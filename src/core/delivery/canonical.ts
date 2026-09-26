import { createHash } from "node:crypto";
import { failWith } from "../errors.js";

/**
 * O5.5C1: the canonical JSON every delivery digest is computed over — object keys sorted by UTF-16 code unit, arrays in
 * order, no whitespace, and only plain JSON data: strings, safe integers, booleans, null, arrays and plain objects. Anything
 * else (undefined, a float, NaN, a Buffer, a class instance, a function) is refused rather than silently dropped or
 * coerced, so two equal values always hash equal and a value that does not round-trip through JSON never hashes at all.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean": return value ? "true" : "false";
    case "string": return JSON.stringify(value);
    case "number":
      if (!Number.isSafeInteger(value)) failWith("InvalidInput", "Canonical delivery data holds only safe integers.");
      return String(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(",")}]`;
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
        failWith("InvalidInput", "Canonical delivery data holds only plain objects.");
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).sort().map(key => {
        if (record[key] === undefined) failWith("InvalidInput", "Canonical delivery data holds no undefined values.");
        return `${JSON.stringify(key)}:${canonicalJson(record[key])}`;
      }).join(",")}}`;
    }
    default: return failWith("InvalidInput", "Canonical delivery data holds only JSON values.");
  }
}
export const sha256Hex = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
/** Deep-freezes plain JSON data (arrays and plain objects), returning the same value; byte buffers cannot be frozen. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !ArrayBuffer.isView(value) && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }
  return value;
}
