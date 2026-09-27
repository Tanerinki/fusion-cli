import assert from "node:assert/strict";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileSha256 } from "../src/app/executable-identity.js";
import { exists } from "../src/app/proposal-probe.js";
import { REVIEWER_ONLY_TURNS, runReviewerProbe, type ReviewerProbeAuthorization } from "../src/app/reviewer-probe.js";
import { reviewCandidateIdentity } from "../src/app/route-fixture.js";
import { routeFixtureIdentity } from "../src/app/route-probe.js";
import { ADJUDICATION_PROBE_PROFILES, MUSE_1_4_R4302_REVIEWER, MUSE_1_4_REVIEWER, PROPOSAL_PROBE_PROFILES, REVIEWER_PROBE_PROFILES,
  ROUTE_REHEARSAL_PROFILES } from "../src/providers/probe-profiles.js";
import { defaultRegistry } from "../src/providers/registry.js";
import { bindingValidation, isValidatedForBinding, isValidatedRuntimeVersion } from "../src/runtime/provider-profiles.js";
import { withRoot } from "./fixtures/probe-harness.js";
import { installMuseVersion, withInstalls, type Installs } from "./fixtures/provider-installs.js";
import { asReviewerRun, evidenceOf, releaseExe, runReviewer } from "./fixtures/reviewer-harness.js";
import { cleanReview, PREFIX, routeEnv } from "./fixtures/route-harness.js";
import { gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * v0.3 — Stage 1 of validating Muse Exec 1.4.0-R4302.1 for the Reviewer binding. Muse updated itself on the maintainer's
 * machine from the validated 1.4.0-R4161.1 to 1.4.0-R4302.1, and Fusion correctly refuses the new binary: its validation is
 * bound to the old release AND its bytes. This milestone prepares exactly ONE real Reviewer turn on the new binary, in the
 * O5.5B24 shape, under an authorization the maintainer explicitly gave for one turn. Offline, the production authorization is
 * only ever refused (these tests run inside no terminal a human started); an open TEST copy of its exact shape runs on the
 * fake binary. Nothing here validates 1.4.0-R4302.1: only the independent review of a live PASS may record it.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const ID = "V0.3-MUSE-R4302-REVIEWER";
const R4302 = "1.4.0-R4302.1";
const PLAN = REVIEWER_PROBE_PROFILES.authorizations[ID]!;
const REVIEW = { prefix: PREFIX.review, output: cleanReview };
const exact = { role: "Reviewer", model: "muse-spark-1.3", effort: "low", options: { provider: "meta", maxModelSteps: 4, malformedOutputRetries: 0 } };

test("v0.3 R4302 authorization: exactly the O5.5B24 shape on the new binary, pinned by bytes; open; never validates anything by itself", async () => withRoot(async dir => {
  assert.deepEqual([PLAN.milestone, PLAN.evidenceDirectory, PLAN.state], ["V0.3-R4302", "fusion-v03-muse-r4302-reviewer", "open"]);
  assert.equal(PLAN.reviewer, MUSE_1_4_R4302_REVIEWER, "the pinned grant itself, not a copy that could drift");
  const grant = PLAN.reviewer;
  assert.deepEqual([grant.executable, grant.executableDirectory, grant.executableSha256, grant.runtimeVersions, grant.lanes],
    ["muse-bin-1.4.0-R4302.1.exe", "%LOCALAPPDATA%/Programs/muse", "61dbb475cb454e89d6e8c6d2e4a22332cd5437437c31654b3591abc72c6b14ac", [R4302], ["subscription"]]);
  // Everything but the binary is the O5.5B24-validated Reviewer binding: the same object, flags and budget.
  assert.equal(grant.binding, MUSE_1_4_REVIEWER.binding);
  assert.equal(grant.turnArgs, MUSE_1_4_REVIEWER.turnArgs);
  assert.deepEqual(grant.binding, { adapter: "muse-exec", model: "muse-spark-1.3", effort: "low",
    options: { provider: "meta", maxModelSteps: 4, malformedOutputRetries: 0, timeoutMs: 180_000 } });
  assert.deepEqual({ ...PLAN.turns }, { ...REVIEWER_ONLY_TURNS }, "one fresh review and no other turn class");
  assert.deepEqual([PLAN.fixtureSha256, PLAN.candidateSha256], [routeFixtureIdentity(), reviewCandidateIdentity()]);
  const namespaces = [...Object.values(ROUTE_REHEARSAL_PROFILES.authorizations), ...Object.values(PROPOSAL_PROBE_PROFILES.authorizations),
    ...Object.values(ADJUDICATION_PROBE_PROFILES.authorizations), REVIEWER_PROBE_PROFILES.authorizations["O5.5B24-REVIEWER"]!].map(entry => entry.evidenceDirectory);
  assert.ok(!namespaces.includes(PLAN.evidenceDirectory), "its own evidence namespace");
  // Stage 1 validates nothing: the release is only UNDER validation; R4161.1's binding validation is untouched.
  assert.equal(isValidatedRuntimeVersion("muse", "muse-exec", R4302), false);
  assert.equal(isValidatedForBinding("muse", "muse-exec", R4302, exact), false);
  assert.equal(bindingValidation("muse", "muse-exec", "1.4.0-R4161.1", exact)?.milestone, "O5.5B24");
  // The production authorization never runs from a test: inside an agent session it is refused before anything exists.
  const root = join(dir, "never-created");
  const nested = await runReviewerProbe({ env: { ...routeEnv(), CLAUDECODE: "1" }, registry: defaultRegistry(), profiles: REVIEWER_PROBE_PROFILES,
    authorization: ID, evidenceRoot: root });
  assert.ok("refused" in nested && nested.reason === "nestedAgentSession", JSON.stringify(nested));
  for (const [state, reason] of [["consumed", "authorizationConsumed"], ["pending", "authorizationPending"], ["retired", "authorizationRetired"]] as const) {
    const refused = await runReviewerProbe({ env: routeEnv(), registry: defaultRegistry(), authorization: ID, evidenceRoot: root,
      profiles: { ...REVIEWER_PROBE_PROFILES, authorizations: { [ID]: { ...PLAN, state } } } });
    assert.ok("refused" in refused && refused.reason === reason, `${state}: ${JSON.stringify(refused)}`);
  }
  assert.equal(await exists(root), false, "no namespace, fixture, claim, evidence or provider process");
}));

/** The open TEST copy: the plan's exact shape on the fake install of the release under validation (its bytes re-pinned). */
async function r4302(i: Installs): Promise<ReviewerProbeAuthorization> {
  await installMuseVersion(i, R4302);
  return { milestone: PLAN.milestone, evidenceDirectory: "fusion-test-reviewer", state: "open", turns: PLAN.turns,
    fixtureSha256: routeFixtureIdentity(), candidateSha256: reviewCandidateIdentity(),
    reviewer: { ...MUSE_1_4_R4302_REVIEWER, executableDirectory: i.museDir, executableSha256: await fileSha256(releaseExe(i, R4302)),
      binding: { ...MUSE_1_4_R4302_REVIEWER.binding, options: { ...MUSE_1_4_R4302_REVIEWER.binding.options, timeoutMs: 20_000 } } } };
}

test("v0.3 R4302 shape (open TEST copy, fake): exactly one Reviewer turn on the pinned binary; a second attempt is refused",
  { skip }, async () => withInstalls(async i => withRoot(async dir => {
    const authorization = await r4302(i);
    const run = asReviewerRun(await runReviewer(i, dir, "once", [REVIEW, REVIEW], { authorization, binary: releaseExe(i, R4302) }));
    assert.equal(run.report.outcome, "PASS", run.report.detail);
    assert.deepEqual([run.report.modelTurns, run.prompts.length], [1, 1], "one model turn, however many the script offers");
    assert.deepEqual(evidenceOf<Record<string, number>>(run, "turnUse"), { leadPlan: 0, changeAuthor: 0, freshReview: 1, leadAdjudication: 0 });
    assert.deepEqual(evidenceOf<Record<string, number>>(run, "launchCounts"),
      { providerAuthReadback: 0, providerInventory: 0, providerInitProbe: 0, providerTurn: 1, providerHost: 1 });
    assert.ok(evidenceOf<Array<{ executable: string }>>(run, "launches").every(l => l.executable === `muse-bin-${R4302}.exe`), "no other binary ran");
    assert.deepEqual(evidenceOf<{ version: string }>(run, "runtimeUnderValidation").version, R4302);
    const again = await runReviewer(i, dir, "once", [REVIEW], { authorization, binary: releaseExe(i, R4302) });
    assert.ok("refused" in again && again.reason === "alreadyAttempted", "the claim makes a second run refuse");
  })));

test("v0.3 R4302 fail-closed preflight: other bytes, the old or a nearby release, an API key, another model, steps or retry — refused before any model turn",
  { skip }, async () => withInstalls(async i => withRoot(async dir => {
    const authorization = await r4302(i);
    const blocked = async (name: string, outcome: string, detail: RegExp, options: Parameters<typeof runReviewer>[4] = {}) => {
      const run = asReviewerRun(await runReviewer(i, dir, name, [REVIEW], { authorization, binary: releaseExe(i, R4302), ...options }));
      assert.deepEqual([run.report.outcome, run.report.modelTurns, run.report.evidence.stage], [outcome, 0, "preflight"], `${name}: ${run.report.detail}`);
      assert.match(run.report.detail, detail, name);
      assert.equal((await readdir(run.root)).includes("reviewer.claim.json"), false, `${name}: a preflight block consumes nothing`);
    };
    // Another model, more steps or a retry: not the authorized binding.
    await blocked("model", "MODEL_BLOCKED", /binding differs/u, { binding: { model: "muse-spark-1.2" } });
    await blocked("steps", "MODEL_BLOCKED", /binding differs/u, { binding: { options: { maxModelSteps: 5 } } });
    await blocked("retry", "MODEL_BLOCKED", /binding differs/u, { binding: { options: { malformedOutputRetries: 1 } } });
    // An API key in the environment: the billing guard refuses before anything starts.
    await blocked("api-key", "AUTH_BLOCKED", /billing guard/u, { env: { ...routeEnv(), META_API_KEY: "x" } });
    // The same release name with other bytes: not the binary the maintainer's machine has. The fake install is a hard link
    // to a node copy other test processes run, so it is replaced by a private copy first and never written through.
    const bytes = await readFile(releaseExe(i, R4302));
    await rm(releaseExe(i, R4302));
    await writeFile(releaseExe(i, R4302), Buffer.concat([bytes, Buffer.from([0])]));
    await blocked("other-bytes", "VERSION_BLOCKED", /SHA-256 differs/u);
    // The old validated release or a nearby future release selected instead: never a fallback, never a neighbour.
    for (const release of ["1.4.0-R4161.1", "1.4.0-R4303.1", "1.4.1-R4302.1"]) {
      await installMuseVersion(i, release);
      await blocked(`release-${release}`, "VERSION_BLOCKED", /is not the release under validation/u, { binary: releaseExe(i, release) });
    }
  })));
