import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isDeepStrictEqual } from "node:util";
import { DiagnosticRedactor } from "../../core/policy/redaction.js";
import { STORAGE_SCHEMA_VERSION, assertId, enqueuePath, finiteNonnegative, isRecord, makeId,
  readJsonl, resolveArtifactRelative, safeShortText, safeTimestamp, schemaVersion, StorageError } from "./shared.js";
import type { ArtifactKind, ArtifactMetadata } from "./types.js";

export interface ArtifactLimits { readonly maxInMemoryBytes?: number; readonly maxCopiedBytes?: number }
const KIND_EXTENSION: Record<ArtifactKind, string> = {
  text: "txt", json: "json", jsonl: "jsonl", binary: "bin", copiedFile: "bin",
};
const KIND_MEDIA: Record<ArtifactKind, string> = {
  text: "text/plain; charset=utf-8", json: "application/json", jsonl: "application/x-ndjson",
  binary: "application/octet-stream", copiedFile: "application/octet-stream",
};
const artifactQueues = new Map<string, { tail: Promise<void> }>();
export const pendingArtifactQueueCount = (): number => artifactQueues.size;
function artifactFailure(error: unknown, message: string): StorageError {
  return error instanceof StorageError ? error :
    new StorageError("ArtifactError", message, undefined, { cause: error });
}
async function artifactRead<T>(operation: () => Promise<T>, message: string): Promise<T> {
  try { return await operation(); }
  catch (error) { throw artifactFailure(error, message); }
}
function positiveLimit(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new StorageError("StorageError", "Invalid artifact size limit.");
  return result;
}
function rejectForbiddenJson(value: unknown, depth = 0): void {
  if (depth > 20) throw new StorageError("ArtifactError", "JSON artifact nesting exceeds limit.");
  if (Array.isArray(value)) { for (const child of value) rejectForbiddenJson(child, depth + 1); return; }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(env|environment|rawAuth|authResponse|headers|cookies|messages|conversation|transcript)$/iu.test(key))
      throw new StorageError("ArtifactError", "Forbidden raw evidence field in JSON artifact.");
    rejectForbiddenJson(child, depth + 1);
  }
}
async function ensureDirectory(path: string): Promise<void> {
  try { await mkdir(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new StorageError("InvalidArtifactPath", "Artifact directory is not a real directory.");
}

export class ArtifactStore {
  readonly root: string;
  readonly indexPath: string;
  readonly maxInMemoryBytes: number;
  readonly maxCopiedBytes: number;
  private constructor(readonly runDirectory: string, readonly runId: string,
    private readonly redactor: DiagnosticRedactor, limits: ArtifactLimits) {
    this.root = join(runDirectory, "artifacts");
    this.indexPath = join(this.root, "index.jsonl");
    this.maxInMemoryBytes = positiveLimit(limits.maxInMemoryBytes, 4 * 1024 * 1024);
    this.maxCopiedBytes = positiveLimit(limits.maxCopiedBytes, 100 * 1024 * 1024);
  }
  static async open(runDirectory: string, runId: string,
    redactor = DiagnosticRedactor.fromEnvironment(process.env), limits: ArtifactLimits = {}): Promise<ArtifactStore> {
    assertId(runId, "r");
    try {
      const store = new ArtifactStore(runDirectory, runId, redactor, limits);
      await ensureDirectory(store.root);
      try { const file = await open(store.indexPath, "wx", 0o600); await file.close(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const info = await lstat(store.indexPath);
      if (!info.isFile() || info.isSymbolicLink())
        throw new StorageError("ArtifactError", "Artifact index is not a regular file.");
      return store;
    } catch (error) { throw artifactFailure(error, "Could not open artifact store."); }
  }
  /** Public read helper; rejects traversal, absolute paths, alternate separators and device names. */
  resolveRelativePath(relative: string): string { return resolveArtifactRelative(this.root, relative); }
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    return enqueuePath(artifactQueues, this.indexPath, () => ({ tail: Promise.resolve() }), task);
  }
  private async index(metadata: ArtifactMetadata): Promise<void> {
    await ensureDirectory(this.root);
    const info = await lstat(this.indexPath);
    if (!info.isFile() || info.isSymbolicLink())
      throw new StorageError("ArtifactError", "Artifact index is not a regular file.");
    const handle = await open(this.indexPath, "a");
    try { await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
  }
  private async storeBuffer(kind: ArtifactKind, bytes: Buffer, producer?: string): Promise<ArtifactMetadata> {
    if (bytes.length > this.maxInMemoryBytes) throw new StorageError("ArtifactTooLarge", "Artifact exceeds in-memory limit.");
    return this.enqueue(async () => {
      const artifactId = makeId("a"), relativePath = `${kind}/${artifactId}.${KIND_EXTENSION[kind]}`;
      const directory = join(this.root, kind), destination = this.resolveRelativePath(relativePath);
      await ensureDirectory(this.root);
      await ensureDirectory(directory);
      const temp = this.resolveRelativePath(`${kind}/.${artifactId}.tmp`);
      let handle;
      let renamed = false;
      try {
        handle = await open(temp, "wx", 0o600);
        await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
        await rename(temp, destination); renamed = true;
        const metadata: ArtifactMetadata = { schemaVersion: STORAGE_SCHEMA_VERSION, artifactId, runId: this.runId,
          kind, mediaType: KIND_MEDIA[kind], relativePath, byteSize: bytes.length,
          createdAt: new Date().toISOString(),
          ...(producer === undefined ? {} : { producer: this.redactor.redactText(safeShortText(producer, "artifact producer")) }),
          sha256: createHash("sha256").update(bytes).digest("hex") };
        await this.index(metadata);
        return metadata;
      } catch (error) {
        if (handle) await handle.close().catch(() => {});
        await rm(temp, { force: true }).catch(() => {});
        if (renamed) await rm(destination, { force: true }).catch(() => {});
        throw artifactFailure(error, "Could not write artifact.");
      }
    }).catch(error => { throw artifactFailure(error, "Could not write artifact."); });
  }
  storeText(text: string, producer?: string): Promise<ArtifactMetadata> {
    if (typeof text !== "string") throw new StorageError("ArtifactError", "Text artifact must be a string.");
    if (Buffer.byteLength(text, "utf8") > this.maxInMemoryBytes)
      throw new StorageError("ArtifactTooLarge", "Artifact exceeds in-memory limit.");
    return this.storeBuffer("text", Buffer.from(this.redactor.redactText(text), "utf8"), producer);
  }
  storeJson(value: unknown, producer?: string): Promise<ArtifactMetadata> {
    let text: string | undefined;
    try {
      rejectForbiddenJson(value);
      text = JSON.stringify(this.redactor.redact(value));
    } catch (error) { throw artifactFailure(error, "Could not serialize JSON artifact."); }
    if (text === undefined) throw new StorageError("ArtifactError", "JSON artifact is not serializable.");
    if (Buffer.byteLength(text, "utf8") + 1 > this.maxInMemoryBytes)
      throw new StorageError("ArtifactTooLarge", "Artifact exceeds in-memory limit.");
    return this.storeBuffer("json", Buffer.from(`${text}\n`, "utf8"), producer);
  }
  storeJsonl(values: readonly unknown[], producer?: string): Promise<ArtifactMetadata> {
    if (!Array.isArray(values)) throw new StorageError("ArtifactError", "JSONL artifact requires records.");
    const lines: string[] = [];
    let total = 0;
    for (const value of values) {
      let line: string | undefined;
      try {
        rejectForbiddenJson(value);
        line = JSON.stringify(this.redactor.redact(value));
      } catch (error) { throw artifactFailure(error, "Could not serialize JSONL artifact."); }
      if (line === undefined) throw new StorageError("ArtifactError", "JSONL record is not serializable.");
      total += Buffer.byteLength(line, "utf8") + 1;
      if (total > this.maxInMemoryBytes) throw new StorageError("ArtifactTooLarge", "Artifact exceeds in-memory limit.");
      lines.push(line);
    }
    return this.storeBuffer("jsonl", Buffer.from(lines.map(line => `${line}\n`).join(""), "utf8"), producer);
  }
  storeBytes(bytes: Uint8Array, producer?: string): Promise<ArtifactMetadata> {
    if (!(bytes instanceof Uint8Array)) throw new StorageError("ArtifactError", "Binary artifact requires bytes.");
    if (bytes.length > this.maxInMemoryBytes) throw new StorageError("ArtifactTooLarge", "Artifact exceeds in-memory limit.");
    return this.storeBuffer("binary", Buffer.from(bytes), producer);
  }
  async copyFile(sourcePath: string, mediaType = KIND_MEDIA.copiedFile, producer?: string): Promise<ArtifactMetadata> {
    if (typeof sourcePath !== "string" || !sourcePath || !mediaType)
      throw new StorageError("ArtifactError", "Invalid copied artifact source.");
    const media = this.redactor.redactText(safeShortText(mediaType, "artifact media type", 128));
    return this.enqueue(async () => {
      await ensureDirectory(this.root);
      const sourceInfo = await lstat(sourcePath);
      if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink())
        throw new StorageError("ArtifactError", "Copied artifact source must be a regular file.");
      if (sourceInfo.size > this.maxCopiedBytes)
        throw new StorageError("ArtifactTooLarge", "Copied artifact exceeds size limit.");
      const artifactId = makeId("a"), kind = "copiedFile" as const;
      const relativePath = `${kind}/${artifactId}.bin`, directory = join(this.root, kind);
      await ensureDirectory(directory);
      const destination = this.resolveRelativePath(relativePath);
      const temp = this.resolveRelativePath(`${kind}/.${artifactId}.tmp`);
      let renamed = false;
      const source = await open(sourcePath, process.platform === "win32" ? constants.O_RDONLY :
        constants.O_RDONLY | constants.O_NOFOLLOW);
      let size = 0;
      const digest = createHash("sha256");
      try {
        const opened = await source.stat();
        if (!opened.isFile()) throw new StorageError("ArtifactError", "Copied source changed type.");
        const limit = this.maxCopiedBytes;
        const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          if (size > limit) {
            callback(new StorageError("ArtifactTooLarge", "Copied artifact exceeds size limit.")); return;
          }
          digest.update(chunk); callback(null, chunk);
        } });
        await pipeline(source.createReadStream({ autoClose: false }), limiter,
          createWriteStream(temp, { flags: "wx", mode: 0o600 }));
        const tempHandle = await open(temp, "r+");
        try { await tempHandle.sync(); } finally { await tempHandle.close(); }
        await rename(temp, destination); renamed = true;
        const metadata: ArtifactMetadata = { schemaVersion: STORAGE_SCHEMA_VERSION, artifactId, runId: this.runId,
          kind, mediaType: media, relativePath, byteSize: size, createdAt: new Date().toISOString(),
          ...(producer === undefined ? {} : { producer: this.redactor.redactText(safeShortText(producer, "artifact producer")) }),
          sha256: digest.digest("hex") };
        await this.index(metadata);
        return metadata;
      } catch (error) {
        await rm(temp, { force: true }).catch(() => {});
        if (renamed) await rm(destination, { force: true }).catch(() => {});
        throw error;
      } finally { await source.close(); }
    }).catch(error => { throw artifactFailure(error, "Could not copy artifact file."); });
  }
  async listMetadata(limit = 10000): Promise<readonly ArtifactMetadata[]> {
    return artifactRead(async () => {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new StorageError("ArtifactError", "Invalid artifact list limit.");
    await ensureDirectory(this.root);
    const records: ArtifactMetadata[] = [];
    for await (const item of readJsonl(this.indexPath)) {
      if ("diagnostic" in item) throw new StorageError("ArtifactError", "Artifact index has a truncated final record.", item.line);
      const value = item.value;
      schemaVersion(value);
      if (!isRecord(value)) throw new StorageError("ArtifactError", "Artifact metadata is invalid.", item.line);
      assertId(value.artifactId, "a");
      if (value.runId !== this.runId || !Object.hasOwn(KIND_EXTENSION, String(value.kind)) ||
          !finiteNonnegative(value.byteSize) || !Number.isSafeInteger(value.byteSize) ||
          typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.sha256) ||
          typeof value.relativePath !== "string" || typeof value.mediaType !== "string")
        throw new StorageError("ArtifactError", "Artifact metadata identity is invalid.", item.line);
      const kind = value.kind as ArtifactKind;
      if (value.relativePath !== `${kind}/${value.artifactId}.${KIND_EXTENSION[kind]}`)
        throw new StorageError("InvalidArtifactPath", "Artifact metadata path mismatches identity.", item.line);
      const metadata: ArtifactMetadata = { schemaVersion: STORAGE_SCHEMA_VERSION,
        artifactId: value.artifactId, runId: this.runId, kind,
        mediaType: safeShortText(value.mediaType, "artifact media type", 128),
        relativePath: value.relativePath, byteSize: value.byteSize,
        createdAt: safeTimestamp(value.createdAt, "artifact creation time"),
        ...(value.producer === undefined ? {} : { producer: safeShortText(value.producer, "artifact producer") }),
        sha256: value.sha256 };
      this.resolveRelativePath(metadata.relativePath);
      if (!isDeepStrictEqual(metadata, value))
        throw new StorageError("ArtifactError", "Artifact metadata has unsupported fields.", item.line);
      if (records.length >= limit) throw new StorageError("ArtifactError", "Artifact list limit exceeded.");
      records.push(metadata);
    }
    return records;
    }, "Could not read artifact index.");
  }
  async getArtifactPath(artifactId: string): Promise<string> {
    return artifactRead(async () => {
    assertId(artifactId, "a");
    await ensureDirectory(this.root);
    const metadata = (await this.listMetadata()).find(item => item.artifactId === artifactId);
    if (!metadata) throw new StorageError("ArtifactError", "Artifact ID was not found.");
    const path = this.resolveRelativePath(metadata.relativePath);
    const category = join(this.root, metadata.kind);
    const dirInfo = await lstat(category), fileInfo = await lstat(path);
    if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink() || !fileInfo.isFile() || fileInfo.isSymbolicLink())
      throw new StorageError("InvalidArtifactPath", "Artifact path is not a regular file inside its category.");
    return path;
    }, "Could not resolve artifact path.");
  }
}
