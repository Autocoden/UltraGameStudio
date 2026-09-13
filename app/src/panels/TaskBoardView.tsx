import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ArrowRight,
  Check,
  Pencil,
  Plus,
  RotateCcw,
  Square,
  Trash2,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { t, type Locale, type TranslationKey } from '@/lib/i18n';
import { useStore } from '@/store/useStore';
import TaskBoardDialog, { type TaskBoardDialogRequest } from '@/panels/TaskBoardDialog';
import {
  getRunnerSnapshot,
  pumpBoard,
  setMaxParallel,
  stopTask,
  subscribeRunner,
} from '@/lib/taskBoardRunner';
import {
  TASK_STATUSES,
  addTask,
  approveTask,
  archiveAllDone,
  archiveTask,
  boardKeyFor,
  columnStep,
  getBoardTasks,
  moveTask,
  requeueTask,
  removeTask,
  restoreTask,
  subscribeTasks,
  updateTask,
  type TaskCard,
  type TaskCategory,
  type TaskComplexity,
  type TaskExecutionPhase,
  type TaskImpact,
  type TaskMeta,
  type TaskPriority,
  type TaskStatus,
} from '@/lib/taskBoard';

/** Column accent per stage — mirrors Autocode's TASK_STATUS_COLORS semantics. */
const COLUMN_STYLES: Record<TaskStatus, { dot: string; pill: string }> = {
  backlog: { dot: 'bg-fg-faint', pill: 'bg-panel-2 text-fg-dim' },
  queue: { dot: 'bg-blue-400', pill: 'bg-blue-500/10 text-blue-300' },
  in_progress: { dot: 'bg-sky-400', pill: 'bg-sky-500/10 text-sky-300' },
  ai_review: { dot: 'bg-amber-400', pill: 'bg-amber-500/10 text-amber-300' },
  human_review: { dot: 'bg-violet-400', pill: 'bg-violet-500/10 text-violet-300' },
  done: { dot: 'bg-emerald-400', pill: 'bg-emerald-500/10 text-emerald-300' },
};

/** Card badge tints — semantics from Autocode's TASK_CATEGORY/PRIORITY/COMPLEXITY/IMPACT_COLORS. */
const CATEGORY_BADGE: Record<TaskCategory, string> = {
  feature: 'bg-sky-500/10 text-sky-300',
  bug_fix: 'bg-red-500/10 text-red-300',
  refactoring: 'bg-cyan-500/10 text-cyan-300',
  documentation: 'bg-amber-500/10 text-amber-300',
  security: 'bg-red-500/10 text-red-300',
};
/** Only medium and up show (Autocode hides low). */
const PRIORITY_BADGE: Partial<Record<TaskPriority, string>> = {
  medium: 'bg-amber-500/10 text-amber-300',
  high: 'bg-orange-500/10 text-orange-300',
  urgent: 'bg-red-500/10 text-red-300',
};
const COMPLEXITY_BADGE: Record<TaskComplexity, string> = {
  trivial: 'bg-emerald-500/10 text-emerald-300',
  small: 'bg-sky-500/10 text-sky-300',
  medium: 'bg-amber-500/10 text-amber-300',
  large: 'bg-orange-500/10 text-orange-300',
  complex: 'bg-red-500/10 text-red-300',
};
/** Only medium and up show (Autocode hides low). */
const IMPACT_BADGE: Partial<Record<TaskImpact, string>> = {
  medium: 'bg-sky-500/10 text-sky-300',
  high: 'bg-amber-500/10 text-amber-300',
  critical: 'bg-red-500/10 text-red-300',
};

/** Execution-phase marker tints — Autocode EXECUTION_PHASE semantics. */
const PHASE_BADGE: Record<TaskExecutionPhase, { cls: string; key: TranslationKey } | null> = {
  idle: null,
  executing: { cls: 'bg-sky-500/10 text-sky-300', key: 'board.phase.executing' },
  reviewing: { cls: 'bg-amber-500/10 text-amber-300', key: 'board.phase.reviewing' },
  awaiting_human: { cls: 'bg-violet-500/10 text-violet-300', key: 'board.phase.awaiting_human' },
  complete: { cls: 'bg-emerald-500/10 text-emerald-300', key: 'board.phase.complete' },
  failed: { cls: 'bg-red-500/10 text-red-300', key: 'board.phase.failed' },
};

/**
 * CONTRACT: default export, no props. Full-page 任务看板 view, opened from the
 * app rail's first entry (above 智能终端).
 *
 * Six Autocode-aligned stages (待规划 → 队列 → 进行中 → AI 审核 → 人工审核 →
 * 完成) in a horizontally scrollable board. Each column header has a "+"
 * button that opens the create-task dialog (Autocode-style — no inline
 * composer); the same dialog edits existing cards. Cards show Autocode-rule
 * classification badges and support drag-and-drop or button moves, clear-done.
 *
 * Queued cards execute autonomously via `lib/taskBoardRunner` (Autocode
 * pipeline: 队列 → 进行中 → AI 审核 → 人工审核 → 完成). This view feeds the
 * runner the active workspace/permission on every board change and renders
 * execution-phase markers, stop / approve / requeue actions and the
 * parallel-execution control.
 *
 * Board data lives in `lib/taskBoard` (module store + localStorage), keyed by
 * the active workspace path so each workspace keeps its own board.
 */
export default function TaskBoardView() {
  const locale = useStore((s) => s.locale);
  const workspaces = useStore((s) => s.workspaces);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const composerWorkspace = useStore((s) => s.composer.workspace);
  const composerPermission = useStore((s) => s.composer.permission);
  const [dialog, setDialog] = useState<TaskBoardDialogRequest | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const runner = useSyncExternalStore(subscribeRunner, getRunnerSnapshot);
  // Pointer-based card drag. HTML5 DnD is unusable inside Tauri on Windows
  // (the native drag-drop handler swallows WebView2 drag events), so the
  // board implements dragging with pointer events + elementFromPoint.
  const [drag, setDrag] = useState<
    { id: string; title: string; x: number; y: number; over: TaskStatus | null } | null
  >(null);
  const dragInfoRef = useRef<{
    id: string;
    title: string;
    status: TaskStatus;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);

  const workspacePath = useMemo(() => {
    const activePath = workspaces.find((w) => w.id === activeWorkspaceId)?.path?.trim();
    return activePath || composerWorkspace.trim();
  }, [workspaces, activeWorkspaceId, composerWorkspace]);

  const boardKey = useMemo(() => boardKeyFor(workspacePath || null), [workspacePath]);
  const boardKeyRef = useRef(boardKey);
  boardKeyRef.current = boardKey;

  // Feed the execution runner: pump the queue on every board change, always
  // with the latest workspace/permission via a ref (permission changes need
  // no resubscription).
  const runnerCtxRef = useRef({ cwd: workspacePath, permission: composerPermission || 'full' });
  runnerCtxRef.current = { cwd: workspacePath, permission: composerPermission || 'full' };
  useEffect(() => {
    const pump = () => pumpBoard(boardKey, runnerCtxRef.current);
    pump();
    return subscribeTasks(pump);
  }, [boardKey]);

  const cards = useSyncExternalStore(
    subscribeTasks,
    useCallback(() => getBoardTasks(boardKey), [boardKey]),
  );

  const byStatus = useMemo(() => {
    const grouped = Object.fromEntries(
      TASK_STATUSES.map((status) => [status, [] as TaskCard[]]),
    ) as Record<TaskStatus, TaskCard[]>;
    for (const card of cards) {
      // Guard against statuses from a future/foreign storage shape.
      if (!TASK_STATUSES.includes(card.status)) continue;
      grouped[card.status].push(card);
    }
    return grouped;
  }, [cards]);

  const columnAt = (x: number, y: number): TaskStatus | null => {
    const el = document.elementFromPoint(x, y);
    const col = el?.closest('[data-board-column]') as HTMLElement | null;
    return (col?.getAttribute('data-board-column') as TaskStatus | null) ?? null;
  };

  /** Pointer-drag entry point for a card (see the note above about HTML5 DnD). */
  const beginCardPointerDrag = useCallback((card: TaskCard, event: React.PointerEvent) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button,input,textarea,select')) return;
    if (card.archived) return;
    dragInfoRef.current = {
      id: card.id,
      title: card.title,
      status: card.status,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    const onMove = (ev: PointerEvent) => {
      const info = dragInfoRef.current;
      if (!info) return;
      if (!info.moved && Math.hypot(ev.clientX - info.startX, ev.clientY - info.startY) < 5) return;
      info.moved = true;
      setDrag({
        id: info.id,
        title: info.title,
        x: ev.clientX,
        y: ev.clientY,
        over: columnAt(ev.clientX, ev.clientY),
      });
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      document.body.style.userSelect = dragPrevUserSelect;
      const info = dragInfoRef.current;
      dragInfoRef.current = null;
      setDrag(null);
      if (!info || !info.moved) return;
      const over = columnAt(ev.clientX, ev.clientY);
      if (over && over !== info.status) moveTask(boardKeyRef.current, info.id, over);
    };
    const onCancel = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      document.body.style.userSelect = dragPrevUserSelect;
      dragInfoRef.current = null;
      setDrag(null);
    };
    const dragPrevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }, []);

  const submitDialog = useCallback(
    (values: { title: string; note: string; meta: TaskMeta }) => {
      if (!dialog) return false;
      if (dialog.mode === 'create') {
        return addTask(boardKey, dialog.status, values.title, values.note, values.meta) !== null;
      }
      if (!dialog.card) return false;
      return updateTask(boardKey, dialog.card.id, {
        title: values.title,
        note: values.note,
        meta: values.meta,
      });
    },
    [boardKey, dialog],
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-bg">
      <header className="flex shrink-0 items-end justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h1 className="text-base font-semibold text-fg">{t(locale, 'board.title')}</h1>
          <p className="mt-1 text-xs text-fg-dim">{t(locale, 'board.subtitle')}</p>
        </div>
        <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-fg-dim">
          {t(locale, 'board.runner.parallel')}
          <select
            value={runner.maxParallel}
            onChange={(event) => setMaxParallel(Number.parseInt(event.target.value, 10))}
            className="h-7 rounded-md border border-border bg-panel px-1.5 text-xs text-fg focus:border-accent focus:outline-none"
          >
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </header>
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
        {TASK_STATUSES.map((status) => (
          <BoardColumn
            key={status}
            locale={locale}
            boardKey={boardKey}
            status={status}
            label={t(locale, `board.column.${status}`)}
            style={COLUMN_STYLES[status]}
            cards={byStatus[status]}
            showArchived={showArchived}
            onToggleShowArchived={() => setShowArchived((v) => !v)}
            dragOver={drag?.over === status}
            onCardPointerDown={beginCardPointerDrag}
            onEdit={(card) => setDialog({ mode: 'edit', status: card.status, card })}
            onAdd={() => setDialog({ mode: 'create', status })}
          />
        ))}
      </div>
      {dialog && (
        <TaskBoardDialog
          locale={locale}
          request={dialog}
          onClose={() => setDialog(null)}
          onSubmit={submitDialog}
        />
      )}
      {drag && (
        <div
          className="pointer-events-none fixed z-[95] max-w-56 -translate-y-1/2 rounded-md border border-accent bg-panel px-2.5 py-2 text-xs text-fg opacity-80 shadow-2xl"
          style={{ left: drag.x + 12, top: drag.y }}
        >
          {drag.title}
        </div>
      )}
    </div>
  );
}

function BoardColumn({
  locale,
  boardKey,
  status,
  label,
  style,
  cards,
  showArchived,
  dragOver,
  onCardPointerDown,
  onToggleShowArchived,
  onEdit,
  onAdd,
}: {
  locale: Locale;
  boardKey: string;
  status: TaskStatus;
  label: string;
  style: { dot: string; pill: string };
  cards: TaskCard[];
  showArchived: boolean;
  dragOver: boolean;
  onCardPointerDown: (card: TaskCard, event: React.PointerEvent) => void;
  onToggleShowArchived: () => void;
  onEdit: (card: TaskCard) => void;
  onAdd: () => void;
}) {
  const isDone = status === 'done';
  // Archived done-cards stay out of the default view and the counters.
  const archivedCount = cards.filter((c) => c.archived).length;
  const visible = isDone && !showArchived ? cards.filter((c) => !c.archived) : cards;

  return (
    <section
      aria-label={label}
      data-board-column={status}
      className={cn(
        'flex min-h-0 w-64 min-w-64 shrink-0 grow flex-col rounded-lg border bg-panel transition-colors',
        dragOver ? 'border-accent' : 'border-border',
      )}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2 className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-fg">
          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', style.dot)} aria-hidden />
          <span className="truncate">{label}</span>
          <span
            className={cn(
              'shrink-0 rounded-full px-1.5 font-mono text-[10px] leading-4',
              style.pill,
            )}
          >
            {visible.length}
          </span>
        </h2>
        <div className="flex shrink-0 items-center gap-1">
          {isDone && archivedCount > 0 && (
            <button
              type="button"
              onClick={onToggleShowArchived}
              className="text-[11px] text-fg-dim transition-colors hover:text-fg"
            >
              {t(locale, showArchived ? 'board.archive.hide' : 'board.archive.show')}
              {showArchived ? null : ` (${archivedCount})`}
            </button>
          )}
          {isDone && visible.some((c) => !c.archived) && (
            <button
              type="button"
              onClick={() => archiveAllDone(boardKey)}
              className="text-[11px] text-fg-dim transition-colors hover:text-fg"
            >
              {t(locale, 'board.archive.all')}
            </button>
          )}
          <button
            type="button"
            title={t(locale, 'board.column.add')}
            aria-label={`${t(locale, 'board.column.add')} · ${label}`}
            onClick={onAdd}
            className="rounded p-1 text-fg-faint transition-colors hover:bg-border-soft hover:text-fg"
          >
            <Plus size={13} aria-hidden />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        {visible.length === 0 && archivedCount === 0 && (
          <p className="px-1 py-3 text-center text-[11px] text-fg-faint">
            {t(locale, 'board.column.empty')}
          </p>
        )}
        {visible.map((card) => (
          <TaskCardItem
            key={card.id}
            locale={locale}
            boardKey={boardKey}
            card={card}
            onCardPointerDown={onCardPointerDown}
            onEdit={onEdit}
          />
        ))}
      </div>
    </section>
  );
}

function TaskCardItem({
  locale,
  boardKey,
  card,
  onCardPointerDown,
  onEdit,
}: {
  locale: Locale;
  boardKey: string;
  card: TaskCard;
  onCardPointerDown: (card: TaskCard, event: React.PointerEvent) => void;
  onEdit: (card: TaskCard) => void;
}) {
  const step = columnStep(card.status);
  const canMovePrev = step > 0;
  const canMoveNext = step < TASK_STATUSES.length - 1;
  const isExecuting = card.phase === 'executing' || card.phase === 'reviewing';
  const awaitingHuman = card.status === 'human_review' && (card.phase === 'awaiting_human' || card.phase === 'failed');
  const phaseBadge = card.phase ? PHASE_BADGE[card.phase] : null;
  const archived = !!card.archived;

  return (
    <article
      onPointerDown={(event) => {
        if (!isExecuting && !archived) onCardPointerDown(card, event);
      }}
      className={cn(
        'group rounded-md border border-border bg-bg p-2.5 shadow-sm',
        archived && 'border-border-soft bg-panel opacity-60',
      )}
    >
      <h3 className={cn('break-words text-xs font-medium', archived ? 'text-fg-dim' : 'text-fg')}>
        {card.title}
      </h3>
      {card.note && (
        <p className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-fg-dim">
          {card.note}
        </p>
      )}
      {(card.category || card.complexity || (card.priority && card.priority !== 'low') || (card.impact && card.impact !== 'low') || phaseBadge || archived) && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {archived && (
            <CardBadge className="bg-panel-2 text-fg-dim">
              {t(locale, 'board.archived.tag')}
            </CardBadge>
          )}
          {phaseBadge && (
            <CardBadge className={phaseBadge.cls}>{t(locale, phaseBadge.key)}</CardBadge>
          )}
          {card.category && (
            <CardBadge className={CATEGORY_BADGE[card.category]}>
              {t(locale, `board.category.${card.category}`)}
            </CardBadge>
          )}
          {card.impact && card.impact !== 'low' && (
            <CardBadge className={IMPACT_BADGE[card.impact]!}>
              {t(locale, `board.impact.${card.impact}`)}
            </CardBadge>
          )}
          {card.complexity && (
            <CardBadge className={COMPLEXITY_BADGE[card.complexity]}>
              {t(locale, `board.complexity.${card.complexity}`)}
            </CardBadge>
          )}
          {card.priority && card.priority !== 'low' && (
            <CardBadge className={PRIORITY_BADGE[card.priority]!}>
              {t(locale, `board.priority.${card.priority}`)}
            </CardBadge>
          )}
        </div>
      )}
      {card.phase === 'failed' && card.executionError && (
        <p className="mt-1 break-words text-[10px] leading-relaxed text-red-400" title={card.executionError}>
          {card.executionError}
        </p>
      )}
      {card.status === 'done' && card.completedAt && (
        <p className="mt-1 text-[10px] text-fg-faint">
          {t(locale, 'board.card.doneAt').replace(
            '{time}',
            new Date(card.completedAt).toLocaleString(locale),
          )}
        </p>
      )}
      <div className="mt-2 flex items-center gap-0.5 text-fg-faint">
        <CardButton
          label={t(locale, 'board.card.movePrev')}
          disabled={!canMovePrev || isExecuting || archived}
          onClick={() => moveTask(boardKey, card.id, TASK_STATUSES[step - 1])}
        >
          <ArrowLeft size={13} aria-hidden />
        </CardButton>
        <CardButton
          label={t(locale, 'board.card.moveNext')}
          disabled={!canMoveNext || isExecuting || archived}
          onClick={() => moveTask(boardKey, card.id, TASK_STATUSES[step + 1])}
        >
          <ArrowRight size={13} aria-hidden />
        </CardButton>
        {isExecuting && (
          <CardButton
            label={t(locale, 'board.card.stop')}
            highlight
            onClick={() => stopTask(boardKey, card.id)}
          >
            <Square size={13} aria-hidden />
          </CardButton>
        )}
        {awaitingHuman && (
          <>
            <CardButton
              label={t(locale, 'board.card.approve')}
              highlight
              onClick={() => approveTask(boardKey, card.id)}
            >
              <Check size={13} aria-hidden />
            </CardButton>
            <CardButton
              label={t(locale, 'board.card.requeue')}
              onClick={() => requeueTask(boardKey, card.id)}
            >
              <RotateCcw size={13} aria-hidden />
            </CardButton>
          </>
        )}
        {card.status === 'done' && !archived && (
          <CardButton
            label={t(locale, 'board.archive.one')}
            onClick={() => archiveTask(boardKey, card.id)}
          >
            <Archive size={13} aria-hidden />
          </CardButton>
        )}
        {archived && (
          <CardButton
            label={t(locale, 'board.archive.restore')}
            highlight
            onClick={() => restoreTask(boardKey, card.id)}
          >
            <ArchiveRestore size={13} aria-hidden />
          </CardButton>
        )}
        <span className="flex-1" />
        {!archived && (
          <CardButton label={t(locale, 'board.card.edit')} onClick={() => onEdit(card)}>
            <Pencil size={13} aria-hidden />
          </CardButton>
        )}
        <CardButton
          label={t(locale, 'board.card.delete')}
          disabled={isExecuting}
          onClick={() => removeTask(boardKey, card.id)}
        >
          <Trash2 size={13} aria-hidden />
        </CardButton>
      </div>
    </article>
  );
}

function CardBadge({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0 text-[10px] leading-4',
        className,
      )}
    >
      {children}
    </span>
  );
}

function CardButton({
  label,
  disabled,
  highlight,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  highlight?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'rounded p-1 transition-colors disabled:cursor-not-allowed disabled:opacity-30',
        highlight
          ? 'text-accent hover:bg-accent/15'
          : 'hover:bg-border-soft hover:text-fg',
      )}
    >
      {children}
    </button>
  );
}
