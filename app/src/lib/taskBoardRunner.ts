/**
 * CONTRACT: Autocode-style task execution queue for the 任务看板.
 *
 * Mirrors Autocode's agent-queue flow: cards in the 队列 (queue) column are
 * picked up in order by the runner, bounded by a user-set parallel cap.
 * Standard persists compatible documents through UGS; only Spec uses the
 * official OpenSpec Change lifecycle. Both finish with read-only QA.
 * PASS lands the card in 人工审核 (human_review, awaiting_human); FAIL,
 * errors and manual stops land there too with a failure reason — same policy
 * as Autocode, where `error` maps into the human_review column.
 *
 * The runner drives status transitions through the plain taskBoard mutations
 * (moveTask/setTaskPhase), so persistence and notifications stay in one place.
 * Cards found `executing`/`reviewing` after a restart are re-queued at load
 * time by taskBoard's recovery migration (the processes are gone).
 *
 * Execution goes through the app's model gateway (the same channel as the
 * chat): the active selection is resolved to a CLI route (channel env/model/
 * command injected), then `completeGatewayText` runs with `forceCli` so the
 * agent is a workspace CLI process instead of raw CLI OAuth credentials.
 */
import {
  cancelAiCli,
  steerAiCli,
  tauriAvailable,
  prepareIsolatedWorkspace,
  ensureWorkspaceChangesBaseline,
  pushWorkspaceBranch,
  prepareOpenSpecChange,
  getOpenSpecChangeStatus,
  validateOpenSpecChange,
  setOpenSpecTaskStatus,
  previewLocalFile,
  type OpenSpecCommandResult,
} from "@/lib/tauri";
import {
  completeGatewayText,
  resolveCliGatewayRoute,
} from "@/lib/modelGateway/modelGateway";
import type { GatewaySelection } from "@/lib/modelGateway/types";
import {
  getExplicitActiveGatewaySelection,
  getDefaultGatewaySelection,
} from "@/lib/gatewayConfig";
import {
  getBoardTasks,
  moveTask,
  setTaskPhase,
  appendTaskRun,
  updateTaskExecution,
  updateTask,
  type TaskCard,
  type TaskNeedsInputDecisions,
  type TaskPhaseThinking,
  type TaskSubtask,
} from "./taskBoard";
import { syncTaskArtifacts } from "./taskArtifacts";
import { __resetTaskExecutionsForTests, getTaskExecution, reserveTaskExecution, subscribeTaskExecutions } from "./taskExecution";
import { parseStandardSubtasks, standardPlanIssues, orderStandardSubtasks } from "./standardPlan";

type TaskAgentPhase = keyof TaskPhaseThinking;

const RUNNER_STORAGE_KEY = "ugs.taskboard.runner.v1";
const DEFAULT_MAX_PARALLEL = 1;
const MIN_MAX_PARALLEL = 1;
const MAX_MAX_PARALLEL = 10;
const MAX_TASK_STREAM_CHARS = 24_000;
const STREAM_TRUNCATION_MARKER = "…\n";

export interface RunnerTaskStream {
  readonly phase: "planning" | "executing" | "reviewing";
  readonly text: string;
  readonly startedAt: number;
}

export interface RunnerSnapshot {
  readonly maxParallel: number;
  readonly runningCount: number;
  readonly streamRevision: number;
}

/** Everything the runner needs from the host to execute one task. */
export interface RunnerContext {
  /** Active workspace path — the agent's cwd. Empty disables execution. */
  cwd: string;
  /** Session permission mode ('full' | 'readonly' | 'ask'). */
  permission: string;
}

const listeners = new Set<() => void>();
const running = new Set<string>();
const stopping = new Set<string>();
const taskStreams = new Map<string, RunnerTaskStream>();
const boardParallel = new Map<string, number>();
const waitingBoards = new Map<string, RunnerContext>();
subscribeTaskExecutions((boardKey) => {
  const ctx = waitingBoards.get(boardKey);
  if (ctx) queueMicrotask(() => pumpBoard(boardKey, ctx));
});
let maxParallel = loadMaxParallel();
let streamRevision = 0;

function loadMaxParallel(): number {
  try {
    if (typeof window === "undefined" || !window.localStorage)
      return DEFAULT_MAX_PARALLEL;
    const raw = window.localStorage.getItem(RUNNER_STORAGE_KEY);
    if (!raw) return DEFAULT_MAX_PARALLEL;
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value)) return DEFAULT_MAX_PARALLEL;
    return Math.min(MAX_MAX_PARALLEL, Math.max(MIN_MAX_PARALLEL, value));
  } catch {
    return DEFAULT_MAX_PARALLEL;
  }
}

function persistMaxParallel(): void {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(RUNNER_STORAGE_KEY, String(maxParallel));
    }
  } catch {
    /* storage unavailable — setting stays session-only */
  }
}

export function subscribeRunner(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function getMaxParallel(boardKey?: string): number {
  if (boardKey) {
    if (boardParallel.has(boardKey)) return boardParallel.get(boardKey)!;
    try {
      const raw = window.localStorage.getItem(
        `${RUNNER_STORAGE_KEY}.${boardKey}`,
      );
      const value = raw === null ? NaN : Number(raw);
      if (Number.isFinite(value))
        return Math.min(MAX_MAX_PARALLEL, Math.max(1, Math.floor(value)));
    } catch {
      /* use the session default */
    }
  }
  return maxParallel;
}

export function setMaxParallel(value: number, boardKey?: string): void {
  if (!Number.isFinite(value)) return;
  const next = Math.min(
    MAX_MAX_PARALLEL,
    Math.max(MIN_MAX_PARALLEL, Math.floor(value)),
  );
  if (boardKey) {
    boardParallel.set(boardKey, next);
    try {
      window.localStorage.setItem(
        `${RUNNER_STORAGE_KEY}.${boardKey}`,
        String(next),
      );
    } catch {
      /* storage unavailable */
    }
    streamRevision += 1;
    emit();
    return;
  }
  if (next === maxParallel) return;
  maxParallel = next;
  persistMaxParallel();
  emit();
}

/** Cached snapshot — useSyncExternalStore requires a stable identity between changes. */
let runnerSnapshot: RunnerSnapshot = {
  maxParallel,
  runningCount: 0,
  streamRevision,
};

/** Reactive snapshot for runner controls and each task's live output. */
export function getRunnerSnapshot(): RunnerSnapshot {
  if (
    runnerSnapshot.maxParallel !== maxParallel ||
    runnerSnapshot.runningCount !== running.size ||
    runnerSnapshot.streamRevision !== streamRevision
  ) {
    runnerSnapshot = {
      maxParallel,
      runningCount: running.size,
      streamRevision,
    };
  }
  return runnerSnapshot;
}

export function isTaskRunning(boardKey: string, cardId: string): boolean {
  return running.has(runKey(boardKey, cardId));
}

function runKey(boardKey: string, cardId: string): string {
  return `${boardKey}/${cardId}`;
}

/** Current in-memory output for one running task. It is intentionally not persisted. */
export function getTaskStream(
  boardKey: string,
  cardId: string,
): RunnerTaskStream | null {
  return taskStreams.get(runKey(boardKey, cardId)) ?? null;
}

function publishTaskStream(
  boardKey: string,
  cardId: string,
  stream: RunnerTaskStream | null,
): void {
  const key = runKey(boardKey, cardId);
  if (stream) taskStreams.set(key, stream);
  else if (!taskStreams.delete(key)) return;
  streamRevision += 1;
  emit();
}

function startTaskStream(
  boardKey: string,
  cardId: string,
  phase: RunnerTaskStream["phase"],
  startedAt: number,
): void {
  publishTaskStream(boardKey, cardId, { phase, text: "", startedAt });
}

function appendTaskStream(
  boardKey: string,
  cardId: string,
  phase: RunnerTaskStream["phase"],
  chunk: string,
): void {
  if (!chunk) return;
  const current = getTaskStream(boardKey, cardId);
  // Ignore a late batch from the previous call (or from a run already
  // cleared) instead of reviving or switching the card's current stream.
  if (!current || current.phase !== phase) return;
  const combined = `${current.text}${chunk}`;
  const text =
    combined.length <= MAX_TASK_STREAM_CHARS
      ? combined
      : `${STREAM_TRUNCATION_MARKER}${combined.slice(
          -(MAX_TASK_STREAM_CHARS - STREAM_TRUNCATION_MARKER.length),
        )}`;
  publishTaskStream(boardKey, cardId, {
    phase,
    text,
    startedAt: current.startedAt,
  });
}

function clearTaskStream(boardKey: string, cardId: string): void {
  publishTaskStream(boardKey, cardId, null);
}

/** Test hook: publish one live snapshot through the same reactive path as the CLI. */
export function __publishTaskStreamForTests(
  boardKey: string,
  cardId: string,
  stream: RunnerTaskStream | null,
): void {
  publishTaskStream(boardKey, cardId, stream);
}

function findQueuedCard(boardKey: string): TaskCard | null {
  return getBoardTasks(boardKey).find((c) => c.status === "queue" && !getTaskExecution(boardKey, c.id)) ?? null;
}

/**
 * Try to start queued tasks of `boardKey` while the parallel cap allows.
 * Call again whenever the board changes or a task finishes — it is idempotent.
 */
export function pumpBoard(boardKey: string, ctx: RunnerContext): void {
  waitingBoards.delete(boardKey);
  if (!tauriAvailable()) return;
  if (!ctx.cwd.trim()) return; // execution needs a workspace
  for (;;) {
    const boardRunning = [...running].filter((key) =>
      key.startsWith(`${boardKey}/`),
    ).length;
    if (boardRunning >= getMaxParallel(boardKey)) return;
    const card = findQueuedCard(boardKey);
    if (!card) {
      if (getBoardTasks(boardKey).some((c) => c.status === "queue")) waitingBoards.set(boardKey, ctx);
      return;
    }
    const key = runKey(boardKey, card.id);
    if (running.has(key)) {
      // The queued head is already executing (stale column state); wait for it.
      return;
    }
    const execution = reserveTaskExecution(boardKey, card.id, "runner");
    if (!execution) continue;
    running.add(key);
    emit();
    void executeCard(boardKey, card.id, card, ctx, execution.controller.signal).finally(() => {
      running.delete(key);
      stopping.delete(key);
      execution.release();
      emit();
      // A slot freed up — pick up the next queued task, if any.
      pumpBoard(boardKey, ctx);
    });
  }
}

/** Deterministic per-task run id — stopTask must be able to reproduce it. */
function executionRunId(boardKey: string, cardId: string): string {
  return `tbrun_${boardKey}_${cardId}`;
}

function classificationLine(card: TaskCard): string {
  const labelMap: Record<string, string> = {
    feature: "功能",
    bug_fix: "缺陷修复",
    refactoring: "重构",
    documentation: "文档",
    security: "安全",
    low: "低",
    medium: "中",
    high: "高",
    urgent: "紧急",
    trivial: "极低",
    small: "小",
    large: "大",
    complex: "复杂",
    critical: "关键影响",
  };
  const parts: string[] = [];
  if (card.category)
    parts.push(`分类: ${labelMap[card.category] ?? card.category}`);
  if (card.priority)
    parts.push(`优先级: ${labelMap[card.priority] ?? card.priority}`);
  if (card.complexity)
    parts.push(`复杂度: ${labelMap[card.complexity] ?? card.complexity}`);
  if (card.impact) parts.push(`影响: ${labelMap[card.impact] ?? card.impact}`);
  return parts.length > 0 ? parts.join(" | ") : "";
}

const NEEDS_INPUT_APPROVAL =
  "批准需求中记录的当前假设，并在此基础上继续规划";

const NEEDS_INPUT_PROTOCOL = [
  "如果存在必须由用户决定、无法安全推断且会阻塞实施的问题，请停止规划并只输出以下协议块：",
  "<<UGS_NEEDS_INPUT>>",
  '{"message":"说明为何需要输入","decisions":[{"id":"Q1","question":"问题","options":[{"id":"A","label":"选项","recommended":true}]}]}',
  "<<UGS_NEEDS_INPUT_END>>",
  "每个问题给出 2-3 个互斥选项，将建议项的 recommended 设为 true。没有阻塞问题时不要输出协议块。",
].join("\n");

function normalizedNeedsInput(value: unknown): TaskNeedsInputDecisions | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.blocked === false) return null;
  const decisions = (Array.isArray(raw.decisions) ? raw.decisions : [])
    .map((entry, index) => {
      if (!entry || typeof entry !== "object") return null;
      const decision = entry as Record<string, unknown>;
      const question =
        typeof decision.question === "string" ? decision.question.trim() : "";
      if (!question) return null;
      const rawOptions = Array.isArray(decision.options)
        ? decision.options
        : [];
      const options = rawOptions
        .map((entry, optionIndex) => {
          if (!entry || typeof entry !== "object") return null;
          const option = entry as Record<string, unknown>;
          const label =
            typeof option.label === "string" ? option.label.trim() : "";
          if (!label) return null;
          return {
            id:
              typeof option.id === "string" && option.id.trim()
                ? option.id.trim()
                : String.fromCharCode(65 + optionIndex),
            label,
            recommended: option.recommended === true,
          };
        })
        .filter((option): option is NonNullable<typeof option> => option !== null)
        .slice(0, 10);
      if (options.length && !options.some((option) => option.recommended)) {
        options[0] = { ...options[0], recommended: true };
      }
      return {
        id:
          typeof decision.id === "string" && decision.id.trim()
            ? decision.id.trim()
            : `Q${index + 1}`,
        question,
        options,
      };
    })
    .filter((decision): decision is NonNullable<typeof decision> => decision !== null)
    .slice(0, 20);
  const questions = (Array.isArray(raw.questions) ? raw.questions : [])
    .filter(
      (question): question is string =>
        typeof question === "string" && Boolean(question.trim()),
    )
    .map((question) => question.trim())
    .slice(0, 20);
  const resolvedQuestions = questions.length
    ? questions
    : decisions.map((decision) => decision.question);
  if (!resolvedQuestions.length && !decisions.length) return null;
  const resolvedDecisions = decisions.length
    ? decisions
    : resolvedQuestions.map((question, index) => ({
        id: `Q${index + 1}`,
        question,
        options: [
          {
            id: "A",
            label: NEEDS_INPUT_APPROVAL,
            recommended: true,
          },
        ],
      }));
  return {
    blocked: true,
    message:
      typeof raw.message === "string" && raw.message.trim()
        ? raw.message.trim()
        : "规划暂停：需要你确认实施决策。",
    questions: resolvedQuestions,
    decisions: resolvedDecisions,
  };
}

export function parseTaskNeedsInput(
  text: string,
): TaskNeedsInputDecisions | null {
  const match = text.match(
    /<<UGS_NEEDS_INPUT>>\s*([\s\S]*?)\s*<<UGS_NEEDS_INPUT_END>>/i,
  );
  if (match) {
    const payload = match[1]
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "");
    const start = payload.indexOf("{");
    const end = payload.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const parsed = normalizedNeedsInput(
          JSON.parse(payload.slice(start, end + 1)),
        );
        if (parsed) return parsed;
      } catch {
        // Fall through to the Markdown blocking-token parser.
      }
    }
  }

  const questions = text
    .split(/\r?\n/)
    .filter((line) => line.includes("[BLOCKS-IMPLEMENTATION]"))
    .map((line) =>
      line
        .replace(/^\s*(?:[-*+]|\d+[.)])\s*/, "")
        .replace(/\[BLOCKS-IMPLEMENTATION\]/gi, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean)
    .filter((question, index, all) => all.indexOf(question) === index);
  return questions.length
    ? normalizedNeedsInput({
        blocked: true,
        message: "规划暂停：以下问题需要你决定后才能继续。",
        questions,
      })
    : null;
}

const EXEC_SYSTEM_PROMPT = [
  "你是任务执行 agent。请直接在当前工作区完成用户交给你的任务。",
  "要求：",
  "- 直接读取并修改工作区中的文件来完成任务，不要提问，不要等待确认。",
  "- 只做与该任务直接相关的最小充分改动。",
  "- 完成后输出一段简短报告：做了什么改动、关键文件路径、如何验证。",
].join("\n");

const AUDIT_SYSTEM_PROMPT = [
  "你是任务验收审核员。请在当前工作区核实给出的任务是否已经完成（可以读取文件、运行只读检查命令，但不要修改任何文件）。",
  "只输出一行结论：以 PASS 开头表示任务已完成；或以 FAIL: 开头并给出未完成的原因。不要输出其他内容。",
].join("\n");

const STANDARD_WORKFLOW_PROMPT =
  "Standard 使用 UGS 自定义流程，兼容 OpenSpec 的需求、规范、设计、任务与验证语义。不得调用 openspec 命令或使用官方 Change 管理流程。任务状态由 UGS 管理。";

const STANDARD_PLANNING_PROMPT = [
  STANDARD_WORKFLOW_PROMPT,
  "先读取项目相关代码，再输出完整 Markdown 实施计划；本阶段不修改产品代码。",
  NEEDS_INPUT_PROTOCOL,
  "按顺序输出四节：## Requirements、## Spec、## Design、## Tasks。",
  "每节内部的小标题使用 ### 或更深层级。Requirements 为需求、验收和证据分配稳定的 R*、AC*、E* 标识；Spec 使用 SCN-* 场景引用这些标识；Design 为方案决策分配稳定标识供任务引用。",
  "Requirements 明确目标、范围及约束；Spec 用 MUST/SHALL 和 GIVEN/WHEN/THEN 场景描述可验证的行为与验收标准。",
  "Design 说明实现方案、影响文件、数据流、风险与取舍。",
  "Tasks 将设计拆成顺序执行的子任务，每项用 - [ ] 开头，包含目标文件、依赖和验证方法；仅 Tasks 节使用复选框。",
  "需求、规范、设计和子任务必须相互对应，最后包含验证与验收任务。",
  "UGS 将四节正文分别保存为 requirements.md、spec.md、design.md、tasks.md；implementation_plan.md 由运行时生成。不要自行修改这些文档或在 tasks.md 写入执行状态。",
  "任务遵循 Autocode 静态定义格式：- [ ] 1.1 动作标题；嵌套的阶段不是可执行任务。每个叶子任务下提供 _Files to modify: 路径_、_Depends on: 1.0 或 none_、_Requirements: R1, AC1_、_Scenarios: SCN-001_、_Design: 设计引用_、_Evidence: 证据引用_、_Done when: 完成条件_ 和 _Verification: 验证方法_。任务 ID 唯一，依赖只引用真实前置任务，不按展示顺序伪造依赖。",
  "必须在最终回复正文中直接输出完整计划，不要只输出调研摘要、计划文件路径或交付承诺，不要使用 ExitPlanMode 代替返回正文；审批由 UGS 处理。",
  "严格遵守用户要求的交付范围：如果只要求分析或方案，子任务仅覆盖调研、方案编写和核验，不得将方案中建议的未来实施步骤当作当前编码任务。",
].join("\n");

export function standardPlanSubtasks(cardId: string, report: string): TaskSubtask[] {
  return parseStandardSubtasks(cardId, report);
}

const OPENSPEC_PROPOSAL_SYSTEM_PROMPT = [
  "你是官方 OpenSpec Change 的规划代理。此阶段只创建或修订规范工件，不实现产品代码。",
  "UGS 宿主已经用官方 OpenSpec CLI 初始化项目并创建变更目录。",
  NEEDS_INPUT_PROTOCOL,
  "1. 先运行 openspec status --change <change-id> --json，识别当前 ready 工件。",
  "2. 按依赖顺序运行 openspec instructions <artifact> --change <change-id> --json。",
  "3. 将每份官方 instruction 和 template 视为权威；一次只写它声明的 outputPath，不代替其他工件编造格式。",
  "4. proposal、specs、design 与 tasks 必须由官方依赖图驱动；读取已完成依赖后再生成下游工件。",
  "5. tasks.md 中每个可执行项都必须使用 Markdown 复选框，并写清边界、依赖、目标文件与验证方式。",
  "6. 运行 openspec validate <change-id> --type change --strict --json --no-interactive，修复全部错误后再结束。",
  "7. 输出简短说明，并原样附上 tasks.md 的完整复选清单。",
].join("\n");

const OPENSPEC_APPLY_SYSTEM_PROMPT = [
  "你是 OpenSpec 实施代理。必须以当前变更的官方工件为唯一实施依据。",
  "先运行 openspec instructions apply --change <change-id> --json 并读取所有 contextFiles。",
  "只完成用户指定的当前子任务；完成后同步更新 tasks.md 对应复选框。",
  "运行与改动相关的验证，不要归档变更。最后报告改动、文件和验证结果。",
].join("\n");

function openSpecChangeName(card: TaskCard): string {
  const requested = card.openSpecChange?.trim();
  const slug = (requested || card.title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || `task-${card.id.slice(0, 8)}`;
}

type OpenSpecArtifactStatus = {
  id?: string;
  outputPath?: string;
  status?: string;
  missingDeps?: string[];
};

type OpenSpecStatusPayload = {
  changeName?: string;
  schemaName?: string;
  isPlanningComplete?: boolean;
  isComplete?: boolean;
  artifacts?: OpenSpecArtifactStatus[];
};

function openSpecStatusPayload(
  result: OpenSpecCommandResult,
): OpenSpecStatusPayload | null {
  return result.json && typeof result.json === "object"
    ? (result.json as OpenSpecStatusPayload)
    : null;
}

function openSpecPlanningComplete(
  status: OpenSpecStatusPayload | null,
): boolean {
  if (status?.artifacts?.length) return status.artifacts.every(artifact => ["done", "skipped"].includes(artifact.status || ""));
  return status?.isPlanningComplete === true || status?.isComplete === true;
}

function openSpecCommandDetail(result: OpenSpecCommandResult): string {
  return (
    result.stderr.trim() ||
    result.stdout.trim() ||
    (result.timedOut ? "命令执行超时" : "命令未返回详情")
  );
}

function openSpecStatusText(result: OpenSpecCommandResult): string {
  const payload = openSpecStatusPayload(result);
  return payload ? JSON.stringify(payload, null, 2) : result.stdout.trim();
}

function openSpecSubtasks(
  cardId: string,
  tasksMarkdown: string,
): TaskSubtask[] {
  return tasksMarkdown
    .split("\n")
    .map((line) => line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/))
    .filter((match): match is RegExpMatchArray => !!match)
    .map((match, index) => ({
      id: cardId + "-openspec-" + index,
      title: match[2].trim(),
      status:
        match[1].toLowerCase() === "x"
          ? ("completed" as const)
          : ("pending" as const),
    }));
}

async function readOpenSpecTasks(
  cwd: string,
  changeId: string,
): Promise<string> {
  const preview = await previewLocalFile(
    "openspec/changes/" + changeId + "/tasks.md",
    { cwd },
  );
  return preview.text || "";
}

function taskBrief(card: TaskCard): string {
  const meta = classificationLine(card);
  return [
    `任务标题：${card.title}`,
    card.note.trim() ? `任务描述：${card.note.trim()}` : "",
    meta ? `任务分类：${meta}` : "",
    card.referenceImages?.length
      ? `参考图片：\n${card.referenceImages.map((image) => `- ${image.path}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function executeCard(
  boardKey: string,
  cardId: string,
  card: TaskCard,
  ctx: RunnerContext,
  signal: AbortSignal,
): Promise<void> {
  const runId = executionRunId(boardKey, cardId);
  try {
    // Resolve the ACTIVE channel like the chat does, so execution inherits the
    // configured provider (env/model/command) instead of raw CLI OAuth state.
    const activeSelection =
      getExplicitActiveGatewaySelection() ?? getDefaultGatewaySelection();
    // Auto-profile cards follow the currently active gateway. Older cards can
    // still contain a snapshot of the channel/model that was active when they
    // were created; applying that snapshot here would silently route a GLM run
    // back through Claude. Explicit profiles keep their task-specific routes.
    const followsActiveGateway =
      !card.agentProfile || card.agentProfile === "auto";
    const selection = !followsActiveGateway && card.modelSelection
      ? ({ ...activeSelection, ...card.modelSelection } as GatewaySelection)
      : activeSelection;
    const selectedRoute = await resolveCliGatewayRoute(selection);
    const route = !followsActiveGateway && card.model
      ? { ...selectedRoute, model: card.model }
      : selectedRoute;
    const planningRoute =
      !followsActiveGateway && card.planningModelSelection
      ? await resolveCliGatewayRoute({
          ...activeSelection,
          ...card.planningModelSelection,
        } as GatewaySelection)
      : route;
    const specRoute = !followsActiveGateway && card.specModelSelection
      ? await resolveCliGatewayRoute({
          ...activeSelection,
          ...card.specModelSelection,
        } as GatewaySelection)
      : planningRoute;
    const reviewRoute = !followsActiveGateway && card.reviewModelSelection
      ? await resolveCliGatewayRoute({
          ...activeSelection,
          ...card.reviewModelSelection,
        } as GatewaySelection)
      : route;
    const stopped = () => {
      if (signal.aborted) throw new Error("手动停止");
    };
    const pauseForInput = (needsInput: TaskNeedsInputDecisions) => {
      updateTaskExecution(boardKey, cardId, { needsInput });
      setTaskPhase(boardKey, cardId, "awaiting_human");
      moveTask(boardKey, cardId, "human_review");
    };
    stopped();
    let cwd = card.executionCwd || ctx.cwd;
    if (card.useWorktree && !card.executionCwd) {
      const workspace = await prepareIsolatedWorkspace(
        ctx.cwd,
        `board-${card.id}`,
        card.baseBranch,
      );
      cwd = workspace.path;
      updateTaskExecution(boardKey, cardId, { executionCwd: cwd });
    }
    const persistTaskArtifacts = async (
      liveStream: RunnerTaskStream | null,
      required = false,
    ): Promise<void> => {
      try {
        const latest = getBoardTasks(boardKey).find((item) => item.id === cardId);
        if (!latest) return;
        const specsPath = await syncTaskArtifacts(ctx.cwd, latest, liveStream);
        if (specsPath && latest.specsPath !== specsPath) {
          updateTaskExecution(boardKey, cardId, { specsPath });
        }
      } catch (error) {
        if (required) throw error;
        // Task artifact mirrors must never make model execution fail.
      }
    };
    stopped();
    const call = async (
      phase: RunnerTaskStream["phase"],
      system: string,
      userContent: string,
      planning = false,
      subtask?: TaskSubtask,
      permissionOverride?: string,
      agentPhase?: TaskAgentPhase,
    ) => {
      stopped();
      const startedAt = Date.now();
      startTaskStream(boardKey, cardId, phase, startedAt);
      await persistTaskArtifacts(getTaskStream(boardKey, cardId));
      stopped();
      const resolvedAgentPhase: TaskAgentPhase =
        agentPhase ??
        (planning ? "planning" : phase === "reviewing" ? "qa" : "coding");
      const thinkingLevel =
        card.agentProfile === "custom"
          ? card.thinkingLevel
          : (card.phaseThinking?.[resolvedAgentPhase] ?? card.thinkingLevel);
      let usage: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        thinkingTokens?: number;
        cacheReadTokens?: number;
        cacheCreationTokens?: number;
      } = {};
      let text: string;
      try {
        text = await completeGatewayText({
          route:
            resolvedAgentPhase === "spec"
              ? specRoute
              : resolvedAgentPhase === "planning"
                ? planningRoute
                : phase === "reviewing"
                  ? !followsActiveGateway && card.reviewModel
                    ? { ...reviewRoute, model: card.reviewModel }
                    : reviewRoute
                  : route,
          system,
          userContent,
          permission:
            permissionOverride ??
            (planning || phase === "reviewing"
              ? "readonly"
              : ctx.permission || "full"),
          cwd,
          forceCli: true,
          runId,
          signal,
          waitForExitOnAbort: true,
          thinkingLevel,
          onDelta: (chunk) => appendTaskStream(boardKey, cardId, phase, chunk),
          onUsage: (next) => {
            usage = {
              ...usage,
              ...next,
              cacheReadTokens:
                next.cacheReadInputTokens ?? usage.cacheReadTokens,
              cacheCreationTokens:
                next.cacheCreationInputTokens ?? usage.cacheCreationTokens,
            };
          },
        });
        stopped();
        const streamText = getTaskStream(boardKey, cardId)?.text;
        appendTaskRun(boardKey, cardId, {
          phase: planning ? "planning" : phase,
          text,
          ...(streamText ? { streamText } : {}),
          startedAt,
          completedAt: Date.now(),
          ...usage,
          ...(thinkingLevel ? { thinkingLevel } : {}),
          ...(subtask
            ? { subtaskId: subtask.id, subtaskTitle: subtask.title }
            : {}),
        });
        await persistTaskArtifacts(null);
      } catch (error) {
        const streamText = getTaskStream(boardKey, cardId)?.text || "";
        appendTaskRun(boardKey, cardId, {
          phase: planning ? "planning" : phase,
          text: streamText,
          ...(streamText ? { streamText } : {}),
          startedAt,
          completedAt: Date.now(),
          error: String(error),
          ...usage,
          ...(thinkingLevel ? { thinkingLevel } : {}),
          ...(subtask
            ? { subtaskId: subtask.id, subtaskTitle: subtask.title }
            : {}),
        });
        await persistTaskArtifacts(null);
        throw error;
      }
      stopped();
      return text;
    };

    updateTaskExecution(boardKey, cardId, { needsInput: undefined });
    const usesOpenSpecLifecycle = card.developmentMode === "spec";
    const usesStandardWorkflow = card.developmentMode === "standard";
    const needsPlanning =
      (usesOpenSpecLifecycle || usesStandardWorkflow) && !card.plan;
    setTaskPhase(
      boardKey,
      cardId,
      needsPlanning ? "planning" : "executing",
    );
    moveTask(boardKey, cardId, "in_progress");
    let plan = card.plan || "";
    let subtasks = card.subtasks ?? [];
    let ranPlanning = false;
    if (usesStandardWorkflow && (!plan || standardPlanIssues(plan).length)) {
      plan = await call(
        "planning",
        STANDARD_PLANNING_PROMPT,
        [taskBrief(card), card.feedback && `人工反馈：\n${card.feedback}`]
          .filter(Boolean).join("\n\n"),
        true,
      );
      const needsInput = parseTaskNeedsInput(plan);
      if (needsInput) {
        pauseForInput(needsInput);
        return;
      }
      subtasks = standardPlanSubtasks(card.id, plan);
      if (!subtasks.length || standardPlanIssues(plan).length) {
        const repaired = await call(
          "planning",
          STANDARD_PLANNING_PROMPT,
          [
            taskBrief(card),
            `上一轮规划不完整：${standardPlanIssues(plan).join("；") || "没有可执行任务清单"}。基于已有调研补全 Requirements、Spec、Design、Tasks 四节，不要重新开展完整调研。必须在最终回复的 ## Tasks 节直接列出 - [ ] 子任务。不要以 ExitPlanMode、工具调用或文件路径代替最终正文。`,
            `上一轮回复：\n${plan}`,
          ].join("\n\n"),
          true,
        );
        const repairNeedsInput = parseTaskNeedsInput(repaired);
        if (repairNeedsInput) {
          pauseForInput(repairNeedsInput);
          return;
        }
        plan = repaired;
        subtasks = standardPlanSubtasks(card.id, plan);
      }
      if (!subtasks.length || standardPlanIssues(plan).length) {
        throw new Error(`Standard 规划经自动补全后仍不完整：${standardPlanIssues(plan).join("；") || "没有可执行任务清单"}，未进入编码。`);
      }
      updateTaskExecution(boardKey, cardId, { plan, subtasks, planApproved: false });
      ranPlanning = true;
    }
    if (usesStandardWorkflow) {
      if (subtasks.length && subtasks.every(task => !task.definitionId)) {
        const parsed = standardPlanSubtasks(card.id, plan);
        subtasks = subtasks.map(task => {
          const definition = parsed.find(item => item.title === task.title);
          return definition ? { ...definition, ...task, definitionId: definition.definitionId,
            dependsOn: definition.dependsOn, description: definition.description } : task;
        });
        updateTaskExecution(boardKey, cardId, { subtasks });
      }
      // Validate dependencies before approval or any implementation side effects.
      subtasks = orderStandardSubtasks(subtasks);
      await persistTaskArtifacts(null, true);
      stopped();
    }
    const openSpecChange = usesOpenSpecLifecycle ? openSpecChangeName(card) : "";
    if (usesOpenSpecLifecycle && !card.openSpecChange) {
      updateTask(boardKey, cardId, { meta: { openSpecChange } });
    }
    if (usesOpenSpecLifecycle) {
      const prepared = await prepareOpenSpecChange(
        cwd,
        openSpecChange,
        card.openSpecSchema || "spec-driven",
        card.note || card.title,
      );
      stopped();
      let statusResult = prepared.status;
      let status = openSpecStatusPayload(statusResult);
      if (!plan || !openSpecPlanningComplete(status)) {
        ranPlanning = true;
        setTaskPhase(boardKey, cardId, "planning");
        const planningReport = await call(
          "planning",
          OPENSPEC_PROPOSAL_SYSTEM_PROMPT,
          [
            "OpenSpec 变更 ID：" + openSpecChange,
            "Schema：" + (card.openSpecSchema || "spec-driven"),
            "宿主预检状态：\n" + openSpecStatusText(statusResult),
            taskBrief(card),
            card.feedback ? "请根据人工反馈修订工件：\n" + card.feedback : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
          true,
          undefined,
          ctx.permission || "full",
          card.developmentMode === "spec" ? "spec" : "planning",
        );
        const planningNeedsInput = parseTaskNeedsInput(planningReport);
        if (planningNeedsInput) {
          pauseForInput(planningNeedsInput);
          return;
        }
        statusResult = await getOpenSpecChangeStatus(cwd, openSpecChange);
        stopped();
        status = openSpecStatusPayload(statusResult);

        let lastPlanningStatus = "";
        let stalledPlanning = 0;
        for (let attempt = 0; !openSpecPlanningComplete(status) && attempt < 8; attempt += 1) {
          const signature = JSON.stringify(status);
          stalledPlanning = signature === lastPlanningStatus ? stalledPlanning + 1 : 0;
          if (stalledPlanning >= 2) break;
          lastPlanningStatus = signature;
          const completionReport = await call(
            "planning",
            OPENSPEC_PROPOSAL_SYSTEM_PROMPT,
            [
              "OpenSpec 变更 ID：" + openSpecChange,
              "官方状态仍显示规划未完成，请补齐所有 blocked 或 ready 工件。",
              openSpecStatusText(statusResult),
              "上一轮报告：\n" + planningReport,
            ].join("\n\n"),
            true,
            undefined,
            ctx.permission || "full",
            card.developmentMode === "spec" ? "spec" : "planning",
          );
          const completionNeedsInput = parseTaskNeedsInput(completionReport);
          if (completionNeedsInput) {
            pauseForInput(completionNeedsInput);
            return;
          }
          statusResult = await getOpenSpecChangeStatus(cwd, openSpecChange);
          stopped();
          status = openSpecStatusPayload(statusResult);
        }

        if (!openSpecPlanningComplete(status)) {
          throw new Error(
            "OpenSpec 规划工件未完成：" + openSpecStatusText(statusResult),
          );
        }

        let validation = await validateOpenSpecChange(cwd, openSpecChange);
        stopped();
        if (!validation.success) {
          const repairReport = await call(
            "planning",
            OPENSPEC_PROPOSAL_SYSTEM_PROMPT,
            [
              "OpenSpec 变更 ID：" + openSpecChange,
              "官方严格校验未通过，请按错误修正规范工件。",
              openSpecCommandDetail(validation),
            ].join("\n\n"),
            true,
            undefined,
            ctx.permission || "full",
            card.developmentMode === "spec" ? "spec" : "planning",
          );
          const repairNeedsInput = parseTaskNeedsInput(repairReport);
          if (repairNeedsInput) {
            pauseForInput(repairNeedsInput);
            return;
          }
          validation = await validateOpenSpecChange(cwd, openSpecChange);
          stopped();
        }
        if (!validation.success) {
          throw new Error(
            "OpenSpec 严格校验未通过：" + openSpecCommandDetail(validation),
          );
        }
      }

      const tasksMarkdown = await readOpenSpecTasks(cwd, openSpecChange);
      stopped();
      const parsedSubtasks = openSpecSubtasks(card.id, tasksMarkdown);
      if (!parsedSubtasks.length) {
        throw new Error("OpenSpec tasks.md 没有可执行的 Markdown 复选任务");
      }
      const priorByTitle = new Map(
        (card.subtasks || []).map((subtask) => [subtask.title, subtask]),
      );
      subtasks = parsedSubtasks.map((subtask) => {
        const prior = priorByTitle.get(subtask.title);
        return prior?.status === "completed"
          ? { ...subtask, status: "completed" as const, summary: prior.summary }
          : subtask;
      });
      plan = tasksMarkdown;
      updateTaskExecution(boardKey, cardId, { plan, subtasks });
    }
    if (
      (card.developmentMode === "spec" || card.requireReviewBeforeCoding) &&
      (!card.planApproved || ranPlanning) &&
      plan
    ) {
      setTaskPhase(boardKey, cardId, "awaiting_human");
      moveTask(boardKey, cardId, "human_review");
      return;
    }
    if (ranPlanning) setTaskPhase(boardKey, cardId, "executing");
    await ensureWorkspaceChangesBaseline(cwd, `board-${cardId}`);
    stopped();
    let workReport = "";
    if (
      (card.developmentMode === "standard" ||
        card.developmentMode === "spec") &&
      subtasks.length > 0
    ) {
      const reports: string[] = [];
      for (const [taskIndex, subtask] of subtasks.entries()) {
        if (subtask.status === "completed" && !card.feedback) continue;
        const currentSubtasks =
          getBoardTasks(boardKey).find((item) => item.id === cardId)
            ?.subtasks ?? subtasks;
        updateTaskExecution(boardKey, cardId, {
          subtasks: currentSubtasks.map((item) =>
            item.id === subtask.id ? { ...item, status: "in_progress" } : item,
          ),
        });
        try {
          const report = await call(
            "executing",
            usesOpenSpecLifecycle
              ? OPENSPEC_APPLY_SYSTEM_PROMPT
              : `${EXEC_SYSTEM_PROMPT}\n${STANDARD_WORKFLOW_PROMPT}\n不要修改 tasks.md 或 implementation_plan.md；UGS 管理静态定义和运行台账。`,
            [
              taskBrief(card),
              `完整实施计划：\n${plan}`,
              openSpecChange && `OpenSpec 变更 ID：${openSpecChange}`,
              `当前只完成这个子任务：${subtask.title}`,
              subtask.description && `任务定义：\n${subtask.description}`,
              usesStandardWorkflow && `规范文档目录：${getBoardTasks(boardKey).find(item => item.id === cardId)?.specsPath || "见完整实施计划"}`,
              card.feedback && `人工反馈：\n${card.feedback}`,
            ]
              .filter(Boolean)
              .join("\n\n"),
            false,
            subtask,
          );
          reports.push(`${subtask.title}\n${report}`);
          if (usesOpenSpecLifecycle) {
            await setOpenSpecTaskStatus(cwd, openSpecChange, taskIndex, true);
            stopped();
          }
          const latest =
            getBoardTasks(boardKey).find((item) => item.id === cardId)
              ?.subtasks ?? currentSubtasks;
          updateTaskExecution(boardKey, cardId, {
            subtasks: latest.map((item) =>
              item.id === subtask.id
                ? {
                    ...item,
                    status: "completed",
                    summary: report.trim().slice(0, 500),
                  }
                : item,
            ),
          });
          await persistTaskArtifacts(null, usesStandardWorkflow);
          stopped();
        } catch (error) {
          const latest =
            getBoardTasks(boardKey).find((item) => item.id === cardId)
              ?.subtasks ?? currentSubtasks;
          updateTaskExecution(boardKey, cardId, {
            subtasks: latest.map((item) =>
              item.id === subtask.id
                ? {
                    ...item,
                    status: "failed",
                    summary:
                      error instanceof Error ? error.message : String(error),
                  }
                : item,
            ),
          });
          throw error;
        }
      }
      workReport = reports.join("\n\n");
      if (!workReport && card.feedback) {
        workReport = await call(
          "executing",
          EXEC_SYSTEM_PROMPT,
          [
            taskBrief(card),
            `实施计划：\n${plan}`,
            `人工反馈：\n${card.feedback}`,
          ].join("\n\n"),
        );
      }
    } else {
      workReport = await call(
        "executing",
        EXEC_SYSTEM_PROMPT,
        [
          taskBrief(card),
          plan && `实施计划：\n${plan}`,
          card.feedback && `人工反馈：\n${card.feedback}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
    }
    if (card.useWorktree && card.pushNewBranches) {
      await pushWorkspaceBranch(cwd);
      stopped();
    }
    if (usesOpenSpecLifecycle) {
      const validation = await validateOpenSpecChange(cwd, openSpecChange);
      stopped();
      if (!validation.success) {
        throw new Error(
          "OpenSpec 实施后严格校验未通过：" + openSpecCommandDetail(validation),
        );
      }
    }
    if (card.developmentMode === "direct") {
      setTaskPhase(boardKey, cardId, "awaiting_human");
      moveTask(boardKey, cardId, "human_review");
      return;
    }

    setTaskPhase(boardKey, cardId, "reviewing");
    moveTask(boardKey, cardId, "ai_review");
    const verdict = (
      await call(
        "reviewing",
        usesOpenSpecLifecycle
          ? `${AUDIT_SYSTEM_PROMPT}\n必须运行 openspec validate ${openSpecChange}，并核对 tasks.md 已全部完成。`
          : `${AUDIT_SYSTEM_PROMPT}\n${usesStandardWorkflow ? STANDARD_WORKFLOW_PROMPT : ""}`,
        [
          taskBrief(card),
          openSpecChange && `OpenSpec 变更 ID：${openSpecChange}`,
          usesStandardWorkflow && `实施计划与验收标准：\n${plan}`,
          "",
          "执行报告：",
          workReport.trim() || "（agent 未留下报告）",
        ]
          .filter(Boolean)
          .join("\n"),
      )
    ).trim();
    // Models rarely keep the answer to ONE clean line: a verbose verdict may
    // narrate first and state its conclusion at the end ("…校验记录。PASS: …").
    // Trust the LAST explicit PASS/FAIL mark instead of the string prefix.
    const marks = [...verdict.matchAll(/\b(PASS|FAIL)\b/gi)];
    const pass =
      marks.length > 0
        ? marks[marks.length - 1][1].toUpperCase() === "PASS"
        : false;
    if (pass) {
      setTaskPhase(boardKey, cardId, "awaiting_human");
      moveTask(boardKey, cardId, "human_review");
    } else {
      const reason =
        verdict.replace(/^FAIL\s*[:：]?\s*/i, "").trim() || "AI 审核未通过";
      setTaskPhase(boardKey, cardId, "failed", reason);
      moveTask(boardKey, cardId, "human_review");
    }
  } catch (err) {
    const stopped = stopping.has(runKey(boardKey, cardId));
    const reason = stopped
      ? "手动停止"
      : `执行失败：${err instanceof Error ? err.message : String(err)}`;
    setTaskPhase(boardKey, cardId, "failed", reason);
    moveTask(boardKey, cardId, "human_review");
  } finally {
    clearTaskStream(boardKey, cardId);
    const latest = getBoardTasks(boardKey).find(item => item.id === cardId);
    if (latest) {
      try { await syncTaskArtifacts(ctx.cwd, latest, null); }
      catch { /* Preserve the original task failure; required plan writes are checked above. */ }
    }
  }
}

/** Cancel the in-flight execution of a task; it lands in human_review as failed. */
export function stopTask(boardKey: string, cardId: string): void {
  const execution = getTaskExecution(boardKey, cardId);
  if (execution?.owner !== "runner") return;
  stopping.add(runKey(boardKey, cardId));
  execution.controller.abort();
  void cancelAiCli(`tbrun_${boardKey}_${cardId}`).catch(() => {});
}

/** Send an additional instruction to the task's current interactive CLI turn. */
export async function steerTask(
  boardKey: string,
  cardId: string,
  instruction: string,
): Promise<boolean> {
  const text = instruction.trim();
  if (!text) return false;
  const key = runKey(boardKey, cardId);
  if (!running.has(key)) return false;
  const accepted = await steerAiCli(`tbrun_${boardKey}_${cardId}`, text);
  if (accepted) {
    const stream = getTaskStream(boardKey, cardId);
    if (stream) {
      appendTaskStream(
        boardKey,
        cardId,
        stream.phase,
        `\n\n[追加指令] ${text}\n`,
      );
    }
  }
  return accepted;
}

/** Test hook: reset in-memory runner state (localStorage is managed by the test). */
export function __resetRunnerForTests(): void {
  __resetTaskExecutionsForTests();
  waitingBoards.clear();
  running.clear();
  stopping.clear();
  taskStreams.clear();
  boardParallel.clear();
  streamRevision = 0;
  runnerSnapshot = { maxParallel, runningCount: 0, streamRevision };
  listeners.clear();
}
