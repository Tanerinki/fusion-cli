import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { BindingConfig } from "../src/app/config.js";
import { REVIEWER_ONLY_TURNS, runReviewerProbe } from "../src/app/reviewer-probe.js";
import { reviewCandidateIdentity } from "../src/app/route-fixture.js";
import { routeFixtureIdentity } from "../src/app/route-probe.js";
import { REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport } from "../src/app/writer-gate.js";
import { VERIFIED_EXEC_WEB_DISABLE_VERSION } from "../src/providers/muse/types.js";
import { MUSE_1_4_REVIEWER, PROPOSAL_PROBE_PROFILES, REVIEWER_PROBE_PROFILES, ROUTE_REHEARSAL_PROFILES } from "../src/providers/probe-profiles.js";
import { defaultRegistry } from "../src/providers/registry.js";
import { bindingValidation, fullRouteLiveCoverage, fullRouteLiveRecords, isValidatedForBinding, isValidatedRuntimeVersion, leadPlanLiveRecords, reviewerLiveRecords,
  transportProfile } from "../src/runtime/provider-profiles.js";
import { exists } from "../src/app/proposal-probe.js";
import { withRoot } from "./fixtures/probe-harness.js";
import { installMuseVersion, withInstalls } from "./fixtures/provider-installs.js";
import { asReviewerRun, evidenceOf, installRelease, RELEASE, runReviewer, testReviewerAuthorization } from "./fixtures/reviewer-harness.js";
import { cleanReview, PREFIX, routeEnv } from "./fixtures/route-harness.js";
import { gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5B24 — one one-shot Reviewer-only authorization for the exact O5.5B23 Muse 1.4 binding: prepared pending (Stage 1),
 * opened by the human exactly as prepared, run once live (PASS), now CONSUMED. Offline: the production entry is only ever
 * refused; an open TEST copy of its exact shape runs on the fake binary only.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const ID = "O5.5B24-REVIEWER";
const PLAN = REVIEWER_PROBE_PROFILES.authorizations[ID]!;
const REVIEW = { prefix: PREFIX.review, output: cleanReview };

test("O5.5B24 authorization: one plan for exactly the O5.5B23 binding; opened as prepared, run once, now consumed — never run by a test", async () => withRoot(async dir => {
  assert.deepEqual(Object.keys(REVIEWER_PROBE_PROFILES.authorizations), [ID], "the only Reviewer-only authorization");
  assert.deepEqual([PLAN.milestone, PLAN.evidenceDirectory, PLAN.state], ["O5.5B24", "fusion-o5-5b24-reviewer", "consumed"]);
  assert.equal(PLAN.reviewer, MUSE_1_4_REVIEWER, "exactly the O5.5B23 binding, not a copy that could drift");
  assert.deepEqual({ ...PLAN.turns }, { ...REVIEWER_ONLY_TURNS }, "one fresh review and no other turn class");
  assert.deepEqual([PLAN.fixtureSha256, PLAN.candidateSha256], [routeFixtureIdentity(), reviewCandidateIdentity()]);
  const grant = PLAN.reviewer;
  assert.deepEqual([grant.executable, grant.executableDirectory, grant.executableSha256, grant.runtimeVersions, grant.lanes],
    ["muse-bin-1.4.0-R4161.1.exe", "%LOCALAPPDATA%/Programs/muse", "b33b493069a2593e97cc63f9a4063feb64269bf7f07a233f5db2db681ad5d950",
      ["1.4.0-R4161.1"], ["subscription"]]);
  assert.deepEqual(grant.binding, { adapter: "muse-exec", model: "muse-spark-1.3", effort: "low",
    options: { provider: "meta", maxModelSteps: 4, malformedOutputRetries: 0, timeoutMs: 180_000 } });
  assert.deepEqual(grant.turnArgs!.map(pair => [...pair]), [["--provider", "meta"], ["--model", "muse-spark-1.3"], ["--reasoning-effort", "low"],
    ["--max-model-steps", "4"]]);
  const namespaces = [...Object.values(ROUTE_REHEARSAL_PROFILES.authorizations), ...Object.values(PROPOSAL_PROBE_PROFILES.authorizations)]
    .map(entry => entry.evidenceDirectory);
  assert.ok(!namespaces.includes(PLAN.evidenceDirectory), "its own evidence namespace");
  // The consumed plan refuses before anything exists; so did its pending form (as Stage 1 prepared it) and, while it was
  // open, any start inside an agent session.
  const root = join(dir, "never-created");
  const consumed = await runReviewerProbe({ env: routeEnv(), registry: defaultRegistry(), profiles: REVIEWER_PROBE_PROFILES, authorization: ID, evidenceRoot: root });
  assert.ok("refused" in consumed && consumed.reason === "authorizationConsumed", JSON.stringify(consumed));
  const nested = await runReviewerProbe({ env: { ...routeEnv(), CLAUDECODE: "1" }, registry: defaultRegistry(), authorization: ID, evidenceRoot: root,
    profiles: { ...REVIEWER_PROBE_PROFILES, authorizations: { [ID]: { ...PLAN, state: "open" } } } });
  assert.ok("refused" in nested && nested.reason === "nestedAgentSession", JSON.stringify(nested));
  const pending = await runReviewerProbe({ env: routeEnv(), registry: defaultRegistry(), authorization: ID, evidenceRoot: root,
    profiles: { ...REVIEWER_PROBE_PROFILES, authorizations: { [ID]: { ...PLAN, state: "pending" } } } });
  assert.ok("refused" in pending && pending.reason === "authorizationPending", JSON.stringify(pending));
  assert.equal(await exists(root), false, "no namespace, fixture, claim, evidence or provider process");
}));

test("O5.5B24 shape (open TEST copy, fake): exactly one Reviewer turn; a second attempt is refused; no Lead, Worker or adjudication process",
  { skip }, async () => withInstalls(async i => withRoot(async dir => {
    await installRelease(i);
    const authorization = await testReviewerAuthorization(i, { milestone: PLAN.milestone, turns: PLAN.turns });
    const run = asReviewerRun(await runReviewer(i, dir, "once", [REVIEW, REVIEW], { authorization }));
    assert.equal(run.report.outcome, "PASS", run.report.detail);
    assert.deepEqual([run.report.modelTurns, run.prompts.length], [1, 1], "one model turn, however many the script offers");
    assert.deepEqual(evidenceOf<Record<string, number>>(run, "turnUse"), { leadPlan: 0, changeAuthor: 0, freshReview: 1, leadAdjudication: 0 });
    assert.deepEqual(evidenceOf<Record<string, number>>(run, "launchCounts"),
      { providerAuthReadback: 0, providerInventory: 0, providerInitProbe: 0, providerTurn: 1, providerHost: 1 });
    assert.ok(evidenceOf<Array<{ executable: string }>>(run, "launches").every(l => l.executable === `muse-bin-${RELEASE}.exe`),
      "no process of any other binary: no Lead, Worker or adjudicating Lead");
    assert.ok((await readdir(run.root)).includes("reviewer.claim.json"));
    const again = await runReviewer(i, dir, "once", [REVIEW], { authorization });
    assert.ok("refused" in again && again.reason === "alreadyAttempted", "the claim makes a second run refuse");
  })));

test("O5.5B24 exact binding, no fallback: the 1.3 selector, another model, more steps or a retry are all refused before any model turn",
  { skip }, async () => withInstalls(async i => withRoot(async dir => {
    await installRelease(i);
    const authorization = await testReviewerAuthorization(i, { milestone: PLAN.milestone, turns: PLAN.turns });
    for (const [name, patch, outcome] of [["model", { model: "muse-spark-1.2" }, "MODEL_BLOCKED"],
      ["steps", { options: { maxModelSteps: 5 } }, "MODEL_BLOCKED"], ["retry", { options: { malformedOutputRetries: 1 } }, "MODEL_BLOCKED"]] as const) {
      const run = asReviewerRun(await runReviewer(i, dir, name, [REVIEW], { authorization, binding: patch as Partial<BindingConfig> }));
      assert.deepEqual([run.report.outcome, run.report.modelTurns, run.report.evidence.stage], [outcome, 0, "preflight"], name);
    }
    await installMuseVersion(i, VERIFIED_EXEC_WEB_DISABLE_VERSION);
    const fallback = asReviewerRun(await runReviewer(i, dir, "fallback", [REVIEW], { authorization }));
    assert.deepEqual([fallback.report.outcome, fallback.report.modelTurns], ["VERSION_BLOCKED", 0], "never a fallback to the validated 1.3");
    assert.equal((await readdir(fallback.root)).includes("reviewer.claim.json"), false, "a preflight block consumes nothing");
  })));

test("O5.5B24 readiness: the live PASS is recorded and validates 1.4 for exactly the Reviewer binding — nothing wider; nothing open", () => {
  // Transport-wide nothing changed: 1.3.0-R3401.1 stays the only validated Exec release (its history intact).
  assert.equal(isValidatedRuntimeVersion("muse", "muse-exec", RELEASE), false);
  assert.deepEqual(transportProfile("muse", "muse-exec")!.compatibility, { kind: "validatedVersions", versions: [VERIFIED_EXEC_WEB_DISABLE_VERSION] });
  const exact = { role: "Reviewer", model: "muse-spark-1.3", effort: "low", options: { ...PLAN.reviewer.binding.options } };
  assert.equal(bindingValidation("muse", "muse-exec", RELEASE, exact)?.milestone, "O5.5B24");
  assert.equal(isValidatedForBinding("muse", "muse-exec", RELEASE, exact), true);
  assert.deepEqual(reviewerLiveRecords().map(r => [r.milestone, r.outcome, r.runtimeVersion, r.contract]), [["O5.5B24", "PASS", RELEASE, "accepted"]]);
  assert.ok(Object.values(REVIEWER_PROBE_PROFILES.authorizations).every(entry => entry.state !== "open"), "the Reviewer authorization is consumed");
  assert.ok(Object.values(ROUTE_REHEARSAL_PROFILES.authorizations).filter(entry => entry.milestone !== "O5.5B27").every(entry => entry.state !== "open"));
  assert.ok(Object.values(PROPOSAL_PROBE_PROFILES.authorizations).every(entry => entry.state === "consumed"));
  assert.deepEqual(leadPlanLiveRecords().map(r => [r.milestone, r.outcome]), [["O5.5B15", "FAIL"], ["O5.5B17", "FAIL"], ["O5.5B21", "PASS"]]);
  assert.deepEqual([fullRouteLiveCoverage().attempts >= 1, fullRouteLiveRecords().filter(r => r.milestone !== "O5.5B27").some(r => r.outcome === "PASS")], [true, false]);
  const report = writerGateReport();
  const rows = Object.fromEntries(report.rows.map(row => [row.id, [row.state, row.evidenceKind]]));
  assert.deepEqual([rows.fullRouteLive, rows.hostControlledWriterWorkflow, rows.providerChangeProposal, rows.liveGateAuthorization],
    [["partial", "recordedLiveProbe"], ["partial", "recordedLiveProbe"], ["satisfied", "recordedLiveProbe"], ["blocked", "none"]]);
  assert.deepEqual([report.realWriterModeReady, REAL_WRITER_LIVE_GATE_AUTHORIZED], [false, false]);
});
