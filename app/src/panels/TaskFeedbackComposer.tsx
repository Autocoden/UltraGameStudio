import {
  useEffect,
  useState,
  type ClipboardEvent,
  type DragEvent,
} from "react";
import {
  AlertCircle,
  CheckCircle2,
  FileText,
  Image as ImageIcon,
  Loader2,
  X,
} from "lucide-react";
import { cn } from "@/lib/cn";
import {
  TASK_MAX_REFERENCE_IMAGES,
  type TaskReferenceImage,
} from "@/lib/taskBoard";
import {
  previewLocalFile,
  saveClipboardImage,
  saveTaskAttachment,
} from "@/lib/tauri";

const MAX_FEEDBACK_FILE_BYTES = 10 * 1024 * 1024;

export interface TaskFeedbackComposerProps {
  value: string;
  onChange: (value: string) => void;
  attachments: TaskReferenceImage[];
  onAttachmentsChange: (attachments: TaskReferenceImage[]) => void;
  cwd: string;
  existingCount?: number;
  disabled?: boolean;
  ariaLabel?: string;
  placeholder?: string;
  className?: string;
  textareaClassName?: string;
}

function attachmentId(): string {
  return typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;
}

function extensionForMime(mime: string): string {
  const extensions: Record<string, string> = {
    "image/svg+xml": "svg",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/avif": "avif",
  };
  return extensions[mime] || mime.split("/")[1]?.split("+")[0] || "bin";
}

function fileBytesBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("读取附件失败"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const separator = result.indexOf(",");
      if (separator < 0) {
        reject(new Error("读取附件失败"));
        return;
      }
      resolve(result.slice(separator + 1));
    };
    reader.readAsDataURL(file);
  });
}

export default function TaskFeedbackComposer({
  value,
  onChange,
  attachments,
  onAttachmentsChange,
  cwd,
  existingCount = 0,
  disabled = false,
  ariaLabel = "修改反馈",
  placeholder = "请描述问题或需要修改的内容...",
  className,
  textareaClassName,
}: TaskFeedbackComposerProps) {
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const usedCount = existingCount + attachments.length;

  useEffect(() => {
    if (!saved) return;
    const timeout = window.setTimeout(() => setSaved(false), 2_000);
    return () => window.clearTimeout(timeout);
  }, [saved]);

  const saveFiles = async (files: File[]) => {
    if (disabled || saving || !files.length) return;
    const remaining = Math.max(0, TASK_MAX_REFERENCE_IMAGES - usedCount);
    if (!remaining) {
      setError(`每个任务最多添加 ${TASK_MAX_REFERENCE_IMAGES} 个附件`);
      return;
    }

    const errors: string[] = [];
    const eligible = files.filter((file) => {
      if (file.size <= 0) return false;
      if (file.size > MAX_FEEDBACK_FILE_BYTES) {
        errors.push(`“${file.name || "附件"}”超过 10MB`);
        return false;
      }
      return true;
    });
    const candidates = eligible.slice(0, remaining);
    if (eligible.length > remaining) {
      errors.push(`本次仅添加前 ${remaining} 个附件`);
    }
    if (!candidates.length) {
      setError(errors.join("；") || "没有可添加的附件");
      return;
    }

    setSaving(true);
    setSaved(false);
    const added: TaskReferenceImage[] = [];
    for (const file of candidates) {
      const mime = file.type || "application/octet-stream";
      const fileName =
        file.name || `screenshot-${Date.now()}.${extensionForMime(mime)}`;
      try {
        const saveFile = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/i.test(mime)
          ? saveClipboardImage
          : saveTaskAttachment;
        const path = await saveFile({
          bytesBase64: await fileBytesBase64(file),
          mime,
          fileName,
          cwd: cwd || null,
        });
        added.push({
          id: attachmentId(),
          path,
          fileName,
          mime,
        });
      } catch (reason) {
        errors.push(
          reason instanceof Error ? reason.message : `保存“${fileName}”失败`,
        );
      }
    }
    if (added.length) {
      onAttachmentsChange([...attachments, ...added]);
      setSaved(true);
    }
    setError(errors.join("；"));
    setSaving(false);
  };

  const handlePaste = async (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(event.clipboardData?.items ?? []);
    const images = items
      .filter((item) => item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (!images.length) return;
    event.preventDefault();
    await saveFiles(images);
  };

  const handleDrop = async (event: DragEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    await saveFiles(Array.from(event.dataTransfer?.files ?? []));
  };

  return (
    <div className={cn("space-y-2", className)}>
      <textarea
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onPaste={(event) => void handlePaste(event)}
        onDragOver={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setDragging(false);
        }}
        onDrop={(event) => void handleDrop(event)}
        disabled={disabled || saving}
        placeholder={placeholder}
        className={cn(
          "min-h-24 w-full rounded border border-border bg-bg p-3 text-sm outline-none transition-colors focus:border-accent",
          dragging && "border-accent bg-accent/5 ring-2 ring-accent/20",
          textareaClassName,
        )}
      />

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-fg-dim">
        <span>拖放文件或粘贴截图（单个文件最大 10MB）</span>
        <span className="tabular-nums">
          {usedCount}/{TASK_MAX_REFERENCE_IMAGES}
        </span>
      </div>

      {saving && (
        <div className="flex items-center gap-1.5 text-xs text-fg-dim">
          <Loader2 size={13} className="animate-spin" />
          正在保存附件
        </div>
      )}
      {saved && (
        <div
          role="status"
          className="flex items-center gap-1.5 text-xs text-emerald-400"
        >
          <CheckCircle2 size={13} />
          已添加附件
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="flex items-start gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-2 text-xs text-red-300"
        >
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!!attachments.length && (
        <div className="flex flex-wrap gap-2 pt-1">
          {attachments.map((attachment) => (
            <FeedbackAttachment
              key={attachment.id}
              attachment={attachment}
              cwd={cwd}
              disabled={disabled || saving}
              onRemove={() => {
                onAttachmentsChange(
                  attachments.filter((candidate) => candidate.id !== attachment.id),
                );
                setError("");
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FeedbackAttachment({
  attachment,
  cwd,
  disabled,
  onRemove,
}: {
  attachment: TaskReferenceImage;
  cwd: string;
  disabled: boolean;
  onRemove: () => void;
}) {
  const [source, setSource] = useState("");
  const isImage = attachment.mime?.startsWith("image/") ?? false;

  useEffect(() => {
    if (!isImage) {
      setSource("");
      return;
    }
    let disposed = false;
    void previewLocalFile(attachment.path, { cwd })
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
  }, [attachment.path, cwd, isImage]);

  return (
    <div
      title={`${attachment.fileName}\n${attachment.path}`}
      className={cn(
        "group relative flex h-16 overflow-hidden rounded-md border border-border bg-panel-2",
        isImage ? "w-16 items-center justify-center" : "min-w-32 max-w-52 items-center gap-2 px-3",
      )}
    >
      {isImage ? (
        source ? (
          <img
            src={source}
            alt={attachment.fileName}
            className="h-full w-full object-cover"
          />
        ) : (
          <ImageIcon size={22} className="text-fg-dim" />
        )
      ) : (
        <>
          <FileText size={20} className="shrink-0 text-fg-dim" />
          <span className="truncate text-xs">{attachment.fileName}</span>
        </>
      )}
      <button
        type="button"
        aria-label={`删除附件 ${attachment.fileName}`}
        disabled={disabled}
        onClick={onRemove}
        className="absolute right-1 top-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-white opacity-90 shadow hover:bg-red-400 disabled:opacity-40"
      >
        <X size={12} />
      </button>
    </div>
  );
}
