import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ADJUDICATION_ONLY_TURNS, AdjudicationTurnGate, adjudicationProbeFindings, adjudicationProbeRequest,
  FUSION_AUTHORED_REVIEW_SESSION } from "../src/app/adjudication-probe.js";
import { ADJUDICATION_REVIEW_REPORT, adjudicationFindingsIdentity, QUOTE_FIXED, QUOTE_TEST, REHEARSAL_PLAN, ROUTE_PACKET } from "../src/app/route-fixture.js";
import { REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport } from "../src/app/writer-gate.js";
import type { AdjudicationRequest, Finding, ProviderAdapter, ReviewEvidence } from "../src/core/domain.js";
import { adjudicationReportSchema, structuredTurnPrompt } from "../src/core/review/contract.js";
import { reviewEvidence } from "../src/core/review/policy.js";
import { claudeStructuredPrompt, structuredEnvelope } from "../src/providers/claude/one-shot-transport.js";
import { ADJUDICATION_PROBE_PROFILES, PROPOSAL_PROBE_PROFILES, REVIEWER_PROBE_PROFILES, ROUTE_LEAD_ADJUDICATOR,
  ROUTE_REHEARSAL_PROFILES } from "../src/providers/probe-profiles.js";
import { fullRouteLiveRecords, transportProfile } from "../src/runtime/provider-profiles.js";
import { asAdjudicationRun, evidenceOf, runAdjudication, testAdjudicationAuthorization } from "./fixtures/adjudication-harness.js";
import { withRoot } from "./fixtures/probe-harness.js";
import { withInstalls } from "./fixtures/provider-installs.js";
import { fenced, LEAD_SECRET, PREFIX, routeEnv, WORKER_SECRET } from "./fixtures/route-harness.js";
import { gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5B28 — the Lead-adjudication probe foundation, offline: the real one-shot adapter code on the scripted fake binary, the
 * real candidate port, view store and Docker backend on the in-memory daemon, the production adjudication request, prompt,
 * envelope and contract. No provider, no authorization, no readiness change.
 */
const skip = gitAvailable ? false : "git executable unavailable";
type Launch = { purpose: string; phase: string; executable: string; executableIsAuthorized: boolean; cwdClass: string;
  posture?: { missing: string[]; widening: string[] }; identityGaps?: string[]; refusedBeforeStart?: string };
type Adjudication = { turn: Record<string, unknown> | null; contract: string; verdicts: Array<Record<string, unknown>> | null;
  byVerdict: Record<string, number> | null; byRequiredAction: Record<string, number> | null; decision: Record<string, unknown> | null;
  structuredOutput: Record<string, unknown> | null; terminal: Record<string, unknown> | null; error?: { kind: string; safeMessage: string };
  envelopeIssue?: string };
const RATIONALE = "ADJUDICATION-RATIONALE-CANARY-3f9d", SUMMARY = "ADJUDICATION-SUMMARY-CANARY-b82e";
type Verdict = readonly [finding: string, verdict: string, action: string];
const report = (...verdicts: Verdict[]) => ({ adjudications: verdicts.map(([findingId, verdict, requiredAction]) => ({ findingId, verdict,
  rationale: `Evidence-based. ${RATIONALE}`, requiredAction })), summary: SUMMARY });
/** The verdicts an evidence-based Lead would give the fixed set: F1 answered by the suite, F2 a LOW remark, F3 contradicted by Fusion. */
const EXPECTED = report(["r1-F1", "REJECTED", "none"], ["r1-F2", "CONFIRMED", "followUp"], ["r1-F3", "REJECTED", "none"]);
const TURN = (output: string) => ({ prefix: PREFIX.adjudication, output });
const claimed = async (root: string) => (await readdir(root)).includes("adjudication.claim.json");
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
/** The request the probe must have sent, rebuilt from production pieces; only the observed diff text is read from the prompt. */
function rebuiltRequest(prompt: string): AdjudicationRequest {
  const line = prompt.split("\n").find(l => l.startsWith("Evidence (data): "))!;
  const sent = JSON.parse(line.slice("Evidence (data): ".length)) as ReviewEvidence;
  const evidence = reviewEvidence(ROUTE_PACKET, { required: true, passed: true, commands: REHEARSAL_PLAN.commands.map(c => ({ id: c.id, passed: true })) },
    { kind: "diff", changedPaths: ["src/quote.ts", "test/quote.test.ts"], text: sent.change.text, truncated: false });
  assert.deepEqual(sent, evidence, "the evidence is production's review evidence of the candidate");
  return adjudicationProbeRequest(evidence, adjudicationProbeFindings("any-run"), { verification: new Map(REHEARSAL_PLAN.commands.map(c => [c.id, true])),
    changedPaths: ["src/quote.ts", "test/quote.test.ts"], allowedScope: ["src/quote.ts", "test/quote.test.ts"], claimedTests: [] });
}
const claim = ({ source: _source, ...finding }: Finding) => finding;

test("O5.5B28 PASS (fake): exactly one Lead adjudication turn over the fixed findings — production request, prompt, schema, envelope and contract; no other role",
  { skip }, async () => withInstalls(async i => withRoot(async dir => {
    const run = asAdjudicationRun(await runAdjudication(i, dir, "pass", [TURN(fenced(EXPECTED))]));
    assert.equal(run.report.outcome, "PASS", run.report.detail);
    assert.deepEqual([run.report.modelTurns, run.report.evidence.stage, run.report.evidence.evidenceKind], [1, "adjudication", "offlineRehearsal"]);
    assert.ok(run.report.evidencePath.endsWith("adjudication.evidence.json"));
    assert.ok(await claimed(run.root), "the one-shot claim was written before the turn");
    // 1./2. One adjudication turn; no Lead plan, Change Author or Reviewer process: every process is the Lead's executable, in the candidate view.
    assert.deepEqual(evidenceOf<Record<string, number>>(run, "turnUse"), { leadPlan: 0, changeAuthor: 0, freshReview: 0, leadAdjudication: 1 });
    const counts = evidenceOf<Record<string, number>>(run, "launchCounts");
    assert.deepEqual(counts, { providerAuthReadback: 2, providerInventory: 1, providerInitProbe: 2, providerTurn: 1, providerHost: 0 },
      "the session readback, then the turn's own readback, plugin inventory, two init probes and one model process");
    const launches = evidenceOf<Launch[]>(run, "launches");
    assert.ok(launches.every(l => l.executableIsAuthorized && l.refusedBeforeStart === undefined && l.cwdClass === "providerView:candidate"), JSON.stringify(launches));
    assert.deepEqual(launches.filter(l => l.phase === "session").map(l => l.purpose), ["providerAuthReadback"], "the session's pre-claim readback only");
    const turn = launches.find(l => l.purpose === "providerTurn")!;
    assert.deepEqual([turn.phase, turn.posture, turn.identityGaps], ["turn", { missing: [], widening: [] }, []]);
    assert.deepEqual(evidenceOf<{ turns: unknown[]; launches: unknown[] }>(run, "refusals"), { turns: [], launches: [] });
    const adjudication = evidenceOf<Adjudication>(run, "adjudication");
    assert.equal(adjudication.contract, "accepted:3 verdict(s)");
    assert.deepEqual(adjudication.verdicts, [
      { findingId: "r1-F1", severity: "MEDIUM", verdict: "REJECTED", requiredAction: "none", verdictSource: "lead", supportedFacts: 0 },
      { findingId: "r1-F2", severity: "LOW", verdict: "CONFIRMED", requiredAction: "followUp", verdictSource: "lead", supportedFacts: 0 },
      { findingId: "r1-F3", severity: "HIGH", verdict: "REJECTED", requiredAction: "none", verdictSource: "lead", supportedFacts: 0 }]);
    assert.deepEqual([adjudication.byVerdict, adjudication.byRequiredAction], [{ CONFIRMED: 1, REJECTED: 2 }, { followUp: 1, none: 2 }]);
    assert.deepEqual(adjudication.decision, { kind: "clean" }, "the production review policy's decision");
    assert.deepEqual([adjudication.turn?.status, adjudication.turn?.requestedModel, adjudication.turn?.observedModel, adjudication.turn?.effort,
      adjudication.turn?.maxTurns], ["completed", "haiku", "claude-haiku-4-5-20251001", "low", 6]);
    // 3. The production envelope and the terminal stages, as bounded labels.
    assert.deepEqual([adjudication.structuredOutput?.classification, adjudication.structuredOutput?.accepted, adjudication.structuredOutput?.policy,
      adjudication.structuredOutput?.bodyMatchesExpectedSchema], ["SINGLE_FENCED_VALID_JSON", true, "rawOrSingleJsonFence", true]);
    assert.deepEqual([adjudication.terminal?.classification, adjudication.terminal?.structuredParsingReached, adjudication.terminal?.schemaValidationReached,
      adjudication.terminal?.processExitCode], ["RESULT_OK", true, true, 0]);
    assert.equal(evidenceOf<{ expectedEnvelope: string }>(run, "preflight").expectedEnvelope, "rawOrSingleJsonFence");
    const readback = evidenceOf<Record<string, unknown>>(run, "readback");
    assert.deepEqual([readback.source, readback.runtimeVersion, readback.effectiveModel, readback.apiKeySource, readback.permissionMode],
      ["completedTurn", "2.1.280", "claude-haiku-4-5-20251001", "none", "dontAsk"]);
    // Fusion's own verification of the Fusion-authored candidate, before the claim.
    const verification = evidenceOf<Record<string, unknown>>(run, "verification");
    assert.deepEqual([verification.passed, verification.commandsRun, verification.acceptance], [true, 2, "offlineRehearsal"]);
    const request = evidenceOf<{ findings: Array<{ id: string; factKinds: string[] }>; fusionFacts: unknown[]; contractPromptSha256: string;
      evidence: { changedPaths: string[] } }>(run, "request");
    assert.deepEqual(request.findings.map(f => [f.id, f.factKinds]), [["r1-F1", []], ["r1-F2", []], ["r1-F3", ["verificationCommand"]]]);
    assert.deepEqual(request.fusionFacts, [{ findingId: "r1-F1", supported: 0, contradicted: 0 }, { findingId: "r1-F2", supported: 0, contradicted: 0 },
      { findingId: "r1-F3", supported: 0, contradicted: 1 }], "Fusion's passed verification contradicts the unit claim");
    assert.deepEqual(request.evidence.changedPaths, ["src/quote.ts", "test/quote.test.ts"]);

    // 3. Exactly the production prompt: the core adjudication contract, the adjudication schema of exactly these finding ids.
    assert.equal(run.prompts.length, 1);
    const prompt = run.prompts[0]!;
    const rebuilt = rebuiltRequest(prompt);
    assert.equal(prompt, structuredTurnPrompt(rebuilt));
    assert.equal(prompt, claudeStructuredPrompt(rebuilt), "the adapter adds nothing to the adjudication prompt");
    assert.equal(request.contractPromptSha256, sha256(prompt));
    assert.ok(prompt.includes(JSON.stringify(adjudicationReportSchema(["r1-F1", "r1-F2", "r1-F3"]))));
    // 4. The fixed findings and Fusion's facts are visible, as data; so is the candidate's diff.
    assert.ok(prompt.includes(`Findings (data): ${JSON.stringify(adjudicationProbeFindings("x").map(claim))}`));
    assert.ok(prompt.includes(`Fusion facts (evidence): ${JSON.stringify(rebuilt.fusionFacts)}`));
    assert.ok(prompt.includes("\"contradicted\":[{\"kind\":\"verificationCommand\",\"commandId\":\"unit\"}]"));
    assert.ok(prompt.includes("basisPoints(subtotal - discount, quote.taxBasisPoints)") && prompt.includes("a full discount leaves nothing to tax"));
    // 5. Nothing hidden travels: no Reviewer summary or provenance, no run id, no Lead plan, Change Author or review text.
    for (const hidden of [ADJUDICATION_REVIEW_REPORT.summary, FUSION_AUTHORED_REVIEW_SESSION, String(run.report.evidence.runId), "planning Lead",
      "Fusion change proposal.", "Fusion fresh review.", LEAD_SECRET, WORKER_SECRET, "\"source\""])
      assert.ok(!prompt.includes(hidden), `the prompt must not carry ${hidden}`);
    // Integrity, cleanup, and no reply text persisted.
    assert.deepEqual(evidenceOf<Record<string, boolean>>(run, "integrity"), { viewUnchanged: true, candidateUnchanged: true, primaryUnchanged: true });
    const cleanup = evidenceOf<{ leftoverOwnedTemporaries: string[]; released: Record<string, unknown> }>(run, "cleanup");
    assert.deepEqual([cleanup.leftoverOwnedTemporaries, cleanup.released], [[], { session: "closed", view: { complete: true }, candidate: { complete: true } }]);
    const text = await readFile(run.report.evidencePath, "utf8");
    for (const secret of [RATIONALE, SUMMARY, "Evidence-based."]) assert.ok(!text.includes(secret), `evidence leaks ${secret}`);
  })));

test("O5.5B28 envelope (fake): raw JSON and one bare fence pass too; the contract sees the same verdicts", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    for (const [name, output, cls] of [["raw", JSON.stringify(EXPECTED), "RAW_VALID_JSON"],
      ["bare", `\`\`\`\n${JSON.stringify(EXPECTED, null, 2)}\n\`\`\``, "SINGLE_FENCED_VALID_JSON"]] as const) {
      const run = asAdjudicationRun(await runAdjudication(i, dir, name, [TURN(output)]));
      assert.equal(run.report.outcome, "PASS", `${name}: ${run.report.detail}`);
      const adjudication = evidenceOf<Adjudication>(run, "adjudication");
      assert.deepEqual([adjudication.structuredOutput?.classification, adjudication.structuredOutput?.accepted, adjudication.contract],
        [cls, true, "accepted:3 verdict(s)"], name);
    }
  })));

test("O5.5B28 envelope (fake): prose, several fences, an unclosed fence and another fence language fail as MALFORMED_OUTPUT, the authorization consumed",
  { skip }, async () => withInstalls(async i => withRoot(async dir => {
    const raw = JSON.stringify(EXPECTED);
    for (const [name, output, cls] of [["prose", `Here are my verdicts:\n${fenced(EXPECTED)}`, "EXTRA_TEXT"],
      ["two", `${fenced(EXPECTED)}${fenced(EXPECTED)}`, "MULTIPLE_FENCES"], ["unclosed", `\`\`\`json\n${raw}\n`, "UNCLOSED_FENCE"],
      ["jsonc", `\`\`\`jsonc\n${raw}\n\`\`\``, "UNSUPPORTED_FENCE"]] as const) {
      const run = asAdjudicationRun(await runAdjudication(i, dir, name, [TURN(output)]));
      assert.deepEqual([run.report.outcome, run.report.modelTurns, run.report.evidence.stage], ["MALFORMED_OUTPUT", 1, "adjudication"], name);
      assert.ok(await claimed(run.root), `${name}: consumed`);
      const adjudication = evidenceOf<Adjudication>(run, "adjudication");
      assert.deepEqual([adjudication.contract, adjudication.structuredOutput?.classification, adjudication.structuredOutput?.accepted,
        adjudication.decision, adjudication.verdicts], ["notReached:MalformedOutput", cls, false, null, null], name);
      assert.deepEqual([adjudication.terminal?.classification, adjudication.terminal?.schemaValidationReached], ["RESULT_OK", false], name);
      const text = await readFile(run.report.evidencePath, "utf8");
      assert.ok(!text.includes(RATIONALE) && !text.includes("Here are my verdicts"), `${name}: no reply text persisted`);
    }
  })));

test("O5.5B28 contract (fake): a schema-invalid fenced reply fails at the envelope; contract-invalid replies fail at the production contract",
  { skip }, async () => withInstalls(async i => withRoot(async dir => {
    const unknown = asAdjudicationRun(await runAdjudication(i, dir, "unknown-id", [TURN(fenced(report(["r1-F1", "REJECTED", "none"],
      ["r1-F2", "CONFIRMED", "followUp"], ["r1-F9", "REJECTED", "none"])))]));
    assert.equal(unknown.report.outcome, "MALFORMED_OUTPUT");
    const bad = evidenceOf<Adjudication>(unknown, "adjudication");
    assert.deepEqual([bad.structuredOutput?.classification, bad.terminal?.schemaValidationReached], ["INVALID_SCHEMA", true]);
    // Raw JSON is handed on to the unchanged core validator, which refuses a missing verdict.
    const missing = asAdjudicationRun(await runAdjudication(i, dir, "missing", [TURN(JSON.stringify(report(["r1-F1", "REJECTED", "none"],
      ["r1-F2", "CONFIRMED", "followUp"])))]));
    assert.deepEqual([missing.report.outcome, evidenceOf<Adjudication>(missing, "adjudication").contract], ["CONTRACT_REFUSED", "refused"]);
    assert.match(missing.report.detail, /adjudication finding set/u);
    // A schema-valid reply whose required action contradicts its verdict: the production contract refuses it.
    const action = asAdjudicationRun(await runAdjudication(i, dir, "action", [TURN(fenced(report(["r1-F1", "REJECTED", "fix"],
      ["r1-F2", "CONFIRMED", "followUp"], ["r1-F3", "REJECTED", "none"])))]));
    assert.deepEqual([action.report.outcome, evidenceOf<Adjudication>(action, "adjudication").structuredOutput?.classification],
      ["CONTRACT_REFUSED", "SINGLE_FENCED_VALID_JSON"]);
    assert.match(action.report.detail, /required action contradicts the verdict/u);
  })));

test("O5.5B28 decision (fake): any production-valid decision passes — a gate is recorded as the policy's decision, never as a failure",
  { skip }, async () => withInstalls(async i => withRoot(async dir => {
    const run = asAdjudicationRun(await runAdjudication(i, dir, "gate", [TURN(fenced(report(["r1-F1", "CONFIRMED", "fix"],
      ["r1-F2", "PARTIAL", "none"], ["r1-F3", "UNVERIFIABLE", "humanDecision"])))]));
    assert.equal(run.report.outcome, "PASS", run.report.detail);
    const adjudication = evidenceOf<Adjudication>(run, "adjudication");
    assert.deepEqual(adjudication.decision, { kind: "gate", state: "decisionRequired" }, "an unverifiable HIGH finding needs a decision");
    const fix = asAdjudicationRun(await runAdjudication(i, dir, "correction", [TURN(fenced(report(["r1-F1", "CONFIRMED", "fix"],
      ["r1-F2", "REJECTED", "none"], ["r1-F3", "REJECTED", "none"])))]));
    assert.deepEqual(evidenceOf<Adjudication>(fix, "adjudication").decision, { kind: "correction", findings: ["r1-F1"] });
  })));

test("O5.5B28 failed model turn (fake): a turn that ends error_max_turns is PROVIDER_FAILED with its terminal labels, text-free", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    const run = asAdjudicationRun(await runAdjudication(i, dir, "max-turns", [{ prefix: PREFIX.adjudication, exitCode: 1, resultFrame: {
      subtype: "error_max_turns", is_error: true, terminal_reason: "max_turns", num_turns: 7, errors: [`Reached maximum number of turns (6) ${RATIONALE}`],
      result: "__absent__" } }]));
    assert.deepEqual([run.report.outcome, run.report.modelTurns], ["PROVIDER_FAILED", 1]);
    const adjudication = evidenceOf<Adjudication>(run, "adjudication");
    assert.deepEqual([adjudication.terminal?.classification, adjudication.terminal?.internalTurnCount, adjudication.terminal?.structuredParsingReached,
      adjudication.contract], ["RESULT_ERROR_MAX_TURNS", 7, false, "notReached:ProcessFailure"]);
    assert.ok(!(await readFile(run.report.evidencePath, "utf8")).includes(RATIONALE));
  })));

test("O5.5B28 bounds: exact binding in preflight; a one-adjudication budget and the pinned fixture, candidate and finding set; never nested",
  { skip }, async () => withInstalls(async i => withRoot(async dir => {
    for (const [name, binding, field] of [["effort", { effort: "medium" }, "effort"], ["turns", { maxTurns: 3 }, "maxTurns"],
      ["model", { model: "sonnet" }, "model"]] as const) {
      const run = asAdjudicationRun(await runAdjudication(i, dir, `binding-${name}`, [TURN(fenced(EXPECTED))], { binding }));
      assert.deepEqual([run.report.outcome, run.report.evidence.stage, run.report.modelTurns], ["MODEL_BLOCKED", "preflight", 0], name);
      assert.deepEqual(evidenceOf<{ bindingMismatches: string[] }>(run, "preflight").bindingMismatches, [field], name);
      assert.equal(await claimed(run.root), false, `${name}: nothing consumed`);
      assert.equal(run.prompts.length, 0);
    }
    for (const [name, turns] of [["plan", { ...ADJUDICATION_ONLY_TURNS, leadPlan: 1 }], ["author", { ...ADJUDICATION_ONLY_TURNS, changeAuthor: 1 }],
      ["review", { ...ADJUDICATION_ONLY_TURNS, freshReview: 1 }], ["two", { ...ADJUDICATION_ONLY_TURNS, leadAdjudication: 2 }],
      ["none", { ...ADJUDICATION_ONLY_TURNS, leadAdjudication: 0 }]] as const) {
      const refused = await runAdjudication(i, dir, `budget-${name}`, [], { authorization: testAdjudicationAuthorization({ turns }) });
      assert.ok("refused" in refused && refused.reason === "budgetNotAdjudicationOnly", name);
    }
    for (const [field, reason] of [["fixtureSha256", "fixtureMismatch"], ["candidateSha256", "candidateMismatch"], ["findingsSha256", "findingsMismatch"]] as const) {
      const refused = await runAdjudication(i, dir, `pin-${field}`, [], { authorization: testAdjudicationAuthorization({ [field]: "0".repeat(64) }) });
      assert.ok("refused" in refused && refused.reason === reason, field);
    }
    for (const [state, reason] of [["pending", "authorizationPending"], ["consumed", "authorizationConsumed"], ["retired", "authorizationRetired"]] as const) {
      const refused = await runAdjudication(i, dir, `state-${state}`, [], { authorization: testAdjudicationAuthorization({ state }) });
      assert.ok("refused" in refused && refused.reason === reason, state);
    }
    const nested = await runAdjudication(i, dir, "nested", [], { env: routeEnv({ CLAUDECODE: "1" }) });
    assert.ok("refused" in nested && nested.reason === "nestedAgentSession");
    assert.deepEqual(await readdir(dir).then(entries => entries.filter(e => /^(?:budget-|pin-|state-|nested$)/u.test(e) && !e.endsWith("-scripts"))), [],
      "a refusal creates no fixture, claim or evidence");
    // A second run under the same (claimed) authorization is refused before anything exists.
    const first = asAdjudicationRun(await runAdjudication(i, dir, "once", [TURN(fenced(EXPECTED))]));
    assert.equal(first.report.outcome, "PASS", first.report.detail);
    const again = await runAdjudication(i, dir, "once", [TURN(fenced(EXPECTED))]);
    assert.ok("refused" in again && again.reason === "alreadyAttempted");
  })));

test("O5.5B28 turn gate: only one adjudication, cycle 1; a plan, a change proposal, a review or a second adjudication never reaches the adapter", async () => {
  let reached = 0;
  const adapter = { runTurn: async () => { reached++; }, runChangeProposalTurn: async () => { reached++; },
    runStructuredTurn: async () => { reached++; return "reached"; }, close: async () => undefined } as unknown as ProviderAdapter;
  const gate = new AdjudicationTurnGate(ADJUDICATION_ONLY_TURNS.leadAdjudication);
  const wrapped = gate.wrap(adapter);
  const session = { id: "s" } as never;
  await assert.rejects(wrapped.runTurn(session, {} as never), /runs no runTurn/u);
  await assert.rejects(wrapped.runChangeProposalTurn!(session, {} as never), /runs no runChangeProposalTurn/u);
  await assert.rejects(wrapped.runStructuredTurn!(session, { kind: "review", cycle: 1 } as never), /runs no review turn/u);
  await assert.rejects(wrapped.runStructuredTurn!(session, { kind: "adjudication", cycle: 2 } as never), /cycle 2 is out of order/u);
  assert.equal(await wrapped.runStructuredTurn!(session, { kind: "adjudication", cycle: 1 } as never), "reached");
  await assert.rejects(wrapped.runStructuredTurn!(session, { kind: "adjudication", cycle: 2 } as never), /budget of 1 is exhausted/u);
  assert.deepEqual([reached, gate.used, gate.refusals.length], [1, 1, 5]);
});

test("O5.5B28 fixed finding set and binding: production findings from a Fusion-authored report; the route Lead's exact grant; the recorded envelope", () => {
  const findings = adjudicationProbeFindings("run-x");
  assert.deepEqual(findings.map(f => [f.id, f.severity, f.confidence, f.facts.length]), [["r1-F1", "MEDIUM", "MEDIUM", 0], ["r1-F2", "LOW", "HIGH", 0],
    ["r1-F3", "HIGH", "LOW", 1]]);
  assert.ok(findings.every(f => f.source.role === "Reviewer" && f.source.sessionId === FUSION_AUTHORED_REVIEW_SESSION && f.source.cycle === 1));
  assert.equal(adjudicationFindingsIdentity(), sha256(JSON.stringify(ADJUDICATION_REVIEW_REPORT)));
  assert.equal(adjudicationFindingsIdentity(), "905bd34b72eda2c6a371ab249eeafd44dd7b7109c50144141d1027978062eec0");
  // The report's claims are grounded in the fixture: F2's lines are the fixed function; F1 is answered by a committed test.
  const lines = QUOTE_FIXED.split("\n");
  assert.ok(lines[13]!.startsWith("/** Discounts reduce the taxable amount.") && lines[18]!.includes("const tax = basisPoints(subtotal - discount"));
  assert.ok(QUOTE_TEST.includes("applies the discount before tax") && QUOTE_TEST.includes("discountBasisPoints: 1000,"));
  // The binding: exactly the route Lead's grant (the Lead that plans and adjudicates in O5.5B25/O5.5B27).
  assert.equal(ROUTE_LEAD_ADJUDICATOR, ROUTE_REHEARSAL_PROFILES.authorizations["O5.5B27-LIVE"]!.roles.Lead);
  assert.deepEqual([ROUTE_LEAD_ADJUDICATOR.family, ROUTE_LEAD_ADJUDICATOR.executable, ROUTE_LEAD_ADJUDICATOR.runtimeVersions, ROUTE_LEAD_ADJUDICATOR.lanes,
    ROUTE_LEAD_ADJUDICATOR.binding, ROUTE_LEAD_ADJUDICATOR.turnArgs, ROUTE_LEAD_ADJUDICATOR.requiredEnvironment],
  ["claude", "claude.exe", ["2.1.280"], ["subscription", "subscriptionToken"], { adapter: "claude-one-shot", model: "haiku", effort: "low", maxTurns: 6,
    options: { canonicalModel: "claude-haiku-4-5-20251001", timeoutMs: 180_000 } }, [["--model", "haiku"], ["--effort", "low"], ["--max-turns", "6"]],
  ["FUSION_CLAUDE_EXE"]]);
  // The envelope and prompt are the production ones: the transport's recorded adjudication envelope, the unchanged core prompt.
  const request = adjudicationProbeRequest({} as ReviewEvidence, findings, { verification: new Map([["unit", true]]), changedPaths: [], allowedScope: [],
    claimedTests: [] });
  assert.equal(transportProfile("claude", "claude-one-shot")!.adjudicationEnvelope, "rawOrSingleJsonFence");
  assert.equal(structuredEnvelope(request).policy, "rawOrSingleJsonFence");
  assert.equal(claudeStructuredPrompt(request), structuredTurnPrompt(request));
});

test("O5.5B28 readiness: offline only — it opens no authorization; no live record, row, aggregate or gate moves", () => {
  // 12. O5.5B28 opened no live authorization; O5.5B29 (Stage 1) prepared exactly one, pinned in its own tests. Nothing else is open.
  assert.deepEqual(Object.keys(ADJUDICATION_PROBE_PROFILES.authorizations), ["O5.5B29-ADJUDICATION"]);
  assert.ok(Object.values(ROUTE_REHEARSAL_PROFILES.authorizations).every(entry => entry.state !== "open"));
  assert.ok(Object.entries(REVIEWER_PROBE_PROFILES.authorizations).filter(([id]) => id !== "V0.3-MUSE-R4302-REVIEWER").map(([, entry]) => entry).every(entry => entry.state !== "open"), "only the v0.3 Reviewer authorization may be open");
  assert.ok(Object.values(PROPOSAL_PROBE_PROFILES.authorizations).every(entry => entry.state === "consumed"));
  // 11. Fake evidence moves nothing: the rows stay where O5.5B27 left them; no adjudication record exists.
  assert.ok(fullRouteLiveRecords().every(record => record.adjudication !== "PASS"), "no live adjudication was ever recorded");
  const report = writerGateReport();
  const rows = Object.fromEntries(report.rows.map(row => [row.id, [row.state, row.evidenceKind]]));
  assert.deepEqual([rows.fullRouteLive, rows.hostControlledWriterWorkflow, rows.reviewAndAdjudication, rows.providerChangeProposal, rows.liveGateAuthorization],
    [["partial", "recordedLiveProbe"], ["satisfied", "recordedLiveProbe"], ["satisfied", "mechanical"], ["satisfied", "recordedLiveProbe"], ["blocked", "none"]]);
  // No route ran it; since O5.5B29 it is named as live only in isolation (pinned there).
  assert.match(report.rows.find(row => row.id === "hostControlledWriterWorkflow")!.remainingBlocker, /Never run live in a route: Lead adjudication of review findings/u);
  for (const input of ["CLAUDE_ADJUDICATION_LIVE: PASS", { adjudicationProbe: "PASS" }]) assert.deepEqual(writerGateReport({ linuxVerification: input }), report);
  assert.deepEqual([report.realWriterModeReady, REAL_WRITER_LIVE_GATE_AUTHORIZED], [false, false]);
});

test("O5.5B28 live entry: bad usage lists the (empty) authorizations and refuses before anything exists; never started with an identity",
  async () => withRoot(async dir => {
    const temp = join(dir, "temp");
    await mkdir(temp);
    const child = spawnSync(process.execPath, [resolve(process.cwd(), "dist/test/live/adjudication-probe.js")], { encoding: "utf8", timeout: 60_000,
      windowsHide: true, env: { SystemRoot: process.env.SystemRoot ?? "", PATH: process.env.PATH ?? "", TEMP: temp, TMP: temp, CLAUDECODE: "1" } });
    assert.equal(child.status, 2, child.stderr);
    // O5.5B28 listed none; O5.5B29 (Stage 1) added its authorization (pinned in its own tests).
    assert.match(child.stderr, /^Usage: node dist\/test\/live\/adjudication-probe\.js --authorization <id>\nAdjudication-only authorizations: O5\.5B29-ADJUDICATION \([a-z]+\)\n$/u);
    assert.deepEqual(await readdir(temp), []);
  }));
