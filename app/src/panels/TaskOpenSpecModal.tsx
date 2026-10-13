import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  CheckCircle2,
  FileCode2,
  GitMerge,
  MessageSquare,
  Play,
  Square,
  X,
} from "lucide-react";
import TaskGitChanges from "@/panels/TaskGitChanges";
import TaskFeedbackComposer from "@/panels/TaskFeedbackComposer";
import TaskLiveInstruction from "@/panels/TaskLiveInstruction";
import TaskNeedsInputDialog from "@/panels/TaskNeedsInputDialog";
import TaskOpenSpecDetail from "@/panels/TaskOpenSpecDetail";
import TaskWorktreeReview from "@/panels/TaskWorktreeReview";
import { t, type Locale } from "@/lib/i18n";
import {
  approveTask,
  requeueTask,
  TASK_MAX_REFERENCE_IMAGES,
  updateTask,
  updateTaskExecution,
  type TaskCard,
  type TaskDecisionAnswer,
  type TaskReferenceImage,
} from "@/lib/taskBoard";
import { stopTask } from "@/lib/taskBoardRunner";
import {
  taskAwaitsPlanApproval,
  taskRequiresWorktreeReview,
} from "@/lib/taskWorktreeReview";

const iconButton =
  "inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-dim transition-colors hover:bg-panel-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const actionButton =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-border px-2.5 text-xs transition-colors hover:bg-panel-2 disabled:cursor-not-allowed disabled:opacity-40";

export default function TaskOpenSpecModal({
  boardKey,
  cwd,
  card,
  locale,
  onClose,
  initialArchive,
  onArchived,
}: {
  boardKey: string;
  cwd: string;
  card: TaskCard;
  locale: Locale;
  onClose: () => void;
  initialArchive?: boolean;
  onArchived?: () => void;
}) {
  const modal = useRef<HTMLDivElement>(null);
  const active =
    card.phase === "planning" ||
    card.phase === "executing" ||
    card.phase === "reviewing";
  const awaitingPlanApproval = taskAwaitsPlanApproval(card);
  const requiresWorktreeReview = taskRequiresWorktreeReview(card, cwd);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewView, setReviewView] = useState<"review" | "git">("review");
  const [feedback, setFeedback] = useState("");
  const [feedbackImages, setFeedbackImages] = useState<TaskReferenceImage[]>([]);
  const [needsInputOpen, setNeedsInputOpen] = useState(
    Boolean(card.needsInput?.blocked),
  );

  const start = () => requeueTask(boardKey, card.id);
  const approvePlan = () => {
    approveTask(boardKey, card.id);
    setReviewOpen(false);
  };
  const requestChanges = () => {
    const value = feedback.trim();
    if (!value && !feedbackImages.length) return;
    const attachmentNote = feedbackImages.length
      ? `反馈附件：\n${feedbackImages
          .map((image) => `- ${image.path}`)
          .join("\n")}`
      : "";
    if (feedbackImages.length) {
      updateTask(boardKey, card.id, {
        meta: {
          referenceImages: [
            ...(card.referenceImages ?? []),
            ...feedbackImages,
          ].slice(0, TASK_MAX_REFERENCE_IMAGES),
        },
      });
    }
    updateTaskExecution(boardKey, card.id, {
      feedback: [value, attachmentNote].filter(Boolean).join("\n\n"),
      ...(awaitingPlanApproval
        ? { plan: "", planApproved: false, subtasks: [] }
        : {}),
    });
    start();
    setFeedback("");
    setFeedbackImages([]);
    setReviewOpen(false);
  };
  const resolveNeedsInput = (answers: TaskDecisionAnswer[]) => {
    const decisions = [
      "用户已确认以下实施决策：",
      ...answers.map(
        (answer, index) =>
          String(index + 1) + ". " + answer.question + " → " + answer.answer,
      ),
    ].join("\n");
    updateTaskExecution(boardKey, card.id, {
      feedback: [card.feedback?.trim(), decisions].filter(Boolean).join("\n\n"),
      needsInput: undefined,
      plan: "",
      planApproved: false,
      subtasks: [],
    });
    setNeedsInputOpen(false);
    start();
  };

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    modal.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);
  useEffect(() => {
    if (card.needsInput?.blocked) setNeedsInputOpen(true);
  }, [card.id, card.needsInput]);

  return createPortal(
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
        data-testid="openspec-task-detail"
        className="fixed inset-3 flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-bg text-fg shadow-2xl outline-none"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            if (reviewOpen) {
              setReviewOpen(false);
              setReviewView("review");
            } else {
              onClose();
            }
            return;
          }
          if (event.key !== "Tab") return;
          const items = modal.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]',
          );
          if (!items?.length) return;
          const first = items[0];
          const last = items[items.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-panel px-4">
          <FileCode2 size={16} className="shrink-0 text-accent" />
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
            {card.title}
          </h2>
          <span
            className="max-w-48 shrink-0 truncate rounded border border-border px-2 py-0.5 font-mono text-[10px] text-fg-dim"
            title={card.id}
          >
            {card.id.slice(0, 8)}
          </span>
          <span className="shrink-0 rounded bg-[#58a6ff]/10 px-2 py-0.5 text-[10px] font-medium text-accent">
            OpenSpec
          </span>
          {active ? (
            <button
              type="button"
              className={actionButton}
              onClick={() => stopTask(boardKey, card.id)}
            >
              <Square size={13} />
              停止
            </button>
          ) : card.status === "human_review" ? (
            <>
              <button
                type="button"
                className={actionButton}
                onClick={() => {
                  setReviewView("review");
                  setReviewOpen(true);
                }}
              >
                <MessageSquare size={13} />
                要求修改
              </button>
              {card.needsInput?.blocked ? (
                <button
                  type="button"
                  className={actionButton + " bg-amber-400 text-black"}
                  onClick={() => setNeedsInputOpen(true)}
                >
                  <MessageSquare size={13} />
                  回答问题
                </button>
              ) : awaitingPlanApproval ? (
                <button
                  type="button"
                  className={`${actionButton} bg-accent text-bg`}
                  onClick={approvePlan}
                >
                  <CheckCircle2 size={13} />
                  批准规范并构建
                </button>
              ) : requiresWorktreeReview ? (
                <button
                  type="button"
                  className={`${actionButton} bg-accent text-bg`}
                  onClick={() => {
                    setReviewView("review");
                    setReviewOpen(true);
                  }}
                >
                  <GitMerge size={13} />
                  验收改动
                </button>
              ) : (
                <button
                  type="button"
                  className={`${actionButton} bg-accent text-bg`}
                  onClick={() => approveTask(boardKey, card.id)}
                >
                  <CheckCircle2 size={13} />
                  标记完成
                </button>
              )}
            </>
          ) : card.status !== "done" ? (
            <button type="button" className={actionButton} onClick={start}>
              <Play size={13} />
              {card.runs?.length ? "继续" : "开始"}
            </button>
          ) : null}
          <button
            type="button"
            className={iconButton}
            title={t(locale, "common.close")}
            aria-label={t(locale, "common.close")}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <div className="min-h-0 flex-1">
          <TaskOpenSpecDetail
            initialArchive={initialArchive}
            onArchived={onArchived}
            boardKey={boardKey}
            cwd={card.executionCwd || cwd}
            card={card}
            active={active}
            flush
          />
        </div>
        {active && <TaskLiveInstruction boardKey={boardKey} cardId={card.id} />}
        {reviewOpen && card.status === "human_review" && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/70 p-6">
            <div className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-border bg-panel shadow-2xl">
              <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
                {reviewView === "git" && (
                  <button
                    type="button"
                    className={iconButton}
                    aria-label="返回验收"
                    onClick={() => setReviewView("review")}
                  >
                    <ArrowLeft size={16} />
                  </button>
                )}
                <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">
                  {reviewView === "git" ? "任务 Git 变更" : "任务验收"}
                </h3>
                <button
                  type="button"
                  className={iconButton}
                  aria-label="关闭验收"
                  onClick={() => setReviewOpen(false)}
                >
                  <X size={16} />
                </button>
              </header>
              <div className="min-h-0 flex-1 overflow-auto p-5">
                {reviewView === "git" ? (
                  <TaskGitChanges
                    cwd={card.executionCwd || cwd}
                    cardId={card.id}
                    baseBranch={card.baseBranch}
                    locale={locale}
                  />
                ) : (
                  <div className="space-y-4">
                    {requiresWorktreeReview ? (
                      <TaskWorktreeReview
                        boardKey={boardKey}
                        mainRoot={cwd}
                        card={card}
                        onViewChanges={() => setReviewView("git")}
                        onClose={onClose}
                      />
                    ) : (
                      <section className="rounded-xl border border-border bg-bg/40 p-4">
                        <h4 className="text-sm font-semibold">
                          {awaitingPlanApproval
                            ? "审核 OpenSpec 规划工件"
                            : "人工验收"}
                        </h4>
                        <p className="mt-1 text-xs leading-5 text-fg-dim">
                          {awaitingPlanApproval
                            ? "检查规范、设计和实施任务；确认后继续执行构建。"
                            : "检查规范工件与执行结果，确认无误后标记完成。"}
                        </p>
                        <button
                          type="button"
                          className={`${actionButton} mt-3 bg-accent text-bg`}
                          onClick={() =>
                            awaitingPlanApproval
                              ? approvePlan()
                              : approveTask(boardKey, card.id)
                          }
                        >
                          <CheckCircle2 size={13} />
                          {awaitingPlanApproval ? "批准规范并构建" : "标记完成"}
                        </button>
                      </section>
                    )}
                    <section className="rounded-xl border border-border bg-bg/40 p-4">
                      <h4 className="text-sm font-semibold">要求修改</h4>
                      <TaskFeedbackComposer
                        value={feedback}
                        onChange={setFeedback}
                        attachments={feedbackImages}
                        onAttachmentsChange={setFeedbackImages}
                        cwd={card.executionCwd || cwd}
                        existingCount={card.referenceImages?.length ?? 0}
                        placeholder="描述需要修改的规范、实现或验收问题…"
                        className="mt-3"
                        textareaClassName="min-h-28 rounded-md"
                      />
                      <div className="mt-3 flex justify-end">
                        <button
                          type="button"
                          className={actionButton}
                          disabled={!feedback.trim() && !feedbackImages.length}
                          onClick={requestChanges}
                        >
                          <MessageSquare size={13} />
                          提交反馈并继续
                        </button>
                      </div>
                    </section>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
        {needsInputOpen && card.needsInput?.blocked && (
          <TaskNeedsInputDialog
            needsInput={card.needsInput}
            onClose={() => setNeedsInputOpen(false)}
            onSubmit={resolveNeedsInput}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}
