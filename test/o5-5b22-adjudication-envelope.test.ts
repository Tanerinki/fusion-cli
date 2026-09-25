import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport } from "../src/app/writer-gate.js";
import type { AdjudicationRequest, ChangeProposalRequest, DelegationPacket, Finding, ReviewEvidence, ReviewRequest } from "../src/core/domain.js";
import { structuredTurnPrompt } from "../src/core/review/contract.js";
import { validateAdjudicationReport, validateReviewReport } from "../src/core/review/findings.js";
import { structureOnlyDiagnostic } from "../src/platform/process/structured-envelope.js";
import { claudeStructuredPrompt, packetEnvelope, structuredEnvelope } from "../src/providers/claude/one-shot-transport.js";
import { ClaudeStream } from "../src/providers/claude/parsing/stream.js";
import { claudeTerminalDiagnostic } from "../src/providers/claude/parsing/terminal.js";
import { ClaudeFailure } from "../src/providers/claude/types.js";
import { PROPOSAL_PROBE_PROFILES, ROUTE_REHEARSAL_PROFILES } from "../src/providers/probe-profiles.js";
import { fullRouteLiveCoverage, leadPlanLiveRecords, transportProfile } from "../src/runtime/provider-profiles.js";
import { withRoot } from "./fixtures/probe-harness.js";
import { withInstalls } from "./fixtures/provider-installs.js";
import { asRun, fenced, plan, PREFIX, proposal, reviewWith, runRoute, sectionOf } from "./fixtures/route-harness.js";
import { FIX, gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5B22 — the Claude Lead's ADJUDICATION reply is read under the same narrow envelope the Change Author (O5.5B10) and
 * the Lead plan (O5.5B18) use: raw strict JSON, or exactly one outer json/bare fence with only whitespace outside it around
 * one strict JSON object that satisfies the adjudication decoding schema; the core adjudication validator stays
 * authoritative. The adjudication prompt, schema and contract, and every other role's policy are unchanged.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const evidence: ReviewEvidence = { task: { goal: "Fix quote totals.", constraints: [], acceptanceCriteria: [] },
  architecture: { decisions: [], invariants: [] }, scope: { relevantFiles: ["src/quote.ts"], allowedFiles: ["src/quote.ts"], forbiddenFiles: [] },
  verification: { required: true, passed: true, commands: [] },
  change: { kind: "diff", changedPaths: ["src/quote.ts"], text: "diff --git a/src/quote.ts b/src/quote.ts\n-old\n+new\n", truncated: false } };
const findings: readonly Finding[] = validateReviewReport({ summary: "One finding.", findings: [{ id: "F1", severity: "HIGH", confidence: "HIGH",
  category: "tests", file: "src/quote.ts", lines: { start: 1, end: 1 }, title: "No regression test", evidence: ["No test pins a full discount."],
  failureScenario: "A later refactor breaks it silently." }] }, { cycle: 1, runId: "run-1", sessionId: "s-1", role: "Reviewer" });
const REQUEST: AdjudicationRequest = { kind: "adjudication", cycle: 1, evidence, findings,
  fusionFacts: findings.map(f => ({ findingId: f.id, supported: [], contradicted: [] })) };
const REPORT = { adjudications: [{ findingId: findings[0]!.id, verdict: "REJECTED", rationale: "The existing tests already cover it.",
  requiredAction: "none" }], summary: "" };
const RAW = JSON.stringify(REPORT);
const ENVELOPE = structuredEnvelope(REQUEST);

/** One adjudication reply through the real stream reader under the adjudication envelope, then the core validator. */
function adjudicate(text: string, envelope = ENVELOPE) {
  const stream = new ClaudeStream();
  stream.accept({ type: "system", subtype: "init", model: "claude-canonical-fixture" });
  stream.accept({ type: "result", subtype: "success", is_error: false, terminal_reason: "completed", result: text });
  let value: unknown, error: ClaudeFailure | undefined;
  try { value = stream.json(envelope); } catch (caught) { if (caught instanceof ClaudeFailure) error = caught; else throw caught; }
  return { value, error, diagnostic: stream.outputDiagnostic!, terminal: claudeTerminalDiagnostic(stream.terminalFacts(), undefined, true) };
}
const accepted = (text: string, cls: string, label: string) => {
  const r = adjudicate(text);
  assert.equal(r.error, undefined, `${label}: ${r.error?.error.safeMessage}`);
  assert.deepEqual(r.value, REPORT, label);
  assert.deepEqual(validateAdjudicationReport(r.value, findings).adjudications.map(a => a.verdict), ["REJECTED"], `${label}: the core contract passes`);
  assert.deepEqual([r.diagnostic.classification, r.diagnostic.accepted, r.diagnostic.policy, r.diagnostic.bodyMatchesExpectedSchema],
    [cls, true, "rawOrSingleJsonFence", true], label);
  assert.deepEqual([r.terminal.structuredParsingReached, r.terminal.schemaValidationReached], [true, true], label);
};
const refused = (text: string, cls: string, label: string, schemaReached = false) => {
  const r = adjudicate(text);
  assert.ok(r.error, `${label}: must be refused`);
  assert.deepEqual([r.error!.error.kind, r.error!.error.safeMessage],
    ["MalformedOutput", `Claude structured output was refused: ${cls} under the rawOrSingleJsonFence envelope.`], label);
  assert.deepEqual([r.diagnostic.classification, r.diagnostic.accepted], [cls, false], label);
  assert.deepEqual([r.terminal.structuredParsingReached, r.terminal.schemaValidationReached], [true, schemaReached], `${label}: exact stage flags`);
};

test("O5.5B22 adjudication envelope: raw JSON, one ```json fence, one bare fence and whitespace around them are accepted; the core contract passes", () => {
  assert.deepEqual([ENVELOPE.policy, typeof ENVELOPE.conforms], ["rawOrSingleJsonFence", "function"]);
  accepted(RAW, "RAW_VALID_JSON", "raw");
  accepted(` \n${JSON.stringify(REPORT, null, 2)}\n\t`, "RAW_VALID_JSON", "raw with whitespace");
  accepted(`\`\`\`json\n${RAW}\n\`\`\``, "SINGLE_FENCED_VALID_JSON", "json fence");
  accepted(`\`\`\`\n${JSON.stringify(REPORT, null, 2)}\n\`\`\``, "SINGLE_FENCED_VALID_JSON", "bare fence");
  accepted(`\r\n \`\`\`json\r\n${RAW}\r\n\`\`\`\r\n `, "SINGLE_FENCED_VALID_JSON", "CRLF, whitespace only outside");
});

test("O5.5B22 adjudication envelope refuses prose, several/nested/unclosed fences, other fence languages; the schema stage is never reached", () => {
  refused(`Verdicts:\n\`\`\`json\n${RAW}\n\`\`\``, "EXTRA_TEXT", "prose before");
  refused(`\`\`\`json\n${RAW}\n\`\`\`\nThat is all.`, "EXTRA_TEXT", "prose after");
  refused(`\`\`\`json\n${RAW}\n\`\`\`\n\`\`\`json\n${RAW}\n\`\`\``, "MULTIPLE_FENCES", "two fences");
  refused(`\`\`\`json\n{\n\`\`\`json\n${RAW}\n\`\`\`\n}\n\`\`\``, "MULTIPLE_FENCES", "a nested fence");
  refused(`\`\`\`json\n${RAW}\n`, "UNCLOSED_FENCE", "an unclosed fence");
  refused(`\`\`\`jsonc\n${RAW}\n\`\`\``, "UNSUPPORTED_FENCE", "a jsonc fence");
  refused(`~~~json\n${RAW}\n~~~`, "UNSUPPORTED_FENCE", "a tilde fence");
  refused(`${RAW} Done.`, "EXTRA_TEXT", "prose after raw JSON");
});

test("O5.5B22 adjudication envelope never repairs JSON: malformed, comments, JSON5, trailing commas, concatenated documents, duplicate keys fail", () => {
  const f = (body: string) => `\`\`\`json\n${body}\n\`\`\``;
  refused(f(`{"adjudications": }`), "SINGLE_FENCED_INVALID_JSON", "malformed");
  refused(f(`// verdicts\n${RAW}`), "SINGLE_FENCED_INVALID_JSON", "a comment");
  refused(f(RAW.replace(/"/gu, "'")), "SINGLE_FENCED_INVALID_JSON", "JSON5 quotes");
  refused(f(RAW.replace(/\],"summary"/u, "],,\"summary\"")), "SINGLE_FENCED_INVALID_JSON", "a double comma");
  refused(f(RAW.replace(/""\}$/u, "\"\",}")), "SINGLE_FENCED_INVALID_JSON", "a trailing comma");
  refused(f(`${RAW}\n${RAW}`), "MULTIPLE_VALUES", "two documents in the fence");
  refused(`${RAW}${RAW}`, "MULTIPLE_VALUES", "two raw documents");
  const duplicate = adjudicate(f(`{"adjudications":[],"adjudications":${JSON.stringify(REPORT.adjudications)},"summary":""}`));
  assert.deepEqual([duplicate.diagnostic.classification, duplicate.diagnostic.bodyJsonFailure, duplicate.error?.error.kind],
    ["SINGLE_FENCED_INVALID_JSON", "duplicateKey", "MalformedOutput"]);
});

test("O5.5B22 schema/contract-invalid adjudications fail: fenced ones at the schema check, raw ones at the unchanged core validator", () => {
  const f = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
  const verdict = REPORT.adjudications[0]!;
  for (const [label, value] of [["an unknown finding id", { ...REPORT, adjudications: [{ ...verdict, findingId: "r1-F9" }] }],
    ["an unknown verdict", { ...REPORT, adjudications: [{ ...verdict, verdict: "MAYBE" }] }],
    ["a missing verdict", { ...REPORT, adjudications: [] }], ["an extra key", { ...REPORT, note: "x" }], ["an array", [REPORT]]] as const)
    refused(f(value), "INVALID_SCHEMA", label, true);
  // Raw: handed on exactly as before; the core adjudication validator refuses it.
  const raw = adjudicate(JSON.stringify({ ...REPORT, adjudications: [{ ...verdict, findingId: "r1-F9" }] }));
  assert.deepEqual([raw.diagnostic.classification, raw.diagnostic.accepted, raw.terminal.schemaValidationReached], ["INVALID_SCHEMA", true, true]);
  assert.throws(() => validateAdjudicationReport(raw.value, findings), (error: unknown) => (error as { error?: { kind?: string } }).error?.kind === "MalformedOutput");
});

test("O5.5B22 privacy: the adjudication reply shape is recorded without content", () => {
  const secret = "ADJUDICATION-RATIONALE-CANARY-7a4c";
  const r = adjudicate(`\`\`\`json\n${JSON.stringify({ ...REPORT, adjudications: [{ ...REPORT.adjudications[0]!, rationale: secret }] })}\n\`\`\``);
  assert.equal(r.error, undefined);
  assert.notEqual(structureOnlyDiagnostic(r.diagnostic), "invalid");
  assert.ok(!JSON.stringify(r.diagnostic).includes(secret) && !JSON.stringify(r.terminal).includes(secret));
});

test("O5.5B22 scope: only adjudication changes — review raw-only, Lead plan and Change Author as before, prompt unchanged, Muse raw-only", () => {
  const review: ReviewRequest = { kind: "review", cycle: 1, evidence, priorFindings: [], limits: { maxFindings: 5 } };
  assert.equal(structuredEnvelope(review).policy, "rawOnly", "the Reviewer role stays raw-only");
  const proposal: ChangeProposalRequest = { kind: "changeProposal", packet: {} as DelegationPacket };
  assert.equal(structuredEnvelope(proposal).policy, "rawOrSingleJsonFence", "Change Author unchanged (O5.5B10)");
  assert.equal(packetEnvelope("plan").policy, "rawOrSingleJsonFence", "Lead plan unchanged (O5.5B18)");
  for (const purpose of [undefined, "delegate", "exploration", "leadReview"] as const) assert.deepEqual(packetEnvelope(purpose), { policy: "rawOnly" });
  const claude = transportProfile("claude", "claude-one-shot")!;
  assert.deepEqual([claude.changeProposalEnvelope, claude.leadPlanEnvelope, claude.adjudicationEnvelope],
    ["rawOrSingleJsonFence", "rawOrSingleJsonFence", "rawOrSingleJsonFence"]);
  for (const transport of ["muse-exec", "muse-msp"])
    assert.equal(transportProfile("muse", transport)!.adjudicationEnvelope, "rawOnly", `${transport} unchanged`);
  // The adjudication prompt is the unchanged core contract; Claude appends nothing to it (its reply rule is proposal-only).
  assert.equal(claudeStructuredPrompt(REQUEST), structuredTurnPrompt(REQUEST));
  // Under the previous raw-only policy the same fenced reply was refused: the known incompatibility this closes.
  const before = adjudicate(fenced(REPORT), { policy: "rawOnly", ...(ENVELOPE.conforms ? { conforms: ENVELOPE.conforms } : {}) });
  assert.deepEqual([before.error?.error.safeMessage, before.terminal.schemaValidationReached],
    ["Claude structured output was refused: SINGLE_FENCED_VALID_JSON under the rawOnly envelope.", false]);
});

test("O5.5B22 route (fake): a fenced Lead adjudication is accepted and recorded (envelope class, contract), text-free; the route passes", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    const secret = "ROUTE-ADJUDICATION-CANARY-e91b";
    const verdict = { adjudications: [{ findingId: "r1-F1", verdict: "REJECTED", rationale: `Covered already. ${secret}`, requiredAction: "none" }], summary: "" };
    const run = asRun(await runRoute(i, dir, "adjudication", {
      Lead: [{ prefix: PREFIX.plan, output: plan() }, { prefix: PREFIX.adjudication, output: fenced(verdict) }],
      Worker: [proposal(FIX)], Reviewer: [{ prefix: PREFIX.review, output: reviewWith({ id: "F1", severity: "HIGH" }) }] }));
    assert.equal(run.report.outcome, "PASS", run.report.detail);
    const turns = sectionOf<Array<{ turn: string; contract: string; structuredOutput: Record<string, unknown> | null; terminal: Record<string, unknown> }>>(run, "turns");
    const adjudication = turns.find(t => t.turn === "leadAdjudication")!;
    assert.equal(adjudication.contract, "accepted:1 verdict(s)");
    assert.deepEqual([adjudication.structuredOutput?.classification, adjudication.structuredOutput?.accepted, adjudication.structuredOutput?.policy,
      adjudication.structuredOutput?.bodyMatchesExpectedSchema], ["SINGLE_FENCED_VALID_JSON", true, "rawOrSingleJsonFence", true]);
    assert.deepEqual([adjudication.terminal.structuredParsingReached, adjudication.terminal.schemaValidationReached], [true, true]);
    // The Reviewer (Muse, raw-only) is unchanged. It reported no diagnostic here until O5.5B23; now its reply shape is
    // recorded under its own raw-only policy.
    assert.deepEqual([turns.find(t => t.turn === "freshReview")!.structuredOutput?.policy, turns.find(t => t.turn === "freshReview")!.structuredOutput?.classification],
      ["rawOnly", "RAW_VALID_JSON"], "the Muse Reviewer's own diagnostic, never the Claude envelope");
    const text = await readFile(run.report.evidencePath, "utf8");
    assert.ok(!text.includes(secret) && !text.includes("Covered already"), "no adjudication text persisted");
    assert.equal(run.report.evidence.evidenceKind, "offlineRehearsal");
  })));

test("O5.5B22 readiness: implementation only — no live record, row or gate moves; nothing is open", () => {
  assert.deepEqual(leadPlanLiveRecords().map(r => [r.milestone, r.outcome]), [["O5.5B15", "FAIL"], ["O5.5B17", "FAIL"], ["O5.5B21", "PASS"]]);
  assert.deepEqual([fullRouteLiveCoverage().attempts, fullRouteLiveCoverage().passed], [1, 0]);
  const report = writerGateReport();
  const rows = Object.fromEntries(report.rows.map(row => [row.id, [row.state, row.evidenceKind]]));
  assert.deepEqual([rows.fullRouteLive, rows.hostControlledWriterWorkflow, rows.providerChangeProposal, rows.reviewAndAdjudication, rows.liveGateAuthorization],
    [["blocked", "recordedLiveProbe"], ["partial", "fakeProviderRehearsal"], ["satisfied", "recordedLiveProbe"], ["satisfied", "mechanical"], ["blocked", "none"]]);
  for (const input of ["CLAUDE_ADJUDICATION_ENVELOPE_IMPLEMENTATION: READY", { adjudicationLive: "PASS" }])
    assert.deepEqual(writerGateReport({ linuxVerification: input }), report);
  assert.deepEqual([report.realWriterModeReady, REAL_WRITER_LIVE_GATE_AUTHORIZED], [false, false]);
  assert.ok(Object.values(ROUTE_REHEARSAL_PROFILES.authorizations).every(entry => entry.state !== "open"));
  assert.ok(Object.values(PROPOSAL_PROBE_PROFILES.authorizations).every(entry => entry.state === "consumed"));
});
