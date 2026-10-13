import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, FileWarning, Loader2 } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useStore } from '@/store/useStore';
import { t, tArgs } from '@/lib/i18n';

type PdfState =
  | { status: 'loading' }
  | { status: 'ready'; doc: PDFDocumentProxy }
  | { status: 'error'; message: string };

// pdf.js rasterises on a worker thread. Without a real worker URL it silently
// falls back to the main thread, where one large PDF locks up the whole window,
// so the library and its worker are wired together exactly once.
let pdfJsPromise: Promise<typeof import('pdfjs-dist')> | null = null;

function loadPdfJs(): Promise<typeof import('pdfjs-dist')> {
  pdfJsPromise ??= (async () => {
    const pdfjs = await import('pdfjs-dist');
    const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  })();
  return pdfJsPromise;
}

/**
 * Paged PDF reader. The document is loaded straight from its asset-protocol
 * URL, so pdf.js issues Range requests and only the pages the reader actually
 * visits are fetched and rasterised — a 500-page manual never travels through
 * the IPC bridge as one base64 string.
 */
export default function PdfPreview({ url }: { url: string }) {
  const locale = useStore((s) => s.locale);
  const [state, setState] = useState<PdfState>({ status: 'loading' });
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let disposed = false;
    let loadingTask: { destroy: () => Promise<void> } | null = null;
    setState({ status: 'loading' });
    void loadPdfJs()
      .then((pdfjs) => {
        const task = pdfjs.getDocument({ url });
        loadingTask = task;
        return task.promise;
      })
      .then((doc) => {
        if (disposed) return;
        setPageCount(doc.numPages);
        setPageNumber(1);
        setState({ status: 'ready', doc });
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
      void loadingTask?.destroy();
    };
  }, [url]);

  useEffect(() => {
    if (state.status !== 'ready') return;
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    void (async () => {
      const page = await state.doc.getPage(pageNumber);
      if (cancelled) return;
      const canvas = canvasRef.current;
      const context = canvas?.getContext('2d');
      if (!canvas || !context) return;
      const available = Math.max(320, (containerRef.current?.clientWidth ?? 900) - 32);
      const unscaled = page.getViewport({ scale: 1 });
      const scale = Math.min(available / unscaled.width, 3);
      const viewport = page.getViewport({ scale });
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const renderTask = page.render({
        // pdf.js 6 still supports rendering into an existing 2D context, but
        // only when `canvas` is explicitly null.
        canvas: null,
        canvasContext: context,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      task = renderTask;
      await renderTask.promise;
    })().catch((err: unknown) => {
      const name = (err as { name?: string } | null)?.name;
      if (!cancelled && name !== 'RenderingCancelledException') {
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [state, pageNumber]);

  const goToPage = useCallback(
    (delta: number) => {
      setPageNumber((current) =>
        Math.min(Math.max(1, current + delta), Math.max(1, pageCount)),
      );
    },
    [pageCount],
  );

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

  const navButton =
    'flex h-6 w-6 items-center justify-center rounded border border-border text-fg-dim transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-40';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-center gap-3 border-b border-border-soft px-3 py-1.5 text-xs text-fg-dim">
        <button
          type="button"
          className={navButton}
          onClick={() => goToPage(-1)}
          disabled={pageNumber <= 1}
          title={t(locale, 'doc.prevPage')}
        >
          <ChevronLeft size={13} />
        </button>
        <span className="font-mono tabular-nums">
          {tArgs(locale, 'doc.pageOf', { current: pageNumber, total: pageCount })}
        </span>
        <button
          type="button"
          className={navButton}
          onClick={() => goToPage(1)}
          disabled={pageNumber >= pageCount}
          title={t(locale, 'doc.nextPage')}
        >
          <ChevronRight size={13} />
        </button>
      </div>
      <div
        ref={containerRef}
        className="flex min-h-0 flex-1 justify-center overflow-auto bg-neutral-800 p-4"
      >
        <canvas ref={canvasRef} className="h-fit shadow-lg" />
      </div>
    </div>
  );
}
