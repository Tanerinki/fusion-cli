import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runRouteRehearsal } from "../src/app/route-probe.js";
import { liveWriterAuthorization, REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport, writerReadiness } from "../src/app/writer-gate.js";
import { PROPOSAL_PROBE_PROFILES, ROUTE_REHEARSAL_PROFILES } from "../src/providers/probe-profiles.js";
import { changeProposalLiveRecords, fullRouteLiveCoverage, leadPlanLiveRecords, liveChangeProposalCoverage,
  routePreflightBlocks } from "../src/runtime/provider-profiles.js";
import { withRoot } from "./fixtures/probe-harness.js";
import { withInstalls } from "./fixtures/provider-installs.js";
import { routeEnv, routeRegistry } from "./fixtures/route-harness.js";

/**
 * O5.5B21 Stage 2 — the first live Lead contract PASS, recorded for exactly its binding, prompt and envelope: Claude Code
 * 2.1.280 haiku/low, --max-turns 6, the O5.5B16 planning prompt, the O5.5B18 single-fence Lead envelope. The route-level
 * TURN_REFUSED is the designed stop (Change Author budget 0). Not a full-route result; the earlier records are unchanged.
 */

test("O5.5B21 record: model turn PASS, reply envelope accepted (SINGLE_FENCED_VALID_JSON), Lead contract PASS — the exact tested binding", () => {
  const history = leadPlanLiveRecords();
  assert.deepEqual(history.map(r => [r.milestone, r.outcome, r.modelTurn, r.leadPrompt]), [["O5.5B15", "FAIL", "FAIL", "genericDelegation"],
    ["O5.5B17", "FAIL", "PASS", "planningLead"], ["O5.5B21", "PASS", "PASS", "planningLead"]]);
  assert.deepEqual(history[2], { milestone: "O5.5B21", authorization: "O5.5B21-LEAD", provider: "claude", transport: "claude-one-shot",
    runtimeVersion: "2.1.280", model: "haiku", effort: "low", maxTurns: 6, outcome: "PASS", modelTurn: "PASS", leadPrompt: "planningLead",
    routeOutcome: "TURN_REFUSED", replyEnvelope: { policy: "rawOrSingleJsonFence", classification: "SINGLE_FENCED_VALID_JSON", accepted: true },
    terminal: { classification: "RESULT_OK", resultSubtype: "success", terminalReason: "completed", isError: false, internalTurnCount: 6,
      permissionDenialCount: 0, errorEntryCount: null, resultTextPresent: true, structuredParsingReached: true, schemaValidationReached: true,
      processExitCode: 0 },
    ranAt: "2026-09-25T13:29:44.657Z", evidenceSha256: "c37ae087438580830f782ea47173e6922d03191c957fe2f75605307174a2054c",
    document: "docs/o5-5b21-lead-contract-live-retest.md" });
  assert.ok(Object.isFrozen(history[2]) && Object.isFrozen(history[2]!.replyEnvelope) && Object.isFrozen(history[2]!.terminal));
  // O5.5B17 vs O5.5B21: the same binding, prompt and limit; only the Lead envelope differs.
  const [, b17, b21] = history;
  for (const key of ["provider", "transport", "runtimeVersion", "model", "effort", "maxTurns", "leadPrompt"] as const) assert.equal(b21![key], b17![key], key);
  assert.deepEqual([b17!.contractRefusal?.policy, b21!.replyEnvelope?.policy], ["rawOnly", "rawOrSingleJsonFence"]);
  // Earlier records unchanged: O5.5B15 FAIL, O5.5B17 FAIL (model turn PASS), O5.5B19 a preflight block; one full-route attempt, 0 passed.
  assert.deepEqual(routePreflightBlocks().map(r => [r.milestone, r.outcome, r.modelTurns]), [["O5.5B19", "VERSION_BLOCKED", 0]]);
  assert.deepEqual([fullRouteLiveCoverage().attempts >= 1, fullRouteLiveCoverage().passed], [true, 0], "a Lead-only PASS is not a full-route result");
});

test("O5.5B21 readiness: no row, aggregate or gate moves; the Change Author live PASSes stay; nothing is open", () => {
  const report = writerGateReport();
  const rows = Object.fromEntries(report.rows.map(row => [row.id, [row.state, row.evidenceKind]]));
  assert.deepEqual([rows.fullRouteLive, rows.hostControlledWriterWorkflow, rows.providerChangeProposal, rows.liveGateAuthorization],
    [["blocked", "recordedLiveProbe"], ["partial", "fakeProviderRehearsal"], ["satisfied", "recordedLiveProbe"], ["blocked", "none"]]);
  assert.deepEqual(liveChangeProposalCoverage(), { changeAuthors: 2, passed: 2, failedOnly: 0, unprobed: 0 });
  assert.deepEqual(changeProposalLiveRecords("claude", "claude-one-shot").map(r => r.outcome), ["MALFORMED_PROPOSAL", "PASS"]);
  const posture = writerReadiness().prerequisites.find(p => p.id === "writerPosture")!.text;
  assert.match(posture, /a further Lead-only retest \(O5\.5B21\) passed end to end: the real Lead plan was accepted; no later role ran\./u);
  assert.doesNotMatch(writerReadiness().prerequisites.map(p => p.text).join(" "), /COMPLETED|success/iu, "the CLI prints these; no success wording");
  for (const input of ["CLAUDE_LEAD_CONTRACT_LIVE: PASS", { leadPlanLive: "PASS", contract: "accepted" }])
    assert.deepEqual(writerGateReport({ linuxVerification: input }), report);
  assert.deepEqual([report.realWriterModeReady, REAL_WRITER_LIVE_GATE_AUTHORIZED, liveWriterAuthorization().authorized], [false, false, false]);
  assert.ok(Object.values(ROUTE_REHEARSAL_PROFILES.authorizations).filter(entry => entry.milestone !== "O5.5B25").every(entry => entry.state !== "open"));
  assert.ok(Object.values(PROPOSAL_PROBE_PROFILES.authorizations).every(entry => entry.state === "consumed"));
});

test("O5.5B21 consumed: the production retest identity is refused before anything exists", async () => withInstalls(async i => withRoot(async dir => {
  const noAdapters = { ...routeRegistry(i, { Lead: "x", Worker: "x", Reviewer: "x" }), factories: new Map() };
  const report = await runRouteRehearsal({ env: routeEnv(), registry: noAdapters, profiles: ROUTE_REHEARSAL_PROFILES,
    authorization: "O5.5B21-LEAD", evidenceRoot: join(dir, "live") });
  assert.equal("refused" in report && report.reason, "authorizationConsumed");
  assert.equal(existsSync(join(dir, "live")), false);
})));
