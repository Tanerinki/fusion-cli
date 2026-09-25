import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport, writerReadiness } from "../src/app/writer-gate.js";
import type { ChangeProposalRequest, DelegationPacket } from "../src/core/domain.js";
import { structuredTurnPrompt } from "../src/core/review/contract.js";
import { LEAD_PLAN_INSTRUCTION, packetTurnInstruction } from "../src/core/workflow/lead-plan.js";
import { CLAUDE_PROPOSAL_REPLY_RULE, claudeStructuredPrompt, packetPrompt } from "../src/providers/claude/one-shot-transport.js";
import { RESULT_PACKET_SCHEMA, renderPrompt } from "../src/providers/muse/structured-output.js";
import { PROPOSAL_PROBE_PROFILES, ROUTE_REHEARSAL_PROFILES } from "../src/providers/probe-profiles.js";
import { fullRouteLiveCoverage, isValidatedRuntimeVersion, leadPlanLiveRecords } from "../src/runtime/provider-profiles.js";
import { withRoot } from "./fixtures/probe-harness.js";
import { withInstalls } from "./fixtures/provider-installs.js";
import { adjudication, asRun, cleanReview, plan, PREFIX, proposal, reviewWith, runRoute, sectionOf,
  testRouteAuthorization } from "./fixtures/route-harness.js";
import { FIX, FIX_ONLY, gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5B16 — the planning Lead's prompt contract, offline. Only the Lead's plan turn changes its opening instruction; the
 * reply contract (ResultPacket shape and reply rules), every other packet turn, the Change Author, Reviewer and
 * adjudication prompts, `--max-turns 6` and the bindings stay exactly as they were. Fake processes prove plumbing only.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const packet: DelegationPacket = { task: { goal: "Fix quote totals.", constraints: ["Keep the public API."], acceptanceCriteria: ["Tests pass."] },
  scope: { relevantFiles: ["src/quote.ts"], allowedFiles: ["src/quote.ts"], forbiddenFiles: ["package.json"] },
  architecture: { decisions: [], invariants: ["Money stays integer cents."] }, verification: { requiredTests: ["unit"] }, openQuestions: [] };
const GENERIC_CLAUDE = "Complete this delegated task within its scope.";
const GENERIC_MUSE = "Complete the delegated task within its scope.";
/** The pre-O5.5B16 Claude packet prompt, verbatim. */
const OLD_CLAUDE = (p: DelegationPacket) => `${GENERIC_CLAUDE} Your entire response must be one raw JSON object, with no Markdown fence, commentary, or text before or after it. Use exactly this shape: {"result":{"status":"completed"},"changes":{"files":[],"summary":""},"verification":{"testsRun":[],"results":[]},"uncertainties":[],"failures":[],"needsLeadDecision":[]}. Change field values to report the actual outcome; model-reported checks are claims only.\nDelegation:\n${JSON.stringify(p)}`;
/** The pre-O5.5B16 Muse packet prompt, verbatim. */
const OLD_MUSE = (p: DelegationPacket) => `${GENERIC_MUSE} Return exactly one JSON ResultPacket matching this schema. Model-reported checks are claims only.\nSchema:\n${JSON.stringify(RESULT_PACKET_SCHEMA)}\nDelegation:\n${JSON.stringify(p)}`;

test("O5.5B16 the planning Lead's instruction: plan, do not implement or modify files, inspect only enough, stop and answer, claim no tests", () => {
  const prompt = packetPrompt(packet, "plan");
  for (const phrase of ["You are the planning Lead for this delegated task.",
    "Do not implement the task: do not modify, create or delete any file, and do not attempt to complete the delegated implementation yourself.",
    "A separate Change Author implements it from your plan; Fusion then validates, applies and verifies that change.",
    "Inspect only enough repository context to produce the plan", "the relevant files and modules", "the behaviour changes required",
    "the architecture and security invariants to preserve", "the acceptance criteria and how they will be verified", "the risks and constraints",
    "Stop exploring as soon as you can produce the plan, and answer.",
    "the concise plan in changes.summary", "set result.status to completed when the plan is ready",
    "Run no tests and report none", "only Fusion's own evidence counts"])
    assert.ok(prompt.includes(phrase), phrase);
  assert.ok(prompt.startsWith(LEAD_PLAN_INSTRUCTION));
  assert.ok(!prompt.includes(GENERIC_CLAUDE), "the generic delegated-task wording is gone from the Lead plan");
  assert.ok(!renderPrompt(packet, "plan").includes(GENERIC_MUSE) && renderPrompt(packet, "plan").startsWith(LEAD_PLAN_INSTRUCTION),
    "the same provider-neutral contract for any Lead family");
  assert.doesNotMatch(LEAD_PLAN_INSTRUCTION, /claude|muse|anthropic|\bmeta\b|haiku|spark/iu, "provider-neutral");
});

test("O5.5B16 only the instruction changes: the reply contract (raw JSON, ResultPacket shape, delegation) is byte-identical", () => {
  // The Lead plan prompt is the old prompt with only its first sentence replaced.
  assert.equal(packetPrompt(packet, "plan"), `${LEAD_PLAN_INSTRUCTION}${OLD_CLAUDE(packet).slice(GENERIC_CLAUDE.length)}`);
  assert.equal(renderPrompt(packet, "plan"), `${LEAD_PLAN_INSTRUCTION}${OLD_MUSE(packet).slice(GENERIC_MUSE.length)}`);
  assert.ok(packetPrompt(packet, "plan").includes(`Use exactly this shape: {"result":{"status":"completed"},"changes":{"files":[],"summary":""},` +
    `"verification":{"testsRun":[],"results":[]},"uncertainties":[],"failures":[],"needsLeadDecision":[]}.`), "the existing structured contract");
  // Every other packet turn keeps its exact previous prompt.
  for (const purpose of [undefined, "delegate", "exploration", "leadReview"] as const) {
    assert.equal(packetTurnInstruction(purpose), undefined, String(purpose));
    assert.equal(packetPrompt(packet, purpose), OLD_CLAUDE(packet), `Claude ${String(purpose)}`);
    assert.equal(renderPrompt(packet, purpose), OLD_MUSE(packet), `Muse ${String(purpose)}`);
  }
});

test("O5.5B16 the Change Author keeps its implementation-oriented structured prompt; it never receives the planning contract", () => {
  const request: ChangeProposalRequest = { kind: "changeProposal", packet };
  const prompt = claudeStructuredPrompt(request);
  assert.equal(prompt, `${structuredTurnPrompt(request)}\n${CLAUDE_PROPOSAL_REPLY_RULE}`, "still the unchanged structured contract + reply rule");
  assert.ok(prompt.startsWith("Fusion change proposal. You are a read-only Change Author."));
  assert.ok(prompt.includes("Propose complete final text for each file; Fusion validates and applies it."), "implementation-oriented");
  assert.ok(!prompt.includes(LEAD_PLAN_INSTRUCTION) && !prompt.includes("planning Lead"));
  // Pinned bytes of the change-proposal prompt for this packet. Unchanged from O5.5B11 to O5.5B25 (230563d7…fc6a); O5.5B26
  // deliberately restated only the Claude reply rule (the Change Author's output discipline); the neutral part is unchanged.
  assert.equal(createHash("sha256").update(prompt).digest("hex"), CHANGE_PROPOSAL_SHA256);
});
const CHANGE_PROPOSAL_SHA256 = "6fcd94abd6ccc8bd5a1fc1de2d96bbca623a9dafe17206605db913d70f21625d";

test("O5.5B16 bindings unchanged: the Lead keeps --max-turns 6, Claude Code 2.1.280, haiku / claude-haiku-4-5-20251001, effort low", () => {
  for (const id of ["O5.5B13-LIVE", "O5.5B15-LEAD"]) {
    const lead = ROUTE_REHEARSAL_PROFILES.authorizations[id]!.roles.Lead;
    assert.deepEqual([lead.binding.maxTurns, lead.turnArgs, lead.runtimeVersions, lead.binding.model, lead.binding.effort,
      lead.binding.options?.canonicalModel], [6, [["--model", "haiku"], ["--effort", "low"], ["--max-turns", "6"]], ["2.1.280"], "haiku", "low",
      "claude-haiku-4-5-20251001"], id);
  }
  assert.equal(isValidatedRuntimeVersion("claude", "claude-one-shot", "2.1.280"), true);
  assert.equal(isValidatedRuntimeVersion("claude", "claude-one-shot", "2.1.281"), false);
});

test("O5.5B16 fake Lead RESULT_OK within the same six-turn limit: the planning prompt reaches the provider, the plan parses and is accepted",
  { skip }, async () => withInstalls(async i => withRoot(async dir => {
    const leadOnly = testRouteAuthorization(i, { turns: ROUTE_REHEARSAL_PROFILES.authorizations["O5.5B15-LEAD"]!.turns });
    const summary = "Plan: in src/quote.ts tax the discounted subtotal; add a full-discount regression test in test/quote.test.ts.";
    const run = asRun(await runRoute(i, dir, "plan-ok", { Lead: [{ prefix: PREFIX.plan, output: plan(summary), excludes: [GENERIC_CLAUDE],
      resultFrame: { num_turns: 4, permission_denials: [] } }] }, { authorization: leadOnly }));
    const [turn] = sectionOf<Array<{ outcome: string; contract: string; terminal: Record<string, unknown> }>>(run, "turns");
    assert.deepEqual([turn!.outcome, turn!.contract], ["completed", "accepted"]);
    assert.deepEqual([turn!.terminal.classification, turn!.terminal.internalTurnCount, turn!.terminal.structuredParsingReached,
      turn!.terminal.schemaValidationReached], ["RESULT_OK", 4, true, true]);
    const model = sectionOf<Array<{ purpose: string; args: string[] }>>(run, "launches").find(l => l.purpose === "providerTurn")!;
    assert.equal(model.args[model.args.indexOf("--max-turns") + 1], "6", "the limit is unchanged");
    assert.ok(run.prompts.Lead[0]!.startsWith(LEAD_PLAN_INSTRUCTION), "the fake received the planning contract");
    assert.ok(run.prompts.Lead[0]!.includes(JSON.stringify("Fix quote totals: tax applies to the discounted subtotal. Add a regression test.")),
      "the delegation itself is unchanged");
  })));

test("O5.5B16 fake RESULT_ERROR_MAX_TURNS is still classified exactly; nothing after the Lead", { skip }, async () => withInstalls(async i => withRoot(async dir => {
  const leadOnly = testRouteAuthorization(i, { turns: ROUTE_REHEARSAL_PROFILES.authorizations["O5.5B15-LEAD"]!.turns });
  const run = asRun(await runRoute(i, dir, "plan-max", { Lead: [{ prefix: PREFIX.plan, exitCode: 1, resultFrame: { subtype: "error_max_turns",
    is_error: true, terminal_reason: "max_turns", num_turns: 7, permission_denials: [], errors: ["x"], result: "__absent__" } }] }, { authorization: leadOnly }));
  assert.deepEqual([run.report.outcome, run.report.detail], ["PROVIDER_FAILED", "leadPlan #1 (Lead): providerFailure: Claude reported a failed turn."]);
  const [turn] = sectionOf<Array<{ terminal: Record<string, unknown> }>>(run, "turns");
  assert.deepEqual([turn!.terminal.classification, turn!.terminal.internalTurnCount, turn!.terminal.structuredParsingReached],
    ["RESULT_ERROR_MAX_TURNS", 7, false]);
  assert.equal(run.prompts.Worker.length + run.prompts.Reviewer.length, 0);
})));

test("O5.5B16 full route (fake): only the Lead's plan takes the planning contract; Change Author, Reviewer and adjudication prompts keep theirs",
  { skip }, async () => withInstalls(async i => withRoot(async dir => {
    const run = asRun(await runRoute(i, dir, "route", {
      Lead: [{ prefix: PREFIX.plan, output: plan() }, { prefix: PREFIX.adjudication, output: adjudication(["r1-F1", "CONFIRMED", "fix"]) }],
      Worker: [proposal(FIX_ONLY), proposal(FIX)],
      Reviewer: [{ prefix: PREFIX.review, output: reviewWith({ id: "F1", severity: "HIGH" }) }, { prefix: PREFIX.review, output: cleanReview }],
    }));
    assert.equal(run.report.outcome, "PASS", run.report.detail);
    assert.deepEqual(run.prompts.Lead.map(p => p.startsWith(LEAD_PLAN_INSTRUCTION)), [true, false], "plan: planning contract; adjudication: its own");
    assert.ok(run.prompts.Lead[1]!.startsWith("Fusion adjudication."));
    assert.ok(run.prompts.Worker.every(p => p.startsWith("Fusion change proposal. You are a read-only Change Author.")));
    assert.ok(run.prompts.Worker[0]!.includes("Lead plan: "), "the accepted plan is forwarded to the Change Author as before");
    assert.ok(run.prompts.Reviewer.every(p => p.startsWith("Fusion fresh review.")));
    for (const p of [...run.prompts.Lead.slice(1), ...run.prompts.Worker, ...run.prompts.Reviewer])
      assert.ok(!p.includes("planning Lead"), "no other role receives the planning contract");
  })));

test("O5.5B16 readiness: offline prompt work moves nothing — the live Lead result stays FAIL, no row or gate moves, nothing is open", () => {
  // History: O5.5B15 (and the later O5.5B17 retest, recorded in its own milestone). Offline prompt work adds nothing.
  assert.deepEqual(leadPlanLiveRecords().map(r => [r.milestone, r.outcome, r.terminal.classification])[0], ["O5.5B15", "FAIL", "RESULT_ERROR_MAX_TURNS"]);
  // As of this milestone no Lead contract had passed live (the later O5.5B21 retest is recorded in its own milestone).
  assert.ok(leadPlanLiveRecords().filter(r => r.milestone === "O5.5B15").every(r => r.outcome === "FAIL"));
  assert.deepEqual([fullRouteLiveCoverage().attempts >= 1, fullRouteLiveCoverage().passed], [true, 0]);
  const report = writerGateReport();
  const rows = Object.fromEntries(report.rows.map(row => [row.id, [row.state, row.evidenceKind]]));
  assert.deepEqual([rows.fullRouteLive, rows.hostControlledWriterWorkflow, rows.providerChangeProposal, rows.liveGateAuthorization],
    [["blocked", "recordedLiveProbe"], ["partial", "fakeProviderRehearsal"], ["satisfied", "recordedLiveProbe"], ["blocked", "none"]]);
  for (const input of ["LEAD_PLANNING_PROMPT_IMPLEMENTATION: READY", { leadPlanLive: "PASS" }])
    assert.deepEqual(writerGateReport({ linuxVerification: input }), report);
  assert.deepEqual([report.realWriterModeReady, REAL_WRITER_LIVE_GATE_AUTHORIZED, writerReadiness().ready], [false, false, false]);
  // Only a later Lead retest (O5.5B17, O5.5B19) may be open; their own tests cover them.
  assert.ok(Object.entries(ROUTE_REHEARSAL_PROFILES.authorizations).every(([id, entry]) => ["O5.5B17-LEAD", "O5.5B19-LEAD", "O5.5B21-LEAD", "O5.5B25-LIVE"].includes(id) || entry.state !== "open"),
    "no other live route authorization is open");
  assert.ok(Object.values(PROPOSAL_PROBE_PROFILES.authorizations).every(entry => entry.state === "consumed"));
});
