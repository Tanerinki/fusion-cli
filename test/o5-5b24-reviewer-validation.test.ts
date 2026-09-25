import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { BindingConfig } from "../src/app/config.js";
import { fileSha256 } from "../src/app/executable-identity.js";
import type { ProviderRuntimeContext } from "../src/app/providers.js";
import { bindingEligibility } from "../src/app/readiness.js";
import type { ReviewRequest } from "../src/core/domain.js";
import { NO_EXTRA_CAPABILITIES, resolveRole } from "../src/core/policy/routing.js";
import { MuseAdapter } from "../src/providers/muse/muse-adapter.js";
import { VERIFIED_EXEC_WEB_DISABLE_VERSION } from "../src/providers/muse/types.js";
import { MUSE_1_4_REVIEWER, PROPOSAL_PROBE_PROFILES } from "../src/providers/probe-profiles.js";
import { DEFAULT_CONFIG, defaultRegistry } from "../src/providers/registry.js";
import { bindingValidation, changeProposalLiveRecords, isValidatedForBinding, isValidatedRuntimeVersion, reviewerLiveRecords, routePreflightBlocks,
  transportProfile, type BindingValidation } from "../src/runtime/provider-profiles.js";
import { withRoot } from "./fixtures/probe-harness.js";
import { installMuseVersion, launches, museBindingFor, museLaunch, MUSE_FIXTURE, withInstalls, type Installs } from "./fixtures/provider-installs.js";
import { RELEASE, releaseExe } from "./fixtures/reviewer-harness.js";
import { routeEnv } from "./fixtures/route-harness.js";

/**
 * O5.5B24 Stage 2 — Muse Exec 1.4.0-R4161.1 validated for EXACTLY the Reviewer binding of the live PASS, on exactly its
 * binary: the recorded validation, the real registry's inspection and the real adapter on fake installs (whose bytes stand
 * in for the validated binary through the registry's test seam), and every way the validation must NOT generalize.
 */
const [RECORDED] = transportProfile("muse", "muse-exec")!.bindingValidations;
const EXACT = { role: "Reviewer", model: "muse-spark-1.3", effort: "low", options: { provider: "meta", maxModelSteps: 4, malformedOutputRetries: 0 } };
/** The recorded validation, re-pinned to the fake install's bytes (the only difference: the SHA-256 of the binary). */
async function fakeValidations(i: Installs): Promise<readonly BindingValidation[]> {
  return [{ ...RECORDED!, executableSha256: await fileSha256(releaseExe(i)) }];
}
const bindingOf = (i: Installs, patch: Partial<BindingConfig> = {}, options: BindingConfig["options"] = EXACT.options): BindingConfig =>
  ({ role: "Reviewer", adapter: "muse-exec", model: EXACT.model, effort: EXACT.effort, ...patch, options: { ...options, binaryDirectory: i.museDir } });
const contextOf = (i: Installs): ProviderRuntimeContext => ({ workspace: join(i.dir, "primary"), env: routeEnv(), sessionWorkspaces: "required" });

test("O5.5B24 record: the Reviewer live PASS and the binding-scoped validation it supports, exactly", () => {
  assert.deepEqual(RECORDED, { release: "1.4.0-R4161.1", role: "Reviewer", model: "muse-spark-1.3", effort: "low",
    options: { provider: "meta", maxModelSteps: 4, malformedOutputRetries: 0 }, executable: "muse-bin-1.4.0-R4161.1.exe",
    executableSha256: MUSE_1_4_REVIEWER.executableSha256, milestone: "O5.5B24",
    evidenceSha256: "a6ead8a22418996be9571677cf11a406f482b3db324efdc20559b3e88cea5c45", document: "docs/o5-5b24-muse14-reviewer-live.md" });
  const [record, ...rest] = reviewerLiveRecords();
  assert.deepEqual(rest, []);
  assert.deepEqual([record!.milestone, record!.authorization, record!.outcome, record!.runtimeVersion, record!.executableSha256, record!.model,
    record!.effort, record!.maxModelSteps, record!.malformedOutputRetries, record!.modelTurns, record!.contract, record!.findings],
    ["O5.5B24", "O5.5B24-REVIEWER", "PASS", RELEASE, MUSE_1_4_REVIEWER.executableSha256, "muse-spark-1.3", "low", 4, 0, 1, "accepted", 0]);
  assert.deepEqual(record!.replyEnvelope, { policy: "rawOnly", classification: "RAW_VALID_JSON", accepted: true });
  assert.deepEqual([record!.terminal.classification, record!.terminal.processExitCode, record!.readback], ["RESULT_OK", 0,
    { lane: "subscription", reportedRuntimeVersion: "1.4.0" }]);
  assert.equal(record!.evidenceSha256, RECORDED!.evidenceSha256);
  // Muse 1.3 history is preserved: still the only transport-wide validated release, its Change Author PASS unchanged.
  assert.deepEqual(transportProfile("muse", "muse-exec")!.compatibility, { kind: "validatedVersions", versions: [VERIFIED_EXEC_WEB_DISABLE_VERSION] });
  assert.equal(VERIFIED_EXEC_WEB_DISABLE_VERSION, "1.3.0-R3401.1");
  assert.deepEqual(changeProposalLiveRecords("muse", "muse-exec").map(r => [r.milestone, r.runtimeVersion, r.outcome]), [["O5.5B9", "1.3.0-R3401.1", "PASS"]]);
  assert.deepEqual(routePreflightBlocks().map(r => [r.milestone, r.installedVersion, r.outcome]), [["O5.5B19", RELEASE, "VERSION_BLOCKED"]], "history untouched");
  assert.equal(isValidatedRuntimeVersion("muse", "muse-exec", RELEASE), false, "never transport-wide");
});

test("O5.5B24 scope (data): exactly the Reviewer binding — no other role, model, effort, step budget, retry policy, transport or release", () => {
  assert.equal(bindingValidation("muse", "muse-exec", RELEASE, EXACT), RECORDED);
  assert.equal(isValidatedForBinding("muse", "muse-exec", RELEASE, { ...EXACT, options: { ...EXACT.options, timeoutMs: 180_000, binaryDirectory: "x" } }), true,
    "locations and timeouts are not part of the scope");
  const worker = PROPOSAL_PROBE_PROFILES.profiles.muse!.binding;
  for (const [label, facts] of [["Explorer", { ...EXACT, role: "Explorer" }], ["Worker (the Muse Change Author)", { ...worker, options: { ...worker.options } }],
    ["model 1.2", { ...EXACT, model: "muse-spark-1.2" }], ["effort minimal", { ...EXACT, effort: "minimal" }],
    ["5 steps", { ...EXACT, options: { ...EXACT.options, maxModelSteps: 5 } }], ["no step limit", { ...EXACT, options: { provider: "meta", malformedOutputRetries: 0 } }],
    ["1 retry", { ...EXACT, options: { ...EXACT.options, malformedOutputRetries: 1 } }], ["default retry", { ...EXACT, options: { provider: "meta", maxModelSteps: 4 } }],
    ["the default production Reviewer", { ...DEFAULT_CONFIG.bindings.find(b => b.role === "Reviewer")!, options: { ...DEFAULT_CONFIG.bindings.find(b => b.role === "Reviewer")!.options } }]] as const)
    assert.equal(isValidatedForBinding("muse", "muse-exec", RELEASE, facts as typeof EXACT), false, label);
  for (const release of ["1.4.1-R9999.1", "1.4.0-R4161.2", "1.4.0"]) assert.equal(isValidatedForBinding("muse", "muse-exec", release, EXACT), false, release);
  assert.equal(isValidatedForBinding("muse", "muse-msp", RELEASE, EXACT), false, "the MSP transport");
  assert.equal(isValidatedForBinding("muse", "muse-exec", VERIFIED_EXEC_WEB_DISABLE_VERSION, EXACT), true, "1.3 stays validated transport-wide");
});

test("O5.5B24 scope (real registry and adapter): the exact binding on the validated binary is eligible and routed; nothing else is", async () =>
  withInstalls(async i => {
    await installMuseVersion(i, RELEASE);
    const registry = defaultRegistry({ museBindingValidations: await fakeValidations(i) });
    const exec = registry.factories.get("muse-exec")!;
    const context = contextOf(i);
    const exact = await exec.inspect(bindingOf(i), context);
    assert.deepEqual([exact.runtimeVersion, exact.capabilities?.webToolsDisabled, exact.capabilities?.webToolsDisabledEvidence?.versionVerified,
      exact.controls.find(c => c.name === "launchReadOnlyFlags")?.state, bindingEligibility(bindingOf(i), exact).review.state],
      [RELEASE, true, true, "available", "eligible"]);
    assert.ok(exact.notes.some(note => note.includes("validated only for exactly this binding")));
    const created = await exec.create(bindingOf(i), context);
    assert.equal((await created.adapter.capabilities()).webToolsDisabled, true);
    const routed = await resolveRole("Reviewer", [created], NO_EXTRA_CAPABILITIES, { structuredTurns: true, reviewIsolation: true, workspaceBinding: true });
    assert.equal(routed.binding.transport, "muse-exec", "the production fresh-review routing accepts it");
    const defaultReviewer = DEFAULT_CONFIG.bindings.find(b => b.role === "Reviewer")!;
    for (const [label, binding] of [["Explorer", bindingOf(i, { role: "Explorer" })], ["model 1.2", bindingOf(i, { model: "muse-spark-1.2" })],
      ["effort minimal", bindingOf(i, { effort: "minimal" })], ["5 steps", bindingOf(i, {}, { ...EXACT.options, maxModelSteps: 5 })],
      ["1 retry", bindingOf(i, {}, { ...EXACT.options, malformedOutputRetries: 1 })],
      ["the default production Reviewer (no step limit, one retry)", bindingOf(i, { model: defaultReviewer.model, effort: defaultReviewer.effort }, { ...defaultReviewer.options })]] as const) {
      const inspection = await exec.inspect(binding, context);
      assert.deepEqual([inspection.capabilities?.webToolsDisabled, bindingEligibility(binding, inspection).review.state === "eligible"], ["unknown", false], label);
      assert.equal((await (await exec.create(binding, context)).adapter.capabilities()).webToolsDisabled, "unknown", label);
    }
    const author = await exec.createChangeAuthor!({ ...bindingOf(i), role: "Worker" }, context);
    assert.equal((await author.adapter.capabilities()).webToolsDisabled, "unknown", "the Change Author is not covered");
    // Another binary under the validated name: the recorded (real) SHA-256 is not the fake install's bytes.
    const recorded = defaultRegistry().factories.get("muse-exec")!;
    const swapped = await recorded.inspect(bindingOf(i), context);
    assert.deepEqual([swapped.capabilities?.webToolsDisabled, bindingEligibility(bindingOf(i), swapped).review.state === "eligible"], ["unknown", false]);
    await assert.rejects(resolveRole("Reviewer", [await recorded.create(bindingOf(i), context)], NO_EXTRA_CAPABILITIES,
      { structuredTurns: true, reviewIsolation: true, workspaceBinding: true }), "a swapped binary is never routed");
    // Another release with the same binding: not covered.
    await installMuseVersion(i, "1.4.1-R9999.1");
    assert.equal((await exec.inspect(bindingOf(i), context)).capabilities?.webToolsDisabled, "unknown");
  }));

test("O5.5B24 scope (the turn itself): on a binary other than the validated one the Exec adapter refuses before any process starts", async () =>
  withInstalls(async i => withRoot(async dir => {
    await installMuseVersion(i, RELEASE);
    const view = join(dir, "view");
    await mkdir(view);
    const config = { ...museLaunch(i, join(dir, "primary"), {}), malformedOutputRetries: 0 as const,
      validatedBindings: [{ release: RELEASE, executableSha256: MUSE_1_4_REVIEWER.executableSha256 }] };
    const adapter = new MuseAdapter(museBindingFor("Reviewer", config), config, undefined, { executable: releaseExe(i), argvPrefix: [MUSE_FIXTURE] });
    const session = await adapter.createSession({ runId: "run-1", role: "Reviewer", workspaceLeaseId: "lease-1", posture: "readOnly", model: config.model,
      workspace: { id: "view-1", root: view } });
    const request: ReviewRequest = { kind: "review", cycle: 1, priorFindings: [], limits: { maxFindings: 32 }, evidence: {
      task: { goal: "Review.", constraints: [], acceptanceCriteria: [] }, architecture: { decisions: [], invariants: [] },
      scope: { relevantFiles: [], allowedFiles: [], forbiddenFiles: [] }, verification: { required: false, passed: false, commands: [] },
      change: { kind: "diff", changedPaths: [], text: "", truncated: false } } };
    const result = await adapter.runStructuredTurn!(session, request);
    assert.deepEqual([result.status, result.status === "completed" ? undefined : result.error.kind], ["failed", "CapabilityUnavailable"]);
    assert.deepEqual(await launches(i.record), [], "no Muse process at all");
    await adapter.close(session);
  })));
