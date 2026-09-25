import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import type { DelegationPacket } from "../src/core/domain.js";
import type { ProcessOutcome } from "../src/platform/process/supervisor.js";
import { terminalOnlyDiagnostic, TURN_TERMINAL_CLASSES, type TurnTerminalDiagnostic } from "../src/platform/process/terminal-diagnostic.js";
import { ClaudeOneShotTransport } from "../src/providers/claude/one-shot-transport.js";
import { CLAUDE_RESULT_SUBTYPES, CLAUDE_TERMINAL_REASONS, claudeTerminalDiagnostic } from "../src/providers/claude/parsing/terminal.js";
import type { ClaudeLaunchConfig } from "../src/providers/claude/types.js";

/**
 * O5.5B14 — the bounded terminal diagnostic of a Claude model turn, through the REAL one-shot transport against the
 * deterministic fake binary (result frames in the pinned runtime's result schema), plus the pure mapper and the
 * provider-neutral re-validation. No provider is ever reached.
 */
const fixture = resolve(process.cwd(), "test/fixtures/claude-fake.mjs");
const fixtureBinary = { executable: process.execPath, argvPrefix: [fixture] } as const;
// The fake checks that the packet prompt carries this exact goal text (its stdin fidelity probe).
const packet: DelegationPacket = { task: { goal: "line 1\n& | $() ü ☃", constraints: [], acceptanceCriteria: [] },
  scope: { relevantFiles: [], allowedFiles: [], forbiddenFiles: [] }, architecture: { decisions: [], invariants: [] },
  verification: { requiredTests: [] }, openQuestions: [] };
const CANARY = "PROVIDER-TEXT-CANARY-9f3e";
const PACKET_TEXT = JSON.stringify({ result: { status: "completed" }, changes: { files: [], summary: "fixture" },
  verification: { testsRun: [], results: [] }, uncertainties: [], failures: [], needsLeadDecision: [] });
const KEYS = ["schemaVersion", "classification", "resultSubtype", "terminalReason", "isError", "internalTurnCount", "permissionDenialCount",
  "errorEntryCount", "resultTextPresent", "resultTextByteLength", "apiErrorStatusClass", "structuredParsingReached", "schemaValidationReached",
  "processExitCode", "processSignal", "fusionTermination", "timedOut", "cancelled"];

function config(scenario: string, env: Readonly<Record<string, string>> = {}): ClaudeLaunchConfig {
  return { executablePath: "unused", workspace: process.cwd(), model: { id: "alias", effort: "low", maxTurns: 6 },
    expectedCanonicalModel: "claude-canonical-fixture", posture: "readOnly", timeoutMs: 8_000,
    sourceEnvironment: { FUSION_FAKE_SCENARIO: scenario, SystemRoot: process.env.SystemRoot,
      USERPROFILE: resolve(process.cwd(), "test/fixtures/empty-claude-home"), FUSION_FAKE_EXPECT_MAX_TURNS: "6", ...env } };
}
/** One packet turn through the real transport; the diagnostic and the turn result. */
async function turn(scenario: string, frame?: Readonly<Record<string, unknown>>, options: Readonly<{ exit?: number; timeoutMs?: number;
  cancelAfterLaunchMs?: number }> = {}) {
  const controller = new AbortController();
  const env = { ...(frame ? { FUSION_FAKE_RESULT: JSON.stringify(frame) } : {}), ...(options.exit === undefined ? {} : { FUSION_FAKE_EXIT: String(options.exit) }) };
  const t = new ClaudeOneShotTransport({ ...config(scenario, env), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    // Cancel only once the model process itself has started, never during preflight.
    ...(options.cancelAfterLaunchMs === undefined ? {} : { launchObserver: record => {
      if (record.purpose === "providerTurn") setTimeout(() => controller.abort(), options.cancelAfterLaunchMs); } }) },
    undefined, fixtureBinary);
  const result = await t.run({ packet, requiredCapabilities: { structuredOutput: true, webToolsDisabled: true,
    filesystem: { read: true, write: false }, shell: { available: false }, modelIdentityReadback: true, subscriptionLaneReadback: true },
    ...(options.cancelAfterLaunchMs === undefined ? {} : { signal: controller.signal }) });
  const diagnostic = t.terminalDiagnostic;
  assert.ok(diagnostic !== undefined, `${scenario}: a diagnostic for every started model process`);
  assertBounded(diagnostic);
  return { result, diagnostic };
}
function assertBounded(diagnostic: TurnTerminalDiagnostic): void {
  assert.deepEqual(Object.keys(diagnostic), KEYS);
  assert.ok(Object.isFrozen(diagnostic));
  assert.deepEqual(terminalOnlyDiagnostic(diagnostic), diagnostic, "every diagnostic the transport reports re-validates unchanged");
  const text = JSON.stringify(diagnostic);
  for (const secret of [CANARY, "Reached maximum", "private", "fixture", "Delegation", "line 1"]) assert.ok(!text.includes(secret), secret);
}
const pick = (d: TurnTerminalDiagnostic, ...keys: Array<keyof TurnTerminalDiagnostic>) => keys.map(key => d[key]);

test("O5.5B14 success: RESULT_OK with the reply read and parsed; counts and the text's byte length, never the text", async () => {
  const { result, diagnostic } = await turn("ok", { num_turns: 2, permission_denials: [] });
  assert.equal(result.status, "completed");
  assert.deepEqual(diagnostic, { schemaVersion: 1, classification: "RESULT_OK", resultSubtype: "success", terminalReason: "completed", isError: false,
    internalTurnCount: 2, permissionDenialCount: 0, errorEntryCount: null, resultTextPresent: true,
    resultTextByteLength: Buffer.byteLength(PACKET_TEXT, "utf8"), apiErrorStatusClass: "none", structuredParsingReached: true,
    schemaValidationReached: true, processExitCode: 0, processSignal: null, fusionTermination: null, timedOut: false, cancelled: false });
});

test("O5.5B14 error_max_turns and error_during_execution: named classes; the failure message and outcome contract are unchanged", async () => {
  const errors = [`Reached maximum number of turns (6) ${CANARY}`];
  const maxTurns = await turn("ok", { subtype: "error_max_turns", is_error: true, terminal_reason: "max_turns", num_turns: 7, errors,
    permission_denials: [], result: "__absent__" }, { exit: 1 });
  assert.equal(maxTurns.result.status, "failed");
  if (maxTurns.result.status === "failed") assert.deepEqual([maxTurns.result.error.kind, maxTurns.result.error.safeMessage],
    ["ProcessFailure", "Claude reported a failed turn."]);
  assert.deepEqual(pick(maxTurns.diagnostic, "classification", "resultSubtype", "terminalReason", "isError", "internalTurnCount", "errorEntryCount",
    "resultTextPresent", "resultTextByteLength", "structuredParsingReached", "schemaValidationReached", "processExitCode"),
  ["RESULT_ERROR_MAX_TURNS", "error_max_turns", "max_turns", true, 7, 1, false, 0, false, false, 1]);
  const execution = await turn("ok", { subtype: "error_during_execution", is_error: true, terminal_reason: "model_error", num_turns: 3,
    errors: [CANARY], result: "__absent__" }, { exit: 1 });
  assert.deepEqual(pick(execution.diagnostic, "classification", "resultSubtype", "terminalReason", "internalTurnCount", "errorEntryCount"),
    ["RESULT_ERROR_DURING_EXECUTION", "error_during_execution", "model_error", 3, 1]);
});

test("O5.5B14 is_error, another subtype, a non-completed terminal reason and a missing error flag are each distinguished", async () => {
  const isError = await turn("ok", { is_error: true, terminal_reason: "api_error", api_error_status: 529, result: CANARY });
  assert.deepEqual(pick(isError.diagnostic, "classification", "resultSubtype", "terminalReason", "isError", "apiErrorStatusClass", "resultTextPresent",
    "structuredParsingReached"), ["RESULT_IS_ERROR", "success", "api_error", true, "5xx", true, false]);
  const budget = await turn("ok", { subtype: "error_max_budget_usd", is_error: true, terminal_reason: "budget_exhausted", result: "__absent__" });
  assert.deepEqual(pick(budget.diagnostic, "classification", "resultSubtype", "terminalReason"),
    ["RESULT_OTHER_SEMANTIC_ERROR", "error_max_budget_usd", "budget_exhausted"]);
  const stopped = await turn("ok", { terminal_reason: "hook_stopped", api_error_status: 400 });
  assert.deepEqual(pick(stopped.diagnostic, "classification", "terminalReason", "isError", "apiErrorStatusClass"),
    ["RESULT_TERMINAL_NOT_COMPLETED", "hook_stopped", false, "4xx"]);
  // Without an explicit `is_error: false` the transport still refuses the reply; the diagnostic says why.
  const flagless = await turn("ok", { is_error: "__absent__" });
  assert.equal(flagless.result.status, "failed");
  assert.deepEqual(pick(flagless.diagnostic, "classification", "isError", "structuredParsingReached"), ["RESULT_OTHER_SEMANTIC_ERROR", null, false]);
});

test("O5.5B14 unknown subtype or terminal reason maps to a bounded `other`; bad counts are null, never guessed", async () => {
  const unknown = await turn("ok", { subtype: "error_new_future_variant", terminal_reason: "future_reason", is_error: true,
    num_turns: "4", permission_denials: "none", errors: [] });
  assert.deepEqual(pick(unknown.diagnostic, "classification", "resultSubtype", "terminalReason", "internalTurnCount", "permissionDenialCount",
    "errorEntryCount"), ["RESULT_OTHER_SEMANTIC_ERROR", "other", "other", null, null, 0]);
  const prose = await turn("ok", { terminal_reason: `completed because ${CANARY}`, num_turns: -1 });
  assert.deepEqual(pick(prose.diagnostic, "classification", "terminalReason", "internalTurnCount"), ["RESULT_TERMINAL_NOT_COMPLETED", "other", null]);
  assert.deepEqual([CLAUDE_RESULT_SUBTYPES.length, CLAUDE_TERMINAL_REASONS.length], [5, 19]);
  assert.ok(CLAUDE_TERMINAL_REASONS.includes("max_turns") && CLAUDE_TERMINAL_REASONS.includes("completed"));
});

test("O5.5B14 permission denials and error entries are counted; their tools, inputs and texts never leave", async () => {
  const denials = [{ tool_name: "Write", tool_use_id: "toolu_private_1", tool_input: { file_path: `C:/secret/${CANARY}`, content: CANARY } },
    { tool_name: "Bash", tool_use_id: "toolu_private_2", tool_input: { command: `echo ${CANARY}` } }];
  const { diagnostic } = await turn("ok", { permission_denials: denials, num_turns: 5 });
  assert.deepEqual(pick(diagnostic, "permissionDenialCount", "internalTurnCount"), [2, 5]);
  assert.ok(!JSON.stringify(diagnostic).includes("toolu_private") && !JSON.stringify(diagnostic).includes("Write"));
});

test("O5.5B14 result text: presence and the exact UTF-8 byte length are recorded; the content never is", async () => {
  const text = `ü☃ ${CANARY} 𝄞`;
  const { result, diagnostic } = await turn("ok", { result: text });
  assert.equal(result.status, "failed", "not a packet: refused as before");
  assert.deepEqual(pick(diagnostic, "resultTextPresent", "resultTextByteLength", "structuredParsingReached", "schemaValidationReached"),
    [true, Buffer.byteLength(text, "utf8"), true, false]);
  assert.notEqual(Buffer.byteLength(text, "utf8"), text.length, "bytes, not UTF-16 units");
  const empty = await turn("ok", { result: "" });
  assert.deepEqual(pick(empty.diagnostic, "resultTextPresent", "resultTextByteLength"), [false, 0]);
  // Parsed JSON that is not a ResultPacket: parsing and the schema check were reached.
  const shape = await turn("extra-packet");
  assert.equal(shape.result.status, "failed");
  assert.deepEqual(pick(shape.diagnostic, "classification", "structuredParsingReached", "schemaValidationReached"), ["RESULT_OK", true, true]);
});

test("O5.5B14 no result frame, a malformed stream, a timeout and a cancellation keep their existing failures and are classified", async () => {
  const missing = await turn("missing-result");
  assert.equal(missing.result.status, "failed");
  if (missing.result.status === "failed") assert.equal(missing.result.error.safeMessage, "Claude ended without initialization and result evidence.");
  assert.deepEqual(pick(missing.diagnostic, "classification", "resultSubtype", "terminalReason", "apiErrorStatusClass", "processExitCode"),
    ["MISSING_RESULT", "missing", "missing", "unknown", 0]);
  const malformed = await turn("malformed");
  assert.equal(malformed.result.status, "failed");
  if (malformed.result.status === "failed") assert.equal(malformed.result.error.kind, "ProtocolError", "the existing malformed-stream path");
  assert.equal(malformed.diagnostic.classification, "MALFORMED_STREAM");
  const timeout = await turn("timeout", undefined, { timeoutMs: 3_000 });
  if (timeout.result.status === "failed") assert.equal(timeout.result.error.kind, "Timeout");
  assert.deepEqual(pick(timeout.diagnostic, "classification", "timedOut", "cancelled", "fusionTermination"), ["TIMEOUT", true, false, "timeout"]);
  const cancelled = await turn("cancel", undefined, { cancelAfterLaunchMs: 300 });
  assert.equal(cancelled.result.status, "cancelled");
  assert.deepEqual(pick(cancelled.diagnostic, "classification", "cancelled", "timedOut"), ["CANCELLED", true, false]);
});

test("O5.5B14 precedence: Fusion's observations first, then subtype, error flag, terminal reason — one class, deterministically", () => {
  const outcome = (patch: Partial<ProcessOutcome> = {}): ProcessOutcome => ({ executable: "x", args: [], cwd: ".", pid: 1, startedAt: "", endedAt: "",
    durationMs: 1, exitCode: 0, signal: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false,
    stdinWriteStatus: "acceptedByPipe", observerIssues: [], ...patch });
  const facts = (result?: Record<string, unknown>, malformed = false) => ({ malformed, result, parsingReached: false, schemaCheckReached: false });
  const failing = { subtype: "error_max_turns", is_error: true, terminal_reason: "api_error" };
  const of = (...args: Parameters<typeof claudeTerminalDiagnostic>) => claudeTerminalDiagnostic(...args).classification;
  const kill = (reason: "user" | "timeout" | "protocolError" | "outputLimit") => ({ termination: { reason, forced: false, method: "none" as const } });
  assert.equal(of(facts(failing, true), outcome({ issue: { kind: "Cancelled", safeMessage: "" }, ...kill("timeout") }), true), "CANCELLED");
  assert.equal(of(facts(failing, true), outcome(kill("timeout")), true), "TIMEOUT");
  assert.equal(of(facts(failing), outcome(), false), "NOT_STARTED");
  assert.equal(of(facts(undefined), outcome({ issue: { kind: "SpawnFailure", safeMessage: "" }, exitCode: null }), true), "NOT_STARTED");
  assert.equal(of(facts(failing, true), outcome(kill("protocolError")), true), "MALFORMED_STREAM");
  assert.equal(of(facts(failing), outcome({ observerIssues: [{ kind: "ObserverFailure", channel: "stdout", safeMessage: "" }] as never }), true), "MALFORMED_STREAM");
  assert.equal(of(facts(failing), outcome(kill("outputLimit")), true), "STOPPED_BY_FUSION");
  assert.equal(of(facts(undefined), outcome(), true), "MISSING_RESULT");
  assert.equal(of(facts(failing), outcome({ exitCode: 1 }), true), "RESULT_ERROR_MAX_TURNS", "the subtype outranks is_error and terminal_reason");
  assert.equal(of(facts({ subtype: "success", is_error: true, terminal_reason: "hook_stopped" }), outcome(), true), "RESULT_IS_ERROR");
  assert.equal(of(facts({ subtype: "success", is_error: false, terminal_reason: "max_turns" }), outcome(), true), "RESULT_TERMINAL_NOT_COMPLETED");
  assert.equal(of(facts({ subtype: "success", is_error: false, terminal_reason: "completed" }), outcome(), true), "RESULT_OK");
  assert.equal(of(facts({ subtype: "success", is_error: false, terminal_reason: "completed" }), outcome({ exitCode: 3 }), true), "RESULT_OK",
    "the exit code is recorded, not classified: the transport already refuses a non-zero exit");
  assert.deepEqual(TURN_TERMINAL_CLASSES.slice(0, 6), ["CANCELLED", "TIMEOUT", "NOT_STARTED", "MALFORMED_STREAM", "STOPPED_BY_FUSION", "MISSING_RESULT"]);
});

test("O5.5B14 re-validation: an extra key, a text value, a non-integer count or an unknown enum makes the whole diagnostic invalid", () => {
  const good = claudeTerminalDiagnostic({ malformed: false, result: { subtype: "success", is_error: false, terminal_reason: "completed", num_turns: 1 },
    parsingReached: true, schemaCheckReached: true }, undefined, true);
  assert.deepEqual(terminalOnlyDiagnostic(good), good);
  assert.equal(terminalOnlyDiagnostic(undefined), null);
  for (const forged of [{ ...good, detail: CANARY }, { ...good, resultSubtype: `error ${CANARY}` }, { ...good, terminalReason: "Completed" },
    { ...good, internalTurnCount: 1.5 }, { ...good, permissionDenialCount: -1 }, { ...good, classification: "PASS" },
    { ...good, apiErrorStatusClass: "401" }, { ...good, processSignal: "SIGUSR1" }, { ...good, resultTextByteLength: "12" }, [good], CANARY])
    assert.equal(terminalOnlyDiagnostic(forged), "invalid", JSON.stringify(forged).slice(0, 80));
  const { schemaVersion: _unused, ...missingKey } = good;
  assert.equal(terminalOnlyDiagnostic(missingKey), "invalid");
});

test("O5.5B14 a turn that never starts its model process reports no diagnostic, never the previous turn's", async () => {
  const t = new ClaudeOneShotTransport(config("ok"), undefined, fixtureBinary);
  const caps = { structuredOutput: true, webToolsDisabled: true } as const;
  assert.equal((await t.run({ packet, requiredCapabilities: caps })).status, "completed");
  assert.equal(t.terminalDiagnostic?.classification, "RESULT_OK");
  const controller = new AbortController();
  controller.abort();
  assert.equal((await t.run({ packet, requiredCapabilities: caps, signal: controller.signal })).status, "cancelled");
  assert.equal(t.terminalDiagnostic, undefined, "cancelled before launch: no model process, no diagnostic");
});
