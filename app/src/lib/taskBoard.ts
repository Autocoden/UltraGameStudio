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
  | 'backlog'
  | 'queue'
  | 'in_progress'
  | 'ai_review'
  | 'human_review'
  | 'done';

export const TASK_STATUSES: readonly TaskStatus[] = [
  'backlog',
  'queue',
  'in_progress',
  'ai_review',
  'human_review',
  'done',
];

/** Classification enums — same value sets as Autocode's ClassificationFields. */
export type TaskCategory = 'feature' | 'bug_fix' | 'refactoring' | 'documentation' | 'security';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';
export type TaskComplexity = 'trivial' | 'small' | 'medium' | 'large' | 'complex';
export type TaskImpact = 'low' | 'medium' | 'high' | 'critical';

export const TASK_CATEGORIES: readonly TaskCategory[] = [
  'feature',
  'bug_fix',
  'refactoring',
  'documentation',
  'security',
];
export const TASK_PRIORITIES: readonly TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
export const TASK_COMPLEXITIES: readonly TaskComplexity[] = [
  'trivial',
  'small',
  'medium',
  'large',
  'complex',
];
export const TASK_IMPACTS: readonly TaskImpact[] = ['low', 'medium', 'high', 'critical'];

/**
 * Execution phase of a task on the Autocode-style pipeline: the runner picks
 * queued cards up, executes them (executing), audits the result (reviewing),
 * then hands them to human acceptance (awaiting_human / failed) until the user
 * approves (complete).
 */
export type TaskExecutionPhase =
  | 'idle'
  | 'executing'
  | 'reviewing'
  | 'awaiting_human'
  | 'complete'
  | 'failed';

export const TASK_EXECUTION_PHASES: readonly TaskExecutionPhase[] = [
  'idle',
  'executing',
  'reviewing',
  'awaiting_human',
  'complete',
  'failed',
];

/** Optional classification metadata set from the create/edit dialog. */
export interface TaskMeta {
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

export interface TaskCard {
  id: string;
  title: string;
  note: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
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

const STORAGE_KEY = 'ugs.taskboard.v1';
/** v2: Autocode-aligned six-stage statuses. v1 (todo/doing/done) migrates on load. */
const STORAGE_VERSION = 2;

/** v1 → v2 status mapping (todo→backlog, doing→in_progress, done→done). */
const LEGACY_STATUS_MAP: Record<string, TaskStatus> = {
  todo: 'backlog',
  doing: 'in_progress',
  done: 'done',
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
    return typeof window !== 'undefined' && !!window.localStorage;
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
 * Startup recovery (Autocode-style queue semantics): cards left executing or
 * reviewing by a previous session go back to the queue — their agent processes
 * are gone, and re-running a task is idempotent. Runs once per module load,
 * before the runner's first pump can observe the stale phases.
 */
function recoverStaleExecutingCards(boards: Record<string, TaskCard[]>): Record<string, TaskCard[]> {
  let changed = false;
  const recovered: Record<string, TaskCard[]> = {};
  for (const [key, cards] of Object.entries(boards)) {
    recovered[key] = cards.map((card) => {
      if (card.phase !== 'executing' && card.phase !== 'reviewing') return card;
      changed = true;
      return { ...card, status: 'queue' as TaskStatus, phase: 'idle' as TaskExecutionPhase };
    });
  }
  return changed ? recovered : boards;
}

function sanitizeStoredShape(value: unknown): StoredShape {
  if (typeof value !== 'object' || value === null) {
    return { version: STORAGE_VERSION, boards: {} };
  }
  const raw = value as { version?: unknown; boards?: unknown };
  // v1 boards carry the legacy three-stage statuses and migrate on load.
  if (
    (raw.version !== STORAGE_VERSION && raw.version !== 1) ||
    typeof raw.boards !== 'object' ||
    raw.boards === null
  ) {
    return { version: STORAGE_VERSION, boards: {} };
  }
  const legacy = raw.version === 1;
  const sanitized: Record<string, TaskCard[]> = {};
  for (const [key, cards] of Object.entries(raw.boards as Record<string, unknown>)) {
    if (!Array.isArray(cards)) continue;
    const clean = cards
      .map((card) => sanitizeCard(card, legacy))
      .filter((card): card is TaskCard => card !== null);
    if (clean.length > 0) sanitized[key] = clean;
  }
  return { version: STORAGE_VERSION, boards: sanitized };
}

function enumOf<T extends string>(list: readonly T[], value: unknown): T | undefined {
  return typeof value === 'string' && (list as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function sanitizeCard(value: unknown, legacyStatuses = false): TaskCard | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Partial<TaskCard>;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (typeof raw.title !== 'string' || !raw.title.trim()) return null;
  let status = raw.status;
  if (legacyStatuses && typeof status === 'string' && status in LEGACY_STATUS_MAP) {
    status = LEGACY_STATUS_MAP[status];
  }
  if (!TASK_STATUSES.includes(status as TaskStatus)) return null;
  const now = Date.now();
  return {
    id: raw.id,
    title: raw.title,
    note: typeof raw.note === 'string' ? raw.note : '',
    status: status as TaskStatus,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now,
    ...(status === 'done' && typeof raw.completedAt === 'number'
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
      executionError: typeof raw.executionError === 'string' ? raw.executionError : undefined,
      archived: typeof raw.archived === 'boolean' ? raw.archived : undefined,
    }),
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
  const out: TaskMeta = {};
  if (meta.category) out.category = meta.category;
  if (meta.priority) out.priority = meta.priority;
  if (meta.complexity) out.complexity = meta.complexity;
  if (meta.impact) out.impact = meta.impact;
  return out;
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
  return trimmed || 'default';
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
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through to the manual v4 shape */
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
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
  note = '',
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

export type TaskPatch = { title?: string; note?: string; meta?: Partial<TaskMeta> };

/** Edit an existing card. A blank title patch is rejected (false). `meta` shallow-merges: an explicit `undefined` clears the field. */
export function updateTask(boardKey: string, id: string, patch: TaskPatch): boolean {
  const cards = boardCards(boardKey);
  const index = cards.findIndex((c) => c.id === id);
  if (index < 0) return false;
  const card = cards[index];
  if (patch.title !== undefined) {
    const trimmed = patch.title.trim();
    if (!trimmed) return false;
    card.title = trimmed;
  }
  if (patch.note !== undefined) {
    card.note = patch.note.trim();
  }
  if (patch.meta) {
    const target = card as Record<keyof TaskMeta, TaskMeta[keyof TaskMeta] | undefined>;
    for (const key of ['category', 'priority', 'complexity', 'impact'] as const) {
      if (key in patch.meta) {
        target[key] = patch.meta[key];
      }
    }
  }
  card.updatedAt = Date.now();
  replaceBoard(
    boardKey,
    cards.map((c, i) => (i === index ? { ...c } : c)),
  );
  emit();
  return true;
}

/**
 * Move a card to `status`, re-appending it as the last card of that column.
 * Entering `done` stamps `completedAt`; leaving it clears the stamp. Moving to
 * the card's current status is a no-op reorder (still a fresh snapshot).
 */
export function moveTask(boardKey: string, id: string, status: TaskStatus): boolean {
  const cards = boardCards(boardKey);
  const index = cards.findIndex((c) => c.id === id);
  if (index < 0) return false;
  const card = cards[index];
  const moved: TaskCard = { ...card };
  if (card.status !== status) {
    moved.status = status;
    moved.updatedAt = Date.now();
    if (status === 'done') moved.completedAt = Date.now();
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

/**
 * Archive a completed card (Autocode-style: keep the data, hide it from the
 * default board). Only `done` cards can be archived.
 */
export function archiveTask(boardKey: string, id: string): boolean {
  const cards = boardCards(boardKey);
  const index = cards.findIndex((c) => c.id === id);
  if (index < 0) return false;
  const card = cards[index];
  if (card.status !== 'done' || card.archived) return false;
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
    if (card.status !== 'done' || card.archived) return card;
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
  else if (phase === 'idle') delete next.executionError;
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
  const ok = moveTask(boardKey, id, 'done');
  if (ok) setTaskPhase(boardKey, id, 'complete');
  return ok;
}

/** Send a card back to the queue for another execution round. */
export function requeueTask(boardKey: string, id: string): boolean {
  const cards = boardCards(boardKey);
  const card = cards.find((c) => c.id === id);
  if (!card) return false;
  const ok = moveTask(boardKey, id, 'queue');
  if (ok) setTaskPhase(boardKey, id, 'idle');
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
export function composeTaskPrompt(card: Pick<TaskCard, 'title' | 'note'>): string {
  const note = card.note.trim();
  return note ? `${card.title.trim()}\n\n${note}` : card.title.trim();
}

/** Test hook: re-read in-memory state from storage (localStorage is seeded/cleared by the test). */
export function __resetTaskBoardForTests(): void {
  boards = loadFromStorage();
  snapshotCache.clear();
  listeners.clear();
}
