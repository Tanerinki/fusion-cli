import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runRouteRehearsal, type RouteReport } from "../src/app/route-probe.js";
import { REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport } from "../src/app/writer-gate.js";
import { ROUTE_REHEARSAL_PROFILES } from "../src/providers/probe-profiles.js";
import { fullRouteLiveCoverage, leadPlanLiveRecords, routePreflightBlocks } from "../src/runtime/provider-profiles.js";
import { withRoot } from "./fixtures/probe-harness.js";
import { installMuseVersion, withInstalls } from "./fixtures/provider-installs.js";
import { routeCompose, routeEnv, routeRegistry, testRouteAuthorization, testRouteBindings, testRouteProfiles, TEST_ROUTE } from "./fixtures/route-harness.js";
import { gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5B19 — the human's one attempt stopped in PREFLIGHT: VERSION_BLOCKED on the inactive Reviewer (Muse had moved to the
 * unvalidated 1.4.0-R4161.1) although the authorization gave the Reviewer no turn. No claim, no provider model turn: not
 * a Lead PASS or FAIL. Recorded as a preflight block; the identity is retired; nothing else moves.
 */
const skip = gitAvailable ? false : "git executable unavailable";

test("O5.5B19 record: a preflight block on the inactive Reviewer — no claim, no model turn; not a Lead or route result", () => {
  assert.deepEqual(routePreflightBlocks(), [{ milestone: "O5.5B19", authorization: "O5.5B19-LEAD", outcome: "VERSION_BLOCKED", blockedRole: "Reviewer",
    blockedProvider: "muse", transport: "muse-exec", installedVersion: "1.4.0-R4161.1", validatedVersions: ["1.3.0-R3401.1"], blockedRoleBudget: 0,
    modelTurns: 0, claimWritten: false, ranAt: "2026-09-25T12:38:18.712Z",
    evidenceSha256: "65377221e5d8742208346b209be606449e72fe5a0ae0c8ed70b88d2c1c9968dc", document: "docs/o5-5b19-lead-contract-live-retest.md" }]);
  assert.ok(Object.isFrozen(routePreflightBlocks()) && Object.isFrozen(routePreflightBlocks()[0]));
  // Not a Lead result and not a route attempt: those histories are unchanged.
  assert.deepEqual(leadPlanLiveRecords().map(r => r.milestone), ["O5.5B15", "O5.5B17"]);
  assert.deepEqual([fullRouteLiveCoverage().attempts, fullRouteLiveCoverage().passed], [1, 0]);
  assert.equal(ROUTE_REHEARSAL_PROFILES.authorizations["O5.5B19-LEAD"]!.state, "retired");
  const report = writerGateReport();
  const rows = Object.fromEntries(report.rows.map(row => [row.id, [row.state, row.evidenceKind]]));
  assert.deepEqual([rows.fullRouteLive, rows.hostControlledWriterWorkflow, rows.providerChangeProposal, rows.liveGateAuthorization],
    [["blocked", "recordedLiveProbe"], ["partial", "fakeProviderRehearsal"], ["satisfied", "recordedLiveProbe"], ["blocked", "none"]]);
  assert.deepEqual([report.realWriterModeReady, REAL_WRITER_LIVE_GATE_AUTHORIZED], [false, false]);
});

test("O5.5B19 retired: the production identity is refused before anything exists", async () => withInstalls(async i => withRoot(async dir => {
  const noAdapters = { ...routeRegistry(i, { Lead: "x", Worker: "x", Reviewer: "x" }), factories: new Map() };
  const report = await runRouteRehearsal({ env: routeEnv(), registry: noAdapters, profiles: ROUTE_REHEARSAL_PROFILES,
    authorization: "O5.5B19-LEAD", evidenceRoot: join(dir, "live") });
  assert.deepEqual("refused" in report && [report.reason, report.message], ["authorizationRetired",
    "Route authorization O5.5B19-LEAD was retired without a model turn; a new run needs a new human authorization."]);
  assert.equal(existsSync(join(dir, "live")), false);
})));

// O5.5B20 made preflight check only the roles an authorization lets start, so the Lead-only case no longer blocks
// (o5-5b20 tests). The block itself stays exact for a route that DOES give the Reviewer turns.
test("O5.5B19 block reproduced offline: an unvalidated Muse on a Reviewer with authorized turns blocks preflight with the live detail",
  { skip }, async () => withInstalls(async i => withRoot(async dir => {
    await installMuseVersion(i, "1.4.0-R4161.1");
    const authorization = testRouteAuthorization(i);
    assert.equal(authorization.turns.freshReview, 2, "the full route: the Reviewer can start");
    const report = await runRouteRehearsal({ env: routeEnv({ FUSION_CLAUDE_EXE: i.claudeExe }), registry: routeRegistry(i,
      { Lead: join(dir, "l.json"), Worker: join(dir, "w.json"), Reviewer: join(dir, "r.json") }), profiles: testRouteProfiles(authorization),
      authorization: TEST_ROUTE, evidenceRoot: join(dir, "b19"), bindings: testRouteBindings(i, authorization), offlineRehearsal: true,
      compose: routeCompose(dir) }) as RouteReport;
    assert.deepEqual([report.outcome, report.detail, report.evidence.stage, report.modelTurns],
      ["VERSION_BLOCKED", "Reviewer: installed 1.4.0-R4161.1 is not a validated muse-exec release", "preflight", 0]);
    assert.equal(existsSync(join(dir, "b19", "route.claim.json")), false, "no claim: nothing consumed");
    assert.equal(report.evidence.launches, undefined, "no provider process started");
  })));
