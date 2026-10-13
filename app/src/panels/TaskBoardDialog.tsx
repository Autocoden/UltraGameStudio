import { useEffect, useMemo, useRef, useState } from "react";
import {
  Camera,
  ChevronDown,
  ChevronUp,
  FileCode2,
  FileText,
  Folder,
  FolderTree,
  GitBranch,
  Image as ImageIcon,
  Info,
  ListChecks,
  Loader2,
  Paperclip,
  Sparkles,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/cn";
import TaskWorkspaceFiles from "./TaskWorkspaceFiles";
import { t, type Locale } from "@/lib/i18n";
import {
  TASK_CATEGORIES,
  TASK_COMPLEXITIES,
  TASK_IMPACTS,
  TASK_MAX_REFERENCE_IMAGES,
  TASK_PRIORITIES,
  type TaskCard,
  type TaskMeta,
  type TaskModelSelection,
  type TaskReferenceImage,
  type TaskStatus,
} from "@/lib/taskBoard";
import {
  DEFAULT_TASK_PHASE_THINKING,
  taskModelSelectionFromGateway,
} from "@/lib/taskAgentProfiles";
import TaskAgentProfileSelector, {
  type TaskModelOption,
} from "./TaskAgentProfileSelector";
import {
  readLocalFileForUpload,
  saveClipboardImage,
  previewLocalFile,
  getTaskGitOverview,
  listWorkspaceDirectory,
  type TaskGitOverview,
  type WorkspaceTreeEntry,
} from "@/lib/tauri";
import {
  getDefaultGatewaySelection,
  getExplicitActiveGatewaySelection,
  loadGatewayConfig,
} from "@/lib/gatewayConfig";
import {
  completeGatewayText,
  resolveCliGatewayRoute,
} from "@/lib/modelGateway/modelGateway";
import {
  fileMentionInsertText,
  filterFileMentionEntries,
  findFileMentionTrigger,
  type FileMentionTrigger,
} from "./aidock/fileMentions";

/**
 * CONTRACT: controlled create/edit dialog for the 任务看板, mirroring
 * Autocode's TaskCreationWizard form section: description (required), optional title,
 * and the 2×2 classification grid (category/priority/complexity/impact — all
 * optional, aligned with Autocode's ClassificationFields and zh labels).
 *
 * `mode: 'create'` starts a card in the given status; `mode: 'edit'` prefills
 * from the card. Cancel/Esc preserves the draft without creating a task.
 * An empty title is derived from the first line of the description.
 */
export interface TaskBoardDialogRequest {
  mode: "create" | "edit";
  status: TaskStatus;
  card?: TaskCard;
}

export default function TaskBoardDialog({
  locale,
  request,
  onClose,
  onSubmit,
  boardKey = "default",
  cwd = "",
}: {
  locale: Locale;
  request: TaskBoardDialogRequest;
  onClose: () => void;
  onSubmit: (values: {
    title: string;
    note: string;
    meta: TaskMeta;
    start?: boolean;
  }) => boolean;
  boardKey?: string;
  cwd?: string;
}) {
  const editing = request.mode === "edit" ? request.card : undefined;
  const [draft] = useState(() => {
    try {
      return editing
        ? null
        : (JSON.parse(
            localStorage.getItem(`ugs.board.draft.${boardKey}`) || "null",
          ) as { title: string; note: string; meta: TaskMeta } | null);
    } catch {
      return null;
    }
  });
  const [title, setTitle] = useState(editing?.title ?? draft?.title ?? "");
  const [note, setNote] = useState(editing?.note ?? draft?.note ?? "");
  const [browseFiles, setBrowseFiles] = useState(false);
  const [meta, setMeta] = useState<TaskMeta>(() => ({
    category: editing?.category ?? draft?.meta?.category,
    priority: editing?.priority ?? draft?.meta?.priority,
    complexity: editing?.complexity ?? draft?.meta?.complexity,
    impact: editing?.impact ?? draft?.meta?.impact,
    developmentMode:
      editing?.developmentMode || draft?.meta?.developmentMode || "standard",
    requireReviewBeforeCoding:
      editing?.requireReviewBeforeCoding ??
      draft?.meta?.requireReviewBeforeCoding ??
      false,
    useWorktree: editing?.useWorktree ?? draft?.meta?.useWorktree ?? false,
    baseBranch: editing?.baseBranch ?? draft?.meta?.baseBranch ?? "",
    pushNewBranches:
      editing?.pushNewBranches ?? draft?.meta?.pushNewBranches ?? false,
    model: editing?.model || draft?.meta?.model || "",
    reviewModel: editing?.reviewModel || draft?.meta?.reviewModel || "",
    agentProfile: editing?.agentProfile ?? draft?.meta?.agentProfile ?? "auto",
    thinkingLevel:
      editing?.thinkingLevel ?? draft?.meta?.thinkingLevel ?? "medium",
    phaseThinking:
      editing?.phaseThinking ??
      draft?.meta?.phaseThinking ??
      DEFAULT_TASK_PHASE_THINKING,
    modelSelection: editing?.modelSelection ?? draft?.meta?.modelSelection,
    specModelSelection:
      editing?.specModelSelection ?? draft?.meta?.specModelSelection,
    planningModelSelection:
      editing?.planningModelSelection ?? draft?.meta?.planningModelSelection,
    reviewModelSelection:
      editing?.reviewModelSelection ?? draft?.meta?.reviewModelSelection,
    referenceImages:
      editing?.referenceImages ?? draft?.meta?.referenceImages ?? [],
    openSpecChange:
      editing?.openSpecChange ?? draft?.meta?.openSpecChange ?? "",
    openSpecSchema:
      editing?.openSpecSchema ?? draft?.meta?.openSpecSchema ?? "spec-driven",
  }));
  const [error, setError] = useState(false);
  const [imageError, setImageError] = useState("");
  const [savingImages, setSavingImages] = useState(false);
  const [showImages, setShowImages] = useState(
    () =>
      (editing?.referenceImages?.length ??
        draft?.meta?.referenceImages?.length ??
        0) > 0,
  );
  const [showClassification, setShowClassification] = useState(() =>
    Boolean(
      editing?.category ||
      editing?.priority ||
      editing?.complexity ||
      editing?.impact ||
      draft?.meta?.category ||
      draft?.meta?.priority ||
      draft?.meta?.complexity ||
      draft?.meta?.impact,
    ),
  );
  const [showGitOptions, setShowGitOptions] = useState(() =>
    Boolean(
      editing?.useWorktree ||
      editing?.baseBranch ||
      draft?.meta?.useWorktree ||
      draft?.meta?.baseBranch,
    ),
  );
  const [improving, setImproving] = useState(false);
  const [gatewayRevision, setGatewayRevision] = useState(0);
  const [gitOverview, setGitOverview] = useState<TaskGitOverview | null>(null);
  const [gitOverviewLoading, setGitOverviewLoading] = useState(false);
  const [fileMentionTrigger, setFileMentionTrigger] =
    useState<FileMentionTrigger | null>(null);
  const [fileMentionEntries, setFileMentionEntries] = useState<
    WorkspaceTreeEntry[]
  >([]);
  const [fileMentionLoading, setFileMentionLoading] = useState(false);
  const [fileMentionError, setFileMentionError] = useState("");
  const [activeFileMentionIndex, setActiveFileMentionIndex] = useState(0);
  const titleRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!editing) {
      try {
        localStorage.setItem(
          `ugs.board.draft.${boardKey}`,
          JSON.stringify({ title, note, meta }),
        );
      } catch {
        /* session draft */
      }
    }
  }, [boardKey, editing, title, note, meta]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    noteRef.current?.focus();
    return () => previous?.focus();
  }, []);

  useEffect(() => {
    const refresh = () => setGatewayRevision((value) => value + 1);
    window.addEventListener("ugs:gateway-config-changed", refresh);
    return () =>
      window.removeEventListener("ugs:gateway-config-changed", refresh);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!cwd) return;
    setGitOverviewLoading(true);
    void getTaskGitOverview(cwd)
      .then((overview) => {
        if (cancelled) return;
        setGitOverview(overview);
        setMeta((current) =>
          current.useWorktree && !current.baseBranch && overview.defaultBranch
            ? { ...current, baseBranch: overview.defaultBranch }
            : current,
        );
      })
      .catch(() => {
        if (!cancelled) setGitOverview(null);
      })
      .finally(() => {
        if (!cancelled) setGitOverviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  const modelOptions = useMemo<TaskModelOption[]>(() => {
    void gatewayRevision;
    return loadGatewayConfig().providers.flatMap((provider) =>
      provider.channels.map((channel) => {
        const model = channel.model || channel.route.model || "";
        return {
          key: `${provider.id}\u0000${channel.id}`,
          label: `${provider.name} · ${channel.name}${model ? ` · ${model}` : ""}`,
          selection: {
            adapter: provider.adapter,
            modelClass: getDefaultGatewaySelection().modelClass,
            providerId: provider.id,
            channelId: channel.id,
            ...(model ? { modelOverride: model } : {}),
            label: `${provider.name} · ${channel.name}`,
          } satisfies TaskModelSelection,
        };
      }),
    );
  }, [gatewayRevision]);

  const activeTaskModelSelection = useMemo(
    () =>
      taskModelSelectionFromGateway(
        getExplicitActiveGatewaySelection() ?? getDefaultGatewaySelection(),
      ),
    [gatewayRevision],
  );

  const fileMentionOptions = useMemo(
    () =>
      fileMentionTrigger
        ? filterFileMentionEntries(fileMentionEntries, fileMentionTrigger.query)
        : [],
    [fileMentionEntries, fileMentionTrigger],
  );
  const fileMentionOpen =
    fileMentionTrigger !== null &&
    (fileMentionLoading || !!fileMentionError || fileMentionOptions.length > 0);

  useEffect(() => {
    if (!fileMentionTrigger) {
      setFileMentionEntries([]);
      setFileMentionLoading(false);
      setFileMentionError("");
      return;
    }
    if (!cwd) {
      setFileMentionEntries([]);
      setFileMentionLoading(false);
      setFileMentionError("请先打开项目后再引用文件");
      return;
    }

    let cancelled = false;
    setFileMentionLoading(true);
    setFileMentionError("");
    void listWorkspaceDirectory(cwd, fileMentionTrigger.directory)
      .then((listing) => {
        if (cancelled) return;
        setFileMentionEntries(listing.entries);
        setActiveFileMentionIndex(0);
      })
      .catch((reason) => {
        if (cancelled) return;
        setFileMentionEntries([]);
        setFileMentionError(
          reason instanceof Error && reason.message === "NO_BACKEND"
            ? "当前浏览器模式不能读取本机文件，请使用桌面端"
            : reason instanceof Error
              ? reason.message
              : String(reason),
        );
      })
      .finally(() => {
        if (!cancelled) setFileMentionLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, fileMentionTrigger?.directory]);

  useEffect(() => {
    if (activeFileMentionIndex < fileMentionOptions.length) return;
    setActiveFileMentionIndex(0);
  }, [activeFileMentionIndex, fileMentionOptions.length]);

  const refreshFileMention = (value: string, caret: number | null) => {
    setFileMentionTrigger(findFileMentionTrigger(value, caret ?? value.length));
    setActiveFileMentionIndex(0);
  };

  const applyFileMention = (entry: WorkspaceTreeEntry) => {
    if (!fileMentionTrigger) return;
    const inserted = fileMentionInsertText(entry);
    const next =
      note.slice(0, fileMentionTrigger.start) +
      inserted +
      note.slice(fileMentionTrigger.end);
    const caret = fileMentionTrigger.start + inserted.length;
    setNote(next);
    setError(false);
    if (entry.kind === "directory") {
      setFileMentionTrigger(findFileMentionTrigger(next, caret));
      setActiveFileMentionIndex(0);
    } else {
      setFileMentionTrigger(null);
    }
    queueMicrotask(() => {
      noteRef.current?.focus();
      noteRef.current?.setSelectionRange(caret, caret);
    });
  };

  const saveImageFiles = async (files: File[]) => {
    const existing = meta.referenceImages ?? [];
    const available = Math.max(
      0,
      TASK_MAX_REFERENCE_IMAGES - existing.length,
    );
    const candidates = files
      .filter((file) => file.type.startsWith("image/"))
      .slice(0, available);
    if (!candidates.length) {
      setImageError(
        available
          ? "请选择图片文件"
          : `最多添加 ${TASK_MAX_REFERENCE_IMAGES} 张参考图片`,
      );
      return;
    }
    setSavingImages(true);
    setImageError("");
    try {
      const saved = await Promise.all(
        candidates.map(async (file): Promise<TaskReferenceImage> => ({
          id:
            typeof crypto !== "undefined" &&
            typeof crypto.randomUUID === "function"
              ? crypto.randomUUID()
              : `${Date.now()}-${Math.random()}`,
          path: await saveClipboardImage({
            bytesBase64: bytesToBase64(
              new Uint8Array(await file.arrayBuffer()),
            ),
            mime: file.type || "image/png",
            fileName: file.name || null,
            cwd: cwd || null,
          }),
          fileName: file.name || "image.png",
          mime: file.type || "image/png",
        })),
      );
      setMeta((current) => ({
        ...current,
        referenceImages: [...(current.referenceImages ?? []), ...saved].slice(
          0,
          TASK_MAX_REFERENCE_IMAGES,
        ),
      }));
      setShowImages(true);
    } catch (reason) {
      setImageError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSavingImages(false);
    }
  };

  const pickImages = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        title: "选择参考图片",
        directory: false,
        multiple: true,
        filters: [
          { name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif"] },
        ],
      });
      const paths = picked
        ? Array.isArray(picked)
          ? picked.map(String)
          : [String(picked)]
        : [];
      if (!paths.length) return;
      setSavingImages(true);
      const files = await Promise.all(
        paths.map(async (path) => {
          const payload = await readLocalFileForUpload(path);
          return new File(
            [base64ToArrayBuffer(payload.bytesBase64)],
            payload.fileName,
            {
              type: payload.mime || "image/png",
            },
          );
        }),
      );
      setSavingImages(false);
      await saveImageFiles(files);
    } catch (reason) {
      setSavingImages(false);
      setImageError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const captureScreen = async () => {
    try {
      if (!navigator.mediaDevices?.getDisplayMedia)
        throw new Error("当前 WebView 不支持屏幕捕获");
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
      try {
        const video = document.createElement("video");
        video.srcObject = stream;
        await video.play();
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext("2d")?.drawImage(video, 0, 0);
        const blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (value) =>
              value ? resolve(value) : reject(new Error("截屏编码失败")),
            "image/png",
          ),
        );
        await saveImageFiles([
          new File([blob], `screenshot-${Date.now()}.png`, {
            type: "image/png",
          }),
        ]);
      } finally {
        stream.getTracks().forEach((track) => track.stop());
      }
    } catch (reason) {
      setImageError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const improveDescription = async () => {
    if (!note.trim() || improving) return;
    setImproving(true);
    setImageError("");
    try {
      const active = meta.modelSelection
        ? {
            ...(getExplicitActiveGatewaySelection() ??
              getDefaultGatewaySelection()),
            ...meta.modelSelection,
          }
        : (getExplicitActiveGatewaySelection() ?? getDefaultGatewaySelection());
      const route = await resolveCliGatewayRoute(active);
      const improved = await completeGatewayText({
        route,
        system:
          "你是任务描述编辑器。保留用户意图和所有约束，把描述改写为清晰、可执行、可验收的开发任务。只输出改写后的描述，不添加解释。",
        userContent: note.trim(),
        cwd,
        permission: "readonly",
        forceCli: true,
        runId: `task-description-${Date.now()}`,
      });
      if (improved.trim()) setNote(improved.trim());
    } catch (reason) {
      setImageError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setImproving(false);
    }
  };

  const setMetaValue = (key: keyof TaskMeta, raw: string) => {
    setMeta((prev) => ({
      ...prev,
      [key]: raw === "" ? undefined : (raw as never),
    }));
  };

  const submit = (start = false) => {
    if (!note.trim()) {
      setError(true);
      return;
    }
    const resolvedTitle =
      title.trim() || note.trim().split("\n")[0].slice(0, 80);
    if (onSubmit({ title: resolvedTitle, note: note.trim(), meta, start })) {
      if (!editing) {
        try {
          localStorage.removeItem(`ugs.board.draft.${boardKey}`);
        } catch {
          /* unavailable */
        }
      }
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
        if (event.key === "Tab") {
          const controls = dialogRef.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary",
          );
          if (!controls?.length) return;
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
      }}
    >
      <div
        role="dialog"
        ref={dialogRef}
        aria-modal="true"
        aria-label={t(
          locale,
          editing ? "board.dialog.editTitle" : "board.dialog.createTitle",
        )}
        className="fixed left-1/2 top-4 flex h-[calc(100vh-32px)] w-[95vw] max-w-5xl -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-panel text-fg shadow-2xl"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-6 py-5">
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-semibold leading-tight text-fg">
              {locale === "zh-CN"
                ? editing
                  ? "编辑任务"
                  : "创建新任务"
                : editing
                  ? "Edit task"
                  : "Create new task"}
            </h2>
            <p className="mt-1.5 text-sm text-fg-dim">
              {locale === "zh-CN"
                ? editing
                  ? "更新任务的描述、配置和执行方式。"
                  : "描述您想构建的内容。AI 将分析您的请求并创建详细的规范。"
                : editing
                  ? "Update the task description, configuration, and execution mode."
                  : "Describe what you want to build. AI will analyze your request and create a detailed specification."}
            </p>
          </div>
          <button
            type="button"
            title={t(locale, "board.edit.cancel")}
            aria-label={t(locale, "board.edit.cancel")}
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-fg-dim transition-colors hover:bg-border-soft hover:text-fg"
          >
            <X size={20} aria-hidden />
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-6">
            {!editing && (
              <div className="flex items-start gap-3 rounded-lg border border-[#58a6ff]/30 bg-[#58a6ff]/10 p-4">
                <Info
                  size={20}
                  className="mt-0.5 shrink-0 text-accent"
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <h3 className="mb-1 text-sm font-medium text-fg">
                    当前工作区
                  </h3>
                  <p className="text-sm text-fg-dim">
                    默认直接在当前检出的 Git 工作区中开发。只有需要单独的
                    worktree 分支时，才在 Git 选项中开启隔离工作区。
                  </p>
                </div>
              </div>
            )}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <label
                  htmlFor="task-dialog-note"
                  className="text-sm font-medium text-fg"
                >
                  {t(locale, "board.dialog.fieldDescription")}{" "}
                  <span className="text-red-400">*</span>
                </label>
                <button
                  type="button"
                  disabled={!note.trim() || improving}
                  onClick={() => void improveDescription()}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-fg-dim hover:bg-border-soft hover:text-fg disabled:opacity-40"
                >
                  {improving ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <Sparkles size={13} />
                  )}
                  使用 AI 优化
                </button>
              </div>
              <div className="relative">
                <textarea
                  id="task-dialog-note"
                  ref={noteRef}
                  aria-required="true"
                  aria-invalid={error}
                  aria-expanded={fileMentionOpen}
                  aria-controls={
                    fileMentionOpen
                      ? "task-dialog-file-mention-suggestions"
                      : undefined
                  }
                  aria-activedescendant={
                    fileMentionOptions.length
                      ? `task-dialog-file-mention-${activeFileMentionIndex}`
                      : undefined
                  }
                  value={note}
                  onChange={(event) => {
                    setNote(event.target.value);
                    setError(false);
                    refreshFileMention(
                      event.target.value,
                      event.target.selectionStart,
                    );
                  }}
                  onKeyDown={(event) => {
                    if (!fileMentionOpen) return;
                    if (
                      event.key === "ArrowDown" &&
                      fileMentionOptions.length
                    ) {
                      event.preventDefault();
                      event.stopPropagation();
                      setActiveFileMentionIndex(
                        (index) => (index + 1) % fileMentionOptions.length,
                      );
                      return;
                    }
                    if (event.key === "ArrowUp" && fileMentionOptions.length) {
                      event.preventDefault();
                      event.stopPropagation();
                      setActiveFileMentionIndex(
                        (index) =>
                          (index - 1 + fileMentionOptions.length) %
                          fileMentionOptions.length,
                      );
                      return;
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      setFileMentionTrigger(null);
                      return;
                    }
                    if (
                      (event.key === "Tab" || event.key === "Enter") &&
                      fileMentionOptions.length
                    ) {
                      event.preventDefault();
                      event.stopPropagation();
                      const option =
                        fileMentionOptions[activeFileMentionIndex] ??
                        fileMentionOptions[0];
                      if (option) applyFileMention(option);
                    }
                  }}
                  onClick={(event) =>
                    refreshFileMention(
                      event.currentTarget.value,
                      event.currentTarget.selectionStart,
                    )
                  }
                  onBlur={() => setFileMentionTrigger(null)}
                  onPaste={(event) => {
                    const files = Array.from(event.clipboardData.files).filter(
                      (file) => file.type.startsWith("image/"),
                    );
                    if (files.length) {
                      event.preventDefault();
                      void saveImageFiles(files);
                    }
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    const files = Array.from(event.dataTransfer.files).filter(
                      (file) => file.type.startsWith("image/"),
                    );
                    if (files.length) {
                      event.preventDefault();
                      void saveImageFiles(files);
                    }
                  }}
                  placeholder={
                    locale === "zh-CN"
                      ? "描述您想实现的功能、错误修复或改进。尽可能详细地说明要求、约束和预期行为。键入 @ 以引用文件。"
                      : t(locale, "board.dialog.descriptionPlaceholder")
                  }
                  rows={6}
                  className="min-h-[150px] max-h-[400px] w-full resize-y rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none"
                />
                {fileMentionOpen && (
                  <div
                    id="task-dialog-file-mention-suggestions"
                    role="listbox"
                    aria-label="项目文件建议"
                    className="absolute left-0 right-0 top-full z-30 mt-1 max-h-64 overflow-y-auto rounded-md border border-border bg-panel py-1 shadow-2xl"
                  >
                    {fileMentionLoading && !fileMentionOptions.length ? (
                      <div className="flex items-center gap-2 px-3 py-2 text-xs text-fg-dim">
                        <Loader2 size={13} className="animate-spin" />
                        正在读取项目文件
                      </div>
                    ) : fileMentionError ? (
                      <p className="px-3 py-2 text-xs text-red-400">
                        {fileMentionError}
                      </p>
                    ) : (
                      fileMentionOptions.map((entry, index) => (
                        <button
                          key={entry.path}
                          id={`task-dialog-file-mention-${index}`}
                          type="button"
                          role="option"
                          aria-selected={index === activeFileMentionIndex}
                          onMouseDown={(event) => event.preventDefault()}
                          onMouseEnter={() => setActiveFileMentionIndex(index)}
                          onClick={() => applyFileMention(entry)}
                          className={cn(
                            "flex w-full items-center gap-2 px-3 py-2 text-left text-xs",
                            index === activeFileMentionIndex
                              ? "bg-[#58a6ff]/15 text-fg"
                              : "text-fg-dim hover:bg-border-soft hover:text-fg",
                          )}
                        >
                          {entry.kind === "directory" ? (
                            <Folder
                              size={14}
                              className="shrink-0 text-amber-400"
                            />
                          ) : (
                            <FileCode2
                              size={14}
                              className="shrink-0 text-sky-400"
                            />
                          )}
                          <span className="min-w-0 flex-1 truncate">
                            {entry.relativePath}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
              {error && (
                <p role="alert" className="text-xs text-red-400">
                  任务描述不能为空
                </p>
              )}
              <p className="text-xs text-fg-faint">
                提示：直接使用 Ctrl+V 粘贴屏幕截图以添加参考图像。
              </p>
            </div>
            <div>
              <button
                type="button"
                aria-expanded={showImages}
                onClick={() => setShowImages((value) => !value)}
                className="flex w-full items-center justify-between rounded-md px-3 py-2 text-sm text-fg-dim hover:bg-border-soft hover:text-fg"
              >
                <span className="inline-flex items-center gap-2">
                  参考图片（可选）
                  {!!meta.referenceImages?.length && (
                    <span className="rounded bg-[#58a6ff]/10 px-1.5 py-0.5 text-[10px] text-accent">
                      {meta.referenceImages.length}
                    </span>
                  )}
                </span>
                <ChevronDown
                  size={15}
                  className={cn(
                    "transition-transform",
                    showImages && "rotate-180",
                  )}
                />
              </button>
              {showImages && (
                <div className="mt-2 rounded-lg border border-border bg-[#21262d]/30 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={
                        savingImages ||
                        (meta.referenceImages?.length ?? 0) >=
                          TASK_MAX_REFERENCE_IMAGES
                      }
                      onClick={() => void pickImages()}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-border-soft disabled:opacity-40"
                    >
                      <Paperclip size={14} />
                      添加图片
                    </button>
                    <button
                      type="button"
                      disabled={
                        savingImages ||
                        (meta.referenceImages?.length ?? 0) >=
                          TASK_MAX_REFERENCE_IMAGES
                      }
                      onClick={() => void captureScreen()}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-border-soft disabled:opacity-40"
                    >
                      <Camera size={14} />
                      截屏
                    </button>
                    {savingImages && (
                      <span className="inline-flex items-center gap-1 text-xs text-fg-dim">
                        <Loader2 size={13} className="animate-spin" />
                        正在保存
                      </span>
                    )}
                  </div>
                  {(meta.referenceImages?.length ?? 0) > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {(meta.referenceImages ?? []).map((image) => (
                        <ReferenceImageThumb
                          key={image.id}
                          image={image}
                          cwd={cwd}
                          onRemove={() =>
                            setMeta((current) => ({
                              ...current,
                              referenceImages: current.referenceImages?.filter(
                                (candidate) => candidate.id !== image.id,
                              ),
                            }))
                          }
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="mt-3 flex h-24 items-center justify-center rounded-md border-2 border-dashed border-border text-xs text-fg-faint">
                      粘贴、拖放、选择文件或截屏添加参考图片
                    </div>
                  )}
                  {imageError && (
                    <p role="alert" className="mt-2 text-xs text-red-400">
                      {imageError}
                    </p>
                  )}
                </div>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <label
                htmlFor="task-dialog-title"
                className="text-sm font-medium text-fg"
              >
                任务标题 <span className="font-normal text-fg-dim">(可选)</span>
              </label>
              <input
                id="task-dialog-title"
                ref={titleRef}
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                  setError(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing)
                    submit();
                }}
                placeholder={
                  locale === "zh-CN"
                    ? "留空则根据描述自动生成"
                    : t(locale, "board.dialog.titlePlaceholder")
                }
                className={cn(
                  "h-10 w-full rounded-md border bg-bg px-3 text-sm text-fg placeholder:text-fg-faint focus:outline-none",
                  error
                    ? "border-red-500"
                    : "border-border focus:border-accent",
                )}
              />
              <p className="text-xs text-fg-faint">
                可选，留空时根据任务描述自动生成
              </p>
            </div>

            <TaskAgentProfileSelector
              value={meta}
              options={modelOptions}
              fallbackSelection={activeTaskModelSelection}
              onChange={(patch) =>
                setMeta((current) => ({ ...current, ...patch }))
              }
            />
            <button
              type="button"
              onClick={() => setShowClassification((shown) => !shown)}
              aria-expanded={showClassification}
              aria-controls="task-dialog-classification"
              className="flex w-full items-center justify-between rounded-md px-3 py-2 text-sm text-fg-dim transition-colors hover:bg-border-soft hover:text-fg"
            >
              <span>{t(locale, "board.dialog.classification")}</span>
              {showClassification ? (
                <ChevronUp size={16} />
              ) : (
                <ChevronDown size={16} />
              )}
            </button>
            {showClassification && (
              <div
                id="task-dialog-classification"
                className="grid grid-cols-2 gap-4"
              >
                <ClassificationSelect
                  id="task-dialog-category"
                  label={t(locale, "board.dialog.classificationLabel")}
                  placeholder={t(locale, "board.dialog.selectCategory")}
                  value={meta.category ?? ""}
                  options={TASK_CATEGORIES.map((value) => ({
                    value,
                    label: t(locale, `board.category.${value}`),
                  }))}
                  onChange={(raw) => setMetaValue("category", raw)}
                />
                <ClassificationSelect
                  id="task-dialog-priority"
                  label={t(locale, "board.dialog.priorityLabel")}
                  placeholder={t(locale, "board.dialog.selectPriority")}
                  value={meta.priority ?? ""}
                  options={TASK_PRIORITIES.map((value) => ({
                    value,
                    label: t(locale, `board.priority.${value}`),
                  }))}
                  onChange={(raw) => setMetaValue("priority", raw)}
                />
                <ClassificationSelect
                  id="task-dialog-complexity"
                  label={t(locale, "board.dialog.complexityLabel")}
                  placeholder={t(locale, "board.dialog.selectComplexity")}
                  value={meta.complexity ?? ""}
                  options={TASK_COMPLEXITIES.map((value) => ({
                    value,
                    label: t(locale, `board.complexity.${value}`),
                  }))}
                  onChange={(raw) => setMetaValue("complexity", raw)}
                />
                <ClassificationSelect
                  id="task-dialog-impact"
                  label={t(locale, "board.dialog.impactLabel")}
                  placeholder={t(locale, "board.dialog.selectImpact")}
                  value={meta.impact ?? ""}
                  options={TASK_IMPACTS.map((value) => ({
                    value,
                    label: t(locale, `board.impact.${value}`),
                  }))}
                  onChange={(raw) => setMetaValue("impact", raw)}
                />
              </div>
            )}
            <label className="flex items-start gap-3 rounded-lg border border-border bg-[#21262d]/30 p-4">
              <input
                type="checkbox"
                className="mt-1"
                checked={meta.requireReviewBeforeCoding || false}
                disabled={meta.developmentMode !== "standard"}
                onChange={(event) =>
                  setMeta((current) => ({
                    ...current,
                    requireReviewBeforeCoding: event.target.checked,
                  }))
                }
              />
              <span className="text-sm">
                编码前需要人工审核
                <span className="mt-1 block text-xs text-fg-dim">
                  在编码阶段开始前审查规范和实施计划。你可以批准、要求修改或提供反馈。
                </span>
              </span>
            </label>
            <section className="space-y-2">
              <h3 className="text-sm font-medium">开发模式</h3>
              <p className="text-xs text-fg-dim">选择任务的规划和执行流程</p>
              <div className="mt-3 grid grid-cols-1 gap-2">
                {(
                  [
                    {
                      mode: "direct",
                      label: "Direct 直连模式",
                      description: "直接编码，跳过分阶段规划和 QA。",
                      performance: "速度最快 · 适合小型、明确的修改",
                      icon: Zap,
                    },
                    {
                      mode: "standard",
                      label: "Standard 标准模式",
                      description:
                        "采用兼容 OpenSpec 规范的自定义流程：需求规划、子任务实施与 QA 审核。",
                      performance: "质量与速度平衡 · 适合大多数开发任务",
                      icon: ListChecks,
                    },
                    {
                      mode: "spec",
                      label: "Spec (OpenSpec)",
                      description: "创建 OpenSpec 变更工件，审批后按规范实施。",
                      performance: "规范优先 · 适合复杂或高风险变更",
                      icon: FileText,
                    },
                  ] as const
                ).map(
                  ({
                    mode,
                    label,
                    description,
                    performance,
                    icon: ModeIcon,
                  }) => (
                    <button
                      type="button"
                      key={mode}
                      data-testid={`development-mode-${mode}`}
                      aria-pressed={meta.developmentMode === mode}
                      onClick={() =>
                        setMeta((current) => ({
                          ...current,
                          developmentMode: mode,
                          requireReviewBeforeCoding:
                            mode === "standard"
                              ? current.requireReviewBeforeCoding
                              : false,
                        }))
                      }
                      className={cn(
                        "flex items-start gap-3 rounded-lg border-2 p-3 text-left transition-colors",
                        meta.developmentMode === mode
                          ? "border-accent bg-[#58a6ff]/5"
                          : "border-border hover:border-[#58a6ff]/50 hover:bg-[#252b33]/50",
                      )}
                    >
                      <ModeIcon
                        size={16}
                        className={cn(
                          "mt-0.5 shrink-0",
                          meta.developmentMode === mode
                            ? "text-accent"
                            : "text-fg-dim",
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="text-sm font-medium">{label}</span>
                          {mode === "standard" && (
                            <span className="rounded bg-[#58a6ff]/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                              推荐
                            </span>
                          )}
                        </span>
                        <span className="mt-1 block text-xs text-fg-dim">
                          {description}
                        </span>
                        <span className="mt-1 block text-xs text-fg-dim">
                          {performance}
                        </span>
                      </span>
                    </button>
                  ),
                )}
              </div>
              {meta.developmentMode === "spec" && (
                <div className="mt-3 grid grid-cols-2 gap-3 rounded-lg border border-sky-500/25 bg-sky-500/5 p-4">
                  <label className="text-xs text-fg-dim">
                    OpenSpec 变更 ID（可选）
                    <input
                      value={meta.openSpecChange || ""}
                      onChange={(event) =>
                        setMeta((current) => ({
                          ...current,
                          openSpecChange: event.target.value,
                        }))
                      }
                      placeholder="根据任务标题自动生成"
                      className="mt-1.5 h-9 w-full rounded-md border border-border bg-bg px-2 text-sm text-fg"
                    />
                  </label>
                  <label className="text-xs text-fg-dim">
                    工作流 Schema
                    <select
                      value={meta.openSpecSchema || "spec-driven"}
                      onChange={(event) =>
                        setMeta((current) => ({
                          ...current,
                          openSpecSchema: event.target.value,
                        }))
                      }
                      className="mt-1.5 h-9 w-full rounded-md border border-border bg-bg px-2 text-sm text-fg"
                    >
                      <option value="spec-driven">spec-driven</option>
                    </select>
                  </label>
                  <p className="col-span-2 text-xs text-fg-dim">
                    执行时将调用官方 OpenSpec CLI 生成 proposal、design、specs
                    与 tasks 工件，批准后再进入实现。
                  </p>
                </div>
              )}
            </section>
            <button
              type="button"
              onClick={() => setShowGitOptions((shown) => !shown)}
              aria-expanded={showGitOptions}
              aria-controls="task-dialog-git-options"
              className="flex w-full items-center justify-between rounded-md px-3 py-2 text-sm text-fg-dim transition-colors hover:bg-border-soft hover:text-fg"
            >
              <span className="flex items-center gap-2">
                <GitBranch size={16} />
                Git 选项（可选）
                {!!meta.baseBranch && (
                  <span className="rounded bg-[#58a6ff]/10 px-1.5 py-0.5 text-[10px] text-accent">
                    {meta.baseBranch}
                  </span>
                )}
              </span>
              {showGitOptions ? (
                <ChevronUp size={16} />
              ) : (
                <ChevronDown size={16} />
              )}
            </button>
            {showGitOptions && (
              <div
                id="task-dialog-git-options"
                className="space-y-4 rounded-lg border border-border bg-[#21262d]/30 p-4"
              >
                <label className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={meta.useWorktree || false}
                    onChange={(event) =>
                      setMeta((current) => ({
                        ...current,
                        useWorktree: event.target.checked,
                      }))
                    }
                  />
                  <span className="text-sm">
                    使用隔离工作区
                    <span className="mt-1 block text-xs text-fg-dim">
                      在单独的 Git 工作树和分支中创建更改，便于合并前审查。
                    </span>
                  </span>
                </label>
                {meta.useWorktree && (
                  <div className="mt-4 grid grid-cols-2 gap-4 border-t border-border pt-4">
                    <label className="text-xs text-fg-dim">
                      基准分支
                      <select
                        value={meta.baseBranch || ""}
                        onChange={(event) =>
                          setMeta((current) => ({
                            ...current,
                            baseBranch: event.target.value,
                          }))
                        }
                        disabled={gitOverviewLoading}
                        className="mt-1.5 h-9 w-full rounded-md border border-border bg-bg px-2 text-sm text-fg"
                      >
                        <option value="">
                          {gitOverviewLoading
                            ? "正在读取分支..."
                            : `当前分支${gitOverview?.currentBranch ? ` · ${gitOverview.currentBranch}` : ""}`}
                        </option>
                        {meta.baseBranch &&
                          !gitOverview?.branches.includes(meta.baseBranch) && (
                            <option value={meta.baseBranch}>
                              {meta.baseBranch}
                            </option>
                          )}
                        {gitOverview?.branches.map((branch) => (
                          <option key={branch} value={branch}>
                            {branch}
                            {branch === gitOverview.defaultBranch
                              ? " · 默认"
                              : ""}
                          </option>
                        ))}
                      </select>
                      {!gitOverviewLoading && !gitOverview && (
                        <span className="mt-1 block text-[10px] text-amber-400">
                          当前目录不是 Git 仓库，执行时将使用目录副本。
                        </span>
                      )}
                    </label>
                    <label className="flex items-start gap-2 pt-6 text-xs text-fg-dim">
                      <input
                        type="checkbox"
                        checked={meta.pushNewBranches || false}
                        onChange={(event) =>
                          setMeta((current) => ({
                            ...current,
                            pushNewBranches: event.target.checked,
                          }))
                        }
                      />
                      创建后推送新分支
                    </label>
                  </div>
                )}
              </div>
            )}
          </div>
          {browseFiles && (
            <aside className="w-80 shrink-0 border-l border-border bg-[#21262d]/20 p-4">
              <TaskWorkspaceFiles
                cwd={cwd}
                cardId={editing?.id || "draft"}
                onReference={(path) =>
                  setNote((value) => `${value}${value ? "\n" : ""}@${path}`)
                }
              />
            </aside>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-border bg-[#21262d]/30 px-6 py-4">
          <div className="flex min-w-0 items-center gap-2">
            {!!cwd && (
              <button
                type="button"
                onClick={() => setBrowseFiles((shown) => !shown)}
                className={cn(
                  "inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm transition-colors",
                  browseFiles
                    ? "border-accent bg-accent text-bg"
                    : "border-border text-fg hover:bg-border-soft",
                )}
              >
                <FolderTree size={16} />
                {browseFiles ? "隐藏文件" : "浏览文件"}
              </button>
            )}
            {draft && (
              <button
                type="button"
                className="h-9 rounded-md px-3 text-xs text-fg-dim hover:bg-border-soft hover:text-fg"
                onClick={() => {
                  setTitle("");
                  setNote("");
                }}
              >
                重新开始
              </button>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="h-9 rounded-md border border-border px-4 text-sm font-medium text-fg transition-colors hover:bg-border-soft"
            >
              {t(locale, "board.edit.cancel")}
            </button>
            <button
              type="button"
              onClick={() => submit()}
              className={cn(
                "h-9 rounded-md px-4 text-sm font-medium transition-colors",
                editing
                  ? "bg-accent text-bg hover:opacity-90"
                  : "border border-border text-fg hover:bg-border-soft",
              )}
            >
              {t(locale, editing ? "board.edit.save" : "board.dialog.create")}
            </button>
            {!editing && (
              <button
                type="button"
                onClick={() => submit(true)}
                className="h-9 rounded-md bg-accent px-4 text-sm font-medium text-bg transition-opacity hover:opacity-90"
              >
                创建并启动
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

function ClassificationSelect({
  id,
  label,
  placeholder,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (raw: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[11px] font-medium text-fg-dim">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-full rounded-md border border-border bg-bg px-2 text-sm text-fg focus:border-accent focus:outline-none"
      >
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function ReferenceImageThumb({
  image,
  cwd,
  onRemove,
}: {
  image: TaskReferenceImage;
  cwd: string;
  onRemove: () => void;
}) {
  const [source, setSource] = useState("");
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
    <div
      className="group relative h-[72px] w-[72px] overflow-hidden rounded-md border border-border bg-bg"
      title={image.path}
    >
      {source ? (
        <img
          src={source}
          alt={image.fileName}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <ImageIcon size={22} className="text-fg-faint" />
        </div>
      )}
      <button
        type="button"
        aria-label={`移除图片 ${image.fileName}`}
        onClick={onRemove}
        className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-white opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
      >
        <Trash2 size={11} />
      </button>
    </div>
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return buffer;
}
