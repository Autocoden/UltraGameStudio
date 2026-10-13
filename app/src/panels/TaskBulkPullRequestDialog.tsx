import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  ExternalLink,
  GitPullRequest,
  Loader2,
  MinusCircle,
  X,
  XCircle,
} from "lucide-react";
import {
  approveTask,
  updateTaskExecution,
  type TaskCard,
} from "@/lib/taskBoard";
import { taskHasSeparateWorktree } from "@/lib/taskWorktreeReview";
import {
  createTaskPullRequest,
  openExternal,
  type TaskPullRequestResult,
} from "@/lib/tauri";
import { cn } from "@/lib/cn";

type BulkPullRequestStep = "options" | "creating" | "results";
type BulkPullRequestStatus =
  | "pending"
  | "creating"
  | "success"
  | "skipped"
  | "error";

interface BulkPullRequestResult {
  taskId: string;
  taskTitle: string;
  status: BulkPullRequestStatus;
  result?: TaskPullRequestResult;
  error?: string;
}

function isWorktreeError(message: string): boolean {
  return /worktree|工作树|not\s+(?:a\s+)?(?:git\s+)?repository|not found|不存在|找不到/i.test(
    message,
  );
}

/** Git's common ref-name constraints, used for immediate dialog feedback. */
export function isValidGitBranchName(value: string): boolean {
  const branch = value.trim();
  if (!branch) return true;
  if (
    branch === "@" ||
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.includes("//") ||
    Array.from(branch).some((character) => {
      const code = character.charCodeAt(0);
      return (
        code <= 0x20 ||
        code === 0x7f ||
        "~^:?*[\\".includes(character)
      );
    })
  ) {
    return false;
  }
  return branch.split("/").every(
    (part) =>
      Boolean(part) &&
      !part.startsWith(".") &&
      !part.endsWith(".lock"),
  );
}

export default function TaskBulkPullRequestDialog({
  boardKey,
  mainRoot,
  tasks,
  onClose,
  onComplete,
}: {
  boardKey: string;
  mainRoot: string;
  tasks: TaskCard[];
  onClose: () => void;
  onComplete: () => void;
}) {
  const [targetBranch, setTargetBranch] = useState("");
  const [draft, setDraft] = useState(false);
  const [step, setStep] = useState<BulkPullRequestStep>("options");
  const [currentIndex, setCurrentIndex] = useState(0);
  const [results, setResults] = useState<BulkPullRequestResult[]>(() =>
    tasks.map((task) => ({
      taskId: task.id,
      taskTitle: task.title,
      status: "pending",
    })),
  );
  const cancelledRef = useRef(false);
  const branchError = isValidGitBranchName(targetBranch)
    ? ""
    : "分支名称无效，请检查空格、连续斜杠或 Git 保留字符。";

  useEffect(
    () => () => {
      cancelledRef.current = true;
    },
    [],
  );

  const counts = useMemo(
    () => ({
      completed: results.filter((result) =>
        ["success", "skipped", "error"].includes(result.status),
      ).length,
      success: results.filter((result) => result.status === "success").length,
      skipped: results.filter((result) => result.status === "skipped").length,
      error: results.filter((result) => result.status === "error").length,
    }),
    [results],
  );
  const progress = tasks.length
    ? Math.round((counts.completed / tasks.length) * 100)
    : 0;

  const updateResult = (
    taskId: string,
    patch: Partial<BulkPullRequestResult>,
  ) =>
    setResults((current) =>
      current.map((item) =>
        item.taskId === taskId ? { ...item, ...patch } : item,
      ),
    );

  const close = () => {
    cancelledRef.current = true;
    if (step === "results") onComplete();
    onClose();
  };

  const createAll = async () => {
    if (branchError || tasks.length === 0) return;
    cancelledRef.current = false;
    setStep("creating");
    setResults(
      tasks.map((task) => ({
        taskId: task.id,
        taskTitle: task.title,
        status: "pending",
      })),
    );

    for (let index = 0; index < tasks.length; index += 1) {
      if (cancelledRef.current) return;
      const task = tasks[index];
      setCurrentIndex(index);
      updateResult(task.id, { status: "creating", error: undefined });

      if (!mainRoot.trim() || !taskHasSeparateWorktree(task, mainRoot)) {
        updateResult(task.id, {
          status: "skipped",
          error: "没有可用于创建 PR 的任务工作树。",
        });
        continue;
      }

      try {
        const result = await createTaskPullRequest(
          mainRoot,
          task.executionCwd || "",
          {
            targetBranch: targetBranch.trim() || undefined,
            title: task.title,
            body: task.note || undefined,
            draft,
          },
        );
        if (cancelledRef.current) return;
        if (!result.success) {
          updateResult(task.id, {
            status: isWorktreeError(result.message) ? "skipped" : "error",
            result,
            error: result.message || "创建拉取请求失败。",
          });
          continue;
        }
        updateTaskExecution(boardKey, task.id, {
          pullRequestUrl: result.url || task.pullRequestUrl,
        });
        approveTask(boardKey, task.id);
        updateResult(task.id, { status: "success", result, error: undefined });
      } catch (reason) {
        if (cancelledRef.current) return;
        const message = reason instanceof Error ? reason.message : String(reason);
        updateResult(task.id, {
          status: isWorktreeError(message) ? "skipped" : "error",
          error: message || "创建拉取请求失败。",
        });
      }
    }

    if (!cancelledRef.current) setStep("results");
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && step !== "creating") close();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-pr-title"
        className="w-full max-w-[600px] rounded-xl border border-border bg-panel text-fg shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
          <div>
            <h2
              id="bulk-pr-title"
              className="flex items-center gap-2 text-lg font-semibold"
            >
              <GitPullRequest size={19} className="text-accent" />
              批量创建拉取请求
            </h2>
            <p className="mt-1 text-sm text-fg-dim">
              {step === "options" && `为所选 ${tasks.length} 个任务创建 PR`}
              {step === "creating" &&
                `正在处理 ${Math.min(currentIndex + 1, tasks.length)} / ${tasks.length}`}
              {step === "results" &&
                `成功 ${counts.success}，跳过 ${counts.skipped}，失败 ${counts.error}`}
            </p>
          </div>
          <button
            type="button"
            title={step === "creating" ? "停止并关闭" : "关闭"}
            aria-label={step === "creating" ? "停止并关闭" : "关闭"}
            className="rounded-md p-1.5 text-fg-dim transition-colors hover:bg-panel-2 hover:text-fg"
            onClick={close}
          >
            <X size={17} />
          </button>
        </header>

        <div className="space-y-4 px-6 py-5">
          {step === "options" && (
            <>
              <div>
                <p className="mb-2 text-sm font-medium">待处理任务</p>
                <div className="max-h-32 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                  {tasks.map((task, index) => (
                    <div
                      key={task.id}
                      className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-panel-2"
                    >
                      <span className="text-fg-faint">{index + 1}.</span>
                      <span className="truncate">{task.title}</span>
                    </div>
                  ))}
                </div>
              </div>
              <label className="block text-sm font-medium" htmlFor="bulk-pr-target">
                目标分支
              </label>
              <input
                id="bulk-pr-target"
                value={targetBranch}
                onChange={(event) => setTargetBranch(event.target.value)}
                placeholder="main"
                aria-invalid={Boolean(branchError)}
                aria-describedby="bulk-pr-target-hint"
                className="-mt-2 w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none transition-colors focus:border-accent"
              />
              <p
                id="bulk-pr-target-hint"
                className={cn(
                  "-mt-2 text-xs",
                  branchError ? "text-red-400" : "text-fg-faint",
                )}
              >
                {branchError || "留空时使用仓库的默认目标分支。"}
              </p>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft}
                  onChange={(event) => setDraft(event.target.checked)}
                />
                创建为草稿 PR
              </label>
            </>
          )}

          {step === "creating" && (
            <div className="space-y-4" role="status" aria-live="polite">
              <div className="flex flex-col items-center py-2 text-center">
                <Loader2 size={38} className="animate-spin text-accent" />
                <p className="mt-3 text-sm font-medium">正在创建拉取请求</p>
                <p className="mt-1 max-w-[400px] truncate text-xs text-fg-dim">
                  {tasks[currentIndex]?.title}
                </p>
              </div>
              <Progress value={progress} />
              <p className="text-center text-xs text-fg-dim">
                {counts.completed} / {tasks.length} 已完成
              </p>
              <ResultList results={results} />
            </div>
          )}

          {step === "results" && (
            <div className="space-y-4" role="status" aria-live="polite">
              <div className="flex flex-wrap items-center justify-center gap-6 py-2 text-sm font-medium">
                {counts.success > 0 && (
                  <span className="flex items-center gap-2 text-emerald-400">
                    <CheckCircle2 size={18} /> {counts.success} 个成功
                  </span>
                )}
                {counts.skipped > 0 && (
                  <span className="flex items-center gap-2 text-fg-dim">
                    <MinusCircle size={18} /> {counts.skipped} 个跳过
                  </span>
                )}
                {counts.error > 0 && (
                  <span className="flex items-center gap-2 text-red-400">
                    <XCircle size={18} /> {counts.error} 个失败
                  </span>
                )}
              </div>
              <ResultList results={results} detailed />
            </div>
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t border-border px-6 py-4">
          {step === "options" ? (
            <>
              <button
                type="button"
                className="rounded-md border border-border px-4 py-2 text-sm hover:bg-panel-2"
                onClick={close}
              >
                取消
              </button>
              <button
                type="button"
                disabled={Boolean(branchError) || tasks.length === 0}
                className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-bg disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => void createAll()}
              >
                <GitPullRequest size={15} />
                创建 {tasks.length} 个 PR
              </button>
            </>
          ) : step === "results" ? (
            <button
              type="button"
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-bg"
              onClick={close}
            >
              关闭
            </button>
          ) : (
            <button
              type="button"
              className="rounded-md border border-border px-4 py-2 text-sm hover:bg-panel-2"
              onClick={close}
            >
              停止并关闭
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

function Progress({ value }: { value: number }) {
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      className="h-2 overflow-hidden rounded-full bg-border-soft"
    >
      <div
        className="h-full rounded-full bg-accent transition-[width]"
        style={{ width: `${value}%` }}
      />
    </div>
  );
}

function ResultList({
  results,
  detailed = false,
}: {
  results: BulkPullRequestResult[];
  detailed?: boolean;
}) {
  return (
    <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border p-2">
      {results.map((result, index) => (
        <div
          key={result.taskId}
          data-bulk-pr-task={result.taskId}
          data-bulk-pr-status={result.status}
          className="flex items-start gap-2 rounded px-2 py-1.5 text-sm hover:bg-panel-2"
        >
          <ResultIcon status={result.status} />
          <div className="min-w-0 flex-1">
            <p className="truncate">
              <span className="mr-2 text-fg-faint">{index + 1}.</span>
              {result.taskTitle}
            </p>
            {detailed && result.error && (
              <p className="mt-0.5 break-words text-xs text-fg-dim">
                {result.error}
              </p>
            )}
          </div>
          {detailed && result.result?.url && (
            <button
              type="button"
              title="查看 PR"
              aria-label={`查看 ${result.taskTitle} 的 PR`}
              className="rounded p-1 text-accent hover:bg-accent/10"
              onClick={() => void openExternal(result.result!.url!)}
            >
              <ExternalLink size={14} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function ResultIcon({ status }: { status: BulkPullRequestStatus }) {
  if (status === "creating") {
    return <Loader2 size={15} className="mt-0.5 shrink-0 animate-spin text-accent" />;
  }
  if (status === "success") {
    return <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-emerald-400" />;
  }
  if (status === "skipped") {
    return <MinusCircle size={15} className="mt-0.5 shrink-0 text-fg-dim" />;
  }
  if (status === "error") {
    return <XCircle size={15} className="mt-0.5 shrink-0 text-red-400" />;
  }
  return <span className="mt-1 h-3 w-3 shrink-0 rounded-full border border-border" />;
}
