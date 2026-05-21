import { Component } from 'react';
import { RefreshCw, AlertTriangle } from 'lucide-react';

/**
 * ErrorBoundary — global React error boundary.
 * Catches unhandled render errors and shows a graceful recovery UI
 * instead of a blank/white screen.
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary] Uncaught render error:', error, info?.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="rounded-2xl border border-border/40 bg-card p-8 max-w-sm w-full text-center space-y-5 shadow-xl">
          <div className="w-12 h-12 rounded-full bg-destructive/10 border border-destructive/20 flex items-center justify-center mx-auto">
            <AlertTriangle size={20} className="text-destructive" />
          </div>
          <div className="space-y-1.5">
            <h2 className="text-base font-semibold text-foreground">Something went wrong</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              An unexpected error occurred. Reload the page to continue — your session will be preserved.
            </p>
          </div>
          <button
            onClick={() => window.location.reload()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            <RefreshCw size={13} />
            Reload page
          </button>
        </div>
      </div>
    );
  }
}
