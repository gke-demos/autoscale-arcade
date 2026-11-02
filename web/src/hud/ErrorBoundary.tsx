import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  label?: string;
  /** Rendered inside the R3F canvas? Then we must not emit DOM. */
  canvas?: boolean;
}
interface State {
  error?: Error;
}

/** Keeps one broken cabinet from taking the whole kiosk down; shows the error honestly. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = {};
  static getDerivedStateFromError(error: Error): State {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.label ?? 'ui'}]`, error, info.componentStack);
  }
  componentDidUpdate(prev: Props) {
    if (prev.children !== this.props.children && this.state.error) this.setState({ error: undefined });
  }
  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.canvas) return null;
    return (
      <div className="panel m-2 border-red-400/50 p-3 font-mono text-[0.8rem] text-red-200">
        <div className="font-bold">⚠ {this.props.label ?? 'UI'} crashed</div>
        <pre className="mt-1 whitespace-pre-wrap text-[0.7rem] text-red-100/80">{String(this.state.error?.stack ?? this.state.error)}</pre>
      </div>
    );
  }
}
