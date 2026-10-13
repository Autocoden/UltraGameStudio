import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  AlertCircle,
  Archive,
  Ban,
  CheckCircle2,
  CircleDot,
  FileCode2,
  FileText,
  History,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
  Square,
  Trash2,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/cn";
import { archiveTask, getBoardTasks, moveTask, setTaskPhase, updateTaskExecution, requeueTask, type TaskCard } from "@/lib/taskBoard";
import TaskWorkspaceFiles from "@/panels/TaskWorkspaceFiles";
import { getRunnerSnapshot, getTaskStream, subscribeRunner } from "@/lib/taskBoardRunner";
import { getTaskExecution, subscribeTaskExecutions } from "@/lib/taskExecution";
import { RuntimeOutput } from "@/panels/TaskRuntimeLogs";
import {
  acknowledgeOpenSpecPlanningReview,
  cancelOpenSpecWorkspaceAction,
  discardInterruptedOpenSpecAction,
  getOpenSpecActionSnapshot,
  OPEN_SPEC_WORKSPACE_ACTIONS,
  openSpecActionLabel,
  resolveOpenSpecAutomaticAction,
  resumeOpenSpecWorkspaceAction,
  runOpenSpecWorkspaceAction,
  sendOpenSpecSessionInput,
  subscribeOpenSpecActions,
  type OpenSpecWorkspaceAction,
} from "@/lib/openSpecWorkspaceActions";
import {
  archiveOpenSpecChange,
  getOpenSpecChangeStatus,
  getOpenSpecRuntimeStatus,
  listOpenSpecChanges,
  previewLocalFile,
  setOpenSpecTaskStatus,
  validateOpenSpecChange,
  type OpenSpecCommandResult,
  type OpenSpecRuntimeStatus,
  type WorkspaceChangeFile,
} from "@/lib/tauri";

type ArtifactState = "done" | "skipped" | "ready" | "blocked" | "unknown";

export interface OpenSpecArtifactSnapshot {
  id: string;
  outputPath: string;
  status: ArtifactState;
  requires: string[];
  missingDeps: string[];
  documents: string[];
}

export interface OpenSpecStatusSnapshot {
  changeName: string;
  schemaName: string;
  changeRoot: string;
  isPlanningComplete: boolean;
  isComplete: boolean;
  nextSteps: string[];
  artifacts: OpenSpecArtifactSnapshot[];
}

export interface OpenSpecChangeSummary {
  name: string;
  completedTasks: number;
  totalTasks: number;
  lastModified?: string;
  status: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function parseOpenSpecStatus(
  result: OpenSpecCommandResult,
): OpenSpecStatusSnapshot | null {
  const payload = record(result.json);
  if (!payload) return null;
  const pathRecords = record(payload.artifactPaths) ?? {};
  const artifacts = Array.isArray(payload.artifacts)
    ? payload.artifacts.flatMap((value) => {
        const artifact = record(value);
        if (!artifact || typeof artifact.id !== "string") return [];
        const path = record(pathRecords[artifact.id]);
        const rawStatus =
          typeof artifact.status === "string" ? artifact.status : "unknown";
        const status: ArtifactState = [
          "done",
          "skipped",
          "ready",
          "blocked",
        ].includes(rawStatus)
          ? (rawStatus as ArtifactState)
          : "unknown";
        return [
          {
            id: artifact.id,
            outputPath:
              typeof artifact.outputPath === "string"
                ? artifact.outputPath
                : typeof path?.outputPath === "string"
                  ? path.outputPath
                  : "",
            status,
            requires: strings(artifact.requires),
            missingDeps: strings(artifact.missingDeps),
            documents: strings(path?.existingOutputPaths),
          },
        ];
      })
    : [];
  return {
    changeName:
      typeof payload.changeName === "string" ? payload.changeName : "",
    schemaName:
      typeof payload.schemaName === "string" ? payload.schemaName : "",
    changeRoot:
      typeof payload.changeRoot === "string" ? payload.changeRoot : "",
    isPlanningComplete: payload.isPlanningComplete === true,
    isComplete: payload.isComplete === true,
    nextSteps: strings(payload.nextSteps),
    artifacts,
  };
}

export function parseOpenSpecChangeList(
  result: OpenSpecCommandResult,
): OpenSpecChangeSummary[] {
  const payload = record(result.json);
  if (!payload || !Array.isArray(payload.changes)) return [];
  return payload.changes.flatMap((value) => {
    const change = record(value);
    if (!change || typeof change.name !== "string") return [];
    return [
      {
        name: change.name,
        completedTasks:
          typeof change.completedTasks === "number"
            ? change.completedTasks
            : 0,
        totalTasks:
          typeof change.totalTasks === "number" ? change.totalTasks : 0,
        ...(typeof change.lastModified === "string"
          ? { lastModified: change.lastModified }
          : {}),
        status: typeof change.status === "string" ? change.status : "unknown",
      },
    ];
  });
}

function commandDetail(result: OpenSpecCommandResult): string {
  const payload = record(result.json);
  const diagnostics = Array.isArray(payload?.status)
    ? payload.status.flatMap((item) => {
        const diagnostic = record(item);
        return typeof diagnostic?.message === "string" ? [diagnostic.message] : [];
      })
    : [];
  if (diagnostics.length) return diagnostics.join("\n");
  return (
    result.stderr.trim() ||
    result.stdout.trim() ||
    (result.timedOut
      ? "OpenSpec 命令执行超时"
      : "OpenSpec 命令没有返回详细信息")
  );
}

function formatOpenSpecModified(value?: string): string {
  if (!value) return "时间未知";
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function displayPath(path: string, changeName: string): string {
  const normalized = path.replace(/\\/g, "/");
  const marker = `/openspec/changes/${changeName}/`;
  const offset = normalized.toLowerCase().indexOf(marker.toLowerCase());
  return offset >= 0 ? normalized.slice(offset + marker.length) : normalized;
}

function artifactVisual(status: ArtifactState) {
  switch (status) {
    case "done":
    case "skipped":
      return {
        Icon: CheckCircle2,
        label: status === "done" ? "已完成" : "已跳过",
        color: "text-emerald-400",
      };
    case "ready":
      return { Icon: CircleDot, label: "可生成", color: "text-sky-400" };
    case "blocked":
      return { Icon: Ban, label: "等待依赖", color: "text-fg-faint" };
    default:
      return { Icon: AlertCircle, label: "未知", color: "text-amber-400" };
  }
}

function PlanningReviewDiff({ file }: { file: WorkspaceChangeFile | null }) {
  if (!file) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-fg-dim">
        选择文件查看规划改动
      </div>
    );
  }
  if (file.binary) {
    return (
      <div className="p-5 text-sm text-fg-dim">二进制文件无法显示文本差异。</div>
    );
  }
  if (!file.lines.length) {
    return (
      <div className="p-5 text-sm text-fg-dim">该文件没有可显示的行差异。</div>
    );
  }
  return (
    <div className="min-w-max p-3 font-mono text-xs">
      {file.lines.map((line, index) => {
        const added =
          line.kind === "added" || line.kind === "replacedAdded";
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
            <span className="w-11 shrink-0 border-r border-border/50 px-1.5 py-1 text-right text-fg-faint">
              {line.oldLine ?? ""}
            </span>
            <span className="w-11 shrink-0 border-r border-border/50 px-1.5 py-1 text-right text-fg-faint">
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
      {file.truncated && (
        <p className="mt-3 text-amber-400">差异较大，当前内容已截断。</p>
      )}
    </div>
  );
}

const actionButton =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-panel-2 disabled:cursor-not-allowed disabled:opacity-40";

export default function TaskOpenSpecDetail({
  boardKey,
  cwd,
  card,
  active,
  flush = false,
  initialArchive = false,
  onArchived,
}: {
  boardKey: string;
  cwd: string;
  card: TaskCard;
  active: boolean;
  flush?: boolean;
  initialArchive?: boolean;
  onArchived?: () => void;
}) {
  const changeName = card.openSpecChange || "";
  const [runtime, setRuntime] = useState<OpenSpecRuntimeStatus | null>(null);
  const [snapshot, setSnapshot] = useState<OpenSpecStatusSnapshot | null>(null);
  const [selectedArtifactId, setSelectedArtifactId] = useState("");
  const [selectedDocument, setSelectedDocument] = useState("");
  const [content, setContent] = useState("");
  const [previewMode, setPreviewMode] = useState<"rendered" | "source">(
    "rendered",
  );
  const [loading, setLoading] = useState(true);
  const [loadingDocument, setLoadingDocument] = useState(false);
  const [action, setAction] = useState<"validate" | "archive" | null>(null);
  const [validation, setValidation] = useState<OpenSpecCommandResult | null>(
    null,
  );
  const [error, setError] = useState("");
  const [confirmArchive, setConfirmArchive] = useState(initialArchive);
  const [forceArchive, setForceArchive] = useState(false);
  const [skipArchiveSpecs, setSkipArchiveSpecs] = useState(false);
  const [bulkArchiveOpen, setBulkArchiveOpen] = useState(false);
  const [bulkArchiveLoading, setBulkArchiveLoading] = useState(false);
  const [bulkChanges, setBulkChanges] = useState<OpenSpecChangeSummary[]>([]);
  const [bulkSelection, setBulkSelection] = useState<string[]>([]);
  const [bulkProgress, setBulkProgress] = useState("");
  const [archiveResult, setArchiveResult] = useState(card.openSpecArchive);
  const archived = archiveResult?.changeName === changeName;
  const [documentRevision, setDocumentRevision] = useState(0);
  const [pendingTask, setPendingTask] = useState<number | null>(null);
  const [selectedAction, setSelectedAction] =
    useState<OpenSpecWorkspaceAction>("explore");
  const [actionInput, setActionInput] = useState("");
  const [sessionInput, setSessionInput] = useState("");
  const [sessionInputSubmitting, setSessionInputSubmitting] = useState(false);
  const [activityExpanded, setActivityExpanded] = useState(true);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [planningReviewOpen, setPlanningReviewOpen] = useState(false);
  const [selectedReviewPath, setSelectedReviewPath] = useState("");
  const activityOutputRef = useRef<HTMLDivElement | null>(null);
  useSyncExternalStore(subscribeRunner, getRunnerSnapshot, getRunnerSnapshot);
  const taskStream = getTaskStream(boardKey, card.id);
  const taskBusy = Boolean(useSyncExternalStore(subscribeTaskExecutions,
    () => getTaskExecution(boardKey, card.id), () => null));
  const subscribeActionRuntime = useCallback(
    (listener: () => void) => subscribeOpenSpecActions(listener),
    [],
  );
  const readActionRuntime = useCallback(
    () => getOpenSpecActionSnapshot(boardKey, card.id),
    [boardKey, card.id],
  );
  const actionRuntime = useSyncExternalStore(
    subscribeActionRuntime,
    readActionRuntime,
    readActionRuntime,
  );
  const activeActionRun = actionRuntime.activeRun;
  const planningReview = actionRuntime.planningReview;
  const selectedReviewFile =
    planningReview?.files.find((file) => file.path === selectedReviewPath) ||
    planningReview?.files[0] ||
    null;
  const workspaceActionBusy =
    activeActionRun?.state === "running" ||
    activeActionRun?.state === "cancelling";
  const interruptedAction = activeActionRun?.state === "interrupted";
  const activityRuns = useMemo(
    () => {
      const phaseLabels = { planning: "任务规划", executing: "任务编码", reviewing: "任务验收" };
      const runs = [
      ...actionRuntime.history,
      ...(activeActionRun ? [activeActionRun] : []),
      ].map(run => ({ ...run, label: openSpecActionLabel(run.action),
        output: [run.output, run.error && !run.output.includes(run.error) ? run.error : ""].filter(Boolean).join("\n\n") }));
      const taskRuns = (card.runs || []).map(run => ({
        id: `task-${run.phase}-${run.startedAt}`, startedAt: run.startedAt,
        label: phaseLabels[run.phase], state: run.error ? "failed" as const : "succeeded" as const,
        output: [run.streamText || "", run.text && !run.streamText?.includes(run.text) ? run.text : "", run.error || ""].filter(Boolean).join("\n\n"),
      }));
      const live = taskStream && !taskRuns.some(run => run.id === `task-${taskStream.phase}-${taskStream.startedAt}`)
        ? [{ id: `task-${taskStream.phase}-${taskStream.startedAt}`, startedAt: taskStream.startedAt,
          label: phaseLabels[taskStream.phase], state: "running" as const, output: taskStream.text }]
        : [];
      return [...runs, ...taskRuns, ...live].sort((a, b) => a.startedAt - b.startedAt);
    },
    [actionRuntime.history, activeActionRun, card.runs, taskStream],
  );
  const liveRun = [...activityRuns].reverse().find(run => run.state === "running" || run.state === "cancelling");
  const liveRunId = liveRun?.id;
  const displayedRun =
    activityRuns.find((run) => run.id === selectedRunId) ||
    liveRun ||
    activityRuns.at(-1) ||
    null;

  useEffect(() => {
    setSelectedRunId(liveRunId || "");
  }, [liveRunId]);

  useEffect(() => {
    const output = activityOutputRef.current;
    if (!output || displayedRun?.id !== liveRunId) return;
    output.scrollTop = output.scrollHeight;
  }, [liveRunId, displayedRun?.id, displayedRun?.output]);

  useEffect(() => {
    if (!planningReview) {
      setPlanningReviewOpen(false);
      setSelectedReviewPath("");
      return;
    }
    setSelectedReviewPath((current) =>
      planningReview.files.some((file) => file.path === current)
        ? current
        : planningReview.files[0]?.path || "",
    );
    if (!planningReview.acknowledged) setPlanningReviewOpen(true);
  }, [planningReview]);

  const refresh = useCallback(async () => {
    if (archived) {
      setLoading(false);
      setDocumentRevision((revision) => revision + 1);
      return;
    }
    setLoading(true);
    setError("");
    try {
      if (!cwd) throw new Error("请先选择项目工作区");
      if (!changeName) throw new Error("此任务尚未绑定 OpenSpec 变更");
      const [nextRuntime, result] = await Promise.all([
        getOpenSpecRuntimeStatus(),
        getOpenSpecChangeStatus(cwd, changeName),
      ]);
      const nextSnapshot = parseOpenSpecStatus(result);
      if (!nextSnapshot) throw new Error("OpenSpec 状态返回了无法识别的数据");
      setRuntime(nextRuntime);
      setSnapshot(nextSnapshot);
      setSelectedArtifactId((current) =>
        nextSnapshot.artifacts.some((artifact) => artifact.id === current)
          ? current
          : nextSnapshot.artifacts.find((artifact) => artifact.documents.length)
              ?.id ||
            nextSnapshot.artifacts[0]?.id ||
            "",
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [archived, changeName, cwd]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectedArtifact = useMemo(
    () =>
      snapshot?.artifacts.find(
        (artifact) => artifact.id === selectedArtifactId,
      ),
    [selectedArtifactId, snapshot],
  );

  useEffect(() => {
    const documents = selectedArtifact?.documents ?? [];
    setSelectedDocument((current) =>
      documents.includes(current) ? current : documents[0] || "",
    );
  }, [selectedArtifact]);

  useEffect(() => {
    let cancelled = false;
    setContent("");
    if (!selectedDocument || archived) {
      setLoadingDocument(false);
      return;
    }
    setLoadingDocument(true);
    void previewLocalFile(selectedDocument, { cwd })
      .then((result) => {
        if (!cancelled) setContent(result.text || "");
      })
      .catch((reason) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoadingDocument(false);
      });
    return () => {
      cancelled = true;
    };
  }, [archived, cwd, documentRevision, selectedDocument]);

  const recordArchive = (result: OpenSpecCommandResult, selectedChange: string) => {
    if (!result.success) throw new Error(commandDetail(result));
    const payload = record(record(result.json)?.archive);
    if (payload?.change !== selectedChange || typeof payload.path !== "string" || !payload.path) {
      throw new Error("OpenSpec 未返回有效的归档结果，请刷新并核对变更目录。");
    }
    const metadata = {
      changeName: selectedChange,
      path: payload.path,
      specsUpdated: payload.specsUpdated === true,
    };
    for (const task of getBoardTasks(boardKey)) {
      if (task.developmentMode === "spec" && task.openSpecChange === selectedChange &&
        (!task.executionCwd || task.executionCwd === cwd)) {
        updateTaskExecution(boardKey, task.id, { openSpecArchive: metadata });
        if (task.status !== "done") moveTask(boardKey, task.id, "done");
        setTaskPhase(boardKey, task.id, "complete");
        archiveTask(boardKey, task.id);
      }
    }
    if (selectedChange === changeName) setArchiveResult(metadata);
  };

  const runValidation = async () => {
    setAction("validate");
    setError("");
    try {
      const result = await validateOpenSpecChange(cwd, changeName);
      setValidation(result);
      if (!result.success) setError(`严格校验未通过：${commandDetail(result)}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAction(null);
    }
  };

  const runArchive = async () => {
    setAction("archive");
    setError("");
    try {
      if (!forceArchive) {
        const checked = await validateOpenSpecChange(cwd, changeName);
        setValidation(checked);
        if (!checked.success) {
          throw new Error(`严格校验未通过：${commandDetail(checked)}`);
        }
      }
      const result = await archiveOpenSpecChange(cwd, changeName, {
        force: forceArchive,
        skipSpecs: skipArchiveSpecs,
      });
      recordArchive(result, changeName);
      setConfirmArchive(false);
      setForceArchive(false);
      setSkipArchiveSpecs(false);
      onArchived?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAction(null);
    }
  };

  const closeBulkArchive = () => {
    setBulkArchiveOpen(false);
    setBulkArchiveLoading(false);
    setBulkChanges([]);
    setBulkSelection([]);
    setBulkProgress("");
    setForceArchive(false);
    setSkipArchiveSpecs(false);
  };

  const openBulkArchive = async () => {
    setBulkArchiveOpen(true);
    setBulkArchiveLoading(true);
    setBulkChanges([]);
    setBulkSelection([]);
    setBulkProgress("");
    setForceArchive(false);
    setSkipArchiveSpecs(false);
    setError("");
    try {
      const result = await listOpenSpecChanges(cwd);
      if (!result.success) throw new Error(commandDetail(result));
      const changes = parseOpenSpecChangeList(result);
      setBulkChanges(changes);
      setBulkSelection(
        changes
          .filter(
            (change) =>
              change.totalTasks === 0 ||
              change.completedTasks >= change.totalTasks,
          )
          .map((change) => change.name),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      closeBulkArchive();
    } finally {
      setBulkArchiveLoading(false);
    }
  };

  const runBulkArchive = async () => {
    if (!bulkSelection.length) return;
    if (
      !forceArchive &&
      bulkChanges.some(
        (change) =>
          bulkSelection.includes(change.name) &&
          change.totalTasks > 0 &&
          change.completedTasks < change.totalTasks,
      )
    ) {
      setError("选中的变更包含未完成任务，请先启用强制归档。");
      return;
    }
    setAction("archive");
    setError("");
    try {
      for (const [index, selectedChange] of bulkSelection.entries()) {
        setBulkProgress(
          "正在归档 " +
            selectedChange +
            "（" +
            (index + 1) +
            "/" +
            bulkSelection.length +
            "）",
        );
        const result = await archiveOpenSpecChange(cwd, selectedChange, {
          force: forceArchive,
          skipSpecs: skipArchiveSpecs,
        });
        if (!result.success) {
          throw new Error(
            selectedChange + " 归档失败：" + commandDetail(result),
          );
        }
        recordArchive(result, selectedChange);
        setBulkSelection((current) => current.filter((name) => name !== selectedChange));
        setBulkChanges((current) => current.filter((change) => change.name !== selectedChange));
      }
      const archivedCurrent = bulkSelection.includes(changeName);
      closeBulkArchive();
      if (!archivedCurrent) await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBulkProgress("");
      setAction(null);
    }
  };

  const toggleTask = async (taskIndex: number, completed: boolean) => {
    setPendingTask(taskIndex);
    setError("");
    try {
      await setOpenSpecTaskStatus(cwd, changeName, taskIndex, completed);
      updateTaskExecution(boardKey, card.id, {
        subtasks: card.subtasks?.map((subtask, index) =>
          index === taskIndex
            ? { ...subtask, status: completed ? "completed" : "pending" }
            : subtask,
        ),
      });
      setDocumentRevision((revision) => revision + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPendingTask(null);
    }
  };

  const completeArtifacts =
    snapshot?.artifacts.filter((artifact) =>
      ["done", "skipped"].includes(artifact.status),
    ).length ?? 0;
  const tasksComplete =
    !card.subtasks?.length ||
    card.subtasks.every((subtask) => subtask.status === "completed");
  const automaticAction = resolveOpenSpecAutomaticAction(
    snapshot,
    card.subtasks ?? [],
  );
  const workspaceControlsBusy =
    active || taskBusy || workspaceActionBusy || action !== null || Boolean(interruptedAction);
  const actionAvailable = (candidate: OpenSpecWorkspaceAction): boolean => {
    if (workspaceControlsBusy || archived) return false;
    if (candidate === "explore") return true;
    if (candidate === "new") return !snapshot?.isPlanningComplete;
    if (candidate === "update") return Boolean(snapshot);
    if (candidate === "verify") {
      return Boolean(snapshot?.isPlanningComplete && tasksComplete);
    }
    if (
      (candidate === "apply" || candidate === "patch") &&
      planningReview &&
      !planningReview.acknowledged
    ) {
      return false;
    }
    return Boolean(snapshot?.isPlanningComplete);
  };
  const archiveReady =
    !!snapshot?.isPlanningComplete &&
    tasksComplete &&
    !active &&
    !taskBusy &&
    !workspaceActionBusy &&
    !interruptedAction &&
    !archived;
  const bulkHasIncomplete = bulkChanges.some(
    (change) =>
      bulkSelection.includes(change.name) &&
      change.totalTasks > 0 &&
      change.completedTasks < change.totalTasks,
  );

  const runWorkspaceAction = async (candidate: OpenSpecWorkspaceAction) => {
    setSelectedAction(candidate);
    setActivityExpanded(true);
    setError("");
    try {
      await runOpenSpecWorkspaceAction({
        boardKey,
        cwd,
        card,
        action: candidate,
        arguments: actionInput,
        status: snapshot,
      });
      setActionInput("");
      setDocumentRevision((revision) => revision + 1);
      await refresh();
    } catch (reason) {
      const latest = getOpenSpecActionSnapshot(boardKey, card.id).history.at(-1);
      if (latest?.state !== "cancelled") {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    }
  };

  const cancelWorkspaceAction = async () => {
    setError("");
    try {
      await cancelOpenSpecWorkspaceAction(boardKey, card.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const resumeWorkspaceAction = async () => {
    setActivityExpanded(true);
    setError("");
    try {
      await resumeOpenSpecWorkspaceAction({
        boardKey,
        cwd,
        card,
        status: snapshot,
      });
      setDocumentRevision((revision) => revision + 1);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const sendSessionInput = async () => {
    if (!sessionInput.trim()) return;
    setSessionInputSubmitting(true);
    setError("");
    try {
      const accepted = await sendOpenSpecSessionInput(
        boardKey,
        card.id,
        sessionInput,
      );
      if (!accepted) {
        throw new Error("当前 CLI 会话不支持追加输入");
      }
      setSessionInput("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSessionInputSubmitting(false);
    }
  };

  return (
    <div
      data-testid="openspec-workspace"
      className={cn(
        "relative flex h-full min-h-0 flex-col overflow-hidden bg-bg",
        !flush && "min-h-[500px] rounded-lg border border-border",
      )}
    >
      <header className="flex min-h-12 shrink-0 items-center gap-3 border-b border-border bg-[#21262d]/40 px-3">
        <FileCode2 size={16} className="text-accent" />
        {loading && !snapshot && <span className="text-xs text-fg-dim">正在加载 OpenSpec 工作区…</span>}
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold">
            {changeName || "OpenSpec"}
          </p>
          <p className="truncate text-[10px] text-fg-dim">
            {snapshot?.schemaName || card.openSpecSchema || "spec-driven"}
            {runtime?.version ? ` · OpenSpec ${runtime.version}` : ""}
            {runtime?.source ? ` · ${runtime.source}` : ""}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            className={actionButton}
            disabled={loading || workspaceControlsBusy || archived}
            onClick={() => void runValidation()}
          >
            {action === "validate" ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <ShieldCheck size={13} />
            )}
            严格校验
          </button>
          <button
            type="button"
            className={actionButton}
            disabled={
              !snapshot ||
              active ||
              taskBusy ||
              workspaceActionBusy ||
              action !== null ||
              archived
            }
            title={
              archiveReady
                ? "同步增量规范并归档变更"
                : "当前变更未就绪，可在确认窗口选择强制归档"
            }
            onClick={() => { setError(""); setConfirmArchive(true); }}
          >
            <Archive size={13} />
            归档
          </button>
          <button
            type="button"
            className={actionButton}
            disabled={
              !cwd ||
              active ||
              taskBusy ||
              workspaceActionBusy ||
              action !== null ||
              archived
            }
            title="选择并归档工作区中的多个 OpenSpec 变更"
            onClick={() => void openBulkArchive()}
          >
            <Archive size={13} />
            批量归档
          </button>
          <button
            type="button"
            className={actionButton}
            disabled={loading || workspaceControlsBusy}
            title="刷新 OpenSpec 状态"
            onClick={() => void refresh()}
          >
            <RefreshCw size={13} className={cn(loading && "animate-spin")} />
          </button>
        </div>
      </header>

      {archived && (
        <div className="border-b border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-xs text-emerald-300">
          {archiveResult?.specsUpdated ? "变更已同步到主规范并归档。" : "变更已归档，未更新主规范。"}
          <span className="ml-2 break-all">{archiveResult?.path}</span>
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-300"
        >
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
            {error}
          </span>
          <button type="button" title="关闭" onClick={() => setError("")}>
            <X size={13} />
          </button>
        </div>
      )}

      {interruptedAction && activeActionRun && (
        <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <RotateCcw size={14} className="shrink-0" />
          <span className="min-w-0 flex-1">
            上次“{openSpecActionLabel(activeActionRun.action)}”在应用关闭前未结束。
          </span>
          <button
            type="button"
            className={actionButton}
            onClick={() => void resumeWorkspaceAction()}
          >
            <Play size={12} />
            恢复
          </button>
          <button
            type="button"
            className={actionButton}
            onClick={() =>
              discardInterruptedOpenSpecAction(boardKey, card.id)
            }
          >
            <Trash2 size={12} />
            放弃
          </button>
        </div>
      )}

      <section
        data-testid="openspec-action-controls"
        className="shrink-0 border-b border-border bg-[#161b22]/70 px-3 py-2"
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-bg disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!actionAvailable(automaticAction)}
            onClick={() => void runWorkspaceAction(automaticAction)}
          >
            {workspaceActionBusy ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Play size={13} />
            )}
            {workspaceActionBusy && activeActionRun
              ? openSpecActionLabel(activeActionRun.action)
              : "自动执行下一步 · " + openSpecActionLabel(automaticAction)}
          </button>
          <select
            aria-label="OpenSpec 动作"
            value={selectedAction}
            disabled={workspaceControlsBusy || archived}
            onChange={(event) =>
              setSelectedAction(event.target.value as OpenSpecWorkspaceAction)
            }
            className="h-8 rounded-md border border-border bg-panel px-2 text-xs outline-none focus:border-accent"
          >
            {OPEN_SPEC_WORKSPACE_ACTIONS.map((candidate) => (
              <option key={candidate} value={candidate}>
                {openSpecActionLabel(candidate)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={actionButton}
            disabled={!actionAvailable(selectedAction)}
            onClick={() => void runWorkspaceAction(selectedAction)}
          >
            <Play size={12} />
            执行
          </button>
          <input
            aria-label="OpenSpec 动作要求"
            value={actionInput}
            disabled={workspaceControlsBusy || archived}
            onChange={(event) => setActionInput(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                actionAvailable(selectedAction)
              ) {
                event.preventDefault();
                void runWorkspaceAction(selectedAction);
              }
            }}
            placeholder="可选：输入本轮分析、规划或修订要求"
            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-bg px-2.5 text-xs outline-none placeholder:text-fg-faint focus:border-accent"
          />
          {workspaceActionBusy && (
            <button
              type="button"
              className={actionButton}
              disabled={activeActionRun?.state === "cancelling"}
              onClick={() => void cancelWorkspaceAction()}
            >
              {activeActionRun?.state === "cancelling" ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Square size={12} />
              )}
              停止
            </button>
          )}
        </div>
      </section>

      {archived && archiveResult ? (
        <div className="min-h-0 flex-1">
          <TaskWorkspaceFiles key={`${archiveResult.path}-${documentRevision}`} cwd={cwd} cardId={card.id} initialDirectory={archiveResult.path} />
        </div>
      ) : <div className="flex min-h-0 flex-1">
        <aside className="w-64 shrink-0 overflow-auto border-r border-border bg-[#21262d]/20 p-3">
          <div className="mb-3 flex items-center justify-between text-[11px] font-semibold text-fg-dim">
            <span>规范工件</span>
            <span>
              {completeArtifacts}/{snapshot?.artifacts.length || 0}
            </span>
          </div>
          <div className="space-y-1.5">
            {snapshot?.artifacts.map((artifact) => {
              const visual = artifactVisual(artifact.status);
              const Icon = visual.Icon;
              return (
                <button
                  key={artifact.id}
                  type="button"
                  className={cn(
                    "w-full rounded-lg border p-2.5 text-left transition-colors",
                    selectedArtifactId === artifact.id
                      ? "border-[#58a6ff]/50 bg-[#58a6ff]/10"
                      : "border-transparent hover:border-border hover:bg-panel-2",
                  )}
                  onClick={() => setSelectedArtifactId(artifact.id)}
                >
                  <div className="flex items-center gap-2">
                    <Icon size={14} className={visual.color} />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">
                      {artifact.id}
                    </span>
                    <span className="text-[10px] text-fg-dim">
                      {visual.label}
                    </span>
                  </div>
                  <p className="mt-1 truncate pl-5 text-[10px] text-fg-faint">
                    {artifact.outputPath || "未声明输出路径"}
                  </p>
                  {!!artifact.missingDeps.length && (
                    <p className="mt-1 pl-5 text-[10px] text-amber-400">
                      等待：{artifact.missingDeps.join("、")}
                    </p>
                  )}
                </button>
              );
            })}
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border px-3">
            <FileText size={14} className="text-fg-dim" />
            <span className="min-w-0 flex-1 truncate text-xs font-medium">
              {selectedDocument
                ? displayPath(selectedDocument, changeName)
                : selectedArtifact?.outputPath || "选择工件以查看内容"}
            </span>
            {(selectedArtifact?.documents.length ?? 0) > 1 && (
              <select
                aria-label="选择规范文件"
                value={selectedDocument}
                onChange={(event) => setSelectedDocument(event.target.value)}
                className="max-w-56 rounded border border-border bg-panel px-2 py-1 text-[10px]"
              >
                {selectedArtifact?.documents.map((document) => (
                  <option key={document} value={document}>
                    {displayPath(document, changeName)}
                  </option>
                ))}
              </select>
            )}
            <div className="flex rounded-md border border-border p-0.5 text-[10px]">
              {(["rendered", "source"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={cn(
                    "rounded px-2 py-1",
                    previewMode === mode ? "bg-panel-2 text-fg" : "text-fg-dim",
                  )}
                  onClick={() => setPreviewMode(mode)}
                >
                  {mode === "rendered" ? "预览" : "源码"}
                </button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-5">
            {loadingDocument ? (
              <div className="flex h-full items-center justify-center text-fg-dim">
                <Loader2 size={18} className="animate-spin" />
              </div>
            ) : !selectedDocument ? (
              <div className="flex h-full items-center justify-center text-center text-fg-dim">
                <div>
                  <FileText size={32} className="mx-auto mb-2 opacity-40" />
                  <p className="text-sm">
                    {selectedArtifact?.status === "ready"
                      ? "此工件已就绪，执行规范规划后会在这里显示。"
                      : "此工件尚无可预览文件。"}
                  </p>
                </div>
              </div>
            ) : previewMode === "source" ? (
              <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-6">
                {content}
              </pre>
            ) : (
              <article className="prose prose-sm max-w-none text-fg prose-headings:text-fg prose-p:text-fg prose-li:text-fg prose-strong:text-fg prose-code:text-accent">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    input: ({ type, checked }) => (
                      <input
                        type={type}
                        checked={checked}
                        readOnly
                        disabled
                        className="mr-2 accent-emerald-500 disabled:opacity-100"
                      />
                    ),
                  }}
                >
                  {content}
                </ReactMarkdown>
              </article>
            )}
          </div>
        </main>

        <aside className="w-72 shrink-0 overflow-auto border-l border-border bg-[#21262d]/10 p-3">
          <section className="rounded-lg border border-border bg-[#161b22]/60 p-3">
            <div className="flex items-center gap-2">
              {snapshot?.isPlanningComplete ? (
                <CheckCircle2 size={15} className="text-emerald-400" />
              ) : (
                <CircleDot size={15} className="text-sky-400" />
              )}
              <h3 className="text-xs font-semibold">
                {snapshot?.isPlanningComplete
                  ? "规划工件已完成"
                  : "规划工件生成中"}
              </h3>
            </div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-panel-2">
              <div
                className="h-full rounded-full bg-accent"
                style={{
                  width: `${snapshot?.artifacts.length ? Math.round((completeArtifacts / snapshot.artifacts.length) * 100) : 0}%`,
                }}
              />
            </div>
            {!!snapshot?.nextSteps.length && (
              <div className="mt-3 space-y-1 text-[11px] leading-5 text-fg-dim">
                {snapshot.nextSteps.map((step) => (
                  <p key={step}>• {step}</p>
                ))}
              </div>
            )}
          </section>

          <section className="mt-3 rounded-lg border border-border bg-[#161b22]/60 p-3">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold">实施任务</h3>
              <span className="text-[10px] text-fg-dim">
                {card.subtasks?.filter((task) => task.status === "completed")
                  .length || 0}
                /{card.subtasks?.length || 0}
              </span>
            </div>
            <div className="space-y-2">
              {card.subtasks?.map((subtask, index) => (
                <label
                  key={subtask.id}
                  className="flex items-start gap-2 rounded border border-[#30363d]/70 bg-bg/60 p-2 text-[11px] leading-4"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-emerald-500"
                    checked={subtask.status === "completed"}
                    disabled={active || taskBusy || pendingTask !== null}
                    onChange={(event) =>
                      void toggleTask(index, event.target.checked)
                    }
                  />
                  <span
                    className={cn(
                      "min-w-0 flex-1",
                      subtask.status === "completed" &&
                        "text-fg-dim line-through",
                    )}
                  >
                    {subtask.title}
                  </span>
                  {pendingTask === index && (
                    <Loader2 size={12} className="animate-spin text-fg-dim" />
                  )}
                </label>
              ))}
              {!card.subtasks?.length && (
                <p className="py-3 text-center text-[11px] text-fg-dim">
                  tasks.md 生成后将在此显示。
                </p>
              )}
            </div>
          </section>

          {planningReview && (
            <section
              className={cn(
                "mt-3 rounded-lg border p-3",
                planningReview.acknowledged
                  ? "border-emerald-500/25 bg-emerald-500/5"
                  : "border-amber-500/30 bg-amber-500/5",
              )}
            >
              <div className="flex items-center gap-2">
                {planningReview.acknowledged ? (
                  <CheckCircle2 size={14} className="text-emerald-400" />
                ) : (
                  <AlertCircle size={14} className="text-amber-400" />
                )}
                <h3 className="text-xs font-semibold">规划改动审阅</h3>
                <span className="ml-auto text-[10px] text-fg-dim">
                  {planningReview.files.length} 个文件
                </span>
              </div>
              <p className="mt-2 text-[10px] leading-4 text-fg-dim">
                {planningReview.acknowledged
                  ? "本轮规划改动已确认，可以进入实施。"
                  : "确认 proposal、spec、design 与 tasks 的差异后才能实施。"}
              </p>
              <button
                type="button"
                className={cn(actionButton, "mt-2 w-full")}
                onClick={() => setPlanningReviewOpen(true)}
              >
                <FileCode2 size={12} />
                {planningReview.acknowledged ? "重新查看差异" : "审阅差异"}
              </button>
            </section>
          )}

          {validation && (
            <section
              className={cn(
                "mt-3 rounded-lg border p-3",
                validation.success
                  ? "border-emerald-500/30 bg-emerald-500/5"
                  : "border-red-500/30 bg-red-500/5",
              )}
            >
              <div className="flex items-center gap-2 text-xs font-semibold">
                {validation.success ? (
                  <CheckCircle2 size={14} className="text-emerald-400" />
                ) : (
                  <AlertCircle size={14} className="text-red-400" />
                )}
                {validation.success ? "严格校验通过" : "严格校验未通过"}
              </div>
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-4 text-fg-dim">
                {commandDetail(validation)}
              </pre>
            </section>
          )}
        </aside>
      </div>

      }
      <section className="shrink-0 border-t border-border bg-[#0d1117]">
        <div className="flex h-9 items-center gap-2 border-b border-border/70 px-3">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-fg-dim hover:text-fg"
            onClick={() => setActivityExpanded((value) => !value)}
          >
            <History size={13} />
            活动与历史
          </button>
          {!!activityRuns.length && (
            <select
              aria-label="OpenSpec 活动历史"
              value={displayedRun?.id || ""}
              onChange={(event) => setSelectedRunId(event.target.value)}
              className="h-6 max-w-72 rounded border border-border bg-panel px-1.5 text-[10px] outline-none"
            >
              {activityRuns.map((run) => (
                <option key={run.id} value={run.id}>
                  {new Date(run.startedAt).toLocaleTimeString()} ·{" "}
                  {run.label}
                </option>
              ))}
            </select>
          )}
          {displayedRun && (
            <span
              className={cn(
                "rounded-full border px-2 py-0.5 text-[10px]",
                displayedRun.state === "succeeded"
                  ? "border-emerald-500/30 text-emerald-300"
                  : displayedRun.state === "failed"
                    ? "border-red-500/30 text-red-300"
                    : displayedRun.state === "cancelled"
                      ? "border-border text-fg-dim"
                      : "border-amber-500/30 text-amber-300",
              )}
            >
              {
                {
                  running: "执行中",
                  cancelling: "正在停止",
                  interrupted: "已中断",
                  succeeded: "已完成",
                  failed: "失败",
                  cancelled: "已取消",
                }[displayedRun.state]
              }
            </span>
          )}
          <span className="ml-auto text-[10px] text-fg-faint">
            CLI 流式输出
          </span>
          <button
            type="button"
            className="text-[10px] text-fg-dim hover:text-fg"
            onClick={() => setActivityExpanded((value) => !value)}
          >
            {activityExpanded ? "收起" : "展开"}
          </button>
        </div>
        {activityExpanded && (
          <div className="flex h-48 flex-col">
            <div
              ref={activityOutputRef}
              data-testid="openspec-activity-output"
              className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-5 text-[#c9d1d9]"
            >
              {displayedRun?.output ? <RuntimeOutput source={displayedRun.output} /> :
                displayedRun?.state === "running" ? "正在等待模型输出…" :
                card.executionError || "启动任务或选择动作后，这里会显示实时输出和历史记录。"}
            </div>
            {activeActionRun?.state === "running" &&
              (activeActionRun.action === "apply" ||
                activeActionRun.action === "patch") && (
                <div className="flex shrink-0 items-center gap-2 border-t border-border/70 px-3 py-2">
                  <input
                    aria-label="向 OpenSpec 活跃会话发送输入"
                    value={sessionInput}
                    disabled={sessionInputSubmitting}
                    onChange={(event) => setSessionInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void sendSessionInput();
                      }
                    }}
                    placeholder="向当前实施会话补充要求"
                    className="h-7 min-w-0 flex-1 rounded border border-border bg-bg px-2 text-[11px] outline-none focus:border-accent"
                  />
                  <button
                    type="button"
                    className={actionButton}
                    disabled={
                      sessionInputSubmitting || !sessionInput.trim()
                    }
                    onClick={() => void sendSessionInput()}
                  >
                    {sessionInputSubmitting ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Send size={12} />
                    )}
                    发送
                  </button>
                </div>
              )}
          </div>
        )}
      </section>

      {planningReviewOpen && planningReview && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/70 p-5">
          <div
            role="dialog"
            aria-label="OpenSpec 规划改动审阅"
            className="flex h-[78%] min-h-96 w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-border bg-panel shadow-2xl"
          >
            <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
              <FileCode2 size={16} className="text-accent" />
              <div>
                <h3 className="text-sm font-semibold">规划改动审阅</h3>
                <p className="text-[10px] text-fg-dim">
                  {openSpecActionLabel(planningReview.action)} ·{" "}
                  {planningReview.files.length} 个 OpenSpec 文件
                </p>
              </div>
              <button
                type="button"
                title="关闭"
                className="ml-auto rounded p-1.5 text-fg-dim hover:bg-panel-2 hover:text-fg"
                onClick={() => setPlanningReviewOpen(false)}
              >
                <X size={15} />
              </button>
            </header>
            <div className="flex min-h-0 flex-1">
              <aside className="w-64 shrink-0 overflow-auto border-r border-border bg-bg/50 p-2">
                {planningReview.files.map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    className={cn(
                      "mb-1 w-full rounded-md border px-2.5 py-2 text-left",
                      selectedReviewFile?.path === file.path
                        ? "border-accent/50 bg-accent/10"
                        : "border-transparent hover:border-border hover:bg-panel-2",
                    )}
                    onClick={() => setSelectedReviewPath(file.path)}
                  >
                    <span className="block truncate text-xs font-medium">
                      {file.path.replace(/\\/g, "/").split("/").at(-1)}
                    </span>
                    <span className="mt-0.5 block truncate text-[10px] text-fg-dim">
                      {file.path.replace(/\\/g, "/")}
                    </span>
                  </button>
                ))}
              </aside>
              <main className="min-w-0 flex-1 overflow-auto bg-[#0d1117]">
                <div className="sticky top-0 z-10 border-b border-border bg-[#161b22] px-3 py-2 text-xs font-medium">
                  {selectedReviewFile?.path || "规划差异"}
                </div>
                <PlanningReviewDiff file={selectedReviewFile} />
              </main>
            </div>
            <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-3">
              <button
                type="button"
                className={actionButton}
                onClick={() => setPlanningReviewOpen(false)}
              >
                稍后处理
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-bg"
                onClick={() => {
                  acknowledgeOpenSpecPlanningReview(boardKey, card.id);
                  updateTaskExecution(boardKey, card.id, { planApproved: true });
                  requeueTask(boardKey, card.id);
                  setPlanningReviewOpen(false);
                }}
                disabled={planningReview.acknowledged || active || taskBusy || workspaceActionBusy}
              >
                <CheckCircle2 size={13} />
                {planningReview.acknowledged ? "已确认" : "确认规划并继续"}
              </button>
            </footer>
          </div>
        </div>
      )}

      {bulkArchiveOpen && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/70 p-5">
          <div
            role="alertdialog"
            aria-label="批量归档 OpenSpec 变更"
            className="flex max-h-[82%] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-panel shadow-2xl"
          >
            <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
              <Archive size={16} className="text-accent" />
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold">批量归档 OpenSpec 变更</h3>
                <p className="truncate text-[10px] text-fg-dim">
                  选择同一工作区内需要归档的变更
                </p>
              </div>
              <button
                type="button"
                title="关闭"
                className="rounded p-1.5 text-fg-dim hover:bg-panel-2 hover:text-fg disabled:opacity-40"
                disabled={action !== null}
                onClick={closeBulkArchive}
              >
                <X size={15} />
              </button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {bulkArchiveLoading ? (
                <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-fg-dim">
                  <Loader2 size={16} className="animate-spin" />
                  正在读取 OpenSpec 变更…
                </div>
              ) : bulkChanges.length === 0 ? (
                <div className="flex min-h-40 items-center justify-center rounded-lg border border-dashed border-border text-sm text-fg-dim">
                  当前工作区没有可归档的 OpenSpec 变更
                </div>
              ) : (
                <>
                  <div className="mb-2 flex items-center justify-between text-xs">
                    <label className="flex cursor-pointer items-center gap-2 font-medium">
                      <input
                        type="checkbox"
                        aria-label="选择全部 OpenSpec 变更"
                        className="accent-accent"
                        checked={
                          bulkChanges.length > 0 &&
                          bulkSelection.length === bulkChanges.length
                        }
                        disabled={action !== null}
                        onChange={(event) =>
                          setBulkSelection(
                            event.target.checked
                              ? bulkChanges.map((change) => change.name)
                              : [],
                          )
                        }
                      />
                      全选
                    </label>
                    <span className="text-fg-dim">
                      已选择 {bulkSelection.length}/{bulkChanges.length}
                    </span>
                  </div>

                  <div className="max-h-60 space-y-1.5 overflow-y-auto rounded-lg border border-border bg-bg/40 p-2">
                    {bulkChanges.map((change) => {
                      const incomplete =
                        change.totalTasks > 0 &&
                        change.completedTasks < change.totalTasks;
                      const selected = bulkSelection.includes(change.name);
                      return (
                        <label
                          key={change.name}
                          className={cn(
                            "flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 transition-colors",
                            selected
                              ? "border-accent/40 bg-accent/10"
                              : "border-transparent hover:border-border hover:bg-panel-2",
                          )}
                        >
                          <input
                            type="checkbox"
                            aria-label={`选择 ${change.name}`}
                            className="shrink-0 accent-accent"
                            checked={selected}
                            disabled={action !== null}
                            onChange={(event) =>
                              setBulkSelection((current) =>
                                event.target.checked
                                  ? current.includes(change.name)
                                    ? current
                                    : [...current, change.name]
                                  : current.filter(
                                      (selectedName) =>
                                        selectedName !== change.name,
                                    ),
                              )
                            }
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex min-w-0 items-center gap-2">
                              <span className="truncate font-mono text-xs font-medium">
                                {change.name}
                              </span>
                              <span
                                className={cn(
                                  "shrink-0 rounded border px-1.5 py-0.5 text-[9px] uppercase",
                                  incomplete
                                    ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
                                    : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
                                )}
                              >
                                {change.status}
                              </span>
                            </span>
                            <span className="mt-1 flex items-center gap-2 text-[10px] text-fg-dim">
                              <span>
                                {change.totalTasks > 0
                                  ? `${change.completedTasks}/${change.totalTasks} 个任务`
                                  : "无任务"}
                              </span>
                              <span>·</span>
                              <span>{formatOpenSpecModified(change.lastModified)}</span>
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>

                  <label className="mt-3 flex items-start gap-2 rounded-lg border border-border bg-bg/50 p-3 text-xs">
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-amber-500"
                      checked={forceArchive}
                      disabled={action !== null}
                      onChange={(event) => setForceArchive(event.target.checked)}
                    />
                    <span>
                      <strong className="block text-amber-300">强制归档</strong>
                      <span className="mt-1 block leading-5 text-fg-dim">
                        使用 --no-validate 跳过校验。选中未完成变更时必须启用。
                      </span>
                    </span>
                  </label>
                  <label className="mt-2 flex items-start gap-2 rounded-lg border border-border bg-bg/50 p-3 text-xs">
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-accent"
                      checked={skipArchiveSpecs}
                      disabled={action !== null}
                      onChange={(event) =>
                        setSkipArchiveSpecs(event.target.checked)
                      }
                    />
                    <span>
                      <strong className="block">跳过主规范同步</strong>
                      <span className="mt-1 block leading-5 text-fg-dim">
                        使用 --skip-specs，仅移动选中的变更目录。
                      </span>
                    </span>
                  </label>

                  {bulkHasIncomplete && !forceArchive && (
                    <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
                      <AlertCircle size={14} className="mt-0.5 shrink-0" />
                      选中的变更包含未完成任务，请启用强制归档后继续。
                    </div>
                  )}
                  {bulkProgress && (
                    <div className="mt-3 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/10 p-3 text-xs text-accent">
                      <Loader2 size={14} className="animate-spin" />
                      {bulkProgress}
                    </div>
                  )}
                  {error && (
                    <div
                      role="alert"
                      className="mt-3 whitespace-pre-wrap rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300"
                    >
                      {error}
                    </div>
                  )}
                </>
              )}
            </div>

            <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-4 py-3">
              <span className="text-[10px] text-fg-dim">
                请选择需要归档的变更；已成功项不会重复执行
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className={actionButton}
                  disabled={action !== null}
                  onClick={closeBulkArchive}
                >
                  取消
                </button>
                <button
                  type="button"
                  className={`${actionButton} bg-accent text-bg`}
                  disabled={
                    bulkArchiveLoading ||
                    action !== null ||
                    bulkSelection.length === 0 ||
                    (bulkHasIncomplete && !forceArchive)
                  }
                  onClick={() => void runBulkArchive()}
                >
                  {action === "archive" && (
                    <Loader2 size={13} className="animate-spin" />
                  )}
                  归档 {bulkSelection.length} 个变更
                </button>
              </div>
            </footer>
          </div>
        </div>
      )}

      {confirmArchive && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/65 p-6">
          <div
            role="alertdialog"
            aria-label="归档 OpenSpec 变更"
            className="w-full max-w-md rounded-xl border border-border bg-panel p-5 shadow-2xl"
          >
            <h3 className="text-base font-semibold">归档 OpenSpec 变更</h3>
            {error && <div role="alert" className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">{error}</div>}
            <p className="mt-3 text-sm leading-6 text-fg-dim">
              {forceArchive
                ? "将跳过校验并强制归档“" + changeName + "”。"
                : "将先运行严格校验，再把“" +
                  changeName +
                  "”的增量规范同步到主规范并归档。"}
            </p>
            <label className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-bg/50 p-3 text-xs">
              <input
                type="checkbox"
                className="mt-0.5 accent-amber-500"
                checked={forceArchive}
                disabled={action !== null}
                onChange={(event) => setForceArchive(event.target.checked)}
              />
              <span>
                <strong className="block text-amber-300">强制归档</strong>
                <span className="mt-1 block leading-5 text-fg-dim">
                  使用 OpenSpec --no-validate 跳过校验。仅用于已知校验问题且仍需归档的变更。
                </span>
              </span>
            </label>
            <label className="mt-2 flex items-start gap-2 rounded-lg border border-border bg-bg/50 p-3 text-xs">
              <input
                type="checkbox"
                className="mt-0.5 accent-accent"
                checked={skipArchiveSpecs}
                disabled={action !== null}
                onChange={(event) => setSkipArchiveSpecs(event.target.checked)}
              />
              <span>
                <strong className="block">跳过主规范同步</strong>
                <span className="mt-1 block leading-5 text-fg-dim">
                  使用 --skip-specs，仅移动变更目录。
                </span>
              </span>
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className={actionButton}
                disabled={action !== null}
                onClick={() => {
                  setConfirmArchive(false);
                  setForceArchive(false);
                  setSkipArchiveSpecs(false);
                }}
              >
                取消
              </button>
              <button
                type="button"
                className={`${actionButton} bg-accent text-bg`}
                disabled={
                  action !== null || (!archiveReady && !forceArchive)
                }
                onClick={() => void runArchive()}
              >
                {action === "archive" && (
                  <Loader2 size={13} className="animate-spin" />
                )}
                {forceArchive ? "强制归档" : "校验并归档"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
