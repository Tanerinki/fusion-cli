import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import type { DelegationPacket, FusionError, ProviderAdapter, VerificationCommand } from "../core/domain.js";
import { FusionFailure } from "../core/errors.js";
import type { RoleCandidate } from "../core/policy/routing.js";
import type { TaskRequest } from "../core/policy/task-inspector.js";
import { WorkflowEngine } from "../core/workflow/engine.js";
import type { CleanupReport, EventSink, ProviderViewHandle, ProviderViewPort, ProviderViewRequest, WorkflowEvent,
  WorkflowResult } from "../core/workflow/types.js";
import { structureOnlyDiagnostic } from "../platform/process/structured-envelope.js";
import type { LaunchRecord, LaunchSettlement, ProcessPurpose } from "../platform/process/supervisor.js";
import type { CandidateVerificationObservation } from "../platform/workflow/candidates.js";
import { comparablePath, gitOk, ProcessGitClient } from "../platform/workspace/git.js";
import { isValidatedRuntimeVersion, providerWorkspaceStatePaths, transportProfile } from "../runtime/provider-profiles.js";
import { parseConfig, type BindingConfig, type FusionConfig } from "./config.js";
import type { ProviderRegistry } from "./providers.js";
import { bindingEligibility } from "./readiness.js";
import { composeProductionWriter, type ProductionWriterOptions, type WriterComposition } from "./writer-composition.js";
import { liveWriterAuthorization, REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport } from "./writer-gate.js";
import { fusionTemporaryBase } from "../platform/fs/temporary.js";

/**
 * O5.5B9 — the AUTHORIZED real-provider change-proposal probe: exactly ONE read-only change-proposal turn of ONE provider
 * family (named by its profile), through the PRODUCTION Writer composition (`composeProductionWriter`: registry-built read-only Change Author,
 * Fusion-owned provider views, the private candidate port bound to a verification-isolation acceptance granted in this
 * process, the confined plan) and the real `WorkflowEngine`, on a throw-away fixture repository Fusion creates under the
 * temporary directory. The task is a single-file edit, so the engine's low-risk Writer flow routes the Worker alone,
 * with an attempt limit of one: no Lead, Explorer or Reviewer turn exists, and no retry. On top of that:
 *  - a static preflight (no provider process) refuses an unvalidated runtime version, a blocked billing lane or an
 *    ineligible change-proposal posture before anything is launched;
 *  - a one-shot claim file makes a second invocation for the same provider refuse before any provider process starts;
 *  - the Worker adapter is wrapped so a second change-proposal call throws;
 *  - every provider process is observed (argv, working directory, environment KEY names, purpose) and counted;
 *  - the evidence file is bounded and redacted: no prompt, no credential, no environment value, no account data;
 *  - O5.5B10: the Change Author's structure-only diagnostic of its reply (classes, flags and counts, rebuilt from a fixed
 *    key set by `structureOnlyDiagnostic`) is recorded as `structuredOutput`, so a refused reply can be explained
 *    without any part of it being persisted.
 * Nothing here opens any gate: `REAL_WRITER_LIVE_GATE_AUTHORIZED` stays false and no readiness row reads this evidence.
 *
 * O5.5B11 — every run is bound to a named human AUTHORIZATION (`ProbeAuthorization`, provider-layer data): which provider
 * families it covers, and for each the exact installed runtime versions, subscription lanes, binding and required
 * environment keys. A consumed authorization refuses before anything exists; each authorization owns its own evidence
 * namespace (a directory marked on first use, never shared with another authorization's claims or evidence); and every
 * provider process is checked BEFORE it starts (`launchRefusal`): outside a checked Fusion-owned view, naming the primary,
 * carrying a forbidden variable, a second model turn, or a model turn without its read-only controls never runs.
 */

/** Stable per-provider outcome of one probe. A provider's PASS never implies another's. */
export const PROBE_OUTCOMES = ["PASS", "AUTH_BLOCKED", "VERSION_BLOCKED", "MODEL_BLOCKED", "POSTURE_BLOCKED", "PROVIDER_FAILED",
  "TIMEOUT", "MALFORMED_PROPOSAL", "INVALID_CHANGESET", "VIEW_MUTATED", "PRIMARY_MUTATED", "APPLICATION_FAILED",
  "VERIFICATION_FAILED", "CLEANUP_FAILED"] as const;
export type ProbeOutcome = (typeof PROBE_OUTCOMES)[number];
/** Evidence schema: 2 (O5.5B10) added `structuredOutput`; 3 (O5.5B11) adds `authorization` and `launchGuard`. */
export const PROBE_EVIDENCE_SCHEMA_VERSION = 3 as const;

/**
 * One provider family's probe facts, supplied by the provider layer (`providers/probe-profiles.ts`) so that nothing
 * here names a provider: the only binding the probe runs, and the launch controls its model turn must carry.
 */
export interface ProbeProfile {
  readonly binding: BindingConfig;
  readonly turnPosture: Readonly<{ required: readonly (readonly string[])[]; widening: readonly string[] }>;
}
/**
 * What one human authorization permits for one provider family, exactly: the installed runtime versions (each must also
 * be a validated one), the credential lanes the BillingGuard may select, the binding facts (adapter, model, effort, turn
 * limit and the listed options, compared exactly) and the environment keys that must be set (names only; values are
 * never read here).
 */
export interface ProbeGrant {
  readonly runtimeVersions: readonly string[];
  readonly lanes: readonly string[];
  readonly binding: Readonly<{ adapter: string; model: string; effort: string; maxTurns?: number;
    options?: Readonly<Record<string, string | number>> }>;
  readonly requiredEnvironment: readonly string[];
}
/**
 * A named human authorization of real model turns: at most ONE proposal turn per provider family it lists. `consumed`:
 * every run it permitted has happened; it refuses before anything exists, so a lost claim file can never re-open it.
 */
export interface ProbeAuthorization {
  readonly milestone: string;
  /** The evidence namespace under the temporary directory: this authorization's claims, evidence and fixtures only. */
  readonly evidenceDirectory: string;
  readonly state: "open" | "consumed";
  readonly grants: Readonly<Record<string, ProbeGrant>>;
}
export interface ProbeProfileSet {
  readonly profiles: Readonly<Record<string, ProbeProfile>>;
  /** Every human authorization the probe knows, by id (the token the human passes). */
  readonly authorizations: Readonly<Record<string, ProbeAuthorization>>;
  /** Environment keys that identify a nested agent session the probe must not start inside. */
  readonly nestedSessionKeys: readonly string[];
  /** Credential and override variables that must never reach a provider process (key names). */
  readonly forbiddenEnv: RegExp;
}

// ---------------------------------------------------------------- the throw-away fixture

export const PROBE_BUGGY = [
  "/** The canonical form of a person's name for lookups. */",
  "export function normalizeName(name) {",
  "  return name.toLowerCase();",
  "}",
  "",
].join("\n");
export const PROBE_TEST = [
  "import assert from \"node:assert/strict\";",
  "import { test } from \"node:test\";",
  "import { normalizeName } from \"../src/name.js\";",
  "",
  "test(\"lowercases a name\", () => {",
  "  assert.equal(normalizeName(\"ADA\"), \"ada\");",
  "});",
  "test(\"trims surrounding whitespace before lowercasing\", () => {",
  "  assert.equal(normalizeName(\"  Ada Lovelace \\n\"), \"ada lovelace\");",
  "});",
  "test(\"keeps inner whitespace\", () => {",
  "  assert.equal(normalizeName(\"\\tGrace  Hopper \"), \"grace  hopper\");",
  "});",
  "",
].join("\n");
/** Committed baseline: a plain Node ESM project without dependencies; the one failing behaviour is in src/name.js. */
export const PROBE_FIXTURE_FILES: Readonly<Record<string, string>> = Object.freeze({
  "package.json": `${JSON.stringify({ name: "fusion-o5-5b9-probe-fixture", version: "1.0.0", private: true, type: "module" }, null, 2)}\n`,
  "README.md": "# Probe fixture\n\nThrow-away repository created by Fusion for one authorized change-proposal probe.\n",
  ".gitignore": ".env\nsecrets.local\n",
  "src/name.js": PROBE_BUGGY,
  "test/name.test.js": PROBE_TEST,
});
/** Ignored, synthetic (not secret) canaries in the primary; the probe proves them unchanged. */
export const PROBE_CANARIES: Readonly<Record<string, string>> = Object.freeze({
  ".env": "FUSION_O5_5B9_CANARY=synthetic-not-a-secret-5c1e\n",
  "secrets.local": "synthetic protected canary 9a4d\n",
});
export const PROBE_TARGET = "src/name.js";
export const PROBE_TASK: TaskRequest = Object.freeze({ operation: "edit",
  summary: "Fix normalizeName in src/name.js so it trims surrounding whitespace and lowercases the result.",
  paths: Object.freeze([PROBE_TARGET]), scopeKnown: true, expectedMutation: "singleFile",
  requestedCapabilities: Object.freeze({ write: true }), verification: Object.freeze({ required: true, planProvided: true }) }) as TaskRequest;
export const PROBE_PACKET: DelegationPacket = {
  task: { goal: PROBE_TASK.summary,
    constraints: ["Modify only src/name.js.", "Do not modify tests, package.json or any other file.",
      "Keep the exported function name and its single string parameter."],
    acceptanceCriteria: ["normalizeName(\"  Ada Lovelace \\n\") returns \"ada lovelace\".", "Every test in test/name.test.js passes."] },
  scope: { relevantFiles: [PROBE_TARGET, "test/name.test.js"], allowedFiles: [PROBE_TARGET],
    forbiddenFiles: ["test/name.test.js", "package.json"] },
  architecture: { decisions: [], invariants: ["No new dependencies."] }, verification: { requiredTests: ["unit"] }, openQuestions: [] };
/** Read-only, inside the confined runtime only. */
export const PROBE_PLAN: readonly VerificationCommand[] = Object.freeze([Object.freeze({ id: "unit", executable: "/usr/local/bin/node",
  args: Object.freeze(["--test", "test/name.test.js"]), cwd: ".", timeoutMs: 120_000, mutationPolicy: "readOnly" as const })]);
export const PROBE_RUN_TIMEOUT_MS = 15 * 60_000;

/** The probe's Fusion configuration, validated exactly like a `fusion.config.json`. */
export function probeConfig(binding: BindingConfig): FusionConfig {
  return parseConfig({ schemaVersion: 1, bindings: [binding], verification: { commands: [], platformRequirement: "platform-neutral",
    confinedCommands: PROBE_PLAN, dependencies: "none" }, limits: { runTimeoutMs: PROBE_RUN_TIMEOUT_MS },
    protection: { ignoredPaths: ["secrets.local"] } });
}

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
export const FIXTURE_GIT = ["-c", "user.name=Fusion Probe", "-c", "user.email=fusion-probe@example.invalid", "-c", "commit.gpgsign=false",
  "-c", "core.autocrlf=false", "-c", "init.defaultBranch=main"];

/** Creates the fixture primary (committed baseline plus ignored canaries) in a fresh directory under `parent`. */
export async function createProbeFixture(parent: string, provider: string, git: ProcessGitClient): Promise<string> {
  const dir = join(parent, `${provider}-fixture-${randomBytes(6).toString("hex")}`), root = join(dir, "primary");
  for (const [path, content] of Object.entries(PROBE_FIXTURE_FILES)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content, { flag: "wx" });
  }
  await gitOk(git, [...FIXTURE_GIT, "init", "-q"], { cwd: root }, "fixture init");
  await gitOk(git, [...FIXTURE_GIT, "add", "--all"], { cwd: root }, "fixture add");
  await gitOk(git, [...FIXTURE_GIT, "commit", "-q", "-m", "probe fixture baseline"], { cwd: root }, "fixture commit");
  for (const [path, content] of Object.entries(PROBE_CANARIES)) await writeFile(join(root, path), content, { flag: "wx" });
  return root;
}

export interface PrimaryEvidence {
  readonly digest: string;
  readonly head: string;
  readonly files: number;
  readonly status: string;
  readonly canaries: Readonly<Record<string, string>>;
}
/** Full walk of the primary (tracked, untracked, ignored and `.git` files, by content), `git status` and HEAD. */
export async function primaryEvidence(root: string, git: ProcessGitClient): Promise<PrimaryEvidence> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name), key = relative(root, path).split(sep).join("/");
    files[key] = entry.isSymbolicLink() ? "link" : entry.isDirectory() ? "directory" : entry.isFile()
      ? sha256(await readFile(path)) : "special";
  }
  const status = await gitOk(git, ["--no-optional-locks", "status", "--porcelain=v1", "-uall", "--ignored"], { cwd: root }, "fixture status");
  const head = (await gitOk(git, ["--no-optional-locks", "rev-parse", "HEAD"], { cwd: root }, "fixture head")).trim();
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  return Object.freeze({ digest: sha256(JSON.stringify({ files: sorted, status, head })), head, files: Object.keys(sorted).length,
    status, canaries: Object.freeze(Object.fromEntries(Object.keys(PROBE_CANARIES).map(path => [path, files[path] ?? "missing"]))) });
}

// ---------------------------------------------------------------- guards and observation

/** Whether `env` belongs to a nested agent session the probe must not start inside (key names only). */
export function nestedAgentSession(env: NodeJS.ProcessEnv, keys: readonly string[]): boolean {
  return Object.keys(env).some(key => keys.includes(key.toUpperCase()));
}

/**
 * The Worker adapter as the engine sees it, except that `runChangeProposalTurn` may run exactly once: a second call is
 * refused before it reaches the provider. Every other member is the adapter's own, bound to it.
 */
export function singleProposalAdapter(adapter: ProviderAdapter): Readonly<{ adapter: ProviderAdapter; calls: () => number }> {
  let calls = 0;
  const proxy = new Proxy(adapter, { get(target, property) {
    const value: unknown = Reflect.get(target, property, target);
    if (property === "runChangeProposalTurn" && typeof value === "function")
      return (...args: unknown[]) => {
        if (++calls > 1) throw new FusionFailure({ kind: "SecurityViolation", retryable: false,
          safeMessage: "The authorized probe permits exactly one change-proposal turn." });
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
  } });
  return Object.freeze({ adapter: proxy, calls: () => calls });
}

interface ObservedView { readonly handle: ProviderViewHandle; readonly checks: ViewChecks; readonly fingerprints: string[];
  released?: CleanupReport }
export interface ViewChecks {
  readonly ownedLocation: boolean;
  readonly primaryDisjoint: boolean;
  readonly gitAbsent: boolean;
  readonly providerStateAbsent: boolean;
}
/** The engine's view port, recording each view's location checks and every fingerprint the engine takes of it. */
export class RecordingViews implements ProviderViewPort {
  readonly views: ObservedView[] = [];
  constructor(private readonly inner: ProviderViewPort, private readonly primaryRoot: string) {}
  get viewRoot(): string { return this.inner.viewRoot; }
  async open(ownerId: string, request: ProviderViewRequest, signal?: AbortSignal): Promise<ProviderViewHandle> {
    const handle = await this.inner.open(ownerId, request, signal);
    this.views.push({ handle, checks: await viewChecks(handle.path, this.primaryRoot), fingerprints: [] });
    return handle;
  }
  async fingerprint(view: ProviderViewHandle, signal?: AbortSignal): Promise<string> {
    const value = await this.inner.fingerprint(view, signal);
    this.views.find(entry => entry.handle.viewId === view.viewId)?.fingerprints.push(value);
    return value;
  }
  async release(view: ProviderViewHandle): Promise<CleanupReport> {
    const report = await this.inner.release(view);
    const entry = this.views.find(item => item.handle.viewId === view.viewId);
    if (entry !== undefined) entry.released = report;
    return report;
  }
}
/** True when `child` is `parent` or lies inside it (comparable, case-insensitive on Windows). */
export const within = (parent: string, child: string): boolean => {
  const p = comparablePath(parent), c = comparablePath(child);
  return c === p || c.startsWith(`${p}${process.platform === "win32" ? "\\" : "/"}`);
};
export const exists = async (path: string): Promise<boolean> => { try { await lstat(path); return true; } catch { return false; } };
async function viewChecks(path: string, primary: string): Promise<ViewChecks> {
  const owned = dirname(dirname(resolve(path)));
  return Object.freeze({ ownedLocation: comparablePath(owned) === comparablePath(fusionTemporaryBase()) &&
      basename(dirname(path)).startsWith("fusion-provider-view-") && basename(path) === "workspace",
    primaryDisjoint: !within(primary, path) && !within(path, primary),
    gitAbsent: !await exists(join(path, ".git")),
    providerStateAbsent: !(await Promise.all(providerWorkspaceStatePaths().map(name => exists(join(path, name))))).some(Boolean) });
}

export class MemorySink implements EventSink {
  readonly events: WorkflowEvent[] = [];
  async append(event: WorkflowEvent): Promise<void> { this.events.push(structuredClone(event)); }
}

interface ObservedLaunch { readonly record: LaunchRecord; settlement?: LaunchSettlement; refused?: LaunchRefusal }

/** Absolute temporary and profile prefixes become placeholders; nothing else is rewritten. */
export function redactPath(value: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = value;
  const prefixes: Array<[string, string]> = [[fusionTemporaryBase(), "%TEMP%"]];
  const profile = env.USERPROFILE ?? env.HOME;
  if (profile) prefixes.push([resolve(profile), "%USERPROFILE%"]);
  for (const [prefix, label] of prefixes) {
    const at = out.toLowerCase().indexOf(prefix.toLowerCase());
    if (at >= 0) out = `${out.slice(0, at)}${label}${out.slice(at + prefix.length)}`;
  }
  return out;
}
/** Which of the profile's required turn controls are missing, and which widening flags are present. */
export function postureOf(rules: ProbeProfile["turnPosture"], args: readonly string[]): Readonly<{ missing: string[]; widening: string[] }> {
  const missing = rules.required.filter(([flag, value]) => {
    const at = args.indexOf(flag!);
    return at < 0 || (value !== undefined && args[at + 1] !== value);
  }).map(rule => rule.join(" "));
  return { missing, widening: args.filter(arg => rules.widening.includes(arg.split("=")[0]!)) };
}

// ---------------------------------------------------------------- the probe

export interface ProbeDependencies {
  /** The environment providers are launched from (the human's terminal in a live run). */
  readonly env: NodeJS.ProcessEnv;
  readonly registry: ProviderRegistry;
  /** The provider layer's probe facts (bindings, turn controls, authorizations, nested-session keys, forbidden variables). */
  readonly profiles: ProbeProfileSet;
  /** The id of the human authorization this run is made under (a key of `profiles.authorizations`). */
  readonly authorization: string;
  /** TEST SEAM: where the claim, the evidence and the fixture live; the authorization's namespace under %TEMP% by default. */
  readonly evidenceRoot?: string;
  /** TEST SEAM: a binding other than the profile's (fake installs). The live entry never passes one. */
  readonly binding?: BindingConfig;
  /** The compiled output root (`dist`) whose modules identify the harness in the evidence; not recorded when absent. */
  readonly compiledRoot?: string;
  /** TEST SEAM: the composition (default `composeProductionWriter`). */
  readonly compose?: (options: ProductionWriterOptions) => Promise<WriterComposition>;
  /**
   * TEST SEAM: run against an offline-rehearsal composition (fake confined backend). The evidence is then labelled
   * `offlineRehearsal` and can never count as live evidence. The live entry never sets it.
   */
  readonly offlineRehearsal?: boolean;
  /** Fusion-labelled container count (live runs), to prove none is left behind. */
  readonly fusionContainers?: () => Promise<number>;
}

export interface ProbeReport {
  readonly outcome: ProbeOutcome;
  readonly detail: string;
  /** Whether a provider model turn was launched (a `providerTurn` process started). */
  readonly modelTurnLaunched: boolean;
  readonly evidencePath: string;
  readonly evidence: ProbeEvidence;
}
/** Refusals happen before any fixture, claim, evidence or provider process exists (the namespace marker aside). */
export type ProbeRefusal = Readonly<{ refused: true; reason: "unknownAuthorization" | "authorizationConsumed" | "unknownProvider" |
  "providerNotAuthorized" | "nestedAgentSession" | "namespaceMismatch" | "alreadyAttempted"; message: string }>;

export interface ProbeEvidence {
  readonly schemaVersion: typeof PROBE_EVIDENCE_SCHEMA_VERSION;
  readonly milestone: string;
  readonly evidenceKind: "liveProvider" | "offlineRehearsal";
  readonly provider: string;
  readonly outcome: ProbeOutcome;
  readonly detail: string;
  readonly stage: "preflight" | "workflow";
  readonly startedAt: string;
  readonly durationMs: number;
  readonly [section: string]: unknown;
}

/**
 * Identity of the harness that produced a piece of evidence: one digest over every compiled source module (path and
 * content hash, sorted) plus the live entry's hash. Rebuilding the same source reproduces it.
 */
export async function harnessIdentity(compiledRoot: string | undefined, liveEntry = "proposal-probe.js"):
  Promise<Readonly<{ compiledSourceSha256: string; compiledFiles: number; liveEntrySha256: string }> | "notRecorded"> {
  if (compiledRoot === undefined) return "notRecorded";
  const srcRoot = join(resolve(compiledRoot), "src");
  const files = (await readdir(srcRoot, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith(".js"))
    .map(entry => relative(srcRoot, join(entry.parentPath, entry.name)).split(sep).join("/")).sort();
  const digest = createHash("sha256");
  for (const file of files) digest.update(`${file}\0${sha256(await readFile(join(srcRoot, ...file.split("/"))))}\n`);
  let liveEntrySha256 = "absent";
  try { liveEntrySha256 = sha256(await readFile(join(dirname(srcRoot), "test", "live", liveEntry))); } catch { /* not built */ }
  return Object.freeze({ compiledSourceSha256: digest.digest("hex"), compiledFiles: files.length, liveEntrySha256 });
}

const NAMESPACE_MARKER = "authorization.json";
/**
 * The authorization's evidence namespace: a directory dedicated to exactly one authorization, marked on first use. A
 * non-empty directory without this authorization's marker, or holding a claim of another authorization, is refused —
 * so an earlier authorization's consumed claims and evidence are never read as, mixed with or overwritten by this one's.
 */
export async function claimNamespace(root: string, id: string, milestone: string): Promise<string | undefined> {
  const marker = join(root, NAMESPACE_MARKER);
  const entries = await readdir(root).catch(() => [] as string[]);
  if (entries.length > 0) {
    let recorded: unknown;
    try { recorded = JSON.parse(await readFile(marker, "utf8")); } catch { return "the evidence directory is not this authorization's namespace"; }
    const mark = recorded as { authorization?: unknown; milestone?: unknown } | null;
    if (mark === null || typeof mark !== "object" || mark.authorization !== id || mark.milestone !== milestone)
      return "the evidence directory belongs to another authorization";
    for (const name of entries.filter(entry => entry.endsWith(".claim.json"))) {
      let claim: unknown;
      try { claim = JSON.parse(await readFile(join(root, name), "utf8")); } catch { return "a claim in the namespace is unreadable"; }
      const c = claim as { authorization?: unknown; milestone?: unknown } | null;
      if (c === null || typeof c !== "object" || c.authorization !== id || c.milestone !== milestone)
        return "a claim in the namespace belongs to another authorization";
    }
    return undefined;
  }
  await mkdir(root, { recursive: true });
  await writeFile(marker, `${JSON.stringify({ authorization: id, milestone })}\n`, { flag: "wx" });
  return undefined;
}
/** The binding facts a grant fixes that the run's binding does not match (names only), or none. */
export function bindingMismatches(binding: BindingConfig, grant: ProbeGrant): string[] {
  const expected = grant.binding;
  const mismatches: string[] = (["adapter", "model", "effort"] as const).filter(key => binding[key] !== expected[key]);
  if (binding.maxTurns !== expected.maxTurns) mismatches.push("maxTurns");
  for (const [key, value] of Object.entries(expected.options ?? {})) if (binding.options[key] !== value) mismatches.push(`options.${key}`);
  return mismatches;
}

/**
 * Runs the one authorized probe for `provider` (a key of `deps.profiles`) under `deps.authorization`. Refuses (no
 * fixture, no claim, no evidence, no provider process) for an unknown or consumed authorization, a provider the
 * authorization does not name, inside a nested agent session, for an inconsistent evidence namespace, or when this
 * provider was already attempted under this authorization. Otherwise writes exactly one evidence file.
 */
export async function runProposalProbe(provider: string, deps: ProbeDependencies): Promise<ProbeReport | ProbeRefusal> {
  const id = deps.authorization;
  const authorization = Object.hasOwn(deps.profiles.authorizations, id) ? deps.profiles.authorizations[id] : undefined;
  if (authorization === undefined)
    return { refused: true, reason: "unknownAuthorization", message: "The authorization is not one Fusion knows." };
  if (authorization.state !== "open")
    return { refused: true, reason: "authorizationConsumed", message: `Authorization ${id} is consumed; a new model turn needs a new human authorization.` };
  const profile = Object.hasOwn(deps.profiles.profiles, provider) ? deps.profiles.profiles[provider] : undefined;
  if (profile === undefined)
    return { refused: true, reason: "unknownProvider", message: `The provider must be one of: ${Object.keys(deps.profiles.profiles).join(", ")}.` };
  const grant = Object.hasOwn(authorization.grants, provider) ? authorization.grants[provider] : undefined;
  if (grant === undefined)
    return { refused: true, reason: "providerNotAuthorized", message: `Authorization ${id} covers only: ${Object.keys(authorization.grants).join(", ")}.` };
  if (nestedAgentSession(deps.env, deps.profiles.nestedSessionKeys))
    return { refused: true, reason: "nestedAgentSession", message: "The probe must be started from a normal terminal, not from inside " +
      "an agent session's tool process tree (see the probe profiles for why)." };
  const root = resolve(deps.evidenceRoot ?? join(fusionTemporaryBase(), authorization.evidenceDirectory));
  const inconsistent = await claimNamespace(root, id, authorization.milestone);
  if (inconsistent !== undefined)
    return { refused: true, reason: "namespaceMismatch", message: `${inconsistent} (${redactPath(root, deps.env)}).` };
  const claimPath = join(root, `${provider}.claim.json`);
  if (await exists(claimPath))
    return { refused: true, reason: "alreadyAttempted", message: `This provider's authorized probe was already attempted (${redactPath(claimPath, deps.env)}); ` +
      "a second model turn needs a new human authorization." };

  const started = new Date(), clock = performance.now();
  const binding = deps.binding ?? profile.binding;
  const evidenceKind = deps.offlineRehearsal === true ? "offlineRehearsal" as const : "liveProvider" as const;
  const base = { schemaVersion: PROBE_EVIDENCE_SCHEMA_VERSION, milestone: authorization.milestone, evidenceKind, provider,
    startedAt: started.toISOString(), authorization: { id, milestone: authorization.milestone, grant },
    binding: { adapter: binding.adapter, model: binding.model, effort: binding.effort, ...(binding.maxTurns === undefined ? {} : { maxTurns: binding.maxTurns }),
      options: Object.fromEntries(Object.entries(binding.options).filter(([key]) => !["executable", "binaryDirectory", "versionFile"].includes(key))) },
    harness: await harnessIdentity(deps.compiledRoot), node: process.version, platform: process.platform,
    gates: { liveGateAuthorized: REAL_WRITER_LIVE_GATE_AUTHORIZED, liveWriterAuthorization: liveWriterAuthorization().authorized } };
  const finish = async (name: string, outcome: ProbeOutcome, detail: string, stage: "preflight" | "workflow", sections: Record<string, unknown>,
    launched: boolean): Promise<ProbeReport> => {
    const evidence: ProbeEvidence = { ...base, outcome, detail, stage, durationMs: Math.round(performance.now() - clock), ...sections };
    const path = join(root, name);
    await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
    return { outcome, detail, modelTurnLaunched: launched, evidencePath: path, evidence };
  };

  // 1. Static preflight: no provider process. The binding's own factory inspects the install and the environment.
  const git = await ProcessGitClient.fromPath(deps.env, true);
  const primary = await createProbeFixture(root, provider, git);
  const factory = deps.registry.factories.get(binding.adapter);
  const preflightName = `${provider}.preflight-${started.toISOString().replace(/[:.]/gu, "-")}.json`;
  if (factory === undefined || factory.createChangeAuthor === undefined)
    return finish(preflightName, "POSTURE_BLOCKED", "the adapter kind cannot serve as a read-only Change Author", "preflight", { primaryRoot: redactPath(primary, deps.env) }, false);
  const context = { workspace: primary, env: deps.env, sessionWorkspaces: "required" as const };
  const inspection = await factory.inspect(binding, context);
  const eligibility = bindingEligibility(binding, inspection);
  const transport = transportProfile(provider, inspection.transport);
  const lane = inspection.billing.candidateLane;
  const mismatched = bindingMismatches(binding, grant);
  const missingEnvironment = grant.requiredEnvironment.filter(key => typeof deps.env[key] !== "string" || deps.env[key] === "");
  const preflight = { executable: inspection.executable, installedVersion: inspection.runtimeVersion,
    validatedVersions: transport?.compatibility.kind === "validatedVersions" ? transport.compatibility.versions : [],
    authorizedVersions: grant.runtimeVersions,
    billing: { state: inspection.billing.state, reasons: inspection.billing.reasons, ...(lane ? { laneIntent: lane } : {}) },
    authorizedLanes: grant.lanes, bindingMatchesAuthorization: mismatched.length === 0, bindingMismatches: mismatched,
    requiredEnvironment: Object.fromEntries(grant.requiredEnvironment.map(key => [key, missingEnvironment.includes(key) ? "missing" : "set"])),
    changeProposalEligibility: { state: eligibility.changeProposal.state, reasons: eligibility.changeProposal.reasons } };
  const blocked = mismatched.length > 0 ? ["MODEL_BLOCKED", `the binding differs from the authorization (${mismatched.join(", ")})`] as const
    : missingEnvironment.length > 0 ? ["VERSION_BLOCKED", `the authorization requires the pinned runtime variable(s) ${missingEnvironment.join(", ")}`] as const
    : inspection.executable !== "available" ? ["PROVIDER_FAILED", "the provider executable was not found"] as const
    : inspection.billing.state !== "clear" ? ["AUTH_BLOCKED", `billing guard: ${inspection.billing.reasons.join("; ") || inspection.billing.state}`] as const
    : lane === undefined || !grant.lanes.includes(lane) ? ["AUTH_BLOCKED", `credential lane ${lane ?? "unknown"} is not authorized (${grant.lanes.join(", ")})`] as const
    : !isValidatedRuntimeVersion(provider, inspection.transport, inspection.runtimeVersion)
      ? ["VERSION_BLOCKED", `installed ${inspection.runtimeVersion} is not a validated ${inspection.transport} release`] as const
    : !grant.runtimeVersions.includes(inspection.runtimeVersion)
      ? ["VERSION_BLOCKED", `installed ${inspection.runtimeVersion} is not the authorized release (${grant.runtimeVersions.join(", ")})`] as const
    : eligibility.changeProposal.state !== "eligible" ? ["POSTURE_BLOCKED", `change proposal ${eligibility.changeProposal.state}: ${eligibility.changeProposal.reasons.join("; ")}`] as const
    : undefined;
  if (blocked !== undefined)
    return finish(preflightName, blocked[0], blocked[1], "preflight", { preflight, primaryRoot: redactPath(primary, deps.env) }, false);

  // 2. Production composition: the Change Author from the registry, the accepted confined backend, the views.
  const launches: ObservedLaunch[] = [];
  const observations: CandidateVerificationObservation[] = [];
  const temp = fusionTemporaryBase();
  /** The top-level temporary directory a path lies in, unless it is the probe's own evidence root. */
  const temporaryRootOf = (path: string): string | undefined => {
    if (!within(temp, path) || comparablePath(path) === comparablePath(temp) || within(root, path)) return undefined;
    return join(temp, relative(temp, path).split(sep)[0]!);
  };
  // The pre-launch guard: armed with the recording view port once the workflow is about to run; nothing starts before.
  let guardedViews: RecordingViews | undefined;
  let modelTurns = 0;
  /** Why a provider process must not start — checked BEFORE it starts — as the outcome it earns; undefined: it may. */
  const launchRefusal = (record: LaunchRecord): LaunchRefusal | undefined => {
    const posture = (reason: string): LaunchRefusal => ({ outcome: "POSTURE_BLOCKED", reason });
    if (guardedViews === undefined) return posture("a provider process was started outside the probe workflow");
    const inView = guardedViews.views.some(v => comparablePath(v.handle.path) === comparablePath(record.cwd) && Object.values(v.checks).every(Boolean));
    const owned = temporaryRootOf(record.cwd);
    const hostDirectory = record.purpose === "providerHost" && owned !== undefined && comparablePath(owned) === comparablePath(record.cwd) &&
      basename(owned).startsWith("fusion-");
    if (!inView && !hostDirectory) return posture("a provider process would start outside a checked Fusion-owned view");
    if (record.args.some(arg => isAbsolute(arg) && (within(primary, arg) || within(arg, primary))))
      return posture("a provider process argument names the primary");
    const forbidden = record.envKeys.filter(key => deps.profiles.forbiddenEnv.test(key));
    if (forbidden.length > 0) return { outcome: "AUTH_BLOCKED", reason: `a forbidden variable would reach a provider process (${forbidden.join(", ")})` };
    if (record.purpose === "providerTurn") {
      if (++modelTurns > 1) return { outcome: "PROVIDER_FAILED", reason: "a second provider model turn" };
      const controls = postureOf(profile.turnPosture, record.args);
      if (controls.missing.length > 0 || controls.widening.length > 0)
        return posture("the provider model turn lacks a read-only control or carries a widening flag");
    }
    return undefined;
  };
  const containersBefore = await deps.fusionContainers?.();
  const compose = deps.compose ?? composeProductionWriter;
  const composition = await compose({ root: primary, config: probeConfig(binding), registry: deps.registry, env: deps.env,
    launchObserver: (record, settled) => {
      const entry: ObservedLaunch = { record }; launches.push(entry);
      void settled.then(value => { entry.settlement = value; });
      const refusal = launchRefusal(record);
      if (refusal === undefined) return;
      entry.refused = refusal;
      throw new FusionFailure({ kind: "SecurityViolation", retryable: false, safeMessage: `Fusion refused to start a provider process: ${refusal.reason}.` });
    },
    onVerification: observation => observations.push(observation) });
  const workers = composition.roles.filter(role => role.binding.role === "Worker");
  const acceptance = composition.verification;
  if (acceptance.acceptance !== "granted" && deps.offlineRehearsal !== true)
    return finish(preflightName, "VERIFICATION_FAILED", `confined verification not accepted: ${acceptance.reasons.join("; ") || "refused"}`,
      "preflight", { preflight, acceptance, primaryRoot: redactPath(primary, deps.env) }, launches.some(l => l.record.purpose === "providerTurn"));
  if (workers.length !== 1 || composition.roles.length !== 1 || composition.unavailable.length !== 0)
    return finish(preflightName, "POSTURE_BLOCKED", `the composition did not yield exactly one Change Author (${composition.unavailable.map(u => u.reason).join("; ")})`,
      "preflight", { preflight, acceptance, primaryRoot: redactPath(primary, deps.env) }, false);

  // 3. The one-shot claim: from here on this provider's authorization is consumed, whatever happens.
  const before = await primaryEvidence(primary, git);
  await writeFile(claimPath, `${JSON.stringify({ authorization: id, milestone: authorization.milestone, provider,
    claimedAt: new Date().toISOString(), evidenceKind })}\n`, { flag: "wx" });
  const worker = workers[0]!;
  const latched = singleProposalAdapter(worker.adapter);
  const roles: RoleCandidate[] = [{ binding: worker.binding, adapter: latched.adapter }];
  const views = new RecordingViews(composition.views, primary);
  guardedViews = views;
  const sink = new MemorySink();
  let result: WorkflowResult | undefined, crash: FusionError | undefined;
  try {
    const engine = new WorkflowEngine({ roles, workspace: composition.workspace, views, events: sink,
      verifier: { verify: () => { throw new FusionFailure({ kind: "SecurityViolation", retryable: false,
        safeMessage: "A Writer candidate is never verified on the host." }); } } });
    const runLabel = authorization.milestone.toLowerCase().replace(/[^a-z0-9]+/gu, "-");
    result = await engine.run({ runId: `${runLabel}-${provider}-${randomBytes(6).toString("hex")}`, task: PROBE_TASK, packet: PROBE_PACKET,
      verification: composition.plan, timeoutMs: PROBE_RUN_TIMEOUT_MS });
  } catch (error) {
    crash = error instanceof FusionFailure ? error.error : { kind: "InternalError", retryable: false, safeMessage: "The probe workflow stopped unexpectedly." };
  }
  // Every observed process settles (bounded); a process that never does stays visible as "unsettled" in the evidence.
  const settleBy = Date.now() + 30_000;
  while (launches.some(entry => entry.settlement === undefined) && Date.now() < settleBy) await new Promise(done => setTimeout(done, 25));
  const after = await primaryEvidence(primary, git).catch(() => undefined);
  const containersAfter = await deps.fusionContainers?.();

  // 4. Evidence and classification. Counts are of processes that STARTED; a refused launch never ran.
  const startedLaunches = launches.filter(l => l.refused === undefined);
  const counts = Object.fromEntries((["providerAuthReadback", "providerInventory", "providerInitProbe", "providerTurn", "providerHost"] as ProcessPurpose[])
    .map(purpose => [purpose, startedLaunches.filter(l => l.record.purpose === purpose).length])) as Record<ProcessPurpose, number>;
  const refusals = launches.flatMap(l => l.refused === undefined ? [] : [{ purpose: l.record.purpose ?? "unlabelled", ...l.refused }]);
  const viewPaths = views.views.map(v => v.handle.path);
  const launchEvidence = launches.map(({ record, settlement, refused }) => {
    const owned = temporaryRootOf(record.cwd);
    const cwdClass = viewPaths.some(path => comparablePath(path) === comparablePath(record.cwd)) ? "providerView"
      : within(primary, record.cwd) || within(record.cwd, primary) ? "primary"
      : owned !== undefined && comparablePath(owned) === comparablePath(record.cwd) && basename(owned).startsWith("fusion-") ? "ownedTemporary"
      : "other";
    return { purpose: record.purpose ?? "unlabelled", executable: basename(record.executable), args: record.args.map(arg => redactPath(arg, deps.env)),
      cwdClass, cwd: redactPath(record.cwd, deps.env), envKeyCount: record.envKeys.length,
      forbiddenEnvKeys: record.envKeys.filter(key => deps.profiles.forbiddenEnv.test(key)),
      argsReferencePrimary: record.args.some(arg => isAbsolute(arg) && (within(primary, arg) || within(arg, primary))),
      ...(record.purpose === "providerTurn" ? { posture: postureOf(profile.turnPosture, record.args) } : {}),
      ...(refused === undefined ? {} : { refusedBeforeStart: refused.reason }), settlement: settlement ?? "unsettled" };
  });
  // Cleanup, attributed: every temporary directory this probe's own views, candidate and provider processes used.
  const attributable = new Set<string>([...viewPaths.map(path => dirname(path)), ...(result?.lease ? [dirname(result.lease.path)] : []),
    ...launches.flatMap(({ record }) => [record.cwd, ...record.args.filter(arg => isAbsolute(arg))]).flatMap(path => {
      const owned = temporaryRootOf(path); return owned === undefined ? [] : [owned]; })]);
  const leftovers = (await Promise.all([...attributable].map(async path => await exists(path) ? [redactPath(path, deps.env)] : []))).flat();
  const proposalEvents = sink.events.filter(e => e.type === "proposal");
  const turnEvents = sink.events.filter(e => e.type === "structuredTurn");
  const identity = turnEvents.map(e => (e as Extract<WorkflowEvent, { type: "structuredTurn" }>).provenance)
    .map(p => ({ provider: p.provider, transport: p.transport, requestedModel: p.requestedModel, observedModel: p.observedModel }));
  // The init readback of the turn, kept even when the turn then failed (a malformed result, say).
  const adapterEvidence = worker.adapter as { runtimeEvidence?: Record<string, unknown>; initReadback?: Record<string, unknown>;
    structuredOutputDiagnostic?: unknown };
  const runtime = adapterEvidence.runtimeEvidence ?? adapterEvidence.initReadback;
  const attested = (worker.adapter as { attestedAuth?: { state: string; lane: string; evidence: readonly string[] } }).attestedAuth;
  const verification = observations.map(({ durationMs, outcome }) => {
    const docker = (outcome.verification.result as { docker?: { runtime?: unknown; resultAccepted?: unknown;
      steps?: ReadonlyArray<{ id: string; testCounts?: unknown; status?: unknown; exitCode?: unknown }> } }).docker;
    return { durationMs, backendId: outcome.verification.selection.backendId, confinement: outcome.verification.selection.confinement,
      platform: outcome.platform.effective, passed: outcome.verification.result.passed, runtime: docker?.runtime ?? null,
      resultAccepted: docker?.resultAccepted ?? null,
      steps: (docker?.steps ?? []).map(step => ({ id: step.id, status: step.status, exitCode: step.exitCode, testCounts: step.testCounts ?? null })) };
  });
  const changeSet = result?.changeSet;
  const sections: Record<string, unknown> = {
    preflight, acceptance, primaryRoot: redactPath(primary, deps.env),
    launches: launchEvidence, launchCounts: counts, proposalCalls: latched.calls(),
    launchGuard: { checkedBeforeStart: true, refusals },
    identity, runtimeReadback: runtime === undefined ? null : {
      source: adapterEvidence.runtimeEvidence === undefined ? "initOfFailedTurn" : "completedTurn",
      runtimeVersion: runtime.runtimeVersion, requestedModel: runtime.requestedModel,
      effectiveModel: runtime.effectiveModel, apiKeySource: runtime.apiKeySource, permissionMode: runtime.permissionMode, tools: runtime.tools,
      mcpServers: Array.isArray(runtime.mcpServers) ? runtime.mcpServers.length : null, auth: runtime.auth,
      pluginIsolation: runtime.pluginIsolation, extensionInventory: runtime.extensionInventory },
    attestedAuth: attested === undefined ? null : { state: attested.state, lane: attested.lane, evidence: attested.evidence },
    // The reply's SHAPE only (null: this adapter family reports none, or no reply was read); never any part of the reply.
    structuredOutput: structureOnlyDiagnostic(adapterEvidence.structuredOutputDiagnostic),
    views: views.views.map(v => ({ kind: v.handle.kind, checks: v.checks, fingerprintObservations: v.fingerprints.length,
      unchanged: v.fingerprints.length >= 2 && v.fingerprints.every(value => value === v.fingerprints[0]), released: v.released ?? null })),
    primary: { before: before.digest, after: after?.digest ?? "unreadable", unchanged: before.digest === after?.digest, files: before.files,
      canariesUnchanged: JSON.stringify(before.canaries) === JSON.stringify(after?.canaries), head: before.head },
    proposal: { events: proposalEvents.map(e => ({ outcome: (e as Extract<WorkflowEvent, { type: "proposal" }>).outcome,
      operations: (e as Extract<WorkflowEvent, { type: "proposal" }>).operations })),
      validated: changeSet === undefined ? null : changeSet.operations.map(op => ({ kind: op.kind, path: op.path, expectedSha256: op.expectedSha256,
        ...(op.kind === "writeText" ? { contentSha256: sha256(op.content), bytes: Buffer.byteLength(op.content, "utf8"),
          ...(op.path === PROBE_TARGET && Buffer.byteLength(op.content, "utf8") <= 4096 ? { content: op.content } : {}) } : {}) })) },
    candidate: { applied: result?.applied ?? null, changedPaths: result?.changedPaths ?? null, cleanup: result?.cleanup ?? null },
    verification: { verdict: result?.verification === undefined ? null : { passed: result.verification.passed, commandsRun: result.verification.commandsRun,
      ...(result.verification.refusal ? { refusal: result.verification.refusal } : {}), evidence: result.verification.evidence ?? null }, runs: verification },
    workflow: { state: result?.state ?? "crashed", transitions: result?.transitions.map(t => `${t.from}>${t.to}:${t.reason}`) ?? [],
      error: result?.error ?? crash ?? null, risk: result?.risk ? { level: result.risk.level, signals: result.risk.signals.map(s => s.code) } : null,
      delegateAttempts: result?.delegateAttempts ?? 0, providerViews: result?.providerViews ?? null },
    cleanup: { attributedTemporaries: attributable.size, leftoverOwnedTemporaries: leftovers,
      ...(containersBefore === undefined ? {} : { fusionContainersBefore: containersBefore, fusionContainersAfter: containersAfter }) },
    gatesAfter: { liveGateAuthorized: REAL_WRITER_LIVE_GATE_AUTHORIZED,
      providerChangeProposal: writerGateReport().rows.find(row => row.id === "providerChangeProposal")?.state ?? "missing" },
  };
  const [outcome, detail] = classifyProbe({ result, crash, turns: counts.providerTurn, proposalCalls: latched.calls(),
    launchRefusals: refusals.map(({ outcome, reason }) => ({ outcome, reason })),
    viewsUnchanged: views.views.every(v => v.fingerprints.every(value => value === v.fingerprints[0])),
    viewChecks: views.views.every(v => Object.values(v.checks).every(Boolean)),
    // Every provider process in a checked view — only a protocol host may run in an empty Fusion-owned directory — and
    // no argument names the primary.
    launchesInViews: launchEvidence.every(l => !l.argsReferencePrimary && (l.cwdClass === "providerView" ||
      (l.purpose === "providerHost" && l.cwdClass === "ownedTemporary"))),
    forbiddenEnv: launchEvidence.some(l => l.forbiddenEnvKeys.length > 0),
    turnPosture: launchEvidence.every(l => !("posture" in l) || (l.posture!.missing.length === 0 && l.posture!.widening.length === 0)),
    primaryUnchanged: before.digest === after?.digest, cleanupComplete: leftovers.length === 0 && (containersAfter === undefined || containersAfter === containersBefore),
    acceptance: result?.verification?.evidence?.acceptance, rehearsal: deps.offlineRehearsal === true });
  return finish(`${provider}.evidence.json`, outcome, detail, "workflow", sections, counts.providerTurn > 0);
}

/** A provider process the pre-launch guard refused to start, with the outcome that refusal earns. */
export interface LaunchRefusal { readonly outcome: ProbeOutcome; readonly reason: string }
export interface ProbeFacts {
  readonly result: WorkflowResult | undefined;
  readonly crash: FusionError | undefined;
  /** Model turns that STARTED (a refused launch never ran). */
  readonly turns: number;
  readonly proposalCalls: number;
  /** O5.5B11: provider processes refused before they started. */
  readonly launchRefusals?: readonly LaunchRefusal[];
  readonly viewsUnchanged: boolean;
  readonly viewChecks: boolean;
  readonly launchesInViews: boolean;
  readonly forbiddenEnv: boolean;
  readonly turnPosture: boolean;
  readonly primaryUnchanged: boolean;
  readonly cleanupComplete: boolean;
  readonly acceptance: "granted" | "offlineRehearsal" | undefined;
  readonly rehearsal: boolean;
}
/** Deterministic outcome of one probe from Fusion's own observations; provider text never decides it. */
export function classifyProbe(facts: ProbeFacts): readonly [ProbeOutcome, string] {
  const { result, crash } = facts;
  const signals = new Set(result?.risk?.signals.map(signal => signal.code) ?? []);
  if (facts.turns > 1 || facts.proposalCalls > 1) return ["PROVIDER_FAILED", `more than one provider turn was observed (${facts.turns})`];
  if (!facts.primaryUnchanged || signals.has("primaryWorkspaceChanged")) return ["PRIMARY_MUTATED", "the primary fixture changed"];
  if (!facts.viewsUnchanged || signals.has("providerWorkspaceChanged")) return ["VIEW_MUTATED", "a provider view changed"];
  if (signals.has("readOnlyWorkspaceChanged")) return ["VIEW_MUTATED", "the private candidate changed during a provider turn"];
  const refused = facts.launchRefusals?.[0];
  if (refused !== undefined) return [refused.outcome, `a provider process was refused before it started: ${refused.reason}`];
  if (!facts.viewChecks || !facts.launchesInViews) return ["POSTURE_BLOCKED", "a provider process ran outside a checked Fusion-owned view"];
  if (facts.forbiddenEnv) return ["AUTH_BLOCKED", "a forbidden credential or override variable reached a provider process"];
  if (!facts.turnPosture) return ["POSTURE_BLOCKED", "the provider turn lacked a read-only control or carried a widening flag"];
  if (crash !== undefined || result === undefined) return ["PROVIDER_FAILED", `the workflow stopped: ${crash?.kind ?? "unknown"}`];
  const reason = result.transitions.at(-1)?.reason;
  const error = result.error;
  if (result.state === "completed") {
    if (result.verification?.passed !== true) return ["VERIFICATION_FAILED", "completed without a passing verification"];
    if (facts.acceptance !== "granted" && !(facts.rehearsal && facts.acceptance === "offlineRehearsal"))
      return ["VERIFICATION_FAILED", "the verification was not covered by a granted acceptance"];
    if (result.cleanup?.complete !== true || result.providerViews?.complete !== true || !facts.cleanupComplete)
      return ["CLEANUP_FAILED", "a candidate, view, container or temporary directory was not removed"];
    if (facts.turns !== 1 || facts.proposalCalls !== 1) return ["PROVIDER_FAILED", "a completed run without exactly one provider turn"];
    return ["PASS", facts.rehearsal ? "offline rehearsal: fake provider and fake confined backend; never live evidence" : "validated, host-applied and verified in the accepted confined backend"];
  }
  const kind = error?.kind;
  switch (reason) {
    case "proposalMalformed": case "malformedResult": return ["MALFORMED_PROPOSAL", error?.safeMessage ?? "the proposal was malformed"];
    case "proposalRejected": return ["INVALID_CHANGESET", error?.safeMessage ?? "the ChangeSet was refused"];
    case "applicationRejected": case "retryExhausted": return ["INVALID_CHANGESET", "the proposal's SHA-256 preconditions did not match the baseline"];
    case "verificationFailed": return ["VERIFICATION_FAILED", error?.safeMessage ?? "the confined tests did not pass"];
    case "verifierUnavailable": case "platformIncompatible": case "confinementNotAccepted": case "dependencyLaneFailure":
    case "dependencyApprovalRequired": return ["VERIFICATION_FAILED", `confined verification refused: ${reason}`];
    case "timedOut": return ["TIMEOUT", error?.safeMessage ?? "the run exceeded its deadline"];
    case "cleanupIncomplete": return ["CLEANUP_FAILED", error?.safeMessage ?? "cleanup was incomplete"];
    case "workspaceFailure": case "unexpectedScope": return ["APPLICATION_FAILED", error?.safeMessage ?? "host application failed"];
    default: break;
  }
  if (kind === "Timeout") return ["TIMEOUT", error!.safeMessage];
  if (kind === "AuthMismatch" || kind === "BillingBlocked") return ["AUTH_BLOCKED", error!.safeMessage];
  if (kind === "CapabilityUnavailable") return [/version/iu.test(error!.safeMessage) ? "VERSION_BLOCKED" : "POSTURE_BLOCKED", error!.safeMessage];
  if (kind === "MalformedOutput") return ["MALFORMED_PROPOSAL", error!.safeMessage];
  if (kind === "SecurityViolation")
    return [result.applied !== undefined ? "APPLICATION_FAILED" : "POSTURE_BLOCKED", error!.safeMessage];
  if (kind === "ProviderIdentityMismatch") return ["MODEL_BLOCKED", `identity: ${error!.safeMessage}`];
  return ["PROVIDER_FAILED", `${reason ?? "unknown"}: ${error?.safeMessage ?? result.state}`];
}
