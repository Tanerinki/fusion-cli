import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runRouteRehearsal } from "../src/app/route-probe.js";
import { liveWriterAuthorization, REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport, writerReadiness } from "../src/app/writer-gate.js";
import { PROPOSAL_PROBE_PROFILES, ROUTE_REHEARSAL_PROFILES } from "../src/providers/probe-profiles.js";
import { changeProposalLiveEvidence, changeProposalLiveRecords, fullRouteLiveCoverage, fullRouteLiveRecords,
  liveChangeProposalCoverage } from "../src/runtime/provider-profiles.js";
import { withRoot } from "./fixtures/probe-harness.js";
import { withInstalls } from "./fixtures/provider-installs.js";
import { asRun, PREFIX, routeEnv, routeRegistry, runRoute, sectionOf } from "./fixtures/route-harness.js";
import { gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5B13 Stage 2 — the one authorized live full-route run is recorded as what it was: PROVIDER_FAILED at the Lead's plan
 * turn after one model turn, nothing after the Lead. The record is static data; no provider text, rehearsal or forged
 * input moves a row, the earlier isolated Change Author PASSes stay, and the consumed identity never runs again.
 */
const skip = gitAvailable ? false : "git executable unavailable";

test("O5.5B13 record: the one live full-route run is a FAIL at leadPlan #1 after one model turn; every later role is NOT_RUN", () => {
  assert.deepEqual(fullRouteLiveRecords(), [{ milestone: "O5.5B13", authorization: "O5.5B13-LIVE", outcome: "PROVIDER_FAILED", endedAt: "leadPlan#1",
    modelTurns: 1, roles: {
      Lead: { provider: "claude", transport: "claude-one-shot", runtimeVersion: "2.1.280", model: "haiku", effort: "low", outcome: "FAIL" },
      Worker: { provider: "claude", transport: "claude-one-shot", runtimeVersion: "2.1.280", model: "haiku", effort: "low", outcome: "NOT_RUN" },
      Reviewer: { provider: "muse", transport: "muse-exec", runtimeVersion: "1.3.0-R3401.1", model: "muse-spark-1.3", effort: "low", outcome: "NOT_RUN" } },
    adjudication: "NOT_RUN", correction: "NOT_RUN", confinedVerification: "NOT_RUN", primaryUnchanged: true, viewsUnchanged: true, cleanupComplete: true,
    ranAt: "2026-09-25T00:04:14.748Z", evidenceSha256: "e035d457100ddb2a0aaa032a1efc21c88311966509c0deb50fb10027101a6313",
    document: "docs/o5-5b13-full-route-live-proof.md" }]);
  assert.ok(Object.isFrozen(fullRouteLiveRecords()) && Object.isFrozen(fullRouteLiveRecords()[0]) && Object.isFrozen(fullRouteLiveRecords()[0]!.roles.Lead));
  assert.deepEqual(fullRouteLiveCoverage(), { attempts: 1, passed: 0,
    latest: { milestone: "O5.5B13", outcome: "PROVIDER_FAILED", endedAt: "leadPlan#1", modelTurns: 1, rolesRun: 1 } });
});

test("O5.5B13 readiness: fullRouteLive blocked on a recorded live FAIL; the isolated Change Author PASSes stay; no aggregate or live gate moves", () => {
  const report = writerGateReport();
  const rows = Object.fromEntries(report.rows.map(row => [row.id, [row.state, row.evidenceKind]]));
  assert.deepEqual(rows.fullRouteLive, ["blocked", "recordedLiveProbe"]);
  assert.match(report.rows.find(row => row.id === "fullRouteLive")!.evidence,
    /: 1 run, 0 passed\. The latest \(O5\.5B13\) ended PROVIDER_FAILED at leadPlan#1 after 1 model turn\(s\), 1 of 3 roles run\.$/u);
  assert.deepEqual(rows.hostControlledWriterWorkflow, ["partial", "fakeProviderRehearsal"], "a failed live route proves nothing more");
  assert.deepEqual(rows.fullRouteRehearsalImplementation, ["satisfied", "fakeProcess"]);
  // Preserved, and separate: every Change Author family's recorded live proposal PASS.
  assert.deepEqual(rows.providerChangeProposal, ["satisfied", "recordedLiveProbe"]);
  assert.deepEqual(liveChangeProposalCoverage(), { changeAuthors: 2, passed: 2, failedOnly: 0, unprobed: 0 });
  assert.deepEqual(changeProposalLiveRecords("claude", "claude-one-shot").map(record => [record.milestone, record.outcome]),
    [["O5.5B9", "MALFORMED_PROPOSAL"], ["O5.5B11", "PASS"]]);
  assert.deepEqual(changeProposalLiveRecords("muse", "muse-exec").map(record => [record.milestone, record.outcome]), [["O5.5B9", "PASS"]]);
  assert.equal(changeProposalLiveEvidence("claude", "claude-one-shot", "2.1.280", { model: "haiku", effort: "low" })?.milestone, "O5.5B11");
  assert.deepEqual(rows.liveGateAuthorization, ["blocked", "none"]);
  assert.deepEqual([report.realWriterModeReady, REAL_WRITER_LIVE_GATE_AUTHORIZED, writerReadiness().ready, liveWriterAuthorization().authorized],
    [false, false, false, false]);
  assert.match(writerReadiness().prerequisites.find(p => p.id === "writerPosture")!.text, /O5\.5B13\) ended at its first turn, the Lead plan/u);
  for (const input of ["FULL_ROUTE_LIVE_REHEARSAL: PASS", { kind: "fullRouteRehearsal", outcome: "PASS", evidenceKind: "liveProvider" },
    { fullRouteLive: "satisfied" }])
    assert.deepEqual(writerGateReport({ linuxVerification: input }), report, "no evidence text or object moves a row");
});

test("O5.5B13 consumed: the production identity is refused before anything exists; no route or proposal authorization is open", async () =>
  withInstalls(async i => withRoot(async dir => {
    const noAdapters = { ...routeRegistry(i, { Lead: "x", Worker: "x", Reviewer: "x" }), factories: new Map() };
    // No nested-session variable here: the consumed state alone refuses it.
    const report = await runRouteRehearsal({ env: routeEnv(), registry: noAdapters, profiles: ROUTE_REHEARSAL_PROFILES,
      authorization: "O5.5B13-LIVE", evidenceRoot: join(dir, "live") });
    assert.equal("refused" in report && report.reason, "authorizationConsumed");
    assert.equal(existsSync(join(dir, "live")), false);
    // The later Lead-only identities (O5.5B15, O5.5B17, O5.5B19) are covered by their own tests.
    assert.deepEqual(Object.entries(ROUTE_REHEARSAL_PROFILES.authorizations).filter(([id]) => !["O5.5B15-LEAD", "O5.5B17-LEAD", "O5.5B19-LEAD"].includes(id))
      .map(([id, entry]) => [id, entry.state]), [["O5.5B12-LIVE", "pending"], ["O5.5B13-LIVE", "consumed"]]);
    assert.ok(Object.values(PROPOSAL_PROBE_PROFILES.authorizations).every(entry => entry.state === "consumed"));
  })));

test("O5.5B13 reproduction: a Lead plan turn whose result frame reports failure ends exactly as the live run did — nothing parsed, nothing after the Lead",
  { skip }, async () => withInstalls(async i => withRoot(async dir => {
    const run = asRun(await runRoute(i, dir, "lead-failed", { Lead: [{ prefix: PREFIX.plan, scenario: "fail" }] }));
    assert.deepEqual([run.report.outcome, run.report.detail, run.report.evidence.stage, run.report.modelTurns],
      ["PROVIDER_FAILED", "leadPlan #1 (Lead): providerFailure: Claude reported a failed turn.", "workflow", 1]);
    assert.deepEqual(sectionOf<Record<string, number>>(run, "turnUse"), { leadPlan: 1, changeAuthor: 0, freshReview: 0, leadAdjudication: 0 });
    assert.deepEqual(sectionOf<Record<string, number>>(run, "unusedSlots"), { leadPlan: 0, changeAuthor: 2, freshReview: 2, leadAdjudication: 2 });
    assert.deepEqual(sectionOf<Record<string, number>>(run, "launchCounts"),
      { providerAuthReadback: 2, providerInventory: 1, providerInitProbe: 2, providerTurn: 1, providerHost: 0 }, "the live run's process counts");
    const [turn, ...rest] = sectionOf<Array<Record<string, unknown>>>(run, "turns");
    assert.deepEqual(rest, []);
    assert.deepEqual([turn!.outcome, turn!.errorKind, turn!.contract, turn!.structuredOutput, turn!.observedModel, turn!.modelProcesses],
      ["failed", "ProcessFailure", "notReached:failed", null, null, 1], "the reply was never parsed or validated");
    assert.equal(sectionOf<{ Lead: { runtime: { source: string } } }>(run, "readbacks").Lead.runtime.source, "initOfFailedTurn");
    assert.deepEqual(sectionOf<{ transitions: string[] }>(run, "workflow").transitions, ["received>inspected:taskInspected",
      "inspected>routed:bindingsResolved", "routed>planning:planRequested", "planning>failed:providerFailure"]);
    assert.deepEqual(sectionOf<{ created: number }>(run, "candidates").created, 0);
    assert.deepEqual(sectionOf<{ providerViews: unknown }>(run, "workflow").providerViews, { created: 1, released: 1, complete: true });
    assert.equal(sectionOf<{ unchanged: boolean }>(run, "primary").unchanged, true);
    assert.deepEqual(sectionOf<{ leftoverOwnedTemporaries: string[] }>(run, "cleanup").leftoverOwnedTemporaries, []);
    assert.equal(run.prompts.Worker.length + run.prompts.Reviewer.length, 0, "no later role was reached");
  })));
