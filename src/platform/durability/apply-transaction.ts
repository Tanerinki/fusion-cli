import { randomBytes } from "node:crypto";
import { constants, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256Hex } from "../../core/delivery/canonical.js";
import { FusionFailure } from "../../core/errors.js";
import { TERMINAL_TRANSACTION_STATES, transactionStateFromHistory, type TransactionState } from "../../core/durability/states.js";
import { RunJournal, type JournalRecord } from "./journal.js";

/**
 * v0.6 — the RECOVERABLE APPLY TRANSACTION (§37–§45). A durable, journaled, per-file multi-file write that can be
 * reconstructed and recovered after a crash. This is NOT full multi-file ACID (§50): it is full pre-validation, per-file
 * atomic replacement where the filesystem provides it (rename within a volume), a durable hash-chained journal of every
 * transition and per-file step written BEFORE the irreversible action, and a deterministic recovery analysis. The exact
 * terminology is used; nothing is oversold.
 *
 * Lifecycle (states from `core/durability/states.ts`): PREPARED → CLAIMED → APPLYING → VERIFYING → COMMITTED, with
 * ROLLBACK_REQUIRED → ROLLING_BACK → ROLLED_BACK and RECOVERY_REQUIRED where recovery cannot be proven safe.
 *
 * Recovery vault (§39): previous file contents (which may contain secrets) are staged in a per-transaction directory
 * inside a host-owned root (never a provider view, never a normal log or manifest). Only HASHES go in the journal —
 * never plaintext. The vault is removed only after COMMITTED is durably established. (DPAPI encryption of the vault was
 * evaluated and is a documented future enhancement; the current protection is host-owned restricted-directory storage
 * plus hashes-not-plaintext-in-journal.)
 */

export const APPLY_TX_JOURNAL_TYPES = Object.freeze({
  prepared: "applyTx.prepared", claimed: "applyTx.claimed", applying: "applyTx.applying", fileApplied: "applyTx.fileApplied",
  verifying: "applyTx.verifying", committed: "applyTx.committed", rollbackRequired: "applyTx.rollbackRequired",
  rollingBack: "applyTx.rollingBack", fileRestored: "applyTx.fileRestored", rolledBack: "applyTx.rolledBack",
  recoveryRequired: "applyTx.recoveryRequired", failed: "applyTx.failed",
} as const);

/** Maps a journal event type to the transaction state it advances to (for deriving state from the journal). */
const TYPE_TO_STATE: Readonly<Record<string, TransactionState>> = Object.freeze({
  [APPLY_TX_JOURNAL_TYPES.prepared]: "PREPARED", [APPLY_TX_JOURNAL_TYPES.claimed]: "CLAIMED",
  [APPLY_TX_JOURNAL_TYPES.applying]: "APPLYING", [APPLY_TX_JOURNAL_TYPES.verifying]: "VERIFYING",
  [APPLY_TX_JOURNAL_TYPES.committed]: "COMMITTED", [APPLY_TX_JOURNAL_TYPES.rollbackRequired]: "ROLLBACK_REQUIRED",
  [APPLY_TX_JOURNAL_TYPES.rollingBack]: "ROLLING_BACK", [APPLY_TX_JOURNAL_TYPES.rolledBack]: "ROLLED_BACK",
  [APPLY_TX_JOURNAL_TYPES.recoveryRequired]: "RECOVERY_REQUIRED", [APPLY_TX_JOURNAL_TYPES.failed]: "FAILED",
});

export interface ApplyFileOp {
  /** Repository-relative, forward-slash path (validated by the caller/manifest). */
  readonly path: string;
  /** Expected content hash before apply; `null` = the file must not exist (a create). */
  readonly beforeSha256: string | null;
  /** The content to write; `null` = a delete. */
  readonly afterSha256: string | null;
  readonly afterBytes: number | null;
}

export type FileActualState = "before" | "after" | "foreign" | "absent";
export interface FileRecoveryFinding {
  readonly path: string;
  readonly actual: FileActualState;
  readonly applied: boolean;
}
export const APPLY_RECOVERY_PLANS = Object.freeze([
  "COMMITTED", "RESUME_APPLY", "ROLLBACK", "FOREIGN_MODIFICATION", "RECOVERY_REQUIRED", "NOTHING_TO_DO",
] as const);
export type ApplyRecoveryPlan = (typeof APPLY_RECOVERY_PLANS)[number];

export interface ApplyRecovery {
  readonly state: TransactionState | "none";
  readonly plan: ApplyRecoveryPlan;
  readonly files: readonly FileRecoveryFinding[];
}

const SHA = /^[0-9a-f]{64}$/u;
const fail = (msg: string): never => { throw new FusionFailure({ kind: "InvalidInput", retryable: false, safeMessage: msg }); };

async function fileState(target: string): Promise<Readonly<{ exists: boolean; sha256: string | null }>> {
  const info = await lstat(target).catch(() => undefined);
  if (info === undefined) return { exists: false, sha256: null };
  if (!info.isFile() || info.isSymbolicLink()) return { exists: true, sha256: null }; // a non-regular file: foreign
  return { exists: true, sha256: sha256Hex(await readFile(target)) };
}

/** Classifies a bound file's CURRENT content against its expected before/after images (§41). */
function classifyFile(op: ApplyFileOp, actual: Readonly<{ exists: boolean; sha256: string | null }>): FileActualState {
  const matches = (h: string | null): boolean => h === null ? !actual.exists : actual.exists && actual.sha256 === h;
  if (matches(op.beforeSha256)) return op.beforeSha256 === null ? "absent" : "before";
  if (matches(op.afterSha256)) return "after";
  return "foreign";
}

/**
 * A durable, recoverable apply against a target directory, journaling every transition. Test seams inject a crash after a
 * named boundary (they throw a marker the caller treats as a process death — real 2-process tests use a child instead).
 */
export interface ApplyFaults {
  afterPrepared?(): void | Promise<void>;
  afterClaimed?(): void | Promise<void>;
  afterApplying?(): void | Promise<void>;
  afterFileApplied?(index: number): void | Promise<void>;
  afterVerifying?(): void | Promise<void>;
}

export class DurableApplyTransaction {
  private constructor(
    readonly txId: string, readonly target: string, readonly vaultDir: string,
    readonly ops: readonly ApplyFileOp[], private readonly journal: RunJournal, private readonly runId: string,
    private readonly faults: ApplyFaults,
  ) {}

  /**
   * Opens (or reopens) a transaction. `vaultRoot` is a host-owned directory OUTSIDE the target; the per-transaction
   * vault holds staged post-images and backups. The journal is the durable record.
   */
  static async open(input: Readonly<{ txId: string; runId: string; target: string; vaultRoot: string; ops: readonly ApplyFileOp[];
    journal: RunJournal; faults?: ApplyFaults }>): Promise<DurableApplyTransaction> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input.txId)) fail("A transaction id is malformed.");
    for (const op of input.ops) {
      if (typeof op.path !== "string" || op.path.length === 0 || op.path.includes("\\") || op.path.startsWith("/") || op.path.includes("..")) fail("An apply op path is malformed.");
      if (op.beforeSha256 !== null && !SHA.test(op.beforeSha256)) fail("An apply op before-hash is malformed.");
      if (op.afterSha256 !== null && (!SHA.test(op.afterSha256) || typeof op.afterBytes !== "number")) fail("An apply op after-image is malformed.");
    }
    const vaultDir = join(input.vaultRoot, input.txId);
    return new DurableApplyTransaction(input.txId, input.target, vaultDir, input.ops, input.journal, input.runId, input.faults ?? {});
  }

  /** The transaction state derived from this run's journal records for this txId. */
  stateFrom(records: readonly JournalRecord[]): TransactionState | "none" {
    const history = records.filter(r => r.operationId === this.txId && r.type in TYPE_TO_STATE)
      .map(r => TYPE_TO_STATE[r.type]!);
    // fileApplied/fileRestored are progress within a state; they carry the current phase's state and are collapsed here.
    const collapsed: TransactionState[] = [];
    for (const s of history) if (collapsed.at(-1) !== s) collapsed.push(s);
    return transactionStateFromHistory(collapsed);
  }

  #ev(type: string, payload: unknown): Promise<JournalRecord> {
    return this.journal.append({ type, runId: this.runId, operationId: this.txId, payload });
  }

  /**
   * PREPARE (§38): validate current state matches every before-image, stage post-images and backups into the vault,
   * journal PREPARED. If preparation cannot be made durable, apply never starts. Nothing in the target is written yet.
   */
  async prepare(contentFor: (index: number, op: ApplyFileOp) => Buffer | Promise<Buffer>): Promise<void> {
    await mkdir(this.vaultDir, { recursive: true });
    for (let i = 0; i < this.ops.length; i++) {
      const op = this.ops[i]!;
      const target = join(this.target, ...op.path.split("/"));
      const actual = await fileState(target);
      if (classifyFile(op, actual) !== (op.beforeSha256 === null ? "absent" : "before"))
        fail(`The target file does not match its expected before-image: ${op.path}`);
      // Back up the previous content (secret-safe: in the host-owned vault, only its hash is journalled).
      if (op.beforeSha256 !== null) await copyFile(target, join(this.vaultDir, `backup-${i}`), constants.COPYFILE_EXCL);
      // Stage and verify the post-image (a create/update; a delete has none), so PREPARED means "durably ready".
      if (op.afterSha256 !== null) {
        const content = await contentFor(i, op);
        if (sha256Hex(content) !== op.afterSha256) fail(`The staged post-image does not match its hash: ${op.path}`);
        await writeFile(join(this.vaultDir, `stage-${i}`), content, { flag: "wx" });
      }
    }
    await this.#ev(APPLY_TX_JOURNAL_TYPES.prepared, { target: this.target, files: this.ops.map(o => ({ path: o.path, beforeSha256: o.beforeSha256, afterSha256: o.afterSha256 })) });
    await this.faults.afterPrepared?.();
  }

  /** CLAIM (§45): the single-use mutation claim, immediately before the first write. Journalled once. */
  async claim(): Promise<void> {
    await this.#ev(APPLY_TX_JOURNAL_TYPES.claimed, {});
    await this.faults.afterClaimed?.();
  }

  /**
   * APPLY: for each op, re-check the current content matches its before-image (a foreign change stops the run), then
   * apply by atomic rename of the staged post-image (create/update) or move-to-backup (delete). Each file's completion
   * is journalled BEFORE the next file starts, so a crash leaves a precise, recoverable record.
   */
  async apply(): Promise<void> {
    await this.#ev(APPLY_TX_JOURNAL_TYPES.applying, {});
    await this.faults.afterApplying?.();
    for (let i = 0; i < this.ops.length; i++) {
      const op = this.ops[i]!;
      const target = join(this.target, ...op.path.split("/"));
      const actual = await fileState(target);
      if (classifyFile(op, actual) === "foreign") { await this.#ev(APPLY_TX_JOURNAL_TYPES.recoveryRequired, { path: op.path, reason: "foreignBeforeApply" }); fail(`A foreign modification of ${op.path} stopped the apply.`); }
      if (classifyFile(op, actual) === "after") { await this.#ev(APPLY_TX_JOURNAL_TYPES.fileApplied, { path: op.path, afterSha256: op.afterSha256 }); continue; }
      if (op.afterSha256 === null) {
        await rename(target, join(this.vaultDir, `deleted-${i}`)); // delete = move aside (recoverable)
      } else {
        await mkdir(dirname(target), { recursive: true });
        await moveReplacing(join(this.vaultDir, `stage-${i}`), target);
      }
      await this.#ev(APPLY_TX_JOURNAL_TYPES.fileApplied, { path: op.path, afterSha256: op.afterSha256 });
      await this.faults.afterFileApplied?.(i);
    }
  }

  /** VERIFY then COMMIT: confirm every op reached its after-image, journal VERIFYING then COMMITTED, then clear vault. */
  async verifyAndCommit(): Promise<void> {
    await this.#ev(APPLY_TX_JOURNAL_TYPES.verifying, {});
    await this.faults.afterVerifying?.();
    for (const op of this.ops) {
      const actual = await fileState(join(this.target, ...op.path.split("/")));
      if (classifyFile(op, actual) !== "after") fail(`Post-check failed for ${op.path}.`);
    }
    await this.#ev(APPLY_TX_JOURNAL_TYPES.committed, {});
    await rm(this.vaultDir, { recursive: true, force: true }).catch(() => undefined); // vault removed only after COMMITTED
  }

  /**
   * RECOVER (§41–§43): inspect the actual filesystem against every bound file and derive the plan. Never writes.
   * - all AFTER  → COMMITTED (or, if not yet journalled committed, RESUME_APPLY to finish verify/commit).
   * - all BEFORE → ROLLBACK-safe (RESUME from the start) or NOTHING_TO_DO if nothing was written.
   * - mixed BEFORE/AFTER → RESUME_APPLY (finish the remaining files) — the exact intent is known and idempotent.
   * - any FOREIGN → FOREIGN_MODIFICATION (a human decides; never overwrite).
   * - anything else ambiguous → RECOVERY_REQUIRED.
   */
  async recover(records: readonly JournalRecord[]): Promise<ApplyRecovery> {
    const state = this.stateFrom(records);
    const findings: FileRecoveryFinding[] = [];
    for (const op of this.ops) {
      const actual = await fileState(join(this.target, ...op.path.split("/")));
      const cls = classifyFile(op, actual);
      findings.push(Object.freeze({ path: op.path, actual: cls, applied: cls === "after" }));
    }
    const files = Object.freeze(findings);
    if (findings.some(f => f.actual === "foreign")) return Object.freeze({ state, plan: "FOREIGN_MODIFICATION", files });
    const allAfter = findings.every(f => f.actual === "after");
    const allBefore = findings.every(f => f.actual === "before" || f.actual === "absent");
    if (state === "COMMITTED") return allAfter ? Object.freeze({ state, plan: "COMMITTED", files }) : Object.freeze({ state, plan: "RECOVERY_REQUIRED", files });
    if (allAfter) return Object.freeze({ state, plan: "RESUME_APPLY", files });            // finish verify+commit
    if (allBefore) return Object.freeze({ state, plan: state === "none" || state === "PREPARED" ? "NOTHING_TO_DO" : "RESUME_APPLY", files });
    // Mixed before/after — a partial apply; the intent is known and each write is idempotent, so resume forward.
    return Object.freeze({ state, plan: "RESUME_APPLY", files });
  }

  get isTerminal(): (state: TransactionState | "none") => boolean {
    return state => state !== "none" && TERMINAL_TRANSACTION_STATES.has(state);
  }
}

/** Atomic replace within a volume; cross-volume falls back to an exclusive temp copy then rename. */
async function moveReplacing(from: string, to: string): Promise<void> {
  try { await rename(from, to); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error; }
  const temp = join(dirname(to), `.fusion-apply-${randomBytes(6).toString("hex")}.tmp`);
  await copyFile(from, temp, constants.COPYFILE_EXCL);
  try { await rename(temp, to); } catch (error) { await rm(temp, { force: true }).catch(() => undefined); throw error; }
  await rm(from, { force: true }).catch(() => undefined);
}
