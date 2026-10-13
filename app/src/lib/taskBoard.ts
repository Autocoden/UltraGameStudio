/**
 * CONTRACT: 任务看板 registry — module-level external store for the
 * Autocode-style task board (rail view `board`).
 *
 * Pattern mirrors `lib/downloadRegistry.ts`: a Set of listeners +
 * `getBoardTasks`/`subscribeTasks` consumed via `useSyncExternalStore`, so the
 * board stays decoupled from the zustand main store. All boards persist under
 * one versioned localStorage key, keyed per workspace (`boardKey`), so each
 * workspace gets its own card set and everything survives a reload.
 *
 * Ordering: a board's cards live in one array; a column renders the cards whose
 * `status` matches, preserving array order. `moveTask` re-appends the moved card
 * at the end of the array, which makes it the last card of its target column
 * without disturbing the relative order of the other columns.
 */

/**
 * Kanban stages, in board order — mirrors Autocode's `TASK_STATUS_COLUMNS`
 * (apps/desktop/src/shared/constants/task.ts): backlog → queue → in_progress
 * → ai_review → human_review → done.
 */
export type TaskStatus =
  "backlog" | "queue" | "in_progress" | "ai_review" | "human_review" | "done";

export const TASK_STATUSES: readonly TaskStatus[] = [
  "backlog",
  "queue",
  "in_progress",
  "ai_review",
  "human_review",
  "done",
];

/** Classification enums — same value sets as Autocode's ClassificationFields. */
export type TaskCategory =
  "feature" | "bug_fix" | "refactoring" | "documentation" | "security";
export type TaskPriority = "low" | "medium" | "high" | "urgent";
export type TaskComplexity =
  "trivial" | "small" | "medium" | "large" | "complex";
export type TaskImpact = "low" | "medium" | "high" | "critical";

export const TASK_CATEGORIES: readonly TaskCategory[] = [
  "feature",
  "bug_fix",
  "refactoring",
  "documentation",
  "security",
];
export const TASK_PRIORITIES: readonly TaskPriority[] = [
  "low",
  "medium",
  "high",
  "urgent",
];
export const TASK_COMPLEXITIES: readonly TaskComplexity[] = [
  "trivial",
  "small",
  "medium",
  "large",
  "complex",
];
export const TASK_IMPACTS: readonly TaskImpact[] = [
  "low",
  "medium",
  "high",
  "critical",
];

/**
 * Execution phase of a task on the Autocode-style pipeline: the runner picks
 * queued cards up, plans standard work (planning), executes it (executing),
 * audits the result (reviewing), then hands it to human acceptance
 * (awaiting_human / failed) until the user approves (complete).
 */
export type TaskExecutionPhase =
  | "idle"
  | "planning"
  | "executing"
  | "reviewing"
  | "awaiting_human"
  | "complete"
  | "failed";

export const TASK_EXECUTION_PHASES: readonly TaskExecutionPhase[] = [
  "idle",
  "planning",
  "executing",
  "reviewing",
  "awaiting_human",
  "complete",
  "failed",
];

/** Agent presets and reasoning levels mirror Autocode's task configuration. */
export const TASK_AGENT_PROFILES = [
  "auto",
  "complex",
  "balanced",
  "quick",
  "custom",
] as const;
export type TaskAgentProfile = (typeof TASK_AGENT_PROFILES)[number];

export const TASK_THINKING_LEVELS = ["low", "medium", "high", "xhigh"] as const;
export type TaskThinkingLevel = (typeof TASK_THINKING_LEVELS)[number];

export interface TaskPhaseThinking {
  spec: TaskThinkingLevel;
  planning: TaskThinkingLevel;
  coding: TaskThinkingLevel;
  qa: TaskThinkingLevel;
}

export interface TaskModelSelection {
  adapter: string;
  modelClass: string;
  providerId?: string;
  channelId?: string;
  modelOverride?: string;
  label?: string;
}

export interface TaskReferenceImage {
  id: string;
  path: string;
  fileName: string;
  mime?: string;
}

/** Matches Autocode's per-task attachment limit in create and feedback flows. */
export const TASK_MAX_REFERENCE_IMAGES = 10;

export interface TaskDecisionOption {
  id: string;
  label: string;
  recommended: boolean;
}

export interface TaskOpenQuestionDecision {
  id: string;
  question: string;
  options: TaskDecisionOption[];
}

export interface TaskNeedsInputDecisions {
  blocked: boolean;
  message: string;
  questions: string[];
  decisions: TaskOpenQuestionDecision[];
}

export interface TaskDecisionAnswer {
  questionId: string;
  question: string;
  optionId: string;
  answer: string;
}

/** Optional classification metadata set from the create/edit dialog. */
export interface TaskOptions {
  developmentMode?: "direct" | "standard" | "spec";
  requireReviewBeforeCoding?: boolean;
  useWorktree?: boolean;
  baseBranch?: string;
  pushNewBranches?: boolean;
  model?: string;
  reviewModel?: string;
  agentProfile?: TaskAgentProfile;
  thinkingLevel?: TaskThinkingLevel;
  phaseThinking?: TaskPhaseThinking;
  modelSelection?: TaskModelSelection;
  specModelSelection?: TaskModelSelection;
  planningModelSelection?: TaskModelSelection;
  reviewModelSelection?: TaskModelSelection;
  referenceImages?: TaskReferenceImage[];
  openSpecChange?: string;
  openSpecSchema?: string;
}

export interface TaskSubtask {
  id: string;
  definitionId?: string;
  description?: string;
  dependsOn?: string[];
  title: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  summary?: string;
}

export interface TaskRunRecord {
  phase: "planning" | "executing" | "reviewing";
  /**
   * Raw live activity captured for the run. It includes the structured
   * `<<UGS_TOOL>>` patches emitted by the native CLI bridge, while `text`
   * remains the clean final model answer used by the task workflow.
   */
  streamText?: string;
  text: string;
  startedAt: number;
  completedAt: number;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  thinkingTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  thinkingLevel?: TaskThinkingLevel;
  subtaskId?: string;
  subtaskTitle?: string;
}

export interface TaskMeta extends TaskOptions {
  category?: TaskCategory;
  priority?: TaskPriority;
  complexity?: TaskComplexity;
  impact?: TaskImpact;
  /** Autocode-style execution phase (runner-managed). */
  phase?: TaskExecutionPhase;
  /** Failure reason when `phase === 'failed'`. */
  executionError?: string;
  /** Archived done-cards stay in storage but are hidden from the board by default. */
  archived?: boolean;
}

export interface TaskCard extends TaskOptions {
  id: string;
  title: string;
  note: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  subtasks?: TaskSubtask[];
  runs?: TaskRunRecord[];
  plan?: string;
  planApproved?: boolean;
  feedback?: string;
  needsInput?: TaskNeedsInputDecisions;
  executionCwd?: string;
  /** Full path to this task's persisted artifacts, matching Autocode's specsPath. */
  specsPath?: string;
  /** Task changes were squash-applied and staged in the main project. */
  stagedInMainProject?: boolean;
  /** Pull request created for the task branch. */
  pullRequestUrl?: string;
  /** The isolated worktree was removed after acceptance. */
  worktreeCleaned?: boolean;
  /** Official OpenSpec archive result; independent of hiding a board card. */
  openSpecArchive?: {
    changeName: string;
    path: string;
    specsUpdated: boolean;
  };
  /** Timestamp of completion; only meaningful while `status === 'done'`. */
  completedAt?: number;
  category?: TaskCategory;
  priority?: TaskPriority;
  complexity?: TaskComplexity;
  impact?: TaskImpact;
  /** Autocode-style execution phase (runner-managed). */
  phase?: TaskExecutionPhase;
  /** Failure reason when `phase === 'failed'`. */
  executionError?: string;
  /** Archived done-cards stay in storage but are hidden from the board by default. */
  archived?: boolean;
}

const STORAGE_KEY = "ugs.taskboard.v1";
/** v2: Autocode-aligned six-stage statuses. v1 (todo/doing/done) migrates on load. */
const STORAGE_VERSION = 2;

/** v1 → v2 status mapping (todo→backlog, doing→in_progress, done→done). */
const LEGACY_STATUS_MAP: Record<string, TaskStatus> = {
  todo: "backlog",
  doing: "in_progress",
  done: "done",
};

interface StoredShape {
  version: number;
  boards: Record<string, TaskCard[]>;
}

const listeners = new Set<() => void>();

let boards: Record<string, TaskCard[]> = loadFromStorage();
/** Per-boardKey output cache so `getBoardTasks` stays referentially stable. */
const snapshotCache = new Map<string, TaskCard[]>();
const EMPTY_CARDS: TaskCard[] = [];

function hasStorage(): boolean {
  try {
    return typeof window !== "undefined" && !!window.localStorage;
  } catch {
    return false;
  }
}

function loadFromStorage(): Record<string, TaskCard[]> {
  if (!hasStorage()) return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return recoverStaleExecutingCards(sanitizeStoredShape(parsed).boards);
  } catch {
    // Corrupted storage falls back to an empty board instead of crashing.
    return {};
  }
}

/**
 * Startup recovery (Autocode-style queue semantics): cards left planning,
 * executing or reviewing by a previous session go back to the queue — their
 * agent processes are gone, and re-running a task is idempotent. Runs once per
 * module load, before the runner's first pump can observe the stale phases.
 */
function recoverStaleExecutingCards(
  boards: Record<string, TaskCard[]>,
): Record<string, TaskCard[]> {
  let changed = false;
  const recovered: Record<string, TaskCard[]> = {};
  for (const [key, cards] of Object.entries(boards)) {
    recovered[key] = cards.map((card) => {
      if (
        card.phase !== "planning" &&
        card.phase !== "executing" &&
        card.phase !== "reviewing"
      )
        return card;
      changed = true;
      return {
        ...card,
        status: "queue" as TaskStatus,
        phase: "idle" as TaskExecutionPhase,
      };
    });
  }
  return changed ? recovered : boards;
}

function sanitizeStoredShape(value: unknown): StoredShape {
  if (typeof value !== "object" || value === null) {
    return { version: STORAGE_VERSION, boards: {} };
  }
  const raw = value as { version?: unknown; boards?: unknown };
  // v1 boards carry the legacy three-stage statuses and migrate on load.
  if (
    (raw.version !== STORAGE_VERSION && raw.version !== 1) ||
    typeof raw.boards !== "object" ||
    raw.boards === null
  ) {
    return { version: STORAGE_VERSION, boards: {} };
  }
  const legacy = raw.version === 1;
  const sanitized: Record<string, TaskCard[]> = {};
  for (const [key, cards] of Object.entries(
    raw.boards as Record<string, unknown>,
  )) {
    if (!Array.isArray(cards)) continue;
    const clean = cards
      .map((card) => sanitizeCard(card, legacy))
      .filter((card): card is TaskCard => card !== null);
    if (clean.length > 0) sanitized[key] = clean;
  }
  return { version: STORAGE_VERSION, boards: sanitized };
}

function enumOf<T extends string>(
  list: readonly T[],
  value: unknown,
): T | undefined {
  return typeof value === "string" &&
    (list as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function sanitizeNeedsInput(value: unknown): TaskNeedsInputDecisions | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<TaskNeedsInputDecisions>;
  const decisions = (Array.isArray(raw.decisions) ? raw.decisions : [])
    .map((decision): TaskOpenQuestionDecision | null => {
      if (!decision || typeof decision !== "object") return null;
      const candidate = decision as Partial<TaskOpenQuestionDecision>;
      if (
        typeof candidate.id !== "string" ||
        !candidate.id.trim() ||
        typeof candidate.question !== "string" ||
        !candidate.question.trim()
      ) {
        return null;
      }
      const options = (
        Array.isArray(candidate.options) ? candidate.options : []
      )
        .map((option): TaskDecisionOption | null => {
          if (!option || typeof option !== "object") return null;
          const item = option as Partial<TaskDecisionOption>;
          if (
            typeof item.id !== "string" ||
            !item.id.trim() ||
            typeof item.label !== "string" ||
            !item.label.trim()
          ) {
            return null;
          }
          return {
            id: item.id.trim(),
            label: item.label.trim(),
            recommended: item.recommended === true,
          };
        })
        .filter((option): option is TaskDecisionOption => option !== null)
        .slice(0, 10);
      return {
        id: candidate.id.trim(),
        question: candidate.question.trim(),
        options,
      };
    })
    .filter((decision): decision is TaskOpenQuestionDecision => decision !== null)
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
  if (!resolvedQuestions.length && !decisions.length) return undefined;
  return {
    blocked: raw.blocked !== false,
    message:
      typeof raw.message === "string" && raw.message.trim()
        ? raw.message.trim()
        : "任务等待你回答实施所需的问题。",
    questions: resolvedQuestions,
    decisions,
  };
}

function sanitizeCard(value: unknown, legacyStatuses = false): TaskCard | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Partial<TaskCard>;
  if (typeof raw.id !== "string" || !raw.id) return null;
  if (typeof raw.title !== "string" || !raw.title.trim()) return null;
  let status = raw.status;
  if (
    legacyStatuses &&
    typeof status === "string" &&
    status in LEGACY_STATUS_MAP
  ) {
    status = LEGACY_STATUS_MAP[status];
  }
  if (!TASK_STATUSES.includes(status as TaskStatus)) return null;
  const now = Date.now();
  return {
    id: raw.id,
    title: raw.title,
    note: typeof raw.note === "string" ? raw.note : "",
    status: status as TaskStatus,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : now,
    ...(status === "done" && typeof raw.completedAt === "number"
      ? { completedAt: raw.completedAt }
      : {}),
    ...spreadMeta({
      category: enumOf(TASK_CATEGORIES, raw.category),
      priority: enumOf(TASK_PRIORITIES, raw.priority),
      complexity: enumOf(TASK_COMPLEXITIES, raw.complexity),
      impact: enumOf(TASK_IMPACTS, raw.impact),
    }),
    ...spreadDefined({
      phase: enumOf(TASK_EXECUTION_PHASES, raw.phase),
      executionError:
        typeof raw.executionError === "string" ? raw.executionError : undefined,
      archived: typeof raw.archived === "boolean" ? raw.archived : undefined,
      stagedInMainProject:
        typeof raw.stagedInMainProject === "boolean"
          ? raw.stagedInMainProject
          : undefined,
      pullRequestUrl:
        typeof raw.pullRequestUrl === "string" ? raw.pullRequestUrl : undefined,
      worktreeCleaned:
        typeof raw.worktreeCleaned === "boolean"
          ? raw.worktreeCleaned
          : undefined,
    }),
    ...spreadOptions(raw),
    ...(Array.isArray(raw.subtasks)
      ? {
          subtasks: raw.subtasks.filter(
            (s) =>
              s &&
              typeof s.id === "string" &&
              typeof s.title === "string" &&
              ["pending", "in_progress", "completed", "failed"].includes(
                s.status,
              ),
          ),
        }
      : {}),
    ...(Array.isArray(raw.runs)
      ? {
          runs: raw.runs
            .filter(
              (r) =>
                r &&
                typeof r.text === "string" &&
                ["planning", "executing", "reviewing"].includes(r.phase),
            )
            .map(
              (r) =>
                ({
                  phase: r.phase,
                  ...(typeof r.streamText === "string"
                    ? { streamText: r.streamText.slice(-100_000) }
                    : {}),
                  text: r.text.slice(-100_000),
                  startedAt: typeof r.startedAt === "number" ? r.startedAt : 0,
                  completedAt:
                    typeof r.completedAt === "number" ? r.completedAt : 0,
                  ...(typeof r.error === "string" ? { error: r.error } : {}),
                  ...(typeof r.inputTokens === "number"
                    ? { inputTokens: r.inputTokens }
                    : {}),
                  ...(typeof r.outputTokens === "number"
                    ? { outputTokens: r.outputTokens }
                    : {}),
                  ...(typeof r.totalTokens === "number"
                    ? { totalTokens: r.totalTokens }
                    : {}),
                  ...(typeof r.thinkingTokens === "number"
                    ? { thinkingTokens: r.thinkingTokens }
                    : {}),
                  ...(typeof r.cacheReadTokens === "number"
                    ? { cacheReadTokens: r.cacheReadTokens }
                    : {}),
                  ...(typeof r.cacheCreationTokens === "number"
                    ? { cacheCreationTokens: r.cacheCreationTokens }
                    : {}),
                  ...(enumOf(TASK_THINKING_LEVELS, r.thinkingLevel)
                    ? {
                        thinkingLevel: enumOf(
                          TASK_THINKING_LEVELS,
                          r.thinkingLevel,
                        ),
                      }
                    : {}),
                  ...(typeof r.subtaskId === "string"
                    ? { subtaskId: r.subtaskId }
                    : {}),
                  ...(typeof r.subtaskTitle === "string"
                    ? { subtaskTitle: r.subtaskTitle }
                    : {}),
                }) as TaskRunRecord,
            )
            .slice(-30),
        }
      : {}),
    ...(typeof raw.plan === "string" ? { plan: raw.plan } : {}),
    ...(raw.openSpecArchive &&
    typeof raw.openSpecArchive.changeName === "string" &&
    typeof raw.openSpecArchive.path === "string" &&
    typeof raw.openSpecArchive.specsUpdated === "boolean"
      ? { openSpecArchive: {
          changeName: raw.openSpecArchive.changeName,
          path: raw.openSpecArchive.path,
          specsUpdated: raw.openSpecArchive.specsUpdated,
        } }
      : {}),
    ...(typeof raw.planApproved === "boolean"
      ? { planApproved: raw.planApproved }
      : {}),
    ...(typeof raw.feedback === "string" ? { feedback: raw.feedback } : {}),
    ...(sanitizeNeedsInput(raw.needsInput)
      ? { needsInput: sanitizeNeedsInput(raw.needsInput) }
      : {}),
    ...(typeof raw.executionCwd === "string"
      ? { executionCwd: raw.executionCwd }
      : {}),
  };
}

/** Drop undefined keys so sanitized cards never carry explicit `undefined` fields. */
function spreadDefined<T extends object>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, val] of Object.entries(value)) {
    if (val !== undefined) (out as Record<string, unknown>)[key] = val;
  }
  return out;
}

/** Drop undefined keys so sanitized cards never carry explicit `undefined` fields. */
function spreadMeta(meta: TaskMeta): TaskMeta {
  const out: TaskMeta = spreadOptions(meta);
  if (meta.category) out.category = meta.category;
  if (meta.priority) out.priority = meta.priority;
  if (meta.complexity) out.complexity = meta.complexity;
  if (meta.impact) out.impact = meta.impact;
  return out;
}

function spreadOptions(raw: TaskOptions): TaskOptions {
  return spreadDefined({
    developmentMode: enumOf(
      ["direct", "standard", "spec"] as const,
      raw.developmentMode,
    ),
    requireReviewBeforeCoding:
      typeof raw.requireReviewBeforeCoding === "boolean"
        ? raw.requireReviewBeforeCoding
        : undefined,
    useWorktree:
      typeof raw.useWorktree === "boolean" ? raw.useWorktree : undefined,
    baseBranch: typeof raw.baseBranch === "string" ? raw.baseBranch : undefined,
    pushNewBranches:
      typeof raw.pushNewBranches === "boolean"
        ? raw.pushNewBranches
        : undefined,
    model: typeof raw.model === "string" ? raw.model : undefined,
    reviewModel:
      typeof raw.reviewModel === "string" ? raw.reviewModel : undefined,
    agentProfile: enumOf(TASK_AGENT_PROFILES, raw.agentProfile),
    thinkingLevel: enumOf(TASK_THINKING_LEVELS, raw.thinkingLevel),
    phaseThinking: sanitizePhaseThinking(raw.phaseThinking),
    modelSelection: sanitizeModelSelection(raw.modelSelection),
    specModelSelection: sanitizeModelSelection(raw.specModelSelection),
    planningModelSelection: sanitizeModelSelection(raw.planningModelSelection),
    reviewModelSelection: sanitizeModelSelection(raw.reviewModelSelection),
    referenceImages: Array.isArray(raw.referenceImages)
      ? raw.referenceImages
          .filter(
            (image) =>
              image &&
              typeof image.id === "string" &&
              typeof image.path === "string" &&
              typeof image.fileName === "string",
          )
          .slice(0, TASK_MAX_REFERENCE_IMAGES)
          .map((image) => ({
            id: image.id,
            path: image.path,
            fileName: image.fileName,
            ...(typeof image.mime === "string" ? { mime: image.mime } : {}),
          }))
      : undefined,
    openSpecChange:
      typeof raw.openSpecChange === "string" ? raw.openSpecChange : undefined,
    openSpecSchema:
      typeof raw.openSpecSchema === "string" ? raw.openSpecSchema : undefined,
  });
}

function sanitizePhaseThinking(value: unknown): TaskPhaseThinking | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<TaskPhaseThinking>;
  const spec = enumOf(TASK_THINKING_LEVELS, raw.spec);
  const planning = enumOf(TASK_THINKING_LEVELS, raw.planning);
  const coding = enumOf(TASK_THINKING_LEVELS, raw.coding);
  const qa = enumOf(TASK_THINKING_LEVELS, raw.qa);
  return spec && planning && coding && qa
    ? { spec, planning, coding, qa }
    : undefined;
}

function sanitizeModelSelection(
  value: unknown,
): TaskModelSelection | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<TaskModelSelection>;
  if (typeof raw.adapter !== "string" || typeof raw.modelClass !== "string")
    return undefined;
  return spreadDefined({
    adapter: raw.adapter,
    modelClass: raw.modelClass,
    providerId: typeof raw.providerId === "string" ? raw.providerId : undefined,
    channelId: typeof raw.channelId === "string" ? raw.channelId : undefined,
    modelOverride:
      typeof raw.modelOverride === "string" ? raw.modelOverride : undefined,
    label: typeof raw.label === "string" ? raw.label : undefined,
  }) as TaskModelSelection;
}

function persist(): void {
  if (!hasStorage()) return;
  try {
    const shape: StoredShape = { version: STORAGE_VERSION, boards };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(shape));
  } catch {
    /* quota/unavailable storage must never break the board */
  }
}

function emit(): void {
  persist();
  snapshotCache.clear();
  for (const listener of listeners) listener();
}

export function boardKeyFor(workspaceId: string | null | undefined): string {
  const trimmed = workspaceId?.trim();
  return trimmed || "default";
}

export function subscribeTasks(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable-per-key snapshot of one board's cards (safe for useSyncExternalStore). */
export function getBoardTasks(boardKey: string): TaskCard[] {
  let snapshot = snapshotCache.get(boardKey);
  if (!snapshot) {
    snapshot = boards[boardKey] ?? EMPTY_CARDS;
    snapshotCache.set(boardKey, snapshot);
  }
  return snapshot;
}

export function newTaskId(): string {
  try {
    if (
      typeof crypto !== "undefined" &&
      typeof crypto.randomUUID === "function"
    ) {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through to the manual v4 shape */
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function boardCards(boardKey: string): TaskCard[] {
  return boards[boardKey] ?? EMPTY_CARDS;
}

/**
 * Replace a board's array (never mutate in place): `getBoardTasks` caches the
 * array reference for `useSyncExternalStore`, so in-place mutation would leave
 * the snapshot identity unchanged and the UI would stop updating.
 */
function replaceBoard(boardKey: string, cards: TaskCard[]): void {
  boards[boardKey] = cards;
}

/** Create a card at the end of `status`. Blank titles are rejected (returns null). */
export function addTask(
  boardKey: string,
  status: TaskStatus,
  title: string,
  note = "",
  meta: TaskMeta = {},
): TaskCard | null {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) return null;
  const now = Date.now();
  const card: TaskCard = {
    id: newTaskId(),
    title: trimmedTitle,
    note: note.trim(),
    status,
    createdAt: now,
    updatedAt: now,
    ...spreadMeta(meta),
  };
  replaceBoard(boardKey, [...boardCards(boardKey), card]);
  emit();
  return card;
}

export type TaskPatch = {
  title?: string;
  note?: string;
  meta?: Partial<TaskMeta>;
};

/** Edit an existing card. A blank title patch is rejected (false). `meta` shallow-merges: an explicit `undefined` clears the field. */
export function updateTask(
  boardKey: string,
  id: string,
  patch: TaskPatch,
): boolean {
  const cards = boardCards(boardKey);
  const index = cards.findIndex((c) => c.id === id);
  if (index < 0) return false;
  const card = { ...cards[index] };
  if (patch.title !== undefined) {
    const trimmed = patch.title.trim();
    if (!trimmed) return false;
    card.title = trimmed;
  }
  if (patch.note !== undefined) {
    card.note = patch.note.trim();
  }
  if (patch.meta) {
    const target = card as Record<
      keyof TaskMeta,
      TaskMeta[keyof TaskMeta] | undefined
    >;
    for (const key of [
      "category",
      "priority",
      "complexity",
      "impact",
      "developmentMode",
      "requireReviewBeforeCoding",
      "useWorktree",
      "baseBranch",
      "pushNewBranches",
      "model",
      "reviewModel",
      "agentProfile",
      "thinkingLevel",
      "phaseThinking",
      "modelSelection",
      "specModelSelection",
      "planningModelSelection",
      "reviewModelSelection",
      "referenceImages",
      "openSpecChange",
      "openSpecSchema",
    ] as const) {
      if (key in patch.meta) {
        target[key] = patch.meta[key];
      }
    }
  }
  card.updatedAt = Date.now();
  replaceBoard(
    boardKey,
    cards.map((c, i) => (i === index ? card : c)),
  );
  emit();
  return true;
}

/**
 * Move a card to `status`, re-appending it as the last card of that column.
 * Entering `done` stamps `completedAt`; leaving it clears the stamp. Moving to
 * the card's current status is a no-op reorder (still a fresh snapshot).
 */
export function moveTask(
  boardKey: string,
  id: string,
  status: TaskStatus,
): boolean {
  const cards = boardCards(boardKey);
  const index = cards.findIndex((c) => c.id === id);
  if (index < 0) return false;
  const card = cards[index];
  const moved: TaskCard = { ...card };
  if (card.status !== status) {
    moved.status = status;
    moved.updatedAt = Date.now();
    if (status === "done") moved.completedAt = Date.now();
    else delete moved.completedAt;
  }
  replaceBoard(boardKey, [
    ...cards.slice(0, index),
    ...cards.slice(index + 1),
    moved,
  ]);
  emit();
  return true;
}

export function removeTask(boardKey: string, id: string): boolean {
  const cards = boardCards(boardKey);
  const next = cards.filter((c) => c.id !== id);
  if (next.length === cards.length) return false;
  replaceBoard(boardKey, next);
  emit();
  return true;
}

export function updateTaskExecution(
  boardKey: string,
  id: string,
  patch: Partial<
    Pick<
      TaskCard,
      | "subtasks"
      | "runs"
      | "plan"
      | "planApproved"
      | "feedback"
      | "needsInput"
      | "executionCwd"
      | "specsPath"
      | "stagedInMainProject"
      | "pullRequestUrl"
      | "worktreeCleaned"
      | "openSpecArchive"
    >
  >,
): boolean {
  const cards = boardCards(boardKey);
  if (!cards.some((c) => c.id === id)) return false;
  replaceBoard(
    boardKey,
    cards.map((c) =>
      c.id === id ? { ...c, ...patch, updatedAt: Date.now() } : c,
    ),
  );
  emit();
  return true;
}

export function appendTaskRun(
  boardKey: string,
  id: string,
  run: TaskRunRecord,
): void {
  const card = boardCards(boardKey).find((c) => c.id === id);
  if (card)
    updateTaskExecution(boardKey, id, {
      runs: [
        ...(card.runs || []),
        {
          ...run,
          text: run.text.slice(-100_000),
          ...(run.streamText
            ? { streamText: run.streamText.slice(-100_000) }
            : {}),
        },
      ].slice(-30),
    });
}

export function reorderTask(
  boardKey: string,
  id: string,
  beforeId: string,
): boolean {
  const cards = boardCards(boardKey);
  const card = cards.find((c) => c.id === id);
  const target = cards.find((c) => c.id === beforeId);
  if (!card || !target || card.status !== target.status || id === beforeId)
    return false;
  const next = cards.filter((c) => c.id !== id);
  next.splice(
    next.findIndex((c) => c.id === beforeId),
    0,
    card,
  );
  replaceBoard(boardKey, next);
  emit();
  return true;
}

/**
 * Archive a completed card (Autocode-style: keep the data, hide it from the
 * default board). Only `done` cards can be archived.
 */
export function archiveTask(boardKey: string, id: string): boolean {
  const cards = boardCards(boardKey);
  const index = cards.findIndex((c) => c.id === id);
  if (index < 0) return false;
  const card = cards[index];
  if (card.status !== "done" || card.archived) return false;
  if (card.developmentMode === "spec" &&
    (!card.openSpecArchive || card.openSpecArchive.changeName !== card.openSpecChange)) return false;
  replaceBoard(
    boardKey,
    cards.map((c, i) => (i === index ? { ...c, archived: true } : c)),
  );
  emit();
  return true;
}

/** Undo an archive: the card returns to the normal done column. */
export function restoreTask(boardKey: string, id: string): boolean {
  const cards = boardCards(boardKey);
  const index = cards.findIndex((c) => c.id === id);
  if (index < 0) return false;
  const card = cards[index];
  if (!card.archived) return false;
  replaceBoard(
    boardKey,
    cards.map((c, i) => (i === index ? { ...c, archived: false } : c)),
  );
  emit();
  return true;
}

/** Archive every un-archived done card of the board; other columns are untouched. */
export function archiveAllDone(boardKey: string): number {
  const cards = boardCards(boardKey);
  if (cards.length === 0) return 0;
  let changed = 0;
  const next = cards.map((card) => {
    if (card.status !== "done" || card.archived) return card;
    if (card.developmentMode === "spec" &&
      (!card.openSpecArchive || card.openSpecArchive.changeName !== card.openSpecChange)) return card;
    changed += 1;
    return { ...card, archived: true };
  });
  if (changed === 0) return 0;
  replaceBoard(boardKey, next);
  emit();
  return changed;
}

/**
 * Update a card's execution phase (and failure reason). `phase === 'idle'`
 * clears the error; anything else keeps the previous error unless one is given.
 */
export function setTaskPhase(
  boardKey: string,
  id: string,
  phase: TaskExecutionPhase,
  executionError?: string,
): boolean {
  const cards = boardCards(boardKey);
  const index = cards.findIndex((c) => c.id === id);
  if (index < 0) return false;
  const card = cards[index];
  const next: TaskCard = { ...card, phase };
  if (executionError !== undefined) next.executionError = executionError;
  else if (phase === "idle") delete next.executionError;
  replaceBoard(
    boardKey,
    cards.map((c, i) => (i === index ? next : c)),
  );
  emit();
  return true;
}

/** Human acceptance: the card is done. */
export function approveTask(boardKey: string, id: string): boolean {
  const cards = boardCards(boardKey);
  const card = cards.find((c) => c.id === id);
  if (!card) return false;
  if (
    card.plan &&
    !card.planApproved &&
    (card.developmentMode === "spec" || card.requireReviewBeforeCoding)
  ) {
    updateTaskExecution(boardKey, id, { planApproved: true });
    return requeueTask(boardKey, id);
  }
  const ok = moveTask(boardKey, id, "done");
  if (ok) setTaskPhase(boardKey, id, "complete");
  return ok;
}

/** Send a card back to the queue for another execution round. */
export function requeueTask(boardKey: string, id: string): boolean {
  const cards = boardCards(boardKey);
  const card = cards.find((c) => c.id === id);
  if (!card) return false;
  updateTaskExecution(boardKey, id, {
    stagedInMainProject: false,
    pullRequestUrl: undefined,
    worktreeCleaned: false,
    ...(card.worktreeCleaned ? { executionCwd: undefined } : {}),
  });
  const ok = moveTask(boardKey, id, "queue");
  if (ok) setTaskPhase(boardKey, id, "idle");
  return ok;
}

/** Column order index used by prev/next buttons: todo → doing → done. */
export function columnStep(status: TaskStatus): number {
  return TASK_STATUSES.indexOf(status);
}

/**
 * Compose the prompt text sent to the smart terminal for a card: the title,
 * then the note as its own block when present.
 */
export function composeTaskPrompt(
  card: Pick<TaskCard, "title" | "note">,
): string {
  const note = card.note.trim();
  return note ? `${card.title.trim()}\n\n${note}` : card.title.trim();
}

/** Test hook: re-read in-memory state from storage (localStorage is seeded/cleared by the test). */
export function __resetTaskBoardForTests(): void {
  boards = loadFromStorage();
  snapshotCache.clear();
  listeners.clear();
}
