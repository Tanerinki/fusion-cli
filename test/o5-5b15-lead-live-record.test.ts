import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runRouteRehearsal } from "../src/app/route-probe.js";
import { liveWriterAuthorization, REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport, writerReadiness } from "../src/app/writer-gate.js";
import { terminalOnlyDiagnostic } from "../src/platform/process/terminal-diagnostic.js";
import { PROPOSAL_PROBE_PROFILES, ROUTE_REHEARSAL_PROFILES } from "../src/providers/probe-profiles.js";
import { changeProposalLiveRecords, fullRouteLiveCoverage, fullRouteLiveRecords, leadPlanLiveRecords,
  liveChangeProposalCoverage } from "../src/runtime/provider-profiles.js";
import { withRoot } from "./fixtures/probe-harness.js";
import { withInstalls } from "./fixtures/provider-installs.js";
import { asRun, PREFIX, routeEnv, routeRegistry, runRoute, sectionOf, testRouteAuthorization } from "./fixtures/route-harness.js";
import { gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5B15 Stage 2 — the one authorized live Lead-plan turn is recorded as what it was: RESULT_ERROR_MAX_TURNS
 * (error_max_turns / max_turns, 7 turns counted against the limit of 6, no reply, exit 1), never parsed. It is a Lead
 * diagnosis, not a full-route attempt: the O5.5B13 route record, every readiness row and the Change Author live history
 * are unchanged, and no authorization is open.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const OBSERVED = { classification: "RESULT_ERROR_MAX_TURNS", resultSubtype: "error_max_turns", terminalReason: "max_turns", isError: true,
  internalTurnCount: 7, permissionDenialCount: 0, errorEntryCount: 1, resultTextPresent: false, structuredParsingReached: false,
  schemaValidationReached: false, processExitCode: 1 } as const;

test("O5.5B15 record: the live Lead plan turn ended RESULT_ERROR_MAX_TURNS at the 6-turn limit; FAIL, never parsed", () => {
  assert.deepEqual(leadPlanLiveRecords(), [{ milestone: "O5.5B15", authorization: "O5.5B15-LEAD", provider: "claude", transport: "claude-one-shot",
    runtimeVersion: "2.1.280", model: "haiku", effort: "low", maxTurns: 6, outcome: "FAIL", routeOutcome: "PROVIDER_FAILED", terminal: OBSERVED,
    ranAt: "2026-09-25T09:32:23.643Z", evidenceSha256: "301e78180f29a78b6a584a02b141b89f185c199bea8a29a59f920e74ed9273ea",
    document: "docs/o5-5b15-lead-live-probe.md" }]);
  const [record] = leadPlanLiveRecords();
  assert.ok(Object.isFrozen(leadPlanLiveRecords()) && Object.isFrozen(record) && Object.isFrozen(record!.terminal));
  assert.equal(record!.terminal.internalTurnCount, record!.maxTurns + 1, "the CLI stops when the next turn would exceed the limit");
  // A Lead diagnosis is not a full-route attempt: the route history is exactly O5.5B13's.
  assert.deepEqual(fullRouteLiveRecords().map(r => [r.milestone, r.outcome, r.endedAt]), [["O5.5B13", "PROVIDER_FAILED", "leadPlan#1"]]);
  assert.deepEqual(fullRouteLiveCoverage(), { attempts: 1, passed: 0,
    latest: { milestone: "O5.5B13", outcome: "PROVIDER_FAILED", endedAt: "leadPlan#1", modelTurns: 1, rolesRun: 1 } });
});

test("O5.5B15 readiness: no row, aggregate or gate moves; the Change Author live PASSes stay; no authorization is open", () => {
  const report = writerGateReport();
  const rows = Object.fromEntries(report.rows.map(row => [row.id, [row.state, row.evidenceKind]]));
  assert.deepEqual([rows.fullRouteLive, rows.hostControlledWriterWorkflow, rows.providerChangeProposal, rows.fullRouteRehearsalImplementation,
    rows.liveGateAuthorization], [["blocked", "recordedLiveProbe"], ["partial", "fakeProviderRehearsal"], ["satisfied", "recordedLiveProbe"],
    ["satisfied", "fakeProcess"], ["blocked", "none"]]);
  assert.deepEqual(liveChangeProposalCoverage(), { changeAuthors: 2, passed: 2, failedOnly: 0, unprobed: 0 });
  assert.deepEqual(changeProposalLiveRecords("claude", "claude-one-shot").map(r => [r.milestone, r.outcome]), [["O5.5B9", "MALFORMED_PROPOSAL"], ["O5.5B11", "PASS"]]);
  assert.deepEqual(changeProposalLiveRecords("muse", "muse-exec").map(r => [r.milestone, r.outcome]), [["O5.5B9", "PASS"]]);
  const posture = writerReadiness().prerequisites.find(p => p.id === "writerPosture")!.text;
  assert.match(posture, /O5\.5B13\) ended at its first turn, the Lead plan/u);
  assert.match(posture, /O5\.5B15\) ended at the CLI's own turn limit \(error_max_turns, 6 turns\) before any reply/u);
  for (const input of ["CLAUDE_LEAD_LIVE_PROBE: PASS", { classification: "RESULT_OK", evidenceKind: "liveProvider" }, { leadPlanLive: "PASS" }])
    assert.deepEqual(writerGateReport({ linuxVerification: input }), report);
  assert.deepEqual([report.realWriterModeReady, REAL_WRITER_LIVE_GATE_AUTHORIZED, writerReadiness().ready, liveWriterAuthorization().authorized],
    [false, false, false, false]);
  assert.deepEqual(Object.entries(ROUTE_REHEARSAL_PROFILES.authorizations).map(([id, entry]) => [id, entry.state]),
    [["O5.5B12-LIVE", "pending"], ["O5.5B13-LIVE", "consumed"], ["O5.5B15-LEAD", "consumed"]]);
  assert.ok(Object.values(PROPOSAL_PROBE_PROFILES.authorizations).every(entry => entry.state === "consumed"));
});

test("O5.5B15 consumed: the production Lead-only identity is refused before anything exists", async () => withInstalls(async i => withRoot(async dir => {
  const noAdapters = { ...routeRegistry(i, { Lead: "x", Worker: "x", Reviewer: "x" }), factories: new Map() };
  // No nested-session variable here: the consumed state alone refuses it.
  const report = await runRouteRehearsal({ env: routeEnv(), registry: noAdapters, profiles: ROUTE_REHEARSAL_PROFILES,
    authorization: "O5.5B15-LEAD", evidenceRoot: join(dir, "live") });
  assert.equal("refused" in report && report.reason, "authorizationConsumed");
  assert.equal(existsSync(join(dir, "live")), false);
})));

test("O5.5B15 replay offline: the observed result-frame shape gives exactly the recorded diagnostic through the real adapter", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    const run = asRun(await runRoute(i, dir, "observed", { Lead: [{ prefix: PREFIX.plan, exitCode: 1, resultFrame: { subtype: "error_max_turns",
      is_error: true, terminal_reason: "max_turns", num_turns: 7, permission_denials: [], errors: ["Reached maximum number of turns (6)"],
      result: "__absent__" } }] }, { authorization: testRouteAuthorization(i, { turns: ROUTE_REHEARSAL_PROFILES.authorizations["O5.5B15-LEAD"]!.turns }) }));
    assert.deepEqual([run.report.outcome, run.report.detail], ["PROVIDER_FAILED", "leadPlan #1 (Lead): providerFailure: Claude reported a failed turn."]);
    const [turn] = sectionOf<Array<{ terminal: Record<string, unknown> }>>(run, "turns");
    assert.notEqual(terminalOnlyDiagnostic(turn!.terminal), "invalid");
    assert.deepEqual(Object.fromEntries(Object.keys(OBSERVED).map(key => [key, turn!.terminal[key]])), OBSERVED);
    assert.deepEqual(sectionOf<Record<string, number>>(run, "turnUse"), { leadPlan: 1, changeAuthor: 0, freshReview: 0, leadAdjudication: 0 });
    assert.equal(run.prompts.Worker.length + run.prompts.Reviewer.length, 0);
    assert.equal(run.report.evidence.evidenceKind, "offlineRehearsal", "a replay is never live evidence");
  })));
