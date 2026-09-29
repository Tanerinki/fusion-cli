import { randomBytes } from "node:crypto";
import { lstat, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, sha256Hex } from "../../core/delivery/canonical.js";
import { FusionFailure } from "../../core/errors.js";
import type { RecoveryState } from "../../core/durability/states.js";
import type { Checkpointed } from "../../core/durability/replay.js";
import { JOURNAL_GENESIS_HASH, type JournalRecord } from "./journal.js";

/**
 * v0.6 — durable CHECKPOINTS (§27, §28). A checkpoint is a bounded, crash-safe snapshot of derived run state, BOUND to
 * an exact journal position (`journalSeq` + the `journalHeadHash` of the record at that position). It is an optimization:
 * the journal stays authoritative. On resume, the newest checkpoint is loaded, VERIFIED against the journal (a mismatch
 * is `CHECKPOINT_INVALID` — never trusted), and only the tail is replayed.
 *
 * Written crash-safely: a temp file (exclusive create, fsync), then an atomic rename over the versioned name. Bounded:
 * at most `maxCheckpoints` are kept; older ones are pruned only after a newer one is durably in place.
 */
export const CHECKPOINT_SCHEMA_VERSION = 1 as const;
export const CHECKPOINT_LIMITS = Object.freeze({ maxBytes: 4 * 1024 * 1024, maxCheckpoints: 8 });
const CHECKPOINT_FILE = /^checkpoint-(\d{1,12})\.json$/u;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;
const SHA = /^[0-9a-f]{64}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export interface RunCheckpoint<S = unknown> {
  readonly schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION;
  readonly runId: string;
  /** The journal sequence this snapshot was taken after (0 = before any record). */
  readonly journalSeq: number;
  /** The `recordHash` of the journal record at `journalSeq` (genesis hash when `journalSeq` is 0). */
  readonly journalHeadHash: string;
  readonly stateSchemaVersion: number;
  readonly state: S;
  readonly at: string;
  /** SHA-256 of the canonical checkpoint without this field. */
  readonly checkpointHash: string;
}

export class CheckpointInvalidError extends FusionFailure {
  constructor(readonly recoveryState: Extract<RecoveryState, "CHECKPOINT_INVALID">, why: string) {
    super({ kind: "SecurityViolation", retryable: false, safeMessage: `A run checkpoint is invalid (${why}); it is not used.` });
    this.name = "CheckpointInvalidError";
  }
}

const KEYS = ["schemaVersion", "runId", "journalSeq", "journalHeadHash", "stateSchemaVersion", "state", "at", "checkpointHash"];
const hashOf = (c: Omit<RunCheckpoint, "checkpointHash">): string => sha256Hex(canonicalJson({ ...c, checkpointHash: "" }));

export function buildCheckpoint<S>(input: Readonly<{ runId: string; journalSeq: number; journalHeadHash: string;
  stateSchemaVersion: number; state: S; at?: string }>): RunCheckpoint<S> {
  if (typeof input.runId !== "string" || !RUN_ID.test(input.runId)) throw new FusionFailure({ kind: "InvalidInput", retryable: false, safeMessage: "A checkpoint needs a valid run id." });
  if (!Number.isSafeInteger(input.journalSeq) || input.journalSeq < 0) throw new FusionFailure({ kind: "InvalidInput", retryable: false, safeMessage: "A checkpoint needs a valid journal sequence." });
  if (typeof input.journalHeadHash !== "string" || !SHA.test(input.journalHeadHash)) throw new FusionFailure({ kind: "InvalidInput", retryable: false, safeMessage: "A checkpoint needs the journal head hash." });
  if (!Number.isSafeInteger(input.stateSchemaVersion) || input.stateSchemaVersion < 1) throw new FusionFailure({ kind: "InvalidInput", retryable: false, safeMessage: "A checkpoint needs a state schema version." });
  const at = input.at ?? new Date().toISOString();
  if (!ISO.test(at)) throw new FusionFailure({ kind: "InvalidInput", retryable: false, safeMessage: "A checkpoint needs an ISO timestamp." });
  const withoutHash: Omit<RunCheckpoint<S>, "checkpointHash"> = { schemaVersion: CHECKPOINT_SCHEMA_VERSION, runId: input.runId,
    journalSeq: input.journalSeq, journalHeadHash: input.journalHeadHash, stateSchemaVersion: input.stateSchemaVersion, state: input.state, at };
  return Object.freeze({ ...withoutHash, checkpointHash: hashOf(withoutHash) });
}

export function validateCheckpoint(value: unknown): RunCheckpoint {
  const c = value as Record<string, unknown> | null;
  if (c === null || typeof c !== "object" || Array.isArray(c) || c.schemaVersion !== CHECKPOINT_SCHEMA_VERSION)
    throw new CheckpointInvalidError("CHECKPOINT_INVALID", "unsupported or missing schema");
  if (Object.keys(c).length !== KEYS.length || !KEYS.every(k => Object.hasOwn(c, k)) ||
      typeof c.runId !== "string" || !RUN_ID.test(c.runId) || !Number.isSafeInteger(c.journalSeq) || (c.journalSeq as number) < 0 ||
      typeof c.journalHeadHash !== "string" || !SHA.test(c.journalHeadHash) || !Number.isSafeInteger(c.stateSchemaVersion) ||
      (c.stateSchemaVersion as number) < 1 || typeof c.at !== "string" || !ISO.test(c.at) ||
      typeof c.checkpointHash !== "string" || !SHA.test(c.checkpointHash))
    throw new CheckpointInvalidError("CHECKPOINT_INVALID", "an invalid field");
  const rebuilt = hashOf({ schemaVersion: CHECKPOINT_SCHEMA_VERSION, runId: c.runId, journalSeq: c.journalSeq as number,
    journalHeadHash: c.journalHeadHash, stateSchemaVersion: c.stateSchemaVersion as number, state: c.state, at: c.at });
  if (rebuilt !== c.checkpointHash) throw new CheckpointInvalidError("CHECKPOINT_INVALID", "the hash does not bind its contents");
  return Object.freeze({ ...(c as unknown as RunCheckpoint) });
}

/** Crash-safe write: temp (exclusive, fsync), atomic rename over `checkpoint-<seq>.json`, then prune to the bound. */
export async function writeCheckpoint(dir: string, checkpoint: RunCheckpoint): Promise<void> {
  const body = canonicalJson({ ...checkpoint });
  if (Buffer.byteLength(body, "utf8") > CHECKPOINT_LIMITS.maxBytes) throw new FusionFailure({ kind: "InvalidInput", retryable: false, safeMessage: "The checkpoint exceeds its size bound." });
  const final = join(dir, `checkpoint-${checkpoint.journalSeq}.json`);
  const temp = join(dir, `.checkpoint-${checkpoint.journalSeq}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temp, "wx", 0o600);
  try { await handle.writeFile(body, "utf8"); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temp, final); } catch (error) { await rm(temp, { force: true }).catch(() => undefined); throw error; }
  await pruneCheckpoints(dir);
}

/** Keeps the newest {@link CHECKPOINT_LIMITS.maxCheckpoints} by journal sequence; removes older ones. */
async function pruneCheckpoints(dir: string): Promise<void> {
  const seqs = (await readdir(dir).catch(() => [] as string[]))
    .map(name => ({ name, m: CHECKPOINT_FILE.exec(name) })).filter(e => e.m !== null)
    .map(e => ({ name: e.name, seq: Number(e.m![1]) })).sort((a, b) => b.seq - a.seq);
  for (const stale of seqs.slice(CHECKPOINT_LIMITS.maxCheckpoints)) await rm(join(dir, stale.name), { force: true }).catch(() => undefined);
}

/**
 * Loads the newest checkpoint whose file validates, trying higher sequences first. A file that fails validation is
 * skipped (a partially-written older checkpoint never blocks recovery); `null` when none validates. Symlinks/reparse
 * points are refused.
 */
export async function readNewestCheckpoint(dir: string): Promise<RunCheckpoint | null> {
  const seqs = (await readdir(dir).catch(() => [] as string[]))
    .map(name => ({ name, m: CHECKPOINT_FILE.exec(name) })).filter(e => e.m !== null)
    .map(e => ({ name: e.name, seq: Number(e.m![1]) })).sort((a, b) => b.seq - a.seq);
  for (const { name } of seqs) {
    const path = join(dir, name);
    const info = await lstat(path).catch(() => undefined);
    if (info === undefined || !info.isFile() || info.isSymbolicLink() || info.size > CHECKPOINT_LIMITS.maxBytes) continue;
    try { return validateCheckpoint(JSON.parse(await readFile(path, "utf8"))); } catch { /* try an older one */ }
  }
  return null;
}

/**
 * Verifies a checkpoint binds THIS journal and returns the `Checkpointed` snapshot for replay. The checkpoint's
 * `journalSeq` must be within the journal, and the record at that position (or genesis for 0) must have the checkpoint's
 * `journalHeadHash`. A mismatch is `CHECKPOINT_INVALID` — a checkpoint from another/rewritten journal is never trusted.
 */
export function reconcileCheckpoint<S>(checkpoint: RunCheckpoint<S>, records: readonly JournalRecord[]): Checkpointed<S> {
  if (checkpoint.journalSeq > records.length)
    throw new CheckpointInvalidError("CHECKPOINT_INVALID", "it is ahead of the journal");
  const headHash = checkpoint.journalSeq === 0 ? JOURNAL_GENESIS_HASH : records[checkpoint.journalSeq - 1]!.recordHash;
  if (headHash !== checkpoint.journalHeadHash)
    throw new CheckpointInvalidError("CHECKPOINT_INVALID", "it does not bind this journal (a snapshot/journal mismatch)");
  return { journalSeq: checkpoint.journalSeq, state: checkpoint.state };
}
