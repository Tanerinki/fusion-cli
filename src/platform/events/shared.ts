import { randomBytes, createHash } from "node:crypto";
import { lstat, open, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, win32 } from "node:path";
import { createReadStream } from "node:fs";

export const STORAGE_SCHEMA_VERSION = 1 as const;
export const FUSION_VERSION = "0.1.0";
const ID = /^[a-z][a-z0-9]*-[0-9a-z]{10}-[0-9a-f]{32}$/u;

export type StorageErrorKind = "StorageError" | "ArtifactError" | "CorruptEventLog" |
  "UnsupportedSchema" | "InvalidArtifactPath" | "ArtifactTooLarge";
export class StorageError extends Error {
  constructor(readonly kind: StorageErrorKind, message: string, readonly line?: number, options?: ErrorOptions) {
    super(message, options); this.name = kind;
  }
}

/** Keep only active per-path queues. A settled tail cannot remove a newer one. */
export function enqueuePath<T, S extends { tail: Promise<void> }>(queues: Map<string, S>, path: string,
  create: () => S, operation: (state: S) => Promise<T>): Promise<T> {
  const state = queues.get(path) ?? create();
  queues.set(path, state);
  const task = state.tail.then(() => operation(state));
  const tail = task.then(() => {}, () => {});
  state.tail = tail;
  void tail.then(() => {
    if (queues.get(path) === state && state.tail === tail) queues.delete(path);
  });
  return task;
}

export function makeId(prefix: string): string {
  if (!/^[a-z][a-z0-9]*$/u.test(prefix)) throw new StorageError("StorageError", "Invalid identifier prefix.");
  return `${prefix}-${Date.now().toString(36).padStart(10, "0")}-${randomBytes(16).toString("hex")}`;
}
export function assertId(value: unknown, prefix: string): asserts value is string {
  if (typeof value !== "string" || !ID.test(value) || !value.startsWith(`${prefix}-`))
    throw new StorageError("StorageError", "Invalid storage identifier.");
}
export const hashText = (value: string): string => createHash("sha256").update(value).digest("hex");
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export function schemaVersion(value: unknown): void {
  if (!isRecord(value)) throw new StorageError("StorageError", "Stored record is not an object.");
  if (value.schemaVersion !== STORAGE_SCHEMA_VERSION)
    throw new StorageError("UnsupportedSchema", "Stored record schema version is unsupported.");
}
export function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
export function safeShortText(value: unknown, name: string, max = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\x00-\x1f\x7f]/u.test(value))
    throw new StorageError("StorageError", `Invalid ${name}.`);
  return value;
}
export function safeOptionalText(value: unknown, name: string, max = 256): string | undefined {
  return value === undefined ? undefined : safeShortText(value, name, max);
}
export function safeTimestamp(value: unknown, name: string): string {
  const text = safeShortText(value, name, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(text) ||
      Number.isNaN(Date.parse(text))) throw new StorageError("StorageError", `Invalid ${name}.`);
  return text;
}
/**
 * Containment by path semantics, not string prefixes: the relative path from root to candidate must not
 * climb out of root or switch roots/drives. Windows comparison is case-insensitive through path.win32.
 */
export function isContainedPath(root: string, path: string, platform = process.platform): boolean {
  const api = platform === "win32" ? win32 : posix;
  const rel = api.relative(api.resolve(root), api.resolve(path));
  if (rel === "") return true;
  return !api.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${api.sep}`);
}
export function assertWithin(root: string, path: string): void {
  if (!isContainedPath(root, path))
    throw new StorageError("InvalidArtifactPath", "Artifact path escapes the run root.");
}
/** Windows device names, including console aliases, are reserved with or without an extension. */
const RESERVED_WINDOWS_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$|clock\$)(?:\.|$)/iu;
/** Portable relative paths only; never use provider paths as artifact destinations. */
export function resolveArtifactRelative(root: string, relative: string): string {
  if (typeof relative !== "string" || !relative || relative.length > 512 ||
      isAbsolute(relative) || win32.isAbsolute(relative) || relative.includes("\\") ||
      /[:*?"<>|]/u.test(relative) || /[\x00-\x1f\x7f]/u.test(relative))
    throw new StorageError("InvalidArtifactPath", "Invalid artifact relative path.");
  const parts = relative.split("/");
  if (parts.some(part => !part || part === "." || part === ".." ||
      /[. ]$/u.test(part) || RESERVED_WINDOWS_NAME.test(part)))
    throw new StorageError("InvalidArtifactPath", "Invalid artifact relative path.");
  const path = join(root, ...parts);
  assertWithin(root, path);
  return path;
}

/** Write a complete replacement before rename. Never remove the old manifest first. */
export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(temp, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close(); handle = undefined;
    await rename(temp, path);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

export type JsonlLine = Readonly<{ line: number; value: unknown }> |
  Readonly<{ line: number; diagnostic: "TruncatedFinalLine" }>;
/** Byte-framed so an unterminated final record is never accepted as a complete event. */
export async function* readJsonl(path: string, maxLineBytes = 1024 * 1024): AsyncGenerator<JsonlLine> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new StorageError("StorageError", "JSONL path is not a regular file.");
  let pending = Buffer.alloc(0), line = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    pending = Buffer.concat([pending, chunk as Buffer]);
    let split: number;
    while ((split = pending.indexOf(10)) !== -1) {
      line++;
      const bytes = pending.subarray(0, split);
      pending = pending.subarray(split + 1);
      if (bytes.length > maxLineBytes || bytes.length === 0)
        throw new StorageError("CorruptEventLog", "Invalid JSONL record length.", line);
      let value: unknown;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
      catch { throw new StorageError("CorruptEventLog", "Malformed JSONL record.", line); }
      yield { line, value };
    }
    if (pending.length > maxLineBytes)
      throw new StorageError("CorruptEventLog", "JSONL record exceeds limit.", line + 1);
  }
  if (pending.length > 0) yield { line: line + 1, diagnostic: "TruncatedFinalLine" };
}
