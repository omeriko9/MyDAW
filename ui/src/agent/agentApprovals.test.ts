import { describe, expect, it } from "vitest";
import { AGENT_CATALOG } from "./catalog.gen";
import {
  classifyOperation,
  classifyOperations,
  needsApproval,
} from "./agentApprovals";

describe("classifyOperation", () => {
  it("marks a read-mode operation as non-mutating", () => {
    const readOp = AGENT_CATALOG.operations.find(
      (o) => o.mode === "read" && !o.traits.includes("mutating"),
    );
    expect(readOp).toBeTruthy();
    expect(classifyOperation(readOp!.name).mutating).toBe(false);
  });

  it("marks an undoable command as mutating + undoable", () => {
    const c = classifyOperation("cmd/track.add");
    expect(c).toMatchObject({ mutating: true, undoable: true, known: true });
  });

  it("treats an unknown operation conservatively (mutating + destructive)", () => {
    const c = classifyOperation("cmd/does.notExist");
    expect(c).toMatchObject({ mutating: true, destructive: true, known: false });
  });
});

describe("classifyOperations", () => {
  it("combines a batch to the worst case", () => {
    const c = classifyOperations(["cmd/marker.add", "cmd/does.notExist"]);
    expect(c.mutating).toBe(true);
    expect(c.destructive).toBe(true); // inherited from the unknown op
    expect(c.known).toBe(false);
  });

  it("an empty operation list is non-mutating", () => {
    expect(classifyOperations([]).mutating).toBe(false);
  });
});

describe("needsApproval", () => {
  const mutating = classifyOperation("cmd/track.add");
  const readOnly = { ...mutating, mutating: false };

  it("requires approval for a mutation by default", () => {
    expect(needsApproval(mutating, false)).toBe(true);
  });
  it("skips approval for a mutation under YOLO", () => {
    expect(needsApproval(mutating, true)).toBe(false);
  });
  it("never requires approval for a read-only call", () => {
    expect(needsApproval(readOnly, false)).toBe(false);
  });
});
