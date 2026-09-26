import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { FusionFailure } from "../core/errors.js";
import type { ControlPlane } from "./control-plane.js";
import { deliveryRepository, listDeliveryStatus, type DeliveryStatus } from "./delivery-service.js";
import { summarizeRun, type RunSummary } from "./runs.js";

/**
 * v0.1 — product state for coherent use: what ran in this repository, what it left behind, and what (if anything) the human
 * can do next. READ-ONLY and replay-free by construction: it reads the run evidence (`.fusion/runs`, trusted, written by
 * Fusion) and the delivery store (outside the repository), classifies each into a resume state and names the next HUMAN
 * step. Nothing here starts a provider, re-runs a turn, retries an apply or touches a claim: an interrupted run is never
 * resumed (a new build is a new run), and a spent approval is never replayed (a retry needs a new delivery and approval).
 *
 * Conversations (`fusion chat`, `fusion analyze`) are NOT part of this history: their transcript is model text, kept only
 * in memory for the running session (bounded) and never written to disk or mixed into workflow evidence.
 */
export const HISTORY_LIMITS = Object.freeze({ defaultRuns: 10, maxRuns: 50 });
const RUN_ID = /^r-[0-9a-z]{10}-[0-9a-f]{32}$/u;

export type ResumeCode = "unfinished" | "confirmationRequired" | "humanGate" | "blocked" | "failed" | "cancelled" | "completed" |
  "offlineRehearsal" | "deliveryPrepared" | "deliveryApproved" | "precheckFailed" | "attemptInterrupted" | "applyInterrupted" | "applied" |
  "applyFailed" | "rolledBack" | "rollbackFailed" | "deliveryUnavailable";
export interface ResumeState { readonly code: ResumeCode; readonly next: string }

export interface RunEntry {
  readonly summary: RunSummary;
  readonly delivery?: DeliveryStatus;
  readonly resume: ResumeState;
}
export interface History {
  readonly repository: string;
  readonly runs: readonly RunEntry[];
  /** More runs exist than were listed. */
  readonly moreRuns: boolean;
  /** Deliveries of this checkout no listed run points to (older runs, or runs whose evidence is gone). */
  readonly otherDeliveries: readonly (DeliveryStatus & { readonly resume: ResumeState })[];
  readonly conversations: "notRecorded";
}

/** What a stored delivery allows next. Only the human acts; this never changes the delivery. */
export function deliveryResume(delivery: DeliveryStatus): ResumeState {
  const id = delivery.deliveryId;
  switch (delivery.state) {
    case "prepared":
      return { code: "deliveryPrepared", next: `Inspect it (fusion inspect-delivery ${id}), then approve it (fusion approve-delivery ${id}).` };
    case "approved":
      if (delivery.attemptLocked)
        return { code: "attemptInterrupted", next: "An apply attempt is running, or one was interrupted before its claim (nothing was changed). " +
          "If no apply is running, this delivery stays locked: run the build again for a new delivery." };
      if (delivery.lastEvent?.type === "precheckFailed")
        return { code: "precheckFailed", next: `The last precheck failed (${delivery.lastEvent.issues.slice(0, 4).join(", ") || "see inspect-delivery"}); ` +
          `nothing was changed and the approval is kept. Resolve it, then run fusion apply ${id}.` };
      return { code: "deliveryApproved", next: `Apply it: fusion apply ${id}.` };
    case "applying":
      return { code: "applyInterrupted", next: delivery.attemptLocked
        ? "An apply holds its single-use claim: it is running, or it was interrupted. It is never applied again. If none is running, check " +
          "the working tree (git status, git diff) and restore from Git if needed."
        : "The apply was interrupted after its single-use claim; it is never applied again. Check the working tree (git status, git diff) " +
          "and restore from Git if needed; run the build again for a new delivery." };
    case "applied":
      return { code: "applied", next: "Applied to the working tree. Review it and commit it with Git yourself (Fusion never commits or pushes)." };
    case "failed":
      return { code: "applyFailed", next: `The apply failed${delivery.lastEvent?.phase ? ` (${delivery.lastEvent.phase})` : ""}; the approval is spent. ` +
        `fusion inspect-delivery ${id} shows its events; run the build again for a new delivery.` };
    case "rolledBack":
      return { code: "rolledBack", next: "The apply was rolled back and the files were restored; the approval is spent. Run the build again for a new delivery." };
    case "rollbackFailed":
      return { code: "rollbackFailed", next: "The rollback did not restore every file: check the working tree now (git status, git diff) and restore " +
        `from Git. fusion inspect-delivery ${id} lists the files.` };
    case "otherCheckout":
      return { code: "deliveryUnavailable", next: "It was prepared in another checkout of this repository; run Fusion there." };
    default:
      return { code: "deliveryUnavailable", next: "The stored delivery is incomplete, corrupt or tampered; it is never applied. Run the build again for a new delivery." };
  }
}

/** What a recorded run allows next, from its evidence and (when it prepared one) its delivery's current state. */
export function runResume(summary: RunSummary, delivery: DeliveryStatus | undefined): ResumeState {
  const outcome = summary.outcome as { state?: string; code?: string } | undefined;
  if (outcome?.state === undefined)
    return { code: "unfinished", next: "No outcome was recorded: the run is still going, or its process ended. Fusion never resumes or replays " +
      "provider turns; if it is not running, start a new build (nothing was applied)." };
  if (summary.deliveryId !== undefined)
    return delivery === undefined
      ? { code: "deliveryUnavailable", next: "Its delivery is not in this checkout's delivery store (another checkout, or removed)." }
      : deliveryResume(delivery);
  switch (outcome.state) {
    case "COMPLETED": case "ANSWERED":
      return summary.offlineRehearsal
        ? { code: "offlineRehearsal", next: "An offline rehearsal: nothing to deliver." }
        : { code: "completed", next: summary.command === "build" ? "Nothing to deliver (read-only result)." : "Nothing to deliver." };
    case "HUMAN_GATE_REQUIRED": case "DECISION_REQUIRED": case "REVIEW_REQUIRED":
      return { code: "humanGate", next: "A human decision is required; rerun the task at an interactive terminal." };
    case "BLOCKED":
      return outcome.code === "REAL_WRITER_MODE_NOT_READY"
        ? { code: "confirmationRequired", next: "Never confirmed: rerun fusion build at an interactive terminal and confirm it." }
        : { code: "blocked", next: "Refused before any change; fusion show gives the reason (fusion doctor checks the setup)." };
    case "CANCELLED":
      return { code: "cancelled", next: "Cancelled; nothing was delivered." };
    default:
      return { code: "failed", next: "It failed; nothing was delivered. fusion show gives the reason." };
  }
}

/** The newest recorded runs of this repository with their deliveries and next steps. Read-only. */
export async function history(plane: ControlPlane, options: Readonly<{ limit?: number }> = {}): Promise<History> {
  const limit = options.limit ?? HISTORY_LIMITS.defaultRuns;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > HISTORY_LIMITS.maxRuns)
    throw new FusionFailure({ kind: "InvalidInput", retryable: false, safeMessage: `--limit must be between 1 and ${HISTORY_LIMITS.maxRuns}.` });
  const repository = await deliveryRepository(plane);
  // Run IDs start with the creation time (base 36, fixed width): the names sort by age without opening every run.
  const names = await readdir(join(repository.root, ".fusion", "runs")).catch(() => [] as string[]);
  const ids = names.filter(name => RUN_ID.test(name)).sort().reverse();
  const deliveries = await listDeliveryStatus(repository);
  const byId = new Map(deliveries.map(delivery => [delivery.deliveryId, delivery]));
  const runs: RunEntry[] = [];
  for (const runId of ids.slice(0, limit)) {
    let summary: RunSummary;
    try { summary = await summarizeRun(repository.root, runId, plane.redactor); }
    catch {
      summary = { runId, command: "unknown", status: "failed", createdAt: "", transitions: 0, findings: [], eventLog: "truncated" };
      runs.push({ summary, resume: { code: "failed", next: "Its evidence could not be read; it is not used." } });
      continue;
    }
    const delivery = summary.deliveryId === undefined ? undefined : byId.get(summary.deliveryId);
    runs.push(Object.freeze({ summary, ...(delivery ? { delivery } : {}), resume: runResume(summary, delivery) }));
  }
  const listed = new Set(runs.map(run => run.summary.deliveryId).filter(id => id !== undefined));
  return Object.freeze({ repository: repository.root, runs: Object.freeze(runs), moreRuns: ids.length > limit,
    otherDeliveries: Object.freeze(deliveries.filter(delivery => !listed.has(delivery.deliveryId)).map(delivery => ({ ...delivery, resume: deliveryResume(delivery) }))),
    conversations: "notRecorded" });
}

/** One run with its delivery and next step (for `fusion show`). */
export async function runWithResume(plane: ControlPlane, summary: RunSummary): Promise<RunEntry> {
  if (summary.deliveryId === undefined) return { summary, resume: runResume(summary, undefined) };
  const delivery = (await listDeliveryStatus(await deliveryRepository(plane))).find(entry => entry.deliveryId === summary.deliveryId);
  return { summary, ...(delivery ? { delivery } : {}), resume: runResume(summary, delivery) };
}
