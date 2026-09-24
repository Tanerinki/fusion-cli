import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { BindingConfig } from "../../src/app/config.js";
import { PROBE_BUGGY, PROBE_TARGET, runProposalProbe, type ProbeDependencies, type ProbeProfileSet, type ProbeReport,
  type ProbeRefusal } from "../../src/app/proposal-probe.js";
import { buildWriterCandidates, type AdapterFactory, type ProviderRegistry } from "../../src/app/providers.js";
import { providerViewPort, WRITER_ROLES, type ProductionWriterOptions, type WriterComposition } from "../../src/app/writer-composition.js";
import type { ProviderAdapter } from "../../src/core/domain.js";
import { DockerLinuxVerificationBackend } from "../../src/platform/verification/docker/backend.js";
import { VerificationService } from "../../src/platform/verification/selection.js";
import { OFFLINE_REHEARSAL, PrivateCandidateWorkspacePort } from "../../src/platform/workflow/candidates.js";
import { ProcessGitClient } from "../../src/platform/workspace/git.js";
import { ClaudeAdapter } from "../../src/providers/claude/claude-adapter.js";
import { MuseAdapter } from "../../src/providers/muse/muse-adapter.js";
import { VERIFIED_EXEC_WEB_DISABLE_VERSION } from "../../src/providers/muse/types.js";
import { PROPOSAL_PROBE_PROFILES } from "../../src/providers/probe-profiles.js";
import { defaultRegistry } from "../../src/providers/registry.js";
import { FAKE_DOCKER_EXE, FAKE_IMAGE, FakeDocker } from "./fake-docker.js";
import { changeSet, oracle, sha256, testSummary } from "./fake-writer.js";
import { claudeBinary, claudeBindingFor, claudeLaunch, EMPTY_HOME, museBinary, museBindingFor, museLaunch, type Installs } from "./provider-installs.js";

/**
 * The offline harness of the authorized change-proposal probe (O5.5B9, O5.5B10): the REAL Claude and Muse adapter code
 * launches the deterministic fake native binaries (never a provider), the real engine, private candidate port and view
 * store run over a real Git fixture, and verification uses the real Docker backend over the in-memory daemon. Every such
 * run is labelled `offlineRehearsal` and cannot count as live evidence.
 */
export const FIXED = PROBE_BUGGY.replace("return name.toLowerCase();", "return name.trim().toLowerCase();");
export const PROPOSAL = JSON.stringify(changeSet([[PROBE_TARGET, PROBE_BUGGY, FIXED]]));
export const BASELINE_HASH = sha256(PROBE_BUGGY);
export const PROPOSAL_PREFIX = "Fusion change proposal.";
export const PROFILES = PROPOSAL_PROBE_PROFILES.profiles as Readonly<Record<"claude" | "muse", (typeof PROPOSAL_PROBE_PROFILES.profiles)[string]>>;
/**
 * TEST-ONLY authorization over both families with the fake installs' bindings (model `alias`, canonical
 * `claude-canonical-fixture`). It is added to a COPY of the production probe profiles; the production table is unchanged.
 */
export const TEST_AUTHORIZATION = "TEST-REHEARSAL";
export const TEST_PROFILES: ProbeProfileSet = Object.freeze({ ...PROPOSAL_PROBE_PROFILES, authorizations: Object.freeze({
  ...PROPOSAL_PROBE_PROFILES.authorizations,
  [TEST_AUTHORIZATION]: Object.freeze({ milestone: "TEST", evidenceDirectory: "fusion-test-probe", state: "open" as const, grants: Object.freeze({
    claude: Object.freeze({ runtimeVersions: ["2.1.280"], lanes: ["subscription", "subscriptionToken"], requiredEnvironment: [],
      binding: { adapter: "claude-one-shot", model: "alias", effort: "low", maxTurns: 3, options: { canonicalModel: "claude-canonical-fixture" } } }),
    muse: Object.freeze({ runtimeVersions: [VERIFIED_EXEC_WEB_DISABLE_VERSION], lanes: ["subscription"], requiredEnvironment: [],
      binding: { adapter: "muse-exec", model: "muse-spark-1.3", effort: "minimal", options: { provider: "meta", maxModelSteps: 4 } } }) }) }) }) });
/** The probe under the test authorization by default; a test names the production profiles and authorization explicitly. */
export const probe = (provider: string, deps: Omit<ProbeDependencies, "profiles" | "authorization"> &
  Partial<Pick<ProbeDependencies, "profiles" | "authorization">>) =>
  runProposalProbe(provider, { profiles: TEST_PROFILES, authorization: TEST_AUTHORIZATION, ...deps });

/** A provider-free environment for the harness itself (Git on PATH, an empty Claude home). */
export function cleanEnv(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const keep = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "PATHEXT", "SYSTEMROOT"].includes(key.toUpperCase())));
  return { ...keep, USERPROFILE: EMPTY_HOME, ...extra };
}
export async function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "fusion-b9-test-"));
  try { return await run(root); }
  finally {
    assert.ok(resolve(root).toLowerCase().startsWith(`${resolve(tmpdir()).toLowerCase()}${sep}`));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
/**
 * The default registry's static inspection (install, version, billing) with Change Authors built on the fake binaries
 * through the REAL adapters; the probe's launch observer reaches them exactly as through the production registry.
 */
export function testRegistry(i: Installs, fakeEnv: Readonly<Record<string, string>>): ProviderRegistry {
  const real = defaultRegistry();
  const claude = real.factories.get("claude-one-shot")!, muse = real.factories.get("muse-exec")!;
  const claudeFactory: AdapterFactory = { kind: "claude-one-shot", inspect: claude.inspect, probe: claude.probe, create: claude.create,
    async createChangeAuthor(binding, context) {
      const canonical = binding.options.canonicalModel;
      const config = { ...claudeLaunch(i, context.workspace, fakeEnv, { model: { id: binding.model, effort: binding.effort,
        maxTurns: binding.maxTurns ?? 1 }, ...(typeof canonical === "string" ? { expectedCanonicalModel: canonical } : {}) }),
        ...(context.launchObserver ? { launchObserver: context.launchObserver } : {}) };
      const role = claudeBindingFor("Worker", config);
      return { binding: role, adapter: new ClaudeAdapter(role, config, claudeBinary) as ProviderAdapter };
    } };
  const museFactory: AdapterFactory = { kind: "muse-exec", inspect: muse.inspect, probe: muse.probe, create: muse.create,
    async createChangeAuthor(binding, context) {
      const retries = binding.options.malformedOutputRetries;
      const config = { ...museLaunch(i, context.workspace, fakeEnv, { model: { id: binding.model, effort: binding.effort },
        ...(retries === 0 || retries === 1 ? { malformedOutputRetries: retries } : {}) }),
        ...(context.launchObserver ? { launchObserver: context.launchObserver } : {}) };
      const role = museBindingFor("Worker", config);
      return { binding: role, adapter: new MuseAdapter(role, config, undefined, museBinary(i)) as ProviderAdapter };
    } };
  return { ...real, factories: new Map([["claude-one-shot", claudeFactory], ["muse-exec", museFactory]]) };
}
export const claudeBinding = (i: Installs): BindingConfig => ({ ...PROFILES.claude.binding, model: "alias",
  options: { ...PROFILES.claude.binding.options, canonicalModel: "claude-canonical-fixture", executable: i.claudeExe } });
export const museBinding = (i: Installs, options: Readonly<Record<string, number | string>> = {}): BindingConfig => ({ ...PROFILES.muse.binding,
  options: { ...PROFILES.muse.binding.options, binaryDirectory: i.museDir, ...options } });
/** The production composition shape over an OFFLINE REHEARSAL candidate port (real Git, real backend, in-memory daemon). */
export function rehearsalCompose(dir: string, runs: { count: number }, override?: (composition: WriterComposition, options: ProductionWriterOptions) =>
  WriterComposition): (options: ProductionWriterOptions) => Promise<WriterComposition> {
  return async options => {
    const { candidates, unavailable } = await buildWriterCandidates(options.config, options.registry, { workspace: options.root,
      env: options.env, ...(options.launchObserver ? { launchObserver: options.launchObserver } : {}) }, WRITER_ROLES);
    const git = await ProcessGitClient.fromPath(process.env, true);
    const fake = new FakeDocker({ attach: oracle((_command, context) => {
      runs.count++;
      const text = context.files.get(PROBE_TARGET)?.toString("utf8") ?? "";
      const fixed = text.includes(".trim()") && text.includes(".toLowerCase()");
      return { pass: fixed, stdout: testSummary(fixed ? 3 : 1, fixed ? 0 : 2) };
    }) });
    const backend = new DockerLinuxVerificationBackend({ image: FAKE_IMAGE, runner: fake, resolveDocker: () => Promise.resolve(FAKE_DOCKER_EXE),
      dependencyStoreDirectory: join(dir, "dependency-store") });
    const workspace = new PrivateCandidateWorkspacePort({ primaryRoot: options.root, git, service: new VerificationService([backend]),
      confinement: OFFLINE_REHEARSAL, declaredPlatform: options.config.verification.platformRequirement, dependencies: "none",
      ...(options.onVerification ? { onVerification: options.onVerification } : {}) });
    const composition: WriterComposition = { roles: candidates, unavailable, workspace, views: providerViewPort(options.root, git, options.registry, workspace),
      plan: { commands: [...(options.config.verification.confinedCommands ?? [])] },
      verification: { acceptance: "refused", reasons: ["offline rehearsal"] } };
    return override ? override(composition, options) : composition;
  };
}
export function report(value: ProbeReport | ProbeRefusal): ProbeReport {
  assert.ok(!("refused" in value), JSON.stringify(value));
  return value as ProbeReport;
}
export type Launch = { purpose: string; args: string[]; cwdClass: string; forbiddenEnvKeys: string[]; posture?: { missing: string[]; widening: string[] } };
export const launchesOf = (r: ProbeReport): Launch[] => (r.evidence.launches ?? []) as Launch[];
export const section = <T>(r: ProbeReport, name: string): T => r.evidence[name] as T;
