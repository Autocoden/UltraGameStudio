import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Copy,
  FileDiff,
  FilePlus,
  FileX,
  GitBranch,
  GitCommit as GitCommitIcon,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { Locale } from "@/lib/i18n";
import {
  getTaskGitOverview,
  listTaskGitCommitFiles,
  listTaskGitCommits,
  listWorkspaceChanges,
  readTaskGitCommitFileDiff,
  type TaskGitCommit,
  type TaskGitCommitFile,
  type TaskGitOverview,
  type WorkspaceChangeFile,
} from "@/lib/tauri";

type ChangeSetMode = "workspace" | "commit";
type DisplayFile = {
  path: string;
  previousPath?: string | null;
  status: "M" | "A" | "D" | "R";
  additions: number;
  deletions: number;
  workspaceFile?: WorkspaceChangeFile;
};

interface CommitGraphRow {
  commit: TaskGitCommit;
  lanesBefore: string[];
  lanesAfter: string[];
  laneIndex: number;
  parentLaneIndexes: number[];
  isNewLane: boolean;
  laneCount: number;
}

const GRAPH_ROW_HEIGHT = 72;
const GRAPH_DOT_Y = 20;
const GRAPH_LANE_WIDTH = 12;
const GRAPH_X_PADDING = 10;
const GRAPH_COLORS = [
  "#3b82f6",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#a855f7",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
];
const button =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-panel-2 disabled:opacity-40";

const TASK_GIT_CHANGE_HIDDEN_DIRS = new Set([
  ".git",
  ".claude",
  ".codex",
  ".cursor",
  ".continue",
  ".windsurf",
  ".aider",
  ".autocode",
  ".auto-claude",
  ".ugs",
  ".ultragamestudio",
  ".worktree",
  ".worktrees",
]);

export function shouldHideTaskGitChangePath(
  filePath: string | undefined | null,
): boolean {
  if (!filePath) return false;
  const [firstSegment] = filePath
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .split("/")
    .filter(Boolean);
  return firstSegment
    ? TASK_GIT_CHANGE_HIDDEN_DIRS.has(firstSegment.toLowerCase())
    : false;
}

export function isVisibleTaskGitFile(file: {
  path?: string | null;
  previousPath?: string | null;
}): boolean {
  return (
    !shouldHideTaskGitChangePath(file.path) &&
    !shouldHideTaskGitChangePath(file.previousPath)
  );
}

function workspaceStatus(
  status: WorkspaceChangeFile["status"],
): DisplayFile["status"] {
  if (status === "added") return "A";
  if (status === "deleted") return "D";
  if (status === "renamed") return "R";
  return "M";
}

function workspaceDisplayFile(file: WorkspaceChangeFile): DisplayFile {
  return {
    path: file.path,
    previousPath: file.oldPath,
    status: workspaceStatus(file.status),
    additions: file.lines.filter(
      (line) => line.kind === "added" || line.kind === "replacedAdded",
    ).length,
    deletions: file.lines.filter(
      (line) => line.kind === "deleted" || line.kind === "replacedDeleted",
    ).length,
    workspaceFile: file,
  };
}

function commitDisplayFile(file: TaskGitCommitFile): DisplayFile {
  return {
    path: file.path,
    previousPath: file.previousPath,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
  };
}

function getGraphColor(hash: string | undefined, laneIndex: number): string {
  if (!hash) return GRAPH_COLORS[laneIndex % GRAPH_COLORS.length];
  let value = 0;
  for (let index = 0; index < hash.length; index += 1) {
    value =
      (value + hash.charCodeAt(index) * (index + 1)) % GRAPH_COLORS.length;
  }
  return GRAPH_COLORS[value];
}

export function buildTaskCommitGraphRows(
  commits: TaskGitCommit[],
): CommitGraphRow[] {
  const visibleHashes = new Set(commits.map((commit) => commit.hash));
  let lanes: string[] = [];
  return commits.map((commit) => {
    let lanesBefore = lanes.slice();
    let laneIndex = lanesBefore.indexOf(commit.hash);
    let isNewLane = false;
    if (laneIndex === -1) {
      laneIndex = lanesBefore.length;
      lanesBefore = [...lanesBefore, commit.hash];
      lanes = lanesBefore.slice();
      isNewLane = true;
    }
    const visibleParents = (commit.parents ?? []).filter((parent) =>
      visibleHashes.has(parent),
    );
    const lanesAfter = lanesBefore.filter((_, index) => index !== laneIndex);
    let insertAt = laneIndex;
    for (const parent of visibleParents) {
      if (lanesAfter.includes(parent)) continue;
      const safeInsertAt = Math.min(insertAt, lanesAfter.length);
      lanesAfter.splice(safeInsertAt, 0, parent);
      insertAt = safeInsertAt + 1;
    }
    lanes = lanesAfter.filter(
      (hash, index, values) => !!hash && values.indexOf(hash) === index,
    );
    return {
      commit,
      lanesBefore,
      lanesAfter: lanes.slice(),
      laneIndex,
      parentLaneIndexes: visibleParents
        .map((parent) => lanes.indexOf(parent))
        .filter((index) => index >= 0),
      isNewLane,
      laneCount: Math.max(lanesBefore.length, lanes.length, laneIndex + 1, 1),
    };
  });
}

function CommitGraph({
  row,
  selected,
}: {
  row: CommitGraphRow;
  selected: boolean;
}) {
  const width = Math.max(
    36,
    GRAPH_X_PADDING * 2 + row.laneCount * GRAPH_LANE_WIDTH,
  );
  const laneX = (index: number) => GRAPH_X_PADDING + index * GRAPH_LANE_WIDTH;
  const commitColor = getGraphColor(row.commit.hash, row.laneIndex);
  const unchangedLanes = row.lanesBefore
    .map((hash, laneIndex) => ({ hash, laneIndex }))
    .filter(
      ({ hash, laneIndex }) =>
        laneIndex !== row.laneIndex && row.lanesAfter.includes(hash),
    );
  return (
    <svg
      aria-hidden="true"
      width={width}
      height={GRAPH_ROW_HEIGHT}
      viewBox={"0 0 " + width + " " + GRAPH_ROW_HEIGHT}
      className="shrink-0 overflow-visible"
    >
      {unchangedLanes.map(({ hash, laneIndex }) => (
        <line
          key={hash + "-" + laneIndex}
          x1={laneX(laneIndex)}
          y1={0}
          x2={laneX(laneIndex)}
          y2={GRAPH_ROW_HEIGHT}
          stroke={getGraphColor(hash, laneIndex)}
          strokeWidth="2"
          opacity="0.7"
        />
      ))}
      {!row.isNewLane && (
        <line
          x1={laneX(row.laneIndex)}
          y1={0}
          x2={laneX(row.laneIndex)}
          y2={GRAPH_DOT_Y}
          stroke={commitColor}
          strokeWidth="2"
          opacity="0.8"
        />
      )}
      {row.parentLaneIndexes.map((parentLaneIndex) => {
        const hash = row.lanesAfter[parentLaneIndex];
        return (
          <path
            key={hash + "-" + parentLaneIndex}
            d={
              "M " +
              laneX(row.laneIndex) +
              " " +
              GRAPH_DOT_Y +
              " C " +
              laneX(row.laneIndex) +
              " " +
              (GRAPH_DOT_Y + 20) +
              ", " +
              laneX(parentLaneIndex) +
              " " +
              (GRAPH_ROW_HEIGHT - 22) +
              ", " +
              laneX(parentLaneIndex) +
              " " +
              GRAPH_ROW_HEIGHT
            }
            fill="none"
            stroke={getGraphColor(hash, parentLaneIndex)}
            strokeWidth="2"
            opacity="0.85"
          />
        );
      })}
      {row.commit.isMerge && (
        <circle
          cx={laneX(row.laneIndex)}
          cy={GRAPH_DOT_Y}
          r="7"
          fill="none"
          stroke={commitColor}
          strokeWidth="1.5"
          opacity="0.7"
        />
      )}
      <circle
        cx={laneX(row.laneIndex)}
        cy={GRAPH_DOT_Y}
        r={selected ? 5.5 : 4.5}
        fill={commitColor}
        stroke="currentColor"
        strokeWidth={selected ? 3 : 2.5}
      />
    </svg>
  );
}

function FileStatusIcon({ status }: { status: DisplayFile["status"] }) {
  if (status === "A")
    return <FilePlus size={15} className="shrink-0 text-green-400" />;
  if (status === "D")
    return <FileX size={15} className="shrink-0 text-red-400" />;
  if (status === "R")
    return <FileDiff size={15} className="shrink-0 text-blue-400" />;
  return <FileDiff size={15} className="shrink-0 text-amber-400" />;
}

function DiffView({
  text,
  workspaceFile,
  truncated,
}: {
  text: string;
  workspaceFile?: WorkspaceChangeFile;
  truncated?: boolean;
}) {
  if (workspaceFile) {
    if (workspaceFile.binary) {
      return (
        <p className="p-6 text-sm text-fg-dim">二进制文件无法显示文本差异。</p>
      );
    }
    if (!workspaceFile.lines.length) {
      return (
        <p className="p-6 text-sm text-fg-dim">该文件没有可显示的行差异。</p>
      );
    }
    return (
      <div className="min-w-max p-4 font-mono text-xs">
        {workspaceFile.lines.map((line, index) => {
          const added = line.kind === "added" || line.kind === "replacedAdded";
          const deleted =
            line.kind === "deleted" || line.kind === "replacedDeleted";
          return (
            <div
              key={
                String(line.oldLine) + "-" + String(line.newLine) + "-" + index
              }
              className={cn(
                "flex min-h-6",
                added && "bg-green-500/10 text-green-300",
                deleted && "bg-red-500/10 text-red-300",
              )}
            >
              <span className="w-12 shrink-0 border-r border-[#30363d]/50 px-2 py-1 text-right text-[#8b949e]/60">
                {line.oldLine ?? ""}
              </span>
              <span className="w-12 shrink-0 border-r border-[#30363d]/50 px-2 py-1 text-right text-[#8b949e]/60">
                {line.newLine ?? ""}
              </span>
              <span className="w-6 shrink-0 py-1 text-center">
                {added ? "+" : deleted ? "-" : " "}
              </span>
              <span className="whitespace-pre px-1 py-1">
                {line.content || " "}
              </span>
            </div>
          );
        })}
        {(workspaceFile.truncated || truncated) && (
          <p className="mt-3 text-amber-400">差异较大，当前内容已截断。</p>
        )}
      </div>
    );
  }
  if (!text)
    return <p className="p-6 text-sm text-fg-dim">没有可显示的差异。</p>;
  return (
    <div className="min-w-max p-4 font-mono text-xs">
      {text.split("\n").map((line, index) => (
        <div
          key={index}
          className={cn(
            "min-h-6 whitespace-pre px-2 py-1",
            line.startsWith("+") &&
              !line.startsWith("+++") &&
              "bg-green-500/10 text-green-300",
            line.startsWith("-") &&
              !line.startsWith("---") &&
              "bg-red-500/10 text-red-300",
            line.startsWith("@@") && "bg-blue-500/10 text-blue-300",
            (line.startsWith("diff ") ||
              line.startsWith("index ") ||
              line.startsWith("---") ||
              line.startsWith("+++")) &&
              "bg-panel-2 text-fg-dim",
          )}
        >
          {line || " "}
        </div>
      ))}
      {truncated && (
        <p className="mt-3 text-amber-400">差异超过 2 MB，当前内容已截断。</p>
      )}
    </div>
  );
}

function sumStats(files: DisplayFile[]) {
  return files.reduce(
    (value, file) => ({
      files: value.files + 1,
      additions: value.additions + file.additions,
      deletions: value.deletions + file.deletions,
    }),
    { files: 0, additions: 0, deletions: 0 },
  );
}

function formatCommitDate(value: string, locale: Locale): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(locale, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

export default function TaskGitChanges({
  cwd,
  cardId,
  baseBranch,
  locale,
}: {
  cwd: string;
  cardId: string;
  baseBranch?: string;
  locale: Locale;
}) {
  const [overview, setOverview] = useState<TaskGitOverview | null>(null);
  const [workspaceFiles, setWorkspaceFiles] = useState<DisplayFile[]>([]);
  const [commits, setCommits] = useState<TaskGitCommit[]>([]);
  const [commitFiles, setCommitFiles] = useState<DisplayFile[]>([]);
  const [activeChangeSet, setActiveChangeSet] =
    useState<ChangeSetMode>("workspace");
  const [selectedCommit, setSelectedCommit] = useState("");
  const [selectedFile, setSelectedFile] = useState("");
  const [diffText, setDiffText] = useState("");
  const [diffTruncated, setDiffTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      if (!cwd) throw new Error("请先选择项目工作区");
      const nextOverview = await getTaskGitOverview(cwd);
      const [changes, history] = await Promise.all([
        listWorkspaceChanges(cwd, "board-" + cardId),
        listTaskGitCommits(
          cwd,
          baseBranch || nextOverview.defaultBranch || undefined,
        ),
      ]);
      const nextWorkspaceFiles = changes.files
        .map(workspaceDisplayFile)
        .filter(isVisibleTaskGitFile);
      setOverview(nextOverview);
      setWorkspaceFiles(nextWorkspaceFiles);
      setCommits(history);
      if (nextWorkspaceFiles.length) {
        setActiveChangeSet("workspace");
        setSelectedCommit("");
        setSelectedFile((current) =>
          nextWorkspaceFiles.some((file) => file.path === current)
            ? current
            : nextWorkspaceFiles[0].path,
        );
      } else if (history.length) {
        setActiveChangeSet("commit");
        setSelectedCommit((current) =>
          history.some((commit) => commit.hash === current)
            ? current
            : history[0].hash,
        );
      } else {
        setSelectedFile("");
        setSelectedCommit("");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [baseBranch, cardId, cwd]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    if (activeChangeSet !== "commit" || !selectedCommit) {
      setCommitFiles([]);
      return;
    }
    setLoadingFiles(true);
    setSelectedFile("");
    setDiffText("");
    void listTaskGitCommitFiles(cwd, selectedCommit)
      .then((files) => {
        if (cancelled) return;
        const next = files.map(commitDisplayFile).filter(isVisibleTaskGitFile);
        setCommitFiles(next);
        setSelectedFile(next[0]?.path || "");
      })
      .catch((reason) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoadingFiles(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeChangeSet, cwd, selectedCommit]);

  useEffect(() => {
    let cancelled = false;
    setDiffText("");
    setDiffTruncated(false);
    if (activeChangeSet !== "commit" || !selectedCommit || !selectedFile) {
      setLoadingDiff(false);
      return;
    }
    setLoadingDiff(true);
    const timer = window.setTimeout(() => {
      void readTaskGitCommitFileDiff(cwd, selectedCommit, selectedFile)
        .then((result) => {
          if (!cancelled) {
            setDiffText(result.text);
            setDiffTruncated(result.truncated);
          }
        })
        .catch((reason) => {
          if (!cancelled)
            setError(reason instanceof Error ? reason.message : String(reason));
        })
        .finally(() => {
          if (!cancelled) setLoadingDiff(false);
        });
    }, 80);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeChangeSet, cwd, selectedCommit, selectedFile]);

  const graphRows = useMemo(() => buildTaskCommitGraphRows(commits), [commits]);
  const displayedFiles =
    activeChangeSet === "workspace" ? workspaceFiles : commitFiles;
  const selectedFileData = displayedFiles.find(
    (file) => file.path === selectedFile,
  );
  const workspaceStats = sumStats(workspaceFiles);
  const displayedStats = sumStats(displayedFiles);

  return (
    <div className="flex h-full min-h-[440px] overflow-hidden rounded-lg border border-border bg-bg">
      <aside className="flex w-80 shrink-0 flex-col border-r border-border">
        <div className="flex items-center justify-between border-b border-border bg-[#21262d]/40 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <GitBranch size={15} className="shrink-0 text-fg-dim" />
            <div className="min-w-0">
              <p className="truncate text-xs font-medium">
                {overview?.currentBranch || "Git 变更"}
              </p>
              <p className="truncate text-[10px] text-fg-dim">
                {overview?.upstream || overview?.remoteUrl || "未设置上游分支"}
              </p>
            </div>
          </div>
          <button
            className={button}
            title="刷新 Git 变更"
            disabled={loading}
            onClick={() => void refresh()}
          >
            <RefreshCw size={13} className={cn(loading && "animate-spin")} />
          </button>
        </div>
        {overview && (
          <div className="flex flex-wrap gap-1.5 border-b border-border px-3 py-2 text-[10px]">
            <span
              className={cn(
                "rounded border border-border px-1.5 py-0.5",
                overview.dirty ? "text-amber-400" : "text-green-400",
              )}
            >
              {overview.dirty ? "有未提交变更" : "工作区干净"}
            </span>
            {!!overview.ahead && <span>领先 {overview.ahead}</span>}
            {!!overview.behind && <span>落后 {overview.behind}</span>}
            {(baseBranch || overview.defaultBranch) && (
              <span className="truncate text-fg-dim">
                基准 {baseBranch || overview.defaultBranch}
              </span>
            )}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto p-2">
          <button
            type="button"
            onClick={() => {
              setActiveChangeSet("workspace");
              setSelectedCommit("");
              setSelectedFile(workspaceFiles[0]?.path || "");
            }}
            className={cn(
              "mb-2 w-full rounded-md border p-3 text-left",
              activeChangeSet === "workspace"
                ? "border-accent bg-[#58a6ff]/10"
                : "border-border hover:bg-panel-2",
            )}
          >
            <div className="flex items-center gap-2">
              <FileDiff size={15} className="text-amber-400" />
              <span className="text-xs font-medium">当前工作区</span>
              <span className="ml-auto rounded bg-panel-2 px-1.5 text-[10px]">
                {workspaceStats.files}
              </span>
            </div>
            <p className="mt-1 text-[10px] text-fg-dim">
              {workspaceStats.files
                ? workspaceStats.files +
                  " 个文件 · +" +
                  workspaceStats.additions +
                  " / -" +
                  workspaceStats.deletions
                : "没有未提交的文件变更"}
            </p>
          </button>
          <div className="mb-1 flex items-center gap-2 px-1 text-[10px] uppercase tracking-wide text-fg-dim">
            <GitCommitIcon size={12} />
            提交历史
          </div>
          {graphRows.map((row) => (
            <button
              key={row.commit.hash}
              type="button"
              onClick={() => {
                setActiveChangeSet("commit");
                setSelectedCommit(row.commit.hash);
              }}
              className={cn(
                "flex w-full rounded-md text-left hover:bg-panel-2",
                activeChangeSet === "commit" &&
                  selectedCommit === row.commit.hash &&
                  "bg-[#58a6ff]/10",
              )}
            >
              <CommitGraph
                row={row}
                selected={
                  activeChangeSet === "commit" &&
                  selectedCommit === row.commit.hash
                }
              />
              <div className="min-w-0 flex-1 py-2 pr-2">
                <p className="truncate text-xs font-medium">
                  {row.commit.message}
                </p>
                <div className="mt-1 flex items-center gap-1.5 text-[10px] text-fg-dim">
                  <span className="font-mono">{row.commit.shortHash}</span>
                  <span className="truncate">{row.commit.author}</span>
                </div>
                <p className="mt-0.5 text-[10px] text-fg-dim">
                  {formatCommitDate(row.commit.date, locale)}
                </p>
              </div>
            </button>
          ))}
          {!loading && !commits.length && (
            <p className="px-2 py-5 text-center text-xs text-fg-dim">
              基准分支之后暂无提交
            </p>
          )}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-12 items-center justify-between border-b border-border bg-[#21262d]/20 px-4">
          <div className="min-w-0">
            <p className="truncate text-xs font-medium">
              {activeChangeSet === "workspace"
                ? "当前工作区变更"
                : commits.find((commit) => commit.hash === selectedCommit)
                    ?.message || "提交变更"}
            </p>
            <p className="text-[10px] text-fg-dim">
              {displayedStats.files} 个文件 ·
              <span className="ml-1 text-green-400">
                +{displayedStats.additions}
              </span>
              <span className="ml-1 text-red-400">
                -{displayedStats.deletions}
              </span>
            </p>
          </div>
          {selectedCommit && (
            <button
              className={button}
              title="复制提交哈希"
              onClick={() => void navigator.clipboard.writeText(selectedCommit)}
            >
              <Copy size={12} />
              {selectedCommit.slice(0, 8)}
            </button>
          )}
        </header>
        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-300"
          >
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span className="break-all">{error}</span>
          </div>
        )}
        <div className="flex min-h-0 flex-1">
          <div className="w-64 shrink-0 overflow-auto border-r border-border p-2">
            {(loading || loadingFiles) && (
              <p className="flex items-center gap-2 p-3 text-xs text-fg-dim">
                <Loader2 size={14} className="animate-spin" />
                加载中...
              </p>
            )}
            {!loading &&
              !loadingFiles &&
              displayedFiles.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => setSelectedFile(file.path)}
                  className={cn(
                    "mb-1 flex w-full items-start gap-2 rounded p-2 text-left hover:bg-panel-2",
                    selectedFile === file.path && "bg-[#58a6ff]/10",
                  )}
                >
                  <FileStatusIcon status={file.status} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs" title={file.path}>
                      {file.path.split(/[\\/]/).pop()}
                    </p>
                    <p className="truncate text-[10px] text-fg-dim">
                      {file.previousPath
                        ? file.previousPath + " → " + file.path
                        : file.path}
                    </p>
                    <p className="mt-1 text-[10px]">
                      <span className="text-green-400">+{file.additions}</span>
                      <span className="ml-2 text-red-400">
                        -{file.deletions}
                      </span>
                    </p>
                  </div>
                  <span className="rounded border border-border px-1 text-[9px] text-fg-dim">
                    {file.status}
                  </span>
                </button>
              ))}
            {!loading && !loadingFiles && !displayedFiles.length && (
              <p className="p-5 text-center text-xs text-fg-dim">
                没有文件变更
              </p>
            )}
          </div>
          <div className="min-w-0 flex-1 overflow-auto">
            {loadingDiff ? (
              <div className="flex h-full items-center justify-center text-fg-dim">
                <Loader2 size={18} className="animate-spin" />
              </div>
            ) : selectedFileData ? (
              <DiffView
                text={diffText}
                workspaceFile={selectedFileData.workspaceFile}
                truncated={diffTruncated}
              />
            ) : (
              <div className="flex h-full items-center justify-center">
                <div className="text-center text-fg-dim">
                  <FileDiff size={30} className="mx-auto mb-2 opacity-50" />
                  <p className="text-sm">选择文件以查看差异</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
