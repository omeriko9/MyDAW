/**
 * ApprovalCard (Increment 5) — the compact approval shown before a mutating agent action
 * runs (unless YOLO mode is on). Shows the operations, resolved risk, and Run/Cancel.
 */

import React from "react";
import type { PendingApproval } from "../../agent/useAgentSession";

interface Props {
  pending: PendingApproval;
  onDecide: (decision: "approved" | "denied") => void;
}

export function ApprovalCard({ pending, onDecide }: Props) {
  const { toolName, operations, classification, args } = pending.request;
  const risks: string[] = [];
  if (classification.destructive) risks.push("destructive");
  if (!classification.undoable) risks.push("not undoable");
  if (classification.external) risks.push("external side effects");
  if (classification.fileSystem) risks.push("file system");
  if (!classification.known) risks.push("unrecognized operation");

  return (
    <div className="agent-approval" role="alertdialog" aria-label="Approve agent action">
      <div className="agent-approval-head">Approve action</div>
      <div className="agent-approval-body">
        <div className="agent-approval-tool">{toolName}</div>
        {operations.length > 0 ? (
          <ul className="agent-approval-ops">
            {operations.map((op, i) => (
              <li key={`${op}-${i}`}>{op}</li>
            ))}
          </ul>
        ) : null}
        {risks.length > 0 ? (
          <div className="agent-approval-risk">⚠ {risks.join(" · ")}</div>
        ) : null}
        <details className="agent-approval-args">
          <summary>arguments</summary>
          <pre>{JSON.stringify(args, null, 2)}</pre>
        </details>
      </div>
      <div className="agent-approval-actions">
        <button type="button" className="btn primary" onClick={() => onDecide("approved")}>
          Run plan
        </button>
        <button type="button" className="btn" onClick={() => onDecide("denied")}>
          Cancel
        </button>
      </div>
    </div>
  );
}
