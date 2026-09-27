import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { BindingConfig } from "../../src/app/config.js";
import type { AdapterFactory, ProviderRegistry } from "../../src/app/providers.js";
import { buildWriterCandidates } from "../../src/app/providers.js";
import { grantedBinding, ROUTE_ROLES, runRouteRehearsal, type RouteAuthorization, type RouteDependencies, type RouteProfileSet,
  type RouteReport, type RouteRefusal, type RouteRole, type RouteRoleGrant } from "../../src/app/route-probe.js";
import { providerViewPort, WRITER_ROLES, type ProductionWriterOptions, type WriterComposition } from "../../src/app/writer-composition.js";
import type { ProviderAdapter } from "../../src/core/domain.js";
import type { CleanupReport, WorkspaceHandle } from "../../src/core/workflow/types.js";
import { DockerLinuxVerificationBackend } from "../../src/platform/verification/docker/backend.js";
import { VerificationService } from "../../src/platform/verification/selection.js";
import { OFFLINE_REHEARSAL, PrivateCandidateWorkspacePort } from "../../src/platform/workflow/candidates.js";
import { ProcessGitClient } from "../../src/platform/workspace/git.js";
import { ClaudeAdapter } from "../../src/providers/claude/claude-adapter.js";
import { MuseAdapter } from "../../src/providers/muse/muse-adapter.js";
import { VERIFIED_EXEC_WEB_DISABLE_VERSION } from "../../src/providers/muse/types.js";
import { PROPOSAL_PROBE_PROFILES, ROUTE_REHEARSAL_PROFILES } from "../../src/providers/probe-profiles.js";
import { defaultRegistry, museValidatedBindings } from "../../src/providers/registry.js";
import type { BindingValidation } from "../../src/runtime/provider-profiles.js";
import { FAKE_DOCKER_EXE, FAKE_IMAGE, FakeDocker, type AttachContext } from "./fake-docker.js";
import { claudeBinary, claudeBindingFor, claudeLaunch, museBinary, museBindingFor, museLaunch, MUSE_FIXTURE, type Installs } from "./provider-installs.js";
import { FAKE_DEPENDENCY_TREE } from "./rehearsal-project.js";
import { FIX, rehearsalOracle } from "./writer-rehearsal-harness.js";

/**
 * O5.5B12 offline harness of the full-route rehearsal: the REAL Claude (Lead, Change Author) and Muse (fresh Reviewer)
 * adapter code launches the scripted fake native binaries (never a provider); the real engine, candidate port, view store
 * and Docker backend run over a real Git fixture and the in-memory daemon with the dependency lane. Every run is labelled
 * `offlineRehearsal`, never live evidence.
 */
export const TEST_ROUTE = "TEST-ROUTE";
const LIVE = ROUTE_REHEARSAL_PROFILES.authorizations["O5.5B12-LIVE"]!;
/** The live plan's grants, with the fake installs' executables and short timeouts: the same families, models, efforts and turns. */
export function testRouteAuthorization(i: Installs, patch: Partial<RouteAuthorization> = {},
  roles: Partial<Record<RouteRole, Partial<RouteRoleGrant>>> = {}): RouteAuthorization {
  const claude = (role: RouteRole): RouteRoleGrant => ({ ...LIVE.roles[role], executable: basename(process.execPath), requiredEnvironment: [],
    binding: { ...LIVE.roles[role].binding, options: { ...LIVE.roles[role].binding.options, timeoutMs: 20_000 } }, ...roles[role] });
  const reviewer: RouteRoleGrant = { ...LIVE.roles.Reviewer, executable: basename(i.museExe), runtimeVersions: [VERIFIED_EXEC_WEB_DISABLE_VERSION],
    binding: { ...LIVE.roles.Reviewer.binding, options: { ...LIVE.roles.Reviewer.binding.options, timeoutMs: 20_000 } }, ...roles.Reviewer };
  return { ...LIVE, milestone: "TEST", evidenceDirectory: "fusion-test-route", state: "open",
    roles: { Lead: claude("Lead"), Worker: claude("Worker"), Reviewer: reviewer }, ...patch };
}
export const testRouteProfiles = (authorization: RouteAuthorization): RouteProfileSet =>
  ({ families: PROPOSAL_PROBE_PROFILES, authorizations: { ...ROUTE_REHEARSAL_PROFILES.authorizations, [TEST_ROUTE]: authorization } });
/** Each role's granted binding plus only the fake installs' locations (the test seam). */
export function testRouteBindings(i: Installs, authorization: RouteAuthorization,
  patch: Partial<Record<RouteRole, Partial<BindingConfig>>> = {}): Record<RouteRole, BindingConfig> {
  const binding = (role: RouteRole, where: Readonly<Record<string, string>>): BindingConfig => {
    const granted = grantedBinding(role, authorization.roles[role]);
    return { ...granted, ...patch[role], options: { ...where, ...granted.options, ...patch[role]?.options } };
  };
  return { Lead: binding("Lead", { executable: i.claudeExe }), Worker: binding("Worker", { executable: i.claudeExe }),
    Reviewer: binding("Reviewer", { binaryDirectory: i.museDir, versionFile: join(i.museDir, ".muse-version") }) };
}

/** One scripted model turn of a fake binary: the prompt must start with `prefix` and contain none of `excludes`. */
export interface ScriptedTurn { readonly prefix: string; readonly output?: string; readonly assistant?: string;
  readonly excludes?: readonly string[]; readonly scenario?: "hang" | "fail" | "mutate" | "touchPrimary";
  /** O5.5B14 (one-shot fake only): fields patched into the result frame (`"__absent__"` removes one), and the exit code. */
  readonly resultFrame?: Readonly<Record<string, unknown>>; readonly exitCode?: number;
  /** O5.5B23 (Exec fake only): the model the turn reads back, when not the requested one. */
  readonly model?: string;
  /** v0.3: taken only by a prompt that contains this text (parallel turns take their own scripted replies in any order). */
  readonly when?: string;
  /** v0.3: waits until `count` turns of this barrier run at the same time — a mechanical proof of concurrency (exit 44 otherwise). */
  readonly barrier?: Readonly<{ name: string; count: number; timeoutMs?: number }>;
  /** v0.3: holds the turn open this long before answering. */
  readonly delayMs?: number }
export type RoleScripts = Partial<Record<RouteRole, readonly ScriptedTurn[]>>;
// O5.5B16: the Lead's plan turn opens with the planning Lead's contract, no longer the generic delegated-task wording.
export const PREFIX = Object.freeze({ plan: "You are the planning Lead for this delegated task.", proposal: "Fusion change proposal.",
  review: "Fusion fresh review.", adjudication: "Fusion adjudication." });

/**
 * The default registry's static inspection with every route role built on the scripted fake binaries through the REAL
 * adapters (Lead and Change Author: the one-shot adapter; Reviewer: the Exec adapter). Extra fake variables per role.
 */
export interface RouteRegistryOptions {
  /** O5.5B25: the binding-scoped validations (re-pinned to the fake install's bytes) the registry and adapters apply. */
  readonly museBindingValidations?: readonly BindingValidation[];
  /** O5.5B25: the executable the Reviewer's fake runs as (default: the verified 1.3 fixture). */
  readonly museExecutable?: string;
}
export function routeRegistry(i: Installs, scripts: Readonly<Record<RouteRole, string>>,
  extra: Partial<Record<RouteRole, Readonly<Record<string, string>>>> = {}, options: RouteRegistryOptions = {}): ProviderRegistry {
  const real = defaultRegistry(options.museBindingValidations ? { museBindingValidations: options.museBindingValidations } : {});
  const claude = real.factories.get("claude-one-shot")!, muse = real.factories.get("muse-exec")!;
  const claudeAdapter = (binding: BindingConfig, context: Parameters<AdapterFactory["create"]>[1]) => {
    const canonical = String(binding.options.canonicalModel);
    const config = { ...claudeLaunch(i, context.workspace, { FUSION_FAKE_SCRIPT: scripts[binding.role as RouteRole],
      FUSION_FAKE_EXPECT_MODEL: binding.model, FUSION_FAKE_EXPECT_MAX_TURNS: String(binding.maxTurns ?? 1), FUSION_FAKE_INIT_MODEL: canonical,
      ...extra[binding.role as RouteRole] }, { model: { id: binding.model, effort: binding.effort, maxTurns: binding.maxTurns ?? 1 },
      expectedCanonicalModel: canonical, timeoutMs: Number(binding.options.timeoutMs ?? 20_000) }),
      ...(context.launchObserver ? { launchObserver: context.launchObserver } : {}) };
    const role = claudeBindingFor(binding.role, config);
    return { binding: role, adapter: new ClaudeAdapter(role, config, claudeBinary) as ProviderAdapter };
  };
  const claudeFactory: AdapterFactory = { kind: "claude-one-shot", inspect: claude.inspect, probe: claude.probe,
    create: async (binding, context) => claudeAdapter(binding, context), createChangeAuthor: async (binding, context) => claudeAdapter(binding, context) };
  const museFactory: AdapterFactory = { kind: "muse-exec", inspect: muse.inspect, probe: muse.probe,
    async create(binding, context) {
      const retries = binding.options.malformedOutputRetries;
      const config = { ...museLaunch(i, context.workspace, { FUSION_FAKE_SCRIPT: scripts[binding.role as RouteRole], FUSION_FAKE_EXPECT_EFFORT: binding.effort,
        ...extra[binding.role as RouteRole] }, { model: { id: binding.model, effort: binding.effort },
        ...(retries === 0 || retries === 1 ? { malformedOutputRetries: retries } : {}), timeoutMs: Number(binding.options.timeoutMs ?? 20_000),
        ...(options.museBindingValidations ? { validatedBindings: museValidatedBindings(binding, options.museBindingValidations) } : {}) }),
        ...(context.launchObserver ? { launchObserver: context.launchObserver } : {}) };
      const role = museBindingFor(binding.role, config);
      const binary = options.museExecutable === undefined ? museBinary(i) : { executable: options.museExecutable, argvPrefix: [MUSE_FIXTURE] };
      return { binding: role, adapter: new MuseAdapter(role, config, undefined, binary) as ProviderAdapter };
    } };
  return { ...real, factories: new Map([["claude-one-shot", claudeFactory], ["muse-exec", museFactory]]) };
}

/** The production composition shape over an OFFLINE REHEARSAL candidate port with the npm lane and the validated oracle. */
export interface ComposeHooks {
  /** Fail the n-th candidate release (0-based); the candidate is kept for `forceRelease`. */
  readonly failRelease?: (index: number) => boolean;
  readonly kept?: Array<() => Promise<unknown>>;
}
export function routeCompose(dir: string, streamed: AttachContext[] = [], hooks: ComposeHooks = {}):
  (options: ProductionWriterOptions) => Promise<WriterComposition> {
  return async options => {
    const { candidates, unavailable } = await buildWriterCandidates(options.config, options.registry, { workspace: options.root,
      env: options.env, ...(options.launchObserver ? { launchObserver: options.launchObserver } : {}),
      // O5.5B23: a Reviewer-only probe's release under validation reaches the factories exactly as in production.
      ...(options.runtimeUnderValidation ? { runtimeUnderValidation: options.runtimeUnderValidation } : {}) }, WRITER_ROLES);
    const git = await ProcessGitClient.fromPath(process.env, true);
    const fake = new FakeDocker({ attach: rehearsalOracle(streamed), depsTree: FAKE_DEPENDENCY_TREE });
    const backend = new DockerLinuxVerificationBackend({ image: FAKE_IMAGE, runner: fake, resolveDocker: () => Promise.resolve(FAKE_DOCKER_EXE),
      dependencyStoreDirectory: join(dir, "dependency-store") });
    const verification = options.config.verification;
    let releases = 0;
    class HookedPort extends PrivateCandidateWorkspacePort {
      override async release(handle: WorkspaceHandle): Promise<CleanupReport> {
        if (hooks.failRelease?.(releases++) === true) {
          hooks.kept?.push(() => super.release(handle));
          return { complete: false, reason: "injected" };
        }
        return super.release(handle);
      }
    }
    const workspace = new HookedPort({ primaryRoot: options.root, git, service: new VerificationService([backend]),
      confinement: OFFLINE_REHEARSAL, declaredPlatform: verification.platformRequirement, dependencies: verification.dependencies ?? "none",
      prepareDependencies: true, ...(options.config.protection ? { protectedPaths: options.config.protection.ignoredPaths } : {}),
      ...(options.onVerification ? { onVerification: options.onVerification } : {}) });
    return { roles: candidates, unavailable, workspace, views: providerViewPort(options.root, git, options.registry, workspace),
      plan: { commands: [...(verification.confinedCommands ?? [])] }, verification: { acceptance: "refused", reasons: ["offline rehearsal"] } };
  };
}

// ---------------------------------------------------------------- scripted outputs

export const LEAD_SECRET = "LEAD-PLAN-HIDDEN-REASONING-51c0";
export const WORKER_SECRET = "WORKER-HIDDEN-RATIONALE-e27d";
export const plan = (summary = `Plan: tax the discounted subtotal, then add a full-discount regression test. ${LEAD_SECRET}`): string =>
  JSON.stringify({ result: { status: "completed" }, changes: { files: [], summary }, verification: { testsRun: [], results: [] },
    uncertainties: [], failures: [], needsLeadDecision: [] });
export const fenced = (value: unknown): string => `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
export const cleanReview = JSON.stringify({ findings: [], summary: "No defect found." });
/** A review in the exec provider's strict WIRE form: every optional property present as null. */
export function reviewWith(...findings: Array<Readonly<{ id: string; severity: string; title?: string }>>): string {
  return JSON.stringify({ findings: findings.map(f => ({ id: f.id, severity: f.severity, confidence: "HIGH", category: "tests",
    file: "test/quote.test.ts", lines: null, title: f.title ?? `${f.severity}: no regression test for a full discount`,
    evidence: ["The change fixes the taxable amount but no test pins the 100 % discount case."],
    failureScenario: "A later refactor taxes a fully discounted quote again and nothing fails.",
    suggestedFix: "Add a test where a 100 % discount leaves nothing to tax.", facts: null })), summary: "One finding." });
}
export const adjudication = (...verdicts: Array<readonly [string, string, string]>): string =>
  JSON.stringify({ adjudications: verdicts.map(([findingId, verdict, requiredAction]) => ({ findingId, verdict,
    rationale: `Evidence-based ${verdict.toLowerCase()} verdict.`, requiredAction })), summary: "" });
/** A Change Author turn: the ChangeSet in one json fence, and a hidden rationale in its transcript that must never travel. */
export const proposal = (changes: unknown = FIX, assistant = WORKER_SECRET): ScriptedTurn =>
  ({ prefix: PREFIX.proposal, output: fenced(changes), assistant });

export interface RouteRun { readonly report: RouteReport; readonly prompts: Readonly<Record<RouteRole, readonly string[]>>;
  readonly streamed: AttachContext[]; readonly root: string }
/**
 * One full-route rehearsal under the test authorization (own namespace `name` under `dir`). Scripts are written per role;
 * afterwards the prompts every role's fake received are returned (test-only logs) for freshness assertions.
 */
export async function runRoute(i: Installs, dir: string, name: string, scripts: RoleScripts,
  options: Readonly<{ authorization?: RouteAuthorization; bindings?: Partial<Record<RouteRole, Partial<BindingConfig>>>;
    extra?: Partial<Record<RouteRole, Readonly<Record<string, string>>>>; env?: NodeJS.ProcessEnv;
    deps?: Partial<RouteDependencies>; hooks?: ComposeHooks; registry?: RouteRegistryOptions; profiles?: RouteProfileSet }> = {}): Promise<RouteRun | RouteRefusal> {
  const authorization = options.authorization ?? testRouteAuthorization(i);
  const scriptDir = join(dir, `${name}-scripts`);
  await mkdir(scriptDir, { recursive: true });
  const paths = Object.fromEntries(ROUTE_ROLES.map(role => [role, join(scriptDir, `${role}.json`)])) as Record<RouteRole, string>;
  for (const role of ROUTE_ROLES) await writeFile(paths[role], JSON.stringify(scripts[role] ?? []));
  const streamed: AttachContext[] = [];
  const root = join(dir, name);
  const report = await runRouteRehearsal({ env: options.env ?? routeEnv(), registry: routeRegistry(i, paths, options.extra, options.registry),
    profiles: options.profiles ?? testRouteProfiles(authorization), authorization: TEST_ROUTE, evidenceRoot: root,
    bindings: testRouteBindings(i, authorization, options.bindings), offlineRehearsal: true, compose: routeCompose(dir, streamed, options.hooks), ...options.deps });
  if ("refused" in report) return report;
  const prompts = Object.fromEntries(await Promise.all(ROUTE_ROLES.map(async role => {
    let text = "";
    try { text = await readFile(`${paths[role]}.prompts.jsonl`, "utf8"); } catch { /* no model turn */ }
    return [role, text.split("\n").filter(Boolean).map(line => (JSON.parse(line) as { prompt: string }).prompt)];
  }))) as Record<RouteRole, string[]>;
  return { report, prompts, streamed, root };
}
/** A provider-free environment for the harness itself (Git on PATH). */
export function routeEnv(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const keep = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "PATHEXT", "SYSTEMROOT"].includes(key.toUpperCase())));
  return { ...keep, ...extra };
}
export function asRun(value: RouteRun | RouteRefusal): RouteRun {
  if ("refused" in value) throw new Error(`refused: ${value.reason}: ${value.message}`);
  return value;
}
export const sectionOf = <T>(run: RouteRun, name: string): T => run.report.evidence[name] as T;
