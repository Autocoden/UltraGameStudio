import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, FileWarning, Loader2 } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { previewOfficeDocument, type OfficePreview } from '@/lib/tauri';
import { useStore } from '@/store/useStore';
import { t, tArgs } from '@/lib/i18n';

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Rendered inside the sandboxed preview iframe; keeps the extracted OOXML
 *  readable without pulling a stylesheet into the app bundle. */
const OFFICE_STYLE = [
  'body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.6;color:#1a1a1a;}',
  'h2{font-size:15px;font-weight:600;margin:0 0 12px;padding-bottom:8px;border-bottom:1px solid #e2e2e2;}',
  'p{margin:0 0 8px;white-space:pre-wrap;}',
  'table{border-collapse:collapse;font-size:12px;}',
  'td,th{border:1px solid #d8d8d8;padding:4px 8px;vertical-align:top;}',
  'th.preview-row-number{background:#f4f4f4;color:#8a8a8a;text-align:right;font-weight:400;width:44px;}',
  '.preview-empty{color:#8a8a8a;font-size:12px;}',
].join('');

type OfficeState =
  | { status: 'loading' }
  | { status: 'docx'; html: string }
  | { status: 'paged'; preview: OfficePreview }
  | { status: 'error'; message: string };

function wrapOfficeHtml(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${OFFICE_STYLE}</style></head><body>${body}</body></html>`;
}

/**
 * Word/PowerPoint/Excel preview.
 *
 * DOCX has no fixed pagination, so it still renders as one flowed document —
 * but the bytes are fetched from the asset protocol instead of arriving as a
 * base64 IPC payload. PPTX/XLSX are paged in Rust, which reads only the leading
 * slides/sheets out of the zip container.
 */
export default function OfficePreviewPane({
  path,
  streamPath,
  mime,
  fileName,
}: {
  path: string;
  streamPath?: string | null;
  mime: string;
  fileName: string;
}) {
  const locale = useStore((s) => s.locale);
  const [state, setState] = useState<OfficeState>({ status: 'loading' });
  const [pageNumber, setPageNumber] = useState(1);

  useEffect(() => {
    let disposed = false;
    setState({ status: 'loading' });
    setPageNumber(1);

    if (mime === DOCX_MIME) {
      const source = streamPath ? convertFileSrc(streamPath) : null;
      if (!source) {
        setState({ status: 'error', message: t(locale, 'doc.decodeFailed') });
        return;
      }
      void fetch(source)
        .then((response) => {
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          return response.arrayBuffer();
        })
        .then((buffer) => import('mammoth/mammoth.browser').then((mammoth) =>
          mammoth.convertToHtml({ arrayBuffer: buffer }),
        ))
        .then((result) => {
          if (!disposed) setState({ status: 'docx', html: result.value });
        })
        .catch((err: unknown) => {
          if (!disposed) {
            setState({
              status: 'error',
              message: err instanceof Error ? err.message : String(err),
            });
          }
        });
      return () => {
        disposed = true;
      };
    }

    void previewOfficeDocument(streamPath || path)
      .then((preview) => {
        if (!disposed) setState({ status: 'paged', preview });
      })
      .catch((err: unknown) => {
        if (!disposed) {
          setState({
            status: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      disposed = true;
    };
  }, [locale, mime, path, streamPath]);

  if (state.status === 'loading') {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-fg-dim">
        <Loader2 size={16} className="animate-spin text-accent" />
        {t(locale, 'doc.rendering')}
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div className="max-w-md rounded-md border border-status-error/40 bg-status-error/10 p-4 text-sm leading-relaxed text-fg-dim">
          <div className="mb-2 flex items-center gap-2 font-medium text-status-error">
            <FileWarning size={16} />
            {t(locale, 'doc.cannotRender')}
          </div>
          {state.message}
        </div>
      </div>
    );
  }

  if (state.status === 'docx') {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-white">
        <iframe
          title={fileName}
          sandbox=""
          srcDoc={wrapOfficeHtml(state.html)}
          className="min-h-0 flex-1 border-0 bg-white"
        />
      </div>
    );
  }

  const { preview } = state;
  const total = Math.max(1, preview.pages.length);
  const current = preview.pages[Math.min(pageNumber, total) - 1];
  const navButton =
    'flex h-6 w-6 items-center justify-center rounded border border-border text-fg-dim transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-40';

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <div className="flex shrink-0 items-center justify-center gap-3 border-b border-border-soft bg-panel px-3 py-1.5 text-xs text-fg-dim">
        <button
          type="button"
          className={navButton}
          onClick={() => setPageNumber((value) => Math.max(1, value - 1))}
          disabled={pageNumber <= 1}
          title={t(locale, 'doc.prevPage')}
        >
          <ChevronLeft size={13} />
        </button>
        <span className="font-mono tabular-nums">
          {tArgs(locale, 'doc.pageOf', { current: pageNumber, total })}
        </span>
        <button
          type="button"
          className={navButton}
          onClick={() => setPageNumber((value) => Math.min(total, value + 1))}
          disabled={pageNumber >= total}
          title={t(locale, 'doc.nextPage')}
        >
          <ChevronRight size={13} />
        </button>
        {preview.truncated && (
          <span className="text-fg-faint">
            {tArgs(locale, 'doc.truncatedPages', {
              shown: preview.pages.length,
              total: preview.pageCount,
            })}
          </span>
        )}
      </div>
      <iframe
        title={`${fileName} · ${current?.index ?? 1}`}
        sandbox=""
        srcDoc={wrapOfficeHtml(current?.html ?? '')}
        className="min-h-0 flex-1 border-0 bg-white"
      />
    </div>
  );
}
