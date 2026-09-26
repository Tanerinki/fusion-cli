import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { BindingConfig } from "../../src/app/config.js";
import { CORRECTION_ONLY_TURNS, runCorrectionProbe, type CorrectionProbeAuthorization, type CorrectionProbeDependencies,
  type CorrectionProbeRefusal, type CorrectionProbeReport, type CorrectionRole } from "../../src/app/correction-probe.js";
import { fileSha256 } from "../../src/app/executable-identity.js";
import { adjudicationFindingsIdentity, correctionAdjudicationIdentity, reviewCandidateIdentity } from "../../src/app/route-fixture.js";
import { grantedBinding, routeFixtureIdentity, type RouteRole, type RouteRoleGrant } from "../../src/app/route-probe.js";
import { PROPOSAL_PROBE_PROFILES, ROUTE_CORRECTION_ROLES } from "../../src/providers/probe-profiles.js";
import { transportProfile } from "../../src/runtime/provider-profiles.js";
import type { AttachContext } from "./fake-docker.js";
import { installMuseVersion, type Installs } from "./provider-installs.js";
import { RELEASE, releaseExe } from "./reviewer-harness.js";
import { routeCompose, routeEnv, routeRegistry, type ScriptedTurn } from "./route-harness.js";

/**
 * O5.5B30 offline harness of the review-correction probe: the REAL one-shot adapter code (the corrective Change Author) and
 * the REAL Exec adapter code (the fresh Reviewer, pinned to the fake install of the validated 1.4 release and its bytes)
 * launch the scripted fake native binaries; the real candidate port, view store and Docker backend run over the real route
 * fixture with the in-memory daemon and the dependency lane. Every run is labelled `offlineRehearsal`, never live evidence.
 */
export const TEST_CORRECTION = "TEST-CORRECTION";
const [VALIDATION] = transportProfile("muse", "muse-exec")!.bindingValidations;

/** The production roles with the fake installs' executables, the fake release's bytes and short timeouts; nothing else differs. */
export async function testCorrectionRoles(i: Installs): Promise<Record<CorrectionRole, RouteRoleGrant>> {
  await installMuseVersion(i, RELEASE);
  const sha = await fileSha256(releaseExe(i));
  const worker = ROUTE_CORRECTION_ROLES.Worker, reviewer = ROUTE_CORRECTION_ROLES.Reviewer;
  return {
    Worker: { ...worker, executable: basename(process.execPath), requiredEnvironment: [],
      binding: { ...worker.binding, options: { ...worker.binding.options, timeoutMs: 20_000 } } },
    Reviewer: { ...reviewer, executableDirectory: i.museDir, executableSha256: sha,
      binding: { ...reviewer.binding, options: { ...reviewer.binding.options, timeoutMs: 20_000 } } },
  };
}
export async function testCorrectionAuthorization(i: Installs, patch: Partial<CorrectionProbeAuthorization> = {},
  roles: Partial<Record<CorrectionRole, Partial<RouteRoleGrant>>> = {}): Promise<CorrectionProbeAuthorization> {
  const base = await testCorrectionRoles(i);
  return { milestone: "TEST", evidenceDirectory: "fusion-test-correction", state: "open",
    roles: { Worker: { ...base.Worker, ...roles.Worker }, Reviewer: { ...base.Reviewer, ...roles.Reviewer } }, turns: CORRECTION_ONLY_TURNS,
    fixtureSha256: routeFixtureIdentity(), candidateSha256: reviewCandidateIdentity(), findingsSha256: adjudicationFindingsIdentity(),
    adjudicationSha256: correctionAdjudicationIdentity(), ...patch };
}
/** Each role's granted binding plus only the fake installs' locations (the test seam). */
export function testCorrectionBindings(i: Installs, authorization: CorrectionProbeAuthorization,
  patch: Partial<Record<CorrectionRole, Partial<BindingConfig>>> = {}): Record<CorrectionRole, BindingConfig> {
  const binding = (role: CorrectionRole, where: Readonly<Record<string, string>>): BindingConfig => {
    const granted = grantedBinding(role, authorization.roles[role]);
    return { ...granted, ...patch[role], options: { ...where, ...granted.options, ...patch[role]?.options } };
  };
  return { Worker: binding("Worker", { executable: i.claudeExe }),
    Reviewer: binding("Reviewer", { binaryDirectory: i.museDir, versionFile: join(i.museDir, ".muse-version") }) };
}

export interface CorrectionRun { readonly report: CorrectionProbeReport; readonly prompts: Readonly<Record<CorrectionRole, readonly string[]>>;
  readonly streamed: AttachContext[]; readonly root: string }
/**
 * One correction probe under the test authorization (own namespace `name` under `dir`) with the scripted turns of the
 * Change Author and the Reviewer. The Lead has an empty script: it is never composed, and any turn of it would fail the fake.
 */
export async function runCorrection(i: Installs, dir: string, name: string, scripts: Partial<Record<CorrectionRole, readonly ScriptedTurn[]>>,
  options: Readonly<{ authorization?: CorrectionProbeAuthorization; bindings?: Partial<Record<CorrectionRole, Partial<BindingConfig>>>;
    extra?: Partial<Record<CorrectionRole, Readonly<Record<string, string>>>>; env?: NodeJS.ProcessEnv;
    deps?: Partial<CorrectionProbeDependencies> }> = {}): Promise<CorrectionRun | CorrectionProbeRefusal> {
  const authorization = options.authorization ?? await testCorrectionAuthorization(i);
  const scriptDir = join(dir, `${name}-scripts`);
  await mkdir(scriptDir, { recursive: true });
  const paths: Record<RouteRole, string> = { Lead: join(scriptDir, "Lead.json"), Worker: join(scriptDir, "Worker.json"), Reviewer: join(scriptDir, "Reviewer.json") };
  await writeFile(paths.Lead, "[]");
  await writeFile(paths.Worker, JSON.stringify(scripts.Worker ?? []));
  await writeFile(paths.Reviewer, JSON.stringify(scripts.Reviewer ?? []));
  const sha = authorization.roles.Reviewer.executableSha256 ?? await fileSha256(releaseExe(i));
  const streamed: AttachContext[] = [];
  const root = join(dir, name);
  const report = await runCorrectionProbe({ env: options.env ?? routeEnv(),
    registry: routeRegistry(i, paths, options.extra ?? {}, { museBindingValidations: [{ ...VALIDATION!, executableSha256: sha }], museExecutable: releaseExe(i) }),
    profiles: { families: PROPOSAL_PROBE_PROFILES, authorizations: { [TEST_CORRECTION]: authorization } }, authorization: TEST_CORRECTION,
    evidenceRoot: root, bindings: testCorrectionBindings(i, authorization, options.bindings), offlineRehearsal: true, compose: routeCompose(dir, streamed),
    ...options.deps });
  if ("refused" in report) return report;
  const promptsOf = async (role: CorrectionRole): Promise<string[]> => {
    let text = "";
    try { text = await readFile(`${paths[role]}.prompts.jsonl`, "utf8"); } catch { /* no model turn */ }
    return text.split("\n").filter(Boolean).map(line => (JSON.parse(line) as { prompt: string }).prompt);
  };
  return { report, prompts: { Worker: await promptsOf("Worker"), Reviewer: await promptsOf("Reviewer") }, streamed, root };
}
export function asCorrectionRun(value: CorrectionRun | CorrectionProbeRefusal): CorrectionRun {
  if ("refused" in value) throw new Error(`refused: ${value.reason}: ${value.message}`);
  return value;
}
export const evidenceOf = <T>(run: CorrectionRun, name: string): T => run.report.evidence[name] as T;
