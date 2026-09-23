import { record, packetShape, fail } from "./types.js";
import { parseStrictJson } from "../../platform/process/strict-json.js";
import type { DelegationPacket, ResultPacket } from "../../core/domain.js";

const strings = { type: "array", items: { type: "string" } } as const;
export const RESULT_PACKET_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["result", "changes", "verification", "uncertainties", "failures", "needsLeadDecision"],
  properties: {
    result: { type: "object", additionalProperties: false, required: ["status"], properties: { status: { type: "string", enum: ["completed","partial","blocked","failed"] } } },
    changes: { type: "object", additionalProperties: false, required: ["files","summary"], properties: { files: strings, summary: { type: "string" } } },
    verification: { type: "object", additionalProperties: false, required: ["testsRun","results"], properties: { testsRun: strings, results: strings } },
    uncertainties: strings, failures: strings, needsLeadDecision: strings,
  },
} as const;

export function renderPrompt(packet: DelegationPacket): string {
  return `Complete the delegated task within its scope. Return exactly one JSON ResultPacket matching this schema. Model-reported checks are claims only.\nSchema:\n${JSON.stringify(RESULT_PACKET_SCHEMA)}\nDelegation:\n${JSON.stringify(packet)}`;
}

/**
 * Deliberately bounded JSON Schema subset. Unsupported assertions reject the schema. `anyOf` exists only in its nullable
 * form (see `assertNullable`), which is all the strict wire schema needs; it is not a general union.
 */
const ASSERTIONS = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems", "$schema", "title", "description", "anyOf"]);
const isNullSchema = (value: unknown): boolean => {
  const s = record(value);
  return s !== null && Object.keys(s).length === 1 && s.type === "null";
};
/** The only accepted `anyOf`: exactly one non-null, non-union schema and `{ "type": "null" }`, with nothing beside them. */
function assertNullable(s: Record<string, unknown>, depth: number): void {
  const branches = s.anyOf;
  if (!Array.isArray(branches) || branches.length !== 2 || Object.keys(s).some(k => k !== "anyOf" && k !== "title" && k !== "description"))
    fail("InvalidInput", "Unsupported anyOf: only a nullable schema is supported.");
  const values = branches.filter(branch => !isNullSchema(branch));
  const inner = values.length === 1 ? record(values[0]) : null;
  if (!inner || inner.anyOf !== undefined || inner.type === "null") fail("InvalidInput", "Unsupported anyOf: only a nullable schema is supported.");
  assertSupportedSchema(inner, depth + 1);
}
export function assertSupportedSchema(schema: unknown, depth = 0): void {
  const s = record(schema);
  if (!s || depth > 24 || Object.keys(s).some(k => !ASSERTIONS.has(k))) fail("InvalidInput", "Unsupported or invalid output schema.");
  if (s.anyOf !== undefined) { assertNullable(s, depth); return; }
  if (s.type !== undefined && !["object","array","string","number","integer","boolean","null"].includes(String(s.type)))
    fail("InvalidInput", "Unsupported output schema type.");
  if (s.properties !== undefined) {
    const props = record(s.properties); if (!props) fail("InvalidInput", "Invalid output schema properties.");
    for (const child of Object.values(props)) assertSupportedSchema(child, depth + 1);
  }
  if (s.items !== undefined) assertSupportedSchema(s.items, depth + 1);
  if (record(s.additionalProperties)) assertSupportedSchema(s.additionalProperties, depth + 1);
  else if (s.additionalProperties !== undefined && typeof s.additionalProperties !== "boolean")
    fail("InvalidInput", "Invalid additionalProperties assertion.");
  if (s.required !== undefined && (!Array.isArray(s.required) || !s.required.every(x => typeof x === "string")))
    fail("InvalidInput", "Invalid output schema required list.");
  if (s.enum !== undefined && !Array.isArray(s.enum)) fail("InvalidInput", "Invalid output schema enum.");
  for (const key of ["minLength","maxLength","minItems","maxItems","minimum","maximum"]) {
    if (s[key] !== undefined && (typeof s[key] !== "number" || !Number.isFinite(s[key]) ||
      (key !== "minimum" && key !== "maximum" && (!Number.isSafeInteger(s[key]) || (s[key] as number) < 0))))
      fail("InvalidInput", "Invalid output schema numeric constraint.");
  }
}
export function validateSchema(value: unknown, schema: unknown, depth = 0): boolean {
  assertSupportedSchema(schema, depth);
  const s = record(schema);
  if (!s) fail("InvalidInput", "Invalid output schema.");
  if (s.anyOf !== undefined) return (s.anyOf as unknown[]).some(branch => validateSchema(value, branch, depth + 1));
  const t = s.type;
  if (t !== undefined && !["object", "array", "string", "number", "integer", "boolean", "null"].includes(String(t))) fail("InvalidInput", "Unsupported output schema type.");
  if (t === "object" && !record(value)) return false;
  if (t === "array" && !Array.isArray(value)) return false;
  if (t === "string" && typeof value !== "string") return false;
  if (t === "number" && (typeof value !== "number" || !Number.isFinite(value))) return false;
  if (t === "integer" && !Number.isSafeInteger(value)) return false;
  if (t === "boolean" && typeof value !== "boolean") return false;
  if (t === "null" && value !== null) return false;
  if (s.const !== undefined && JSON.stringify(value) !== JSON.stringify(s.const)) return false;
  if (s.enum !== undefined) {
    if (!Array.isArray(s.enum)) fail("InvalidInput", "Invalid output schema enum.");
    if (!s.enum.some(x => JSON.stringify(x) === JSON.stringify(value))) return false;
  }
  if (typeof value === "string") {
    if (s.minLength !== undefined && value.length < Number(s.minLength)) return false;
    if (s.maxLength !== undefined && value.length > Number(s.maxLength)) return false;
  }
  if (typeof value === "number") {
    if (s.minimum !== undefined && value < Number(s.minimum)) return false;
    if (s.maximum !== undefined && value > Number(s.maximum)) return false;
  }
  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < Number(s.minItems)) return false;
    if (s.maxItems !== undefined && value.length > Number(s.maxItems)) return false;
    if (s.items !== undefined && !value.every(v => validateSchema(v, s.items, depth + 1))) return false;
  }
  const obj = record(value);
  if (obj) {
    const props = s.properties === undefined ? {} : record(s.properties);
    if (!props) fail("InvalidInput", "Invalid output schema properties.");
    if (s.required !== undefined) {
      if (!Array.isArray(s.required) || !s.required.every(x => typeof x === "string")) fail("InvalidInput", "Invalid output schema required list.");
      if (s.required.some(x => !Object.hasOwn(obj, x))) return false;
    }
    for (const [k,v] of Object.entries(obj)) {
      if (Object.hasOwn(props, k)) { if (!validateSchema(v, props[k], depth + 1)) return false; }
      else if (s.additionalProperties === false) return false;
      else if (record(s.additionalProperties) && !validateSchema(v, s.additionalProperties, depth + 1)) return false;
    }
  }
  return true;
}

/**
 * The strict wire form of a canonical output schema, as the exec provider's structured decoding requires: every object
 * lists every property in `required` and stays closed, and a canonically optional property instead admits `null`, which
 * stands for its omission (`normalizeWireValue` maps it back). Constraints are kept unchanged. A canonical shape the
 * transform cannot represent faithfully (an open object, an array without items, a `required` entry naming no
 * property, a canonical `null` or `anyOf`) fails closed. The canonical schema is not modified.
 */
export function toMuseStrictSchema(canonical: unknown): Record<string, unknown> {
  assertSupportedSchema(canonical);
  const strict = (node: unknown): Record<string, unknown> => {
    const s = record(node);
    if (!s || s.anyOf !== undefined || s.type === undefined || s.type === "null")
      fail("InvalidInput", "The canonical output schema cannot be made strict.");
    if (s.type === "object") {
      const props = record(s.properties);
      const required = s.required === undefined ? [] : s.required as string[];
      if (!props || s.additionalProperties !== false || new Set(required).size !== required.length ||
          required.some(key => !Object.hasOwn(props, key)))
        fail("InvalidInput", "Only closed objects with declared properties can be made strict.");
      const properties = Object.fromEntries(Object.entries(props).map(([key, child]) => {
        const wire = strict(child);
        return [key, required.includes(key) ? wire : { anyOf: [wire, { type: "null" }] }];
      }));
      return { ...s, properties, required: Object.keys(props), additionalProperties: false };
    }
    if (s.properties !== undefined || s.required !== undefined || s.additionalProperties !== undefined)
      fail("InvalidInput", "Object keywords outside an object schema cannot be made strict.");
    if (s.type === "array") {
      if (s.items === undefined) fail("InvalidInput", "An array without an item schema cannot be made strict.");
      return { ...s, items: strict(s.items) };
    }
    if (s.items !== undefined) fail("InvalidInput", "Array keywords outside an array schema cannot be made strict.");
    return { ...s };
  };
  return strict(canonical);
}

/**
 * Maps a wire value back to the canonical form: a `null` in a canonically optional property is the wire encoding of
 * its omission and is removed. Nothing else changes: a `null` anywhere else stays and fails canonical validation, and
 * undeclared keys are kept for validation to reject. Returns a new value; neither input is modified.
 */
export function normalizeWireValue(value: unknown, canonical: unknown): unknown {
  const s = record(canonical);
  if (!s) return value;
  if (s.type === "object") {
    const obj = record(value), props = record(s.properties);
    if (!obj || !props) return value;
    const required = new Set(Array.isArray(s.required) ? s.required : []);
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(obj)) {
      const declared = Object.hasOwn(props, key);
      if (declared && entry === null && !required.has(key)) continue;
      Object.defineProperty(out, key, { value: declared ? normalizeWireValue(entry, props[key]) : entry,
        enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  if (s.type === "array" && Array.isArray(value)) return value.map(item => normalizeWireValue(item, s.items));
  return value;
}

/**
 * A structured review or adjudication: the whole terminal text must be one strict JSON value. It must pass the wire
 * schema the provider was constrained to, then, after wire-only nulls are normalized away, the canonical schema.
 * Prose, fences or trailing text are malformed, never repaired. The value stays untrusted: the core validates it
 * against the O4 contract.
 */
export function parseStructured(text: string, canonical: unknown, wire: unknown): unknown {
  let value: unknown;
  try { value = parseStrictJson(text); }
  catch { fail("MalformedOutput", "Muse returned invalid structured JSON."); }
  if (!validateSchema(value, wire)) fail("MalformedOutput", "Muse output failed local wire-schema validation.");
  const normalized = normalizeWireValue(value, canonical);
  if (!validateSchema(normalized, canonical)) fail("MalformedOutput", "Muse output failed the canonical schema after normalization.");
  return normalized;
}

export function parsePacket(text: string, schema?: unknown): ResultPacket {
  let value: unknown;
  try { value = parseStrictJson(text); }
  catch { fail("MalformedOutput", "Muse returned invalid structured JSON."); }
  if (!packetShape(value)) fail("MalformedOutput", "Muse returned an invalid ResultPacket.");
  if (schema !== undefined && !validateSchema(value, schema)) fail("MalformedOutput", "Muse output failed local schema validation.");
  return value;
}
