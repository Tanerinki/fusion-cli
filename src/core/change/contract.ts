import { createHash } from "node:crypto";
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

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
/** `\`-separated, `.`-segmented or empty-segmented spellings of a scope entry, reduced to one `/`-separated form. */
const unifiedScopePath = (path: string): string => path.replace(/\\/gu, "/").split("/").filter(part => part !== "" && part !== ".").join("/");
function canonicalOrUndefined(path: string): string | undefined {
  try { return canonicalChangePath(path); } catch { return undefined; }
}

/**
 * The exact file scope a Writer's ChangeSet is validated against, derived by Fusion from the delegation packet before
 * any role runs. Allowed entries must already be canonical repository-relative file paths (an ambiguous write scope is
 * refused, never normalized into a different target). Forbidden entries are unified (`\`, `.` and empty segments) and
 * remove every allowed path they name exactly or as a directory prefix; one that can name no canonical path is inert.
 */
export function writerChangeScope(packet: DelegationPacket): ChangeScope {
  const allowed = packet.scope.allowedFiles.map(path => canonicalOrUndefined(path) ??
    failWith("InvalidInput", "The delegated write scope must list canonical repository-relative file paths."));
  const forbidden = [...new Set(packet.scope.forbiddenFiles.map(path => canonicalOrUndefined(unifiedScopePath(path)))
    .filter((path): path is string => path !== undefined))];
  const folded = forbidden.map(path => path.toLowerCase());
  const permitted = allowed.filter(path => !folded.some(blocked => path.toLowerCase() === blocked ||
    path.toLowerCase().startsWith(`${blocked}/`)));
  if (permitted.length === 0) failWith("InvalidInput", "The delegated write scope permits no file.");
  const scope: ChangeScope = Object.freeze({ allowedPaths: Object.freeze([...new Set(permitted)]),
    forbiddenPaths: Object.freeze(forbidden.filter((path, index) => folded.indexOf(path.toLowerCase()) === index)) });
  validatedScope(scope);
  return scope;
}

/** Scope checks shared by the ChangeSet validator and the scope Fusion derives for a Writer. */
function validatedScope(scope: ChangeScope): Readonly<{ permit: ReadonlySet<string>; denyPath: (path: string) => boolean }> {
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
  return { permit, denyPath };
}

/**
 * The raw `path` strings of a proposal's operations, read defensively from untrusted output (no getters run: the value
 * is a structured clone). Used only to explain a refusal (risk signals); `validateChangeSet` stays authoritative.
 */
export function proposedPaths(output: unknown): readonly string[] {
  let value: unknown;
  try { value = structuredClone(output); } catch { return []; }
  if (!own(value) || !Array.isArray(value.operations)) return [];
  return value.operations.slice(0, CHANGE_LIMITS.maxOperations * 4)
    .flatMap(op => own(op) && typeof op.path === "string" && op.path.length <= 4 * CHANGE_LIMITS.maxPathChars ? [op.path] : []);
}

/**
 * Exact files only in v0.1: directory or glob scope requires an explicit Lead decision. The untrusted output is first
 * detached from its producer by a structured clone, so a getter or proxy can never return one value to the checks and
 * another to the host applier.
 */
export function validateChangeSet(untrusted: unknown, scope: ChangeScope): ChangeSet {
  let output: unknown;
  try { output = structuredClone(untrusted); } catch { failWith("MalformedOutput", "ChangeSet is not plain data."); }
  if (!own(output) || !keys(output, ["schemaVersion", "operations"]) || output.schemaVersion !== 1 ||
      !Array.isArray(output.operations) || output.operations.length === 0 ||
      output.operations.length > CHANGE_LIMITS.maxOperations)
    failWith("MalformedOutput", "ChangeSet has an invalid shape or operation count.");
  const { permit, denyPath } = validatedScope(scope);
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
      // Rewriting a file with its current content changes nothing: it is a malformed proposal, never an edit.
      if (raw.expectedSha256 !== null && raw.expectedSha256 === sha256(raw.content))
        failWith("MalformedOutput", "ChangeSet rewrites a file with its existing content.");
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
