import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { validateChangeSet } from "../core/change/contract.js";
import { canonicalJson, sha256Hex } from "../core/delivery/canonical.js";
import type { ChangeScope } from "../core/domain.js";
import type { WorkflowResult } from "../core/workflow/types.js";
import { ensureFusionStorageRoot, ensureOwnedDir } from "../platform/events/run-store.js";
import { atomicJson } from "../platform/events/shared.js";
import { readBoundedFile } from "../platform/fs/bounded-read.js";

/**
 * v0.6 I7 — the durable CANDIDATE-RESULT STORE. Persists each COMPLETED tournament candidate's generation result so a
 * crash does not force its expensive provider turn to be re-run (§13, §34). On resume, a completed candidate's result
 * is REUSED at the generation boundary; the tournament's evaluation, experiments, mesh and selection then run
 * identically (they re-materialize from the persisted `changeSet` via the workspace port), so the interrupted run's
 * final decision follows the same v0.5 evidence rules as an uninterrupted one.
 *
 * This is the ONE place Fusion persists a candidate's change content to disk. It is HOST-OWNED (in
 * `.fusion/durable/<runId>/candidates/`, self-ignored, never a provider view, never sent anywhere) and is cleaned up
 * with the run. Only the fields the tournament's downstream uses are persisted (never a live workspace handle), each
 * entry is content-hashed, and a torn/invalid/foreign entry is IGNORED (the candidate is simply re-run — fail safe).
 */
export const CANDIDATE_RESULT_FORMAT = "fusion.candidateResult" as const;
export const CANDIDATE_RESULT_VERSION = 1 as const;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/** The persisted, reusable projection of a completed candidate's result — the fields evaluation/selection consume. */
interface StoredCandidateResult {
  readonly format: typeof CANDIDATE_RESULT_FORMAT;
  readonly version: typeof CANDIDATE_RESULT_VERSION;
  readonly runId: string;
  readonly candidateId: string;
  /** SHA-256 of the canonical `result` payload — binds the reused result to exactly these bytes. */
  readonly resultHash: string;
  readonly result: unknown;
}

/** The subset of WorkflowResult that is durable and reusable (never a workspace handle). */
function reusableProjection(result: WorkflowResult): Record<string, unknown> {
  const keys: (keyof WorkflowResult)[] = ["state", "risk", "changeSet", "applied", "changedPaths", "verification",
    "reproduction", "error", "delegateAttempts", "reviews", "plan", "result", "pendingStage"];
  const out: Record<string, unknown> = {};
  for (const k of keys) if (result[k] !== undefined) out[k] = result[k];
  return out;
}

export class CandidateResultStore {
  private constructor(readonly runId: string, readonly dir: string, private readonly scope: ChangeScope) {}

  /** Opens (creating) the per-run candidate store under `.fusion/durable/<runId>/candidates/`. */
  static async open(repositoryRoot: string, runId: string, scope: ChangeScope): Promise<CandidateResultStore> {
    if (!ID.test(runId)) throw new Error("invalid run id");
    const fusion = await ensureFusionStorageRoot(repositoryRoot);
    await ensureOwnedDir(join(fusion, "durable"));
    const dir = join(fusion, "durable", runId, "candidates");
    await mkdir(dir, { recursive: true });
    return new CandidateResultStore(runId, dir, scope);
  }

  #path(candidateId: string): string { return join(this.dir, `${candidateId}.json`); }

  /**
   * Persists a COMPLETED candidate's reusable result durably (canonical bytes, fsync, atomic replace). Only a
   * `completed` result with a validatable change set is stored (a failed/interrupted candidate is never reused).
   * Best-effort: a persistence failure just means the candidate is re-run on resume (conservative, never incorrect).
   */
  async persist(candidateId: string, result: WorkflowResult): Promise<boolean> {
    // Any candidate whose GENERATION produced a validatable change (and its host application ledger) is reusable — the
    // expensive provider turn completed. Its final verdict is re-derived on resume, so a losing candidate is reused too
    // (and loses again) rather than re-generated. A candidate that produced no change has nothing to reuse.
    if (!ID.test(candidateId) || result.changeSet === undefined || result.applied === undefined) return false;
    try {
      validateChangeSet(result.changeSet, this.scope); // never persist a change set that would not re-validate
      const payload = reusableProjection(result);
      const body = canonicalJson(payload);
      if (Buffer.byteLength(body, "utf8") > MAX_ENTRY_BYTES) return false;
      const record: StoredCandidateResult = { format: CANDIDATE_RESULT_FORMAT, version: CANDIDATE_RESULT_VERSION,
        runId: this.runId, candidateId, resultHash: sha256Hex(body), result: payload };
      await atomicJson(this.#path(candidateId), record);
      return true;
    } catch { return false; }
  }

  /**
   * Loads a completed candidate's reusable result, or `null` when absent/torn/invalid/foreign. A returned result is
   * re-validated (the change set re-validates against the scope, the hash binds the bytes), so a corrupt or tampered
   * entry is never reused — the candidate is simply re-run.
   */
  async load(candidateId: string): Promise<WorkflowResult | null> {
    if (!ID.test(candidateId)) return null;
    const path = this.#path(candidateId);
    const info = await lstat(path).catch(() => undefined);
    if (info === undefined || !info.isFile() || info.isSymbolicLink()) return null;
    let record: StoredCandidateResult;
    try {
      const bytes = await readBoundedFile(path, MAX_ENTRY_BYTES);
      record = JSON.parse(bytes.toString("utf8")) as StoredCandidateResult;
    } catch { return null; }
    if (record === null || typeof record !== "object" || record.format !== CANDIDATE_RESULT_FORMAT || record.version !== CANDIDATE_RESULT_VERSION ||
        record.runId !== this.runId || record.candidateId !== candidateId || typeof record.resultHash !== "string" || record.result === null || typeof record.result !== "object")
      return null;
    let body: string;
    try { body = canonicalJson(record.result); } catch { return null; }
    if (sha256Hex(body) !== record.resultHash) return null; // torn or tampered
    const projected = record.result as Partial<WorkflowResult>;
    if (projected.changeSet === undefined || projected.applied === undefined) return null;
    try { validateChangeSet(projected.changeSet, this.scope); } catch { return null; }
    // Rehydrate a WorkflowResult from the reusable projection (no live workspace handle — evaluation re-materializes).
    return Object.freeze({ transitions: [], delegateAttempts: 0, reviews: [], ...projected }) as WorkflowResult;
  }
}
