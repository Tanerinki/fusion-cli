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

/** Deliberately bounded JSON Schema subset. Unsupported assertions reject the schema. */
const ASSERTIONS = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems", "$schema", "title", "description"]);
export function assertSupportedSchema(schema: unknown, depth = 0): void {
  const s = record(schema);
  if (!s || depth > 24 || Object.keys(s).some(k => !ASSERTIONS.has(k))) fail("InvalidInput", "Unsupported or invalid output schema.");
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
      if (s.required.some(x => !(x in obj))) return false;
    }
    for (const [k,v] of Object.entries(obj)) {
      if (k in props) { if (!validateSchema(v, props[k], depth + 1)) return false; }
      else if (s.additionalProperties === false) return false;
      else if (record(s.additionalProperties) && !validateSchema(v, s.additionalProperties, depth + 1)) return false;
    }
  }
  return true;
}

export function parsePacket(text: string, schema?: unknown): ResultPacket {
  let value: unknown;
  try { value = parseStrictJson(text); }
  catch { fail("MalformedOutput", "Muse returned invalid structured JSON."); }
  if (!packetShape(value)) fail("MalformedOutput", "Muse returned an invalid ResultPacket.");
  if (schema !== undefined && !validateSchema(value, schema)) fail("MalformedOutput", "Muse output failed local schema validation.");
  return value;
}
