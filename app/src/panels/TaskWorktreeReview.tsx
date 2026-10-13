import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Code2,
  ExternalLink,
  Eye,
  FileCode2,
  FolderX,
  GitBranch,
  GitCommit,
  GitMerge,
  GitPullRequest,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  Send,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cn } from "@/lib/cn";
import {
  loadTaskDeveloperToolPreferences,
  subscribeTaskDeveloperToolPreferences,
  taskIDELabel,
  taskTerminalLabel,
} from "@/lib/taskDeveloperTools";
import {
  approveTask,
  removeTask,
  updateTaskExecution,
  type TaskCard,
} from "@/lib/taskBoard";
import {
  cleanupTaskWorktree,
  createTaskPullRequest,
  getTaskWorktreeReview,
  integrateTaskWorktree,
  openWorkspaceInIde,
  openWorkspaceInTerminal,
  pushTaskWorktree,
  type TaskPullRequestResult,
  type TaskWorktreeIntegrateResult,
  type TaskWorktreePushResult,
  type TaskWorktreeReview as TaskWorktreeReviewState,
} from "@/lib/tauri";

const button =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-panel-2 disabled:cursor-not-allowed disabled:opacity-40";

export default function TaskWorktreeReview({
  boardKey,
  mainRoot,
  card,
  onViewChanges,
  onClose,
}: {
  boardKey: string;
  mainRoot: string;
  card: TaskCard;
  onViewChanges: () => void;
  onClose: () => void;
}) {
  const worktreeRoot = card.executionCwd || "";
  const [review, setReview] = useState<TaskWorktreeReviewState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<
    "merge" | "push" | "pr" | "cleanup" | "discard" | null
  >(null);
  const [stageOnly, setStageOnly] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<
    | TaskWorktreeIntegrateResult
    | TaskWorktreePushResult
    | TaskPullRequestResult
    | null
  >(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const [showPr, setShowPr] = useState(false);
  const [showConflicts, setShowConflicts] = useState(false);
  const [developerTools, setDeveloperTools] = useState(
    loadTaskDeveloperToolPreferences,
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await getTaskWorktreeReview(
        mainRoot,
        worktreeRoot,
        card.baseBranch,
      );
      setReview(next);
    } catch (reason) {
      setReview(null);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [card.baseBranch, mainRoot, worktreeRoot]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(
    () => subscribeTaskDeveloperToolPreferences(setDeveloperTools),
    [],
  );

  const integrate = async () => {
    setBusy("merge");
    setError("");
    setResult(null);
    try {
      const next = await integrateTaskWorktree(mainRoot, worktreeRoot, {
        targetBranch: review?.targetBranch || card.baseBranch,
        stageOnly,
        commitMessage: card.title,
      });
      setResult(next);
      if (!next.success) {
        setError(next.message);
        return;
      }
      if (next.staged) {
        updateTaskExecution(boardKey, card.id, {
          stagedInMainProject: true,
          worktreeCleaned: false,
        });
      } else {
        updateTaskExecution(boardKey, card.id, {
          stagedInMainProject: false,
          worktreeCleaned: next.worktreeCleaned,
          ...(next.worktreeCleaned ? { executionCwd: mainRoot } : {}),
        });
        if (next.worktreeCleaned) approveTask(boardKey, card.id);
      }
      if (next.staged || !next.worktreeCleaned) await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const push = async () => {
    setBusy("push");
    setError("");
    try {
      const next = await pushTaskWorktree(mainRoot, worktreeRoot, {
        targetBranch: review?.targetBranch || card.baseBranch,
        commitMessage: card.title,
      });
      setResult(next);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const createPr = async (options: {
    targetBranch: string;
    title: string;
    body: string;
    draft: boolean;
  }) => {
    setBusy("pr");
    setError("");
    try {
      const next = await createTaskPullRequest(mainRoot, worktreeRoot, options);
      setResult(next);
      if (!next.success) {
        setError(next.message);
        return;
      }
      updateTaskExecution(boardKey, card.id, {
        pullRequestUrl: next.url || undefined,
      });
      approveTask(boardKey, card.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const cleanup = async (discard: boolean, markDone = false) => {
    setBusy(discard ? "discard" : "cleanup");
    setError("");
    try {
      const next = await cleanupTaskWorktree(mainRoot, worktreeRoot, {
        deleteBranch: true,
        force: discard,
      });
      if (discard) {
        removeTask(boardKey, card.id);
        onClose();
        return;
      }
      updateTaskExecution(boardKey, card.id, {
        executionCwd: mainRoot,
        worktreeCleaned: true,
      });
      setResult({
        success: next.success,
        url: null,
        alreadyExists: false,
        branch: next.branch,
        targetBranch: review?.targetBranch || card.baseBranch || "",
        commitCreated: false,
        message: next.message,
      });
      setConfirmCleanup(false);
      if (markDone) approveTask(boardKey, card.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const openWorktree = async (target: "ide" | "terminal") => {
    setError("");
    try {
      if (target === "ide") {
        await openWorkspaceInIde(
          worktreeRoot,
          developerTools.preferredIDE,
          developerTools.preferredIDE === "custom"
            ? developerTools.customIDEPath
            : undefined,
        );
      } else {
        await openWorkspaceInTerminal(
          worktreeRoot,
          developerTools.preferredTerminal,
          developerTools.preferredTerminal === "custom"
            ? developerTools.customTerminalPath
            : undefined,
        );
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  if (card.stagedInMainProject) {
    return (
      <section className="overflow-hidden rounded-xl border border-emerald-500/30 bg-emerald-500/5">
        <div className="flex items-start gap-3 p-4">
          <CheckCircle2
            size={18}
            className="mt-0.5 shrink-0 text-emerald-400"
          />
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-emerald-300">
              改动已暂存到主项目
            </h3>
            <p className="mt-1 text-xs leading-5 text-fg-dim">
              请在主项目检查已暂存改动，然后执行提交。建议提交信息：
            </p>
            <code className="mt-2 block overflow-auto rounded bg-bg/70 px-3 py-2 text-xs">
              git commit -m &quot;{card.title.replace(/&quot;/g, "'")}&quot;
            </code>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className={button} onClick={onViewChanges}>
                <Eye size={13} />
                查看任务改动
              </button>
              <button
                type="button"
                className={`${button} flex-1 bg-accent text-bg`}
                disabled={busy !== null}
                onClick={() => setConfirmCleanup(true)}
              >
                <Trash2 size={13} />
                清理工作树并标记完成
              </button>
              <button
                type="button"
                className={button}
                onClick={() => approveTask(boardKey, card.id)}
              >
                <CheckCircle2 size={13} />
                仅标记完成（保留工作树）
              </button>
            </div>
          </div>
        </div>
        {confirmCleanup && (
          <ConfirmDialog
            title="清理任务工作树"
            description="主项目中的已暂存改动会保留。任务工作树将被移除，任务随后标记完成；若分支尚未合并，Git 会保留该分支。"
            confirmLabel="清理并完成"
            busy={busy === "cleanup"}
            onCancel={() => setConfirmCleanup(false)}
            onConfirm={() => void cleanup(false, true)}
          />
        )}
      </section>
    );
  }

  if (review?.alreadyMerged) {
    return (
      <section className="overflow-hidden rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
        <div className="flex items-start gap-3">
          <CheckCircle2
            size={18}
            className="mt-0.5 shrink-0 text-emerald-400"
          />
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-emerald-300">
              任务分支已合并到 {review.targetBranch}
            </h3>
            <p className="mt-1 text-xs leading-5 text-fg-dim">
              主项目已经包含任务分支的提交。清理独立工作树后即可完成验收。
            </p>
            {result?.message && (
              <p className="mt-2 whitespace-pre-wrap text-xs text-fg-dim">
                {result.message}
              </p>
            )}
            {error && (
              <p role="alert" className="mt-2 text-xs text-red-400">
                {error}
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className={button} onClick={onViewChanges}>
                <Eye size={13} />
                查看任务改动
              </button>
              <button
                type="button"
                className={`${button} flex-1 bg-accent text-bg`}
                disabled={busy !== null}
                onClick={() => setConfirmCleanup(true)}
              >
                <Trash2 size={13} />
                清理工作树并标记完成
              </button>
              <button
                type="button"
                className={button}
                disabled={busy !== null}
                onClick={() => approveTask(boardKey, card.id)}
              >
                <CheckCircle2 size={13} />
                仅标记完成（保留工作树）
              </button>
            </div>
          </div>
        </div>
        {confirmCleanup && (
          <ConfirmDialog
            title="清理已合并的任务工作树"
            description="任务提交已经位于主项目中。此操作会移除独立工作树和任务分支，然后将任务标记完成。"
            confirmLabel="清理并完成"
            busy={busy === "cleanup"}
            onCancel={() => setConfirmCleanup(false)}
            onConfirm={() => void cleanup(false, true)}
          />
        )}
      </section>
    );
  }

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-bg/40">
      <div className="border-b border-border bg-[#21262d]/35 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <GitBranch size={16} className="text-violet-400" />
            构建已就绪，等待人工验收
          </h3>
          <button
            type="button"
            className={button}
            disabled={loading || busy !== null}
            onClick={() => void refresh()}
          >
            <RefreshCw size={13} className={cn(loading && "animate-spin")} />
            刷新
          </button>
        </div>
        {review && (
          <>
            <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-fg-dim">
              <span className="flex items-center gap-1.5">
                <FileCode2 size={13} />
                <strong className="text-fg">{review.filesChanged}</strong>{" "}
                个文件
              </span>
              <span className="flex items-center gap-1.5">
                <GitCommit size={13} />
                <strong className="text-fg">{review.commitCount}</strong> 个提交
              </span>
              <span className="flex items-center gap-1 text-emerald-400">
                <Plus size={13} /> {review.additions}
              </span>
              <span className="flex items-center gap-1 text-red-400">
                <Minus size={13} /> {review.deletions}
              </span>
            </div>
            <div className="mt-2 flex min-w-0 items-center gap-2 text-[11px] text-fg-dim">
              <code className="max-w-[42%] truncate rounded bg-bg px-1.5 py-0.5">
                {review.branch}
              </code>
              <span>→</span>
              <code className="truncate rounded bg-bg px-1.5 py-0.5">
                {review.targetBranch}
              </code>
            </div>
            <p className="mt-2 truncate font-mono text-[10px] text-fg-faint">
              {review.worktreePath}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className={button}
                onClick={() => void openWorktree("ide")}
              >
                <Code2 size={13} />
                在 {taskIDELabel(developerTools.preferredIDE)} 中打开
              </button>
              <button
                type="button"
                className={button}
                onClick={() => void openWorktree("terminal")}
              >
                <Terminal size={13} />
                在 {taskTerminalLabel(developerTools.preferredTerminal)} 中打开
              </button>
            </div>
          </>
        )}
      </div>

      <div className="space-y-3 p-4">
        {loading && !review && (
          <div className="flex items-center gap-2 py-3 text-sm text-fg-dim">
            <Loader2 size={16} className="animate-spin" />
            正在检查工作树与合并冲突…
          </div>
        )}
        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300"
          >
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words break-words">
              {error}
            </span>
            <button
              type="button"
              aria-label="关闭错误"
              onClick={() => setError("")}
            >
              <X size={13} />
            </button>
          </div>
        )}
        {result?.success && (
          <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-300">
            <CheckCircle2 size={15} className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p>{result.message}</p>
              {"url" in result && result.url && (
                <button
                  type="button"
                  className="mt-2 inline-flex items-center gap-1 text-accent hover:underline"
                  onClick={() => void openUrl(result.url!)}
                >
                  {result.url}
                  <ExternalLink size={12} />
                </button>
              )}
            </div>
          </div>
        )}
        {!!review?.mainDirtyFiles.length && (
          <WarningList
            title={`主项目有 ${review.mainDirtyFiles.length} 个未提交文件`}
            description="请先提交或暂存主项目改动，避免覆盖你正在进行的工作。"
            files={review.mainDirtyFiles}
          />
        )}
        {!!review?.potentialConflicts.length && (
          <WarningList
            title={`发现 ${review.potentialConflicts.length} 个可能冲突的文件`}
            description="执行合并时将让 Git 尝试自动处理；若仍冲突，操作会中止并恢复主项目。"
            files={review.potentialConflicts}
            onDetails={() => setShowConflicts(true)}
          />
        )}
        {review?.commitsBehind ? (
          <p className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-300">
            目标分支比任务分支领先 {review.commitsBehind}{" "}
            个提交，合并时会包含这些分支差异。
          </p>
        ) : null}

        {review && (
          <label className="inline-flex cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-[#161b22]/50 px-3 py-2 text-sm">
            <input
              type="checkbox"
              checked={stageOnly}
              onChange={(event) => setStageOnly(event.target.checked)}
              className="accent-violet-500"
            />
            <span className={stageOnly ? "text-fg" : "text-fg-dim"}>
              仅将改动暂存到主项目，由我手动提交
            </span>
          </label>
        )}

        <div className="flex flex-wrap gap-2">
          <button type="button" className={button} onClick={onViewChanges}>
            <Eye size={13} />
            查看变更
          </button>
          <button
            type="button"
            className={`${button} min-w-40 flex-1 bg-accent text-bg hover:opacity-90`}
            disabled={!review || review.mainDirty || busy !== null}
            onClick={() => void integrate()}
          >
            {busy === "merge" ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <GitMerge size={14} />
            )}
            {stageOnly
              ? `暂存到 ${review?.targetBranch || "主项目"}`
              : `合并到 ${review?.targetBranch || "主项目"}`}
          </button>
          <button
            type="button"
            className={button}
            disabled={!review?.remoteUrl || busy !== null}
            onClick={() => void push()}
          >
            {busy === "push" ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Send size={13} />
            )}
            推送
          </button>
          <button
            type="button"
            className={button}
            disabled={!review?.remoteUrl || busy !== null}
            onClick={() => setShowPr(true)}
          >
            <GitPullRequest size={13} />
            创建 PR
          </button>
          <button
            type="button"
            title="丢弃任务工作树"
            className={`${button} text-red-400`}
            disabled={busy !== null}
            onClick={() => setConfirmDiscard(true)}
          >
            <FolderX size={13} />
          </button>
        </div>
      </div>

      {showPr && review && (
        <PullRequestDialog
          card={card}
          review={review}
          busy={busy === "pr"}
          error={error}
          result={
            result && "url" in result ? (result as TaskPullRequestResult) : null
          }
          onClose={() => setShowPr(false)}
          onSubmit={(options) => void createPr(options)}
        />
      )}
      {confirmDiscard && (
        <ConfirmDialog
          danger
          title="丢弃任务工作树"
          description="这会永久删除任务工作树、其中尚未提交的文件和任务分支，并删除该看板任务。"
          confirmLabel="丢弃并删除"
          busy={busy === "discard"}
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={() => void cleanup(true)}
        />
      )}
      {showConflicts && review && (
        <ConflictDetailsDialog
          files={review.potentialConflicts}
          stageOnly={stageOnly}
          busy={busy === "merge"}
          canMerge={!review.mainDirty && busy === null}
          onClose={() => setShowConflicts(false)}
          onMerge={() => {
            setShowConflicts(false);
            void integrate();
          }}
        />
      )}
    </section>
  );
}

function WarningList({
  title,
  description,
  files,
  onDetails,
}: {
  title: string;
  description: string;
  files: string[];
  onDetails?: () => void;
}) {
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs">
      <div className="flex items-start gap-2">
        <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-400" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-amber-300">{title}</p>
          <p className="mt-1 leading-5 text-fg-dim">{description}</p>
          <ul className="mt-2 space-y-1 font-mono text-[10px] text-fg-dim">
            {files.slice(0, 6).map((file) => (
              <li key={file} className="truncate" title={file}>
                {file}
              </li>
            ))}
            {files.length > 6 && <li>另有 {files.length - 6} 个文件…</li>}
          </ul>
          {onDetails && (
            <button
              type="button"
              className={cn(button, "mt-2")}
              onClick={onDetails}
            >
              查看冲突详情
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ConflictDetailsDialog({
  files,
  stageOnly,
  busy,
  canMerge,
  onClose,
  onMerge,
}: {
  files: string[];
  stageOnly: boolean;
  busy: boolean;
  canMerge: boolean;
  onClose: () => void;
  onMerge: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[115] flex items-center justify-center bg-black/70 p-6">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label="合并冲突预览"
        className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-panel shadow-2xl"
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-border px-5 py-4">
          <AlertTriangle size={19} className="mt-0.5 shrink-0 text-amber-400" />
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold">合并冲突预览</h3>
            <p className="mt-1 text-xs leading-5 text-fg-dim">
              检测到 {files.length} 个任务分支与目标分支同时修改的文件。Git
              会先尝试自动合并；仍有冲突时将中止操作并恢复主项目。
            </p>
          </div>
          <button type="button" aria-label="关闭冲突详情" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-3 overflow-auto p-5">
          {files.map((file) => (
            <div
              key={file}
              className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="min-w-0 break-all font-mono text-xs">
                  {file}
                </span>
                <span className="shrink-0 rounded bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-300">
                  可能冲突
                </span>
              </div>
              <dl className="mt-2 grid gap-1 text-[11px] leading-5 text-fg-dim">
                <div>
                  <dt className="inline text-fg">原因：</dt>
                  <dd className="inline">目标分支和任务分支都修改了该路径。</dd>
                </div>
                <div>
                  <dt className="inline text-fg">策略：</dt>
                  <dd className="inline">
                    先由 Git 自动合并；无法安全合并时回滚并保留两个工作区。
                  </dd>
                </div>
              </dl>
            </div>
          ))}
        </div>
        <footer className="flex shrink-0 justify-end gap-2 border-t border-border px-5 py-4">
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={onClose}
          >
            关闭
          </button>
          <button
            type="button"
            className={cn(button, "bg-amber-400 text-black hover:bg-amber-300")}
            disabled={!canMerge || busy}
            onClick={onMerge}
          >
            {busy ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <GitMerge size={13} />
            )}
            {stageOnly ? "继续暂存改动" : "继续合并"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function PullRequestDialog({
  card,
  review,
  busy,
  error,
  result,
  onClose,
  onSubmit,
}: {
  card: TaskCard;
  review: TaskWorktreeReviewState;
  busy: boolean;
  error: string;
  result: TaskPullRequestResult | null;
  onClose: () => void;
  onSubmit: (options: {
    targetBranch: string;
    title: string;
    body: string;
    draft: boolean;
  }) => void;
}) {
  const [targetBranch, setTargetBranch] = useState(review.targetBranch);
  const [title, setTitle] = useState(card.title);
  const [body, setBody] = useState(card.note);
  const [draft, setDraft] = useState(false);
  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="创建 Pull Request"
        className="w-full max-w-lg rounded-xl border border-border bg-panel p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-base font-semibold">
              <GitPullRequest size={17} className="text-accent" />
              创建 Pull Request
            </h3>
            <p className="mt-1 text-xs text-fg-dim">
              推送 {review.branch} 并向目标分支创建 PR。
            </p>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        {result?.success ? (
          <div className="mt-5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-300">
            <p>{result.message}</p>
            {result.url && (
              <button
                type="button"
                className="mt-2 inline-flex items-center gap-1 text-accent hover:underline"
                onClick={() => void openUrl(result.url!)}
              >
                {result.url}
                <ExternalLink size={12} />
              </button>
            )}
          </div>
        ) : (
          <div className="mt-5 space-y-4">
            <label className="block text-xs text-fg-dim">
              目标分支
              <input
                value={targetBranch}
                onChange={(event) => setTargetBranch(event.target.value)}
                className="mt-1.5 w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg"
              />
            </label>
            <label className="block text-xs text-fg-dim">
              PR 标题
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                className="mt-1.5 w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg"
              />
            </label>
            <label className="block text-xs text-fg-dim">
              PR 描述
              <textarea
                value={body}
                onChange={(event) => setBody(event.target.value)}
                className="mt-1.5 min-h-28 w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg"
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft}
                onChange={(event) => setDraft(event.target.checked)}
                className="accent-violet-500"
              />
              创建为草稿 PR
            </label>
            {error && <p className="text-xs text-red-400">{error}</p>}
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={onClose}
          >
            {result?.success ? "关闭" : "取消"}
          </button>
          {!result?.success && (
            <button
              type="button"
              className={`${button} bg-accent text-bg`}
              disabled={busy || !title.trim() || !targetBranch.trim()}
              onClick={() => onSubmit({ targetBranch, title, body, draft })}
            >
              {busy ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <GitPullRequest size={14} />
              )}
              {busy ? "正在创建…" : "创建 PR"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ConfirmDialog({
  title,
  description,
  confirmLabel,
  danger = false,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[115] flex items-center justify-center bg-black/70 p-6">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-md rounded-xl border border-border bg-panel p-5 shadow-2xl"
      >
        <h3 className="text-base font-semibold">{title}</h3>
        <p className="mt-3 text-sm leading-6 text-fg-dim">{description}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={onCancel}
          >
            取消
          </button>
          <button
            type="button"
            className={cn(
              button,
              danger ? "bg-red-500 text-white" : "bg-accent text-bg",
            )}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy && <Loader2 size={13} className="animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
