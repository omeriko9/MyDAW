/**
 * Panel error boundary (moved out of App.tsx for the shells) — a crashing pane must
 * not kill the shell. Every pane slot in every shell wraps its pane in one of these.
 */

import React from "react";
import { Icon } from "../components/common/icons";

interface BoundaryProps {
  name: string;
  children: React.ReactNode;
}

interface BoundaryState {
  error: Error | null;
}

export class PanelBoundary extends React.Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(`[shell] ${this.props.name} panel crashed:`, error, info.componentStack);
  }

  override render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="app-panel-error">
          <span className="icon-warn">
            <Icon name="warning" size={22} />
          </span>
          <div>{this.props.name} crashed</div>
          <div className="faint" style={{ fontSize: 11, maxWidth: 360 }}>
            {this.state.error.message}
          </div>
          <button type="button" className="btn" onClick={() => this.setState({ error: null })}>
            Reload panel
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
