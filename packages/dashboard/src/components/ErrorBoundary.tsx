import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Top-level safety net. Without this, any uncaught exception in any
 * child component empties the whole React tree → black screen with
 * no clue. This catches the throw, surfaces the error + stack
 * inline, and offers a Reload button so the user is never stranded.
 *
 * The dashboard polls the API every couple of seconds; most
 * crashes here are caused by a transient malformed snapshot, so a
 * Reload typically gets things back.
 */
interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ info });
    // Keep a copy on window so DevTools / external logger can grab it.
    (window as unknown as { __lastDashboardError?: { error: Error; info: ErrorInfo } }).__lastDashboardError = { error, info };
  }

  private readonly reload = (): void => { window.location.reload(); };

  private readonly clear = (): void => { this.setState({ error: null, info: null }); };

  render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="min-h-screen bg-bg text-text p-6 font-mono">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-lg font-semibold text-node-stopped mb-2">
            Dashboard caught a render error
          </h1>
          <p className="text-text-muted text-xs mb-4">
            The error below stopped the React tree. The API and bus are
            usually still healthy — Reload normally recovers.
          </p>

          <div className="bg-surface-raised border border-node-stopped/40 rounded p-4 mb-4">
            <div className="text-sm text-node-stopped font-semibold mb-2">
              {error.name}: {error.message}
            </div>
            {error.stack && (
              <pre className="text-[11px] text-text-muted whitespace-pre-wrap break-words">
                {error.stack}
              </pre>
            )}
          </div>

          {info?.componentStack && (
            <div className="bg-surface-raised border border-border rounded p-4 mb-4">
              <div className="text-xs text-text-muted uppercase tracking-wide mb-2">
                Component stack
              </div>
              <pre className="text-[11px] text-text-muted whitespace-pre-wrap break-words">
                {info.componentStack}
              </pre>
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={this.reload}
              className="px-4 py-2 text-sm font-medium rounded-md bg-accent text-white hover:bg-accent-hover transition-colors"
            >
              Reload
            </button>
            <button
              onClick={this.clear}
              className="px-4 py-2 text-sm text-text-muted hover:text-text rounded-md transition-colors"
            >
              Try to dismiss (may re-trigger)
            </button>
          </div>
        </div>
      </div>
    );
  }
}
