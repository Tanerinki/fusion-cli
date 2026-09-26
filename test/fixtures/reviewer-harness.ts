import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BindingConfig } from "../../src/app/config.js";
import type { AdapterFactory, ProviderRegistry } from "../../src/app/providers.js";
import { fileSha256, REVIEWER_ONLY_TURNS, runReviewerProbe, type ReviewerProbeAuthorization, type ReviewerProbeDependencies,
  type ReviewerProbeGrant, type ReviewerProbeRefusal, type ReviewerProbeReport } from "../../src/app/reviewer-probe.js";
import { reviewCandidateIdentity } from "../../src/app/route-fixture.js";
import { grantedBinding, routeFixtureIdentity } from "../../src/app/route-probe.js";
import type { ProviderAdapter } from "../../src/core/domain.js";
import { MuseAdapter } from "../../src/providers/muse/muse-adapter.js";
import { MUSE_1_4_REVIEWER, PROPOSAL_PROBE_PROFILES } from "../../src/providers/probe-profiles.js";
import { defaultRegistry, museVersionUnderValidation } from "../../src/providers/registry.js";
import type { AttachContext } from "./fake-docker.js";
import { installMuseVersion, museBindingFor, museLaunch, MUSE_FIXTURE, type Installs } from "./provider-installs.js";
import { routeCompose, routeEnv, type ScriptedTurn } from "./route-harness.js";

/**
 * O5.5B23 offline harness of the Reviewer-only probe: the REAL Exec adapter code (built exactly as the registry builds it,
 * including the release under validation from the runtime context) launches the scripted fake native binary installed
 * as the release under validation; the real candidate port, view store and Docker backend run over the real route fixture
 * with the in-memory daemon and the dependency lane. Every run is labelled `offlineRehearsal`, never live evidence.
 */
export const RELEASE = MUSE_1_4_REVIEWER.runtimeVersions[0]!;
export const TEST_REVIEWER = "TEST-REVIEWER";
export const releaseExe = (i: Installs, release = RELEASE): string => join(i.museDir, `muse-bin-${release}.exe`);
/** Installs the fake binary as the release under validation and selects it (as the machine's updater did). */
export async function installRelease(i: Installs, release = RELEASE): Promise<void> { await installMuseVersion(i, release); }

/** The production grant with the fake install's directory and bytes and a short timeout: the same family, release, binding and flags. */
export async function testReviewerGrant(i: Installs, patch: Partial<ReviewerProbeGrant> = {}): Promise<ReviewerProbeGrant> {
  return { ...MUSE_1_4_REVIEWER, executableDirectory: i.museDir, executableSha256: await fileSha256(releaseExe(i)),
    binding: { ...MUSE_1_4_REVIEWER.binding, options: { ...MUSE_1_4_REVIEWER.binding.options, timeoutMs: 20_000 } }, ...patch };
}
export async function testReviewerAuthorization(i: Installs, patch: Partial<ReviewerProbeAuthorization> = {},
  grant: Partial<ReviewerProbeGrant> = {}): Promise<ReviewerProbeAuthorization> {
  return { milestone: "TEST", evidenceDirectory: "fusion-test-reviewer", state: "open", reviewer: await testReviewerGrant(i, grant),
    turns: REVIEWER_ONLY_TURNS, fixtureSha256: routeFixtureIdentity(), candidateSha256: reviewCandidateIdentity(), ...patch };
}
/** The granted binding plus only the fake install's location (the test seam). */
export function testReviewerBinding(i: Installs, authorization: ReviewerProbeAuthorization, patch: Partial<BindingConfig> = {}): BindingConfig {
  const granted = grantedBinding("Reviewer", authorization.reviewer);
  return { ...granted, ...patch, options: { binaryDirectory: i.museDir, versionFile: join(i.museDir, ".muse-version"), ...granted.options,
    ...patch.options } };
}

/**
 * The default registry's static inspection with the Exec Reviewer built on the scripted fake binary through the REAL
 * adapter, from the same launch facts the registry derives (model, effort, steps, retries, timeout and the release under
 * validation from the runtime context). `binary` is the executable the fake runs as (the release under validation).
 */
export function reviewerRegistry(i: Installs, script: string, extra: Readonly<Record<string, string>> = {}, binary = releaseExe(i)): ProviderRegistry {
  const real = defaultRegistry();
  const exec = real.factories.get("muse-exec")!;
  const factory: AdapterFactory = { kind: "muse-exec", inspect: exec.inspect, probe: exec.probe,
    async create(binding, context) {
      const retries = binding.options.malformedOutputRetries, under = museVersionUnderValidation(context, binding.adapter);
      const config = { ...museLaunch(i, context.workspace, { FUSION_FAKE_SCRIPT: script, FUSION_FAKE_EXPECT_EFFORT: binding.effort, ...extra },
        { model: { id: binding.model, effort: binding.effort }, maxModelSteps: Number(binding.options.maxModelSteps ?? 4),
          ...(retries === 0 || retries === 1 ? { malformedOutputRetries: retries } : {}), timeoutMs: Number(binding.options.timeoutMs ?? 20_000),
          ...(under === undefined ? {} : { versionUnderValidation: under }) }),
        ...(context.launchObserver ? { launchObserver: context.launchObserver } : {}) };
      const role = museBindingFor(binding.role, config);
      return { binding: role, adapter: new MuseAdapter(role, config, undefined, { executable: binary, argvPrefix: [MUSE_FIXTURE] }) as ProviderAdapter };
    } };
  return { ...real, factories: new Map([["muse-exec", factory]]) };
}

export interface ReviewerRun { readonly report: ReviewerProbeReport; readonly prompts: readonly string[]; readonly streamed: AttachContext[];
  readonly root: string }
/** One Reviewer-only probe under the test authorization (own namespace `name` under `dir`) with the scripted Reviewer turns. */
export async function runReviewer(i: Installs, dir: string, name: string, turns: readonly ScriptedTurn[],
  options: Readonly<{ authorization?: ReviewerProbeAuthorization; binding?: Partial<BindingConfig>; extra?: Readonly<Record<string, string>>;
    env?: NodeJS.ProcessEnv; deps?: Partial<ReviewerProbeDependencies>; binary?: string }> = {}): Promise<ReviewerRun | ReviewerProbeRefusal> {
  const authorization = options.authorization ?? await testReviewerAuthorization(i);
  await mkdir(join(dir, `${name}-scripts`), { recursive: true });
  const script = join(dir, `${name}-scripts`, "Reviewer.json");
  await writeFile(script, JSON.stringify(turns));
  const streamed: AttachContext[] = [];
  const root = join(dir, name);
  const report = await runReviewerProbe({ env: options.env ?? routeEnv(), registry: reviewerRegistry(i, script, options.extra, options.binary),
    profiles: { families: PROPOSAL_PROBE_PROFILES, authorizations: { [TEST_REVIEWER]: authorization } }, authorization: TEST_REVIEWER,
    evidenceRoot: root, binding: testReviewerBinding(i, authorization, options.binding), offlineRehearsal: true,
    compose: routeCompose(dir, streamed), ...options.deps });
  if ("refused" in report) return report;
  let text = "";
  try { text = await readFile(`${script}.prompts.jsonl`, "utf8"); } catch { /* no model turn */ }
  return { report, prompts: text.split("\n").filter(Boolean).map(line => (JSON.parse(line) as { prompt: string }).prompt), streamed, root };
}
export function asReviewerRun(value: ReviewerRun | ReviewerProbeRefusal): ReviewerRun {
  if ("refused" in value) throw new Error(`refused: ${value.reason}: ${value.message}`);
  return value;
}
export const evidenceOf = <T>(run: ReviewerRun, name: string): T => run.report.evidence[name] as T;
