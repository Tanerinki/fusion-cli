import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { FUSION_AUTHORED_REVIEW_SESSION } from "../src/app/adjudication-probe.js";
import { CORRECTION_ONLY_TURNS, correctionBoundary, CorrectionTurnGate } from "../src/app/correction-probe.js";
import { ADJUDICATION_REVIEW_REPORT, CORRECTION_ADJUDICATION_REPORT, correctionAdjudicationIdentity, QUOTE_BUGGY, QUOTE_FIXED, QUOTE_TEST,
  QUOTE_TEST_WITH_REGRESSION, REHEARSAL_PLAN, ROUTE_PACKET } from "../src/app/route-fixture.js";
import { REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport } from "../src/app/writer-gate.js";
import type { ChangeProposalRequest, Finding, ProviderAdapter, ReviewEvidence, ReviewRequest } from "../src/core/domain.js";
import { structuredTurnPrompt } from "../src/core/review/contract.js";
import { reviewEvidence } from "../src/core/review/policy.js";
import { FRESH_CANDIDATE_CONSTRAINT } from "../src/core/workflow/packets.js";
import { claudeStructuredPrompt } from "../src/providers/claude/one-shot-transport.js";
import { ADJUDICATION_PROBE_PROFILES, CORRECTION_PROBE_PROFILES, MUSE_1_4_REVIEWER, PROPOSAL_PROBE_PROFILES, REVIEWER_PROBE_PROFILES,
  ROUTE_CORRECTION_ROLES, ROUTE_REHEARSAL_PROFILES } from "../src/providers/probe-profiles.js";
import { adjudicationLiveRecords, fullRouteLiveRecords } from "../src/runtime/provider-profiles.js";
import { asCorrectionRun, evidenceOf, runCorrection, testCorrectionAuthorization } from "./fixtures/correction-harness.js";
import { changeSet } from "./fixtures/fake-writer.js";
import { withRoot } from "./fixtures/probe-harness.js";
import { withInstalls } from "./fixtures/provider-installs.js";
import { cleanReview, fenced, PREFIX, proposal, reviewWith, routeEnv, WORKER_SECRET } from "./fixtures/route-harness.js";
import { gitAvailable, WRONG } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5B30 — the review-driven correction branch, offline: the probe enters at the post-adjudication boundary (a
 * Fusion-owned starting candidate, the fixed cycle-1 findings and the O5.5B29 verdict labels), then the real one-shot
 * adapter code (corrective Change Author) and the real Exec adapter code (fresh re-Reviewer) on scripted fake binaries,
 * the real candidate port, view store and Docker backend. No provider, no authorization, no readiness change.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
/** The correction the confirmed finding asks for: the fix, the full-discount regression test and a partial-discount test. */
const PARTIAL = `test("a partial discount is taxed on the discounted subtotal", () => {
  assert.deepEqual(totals({ id: "Q-0004", items: [{ sku: "a", quantity: 4, unitCents: 2500 }], discountBasisPoints: 2500,
    taxBasisPoints: 1000 }), { subtotal: 10000, discount: 2500, tax: 750, total: 8250 });
});
`;
const CORRECTED = changeSet([["src/quote.ts", QUOTE_BUGGY, QUOTE_FIXED], ["test/quote.test.ts", QUOTE_TEST, `${QUOTE_TEST_WITH_REGRESSION}${PARTIAL}`]]);
type Launch = { purpose: string; phase: string; role: string | null; executable: string; executableIsAuthorized: boolean; cwdClass: string;
  posture?: { missing: string[]; widening: string[] }; identityGaps?: string[]; refusedBeforeStart?: string };
type Turn = { turn: Record<string, unknown> | null; structuredOutput: Record<string, unknown> | null; terminal: Record<string, unknown> | null;
  error?: { kind: string; safeMessage: string } };
const claimed = async (root: string) => (await readdir(root)).includes("correction.claim.json");
const ZERO = { providerAuthReadback: 0, providerInventory: 0, providerInitProbe: 0, providerTurn: 0, providerHost: 0 };
const OBSERVED = { verification: new Map(REHEARSAL_PLAN.commands.map(c => [c.id, true])), changedPaths: ["src/quote.ts", "test/quote.test.ts"],
  allowedScope: ["src/quote.ts", "test/quote.test.ts"], claimedTests: [] };
const BASELINE = [{ path: "src/quote.ts", sha256: sha256(QUOTE_BUGGY) }, { path: "test/quote.test.ts", sha256: sha256(QUOTE_TEST) }];
const claim = ({ source: _source, ...finding }: Finding) => finding;

test("O5.5B30 happy path (fake): correction Author -> host apply -> verify -> fresh re-review clean; entered at the post-adjudication boundary",
  { skip }, async () => withInstalls(async i => withRoot(async dir => {
    const run = asCorrectionRun(await runCorrection(i, dir, "pass", { Worker: [proposal(CORRECTED)], Reviewer: [{ prefix: PREFIX.review, output: cleanReview }] }));
    assert.equal(run.report.outcome, "PASS", run.report.detail);
    assert.deepEqual([run.report.modelTurns, run.report.evidence.stage, run.report.evidence.evidenceKind], [2, "correction", "offlineRehearsal"]);
    assert.ok(await claimed(run.root));
    // 1. The boundary: the starting candidate verified, cycle 1 adjudicated, the policy's decision a correction of r1-F1.
    const boundary = evidenceOf<Record<string, unknown>>(run, "boundary");
    assert.deepEqual(boundary.decision, { kind: "correction", findings: ["r1-F1"] });
    assert.deepEqual(boundary.adjudicationCycle1, [
      { findingId: "r1-F1", verdict: "CONFIRMED", requiredAction: "fix", verdictSource: "lead", outstanding: true },
      { findingId: "r1-F2", verdict: "CONFIRMED", requiredAction: "fix", verdictSource: "lead", outstanding: false },
      { findingId: "r1-F3", verdict: "REJECTED", requiredAction: "none", verdictSource: "lead", outstanding: false }]);
    assert.deepEqual([boundary.retry, boundary.priorFindings], [{ attempt: 2, limit: 2, freshCandidate: true, findings: ["r1-F1"] }, ["r1-F1"]]);
    assert.equal(evidenceOf<{ passed: boolean }>(run, "startingVerification").passed, true);
    // 2./15. Exactly two model turns: the corrective Change Author, then the re-review; no Lead, no initial author or review.
    assert.deepEqual(evidenceOf<Record<string, number>>(run, "turnUse"), { leadPlan: 0, changeAuthor: 1, freshReview: 1, leadAdjudication: 0 });
    assert.deepEqual(evidenceOf<Record<string, unknown>>(run, "launchCounts"), {
      Worker: { providerAuthReadback: 2, providerInventory: 1, providerInitProbe: 2, providerTurn: 1, providerHost: 0 },
      Reviewer: { ...ZERO, providerTurn: 1, providerHost: 1 } });
    const launches = evidenceOf<Launch[]>(run, "launches");
    assert.ok(launches.every(l => l.executableIsAuthorized && l.refusedBeforeStart === undefined), JSON.stringify(launches));
    assert.ok(!launches.some(l => l.phase === "preflight" || l.phase === "boundary" || l.phase === "fusion"), "no provider process before the boundary or between turns");
    assert.deepEqual(launches.filter(l => l.phase === "authorSession").map(l => [l.role, l.purpose]), [["Worker", "providerAuthReadback"]]);
    assert.ok(launches.filter(l => l.role === "Worker").every(l => l.cwdClass === "providerView:baseline"), "the Change Author reads the baseline");
    assert.ok(launches.filter(l => l.role === "Reviewer").every(l => l.phase === "rereview"), "the Reviewer starts only after verification");
    assert.deepEqual(launches.filter(l => l.purpose === "providerTurn").map(l => [l.role, l.phase, l.cwdClass, l.identityGaps, l.posture]), [
      ["Worker", "authorTurn", "providerView:baseline", [], { missing: [], widening: [] }],
      ["Reviewer", "rereview", "providerView:candidate", [], { missing: [], widening: [] }]]);
    assert.deepEqual(evidenceOf<{ turns: unknown[]; launches: unknown[] }>(run, "refusals"), { turns: [], launches: [] });
    // 6./7. The production ChangeSet contract and envelope; host application into the fresh private candidate only.
    const author = evidenceOf<Turn & { proposal: Record<string, unknown> }>(run, "correctionAuthor");
    assert.deepEqual(author.proposal, { outcome: "validated", operations: 2, paths: ["src/quote.ts", "test/quote.test.ts"] });
    assert.deepEqual([author.structuredOutput?.classification, author.structuredOutput?.accepted, author.structuredOutput?.policy],
      ["SINGLE_FENCED_VALID_JSON", true, "rawOrSingleJsonFence"]);
    assert.deepEqual([author.turn?.requestedModel, author.turn?.observedModel, author.turn?.effort, author.turn?.maxTurns],
      ["haiku", "claude-haiku-4-5-20251001", "low", 6]);
    assert.deepEqual(evidenceOf<Array<{ path: string; beforeSha256: string; afterSha256: string }>>(run, "application").map(a => [a.path, a.beforeSha256, a.afterSha256]), [
      ["src/quote.ts", sha256(QUOTE_BUGGY), sha256(QUOTE_FIXED)], ["test/quote.test.ts", sha256(QUOTE_TEST), sha256(`${QUOTE_TEST_WITH_REGRESSION}${PARTIAL}`)]]);
    // 8. Verification passed before the re-review started.
    assert.deepEqual([evidenceOf<Record<string, unknown>>(run, "correctionVerification").passed, evidenceOf<Record<string, unknown>>(run, "correctionVerification").commandsRun],
      [true, 2]);
    // 10./11./13. A NEW Reviewer session in a NEW view of the corrected candidate; a clean re-review completes the branch.
    const rereview = evidenceOf<Turn & { contract: string; decision: unknown; request: Record<string, unknown> }>(run, "rereview");
    assert.deepEqual([rereview.contract, rereview.decision], ["accepted:0 finding(s)", { kind: "clean" }]);
    assert.deepEqual([rereview.structuredOutput?.classification, rereview.structuredOutput?.policy, rereview.turn?.observedModel],
      ["RAW_VALID_JSON", "rawOnly", "muse-spark-1.3"]);
    assert.deepEqual([rereview.request.cycle, rereview.request.priorFindings, rereview.request.changedPaths], [2, ["r1-F1"], ["src/quote.ts", "test/quote.test.ts"]]);
    assert.deepEqual(evidenceOf<unknown[]>(run, "sessions"), [{ role: "Worker", viewKind: "baseline" }, { role: "Reviewer", viewKind: "candidate" }]);
    assert.deepEqual(evidenceOf<Array<{ kind: string; unchanged: boolean; released: unknown }>>(run, "views").map(v => [v.kind, v.unchanged, v.released]),
      [["baseline", true, { complete: true }], ["candidate", true, { complete: true }]]);
    assert.deepEqual(evidenceOf<Record<string, boolean>>(run, "integrity"), { viewsUnchanged: true, candidateUnchanged: true, primaryUnchanged: true });
    assert.deepEqual(evidenceOf<Record<string, unknown>>(run, "executableIdentityAfter"), { Reviewer: { sha256Matches: true } });
    const cleanup = evidenceOf<{ leftoverOwnedTemporaries: string[]; released: Record<string, unknown> }>(run, "cleanup");
    assert.deepEqual([cleanup.leftoverOwnedTemporaries, cleanup.released], [[], { startingCandidate: { complete: true }, WorkerSession: "closed",
      ReviewerSession: "closed", views: [{ complete: true }, { complete: true }], correctedCandidate: { complete: true } }]);

    // 3./4./5. The Change Author's prompt: exactly the production correction request — only the confirmed outstanding finding.
    const request: ChangeProposalRequest = { kind: "changeProposal", packet: correctionBoundary("x", OBSERVED).packet, baseline: BASELINE };
    assert.equal(run.prompts.Worker.length, 1);
    const authorPrompt = run.prompts.Worker[0]!;
    assert.equal(authorPrompt, claudeStructuredPrompt(request), "the production Change Author prompt, schema and reply rule");
    assert.ok(authorPrompt.includes("Attempt 2 of 2: Fusion review confirmed 1 finding(s) to fix.") && authorPrompt.includes(FRESH_CANDIDATE_CONSTRAINT));
    assert.ok(authorPrompt.includes("Fix r1-F1 [MEDIUM] No test covers a partial discount (test/quote.test.ts). Suggested fix: Add a test with a partial discount."));
    for (const hidden of ["r1-F2", "r1-F3", "The unit tests fail after the change", "The doc comment does not state the rounding order", "Fusion placeholder",
      ADJUDICATION_REVIEW_REPORT.summary, FUSION_AUTHORED_REVIEW_SESSION, "Fusion adjudication.", "Fusion fresh review.", "planning Lead", "Lead plan:"])
      assert.ok(!authorPrompt.includes(hidden), `the correction prompt must not carry ${hidden}`);
    // 11./12. The re-review's prompt: the production review of the corrected candidate, the prior finding; no Worker text.
    assert.equal(run.prompts.Reviewer.length, 1);
    const reviewPrompt = run.prompts.Reviewer[0]!;
    const line = reviewPrompt.split("\n").find(l => l.startsWith("Evidence (data): "))!;
    const sent = JSON.parse(line.slice("Evidence (data): ".length)) as ReviewEvidence;
    const evidence = reviewEvidence(ROUTE_PACKET, { required: true, passed: true, commands: REHEARSAL_PLAN.commands.map(c => ({ id: c.id, passed: true })) },
      { kind: "diff", changedPaths: ["src/quote.ts", "test/quote.test.ts"], text: sent.change.text, truncated: false });
    assert.deepEqual(sent, evidence, "production review evidence of the corrected candidate");
    const review: ReviewRequest = { kind: "review", cycle: 2, evidence, priorFindings: correctionBoundary("x", OBSERVED).priorFindings, limits: { maxFindings: 32 } };
    assert.ok(reviewPrompt.startsWith(structuredTurnPrompt(review).split("\n")[0]!));
    assert.ok(reviewPrompt.includes(`Previous findings (data): ${JSON.stringify(correctionBoundary("x", OBSERVED).priorFindings.map(claim))}`));
    assert.ok(sent.change.text.includes("a partial discount is taxed on the discounted subtotal"), "the corrected diff");
    for (const hidden of [WORKER_SECRET, "Fix r1-F1", "Fusion placeholder", "r1-F2", "r1-F3", FUSION_AUTHORED_REVIEW_SESSION])
      assert.ok(!reviewPrompt.includes(hidden), `the re-review prompt must not carry ${hidden}`);
    const text = await readFile(run.report.evidencePath, "utf8");
    for (const secret of [WORKER_SECRET, "Fusion placeholder", "```", "partial discount is taxed"]) assert.ok(!text.includes(secret), `evidence leaks ${secret}`);
  })));

test("O5.5B30 failure (fake): correction Author -> verification fails -> no re-review, no Reviewer process at all", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    const run = asCorrectionRun(await runCorrection(i, dir, "fails", { Worker: [proposal(WRONG)], Reviewer: [{ prefix: PREFIX.review, output: cleanReview }] }));
    assert.deepEqual([run.report.outcome, run.report.modelTurns], ["VERIFICATION_FAILED", 1]);
    assert.match(run.report.detail, /^verification: .*corrected candidate did not pass; attempts are exhausted and no re-review runs/u);
    assert.ok(await claimed(run.root), "consumed");
    assert.equal(evidenceOf<{ passed: boolean }>(run, "correctionVerification").passed, false);
    assert.deepEqual(evidenceOf<Record<string, unknown>>(run, "launchCounts").Reviewer, ZERO, "the Reviewer never started");
    assert.deepEqual(evidenceOf<Record<string, number>>(run, "turnUse"), { leadPlan: 0, changeAuthor: 1, freshReview: 0, leadAdjudication: 0 });
    assert.equal(run.prompts.Reviewer.length, 0);
    assert.deepEqual(evidenceOf<{ request: unknown; turn: unknown }>(run, "rereview").request, null);
    assert.deepEqual(evidenceOf<Record<string, boolean>>(run, "integrity"), { viewsUnchanged: true, candidateUnchanged: true, primaryUnchanged: true });
    assert.deepEqual(evidenceOf<{ leftoverOwnedTemporaries: string[] }>(run, "cleanup").leftoverOwnedTemporaries, []);
  })));

test("O5.5B30 refused ChangeSets (fake): prose around the fence and an out-of-scope file end the branch before any re-review", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    const prose = asCorrectionRun(await runCorrection(i, dir, "prose", { Worker: [{ prefix: PREFIX.proposal, output: `Here is the fix:\n${fenced(CORRECTED)}` }],
      Reviewer: [{ prefix: PREFIX.review, output: cleanReview }] }));
    assert.deepEqual([prose.report.outcome, prose.report.modelTurns], ["MALFORMED_OUTPUT", 1]);
    assert.match(prose.report.detail, /^correctionAuthor: /u);
    assert.deepEqual(evidenceOf<Turn>(prose, "correctionAuthor").structuredOutput?.classification, "EXTRA_TEXT");
    const scope = changeSet([["src/quote.ts", QUOTE_BUGGY, QUOTE_FIXED], ["package.json", null, "{}\n"]]);
    const outside = asCorrectionRun(await runCorrection(i, dir, "scope", { Worker: [proposal(scope)], Reviewer: [{ prefix: PREFIX.review, output: cleanReview }] }));
    assert.deepEqual([outside.report.outcome, outside.report.modelTurns], ["INVALID_CHANGESET", 1]);
    for (const run of [prose, outside]) {
      assert.deepEqual(evidenceOf<Record<string, unknown>>(run, "launchCounts").Reviewer, ZERO);
      assert.equal(evidenceOf<unknown>(run, "application"), null, "nothing was applied");
      assert.deepEqual(evidenceOf<Record<string, boolean>>(run, "integrity").primaryUnchanged, true);
    }
  })));

test("O5.5B30 re-review findings (fake) follow the bounded policy: recorded, no cycle-2 adjudication, no further correction", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    const run = asCorrectionRun(await runCorrection(i, dir, "findings", { Worker: [proposal(CORRECTED)],
      Reviewer: [{ prefix: PREFIX.review, output: reviewWith({ id: "F1", severity: "MEDIUM", title: "The partial discount test rounds differently" }) }] }));
    assert.deepEqual([run.report.outcome, run.report.modelTurns], ["REREVIEW_FINDINGS", 2]);
    assert.match(run.report.detail, /cycle-2 Lead adjudication, which this probe never runs, and no further correction is available/u);
    const rereview = evidenceOf<{ contract: string; findings: unknown; decision: unknown }>(run, "rereview");
    assert.deepEqual([rereview.contract, rereview.findings, rereview.decision], ["accepted:1 finding(s)",
      { count: 1, bySeverity: { MEDIUM: 1 }, byConfidence: { HIGH: 1 } }, { kind: "adjudicationRequired", cycle: 2, authorized: false }]);
    assert.deepEqual(evidenceOf<Record<string, number>>(run, "turnUse"), { leadPlan: 0, changeAuthor: 1, freshReview: 1, leadAdjudication: 0 });
    assert.deepEqual(evidenceOf<Record<string, boolean>>(run, "integrity"), { viewsUnchanged: true, candidateUnchanged: true, primaryUnchanged: true });
  })));

test("O5.5B30 turn gate: one correction proposal; one re-review, cycle 2, only after verification; nothing else reaches a provider", async () => {
  let reached = 0;
  const adapter = { runTurn: async () => { reached++; }, runChangeProposalTurn: async () => { reached++; return "proposal"; },
    runStructuredTurn: async () => { reached++; return "review"; }, close: async () => undefined } as unknown as ProviderAdapter;
  const gate = new CorrectionTurnGate(CORRECTION_ONLY_TURNS);
  const worker = gate.wrap("Worker", adapter), reviewer = gate.wrap("Reviewer", adapter);
  const session = { id: "s" } as never;
  await assert.rejects(worker.runTurn(session, {} as never), /corrective Change Author runs no runTurn/u);
  await assert.rejects(worker.runStructuredTurn!(session, { kind: "review", cycle: 2 } as never), /runs no runStructuredTurn/u);
  assert.equal(await worker.runChangeProposalTurn!(session, {} as never), "proposal");
  await assert.rejects(worker.runChangeProposalTurn!(session, {} as never), /changeAuthor budget of 1 is exhausted/u);
  await assert.rejects(reviewer.runStructuredTurn!(session, { kind: "adjudication", cycle: 2 } as never), /runs no adjudication turn/u);
  await assert.rejects(reviewer.runStructuredTurn!(session, { kind: "review", cycle: 1 } as never), /cycle 1 is not the re-review/u);
  await assert.rejects(reviewer.runStructuredTurn!(session, { kind: "review", cycle: 2 } as never), /only after the corrected candidate's verification passed/u);
  await assert.rejects(reviewer.runChangeProposalTurn!(session, {} as never), /runs no runChangeProposalTurn turn/u);
  gate.verified = true;
  assert.equal(await reviewer.runStructuredTurn!(session, { kind: "review", cycle: 2 } as never), "review");
  await assert.rejects(reviewer.runStructuredTurn!(session, { kind: "review", cycle: 2 } as never), /freshReview budget of 1 is exhausted/u);
  assert.deepEqual([reached, gate.used, gate.refusals.length], [2, { changeAuthor: 1, freshReview: 1 }, 8]);
});

test("O5.5B30 bounds: exact bindings in preflight; the two-turn budget; pinned fixture, candidate, findings and adjudication; never nested",
  { skip }, async () => withInstalls(async i => withRoot(async dir => {
    const scripts = { Worker: [proposal(CORRECTED)], Reviewer: [{ prefix: PREFIX.review, output: cleanReview }] };
    for (const [name, bindings, role, field] of [["effort", { Worker: { effort: "medium" } }, "Worker", "effort"],
      ["turns", { Worker: { maxTurns: 3 } }, "Worker", "maxTurns"], ["steps", { Reviewer: { options: { maxModelSteps: 8 } } }, "Reviewer", "options.maxModelSteps"]] as const) {
      const run = asCorrectionRun(await runCorrection(i, dir, `binding-${name}`, scripts, { bindings }));
      assert.deepEqual([run.report.outcome, run.report.evidence.stage, run.report.modelTurns], ["MODEL_BLOCKED", "preflight", 0], name);
      assert.deepEqual((evidenceOf<Record<string, { bindingMismatches: string[] }>>(run, "preflight")[role]!).bindingMismatches, [field], name);
      assert.equal(await claimed(run.root), false);
    }
    const bytes = asCorrectionRun(await runCorrection(i, dir, "bytes", scripts, { authorization: await testCorrectionAuthorization(i, {}, { Reviewer: { executableSha256: "0".repeat(64) } }) }));
    assert.deepEqual([bytes.report.outcome, bytes.report.modelTurns], ["VERSION_BLOCKED", 0]);
    assert.match(bytes.report.detail, /Reviewer: the executable's SHA-256 differs from the authorized one/u);
    for (const [name, turns] of [["plan", { ...CORRECTION_ONLY_TURNS, leadPlan: 1 }], ["adjudication", { ...CORRECTION_ONLY_TURNS, leadAdjudication: 1 }],
      ["two-authors", { ...CORRECTION_ONLY_TURNS, changeAuthor: 2 }], ["two-reviews", { ...CORRECTION_ONLY_TURNS, freshReview: 2 }],
      ["no-review", { ...CORRECTION_ONLY_TURNS, freshReview: 0 }]] as const) {
      const refused = await runCorrection(i, dir, `budget-${name}`, {}, { authorization: await testCorrectionAuthorization(i, { turns }) });
      assert.ok("refused" in refused && refused.reason === "budgetNotCorrectionOnly", name);
    }
    for (const [field, reason] of [["fixtureSha256", "fixtureMismatch"], ["candidateSha256", "candidateMismatch"], ["findingsSha256", "findingsMismatch"],
      ["adjudicationSha256", "adjudicationMismatch"]] as const) {
      const refused = await runCorrection(i, dir, `pin-${field}`, {}, { authorization: await testCorrectionAuthorization(i, { [field]: "0".repeat(64) }) });
      assert.ok("refused" in refused && refused.reason === reason, field);
    }
    for (const [state, reason] of [["pending", "authorizationPending"], ["consumed", "authorizationConsumed"], ["retired", "authorizationRetired"]] as const) {
      const refused = await runCorrection(i, dir, `state-${state}`, {}, { authorization: await testCorrectionAuthorization(i, { state }) });
      assert.ok("refused" in refused && refused.reason === reason, state);
    }
    const nested = await runCorrection(i, dir, "nested", {}, { env: routeEnv({ CLAUDECODE: "1" }) });
    assert.ok("refused" in nested && nested.reason === "nestedAgentSession");
    assert.deepEqual((await readdir(dir)).filter(e => /^(?:budget-|pin-|state-|nested$)/u.test(e) && !e.endsWith("-scripts")), [], "refusals create nothing");
  })));

test("O5.5B30 boundary: the O5.5B29 labels through the production contract and policy send back only r1-F1; rejected and LOW findings are never corrections", () => {
  const boundary = correctionBoundary("run-x", OBSERVED);
  assert.deepEqual(boundary.findings.map(f => f.id), ["r1-F1", "r1-F2", "r1-F3"]);
  assert.deepEqual(boundary.adjudicated.map(a => [a.finding.id, a.verdict, a.requiredAction, a.verdictSource]),
    [["r1-F1", "CONFIRMED", "fix", "lead"], ["r1-F2", "CONFIRMED", "fix", "lead"], ["r1-F3", "REJECTED", "none", "lead"]]);
  assert.deepEqual(boundary.decision.kind === "correction" ? boundary.decision.findings.map(f => f.id) : boundary.decision.kind, ["r1-F1"]);
  assert.deepEqual([boundary.retry.attempt, boundary.retry.limit, boundary.retry.freshCandidate, (boundary.retry.findings ?? []).map(f => f.id)], [2, 2, true, ["r1-F1"]]);
  assert.deepEqual(boundary.priorFindings.map(f => f.id), ["r1-F1"]);
  const constraints = boundary.packet.task.constraints;
  assert.deepEqual(constraints.slice(-3), ["Attempt 2 of 2: Fusion review confirmed 1 finding(s) to fix.", FRESH_CANDIDATE_CONSTRAINT,
    "Fix r1-F1 [MEDIUM] No test covers a partial discount (test/quote.test.ts). Suggested fix: Add a test with a partial discount."]);
  assert.ok(!JSON.stringify(boundary.packet).includes("Fusion placeholder") && !JSON.stringify(boundary.packet).includes("r1-F3"));
  // The labels are exactly the recorded O5.5B29 live verdicts; the rationales are Fusion placeholders.
  assert.deepEqual(CORRECTION_ADJUDICATION_REPORT.adjudications.map(a => [a.findingId, a.verdict, a.requiredAction]),
    adjudicationLiveRecords()[0]!.verdicts.map(v => [v.findingId, v.verdict, v.requiredAction]));
  assert.deepEqual(adjudicationLiveRecords()[0]!.decision.findings, ["r1-F1"], "the live decision matches the boundary's");
  assert.equal(correctionAdjudicationIdentity(), sha256(JSON.stringify(CORRECTION_ADJUDICATION_REPORT)));
  assert.equal(correctionAdjudicationIdentity(), "cf8a04023d2853ba0d761a13ddf0538b59004d4f69d639901e67483f85db0aa7");
});

test("O5.5B30 readiness: offline only — it opens no authorization; no live record, row, aggregate or gate moves; the exact route roles", () => {
  // O5.5B30 opened none; O5.5B31 (Stage 1) prepared exactly one, pinned in its own tests.
  assert.deepEqual(Object.keys(CORRECTION_PROBE_PROFILES.authorizations), ["O5.5B31-CORRECTION"]);
  // v0.3 opened exactly one Reviewer authorization (Muse 1.4.0-R4302.1), pinned in its own tests: the single named exception.
  for (const set of [ROUTE_REHEARSAL_PROFILES, REVIEWER_PROBE_PROFILES, ADJUDICATION_PROBE_PROFILES, PROPOSAL_PROBE_PROFILES])
    assert.ok(Object.entries(set.authorizations).filter(([id]) => id !== "V0.3-MUSE-R4302-REVIEWER").every(([, entry]) => entry.state !== "open"));
  const route = ROUTE_REHEARSAL_PROFILES.authorizations["O5.5B27-LIVE"]!.roles;
  assert.equal(ROUTE_CORRECTION_ROLES.Worker, route.Worker, "the route Change Author's grant object");
  assert.equal(ROUTE_CORRECTION_ROLES.Reviewer, route.Reviewer);
  assert.equal(ROUTE_CORRECTION_ROLES.Reviewer, MUSE_1_4_REVIEWER, "the O5.5B24-validated Muse 1.4 Reviewer");
  assert.deepEqual([ROUTE_CORRECTION_ROLES.Worker.runtimeVersions, ROUTE_CORRECTION_ROLES.Worker.binding, ROUTE_CORRECTION_ROLES.Worker.turnArgs], [["2.1.280"],
    { adapter: "claude-one-shot", model: "haiku", effort: "low", maxTurns: 6, options: { canonicalModel: "claude-haiku-4-5-20251001", timeoutMs: 180_000 } },
    [["--model", "haiku"], ["--effort", "low"], ["--max-turns", "6"]]]);
  assert.deepEqual([MUSE_1_4_REVIEWER.runtimeVersions, MUSE_1_4_REVIEWER.executableSha256, MUSE_1_4_REVIEWER.binding], [["1.4.0-R4161.1"],
    "b33b493069a2593e97cc63f9a4063feb64269bf7f07a233f5db2db681ad5d950", { adapter: "muse-exec", model: "muse-spark-1.3", effort: "low",
      options: { provider: "meta", maxModelSteps: 4, malformedOutputRetries: 0, timeoutMs: 180_000 } }]);
  assert.ok(fullRouteLiveRecords().every(record => record.correction !== "PASS"));
  const report = writerGateReport();
  const rows = Object.fromEntries(report.rows.map(row => [row.id, [row.state, row.evidenceKind]]));
  assert.deepEqual([rows.fullRouteLive, rows.hostControlledWriterWorkflow, rows.reviewAndAdjudication, rows.liveGateAuthorization],
    [["partial", "recordedLiveProbe"], ["satisfied", "recordedLiveProbe"], ["satisfied", "mechanical"], ["blocked", "none"]]);
  // Since O5.5B31 the correction branch is named as live only in isolation (pinned there).
  assert.match(report.rows.find(row => row.id === "hostControlledWriterWorkflow")!.remainingBlocker, /; review-driven correction and re-review[ ;(]/u);
  for (const input of ["REVIEW_DRIVEN_CORRECTION_LIVE: PASS", { correctionProbe: "PASS" }]) assert.deepEqual(writerGateReport({ linuxVerification: input }), report);
  assert.deepEqual([report.realWriterModeReady, REAL_WRITER_LIVE_GATE_AUTHORIZED], [false, false]);
});

test("O5.5B30 live entry: bad usage lists the (empty) authorizations and refuses before anything exists; never started with an identity",
  async () => withRoot(async dir => {
    const temp = join(dir, "temp");
    await mkdir(temp);
    const child = spawnSync(process.execPath, [resolve(process.cwd(), "dist/test/live/correction-probe.js")], { encoding: "utf8", timeout: 60_000,
      windowsHide: true, env: { SystemRoot: process.env.SystemRoot ?? "", PATH: process.env.PATH ?? "", TEMP: temp, TMP: temp, CLAUDECODE: "1" } });
    assert.equal(child.status, 2, child.stderr);
    // O5.5B30 listed none; O5.5B31 (Stage 1) added its authorization (pinned in its own tests).
    assert.match(child.stderr, /^Usage: node dist\/test\/live\/correction-probe\.js --authorization <id>\nCorrection-only authorizations: O5\.5B31-CORRECTION \([a-z]+\)\n$/u);
    assert.deepEqual(await readdir(temp), []);
  }));
