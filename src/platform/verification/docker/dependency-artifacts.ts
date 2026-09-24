import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { failWith } from "../../../core/errors.js";
import { readBoundedFile } from "../../fs/bounded-read.js";
import { removeOwnedTemporary } from "../../fs/temporary.js";
import { parseStrictJson } from "../../process/strict-json.js";
import { comparablePath } from "../../workspace/git.js";
import { dependencyIdentityKey, type DependencyIdentity } from "../dependency-policy.js";
import type { StreamedPart } from "./bundle.js";
import { ChunkReader, decodeArchive, digestStream, rawArchiveCeiling, validatingSink, type ArchiveLimits,
  type ArchiveStats } from "./transfer-archive.js";

/**
 * Host-side store of prepared dependency artifacts. Each entry is immutable once committed and is consumed
 * COPY-ON-USE: verification streams the compressed archive into the container, which extracts its own private copy
 * into tmpfs, so no run can modify the cache and nothing is shared between runs. Entries are keyed by the canonical
 * hash of their `DependencyIdentity` (manifest digests, pinned image, OS/arch, npm policy).
 *
 * Cache-poisoning defense, checked on EVERY use: the entry directory name, the record's key, the key recomputed from the
 * record's identity and the identity the caller expects must all agree; the archive's size and SHA-256 must match the
 * record. A mismatching entry is evicted (ownership-checked) and the use fails closed. Structure (paths, links, caps)
 * is validated when an entry is committed and again by the guest's extractor. The store lives in a Fusion-owned
 * directory with an ownership marker; nothing from any repository's `node_modules` is ever read.
 */
export const DEPENDENCY_ARTIFACT_LIMITS: ArchiveLimits = Object.freeze({ maxEntries: 250_000,
  maxFileBytes: 256 * 1024 * 1024, maxTotalBytes: 1536 * 1024 * 1024 });
export const MAX_COMPRESSED_ARTIFACT_BYTES = 768 * 1024 * 1024;
const STORE_MARKER = ".fusion-dependency-store";
const ARTIFACT = "artifact.fta.gz", RECORD = "record.json";
const KEY = /^[0-9a-f]{64}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export interface DependencyArtifactRecord {
  readonly schemaVersion: 1;
  readonly key: string;
  readonly identity: DependencyIdentity;
  readonly artifact: Readonly<{ sha256: string; compressedBytes: number; entries: number; files: number; directories: number;
    bytes: number }>;
  /** Observed while preparing. Lifecycle scripts are never executed; the list names packages installed without them. */
  readonly observed: Readonly<{ node: string; npm: string; lifecycleScriptsExecuted: false;
    installScriptPackagesSkipped: readonly string[]; rootScriptsSkipped: readonly string[] }>;
  readonly preparedAt: string;
}
export interface ValidatedArtifact {
  readonly record: DependencyArtifactRecord;
  /** The compressed archive as a streamable input part (gzip; digest over compressed bytes). */
  readonly part: StreamedPart & Readonly<{ compressed: "gzip" }>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  isRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Strict shape check of a stored record; anything unexpected is treated as tampering. */
function parseRecord(value: unknown): DependencyArtifactRecord | undefined {
  if (!exactKeys(value, ["schemaVersion", "key", "identity", "artifact", "observed", "preparedAt"]) || value.schemaVersion !== 1 ||
      typeof value.key !== "string" || !KEY.test(value.key) || typeof value.preparedAt !== "string" || !ISO_TIME.test(value.preparedAt))
    return undefined;
  const artifact = value.artifact, observed = value.observed;
  if (!exactKeys(artifact, ["sha256", "compressedBytes", "entries", "files", "directories", "bytes"]) ||
      typeof artifact.sha256 !== "string" || !SHA256.test(artifact.sha256) || !count(artifact.compressedBytes) ||
      artifact.compressedBytes > MAX_COMPRESSED_ARTIFACT_BYTES || !count(artifact.entries) || !count(artifact.files) ||
      !count(artifact.directories) || !count(artifact.bytes) || artifact.files + artifact.directories !== artifact.entries)
    return undefined;
  if (!exactKeys(observed, ["node", "npm", "lifecycleScriptsExecuted", "installScriptPackagesSkipped", "rootScriptsSkipped"]) ||
      observed.lifecycleScriptsExecuted !== false || typeof observed.node !== "string" || typeof observed.npm !== "string" ||
      !Array.isArray(observed.installScriptPackagesSkipped) || !Array.isArray(observed.rootScriptsSkipped))
    return undefined;
  if (!isRecord(value.identity)) return undefined;
  return value as unknown as DependencyArtifactRecord;
}

export type LookupOutcome = Readonly<{ state: "hit"; artifact: ValidatedArtifact }> | Readonly<{ state: "miss" }> |
  Readonly<{ state: "invalid"; reason: string; evicted: boolean }>;

export class DependencyArtifactStore {
  readonly root: string;
  constructor(root: string) {
    if (typeof root !== "string" || root.length === 0 || root.includes("\0")) failWith("InvalidInput", "Dependency store root is invalid.");
    this.root = resolve(root);
  }

  /** Creates the store (with its marker) or proves an existing directory is one. */
  async open(): Promise<void> {
    const info = await lstat(this.root).catch(() => undefined);
    if (info === undefined) {
      await mkdir(this.root, { recursive: true });
      await writeFile(join(this.root, STORE_MARKER), "fusion dependency store v1\n", { flag: "wx" }).catch(() => undefined);
    } else if (info.isSymbolicLink() || !info.isDirectory()) failWith("SecurityViolation", "Dependency store root is not a real directory.");
    const marker = await lstat(join(this.root, STORE_MARKER)).catch(() => undefined);
    if (marker === undefined || !marker.isFile() || marker.isSymbolicLink())
      failWith("SecurityViolation", "Dependency store root lacks the Fusion ownership marker.");
  }

  #entry(key: string): string {
    if (!KEY.test(key)) failWith("InvalidInput", "Dependency artifact key is invalid.");
    return join(this.root, key);
  }

  /** Removes one entry, only when it is a real directory directly inside this marked store. */
  async evict(key: string): Promise<boolean> {
    const path = this.#entry(key);
    if (comparablePath(dirname(path)) !== comparablePath(this.root) || basename(path) !== key) return false;
    const info = await lstat(path).catch(() => undefined);
    if (info === undefined) return true;
    if (info.isSymbolicLink() || !info.isDirectory()) return false;
    await removeOwnedTemporary(path);
    return lstat(path).then(() => false, () => true);
  }

  /**
   * Finds and validates the entry for `identity`. A tampered, mismatched or partial entry is evicted and reported as
   * `invalid`, never returned.
   */
  async lookup(identity: DependencyIdentity): Promise<LookupOutcome> {
    await this.open();
    const key = dependencyIdentityKey(identity);
    const path = this.#entry(key);
    const info = await lstat(path).catch(() => undefined);
    if (info === undefined) return { state: "miss" };
    const invalid = async (reason: string): Promise<LookupOutcome> => ({ state: "invalid", reason, evicted: await this.evict(key) });
    if (info.isSymbolicLink() || !info.isDirectory()) return invalid("entry-not-directory");
    let record: DependencyArtifactRecord | undefined;
    try { record = parseRecord(parseStrictJson((await readBoundedFile(join(path, RECORD), 64 * 1024)).toString("utf8"), 8)); }
    catch { return invalid("record-unreadable"); }
    if (record === undefined) return invalid("record-malformed");
    if (record.key !== key || dependencyIdentityKey(record.identity) !== key ||
        JSON.stringify(record.identity) !== JSON.stringify(identity))
      return invalid("identity-mismatch");
    const artifactPath = join(path, ARTIFACT);
    const artifactInfo = await lstat(artifactPath).catch(() => undefined);
    if (artifactInfo === undefined || artifactInfo.isSymbolicLink() || !artifactInfo.isFile() ||
        artifactInfo.size !== record.artifact.compressedBytes)
      return invalid("artifact-size-mismatch");
    const digest = await digestStream(createReadStream(artifactPath)).catch(() => undefined);
    if (digest === undefined || digest.sha256 !== record.artifact.sha256 || digest.bytes !== record.artifact.compressedBytes)
      return invalid("artifact-digest-mismatch");
    return { state: "hit", artifact: Object.freeze({ record, part: Object.freeze({ sha256: record.artifact.sha256,
      bytes: record.artifact.compressedBytes, limits: DEPENDENCY_ARTIFACT_LIMITS, compressed: "gzip" as const,
      chunks: () => createReadStream(artifactPath) as AsyncIterable<Uint8Array> }) }) };
  }

  /** A private staging directory for one preparation; it is either committed or removed. */
  async stage(): Promise<string> {
    await this.open();
    const path = join(this.root, `.staging-${randomBytes(16).toString("hex")}`);
    await mkdir(path);
    return path;
  }
  async discard(staging: string): Promise<void> {
    const name = basename(staging);
    if (comparablePath(dirname(resolve(staging))) !== comparablePath(this.root) || !/^\.staging-[0-9a-f]{32}$/u.test(name)) return;
    await removeOwnedTemporary(staging).catch(() => undefined);
  }
  artifactPath(staging: string): string { return join(staging, ARTIFACT); }
  /** Removes staging directories abandoned by a crashed preparation (older than `maxAgeMs`); returns how many. */
  async discardStaleStaging(nowMs: number, maxAgeMs = 2 * 60 * 60_000): Promise<number> {
    const exists = await lstat(this.root).then(info => info.isDirectory() && !info.isSymbolicLink(), () => false);
    if (!exists) return 0;
    let removed = 0;
    for (const name of (await readdir(this.root)).slice(0, 1024)) {
      if (!/^\.staging-[0-9a-f]{32}$/u.test(name)) continue;
      const info = await lstat(join(this.root, name));
      if (info.isSymbolicLink() || !info.isDirectory() || nowMs - info.mtimeMs < maxAgeMs) continue;
      await this.discard(join(this.root, name));
      removed++;
    }
    return removed;
  }

  /**
   * Validates a staged artifact's structure against the limits and its declared statistics, writes the record and
   * atomically moves the entry into place. A concurrent commit of the same key keeps the first entry.
   */
  async commit(staging: string, record: DependencyArtifactRecord): Promise<void> {
    const stats = await validateArtifactStructure(this.artifactPath(staging));
    const declared = record.artifact;
    if (stats.entries !== declared.entries || stats.files !== declared.files || stats.directories !== declared.directories ||
        stats.bytes !== declared.bytes)
      failWith("MalformedOutput", "Prepared dependency artifact contradicts its declared statistics.");
    if (record.key !== dependencyIdentityKey(record.identity)) failWith("InvalidInput", "Dependency record key is inconsistent.");
    await writeFile(join(staging, RECORD), JSON.stringify(record), { flag: "wx" });
    try { await rename(staging, this.#entry(record.key)); }
    catch (error) {
      await this.discard(staging);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY" &&
          (error as NodeJS.ErrnoException).code !== "EPERM")
        throw error;
    }
  }
}

/** Full structural validation of a compressed artifact: gzip, FTA1 rules, limits (expansion is capped). */
export async function validateArtifactStructure(path: string, limits: ArchiveLimits = DEPENDENCY_ARTIFACT_LIMITS): Promise<ArchiveStats> {
  let stats: ArchiveStats | undefined;
  await pipeline(createReadStream(path), createGunzip(), async (expanded: AsyncIterable<Buffer>) => {
    const reader = new ChunkReader(expanded, rawArchiveCeiling(limits));
    stats = await decodeArchive(reader, validatingSink, limits);
    if (!await reader.atEnd()) failWith("MalformedOutput", "Dependency artifact has trailing bytes.");
  });
  return stats!;
}

/** Test and diagnostics helper: the raw record of an entry (no validation). */
export async function readRawRecord(store: DependencyArtifactStore, key: string): Promise<string> {
  return readFile(join(store.root, key, RECORD), "utf8");
}
