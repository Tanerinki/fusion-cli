/**
 * Fusion Transfer Archive, version 1 (FTA1): the only way files enter a Docker verification container. There is no
 * host mount; the host streams an FTA1 archive over the container's attached stdin and the guest extracts it into
 * container-local tmpfs before any repository code runs. The same module is shipped INTO the guest (it imports only
 * Node built-ins), so host validation and guest extraction share one parser.
 *
 * Format (big-endian):
 *   "FTA1" magic, then entries:
 *     'D' u16 pathLength path                          directory (created 0755)
 *     'F' u16 pathLength path u8 flags u32 size bytes  regular file; flags bit 0 = executable (0755, else 0644)
 *     'E' u32 entryCount                               end; the count must match
 *
 * Only directories and regular files exist: no links, devices, owners, timestamps or setuid bits. Paths are canonical
 * relative POSIX paths — no absolute, drive, UNC or backslash form, no `.`/`..`/empty segment, no control character or
 * colon — and a parent directory must be declared before its children, so an entry can never land outside the
 * extraction root. Exact and case-insensitive duplicates are refused. Entry count, per-file size and total size are
 * capped by the caller; the reader also caps raw bytes, so a (decompressed) expansion bomb stops at the bound.
 */
import { createHash, type Hash } from "node:crypto";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { join } from "node:path";

export const FTA_MAGIC = Buffer.from("FTA1", "latin1");
export const FTA_LIMITS = Object.freeze({ maxPathBytes: 1024, maxSegmentBytes: 255 });
const KIND_DIRECTORY = 0x44, KIND_FILE = 0x46, KIND_END = 0x45;

export interface ArchiveLimits {
  readonly maxEntries: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  /** Path segments refused anywhere (compared case-insensitively), e.g. `node_modules` for repository source. */
  readonly forbiddenSegments?: readonly string[];
}
export interface ArchiveStats {
  readonly entries: number;
  readonly files: number;
  readonly directories: number;
  readonly bytes: number;
}

/** Stable, path-free failure codes; safe to surface from inside the container. */
export class TransferArchiveError extends Error {
  constructor(readonly code: string) { super(code); this.name = "TransferArchiveError"; }
}
const refuse = (code: string): never => { throw new TransferArchiveError(code); };

const CONTROL = /[\u0000-\u001f\u007f]/u;
/** Validates one archive path; returns it, or throws a stable code. Canonical form only — nothing is "normalized". */
export function validateArchivePath(path: string, forbidden: ReadonlySet<string> = new Set()): string {
  if (typeof path !== "string" || path.length === 0) return refuse("path-empty");
  if (Buffer.byteLength(path, "utf8") > FTA_LIMITS.maxPathBytes) return refuse("path-too-long");
  if (CONTROL.test(path)) return refuse("path-control-character");
  if (path.includes("\\")) return refuse("path-backslash");
  if (path.includes(":")) return refuse("path-drive-or-stream");
  if (path.startsWith("/")) return refuse("path-absolute");
  for (const segment of path.split("/")) {
    if (segment === "") return refuse("path-empty-segment");
    if (segment === "." || segment === "..") return refuse("path-traversal");
    if (Buffer.byteLength(segment, "utf8") > FTA_LIMITS.maxSegmentBytes) return refuse("path-segment-too-long");
    if (forbidden.has(segment.toLowerCase())) return refuse("path-forbidden-segment");
  }
  return path;
}
const collisionKey = (path: string): string => path.normalize("NFC").toLowerCase();
const parentOf = (path: string): string => { const index = path.lastIndexOf("/"); return index < 0 ? "" : path.slice(0, index); };

function checkLimits(limits: ArchiveLimits): void {
  for (const value of [limits.maxEntries, limits.maxFileBytes, limits.maxTotalBytes])
    if (!Number.isSafeInteger(value) || value < 1) refuse("limits-invalid");
  if (limits.maxFileBytes > 0xffffffff) refuse("limits-invalid");
}

/** Pull reader over a byte stream with a hard raw-byte ceiling and an optional hashing tap. */
export class ChunkReader {
  readonly #iterator: AsyncIterator<Uint8Array>;
  #buffer: Buffer;
  #done = false;
  consumed = 0;
  tap: Hash | undefined;
  constructor(source: AsyncIterable<Uint8Array>, private readonly maxBytes: number, initial: Buffer = Buffer.alloc(0)) {
    this.#iterator = source[Symbol.asyncIterator]();
    this.#buffer = initial;
  }
  async #fill(): Promise<boolean> {
    if (this.#done) return false;
    const next = await this.#iterator.next();
    if (next.done === true) { this.#done = true; return false; }
    const chunk = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    return true;
  }
  #take(count: number): Buffer {
    const out = this.#buffer.subarray(0, count);
    this.#buffer = this.#buffer.subarray(count);
    this.consumed += count;
    if (this.consumed > this.maxBytes) refuse("stream-too-large");
    this.tap?.update(out);
    return out;
  }
  /** Exactly `count` bytes, or `stream-truncated`. */
  async exact(count: number): Promise<Buffer> {
    while (this.#buffer.length < count) if (!await this.#fill()) refuse("stream-truncated");
    return Buffer.from(this.#take(count));
  }
  /** Yields exactly `count` bytes in pieces, without buffering them all. */
  async *range(count: number): AsyncGenerator<Buffer> {
    let left = count;
    while (left > 0) {
      if (this.#buffer.length === 0 && !await this.#fill()) refuse("stream-truncated");
      const piece = this.#take(Math.min(left, this.#buffer.length));
      left -= piece.length;
      yield piece;
    }
  }
  /** True when the source is exhausted and nothing is buffered. */
  async atEnd(): Promise<boolean> {
    while (this.#buffer.length === 0) if (!await this.#fill()) return true;
    return false;
  }
}

export interface ArchiveSink {
  directory(path: string): Promise<void>;
  /** Must consume `content` completely. */
  file(path: string, executable: boolean, size: number, content: AsyncIterable<Buffer>): Promise<void>;
}

/** Decodes one FTA1 archive from `reader` into `sink`, enforcing every structural rule and limit. */
export async function decodeArchive(reader: ChunkReader, sink: ArchiveSink, limits: ArchiveLimits): Promise<ArchiveStats> {
  checkLimits(limits);
  const forbidden = new Set((limits.forbiddenSegments ?? []).map(segment => segment.toLowerCase()));
  if (!(await reader.exact(FTA_MAGIC.length)).equals(FTA_MAGIC)) refuse("archive-magic");
  const seen = new Set<string>(), directories = new Set<string>([""]);
  let files = 0, dirs = 0, bytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (;;) {
    const kind = (await reader.exact(1))[0]!;
    if (kind === KIND_END) {
      const count = (await reader.exact(4)).readUInt32BE(0);
      if (count !== files + dirs) refuse("archive-count-mismatch");
      return Object.freeze({ entries: files + dirs, files, directories: dirs, bytes });
    }
    if (kind !== KIND_DIRECTORY && kind !== KIND_FILE) refuse("archive-entry-kind");
    if (files + dirs >= limits.maxEntries) refuse("archive-too-many-entries");
    const length = (await reader.exact(2)).readUInt16BE(0);
    if (length === 0 || length > FTA_LIMITS.maxPathBytes) refuse("path-too-long");
    let path: string;
    try { path = decoder.decode(await reader.exact(length)); } catch (error) {
      if (error instanceof TransferArchiveError) throw error;
      return refuse("path-not-utf8");
    }
    validateArchivePath(path, forbidden);
    const key = collisionKey(path);
    if (seen.has(key)) refuse("path-duplicate");
    seen.add(key);
    if (!directories.has(parentOf(path))) refuse("path-parent-undeclared");
    if (kind === KIND_DIRECTORY) {
      directories.add(path);
      dirs++;
      await sink.directory(path);
      continue;
    }
    const flags = (await reader.exact(1))[0]!;
    if ((flags & ~1) !== 0) refuse("file-flags");
    const size = (await reader.exact(4)).readUInt32BE(0);
    if (size > limits.maxFileBytes) refuse("file-too-large");
    bytes += size;
    if (bytes > limits.maxTotalBytes) refuse("archive-too-large");
    files++;
    await sink.file(path, (flags & 1) === 1, size, reader.range(size));
  }
}

/** Reader ceiling for one archive: content plus the largest possible framing for the entry cap. */
export const rawArchiveCeiling = (limits: ArchiveLimits): number =>
  FTA_MAGIC.length + 5 + limits.maxTotalBytes + limits.maxEntries * (1 + 2 + FTA_LIMITS.maxPathBytes + 1 + 4);

/** A sink that only drains content: structural validation without writing anything. */
export const validatingSink: ArchiveSink = {
  directory: () => Promise.resolve(),
  async file(_path, _executable, _size, content) { for await (const _ of content) { /* drain */ } },
};

/**
 * Extracts into `root`, which must already exist and be empty and Fusion-created. Directories are created one level at
 * a time and files with exclusive create, so nothing is overwritten and no link is ever created or followed.
 */
export function extractingSink(root: string): ArchiveSink {
  return {
    async directory(path) { await mkdir(join(root, ...path.split("/")), { mode: 0o755 }); },
    async file(path, executable, size, content) {
      const handle = await open(join(root, ...path.split("/")), "wx", executable ? 0o755 : 0o644);
      let written = 0;
      try {
        for await (const chunk of content) { await handle.write(chunk); written += chunk.length; }
      } finally { await handle.close(); }
      if (written !== size) refuse("file-size-mismatch");
    },
  };
}

// ---------------------------------------------------------------- encoding (host and guest producers)

export interface ArchiveEntry {
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly executable?: boolean;
  readonly size?: number;
}
function header(entry: ArchiveEntry): Buffer {
  const path = Buffer.from(entry.path, "utf8");
  if (entry.kind === "directory") {
    const out = Buffer.alloc(3 + path.length);
    out[0] = KIND_DIRECTORY; out.writeUInt16BE(path.length, 1); path.copy(out, 3);
    return out;
  }
  const out = Buffer.alloc(8 + path.length);
  out[0] = KIND_FILE; out.writeUInt16BE(path.length, 1); path.copy(out, 3);
  out[3 + path.length] = entry.executable === true ? 1 : 0;
  out.writeUInt32BE(entry.size!, 4 + path.length);
  return out;
}

/**
 * Encodes a planned entry list. `content` supplies each file's bytes and must produce exactly the planned size; a file
 * that changed size since planning fails the encode instead of producing a different archive.
 */
export async function* encodeArchive(entries: readonly ArchiveEntry[],
  content: (entry: ArchiveEntry) => AsyncIterable<Uint8Array>): AsyncGenerator<Buffer> {
  yield Buffer.from(FTA_MAGIC);
  for (const entry of entries) {
    yield header(entry);
    if (entry.kind !== "file") continue;
    let produced = 0;
    for await (const chunk of content(entry)) {
      produced += chunk.byteLength;
      if (produced > entry.size!) refuse("file-changed-during-encode");
      yield Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    if (produced !== entry.size) refuse("file-changed-during-encode");
  }
  const end = Buffer.alloc(5);
  end[0] = KIND_END; end.writeUInt32BE(entries.length, 1);
  yield end;
}

/** Bytes and SHA-256 of an encoded stream, by draining it once. */
export async function digestStream(stream: AsyncIterable<Uint8Array>): Promise<Readonly<{ sha256: string; bytes: number }>> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of stream) { hash.update(chunk); bytes += chunk.byteLength; }
  return Object.freeze({ sha256: hash.digest("hex"), bytes });
}

export interface TreePlanOptions {
  readonly limits: ArchiveLimits;
  /** Root-level names skipped silently (e.g. `.git`: repository metadata is never part of the verified input). */
  readonly skipRootNames?: readonly string[];
  /** Whether executable bits are carried (only meaningful on POSIX producers; Windows sources are always 0644). */
  readonly preserveExecutable?: boolean;
}
/**
 * Plans an archive of a real directory tree: regular files and directories only, sorted, bounded. A symbolic link,
 * junction or special file fails closed — it is never followed or copied.
 */
export async function planTree(root: string, options: TreePlanOptions): Promise<readonly ArchiveEntry[]> {
  checkLimits(options.limits);
  const forbidden = new Set((options.limits.forbiddenSegments ?? []).map(segment => segment.toLowerCase()));
  const skip = new Set(options.skipRootNames ?? []);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) refuse("tree-root-invalid");
  const entries: ArchiveEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  const walk = async (relative: string): Promise<void> => {
    const directory = relative === "" ? root : join(root, ...relative.split("/"));
    for (const name of (await readdir(directory)).sort()) {
      if (relative === "" && skip.has(name)) continue;
      const path = relative === "" ? name : `${relative}/${name}`;
      validateArchivePath(path, forbidden);
      const key = collisionKey(path);
      if (seen.has(key)) refuse("path-duplicate");
      seen.add(key);
      if (entries.length >= options.limits.maxEntries) refuse("archive-too-many-entries");
      const info = await lstat(join(directory, name));
      if (info.isSymbolicLink()) refuse("tree-link");
      if (info.isDirectory()) { entries.push({ path, kind: "directory" }); await walk(path); }
      else if (info.isFile()) {
        if (info.size > options.limits.maxFileBytes) refuse("file-too-large");
        total += info.size;
        if (total > options.limits.maxTotalBytes) refuse("archive-too-large");
        entries.push({ path, kind: "file", size: info.size,
          executable: options.preserveExecutable === true && (info.mode & 0o111) !== 0 });
      } else refuse("tree-special-file");
    }
  };
  await walk("");
  return Object.freeze(entries);
}

/** Streams exactly `size` bytes of a file planned by `planTree`; growth or shrinkage fails the encode. */
export async function* fileContent(root: string, entry: ArchiveEntry): AsyncGenerator<Buffer> {
  const handle = await open(join(root, ...entry.path.split("/")), "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== entry.size) refuse("file-changed-during-encode");
    const buffer = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, entry.size!)));
    let position = 0;
    while (position < entry.size!) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, entry.size! - position), position);
      if (bytesRead === 0) refuse("file-changed-during-encode");
      position += bytesRead;
      yield Buffer.from(buffer.subarray(0, bytesRead));
    }
  } finally { await handle.close(); }
}

/** Archive of in-memory files (small, Fusion-authored inputs such as canary files or dependency manifests). */
export function memoryArchive(files: Readonly<Record<string, Buffer>>): readonly [readonly ArchiveEntry[],
  (entry: ArchiveEntry) => AsyncIterable<Uint8Array>] {
  const entries: ArchiveEntry[] = [];
  const directories = new Set<string>();
  for (const path of Object.keys(files).sort()) {
    validateArchivePath(path);
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) {
      const directory = parts.slice(0, index).join("/");
      if (!directories.has(directory)) { directories.add(directory); entries.push({ path: directory, kind: "directory" }); }
    }
    entries.push({ path, kind: "file", size: files[path]!.length });
  }
  // Each directory is emitted immediately before its first child, so parents always precede children.
  return [Object.freeze(entries), async function* (entry) { yield files[entry.path]!; }];
}
