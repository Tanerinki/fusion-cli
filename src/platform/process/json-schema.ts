/**
 * The deliberately bounded JSON Schema subset of Fusion's decoding schemas: the canonical structured-turn contracts and a
 * provider's strict wire form of them. Unsupported assertions reject the schema. `anyOf` exists only in its nullable form
 * (see `assertNullable`), which is all the strict wire schema needs; it is not a general union.
 *
 * Provider-neutral: each provider binds the subset to its own typed failure, so an unsupported schema keeps failing as
 * that provider's `InvalidInput`. A schema check is a decoding aid, never a second contract: the core validators stay
 * authoritative for every structured turn.
 */
export type SchemaFailure = (kind: "InvalidInput", safeMessage: string) => never;
export interface JsonSchemaSubset {
  readonly isNullSchema: (value: unknown) => boolean;
  /** The only accepted `anyOf`: exactly one non-null, non-union schema and `{ "type": "null" }`, with nothing beside them. */
  readonly assertNullable: (schema: Record<string, unknown>, depth: number) => void;
  readonly assertSupportedSchema: (schema: unknown, depth?: number) => void;
  readonly validateSchema: (value: unknown, schema: unknown, depth?: number) => boolean;
}

const ASSERTIONS = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems", "$schema", "title", "description", "anyOf"]);
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function jsonSchemaSubset(fail: SchemaFailure): JsonSchemaSubset {
  const isNullSchema = (value: unknown): boolean => {
    const s = record(value);
    return s !== null && Object.keys(s).length === 1 && s.type === "null";
  };
  function assertNullable(s: Record<string, unknown>, depth: number): void {
    const branches = s.anyOf;
    if (!Array.isArray(branches) || branches.length !== 2 || Object.keys(s).some(k => k !== "anyOf" && k !== "title" && k !== "description"))
      fail("InvalidInput", "Unsupported anyOf: only a nullable schema is supported.");
    const values = branches.filter(branch => !isNullSchema(branch));
    const inner = values.length === 1 ? record(values[0]) : null;
    if (!inner || inner.anyOf !== undefined || inner.type === "null") fail("InvalidInput", "Unsupported anyOf: only a nullable schema is supported.");
    assertSupportedSchema(inner, depth + 1);
  }
  function assertSupportedSchema(schema: unknown, depth = 0): void {
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
  function validateSchema(value: unknown, schema: unknown, depth = 0): boolean {
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
  return Object.freeze({ isNullSchema, assertNullable, assertSupportedSchema, validateSchema });
}
