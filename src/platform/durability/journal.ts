import { lstat, open } from "node:fs/promises";
import { canonicalJson, sha256Hex } from "../../core/delivery/canonical.js";
import { FusionFailure } from "../../core/errors.js";
import type { RecoveryState } from "../../core/durability/states.js";
import { readJsonl } from "../events/shared.js";

/**
 * v0.6 — the DURABLE RUN JOURNAL (§25, §26): an append-only, HASH-CHAINED, fsync-on-append log of typed facts. Correctness
 * never depends on wall-clock ordering — the explicit `seq` (contiguous from 1) and the hash chain are authoritative; the
 * timestamp is for observability only. Each record binds the previous record's hash, so truncation, a torn tail, a
 * sequence gap or duplicate, a rewritten middle record, a corrupted payload or an unsupported future schema are all
 * detected on read and fail closed as `JOURNAL_CORRUPT` / `RECOVERY_REQUIRED` — a corrupt security-critical log is never
 * guessed through, never read as a shorter clean one.
 *
 * This is not a second truth system (§56): it is the durable substrate the recovery planner, checkpoints and the
 * recoverable apply transaction record their reconstructible facts on, before each irreversible transition.
 */
export const JOURNAL_SCHEMA_VERSION = 1 as const;
export const JOURNAL_GENESIS_HASH = "0".repeat(64);
export const JOURNAL_LIMITS = Object.freeze({ maxLineBytes: 256 * 1024, maxRecords: 100_000 });

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;
const TYPE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;
const SHA = /^[0-9a-f]{64}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export interface JournalRecord {
  readonly schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  readonly seq: number;
  readonly type: string;
  readonly runId: string;
  readonly operationId: string | null;
  readonly objectId: string | null;
  /** Observability only; correctness never depends on it. */
  readonly at: string;
  readonly payload: unknown;
  /** SHA-256 of the canonical payload. */
  readonly payloadHash: string;
  /** The previous record's `recordHash` (or the genesis hash for `seq` 1). */
  readonly prevHash: string;
  /** SHA-256 of the canonical record without this field — binds every field above. */
  readonly recordHash: string;
}
/** The caller-supplied fields of one appended fact. */
export interface JournalAppend {
  readonly type: string;
  readonly runId: string;
  readonly operationId?: string | null;
  readonly objectId?: string | null;
  readonly payload: unknown;
  readonly at?: string;
}

/** A corrupt or unreconstructible journal. Carries the explicit recovery state; a corrupt log is never used as data. */
export class JournalCorruptError extends FusionFailure {
  constructor(readonly recoveryState: Extract<RecoveryState, "JOURNAL_CORRUPT" | "RECOVERY_REQUIRED">, why: string) {
    super({ kind: "SecurityViolation", retryable: false, safeMessage: `The run journal is corrupt (${why}); it is not read as any state.` });
    this.name = "JournalCorruptError";
  }
}

const RECORD_KEYS = ["schemaVersion", "seq", "type", "runId", "operationId", "objectId", "at", "payload", "payloadHash", "prevHash", "recordHash"];

/** The hash a record commits to: canonical over every field except `recordHash` itself. */
function computeRecordHash(record: Omit<JournalRecord, "recordHash">): string {
  return sha256Hex(canonicalJson({ ...record, recordHash: "" }));
}

/** Builds the next record from the previous one (or genesis) and the append input. Pure. */
export function nextRecord(previous: JournalRecord | null, input: JournalAppend, at: string): JournalRecord {
  if (typeof input.type !== "string" || !TYPE.test(input.type)) throw new FusionFailure({ kind: "InvalidInput", retryable: false, safeMessage: "A journal record needs a valid type." });
  if (typeof input.runId !== "string" || !RUN_ID.test(input.runId)) throw new FusionFailure({ kind: "InvalidInput", retryable: false, safeMessage: "A journal record needs a valid run id." });
  const operationId = input.operationId ?? null;
  const objectId = input.objectId ?? null;
  if (operationId !== null && (typeof operationId !== "string" || !ID.test(operationId))) throw new FusionFailure({ kind: "InvalidInput", retryable: false, safeMessage: "A journal operation id is malformed." });
  if (objectId !== null && (typeof objectId !== "string" || !ID.test(objectId))) throw new FusionFailure({ kind: "InvalidInput", retryable: false, safeMessage: "A journal object id is malformed." });
  if (!ISO.test(at)) throw new FusionFailure({ kind: "InvalidInput", retryable: false, safeMessage: "A journal record needs an ISO timestamp." });
  const payloadHash = sha256Hex(canonicalJson(input.payload ?? null));
  const withoutHash: Omit<JournalRecord, "recordHash"> = {
    schemaVersion: JOURNAL_SCHEMA_VERSION, seq: previous === null ? 1 : previous.seq + 1, type: input.type, runId: input.runId,
    operationId, objectId, at, payload: input.payload ?? null, payloadHash, prevHash: previous === null ? JOURNAL_GENESIS_HASH : previous.recordHash,
  };
  return Object.freeze({ ...withoutHash, recordHash: computeRecordHash(withoutHash) });
}

/** Validates one untrusted record's shape and self-consistency (its own hashes); chain position is checked by the reader. */
export function validateJournalRecord(value: unknown): JournalRecord {
  const r = value as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || Array.isArray(r)) throw new JournalCorruptError("JOURNAL_CORRUPT", "a record is not an object");
  if (r.schemaVersion !== JOURNAL_SCHEMA_VERSION) throw new JournalCorruptError("JOURNAL_CORRUPT", "unsupported record schema");
  if (Object.keys(r).length !== RECORD_KEYS.length || !RECORD_KEYS.every(k => Object.hasOwn(r, k)))
    throw new JournalCorruptError("JOURNAL_CORRUPT", "a record has an invalid shape");
  if (!Number.isSafeInteger(r.seq) || (r.seq as number) < 1) throw new JournalCorruptError("JOURNAL_CORRUPT", "a record has an invalid sequence");
  if (typeof r.type !== "string" || !TYPE.test(r.type) || typeof r.runId !== "string" || !RUN_ID.test(r.runId) ||
      !(r.operationId === null || (typeof r.operationId === "string" && ID.test(r.operationId))) ||
      !(r.objectId === null || (typeof r.objectId === "string" && ID.test(r.objectId))) ||
      typeof r.at !== "string" || !ISO.test(r.at) || typeof r.payloadHash !== "string" || !SHA.test(r.payloadHash) ||
      typeof r.prevHash !== "string" || !SHA.test(r.prevHash) || typeof r.recordHash !== "string" || !SHA.test(r.recordHash))
    throw new JournalCorruptError("JOURNAL_CORRUPT", "a record has an invalid field");
  if (sha256Hex(canonicalJson(r.payload ?? null)) !== r.payloadHash) throw new JournalCorruptError("JOURNAL_CORRUPT", "a payload hash does not match its payload");
  const rebuilt = computeRecordHash({ schemaVersion: JOURNAL_SCHEMA_VERSION, seq: r.seq as number, type: r.type, runId: r.runId,
    operationId: r.operationId as string | null, objectId: r.objectId as string | null, at: r.at, payload: r.payload,
    payloadHash: r.payloadHash, prevHash: r.prevHash });
  if (rebuilt !== r.recordHash) throw new JournalCorruptError("JOURNAL_CORRUPT", "a record hash does not bind its contents");
  return Object.freeze({ ...(r as unknown as JournalRecord) });
}

/**
 * Reads and fully verifies a journal file into its records. A missing file is an empty journal (`[]`). Any break —
 * truncation/torn tail, a non-JSON or malformed line, a sequence that is not contiguous from 1, a broken hash chain, a
 * payload that does not match its hash, or an unsupported schema — throws `JournalCorruptError`. Never returns a partial
 * or "cleaned" view.
 */
export async function readJournal(path: string): Promise<readonly JournalRecord[]> {
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined) return Object.freeze([]);
  if (!info.isFile() || info.isSymbolicLink()) throw new JournalCorruptError("JOURNAL_CORRUPT", "the journal is not a regular file");
  const records: JournalRecord[] = [];
  let expectedSeq = 1;
  let prevHash = JOURNAL_GENESIS_HASH;
  try {
    for await (const item of readJsonl(path, JOURNAL_LIMITS.maxLineBytes)) {
      if ("diagnostic" in item) throw new JournalCorruptError("RECOVERY_REQUIRED", "the final record is torn (a crash mid-append)");
      const record = validateJournalRecord(item.value);
      if (record.seq !== expectedSeq) throw new JournalCorruptError("JOURNAL_CORRUPT", `a sequence is out of order (expected ${expectedSeq})`);
      if (record.prevHash !== prevHash) throw new JournalCorruptError("JOURNAL_CORRUPT", "the hash chain is broken");
      if (records.length >= JOURNAL_LIMITS.maxRecords) throw new JournalCorruptError("JOURNAL_CORRUPT", "the journal exceeds its record bound");
      records.push(record);
      expectedSeq++;
      prevHash = record.recordHash;
    }
  } catch (error) {
    if (error instanceof JournalCorruptError) throw error;
    // A malformed line, a non-JSON record or a bad length from the byte-framed reader: corrupt, never guessed through.
    throw new JournalCorruptError("JOURNAL_CORRUPT", "a record could not be read");
  }
  return Object.freeze(records);
}

/**
 * An append-only journal writer bound to one file. It re-reads and verifies the tail before each append (so a concurrent
 * or prior corruption is caught before another record is chained onto it), computes the chained record and writes one
 * fsync'd line. Single-writer safety is the caller's lease's job; this class assumes it holds the write lease.
 */
export class RunJournal {
  #last: JournalRecord | null = null;
  #loaded = false;
  private constructor(readonly path: string) {}

  static async open(path: string): Promise<RunJournal> {
    const journal = new RunJournal(path);
    const records = await readJournal(path);
    journal.#last = records.at(-1) ?? null;
    journal.#loaded = true;
    return journal;
  }

  get lastSeq(): number { return this.#last?.seq ?? 0; }
  get headHash(): string { return this.#last?.recordHash ?? JOURNAL_GENESIS_HASH; }

  /** Appends one durable, chained record and returns it. fsync before returning (the fact is durable before we proceed). */
  async append(input: JournalAppend): Promise<JournalRecord> {
    if (!this.#loaded) throw new FusionFailure({ kind: "InternalError", retryable: false, safeMessage: "The journal was not opened." });
    const record = nextRecord(this.#last, input, input.at ?? new Date().toISOString());
    const info = await lstat(this.path).catch(() => undefined);
    if (info !== undefined && (!info.isFile() || info.isSymbolicLink()))
      throw new JournalCorruptError("JOURNAL_CORRUPT", "the journal is not a regular file");
    const line = `${canonicalJson({ ...record })}\n`;
    if (Buffer.byteLength(line, "utf8") > JOURNAL_LIMITS.maxLineBytes)
      throw new FusionFailure({ kind: "InvalidInput", retryable: false, safeMessage: "A journal record exceeds its size bound." });
    const handle = await open(this.path, info === undefined ? "wx" : "a", 0o600);
    try { await handle.appendFile(line, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    this.#last = record;
    return record;
  }
}
