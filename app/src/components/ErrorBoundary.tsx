import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Surfaces render-time exceptions on screen instead of letting React unmount
 * the subtree silently. In a packaged WebView2 build there is no DevTools to
 * read the console, so a panel that throws during render would otherwise leave
 * the last-painted (now detached) DOM on screen — inputs look present but no
 * React handler fires, which reads to the user as "the keyboard is dead".
 *
 * Wrapping a panel in this boundary turns that invisible failure into a visible,
 * copyable error report.
 */
interface ErrorBoundaryProps {
  /** Short label for the region being guarded, shown in the fallback. */
  label?: string;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  info: string | null;
}

export default class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null, info: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ error, info: info.componentStack ?? null });
    // Still log for environments that do have a console attached.
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', this.props.label ?? '', error, info);
  }

  private reset = (): void => {
    this.setState({ error: null, info: null });
  };

  render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    const detail = [
      `${error.name}: ${error.message}`,
      error.stack ?? '',
      info ? `\nComponent stack:${info}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    return (
      <div className="space-y-3 rounded-lg border border-status-error/40 bg-status-error/10 p-4">
        <div className="text-sm font-semibold text-status-error">
          {this.props.label
            ? `「${this.props.label}」渲染出错 / failed to render`
            : '渲染出错 / failed to render'}
        </div>
        <p className="text-[11px] leading-relaxed text-status-error/80">
          这一部分崩溃了，所以它的输入框无法使用。下面是具体错误，请反馈给开发者。
        </p>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded border border-status-error/30 bg-black/30 p-2 font-mono text-[10px] leading-relaxed text-status-error">
          {detail}
        </pre>
        <button
          type="button"
          onClick={this.reset}
          className="inline-flex items-center rounded border border-status-error/40 bg-status-error/10 px-2.5 py-1 text-xs text-status-error transition-colors hover:bg-status-error/20"
        >
          重试 / Retry
        </button>
      </div>
    );
  }
}
