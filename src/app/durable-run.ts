import { join } from "node:path";
import type { DurableRunState } from "../core/durability/states.js";
import { isRunClaimed, RunLease, type RunAlreadyClaimedError } from "../platform/durability/lease.js";
import { readJournal, RunJournal, type JournalRecord } from "../platform/durability/journal.js";
import { ensureOwnedDir, ensureFusionStorageRoot } from "../platform/events/run-store.js";

/**
 * v0.6 I3 — DURABLE RUN: the hash-chained journal + single-writer lease that wrap a real Fusion run (a `fusion build`),
 * so a crash does not make Fusion forget what completed and two processes cannot mutate the same run at once. The v0.5
 * workflow engine stays semantically authoritative; this only PERSISTS its critical, reliability-relevant milestones
 * durably (before the run advances past them) and owns the run. It lives in `.fusion/durable/<runId>/` (self-ignored),
 * separate from the run's display/evidence store, so it never disturbs `.fusion/runs/<runId>/`.
 *
 * Milestones are the closed set of security/reliability-critical transitions (§11) — never raw prompts or source, only
 * typed labels, ids, hashes and counts. Correctness rests on the journal (contiguous seq + hash chain), not the clock.
 */
export const DURABLE_RUN_MILESTONES = Object.freeze([
  "runStarted", "routeDecided", "tournamentStarted", "candidateCompleted", "verificationNodeCompleted",
  "winnerSelected", "converged", "tieRequiresHuman", "revalidationCompleted", "deliveryCreated",
  "humanGateRequired", "runCompleted", "runBlocked",
] as const);
export type DurableRunMilestone = (typeof DURABLE_RUN_MILESTONES)[number];

const TERMINAL: ReadonlySet<DurableRunMilestone> = new Set<DurableRunMilestone>(["runCompleted", "runBlocked"]);

function durableDir(fusionRoot: string, runId: string): string { return join(fusionRoot, "durable", runId); }

/** A live, owned durable run. Journals milestones durably and releases the single-writer lease when it ends. */
export class DurableRun {
  private constructor(readonly runId: string, private readonly journal: RunJournal, private readonly lease: RunLease) {}

  /**
   * Claims and begins a durable run: ensures `.fusion/durable/<runId>/`, acquires the single-writer lease (a live owner
   * of the SAME run is refused with RUN_ALREADY_CLAIMED), opens the journal and records `runStarted`. Fresh build runs
   * have unique ids, so this never contends; the lease matters when the SAME run is re-opened (resume/recovery).
   */
  static async begin(repositoryRoot: string, runId: string, options: Readonly<{ workflowId?: string; ttlMs?: number; now?: () => number }> = {}): Promise<DurableRun> {
    const fusion = await ensureFusionStorageRoot(repositoryRoot);
    await ensureOwnedDir(join(fusion, "durable"));
    const dir = durableDir(fusion, runId);
    await ensureOwnedDir(dir);
    const lease = await RunLease.acquire(join(dir, "run.lock"), { ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }), ...(options.now ? { now: options.now } : {}) });
    const journal = await RunJournal.open(join(dir, "journal.jsonl"));
    const run = new DurableRun(runId, journal, lease);
    if (journal.lastSeq === 0) await run.milestone("runStarted", options.workflowId === undefined ? {} : { workflowId: options.workflowId });
    return run;
  }

  /** Records one critical milestone durably (fsync) before the run advances past it. Bounded, typed payload only. */
  async milestone(type: DurableRunMilestone, payload: Readonly<Record<string, string | number | boolean | null>> = {}): Promise<JournalRecord> {
    return this.journal.append({ type, runId: this.runId, payload });
  }

  /** Ends the run: records the terminal milestone (`runCompleted` or `runBlocked`) and releases the lease. */
  async end(outcome: Readonly<{ blocked?: boolean; decision?: string; delivered?: boolean }> = {}): Promise<void> {
    try {
      await this.milestone(outcome.blocked === true ? "runBlocked" : "runCompleted",
        { ...(outcome.decision === undefined ? {} : { decision: outcome.decision }), delivered: outcome.delivered === true });
    } finally { await this.lease.release().catch(() => undefined); }
  }

  /** Best-effort release without a terminal milestone (e.g. an unexpected throw): the run stays reconstructible as INTERRUPTED. */
  async abandon(): Promise<void> { await this.lease.release().catch(() => undefined); }
}

export interface RunReconstruction {
  readonly runId: string;
  readonly state: DurableRunState;
  /** The critical milestones the journal durably records, in order. */
  readonly milestones: readonly Readonly<{ type: DurableRunMilestone; seq: number }>[];
  readonly lastSeq: number;
}

/**
 * Reconstructs a run's durable state from the journal alone (read-only; never claims the run). A journal that fails
 * verification throws `JournalCorruptError` (JOURNAL_CORRUPT / RECOVERY_REQUIRED) — a corrupt run log is never guessed
 * through. An absent journal is a run that never began durably.
 */
export async function reconstructRun(repositoryRoot: string, runId: string): Promise<RunReconstruction | null> {
  const fusion = await ensureFusionStorageRoot(repositoryRoot);
  const records = await readJournal(join(durableDir(fusion, runId), "journal.jsonl"));
  if (records.length === 0) return null;
  const milestones = records
    .filter(r => (DURABLE_RUN_MILESTONES as readonly string[]).includes(r.type))
    .map(r => Object.freeze({ type: r.type as DurableRunMilestone, seq: r.seq }));
  const terminal = milestones.find(m => TERMINAL.has(m.type));
  const state: DurableRunState = terminal === undefined ? "INTERRUPTED"
    : terminal.type === "runBlocked" ? "BLOCKED" : "COMPLETED";
  return Object.freeze({ runId, state, milestones: Object.freeze(milestones), lastSeq: records.at(-1)!.seq });
}

/** Whether a run is currently claimed by a LIVE writer (a read-only check; never claims). */
export async function isRunOwned(repositoryRoot: string, runId: string, options: Readonly<{ ttlMs?: number; now?: () => number }> = {}): Promise<boolean> {
  const fusion = await ensureFusionStorageRoot(repositoryRoot);
  return isRunClaimed(join(durableDir(fusion, runId), "run.lock"), options);
}

export type { RunAlreadyClaimedError };
