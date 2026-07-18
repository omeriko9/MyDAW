import { describe, expect, it } from "vitest";

import {
  AGENT_CATALOG,
  AGENT_CATALOG_SHA256,
  BATCHABLE_OPERATION_NAMES,
  ENGINE_OPERATION_NAMES,
  REQUEST_COVERAGE,
  UI_OPERATION_NAMES,
} from "./catalog.gen";

const REQUEST_TYPES = [
  "session/hello",
  "session/newWindow",
  "project/new",
  "project/load",
  "project/save",
  "project/saveAs",
  "project/loadRecent",
  "project/recoveryInfo",
  "project/recover",
  "project/getImportFormats",
  "project/importForeign",
  "project/getUnresolvedPlugins",
  "dialog/saveProject",
  "dialog/openProject",
  "dialog/importProject",
  "dialog/importFiles",
  "cmd/track.add",
  "cmd/track.remove",
  "cmd/track.reorder",
  "cmd/track.set",
  "cmd/track.setEq",
  "cmd/track.addSend",
  "cmd/track.removeSend",
  "cmd/track.setSend",
  "cmd/track.bounce",
  "cmd/track.unfreeze",
  "cmd/track.duplicate",
  "cmd/clip.addMidi",
  "cmd/clip.addAudio",
  "cmd/clip.move",
  "cmd/clip.resize",
  "cmd/clip.split",
  "cmd/clip.join",
  "cmd/clip.delete",
  "cmd/clip.duplicate",
  "cmd/clip.set",
  "cmd/notes.edit",
  "cmd/notes.quantize",
  "cmd/cc.edit",
  "cmd/automation.set",
  "cmd/marker.add",
  "cmd/marker.set",
  "cmd/marker.remove",
  "cmd/tempo.set",
  "cmd/timesig.set",
  "cmd/tempoMap.set",
  "cmd/timeSigMap.set",
  "cmd/loop.set",
  "cmd/grid.set",
  "edit/undo",
  "edit/redo",
  "transport/play",
  "transport/stop",
  "transport/pause",
  "transport/record",
  "transport/locate",
  "transport/setMetronome",
  "transport/setAutomationWrite",
  "engine/getDevices",
  "engine/setAudioConfig",
  "engine/getStatus",
  "engine/panic",
  "engine/getLog",
  "midi/getInputs",
  "midi/setInputEnabled",
  "midi/preview",
  "media/import",
  "media/relink",
  "export/render",
  "export/midi",
  "export/trackArchive",
  "export/cpr",
  "plugins/scan",
  "plugins/getRegistry",
  "plugins/setFolders",
  "plugins/getFolders",
  "plugins/getDefaultFolders",
  "plugins/unblacklist",
  "plugins/recreate",
  "cmd/plugin.add",
  "cmd/plugin.remove",
  "cmd/plugin.move",
  "cmd/plugin.set",
  "cmd/plugin.setParam",
  "cmd/plugin.setSample",
  "cmd/vca.add",
  "cmd/vca.remove",
  "cmd/vca.set",
  "cmd/clip.stretch",
  "cmd/clip.processAudio",
  "cmd/take.create",
  "cmd/take.setComp",
  "cmd/take.flatten",
  "midimap/learn",
  "midimap/remove",
  "midimap/feedCc",
  "plugin/getParams",
  "plugin/getPresets",
  "plugin/loadPreset",
  "plugin/savePreset",
  "plugin/openEditor",
  "plugin/closeEditor",
  "settings/get",
  "settings/set",
] as const;

const UI_OPERATION_TYPES = [
  "ui/dialog.set",
  "ui/edit.invoke",
  "ui/entity.reveal",
  "ui/focus.set",
  "ui/follow.set",
  "ui/layout.set",
  "ui/midi.transform",
  "ui/pluginEditor.set",
  "ui/selection.get",
  "ui/selection.set",
  "ui/theme.set",
  "ui/tool.set",
  "ui/viewport.set",
] as const;

/** RequestMap entries deliberately kept OUT of the agent catalog (see requestExclusions). */
const EXCLUDED_REQUESTS = [
  "session/hello",
  "session/newWindow",
  "export/trackArchive",
  "export/cpr",
] as const;
const ENGINE_REQUEST_TYPES = REQUEST_TYPES.filter(
  (name) => !EXCLUDED_REQUESTS.includes(name as (typeof EXCLUDED_REQUESTS)[number]),
);

const byCodePoint = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const operation = (name: string) => {
  const result = AGENT_CATALOG.operations.find((candidate) => candidate.name === name);
  expect(result, `missing catalog operation ${name}`).toBeDefined();
  return result!;
};

type JsonSchema = {
  $ref?: string;
  type?: string | readonly string[];
  const?: unknown;
  enum?: readonly unknown[];
  anyOf?: readonly JsonSchema[];
  allOf?: readonly JsonSchema[];
  oneOf?: readonly JsonSchema[];
  not?: JsonSchema;
  properties?: Readonly<Record<string, JsonSchema>>;
  required?: readonly string[];
  additionalProperties?: boolean | JsonSchema;
  minProperties?: number;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
};

const schemas = AGENT_CATALOG.schemas as unknown as Readonly<Record<string, JsonSchema>>;

const deepEqual = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/** Small independent validator for the JSON Schema vocabulary used by catalog examples. */
const accepts = (schema: JsonSchema, value: unknown): boolean => {
  if (schema.$ref) {
    const prefix = "#/schemas/";
    if (!schema.$ref.startsWith(prefix)) return false;
    const referenced = schemas[schema.$ref.slice(prefix.length)];
    return referenced !== undefined && accepts(referenced, value);
  }
  if (schema.anyOf && !schema.anyOf.some((branch) => accepts(branch, value))) return false;
  if (schema.allOf && !schema.allOf.every((branch) => accepts(branch, value))) return false;
  if (schema.oneOf && schema.oneOf.filter((branch) => accepts(branch, value)).length !== 1) {
    return false;
  }
  if (schema.not && accepts(schema.not, value)) return false;
  if (schema.const !== undefined && !deepEqual(value, schema.const)) return false;
  if (schema.enum && !schema.enum.some((candidate) => deepEqual(candidate, value))) return false;

  const types = schema.type === undefined
    ? []
    : (Array.isArray(schema.type) ? schema.type : [schema.type]);
  if (types.length > 0 && !types.some((type) => {
    if (type === "null") return value === null;
    if (type === "array") return Array.isArray(value);
    if (type === "object") return typeof value === "object" && value !== null && !Array.isArray(value);
    if (type === "number") return typeof value === "number" && Number.isFinite(value);
    return typeof value === type;
  })) return false;

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (schema.minProperties !== undefined && entries.length < schema.minProperties) return false;
    if (schema.required?.some((key) => !Object.hasOwn(value, key))) return false;
    for (const [key, child] of entries) {
      const propertySchema = schema.properties?.[key];
      if (propertySchema) {
        if (!accepts(propertySchema, child)) return false;
      } else if (schema.additionalProperties === false) {
        return false;
      } else if (typeof schema.additionalProperties === "object"
        && !accepts(schema.additionalProperties, child)) {
        return false;
      }
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.uniqueItems
      && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) return false;
    if (schema.items && value.some((item) => !accepts(schema.items!, item))) return false;
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return false;
    if (schema.maximum !== undefined && value > schema.maximum) return false;
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) return false;
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) return false;
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) return false;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return false;
  }
  return true;
};

describe("generated agent capability catalog", () => {
  it("covers the complete engine and typed UI surfaces exactly once", () => {
    expect(AGENT_CATALOG).toMatchObject({
      $schema: "./capabilities.schema.json",
      formatVersion: 1,
      schemaDialect: "https://json-schema.org/draft/2020-12/schema",
    });
    expect(ENGINE_OPERATION_NAMES).toHaveLength(100);
    expect(UI_OPERATION_NAMES).toHaveLength(13);
    expect(AGENT_CATALOG.operations).toHaveLength(113);

    const names = AGENT_CATALOG.operations.map(({ name }) => name);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(ENGINE_OPERATION_NAMES).size).toBe(ENGINE_OPERATION_NAMES.length);
    expect(new Set(UI_OPERATION_NAMES).size).toBe(UI_OPERATION_NAMES.length);
    expect(ENGINE_OPERATION_NAMES).toEqual([...ENGINE_REQUEST_TYPES].sort(byCodePoint));
    expect(UI_OPERATION_NAMES).toEqual(UI_OPERATION_TYPES);
    expect([...ENGINE_OPERATION_NAMES, ...UI_OPERATION_NAMES].sort(byCodePoint)).toEqual(names);
  });

  it("emits the exact RequestMap coverage shape, including the explicit exclusions", () => {
    expect(Object.keys(REQUEST_COVERAGE)).toEqual(REQUEST_TYPES);
    expect(REQUEST_COVERAGE["session/hello"]).toEqual({
      kind: "excluded",
      reason: "Connection bootstrap returns a large unbounded session snapshot and is not an agent action.",
      use: "Use mydaw_context and bounded mydaw_query views for session, project, engine, transport, registry, and recent-project state.",
    });
    expect(REQUEST_COVERAGE["session/newWindow"]).toEqual({
      kind: "excluded",
      reason: "Spawns a detached second engine process + opens a browser tab; an app/window-management action, not a project edit.",
      use: "This is a UI window action (File > New Window), not an agent capability.",
    });
    expect(AGENT_CATALOG.requestExclusions).toEqual(
      EXCLUDED_REQUESTS.map((request) => ({
        request,
        reason: (REQUEST_COVERAGE[request] as { reason: string }).reason,
        use: (REQUEST_COVERAGE[request] as { use: string }).use,
      })),
    );

    for (const requestType of ENGINE_REQUEST_TYPES) {
      expect(REQUEST_COVERAGE[requestType]).toEqual({
        kind: "operation",
        operation: requestType,
      });
    }
  });

  it("keeps all generated views in canonical deterministic order", () => {
    const engineNames = AGENT_CATALOG.operations
      .filter(({ target }) => target !== "ui")
      .map(({ name }) => name);
    const uiNames = AGENT_CATALOG.operations
      .filter(({ target }) => target === "ui")
      .map(({ name }) => name);

    expect(ENGINE_OPERATION_NAMES).toEqual(engineNames);
    expect(UI_OPERATION_NAMES).toEqual(uiNames);
    expect(BATCHABLE_OPERATION_NAMES).toEqual(
      AGENT_CATALOG.operations
        .filter(({ target, supports }) => target === "command" && supports.includes("batch"))
        .map(({ name }) => name),
    );
    expect(AGENT_CATALOG.operations.map(({ name }) => name)).toEqual(
      [...AGENT_CATALOG.operations.map(({ name }) => name)].sort(byCodePoint),
    );
    expect(AGENT_CATALOG_SHA256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("preserves representative metadata, schemas, and valid examples", () => {
    expect(operation("project/getImportFormats")).toMatchObject({
      category: "project",
      target: "engine",
      mode: "read",
      traits: ["idempotent"],
      supports: [],
      input: { $ref: "#/schemas/EmptyObject" },
      output: { $ref: "#/schemas/GetImportFormatsReply" },
      examples: [{ input: {} }],
    });
    expect(operation("cmd/track.add")).toMatchObject({
      category: "tracks",
      target: "command",
      mode: "write",
      traits: ["mutating", "undoable"],
      supports: ["batch", "dryRun"],
      requires: ["project"],
      produces: ["track.id"],
      input: { $ref: "#/schemas/TrackAddRequest" },
      output: { $ref: "#/schemas/TrackAddReply" },
      examples: [{
        input: { kind: "instrument", name: "Agent Synth", channels: 2 },
      }],
    });
    expect(operation("cmd/track.remove")).toMatchObject({
      target: "command",
      mode: "write",
      traits: expect.arrayContaining(["undoable", "destructive"]),
    });
    expect(operation("dialog/importFiles")).toMatchObject({
      target: "engine",
      mode: "write",
      traits: ["mutating", "external"],
      supports: [],
    });
    expect(operation("ui/selection.get")).toMatchObject({
      target: "ui",
      mode: "read",
      traits: expect.arrayContaining(["idempotent", "ui-only"]),
    });
    expect(operation("ui/midi.transform")).toMatchObject({
      target: "ui",
      mode: "write",
      traits: expect.arrayContaining(["ui-only"]),
      examples: expect.arrayContaining([expect.any(Object)]),
    });
    expect(schemas.TrackAddRequest).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: {
        kind: { $ref: "#/schemas/AddableTrackKind" },
        channels: { type: "number", enum: [1, 2] },
      },
    });

    for (const candidate of AGENT_CATALOG.operations) {
      expect(candidate.description.trim().length).toBeGreaterThan(0);
      expect(candidate.description.length).toBeLessThanOrEqual(160);
      expect(candidate.examples.length).toBeGreaterThan(0);
      for (const example of candidate.examples as readonly unknown[]) {
        const input = typeof example === "object" && example !== null
          && Object.hasOwn(example, "input")
          ? (example as { input: unknown }).input
          : example;
        expect(
          accepts(candidate.input as unknown as JsonSchema, input),
          `${candidate.name} has an example that does not match its input schema`,
        ).toBe(true);
      }
    }
  });
});
