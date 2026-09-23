import { isAbsolute, win32 } from "node:path";
import type { ChangeOperation, ChangeScope, ChangeSet, DelegationPacket } from "../domain.js";
import { failWith } from "../errors.js";

export const CHANGE_LIMITS = Object.freeze({ maxOperations: 32, maxPathChars: 512,
  maxFileBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 });
const HASH = /^[0-9a-f]{64}$/u;
const DEVICE = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\..*)?$/iu;
const own = (value: unknown): value is Record<string, unknown> => value !== null &&
  typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const keys = (value: Record<string, unknown>, expected: readonly string[]): boolean =>
  Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));

/** Refuse ambiguous input; never normalize model paths into different targets. */
export function canonicalChangePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > CHANGE_LIMITS.maxPathChars ||
      value.includes("\\") || isAbsolute(value) || win32.isAbsolute(value) ||
      /[\x00-\x1f\x7f<>:"|?*~]/u.test(value) ||
      value.split("/").some(part => !part || part === "." || part === ".." ||
        part.toLowerCase() === ".git" || part.toLowerCase() === ".fusion" ||
        DEVICE.test(part) || /[. ]$/u.test(part)))
    failWith("SecurityViolation", "ChangeSet path is not a canonical repository-relative file path.");
  return value;
}

export function changeScope(packet: DelegationPacket): ChangeScope {
  return { allowedPaths: packet.scope.allowedFiles, forbiddenPaths: packet.scope.forbiddenFiles };
}

/** Exact files only in v0.1: directory or glob scope requires an explicit Lead decision. */
export function validateChangeSet(output: unknown, scope: ChangeScope): ChangeSet {
  if (!own(output) || !keys(output, ["schemaVersion", "operations"]) || output.schemaVersion !== 1 ||
      !Array.isArray(output.operations) || output.operations.length === 0 ||
      output.operations.length > CHANGE_LIMITS.maxOperations)
    failWith("MalformedOutput", "ChangeSet has an invalid shape or operation count.");
  if (!own(scope) || !Array.isArray(scope.allowedPaths) || !Array.isArray(scope.forbiddenPaths) ||
      scope.allowedPaths.length === 0 || scope.allowedPaths.length > 1024 || scope.forbiddenPaths.length > 1024)
    failWith("InvalidInput", "ChangeSet requires a bounded explicit file scope.");
  const allowed = scope.allowedPaths.map(canonicalChangePath);
  const forbidden = scope.forbiddenPaths.map(canonicalChangePath);
  if (new Set(allowed.map(path => path.toLowerCase())).size !== allowed.length ||
      new Set(forbidden.map(path => path.toLowerCase())).size !== forbidden.length)
    failWith("InvalidInput", "ChangeSet scope contains case-colliding paths.");
  const permit = new Set(allowed.map(path => path.toLowerCase()));
  const denied = forbidden.map(path => path.toLowerCase());
  const denyPath = (path: string): boolean => denied.some(blocked => path === blocked || path.startsWith(`${blocked}/`));
  if (allowed.some(path => denyPath(path.toLowerCase())))
    failWith("SecurityViolation", "ChangeSet scope both permits and forbids a path.");
  let totalBytes = 0;
  const seen = new Set<string>();
  const operations: ChangeOperation[] = [];
  for (const raw of output.operations) {
    if (!own(raw) || (raw.kind !== "writeText" && raw.kind !== "delete") ||
        !keys(raw, raw.kind === "writeText" ? ["kind", "path", "expectedSha256", "content"]
          : ["kind", "path", "expectedSha256"]))
      failWith("MalformedOutput", "ChangeSet operation has invalid or extra properties.");
    const path = canonicalChangePath(raw.path), folded = path.toLowerCase();
    if (seen.has(folded) || [...seen].some(other => other.startsWith(`${folded}/`) || folded.startsWith(`${other}/`)))
      failWith("SecurityViolation", "ChangeSet contains duplicate, colliding or nested targets.");
    seen.add(folded);
    if (!permit.has(folded) || denyPath(folded))
      failWith("SecurityViolation", "ChangeSet operation is outside the approved file scope.");
    if (raw.expectedSha256 !== null && (typeof raw.expectedSha256 !== "string" || !HASH.test(raw.expectedSha256)))
      failWith("MalformedOutput", "ChangeSet expected hash is malformed.");
    if (raw.kind === "delete") {
      if (raw.expectedSha256 === null) failWith("MalformedOutput", "Delete requires an expected hash.");
      operations.push({ kind: "delete", path, expectedSha256: raw.expectedSha256 as string });
    } else {
      if (typeof raw.content !== "string" || raw.content.includes("\0") ||
          Buffer.from(raw.content, "utf8").toString("utf8") !== raw.content)
        failWith("MalformedOutput", "ChangeSet text content is malformed.");
      const bytes = Buffer.byteLength(raw.content, "utf8");
      totalBytes += bytes;
      if (bytes > CHANGE_LIMITS.maxFileBytes || totalBytes > CHANGE_LIMITS.maxTotalBytes)
        failWith("SecurityViolation", "ChangeSet content exceeds the byte limit.");
      operations.push({ kind: "writeText", path, expectedSha256: raw.expectedSha256 as string | null,
        content: raw.content });
    }
  }
  return Object.freeze({ schemaVersion: 1, operations: Object.freeze(operations.map(op => Object.freeze(op))) });
}

/** Decoder aid; validateChangeSet remains authoritative for kind-dependent fields and scope. */
export function changeSetSchema(): Record<string, unknown> {
  return { type: "object", additionalProperties: false, required: ["schemaVersion", "operations"], properties: {
    schemaVersion: { type: "integer", const: 1 }, operations: { type: "array", minItems: 1,
      maxItems: CHANGE_LIMITS.maxOperations, items: { type: "object", additionalProperties: false,
        required: ["kind", "path", "expectedSha256"], properties: {
          kind: { type: "string", enum: ["writeText", "delete"] },
          path: { type: "string", minLength: 1, maxLength: CHANGE_LIMITS.maxPathChars },
          expectedSha256: { anyOf: [{ type: "string", minLength: 64, maxLength: 64 }, { type: "null" }] },
          content: { type: "string", maxLength: CHANGE_LIMITS.maxFileBytes },
        } } },
  } };
}
