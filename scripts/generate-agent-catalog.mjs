#!/usr/bin/env node

// Canonical MyDAW agent-catalog validator and code generator.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG_PATH = resolve(ROOT, "shared/agent/capabilities.json");
const META_SCHEMA_PATH = resolve(ROOT, "shared/agent/capabilities.schema.json");
const PROMPTS_PATH = resolve(ROOT, "shared/agent/prompts.json");
const TYPES_PATH = resolve(ROOT, "ui/src/protocol/types.ts");
const TS_OUTPUT = resolve(ROOT, "ui/src/agent/catalog.gen.ts");
const TS_PROMPTS_OUTPUT = resolve(ROOT, "ui/src/agent/prompts.gen.ts");
const CPP_HEADER_OUTPUT = resolve(ROOT, "engine/src/agent/AgentCatalog.gen.h");
const CPP_SOURCE_OUTPUT = resolve(ROOT, "engine/src/agent/AgentCatalog.gen.cpp");
const CHECK = process.argv.includes("--check");

const fail = (message) => {
  throw new Error("[agent-catalog] " + message);
};

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail("cannot parse " + file + ": " + error.message);
  }
};

const catalog = readJson(CATALOG_PATH);
readJson(META_SCHEMA_PATH); // syntax check; structural checks below are intentionally stricter.
const prompts = readJson(PROMPTS_PATH);

const normalizedJson = JSON.stringify(catalog, null, 2) + "\n";
const catalogHash = createHash("sha256").update(normalizedJson).digest("hex");

// Prepared agent scripts (exposed via MCP prompts/list|get and, later, the in-app
// Scripts menu). Validated here so a malformed prompt set fails the build/drift gate
// exactly like the capability catalog.
const validatePrompts = () => {
  if (!isObject(prompts)) fail("prompts root must be an object");
  if (prompts.formatVersion !== 1) fail("prompts.formatVersion must be 1");
  if (!Array.isArray(prompts.prompts) || prompts.prompts.length === 0) {
    fail("prompts.prompts must be a non-empty array");
  }
  const ids = [];
  for (const [index, entry] of prompts.prompts.entries()) {
    const location = "prompts.prompts[" + index + "]";
    if (!isObject(entry)) fail(location + " must be an object");
    for (const key of Object.keys(entry)) {
      if (!["id", "title", "category", "prompt", "tags"].includes(key)) {
        fail(location + " has unsupported key " + key);
      }
    }
    if (typeof entry.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(entry.id)) {
      fail(location + ".id must be a kebab-case slug");
    }
    if (typeof entry.title !== "string" || !entry.title.trim() || entry.title.length > 80) {
      fail(location + ".title must contain 1..80 characters");
    }
    if (
      typeof entry.category !== "string" ||
      !entry.category.trim() ||
      entry.category.length > 40
    ) {
      fail(location + ".category must contain 1..40 characters");
    }
    if (typeof entry.prompt !== "string" || !entry.prompt.trim() || entry.prompt.length > 4000) {
      fail(location + ".prompt must contain 1..4000 characters");
    }
    if (
      entry.tags !== undefined &&
      (!Array.isArray(entry.tags) || entry.tags.some((tag) => typeof tag !== "string" || !tag))
    ) {
      fail(location + ".tags must be a string array");
    }
    ids.push(entry.id);
  }
  if (!unique(ids)) fail("prompt ids must be unique");
};

const compareCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const unique = (values) => new Set(values).size === values.length;
const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const supportedSchemaKeys = new Set([
  "$ref",
  "$schema",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "default",
  "description",
  "enum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "items",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "not",
  "oneOf",
  "pattern",
  "properties",
  "required",
  "type",
  "uniqueItems",
]);

const visitSchema = (schema, location, visitor, seen = new Set()) => {
  if (!isObject(schema)) fail(location + " must be a JSON Schema object");
  if (seen.has(schema)) return;
  seen.add(schema);
  for (const key of Object.keys(schema)) {
    if (!supportedSchemaKeys.has(key)) fail(location + " uses unsupported keyword " + key);
  }
  visitor(schema, location);
  if (schema.properties !== undefined) {
    if (!isObject(schema.properties)) fail(location + ".properties must be an object");
    for (const [name, child] of Object.entries(schema.properties)) {
      visitSchema(child, location + ".properties." + name, visitor, seen);
    }
  }
  for (const key of ["items", "not"]) {
    if (schema[key] !== undefined) visitSchema(schema[key], location + "." + key, visitor, seen);
  }
  if (isObject(schema.additionalProperties)) {
    visitSchema(
      schema.additionalProperties,
      location + ".additionalProperties",
      visitor,
      seen,
    );
  } else if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== "boolean"
  ) {
    fail(location + ".additionalProperties must be boolean or a schema");
  }
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    if (schema[key] === undefined) continue;
    if (!Array.isArray(schema[key]) || schema[key].length === 0) {
      fail(location + "." + key + " must be a non-empty array");
    }
    schema[key].forEach((child, index) =>
      visitSchema(child, location + "." + key + "[" + index + "]", visitor, seen),
    );
  }
};

const refName = (ref, location) => {
  const prefix = "#/schemas/";
  if (typeof ref !== "string" || !ref.startsWith(prefix) || ref.length === prefix.length) {
    fail(location + " has unsupported reference " + JSON.stringify(ref));
  }
  const name = ref.slice(prefix.length);
  if (!Object.hasOwn(catalog.schemas, name)) fail(location + " references missing schema " + name);
  return name;
};

const validateSchema = (schema, location) => {
  visitSchema(schema, location, (node, nodeLocation) => {
    if (node.$ref !== undefined) refName(node.$ref, nodeLocation);
    if (
      node.type !== undefined &&
      typeof node.type !== "string" &&
      !(Array.isArray(node.type) && node.type.every((item) => typeof item === "string"))
    ) {
      fail(nodeLocation + ".type must be a string or string array");
    }
    if (
      node.required !== undefined &&
      (!Array.isArray(node.required) || !node.required.every((item) => typeof item === "string"))
    ) {
      fail(nodeLocation + ".required must be a string array");
    }
  });
};

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const accepts = (schema, value, depth = 0) => {
  if (depth > 128) return false;
  if (schema.$ref) return accepts(catalog.schemas[refName(schema.$ref, "example")], value, depth + 1);
  if (schema.allOf && !schema.allOf.every((item) => accepts(item, value, depth + 1))) return false;
  if (schema.anyOf && !schema.anyOf.some((item) => accepts(item, value, depth + 1))) return false;
  if (
    schema.oneOf &&
    schema.oneOf.filter((item) => accepts(item, value, depth + 1)).length !== 1
  ) {
    return false;
  }
  if (schema.not && accepts(schema.not, value, depth + 1)) return false;
  if (schema.const !== undefined && !sameJson(schema.const, value)) return false;
  if (schema.enum && !schema.enum.some((item) => sameJson(item, value))) return false;

  const types = schema.type === undefined
    ? []
    : Array.isArray(schema.type)
      ? schema.type
      : [schema.type];
  if (
    types.length > 0 &&
    !types.some((type) => {
      if (type === "null") return value === null;
      if (type === "array") return Array.isArray(value);
      if (type === "object") return isObject(value);
      if (type === "integer") return Number.isInteger(value);
      if (type === "number") return typeof value === "number" && Number.isFinite(value);
      return typeof value === type;
    })
  ) {
    return false;
  }

  if (isObject(value)) {
    const entries = Object.entries(value);
    if (schema.minProperties !== undefined && entries.length < schema.minProperties) return false;
    if (schema.maxProperties !== undefined && entries.length > schema.maxProperties) return false;
    if (schema.required?.some((key) => !Object.hasOwn(value, key))) return false;
    for (const [key, child] of entries) {
      const childSchema = schema.properties?.[key];
      if (childSchema) {
        if (!accepts(childSchema, child, depth + 1)) return false;
      } else if (schema.additionalProperties === false) {
        return false;
      } else if (
        isObject(schema.additionalProperties) &&
        !accepts(schema.additionalProperties, child, depth + 1)
      ) {
        return false;
      }
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      return false;
    }
    if (schema.items && value.some((item) => !accepts(schema.items, item, depth + 1))) return false;
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
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) return false;
  }
  return true;
};

const extractRequestTypes = () => {
  const source = readFileSync(TYPES_PATH, "utf8");
  const match = source.match(/export interface RequestMap\s*\{([\s\S]*?)^\}/m);
  if (!match) fail("cannot locate RequestMap in ui/src/protocol/types.ts");
  const names = [...match[1].matchAll(/^\s*"([^"]+)"\s*:/gm)].map((item) => item[1]);
  if (names.length === 0 || !unique(names)) fail("RequestMap extraction was empty or duplicated");
  return names;
};

const expectedUiOperations = [
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
].sort(compareCodePoint);

const validateCatalog = () => {
  if (!isObject(catalog)) fail("catalog root must be an object");
  if (catalog.formatVersion !== 1) fail("formatVersion must be 1");
  if (catalog.schemaDialect !== "https://json-schema.org/draft/2020-12/schema") {
    fail("schemaDialect must be JSON Schema draft 2020-12");
  }
  if (!isObject(catalog.schemas)) fail("schemas must be an object");
  if (!Array.isArray(catalog.operations)) fail("operations must be an array");
  if (!Array.isArray(catalog.requestExclusions)) fail("requestExclusions must be an array");

  for (const [name, schema] of Object.entries(catalog.schemas)) {
    if (!name) fail("schema names cannot be empty");
    validateSchema(schema, "schemas." + name);
  }

  const allowedTargets = new Set(["command", "engine", "ui"]);
  const allowedModes = new Set(["read", "write"]);
  const allowedSupports = new Set(["batch", "dryRun", "transient"]);
  const allowedTraits = new Set([
    "asynchronous",
    "destructive",
    "external",
    "filesystem",
    "idempotent",
    "mutating",
    "ui-only",
    "undoable",
  ]);
  const names = [];
  for (const [index, operation] of catalog.operations.entries()) {
    const location = "operations[" + index + "]";
    if (!isObject(operation)) fail(location + " must be an object");
    for (const key of [
      "name",
      "category",
      "description",
      "target",
      "mode",
      "traits",
      "supports",
      "requires",
      "input",
      "output",
      "examples",
    ]) {
      if (!Object.hasOwn(operation, key)) fail(location + " is missing " + key);
    }
    if (typeof operation.name !== "string" || !operation.name) fail(location + ".name is invalid");
    if (typeof operation.category !== "string" || !operation.category) {
      fail(location + ".category is invalid");
    }
    if (
      typeof operation.description !== "string" ||
      !operation.description.trim() ||
      operation.description.length > 200
    ) {
      fail(location + ".description must contain 1..200 characters");
    }
    if (!allowedTargets.has(operation.target)) fail(location + ".target is invalid");
    if (!allowedModes.has(operation.mode)) fail(location + ".mode is invalid");
    if (
      !Array.isArray(operation.traits) ||
      !unique(operation.traits) ||
      operation.traits.some((trait) => !allowedTraits.has(trait))
    ) {
      fail(location + ".traits is invalid");
    }
    if (
      !Array.isArray(operation.supports) ||
      !unique(operation.supports) ||
      operation.supports.some((item) => !allowedSupports.has(item))
    ) {
      fail(location + ".supports is invalid");
    }
    if (
      !Array.isArray(operation.requires) ||
      !unique(operation.requires) ||
      operation.requires.some((item) => typeof item !== "string" || !item)
    ) {
      fail(location + ".requires is invalid");
    }
    if (!Array.isArray(operation.examples) || operation.examples.length === 0) {
      fail(location + ".examples must not be empty");
    }
    validateSchema(operation.input, location + ".input");
    validateSchema(operation.output, location + ".output");
    operation.examples.forEach((example, exampleIndex) => {
      if (!isObject(example) || !Object.hasOwn(example, "input")) {
        fail(location + ".examples[" + exampleIndex + "] must contain input");
      }
      if (!accepts(operation.input, example.input)) {
        fail(location + ".examples[" + exampleIndex + "].input does not match input schema");
      }
    });
    if (operation.target === "ui" && !operation.name.startsWith("ui/")) {
      fail(location + " UI target must use ui/ prefix");
    }
    if (operation.target !== "ui" && operation.name.startsWith("ui/")) {
      fail(location + " non-UI target cannot use ui/ prefix");
    }
    names.push(operation.name);
  }
  if (!unique(names)) fail("operation names must be unique");
  const sortedNames = [...names].sort(compareCodePoint);
  if (JSON.stringify(names) !== JSON.stringify(sortedNames)) {
    fail("operations must be sorted by code point");
  }

  const exclusions = catalog.requestExclusions;
  for (const [index, exclusion] of exclusions.entries()) {
    if (
      !isObject(exclusion) ||
      typeof exclusion.request !== "string" ||
      !exclusion.request ||
      typeof exclusion.reason !== "string" ||
      !exclusion.reason ||
      typeof exclusion.use !== "string" ||
      !exclusion.use
    ) {
      fail("requestExclusions[" + index + "] is invalid");
    }
  }
  const exclusionNames = exclusions.map((item) => item.request);
  if (!unique(exclusionNames)) fail("request exclusions must be unique");

  const requestTypes = extractRequestTypes();
  const engineNames = catalog.operations
    .filter((operation) => operation.target !== "ui")
    .map((operation) => operation.name);
  const uiNames = catalog.operations
    .filter((operation) => operation.target === "ui")
    .map((operation) => operation.name);
  const covered = new Set([...engineNames, ...exclusionNames]);
  const missing = requestTypes.filter((name) => !covered.has(name));
  const extras = engineNames.filter((name) => !requestTypes.includes(name));
  if (missing.length || extras.length) {
    fail("RequestMap coverage mismatch; missing=[" + missing.join(", ") + "], extra=[" + extras.join(", ") + "]");
  }
  if (engineNames.some((name) => exclusionNames.includes(name))) {
    fail("an engine operation cannot also be excluded");
  }
  if (JSON.stringify(uiNames) !== JSON.stringify(expectedUiOperations)) {
    fail("UI operation set mismatch; got [" + uiNames.join(", ") + "]");
  }
  if (engineNames.length !== 103 || uiNames.length !== 13 || exclusions.length !== 5) {
    fail(
      "expected 103 engine operations, 13 UI operations, and 5 exclusions; got " +
        engineNames.length +
        "/" +
        uiNames.length +
        "/" +
        exclusions.length,
    );
  }
  return { requestTypes, engineNames, uiNames, exclusions };
};

const validation = validateCatalog();
validatePrompts();
const normalizedPromptsJson = JSON.stringify(prompts, null, 2) + "\n";
const promptsHash = createHash("sha256").update(normalizedPromptsJson).digest("hex");
const batchableOperationNames = catalog.operations
  .filter((operation) => operation.target === "command" && operation.supports.includes("batch"))
  .map((operation) => operation.name);

const quote = (value) => JSON.stringify(value);

const schemaToTs = (schema, stack = new Set()) => {
  if (schema.$ref) {
    const name = refName(schema.$ref, "TypeScript generation");
    if (stack.has(name)) return "unknown";
    const next = new Set(stack);
    next.add(name);
    return schemaToTs(catalog.schemas[name], next);
  }
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((item) => JSON.stringify(item)).join(" | ") || "never";
  if (schema.allOf) return schema.allOf.map((item) => "(" + schemaToTs(item, stack) + ")").join(" & ");
  if (schema.anyOf || schema.oneOf) {
    return (schema.anyOf || schema.oneOf)
      .map((item) => "(" + schemaToTs(item, stack) + ")")
      .join(" | ");
  }
  const type = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (type.length > 1) {
    return type
      .map((item) => schemaToTs({ ...schema, type: item }, stack))
      .join(" | ");
  }
  switch (type[0]) {
    case "null":
      return "null";
    case "boolean":
      return "boolean";
    case "integer":
    case "number":
      return "number";
    case "string":
      return "string";
    case "array":
      return "Array<" + schemaToTs(schema.items || {}, stack) + ">";
    case "object":
    default: {
      if (!schema.properties && schema.additionalProperties === undefined) return "unknown";
      const required = new Set(schema.required || []);
      const fields = Object.entries(schema.properties || {}).map(
        ([name, child]) =>
          quote(name) + (required.has(name) ? ": " : "?: ") + schemaToTs(child, stack) + ";",
      );
      if (schema.additionalProperties === true || isObject(schema.additionalProperties)) {
        const valueType = isObject(schema.additionalProperties)
          ? schemaToTs(schema.additionalProperties, stack)
          : "unknown";
        fields.push("[key: string]: " + valueType + ";");
      }
      return "{ " + fields.join(" ") + " }";
    }
  }
};

const generateTypeScript = () => {
  const coverage = {};
  for (const requestType of validation.requestTypes) {
    const exclusion = validation.exclusions.find((item) => item.request === requestType);
    coverage[requestType] = exclusion
      ? { kind: "excluded", reason: exclusion.reason, use: exclusion.use }
      : { kind: "operation", operation: requestType };
  }
  const engineExamples = {};
  for (const operation of catalog.operations.filter((item) => item.target !== "ui")) {
    engineExamples[operation.name] = operation.examples.map((example) => example.input);
  }
  const uiExamples = {};
  for (const operation of catalog.operations.filter((item) => item.target === "ui")) {
    uiExamples[operation.name] = operation.examples.map((example) => example.input);
  }
  const uiMapLines = catalog.operations
    .filter((item) => item.target === "ui")
    .map(
      (operation) =>
        "  " +
        quote(operation.name) +
        ": { req: " +
        schemaToTs(operation.input) +
        "; reply: " +
        schemaToTs(operation.output) +
        " };",
    );

  const lines = [
    "/* AUTO-GENERATED by scripts/generate-agent-catalog.mjs. DO NOT EDIT. */",
    'import type { ReplyPayload, RequestPayload, RequestType } from "../protocol/types";',
    "",
    "export type JsonSchema = Readonly<Record<string, unknown>>;",
    "export interface CatalogOperation {",
    "  readonly name: string;",
    "  readonly category: string;",
    "  readonly description: string;",
    '  readonly target: "command" | "engine" | "ui";',
    '  readonly mode: "read" | "write";',
    "  readonly traits: readonly string[];",
    "  readonly supports: readonly string[];",
    "  readonly requires: readonly string[];",
    "  readonly produces?: readonly string[] | Readonly<Record<string, string>>;",
    "  readonly input: JsonSchema;",
    "  readonly output: JsonSchema;",
    "  readonly examples: readonly Readonly<{ input: unknown }>[];",
    "}",
    "export interface AgentCatalog {",
    "  readonly $schema: string;",
    "  readonly formatVersion: number;",
    "  readonly schemaDialect: string;",
    "  readonly schemas: Readonly<Record<string, JsonSchema>>;",
    "  readonly operations: readonly CatalogOperation[];",
    "  readonly requestExclusions: readonly Readonly<{ request: string; reason: string; use: string }>[];",
    "}",
    "",
    "export const AGENT_CATALOG_SHA256 = " + quote(catalogHash) + ";",
    "export const AGENT_CATALOG: AgentCatalog = " + JSON.stringify(catalog, null, 2) + ";",
    "export const ENGINE_OPERATION_NAMES = " +
      JSON.stringify(validation.engineNames, null, 2) +
      " as const satisfies readonly RequestType[];",
    "export const UI_OPERATION_NAMES = " +
      JSON.stringify(validation.uiNames, null, 2) +
      " as const;",
    "export const BATCHABLE_OPERATION_NAMES = " +
      JSON.stringify(batchableOperationNames, null, 2) +
      " as const satisfies readonly EngineOperationName[];",
    "",
    "export type EngineOperationName = (typeof ENGINE_OPERATION_NAMES)[number];",
    "export type UiOperationName = (typeof UI_OPERATION_NAMES)[number];",
    "export type CapabilityName = EngineOperationName | UiOperationName;",
    "export type RequestCoverage =",
    '  | Readonly<{ kind: "operation"; operation: RequestType }>',
    '  | Readonly<{ kind: "excluded"; reason: string; use: string }>;',
    "export const REQUEST_COVERAGE = " +
      JSON.stringify(coverage, null, 2) +
      " as const satisfies Record<RequestType, RequestCoverage>;",
    "",
    "export type EngineOperationMap = {",
    "  [K in EngineOperationName]: { req: RequestPayload<K>; reply: ReplyPayload<K> };",
    "};",
    "export type EngineOperationHandler<K extends EngineOperationName> = (",
    '  payload: EngineOperationMap[K]["req"],',
    ') => EngineOperationMap[K]["reply"] | Promise<EngineOperationMap[K]["reply"]>;',
    "export type EngineOperationHandlers = {",
    "  [K in EngineOperationName]: EngineOperationHandler<K>;",
    "};",
    "",
    "export interface UiOperationMap {",
    ...uiMapLines,
    "}",
    "export type UiOperationHandler<K extends UiOperationName> = (",
    '  payload: UiOperationMap[K]["req"],',
    ') => UiOperationMap[K]["reply"] | Promise<UiOperationMap[K]["reply"]>;',
    "export type UiOperationHandlers = {",
    "  [K in UiOperationName]: UiOperationHandler<K>;",
    "};",
    "",
    "export const ENGINE_OPERATION_EXAMPLES = " +
      JSON.stringify(engineExamples, null, 2) +
      " satisfies { [K in EngineOperationName]: Array<RequestPayload<K>> };",
    "export const UI_OPERATION_EXAMPLES = " +
      JSON.stringify(uiExamples, null, 2) +
      ' satisfies { [K in UiOperationName]: Array<UiOperationMap[K]["req"]> };',
    "",
  ];
  return lines.join("\n");
};

const generateCppHeader = () =>
  [
    "// AUTO-GENERATED by scripts/generate-agent-catalog.mjs. DO NOT EDIT.",
    "#pragma once",
    "",
    "#include <cstddef>",
    "#include <string_view>",
    "",
    "namespace mydaw::agent {",
    "",
    "inline constexpr int kAgentCatalogFormatVersion = " + catalog.formatVersion + ";",
    "extern const char kAgentCatalogSha256[];",
    "const char* agentCatalogJson();",
    "std::size_t agentCatalogJsonSize();",
    "bool isAgentBatchableOperation(std::string_view name);",
    "",
    "// Prepared agent scripts (MCP prompts). Embedded copy of shared/agent/prompts.json.",
    "extern const char kAgentPromptsSha256[];",
    "const char* agentPromptsJson();",
    "std::size_t agentPromptsJsonSize();",
    "",
    "} // namespace mydaw::agent",
    "",
  ].join("\n");

const rawStringDelimiter = (payload) => {
  // C++ raw-string delimiters are limited to 16 characters.
  let delimiter = "MYDAW_AGENT";
  let attempt = 0;
  while (payload.includes(")" + delimiter + '"')) {
    delimiter = "MYDAW_A" + String(++attempt);
  }
  return delimiter;
};

const generateCppSource = () => {
  const delimiter = rawStringDelimiter(normalizedJson);
  const promptsDelimiter = rawStringDelimiter(normalizedPromptsJson);
  return [
    "// AUTO-GENERATED by scripts/generate-agent-catalog.mjs. DO NOT EDIT.",
    '#include "agent/AgentCatalog.gen.h"',
    "",
    "namespace mydaw::agent {",
    "",
    "const char kAgentCatalogSha256[] = " + quote(catalogHash) + ";",
    "const char kAgentPromptsSha256[] = " + quote(promptsHash) + ";",
    "namespace {",
    "const char kAgentCatalogJson[] = R\"" + delimiter + "(" + normalizedJson + ")" + delimiter + '\";',
    "const char kAgentPromptsJson[] = R\"" + promptsDelimiter + "(" + normalizedPromptsJson + ")" + promptsDelimiter + '\";',
    "constexpr std::string_view kBatchableOperationNames[] = {",
    ...batchableOperationNames.map((name) => "    " + quote(name) + ","),
    "};",
    "} // namespace",
    "",
    "const char* agentCatalogJson() { return kAgentCatalogJson; }",
    "std::size_t agentCatalogJsonSize() { return sizeof(kAgentCatalogJson) - 1; }",
    "const char* agentPromptsJson() { return kAgentPromptsJson; }",
    "std::size_t agentPromptsJsonSize() { return sizeof(kAgentPromptsJson) - 1; }",
    "bool isAgentBatchableOperation(std::string_view name) {",
    "    for (const std::string_view candidate : kBatchableOperationNames)",
    "        if (candidate == name)",
    "            return true;",
    "    return false;",
    "}",
    "",
    "} // namespace mydaw::agent",
    "",
  ].join("\n");
};

const generatePromptsTs = () =>
  [
    "/* AUTO-GENERATED by scripts/generate-agent-catalog.mjs. DO NOT EDIT. */",
    "",
    "export interface PreparedScript {",
    "  readonly id: string;",
    "  readonly title: string;",
    "  readonly category: string;",
    "  readonly prompt: string;",
    "  readonly tags?: readonly string[];",
    "}",
    "",
    "export const AGENT_PROMPTS_SHA256 = " + quote(promptsHash) + ";",
    "export const AGENT_PROMPTS: readonly PreparedScript[] = " +
      JSON.stringify(prompts.prompts, null, 2) +
      ";",
    "",
  ].join("\n");

const outputs = [
  [TS_OUTPUT, generateTypeScript()],
  [TS_PROMPTS_OUTPUT, generatePromptsTs()],
  [CPP_HEADER_OUTPUT, generateCppHeader()],
  [CPP_SOURCE_OUTPUT, generateCppSource()],
];

const drift = [];
for (const [file, content] of outputs) {
  if (CHECK) {
    if (!existsSync(file)) {
      drift.push(file + " is missing");
    } else if (readFileSync(file, "utf8") !== content) {
      drift.push(file + " is stale");
    }
  } else {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, "utf8");
  }
}

if (CHECK && drift.length > 0) {
  fail(drift.join("; ") + ". Run node scripts/generate-agent-catalog.mjs");
}

console.log(
  "[agent-catalog] " +
    (CHECK ? "checked" : "generated") +
    " " +
    validation.engineNames.length +
    " engine + " +
    validation.uiNames.length +
    " UI operations, " +
    validation.exclusions.length +
    " exclusion, " +
    prompts.prompts.length +
    " prompts, sha256=" +
    catalogHash,
);
