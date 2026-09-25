import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { BindingConfig } from "../src/app/config.js";
import { grantDirectory, readbackMatches, REVIEWER_ONLY_TURNS, ReviewerTurnGate, runReviewerProbe } from "../src/app/reviewer-probe.js";
import { QUOTE_FIXED, QUOTE_TEST_WITH_REGRESSION, REVIEW_CANDIDATE_CHANGE, reviewCandidateIdentity } from "../src/app/route-fixture.js";
import { REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport } from "../src/app/writer-gate.js";
import type { ProviderAdapter } from "../src/core/domain.js";
import { EXEC_CONTROL_FLAGS, VERIFIED_EXEC_WEB_DISABLE_VERSION, capability } from "../src/providers/muse/types.js";
import { MUSE_1_4_REVIEWER, PROPOSAL_PROBE_PROFILES, REVIEWER_PROBE_PROFILES, ROUTE_REHEARSAL_PROFILES } from "../src/providers/probe-profiles.js";
import { defaultRegistry } from "../src/providers/registry.js";
import { fullRouteLiveCoverage, isValidatedRuntimeVersion, leadPlanLiveRecords, transportProfile } from "../src/runtime/provider-profiles.js";
import { withRoot } from "./fixtures/probe-harness.js";
import { installMuseVersion, museLaunch, withInstalls } from "./fixtures/provider-installs.js";
import { asReviewerRun, evidenceOf, installRelease, RELEASE, releaseExe, runReviewer, testReviewerAuthorization } from "./fixtures/reviewer-harness.js";
import { cleanReview, fenced, PREFIX, reviewWith, routeEnv } from "./fixtures/route-harness.js";
import { gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5B23 — the Reviewer-only probe foundation, offline: the real Exec adapter code on the scripted fake binary installed
 * as the release under validation, the real candidate port, view store and Docker backend on the in-memory daemon. No
 * provider, no authorization, no readiness change.
 */
const skip = gitAvailable ? false : "git executable unavailable";
type Launch = { purpose: string; phase: string; executable: string; executableIsAuthorized: boolean; args: string[]; cwdClass: string;
  posture?: { missing: string[]; widening: string[] }; identityGaps?: string[]; refusedBeforeStart?: string };
type Review = { turn: Record<string, unknown> | null; contract: string; findings: { count: number; bySeverity: Record<string, number> } | null;
  structuredOutput: Record<string, unknown> | null; terminal: Record<string, unknown> | null; error?: { kind: string; safeMessage: string } };
const REVIEW = (output: string) => ({ prefix: PREFIX.review, output });
const counts = (run: ReturnType<typeof asReviewerRun>) => evidenceOf<Record<string, number>>(run, "launchCounts");
const claimed = async (root: string) => (await readdir(root)).includes("reviewer.claim.json");

test("O5.5B23 PASS (fake): one Reviewer turn under the release under validation — no Lead, Worker or adjudication process; the production contract accepts it",
  { skip }, async () => withInstalls(async i => withRoot(async dir => {
    await installRelease(i);
    const run = asReviewerRun(await runReviewer(i, dir, "pass", [REVIEW(reviewWith({ id: "F1", severity: "LOW" }))]));
    assert.equal(run.report.outcome, "PASS", run.report.detail);
    assert.equal(run.report.modelTurns, 1);
    assert.equal(run.report.evidence.stage, "review");
    assert.equal(run.report.evidence.evidenceKind, "offlineRehearsal");
    assert.ok(run.report.evidencePath.endsWith("reviewer.evidence.json"));
    assert.ok(await claimed(run.root), "the one-shot claim was written before the turn");
    // Only the Reviewer's own processes: its account-attestation host and one model process, both the release under validation.
    assert.deepEqual(counts(run), { providerAuthReadback: 0, providerInventory: 0, providerInitProbe: 0, providerTurn: 1, providerHost: 1 });
    const launches = evidenceOf<Launch[]>(run, "launches");
    assert.ok(launches.every(l => l.executable === `muse-bin-${RELEASE}.exe` && l.executableIsAuthorized && l.refusedBeforeStart === undefined));
    assert.deepEqual(launches.map(l => [l.purpose, l.phase, l.cwdClass]), [["providerHost", "readback", "ownedTemporary"],
      ["providerTurn", "turn", "providerView:candidate"]]);
    assert.deepEqual(evidenceOf<Record<string, number>>(run, "turnUse"), { leadPlan: 0, changeAuthor: 0, freshReview: 1, leadAdjudication: 0 });
    assert.deepEqual(evidenceOf<{ turns: unknown[]; launches: unknown[] }>(run, "refusals"), { turns: [], launches: [] });
    const review = evidenceOf<Review>(run, "review");
    assert.equal(review.contract, "accepted:1 finding(s)");
    assert.deepEqual(review.findings, { count: 1, bySeverity: { LOW: 1 }, byConfidence: { HIGH: 1 } });
    assert.deepEqual([review.turn?.status, review.turn?.observedModel, review.turn?.requestedModel, review.turn?.effort],
      ["completed", "muse-spark-1.3", "muse-spark-1.3", "low"]);
    assert.deepEqual([review.structuredOutput?.classification, review.structuredOutput?.accepted, review.structuredOutput?.policy,
      review.structuredOutput?.bodyMatchesExpectedSchema], ["RAW_VALID_JSON", true, "rawOnly", true]);
    assert.deepEqual([review.terminal?.classification, review.terminal?.resultSubtype, review.terminal?.terminalReason, review.terminal?.isError,
      review.terminal?.structuredParsingReached, review.terminal?.schemaValidationReached, review.terminal?.processExitCode],
      ["RESULT_OK", "completed", "completed", false, true, true, 0]);
    // Pre-claim runtime readback: the account lane and the running host's own version report (its version core).
    assert.deepEqual(evidenceOf<Record<string, unknown>>(run, "readback"), { auth: { state: "authenticated", lane: "subscription",
      evidence: ["msp:account/read:accountLogin"] }, reportedRuntimeVersion: "1.4.0", matchesInstalled: true });
    // Fusion's real verification of the Fusion-authored candidate, before the claim, with its declared dependency stage.
    const verification = evidenceOf<Record<string, unknown>>(run, "verification");
    assert.deepEqual([verification.passed, verification.commandsRun, verification.acceptance], [true, 2, "offlineRehearsal"]);
    assert.deepEqual((verification.dependencies as { kind: string; prepared: boolean }).kind, "npm-lockfile");
    assert.deepEqual(evidenceOf<{ changedPaths: string[]; verification: unknown }>(run, "reviewEvidence").changedPaths, ["src/quote.ts", "test/quote.test.ts"]);
    // Exactly the production fresh-review prompt: the task, Fusion's verification and the observed diff; no rationale.
    assert.equal(run.prompts.length, 1);
    const [prompt] = run.prompts;
    assert.ok(prompt!.startsWith(PREFIX.review));
    assert.ok(prompt!.includes("basisPoints(subtotal - discount, quote.taxBasisPoints)") && prompt!.includes("a full discount leaves nothing to tax"));
    assert.ok(prompt!.includes("Fix quote totals: tax applies to the discounted subtotal."));
    assert.ok(!prompt!.includes("planning Lead") && !prompt!.includes("Fusion change proposal."), "no Lead or Worker text");
    assert.deepEqual(evidenceOf<Record<string, boolean>>(run, "integrity"), { viewUnchanged: true, candidateUnchanged: true, primaryUnchanged: true });
    const cleanup = evidenceOf<{ leftoverOwnedTemporaries: string[]; released: Record<string, unknown> }>(run, "cleanup");
    assert.deepEqual(cleanup.leftoverOwnedTemporaries, []);
    assert.deepEqual(cleanup.released, { session: "closed", view: { complete: true }, candidate: { complete: true } });
    assert.deepEqual(evidenceOf<Record<string, unknown>>(run, "executableAfter"), { checked: true, sha256Matches: true });
  })));

test("O5.5B23 exact binding: the grant's binding, a one-review budget, one release and the pinned fixture and candidate are required",
  { skip }, async () => withInstalls(async i => withRoot(async dir => {
    await installRelease(i);
    const effort = asReviewerRun(await runReviewer(i, dir, "effort", [REVIEW(cleanReview)], { binding: { effort: "minimal" } }));
    assert.deepEqual([effort.report.outcome, effort.report.evidence.stage, effort.report.modelTurns], ["MODEL_BLOCKED", "preflight", 0]);
    assert.deepEqual(evidenceOf<{ bindingMismatches: string[] }>(effort, "preflight").bindingMismatches, ["effort"]);
    assert.equal(await claimed(effort.root), false);
    for (const [name, turns] of [["two", { ...REVIEWER_ONLY_TURNS, freshReview: 2 }], ["lead", { ...REVIEWER_ONLY_TURNS, leadPlan: 1 }],
      ["none", { ...REVIEWER_ONLY_TURNS, freshReview: 0 }], ["adjudication", { ...REVIEWER_ONLY_TURNS, leadAdjudication: 1 }]] as const) {
      const refused = await runReviewer(i, dir, `budget-${name}`, [], { authorization: await testReviewerAuthorization(i, { turns }) });
      assert.ok("refused" in refused && refused.reason === "budgetNotReviewerOnly", name);
    }
    const two = await runReviewer(i, dir, "two-releases", [], { authorization: await testReviewerAuthorization(i, {},
      { runtimeVersions: [RELEASE, VERIFIED_EXEC_WEB_DISABLE_VERSION] }) });
    assert.ok("refused" in two && two.reason === "validationTargetAmbiguous");
    const fixture = await runReviewer(i, dir, "fixture", [], { authorization: await testReviewerAuthorization(i, { fixtureSha256: "0".repeat(64) }) });
    assert.ok("refused" in fixture && fixture.reason === "fixtureMismatch");
    const candidate = await runReviewer(i, dir, "candidate", [], { authorization: await testReviewerAuthorization(i, { candidateSha256: "0".repeat(64) }) });
    assert.ok("refused" in candidate && candidate.reason === "candidateMismatch");
  })));

test("O5.5B23 wrong version: another selected release is blocked (never a fallback), and so is a host reporting another release", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    await installRelease(i);
    await installMuseVersion(i, VERIFIED_EXEC_WEB_DISABLE_VERSION);
    const fallback = asReviewerRun(await runReviewer(i, dir, "fallback", [REVIEW(cleanReview)]));
    assert.deepEqual([fallback.report.outcome, fallback.report.evidence.stage, fallback.report.modelTurns], ["VERSION_BLOCKED", "preflight", 0]);
    assert.match(fallback.report.detail, /installed 1\.3\.0-R3401\.1 is not the release under validation \(1\.4\.0-R4161\.1\); no other release is ever used/u);
    assert.equal(evidenceOf<unknown[]>(fallback, "launches"), undefined, "no provider process at all");
    await installMuseVersion(i, "1.4.1-R9999.1");
    const newer = asReviewerRun(await runReviewer(i, dir, "newer", [REVIEW(cleanReview)]));
    assert.equal(newer.report.outcome, "VERSION_BLOCKED");
    await installRelease(i);
    const host = asReviewerRun(await runReviewer(i, dir, "host", [REVIEW(cleanReview)], { extra: { FUSION_FAKE_HOST_VERSION: "1.3.0" } }));
    assert.deepEqual([host.report.outcome, host.report.evidence.stage, host.report.modelTurns], ["VERSION_BLOCKED", "preflight", 0]);
    assert.match(host.report.detail, /the running host reported release 1\.3\.0, not the release under validation/u);
    assert.deepEqual([counts(host).providerHost, counts(host).providerTurn], [1, 0], "only the attestation host ran; no model turn");
    assert.equal(await claimed(host.root), false, "a pre-claim block consumes nothing");
    assert.equal(host.prompts.length, 0);
  })));

test("O5.5B23 wrong model: a binding with another model is blocked before anything runs; a turn reading back another model fails the probe",
  { skip }, async () => withInstalls(async i => withRoot(async dir => {
    await installRelease(i);
    const binding = asReviewerRun(await runReviewer(i, dir, "model", [REVIEW(cleanReview)], { binding: { model: "muse-spark-1.2" } }));
    assert.deepEqual([binding.report.outcome, binding.report.modelTurns], ["MODEL_BLOCKED", 0]);
    assert.deepEqual(evidenceOf<{ bindingMismatches: string[] }>(binding, "preflight").bindingMismatches, ["model"]);
    const readback = asReviewerRun(await runReviewer(i, dir, "readback", [{ ...REVIEW(cleanReview), model: "muse-spark-1.2" }]));
    assert.deepEqual([readback.report.outcome, readback.report.modelTurns], ["MODEL_BLOCKED", 1]);
    assert.match(readback.report.detail, /Effective model differs/u);
    assert.equal(evidenceOf<Review>(readback, "review").contract, "notReached:ProviderIdentityMismatch");
  })));

test("O5.5B23 wrong executable: another SHA-256, another location, or a process of another binary is blocked", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    await installRelease(i);
    const bytes = asReviewerRun(await runReviewer(i, dir, "sha", [REVIEW(cleanReview)],
      { authorization: await testReviewerAuthorization(i, {}, { executableSha256: "0".repeat(64) }) }));
    assert.deepEqual([bytes.report.outcome, bytes.report.detail], ["VERSION_BLOCKED", "Reviewer: the executable's SHA-256 differs from the authorized one"]);
    assert.deepEqual(evidenceOf<{ executableIdentity: Record<string, unknown> }>(bytes, "preflight").executableIdentity.sha256Matches, false);
    const place = asReviewerRun(await runReviewer(i, dir, "place", [REVIEW(cleanReview)],
      { authorization: await testReviewerAuthorization(i, {}, { executableDirectory: join(i.dir, "elsewhere") }) }));
    assert.deepEqual([place.report.outcome, place.report.detail], ["VERSION_BLOCKED", "Reviewer: the executable is not the authorized one at its authorized location"]);
    // The adapter would launch another binary (the verified 1.3 fixture) than the pinned one: refused before it starts.
    const other = asReviewerRun(await runReviewer(i, dir, "other", [REVIEW(cleanReview)], { binary: releaseExe(i, VERIFIED_EXEC_WEB_DISABLE_VERSION) }));
    assert.deepEqual([other.report.outcome, other.report.modelTurns], ["VERSION_BLOCKED", 0]);
    assert.match(other.report.detail, /another executable than the authorized one/u);
    assert.equal(await claimed(other.root), false);
    assert.equal(grantDirectory("%LOCALAPPDATA%/Programs/muse", { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" })?.toLowerCase(),
      "c:\\users\\x\\appdata\\local\\programs\\muse");
    assert.equal(grantDirectory("%LOCALAPPDATA%/Programs/muse", {}), undefined);
    assert.equal(grantDirectory("relative/dir", {}), undefined);
  })));

test("O5.5B23 limits: 4 model steps and no retry are required and carried exactly; a malformed reply is never retried", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    await installRelease(i);
    for (const [name, option, mismatch] of [["steps", { maxModelSteps: 5 }, "options.maxModelSteps"],
      ["retries", { malformedOutputRetries: 1 }, "options.malformedOutputRetries"]] as const) {
      const run = asReviewerRun(await runReviewer(i, dir, name, [REVIEW(cleanReview)],
        { binding: { options: option as unknown as BindingConfig["options"] } }));
      assert.deepEqual([run.report.outcome, evidenceOf<{ bindingMismatches: string[] }>(run, "preflight").bindingMismatches], ["MODEL_BLOCKED", [mismatch]]);
    }
    const once = asReviewerRun(await runReviewer(i, dir, "once", [REVIEW("{bad"), REVIEW(cleanReview)]));
    assert.deepEqual([once.report.outcome, counts(once).providerTurn, once.prompts.length], ["MALFORMED_OUTPUT", 1, 1], "exactly one model turn");
    const [turn] = evidenceOf<Launch[]>(once, "launches").filter(l => l.purpose === "providerTurn");
    assert.deepEqual(turn!.identityGaps, []);
    assert.equal(turn!.args.filter(arg => arg === "--max-model-steps").length, 1);
    assert.equal(turn!.args[turn!.args.indexOf("--max-model-steps") + 1], "4");
  })));

test("O5.5B23 read-only posture: the production Reviewer's controls exactly; facts under validation are claimed but never verified", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    await installRelease(i);
    const run = asReviewerRun(await runReviewer(i, dir, "posture", [REVIEW(cleanReview)]));
    assert.equal(run.report.outcome, "PASS", run.report.detail);
    const [turn] = evidenceOf<Launch[]>(run, "launches").filter(l => l.purpose === "providerTurn");
    assert.deepEqual(turn!.posture, { missing: [], widening: [] });
    const at = turn!.args.indexOf(EXEC_CONTROL_FLAGS[0]);
    assert.deepEqual(turn!.args.slice(at, at + EXEC_CONTROL_FLAGS.length), [...EXEC_CONTROL_FLAGS], "the production Exec controls, in order");
    for (const [flag, value] of MUSE_1_4_REVIEWER.turnArgs!) assert.equal(turn!.args[turn!.args.indexOf(flag) + 1], value, flag);
    const controls = evidenceOf<{ controls: Array<{ name: string; state: string }> }>(run, "preflight").controls;
    assert.deepEqual(controls.find(c => c.name === "launchReadOnlyFlags")?.state, "available");
    const config = { ...museLaunch(i, dir, {}), versionUnderValidation: RELEASE };
    const claimedFacts = capability(config, "muse-exec", RELEASE);
    assert.deepEqual([claimedFacts.webToolsDisabled, claimedFacts.filesystem.write, claimedFacts.shell.available, claimedFacts.approvalEscalationDisabled,
      claimedFacts.personalContextDisabled, claimedFacts.extensionsQuarantined], [true, false, false, true, true, true]);
    assert.deepEqual([claimedFacts.webToolsDisabledEvidence?.versionVerified, claimedFacts.postureEvidence?.versionVerified], [false, false],
      "claimed under validation, never reported verified");
    const plain = capability(museLaunch(i, dir, {}), "muse-exec", RELEASE);
    assert.deepEqual([plain.webToolsDisabled, plain.approvalEscalationDisabled], ["unknown", "unknown"], "without the probe the release stays unknown");
    assert.equal(capability({ ...museLaunch(i, dir, {}), versionUnderValidation: "9.9.9" }, "muse-exec", RELEASE).webToolsDisabled, "unknown");
  })));

test("O5.5B23 the under-validation seam: only a probe's runtime context sets it — never a binding option — and only for the exact release", { skip },
  async () => withInstalls(async i => {
    await installRelease(i);
    const muse = defaultRegistry().factories.get("muse-exec")!;
    const binding: BindingConfig = { role: "Reviewer", adapter: "muse-exec", model: "muse-spark-1.3", effort: "low",
      options: { provider: "meta", binaryDirectory: i.museDir, maxModelSteps: 4 } };
    const context = { workspace: i.dir, env: routeEnv(), sessionWorkspaces: "required" as const };
    const plain = await muse.inspect(binding, context);
    assert.deepEqual([plain.runtimeVersion, plain.controls.find(c => c.name === "launchReadOnlyFlags")?.state, plain.capabilities?.webToolsDisabled],
      [RELEASE, "unknown", "unknown"]);
    assert.equal(plain.executablePath?.toLowerCase(), releaseExe(i).toLowerCase());
    const under = await muse.inspect(binding, { ...context, runtimeUnderValidation: { transport: "muse-exec", version: RELEASE } });
    assert.deepEqual([under.controls.find(c => c.name === "launchReadOnlyFlags")?.state, under.capabilities?.webToolsDisabled], ["available", true]);
    assert.ok(under.notes.some(note => note.includes("UNDER VALIDATION")));
    for (const target of [{ transport: "muse-exec", version: "1.4.0-R0000.1" }, { transport: "muse-msp", version: RELEASE }])
      assert.equal((await muse.inspect(binding, { ...context, runtimeUnderValidation: target })).capabilities?.webToolsDisabled, "unknown", target.version);
    await assert.rejects(muse.inspect({ ...binding, options: { ...binding.options, versionUnderValidation: RELEASE } }, context),
      (error: unknown) => (error as { error?: { safeMessage?: string } }).error?.safeMessage === 'Unknown option "versionUnderValidation" for adapter muse-exec.');
    // The real factory's adapter, built for the probe's context, claims the facts; built without it, it does not.
    const underAdapter = (await muse.create(binding, { ...context, runtimeUnderValidation: { transport: "muse-exec", version: RELEASE } })).adapter;
    const plainAdapter = (await muse.create(binding, context)).adapter;
    assert.deepEqual([(await underAdapter.capabilities()).webToolsDisabled, (await plainAdapter.capabilities()).webToolsDisabled], [true, "unknown"]);
  }));

test("O5.5B23 raw-only Muse policy unchanged: one fenced review is refused as SINGLE_FENCED_VALID_JSON under rawOnly — recorded, never retried",
  { skip }, async () => withInstalls(async i => withRoot(async dir => {
    await installRelease(i);
    const run = asReviewerRun(await runReviewer(i, dir, "fenced", [{ prefix: PREFIX.review, output: fenced(JSON.parse(cleanReview)) }]));
    assert.deepEqual([run.report.outcome, run.report.modelTurns, counts(run).providerTurn], ["MALFORMED_OUTPUT", 1, 1]);
    assert.ok(await claimed(run.root), "the authorization is consumed: no retry, no widening");
    const review = evidenceOf<Review>(run, "review");
    assert.deepEqual([review.structuredOutput?.classification, review.structuredOutput?.accepted, review.structuredOutput?.policy,
      review.structuredOutput?.bodyMatchesExpectedSchema], ["SINGLE_FENCED_VALID_JSON", false, "rawOnly", true]);
    assert.deepEqual([review.terminal?.classification, review.terminal?.structuredParsingReached, review.terminal?.schemaValidationReached],
      ["RESULT_OK", true, false], "the model turn succeeded; the reply never reached the schema stage");
    assert.deepEqual(review.error, { kind: "MalformedOutput", safeMessage: "Muse returned invalid structured JSON." });
    assert.equal(review.contract, "notReached:MalformedOutput");
    for (const transport of ["muse-exec", "muse-msp"]) {
      const profile = transportProfile("muse", transport)!;
      assert.deepEqual([profile.changeProposalEnvelope, profile.leadPlanEnvelope, profile.adjudicationEnvelope], ["rawOnly", "rawOnly", "rawOnly"]);
    }
  })));

test("O5.5B23 contract: a clean review passes; malformed, schema-invalid and contract-invalid replies fail at their own stage", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    await installRelease(i);
    const clean = asReviewerRun(await runReviewer(i, dir, "clean", [REVIEW(cleanReview)]));
    assert.deepEqual([clean.report.outcome, evidenceOf<Review>(clean, "review").contract], ["PASS", "accepted:0 finding(s)"]);
    const bad = asReviewerRun(await runReviewer(i, dir, "bad", [REVIEW("{bad")]));
    assert.deepEqual([bad.report.outcome, evidenceOf<Review>(bad, "review").structuredOutput?.classification,
      evidenceOf<Review>(bad, "review").terminal?.schemaValidationReached], ["MALFORMED_OUTPUT", "RAW_INVALID_JSON", false]);
    const schema = asReviewerRun(await runReviewer(i, dir, "schema", [REVIEW(JSON.stringify({ findings: [] }))]));
    assert.deepEqual([schema.report.outcome, evidenceOf<Review>(schema, "review").structuredOutput?.classification,
      evidenceOf<Review>(schema, "review").terminal?.schemaValidationReached], ["MALFORMED_OUTPUT", "INVALID_SCHEMA", true]);
    assert.equal(evidenceOf<Review>(schema, "review").error?.safeMessage, "Muse output failed local wire-schema validation.");
    const duplicate = asReviewerRun(await runReviewer(i, dir, "duplicate", [REVIEW(reviewWith({ id: "F1", severity: "LOW" }, { id: "F1", severity: "HIGH" }))]));
    assert.deepEqual([duplicate.report.outcome, evidenceOf<Review>(duplicate, "review").contract], ["CONTRACT_REFUSED", "refused"]);
    assert.match(duplicate.report.detail, /duplicate finding ID/u);
  })));

test("O5.5B23 terminal: a failed Muse turn is diagnosed as RESULT_IS_ERROR (never parsed), with labels and counts only", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    await installRelease(i);
    const run = asReviewerRun(await runReviewer(i, dir, "failed", [{ ...REVIEW(cleanReview), scenario: "fail" }]));
    assert.deepEqual([run.report.outcome, run.report.detail], ["PROVIDER_FAILED", "ProcessFailure: Muse Exec reported a failed turn."]);
    const review = evidenceOf<Review>(run, "review");
    assert.deepEqual(review.terminal, { schemaVersion: 1, classification: "RESULT_IS_ERROR", resultSubtype: "failed", terminalReason: "provider_failure",
      isError: true, internalTurnCount: null, permissionDenialCount: null, errorEntryCount: null, resultTextPresent: true,
      resultTextByteLength: Buffer.byteLength(cleanReview, "utf8"), apiErrorStatusClass: "none", structuredParsingReached: false,
      schemaValidationReached: false, processExitCode: 0, processSignal: null, fusionTermination: null, timedOut: false, cancelled: false });
    assert.equal(review.structuredOutput, null, "no reply was read");
    assert.equal(review.contract, "notReached:ProcessFailure");
  })));

test("O5.5B23 integrity: the primary is unchanged; a Reviewer writing into its candidate view voids the review", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    await installRelease(i);
    const clean = asReviewerRun(await runReviewer(i, dir, "primary", [REVIEW(cleanReview)]));
    const primary = evidenceOf<{ unchanged: boolean; canariesUnchanged: boolean; before: string; after: string }>(clean, "primary");
    assert.deepEqual([primary.unchanged, primary.canariesUnchanged, primary.before === primary.after], [true, true, true]);
    const mutate = asReviewerRun(await runReviewer(i, dir, "mutate", [{ ...REVIEW(cleanReview), scenario: "mutate" }]));
    assert.deepEqual([mutate.report.outcome, mutate.report.detail], ["VIEW_MUTATED", "the Reviewer's candidate view changed"]);
    assert.deepEqual(evidenceOf<Record<string, boolean>>(mutate, "integrity"), { viewUnchanged: false, candidateUnchanged: true, primaryUnchanged: true });
    assert.deepEqual(evidenceOf<{ leftoverOwnedTemporaries: string[] }>(mutate, "cleanup").leftoverOwnedTemporaries, []);
  })));

test("O5.5B23 privacy: the evidence holds no reply, prompt, diff, finding text or canary", { skip }, async () => withInstalls(async i => withRoot(async dir => {
  await installRelease(i);
  const run = asReviewerRun(await runReviewer(i, dir, "privacy", [REVIEW(reviewWith({ id: "F1", severity: "MEDIUM", title: "PRIVATE-FINDING-TITLE-3b7e" }))]));
  assert.equal(run.report.outcome, "PASS", run.report.detail);
  const text = await readFile(run.report.evidencePath, "utf8");
  for (const secret of ["PRIVATE-FINDING-TITLE-3b7e", "A later refactor", "a full discount leaves nothing to tax", "subtotal - discount",
    PREFIX.review, "synthetic-not-a-secret-7a31", "synthetic protected route canary"])
    assert.ok(!text.includes(secret), `evidence leaks ${secret}`);
})));

test("O5.5B23 turn gate: one fresh review in order, and nothing else ever reaches the provider", async () => {
  const calls: string[] = [];
  const stub = { runTurn: async () => { calls.push("runTurn"); }, runChangeProposalTurn: async () => { calls.push("proposal"); },
    runStructuredTurn: async (_s: unknown, request: { kind: string }) => { calls.push(request.kind); return { status: "completed" }; },
    close: async () => undefined } as unknown as ProviderAdapter;
  const gate = new ReviewerTurnGate(1);
  const adapter = gate.wrap(stub);
  const refused = (error: unknown) => (error as { error?: { kind?: string } }).error?.kind === "SecurityViolation";
  await assert.rejects(adapter.runStructuredTurn!({} as never, { kind: "review", cycle: 2 } as never), refused, "out of order");
  await assert.rejects(adapter.runStructuredTurn!({} as never, { kind: "adjudication", cycle: 1 } as never), refused, "no adjudication");
  await assert.rejects(adapter.runTurn({} as never, {} as never), refused, "no packet turn (Lead or Worker)");
  await assert.rejects(adapter.runChangeProposalTurn!({} as never, {} as never), refused, "no change proposal");
  await adapter.runStructuredTurn!({} as never, { kind: "review", cycle: 1 } as never);
  await assert.rejects(adapter.runStructuredTurn!({} as never, { kind: "review", cycle: 2 } as never), refused, "a second review");
  assert.deepEqual(calls, ["review"], "only the one authorized review reached the adapter");
  assert.equal(gate.used, 1);
  assert.equal(gate.refusals.length, 5);
});

test("O5.5B23 the binding and the candidate: the exact Muse 1.4 Reviewer grant; the Fusion-authored change is the correct fix", () => {
  assert.deepEqual({ ...MUSE_1_4_REVIEWER, turnArgs: MUSE_1_4_REVIEWER.turnArgs!.map(pair => [...pair]) }, {
    family: "muse", executable: "muse-bin-1.4.0-R4161.1.exe", executableDirectory: "%LOCALAPPDATA%/Programs/muse",
    executableSha256: "b33b493069a2593e97cc63f9a4063feb64269bf7f07a233f5db2db681ad5d950", runtimeVersions: ["1.4.0-R4161.1"],
    lanes: ["subscription"], binding: { adapter: "muse-exec", model: "muse-spark-1.3", effort: "low",
      options: { provider: "meta", maxModelSteps: 4, malformedOutputRetries: 0, timeoutMs: 180_000 } },
    turnArgs: [["--provider", "meta"], ["--model", "muse-spark-1.3"], ["--reasoning-effort", "low"], ["--max-model-steps", "4"]], requiredEnvironment: [] });
  assert.deepEqual(REVIEW_CANDIDATE_CHANGE.operations.map(op => [op.kind, op.path, op.kind === "writeText" ? op.content : null]),
    [["writeText", "src/quote.ts", QUOTE_FIXED], ["writeText", "test/quote.test.ts", QUOTE_TEST_WITH_REGRESSION]]);
  assert.match(reviewCandidateIdentity(), /^[0-9a-f]{64}$/u);
  assert.ok(readbackMatches(RELEASE, "1.4.0") && readbackMatches(RELEASE, RELEASE));
  assert.ok(!readbackMatches(RELEASE, "1.4") && !readbackMatches(RELEASE, "1.3.0") && !readbackMatches(RELEASE, undefined) && !readbackMatches(RELEASE, "invalid"));
});

test("O5.5B23 readiness: Muse 1.4 stays unvalidated, no row or gate moves, and no authorization exists or is open", async () => {
  assert.equal(isValidatedRuntimeVersion("muse", "muse-exec", RELEASE), false);
  assert.deepEqual(transportProfile("muse", "muse-exec")!.compatibility, { kind: "validatedVersions", versions: [VERIFIED_EXEC_WEB_DISABLE_VERSION] });
  assert.equal(VERIFIED_EXEC_WEB_DISABLE_VERSION, "1.3.0-R3401.1");
  // O5.5B23 opens nothing: no Reviewer-only authorization is open (O5.5B23 itself defines none).
  assert.ok(Object.values(REVIEWER_PROBE_PROFILES.authorizations).every(entry => entry.state !== "open"));
  const refused = await runReviewerProbe({ env: routeEnv(), registry: defaultRegistry(), profiles: REVIEWER_PROBE_PROFILES, authorization: "NO-SUCH-AUTHORIZATION" });
  assert.ok("refused" in refused && refused.reason === "unknownAuthorization");
  assert.ok(Object.values(ROUTE_REHEARSAL_PROFILES.authorizations).every(entry => entry.state !== "open"));
  assert.ok(Object.values(PROPOSAL_PROBE_PROFILES.authorizations).every(entry => entry.state === "consumed"));
  assert.deepEqual(leadPlanLiveRecords().map(r => [r.milestone, r.outcome]), [["O5.5B15", "FAIL"], ["O5.5B17", "FAIL"], ["O5.5B21", "PASS"]]);
  assert.deepEqual([fullRouteLiveCoverage().attempts, fullRouteLiveCoverage().passed], [1, 0]);
  const report = writerGateReport();
  const rows = Object.fromEntries(report.rows.map(row => [row.id, [row.state, row.evidenceKind]]));
  assert.deepEqual([rows.fullRouteLive, rows.hostControlledWriterWorkflow, rows.providerChangeProposal, rows.reviewAndAdjudication, rows.liveGateAuthorization],
    [["blocked", "recordedLiveProbe"], ["partial", "fakeProviderRehearsal"], ["satisfied", "recordedLiveProbe"], ["satisfied", "mechanical"], ["blocked", "none"]]);
  for (const input of ["MUSE_1_4_REVIEWER_LIVE: PASS", { reviewerProbe: "PASS" }]) assert.deepEqual(writerGateReport({ linuxVerification: input }), report);
  assert.deepEqual([report.realWriterModeReady, REAL_WRITER_LIVE_GATE_AUTHORIZED], [false, false]);
});
