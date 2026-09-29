// v0.5 live acceptance — the FACTS of a repository's tournament build, read from Fusion's own run records (.fusion/runs) through
// the product's validating readers: every candidate's facts come from events BOUND to it by their scope, and the decision from
// the binding the run summary resolves. Labels, counts and digests only — no model text. Used by
// scripts/v05-live-acceptance.mjs; pinned by test/v05-live-verdicts.test.ts (over records the real build route wrote).
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const load = path => import(pathToFileURL(join(REPO, "dist", ...path.split("/"))).href);
const RUN_ID = /^r-[0-9a-z]{10}-[0-9a-f]{32}$/u;

/** The facts of the newest build in `root` that recorded a route decision (the tournament's, when there is one). */
export async function collectFacts(root) {
  const { EventStore } = await load("src/platform/events/event-store.js");
  const { RunStore } = await load("src/platform/events/run-store.js");
  const { summarizeRun } = await load("src/app/runs.js");
  const { DiagnosticRedactor } = await load("src/core/policy/redaction.js");
  const redactor = new DiagnosticRedactor();
  const names = (await readdir(join(root, ".fusion", "runs")).catch(() => [])).filter(n => RUN_ID.test(n)).sort().reverse();
  let chosen;
  for (const runId of names) {
    const store = await RunStore.open(root, runId, redactor);
    const events = [];
    for await (const item of EventStore.read(store.directory, runId)) if ("event" in item) events.push(item.event);
    const route = events.find(e => e.type === "RouteDecided")?.payload;
    if (route === undefined) continue;
    chosen ??= { runId, store, events, route };
    if (route.route === "tournament") { chosen = { runId, store, events, route }; break; }
  }
  if (chosen === undefined) return { run: null, route: null, tournament: null, deliveryId: null };
  const { runId, store, events, route } = chosen;
  const summary = await summarizeRun(root, runId, redactor);
  const run = { runId, outcomeState: summary.outcome?.state ?? null, outcomeCode: summary.outcome?.code ?? null };
  const started = events.find(e => e.type === "TournamentStarted");
  if (started === undefined) return { run, route, tournament: null, deliveryId: summary.deliveryId ?? null };
  const tid = started.scope.tournamentId;
  const decided = events.find(e => e.type === "TournamentDecided" && e.scope?.tournamentId === tid);
  let artifact = {};
  if (decided?.payload.artifactRef !== undefined) {
    try { artifact = JSON.parse(await readFile(await (await store.openArtifacts()).getArtifactPath(decided.payload.artifactRef), "utf8")); }
    catch { artifact = {}; }
  }
  const scoped = (id, type) => events.filter(e => e.type === type && e.scope?.tournamentId === tid && e.scope?.candidate === id);
  const ids = [...new Set(events.filter(e => e.scope?.tournamentId === tid && e.scope?.candidate !== undefined).map(e => e.scope.candidate))].sort();
  const candidates = ids.map(id => {
    const record = (artifact.candidates ?? []).find(c => c.id === id);
    const verified = scoped(id, "CandidateVerificationObserved")[0]?.payload;
    return { id,
      proposals: scoped(id, "ChangeProposalRecorded").filter(e => e.payload.outcome === "validated").length,
      modelTurns: scoped(id, "AgentTurnObserved").length + scoped(id, "StructuredTurnObserved").length,
      applied: scoped(id, "CandidateObserved").some(e => e.payload.phase === "applied"),
      checks: (verified?.commands ?? []).map(c => c.id),
      profileSha256: record?.manifest?.profileSha256 ?? null,
      nodes: (record?.nodes ?? []).map(n => ({ id: n.id, result: n.result })),
      failure: record?.failure ?? null };
  });
  const revalidation = events.find(e => e.type === "EvidenceDecisionRecorded" && e.scope?.tournamentId === tid && e.scope?.stage === "revalidation");
  return { run, route, deliveryId: summary.deliveryId ?? null, tournament: {
    id: tid, started: started.payload, candidates,
    decided: decided?.payload ?? null,
    revalidation: revalidation === undefined ? null
      : { candidate: revalidation.scope.candidate, revision: revalidation.scope.revision, deliverable: revalidation.payload.deliverable },
    resolved: summary.tournament?.resolved === true, reason: summary.tournament?.reason ?? null,
    primaryUnchanged: typeof artifact.primaryUnchanged === "boolean" ? artifact.primaryUnchanged : null,
    reasons: Array.isArray(artifact.differences) ? artifact.differences.filter(r => typeof r === "string").slice(0, 8) : [] } };
}
