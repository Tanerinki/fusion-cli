import { record, packetShape, fail } from "./types.js";
import { jsonSchemaSubset } from "../../platform/process/json-schema.js";
import { parseStrictJson } from "../../platform/process/strict-json.js";
import type { DelegationPacket, PacketTurnPurpose, ResultPacket } from "../../core/domain.js";
import { packetTurnInstruction } from "../../core/workflow/lead-plan.js";

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

/** A packet turn's prompt: the role-specific instruction (O5.5B16: the planning Lead) or the generic delegated-task wording. */
export function renderPrompt(packet: DelegationPacket, purpose?: PacketTurnPurpose): string {
  return `${packetTurnInstruction(purpose) ?? "Complete the delegated task within its scope."} Return exactly one JSON ResultPacket matching this schema. Model-reported checks are claims only.\nSchema:\n${JSON.stringify(RESULT_PACKET_SCHEMA)}\nDelegation:\n${JSON.stringify(packet)}`;
}

/**
 * The bounded JSON Schema subset (platform/process/json-schema.ts), bound to Muse's typed failure: an unsupported schema
 * fails as a Muse `InvalidInput`. `anyOf` exists only in its nullable form, which is all the strict wire schema needs.
 */
const SCHEMA = jsonSchemaSubset(fail);
const { isNullSchema, assertNullable } = SCHEMA;
export const assertSupportedSchema: (schema: unknown, depth?: number) => void = SCHEMA.assertSupportedSchema;
export const validateSchema: (value: unknown, schema: unknown, depth?: number) => boolean = SCHEMA.validateSchema;

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
    if (s?.anyOf !== undefined) {
      assertNullable(s, 0);
      const inner = (s.anyOf as unknown[]).find(branch => !isNullSchema(branch));
      return { anyOf: [strict(inner), { type: "null" }] };
    }
    if (!s || s.type === undefined || s.type === "null")
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
