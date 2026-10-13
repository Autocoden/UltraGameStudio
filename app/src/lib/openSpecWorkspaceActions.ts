import {
  completeGatewayText,
  resolveCliGatewayRoute,
} from "@/lib/modelGateway/modelGateway";
import type { GatewaySelection, GatewayTextRequest } from "@/lib/modelGateway/types";
import { __resetTaskExecutionsForTests, getTaskExecution, reserveTaskExecution } from "@/lib/taskExecution";
import {
  getDefaultGatewaySelection,
  getExplicitActiveGatewaySelection,
} from "@/lib/gatewayConfig";
import {
  appendTaskRun,
  updateTaskExecution,
  setTaskPhase,
  moveTask,
  type TaskCard,
  type TaskSubtask,
} from "@/lib/taskBoard";
import {
  cancelAiCli,
  ensureWorkspaceChangesBaseline,
  listWorkspaceChanges,
  previewLocalFile,
  steerAiCli,
  getOpenSpecChangeStatus,
  validateOpenSpecChange,
  type WorkspaceChangeFile,
} from "@/lib/tauri";

export const OPEN_SPEC_WORKSPACE_ACTIONS = [
  "new",
  "explore",
  "update",
  "apply",
  "patch",
  "verify",
] as const;

export type OpenSpecWorkspaceAction =
  (typeof OPEN_SPEC_WORKSPACE_ACTIONS)[number];

export type OpenSpecActionRunState =
  | "running"
  | "cancelling"
  | "interrupted"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface OpenSpecActionRun {
  id: string;
  action: OpenSpecWorkspaceAction;
  state: OpenSpecActionRunState;
  arguments?: string;
  output: string;
  startedAt: number;
  completedAt?: number;
  error?: string;
  receivedDelta?: boolean;
}

export interface OpenSpecActionSnapshot {
  activeRun: OpenSpecActionRun | null;
  history: OpenSpecActionRun[];
  planningReview: OpenSpecPlanningReview | null;
}

export interface OpenSpecPlanningReview {
  id: string;
  action: "new" | "update";
  createdAt: number;
  acknowledged: boolean;
  files: WorkspaceChangeFile[];
}

export interface OpenSpecActionStatus {
  isPlanningComplete: boolean;
  isComplete: boolean;
  artifacts: Array<{ status: string }>;
}

export interface RunOpenSpecWorkspaceActionInput {
  boardKey: string;
  cwd: string;
  card: TaskCard;
  action: OpenSpecWorkspaceAction;
  arguments?: string;
  status?: OpenSpecActionStatus | null;
}

const STORAGE_PREFIX = "ugs.openspec.actions.v1.";
const MAX_OUTPUT_CHARS = 100_000;
const MAX_HISTORY = 20;
const snapshots = new Map<string, OpenSpecActionSnapshot>();
const listeners = new Set<() => void>();
let sequence = 0;

function runKey(boardKey: string, cardId: string): string {
  return boardKey + "\u0000" + cardId;
}

function storageKey(key: string): string {
  return STORAGE_PREFIX + encodeURIComponent(key);
}

function hasStorage(): boolean {
  try {
    return typeof window !== "undefined" && Boolean(window.localStorage);
  } catch {
    return false;
  }
}

function isAction(value: unknown): value is OpenSpecWorkspaceAction {
  return (
    typeof value === "string" &&
    OPEN_SPEC_WORKSPACE_ACTIONS.includes(value as OpenSpecWorkspaceAction)
  );
}

function isRunState(value: unknown): value is OpenSpecActionRunState {
  return [
    "running",
    "cancelling",
    "interrupted",
    "succeeded",
    "failed",
    "cancelled",
  ].includes(String(value));
}

function parseRun(value: unknown): OpenSpecActionRun | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const run = value as Partial<OpenSpecActionRun>;
  if (
    typeof run.id !== "string" ||
    !isAction(run.action) ||
    !isRunState(run.state) ||
    typeof run.output !== "string" ||
    typeof run.startedAt !== "number"
  ) {
    return null;
  }
  return {
    id: run.id,
    action: run.action,
    state: run.state,
    output: run.output.slice(-MAX_OUTPUT_CHARS),
    startedAt: run.startedAt,
    ...(typeof run.arguments === "string" ? { arguments: run.arguments } : {}),
    ...(typeof run.completedAt === "number"
      ? { completedAt: run.completedAt }
      : {}),
    ...(typeof run.error === "string" ? { error: run.error } : {}),
    ...(run.receivedDelta === true ? { receivedDelta: true } : {}),
  };
}

function persist(key: string, snapshot: OpenSpecActionSnapshot): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(storageKey(key), JSON.stringify(snapshot));
  } catch {
    // Runtime state is still available in memory when storage is unavailable.
  }
}

function loadSnapshot(key: string): OpenSpecActionSnapshot {
  const cached = snapshots.get(key);
  if (cached) return cached;
  let snapshot: OpenSpecActionSnapshot = {
    activeRun: null,
    history: [],
    planningReview: null,
  };
  if (hasStorage()) {
    try {
      const raw = window.localStorage.getItem(storageKey(key));
      const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      if (parsed) {
        const activeRun = parseRun(parsed.activeRun);
        const history = Array.isArray(parsed.history)
          ? parsed.history
              .map(parseRun)
              .filter((run): run is OpenSpecActionRun => Boolean(run))
              .slice(-MAX_HISTORY)
          : [];
        const reviewValue =
          parsed.planningReview &&
          typeof parsed.planningReview === "object" &&
          !Array.isArray(parsed.planningReview)
            ? (parsed.planningReview as Partial<OpenSpecPlanningReview>)
            : null;
        const planningReview =
          reviewValue &&
          typeof reviewValue.id === "string" &&
          (reviewValue.action === "new" || reviewValue.action === "update") &&
          typeof reviewValue.createdAt === "number" &&
          Array.isArray(reviewValue.files)
            ? ({
                id: reviewValue.id,
                action: reviewValue.action,
                createdAt: reviewValue.createdAt,
                acknowledged: reviewValue.acknowledged === true,
                files: reviewValue.files as WorkspaceChangeFile[],
              } satisfies OpenSpecPlanningReview)
            : null;
        snapshot = { activeRun, history, planningReview };
      }
    } catch {
      // Ignore malformed persisted runtime state.
    }
  }
  if (
    snapshot.activeRun?.state === "running" ||
    snapshot.activeRun?.state === "cancelling"
  ) {
    snapshot = {
      ...snapshot,
      activeRun: {
        ...snapshot.activeRun,
        state: "interrupted",
        completedAt: Date.now(),
        error: "应用关闭前动作尚未结束，可以恢复执行或放弃本次运行。",
      },
    };
    persist(key, snapshot);
  }
  snapshots.set(key, snapshot);
  return snapshot;
}

function publish(key: string, snapshot: OpenSpecActionSnapshot): void {
  snapshots.set(key, snapshot);
  persist(key, snapshot);
  for (const listener of listeners) listener();
}

function updateActive(
  key: string,
  id: string,
  updater: (run: OpenSpecActionRun) => OpenSpecActionRun,
): OpenSpecActionRun | null {
  const snapshot = loadSnapshot(key);
  if (!snapshot.activeRun || snapshot.activeRun.id !== id) return null;
  const activeRun = updater(snapshot.activeRun);
  publish(key, { ...snapshot, activeRun });
  return activeRun;
}

function finishRun(
  key: string,
  id: string,
  state: "succeeded" | "failed" | "cancelled",
  error?: string,
): OpenSpecActionRun | null {
  const snapshot = loadSnapshot(key);
  if (!snapshot.activeRun || snapshot.activeRun.id !== id) return null;
  const run: OpenSpecActionRun = {
    ...snapshot.activeRun,
    state,
    completedAt: Date.now(),
    ...(error ? { error } : {}),
  };
  publish(key, {
    ...snapshot,
    activeRun: null,
    history: [...snapshot.history, run].slice(-MAX_HISTORY),
  });
  return run;
}

export function subscribeOpenSpecActions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getOpenSpecActionSnapshot(
  boardKey: string,
  cardId: string,
): OpenSpecActionSnapshot {
  return loadSnapshot(runKey(boardKey, cardId));
}

export function openSpecActionLabel(action: OpenSpecWorkspaceAction): string {
  return {
    new: "新建规划",
    explore: "探索分析",
    update: "更新规划",
    apply: "执行实施",
    patch: "修订实现",
    verify: "验证结果",
  }[action];
}

function actionPhase(
  action: OpenSpecWorkspaceAction,
): "planning" | "executing" | "reviewing" {
  if (action === "new" || action === "explore" || action === "update") {
    return "planning";
  }
  return action === "verify" ? "reviewing" : "executing";
}

function actionAgentPhase(
  action: OpenSpecWorkspaceAction,
): "spec" | "coding" | "qa" {
  if (action === "new" || action === "explore" || action === "update") {
    return "spec";
  }
  return action === "verify" ? "qa" : "coding";
}

function actionSystemPrompt(action: OpenSpecWorkspaceAction): string {
  const shared = [
    "你正在 UGS 的 OpenSpec 工作区中执行单个动作。",
    "先检查当前文件与 openspec status，再采取动作；不要臆造命令结果。",
    "持续输出你正在检查、调用工具和完成的步骤，结尾给出简短结果。",
  ];
  const specific: Record<OpenSpecWorkspaceAction, string[]> = {
    new: [
      "创建或补齐当前变更的规划工件，不实现产品代码。",
      "按 OpenSpec instructions 的依赖顺序生成 proposal、specs、design 和 tasks，并运行严格校验。",
    ],
    explore: [
      "只做分析与方案探索，不修改工作区文件。",
      "说明现状、约束、风险、可选方案和建议方案。",
    ],
    update: [
      "根据用户要求修订当前变更的规划工件，不实现产品代码。",
      "保持 proposal、specs、design、tasks 一致，并运行严格校验。",
    ],
    apply: [
      "按当前 OpenSpec 工件实施尚未完成的任务。",
      "运行必要测试，并在完成后同步勾选 tasks.md。",
    ],
    patch: [
      "根据用户反馈修订现有实现，运行相关测试。",
      "若契约发生变化，同步更新 OpenSpec 工件与 tasks.md。",
    ],
    verify: [
      "以只读审查者身份验证实现，不修改任何文件。",
      "运行 openspec 严格校验和相关测试，最后明确输出 PASS 或 FAIL: 原因。",
    ],
  };
  return [...shared, ...specific[action]].join("\n");
}

export function buildOpenSpecActionPrompt(input: {
  action: OpenSpecWorkspaceAction;
  card: Pick<TaskCard, "title" | "note" | "openSpecChange" | "openSpecSchema">;
  arguments?: string;
  status?: OpenSpecActionStatus | null;
}): { system: string; userContent: string } {
  const changeName = input.card.openSpecChange || "unknown-change";
  const status = input.status
    ? JSON.stringify(input.status, null, 2)
    : "请在工作区读取最新状态";
  return {
    system: actionSystemPrompt(input.action),
    userContent: [
      "动作：" + input.action,
      "OpenSpec 变更 ID：" + changeName,
      "Schema：" + (input.card.openSpecSchema || "spec-driven"),
      "任务：" + input.card.title,
      input.card.note ? "任务说明：\n" + input.card.note : "",
      "当前状态：\n" + status,
      input.arguments?.trim()
        ? "本轮用户要求：\n" + input.arguments.trim()
        : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

async function resolveActionRoute(
  card: TaskCard,
  action: OpenSpecWorkspaceAction,
) {
  const activeSelection =
    getExplicitActiveGatewaySelection() ?? getDefaultGatewaySelection();
  const selected =
    action === "verify"
      ? card.reviewModelSelection ?? card.modelSelection
      : actionAgentPhase(action) === "spec"
        ? card.specModelSelection ??
          card.planningModelSelection ??
          card.modelSelection
        : card.modelSelection;
  const route = await resolveCliGatewayRoute(
    selected
      ? ({ ...activeSelection, ...selected } as GatewaySelection)
      : activeSelection,
  );
  const explicitModel =
    action === "verify"
      ? card.reviewModel
      : actionAgentPhase(action) === "coding"
        ? card.model
        : undefined;
  return explicitModel ? { ...route, model: explicitModel } : route;
}

function appendOutput(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length <= MAX_OUTPUT_CHARS
    ? combined
    : "[较早活动已截断]\n" + combined.slice(-(MAX_OUTPUT_CHARS - 12));
}

async function syncTaskChecklist(
  boardKey: string,
  cwd: string,
  card: TaskCard,
): Promise<void> {
  if (!card.openSpecChange) return;
  try {
    const preview = await previewLocalFile(
      "openspec/changes/" + card.openSpecChange + "/tasks.md",
      { cwd },
    );
    const markdown = preview.text || "";
    const priorByTitle = new Map(
      (card.subtasks || []).map((subtask) => [subtask.title, subtask]),
    );
    const subtasks: TaskSubtask[] = markdown
      .split("\n")
      .map((line) => line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map((match, index) => {
        const title = match[2].trim();
        const prior = priorByTitle.get(title);
        return {
          id: prior?.id || card.id + "-openspec-" + index,
          title,
          status:
            match[1].toLowerCase() === "x"
              ? ("completed" as const)
              : ("pending" as const),
          ...(prior?.summary ? { summary: prior.summary } : {}),
        };
      });
    updateTaskExecution(boardKey, card.id, {
      plan: markdown,
      ...(subtasks.length ? { subtasks } : {}),
    });
  } catch {
    // Not every schema has a tasks artifact yet.
  }
}

export async function runOpenSpecWorkspaceAction(
  input: RunOpenSpecWorkspaceActionInput,
  internal: { initialOutput?: string } = {},
): Promise<OpenSpecActionRun> {
  const key = runKey(input.boardKey, input.card.id);
  const snapshot = loadSnapshot(key);
  if (snapshot.activeRun) {
    throw new Error(
      snapshot.activeRun.state === "interrupted"
        ? "请先恢复或放弃上次中断的动作"
        : "已有 OpenSpec 动作正在执行",
      );
  }
  if (
    (input.action === "apply" || input.action === "patch") &&
    snapshot.planningReview &&
    !snapshot.planningReview.acknowledged
  ) {
    throw new Error("请先审阅并确认上一轮 OpenSpec 规划改动");
  }
  if (!input.cwd) throw new Error("请先选择项目工作区");
  if (!input.card.openSpecChange) {
    throw new Error("此任务尚未绑定 OpenSpec 变更");
  }
  const execution = reserveTaskExecution(input.boardKey, input.card.id, "openspec");
  if (!execution) throw new Error("此任务已有动作正在执行");
  const stopped = () => {
    if (execution.controller.signal.aborted) throw new Error("已取消");
  };

  sequence += 1;
  const id =
    "openspec_" + Date.now() + "_" + sequence + "_" + input.card.id;
  const label = openSpecActionLabel(input.action);
  const run: OpenSpecActionRun = {
    id,
    action: input.action,
    state: "running",
    ...(input.arguments?.trim() ? { arguments: input.arguments.trim() } : {}),
    output:
      internal.initialOutput ||
      "[" + new Date().toLocaleTimeString() + "] " + label + "\n",
    startedAt: Date.now(),
  };
  const createsPlanningReview =
    input.action === "new" || input.action === "update";
  const reviewCacheKey = "openspec-planning-review-" + id;
  let reviewBaselineReady = false;
  let usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    thinkingTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  } = {};
  try {
    publish(key, { ...snapshot, activeRun: run });
    const prompt = buildOpenSpecActionPrompt(input);
    if (createsPlanningReview) {
      try {
        await ensureWorkspaceChangesBaseline(input.cwd, reviewCacheKey);
        reviewBaselineReady = true;
      } catch {
        // A non-git workspace can still run the action without a diff review.
      }
    }
    stopped();
    const route = await resolveActionRoute(input.card, input.action);
    stopped();
    const agentPhase = actionAgentPhase(input.action);
    const thinkingLevel =
      input.card.agentProfile === "custom"
        ? input.card.thinkingLevel
        : input.card.phaseThinking?.[agentPhase] ?? input.card.thinkingLevel;
    const request: GatewayTextRequest = {
      route,
      system: prompt.system,
      userContent: prompt.userContent,
      permission:
        input.action === "explore" || input.action === "verify"
          ? "readonly"
          : "full",
      cwd: input.cwd,
      forceCli: true,
      runId: id,
      signal: execution.controller.signal,
      waitForExitOnAbort: true,
      thinkingLevel,
      onDelta: (chunk) => {
        updateActive(key, id, (current) => ({
          ...current,
          receivedDelta: true,
          output: appendOutput(current.output, chunk),
        }));
      },
      onUsage: (next) => {
        usage = {
          ...usage,
          inputTokens: next.inputTokens ?? usage.inputTokens,
          outputTokens: next.outputTokens ?? usage.outputTokens,
          totalTokens: next.totalTokens ?? usage.totalTokens,
          thinkingTokens: next.thinkingTokens ?? usage.thinkingTokens,
          cacheReadTokens:
            next.cacheReadInputTokens ?? usage.cacheReadTokens,
          cacheCreationTokens:
            next.cacheCreationInputTokens ?? usage.cacheCreationTokens,
        };
      },
    };
    let text = await completeGatewayText(request);
    stopped();
    if (createsPlanningReview) {
      // One model turn may produce only one artifact. The CLI status, not the
      // model's completion message, decides when planning has finished.
      let previousStatus = "";
      let stalled = 0;
      for (let attempt = 0; ; attempt += 1) {
        const current = loadSnapshot(key).activeRun;
        if (!current || current.id !== id || current.state === "cancelling") throw new Error("已取消");
        const result = await getOpenSpecChangeStatus(input.cwd, input.card.openSpecChange);
        stopped();
        if (!result.success) throw new Error(result.stderr || result.stdout || "无法读取 OpenSpec 工件状态");
        const status = result.json as { isComplete?: boolean; isPlanningComplete?: boolean; artifacts?: Array<{ status: string }> } | null;
        const complete = status?.artifacts?.length
          ? status.artifacts.every(artifact => ["done", "skipped"].includes(artifact.status))
          : status?.isComplete === true || status?.isPlanningComplete === true;
        if (complete) {
          const validation = await validateOpenSpecChange(input.cwd, input.card.openSpecChange);
          stopped();
          if (!validation.success) throw new Error("OpenSpec 严格校验失败：" + (validation.stderr || validation.stdout));
          break;
        }
        const statusText = JSON.stringify(status);
        stalled = statusText === previousStatus ? stalled + 1 : 0;
        if (attempt >= 8 || stalled >= 2) throw new Error("OpenSpec 规划工件未补齐，已停止自动推进。请检查活动日志。状态：" + statusText);
        previousStatus = statusText;
        updateActive(key, id, run => ({ ...run, output: appendOutput(run.output, "\n[UGS] 继续生成缺失的 OpenSpec 工件…\n") }));
        text = await completeGatewayText({ ...request, userContent: prompt.userContent +
          "\n\n官方状态仍有未完成工件，请按依赖顺序继续读取 openspec instructions 并写入对应 outputPath，不要只返回摘要：\n" + statusText });
        stopped();
      }
    }
    const latest = loadSnapshot(key).activeRun;
    if (!latest || latest.id !== id || latest.state === "cancelling") {
      throw new Error("已取消");
    }
    if (text && !latest.output.includes(text)) {
      updateActive(key, id, (current) => ({
        ...current,
        output: appendOutput(current.output, text),
      }));
    }
    let planningReview: OpenSpecPlanningReview | null = null;
    if (createsPlanningReview && reviewBaselineReady) {
      try {
        const changes = await listWorkspaceChanges(
          input.cwd,
          reviewCacheKey,
        );
        const marker = (
          "openspec/changes/" +
          input.card.openSpecChange +
          "/"
        ).toLowerCase();
        const files = changes.files.filter((file) =>
          file.path.replace(/\\/g, "/").toLowerCase().includes(marker),
        );
        if (files.length) {
          planningReview = {
            id,
            action: input.action as "new" | "update",
            createdAt: Date.now(),
            acknowledged: false,
            files,
          };
        }
      } catch {
        // The action result remains valid when the optional diff cannot load.
      }
    }
    stopped();
    const completed = finishRun(key, id, "succeeded");
    if (!completed) throw new Error("OpenSpec 动作状态已失效");
    if (planningReview) {
      const next = loadSnapshot(key);
      publish(key, { ...next, planningReview });
    }
    appendTaskRun(input.boardKey, input.card.id, {
      phase: actionPhase(input.action),
      text,
      streamText: completed.output,
      startedAt: completed.startedAt,
      completedAt: completed.completedAt || Date.now(),
      ...usage,
      ...(thinkingLevel ? { thinkingLevel } : {}),
      subtaskTitle: "OpenSpec · " + label,
    });
    if (input.action !== "explore" && input.action !== "verify") {
      await syncTaskChecklist(
        input.boardKey,
        input.cwd,
        input.card,
      );
    }
    if (createsPlanningReview) {
      updateTaskExecution(input.boardKey, input.card.id, { planApproved: false });
      setTaskPhase(input.boardKey, input.card.id, "awaiting_human");
      moveTask(input.boardKey, input.card.id, "human_review");
    }
    return completed;
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    const current = loadSnapshot(key).activeRun;
    const cancelled = execution.controller.signal.aborted || (
      current?.id === id &&
      (current.state === "cancelling" || message === "已取消"));
    const completed = finishRun(
      key,
      id,
      cancelled ? "cancelled" : "failed",
      cancelled ? "用户取消" : message,
    );
    if (completed) {
      appendTaskRun(input.boardKey, input.card.id, {
        phase: actionPhase(input.action),
        text: completed.output,
        streamText: completed.output,
        startedAt: completed.startedAt,
        completedAt: completed.completedAt || Date.now(),
        error: completed.error,
        ...usage,
        subtaskTitle: "OpenSpec · " + label,
      });
    }
    throw reason;
  } finally {
    execution.release();
  }
}

export async function cancelOpenSpecWorkspaceAction(
  boardKey: string,
  cardId: string,
): Promise<void> {
  const key = runKey(boardKey, cardId);
  const active = loadSnapshot(key).activeRun;
  if (!active || active.state !== "running") return;
  updateActive(key, active.id, (run) => ({ ...run, state: "cancelling" }));
  getTaskExecution(boardKey, cardId)?.controller.abort();
  await cancelAiCli(active.id);
}

export async function sendOpenSpecSessionInput(
  boardKey: string,
  cardId: string,
  text: string,
): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const key = runKey(boardKey, cardId);
  const active = loadSnapshot(key).activeRun;
  if (
    !active ||
    active.state !== "running" ||
    (active.action !== "apply" && active.action !== "patch")
  ) {
    return false;
  }
  const accepted = await steerAiCli(active.id, trimmed);
  if (accepted) {
    updateActive(key, active.id, (run) => ({
      ...run,
      output: appendOutput(
        run.output,
        "\n\n[用户追加要求] " + trimmed + "\n",
      ),
    }));
  }
  return accepted;
}

export async function resumeOpenSpecWorkspaceAction(input: {
  boardKey: string;
  cwd: string;
  card: TaskCard;
  status?: OpenSpecActionStatus | null;
}): Promise<OpenSpecActionRun> {
  const key = runKey(input.boardKey, input.card.id);
  const snapshot = loadSnapshot(key);
  const interrupted = snapshot.activeRun;
  if (!interrupted || interrupted.state !== "interrupted") {
    throw new Error("没有可恢复的 OpenSpec 动作");
  }
  publish(key, { ...snapshot, activeRun: null });
  try {
    return await runOpenSpecWorkspaceAction(
      {
        ...input,
        action: interrupted.action,
        arguments: [
          interrupted.arguments || "",
          "继续上次被中断的动作。先检查工作区当前状态，只完成尚未完成的部分。",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
      {
        initialOutput:
          interrupted.output +
          "\n\n[" +
          new Date().toLocaleTimeString() +
          "] 恢复执行\n",
      },
    );
  } catch (reason) {
    if (!loadSnapshot(key).activeRun) {
      publish(key, { ...loadSnapshot(key), activeRun: interrupted });
    }
    throw reason;
  }
}

export function discardInterruptedOpenSpecAction(
  boardKey: string,
  cardId: string,
): void {
  const key = runKey(boardKey, cardId);
  const snapshot = loadSnapshot(key);
  if (snapshot.activeRun?.state !== "interrupted") return;
  publish(key, {
    ...snapshot,
    activeRun: null,
    history: [...snapshot.history, snapshot.activeRun].slice(-MAX_HISTORY),
  });
}

export function acknowledgeOpenSpecPlanningReview(
  boardKey: string,
  cardId: string,
): void {
  const key = runKey(boardKey, cardId);
  const snapshot = loadSnapshot(key);
  if (!snapshot.planningReview || snapshot.planningReview.acknowledged) return;
  publish(key, {
    ...snapshot,
    planningReview: {
      ...snapshot.planningReview,
      acknowledged: true,
    },
  });
}

export function clearOpenSpecActionHistory(
  boardKey: string,
  cardId: string,
): void {
  const key = runKey(boardKey, cardId);
  const snapshot = loadSnapshot(key);
  publish(key, { ...snapshot, history: [] });
}

export function resolveOpenSpecAutomaticAction(
  snapshot: OpenSpecActionStatus | null,
  subtasks: readonly Pick<TaskSubtask, "status">[] = [],
): OpenSpecWorkspaceAction {
  if (!snapshot?.isPlanningComplete) {
    const hasStarted = Boolean(
      snapshot?.artifacts.some(
        (artifact) => artifact.status === "done" || artifact.status === "skipped",
      ),
    );
    return hasStarted ? "update" : "new";
  }
  if (
    subtasks.length > 0 &&
    subtasks.some((task) => task.status !== "completed")
  ) {
    return "apply";
  }
  return snapshot.isComplete ? "verify" : "apply";
}

export function __resetOpenSpecActionsForTests(): void {
  __resetTaskExecutionsForTests();
  snapshots.clear();
  listeners.clear();
  sequence = 0;
}
