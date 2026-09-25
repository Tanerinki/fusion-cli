import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runRouteRehearsal } from "../src/app/route-probe.js";
import { liveWriterAuthorization, REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport, writerReadiness } from "../src/app/writer-gate.js";
import { PROPOSAL_PROBE_PROFILES, ROUTE_REHEARSAL_PROFILES } from "../src/providers/probe-profiles.js";
import { changeProposalLiveRecords, fullRouteLiveCoverage, leadPlanLiveRecords, liveChangeProposalCoverage } from "../src/runtime/provider-profiles.js";
import { withRoot } from "./fixtures/probe-harness.js";
import { withInstalls } from "./fixtures/provider-installs.js";
import { ClaudeStream } from "../src/providers/claude/parsing/stream.js";
import { packetEnvelope } from "../src/providers/claude/one-shot-transport.js";
import { ClaudeFailure } from "../src/providers/claude/types.js";
import { fenced, plan, routeEnv, routeRegistry } from "./fixtures/route-harness.js";

/**
 * O5.5B17 Stage 2 — the one authorized Lead retest under the O5.5B16 planning prompt is recorded as what it was: the
 * model turn SUCCEEDED (RESULT_OK within the same 6-turn limit), the Lead CONTRACT FAILED — its reply, exactly one fenced
 * JSON object, was refused by the raw-only Lead envelope before the ResultPacket check ran. Not a Lead contract PASS,
 * not a route attempt; the O5.5B13/O5.5B15 records, readiness and the Change Author history are unchanged.
 */
const REFUSAL = "Claude structured output was refused: SINGLE_FENCED_VALID_JSON under the rawOnly envelope.";

test("O5.5B17 record: model turn PASS (RESULT_OK, 6 turns, exit 0), Lead contract FAIL (envelope: SINGLE_FENCED_VALID_JSON under rawOnly)", () => {
  const [b15, b17, ...rest] = leadPlanLiveRecords();
  assert.deepEqual(rest, []);
  assert.deepEqual(b17, { milestone: "O5.5B17", authorization: "O5.5B17-LEAD", provider: "claude", transport: "claude-one-shot",
    runtimeVersion: "2.1.280", model: "haiku", effort: "low", maxTurns: 6, outcome: "FAIL", modelTurn: "PASS", leadPrompt: "planningLead",
    routeOutcome: "MALFORMED_OUTPUT", contractRefusal: { stage: "envelope", policy: "rawOnly", classification: "SINGLE_FENCED_VALID_JSON" },
    terminal: { classification: "RESULT_OK", resultSubtype: "success", terminalReason: "completed", isError: false, internalTurnCount: 6,
      permissionDenialCount: 0, errorEntryCount: null, resultTextPresent: true, structuredParsingReached: true, schemaValidationReached: true,
      processExitCode: 0 },
    ranAt: "2026-09-25T10:50:40.323Z", evidenceSha256: "86ad482dcfacfb0eec56eab82cecbccfe82a1be1254357bb5943ec7ef18b9c85",
    document: "docs/o5-5b17-lead-live-retest.md" });
  assert.ok(Object.isFrozen(b17) && Object.isFrozen(b17!.terminal) && Object.isFrozen(b17!.contractRefusal));
  // The A/B: same binding and limit, only the prompt differs; the turn count went from 7 (limit exceeded) to 6.
  for (const key of ["provider", "transport", "runtimeVersion", "model", "effort", "maxTurns"] as const) assert.equal(b17![key], b15![key], key);
  assert.deepEqual([b15!.leadPrompt, b15!.modelTurn, b15!.terminal.internalTurnCount, b17!.leadPrompt, b17!.modelTurn, b17!.terminal.internalTurnCount],
    ["genericDelegation", "FAIL", 7, "planningLead", "PASS", 6]);
  assert.equal(b15!.contractRefusal, undefined);
  // Not a full-route attempt.
  assert.deepEqual([fullRouteLiveCoverage().attempts, fullRouteLiveCoverage().passed], [1, 0]);
});

test("O5.5B17 readiness: no row, aggregate or gate moves; the Change Author live PASSes stay; no authorization is open", () => {
  const report = writerGateReport();
  const rows = Object.fromEntries(report.rows.map(row => [row.id, [row.state, row.evidenceKind]]));
  assert.deepEqual([rows.fullRouteLive, rows.hostControlledWriterWorkflow, rows.providerChangeProposal, rows.liveGateAuthorization],
    [["blocked", "recordedLiveProbe"], ["partial", "fakeProviderRehearsal"], ["satisfied", "recordedLiveProbe"], ["blocked", "none"]]);
  assert.deepEqual(liveChangeProposalCoverage(), { changeAuthors: 2, passed: 2, failedOnly: 0, unprobed: 0 });
  assert.deepEqual(changeProposalLiveRecords("claude", "claude-one-shot").map(r => r.outcome), ["MALFORMED_PROPOSAL", "PASS"]);
  assert.match(writerReadiness().prerequisites.find(p => p.id === "writerPosture")!.text,
    /\(O5\.5B17\) answered within the same limit, but its reply, one fenced JSON object, was refused by the Lead's raw-only reply envelope/u);
  assert.doesNotMatch(writerReadiness().prerequisites.map(p => p.text).join(" "), /COMPLETED|success/iu, "the CLI prints these; no success wording");
  for (const input of ["CLAUDE_LEAD_MODEL_TURN_LIVE: PASS", { leadPlanLive: "PASS", classification: "RESULT_OK" }])
    assert.deepEqual(writerGateReport({ linuxVerification: input }), report);
  assert.deepEqual([report.realWriterModeReady, REAL_WRITER_LIVE_GATE_AUTHORIZED, liveWriterAuthorization().authorized], [false, false, false]);
  // Only the later O5.5B19 contract retest may be open (its own tests cover it).
  assert.ok(Object.entries(ROUTE_REHEARSAL_PROFILES.authorizations).every(([id, entry]) => id === "O5.5B19-LEAD" || entry.state !== "open"));
  assert.ok(Object.values(PROPOSAL_PROBE_PROFILES.authorizations).every(entry => entry.state === "consumed"));
});

test("O5.5B17 consumed: the production retest identity is refused before anything exists", async () => withInstalls(async i => withRoot(async dir => {
  const noAdapters = { ...routeRegistry(i, { Lead: "x", Worker: "x", Reviewer: "x" }), factories: new Map() };
  const report = await runRouteRehearsal({ env: routeEnv(), registry: noAdapters, profiles: ROUTE_REHEARSAL_PROFILES,
    authorization: "O5.5B17-LEAD", evidenceRoot: join(dir, "live") });
  assert.equal("refused" in report && report.reason, "authorizationConsumed");
  assert.equal(existsSync(join(dir, "live")), false);
})));

// O5.5B18 changed the Lead plan's envelope, so the route now accepts this reply (o5-5b18 tests). The refusal O5.5B17
// observed stays reproducible under the raw-only packet envelope the Lead used then.
test("O5.5B17 refusal reproduced: under the raw-only packet envelope (the Lead's policy then), one fenced ResultPacket is refused with the live message", () => {
  const stream = new ClaudeStream();
  stream.accept({ type: "system", subtype: "init", model: "claude-canonical-fixture" });
  stream.accept({ type: "result", subtype: "success", is_error: false, terminal_reason: "completed", result: fenced(JSON.parse(plan())) });
  assert.throws(() => stream.packet({ policy: "rawOnly" }), (error: unknown) => error instanceof ClaudeFailure &&
    error.error.kind === "MalformedOutput" && error.error.safeMessage === REFUSAL);
  assert.deepEqual([stream.outputDiagnostic?.classification, stream.outputDiagnostic?.accepted, stream.outputDiagnostic?.bodyMatchesExpectedSchema],
    ["SINGLE_FENCED_VALID_JSON", false, "notChecked"], "no schema predicate: the ResultPacket shape was never checked");
  assert.equal(packetEnvelope(undefined).policy, "rawOnly", "every non-plan packet turn keeps that envelope");
});
