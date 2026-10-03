import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { classifyCorrectionProbe, CORRECTION_ONLY_TURNS, runCorrectionProbe, type CorrectionProbeFacts } from "../src/app/correction-probe.js";
import { adjudicationFindingsIdentity, correctionAdjudicationIdentity, QUOTE_BUGGY, QUOTE_FIXED, QUOTE_TEST, QUOTE_TEST_WITH_REGRESSION,
  reviewCandidateIdentity } from "../src/app/route-fixture.js";
import { routeFixtureIdentity } from "../src/app/route-probe.js";
import { liveWriterAuthorization, REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport, writerReadiness } from "../src/app/writer-gate.js";
import { ADJUDICATION_PROBE_PROFILES, CORRECTION_PROBE_PROFILES, MUSE_1_4_REVIEWER, PROPOSAL_PROBE_PROFILES, REVIEWER_PROBE_PROFILES,
  ROUTE_CORRECTION_ROLES, ROUTE_REHEARSAL_PROFILES } from "../src/providers/probe-profiles.js";
import { defaultRegistry } from "../src/providers/registry.js";
import { correctionLiveRecords, fullRouteLiveRecords } from "../src/runtime/provider-profiles.js";
import { asCorrectionRun, evidenceOf, runCorrection, testCorrectionRoles } from "./fixtures/correction-harness.js";
import { changeSet } from "./fixtures/fake-writer.js";
import { withRoot } from "./fixtures/probe-harness.js";
import { withInstalls } from "./fixtures/provider-installs.js";
import { cleanReview, PREFIX, proposal, routeEnv, WORKER_SECRET } from "./fixtures/route-harness.js";
import { gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5B31 — ONE authorized live review-correction rehearsal. Stage 1 prepared `O5.5B31-CORRECTION` (exactly the O5.5B30
 * probe with the route's own role grants — Claude Change Author, the validated Muse 1.4 Reviewer — at most one corrective
 * Change Author turn and one fresh re-review, the pinned fixture, starting candidate, finding set and O5.5B29 adjudication
 * labels, its own namespace); the human ran it once (REREVIEW_FINDINGS). Stage 2 records the independently validated
 * result and the readiness reassessment. No test ever calls a provider.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const ID = "O5.5B31-CORRECTION";
const B31 = CORRECTION_PROBE_PROFILES.authorizations[ID]!;
const PARTIAL = `test("a partial discount is taxed on the discounted subtotal", () => {
  assert.deepEqual(totals({ id: "Q-0004", items: [{ sku: "a", quantity: 4, unitCents: 2500 }], discountBasisPoints: 2500,
    taxBasisPoints: 1000 }), { subtotal: 10000, discount: 2500, tax: 750, total: 8250 });
});
`;
const CORRECTED = changeSet([["src/quote.ts", QUOTE_BUGGY, QUOTE_FIXED], ["test/quote.test.ts", QUOTE_TEST, `${QUOTE_TEST_WITH_REGRESSION}${PARTIAL}`]]);

test("O5.5B31 authorization: consumed, one correction and one re-review, the route's exact roles, the pinned inputs, its own namespace", () => {
  assert.deepEqual([B31.milestone, B31.evidenceDirectory, B31.state], ["O5.5B31", "fusion-o5-5b31-correction", "consumed"]);
  // Exact two-turn maximum: one corrective Change Author turn, one fresh re-review; no plan, no adjudication.
  assert.deepEqual({ ...B31.turns }, { leadPlan: 0, changeAuthor: 1, freshReview: 1, leadAdjudication: 0 });
  assert.deepEqual({ ...B31.turns }, { ...CORRECTION_ONLY_TURNS });
  assert.equal(B31.roles, ROUTE_CORRECTION_ROLES, "the route's own grant objects");
  assert.deepEqual(Object.keys(B31.roles), ["Worker", "Reviewer"], "no Lead role: it can never start");
  // The exact bindings.
  assert.deepEqual([B31.roles.Worker.family, B31.roles.Worker.executable, B31.roles.Worker.runtimeVersions, B31.roles.Worker.lanes, B31.roles.Worker.binding,
    B31.roles.Worker.turnArgs, B31.roles.Worker.requiredEnvironment], ["claude", "claude.exe", ["2.1.280"], ["subscription", "subscriptionToken"],
    { adapter: "claude-one-shot", model: "haiku", effort: "low", maxTurns: 6, options: { canonicalModel: "claude-haiku-4-5-20251001", timeoutMs: 180_000 } },
    [["--model", "haiku"], ["--effort", "low"], ["--max-turns", "6"]], ["FUSION_CLAUDE_EXE"]]);
  assert.equal(B31.roles.Reviewer, MUSE_1_4_REVIEWER);
  assert.deepEqual([B31.roles.Reviewer.executable, B31.roles.Reviewer.executableDirectory, B31.roles.Reviewer.executableSha256, B31.roles.Reviewer.runtimeVersions,
    B31.roles.Reviewer.lanes, B31.roles.Reviewer.binding, B31.roles.Reviewer.turnArgs], ["muse-bin-1.4.0-R4161.1.exe", "%LOCALAPPDATA%/Programs/muse",
    "b33b493069a2593e97cc63f9a4063feb64269bf7f07a233f5db2db681ad5d950", ["1.4.0-R4161.1"], ["subscription"],
    { adapter: "muse-exec", model: "muse-spark-1.3", effort: "low", options: { provider: "meta", maxModelSteps: 4, malformedOutputRetries: 0, timeoutMs: 180_000 } },
    [["--provider", "meta"], ["--model", "muse-spark-1.3"], ["--reasoning-effort", "low"], ["--max-model-steps", "4"]]]);
  // No fallback and no retry: no fallback option; the fallback flag is widening (refused); the Reviewer's retries are 0.
  for (const role of ["Worker", "Reviewer"] as const) assert.ok(!Object.keys(B31.roles[role].binding.options ?? {}).some(key => /fallback/iu.test(key)));
  assert.ok(PROPOSAL_PROBE_PROFILES.profiles.claude!.turnPosture.widening.includes("--fallback-model"));
  assert.equal(B31.roles.Reviewer.binding.options?.malformedOutputRetries, 0);
  // The pinned inputs.
  assert.deepEqual([B31.fixtureSha256, B31.candidateSha256, B31.findingsSha256, B31.adjudicationSha256],
    [routeFixtureIdentity(), reviewCandidateIdentity(), adjudicationFindingsIdentity(), correctionAdjudicationIdentity()]);
  assert.deepEqual([B31.fixtureSha256, B31.candidateSha256, B31.findingsSha256, B31.adjudicationSha256], [
    "59c19d1f876f944410d0e3bee5a7d390770380993a563a978231e5355b938326", "a8e6622d5a41356aac23fce1327d3873cc7ce19d7bebcca8a210ab4245824952",
    "905bd34b72eda2c6a371ab249eeafd44dd7b7109c50144141d1027978062eec0", "cf8a04023d2853ba0d761a13ddf0538b59004d4f69d639901e67483f85db0aa7"]);
  // Stage 1 prepared it open; it ran once live (Stage 2): consumed. Nothing is open anywhere; its namespace is its own.
  assert.deepEqual(Object.entries(CORRECTION_PROBE_PROFILES.authorizations).map(([id, entry]) => [id, entry.state]), [[ID, "consumed"]]);
  for (const set of [ROUTE_REHEARSAL_PROFILES, REVIEWER_PROBE_PROFILES, ADJUDICATION_PROBE_PROFILES, PROPOSAL_PROBE_PROFILES])
    assert.ok(Object.values(set.authorizations).every(entry => entry.state !== "open"));
  const others = [ROUTE_REHEARSAL_PROFILES, REVIEWER_PROBE_PROFILES, ADJUDICATION_PROBE_PROFILES, PROPOSAL_PROBE_PROFILES]
    .flatMap(set => Object.values(set.authorizations).map(entry => entry.evidenceDirectory));
  assert.ok(!others.includes(B31.evidenceDirectory));
});

test("O5.5B31 is never run by a test: consumed it refuses before anything exists; open, it refused inside an agent session (no provider call)",
  async () => withRoot(async dir => {
  const consumed = await runCorrectionProbe({ env: routeEnv(), registry: defaultRegistry(), profiles: CORRECTION_PROBE_PROFILES,
    authorization: ID, evidenceRoot: join(dir, "never-created") });
  assert.ok("refused" in consumed && consumed.reason === "authorizationConsumed", JSON.stringify(consumed));
  const refused = await runCorrectionProbe({ env: routeEnv({ CLAUDECODE: "1" }), registry: defaultRegistry(), authorization: ID,
    profiles: { ...CORRECTION_PROBE_PROFILES, authorizations: { [ID]: { ...B31, state: "open" } } }, evidenceRoot: join(dir, "never-created") });
  assert.ok("refused" in refused && refused.reason === "nestedAgentSession", JSON.stringify(refused));
  assert.deepEqual(await readdir(dir), []);
}));

test("O5.5B31 plan offline (fake): exactly the authorized plan, only the fake executables, bytes and timeouts substituted, passes end to end",
  { skip }, async () => withInstalls(async i => withRoot(async dir => {
    const roles = await testCorrectionRoles(i);
    // The test seam only: executable name, pinned directory and bytes, required variable and timeout; every other grant fact is the live one.
    assert.deepEqual({ ...roles.Worker, executable: B31.roles.Worker.executable, requiredEnvironment: B31.roles.Worker.requiredEnvironment,
      binding: { ...roles.Worker.binding, options: { ...roles.Worker.binding.options, timeoutMs: 180_000 } } }, { ...B31.roles.Worker });
    assert.deepEqual({ ...roles.Reviewer, executableDirectory: B31.roles.Reviewer.executableDirectory, executableSha256: B31.roles.Reviewer.executableSha256,
      binding: { ...roles.Reviewer.binding, options: { ...roles.Reviewer.binding.options, timeoutMs: 180_000 } } }, { ...B31.roles.Reviewer });
    const run = asCorrectionRun(await runCorrection(i, dir, "b31-plan", { Worker: [proposal(CORRECTED)], Reviewer: [{ prefix: PREFIX.review, output: cleanReview }] },
      { authorization: { ...B31, state: "open", milestone: "TEST", evidenceDirectory: "fusion-test-b31", roles } }));
    assert.equal(run.report.outcome, "PASS", run.report.detail);
    assert.equal(run.report.modelTurns, 2);
    assert.deepEqual(evidenceOf<Record<string, number>>(run, "turnUse"), { leadPlan: 0, changeAuthor: 1, freshReview: 1, leadAdjudication: 0 });
    assert.deepEqual(Object.keys(evidenceOf<Record<string, unknown>>(run, "bindings")), ["Worker", "Reviewer"], "no Lead binding was composed");
    // No primary mutation; bounded evidence without raw replies or secrets.
    assert.deepEqual(evidenceOf<Record<string, unknown>>(run, "primary").unchanged, true);
    assert.deepEqual(evidenceOf<Record<string, boolean>>(run, "integrity"), { viewsUnchanged: true, candidateUnchanged: true, primaryUnchanged: true });
    const text = await readFile(run.report.evidencePath, "utf8");
    for (const secret of [WORKER_SECRET, "```", "partial discount is taxed", "No defect found.", "Fusion placeholder", "Evidence (data)"])
      assert.ok(!text.includes(secret), `evidence leaks ${secret}`);
  })));

test("O5.5B31 PASS definition: both turns, a verified correction, a clean re-review, integrity and cleanup; never a third turn", () => {
  const pass: CorrectionProbeFacts = { claimed: true, stage: "rereview", block: undefined, crash: undefined, turnError: undefined, contractError: undefined,
    reviewFindings: [], decision: { kind: "clean" }, modelTurns: 2, turnRefusals: [], launchRefusals: [], viewsUnchanged: true, candidateUnchanged: true,
    primaryUnchanged: true, launchesConfined: true, forbiddenEnv: false, executablesUnchanged: true, cleanupComplete: true, rehearsal: false };
  assert.equal(classifyCorrectionProbe(pass)[0], "PASS");
  const outcome = (patch: Partial<CorrectionProbeFacts>) => classifyCorrectionProbe({ ...pass, ...patch })[0];
  assert.equal(outcome({ modelTurns: 3 }), "TURN_REFUSED", "never a third model turn");
  assert.equal(outcome({ turnRefusals: ["a second correction"] }), "TURN_REFUSED");
  assert.equal(outcome({ launchRefusals: [{ outcome: "POSTURE_BLOCKED", reason: "a process of an executable the authorization does not name" }] }),
    "POSTURE_BLOCKED", "no other role can start");
  assert.equal(outcome({ block: ["VERIFICATION_FAILED", "failed"], stage: "verification" }), "VERIFICATION_FAILED");
  assert.equal(outcome({ reviewFindings: [{} as never], decision: undefined }), "REREVIEW_FINDINGS");
  assert.equal(outcome({ primaryUnchanged: false }), "PRIMARY_MUTATED");
  assert.equal(outcome({ executablesUnchanged: false }), "VERSION_BLOCKED");
  assert.equal(outcome({ cleanupComplete: false }), "CLEANUP_FAILED");
  assert.equal(outcome({ modelTurns: 1, decision: undefined, reviewFindings: undefined }), "PROVIDER_FAILED");
});

test("O5.5B31 live entry: lists the open authorization; bad usage refuses before anything exists (never started with the identity)",
  async () => withRoot(async dir => {
    const temp = join(dir, "temp");
    await mkdir(temp);
    const child = spawnSync(process.execPath, [resolve(process.cwd(), "dist/test/live/correction-probe.js")], { encoding: "utf8", timeout: 60_000,
      windowsHide: true, env: { SystemRoot: process.env.SystemRoot ?? "", PATH: process.env.PATH ?? "", TEMP: temp, TMP: temp, CLAUDECODE: "1" } });
    assert.equal(child.status, 2, child.stderr);
    assert.equal(child.stderr, "Usage: node dist/test/live/correction-probe.js --authorization <id>\nCorrection-only authorizations: O5.5B31-CORRECTION (consumed)\n");
    assert.deepEqual(await readdir(temp), []);
  }));

test("O5.5B31 record: correction and re-review PASS, the branch PARTIAL — exactly as independently validated; no finding text", () => {
  assert.deepEqual(correctionLiveRecords().map(r => [r.milestone, r.outcome, r.correction, r.rereview, r.completeBranch]),
    [["O5.5B31", "REREVIEW_FINDINGS", "PASS", "PASS", "PARTIAL"]]);
  const record = correctionLiveRecords()[0]!;
  assert.deepEqual([record.authorization, record.modelTurns], [ID, 2]);
  assert.deepEqual(record.boundary, { decision: "correction", corrections: ["r1-F1"], priorFindings: ["r1-F1"] });
  // The corrective Change Author: the exact binding, the envelope, the ChangeSet contract.
  assert.deepEqual([record.author.runtimeVersion, record.author.model, record.author.canonicalModel, record.author.effort, record.author.maxTurns],
    [B31.roles.Worker.runtimeVersions[0], B31.roles.Worker.binding.model, B31.roles.Worker.binding.options?.canonicalModel, B31.roles.Worker.binding.effort,
      B31.roles.Worker.binding.maxTurns]);
  assert.deepEqual(record.author.replyEnvelope, { policy: "rawOrSingleJsonFence", classification: "SINGLE_FENCED_VALID_JSON", accepted: true });
  assert.deepEqual(record.author.terminal, { classification: "RESULT_OK", internalTurnCount: 4, resultTextByteLength: 2554, processExitCode: 0 });
  assert.deepEqual(record.author.changeSet, { outcome: "validated", operations: 2, paths: ["src/quote.ts", "test/quote.test.ts"] });
  // Host application: the corrected quote is byte-identical to Fusion's fix; the test file differs from the starting candidate's.
  assert.deepEqual(record.application.map(a => [a.path, a.bytes]), [["src/quote.ts", 1014], ["test/quote.test.ts", 1039]]);
  assert.equal(record.application[0]!.afterSha256, createHash("sha256").update(QUOTE_FIXED, "utf8").digest("hex"));
  assert.notEqual(record.application[1]!.afterSha256, createHash("sha256").update(QUOTE_TEST_WITH_REGRESSION, "utf8").digest("hex"));
  assert.deepEqual(record.verification, { passed: true, commandsRun: 2, acceptance: "granted" });
  // The re-review: the exact validated Muse binding and binary; the contract accepted one finding; the policy's next step.
  assert.deepEqual([record.reviewer.runtimeVersion, record.reviewer.executableSha256, record.reviewer.model, record.reviewer.effort, record.reviewer.maxModelSteps,
    record.reviewer.malformedOutputRetries], [B31.roles.Reviewer.runtimeVersions[0], B31.roles.Reviewer.executableSha256, B31.roles.Reviewer.binding.model,
    B31.roles.Reviewer.binding.effort, B31.roles.Reviewer.binding.options?.maxModelSteps, B31.roles.Reviewer.binding.options?.malformedOutputRetries]);
  assert.deepEqual([record.reviewer.cycle, record.reviewer.contract, record.reviewer.findings, record.reviewer.replyEnvelope, record.reviewer.next],
    [2, "accepted:1 finding(s)", { count: 1, bySeverity: { MEDIUM: 1 }, byConfidence: { HIGH: 1 } },
      { policy: "rawOnly", classification: "RAW_VALID_JSON", accepted: true }, "adjudicationRequired"]);
  assert.ok(!JSON.stringify(record).includes("r2-"), "no finding id, title or text of the re-review was persisted");
  assert.deepEqual([record.evidenceSha256, record.ranAt, record.document], ["73edc215966f2c086c32063dfb4fe62baf217dc3cc105d03e9b2d5a92cc547d9",
    "2026-09-25T22:51:06.626Z", "docs/o5-5b31-review-correction-live.md"]);
  // An isolated probe of the branch, not a route: no full-route record claims a correction.
  assert.ok(fullRouteLiveRecords().every(r => r.correction !== "PASS"));
});

test("O5.5B31 readiness: the private-candidate Writer workflow is satisfied (every turn kind live); Writer mode, delivery, O5.5B, O6 and the gate do not move", () => {
  const report = writerGateReport();
  const rows = Object.fromEntries(report.rows.map(row => [row.id, [row.state, row.evidenceKind]]));
  assert.deepEqual(rows.hostControlledWriterWorkflow, ["satisfied", "recordedLiveProbe"]);
  const row = (id: string) => report.rows.find(r => r.id === id)!;
  assert.match(row("hostControlledWriterWorkflow").evidence, /Every provider turn kind of the route has run live under its production contract: the Lead adjudication \(O5\.5B29\), the corrective Change Author and the re-review after a correction \(O5\.5B31\) as isolated probes of their branch; every transition, a cycle-2 adjudication and its gate included, is exercised offline by the real engine\./u);
  assert.match(row("hostControlledWriterWorkflow").remainingBlocker, /^Satisfied for the private-candidate workflow only\. Never run live in a route: Lead adjudication of review findings \(live only as an isolated probe: O5\.5B29\); review-driven correction and re-review \(live only as an isolated probe: O5\.5B31\); never run live at all: a cycle-2 Lead adjudication \(the same adjudication turn as the live one; its transition is exercised offline\)\. Single samples on one throw-away fixture\. The workflow ends in a private candidate: nothing is delivered to a primary checkout \(no command prepares a delivery from a Writer run; see humanApprovedDelivery\), and a real Writer run stays refused \(liveGateAuthorization\)\.$/u);
  assert.match(row("fullRouteLive").remainingBlocker, /review-driven correction and re-review \(live only as an isolated probe: O5\.5B31\)\./u);
  // Everything outside the private-candidate workflow stays where it was: substrate boundaries, delivery, the gate.
  assert.deepEqual([rows.fullRouteLive, rows.primaryProtection, rows.providerWorkspaceBoundary, rows.ignoredPathProtection, rows.sharedGitAndIgnoredPaths,
    rows.dependencySupport, rows.reviewAndAdjudication, rows.hostControlledApplication, rows.liveGateAuthorization], [["partial", "recordedLiveProbe"],
    ["partial", "mechanical"], ["partial", "fakeProcess"], ["partial", "mechanical"], ["partial", "mechanical"], ["partial", "mechanical"],
    ["satisfied", "mechanical"], ["satisfied", "mechanical"], ["blocked", "none"]]);
  assert.equal(report.verificationIsolation.windows.evidenceState, "proven");
  assert.equal(writerGateReport({ hostPlatform: "win32" }).verificationIsolation.windows.effectiveState, "unknown", "registered but not probed => unknown");
  assert.equal(writerGateReport({ hostPlatform: "win32", windowsRuntime: "proven" }).verificationIsolation.windows.effectiveState, "ready");
  assert.equal(writerGateReport({ hostPlatform: "linux" }).verificationIsolation.windows.effectiveState, "blocked", "off-Windows fails closed");
  for (const input of ["HOST_CONTROLLED_WRITER_WORKFLOW_READINESS: YES", { correction: "PASS" }]) assert.deepEqual(writerGateReport({ linuxVerification: input }), report);
  assert.deepEqual([report.realWriterModeReady, REAL_WRITER_LIVE_GATE_AUTHORIZED, liveWriterAuthorization().authorized], [false, false, false]);
  const posture = writerReadiness().prerequisites.find(p => p.id === "writerPosture")!.text;
  assert.match(posture, /A review-correction probe \(O5\.5B31\), entered after that decision, ran the corrective Change Author .* the cycle-2 adjudication that finding needs was not run\. Nothing was delivered to a primary checkout\./u);
  assert.doesNotMatch(writerReadiness().prerequisites.map(p => p.text).join(" "), /COMPLETED|success/iu, "the CLI prints these; no success wording");
});
