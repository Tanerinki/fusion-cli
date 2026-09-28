import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import type { BindingConfig } from "../src/app/config.js";
import { fileSha256 } from "../src/app/executable-identity.js";
import type { ProviderRegistry, ProviderRuntimeContext } from "../src/app/providers.js";
import { bindingEligibility } from "../src/app/readiness.js";
import { runCli } from "../src/cli/run.js";
import type { ReviewRequest } from "../src/core/domain.js";
import { NO_EXTRA_CAPABILITIES, resolveRole } from "../src/core/policy/routing.js";
import { MuseAdapter } from "../src/providers/muse/muse-adapter.js";
import { VERIFIED_EXEC_WEB_DISABLE_VERSION } from "../src/providers/muse/types.js";
import { MUSE_1_4_R4302_REVIEWER, MUSE_1_4_REVIEWER, REVIEWER_PROBE_PROFILES } from "../src/providers/probe-profiles.js";
import { DEFAULT_CONFIG, defaultRegistry, museValidatedBindings } from "../src/providers/registry.js";
import { bindingValidation, isValidatedForBinding, isValidatedRuntimeVersion, reviewerLiveRecords, transportProfile,
  type BindingValidation } from "../src/runtime/provider-profiles.js";
import { withRoot } from "./fixtures/probe-harness.js";
import { EMPTY_HOME, installMuseVersion, launches, museBindingFor, museLaunch, MUSE_FIXTURE, selectUnstartedMuseVersion, withInstalls,
  type Installs } from "./fixtures/provider-installs.js";
import { releaseExe } from "./fixtures/reviewer-harness.js";
import { routeEnv } from "./fixtures/route-harness.js";
import { gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * v0.3 Stage 2 — Muse Exec 1.4.0-R4302.1 validated for EXACTLY the Reviewer binding of its live PASS (V0.3-R4302), on exactly
 * its binary, next to the unchanged O5.5B24 validation of 1.4.0-R4161.1. The maintainer ran the one authorized turn once from a
 * normal terminal; its evidence was reviewed independently (100 checks, docs/v0.3-muse-r4302-reviewer-validation.md). Offline:
 * the recorded data, the real registry's inspection and the real adapter on fake installs (whose bytes stand in for the
 * validated binary through the registry's test seam), the real `fusion --json doctor` report read by the v0.3 live
 * preconditions, and every way the validation must NOT generalize — above all to the Explorer binding.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const R4302 = "1.4.0-R4302.1", R4161 = "1.4.0-R4161.1";
const PIN_R4302 = "61dbb475cb454e89d6e8c6d2e4a22332cd5437437c31654b3591abc72c6b14ac";
const PIN_R4161 = "b33b493069a2593e97cc63f9a4063feb64269bf7f07a233f5db2db681ad5d950";
const EVIDENCE = "ac81b01eda1c282d25cd31bc42d561b5aecd1e97500970ff7839e9f77da2a752";
const RECORDED = transportProfile("muse", "muse-exec")!.bindingValidations;
const EXACT = { role: "Reviewer", model: "muse-spark-1.3", effort: "low", options: { provider: "meta", maxModelSteps: 4, malformedOutputRetries: 0 } };
const DEFAULT_EXPLORER = DEFAULT_CONFIG.bindings.find(b => b.role === "Explorer")!;
const DEFAULT_REVIEWER = DEFAULT_CONFIG.bindings.find(b => b.role === "Reviewer")!;
const factsOf = (binding: BindingConfig) => ({ role: binding.role, model: binding.model, effort: binding.effort, options: { ...binding.options } });

/** The recorded validations with ONE release re-pinned to the fake install's bytes (the only difference: that SHA-256). */
async function pinned(i: Installs, release: string): Promise<readonly BindingValidation[]> {
  const bytes = await fileSha256(releaseExe(i, release));
  return RECORDED.map(entry => entry.release === release ? { ...entry, executableSha256: bytes } : entry);
}
const bindingOf = (i: Installs, patch: Partial<BindingConfig> = {}, options: BindingConfig["options"] = EXACT.options): BindingConfig =>
  ({ role: "Reviewer", adapter: "muse-exec", model: EXACT.model, effort: EXACT.effort, ...patch, options: { ...options, binaryDirectory: i.museDir } });
const explorerOf = (i: Installs): BindingConfig => ({ ...DEFAULT_EXPLORER, options: { ...DEFAULT_EXPLORER.options, binaryDirectory: i.museDir } });
const contextOf = (i: Installs): ProviderRuntimeContext => ({ workspace: join(i.dir, "primary"), env: routeEnv(), sessionWorkspaces: "required" });
const ROUTING = { structuredTurns: true, reviewIsolation: true, workspaceBinding: true } as const;

test("V0.3-R4302 record: the second binding-scoped validation, exactly; O5.5B24's is unchanged; nothing transport-wide", () => {
  assert.deepEqual(RECORDED.map(entry => ({ ...entry, options: { ...entry.options } })), [
    { release: R4161, role: "Reviewer", model: "muse-spark-1.3", effort: "low", options: { provider: "meta", maxModelSteps: 4, malformedOutputRetries: 0 },
      executable: "muse-bin-1.4.0-R4161.1.exe", executableSha256: PIN_R4161, milestone: "O5.5B24",
      evidenceSha256: "a6ead8a22418996be9571677cf11a406f482b3db324efdc20559b3e88cea5c45", document: "docs/o5-5b24-muse14-reviewer-live.md" },
    { release: R4302, role: "Reviewer", model: "muse-spark-1.3", effort: "low", options: { provider: "meta", maxModelSteps: 4, malformedOutputRetries: 0 },
      executable: "muse-bin-1.4.0-R4302.1.exe", executableSha256: PIN_R4302, milestone: "V0.3-R4302", evidenceSha256: EVIDENCE,
      document: "docs/v0.3-muse-r4302-reviewer-validation.md" }]);
  // The validation pins exactly the binary the authorization pinned, and the same binding the O5.5B24 grant ran.
  assert.deepEqual([MUSE_1_4_R4302_REVIEWER.executableSha256, MUSE_1_4_REVIEWER.executableSha256], [PIN_R4302, PIN_R4161]);
  const [b24, r4302, ...more] = reviewerLiveRecords();
  assert.deepEqual([b24!.milestone, more], ["O5.5B24", []]);
  assert.deepEqual({ ...r4302, replyEnvelope: { ...r4302!.replyEnvelope }, terminal: { ...r4302!.terminal }, readback: { ...r4302!.readback },
    candidateVerification: { ...r4302!.candidateVerification } }, {
    milestone: "V0.3-R4302", authorization: "V0.3-MUSE-R4302-REVIEWER", provider: "muse", transport: "muse-exec", runtimeVersion: R4302,
    executable: "muse-bin-1.4.0-R4302.1.exe", executableSha256: PIN_R4302, model: "muse-spark-1.3", effort: "low", maxModelSteps: 4,
    malformedOutputRetries: 0, outcome: "PASS", modelTurns: 1, contract: "accepted", findings: 0,
    replyEnvelope: { policy: "rawOnly", classification: "RAW_VALID_JSON", accepted: true },
    terminal: { classification: "RESULT_OK", resultSubtype: "completed", terminalReason: "completed", isError: false, resultTextByteLength: 260,
      structuredParsingReached: true, schemaValidationReached: true, processExitCode: 0 },
    readback: { lane: "subscription", reportedRuntimeVersion: "1.4.0" }, candidateVerification: { passed: true, commandsRun: 2, acceptance: "granted" },
    ranAt: "2026-09-28T00:06:04.516Z", evidenceSha256: EVIDENCE, document: "docs/v0.3-muse-r4302-reviewer-validation.md" });
  // One run, one authorization: consumed, so a second run refuses (its own tests).
  assert.equal(REVIEWER_PROBE_PROFILES.authorizations["V0.3-MUSE-R4302-REVIEWER"]!.state, "consumed");
  // Transport-wide nothing changed: 1.3.0-R3401.1 stays the only validated Exec release; neither 1.4 release is transport-wide.
  assert.deepEqual(transportProfile("muse", "muse-exec")!.compatibility, { kind: "validatedVersions", versions: [VERIFIED_EXEC_WEB_DISABLE_VERSION] });
  for (const release of [R4302, R4161]) assert.equal(isValidatedRuntimeVersion("muse", "muse-exec", release), false, release);
  assert.deepEqual(transportProfile("muse", "muse-msp")!.bindingValidations, [], "the MSP transport gains nothing");
});

test("V0.3-R4302 scope (data): exactly the Reviewer binding on each release's own binary — no Explorer, model, effort, budget, retry or neighbour", () => {
  assert.equal(bindingValidation("muse", "muse-exec", R4302, EXACT)?.milestone, "V0.3-R4302");
  assert.equal(bindingValidation("muse", "muse-exec", R4161, EXACT)?.milestone, "O5.5B24", "the old validated runtime is unchanged");
  assert.equal(isValidatedForBinding("muse", "muse-exec", R4302, { ...EXACT, options: { ...EXACT.options, timeoutMs: 180_000, binaryDirectory: "x" } }), true,
    "locations and timeouts are not part of the scope");
  assert.equal(isValidatedForBinding("muse", "muse-exec", R4302, factsOf(DEFAULT_REVIEWER)), true, "the v0.1 default Reviewer is the validated binding");
  // Each release is bound to its own binary: the registry hands an exact binding both pairs, never one release's bytes for the other.
  assert.deepEqual(museValidatedBindings(DEFAULT_REVIEWER, RECORDED).map(entry => [entry.release, entry.executableSha256]), [[R4161, PIN_R4161], [R4302, PIN_R4302]]);
  // The Explorer stays UNVALIDATED on every release: its role, and the default Explorer binding (no step limit, default retry).
  for (const release of [R4302, R4161]) {
    assert.equal(isValidatedForBinding("muse", "muse-exec", release, { ...EXACT, role: "Explorer" }), false, `Explorer role on ${release}`);
    assert.equal(isValidatedForBinding("muse", "muse-exec", release, factsOf(DEFAULT_EXPLORER)), false, `default Explorer on ${release}`);
    assert.deepEqual(museValidatedBindings(DEFAULT_EXPLORER, RECORDED), [], "the registry gives the default Explorer no validated binary");
  }
  for (const [label, facts] of [["model 1.2", { ...EXACT, model: "muse-spark-1.2" }], ["effort minimal", { ...EXACT, effort: "minimal" }],
    ["5 steps", { ...EXACT, options: { ...EXACT.options, maxModelSteps: 5 } }], ["no step limit", { ...EXACT, options: { provider: "meta", malformedOutputRetries: 0 } }],
    ["1 retry", { ...EXACT, options: { ...EXACT.options, malformedOutputRetries: 1 } }], ["default retry", { ...EXACT, options: { provider: "meta", maxModelSteps: 4 } }],
    ["another provider", { ...EXACT, options: { ...EXACT.options, provider: "other" } }], ["Worker", { ...EXACT, role: "Worker" }]] as const)
    assert.equal(isValidatedForBinding("muse", "muse-exec", R4302, facts as typeof EXACT), false, label);
  // Nearby and future releases: never covered, whatever their name shares with a validated one.
  for (const release of ["1.4.0-R4303.1", "1.4.0-R4301.1", "1.4.0-R4302.2", "1.4.0-R4302", "1.4.1-R4302.1", "1.5.0-R4302.1", "1.4.0", "1.4.0-R4302.1 "])
    assert.equal(isValidatedForBinding("muse", "muse-exec", release, EXACT), false, JSON.stringify(release));
  assert.equal(isValidatedForBinding("muse", "muse-msp", R4302, EXACT), false, "the MSP transport");
});

test("V0.3-R4302 scope (real registry and adapter): R4302.1 on its validated binary is eligible and routed; another binary, release or the Explorer is not",
  async () => withInstalls(async i => {
    await installMuseVersion(i, R4302);
    const context = contextOf(i);
    const exec = defaultRegistry({ museBindingValidations: await pinned(i, R4302) }).factories.get("muse-exec")!;
    const exact = await exec.inspect(bindingOf(i), context);
    assert.deepEqual([exact.runtimeVersion, exact.capabilities?.webToolsDisabled, exact.capabilities?.approvalEscalationDisabled,
      exact.capabilities?.personalContextDisabled, exact.capabilities?.extensionsQuarantined, exact.capabilities?.webToolsDisabledEvidence?.versionVerified,
      exact.capabilities?.postureEvidence?.source, exact.capabilities?.postureEvidence?.versionVerified],
      [R4302, true, true, true, true, true, "launchFlag", true]);
    assert.deepEqual(exact.controls.map(control => [control.name, control.state]), [["launchReadOnlyFlags", "available"], ["approvalEscalation", "available"],
      ["personalContext", "available"], ["extensionIsolation", "available"], ["subscriptionLane", "available"]]);
    const eligible = bindingEligibility(bindingOf(i), exact);
    assert.deepEqual([eligible.readOnly.state, eligible.review.state, eligible.writer.state], ["eligible", "eligible", "blocked"], "read-only, never a writer");
    const created = await exec.create(bindingOf(i), context);
    assert.equal((await resolveRole("Reviewer", [created], NO_EXTRA_CAPABILITIES, ROUTING)).binding.transport, "muse-exec", "production fresh-review routing accepts it");
    // The Explorer binding on the same validated binary: no posture fact is claimed, so it is neither eligible nor routed.
    const explorer = await exec.inspect(explorerOf(i), context);
    assert.deepEqual([explorer.capabilities?.webToolsDisabled, explorer.controls.find(c => c.name === "launchReadOnlyFlags")?.state,
      bindingEligibility(explorerOf(i), explorer).readOnly.state === "eligible", bindingEligibility(explorerOf(i), explorer).review.state === "eligible"],
      ["unknown", "unknown", false, false]);
    assert.equal((await (await exec.create(explorerOf(i), context)).adapter.capabilities()).webToolsDisabled, "unknown", "the Explorer adapter claims nothing");
    // The same release name with another binary: the recorded (real) SHA-256 is not the fake install's bytes.
    const production = defaultRegistry().factories.get("muse-exec")!;
    const swapped = await production.inspect(bindingOf(i), context);
    assert.deepEqual([swapped.runtimeVersion, swapped.capabilities?.webToolsDisabled, bindingEligibility(bindingOf(i), swapped).review.state === "eligible",
      bindingEligibility(bindingOf(i), swapped).readOnly.state === "eligible"], [R4302, "unknown", false, false]);
    await assert.rejects(resolveRole("Reviewer", [await production.create(bindingOf(i), context)], NO_EXTRA_CAPABILITIES, ROUTING), "a swapped binary is never routed");
    // R4161.1's validation never covers R4302.1's bytes: pin only the OLD release to these bytes and the new release is refused.
    const bytes = await fileSha256(releaseExe(i, R4302));
    const oldOnly = defaultRegistry({ museBindingValidations: RECORDED.map(entry => entry.release === R4161 ? { ...entry, executableSha256: bytes } : entry) });
    const crossed = await oldOnly.factories.get("muse-exec")!.inspect(bindingOf(i), context);
    assert.deepEqual([crossed.capabilities?.webToolsDisabled, bindingEligibility(bindingOf(i), crossed).review.state === "eligible"], ["unknown", false]);
    // A nearby release with the exact binding, even on the very bytes R4302.1's validation names: not covered.
    const r4302 = RECORDED.find(entry => entry.release === R4302)!;
    for (const release of ["1.4.0-R4303.1", "1.4.1-R4302.1"]) {
      await selectUnstartedMuseVersion(i, release);
      const nearby = defaultRegistry({ museBindingValidations: [{ ...r4302, executableSha256: await fileSha256(releaseExe(i, release)) }] });
      const inspection = await nearby.factories.get("muse-exec")!.inspect(bindingOf(i), context);
      assert.deepEqual([inspection.runtimeVersion, inspection.capabilities?.webToolsDisabled, bindingEligibility(bindingOf(i), inspection).review.state === "eligible"],
        [release, "unknown", false], release);
    }
  }));

test("V0.3-R4302 scope (the old validated runtime): R4161.1 on its own validated binary stays eligible; R4302.1's pin never covers it", async () =>
  withInstalls(async i => {
    await installMuseVersion(i, R4161);
    const context = contextOf(i);
    const old = await defaultRegistry({ museBindingValidations: await pinned(i, R4161) }).factories.get("muse-exec")!.inspect(bindingOf(i), context);
    assert.deepEqual([old.runtimeVersion, old.capabilities?.webToolsDisabled, bindingEligibility(bindingOf(i), old).review.state], [R4161, true, "eligible"]);
    // The same bytes named by R4302.1's validation only: the release differs, so nothing is claimed.
    const bytes = await fileSha256(releaseExe(i, R4161));
    const r4302Only = defaultRegistry({ museBindingValidations: RECORDED.map(entry => entry.release === R4302 ? { ...entry, executableSha256: bytes } : entry) });
    const inspection = await r4302Only.factories.get("muse-exec")!.inspect(bindingOf(i), context);
    assert.deepEqual([inspection.capabilities?.webToolsDisabled, bindingEligibility(bindingOf(i), inspection).review.state === "eligible"], ["unknown", false]);
  }));

test("V0.3-R4302 scope (the turn itself): on a binary other than the validated R4302.1 the Exec adapter refuses before any process starts", async () =>
  withInstalls(async i => withRoot(async dir => {
    await installMuseVersion(i, R4302);
    const view = join(dir, "view");
    await mkdir(view);
    const config = { ...museLaunch(i, join(dir, "primary"), {}), malformedOutputRetries: 0 as const,
      validatedBindings: museValidatedBindings(bindingOf(i), RECORDED) };
    const adapter = new MuseAdapter(museBindingFor("Reviewer", config), config, undefined, { executable: releaseExe(i, R4302), argvPrefix: [MUSE_FIXTURE] });
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

// ---------------------------------------------------------------- the v0.3 live preconditions, from the real doctor report

type Verdict = { confirmed: boolean; lines: string[]; reasons: string[] };
type Preconditions = { parseDoctorReport(stdout: string): unknown; evaluatePreconditions(report: unknown): Verdict };
const preconditions = async (): Promise<Preconditions> =>
  await import(pathToFileURL(resolve(process.cwd(), "scripts", "v03-live-preconditions.mjs")).href) as Preconditions;
type Report = { providers: Array<{ role: string; postureEvidence: string; inspection?: { runtimeVersion: string }; eligibility: { readOnly: { state: string } };
  probe?: unknown }> };
/** What a successful `--probe` adds (auth readbacks; the Lead's runtime posture) — the probe itself needs the real CLIs. */
const LEAD_PROBE = { auth: { state: "authenticated", lane: "subscriptionToken", detail: "claude auth status" },
  posture: { state: "attested", version: "2.1.283", detail: "canary check passed on this runtime" } };
const MUSE_LOGIN = { auth: { state: "authenticated", lane: "subscription", detail: "msp:account/read:accountLogin" } };

/**
 * `fusion --json doctor` exactly as the maintainer's machine runs it — the DEFAULT configuration (no fusion.config.json), the
 * real registry and its real static inspection of the installed Muse release — with only the recorded SHA-256 of `pinnedRelease`
 * re-pinned to the fake install's bytes (the test seam). Returns the parsed structured report.
 */
async function doctorReport(i: Installs, root: string, validations: readonly BindingValidation[], env: NodeJS.ProcessEnv = {}): Promise<Report> {
  const real = defaultRegistry({ museBindingValidations: validations });
  const registry: ProviderRegistry = { ...real, defaults: { ...DEFAULT_CONFIG, bindings: DEFAULT_CONFIG.bindings.map(binding =>
    binding.adapter === "claude-one-shot" ? { ...binding, options: { ...binding.options, executable: i.claudeExe } } : binding) } };
  let stdout = "";
  await runCli(["--json", "doctor"], { stdout: text => { stdout += text; }, stderr: () => undefined }, { cwd: root, registry,
    env: { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
      USERPROFILE: EMPTY_HOME, FUSION_MUSE_BIN_DIR: i.museDir, ...env } });
  return JSON.parse(stdout) as Report;
}
const withProbes = (report: Report, reviewer: unknown = MUSE_LOGIN): Report => ({ ...report, providers: report.providers.map(provider =>
  ({ ...provider, probe: provider.role === "Lead" ? LEAD_PROBE : provider.role === "Reviewer" ? reviewer : MUSE_LOGIN })) });
async function repository(i: Installs): Promise<string> {
  const root = join(i.dir, "repo");
  await mkdir(root);
  await writeFile(join(root, "README.md"), "fixture\n");
  const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd: root, encoding: "utf8", windowsHide: true });
  for (const args of [["init", "-q"], ["add", "."], ["commit", "-qm", "init"]]) assert.equal(git(...args).status, 0, args.join(" "));
  return root;
}

test("v0.3 live preconditions: the real doctor report of the validated R4302.1 Reviewer is CONFIRMED; the Explorer stays unproven",
  { skip }, async () => withInstalls(async i => {
    await installMuseVersion(i, R4302);
    const root = await repository(i);
    const m = await preconditions();
    const report = await doctorReport(i, root, await pinned(i, R4302));
    const reviewer = report.providers.find(p => p.role === "Reviewer")!, explorer = report.providers.find(p => p.role === "Explorer")!;
    assert.deepEqual([reviewer.inspection?.runtimeVersion, reviewer.postureEvidence, reviewer.eligibility.readOnly.state], [R4302, "launchTime", "eligible"]);
    // The Explorer binding on the same binary proves nothing; the validated Reviewer binding is the exploration transport.
    assert.deepEqual([explorer.inspection?.runtimeVersion, explorer.postureEvidence, explorer.eligibility.readOnly.state === "eligible"], [R4302, "none", false]);
    const verdict = m.evaluatePreconditions(m.parseDoctorReport(JSON.stringify(withProbes(report))));
    assert.deepEqual(verdict.reasons, []);
    assert.equal(verdict.confirmed, true);
    assert.ok(verdict.lines.includes("Reviewer (muse-exec): auth authenticated (subscription login); posture evidence launchTime; read-only eligible"), JSON.stringify(verdict.lines));
  }));

test("v0.3 live preconditions stay fail-closed: another binary, a nearby release, an API key or an unconfirmed login still stop before any model turn",
  { skip }, async () => withInstalls(async i => {
    await installMuseVersion(i, R4302);
    const root = await repository(i);
    const m = await preconditions();
    const refused = (report: Report, reviewer?: unknown) => m.evaluatePreconditions(m.parseDoctorReport(JSON.stringify(withProbes(report, reviewer))));
    const notValidated = (release: string) => `the Reviewer's read-only posture is not proven at launch time: Muse ${release} is not a validated release ` +
      "for this binding (Fusion will not let it investigate or review)";
    // The recorded pin against other bytes under the same name (the production validations on a fake binary).
    const swapped = refused(await doctorReport(i, root, RECORDED));
    assert.deepEqual([swapped.confirmed, swapped.reasons], [false, [notValidated(R4302)]]);
    // Its subscription login is still required, on its own lane, even when the binding is validated.
    const validated = await doctorReport(i, root, await pinned(i, R4302));
    for (const [probe, reason] of [[{ auth: { state: "unauthenticated", lane: "subscription", detail: "d" } }, "the Reviewer's login is unauthenticated, not authenticated"],
      [{ auth: { state: "authenticated", lane: "subscriptionToken", detail: "d" } }, "the Reviewer authenticated on the subscription OAuth token lane, not its subscription login"],
      [{ auth: { state: "authenticated", lane: "api", detail: "d" } }, "the Reviewer authenticated on the api lane, not its subscription login"],
      [{ error: "probe failed" }, "the Reviewer probe failed: probe failed"]] as const) {
      const verdict = refused(validated, probe);
      assert.deepEqual([verdict.confirmed, verdict.reasons], [false, [reason]], JSON.stringify(probe));
    }
    // An API key in the environment: the billing guard blocks the binding, so its posture is not eligible either.
    const keyed = refused(await doctorReport(i, root, await pinned(i, R4302), { META_API_KEY: "not-a-real-key-v03-r4302" }));
    assert.equal(keyed.confirmed, false);
    assert.ok(keyed.reasons.includes(notValidated(R4302)), JSON.stringify(keyed.reasons));
    // A nearby release (Muse updating itself again) with the exact binding: named, and refused.
    const pins = await pinned(i, R4302);
    await installMuseVersion(i, "1.4.0-R4303.1");
    const nearby = refused(await doctorReport(i, root, pins));
    assert.deepEqual([nearby.confirmed, nearby.reasons], [false, [notValidated("1.4.0-R4303.1")]]);
  }));
