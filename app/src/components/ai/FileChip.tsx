import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import {
  FileCode,
  FileText,
  FolderOpen,
  FolderTree,
  ImageOff,
  Loader2,
  Copy,
  Check,
  X,
} from 'lucide-react';
import {
  displayFileRefLabel,
  displayFileRefPath,
  fileRefLineSuffix,
  isImageFileRef,
  isDocumentFileRef,
  type FileRef,
} from './lib/filePath';
import {
  FileChipBudgetContext,
  claimFileChipSlot,
  createFileChipBudget,
  useFileChipBudget,
  type FileChipSlot,
} from './lib/fileChipBudget';
import { useStore } from '@/store/useStore';
import { t } from '@/lib/i18n';
import { fileExists, previewLocalFile, readImageThumbnail } from '@/lib/tauri';
import { createObjectUrlFromBase64, revokeObjectUrl } from '@/lib/objectUrl';
import { useFileActionsMenu } from './useFileActionsMenu';

export interface OpenFileIntent {
  reveal?: boolean;
  /**
   * Jump to the directory that holds the file instead of previewing/opening the
   * file itself. Unlike `reveal` (open the folder AND select the file), this
   * opens the folder alone — the "跳转到这个文件的目录" action.
   */
  openContainingFolder?: boolean;
}

export interface OpenFileFn {
  (ref: FileRef, intent?: OpenFileIntent): void | Promise<void>;
}

export function FileChipBudgetProvider({
  children,
  limit,
}: {
  children: ReactNode;
  limit?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const budget = createFileChipBudget(limit, expanded, setExpanded);

  return (
    <FileChipBudgetContext.Provider value={budget}>
      {children}
    </FileChipBudgetContext.Provider>
  );
}

function useFileChipSlot(bypass: boolean): FileChipSlot {
  const budget = useFileChipBudget();
  const idRef = useRef<symbol | null>(null);
  // Hooks must run unconditionally; bypass only skips the budget *claim*.
  // The ref allocation above is harmless and keeps the call order stable.
  if (bypass) return 'visible';
  if (!budget) return 'visible';

  if (!idRef.current) idRef.current = Symbol('file-chip');
  const slotId = idRef.current;
  const existing = budget.slots.get(slotId);
  if (existing) return existing;

  const slot = claimFileChipSlot(budget);
  budget.slots.set(slotId, slot);
  return slot;
}

export function FileChipLimitNotice() {
  const locale = useStore((s) => s.locale);
  const budget = useFileChipBudget();
  const label = t(locale, 'chat.fileRefsFolded');
  const expand = () => budget?.setExpanded?.(true);

  if (budget?.setExpanded) {
    return (
      <button
        type="button"
        className="ai-file-chip-limit inline-flex max-w-full cursor-pointer items-center rounded border border-border-soft bg-panel-2 px-1.5 py-0.5 align-baseline text-[11px] leading-snug text-fg-faint transition-colors hover:border-accent hover:text-fg"
        title={`${label} · ${t(locale, 'chat.expand')}`}
        aria-expanded={budget.expanded}
        aria-label={`${t(locale, 'chat.expand')}：${label}`}
        onClick={expand}
      >
        {label}
      </button>
    );
  }

  return (
    <span
      className="ai-file-chip-limit inline-flex max-w-full items-center rounded border border-border-soft bg-panel-2 px-1.5 py-0.5 align-baseline text-[11px] leading-snug text-fg-faint"
      title={label}
    >
      {label}
    </span>
  );
}

const menuIconClass = 'shrink-0 text-fg-faint';

type ThumbState =
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'error' };

/**
 * Lightweight existence check via the Rust backend. Returns 'checking'
 * initially, then 'exists' or 'missing'. Skipped for remote workspaces and
 * non-desktop contexts.
 *
 * We use a custom Tauri command instead of @tauri-apps/plugin-fs so that paths
 * outside fs:scope-home-recursive (e.g. other Windows drives like E:\) are
 * still resolved and checked correctly.
 */
function useFileExists(path: string | null, cwd: string | undefined): 'checking' | 'exists' | 'missing' {
  const [state, setState] = useState<'checking' | 'exists' | 'missing'>('checking');

  useEffect(() => {
    if (!path || path.startsWith('remote://') || cwd?.startsWith('remote://')) {
      setState('exists'); // can't check — assume OK so chip stays interactive
      return;
    }

    let disposed = false;
    setState('checking');

    void (async () => {
      try {
        const ok = await fileExists(path, { cwd });
        if (!disposed) setState(ok ? 'exists' : 'missing');
      } catch {
        if (!disposed) setState('exists'); // optimistic fallback
      }
    })();

    return () => { disposed = true; };
  }, [path, cwd]);

  return state;
}

function useCopyToClipboard(): [boolean, (value: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = async (value: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        try { ta.select(); document.execCommand('copy'); }
        finally { if (ta.parentNode) ta.parentNode.removeChild(ta); }
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch { /* clipboard unavailable */ }
  };
  return [copied, copy];
}

/**
 * Lazily load a small in-memory preview of an image file reference so the chip
 * can show its thumbnail. Reuses the same `preview_local_file` backend command
 * the right-side drawer relies on, and revokes the object URL on cleanup.
 */
function useImageThumbnail(
  path: string | null,
  cwd: string | undefined,
): ThumbState {
  const [state, setState] = useState<ThumbState>({ status: 'loading' });

  useEffect(() => {
    if (!path || path.startsWith('remote://') || cwd?.startsWith('remote://')) {
      setState({ status: 'error' });
      return;
    }

    let disposed = false;
    let createdUrl: string | null = null;
    setState({ status: 'loading' });

    // Thumbnails are downscaled in Rust, so a chat holding twenty 4K
    // screenshots moves a few KB per chip instead of twenty full-resolution
    // base64 payloads.
    void readImageThumbnail(path, { cwd })
      .then(async (thumb) => {
        if (disposed) return;
        try {
          const url = await createObjectUrlFromBase64(thumb.base64, thumb.mime);
          if (disposed) {
            revokeObjectUrl(url);
            return;
          }
          createdUrl = url;
          setState({ status: 'ready', url });
        } catch {
          if (!disposed) setState({ status: 'error' });
        }
      })
      .catch(() => {
        // Vector and animated formats have no raster decoder; fall back to the
        // inline payload `preview_local_file` returns for them.
        return previewLocalFile(path, { cwd }).then(async (file) => {
          if (disposed) return;
          if (file.kind !== 'image' || !file.base64 || !file.mime) {
            setState({ status: 'error' });
            return;
          }
          try {
            const url = await createObjectUrlFromBase64(file.base64, file.mime);
            if (disposed) {
              revokeObjectUrl(url);
              return;
            }
            createdUrl = url;
            setState({ status: 'ready', url });
          } catch {
            if (!disposed) setState({ status: 'error' });
          }
        });
      })
      .catch(() => {
        if (!disposed) setState({ status: 'error' });
      });

    return () => {
      disposed = true;
      revokeObjectUrl(createdUrl);
    };
  }, [path, cwd]);

  return state;
}

/**
 * A clickable chip for a local file reference (e.g. `src/store/useStore.ts:42`).
 * Shows the basename + optional `:line` suffix; the full path is in the tooltip.
 * Clicking calls `onOpenFile`; right-clicking opens a small reveal-in-folder
 * menu. When no handler is wired the chip is styled inert but still serves as a
 * visual signal that this token is a file path.
 */
/**
 * A file reference that fell outside the per-message chip budget, rendered as a
 * clickable-but-plain link instead of a decorated chip.
 *
 * UGS contract: every file path the AI prints must stay clickable. The budget
 * exists to stop a long answer from painting dozens of thumbnails and hover
 * targets, but deliverables (generated HTML/MD reports) routinely sit far past
 * the cutoff — a single analysis reply can carry hundreds of references, so the
 * artifact the user actually wants is exactly the one the budget would fold
 * away. Folding may drop decoration; it must never drop clickability, or the
 * artifact becomes an un-openable string.
 *
 * Deliberately calls no hooks: `useFileExists` / `useImageThumbnail` would fire
 * one backend round-trip per folded reference, which on a 400-reference reply
 * is exactly the IPC storm the budget was introduced to avoid. Opening is
 * cheap, and the preview drawer already reports a missing file.
 */
export function FoldedFileChip({
  refData,
  onOpenFile,
  cwd,
  fallback,
  label: linkLabel,
}: {
  refData: FileRef;
  onOpenFile?: OpenFileFn;
  cwd?: string;
  fallback?: ReactNode;
  label?: ReactNode;
}) {
  const label = linkLabel ?? `${refData.path}${fileRefLineSuffix(refData)}`;
  const locale = useStore((s) => s.locale);
  const [copied, copyToClipboard] = useCopyToClipboard();
  const { open: openActionsMenu, element: actionsMenu } = useFileActionsMenu();
  const resolvedPath = displayFileRefPath(refData, cwd);

  if (typeof onOpenFile !== 'function') {
    return <>{fallback ?? label}</>;
  }

  // Folding may drop the chip decoration and its thumbnail, but it must never
  // drop the right-click actions — the artifact a long reply folds away is
  // exactly the one the user wants to reveal on disk.
  const openContextMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    openActionsMenu(event, [
      {
        key: 'copy-path',
        label: copied ? t(locale, 'chat.copied') : t(locale, 'chat.copyPath'),
        icon: copied ? (
          <Check size={13} className="shrink-0 text-accent-2" />
        ) : (
          <Copy size={13} className={menuIconClass} />
        ),
        onSelect: () => void copyToClipboard(resolvedPath),
      },
      {
        key: 'preview-in-app',
        label: t(locale, 'chat.previewInApp'),
        icon: <FileCode size={13} className={menuIconClass} />,
        onSelect: () => void onOpenFile(refData),
      },
      {
        key: 'open-containing-folder',
        label: t(locale, 'chat.openContainingFolder'),
        icon: <FolderTree size={13} className={menuIconClass} />,
        onSelect: () => void onOpenFile(refData, { openContainingFolder: true }),
      },
      {
        key: 'reveal-in-folder',
        label: t(locale, 'chat.reveal'),
        icon: <FolderOpen size={13} className={menuIconClass} />,
        onSelect: () => void onOpenFile(refData, { reveal: true }),
      },
    ]);
  };

  return (
    <span className="relative inline-flex max-w-full align-baseline">
      <button
        type="button"
        onClick={() => void onOpenFile(refData)}
        data-file-preview-trigger="true"
        onContextMenu={openContextMenu}
        title={`${displayFileRefLabel(refData, cwd)}\n${t(locale, 'chat.revealHint')}`}
        className="ai-file-chip ai-file-chip--folded ai-file-chip--interactive cursor-pointer"
      >
        <span className="ai-file-chip__label min-w-0 whitespace-normal break-all text-left">
          {label}
        </span>
      </button>
      {actionsMenu}
    </span>
  );
}

export default function FileChip({
  refData,
  onOpenFile,
  cwd,
  overflowFallback,
  thumbnailOnly,
  onRemove,
  label,
}: {
  refData: FileRef;
  onOpenFile?: OpenFileFn;
  cwd?: string;
  overflowFallback?: ReactNode;
  /**
   * Composer preview strip mode: render the thumbnail tile alone, with no path
   * text beside it. The path stays in the textarea, so repeating it in the chip
   * only burns a full row per pasted screenshot.
   */
  thumbnailOnly?: boolean;
  /** Composer preview strip mode: drop this reference from the draft text. */
  onRemove?: () => void;
  /** Preserve a Markdown link's descriptive label for generated deliverables. */
  label?: ReactNode;
}) {
  // Images bypass the chip budget in the message stream: a long AI reply can
  // legitimately carry dozens of code/text references (where the budget
  // prevents an IPC storm), but image thumbnails are the visual payload of
  // the message — folding a screenshot path into a plain text chip hides
  // exactly what the user wants to see. The thumbnail hook downscales in
  // Rust, so the per-image cost is a few KB rather than a full-resolution
  // payload, and real-world replies don't stack hundreds of images the way
  // they stack file paths.
  //
  // The composer strip (`thumbnailOnly`) keeps the budget for images too:
  // pasting 30 screenshots into the draft input would otherwise fill the
  // whole card with thumbnails and push the textarea off-screen.
  const bypass = isImageFileRef(refData) && !thumbnailOnly;
  const slot = useFileChipSlot(bypass);
  if (slot === 'notice') {
    if (label != null) {
      return <><FileChipLimitNotice /><FoldedFileChip refData={refData} onOpenFile={onOpenFile} cwd={cwd} label={label} /></>;
    }
    return overflowFallback ?? <FileChipLimitNotice />;
  }
  if (slot === 'hidden') {
    // Over-budget slots in the composer strip stay invisible: falling back to a
    // raw path chip would reintroduce exactly the wall of path rows the strip
    // replaced. The paths themselves are still in the draft.
    if (thumbnailOnly) return null;
    return (
      <FoldedFileChip
        refData={refData}
        onOpenFile={onOpenFile}
        cwd={cwd}
        fallback={overflowFallback}
        label={label}
      />
    );
  }

  return (
    <VisibleFileChip
      refData={refData}
      onOpenFile={onOpenFile}
      cwd={cwd}
      thumbnailOnly={thumbnailOnly}
      onRemove={onRemove}
      label={label}
    />
  );
}

export function VisibleFileChip({
  refData,
  onOpenFile,
  cwd,
  thumbnailOnly,
  onRemove,
  label,
}: {
  refData: FileRef;
  onOpenFile?: OpenFileFn;
  cwd?: string;
  thumbnailOnly?: boolean;
  onRemove?: () => void;
  label?: ReactNode;
}) {
  const locale = useStore((s) => s.locale);
  const lineSuffix = fileRefLineSuffix(refData);
  // Show the original path from AI output, not the cwd-concatenated one.
  const originalPath = refData.path;
  // Resolved path is still used for existence check, tooltip, and copy.
  const resolvedPath = displayFileRefPath(refData, cwd);
  const pathTitle =
    originalPath === resolvedPath ? resolvedPath : `${originalPath}\n${resolvedPath}`;
  const interactive = typeof onOpenFile === 'function';
  const isImage = isImageFileRef(refData);
  const isDocument = isDocumentFileRef(refData);
  const thumb = useImageThumbnail(isImage ? resolvedPath : null, cwd);
  const existsState = useFileExists(interactive ? resolvedPath : null, cwd);
  const [copied, copyToClipboard] = useCopyToClipboard();
  const {
    open: openActionsMenu,
    close: closeActionsMenu,
    element: actionsMenu,
  } = useFileActionsMenu();
  // Thumbnails load through the backend command previewLocalFile, which uses
  // std::fs and is not restricted by the Tauri fs plugin scope. If a thumbnail
  // successfully loaded, the file definitely exists, even when fs:exists reports
  // missing for paths outside fs:scope-home-recursive (e.g. E:\ on Windows).
  const fileMissing = existsState === 'missing' && thumb.status !== 'ready';

  const openFile = () => {
    closeActionsMenu();
    if (fileMissing) return; // Don't attempt to open a non-existent file.
    // Keep left-click type-aware inside the app. FilePreviewDrawer renders
    // images as images, source/text files as text, and unsupported binaries
    // without delegating the primary click to Windows.
    if (interactive) void onOpenFile(refData);
  };

  const previewInApp = () => {
    if (interactive) void onOpenFile(refData);
  };

  const revealFile = () => {
    if (interactive) void onOpenFile(refData, { reveal: true });
  };

  /**
   * Jump to the folder that contains the file, without selecting the file
   * itself. Distinct from `reveal` — this is the plain "go to this file's
   * directory" action users asked for when a path is only a shortcut to an
   * artifact buried under `.ultragamestudio/…` or a deep asset tree.
   */
  const openContainingFolder = () => {
    if (interactive) void onOpenFile(refData, { openContainingFolder: true });
  };

  const copyPath = () => {
    void copyToClipboard(resolvedPath);
  };

  const openContextMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (!interactive) return;
    openActionsMenu(event, [
      {
        key: 'copy-path',
        label: copied ? t(locale, 'chat.copied') : t(locale, 'chat.copyPath'),
        icon: copied ? (
          <Check size={13} className="shrink-0 text-accent-2" />
        ) : (
          <Copy size={13} className={menuIconClass} />
        ),
        onSelect: copyPath,
      },
      {
        key: 'preview-in-app',
        label: t(locale, 'chat.previewInApp'),
        icon: <FileCode size={13} className={menuIconClass} />,
        onSelect: previewInApp,
      },
      {
        key: 'open-containing-folder',
        label: t(locale, 'chat.openContainingFolder'),
        icon: <FolderTree size={13} className={menuIconClass} />,
        onSelect: openContainingFolder,
      },
      {
        key: 'reveal-in-folder',
        label: t(locale, 'chat.reveal'),
        icon: <FolderOpen size={13} className={menuIconClass} />,
        onSelect: revealFile,
      },
    ]);
  };

  const chipTitle = fileMissing
    ? `${t(locale, 'chat.fileNotFound')}: ${pathTitle}\n${t(locale, 'chat.fileNotFoundHint')}`
    : interactive
      ? `${pathTitle}\n${t(locale, 'chat.revealHint')}`
      : pathTitle;

  // Image references render the path chip PLUS a clickable thumbnail card.
  // UGS requirement: every AI-output document/image path must stay visible as
  // clickable text — a bare thumbnail with no path label reads as "not a file
  // chip" and previously hid the open-in-preview affordance entirely. Both the
  // chip label and the thumbnail route through onOpenFile so the right-side
  // preview drawer opens exactly as before. While the thumbnail loads we show
  // a spinner inside the card; if it can't be loaded (browser mode, missing
  // file) we fall through to just the plain path chip below.
  //
  // `thumbnailOnly` (composer preview strip) keeps the tile and the open
  // affordance but drops the path text: a pasted screenshot path is ~90 chars
  // wide, so one image per row is what made a stack of pastes fill the card.
  // The path stays recoverable via the tooltip and the right-click menu.
  if (isImage && (thumbnailOnly || thumb.status !== 'error')) {
    return (
      <span
        className={
          thumbnailOnly
            ? 'relative inline-flex shrink-0 items-center'
            : 'relative inline-flex max-w-full items-center gap-1.5 align-middle'
        }
      >
        <button
          type="button"
          disabled={!interactive || fileMissing}
          data-file-preview-trigger="true"
          onClick={interactive && !fileMissing ? openFile : undefined}
          onContextMenu={openContextMenu}
          title={
            interactive
              ? `${pathTitle}\n${t(locale, 'chat.revealHint')}`
              : pathTitle
          }
          className={
            'ai-file-chip-thumb group relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-panel-2 ' +
            (thumbnailOnly ? 'h-14 w-14 ' : 'h-[72px] w-[72px] align-middle ') +
            (interactive && !fileMissing ? 'cursor-pointer hover:border-accent' : 'cursor-default') +
            (fileMissing ? ' border-status-error/50' : '')
          }
        >
          {thumb.status === 'ready' ? (
            <img
              src={thumb.url}
              alt={refData.basename}
              loading="lazy"
              className="h-full w-full object-cover"
            />
          ) : thumb.status === 'loading' ? (
            <Loader2 size={16} className="animate-spin text-accent" />
          ) : (
            <ImageOff size={16} className="text-fg-faint" />
          )}
        </button>
        {onRemove && (
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onRemove();
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            title={t(locale, 'common.delete')}
            aria-label={`${t(locale, 'common.delete')}：${refData.basename}`}
            className="absolute right-0.5 top-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full border border-border bg-panel/85 text-fg-dim transition-colors hover:border-status-error/60 hover:text-status-error focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            <X size={10} strokeWidth={3} />
          </button>
        )}
        {!thumbnailOnly && (
          <button
            type="button"
            disabled={!interactive || fileMissing}
            data-file-preview-trigger="true"
            onClick={interactive && !fileMissing ? openFile : undefined}
            onContextMenu={openContextMenu}
            title={chipTitle}
            className={
              'ai-file-chip inline-flex max-w-full items-center gap-1 rounded border border-transparent bg-transparent px-0.5 py-px align-baseline font-mono text-[12px] leading-snug ' +
              (interactive && !fileMissing
                ? 'ai-file-chip--interactive cursor-pointer'
                : 'cursor-default text-fg-dim')
            }
          >
            <span className="ai-file-chip__label min-w-0 whitespace-normal break-all text-left">
              {label ?? originalPath}
              {lineSuffix && (
                <span className={interactive ? 'opacity-75' : 'text-fg-faint'}>
                  {lineSuffix}
                </span>
              )}
            </span>
          </button>
        )}
        {actionsMenu}
      </span>
    );
  }

  return (
    <span className="relative inline-flex max-w-full align-baseline">
      <button
        type="button"
        disabled={!interactive || fileMissing}
        data-file-preview-trigger="true"
        onClick={interactive && !fileMissing ? openFile : undefined}
        onContextMenu={openContextMenu}
        title={chipTitle}
        className={
          'ai-file-chip inline-flex max-w-full items-center gap-1 rounded border border-transparent bg-transparent px-0.5 py-px align-baseline font-mono text-[12px] leading-snug ' +
          (interactive && !fileMissing
            ? 'ai-file-chip--interactive cursor-pointer'
            : 'cursor-default text-fg-dim')
        }
      >
        {!fileMissing && (isImage ? (
          <ImageOff size={11} className="shrink-0 opacity-70" />
        ) : isDocument ? (
          <FileText size={11} className="shrink-0 opacity-70" />
        ) : (
          <FileCode size={11} className="shrink-0 opacity-70" />
        ))}
        <span className="ai-file-chip__label min-w-0 whitespace-normal break-all text-left">
          {label ?? originalPath}
          {lineSuffix && (
            <span className={interactive ? 'opacity-75' : 'text-fg-faint'}>
              {lineSuffix}
            </span>
          )}
        </span>
      </button>
      {actionsMenu}
    </span>
  );
}
