import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { collectRoutingRecords, renderCalibration } from "../src/app/calibration.js";
import { RunRecorder } from "../src/app/runs.js";
import type { BuildEvidence } from "../src/core/evidence/build.js";
import { DiagnosticRedactor } from "../src/core/policy/redaction.js";
import { CALIBRATION_POLICIES, MIN_SAMPLE, ROUTING_RECORD_FORMAT, separated, whatIf, type RoutingRecord } from "../src/core/tournament/calibration.js";
import { TOURNAMENT_POLICY_VERSION } from "../src/core/tournament/route.js";
import { makeId, StorageError } from "../src/platform/events/shared.js";
import type { RouteDecidedRecord } from "../src/platform/events/types.js";

const REDACTOR = new DiagnosticRedactor();
const CANARY = "CANARY-TASK-7f3a src/billing/secret-canary.ts";
const record = (patch: Omit<Partial<RoutingRecord>, "facts"> & { facts?: Partial<RoutingRecord["facts"]> } = {}): RoutingRecord => ({
  format: ROUTING_RECORD_FORMAT, version: 1, policyVersion: TOURNAMENT_POLICY_VERSION, route: "single", candidates: 1, source: "policy", outcome: "verified",
  ...patch, facts: { taskClass: "bugFix", sensitive: false, risk: "medium", alternatives: 0, priorFailure: false, ...patch.facts } });
const tournament = (separates: boolean): Partial<RoutingRecord> => ({ route: "tournament", candidates: 2,
  tournament: { outcome: "DELIVERY_ELIGIBLE", judged: 2, verified: separates ? 1 : 2, rejected: separates ? 1 : 0, failed: 0, mutationsRun: 0, mutationsSurvived: 0 } });
const policy = (id: string) => CALIBRATION_POLICIES.find(p => p.id === id)!;

test("v0.5 calibration: what-if counts what a policy would add or drop, estimates only with a sample, and keeps human routing", () => {
  const records = [
    // bugFix/medium: 4 tournaments, 2 of them separated a rejected candidate from a verified one.
    record(tournament(true)), record(tournament(true)), record(tournament(false)), record(tournament(false)),
    // bugFix/low: 2 single runs, no tournament ever observed there.
    record({ facts: { risk: "low" } }), record({ facts: { risk: "low" } }),
    // change/medium: one run a human routed as 3 candidates.
    record({ facts: { taskClass: "change" }, route: "tournament", candidates: 3, source: "human" }),
  ];
  assert.equal(separated(records[0]!), true);
  assert.equal(separated(records[2]!), false);

  const current = whatIf(records, policy(TOURNAMENT_POLICY_VERSION));
  assert.deepEqual([current.totals.added, current.totals.dropped, current.totals.candidateRunsDelta], [0, 0, 0], "the current policy reproduces its own routing");
  assert.equal(current.humanRouted, 1, "a human's routing stands under any policy and is not counted");

  const never = whatIf(records, policy("single-always"));
  assert.deepEqual([never.totals.dropped, never.totals.separationsLost, never.totals.candidateRunsDelta], [4, 2, -4], "dropped tournaments lose their OBSERVED separations");

  const anyRisk = whatIf(records, policy("fixes-at-any-risk"));
  const low = anyRisk.groups.find(g => g.group === "bugFix/low")!;
  assert.deepEqual([low.added, low.tournaments, low.rate, low.separationsGainedEstimate], [2, 0, undefined, undefined], "no observed tournaments: no estimate");
  assert.equal(anyRisk.totals.unestimatedAdded, 2);
  const medium = anyRisk.groups.find(g => g.group === "bugFix/medium")!;
  assert.equal(medium.rate, 0.5);
  assert.ok(medium.tournaments >= MIN_SAMPLE);

  const text = renderCalibration({ repository: "/repo", records: records.length, skipped: 1, unreadable: 0, reports: [anyRisk] });
  assert.match(text, /^ {2}bugFix\/low: 2 run\(s\), 0 tournament\(s\), 0 separated; would add 2 \(no estimate: fewer than 3 observed tournaments\)$/mu);
  assert.match(text, /Nothing is changed: a routing change is a versioned, reviewed code change\./u);
});

function evidence(decision: "VERIFIED" | "BLOCKED", deliverable: boolean): BuildEvidence {
  return { plan: { profile: { taskClass: "bugFix", sensitive: false }, reproduce: true, freshReview: false, objective: "review", strict: false, obligations: [] },
    graph: { format: "fusion.evidenceGraph", version: 1, claims: [], evidence: [], overflowed: false },
    decision: { decision, deliverable, overflowed: false, obligations: [] } } as unknown as BuildEvidence;
}
const ROUTE: RouteDecidedRecord = { policyVersion: TOURNAMENT_POLICY_VERSION, route: "tournament", candidates: 2, source: "policy", taskClass: "bugFix",
  sensitive: false, risk: "medium", alternatives: 0, priorFailure: false, cap: 3 };

test("v0.5 calibration: records come from the runs' own bound records — labels and counts only, never the task or a path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fusion-v05-calibration-"));
  try {
    // A tournament: c1 rejected, c2 verified and selected.
    const t = await RunRecorder.start(dir, "build", REDACTOR, { task: CANARY });
    await t.recordRoute(ROUTE);
    const tid = makeId("t"), rev = { c1: "1".repeat(64), c2: "2".repeat(64) };
    await t.recordTournamentStart(tid, { policyVersion: TOURNAMENT_POLICY_VERSION, candidates: 2, source: "policy", independence: "separateContext",
      profileSha256: "a".repeat(64), contractSha256: "b".repeat(64), snapshotSha256: "c".repeat(64), reproduced: true });
    for (const [id, ok] of [["c1", false], ["c2", true]] as const)
      await t.recordTournamentCandidate({ tournamentId: tid, candidate: id, revision: rev[id] }, { state: ok ? "verified" : "rejected",
        decision: ok ? "VERIFIED" : "BLOCKED", deliverable: ok, profileComplete: true, contradictions: 0, mutationsRun: 1, mutationsSurvived: ok ? 0 : 1 });
    const decisionId = await t.recordEvidence(evidence("VERIFIED", true), { tournamentId: tid, candidate: "c2", revision: rev.c2, stage: "revalidation" });
    await t.recordTournamentDecision(tid, { outcome: "DELIVERY_ELIGIBLE", selected: "c2", selectedRevision: rev.c2, chosenBy: "fusion",
      evidenceDecisionId: decisionId, manifestSha256: "9".repeat(64) }, { format: "fusion.tournament", selection: { kind: "selected", converged: ["c2"], dominated: [] } });
    await t.finish({ state: "COMPLETED", exitCode: 0, code: "completed", message: `done ${CANARY}` });
    // A single build, and a run without a route decision (read-only).
    const s = await RunRecorder.start(dir, "build", REDACTOR, { task: CANARY });
    await s.recordRoute({ ...ROUTE, route: "single", candidates: 1, risk: "low" });
    await s.finish({ state: "DECISION_REQUIRED", exitCode: 13, code: "evidenceInsufficient", message: "no delivery" });
    const r = await RunRecorder.start(dir, "review", REDACTOR, { task: CANARY });
    await r.finish({ state: "ANSWERED", exitCode: 0, code: "answered", message: "read-only" });

    const collected = await collectRoutingRecords(dir, REDACTOR);
    assert.deepEqual([collected.records.length, collected.skipped, collected.unreadable], [2, 1, 0]);
    const byRoute = new Map(collected.records.map(x => [x.route, x]));
    assert.deepEqual(byRoute.get("tournament")?.tournament, { outcome: "DELIVERY_ELIGIBLE", judged: 2, verified: 1, rejected: 1, failed: 0,
      selection: "onlyVerified", mutationsRun: 2, mutationsSurvived: 1 });
    assert.equal(separated(byRoute.get("tournament")!), true);
    assert.deepEqual([byRoute.get("single")?.outcome, byRoute.get("single")?.facts.risk], ["decisionRequired", "low"]);
    const json = JSON.stringify(collected);
    assert.ok(!json.includes("CANARY") && !json.includes("secret-canary") && !json.includes("src/"), "no task text and no path");

    // The offline script reads the same records and changes nothing.
    const script = resolve("scripts", "v05-routing-calibration.mjs");
    const run = promisify(execFile);
    const out = await run(process.execPath, [script, "--repo", dir, "--json"]);
    const report = JSON.parse(out.stdout) as { records: number; reports: Array<{ policy: string }> };
    assert.equal(report.records, 2);
    assert.deepEqual(report.reports.map(x => x.policy), CALIBRATION_POLICIES.map(p => p.id));
    assert.ok(!out.stdout.includes("CANARY"));
    const text = await run(process.execPath, [script, "--repo", dir, "--policy", "single-always"]);
    assert.match(text.stdout, /^Policy single-always — never a tournament/mu);
    await assert.rejects(run(process.execPath, [script, "--limit", "0"]), (e: { code?: number }) => e.code === 2);
    await assert.rejects(run(process.execPath, [script, "--policy", "online-learning"]), (e: { code?: number }) => e.code === 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("v0.5 calibration: a route decision is validated strictly — a tournament of one, an unknown risk or source is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fusion-v05-route-event-"));
  try {
    const recorder = await RunRecorder.start(dir, "build", REDACTOR, {});
    for (const bad of [{ ...ROUTE, candidates: 1 }, { ...ROUTE, route: "single" }, { ...ROUTE, risk: "extreme" }, { ...ROUTE, source: "model" },
      { ...ROUTE, cap: 4 }, { ...ROUTE, candidates: 4 }])
      await assert.rejects(recorder.recordRoute(bad as RouteDecidedRecord), StorageError, JSON.stringify(bad));
    await recorder.recordRoute(ROUTE);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
