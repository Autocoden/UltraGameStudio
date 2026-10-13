import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ArchiveRestore,
  Clock,
  FileCode,
  MoreVertical,
  Plus,
  Square,
  Zap,
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
  GitPullRequest,
  Lock,
  Unlock,
  Settings,
  ListPlus,
  Inbox,
  Loader2,
  Eye,
  CheckCircle2,
  Play,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { t, type Locale, type TranslationKey } from "@/lib/i18n";
import { useStore } from "@/store/useStore";
import TaskBoardDialog, {
  type TaskBoardDialogRequest,
} from "@/panels/TaskBoardDialog";
import TaskBoardDetail from "@/panels/TaskBoardDetail";
import TaskBulkPullRequestDialog from "@/panels/TaskBulkPullRequestDialog";
import TaskOpenSpecModal from "@/panels/TaskOpenSpecModal";
import { openExternal } from "@/lib/tauri";
import { taskAwaitsPlanApproval } from "@/lib/taskWorktreeReview";
import {
  loadBoardPreferences,
  saveBoardPreferences,
  type ColumnPreference,
} from "@/lib/taskBoardPreferences";
import {
  getMaxParallel,
  getRunnerSnapshot,
  pumpBoard,
  setMaxParallel,
  stopTask,
  subscribeRunner,
} from "@/lib/taskBoardRunner";
import {
  TASK_STATUSES,
  addTask,
  approveTask,
  archiveAllDone,
  archiveTask,
  boardKeyFor,
  getBoardTasks,
  moveTask,
  requeueTask,
  removeTask,
  restoreTask,
  reorderTask,
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
} from "@/lib/taskBoard";

/** Column accent per stage — mirrors Autocode's TASK_STATUS_COLORS semantics. */
const COLUMN_STYLES: Record<TaskStatus, { dot: string; pill: string }> = {
  backlog: { dot: "bg-fg-faint", pill: "bg-panel-2 text-fg-dim" },
  queue: { dot: "bg-blue-400", pill: "bg-blue-500/10 text-blue-300" },
  in_progress: { dot: "bg-sky-400", pill: "bg-sky-500/10 text-sky-300" },
  ai_review: { dot: "bg-amber-400", pill: "bg-amber-500/10 text-amber-300" },
  human_review: {
    dot: "bg-violet-400",
    pill: "bg-violet-500/10 text-violet-300",
  },
  done: { dot: "bg-emerald-400", pill: "bg-emerald-500/10 text-emerald-300" },
};

/** Card badge tints — semantics from Autocode's TASK_CATEGORY/PRIORITY/COMPLEXITY/IMPACT_COLORS. */
const CATEGORY_BADGE: Record<TaskCategory, string> = {
  feature: "bg-sky-500/10 text-sky-300",
  bug_fix: "bg-red-500/10 text-red-300",
  refactoring: "bg-cyan-500/10 text-cyan-300",
  documentation: "bg-amber-500/10 text-amber-300",
  security: "bg-red-500/10 text-red-300",
};
/** Only medium and up show (Autocode hides low). */
const PRIORITY_BADGE: Partial<Record<TaskPriority, string>> = {
  medium: "bg-amber-500/10 text-amber-300",
  high: "bg-orange-500/10 text-orange-300",
  urgent: "bg-red-500/10 text-red-300",
};
const COMPLEXITY_BADGE: Record<TaskComplexity, string> = {
  trivial: "bg-emerald-500/10 text-emerald-300",
  small: "bg-sky-500/10 text-sky-300",
  medium: "bg-amber-500/10 text-amber-300",
  large: "bg-orange-500/10 text-orange-300",
  complex: "bg-red-500/10 text-red-300",
};
/** Only medium and up show (Autocode hides low). */
const IMPACT_BADGE: Partial<Record<TaskImpact, string>> = {
  medium: "bg-sky-500/10 text-sky-300",
  high: "bg-amber-500/10 text-amber-300",
  critical: "bg-red-500/10 text-red-300",
};

/** Execution-phase marker tints — Autocode EXECUTION_PHASE semantics. */
const PHASE_BADGE: Record<
  TaskExecutionPhase,
  { cls: string; key: TranslationKey } | null
> = {
  idle: null,
  planning: {
    cls: "bg-violet-500/10 text-violet-300",
    key: "board.phase.planning",
  },
  executing: {
    cls: "bg-sky-500/10 text-sky-300",
    key: "board.phase.executing",
  },
  reviewing: {
    cls: "bg-amber-500/10 text-amber-300",
    key: "board.phase.reviewing",
  },
  awaiting_human: {
    cls: "bg-violet-500/10 text-violet-300",
    key: "board.phase.awaiting_human",
  },
  complete: {
    cls: "bg-emerald-500/10 text-emerald-300",
    key: "board.phase.complete",
  },
  failed: { cls: "bg-red-500/10 text-red-300", key: "board.phase.failed" },
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
  const [detailId, setDetailId] = useState<string | null>(null);
  const [archiveQueue, setArchiveQueue] = useState<string[]>([]);
  const [queueSettings, setQueueSettings] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteSelection, setDeleteSelection] = useState(false);
  const [bulkPullRequest, setBulkPullRequest] = useState(false);
  useSyncExternalStore(subscribeRunner, getRunnerSnapshot);
  // Pointer-based card drag. HTML5 DnD is unusable inside Tauri on Windows
  // (the native drag-drop handler swallows WebView2 drag events), so the
  // board implements dragging with pointer events + elementFromPoint.
  const [drag, setDrag] = useState<{
    id: string;
    title: string;
    x: number;
    y: number;
    over: TaskStatus | null;
  } | null>(null);
  const dragInfoRef = useRef<{
    id: string;
    title: string;
    status: TaskStatus;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);

  const workspacePath = useMemo(() => {
    const activePath = workspaces
      .find((w) => w.id === activeWorkspaceId)
      ?.path?.trim();
    return activePath || composerWorkspace.trim();
  }, [workspaces, activeWorkspaceId, composerWorkspace]);

  const boardKey = useMemo(
    () => boardKeyFor(workspacePath || null),
    [workspacePath],
  );
  const [preferences, setPreferences] = useState(() =>
    loadBoardPreferences(boardKey),
  );
  useEffect(() => {
    setPreferences(loadBoardPreferences(boardKey));
    setSelected(new Set());
    setDetailId(null);
  }, [boardKey]);
  const changeColumn = (status: TaskStatus, patch: Partial<ColumnPreference>) =>
    setPreferences((current) => {
      const next = { ...current, [status]: { ...current[status], ...patch } };
      try {
        saveBoardPreferences(boardKey, next);
      } catch {
        /* session settings remain usable */
      }
      return next;
    });
  const boardKeyRef = useRef(boardKey);
  boardKeyRef.current = boardKey;

  // Feed the execution runner: pump the queue on every board change, always
  // with the latest workspace/permission via a ref (permission changes need
  // no resubscription).
  const runnerCtxRef = useRef({
    cwd: workspacePath,
    permission: composerPermission || "full",
  });
  runnerCtxRef.current = {
    cwd: workspacePath,
    permission: composerPermission || "full",
  };
  useEffect(() => {
    const pump = () => pumpBoard(boardKey, runnerCtxRef.current);
    pump();
    return subscribeTasks(pump);
  }, [boardKey]);

  const cards = useSyncExternalStore(
    subscribeTasks,
    useCallback(() => getBoardTasks(boardKey), [boardKey]),
  );
  const detailCard = detailId
    ? cards.find((card) => card.id === detailId)
    : undefined;

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

  const collapsedColumnCount = useMemo(
    () => TASK_STATUSES.filter((status) => preferences[status].collapsed).length,
    [preferences],
  );
  const selectableCardIds = useMemo(
    () =>
      new Set(
        cards
          .filter((card) => showArchived || !card.archived)
          .map((card) => card.id),
      ),
    [cards, showArchived],
  );
  useEffect(() => {
    setSelected((current) => {
      const next = new Set(
        [...current].filter((id) => selectableCardIds.has(id)),
      );
      return next.size === current.size ? current : next;
    });
  }, [selectableCardIds]);
  const selectedCards = useMemo(
    () => cards.filter((card) => selected.has(card.id)),
    [cards, selected],
  );
  const toggleTaskSelection = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const changeTaskStatus = useCallback(
    (card: TaskCard, status: TaskStatus) => {
      // Manual completion updates task state only. Worktree integration and
      // cleanup remain explicit actions in task details.
      if (status === "done") approveTask(boardKey, card.id);
      else moveTask(boardKey, card.id, status);
    },
    [boardKey],
  );

  const columnAt = (x: number, y: number): TaskStatus | null => {
    const el = document.elementFromPoint(x, y);
    const col = el?.closest("[data-board-column]") as HTMLElement | null;
    return (
      (col?.getAttribute("data-board-column") as TaskStatus | null) ?? null
    );
  };

  /** Pointer-drag entry point for a card (see the note above about HTML5 DnD). */
  const beginCardPointerDrag = useCallback(
    (card: TaskCard, event: React.PointerEvent) => {
      if (event.button !== 0) return;
      if (
        (event.target as HTMLElement).closest(
          "button,input,textarea,select,summary,details",
        )
      )
        return;
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
        if (
          !info.moved &&
          Math.hypot(ev.clientX - info.startX, ev.clientY - info.startY) < 5
        )
          return;
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
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        document.body.style.userSelect = dragPrevUserSelect;
        const info = dragInfoRef.current;
        dragInfoRef.current = null;
        setDrag(null);
        if (!info || !info.moved) return;
        const over = columnAt(ev.clientX, ev.clientY);
        if (over && over !== info.status)
          changeTaskStatus(card, over);
        else {
          const target = document
            .elementFromPoint(ev.clientX, ev.clientY)
            ?.closest("[data-task-id]")
            ?.getAttribute("data-task-id");
          if (target) reorderTask(boardKeyRef.current, info.id, target);
        }
      };
      const onCancel = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        document.body.style.userSelect = dragPrevUserSelect;
        dragInfoRef.current = null;
        setDrag(null);
      };
      const dragPrevUserSelect = document.body.style.userSelect;
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
    },
    [changeTaskStatus],
  );

  const submitDialog = useCallback(
    (values: {
      title: string;
      note: string;
      meta: TaskMeta;
      start?: boolean;
    }) => {
      if (!dialog) return false;
      if (dialog.mode === "create") {
        return (
          addTask(
            boardKey,
            values.start ? "queue" : dialog.status,
            values.title,
            values.note,
            values.meta,
          ) !== null
        );
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
    <div className="autocode-board flex h-full min-h-0 w-full flex-col overflow-hidden bg-bg">
      <header className="flex h-[60px] shrink-0 items-center justify-between gap-3 px-5">
        <div>
          {collapsedColumnCount >= 3 && (
            <button
              title="展开所有列"
              aria-label="展开所有列"
              className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-fg-dim transition-colors hover:bg-panel-2 hover:text-fg"
              onClick={() =>
                TASK_STATUSES.forEach((status) =>
                  changeColumn(status, { collapsed: false }),
                )
              }
            >
              <ChevronsRight size={16} />
              展开所有列
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            title="刷新任务"
            className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-fg-dim transition-colors hover:bg-panel-2 hover:text-fg"
            onClick={() => pumpBoard(boardKey, runnerCtxRef.current)}
          >
            <RefreshCw size={16} />
            刷新任务
          </button>
          <button
            className="flex h-10 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-bg transition-opacity hover:opacity-90"
            onClick={() => setDialog({ mode: "create", status: "backlog" })}
          >
            <Plus size={16} />
            新建任务
          </button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 gap-4 overflow-x-auto p-4">
        {TASK_STATUSES.map((status) => (
          <BoardColumn
            key={status}
            locale={locale}
            boardKey={boardKey}
            status={status}
            label={t(locale, `board.column.${status}`)}
            style={COLUMN_STYLES[status]}
            cards={byStatus[status]}
            preference={preferences[status]}
            onPreference={(patch) => changeColumn(status, patch)}
            parallel={getMaxParallel(boardKey)}
            onQueueSettings={() => setQueueSettings(true)}
            selected={selected}
            onSelect={toggleTaskSelection}
            onClearSelection={() => setSelected(new Set())}
            onOpen={(card, archive = false) => {
              setArchiveQueue(archive ? [card.id] : []);
              setDetailId(card.id);
            }}
            onArchiveAll={() => {
              const pending = cards.filter(card => card.status === "done" && !card.archived &&
                card.developmentMode === "spec" &&
                (!card.openSpecArchive || card.openSpecArchive.changeName !== card.openSpecChange));
              archiveAllDone(boardKey);
              if (pending.length) {
                setArchiveQueue(pending.map(card => card.id));
                setDetailId(pending[0].id);
              }
            }}
            onMove={changeTaskStatus}
            showArchived={showArchived}
            onToggleShowArchived={() => setShowArchived((v) => !v)}
            dragOver={drag?.over === status}
            onCardPointerDown={beginCardPointerDrag}
            onEdit={(card) =>
              setDialog({ mode: "edit", status: card.status, card })
            }
            onAdd={() => setDialog({ mode: "create", status })}
          />
        ))}
      </div>
      {selected.size > 0 && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2">
          <div className="flex items-center gap-3 rounded-2xl border border-border bg-panel/95 px-4 py-3 text-sm shadow-2xl backdrop-blur-sm">
            <span className="whitespace-nowrap font-medium text-fg">
              已选择 {selected.size} 个任务
            </span>
            <div className="h-5 w-px bg-border" />
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 font-medium text-bg transition-opacity hover:opacity-90"
              onClick={() => setBulkPullRequest(true)}
            >
              <GitPullRequest size={15} />
              创建 PR
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-red-400 transition-colors hover:bg-red-500/10"
              onClick={() => setDeleteSelection(true)}
            >
              <Trash2 size={15} />
              删除所选
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-fg-dim transition-colors hover:bg-panel-2 hover:text-fg"
              onClick={() => setSelected(new Set())}
            >
              <X size={15} />
              清除选择
            </button>
          </div>
        </div>
      )}
      {detailCard &&
        (detailCard.developmentMode === "spec" ? (
          <TaskOpenSpecModal
            key={`${boardKey}-${detailCard.id}-openspec`}
            boardKey={boardKey}
            cwd={workspacePath}
            card={detailCard}
            locale={locale}
            initialArchive={archiveQueue.includes(detailCard.id)}
            onArchived={() => {
              if (!archiveQueue.length) return;
              const remaining = archiveQueue.filter(id => id !== detailCard.id);
              setArchiveQueue(remaining);
              setDetailId(remaining[0] || null);
            }}
            onClose={() => { setArchiveQueue([]); setDetailId(null); }}
          />
        ) : (
          <TaskBoardDetail
            key={`${boardKey}-${detailCard.id}`}
            boardKey={boardKey}
            cardId={detailCard.id}
            cwd={workspacePath}
            locale={locale}
            onClose={() => setDetailId(null)}
            onEdit={(card) =>
              setDialog({ mode: "edit", status: card.status, card })
            }
          />
        ))}
      {queueSettings && (
        <QueueSettings
          value={getMaxParallel(boardKey)}
          onClose={() => setQueueSettings(false)}
          onSave={(value) => {
            setMaxParallel(value, boardKey);
            pumpBoard(boardKey, runnerCtxRef.current);
            setQueueSettings(false);
          }}
        />
      )}
      {bulkPullRequest && (
        <TaskBulkPullRequestDialog
          boardKey={boardKey}
          mainRoot={workspacePath}
          tasks={selectedCards}
          onClose={() => setBulkPullRequest(false)}
          onComplete={() => setSelected(new Set())}
        />
      )}
      {deleteSelection && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60">
          <div
            role="alertdialog"
            aria-label="删除所选任务"
            className="w-full max-w-[500px] rounded-xl border border-border bg-panel p-6 text-fg shadow-2xl"
          >
            <h2 className="flex items-center gap-2 text-lg font-semibold text-red-400">
              <Trash2 size={19} />
              删除所选任务
            </h2>
            <p className="mt-2 text-sm text-fg-dim">
              确定删除所选 {selected.size} 个任务记录？此操作无法撤销。
            </p>
            <div className="my-4 max-h-32 space-y-1 overflow-y-auto rounded-md border border-border p-2">
              {selectedCards.map((card, index) => (
                <div
                  key={card.id}
                  className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-panel-2"
                >
                  <span className="text-fg-faint">{index + 1}.</span>
                  <span className="min-w-0 flex-1 truncate">{card.title}</span>
                  {(card.phase === "planning" ||
                    card.phase === "executing" ||
                    card.phase === "reviewing") && (
                    <span className="shrink-0 text-xs text-amber-400">
                      运行中，将跳过
                    </span>
                  )}
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <button
                className="rounded-md border border-border px-4 py-2 text-sm hover:bg-panel-2"
                onClick={() => setDeleteSelection(false)}
              >
                取消
              </button>
              <button
                className="rounded-md bg-red-500 px-4 py-2 text-sm text-white hover:bg-red-500/90"
                onClick={() => {
                  const skipped = new Set<string>();
                  for (const id of selected) {
                    const card = cards.find((c) => c.id === id);
                    if (
                      card &&
                      card.phase !== "planning" &&
                      card.phase !== "executing" &&
                      card.phase !== "reviewing"
                    ) {
                      removeTask(boardKey, id);
                    } else if (card) {
                      skipped.add(id);
                    }
                  }
                  setSelected(skipped);
                  setDeleteSelection(false);
                }}
              >
                删除 {selectedCards.filter((card) => card.phase !== "planning" && card.phase !== "executing" && card.phase !== "reviewing").length} 个任务
              </button>
            </div>
          </div>
        </div>
      )}
      {dialog && (
        <TaskBoardDialog
          boardKey={boardKey}
          cwd={workspacePath}
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
  preference,
  onPreference,
  parallel,
  onQueueSettings,
  selected,
  onSelect,
  onClearSelection,
  onOpen,
  onArchiveAll,
  onMove,
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
  preference: ColumnPreference;
  onPreference: (patch: Partial<ColumnPreference>) => void;
  parallel: number;
  onQueueSettings: () => void;
  selected: Set<string>;
  onSelect: (id: string) => void;
  onClearSelection: () => void;
  onOpen: (card: TaskCard, archive?: boolean) => void;
  onArchiveAll: () => void;
  onMove: (card: TaskCard, status: TaskStatus) => void;
  showArchived: boolean;
  dragOver: boolean;
  onCardPointerDown: (card: TaskCard, event: React.PointerEvent) => void;
  onToggleShowArchived: () => void;
  onEdit: (card: TaskCard) => void;
  onAdd: () => void;
}) {
  const isDone = status === "done";
  // Archived done-cards stay out of the default view and the counters.
  const archivedCount = cards.filter((c) => c.archived).length;
  const visible =
    isDone && !showArchived ? cards.filter((c) => !c.archived) : cards;
  const selectedCount = visible.filter((card) => selected.has(card.id)).length;
  const allSelected = visible.length > 0 && selectedCount === visible.length;
  const someSelected = selectedCount > 0 && !allSelected;
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  const colors: Record<TaskStatus, string> = {
    backlog: "#8b949e",
    queue: "#1f9cf0",
    in_progress: "#58a6ff",
    ai_review: "#d29922",
    human_review: "#8250df",
    done: "#3fb950",
  };
  const EmptyIcon =
    status === "backlog"
      ? Inbox
      : status === "done"
        ? CheckCircle2
        : status.includes("review")
          ? Eye
          : Loader2;
  const emptyMessages: Record<TaskStatus, [string, string]> = {
    backlog: ["没有待规划的任务", "添加一个任务以开始"],
    queue: ["队列为空", "当达到并行任务限制时，任务将在此等待"],
    in_progress: ["暂无运行中的任务", "从待规划列开始一个任务"],
    ai_review: ["审核中无任务", "AI 将审核已完成的任务"],
    human_review: ["暂无待审核任务", "查看已完成的任务以合并它们"],
    done: ["暂无已完成的任务", "任务完成后将显示在这里"],
  };

  return (
    <section
      aria-label={label}
      data-board-column={status}
      style={{
        width: preference.collapsed ? 48 : preference.width,
        minWidth: preference.collapsed ? 48 : preference.width,
        borderTopColor: colors[status],
      }}
      className={cn(
        "relative flex min-h-0 shrink-0 flex-col rounded-xl border border-t-2 bg-gradient-to-b from-panel-2/30 to-transparent transition-colors",
        dragOver ? "border-accent" : "border-border",
      )}
    >
      {preference.collapsed ? (
        <>
          <button
            title="展开列"
            aria-label={`展开${label}`}
            className="mx-auto p-3 text-fg-dim"
            onClick={() => onPreference({ collapsed: false })}
          >
            <ChevronRight size={16} />
          </button>
          <div className="flex flex-1 items-center justify-center">
            <h2
              className="flex items-center gap-3 text-sm font-semibold text-fg"
              style={{
                writingMode: "vertical-rl",
                transform: "rotate(180deg)",
              }}
            >
              {label}
              <span>{visible.length}</span>
            </h2>
          </div>
        </>
      ) : (
        <>
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border p-4">
            <h2 className="flex min-w-0 items-center gap-2.5 text-sm font-semibold text-fg">
              <button
                title="折叠列"
                aria-label={`折叠${label}`}
                onClick={() => onPreference({ collapsed: true })}
              >
                <ChevronLeft size={14} />
              </button>
              <input
                type="checkbox"
                aria-label={allSelected ? `取消全选${label}任务` : `全选${label}任务`}
                checked={allSelected}
                disabled={visible.length === 0}
                ref={(node) => {
                  if (node) node.indeterminate = someSelected;
                }}
                onChange={() => {
                  if (allSelected) {
                    onClearSelection();
                    return;
                  }
                  visible
                    .filter((card) => !selected.has(card.id))
                    .forEach((card) => onSelect(card.id));
                }}
                className="h-4 w-4 disabled:opacity-40"
              />
              <span className="truncate">{label}</span>
              <span
                className={cn(
                  "flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full px-1.5 text-xs font-semibold",
                  style.pill,
                )}
              >
                {visible.length}
                {status === "in_progress" ? `/${parallel}` : ""}
              </span>
            </h2>
            <div className="flex shrink-0 items-center gap-1">
              <button
                title={preference.locked ? "解锁列宽" : "锁定列宽"}
                aria-pressed={preference.locked}
                onClick={() => onPreference({ locked: !preference.locked })}
                className={cn(
                  "rounded p-1.5 transition-colors",
                  preference.locked
                    ? "bg-amber-500/10 text-amber-400 hover:bg-amber-500/20"
                    : "text-fg-faint hover:bg-border-soft hover:text-fg-dim",
                )}
              >
                {preference.locked ? <Lock size={14} /> : <Unlock size={14} />}
              </button>
              {status === "backlog" && visible.length > 0 && (
                <button
                  title="全部加入队列"
                  className="p-1 text-fg-faint"
                  onClick={() =>
                    visible.forEach((card) => requeueTask(boardKey, card.id))
                  }
                >
                  <ListPlus size={16} />
                </button>
              )}
              {status === "queue" && (
                <button
                  title="队列设置"
                  onClick={onQueueSettings}
                  className="p-1 text-fg-faint"
                >
                  <Settings size={16} />
                </button>
              )}
              {isDone && visible.some((card) => !card.archived) && !showArchived && (
                <button
                  type="button"
                  title={t(locale, "board.archive.all")}
                  aria-label={t(locale, "board.archive.all")}
                  onClick={onArchiveAll}
                  className="rounded p-1.5 text-fg-faint transition-colors hover:bg-border-soft hover:text-fg-dim"
                >
                  <Archive size={16} />
                </button>
              )}
              {isDone && archivedCount > 0 && (
                <button
                  type="button"
                  title={t(
                    locale,
                    showArchived ? "board.archive.hide" : "board.archive.show",
                  )}
                  aria-label={t(
                    locale,
                    showArchived ? "board.archive.hide" : "board.archive.show",
                  )}
                  aria-pressed={showArchived}
                  onClick={onToggleShowArchived}
                  className={cn(
                    "relative rounded p-1.5 transition-colors",
                    showArchived
                      ? "bg-[#58a6ff]/10 text-accent"
                      : "text-fg-faint hover:bg-border-soft hover:text-fg-dim",
                  )}
                >
                  <Archive size={16} />
                  <span className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-panel-2 px-0.5 text-[9px] font-medium text-fg-dim">
                    {archivedCount}
                  </span>
                </button>
              )}
              {status === "backlog" && (
                <button
                  type="button"
                  title={t(locale, "board.column.add")}
                  aria-label={`${t(locale, "board.column.add")} · ${label}`}
                  onClick={onAdd}
                  className="rounded p-1 text-fg-faint transition-colors hover:bg-border-soft hover:text-fg"
                >
                  <Plus size={13} aria-hidden />
                </button>
              )}
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
            {visible.length === 0 && (
              <div className="flex w-full flex-col items-center rounded-lg border-2 border-dashed border-border px-4 py-6 text-center text-fg-faint">
                <EmptyIcon size={24} className="mb-3 opacity-50" />
                <p className="text-sm">{emptyMessages[status][0]}</p>
                <p className="mt-1 text-xs opacity-70">
                  {emptyMessages[status][1]}
                </p>
              </div>
            )}
            {visible.map((card) => (
              <TaskCardItem
                key={card.id}
                locale={locale}
                boardKey={boardKey}
                card={card}
                onOpen={onOpen}
                selected={selected.has(card.id)}
                onSelect={() => onSelect(card.id)}
                onMove={onMove}
                onCardPointerDown={onCardPointerDown}
                onEdit={onEdit}
              />
            ))}
          </div>
          {!preference.locked && (
            <div
              role="separator"
              aria-label={`调整${label}列宽`}
              aria-orientation="vertical"
              className="absolute inset-y-0 -right-2 w-2 cursor-col-resize touch-none hover:bg-[#58a6ff]/20"
              onPointerDown={(event) => {
                resizeStart.current = {
                  x: event.clientX,
                  width: preference.width,
                };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (
                  resizeStart.current &&
                  event.currentTarget.hasPointerCapture(event.pointerId)
                )
                  onPreference({
                    width: Math.max(
                      180,
                      Math.min(
                        600,
                        resizeStart.current.width +
                          event.clientX -
                          resizeStart.current.x,
                      ),
                    ),
                  });
              }}
              onPointerUp={() => {
                resizeStart.current = null;
              }}
            />
          )}
        </>
      )}
    </section>
  );
}

function TaskCardItem({
  locale,
  boardKey,
  card,
  onOpen,
  selected,
  onSelect,
  onMove,
  onCardPointerDown,
  onEdit,
}: {
  locale: Locale;
  boardKey: string;
  card: TaskCard;
  onOpen: (card: TaskCard, archive?: boolean) => void;
  selected: boolean;
  onSelect: () => void;
  onMove: (card: TaskCard, status: TaskStatus) => void;
  onCardPointerDown: (card: TaskCard, event: React.PointerEvent) => void;
  onEdit: (card: TaskCard) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isExecuting =
    card.phase === "planning" ||
    card.phase === "executing" ||
    card.phase === "reviewing";
  const failed = card.phase === "failed";
  const awaitingPlanApproval = taskAwaitsPlanApproval(card);
  const awaitingHuman =
    card.status === "human_review" &&
    card.phase === "awaiting_human" &&
    !card.needsInput?.blocked;
  const completedSuccessfully =
    card.status === "done" ||
    card.phase === "complete" ||
    (card.phase === "awaiting_human" && !card.needsInput?.blocked && !awaitingPlanApproval);
  const phaseBadge = card.phase ? PHASE_BADGE[card.phase] : null;
  const archived = !!card.archived;
  const completedSubtasks =
    card.subtasks?.filter((subtask) => subtask.status === "completed").length ??
    0;
  const progress =
    card.needsInput?.blocked
      ? 20
      : card.status === "done" ||
    card.phase === "complete" ||
    (card.phase === "awaiting_human" && !awaitingPlanApproval)
      ? 100
      : card.subtasks?.length
        ? Math.round((completedSubtasks / card.subtasks.length) * 100)
        : card.phase === "reviewing"
          ? 85
          : card.phase === "executing"
            ? 45
            : card.phase === "planning"
              ? 15
              : 0;
  const showProgress =
    !!card.subtasks?.length ||
    isExecuting ||
    card.status === "done" ||
    card.phase === "awaiting_human";
  const tokenUsage = (card.runs ?? []).reduce(
    (total, run) => ({
      input: total.input + (run.inputTokens ?? 0),
      output: total.output + (run.outputTokens ?? 0),
      all:
        total.all +
        (run.totalTokens ?? (run.inputTokens ?? 0) + (run.outputTokens ?? 0)),
    }),
    { input: 0, output: 0, all: 0 },
  );
  const completedStages = {
    planning:
      completedSuccessfully ||
      (card.runs ?? []).some((run) => run.phase === "planning"),
    coding:
      completedSuccessfully ||
      (card.runs ?? []).some((run) => run.phase === "executing"),
    qa:
      completedSuccessfully ||
      (card.runs ?? []).some((run) => run.phase === "reviewing"),
  };
  const activeStage =
    card.phase === "planning"
      ? "planning"
      : card.phase === "executing"
        ? "coding"
        : card.phase === "reviewing"
          ? "qa"
          : null;

  return (
    <article
      data-task-id={card.id}
      tabIndex={0}
      onClick={(event) => {
        if (
          !(event.target as HTMLElement).closest(
            "button, input, summary, details, a",
          )
        ) {
          onOpen(card);
        }
      }}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && event.key === "Enter")
          onOpen(card);
      }}
      onPointerDown={(event) => {
        if (!isExecuting && !archived) onCardPointerDown(card, event);
      }}
      className={cn(
        "group cursor-pointer rounded-xl border border-border bg-panel p-4 shadow-sm transition-all duration-200 hover:-translate-y-px hover:border-[#58a6ff]/40 hover:shadow-md",
        selected && "ring-2 ring-accent",
        archived && "border-border-soft bg-panel opacity-60",
      )}
    >
      <input
        type="checkbox"
        aria-label={`选择任务：${card.title}`}
        checked={selected}
        onChange={onSelect}
        className="float-left mr-2 mt-0.5 h-4 w-4"
      />
      <h3
        onClick={() => onOpen(card)}
        className={cn(
          "line-clamp-2 break-words text-sm font-semibold leading-snug",
          archived ? "text-fg-dim" : "text-fg",
        )}
      >
        {card.title}
      </h3>
      {card.note && (
        <p className="mt-2 line-clamp-2 break-words text-xs text-fg-dim">
          {card.note}
        </p>
      )}
      {(card.category ||
        card.complexity ||
        (card.priority && card.priority !== "low") ||
        (card.impact && card.impact !== "low") ||
        (card.developmentMode && card.developmentMode !== "standard") ||
        phaseBadge ||
        card.status === "human_review" ||
        card.status === "done" ||
        archived) && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {archived && (
            <CardBadge className="bg-panel-2 text-fg-dim">
              {t(locale, "board.archived.tag")}
            </CardBadge>
          )}
          {card.status === "human_review" && (
            <CardBadge
              className={
                card.needsInput?.blocked
                  ? "bg-amber-500/10 text-amber-300"
                  : "bg-purple-500/10 text-purple-400"
              }
            >
              {card.needsInput?.blocked ? "需要输入" : "需要审核"}
            </CardBadge>
          )}
          {card.status === "done" && (
              <CardBadge className="bg-emerald-500/10 text-emerald-400">
                已完成
              </CardBadge>
            )}
          {phaseBadge &&
            card.phase !== "complete" &&
            card.phase !== "awaiting_human" && (
              <CardBadge className={phaseBadge.cls}>
                {t(locale, phaseBadge.key)}
              </CardBadge>
            )}
          {card.developmentMode && card.developmentMode !== "standard" && (
            <CardBadge
              className={
                card.developmentMode === "spec"
                  ? "border border-sky-500/30 bg-sky-500/10 text-sky-300"
                  : "border border-amber-500/30 bg-amber-500/10 text-amber-300"
              }
            >
              <span className="inline-flex items-center gap-1">
                {card.developmentMode === "spec" ? (
                  <FileCode size={10} />
                ) : (
                  <Zap size={10} />
                )}
                {card.developmentMode === "spec" ? "Spec (OpenSpec)" : "Direct"}
              </span>
            </CardBadge>
          )}
          {card.category && (
            <CardBadge className={CATEGORY_BADGE[card.category]}>
              {t(locale, `board.category.${card.category}`)}
            </CardBadge>
          )}
          {card.impact && card.impact !== "low" && (
            <CardBadge className={IMPACT_BADGE[card.impact]!}>
              {t(locale, `board.impact.${card.impact}`)}
            </CardBadge>
          )}
          {card.complexity && (
            <CardBadge className={COMPLEXITY_BADGE[card.complexity]}>
              {t(locale, `board.complexity.${card.complexity}`)}
            </CardBadge>
          )}
          {card.priority && card.priority !== "low" && (
            <CardBadge className={PRIORITY_BADGE[card.priority]!}>
              {t(locale, `board.priority.${card.priority}`)}
            </CardBadge>
          )}
        </div>
      )}
      {card.phase === "failed" && card.executionError && (
        <p
          className="mt-1 break-words text-[10px] leading-relaxed text-red-400"
          title={card.executionError}
        >
          {card.executionError}
        </p>
      )}
      {card.needsInput?.blocked && (
        <p
          className="mt-1 line-clamp-2 break-words text-[10px] leading-relaxed text-amber-300"
          title={card.needsInput.message}
        >
          {card.needsInput.message}
        </p>
      )}
      {showProgress && (
        <div className="mt-4" aria-label={`任务进度 ${progress}%`}>
          <div className="mb-1.5 flex items-center justify-between text-[11px] text-fg-dim">
            <span>{progress === 100 ? (awaitingHuman ? "执行完成，待验收" : "已完成") : "进度"}</span>
            <span className="tabular-nums text-fg">{progress}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-border-soft">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                card.phase === "failed"
                  ? "bg-red-400"
                  : progress === 100
                    ? "bg-emerald-500"
                    : "bg-accent",
              )}
              style={{ width: `${progress}%` }}
            />
          </div>
          <div
            className="mt-3 flex items-center gap-1.5 text-[10px]"
            aria-label="任务阶段：计划、代码、质量保证"
          >
            {(
              [
                ["planning", "计划"],
                ["coding", "代码"],
                ["qa", "质量保证"],
              ] as const
            ).map(([stage, label], index) => (
              <Fragment key={stage}>
                {index > 0 && <span className="text-fg-faint">—</span>}
                <span
                  className={cn(
                    "rounded px-2 py-1",
                    completedStages[stage]
                      ? "bg-emerald-500/10 text-emerald-400"
                      : activeStage === stage
                        ? "bg-sky-500/10 text-sky-300"
                        : "bg-panel-2 text-fg-faint",
                  )}
                >
                  {completedStages[stage]
                    ? "✓ "
                    : activeStage === stage
                      ? "● "
                      : ""}
                  {label}
                </span>
              </Fragment>
            ))}
          </div>
        </div>
      )}
      {(card.runs?.length || tokenUsage.all > 0) && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[10px]">
          <span className="rounded border border-border px-1.5 py-0.5 text-fg-dim">
            轮次{" "}
            <span className="font-mono text-fg">{card.runs?.length ?? 0}</span>
          </span>
          {tokenUsage.input > 0 && (
            <span className="rounded border border-border px-1.5 py-0.5 text-fg-dim">
              输入{" "}
              <span className="font-mono text-fg">
                {formatTokenCount(tokenUsage.input)}
              </span>
            </span>
          )}
          {tokenUsage.output > 0 && (
            <span className="rounded border border-border px-1.5 py-0.5 text-fg-dim">
              输出{" "}
              <span className="font-mono text-fg">
                {formatTokenCount(tokenUsage.output)}
              </span>
            </span>
          )}
          {tokenUsage.all > 0 && (
            <span className="rounded border border-border px-1.5 py-0.5 text-fg-dim">
              总计{" "}
              <span className="font-mono text-fg">
                {formatTokenCount(tokenUsage.all)}
              </span>
            </span>
          )}
        </div>
      )}
      {awaitingPlanApproval && <p className="mt-3 text-xs text-amber-300">计划已完成，等待批准后执行</p>}
      <div className="mt-4 flex items-center justify-between gap-2 text-fg-faint">
        <div className="flex min-w-0 items-center gap-1.5 text-[11px]">
          <Clock size={12} />
          <span>{formatRelativeTime(card.updatedAt, locale)}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {archived ? (
            <CardPrimaryButton
              label={t(locale, "board.archive.restore")}
              onClick={() => restoreTask(boardKey, card.id)}
            >
              <ArchiveRestore size={13} />
            </CardPrimaryButton>
          ) : card.status === "done" ? (
            <div className="flex items-center gap-1">
              {card.pullRequestUrl && (
                <CardPrimaryButton
                  label="查看 PR"
                  subtle
                  onClick={() => void openExternal(card.pullRequestUrl!)}
                >
                  <GitPullRequest size={13} />
                </CardPrimaryButton>
              )}
              <CardPrimaryButton
                label={t(locale, "board.archive.one")}
                subtle
                onClick={() => {
                  if (card.developmentMode === "spec" &&
                    (!card.openSpecArchive || card.openSpecArchive.changeName !== card.openSpecChange)) {
                    onOpen(card, true);
                  } else {
                    archiveTask(boardKey, card.id);
                  }
                }}
              >
                <Archive size={13} />
              </CardPrimaryButton>
            </div>
          ) : isExecuting || card.status === "queue" ? (
            <CardPrimaryButton
              label={
                card.status === "queue"
                  ? "取消排队"
                  : t(locale, "board.card.stop")
              }
              danger
              onClick={() =>
                card.status === "queue"
                  ? moveTask(boardKey, card.id, "backlog")
                  : stopTask(boardKey, card.id)
              }
            >
              <Square size={13} />
            </CardPrimaryButton>
          ) : failed ? (
            <CardPrimaryButton
              label="继续"
              onClick={() => requeueTask(boardKey, card.id)}
            >
              <Play size={13} />
            </CardPrimaryButton>
          ) : awaitingPlanApproval ? (
            <CardPrimaryButton label="批准计划并开始执行" onClick={() => approveTask(boardKey, card.id)}>
              <Play size={13} />
            </CardPrimaryButton>
          ) : awaitingHuman ? null : (
            <CardPrimaryButton
              label="开始"
              onClick={() => requeueTask(boardKey, card.id)}
            >
              <Play size={13} />
            </CardPrimaryButton>
          )}
          <details
            className="relative"
            onClick={(event) => event.stopPropagation()}
          >
            <summary
              title="任务操作"
              aria-label="任务操作"
              className="flex h-7 w-7 list-none cursor-pointer items-center justify-center rounded-md hover:bg-border-soft hover:text-fg"
            >
              <MoreVertical size={16} />
            </summary>
            <div className="absolute right-0 top-8 z-30 w-40 rounded-md border border-border bg-panel p-1 text-xs text-fg shadow-xl">
              <p className="px-2 py-1 text-[10px] font-medium text-fg-faint">
                移至
              </p>
              {TASK_STATUSES.filter((status) => status !== card.status).map(
                (status) => (
                  <button
                    key={status}
                    type="button"
                    title={`移至${t(locale, `board.column.${status}`)}`}
                    disabled={isExecuting || archived}
                    onClick={(event) => {
                      event.stopPropagation();
                      onMove(card, status);
                      event.currentTarget
                        .closest("details")
                        ?.removeAttribute("open");
                    }}
                    className="block w-full rounded px-2 py-1.5 text-left hover:bg-border-soft disabled:opacity-40"
                  >
                    {t(locale, `board.column.${status}`)}
                  </button>
                ),
              )}
              <div className="my-1 border-t border-border" />
              {!archived && (
                <button
                  type="button"
                  title="编辑"
                  disabled={isExecuting}
                  onClick={() => onEdit(card)}
                  className="block w-full rounded px-2 py-1.5 text-left hover:bg-border-soft disabled:opacity-40"
                >
                  编辑
                </button>
              )}
              <button
                type="button"
                title="删除"
                disabled={isExecuting}
                onClick={(event) => {
                  setConfirmDelete(true);
                  event.currentTarget
                    .closest("details")
                    ?.removeAttribute("open");
                }}
                className="block w-full rounded px-2 py-1.5 text-left text-red-400 hover:bg-red-500/10 disabled:opacity-40"
              >
                删除
              </button>
            </div>
          </details>
        </div>
      </div>
      {confirmDelete &&
        createPortal(
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
            onClick={(event) => event.stopPropagation()}
          >
            <div
              role="alertdialog"
              aria-modal="true"
              aria-label="删除任务"
              className="w-96 rounded-xl border border-border bg-panel p-6 shadow-2xl"
            >
              <h4 className="text-base font-semibold text-fg">删除任务</h4>
              <p className="my-4 text-sm text-fg-dim">
                确定删除“{card.title}”及其任务记录？
              </p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="rounded-md border border-border px-3 py-1.5 text-xs"
                  onClick={() => setConfirmDelete(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="rounded-md bg-red-500 px-3 py-1.5 text-xs text-white"
                  onClick={() => removeTask(boardKey, card.id)}
                >
                  删除
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </article>
  );
}

function CardBadge({
  className,
  children,
}: {
  className: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn("rounded px-1.5 py-0 text-[10px] leading-4", className)}
    >
      {children}
    </span>
  );
}

function QueueSettings({
  value,
  onSave,
  onClose,
}: {
  value: number;
  onSave: (value: number) => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState(String(value));
  const [error, setError] = useState("");
  return (
    <div
      className="fixed inset-0 z-[85] flex items-center justify-center bg-black/60"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="队列设置"
        className="w-full max-w-md rounded-xl border border-border bg-panel p-6 text-fg shadow-2xl"
      >
        <h2 className="text-lg font-semibold">队列设置</h2>
        <p className="mt-2 text-sm text-fg-dim">
          配置“进行中”看板中可以并行运行的最大任务数
        </p>
        <label className="mt-6 block text-sm">
          最大并行任务数
          <input
            autoFocus
            type="number"
            min={1}
            max={10}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="mt-2 w-full rounded-md border border-border bg-bg px-3 py-2"
          />
        </label>
        {error && (
          <p role="alert" className="mt-2 text-sm text-red-400">
            {error}
          </p>
        )}
        <p className="mt-2 text-sm text-fg-dim">
          达到此限制时，新任务将在移至“进行中”之前在队列中等待
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <button
            className="rounded-md border border-border px-4 py-2 text-sm"
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="rounded-md bg-accent px-4 py-2 text-sm text-bg"
            onClick={() => {
              const number = Number(input);
              if (!Number.isInteger(number) || number < 1 || number > 10)
                setError("请输入 1–10 之间的整数");
              else onSave(number);
            }}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

function formatRelativeTime(timestamp: number, locale: Locale): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return locale === "zh-CN" ? "刚刚" : "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return locale === "zh-CN" ? `${minutes} 分钟前` : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return locale === "zh-CN" ? `${hours} 小时前` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return locale === "zh-CN" ? `${days} 天前` : `${days}d ago`;
}

function formatTokenCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  }
  return String(Math.round(value));
}

function CardPrimaryButton({
  label,
  danger,
  subtle,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  subtle?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(event) => { event.stopPropagation(); onClick(); }}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors",
        danger
          ? "bg-red-500/15 text-red-300 hover:bg-red-500/25"
          : subtle
            ? "text-fg-dim hover:bg-border-soft hover:text-fg"
            : "bg-accent text-bg hover:opacity-90",
      )}
    >
      {children}
    </button>
  );
}
