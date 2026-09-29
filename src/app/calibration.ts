import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DiagnosticRedactor } from "../core/policy/redaction.js";
import { isCandidateId } from "../core/tournament/contracts.js";
import { ROUTING_RECORD_FORMAT, type OutcomeClass, type RoutingRecord, type SelectionClass, type WhatIfReport } from "../core/tournament/calibration.js";
import { EventStore } from "../platform/events/event-store.js";
import { RunStore } from "../platform/events/run-store.js";
import type { RouteDecidedRecord, StoredEvent, TournamentCandidateRecord, TournamentDecidedRecord } from "../platform/events/types.js";
import { summarizeRun } from "./runs.js";

/**
 * v0.5 — the ROUTING RECORDS of past builds, read offline from Fusion's own run records in this repository: the route decision
 * (its host facts), the outcome class and, for a tournament, its candidates' judged states, the selection class and failures.
 * Labels and counts only — a record carries no task text, path, provider text or source. Read-only and bounded; a run whose
 * records cannot be read, or that recorded no route decision (a read-only run, or one before v0.5), is skipped and counted.
 */
export const CALIBRATION_LIMITS = Object.freeze({ defaultRuns: 200, maxRuns: 1_000 });
const RUN_ID = /^r-[0-9a-z]{10}-[0-9a-f]{32}$/u;

function outcomeClass(state: unknown): OutcomeClass | undefined {
  switch (state) {
    case "COMPLETED": return "verified";
    case "DECISION_REQUIRED": case "REVIEW_REQUIRED": return "decisionRequired";
    case "HUMAN_GATE_REQUIRED": return "humanGate";
    case "FAILED": return "failed";
    case "TIMED_OUT": return "timedOut";
    case "CANCELLED": return "cancelled";
    case "BLOCKED": return "blocked";
    default: return undefined;
  }
}

export async function collectRoutingRecords(repositoryRoot: string, redactor: DiagnosticRedactor, limit: number = CALIBRATION_LIMITS.defaultRuns):
  Promise<Readonly<{ records: readonly RoutingRecord[]; skipped: number; unreadable: number }>> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CALIBRATION_LIMITS.maxRuns) throw new RangeError(`The run limit must be 1-${CALIBRATION_LIMITS.maxRuns}.`);
  const names = await readdir(join(repositoryRoot, ".fusion", "runs")).catch(() => [] as string[]);
  const records: RoutingRecord[] = [];
  let skipped = 0, unreadable = 0;
  for (const runId of names.filter(name => RUN_ID.test(name)).sort().reverse().slice(0, limit)) {
    try {
      const record = await recordOf(repositoryRoot, runId, redactor);
      if (record === undefined) skipped++; else records.push(record);
    } catch { unreadable++; }
  }
  return Object.freeze({ records: Object.freeze(records), skipped, unreadable });
}

async function recordOf(root: string, runId: string, redactor: DiagnosticRedactor): Promise<RoutingRecord | undefined> {
  const store = await RunStore.open(root, runId, redactor);
  const events: StoredEvent[] = [];
  for await (const item of EventStore.read(store.directory, runId)) {
    if ("diagnostic" in item) break;
    events.push(item.event);
    if (events.length > 20_000) break;
  }
  const routes = events.filter(e => e.type === "RouteDecided");
  if (routes.length !== 1) return undefined;
  const route = routes[0]!.payload as RouteDecidedRecord;
  const summary = await summarizeRun(root, runId, redactor);
  const outcome = outcomeClass(summary.outcome?.state);
  if (outcome === undefined) return undefined;
  const completed = events.find(e => e.type === "RunCompleted")?.payload as { wallTimeMs?: number } | undefined;
  let tournament: RoutingRecord["tournament"];
  if (route.route === "tournament" && summary.tournament?.resolved === true && summary.tournament.outcome !== undefined) {
    // Each candidate's evaluation is bound to it by its scope; the decision event is the one the summary resolved.
    const evaluated = new Map<string, TournamentCandidateRecord>();
    for (const e of events) if (e.type === "TournamentCandidateEvaluated" && e.scope?.tournamentId === summary.tournament.id && isCandidateId(e.scope.candidate))
      evaluated.set(e.scope.candidate, e.payload as TournamentCandidateRecord);
    const judged = [...evaluated.values()];
    const decided = events.find(e => e.type === "TournamentDecided" && e.scope?.tournamentId === summary.tournament!.id)?.payload as TournamentDecidedRecord | undefined;
    const selection = await selectionClass(store, decided);
    tournament = Object.freeze({ outcome: summary.tournament.outcome, judged: judged.length,
      verified: judged.filter(c => c.decision === "VERIFIED" && c.deliverable).length,
      rejected: judged.filter(c => c.decision === "BLOCKED" || c.contradictions > 0).length,
      failed: Math.max(0, route.candidates - judged.length),
      ...(selection === undefined ? {} : { selection }),
      mutationsRun: judged.reduce((n, c) => n + c.mutationsRun, 0), mutationsSurvived: judged.reduce((n, c) => n + c.mutationsSurvived, 0) });
  }
  return Object.freeze({ format: ROUTING_RECORD_FORMAT, version: 1, policyVersion: route.policyVersion,
    facts: Object.freeze({ taskClass: route.taskClass, sensitive: route.sensitive, risk: route.risk, alternatives: route.alternatives, priorFailure: route.priorFailure }),
    route: route.route, candidates: route.candidates, source: route.source, outcome, ...(tournament === undefined ? {} : { tournament }),
    ...(typeof completed?.wallTimeMs === "number" ? { durationMs: Math.round(completed.wallTimeMs) } : {}) });
}

/** How the tournament selected: the human's tie choice, or — from its redacted record — convergence, dominance or the only verified. */
async function selectionClass(store: RunStore, decided: TournamentDecidedRecord | undefined): Promise<SelectionClass | undefined> {
  if (decided?.selected === undefined) return undefined;
  if (decided.chosenBy === "human") return "humanChoice";
  if (decided.artifactRef === undefined) return undefined;
  try {
    const artifacts = await store.openArtifacts();
    const record = JSON.parse(await readFile(await artifacts.getArtifactPath(decided.artifactRef), "utf8")) as
      { selection?: { kind?: unknown; converged?: unknown; dominated?: unknown } };
    const selection = record.selection;
    if (selection?.kind !== "selected") return undefined;
    return Array.isArray(selection.converged) && selection.converged.length > 1 ? "converged"
      : Array.isArray(selection.dominated) && selection.dominated.length > 0 ? "dominance" : "onlyVerified";
  } catch { return undefined; }
}

/** The calibration report in plain words: per policy, what it would have changed on these runs — observed or estimated, never guessed. */
export function renderCalibration(input: Readonly<{ repository: string; records: number; skipped: number; unreadable: number;
  reports: readonly WhatIfReport[] }>): string {
  const pct = (n: number): string => `${Math.round(n * 100)}%`;
  const lines = ["Fusion routing calibration (offline; labels and counts only — no task text, paths or model text)",
    `Repository: ${input.repository}`,
    `Routed builds: ${input.records} (skipped ${input.skipped} without a route decision, ${input.unreadable} unreadable)`];
  for (const report of input.reports) {
    lines.push("", `Policy ${report.policy} — ${report.description}${report.humanRouted > 0 ? ` (${report.humanRouted} human-routed run(s) kept as routed)` : ""}`);
    for (const g of report.groups)
      lines.push(`  ${g.group}: ${g.runs} run(s), ${g.tournaments} tournament(s), ${g.separated} separated${g.rate === undefined ? "" : ` (${pct(g.rate)})`}` +
        `${g.added > 0 ? `; would add ${g.added}${g.separationsGainedEstimate === undefined ? " (no estimate: fewer than 3 observed tournaments)" : ` (est. ${g.separationsGainedEstimate.toFixed(1)} separations)`}` : ""}` +
        `${g.dropped > 0 ? `; would drop ${g.dropped} (${g.separationsLost} observed separation(s) lost)` : ""}`);
    const t = report.totals;
    lines.push(`  total: +${t.added} tournament(s)${t.separationsGainedEstimate === undefined ? "" : `, est. +${t.separationsGainedEstimate.toFixed(1)} separations`}` +
      `${t.unestimatedAdded > 0 ? ` (${t.unestimatedAdded} without an estimate)` : ""}, -${t.dropped} tournament(s) (${t.separationsLost} observed separation(s) lost), ` +
      `candidate runs ${t.candidateRunsDelta >= 0 ? "+" : ""}${t.candidateRunsDelta}`);
  }
  lines.push("", "A separation: Fusion's evidence rejected one candidate while it verified another. Estimates are observed rates times counts,",
    "only for groups with at least 3 observed tournaments. Nothing is changed: a routing change is a versioned, reviewed code change.", "");
  return lines.join("\n");
}
