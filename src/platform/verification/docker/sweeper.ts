import { failWith } from "../../../core/errors.js";
import { parseStrictJson } from "../../process/strict-json.js";
import { isNoSuchObject, parseContainerInspect, type DockerCommandRunner } from "./cli.js";
import { CONTAINER_ID, isFusionOwned, OWNER_LABELS } from "./config.js";

/**
 * Crash recovery for Docker verification containers. After a host crash or a killed Fusion process, stopped (or
 * deadline-exceeded) containers may remain. This sweep removes ONLY containers that are provably Fusion's AND provably
 * stale:
 *  - listed by the daemon's label filter, then re-inspected individually (never trusted from the listing);
 *  - carrying the COMPLETE Fusion ownership label set (`isFusionOwned`) — a name prefix, a partial label set or a
 *    malformed value makes a container foreign and untouchable;
 *  - not a run that is live in this process (`ACTIVE_DOCKER_RUNS`);
 *  - older than `minAgeMs` by BOTH the daemon's own creation time and Fusion's creation label (the older-looking of the
 *    two cannot shortcut the other), where `minAgeMs` exceeds the longest possible run, so another live Fusion process's
 *    container is never selected.
 * Only `container inspect` and `rm --force <64-hex id>` are issued; never prune, never images, volumes or networks.
 * The sweep is bounded, idempotent, reports what it did with ids only, and never reports an unproven removal as done.
 */
export const ACTIVE_DOCKER_RUNS = new Set<string>();
/** Longest possible run: one hour of commands, the maximum host allowance and dependency transfer headroom. */
export const LONGEST_RUN_MS = 60 * 60_000 + 10 * 60_000 + 20 * 60_000;
export const SWEEP_LIMITS = Object.freeze({ defaultMinAgeMs: 2 * 60 * 60_000, maxContainers: 64 });

export interface SweepCandidate {
  readonly id: string;
  readonly labels: unknown;
  readonly running: boolean;
  /** Daemon-reported creation time. */
  readonly created: string;
}
export type SweepDecision = "remove" | "foreign" | "live" | "young" | "invalidTime";
export interface SweepSelection {
  readonly id: string;
  readonly decision: SweepDecision;
}

/** Pure selection over re-inspected containers; exported for mutation tests. */
export function selectStaleOwnedContainers(candidates: readonly SweepCandidate[], nowMs: number, minAgeMs: number,
  active: ReadonlySet<string> = ACTIVE_DOCKER_RUNS): SweepSelection[] {
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(minAgeMs) || minAgeMs < LONGEST_RUN_MS)
    failWith("InvalidInput", "Sweep age threshold must exceed the longest possible verification run.");
  return candidates.map(candidate => {
    if (typeof candidate.id !== "string" || !CONTAINER_ID.test(candidate.id) || !isFusionOwned(candidate.labels))
      return { id: String(candidate.id), decision: "foreign" as const };
    const labels = candidate.labels as Record<string, string>;
    if (active.has(labels[OWNER_LABELS.run]!)) return { id: candidate.id, decision: "live" as const };
    const labelled = Date.parse(labels[OWNER_LABELS.created]!), daemon = Date.parse(candidate.created);
    if (!Number.isFinite(labelled) || !Number.isFinite(daemon) || labelled > nowMs + 60_000 || daemon > nowMs + 60_000)
      return { id: candidate.id, decision: "invalidTime" as const };
    if (nowMs - labelled < minAgeMs || nowMs - daemon < minAgeMs) return { id: candidate.id, decision: "young" as const };
    return { id: candidate.id, decision: "remove" as const };
  });
}

export interface SweepReport {
  /** True when every selected container was proven removed (or nothing needed removal). */
  readonly complete: boolean;
  readonly dryRun: boolean;
  readonly listed: number;
  readonly selections: readonly SweepSelection[];
  readonly removed: readonly string[];
  readonly failed: readonly string[];
  /** Listing hit the bound; the rest is left for the next sweep. */
  readonly truncated: boolean;
  readonly reasons: readonly string[];
}

export interface SweepOptions {
  readonly nowMs?: number;
  readonly minAgeMs?: number;
  readonly dryRun?: boolean;
  readonly active?: ReadonlySet<string>;
}

/** Lists, re-inspects, selects and (unless `dryRun`) removes stale Fusion-owned containers. */
export async function sweepStaleContainers(runner: DockerCommandRunner, options: SweepOptions = {}): Promise<SweepReport> {
  const nowMs = options.nowMs ?? Date.now(), minAgeMs = options.minAgeMs ?? SWEEP_LIMITS.defaultMinAgeMs;
  const reasons: string[] = [];
  const listed = await runner.run({ args: ["ps", "--all", "--no-trunc", "--filter", `label=${OWNER_LABELS.owner}=true`,
    "--format", "{{.ID}}"], timeoutMs: 20_000, maxStdoutBytes: 256 * 1024 });
  if (listed.status !== "exited" || listed.exitCode !== 0)
    return { complete: false, dryRun: options.dryRun === true, listed: 0, selections: [], removed: [], failed: [], truncated: false,
      reasons: ["the daemon could not list containers"] };
  const ids = listed.stdout.split(/\r?\n/u).map(line => line.trim()).filter(line => line !== "");
  const valid = ids.filter(id => CONTAINER_ID.test(id));
  if (valid.length !== ids.length) reasons.push("the daemon listing contained malformed ids (ignored)");
  const bounded = valid.slice(0, SWEEP_LIMITS.maxContainers);
  const candidates: SweepCandidate[] = [];
  let unreadable = 0;
  for (const id of bounded) {
    const inspected = await runner.run({ args: ["container", "inspect", "--format", "{{json .}}", id], timeoutMs: 20_000,
      maxStdoutBytes: 512 * 1024 });
    if (isNoSuchObject(inspected)) continue;
    const inspection = inspected.status === "exited" && inspected.exitCode === 0 ? parseContainerInspect(inspected.stdout) : undefined;
    if (inspection === undefined || inspection.id !== id) { unreadable++; continue; }
    candidates.push({ id, labels: inspection.labels, running: inspection.running, created: inspection.created });
  }
  if (unreadable > 0) reasons.push(`${unreadable} container(s) could not be inspected and were left alone`);
  const selections = selectStaleOwnedContainers(candidates, nowMs, minAgeMs, options.active ?? ACTIVE_DOCKER_RUNS);
  const removed: string[] = [], failed: string[] = [];
  if (options.dryRun !== true) {
    for (const selection of selections.filter(entry => entry.decision === "remove")) {
      if (await removeOwned(runner, selection.id)) removed.push(selection.id);
      else failed.push(selection.id);
    }
  }
  if (failed.length > 0) reasons.push(`${failed.length} stale container(s) could not be proven removed`);
  return Object.freeze({ complete: failed.length === 0 && unreadable === 0, dryRun: options.dryRun === true, listed: ids.length,
    selections: Object.freeze(selections), removed: Object.freeze(removed), failed: Object.freeze(failed),
    truncated: valid.length > bounded.length, reasons: Object.freeze(reasons) });
}

/** Re-reads the labels immediately before removal and confirms the daemon no longer knows the container. */
export async function removeOwned(runner: DockerCommandRunner, id: string, runId?: string): Promise<boolean> {
  if (!CONTAINER_ID.test(id)) return false;
  const labels = await runner.run({ args: ["container", "inspect", "--format", "{{json .Config.Labels}}", id],
    timeoutMs: 20_000, maxStdoutBytes: 64 * 1024 });
  if (isNoSuchObject(labels)) return true;
  if (labels.status !== "exited" || labels.exitCode !== 0) return false;
  let parsed: unknown;
  try { parsed = parseStrictJson(labels.stdout.trim(), 4); } catch { return false; }
  if (!isFusionOwned(parsed, runId)) return false;
  await runner.run({ args: ["rm", "--force", id], timeoutMs: 30_000, maxStdoutBytes: 4096 });
  const after = await runner.run({ args: ["container", "inspect", "--format", "{{.Id}}", id], timeoutMs: 20_000, maxStdoutBytes: 4096 });
  return isNoSuchObject(after);
}
