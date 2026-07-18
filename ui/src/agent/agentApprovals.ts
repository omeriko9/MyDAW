/**
 * Approval classification for agent tool calls (Increment 4).
 *
 * Read-only calls run automatically; every mutation pauses at an approval unless YOLO mode
 * is on. Risk is derived from the canonical catalog traits so the classification cannot
 * drift from what the engine will actually do.
 */

import { AGENT_CATALOG } from "./catalog.gen";
import type { OperationClassification } from "./agentTypes";

const OP_BY_NAME = new Map(AGENT_CATALOG.operations.map((op) => [op.name, op]));

/** Classify a single catalog operation by name. Unknown names are treated conservatively. */
export function classifyOperation(name: string): OperationClassification {
  const op = OP_BY_NAME.get(name);
  if (!op) {
    // Unknown operation: assume the worst so it cannot slip past an approval.
    return {
      mutating: true,
      undoable: false,
      destructive: true,
      external: false,
      fileSystem: false,
      uiOnly: false,
      known: false,
    };
  }
  const traits = new Set(op.traits);
  return {
    mutating: traits.has("mutating") || op.mode === "write",
    undoable: traits.has("undoable"),
    destructive: traits.has("destructive"),
    external: traits.has("external") || traits.has("asynchronous"),
    fileSystem: traits.has("filesystem"),
    uiOnly: traits.has("ui-only") || op.target === "ui",
    known: true,
  };
}

/** Combine the classifications of every operation in a batch into one worst-case result. */
export function classifyOperations(names: string[]): OperationClassification {
  if (names.length === 0) {
    return {
      mutating: false,
      undoable: true,
      destructive: false,
      external: false,
      fileSystem: false,
      uiOnly: false,
      known: true,
    };
  }
  return names.map(classifyOperation).reduce((a, b) => ({
    mutating: a.mutating || b.mutating,
    undoable: a.undoable && b.undoable,
    destructive: a.destructive || b.destructive,
    external: a.external || b.external,
    fileSystem: a.fileSystem || b.fileSystem,
    uiOnly: a.uiOnly && b.uiOnly,
    known: a.known && b.known,
  }));
}

/**
 * Whether a call with this classification must pause for user approval. Read-only calls
 * never do; YOLO mode bypasses mutation approvals (but classification still drives the
 * warning surfaced to the user).
 */
export function needsApproval(
  classification: OperationClassification,
  yolo: boolean,
): boolean {
  if (!classification.mutating) return false;
  return !yolo;
}
