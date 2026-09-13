/**
 * CONTRACT: Autocode-style task execution queue for the 任务看板.
 *
 * Mirrors Autocode's agent-queue flow: cards in the 队列 (queue) column are
 * picked up in order by the runner, bounded by a user-set parallel cap. One
 * execution = two CLI calls, mirroring Autocode's coding → qa_review phases:
 *   1. work call — the agent completes the task directly in the workspace;
 *   2. audit call — a read-only verifier checks the workspace and answers
 *      PASS / FAIL: reason.
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
import { cancelAiCli, tauriAvailable } from '@/lib/tauri';
import {
  completeGatewayText,
  resolveCliGatewayRoute,
} from '@/lib/modelGateway/modelGateway';
import {
  getExplicitActiveGatewaySelection,
  getDefaultGatewaySelection,
} from '@/lib/gatewayConfig';
import {
  getBoardTasks,
  moveTask,
  setTaskPhase,
  type TaskCard,
} from './taskBoard';

const RUNNER_STORAGE_KEY = 'ugs.taskboard.runner.v1';
const DEFAULT_MAX_PARALLEL = 1;
const MIN_MAX_PARALLEL = 1;
const MAX_MAX_PARALLEL = 4;

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
let maxParallel = loadMaxParallel();

function loadMaxParallel(): number {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return DEFAULT_MAX_PARALLEL;
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
    if (typeof window !== 'undefined' && window.localStorage) {
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

export function getMaxParallel(): number {
  return maxParallel;
}

export function setMaxParallel(value: number): void {
  const next = Math.min(MAX_MAX_PARALLEL, Math.max(MIN_MAX_PARALLEL, Math.floor(value)));
  if (next === maxParallel) return;
  maxParallel = next;
  persistMaxParallel();
  emit();
}

/** Cached snapshot — useSyncExternalStore requires a stable identity between changes. */
let runnerSnapshot = { maxParallel, runningCount: 0 };

/** Reactive snapshot for the board header (parallel control + running count). */
export function getRunnerSnapshot(): { maxParallel: number; runningCount: number } {
  if (runnerSnapshot.maxParallel !== maxParallel || runnerSnapshot.runningCount !== running.size) {
    runnerSnapshot = { maxParallel, runningCount: running.size };
  }
  return runnerSnapshot;
}

export function isTaskRunning(boardKey: string, cardId: string): boolean {
  return running.has(runKey(boardKey, cardId));
}

function runKey(boardKey: string, cardId: string): string {
  return `${boardKey}/${cardId}`;
}

function findQueuedCard(boardKey: string): TaskCard | null {
  return getBoardTasks(boardKey).find((c) => c.status === 'queue') ?? null;
}

/**
 * Try to start queued tasks of `boardKey` while the parallel cap allows.
 * Call again whenever the board changes or a task finishes — it is idempotent.
 */
export function pumpBoard(boardKey: string, ctx: RunnerContext): void {
  if (!tauriAvailable()) return;
  if (!ctx.cwd.trim()) return; // execution needs a workspace
  for (;;) {
    if (running.size >= maxParallel) return;
    const card = findQueuedCard(boardKey);
    if (!card) return;
    const key = runKey(boardKey, card.id);
    if (running.has(key)) {
      // The queued head is already executing (stale column state); wait for it.
      return;
    }
    running.add(key);
    emit();
    void executeCard(boardKey, card.id, card, ctx).finally(() => {
      running.delete(key);
      stopping.delete(key);
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
    feature: '功能',
    bug_fix: '缺陷修复',
    refactoring: '重构',
    documentation: '文档',
    security: '安全',
    low: '低',
    medium: '中',
    high: '高',
    urgent: '紧急',
    trivial: '极低',
    small: '小',
    large: '大',
    complex: '复杂',
    critical: '关键影响',
  };
  const parts: string[] = [];
  if (card.category) parts.push(`分类: ${labelMap[card.category] ?? card.category}`);
  if (card.priority) parts.push(`优先级: ${labelMap[card.priority] ?? card.priority}`);
  if (card.complexity) parts.push(`复杂度: ${labelMap[card.complexity] ?? card.complexity}`);
  if (card.impact) parts.push(`影响: ${labelMap[card.impact] ?? card.impact}`);
  return parts.length > 0 ? parts.join(' | ') : '';
}

const EXEC_SYSTEM_PROMPT = [
  '你是任务执行 agent。请直接在当前工作区完成用户交给你的任务。',
  '要求：',
  '- 直接读取并修改工作区中的文件来完成任务，不要提问，不要等待确认。',
  '- 只做与该任务直接相关的最小充分改动。',
  '- 完成后输出一段简短报告：做了什么改动、关键文件路径、如何验证。',
].join('\n');

const AUDIT_SYSTEM_PROMPT = [
  '你是任务验收审核员。请在当前工作区核实给出的任务是否已经完成（可以读取文件、运行只读检查命令，但不要修改任何文件）。',
  '只输出一行结论：以 PASS 开头表示任务已完成；或以 FAIL: 开头并给出未完成的原因。不要输出其他内容。',
].join('\n');

function taskBrief(card: TaskCard): string {
  const meta = classificationLine(card);
  return [
    `任务标题：${card.title}`,
    card.note.trim() ? `任务描述：${card.note.trim()}` : '',
    meta ? `任务分类：${meta}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

async function executeCard(
  boardKey: string,
  cardId: string,
  card: TaskCard,
  ctx: RunnerContext,
): Promise<void> {
  const runId = executionRunId(boardKey, cardId);
  try {
    // Resolve the ACTIVE channel like the chat does, so execution inherits the
    // configured provider (env/model/command) instead of raw CLI OAuth state.
    const selection = getExplicitActiveGatewaySelection() ?? getDefaultGatewaySelection();
    const route = await resolveCliGatewayRoute(selection);

    setTaskPhase(boardKey, cardId, 'executing');
    moveTask(boardKey, cardId, 'in_progress');
    const workReport = await completeGatewayText({
      route,
      system: EXEC_SYSTEM_PROMPT,
      userContent: taskBrief(card),
      permission: ctx.permission || 'full',
      cwd: ctx.cwd,
      forceCli: true,
      runId,
    });

    setTaskPhase(boardKey, cardId, 'reviewing');
    moveTask(boardKey, cardId, 'ai_review');
    const verdict = (
      await completeGatewayText({
        route,
        system: AUDIT_SYSTEM_PROMPT,
        userContent: [
          taskBrief(card),
          '',
          '执行报告：',
          workReport.trim() || '（agent 未留下报告）',
        ].join('\n'),
        permission: ctx.permission || 'full',
        cwd: ctx.cwd,
        forceCli: true,
        runId,
      })
    ).trim();
    // Models rarely keep the answer to ONE clean line: a verbose verdict may
    // narrate first and state its conclusion at the end ("…校验记录。PASS: …").
    // Trust the LAST explicit PASS/FAIL mark instead of the string prefix.
    const marks = [...verdict.matchAll(/\b(PASS|FAIL)\b/gi)];
    const pass = marks.length > 0
      ? marks[marks.length - 1][1].toUpperCase() === 'PASS'
      : false;
    if (pass) {
      setTaskPhase(boardKey, cardId, 'awaiting_human');
      moveTask(boardKey, cardId, 'human_review');
    } else {
      const reason = verdict.replace(/^FAIL\s*[:：]?\s*/i, '').trim() || 'AI 审核未通过';
      setTaskPhase(boardKey, cardId, 'failed', reason);
      moveTask(boardKey, cardId, 'human_review');
    }
  } catch (err) {
    const stopped = stopping.has(runKey(boardKey, cardId));
    const reason = stopped
      ? '手动停止'
      : `执行失败：${err instanceof Error ? err.message : String(err)}`;
    setTaskPhase(boardKey, cardId, 'failed', reason);
    moveTask(boardKey, cardId, 'human_review');
  }
}

/** Cancel the in-flight execution of a task; it lands in human_review as failed. */
export function stopTask(boardKey: string, cardId: string): void {
  stopping.add(runKey(boardKey, cardId));
  void cancelAiCli(`tbrun_${boardKey}_${cardId}`).catch(() => {});
}

/** Test hook: reset in-memory runner state (localStorage is managed by the test). */
export function __resetRunnerForTests(): void {
  running.clear();
  stopping.clear();
  listeners.clear();
}
