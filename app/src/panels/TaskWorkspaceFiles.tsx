import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  AlertCircle,
  BookOpen,
  Braces,
  ChevronLeft,
  ChevronRight,
  Code2,
  File,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/cn";
import {
  listWorkspaceChanges,
  listWorkspaceDirectory,
  openWorkspaceDirectory,
  previewLocalFile,
  type LocalFilePreview,
  type WorkspaceChangeFile,
  type WorkspaceTreeEntry,
} from "@/lib/tauri";

const PANEL_WIDTH_KEY = "task-files-panel-width";
const TASK_ARTIFACT_EXTENSIONS = new Set([".md", ".json", ".jsonl"]);
const TASK_ARTIFACT_PRIORITY: Record<string, number> = {
  "HUMAN_INPUT.md": 0,
  "change_requests.jsonl": 1,
  "requirements.md": 2,
  "spec.md": 3,
  "design.md": 4,
  "tasks.md": 5,
  "implementation_plan.md": 6,
  "task_logs.jsonl": 7,
};
const INTERNAL_TASK_ARTIFACTS = new Set([
  "autocode-run-prompt.md",
  "autocode-run-result.json",
  "session_state.json",
]);

type ViewMode = "reader" | "source";
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

function parentPath(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return index > 0 ? normalized.slice(0, index) : normalized;
}

function fileExtension(name: string): string {
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index).toLowerCase() : "";
}

function EntryIcon({ entry }: { entry: WorkspaceTreeEntry }) {
  if (entry.kind === "directory") return <Folder size={14} className="text-amber-300" />;
  const extension = fileExtension(entry.name);
  if (extension === ".json" || extension === ".jsonl") {
    return <FileJson size={14} className="text-amber-300" />;
  }
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(extension)) {
    return <ImageIcon size={14} className="text-violet-300" />;
  }
  if ([".md", ".mdx", ".txt"].includes(extension)) {
    return <FileText size={14} className="text-sky-300" />;
  }
  return <File size={14} className="text-fg-dim" />;
}

function JsonNode({ value, name }: { value: JsonValue; name?: string }) {
  if (value !== null && typeof value === "object") {
    const values = Array.isArray(value)
      ? value.map((item, index) => [String(index), item] as const)
      : Object.entries(value);
    const label = Array.isArray(value) ? `Array(${values.length})` : `Object(${values.length})`;
    return (
      <details open className="ml-3 border-l border-border/70 pl-2 text-xs">
        <summary className="cursor-pointer py-0.5 text-fg-dim">
          {name !== undefined && <span className="mr-1 text-sky-300">{name}:</span>}
          {label}
        </summary>
        <div className="space-y-0.5">
          {values.map(([key, item]) => (
            <JsonNode key={key} name={key} value={item} />
          ))}
        </div>
      </details>
    );
  }
  return (
    <div className="ml-3 py-0.5 text-xs">
      {name !== undefined && <span className="mr-1 text-sky-300">{name}:</span>}
      <span
        className={
          typeof value === "string"
            ? "text-emerald-300"
            : value === null
              ? "text-fg-dim"
              : "text-amber-300"
        }
      >
        {typeof value === "string" ? JSON.stringify(value) : String(value)}
      </span>
    </div>
  );
}

function SourceView({ source }: { source: string }) {
  return (
    <pre className="min-h-full overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-fg">
      {source}
    </pre>
  );
}

function TextPreview({
  preview,
  viewMode,
}: {
  preview: LocalFilePreview;
  viewMode: ViewMode;
}) {
  const source = preview.text || "";
  const extension = fileExtension(preview.fileName);
  if (viewMode === "source") return <SourceView source={source} />;

  if (extension === ".md" || extension === ".mdx") {
    return (
      <div className="p-4 text-sm leading-relaxed text-fg [&_a]:text-accent [&_a]:underline [&_blockquote]:border-l-4 [&_blockquote]:border-accent/50 [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-panel-2 [&_code]:px-1 [&_h1]:mb-3 [&_h1]:text-xl [&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:text-lg [&_li]:ml-5 [&_li]:list-disc [&_ol_li]:list-decimal [&_p]:my-2 [&_pre]:my-3 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-bg [&_pre]:p-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:p-1.5 [&_th]:border [&_th]:border-border [&_th]:p-1.5">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>
      </div>
    );
  }
  if (extension === ".json") {
    try {
      return (
        <div className="overflow-auto p-4">
          <JsonNode value={JSON.parse(source) as JsonValue} />
        </div>
      );
    } catch {
      return <SourceView source={source} />;
    }
  }
  return <SourceView source={source} />;
}

function PreviewPane({
  preview,
  content,
  viewMode,
}: {
  preview: LocalFilePreview | null;
  content: string;
  viewMode: ViewMode;
}) {
  if (!preview) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-fg-dim">
        {content || "选择文件以查看其内容"}
      </div>
    );
  }
  if (preview.kind === "image" && preview.base64 && preview.mime) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <img
          src={`data:${preview.mime};base64,${preview.base64}`}
          alt={preview.fileName}
          className="max-h-full max-w-full rounded object-contain"
        />
      </div>
    );
  }
  if (preview.kind === "video" && preview.base64 && preview.mime) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <video controls src={`data:${preview.mime};base64,${preview.base64}`} className="max-h-full max-w-full" />
      </div>
    );
  }
  if (preview.kind === "document" && preview.base64 && preview.mime === "application/pdf") {
    return (
      <object
        data={`data:${preview.mime};base64,${preview.base64}`}
        type={preview.mime}
        className="h-full min-h-96 w-full"
      >
        <p className="p-4 text-xs text-fg-dim">无法内嵌预览该 PDF。</p>
      </object>
    );
  }
  if (preview.kind === "text") {
    return <TextPreview preview={preview} viewMode={viewMode} />;
  }
  return (
    <div className="flex h-full items-center justify-center text-sm text-fg-dim">
      {preview.fileName} · {preview.sizeBytes} bytes
    </div>
  );
}

export default function TaskWorkspaceFiles({
  cwd,
  cardId,
  changes = false,
  taskArtifacts = false,
  onReference,
  initialDirectory = "",
}: {
  cwd: string;
  cardId: string;
  changes?: boolean;
  taskArtifacts?: boolean;
  onReference?: (path: string) => void;
  initialDirectory?: string;
}) {
  const [directory, setDirectory] = useState(initialDirectory);
  const [entries, setEntries] = useState<WorkspaceTreeEntry[]>([]);
  const [diffs, setDiffs] = useState<WorkspaceChangeFile[]>([]);
  const [selected, setSelected] = useState("");
  const [preview, setPreview] = useState<LocalFilePreview | null>(null);
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>("reader");
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    return Number.isFinite(saved) && saved >= 160 ? saved : 270;
  });
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    path: string;
    directory: boolean;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const visibleEntries = useMemo(() => {
    if (!taskArtifacts) return entries;
    return entries
      .filter((entry) => {
        if (entry.kind !== "file") return false;
        const name = entry.name.toLowerCase();
        return (
          !INTERNAL_TASK_ARTIFACTS.has(name) &&
          TASK_ARTIFACT_EXTENSIONS.has(fileExtension(name))
        );
      })
      .sort((left, right) => {
        const leftPriority = TASK_ARTIFACT_PRIORITY[left.name] ?? 100;
        const rightPriority = TASK_ARTIFACT_PRIORITY[right.name] ?? 100;
        return leftPriority - rightPriority || left.name.localeCompare(right.name);
      });
  }, [entries, taskArtifacts]);

  useEffect(() => setDirectory(initialDirectory), [initialDirectory]);

  useEffect(() => {
    let cancelled = false;
    setError("");
    setLoading(true);
    const load = async () => {
      if (!cwd) throw new Error("请先选择项目工作区");
      if (changes) {
        const result = await listWorkspaceChanges(cwd, `board-${cardId}`);
        if (!cancelled) setDiffs(result.files);
      } else {
        const result = await listWorkspaceDirectory(cwd, directory);
        if (!cancelled) setEntries(result.entries);
      }
    };
    void load()
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, cardId, changes, directory, revision]);

  const selectFile = useCallback(
    (entry: WorkspaceTreeEntry) => {
      if (entry.kind === "directory") {
        setDirectory(entry.relativePath.replace(/\\/g, "/"));
        setSelected("");
        setPreview(null);
        setContent("");
        return;
      }
      if (onReference) {
        onReference(entry.relativePath);
        return;
      }
      setSelected(entry.path);
      setContent("正在加载内容...");
      setPreview(null);
      void previewLocalFile(entry.path, { cwd })
        .then((result) => {
          setPreview(result);
          setContent(result.text || `${result.fileName} · ${result.sizeBytes} bytes`);
        })
        .catch((reason) => {
          setContent(reason instanceof Error ? reason.message : String(reason));
        });
    },
    [cwd, onReference],
  );

  useEffect(() => {
    if (!taskArtifacts || loading || error || selected) return;
    const firstFile = visibleEntries.find((entry) => entry.kind === "file");
    if (firstFile) selectFile(firstFile);
  }, [error, loading, selectFile, selected, taskArtifacts, visibleEntries]);

  const selectedName = useMemo(() => {
    if (!selected) return "";
    return selected.split(/[\\/]/).at(-1) || selected;
  }, [selected]);

  const keyboardEntries = visibleEntries.filter((entry) => entry.kind === "file");
  const handleListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!keyboardEntries.length || onReference) return;
    const index = keyboardEntries.findIndex((entry) => entry.path === selected);
    let next = index;
    if (event.key === "ArrowDown") next = Math.min(keyboardEntries.length - 1, index + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, index < 0 ? 0 : index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = keyboardEntries.length - 1;
    else return;
    event.preventDefault();
    selectFile(keyboardEntries[next]);
  };

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeRef.current = { startX: event.clientX, startWidth: sidebarWidth };
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
    const move = (moveEvent: PointerEvent) => {
      const state = resizeRef.current;
      if (!state) return;
      const max = Math.max(190, (rootRef.current?.clientWidth || 900) * 0.55);
      setSidebarWidth(Math.min(max, Math.max(160, state.startWidth + moveEvent.clientX - state.startX)));
    };
    const finish = () => {
      resizeRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setSidebarWidth((value) => {
        localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(value)));
        return value;
      });
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("keydown", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", close);
      window.removeEventListener("resize", close);
    };
  }, [contextMenu]);

  const showContextMenu = (
    event: ReactMouseEvent,
    entry: WorkspaceTreeEntry,
  ) => {
    event.preventDefault();
    const bounds = rootRef.current?.getBoundingClientRect();
    setContextMenu({
      x: Math.max(8, event.clientX - (bounds?.left || 0)),
      y: Math.max(8, event.clientY - (bounds?.top || 0)),
      path: entry.path,
      directory: entry.kind === "directory",
    });
  };

  return (
    <div ref={rootRef} className="relative flex h-full min-h-64 overflow-hidden rounded-lg border border-border">
      <aside style={{ width: sidebarWidth }} className="flex shrink-0 flex-col bg-[#ffffff]/[0.01]">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
          <span className="min-w-0 flex-1 truncate text-xs font-medium uppercase tracking-wide text-fg-dim">
            {changes ? "已变更文件" : directory || "任务文件"}
          </span>
          {directory && !changes && (
            <button
              className="rounded p-1 text-fg-dim hover:bg-panel-2 hover:text-fg"
              title="上级目录"
              onClick={() => setDirectory(directory.split("/").slice(0, -1).join("/"))}
            >
              <ChevronLeft size={14} />
            </button>
          )}
          <button
            className="rounded p-1 text-fg-dim hover:bg-panel-2 hover:text-fg"
            title="刷新"
            onClick={() => setRevision((value) => value + 1)}
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
        <div
          role="listbox"
          aria-label="任务文件"
          tabIndex={0}
          onKeyDown={handleListKeyDown}
          className="min-h-0 flex-1 overflow-auto p-2 outline-none"
        >
          {loading && (
            <div className="flex justify-center py-8 text-fg-dim"><Loader2 size={18} className="animate-spin" /></div>
          )}
          {error && (
            <div role="alert" className="p-3 text-center text-xs text-red-400">
              <AlertCircle size={18} className="mx-auto mb-2" />
              {error}
            </div>
          )}
          {!loading && !error && !changes && visibleEntries.length === 0 && (
            <div className="p-8 text-center text-xs text-fg-dim">
              <FolderOpen size={26} className="mx-auto mb-2 opacity-50" />
              当前目录没有文件
            </div>
          )}
          {!loading && !error && changes && diffs.length === 0 && (
            <div className="p-8 text-center text-xs text-fg-dim">没有检测到文件变更</div>
          )}
          {!changes &&
            visibleEntries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                role="option"
                aria-selected={selected === entry.path}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-panel-2",
                  selected === entry.path && "bg-panel-2 text-fg",
                  entry.hidden && "opacity-60",
                )}
                onClick={() => selectFile(entry)}
                onContextMenu={(event) => showContextMenu(event, entry)}
              >
                <EntryIcon entry={entry} />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {entry.kind === "directory" && <ChevronRight size={13} className="text-fg-dim" />}
              </button>
            ))}
          {changes &&
            diffs.map((file) => (
              <button
                key={file.path}
                type="button"
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-panel-2",
                  selected === file.path && "bg-panel-2",
                )}
                onClick={() => {
                  setSelected(file.path);
                  setPreview(null);
                  setContent(
                    file.lines
                      .map((line) => `${line.kind === "deleted" || line.kind === "replacedDeleted" ? "-" : "+"} ${line.content}`)
                      .join("\n"),
                  );
                }}
              >
                <FileText size={14} className="text-sky-300" />
                <span className="min-w-0 flex-1 truncate">{file.path}</span>
                <span className="text-[10px] text-fg-dim">{file.status}</span>
              </button>
            ))}
        </div>
      </aside>

      <div
        role="separator"
        aria-label="调整文件面板宽度"
        aria-orientation="vertical"
        className="w-1 shrink-0 cursor-ew-resize border-x border-border bg-panel-2/30 hover:bg-accent/40"
        onPointerDown={startResize}
      />

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-panel-2/20 px-3">
          {selectedName ? (
            <>
              <Braces size={14} className="text-accent" />
              <span className="min-w-0 flex-1 truncate text-xs font-medium">{selectedName}</span>
              {preview?.kind === "text" && (
                <div className="flex rounded-md border border-border bg-bg p-0.5">
                  <button
                    type="button"
                    aria-pressed={viewMode === "reader"}
                    className={cn("flex items-center gap-1 rounded px-2 py-1 text-[11px]", viewMode === "reader" && "bg-panel-2 text-fg")}
                    onClick={() => setViewMode("reader")}
                  >
                    <BookOpen size={12} /> 阅读
                  </button>
                  <button
                    type="button"
                    aria-pressed={viewMode === "source"}
                    className={cn("flex items-center gap-1 rounded px-2 py-1 text-[11px]", viewMode === "source" && "bg-panel-2 text-fg")}
                    onClick={() => setViewMode("source")}
                  >
                    <Code2 size={12} /> 源码
                  </button>
                </div>
              )}
            </>
          ) : (
            <span className="text-xs text-fg-dim">选择文件以查看其内容</span>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {changes && !preview ? <SourceView source={content} /> : <PreviewPane preview={preview} content={content} viewMode={viewMode} />}
          {preview?.truncated && (
            <p className="m-3 border-t border-border pt-2 text-[11px] text-amber-400">文件较大，当前显示的是截断预览。</p>
          )}
        </div>
      </section>

      {contextMenu && (
        <div
          className="absolute z-50 min-w-52 rounded-md border border-border bg-panel py-1 shadow-xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-panel-2"
            onClick={() => {
              void openWorkspaceDirectory(
                contextMenu.directory ? contextMenu.path : parentPath(contextMenu.path),
              );
              setContextMenu(null);
            }}
          >
            <FolderOpen size={14} />
            在文件资源管理器中打开
          </button>
        </div>
      )}
    </div>
  );
}
