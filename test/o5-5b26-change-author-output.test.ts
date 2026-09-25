import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PROBE_BUGGY, PROBE_PACKET, PROBE_TARGET } from "../src/app/proposal-probe.js";
import { ROUTE_PACKET } from "../src/app/route-fixture.js";
import { REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport } from "../src/app/writer-gate.js";
import { validateChangeSet } from "../src/core/change/contract.js";
import type { AdjudicationRequest, ChangeProposalRequest, ReviewRequest } from "../src/core/domain.js";
import { structuredTurnPrompt } from "../src/core/review/contract.js";
import { validateReviewReport } from "../src/core/review/findings.js";
import { reviewEvidence } from "../src/core/review/policy.js";
import { LEAD_PLAN_INSTRUCTION } from "../src/core/workflow/lead-plan.js";
import { CLAUDE_PROPOSAL_REPLY_RULE, claudeProposalReplyRule, claudeStructuredPrompt, packetPrompt, structuredEnvelope } from "../src/providers/claude/one-shot-transport.js";
import { ClaudeStream } from "../src/providers/claude/parsing/stream.js";
import { claudeTerminalDiagnostic } from "../src/providers/claude/parsing/terminal.js";
import { ClaudeFailure } from "../src/providers/claude/types.js";
import { renderPrompt } from "../src/providers/muse/structured-output.js";
import { PROPOSAL_PROBE_PROFILES, REVIEWER_PROBE_PROFILES, ROUTE_REHEARSAL_PROFILES } from "../src/providers/probe-profiles.js";
import { fullRouteLiveRecords, transportProfile } from "../src/runtime/provider-profiles.js";
import { withRoot } from "./fixtures/probe-harness.js";
import { withInstalls } from "./fixtures/provider-installs.js";
import { asRun, cleanReview, fenced, PREFIX, plan, proposal, runRoute, sectionOf } from "./fixtures/route-harness.js";
import { FIX, gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5B26 — the route Change Author's OUTPUT DISCIPLINE (offline). Live (O5.5B25) the Change Author's model turn succeeded
 * but its reply carried text before one schema-matching fenced ChangeSet (EXTRA_TEXT). The fix is instruction-only, in the
 * Claude transport's reply rule; the envelope, the ChangeSet contract and every other prompt are unchanged.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
/** Reference digests taken from the code BEFORE O5.5B26 (HEAD 39138ba) with exactly the requests below. */
const BEFORE = Object.freeze({ neutralProposalPrompt: "2b063280d2e7c82aa6b19913df6705e348b2d6b2f6ff2aa101d7c1bd10016f04",
  reviewPrompt: "400cf57992236d78c2528052a37158e9736996570cdca740fc1240e316d30609",
  adjudicationPrompt: "63e69cf6f1e51a34a78bdd9d656b4b2039455d428b882f20009f25f0e26b64ef",
  leadPlanInstruction: "59d3aed7de0b1d9c5b5c0a1b59b0382311ed05cfce26c4dc6afa9d4daf871387",
  claudeLeadPlanPrompt: "74e6bfe008d79945ae0344d7c05c74a2197ff7c0ebacb191193202f55e449b05",
  museLeadPlanPrompt: "1bcb8b4052f522127da1d60ba6c728646de5ec26bbffbc779146086742eb070a",
  envelopeSource: "964465137f0c6de090edbeeffc269c1055f4171d757b887c06bbd3d6b8650fab",
  oldReplyRule: "Reply format (Fusion checks it mechanically): reply with the raw JSON object alone. The first character of your reply must be { " +
    "and the last must be }. Do not wrap it in a Markdown code fence and add no heading, explanation or any other text before or after it." });

const evidence = reviewEvidence(ROUTE_PACKET, { required: true, passed: true, commands: [{ id: "typecheck", passed: true }, { id: "unit", passed: true }] },
  { kind: "diff", changedPaths: ["src/quote.ts"], text: "diff --git a/src/quote.ts b/src/quote.ts\n-old\n+new\n", truncated: false });
const findings = validateReviewReport({ summary: "One.", findings: [{ id: "F1", severity: "HIGH", confidence: "HIGH", category: "tests", file: "src/quote.ts",
  title: "No regression test", evidence: ["none"], failureScenario: "A refactor breaks it." }] }, { cycle: 1, runId: "run-1", sessionId: "s-1", role: "Reviewer" });
const PROPOSAL: ChangeProposalRequest = { kind: "changeProposal", packet: PROBE_PACKET, baseline: [{ path: PROBE_TARGET, sha256: sha(PROBE_BUGGY) }] };
const REVIEW: ReviewRequest = { kind: "review", cycle: 1, evidence, priorFindings: [], limits: { maxFindings: 5 } };
const ADJUDICATION: AdjudicationRequest = { kind: "adjudication", cycle: 1, evidence, findings,
  fusionFacts: findings.map(f => ({ findingId: f.id, supported: [], contradicted: [] })) };

// The O5.5B11-style ChangeSet (the proposal probe's fix) and the reply shapes around it.
const SCOPE = { allowedPaths: [PROBE_TARGET], forbiddenPaths: [] };
const CHANGESET = { schemaVersion: 1, operations: [{ kind: "writeText", path: PROBE_TARGET, expectedSha256: sha(PROBE_BUGGY),
  content: PROBE_BUGGY.replace("return name.toLowerCase();", "return name.trim().toLowerCase();") }] };
const RAW = JSON.stringify(CHANGESET);
const JSON_FENCE = `\`\`\`json\n${JSON.stringify(CHANGESET, null, 2)}\n\`\`\``;
const BARE_FENCE = `\`\`\`\n${RAW}\n\`\`\``;
const PROSE = "I inspected src/name.js and the test file. The fix trims before lowercasing; here is the proposal:";
function read(text: string) {
  const stream = new ClaudeStream();
  stream.accept({ type: "system", subtype: "init", model: "claude-canonical-fixture" });
  stream.accept({ type: "result", subtype: "success", is_error: false, terminal_reason: "completed", result: text });
  let value: unknown, error: ClaudeFailure | undefined;
  try { value = stream.json(structuredEnvelope(PROPOSAL)); } catch (caught) { if (caught instanceof ClaudeFailure) error = caught; else throw caught; }
  return { value, error, diagnostic: stream.outputDiagnostic!, terminal: claudeTerminalDiagnostic(stream.terminalFacts(), undefined, true) };
}
const accepted = (text: string, classification: string, label: string) => {
  const r = read(text);
  assert.equal(r.error, undefined, `${label}: ${r.error?.error.safeMessage}`);
  assert.equal(r.diagnostic.classification, classification, label);
  assert.deepEqual(validateChangeSet(r.value, SCOPE).operations.map(op => op.path), [PROBE_TARGET], `${label}: the unchanged ChangeSet contract passes`);
};
const refused = (text: string, classification: string, label: string, location?: string) => {
  const r = read(text);
  assert.equal(r.error?.error.safeMessage, `Claude structured output was refused: ${classification} under the rawOrSingleJsonFence envelope.`, label);
  assert.deepEqual([r.diagnostic.classification, r.diagnostic.accepted], [classification, false], label);
  if (location !== undefined) assert.equal(r.diagnostic.extraTextLocation, location, label);
  return r;
};

test("O5.5B26 the Change Author's prompt: explicit output-only discipline, last, for exactly the recorded envelope", () => {
  const prompt = claudeStructuredPrompt(PROPOSAL);
  assert.equal(prompt, `${structuredTurnPrompt(PROPOSAL)}\n${CLAUDE_PROPOSAL_REPLY_RULE}`, "the neutral contract, then the Claude rule last");
  assert.equal(CLAUDE_PROPOSAL_REPLY_RULE, claudeProposalReplyRule(transportProfile("claude", "claude-one-shot")!.changeProposalEnvelope));
  for (const line of ["You are the Change Author.", "Produce the requested implementation proposal only",
    "exactly one JSON object matching the ChangeSet schema above", "Your final reply is that payload and nothing else, also after you have inspected files.",
    "Do not explain the proposal before or after it.", "No commentary, rationale, summary, list of changed files, test narrative or Markdown prose outside the payload.",
    "(1) the raw JSON object alone; (2) exactly one ```json fenced block containing only that object; (3) exactly one ``` fenced block containing only that object.",
    "Only whitespace may appear outside the fence.", "Do not claim that anything was applied, changed, run or verified",
    "Stop immediately after the payload."])
    assert.ok(CLAUDE_PROPOSAL_REPLY_RULE.includes(line), line);
  assert.ok(prompt.endsWith("- Stop immediately after the payload."), "nothing follows the discipline");
  assert.ok(!prompt.includes(BEFORE.oldReplyRule), "the previous rule is gone");
  // A raw-only transport would be told the raw object only.
  assert.ok(claudeProposalReplyRule("rawOnly").includes("the raw JSON object alone. The first character of your reply must be {"));
  assert.ok(!claudeProposalReplyRule("rawOnly").includes("fenced block"));
});

test("O5.5B26 no request for prose: every mention of explanation, summary, rationale or narrative in the instruction is a prohibition", () => {
  const instruction = claudeStructuredPrompt(PROPOSAL).split("\n").filter(line => !/^(Delegation \(data\)|Baseline \(Fusion data\)): /u.test(line)).join("\n");
  const prohibitions = ["Do not explain the proposal before or after it.", "No commentary, rationale, summary, list of changed files, test narrative or Markdown prose outside the payload.",
    "no commentary, no text before or after it", "Do not claim to have changed files or run verification."];
  let rest = instruction;
  for (const phrase of prohibitions) rest = rest.split(phrase).join("");
  assert.doesNotMatch(rest, /explain|summar|rationale|narrative|describe|commentary|changed files/iu, "no remaining request for prose");
});

test("O5.5B26 accepted, exactly as before: raw JSON (O5.5B11 style), one json fence, one bare fence — the ChangeSet contract passes", () => {
  accepted(RAW, "RAW_VALID_JSON", "raw");
  accepted(` \n${RAW}\n\t`, "RAW_VALID_JSON", "raw with whitespace");
  accepted(JSON_FENCE, "SINGLE_FENCED_VALID_JSON", "json fence");
  accepted(BARE_FENCE, "SINGLE_FENCED_VALID_JSON", "bare fence");
  accepted(`\n${JSON_FENCE}\n\n`, "SINGLE_FENCED_VALID_JSON", "json fence, whitespace outside");
});

test("O5.5B26 refused, exactly as before: prose before (the O5.5B25 shape), after, or both; two fences; another fence language; an invalid ChangeSet", () => {
  // The O5.5B25 live shape: text before one closed json fence whose body matches the ChangeSet schema; whitespace after.
  const b25 = refused(`${PROSE}\n${JSON_FENCE}\n`, "EXTRA_TEXT", "prose before", "beforeFence");
  assert.deepEqual([b25.diagnostic.exactlyOneFencePair, b25.diagnostic.fenceLanguage, b25.diagnostic.bodyMatchesExpectedSchema, b25.diagnostic.whitespaceOnlyAfterFence,
    b25.terminal.structuredParsingReached, b25.terminal.schemaValidationReached], [true, "json", true, true, true, false], "exactly the recorded O5.5B25 facts");
  refused(`${JSON_FENCE}\nThe proposal trims the name first.`, "EXTRA_TEXT", "prose after", "afterFence");
  refused(`${PROSE}\n${JSON_FENCE}\nDone.`, "EXTRA_TEXT", "prose before and after", "beforeFence");
  refused(`${RAW}\nThat is the whole change.`, "EXTRA_TEXT", "prose after raw JSON");
  refused(`${JSON_FENCE}\n${JSON_FENCE}`, "MULTIPLE_FENCES", "two fences");
  refused(`\`\`\`javascript\n${RAW}\n\`\`\``, "UNSUPPORTED_FENCE", "a javascript fence");
  refused(`~~~json\n${RAW}\n~~~`, "UNSUPPORTED_FENCE", "a tilde fence");
  const invalid = refused(fenced({ schemaVersion: 1, operations: [{ kind: "writeText", path: PROBE_TARGET, content: "x" }] }).trimEnd(), "INVALID_SCHEMA", "a fenced invalid ChangeSet");
  assert.equal(invalid.terminal.schemaValidationReached, true);
  // Raw and schema-invalid: handed on as before and refused by the unchanged ChangeSet contract.
  const raw = read(JSON.stringify({ schemaVersion: 1, operations: [] }));
  assert.throws(() => validateChangeSet(raw.value, SCOPE), (error: unknown) => (error as { error?: { kind?: string } }).error?.kind === "MalformedOutput");
});

test("O5.5B26 unchanged: the envelope parser's source, every envelope policy, the Lead, Reviewer and adjudication prompts, and the neutral proposal contract", async () => {
  const source = (await readFile("src/platform/process/structured-envelope.ts", "utf8")).replace(/\r\n/gu, "\n");
  assert.equal(sha(source), BEFORE.envelopeSource, "the parser is byte-identical");
  const claude = transportProfile("claude", "claude-one-shot")!, museExec = transportProfile("muse", "muse-exec")!;
  assert.deepEqual([claude.changeProposalEnvelope, claude.leadPlanEnvelope, claude.adjudicationEnvelope], ["rawOrSingleJsonFence", "rawOrSingleJsonFence", "rawOrSingleJsonFence"]);
  assert.deepEqual([museExec.changeProposalEnvelope, museExec.leadPlanEnvelope, museExec.adjudicationEnvelope], ["rawOnly", "rawOnly", "rawOnly"]);
  assert.deepEqual([structuredEnvelope(PROPOSAL).policy, structuredEnvelope(REVIEW).policy, structuredEnvelope(ADJUDICATION).policy],
    ["rawOrSingleJsonFence", "rawOnly", "rawOrSingleJsonFence"]);
  assert.equal(sha(structuredTurnPrompt(PROPOSAL)), BEFORE.neutralProposalPrompt, "the provider-neutral Change Author contract (every other family)");
  assert.equal(sha(LEAD_PLAN_INSTRUCTION), BEFORE.leadPlanInstruction, "Lead plan instruction");
  assert.equal(sha(packetPrompt(PROBE_PACKET, "plan")), BEFORE.claudeLeadPlanPrompt, "Claude Lead plan prompt");
  assert.equal(sha(renderPrompt(PROBE_PACKET, "plan")), BEFORE.museLeadPlanPrompt, "Muse Lead plan prompt");
  assert.equal(sha(structuredTurnPrompt(REVIEW)), BEFORE.reviewPrompt, "Reviewer prompt");
  assert.equal(claudeStructuredPrompt(REVIEW), structuredTurnPrompt(REVIEW), "no Claude suffix on a review");
  assert.equal(sha(structuredTurnPrompt(ADJUDICATION)), BEFORE.adjudicationPrompt, "adjudication prompt");
  assert.equal(claudeStructuredPrompt(ADJUDICATION), structuredTurnPrompt(ADJUDICATION), "no Claude suffix on an adjudication");
});

test("O5.5B26 route (fake): the O5.5B25 reply shape is still refused at changeAuthor #1; a compliant reply under the new prompt reaches the Reviewer",
  { skip }, async () => withInstalls(async i => withRoot(async dir => {
    const b25Shape = { prefix: PREFIX.proposal, output: `${PROSE}\n${fenced(FIX)}` };
    const refusedRun = asRun(await runRoute(i, dir, "b25-shape", { Lead: [{ prefix: PREFIX.plan, output: plan() }], Worker: [b25Shape] }));
    assert.deepEqual([refusedRun.report.outcome, refusedRun.report.detail], ["MALFORMED_OUTPUT",
      "changeAuthor #1 (Worker): Claude structured output was refused: EXTRA_TEXT under the rawOrSingleJsonFence envelope."]);
    const author = sectionOf<Array<{ turn: string; structuredOutput: Record<string, unknown> }>>(refusedRun, "turns").find(t => t.turn === "changeAuthor")!;
    assert.deepEqual([author.structuredOutput.extraTextLocation, author.structuredOutput.bodyMatchesExpectedSchema], ["beforeFence", true]);
    assert.deepEqual(sectionOf<Record<string, number>>(refusedRun, "turnUse"), { leadPlan: 1, changeAuthor: 1, freshReview: 0, leadAdjudication: 0 });
    const run = asRun(await runRoute(i, dir, "compliant", { Lead: [{ prefix: PREFIX.plan, output: plan() }], Worker: [proposal(FIX)],
      Reviewer: [{ prefix: PREFIX.review, output: cleanReview }] }));
    assert.equal(run.report.outcome, "PASS", run.report.detail);
    assert.deepEqual(sectionOf<Record<string, number>>(run, "turnUse"), { leadPlan: 1, changeAuthor: 1, freshReview: 1, leadAdjudication: 0 });
    // What the route Change Author actually received: the output discipline, last; never the previous rule.
    for (const prompt of [...refusedRun.prompts.Worker, ...run.prompts.Worker]) {
      assert.ok(prompt.startsWith(PREFIX.proposal));
      assert.ok(prompt.endsWith(CLAUDE_PROPOSAL_REPLY_RULE), "the discipline is the last text the Change Author reads");
      assert.ok(!prompt.includes(BEFORE.oldReplyRule));
    }
    assert.ok(!run.prompts.Reviewer[0]!.includes("You are the Change Author."), "the Reviewer never receives the Change Author's rule");
    assert.ok(!run.prompts.Lead[0]!.includes("You are the Change Author."), "nor does the Lead");
  })));

test("O5.5B26 readiness: offline prompt work advances nothing; no live authorization is open", () => {
  assert.ok(Object.values(ROUTE_REHEARSAL_PROFILES.authorizations).filter(entry => entry.milestone !== "O5.5B27").every(entry => entry.state !== "open"));
  assert.ok(Object.values(REVIEWER_PROBE_PROFILES.authorizations).every(entry => entry.state !== "open"));
  assert.ok(Object.values(PROPOSAL_PROBE_PROFILES.authorizations).every(entry => entry.state === "consumed"));
  assert.deepEqual(fullRouteLiveRecords().slice(0, 2).map(r => r.outcome), ["PROVIDER_FAILED", "MALFORMED_OUTPUT"], "no pass before O5.5B27");
  const report = writerGateReport();
  const rows = Object.fromEntries(report.rows.map(row => [row.id, [row.state, row.evidenceKind]]));
  assert.deepEqual([rows.fullRouteLive, rows.hostControlledWriterWorkflow, rows.providerChangeProposal, rows.liveGateAuthorization],
    [["partial", "recordedLiveProbe"], ["partial", "recordedLiveProbe"], ["satisfied", "recordedLiveProbe"], ["blocked", "none"]]);
  for (const input of ["CLAUDE_CHANGE_AUTHOR_OUTPUT_DISCIPLINE_IMPLEMENTATION: READY", { changeAuthorContract: "PASS" }])
    assert.deepEqual(writerGateReport({ linuxVerification: input }), report);
  assert.deepEqual([report.realWriterModeReady, REAL_WRITER_LIVE_GATE_AUTHORIZED], [false, false]);
});
