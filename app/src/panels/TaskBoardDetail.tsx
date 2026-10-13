import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  Archive,
  CheckCircle2,
  ChevronRight,
  ChevronsUpDown,
  Clock,
  Gauge,
  GitBranch,
  GitPullRequest,
  Network,
  Pencil,
  Play,
  Square,
  Trash2,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import TaskGitChanges from "@/panels/TaskGitChanges";
import TaskFeedbackComposer from "@/panels/TaskFeedbackComposer";
import TaskLiveInstruction from "@/panels/TaskLiveInstruction";
import TaskNeedsInputDialog from "@/panels/TaskNeedsInputDialog";
import TaskRuntimeLogs, {
  RuntimeOutput as TaskRuntimeOutput,
} from "@/panels/TaskRuntimeLogs";
import TaskExecutionGraph from "@/panels/TaskExecutionGraph";
import { formatTaskDuration } from "@/lib/taskExecutionGraph";
import TaskWorkspaceFiles from "@/panels/TaskWorkspaceFiles";
import TaskWorktreeReview from "@/panels/TaskWorktreeReview";
import { cn } from "@/lib/cn";
import { t, type Locale } from "@/lib/i18n";
import {
  taskAwaitsPlanApproval,
  taskRequiresWorktreeReview,
} from "@/lib/taskWorktreeReview";
import { syncTaskArtifacts } from "@/lib/taskArtifacts";
import {
  approveTask,
  archiveTask,
  getBoardTasks,
  removeTask,
  requeueTask,
  restoreTask,
  subscribeTasks,
  TASK_MAX_REFERENCE_IMAGES,
  updateTask,
  updateTaskExecution,
  type TaskCard,
  type TaskDecisionAnswer,
  type TaskReferenceImage,
} from "@/lib/taskBoard";
import {
  getRunnerSnapshot,
  getTaskStream,
  stopTask,
  subscribeRunner,
  type RunnerTaskStream,
} from "@/lib/taskBoardRunner";
import {
  openExternal,
  previewLocalFile,
  getTaskGitOverview,
  setOpenSpecTaskStatus,
  type TaskGitOverview,
} from "@/lib/tauri";

const button =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-panel-2 disabled:opacity-40";

const MODAL_WIDTH_STORAGE_KEY = "task_detail_modal_width";
const DEFAULT_MODAL_WIDTH_RATIO = 0.92;
const MIN_MODAL_WIDTH = 760;
const MODAL_SIDE_MARGIN = 48;

function getMaxModalWidth(): number {
  if (typeof window === "undefined") return 1280;
  return Math.max(
    MIN_MODAL_WIDTH,
    window.innerWidth - MODAL_SIDE_MARGIN * 2,
  );
}

function clampModalWidth(width: number): number {
  return Math.max(MIN_MODAL_WIDTH, Math.min(width, getMaxModalWidth()));
}

function getInitialModalWidth(): number {
  if (typeof window === "undefined") return 1280;
  const saved = Number(localStorage.getItem(MODAL_WIDTH_STORAGE_KEY));
  if (Number.isFinite(saved) && saved > 0) return clampModalWidth(saved);
  return clampModalWidth(
    Math.min(1280, window.innerWidth * DEFAULT_MODAL_WIDTH_RATIO),
  );
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

function formatRelativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function taskDisplaySlug(card: TaskCard): string {
  const fromTitle = card.title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return fromTitle || card.id.slice(0, 36);
}
const TASK_THINKING_LABELS = {
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
} as const;

export default function TaskBoardDetail({
  boardKey,
  cardId,
  cwd,
  locale,
  onClose,
  onEdit,
}: {
  boardKey: string;
  cardId: string;
  cwd: string;
  locale: Locale;
  onClose: () => void;
  onEdit: (card: TaskCard) => void;
}) {
  const cards = useSyncExternalStore(subscribeTasks, () =>
    getBoardTasks(boardKey),
  );
  useSyncExternalStore(subscribeRunner, getRunnerSnapshot);
  const card = cards.find((c) => c.id === cardId);
  const stream = getTaskStream(boardKey, cardId);
  const [tab, setTab] = useState(() =>
    card?.phase === "planning" ||
    card?.phase === "executing" ||
    card?.phase === "reviewing"
      ? "logs"
      : "overview",
  );
  const [feedback, setFeedback] = useState("");
  const [feedbackImages, setFeedbackImages] = useState<TaskReferenceImage[]>([]);
  const [needsInputOpen, setNeedsInputOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [subtaskError, setSubtaskError] = useState("");
  const [pendingSpecTask, setPendingSpecTask] = useState<number | null>(null);
  const [gitOverview, setGitOverview] = useState<TaskGitOverview | null>(null);
  const [taskSpecsPath, setTaskSpecsPath] = useState("");
  const [taskArtifactsError, setTaskArtifactsError] = useState("");
  const [width, setWidth] = useState(getInitialModalWidth);
  const resizeState = useRef<{
    side: "left" | "right";
    startX: number;
    startWidth: number;
  } | null>(null);
  const modal = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    modal.current?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => {
    const handleWindowResize = () => {
      setWidth((current) => {
        const next = clampModalWidth(current);
        localStorage.setItem(MODAL_WIDTH_STORAGE_KEY, String(Math.round(next)));
        return next;
      });
    };
    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, []);
  useEffect(
    () => () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    },
    [],
  );
  useEffect(() => {
    const workspace = card?.executionCwd || cwd;
    if (!workspace) {
      setGitOverview(null);
      return;
    }
    let cancelled = false;
    void getTaskGitOverview(workspace)
      .then((overview) => {
        if (!cancelled) setGitOverview(overview);
      })
      .catch(() => {
        if (!cancelled) setGitOverview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [card?.executionCwd, card?.id, cwd]);
  useEffect(() => {
    if (card?.needsInput?.blocked) setNeedsInputOpen(true);
  }, [card?.id, card?.needsInput]);
  useEffect(() => {
    setTaskSpecsPath(card?.specsPath || "");
    setTaskArtifactsError("");
  }, [card?.id, card?.specsPath]);
  useEffect(() => {
    if (!card || !cwd) return;
    let cancelled = false;
    const delay = stream ? 500 : 0;
    const timer = window.setTimeout(() => {
      void syncTaskArtifacts(cwd, card, stream)
        .then((specsPath) => {
          if (cancelled || !specsPath) return;
          setTaskSpecsPath(specsPath);
          setTaskArtifactsError("");
          if (card.specsPath !== specsPath) {
            updateTaskExecution(boardKey, cardId, { specsPath });
          }
        })
        .catch((reason) => {
          if (!cancelled) {
            setTaskArtifactsError(
              reason instanceof Error ? reason.message : String(reason),
            );
          }
        });
    }, delay);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [boardKey, card, cardId, cwd, stream]);
  if (!card) return null;
  const active =
    card.phase === "planning" ||
    card.phase === "executing" ||
    card.phase === "reviewing";
  const taskCwd = card.executionCwd || cwd;
  const awaitingPlanApproval = taskAwaitsPlanApproval(card);
  const requiresWorktreeReview = taskRequiresWorktreeReview(card, cwd);
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
  const usage = (card.runs ?? []).reduce(
    (total, run) => ({
      input: total.input + (run.inputTokens ?? 0),
      output: total.output + (run.outputTokens ?? 0),
      all:
        total.all +
        (run.totalTokens ?? (run.inputTokens ?? 0) + (run.outputTokens ?? 0)),
      thinking: total.thinking + (run.thinkingTokens ?? 0),
      cacheRead: total.cacheRead + (run.cacheReadTokens ?? 0),
      cacheCreation: total.cacheCreation + (run.cacheCreationTokens ?? 0),
    }),
    {
      input: 0,
      output: 0,
      all: 0,
      thinking: 0,
      cacheRead: 0,
      cacheCreation: 0,
    },
  );
  const completedSuccessfully =
    progress === 100 && card.phase !== "failed" && !card.needsInput?.blocked;
  const displayedBaseBranch =
    card.baseBranch ||
    gitOverview?.defaultBranch ||
    gitOverview?.currentBranch ||
    "项目默认分支";
  const start = () => requeueTask(boardKey, cardId);
  const submitFeedback = () => {
    const value = feedback.trim();
    if (!value && !feedbackImages.length) return;
    const attachmentNote = feedbackImages.length
      ? `反馈附件：\n${feedbackImages
          .map((image) => `- ${image.path}`)
          .join("\n")}`
      : "";
    if (feedbackImages.length) {
      updateTask(boardKey, cardId, {
        meta: {
          referenceImages: [
            ...(card.referenceImages ?? []),
            ...feedbackImages,
          ].slice(0, TASK_MAX_REFERENCE_IMAGES),
        },
      });
    }
    updateTaskExecution(boardKey, cardId, {
      feedback: [value, attachmentNote].filter(Boolean).join("\n\n"),
      ...((card.developmentMode === "spec" ||
        card.requireReviewBeforeCoding) &&
      !card.planApproved
        ? { plan: "", planApproved: false, subtasks: [] }
        : {}),
    });
    setFeedback("");
    setFeedbackImages([]);
    start();
  };
  const resolveNeedsInput = (answers: TaskDecisionAnswer[]) => {
    const decisions = [
      "用户已确认以下实施决策：",
      ...answers.map(
        (answer, index) =>
          String(index + 1) + ". " + answer.question + " → " + answer.answer,
      ),
    ].join("\n");
    updateTaskExecution(boardKey, cardId, {
      feedback: [card.feedback?.trim(), decisions].filter(Boolean).join("\n\n"),
      needsInput: undefined,
      plan: "",
      planApproved: false,
      subtasks: [],
    });
    setNeedsInputOpen(false);
    start();
  };
  const startResize = (
    side: "left" | "right",
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    resizeState.current = {
      side,
      startX: event.clientX,
      startWidth: width,
    };
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const state = resizeState.current;
      if (!state) return;
      const delta = moveEvent.clientX - state.startX;
      const direction = state.side === "right" ? 1 : -1;
      setWidth(clampModalWidth(state.startWidth + delta * direction * 2));
    };
    const handlePointerUp = () => {
      resizeState.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setWidth((current) => {
        const next = clampModalWidth(current);
        localStorage.setItem(MODAL_WIDTH_STORAGE_KEY, String(Math.round(next)));
        return next;
      });
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  };
  const approvePlan = () => {
    updateTaskExecution(boardKey, cardId, { planApproved: true });
    start();
  };
  const toggleSubtask = async (taskIndex: number, completed: boolean) => {
    setSubtaskError("");
    setPendingSpecTask(taskIndex);
    try {
      if (card.developmentMode === "spec" && card.openSpecChange) {
        await setOpenSpecTaskStatus(
          taskCwd,
          card.openSpecChange,
          taskIndex,
          completed,
        );
      }
      updateTaskExecution(boardKey, cardId, {
        subtasks: card.subtasks?.map((subtask, index) =>
          index === taskIndex
            ? { ...subtask, status: completed ? "completed" : "pending" }
            : subtask,
        ),
      });
    } catch (reason) {
      setSubtaskError(
        reason instanceof Error ? reason.message : String(reason),
      );
    } finally {
      setPendingSpecTask(null);
    }
  };
  return (
    <div
      className="fixed inset-0 z-[75] bg-black/60"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={modal}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={card.title}
        className="fixed inset-y-0 left-1/2 flex -translate-x-1/2 flex-col border-x border-border bg-panel text-fg shadow-2xl outline-none"
        style={{
          width,
          maxWidth: `calc(100vw - ${MODAL_SIDE_MARGIN * 2}px)`,
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
          if (event.key === "Tab") {
            const items = modal.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled),input,textarea,[tabindex="0"]',
            );
            if (!items?.length) return;
            if (event.shiftKey && document.activeElement === items[0]) {
              event.preventDefault();
              items[items.length - 1].focus();
            }
            if (
              !event.shiftKey &&
              document.activeElement === items[items.length - 1]
            ) {
              event.preventDefault();
              items[0].focus();
            }
          }
        }}
      >
        {(["left", "right"] as const).map((side) => (
          <div
            key={side}
            role="separator"
            aria-label="调整任务详情宽度"
            aria-orientation="vertical"
            className={`absolute inset-y-0 z-20 w-2.5 cursor-ew-resize touch-none hover:bg-[#58a6ff]/20 ${side === "left" ? "-left-2.5" : "-right-2.5"}`}
            onPointerDown={(event) => startResize(side, event)}
          />
        ))}
        <header className="shrink-0 border-b border-border p-5 pb-4">
          <div className="flex items-start justify-between gap-4">
            <h2 className="truncate text-xl font-semibold">{card.title}</h2>
            <div className="flex gap-1">
              <button
                className="flex h-9 w-9 items-center justify-center rounded-md text-fg-dim transition-colors hover:bg-[#58a6ff]/10 hover:text-accent disabled:opacity-40"
                title="编辑任务"
                disabled={active}
                onClick={() => onEdit(card)}
              >
                <Pencil size={16} />
              </button>
              <button
                className="flex h-9 w-9 items-center justify-center rounded-md text-fg-dim transition-colors hover:bg-border-soft hover:text-fg"
                title="关闭"
                onClick={onClose}
              >
                <X size={20} />
              </button>
            </div>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-2 text-xs">
            <span
              className="max-w-full truncate rounded-md border border-border px-2 py-0.5 font-mono font-medium"
              title={card.id}
            >
              {taskDisplaySlug(card)}
            </span>
            <span
              className={cn(
                "rounded-md border px-2 py-0.5 font-medium",
                card.status === "human_review"
                  ? "border-purple-500/20 bg-purple-500/15 text-purple-300"
                  : card.status === "done"
                  ? "border-transparent bg-[#3fb950]/10 text-[#3fb950]"
                    : card.status === "in_progress"
                      ? "border-blue-500/20 bg-blue-500/15 text-blue-300"
                      : "border-border bg-panel-2 text-fg-dim",
              )}
            >
              {t(locale, `board.column.${card.status}`)}
            </span>
            {completedSuccessfully && card.status !== "done" && (
              <span className="rounded-md border border-transparent bg-[#3fb950]/10 px-2 py-0.5 font-medium text-[#3fb950]">
                已完成
              </span>
            )}
            {card.phase === "failed" && (
              <span className="rounded-md border border-red-500/20 bg-red-500/15 px-2 py-0.5 font-medium text-red-400">
                执行失败
              </span>
            )}
            {!!card.subtasks?.length && (
              <span className="ml-1 text-fg-dim">
                {completedSubtasks}/{card.subtasks.length} 个子任务
              </span>
            )}
          </div>
          {(active || progress > 0) && (
            <div className="mt-3">
              <div className="mb-1 flex justify-between text-[11px] text-fg-dim">
                <span>{progress === 100 ? "Completed" : "进度"}</span>
                <span>{progress}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-panel-2">
                <div
                  className={cn(
                    "h-full rounded-full transition-all",
                    completedSuccessfully ? "bg-[#3fb950]" : "bg-accent",
                    active && "animate-pulse",
                  )}
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}
          {card.executionError && (
            <p className="mt-3 rounded border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-400">
              {card.executionError}
            </p>
          )}
        </header>
        <div
          role="tablist"
          className="flex shrink-0 border-b border-border px-5"
        >
          {[
            ["overview", "概览"],
            ["subtasks", `子任务 (${card.subtasks?.length || 0})`],
            ["logs", "日志"],
            ["files", "文件"],
            ["git", "Git 变更"],
          ].map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={`border-b-2 px-4 py-2.5 text-sm ${tab === id ? "border-accent text-accent" : "border-transparent text-fg-dim"}`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <div role="tabpanel" className="min-h-0 flex-1 overflow-auto p-5">
          {tab === "overview" && (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="rounded-md border border-border bg-panel-2 px-2 py-0.5 text-xs font-medium">
                    手动创建
                  </span>
                  {card.developmentMode === "spec" && card.openSpecChange && (
                    <span className="rounded-md border border-sky-500/20 bg-sky-500/10 px-2 py-0.5 text-xs text-sky-300">
                      OpenSpec · {card.openSpecSchema || "spec-driven"}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-4 text-xs text-fg-dim">
                  {usage.all > 0 && (
                    <span className="flex items-center gap-1.5">
                      <Gauge size={13} />
                      Token {formatTokenCount(usage.all)}
                      <span className="rounded-md border border-border px-1.5 py-0.5 text-[10px] font-medium text-fg">
                        Provider
                      </span>
                    </span>
                  )}
                  <span className="flex items-center gap-1.5">
                    <Clock size={13} />
                    创建 {formatRelativeTime(card.createdAt)}
                  </span>
                  <span className="text-border">|</span>
                  <span>更新 {formatRelativeTime(card.updatedAt)}</span>
                </div>
              </div>

              {awaitingPlanApproval && (
                <section className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4" aria-label="等待计划审批">
                  <h3 className="text-sm font-semibold">计划已完成，等待批准后执行</h3>
                  <p className="my-2 text-xs text-fg-dim">已启用编码前审核，当前尚未开始实施或验收。批准后任务会返回队列，继续执行子任务。</p>
                  <button className={button} onClick={approvePlan}>批准计划并开始执行</button>
                </section>
              )}
              {usage.all > 0 && (
                <div className="space-y-2">
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      ["输入 TOKEN", usage.input],
                      ["输出 TOKEN", usage.output],
                      ["合计 TOKEN", usage.all],
                      ...(usage.thinking > 0
                        ? [["思考 TOKEN", usage.thinking] as const]
                        : []),
                      ...(usage.cacheRead > 0
                        ? [["缓存读取 TOKEN", usage.cacheRead] as const]
                        : []),
                      ...(usage.cacheCreation > 0
                        ? [["缓存创建 TOKEN", usage.cacheCreation] as const]
                        : []),
                    ].map(([label, value]) => (
                      <div
                        key={label}
                        className="rounded-lg border border-border bg-[#ffffff]/[0.01] px-3 py-2"
                      >
                        <p className="text-[11px] uppercase tracking-wide text-fg-dim">
                          {label}
                        </p>
                        <p className="mt-1 text-sm font-semibold tabular-nums text-fg">
                          {formatTokenCount(value as number)}
                        </p>
                      </div>
                    ))}
                  </div>
                  <div className="rounded-lg border border-border bg-[#ffffff]/[0.01] px-3 py-2 text-xs text-fg-dim">
                    <span className="font-medium text-fg">Cost estimate:</span>{" "}
                    Not configured
                    <span className="mx-2 text-border">|</span>
                    Provider-reported usage. Cost estimates are not shown until
                    a versioned provider pricing policy is configured. Reconcile
                    token counts against provider billing.
                  </div>
                </div>
              )}

              <section className="overflow-hidden rounded-lg border border-border bg-[#ffffff]/[0.01] px-4 py-3">
                <div className="whitespace-pre-wrap text-sm leading-relaxed">
                  <ReactMarkdown>{card.note || card.title}</ReactMarkdown>
                </div>
              </section>

              {card.needsInput?.blocked && (
                <section className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
                  <div className="flex items-start gap-3">
                    <AlertCircle size={16} className="mt-0.5 text-amber-400" />
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-semibold text-amber-300">
                        任务需要你的决定
                      </h3>
                      <p className="mt-1 text-xs leading-5 text-fg-dim">
                        {card.needsInput.message}
                      </p>
                      <button
                        type="button"
                        className={cn(button, "mt-3 bg-amber-400 text-black")}
                        onClick={() => setNeedsInputOpen(true)}
                      >
                        回答问题
                      </button>
                    </div>
                  </div>
                </section>
              )}

              <section className="rounded-lg border border-border bg-[#ffffff]/[0.01] px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-dim">
                      <GitBranch size={13} className="text-accent" />
                      基础分支
                    </h3>
                    <p className="break-all text-sm font-medium text-fg">
                      {displayedBaseBranch}
                    </p>
                    <p className="mt-1 text-xs text-fg-dim">
                      {card.baseBranch
                        ? "当前任务正在覆盖项目默认分支。"
                        : "当前任务正在遵循项目默认分支。"}
                    </p>
                  </div>
                  <button
                    type="button"
                    className={button}
                    disabled={active}
                    onClick={() => onEdit(card)}
                  >
                    <Pencil size={14} />
                    编辑
                  </button>
                </div>
              </section>
              {!!card.referenceImages?.length && (
                <section>
                  <h3 className="mb-3 text-sm font-semibold">
                    参考图片 ({card.referenceImages.length})
                  </h3>
                  <div className="flex flex-wrap gap-3">
                    {card.referenceImages.map((image) => (
                      <TaskReferencePreview
                        key={image.id}
                        image={image}
                        cwd={taskCwd}
                      />
                    ))}
                  </div>
                </section>
              )}
              {card.plan && (
                <section>
                  <h3 className="mb-3 text-sm font-semibold">
                    {card.developmentMode === "spec"
                      ? "OpenSpec 实施计划"
                      : "实施计划"}
                  </h3>
                  <div className="whitespace-pre-wrap text-sm">
                    <ReactMarkdown>{card.plan}</ReactMarkdown>
                  </div>
                </section>
              )}
              {(requiresWorktreeReview || card.status === "human_review") && (
                <div className="border-t border-border" />
              )}
              {requiresWorktreeReview && (
                <TaskWorktreeReview
                  boardKey={boardKey}
                  mainRoot={cwd}
                  card={card}
                  onViewChanges={() => setTab("git")}
                  onClose={onClose}
                />
              )}
              {card.status === "human_review" && (
                <section className="rounded-lg border border-border p-4">
                  <h3 className="mb-2 text-sm font-semibold">要求修改</h3>
                  <TaskFeedbackComposer
                    value={feedback}
                    onChange={setFeedback}
                    attachments={feedbackImages}
                    onAttachmentsChange={setFeedbackImages}
                    cwd={taskCwd}
                    existingCount={card.referenceImages?.length ?? 0}
                    placeholder="请描述问题或需要修改的内容..."
                    className="mb-3"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      className={button}
                      disabled={!feedback.trim() && !feedbackImages.length}
                      onClick={submitFeedback}
                    >
                      提交反馈并继续
                    </button>
                    {!requiresWorktreeReview && (
                      <button
                        className={`${button} border-accent bg-accent text-bg`}
                        onClick={() =>
                          awaitingPlanApproval
                            ? approvePlan()
                            : approveTask(boardKey, cardId)
                        }
                      >
                        <CheckCircle2 size={14} />
                        {awaitingPlanApproval
                          ? card.developmentMode === "spec"
                            ? "批准规范并构建"
                            : "批准计划并构建"
                          : "标记完成"}
                      </button>
                    )}
                  </div>
                </section>
              )}
            </div>
          )}
          {tab === "subtasks" && (
            <TaskSubtasksPane
              card={card}
              stream={stream}
              locale={locale}
              active={active}
              pendingSpecTask={pendingSpecTask}
              error={subtaskError}
              onToggle={(taskIndex, completed) =>
                void toggleSubtask(taskIndex, completed)
              }
              onDelete={(subtaskId) =>
                updateTaskExecution(boardKey, cardId, {
                  subtasks: card.subtasks?.filter(
                    (subtask) => subtask.id !== subtaskId,
                  ),
                })
              }
            />
          )}
          {tab === "logs" && (
            <TaskRuntimeLogs
              card={card}
              stream={stream}
              active={active}
              locale={locale}
              onClear={() =>
                updateTaskExecution(boardKey, cardId, { runs: [] })
              }
            />
          )}
          {tab === "files" && (
            taskSpecsPath ? (
              <TaskWorkspaceFiles
                key={`${taskSpecsPath}-${tab}`}
                cwd={taskSpecsPath}
                cardId={cardId}
                taskArtifacts
              />
            ) : (
              <div className="flex min-h-64 items-center justify-center rounded-lg border border-border px-6 text-center text-sm text-fg-dim">
                {taskArtifactsError ||
                  (cwd
                    ? "正在准备任务文件..."
                    : "请先选择项目工作区")}
              </div>
            )
          )}
          {tab === "git" && (
            <TaskGitChanges
              key={`${taskCwd}-git-${card.baseBranch || "default"}`}
              cwd={taskCwd}
              cardId={cardId}
              baseBranch={card.baseBranch}
              locale={locale}
            />
          )}
        </div>
        {active && <TaskLiveInstruction boardKey={boardKey} cardId={cardId} />}
        <footer className="flex shrink-0 items-center justify-between border-t border-border bg-[#ffffff]/[0.01] px-5 py-3">
          <button
            className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-xs text-fg-dim transition-colors hover:bg-red-500/10 hover:text-red-400 disabled:opacity-40"
            disabled={active}
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 size={14} />
            删除
          </button>
          <div className="flex items-center gap-3">
            {active ? (
              <button
                className={`${button} border-accent bg-accent text-bg`}
                onClick={() => stopTask(boardKey, cardId)}
              >
                <Square size={14} />
                停止
              </button>
            ) : (
              <>
                {card.status === "done" ? (
                  <div className="flex items-center gap-2">
                    {card.pullRequestUrl && (
                      <button
                        className={`${button} text-sky-300`}
                        onClick={() => void openExternal(card.pullRequestUrl!)}
                      >
                        <GitPullRequest size={14} />
                        查看 PR
                      </button>
                    )}
                    <button
                      className={button}
                      onClick={() => {
                        if (card.archived) restoreTask(boardKey, cardId);
                        else archiveTask(boardKey, cardId);
                        onClose();
                      }}
                    >
                      <Archive size={14} />
                      {card.archived ? "恢复" : "归档"}
                    </button>
                  </div>
                ) : card.needsInput?.blocked ? (
                  <button
                    className={cn(button, "bg-amber-400 text-black")}
                    onClick={() => setNeedsInputOpen(true)}
                  >
                    <AlertCircle size={14} />
                    回答问题
                  </button>
                ) : (
                  <button
                    className={cn(button, "border-accent bg-accent text-bg")}
                    onClick={awaitingPlanApproval ? approvePlan : start}
                  >
                    <Play size={14} />
                    {card.phase === "failed" || card.runs?.length
                      ? "继续"
                      : "开始"}
                  </button>
                )}
              </>
            )}
            <button className={button} onClick={onClose}>
              关闭
            </button>
          </div>
        </footer>
        {confirmDelete &&
          createPortal(
            <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60">
              <div
                role="alertdialog"
                aria-modal="true"
                aria-label="删除任务"
                className="w-96 rounded-xl border border-border bg-panel p-6 shadow-2xl"
              >
                <h3 className="text-lg font-semibold">删除任务</h3>
                <p className="my-4 text-sm text-fg-dim">
                  确定删除“{card.title}”及其任务记录？
                </p>
                <div className="flex justify-end gap-2">
                  <button
                    className={button}
                    onClick={() => setConfirmDelete(false)}
                  >
                    取消
                  </button>
                  <button
                    className={`${button} text-red-400`}
                    onClick={() => {
                      removeTask(boardKey, cardId);
                      onClose();
                    }}
                  >
                    删除
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )}
        {needsInputOpen && card.needsInput?.blocked && (
          <TaskNeedsInputDialog
            needsInput={card.needsInput}
            onClose={() => setNeedsInputOpen(false)}
            onSubmit={resolveNeedsInput}
          />
        )}
      </div>
    </div>
  );
}

function TaskSubtasksPane({
  card,
  stream,
  locale,
  active,
  pendingSpecTask,
  error,
  onToggle,
  onDelete,
}: {
  card: TaskCard;
  stream: RunnerTaskStream | null;
  locale: Locale;
  active: boolean;
  pendingSpecTask: number | null;
  error: string;
  onToggle: (taskIndex: number, completed: boolean) => void;
  onDelete: (subtaskId: string) => void;
}) {
  const subtasks = card.subtasks ?? [];
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const completed = subtasks.filter(
    (subtask) => subtask.status === "completed",
  ).length;
  const progress = subtasks.length
    ? Math.round((completed / subtasks.length) * 100)
    : 0;
  const activeSubtask =
    subtasks.find((subtask) => subtask.status === "in_progress") ?? null;
  const selected =
    subtasks.find((subtask) => subtask.id === selectedId) ??
    null;
  const selectedRuns = selected
    ? (card.runs ?? []).filter((run) => run.subtaskId === selected.id)
    : [];
  const allExpanded =
    subtasks.length > 0 &&
    subtasks.every((subtask) => expandedIds.has(subtask.id));
  const toggleExpanded = (subtaskId: string) =>
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(subtaskId)) next.delete(subtaskId);
      else next.add(subtaskId);
      return next;
    });

  if (!subtasks.length) {
    return (
      <div className="flex min-h-72 flex-col items-center justify-center rounded-xl border border-dashed border-border text-center">
        <Network size={34} className="mb-3 text-fg-faint" />
        <p className="text-sm font-medium">暂无子任务</p>
        <p className="mt-1 max-w-sm text-xs leading-5 text-fg-dim">
          标准模式或 OpenSpec 生成计划后，将在此显示实施清单和执行关系图。
        </p>
      </div>
    );
  }

  return (
    <div className="grid min-h-[30rem] gap-4 xl:grid-cols-[minmax(20rem,0.9fr)_minmax(22rem,1.1fr)]">
      <section className="min-w-0 overflow-hidden rounded-xl border border-border bg-bg/25">
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 text-xs text-fg-dim">
          <span>
            已完成 {completed}/{subtasks.length}
          </span>
          <div className="flex items-center gap-3">
            <span className="tabular-nums text-fg">{progress}%</span>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded px-1.5 py-1 hover:bg-panel-2 hover:text-fg"
              onClick={() =>
                setExpandedIds(
                  allExpanded
                    ? new Set()
                    : new Set(subtasks.map((subtask) => subtask.id)),
                )
              }
            >
              <ChevronsUpDown size={13} />
              {allExpanded ? "全部收起" : "全部展开"}
            </button>
          </div>
        </header>
        <div className="h-1 bg-panel-2">
          <div
            className="h-full bg-emerald-500 transition-[width]"
            style={{ width: `${progress}%` }}
          />
        </div>
        {error && (
          <p role="alert" className="m-3 text-xs text-red-400">
            {error}
          </p>
        )}
        <div className="space-y-2 p-3">
          {subtasks.map((subtask, taskIndex) => {
            const expanded = expandedIds.has(subtask.id);
            const isSelected = selected?.id === subtask.id;
            const statusLabel =
              subtask.status === "completed"
                ? "已完成"
                : subtask.status === "in_progress"
                  ? "进行中"
                  : subtask.status === "failed"
                    ? "失败"
                    : "待处理";
            return (
              <article
                key={subtask.id}
                className={cn(
                  "overflow-hidden rounded-lg border bg-[#21262d]/25 transition-colors",
                  subtask.status === "completed"
                    ? "border-emerald-500/30"
                    : subtask.status === "in_progress"
                      ? "border-sky-500/40 bg-sky-500/5"
                      : subtask.status === "failed"
                        ? "border-red-500/35 bg-red-500/5"
                        : isSelected
                          ? "border-[#58a6ff]/40"
                          : "border-border",
                )}
              >
                <div className="flex items-center gap-2 p-3">
                  <input
                    type="checkbox"
                    aria-label={subtask.title}
                    checked={subtask.status === "completed"}
                    disabled={active || pendingSpecTask !== null}
                    onChange={(event) =>
                      onToggle(taskIndex, event.target.checked)
                    }
                    className="accent-emerald-500"
                  />
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => {
                      setSelectedId(subtask.id);
                      toggleExpanded(subtask.id);
                    }}
                  >
                    <span className="rounded-full bg-panel-2 px-1.5 py-0.5 text-[10px] font-medium text-fg-dim">
                      #{taskIndex + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {subtask.title}
                    </span>
                    <span
                      className={cn(
                        "text-[10px]",
                        subtask.status === "completed"
                          ? "text-emerald-400"
                          : subtask.status === "in_progress"
                            ? "text-sky-400"
                            : subtask.status === "failed"
                              ? "text-red-400"
                              : "text-fg-faint",
                      )}
                    >
                      {statusLabel}
                    </span>
                    <ChevronRight
                      size={14}
                      className={cn(
                        "shrink-0 text-fg-faint transition-transform",
                        expanded && "rotate-90",
                      )}
                    />
                  </button>
                  {card.developmentMode !== "spec" && (
                    <button
                      type="button"
                      className="rounded p-1.5 text-fg-faint hover:bg-red-500/10 hover:text-red-400 disabled:opacity-40"
                      title="删除子任务"
                      disabled={active}
                      onClick={() => onDelete(subtask.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
                {expanded && (
                  <div className="border-t border-[#30363d]/60 px-4 py-3 text-xs leading-5 text-fg-dim">
                    {subtask.description && <div className="task-markdown mb-3"><ReactMarkdown remarkPlugins={[remarkGfm]}>{subtask.description}</ReactMarkdown></div>}
                    {subtask.summary ? (
                      <div className="task-markdown">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {subtask.summary}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      <p>执行后将在这里显示完成摘要。</p>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>

      <section className="min-w-0 overflow-hidden rounded-xl border border-border bg-bg/25">
        <TaskExecutionGraph card={card} selectedId={selected?.id || null} onSelect={setSelectedId} activeStartedAt={stream?.phase === "executing" ? stream.startedAt : undefined} />
        <div>
          <div className="min-h-0 overflow-auto border-t border-border p-4">
            <h4 className="truncate text-xs font-semibold">
              {selected?.title || "选择子任务查看输出"}
            </h4>
            {selected?.summary && (
              <div className="task-markdown mt-2 text-xs leading-5 text-fg-dim">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {selected.summary}
                </ReactMarkdown>
              </div>
            )}
            <div className="mt-3 space-y-2">
              {selected && selected.id === activeSubtask?.id && stream?.phase === "executing" && (
                <div className="max-h-64 overflow-auto text-xs"><TaskRuntimeOutput source={stream.text} /></div>
              )}
              {selectedRuns.map((run, index) => (
                <details
                  key={`${run.startedAt}-${index}`}
                  open={index === selectedRuns.length - 1}
                  className="rounded-md border border-border bg-[#21262d]/20 p-2.5"
                >
                  <summary className="cursor-pointer text-[10px] text-fg-dim">
                    {new Date(run.startedAt).toLocaleString(locale)} ·{" "}
                    {formatTaskDuration(run.completedAt - run.startedAt)}
                    {run.thinkingLevel
                      ? ` · 思考${TASK_THINKING_LABELS[run.thinkingLevel]}`
                      : ""}
                    {run.totalTokens ? ` · ${run.totalTokens} Token` : ""}
                  </summary>
                  <div className="mt-2 max-h-52 overflow-auto text-xs">
                    <TaskRuntimeOutput source={run.streamText || run.text} />
                  </div>
                  {run.error && (
                    <p className="mt-2 text-[11px] text-red-400">{run.error}</p>
                  )}
                </details>
              ))}
              {selected && !selectedRuns.length && (
                <p className="text-xs text-fg-faint">该子任务暂无模型输出。</p>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function TaskReferencePreview({
  image,
  cwd,
}: {
  image: TaskReferenceImage;
  cwd: string;
}) {
  const [source, setSource] = useState("");
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    let disposed = false;
    void previewLocalFile(image.path, { cwd })
      .then((preview) => {
        if (
          !disposed &&
          preview.kind === "image" &&
          preview.base64 &&
          preview.mime
        ) {
          setSource(`data:${preview.mime};base64,${preview.base64}`);
        }
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [cwd, image.path]);
  return (
    <>
      <button
        type="button"
        title={`${image.fileName}\n${image.path}`}
        onClick={() => setExpanded(true)}
        className="h-24 w-24 overflow-hidden rounded-lg border border-border bg-bg hover:border-accent"
      >
        {source ? (
          <img
            src={source}
            alt={image.fileName}
            className="h-full w-full object-cover"
          />
        ) : (
          <ImagePlaceholder />
        )}
      </button>
      {expanded && source && (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-black/80 p-10"
          onClick={() => setExpanded(false)}
        >
          <img
            src={source}
            alt={image.fileName}
            className="max-h-full max-w-full object-contain"
          />
          <button
            type="button"
            title="关闭图片"
            className="absolute right-6 top-6 rounded-full bg-panel p-2 text-fg"
            onClick={() => setExpanded(false)}
          >
            <X size={20} />
          </button>
        </div>
      )}
    </>
  );
}

function ImagePlaceholder() {
  return (
    <div className="flex h-full w-full items-center justify-center text-xs text-fg-faint">
      图片
    </div>
  );
}
