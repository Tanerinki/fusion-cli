import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport } from "../src/app/writer-gate.js";
import type { ChangeProposalRequest, DelegationPacket, StructuredTurnRequest } from "../src/core/domain.js";
import { structureOnlyDiagnostic } from "../src/platform/process/structured-envelope.js";
import { ClaudeOneShotTransport, packetEnvelope, structuredEnvelope } from "../src/providers/claude/one-shot-transport.js";
import { ClaudeStream, isResultPacket } from "../src/providers/claude/parsing/stream.js";
import { claudeTerminalDiagnostic } from "../src/providers/claude/parsing/terminal.js";
import { ClaudeFailure, type ClaudeLaunchConfig } from "../src/providers/claude/types.js";
import { parsePacket } from "../src/providers/muse/structured-output.js";
import { PROPOSAL_PROBE_PROFILES, ROUTE_REHEARSAL_PROFILES } from "../src/providers/probe-profiles.js";
import { fullRouteLiveCoverage, fullRouteLiveRecords, leadPlanLiveRecords, transportProfile } from "../src/runtime/provider-profiles.js";
import { withRoot } from "./fixtures/probe-harness.js";
import { withInstalls } from "./fixtures/provider-installs.js";
import { asRun, fenced, plan, PREFIX, runRoute, sectionOf, testRouteAuthorization } from "./fixtures/route-harness.js";
import { gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5B18 — the Lead plan's ResultPacket is read under the same narrow envelope the Change Author already uses (O5.5B10):
 * raw strict JSON, or exactly one outer json/bare fence with only whitespace outside it around one strict JSON object that
 * is an exact ResultPacket. Nothing else changes: every other packet turn and every review/adjudication turn stays
 * raw-only, the Change Author and Muse are untouched, and no offline replay is live evidence.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const PACKET = { result: { status: "completed" }, changes: { files: ["src/quote.ts"], summary: "Plan: tax the discounted subtotal." },
  verification: { testsRun: [], results: [] }, uncertainties: [], failures: [], needsLeadDecision: [] };
const RAW = JSON.stringify(PACKET);
const PRETTY = JSON.stringify(PACKET, null, 2);
const LEAD = packetEnvelope("plan");

/** One Lead plan reply through the real stream reader under the Lead's envelope. */
function lead(text: string, envelope = LEAD) {
  const stream = new ClaudeStream();
  stream.accept({ type: "system", subtype: "init", model: "claude-canonical-fixture" });
  stream.accept({ type: "result", subtype: "success", is_error: false, terminal_reason: "completed", result: text });
  let value: unknown, error: ClaudeFailure | undefined;
  try { value = stream.packet(envelope); } catch (caught) { if (caught instanceof ClaudeFailure) error = caught; else throw caught; }
  return { value, error, diagnostic: stream.outputDiagnostic!, terminal: claudeTerminalDiagnostic(stream.terminalFacts(), undefined, true) };
}
const accepted = (text: string, cls: string, label: string) => {
  const r = lead(text);
  assert.equal(r.error, undefined, `${label}: ${r.error?.error.safeMessage}`);
  assert.deepEqual(r.value, PACKET, label);
  assert.deepEqual([r.diagnostic.classification, r.diagnostic.accepted, r.diagnostic.policy, r.diagnostic.bodyMatchesExpectedSchema],
    [cls, true, "rawOrSingleJsonFence", true], label);
  return r;
};
const refused = (text: string, cls: string, label: string) => {
  const r = lead(text);
  assert.ok(r.error, `${label}: must be refused`);
  assert.deepEqual([r.error!.error.kind, r.error!.error.safeMessage],
    ["MalformedOutput", `Claude structured output was refused: ${cls} under the rawOrSingleJsonFence envelope.`], label);
  assert.deepEqual([r.diagnostic.classification, r.diagnostic.accepted], [cls, false], label);
  return r;
};

test("O5.5B18 Lead envelope: raw JSON, one ```json fence, one bare fence, and whitespace around them are accepted — the same exact ResultPacket", () => {
  accepted(RAW, "RAW_VALID_JSON", "raw");
  accepted(` \n${PRETTY}\n\t`, "RAW_VALID_JSON", "raw with surrounding whitespace");
  accepted(`\`\`\`json\n${RAW}\n\`\`\``, "SINGLE_FENCED_VALID_JSON", "json fence");
  accepted(`\`\`\`\n${PRETTY}\n\`\`\``, "SINGLE_FENCED_VALID_JSON", "bare fence");
  accepted(fenced(PACKET), "SINGLE_FENCED_VALID_JSON", "json fence, pretty, trailing newline");
  accepted(`\r\n  \`\`\`json\r\n${PRETTY.replace(/\n/gu, "\r\n")}\r\n\`\`\`\r\n\r\n `, "SINGLE_FENCED_VALID_JSON", "CRLF and whitespace only outside");
});

test("O5.5B18 Lead envelope refuses everything else: prose, several or nested fences, unclosed or other-language fences", () => {
  refused(`Here is the plan:\n\`\`\`json\n${RAW}\n\`\`\``, "EXTRA_TEXT", "prose before the fence");
  refused(`\`\`\`json\n${RAW}\n\`\`\`\nDone.`, "EXTRA_TEXT", "prose after the fence");
  refused(`\`\`\`json\n${RAW}\n\`\`\`\n\`\`\`json\n${RAW}\n\`\`\``, "MULTIPLE_FENCES", "two fences");
  refused(`\`\`\`json\n{\n\`\`\`json\n${RAW}\n\`\`\`\n}\n\`\`\``, "MULTIPLE_FENCES", "a nested fence");
  refused(`\`\`\`json\n${RAW}\n`, "UNCLOSED_FENCE", "an unclosed fence");
  refused(`\`\`\`js\n${RAW}\n\`\`\``, "UNSUPPORTED_FENCE", "another fence language");
  refused(`\`\`\`JSON5\n${RAW}\n\`\`\``, "UNSUPPORTED_FENCE", "a JSON5 fence tag");
  refused(`~~~json\n${RAW}\n~~~`, "UNSUPPORTED_FENCE", "a tilde fence");
  refused(`The plan is ${RAW}`, "OTHER_MALFORMED", "prose around raw JSON");
  refused(`${RAW} Done.`, "EXTRA_TEXT", "prose after raw JSON");
});

test("O5.5B18 Lead envelope never repairs JSON: malformed, duplicate keys, trailing commas, comments, JSON5 and concatenated documents fail", () => {
  const f = (body: string) => `\`\`\`json\n${body}\n\`\`\``;
  refused(f(`{"result": }`), "SINGLE_FENCED_INVALID_JSON", "malformed JSON");
  const duplicate = refused(f(`{"result":{"status":"blocked"},"result":{"status":"completed"},"changes":{"files":[],"summary":""},` +
    `"verification":{"testsRun":[],"results":[]},"uncertainties":[],"failures":[],"needsLeadDecision":[]}`), "SINGLE_FENCED_INVALID_JSON", "a duplicate key");
  assert.equal(duplicate.diagnostic.bodyJsonFailure, "duplicateKey");
  refused(f(RAW.replace(/\]\}$/u, "],}")), "SINGLE_FENCED_INVALID_JSON", "a trailing comma");
  refused(f(`// plan\n${RAW}`), "SINGLE_FENCED_INVALID_JSON", "a comment");
  refused(f(RAW.replace(/"/gu, "'")), "SINGLE_FENCED_INVALID_JSON", "JSON5 single quotes");
  refused(f(`${RAW}\n${RAW}`), "MULTIPLE_VALUES", "two concatenated documents in the fence");
  refused(`${RAW}${RAW}`, "MULTIPLE_VALUES", "two concatenated raw documents");
  refused(`{"result": }`, "RAW_INVALID_JSON", "malformed raw JSON");
});

test("O5.5B18 Lead envelope checks the exact ResultPacket shape: wrong top-level type and schema-invalid packets fail", () => {
  const f = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
  refused(f([PACKET]), "INVALID_SCHEMA", "an array");
  refused(f("plan"), "INVALID_SCHEMA", "a string");
  const { needsLeadDecision: _omit, ...missing } = PACKET;
  for (const [label, value] of [["a missing key", missing], ["an extra key", { ...PACKET, secret: "x" }],
    ["an unknown status", { ...PACKET, result: { status: "done" } }], ["a non-string file", { ...PACKET, changes: { files: [1], summary: "" } }]] as const) {
    const r = refused(f(value), "INVALID_SCHEMA", label);
    assert.equal(r.diagnostic.bodyMatchesExpectedSchema, false, label);
  }
  // A raw reply is handed on exactly as before; the unchanged ResultPacket check then refuses it.
  const raw = lead(JSON.stringify({ ...PACKET, secret: "x" }));
  assert.deepEqual([raw.diagnostic.classification, raw.diagnostic.accepted, raw.error?.error.safeMessage],
    ["INVALID_SCHEMA", true, "Claude returned an invalid ResultPacket."]);
  assert.equal(isResultPacket(PACKET), true);
});

test("O5.5B18 privacy and diagnostics: the reply shape is recorded without content; schemaValidationReached means a check actually ran", () => {
  const secret = "LEAD-ENVELOPE-CANARY-51b3";
  const ok = lead(`\`\`\`json\n${JSON.stringify({ ...PACKET, changes: { files: [], summary: secret } })}\n\`\`\``);
  assert.notEqual(structureOnlyDiagnostic(ok.diagnostic), "invalid");
  assert.ok(!JSON.stringify(ok.diagnostic).includes(secret) && !JSON.stringify(ok.terminal).includes(secret));
  assert.deepEqual([ok.terminal.structuredParsingReached, ok.terminal.schemaValidationReached], [true, true]);
  // The O5.5B17 case under the raw-only envelope: refused before any schema check — no longer reported as reached.
  const before = lead(fenced(PACKET), { policy: "rawOnly" });
  assert.deepEqual([before.diagnostic.classification, before.diagnostic.bodyMatchesExpectedSchema, before.terminal.schemaValidationReached],
    ["SINGLE_FENCED_VALID_JSON", "notChecked", false]);
  // A fenced body that fails the schema: the check ran (and refused it).
  assert.equal(lead(`\`\`\`json\n{"plan":1}\n\`\`\``).terminal.schemaValidationReached, true);
  // A fence body that does not parse: no check ran.
  assert.equal(lead(`\`\`\`json\n{bad\n\`\`\``).terminal.schemaValidationReached, false);
});

test("O5.5B18 scope: only the Lead plan widens — every other packet turn, review and adjudication stay raw-only; the Change Author is unchanged",
  () => {
    assert.deepEqual([LEAD.policy, typeof LEAD.conforms], ["rawOrSingleJsonFence", "function"]);
    for (const purpose of [undefined, "delegate", "exploration", "leadReview"] as const) {
      assert.deepEqual(packetEnvelope(purpose), { policy: "rawOnly" }, String(purpose));
      assert.ok(lead(fenced(PACKET), packetEnvelope(purpose)).error, `${String(purpose)}: a fence is still refused`);
    }
    // Review stays raw-only. (Lead adjudication stayed raw-only here too; O5.5B22 later gave it the same narrow envelope.)
    for (const request of [{ kind: "review", limits: { maxFindings: 5 } }] as unknown as StructuredTurnRequest[])
      assert.equal(structuredEnvelope(request).policy, "rawOnly", `${request.kind} stays raw-only`);
    const proposal: ChangeProposalRequest = { kind: "changeProposal", packet: {} as DelegationPacket };
    assert.equal(structuredEnvelope(proposal).policy, "rawOrSingleJsonFence", "the Change Author keeps its O5.5B10 envelope");
    const claude = transportProfile("claude", "claude-one-shot")!;
    assert.deepEqual([claude.changeProposalEnvelope, claude.leadPlanEnvelope], ["rawOrSingleJsonFence", "rawOrSingleJsonFence"]);
    // Muse is untouched: its profiles stay raw-only and its packet reader still refuses any fence.
    assert.deepEqual([transportProfile("muse", "muse-exec")!.leadPlanEnvelope, transportProfile("muse", "muse-msp")!.leadPlanEnvelope,
      transportProfile("muse", "muse-exec")!.changeProposalEnvelope], ["rawOnly", "rawOnly", "rawOnly"]);
    assert.deepEqual(parsePacket(RAW), PACKET);
    assert.throws(() => parsePacket(fenced(PACKET)), /invalid structured JSON/u);
  });

test("O5.5B18 transport (fake binary): a fenced plan completes for the Lead's plan purpose and is still refused for a delegate turn", async () => {
  const fixture = resolve(process.cwd(), "test/fixtures/claude-fake.mjs");
  const config = (output: string): ClaudeLaunchConfig => ({ executablePath: "unused", workspace: process.cwd(), model: { id: "alias", effort: "low", maxTurns: 6 },
    expectedCanonicalModel: "claude-canonical-fixture", posture: "readOnly", timeoutMs: 8_000,
    sourceEnvironment: { FUSION_FAKE_SCENARIO: "ok", FUSION_FAKE_OUTPUT: output, FUSION_FAKE_EXPECT_MAX_TURNS: "6", SystemRoot: process.env.SystemRoot,
      USERPROFILE: resolve(process.cwd(), "test/fixtures/empty-claude-home") } });
  const packet: DelegationPacket = { task: { goal: "line 1\n& | $() ü ☃", constraints: [], acceptanceCriteria: [] },
    scope: { relevantFiles: [], allowedFiles: [], forbiddenFiles: [] }, architecture: { decisions: [], invariants: [] },
    verification: { requiredTests: [] }, openQuestions: [] };
  const caps = { structuredOutput: true, webToolsDisabled: true } as const;
  const planTurn = new ClaudeOneShotTransport(config(fenced(PACKET)), undefined, { executable: process.execPath, argvPrefix: [fixture] });
  const planned = await planTurn.run({ packet, requiredCapabilities: caps, purpose: "plan" });
  assert.equal(planned.status, "completed", JSON.stringify(planned.error));
  assert.deepEqual([planTurn.structuredOutputDiagnostic?.classification, planTurn.structuredOutputDiagnostic?.accepted,
    planTurn.terminalDiagnostic?.classification, planTurn.terminalDiagnostic?.schemaValidationReached], ["SINGLE_FENCED_VALID_JSON", true, "RESULT_OK", true]);
  const delegateTurn = new ClaudeOneShotTransport(config(fenced(PACKET)), undefined, { executable: process.execPath, argvPrefix: [fixture] });
  const delegated = await delegateTurn.run({ packet, requiredCapabilities: caps, purpose: "delegate" });
  assert.equal(delegated.status, "failed");
  if (delegated.status === "failed") assert.equal(delegated.error.safeMessage, "Claude structured output was refused: SINGLE_FENCED_VALID_JSON under the rawOnly envelope.");
});

test("O5.5B18 regression: the exact O5.5B17 shape (a successful Lead turn replying with one fenced ResultPacket) now passes the Lead envelope and contract — offline only",
  { skip }, async () => withInstalls(async i => withRoot(async dir => {
    const leadOnly = testRouteAuthorization(i, { turns: ROUTE_REHEARSAL_PROFILES.authorizations["O5.5B17-LEAD"]!.turns });
    const run = asRun(await runRoute(i, dir, "b17-shape", { Lead: [{ prefix: PREFIX.plan, output: fenced(JSON.parse(plan())), resultFrame: { num_turns: 6 } }] },
      { authorization: leadOnly }));
    assert.deepEqual([run.report.outcome, run.report.detail], ["TURN_REFUSED",
      "a role turn was refused before it reached the provider: the Worker role has no authorized turn in this authorization"],
    "the Lead plan passes; the Lead-only budget then stops the route before the Worker");
    const [turn] = sectionOf<Array<{ outcome: string; contract: string; structuredOutput: Record<string, unknown> | null;
      terminal: Record<string, unknown> }>>(run, "turns");
    assert.deepEqual([turn!.outcome, turn!.contract], ["completed", "accepted"]);
    assert.deepEqual([turn!.structuredOutput?.classification, turn!.structuredOutput?.accepted, turn!.structuredOutput?.policy,
      turn!.structuredOutput?.bodyMatchesExpectedSchema], ["SINGLE_FENCED_VALID_JSON", true, "rawOrSingleJsonFence", true]);
    assert.deepEqual([turn!.terminal.classification, turn!.terminal.internalTurnCount, turn!.terminal.structuredParsingReached,
      turn!.terminal.schemaValidationReached, turn!.terminal.processExitCode], ["RESULT_OK", 6, true, true, 0]);
    const model = sectionOf<Array<{ purpose: string; args: string[] }>>(run, "launches").find(l => l.purpose === "providerTurn")!;
    assert.deepEqual([model.args[model.args.indexOf("--max-turns") + 1], model.args[model.args.indexOf("--model") + 1],
      model.args[model.args.indexOf("--effort") + 1]], ["6", "haiku", "low"], "no model, effort or limit change");
    assert.equal(run.report.evidence.evidenceKind, "offlineRehearsal", "a replay is never live evidence");
  })));

test("O5.5B18 readiness: no offline replay is live evidence; the live Lead contract has never passed; nothing is open", () => {
  assert.deepEqual(leadPlanLiveRecords().slice(0, 2).map(r => [r.milestone, r.outcome, r.modelTurn]), [["O5.5B15", "FAIL", "FAIL"], ["O5.5B17", "FAIL", "PASS"]]);
  assert.deepEqual([fullRouteLiveCoverage().attempts >= 1, fullRouteLiveRecords().filter(r => r.milestone !== "O5.5B27").some(r => r.outcome === "PASS")], [true, false]);
  const report = writerGateReport();
  const rows = Object.fromEntries(report.rows.map(row => [row.id, [row.state, row.evidenceKind]]));
  assert.deepEqual([rows.fullRouteLive, rows.hostControlledWriterWorkflow, rows.providerChangeProposal, rows.liveGateAuthorization],
    [["partial", "recordedLiveProbe"], ["partial", "recordedLiveProbe"], ["satisfied", "recordedLiveProbe"], ["blocked", "none"]]);
  for (const input of ["CLAUDE_LEAD_ENVELOPE_IMPLEMENTATION: READY", { leadPlanLive: "PASS" }])
    assert.deepEqual(writerGateReport({ linuxVerification: input }), report);
  assert.deepEqual([report.realWriterModeReady, REAL_WRITER_LIVE_GATE_AUTHORIZED], [false, false]);
  // Only the later O5.5B19 contract retest may be open (its own tests cover it).
  assert.ok(Object.entries(ROUTE_REHEARSAL_PROFILES.authorizations).every(([id, entry]) => ["O5.5B19-LEAD", "O5.5B21-LEAD", "O5.5B25-LIVE", "O5.5B27-LIVE"].includes(id) || entry.state !== "open"),
    "no other live route authorization is open");
  assert.ok(Object.values(PROPOSAL_PROBE_PROFILES.authorizations).every(entry => entry.state === "consumed"));
});
