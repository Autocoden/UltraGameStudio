import { isValidElement, type MouseEvent, type ReactNode } from 'react';
import { ExternalLink, Image as ImageIcon } from 'lucide-react';
import { openExternal } from '@/lib/tauri';
import { parseFileRef, type FileRef } from './lib/filePath';
import FileChip, { type OpenFileFn } from './FileChip';
import AudioPlayer from './AudioPlayer';
import VideoPlayer from './VideoPlayer';
import ModelViewer from './ModelViewer';
import { canPreviewModelUrl, isModelUrl } from './lib/modelLink';
import { createImagePreviewRef, isHttpImageUrl } from './lib/imagePreview';

/**
 * Anchor renderer for markdown links. External URLs (http/https/mailto) open in
 * a new tab with safe rel; anything that parses as a local file reference is
 * rendered as a clickable {@link FileChip} (a real <a target="_blank"> silently
 * fails for local paths inside a webview).
 */
export default function SmartLink({
  href,
  children,
  onOpenFile,
  cwd,
  defaultModelAnimations,
}: {
  href?: string;
  children?: ReactNode;
  onOpenFile?: OpenFileFn;
  cwd?: string;
  defaultModelAnimations?: string[];
}) {
  const url = href ?? '';
  const labelText = childrenToText(children);
  const isAudioUrl =
    /^data:audio\//i.test(url) ||
    /^https?:\/\/.+\.(?:mp3|wav|m4a|aac|ogg|flac|webm)(?:[?#].*)?$/i.test(url);
  const isVideoUrl =
    /^data:video\//i.test(url) ||
    /^https?:\/\/.+\.(?:mp4|mov|m4v|webm|mkv|avi)(?:[?#].*)?$/i.test(url);
  const isWebUrl = /^https?:/i.test(url);
  const isImageUrl = isHttpImageUrl(url);
  const hasExplicitNonModelMediaExt =
    /\.(?:png|apng|jpe?g|jpe|jfif|pjpeg|pjp|gif|webp|bmp|svg|avif|ico|mp4|mov|webm|mp3|wav|m4a|aac|ogg|flac)(?:[?#].*)?$/i.test(
      url,
    );
  const isModelAssetUrl =
    isModelUrl(url) ||
    (isWebUrl &&
      !hasExplicitNonModelMediaExt &&
      hasExplicitModelPreviewLabel(labelText));
  const isExternal = /^(https?:|mailto:)/i.test(url);
  const ref = parseFileRef(url, { allowSpaces: true });

  if (isModelAssetUrl && canPreviewModelUrl(url)) {
    return (
      <ModelViewer
        src={ref?.path ?? url}
        label={labelText}
        cwd={cwd}
        defaultAnimations={defaultModelAnimations}
      />
    );
  }

  if (ref) return <FileChip refData={ref} onOpenFile={onOpenFile} cwd={cwd} label={children} />;

  if (isVideoUrl) {
    return <VideoPlayer src={url} label={labelText} />;
  }

  if (isAudioUrl) {
    return <AudioPlayer src={url} label={labelText} />;
  }

  if (isImageUrl && onOpenFile) {
    return (
      <button
        type="button"
        onClick={() => void onOpenFile(createImagePreviewRef(url, labelText))}
        data-file-preview-trigger="true"
        title="在右侧预览"
        className="inline-flex items-center gap-0.5 text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
      >
        {children}
        <ImageIcon size={11} className="opacity-60" />
      </button>
    );
  }

  if (!isExternal) {
    const childRef = resolveLabelRef(labelText);
    if (childRef) {
      return <FileChip refData={childRef} onOpenFile={onOpenFile} cwd={cwd} label={children} />;
    }
  }

  if (isExternal) {
    const openWebUrl = (event: MouseEvent<HTMLAnchorElement>) => {
      if (!isWebUrl) return;
      event.preventDefault();
      void openExternal(url);
    };

    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={openWebUrl}
        className="inline-flex items-center gap-0.5 text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
      >
        {children}
        <ExternalLink size={11} className="opacity-60" />
      </a>
    );
  }

  // Unknown scheme / relative anchor — there is no local file behind the text,
  // and no web target either. Render it as dimmed plain text instead of an
  // accent-coloured, underlined span: a link that looks clickable but does
  // nothing is exactly the "交付物点不动" report this branch keeps producing.
  return <span className="text-fg-dim">{children}</span>;
}

/**
 * Resolve the *link text* to a local file when the href itself is unusable
 * (folder destination, sanitised scheme, empty string).
 *
 * Models routinely label a deliverable with a human-readable annotation —
 * `[report.md（162 KB / 1757 行 / 113 张图引用）](…)` — which is not a valid path
 * as a whole string. Try the whole label first, then retry with one trailing
 * bracketed annotation stripped, so the annotation stops costing the user a
 * clickable artifact.
 */
function resolveLabelRef(label: string): FileRef | null {
  const direct = parseFileRef(label, { allowSpaces: true });
  if (direct) return direct;
  const stripped = label.replace(/[（(][^（）()]*[)）]\s*$/u, '').trim();
  if (!stripped || stripped === label) return null;
  return parseFileRef(stripped, { allowSpaces: true });
}

function childrenToText(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(childrenToText).join('');
  if (isValidElement(children)) {
    return childrenToText((children.props as { children?: ReactNode }).children);
  }
  return '';
}

function hasExplicitModelPreviewLabel(text: string): boolean {
  const value = text.trim();
  if (!value || /^https?:\/\//i.test(value)) return false;
  return (
    /(?:预览|查看|打开|下载)(?:\s*\/\s*(?:预览|下载))?\s*(?:3d|三维)\s*(?:模型|资产)/iu.test(
      value,
    ) ||
    /\b(?:preview|view|open|download)(?:\s*\/\s*(?:preview|download))?\s*(?:3d|three[-\s]?d)\s*(?:model|asset)\b/iu.test(
      value,
    )
  );
}
