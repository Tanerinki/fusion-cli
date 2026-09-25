import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { liveWriterAuthorization, REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport, writerReadiness } from "../src/app/writer-gate.js";
import { PROPOSAL_PROBE_PROFILES, ROUTE_REHEARSAL_PROFILES } from "../src/providers/probe-profiles.js";
import { changeProposalLiveRecords, fullRouteLiveCoverage, fullRouteLiveRecords } from "../src/runtime/provider-profiles.js";
import { withRoot } from "./fixtures/probe-harness.js";
import { withInstalls } from "./fixtures/provider-installs.js";
import { asRun, cleanReview, plan, PREFIX, proposal, runRoute, sectionOf } from "./fixtures/route-harness.js";
import { FIX, gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5B14 — the bounded terminal diagnostic in future route evidence, offline with the REAL adapters against fake
 * binaries: every Claude role turn says why its model process ended; a Muse turn is unchanged (none); nothing a fake
 * run produces becomes live evidence, and the historical O5.5B13 record stays exactly what it was.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const CANARY = "ROUTE-PROVIDER-TEXT-CANARY-51d7";
type Terminal = Record<string, unknown> | null;
type Turn = { claim: string; turn: string; outcome: string; terminal: Terminal };

test("O5.5B14 route: a Lead plan that ends error_max_turns stays PROVIDER_FAILED; its evidence now says RESULT_ERROR_MAX_TURNS, text-free", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    const run = asRun(await runRoute(i, dir, "max-turns", { Lead: [{ prefix: PREFIX.plan, exitCode: 1, resultFrame: { subtype: "error_max_turns",
      is_error: true, terminal_reason: "max_turns", num_turns: 7, errors: [`Reached maximum number of turns (6) ${CANARY}`],
      permission_denials: [{ tool_name: "Write", tool_use_id: "toolu_private", tool_input: { file_path: CANARY } }], result: "__absent__" } }] }));
    assert.deepEqual([run.report.outcome, run.report.detail], ["PROVIDER_FAILED", "leadPlan #1 (Lead): providerFailure: Claude reported a failed turn."],
      "the outcome contract is unchanged; the diagnostic explains it");
    const [lead, ...rest] = sectionOf<Turn[]>(run, "turns");
    assert.deepEqual(rest, []);
    assert.deepEqual(lead!.terminal, { schemaVersion: 1, classification: "RESULT_ERROR_MAX_TURNS", resultSubtype: "error_max_turns",
      terminalReason: "max_turns", isError: true, internalTurnCount: 7, permissionDenialCount: 1, errorEntryCount: 1, resultTextPresent: false,
      resultTextByteLength: 0, apiErrorStatusClass: "none", structuredParsingReached: false, schemaValidationReached: false, processExitCode: 1,
      processSignal: null, fusionTermination: null, timedOut: false, cancelled: false });
    const text = await readFile(run.report.evidencePath, "utf8");
    for (const secret of [CANARY, "Reached maximum", "toolu_private"]) assert.ok(!text.includes(secret), `evidence leaks ${secret}`);
    assert.equal(run.report.evidence.evidenceKind, "offlineRehearsal");
  })));

test("O5.5B14 route: every Claude turn carries its diagnostic (parsed, schema reached); the Muse Reviewer turn carries its own (O5.5B23)", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    const run = asRun(await runRoute(i, dir, "straight", { Lead: [{ prefix: PREFIX.plan, output: plan(), resultFrame: { num_turns: 3 } }],
      Worker: [proposal(FIX)], Reviewer: [{ prefix: PREFIX.review, output: cleanReview }] }));
    assert.equal(run.report.outcome, "PASS", run.report.detail);
    const turns = sectionOf<Turn[]>(run, "turns");
    assert.deepEqual(turns.map(t => [t.claim.split(":")[1], t.terminal === null ? null : [t.terminal.classification, t.terminal.structuredParsingReached,
      t.terminal.schemaValidationReached, t.terminal.processExitCode]]), [
      // The Muse Reviewer reported none until O5.5B23 gave the Exec transport the same bounded diagnostic.
      ["leadPlan#1", ["RESULT_OK", true, true, 0]], ["changeAuthor#1", ["RESULT_OK", true, true, 0]], ["freshReview#1", ["RESULT_OK", true, true, 0]]]);
    assert.equal(turns[0]!.terminal!.internalTurnCount, 3);
    // O5.5B14 pinned the generic delegation prompt here (asking the read-only Lead to complete the write task); O5.5B16
    // deliberately replaced it with the planning Lead's contract. The delegation itself is unchanged.
    const leadPrompt = run.prompts.Lead[0]!;
    assert.ok(leadPrompt.startsWith("You are the planning Lead for this delegated task."));
    assert.ok(!leadPrompt.includes("Complete this delegated task within its scope."));
    assert.ok(leadPrompt.includes(`"allowedFiles":["src/quote.ts","test/quote.test.ts"]`));
  })));

test("O5.5B14 readiness: diagnostics are implementation only — the O5.5B13 record stays FAIL, no row or gate moves, nothing is open", () => {
  const records = fullRouteLiveRecords();
  assert.deepEqual(records.slice(0, 1).map(record => [record.milestone, record.outcome, record.endedAt, record.modelTurns, record.roles.Lead.outcome]),
    [["O5.5B13", "PROVIDER_FAILED", "leadPlan#1", 1, "FAIL"]], "historical: never re-judged");
  assert.deepEqual(Object.keys(records[0]!), ["milestone", "authorization", "outcome", "endedAt", "modelTurns", "roles", "adjudication", "correction",
    "confinedVerification", "primaryUnchanged", "viewsUnchanged", "cleanupComplete", "ranAt", "evidenceSha256", "document"],
    "the historical record gains no diagnostic it never had");
  // History grows (O5.5B25 recorded a second, later run); nothing has passed.
  assert.deepEqual([fullRouteLiveCoverage().attempts >= 1, fullRouteLiveRecords().filter(r => r.milestone !== "O5.5B27").some(r => r.outcome === "PASS")], [true, false]);
  const report = writerGateReport();
  const rows = Object.fromEntries(report.rows.map(row => [row.id, [row.state, row.evidenceKind]]));
  assert.deepEqual([rows.fullRouteLive, rows.hostControlledWriterWorkflow, rows.providerChangeProposal, rows.liveGateAuthorization],
    [["partial", "recordedLiveProbe"], ["partial", "recordedLiveProbe"], ["satisfied", "recordedLiveProbe"], ["blocked", "none"]]);
  assert.deepEqual(changeProposalLiveRecords("claude", "claude-one-shot").map(record => record.outcome), ["MALFORMED_PROPOSAL", "PASS"]);
  const fakeDiagnostic = { schemaVersion: 1, classification: "RESULT_OK", evidenceKind: "liveProvider" };
  for (const input of [fakeDiagnostic, "CLAUDE_TERMINAL_DIAGNOSTICS: READY", { fullRouteLive: "PASS" }])
    assert.deepEqual(writerGateReport({ linuxVerification: input }), report, "no diagnostic moves a row");
  assert.deepEqual([report.realWriterModeReady, REAL_WRITER_LIVE_GATE_AUTHORIZED, writerReadiness().ready, liveWriterAuthorization().authorized],
    [false, false, false, false]);
  // Only a later Lead-only identity (O5.5B15, O5.5B17, O5.5B19) may be open; their own tests cover them.
  assert.ok(Object.entries(ROUTE_REHEARSAL_PROFILES.authorizations).every(([id, entry]) => ["O5.5B15-LEAD", "O5.5B17-LEAD", "O5.5B19-LEAD", "O5.5B21-LEAD", "O5.5B25-LIVE", "O5.5B27-LIVE"].includes(id) || entry.state !== "open"),
    "no other live route authorization is open");
  assert.ok(Object.values(PROPOSAL_PROBE_PROFILES.authorizations).every(entry => entry.state === "consumed"), "no live proposal authorization is open");
});
