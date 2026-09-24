import { randomBytes } from "node:crypto";
import { mkdir, readdir, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import type { AgentRole, FusionError, ProviderAdapter } from "../core/domain.js";
import { FusionFailure } from "../core/errors.js";
import type { RoleCandidate } from "../core/policy/routing.js";
import { WorkflowEngine } from "../core/workflow/engine.js";
import type { Transition, WorkflowEvent, WorkflowResult } from "../core/workflow/types.js";
import { structureOnlyDiagnostic } from "../platform/process/structured-envelope.js";
import type { LaunchRecord, LaunchSettlement, ProcessPurpose } from "../platform/process/supervisor.js";
import type { CandidateVerificationObservation } from "../platform/workflow/candidates.js";
import { comparablePath, gitOk, ProcessGitClient } from "../platform/workspace/git.js";
import { isValidatedRuntimeVersion, transportProfile } from "../runtime/provider-profiles.js";
import { parseConfig, type BindingConfig, type FusionConfig } from "./config.js";
import type { ProviderRegistry } from "./providers.js";
import { bindingMismatches, claimNamespace, exists, FIXTURE_GIT, harnessIdentity, MemorySink, nestedAgentSession, postureOf,
  primaryEvidence, RecordingViews, redactPath, within, type ProbeGrant, type ProbeProfileSet } from "./proposal-probe.js";
import { bindingEligibility } from "./readiness.js";
import { REHEARSAL_FILES, REHEARSAL_PLAN, ROUTE_PACKET, ROUTE_TASK } from "./route-fixture.js";
import { composeProductionWriter, type ProductionWriterOptions, type WriterComposition } from "./writer-composition.js";
import { liveWriterAuthorization, REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport } from "./writer-gate.js";

/**
 * O5.5B12 — the FULL-ROUTE live rehearsal harness: one run of the PRODUCTION Writer route through the real
 * `WorkflowEngine` and `composeProductionWriter` — Lead plan → read-only Change Author → Fusion validation and host
 * application into a private candidate → confined verification → fresh Reviewer → Lead adjudication → at most the
 * engine's one bounded correction — on a throw-away fixture Fusion creates under the temporary directory.
 *
 * It orchestrates nothing of its own: every decision is the engine's. What it adds is bounding and evidence:
 *  - a named ROUTE AUTHORIZATION (provider-layer data) freezing, per role, the provider family, executable, runtime
 *    versions, lanes and exact binding, and per TURN CLASS a maximum count. A `pending` authorization refuses before
 *    anything exists: it is a plan awaiting human approval, not a runnable grant;
 *  - a TURN GATE wrapping each role's adapter: a model turn runs only when the engine's own last transition makes it
 *    exactly that turn class, in order, within its budget; the Change Author's second slot opens only after the engine
 *    moved to a retry for a mechanical reason (a confirmed finding, a failed verification, a stale precondition).
 *    A refused turn never reaches the provider, and a failed or malformed turn has consumed its slot;
 *  - a PRE-LAUNCH GUARD over every provider process of every role: an authorized executable only, in a checked
 *    Fusion-owned view (the turn class's own view kind for a model turn), no primary path, no forbidden variable, the
 *    family's read-only turn controls and no widening flag, at most one model process per authorized turn;
 *  - bounded, redacted evidence per role turn and for the whole route; never a reply, prompt, transcript or credential.
 * Nothing here opens any gate: `REAL_WRITER_LIVE_GATE_AUTHORIZED` stays false and no readiness row reads this evidence.
 */

export const ROUTE_MILESTONE_EVIDENCE_SCHEMA = 1 as const;
/** Every model-turn class the frozen route can contain. Anything else (an Explorer, a Lead review) has no budget. */
export const ROUTE_TURN_CLASSES = Object.freeze(["leadPlan", "changeAuthor", "freshReview", "leadAdjudication"] as const);
export type RouteTurnClass = (typeof ROUTE_TURN_CLASSES)[number];
export const ROUTE_ROLES = Object.freeze(["Lead", "Worker", "Reviewer"] as const);
export type RouteRole = (typeof ROUTE_ROLES)[number];
/** The Change Author's second slot opens only after the engine itself moved to a retry for one of these reasons. */
export const SECOND_ATTEMPT_REASONS: readonly string[] = Object.freeze(["reviewFindingsConfirmed", "verificationFailed", "applicationRejected"]);
/** The provider view each turn class runs in (the engine's own choice, checked again before each model process starts). */
export const ROUTE_VIEW_OF: Readonly<Record<RouteTurnClass, "baseline" | "candidate">> = Object.freeze({
  leadPlan: "baseline", changeAuthor: "baseline", freshReview: "candidate", leadAdjudication: "candidate" });

/** One role's frozen grant: the O5.5B11 grant facts plus its provider family and the process executable it may start. */
export interface RouteRoleGrant extends ProbeGrant {
  /** Key of the family's probe profile (turn controls). */
  readonly family: string;
  /** Basename of the only executable a process of this role may start (compared case-insensitively). */
  readonly executable: string;
}
export interface RouteAuthorization {
  readonly milestone: string;
  readonly evidenceDirectory: string;
  /** `pending`: a plan for human review, refused before anything exists. `open`: runnable once. `consumed`. */
  readonly state: "pending" | "open" | "consumed";
  readonly roles: Readonly<Record<RouteRole, RouteRoleGrant>>;
  /** Maximum model turns per class; the sum is the run's whole provider-turn budget. */
  readonly turns: Readonly<Record<RouteTurnClass, number>>;
}
export interface RouteProfileSet {
  /** The family profiles (turn controls), nested-session keys and forbidden variables of the proposal probes. */
  readonly families: ProbeProfileSet;
  readonly authorizations: Readonly<Record<string, RouteAuthorization>>;
}

export const ROUTE_OUTCOMES = Object.freeze(["PASS", "AUTH_BLOCKED", "VERSION_BLOCKED", "MODEL_BLOCKED", "POSTURE_BLOCKED",
  "TURN_REFUSED", "PROVIDER_FAILED", "TIMEOUT", "CANCELLED", "MALFORMED_OUTPUT", "INVALID_CHANGESET", "APPLICATION_FAILED",
  "VERIFICATION_FAILED", "FINDINGS_UNRESOLVED", "DECISION_REQUIRED", "ROUTE_MISMATCH", "VIEW_MUTATED", "PRIMARY_MUTATED",
  "CLEANUP_FAILED"] as const);
export type RouteOutcome = (typeof ROUTE_OUTCOMES)[number];
export interface RouteLaunchRefusal { readonly outcome: RouteOutcome; readonly reason: string }

// ---------------------------------------------------------------- the turn gate

/** One authorized role turn: bounded labels and counts only. */
export interface RouteTurnRecord {
  readonly turn: RouteTurnClass;
  readonly slot: number;
  readonly role: RouteRole;
  readonly family: string;
  outcome: "running" | "completed" | "failed" | "cancelled" | "threw";
  errorKind?: string;
  sessionId?: string;
  viewKinds: string[];
  modelProcesses: number;
  processes: Partial<Record<ProcessPurpose, number>>;
  structuredOutput: unknown;
  durationMs?: number;
}
interface ActiveTurn { readonly record: RouteTurnRecord; readonly grant: RouteRoleGrant; readonly viewKind: "baseline" | "candidate" }
export type RouteAdmission = Readonly<{ turn: RouteTurnClass; slot: number }> | Readonly<{ refused: string }>;

/**
 * Wraps each role's adapter so that a model turn runs only as an authorized turn class, in order and within budget, and
 * only in the workflow state the engine itself moved to for that turn. Decisions read only the engine's transitions
 * (trusted, recorded before each turn), never provider output.
 */
export class RouteTurnGate {
  readonly turns: RouteTurnRecord[] = [];
  readonly refusals: Array<Readonly<{ role: string; call: string; reason: string }>> = [];
  active: ActiveTurn | undefined;
  constructor(private readonly authorization: RouteAuthorization, private readonly transitions: () => readonly Transition[],
    private readonly durable: (entry: Readonly<Record<string, unknown>>) => Promise<void> = async () => undefined,
    private readonly onTurn?: (turn: RouteTurnClass, slot: number) => void) {}

  used(turn: RouteTurnClass): number { return this.turns.filter(record => record.turn === turn).length; }

  /** Which authorized turn this call is right now, or why it is refused. Pure: consumes nothing. */
  admit(role: string, call: string, request: unknown): RouteAdmission {
    const all = this.transitions(), last = all.at(-1);
    const fields = request !== null && typeof request === "object" ? request as { kind?: unknown; cycle?: unknown } : {};
    const cycle = typeof fields.cycle === "number" ? fields.cycle : undefined;
    const state = last === undefined ? "none" : `${last.to}:${last.reason}`;
    const refuse = (reason: string): RouteAdmission => ({ refused: reason });
    let turn: RouteTurnClass, slot: number;
    if (role === "Lead" && call === "runTurn" && last?.to === "planning" && last.reason === "planRequested") {
      turn = "leadPlan"; slot = this.used(turn) + 1;
    } else if (role === "Lead" && call === "runStructuredTurn" && fields.kind === "adjudication" && last?.to === "adjudicating" &&
        last.reason === "adjudicationRequested" && cycle !== undefined && last.attempt === cycle) {
      turn = "leadAdjudication"; slot = cycle;
    } else if (role === "Worker" && call === "runChangeProposalTurn" && last?.to === "delegating" && last.reason === "delegated") {
      turn = "changeAuthor"; slot = this.used(turn) + 1;
      if (last.attempt !== slot) return refuse(`the Change Author turn is attempt ${String(last.attempt)}, not slot ${slot}`);
      if (slot > 1) {
        const retry = [...all].reverse().find(transition => transition.to === "retrying");
        if (retry === undefined || !SECOND_ATTEMPT_REASONS.includes(retry.reason))
          return refuse("a second Change Author turn without a mechanical retry or correction state");
      }
    } else if (role === "Reviewer" && call === "runStructuredTurn" && fields.kind === "review" && last?.to === "reviewing" &&
        last.reason === "freshReviewRequested" && cycle !== undefined && last.attempt === cycle) {
      turn = "freshReview"; slot = cycle;
    } else {
      return refuse(`the ${role} role may not run ${call}${typeof fields.kind === "string" ? ` (${fields.kind})` : ""} in state ${state}`);
    }
    if (slot !== this.used(turn) + 1) return refuse(`${turn} slot ${slot} is out of order`);
    if (slot > this.authorization.turns[turn]) return refuse(`${turn} budget of ${this.authorization.turns[turn]} is exhausted`);
    return { turn, slot };
  }

  /** The adapter as the engine sees it: every model-turn method gated, every other member the adapter's own. */
  wrap(role: AgentRole, adapter: ProviderAdapter): ProviderAdapter {
    const gate = this;
    const turnMethods = new Set(["runTurn", "runStructuredTurn", "runChangeProposalTurn"]);
    return new Proxy(adapter, { get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (typeof property !== "string" || !turnMethods.has(property)) return (value as (...a: unknown[]) => unknown).bind(target);
      return async (...args: unknown[]) => {
        const [session, request] = args as [{ id?: unknown } | undefined, unknown];
        const decision = gate.admit(role, property, property === "runTurn" ? undefined : request);
        if ("refused" in decision) {
          gate.refusals.push(Object.freeze({ role, call: property, reason: decision.refused }));
          throw new FusionFailure({ kind: "SecurityViolation", retryable: false,
            safeMessage: `The rehearsal authorization refuses this turn: ${decision.refused}.` });
        }
        const grant = gate.authorization.roles[role as RouteRole];
        const record: RouteTurnRecord = { turn: decision.turn, slot: decision.slot, role: role as RouteRole, family: grant.family,
          outcome: "running", viewKinds: [], modelProcesses: 0, processes: {}, structuredOutput: null,
          ...(typeof session?.id === "string" ? { sessionId: session.id } : {}) };
        gate.turns.push(record);
        // The slot is consumed durably before the provider is reached; a crash after this point never re-opens it.
        await gate.durable({ turn: record.turn, slot: record.slot, role, at: new Date().toISOString() });
        gate.onTurn?.(record.turn, record.slot);
        gate.active = { record, grant, viewKind: ROUTE_VIEW_OF[record.turn] };
        const clock = performance.now();
        try {
          const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          const status = (result as { status?: unknown } | null)?.status;
          record.outcome = status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "failed";
          if (status !== "completed") record.errorKind = String((result as { error?: { kind?: unknown } } | null)?.error?.kind ?? "unknown");
          return result;
        } catch (error) {
          record.outcome = "threw";
          record.errorKind = error instanceof FusionFailure ? error.error.kind : "InternalError";
          throw error;
        } finally {
          record.durationMs = Math.round(performance.now() - clock);
          // The reply's shape only, for the structured turns of an adapter that reports it (never content).
          if (property !== "runTurn")
            record.structuredOutput = structureOnlyDiagnostic((target as { structuredOutputDiagnostic?: unknown }).structuredOutputDiagnostic);
          gate.active = undefined;
        }
      };
    } });
  }
}

// ---------------------------------------------------------------- the throw-away fixture

/** Ignored, synthetic (not secret) canaries in the primary; the rehearsal proves them unchanged. */
export const ROUTE_CANARIES: Readonly<Record<string, string>> = Object.freeze({
  ".env": "FUSION_ROUTE_CANARY=synthetic-not-a-secret-7a31\n",
  "secrets.local": "synthetic protected route canary 2c6e\n",
});
export const ROUTE_RUN_TIMEOUT_MS = 45 * 60_000;

/** Creates the fixture primary (the committed "quotes" project plus ignored canaries) in a fresh directory under `parent`. */
export async function createRouteFixture(parent: string, git: ProcessGitClient): Promise<string> {
  const dir = join(parent, `route-fixture-${randomBytes(6).toString("hex")}`), root = join(dir, "primary");
  for (const [path, content] of Object.entries(REHEARSAL_FILES)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content, { flag: "wx" });
  }
  await gitOk(git, [...FIXTURE_GIT, "init", "-q"], { cwd: root }, "fixture init");
  await gitOk(git, [...FIXTURE_GIT, "add", "--all"], { cwd: root }, "fixture add");
  await gitOk(git, [...FIXTURE_GIT, "commit", "-q", "-m", "route rehearsal fixture baseline"], { cwd: root }, "fixture commit");
  for (const [path, content] of Object.entries(ROUTE_CANARIES)) await writeFile(join(root, path), content, { flag: "wx" });
  return root;
}

/** The route's Fusion configuration, validated exactly like a `fusion.config.json`. */
export function routeConfig(bindings: Readonly<Record<RouteRole, BindingConfig>>, plan: readonly unknown[]): FusionConfig {
  return parseConfig({ schemaVersion: 1, bindings: ROUTE_ROLES.map(role => bindings[role]),
    verification: { commands: [], platformRequirement: "linux-compatible", confinedCommands: plan, dependencies: "npm-lockfile" },
    limits: { runTimeoutMs: ROUTE_RUN_TIMEOUT_MS }, protection: { ignoredPaths: ["secrets.local"] } });
}
/** The binding a role's grant freezes, exactly. */
export function grantedBinding(role: RouteRole, grant: RouteRoleGrant): BindingConfig {
  return { role, adapter: grant.binding.adapter, model: grant.binding.model, effort: grant.binding.effort,
    ...(grant.binding.maxTurns === undefined ? {} : { maxTurns: grant.binding.maxTurns }), options: { ...(grant.binding.options ?? {}) } };
}

// ---------------------------------------------------------------- the rehearsal

export interface RouteDependencies {
  readonly env: NodeJS.ProcessEnv;
  readonly registry: ProviderRegistry;
  readonly profiles: RouteProfileSet;
  readonly authorization: string;
  /** TEST SEAM: where the claim, the ledger, the evidence and the fixture live; the authorization's namespace by default. */
  readonly evidenceRoot?: string;
  /** TEST SEAM: per-role bindings other than the granted ones (fake installs). The live entry never passes any. */
  readonly bindings?: Partial<Record<RouteRole, BindingConfig>>;
  readonly compiledRoot?: string;
  /** TEST SEAM: the composition (default `composeProductionWriter`). */
  readonly compose?: (options: ProductionWriterOptions) => Promise<WriterComposition>;
  /** TEST SEAM: a fake provider and a fake confined backend; the evidence is `offlineRehearsal`, never live evidence. */
  readonly offlineRehearsal?: boolean;
  readonly fusionContainers?: () => Promise<number>;
  /** Cancels the whole run (the live entry wires Ctrl+C). */
  readonly signal?: AbortSignal;
  /** TEST SEAM: observes each authorized turn as it starts (after its slot is durably consumed). */
  readonly onTurn?: (turn: RouteTurnClass, slot: number) => void;
}
export type RouteRefusal = Readonly<{ refused: true; reason: "unknownAuthorization" | "authorizationPending" | "authorizationConsumed" |
  "unknownFamily" | "nestedAgentSession" | "namespaceMismatch" | "alreadyAttempted"; message: string }>;
export interface RouteReport {
  readonly outcome: RouteOutcome;
  readonly detail: string;
  readonly modelTurns: number;
  readonly evidencePath: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}
interface ObservedLaunch { readonly record: LaunchRecord; settlement?: LaunchSettlement; refused?: RouteLaunchRefusal; turn?: string }
const ROUTE_CLAIM = "route.claim.json", ROUTE_LEDGER = "route.turns.jsonl";

/**
 * Runs the one authorized full-route rehearsal. Refuses (no fixture, no claim, no evidence, no provider process) for an
 * unknown, pending or consumed authorization, a family without a probe profile, inside a nested agent session, for an
 * inconsistent evidence namespace, or when the authorization was already attempted. Otherwise writes exactly one
 * evidence file (a preflight block consumes nothing).
 */
export async function runRouteRehearsal(deps: RouteDependencies): Promise<RouteReport | RouteRefusal> {
  const id = deps.authorization;
  const authorization = Object.hasOwn(deps.profiles.authorizations, id) ? deps.profiles.authorizations[id] : undefined;
  if (authorization === undefined) return { refused: true, reason: "unknownAuthorization", message: "The route authorization is not one Fusion knows." };
  if (authorization.state === "pending")
    return { refused: true, reason: "authorizationPending", message: `Route authorization ${id} is a plan awaiting explicit human approval; it cannot run.` };
  if (authorization.state !== "open")
    return { refused: true, reason: "authorizationConsumed", message: `Route authorization ${id} is consumed; a new run needs a new human authorization.` };
  const families = deps.profiles.families;
  for (const role of ROUTE_ROLES) if (!Object.hasOwn(families.profiles, authorization.roles[role].family))
    return { refused: true, reason: "unknownFamily", message: `The ${role} grant names a family without a probe profile.` };
  if (nestedAgentSession(deps.env, families.nestedSessionKeys))
    return { refused: true, reason: "nestedAgentSession", message: "The rehearsal must be started from a normal terminal, not from inside an agent session's tool process tree." };
  const root = resolve(deps.evidenceRoot ?? join(tmpdir(), authorization.evidenceDirectory));
  const inconsistent = await claimNamespace(root, id, authorization.milestone);
  if (inconsistent !== undefined) return { refused: true, reason: "namespaceMismatch", message: `${inconsistent} (${redactPath(root, deps.env)}).` };
  const claimPath = join(root, ROUTE_CLAIM);
  if (await exists(claimPath)) return { refused: true, reason: "alreadyAttempted",
    message: "This route authorization was already attempted; another run needs a new human authorization." };

  const started = new Date(), clock = performance.now();
  const evidenceKind = deps.offlineRehearsal === true ? "offlineRehearsal" as const : "liveProvider" as const;
  const bindings = Object.fromEntries(ROUTE_ROLES.map(role => [role, deps.bindings?.[role] ?? grantedBinding(role, authorization.roles[role])])) as
    Record<RouteRole, BindingConfig>;
  const publicBinding = (binding: BindingConfig) => ({ adapter: binding.adapter, model: binding.model, effort: binding.effort,
    ...(binding.maxTurns === undefined ? {} : { maxTurns: binding.maxTurns }),
    options: Object.fromEntries(Object.entries(binding.options).filter(([key]) => !["executable", "binaryDirectory", "versionFile"].includes(key))) });
  const base = { schemaVersion: ROUTE_MILESTONE_EVIDENCE_SCHEMA, kind: "fullRouteRehearsal", milestone: authorization.milestone, evidenceKind,
    startedAt: started.toISOString(), authorization: { id, milestone: authorization.milestone, turns: authorization.turns,
      roles: Object.fromEntries(ROUTE_ROLES.map(role => [role, authorization.roles[role]])) },
    bindings: Object.fromEntries(ROUTE_ROLES.map(role => [role, publicBinding(bindings[role])])),
    harness: await harnessIdentity(deps.compiledRoot, "route-rehearsal.js"), node: process.version, platform: process.platform,
    gates: { liveGateAuthorized: REAL_WRITER_LIVE_GATE_AUTHORIZED, liveWriterAuthorization: liveWriterAuthorization().authorized } };
  const finish = async (name: string, outcome: RouteOutcome, detail: string, stage: "preflight" | "workflow",
    sections: Record<string, unknown>, modelTurns: number): Promise<RouteReport> => {
    const evidence = { ...base, outcome, detail, stage, durationMs: Math.round(performance.now() - clock), ...sections };
    const path = join(root, name);
    await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
    return { outcome, detail, modelTurns, evidencePath: path, evidence };
  };

  // 1. Static preflight per role, no provider process: install, version, lane, exact binding, posture eligibility.
  const git = await ProcessGitClient.fromPath(deps.env, true);
  const primary = await createRouteFixture(root, git);
  const preflightName = `route.preflight-${started.toISOString().replace(/[:.]/gu, "-")}.json`;
  const preflight: Record<string, unknown> = {};
  for (const role of ROUTE_ROLES) {
    const grant = authorization.roles[role], binding = bindings[role];
    const factory = deps.registry.factories.get(binding.adapter);
    if (factory === undefined || (role === "Worker" && factory.createChangeAuthor === undefined))
      return finish(preflightName, "POSTURE_BLOCKED", `${role}: the adapter kind cannot serve this role`, "preflight", { preflight, primaryRoot: redactPath(primary, deps.env) }, 0);
    const inspection = await factory.inspect(binding, { workspace: primary, env: deps.env, sessionWorkspaces: "required" });
    const eligibility = bindingEligibility(binding, inspection);
    const surface = role === "Worker" ? eligibility.changeProposal : eligibility.review;
    // The grant family is the provider profile id (an inspection names the provider as its binding does).
    const transport = transportProfile(grant.family, inspection.transport);
    const lane = inspection.billing.candidateLane;
    const mismatched = bindingMismatches(binding, grant);
    const missing = grant.requiredEnvironment.filter(key => typeof deps.env[key] !== "string" || deps.env[key] === "");
    preflight[role] = { family: grant.family, executable: inspection.executable, installedVersion: inspection.runtimeVersion,
      validatedVersions: transport?.compatibility.kind === "validatedVersions" ? transport.compatibility.versions : [],
      authorizedVersions: grant.runtimeVersions, billing: { state: inspection.billing.state, reasons: inspection.billing.reasons,
        ...(lane ? { laneIntent: lane } : {}) }, authorizedLanes: grant.lanes, bindingMatchesAuthorization: mismatched.length === 0,
      bindingMismatches: mismatched, requiredEnvironment: Object.fromEntries(grant.requiredEnvironment.map(key => [key, missing.includes(key) ? "missing" : "set"])),
      eligibility: { state: surface.state, reasons: surface.reasons } };
    const blocked = mismatched.length > 0 ? ["MODEL_BLOCKED", `the binding differs from the authorization (${mismatched.join(", ")})`] as const
      : missing.length > 0 ? ["VERSION_BLOCKED", `the authorization requires the pinned runtime variable(s) ${missing.join(", ")}`] as const
      : inspection.executable !== "available" ? ["PROVIDER_FAILED", "the provider executable was not found"] as const
      : inspection.billing.state !== "clear" ? ["AUTH_BLOCKED", `billing guard: ${inspection.billing.reasons.join("; ") || inspection.billing.state}`] as const
      : lane === undefined || !grant.lanes.includes(lane) ? ["AUTH_BLOCKED", `credential lane ${lane ?? "unknown"} is not authorized (${grant.lanes.join(", ")})`] as const
      : !isValidatedRuntimeVersion(grant.family, inspection.transport, inspection.runtimeVersion)
        ? ["VERSION_BLOCKED", `installed ${inspection.runtimeVersion} is not a validated ${inspection.transport} release`] as const
      : !grant.runtimeVersions.includes(inspection.runtimeVersion)
        ? ["VERSION_BLOCKED", `installed ${inspection.runtimeVersion} is not the authorized release (${grant.runtimeVersions.join(", ")})`] as const
      : surface.state !== "eligible" ? ["POSTURE_BLOCKED", `${role === "Worker" ? "change proposal" : "review"} ${surface.state}: ${surface.reasons.join("; ")}`] as const
      : undefined;
    if (blocked !== undefined)
      return finish(preflightName, blocked[0], `${role}: ${blocked[1]}`, "preflight", { preflight, primaryRoot: redactPath(primary, deps.env) }, 0);
  }

  // 2. Production composition with the pre-launch guard over every provider process of every role.
  const launches: ObservedLaunch[] = [];
  const observations: CandidateVerificationObservation[] = [];
  const temp = resolve(tmpdir());
  const temporaryRootOf = (path: string): string | undefined => {
    if (!within(temp, path) || comparablePath(path) === comparablePath(temp) || within(root, path)) return undefined;
    return join(temp, relative(temp, path).split(sep)[0]!);
  };
  const executables = new Map(ROUTE_ROLES.map(role => [authorization.roles[role].executable.toLowerCase(), authorization.roles[role].family]));
  let guardedViews: RecordingViews | undefined, gate: RouteTurnGate | undefined;
  const launchRefusal = (record: LaunchRecord): RouteLaunchRefusal | undefined => {
    const posture = (reason: string): RouteLaunchRefusal => ({ outcome: "POSTURE_BLOCKED", reason });
    if (guardedViews === undefined || gate === undefined) return posture("a provider process was started outside the rehearsal workflow");
    const executable = basename(record.executable).toLowerCase();
    const family = executables.get(executable);
    if (family === undefined) return posture("a provider process of an executable the authorization does not name");
    const view = guardedViews.views.find(v => comparablePath(v.handle.path) === comparablePath(record.cwd) && Object.values(v.checks).every(Boolean));
    const owned = temporaryRootOf(record.cwd);
    const hostDirectory = record.purpose === "providerHost" && owned !== undefined && comparablePath(owned) === comparablePath(record.cwd) &&
      basename(owned).startsWith("fusion-");
    if (view === undefined && !hostDirectory) return posture("a provider process would start outside a checked Fusion-owned view");
    if (record.args.some(arg => isAbsolute(arg) && (within(primary, arg) || within(arg, primary))))
      return posture("a provider process argument names the primary");
    const forbidden = record.envKeys.filter(key => families.forbiddenEnv.test(key));
    if (forbidden.length > 0) return { outcome: "AUTH_BLOCKED", reason: `a forbidden variable would reach a provider process (${forbidden.join(", ")})` };
    const active = gate.active;
    if (record.purpose === "providerTurn") {
      if (active === undefined) return { outcome: "TURN_REFUSED", reason: "a provider model turn outside an authorized role turn" };
      if (active.record.modelProcesses + 1 > 1)
        return { outcome: "TURN_REFUSED", reason: `a second provider model process within ${active.record.turn} #${active.record.slot}` };
      if (executable !== active.grant.executable.toLowerCase())
        return posture(`a model turn of ${active.record.turn} by another provider than the ${active.record.role} role's authorized one`);
      if (view?.handle.kind !== active.viewKind)
        return posture(`the ${active.record.turn} turn would run outside its ${active.viewKind} view`);
      const controls = postureOf(families.profiles[family]!.turnPosture, record.args);
      if (controls.missing.length > 0 || controls.widening.length > 0)
        return posture("the provider model turn lacks a read-only control or carries a widening flag");
    }
    return undefined;
  };
  const containersBefore = await deps.fusionContainers?.();
  const compose = deps.compose ?? composeProductionWriter;
  const composition = await compose({ root: primary, config: routeConfig(bindings, [...REHEARSAL_PLAN.commands]), registry: deps.registry,
    env: deps.env, ...(deps.signal ? { signal: deps.signal } : {}),
    launchObserver: (record, settled) => {
      const active = gate?.active;
      const entry: ObservedLaunch = { record, ...(active ? { turn: `${active.record.turn}#${active.record.slot}` } : {}) };
      launches.push(entry);
      void settled.then(value => { entry.settlement = value; });
      const refusal = launchRefusal(record);
      if (refusal !== undefined) {
        entry.refused = refusal;
        throw new FusionFailure({ kind: "SecurityViolation", retryable: false, safeMessage: `Fusion refused to start a provider process: ${refusal.reason}.` });
      }
      if (active !== undefined) {
        const purpose = record.purpose ?? "providerTurn";
        active.record.processes[purpose] = (active.record.processes[purpose] ?? 0) + 1;
        if (purpose === "providerTurn") active.record.modelProcesses++;
        const kind = guardedViews?.views.find(v => comparablePath(v.handle.path) === comparablePath(record.cwd))?.handle.kind;
        if (kind !== undefined && !active.record.viewKinds.includes(kind)) active.record.viewKinds.push(kind);
      }
    },
    onVerification: observation => observations.push(observation) });
  const acceptance = composition.verification;
  if (acceptance.acceptance !== "granted" && deps.offlineRehearsal !== true)
    return finish(preflightName, "VERIFICATION_FAILED", `confined verification not accepted: ${acceptance.reasons.join("; ") || "refused"}`,
      "preflight", { preflight, acceptance, primaryRoot: redactPath(primary, deps.env) }, 0);
  const byRole = new Map(ROUTE_ROLES.map(role => [role, composition.roles.filter(candidate => candidate.binding.role === role)]));
  if (composition.unavailable.length > 0 || composition.roles.length !== ROUTE_ROLES.length || ROUTE_ROLES.some(role => byRole.get(role)!.length !== 1))
    return finish(preflightName, "POSTURE_BLOCKED", `the composition did not yield exactly one binding per route role (${composition.unavailable.map(u => u.reason).join("; ")})`,
      "preflight", { preflight, acceptance, primaryRoot: redactPath(primary, deps.env) }, 0);

  // 3. The one-shot claim: from here on the whole route authorization is consumed, whatever happens.
  const before = await primaryEvidence(primary, git);
  await writeFile(claimPath, `${JSON.stringify({ authorization: id, milestone: authorization.milestone, route: true,
    turns: authorization.turns, claimedAt: new Date().toISOString(), evidenceKind })}\n`, { flag: "wx" });
  const sink = new MemorySink();
  const transitions = (): Transition[] => sink.events.filter((e): e is Extract<WorkflowEvent, { type: "transition" }> => e.type === "transition")
    .map(e => e.transition);
  gate = new RouteTurnGate(authorization, transitions,
    entry => appendFile(join(root, ROUTE_LEDGER), `${JSON.stringify({ authorization: id, ...entry })}\n`), deps.onTurn);
  const roles: RoleCandidate[] = ROUTE_ROLES.map(role => { const candidate = byRole.get(role)![0]!;
    return { binding: candidate.binding, adapter: gate!.wrap(role, candidate.adapter) }; });
  const views = new RecordingViews(composition.views, primary);
  guardedViews = views;
  let result: WorkflowResult | undefined, crash: FusionError | undefined;
  try {
    const engine = new WorkflowEngine({ roles, workspace: composition.workspace, views, events: sink,
      verifier: { verify: () => { throw new FusionFailure({ kind: "SecurityViolation", retryable: false,
        safeMessage: "A Writer candidate is never verified on the host." }); } } });
    const runLabel = authorization.milestone.toLowerCase().replace(/[^a-z0-9]+/gu, "-");
    result = await engine.run({ runId: `${runLabel}-route-${randomBytes(6).toString("hex")}`, task: ROUTE_TASK, packet: ROUTE_PACKET,
      verification: composition.plan, timeoutMs: ROUTE_RUN_TIMEOUT_MS, ...(deps.signal ? { signal: deps.signal } : {}) });
  } catch (error) {
    crash = error instanceof FusionFailure ? error.error : { kind: "InternalError", retryable: false, safeMessage: "The rehearsal workflow stopped unexpectedly." };
  }
  const settleBy = Date.now() + 30_000;
  while (launches.some(entry => entry.settlement === undefined) && Date.now() < settleBy) await new Promise(done => setTimeout(done, 25));
  const after = await primaryEvidence(primary, git).catch(() => undefined);
  const containersAfter = await deps.fusionContainers?.();

  // 4. Evidence and classification.
  const startedLaunches = launches.filter(l => l.refused === undefined);
  const purposes: ProcessPurpose[] = ["providerAuthReadback", "providerInventory", "providerInitProbe", "providerTurn", "providerHost"];
  const counts = Object.fromEntries(purposes.map(purpose => [purpose, startedLaunches.filter(l => l.record.purpose === purpose).length]));
  const launchRefusals = launches.flatMap(l => l.refused === undefined ? [] : [{ purpose: l.record.purpose ?? "unlabelled", turn: l.turn ?? null, ...l.refused }]);
  const viewPaths = views.views.map(v => v.handle.path);
  const launchEvidence = launches.map(({ record, settlement, refused, turn }) => {
    const owned = temporaryRootOf(record.cwd);
    const view = views.views.find(v => comparablePath(v.handle.path) === comparablePath(record.cwd));
    const cwdClass = view !== undefined ? `providerView:${view.handle.kind}` : within(primary, record.cwd) || within(record.cwd, primary) ? "primary"
      : owned !== undefined && comparablePath(owned) === comparablePath(record.cwd) && basename(owned).startsWith("fusion-") ? "ownedTemporary" : "other";
    return { purpose: record.purpose ?? "unlabelled", turn: turn ?? "sessionSetup", executable: basename(record.executable),
      args: record.args.map(arg => redactPath(arg, deps.env)), cwdClass, envKeyCount: record.envKeys.length,
      forbiddenEnvKeys: record.envKeys.filter(key => families.forbiddenEnv.test(key)),
      argsReferencePrimary: record.args.some(arg => isAbsolute(arg) && (within(primary, arg) || within(arg, primary))),
      ...(record.purpose === "providerTurn" && executables.has(basename(record.executable).toLowerCase())
        ? { posture: postureOf(families.profiles[executables.get(basename(record.executable).toLowerCase())!]!.turnPosture, record.args) } : {}),
      ...(refused === undefined ? {} : { refusedBeforeStart: refused.reason }), settlement: settlement ?? "unsettled" };
  });
  const attributable = new Set<string>([...viewPaths.map(path => dirname(path)), ...(result?.lease ? [dirname(result.lease.path)] : []),
    ...launches.flatMap(({ record }) => [record.cwd, ...record.args.filter(arg => isAbsolute(arg))]).flatMap(path => {
      const owned = temporaryRootOf(path); return owned === undefined ? [] : [owned]; })]);
  const leftovers = (await Promise.all([...attributable].map(async path => await exists(path) ? [redactPath(path, deps.env)] : []))).flat();
  const events = sink.events;
  const of = <T extends WorkflowEvent["type"]>(type: T) => events.filter((e): e is Extract<WorkflowEvent, { type: T }> => e.type === type);
  const provenance = [...of("turn").map(e => e.provenance), ...of("structuredTurn").map(e => e.provenance)];
  const turns = gate.turns.map(record => {
    const seen = provenance.find(p => p.sessionId === record.sessionId);
    const binding = bindings[record.role];
    return { turn: record.turn, slot: record.slot, role: record.role, family: record.family, provider: seen?.provider ?? null,
      transport: seen?.transport ?? null, requestedModel: binding.model, observedModel: seen?.observedModel ?? null, effort: binding.effort,
      sessionId: record.sessionId ?? null, viewKinds: record.viewKinds, processes: record.processes, modelProcesses: record.modelProcesses,
      outcome: record.outcome, ...(record.errorKind ? { errorKind: record.errorKind } : {}), structuredOutput: record.structuredOutput,
      durationMs: record.durationMs ?? null, claimConsumed: true };
  });
  const findings = of("finding").map(e => ({ cycle: e.cycle, id: e.finding.id, severity: e.finding.severity, category: e.finding.category }));
  const adjudications = of("adjudication").map(e => ({ cycle: e.cycle, findingId: e.record.finding.id, verdict: e.record.verdict,
    requiredAction: e.record.requiredAction }));
  const allTransitions = transitions();
  const readbacks = Object.fromEntries(ROUTE_ROLES.map(role => {
    const adapter = byRole.get(role)![0]!.adapter as { runtimeEvidence?: Record<string, unknown>; initReadback?: Record<string, unknown>;
      attestedAuth?: { state: string; lane: string; evidence: readonly string[] } };
    const runtime = adapter.runtimeEvidence ?? adapter.initReadback;
    return [role, { runtime: runtime === undefined ? null : { source: adapter.runtimeEvidence === undefined ? "initOfFailedTurn" : "completedTurn",
      runtimeVersion: runtime.runtimeVersion, requestedModel: runtime.requestedModel, effectiveModel: runtime.effectiveModel,
      apiKeySource: runtime.apiKeySource, permissionMode: runtime.permissionMode, tools: runtime.tools,
      mcpServers: Array.isArray(runtime.mcpServers) ? runtime.mcpServers.length : null, auth: runtime.auth },
      attestedAuth: adapter.attestedAuth === undefined ? null : { state: adapter.attestedAuth.state, lane: adapter.attestedAuth.lane,
        evidence: adapter.attestedAuth.evidence } }];
  }));
  const verification = observations.map(({ durationMs, outcome }) => {
    const docker = (outcome.verification.result as { docker?: { runtime?: unknown; resultAccepted?: unknown;
      steps?: ReadonlyArray<{ id: string; testCounts?: unknown; status?: unknown; exitCode?: unknown }> } }).docker;
    return { durationMs, backendId: outcome.verification.selection.backendId, confinement: outcome.verification.selection.confinement,
      platform: outcome.platform.effective, passed: outcome.verification.result.passed, runtime: docker?.runtime ?? null,
      resultAccepted: docker?.resultAccepted ?? null,
      steps: (docker?.steps ?? []).map(step => ({ id: step.id, status: step.status, exitCode: step.exitCode, testCounts: step.testCounts ?? null })) };
  });
  const sections: Record<string, unknown> = {
    preflight, acceptance, primaryRoot: redactPath(primary, deps.env),
    route: { risk: result?.risk ? { level: result.risk.level, signals: result.risk.signals.map(s => s.code) } : null,
      freshReview: allTransitions.some(t => t.reason === "freshReviewRequested"),
      corrections: allTransitions.filter(t => t.to === "retrying" && t.reason === "reviewFindingsConfirmed").length,
      retries: allTransitions.filter(t => t.to === "retrying").map(t => t.reason), delegateAttempts: result?.delegateAttempts ?? 0 },
    turns, turnBudget: authorization.turns,
    turnUse: Object.fromEntries(ROUTE_TURN_CLASSES.map(turn => [turn, gate!.used(turn)])),
    refusals: { turns: gate.refusals, launches: launchRefusals },
    launches: launchEvidence, launchCounts: counts, readbacks,
    proposals: of("proposal").map(e => ({ attempt: e.attempt, outcome: e.outcome, operations: e.operations })),
    candidates: { created: of("candidate").filter(e => e.phase === "created").length,
      released: of("candidate").filter(e => e.phase === "released" && e.complete === true).length,
      changedPaths: result?.changedPaths ?? null, cleanup: result?.cleanup ?? null },
    verification: { events: of("verification").map(e => ({ attempt: e.attempt, passed: e.passed, commandsRun: e.commandsRun,
      ...(e.refusal ? { refusal: e.refusal } : {}), acceptance: e.evidence?.acceptance ?? null })), runs: verification },
    review: { cycles: of("reviewCycle").filter(e => e.phase === "completed").map(e => ({ cycle: e.cycle, outcome: e.outcome })), findings,
      adjudications },
    views: views.views.map(v => ({ kind: v.handle.kind, checks: v.checks, fingerprintObservations: v.fingerprints.length,
      unchanged: v.fingerprints.length >= 2 && v.fingerprints.every(value => value === v.fingerprints[0]), released: v.released ?? null })),
    primary: { before: before.digest, after: after?.digest ?? "unreadable", unchanged: before.digest === after?.digest, files: before.files,
      canariesUnchanged: JSON.stringify(before.canaries) === JSON.stringify(after?.canaries), head: before.head },
    workflow: { state: result?.state ?? "crashed", transitions: allTransitions.map(t => `${t.from}>${t.to}:${t.reason}`),
      error: result?.error ?? crash ?? null, providerViews: result?.providerViews ?? null },
    cleanup: { attributedTemporaries: attributable.size, leftoverOwnedTemporaries: leftovers,
      ...(containersBefore === undefined ? {} : { fusionContainersBefore: containersBefore, fusionContainersAfter: containersAfter }) },
    gatesAfter: { liveGateAuthorized: REAL_WRITER_LIVE_GATE_AUTHORIZED,
      providerChangeProposal: writerGateReport().rows.find(row => row.id === "providerChangeProposal")?.state ?? "missing" },
  };
  const [outcome, detail] = classifyRoute({ result, crash, turns: gate.turns, turnRefusals: gate.refusals.map(r => r.reason),
    launchRefusals: launchRefusals.map(({ outcome, reason }) => ({ outcome, reason })),
    viewsUnchanged: views.views.every(v => v.fingerprints.every(value => value === v.fingerprints[0])),
    viewChecks: views.views.every(v => Object.values(v.checks).every(Boolean)),
    launchesInViews: launchEvidence.every(l => l.refusedBeforeStart !== undefined || (!l.argsReferencePrimary &&
      (l.cwdClass.startsWith("providerView:") || (l.purpose === "providerHost" && l.cwdClass === "ownedTemporary")))),
    forbiddenEnv: launchEvidence.some(l => l.refusedBeforeStart === undefined && l.forbiddenEnvKeys.length > 0),
    primaryUnchanged: before.digest === after?.digest,
    cleanupComplete: leftovers.length === 0 && (containersAfter === undefined || containersAfter === containersBefore),
    acceptances: of("verification").map(e => e.evidence?.acceptance), rehearsal: deps.offlineRehearsal === true });
  return finish("route.evidence.json", outcome, detail, "workflow", sections, counts.providerTurn ?? 0);
}

// ---------------------------------------------------------------- classification

export interface RouteFacts {
  readonly result: WorkflowResult | undefined;
  readonly crash: FusionError | undefined;
  readonly turns: readonly RouteTurnRecord[];
  readonly turnRefusals: readonly string[];
  readonly launchRefusals: readonly RouteLaunchRefusal[];
  readonly viewsUnchanged: boolean;
  readonly viewChecks: boolean;
  readonly launchesInViews: boolean;
  readonly forbiddenEnv: boolean;
  readonly primaryUnchanged: boolean;
  readonly cleanupComplete: boolean;
  /** The acceptance label of every candidate verification. */
  readonly acceptances: readonly (string | undefined)[];
  readonly rehearsal: boolean;
}
/**
 * Deterministic outcome of one full-route rehearsal from Fusion's own observations; provider text never decides it.
 * Integrity first (primary, views, candidate), then refused launches and turns, then the engine's terminal state.
 */
export function classifyRoute(facts: RouteFacts): readonly [RouteOutcome, string] {
  const { result, crash } = facts;
  const signals = new Set(result?.risk?.signals.map(signal => signal.code) ?? []);
  // The turn a failure belongs to: the last one that did not complete, else the last one (its output was refused).
  const failedTurn = [...facts.turns].reverse().find(turn => turn.outcome !== "completed") ?? facts.turns.at(-1);
  const who = failedTurn !== undefined ? `${failedTurn.turn} #${failedTurn.slot} (${failedTurn.role})` : "the route";
  if (!facts.primaryUnchanged || signals.has("primaryWorkspaceChanged")) return ["PRIMARY_MUTATED", "the primary fixture changed"];
  if (!facts.viewsUnchanged || signals.has("providerWorkspaceChanged")) return ["VIEW_MUTATED", "a provider view changed"];
  if (signals.has("readOnlyWorkspaceChanged")) return ["VIEW_MUTATED", "the private candidate changed during a provider turn"];
  const launch = facts.launchRefusals[0];
  if (launch !== undefined) return [launch.outcome, `a provider process was refused before it started: ${launch.reason}`];
  const refusedTurn = facts.turnRefusals[0];
  if (refusedTurn !== undefined) return ["TURN_REFUSED", `a role turn was refused before it reached the provider: ${refusedTurn}`];
  if (!facts.viewChecks || !facts.launchesInViews) return ["POSTURE_BLOCKED", "a provider process ran outside a checked Fusion-owned view"];
  if (facts.forbiddenEnv) return ["AUTH_BLOCKED", "a forbidden credential or override variable reached a provider process"];
  if (crash !== undefined || result === undefined) return ["PROVIDER_FAILED", `the workflow stopped: ${crash?.kind ?? "unknown"}`];
  const reason = result.transitions.at(-1)?.reason;
  const error = result.error;
  if (result.state === "completed") {
    if (result.verification?.passed !== true) return ["VERIFICATION_FAILED", "completed without a passing verification"];
    const accepted = facts.acceptances.length > 0 && facts.acceptances.every(value => value === "granted" || (facts.rehearsal && value === "offlineRehearsal"));
    if (!accepted) return ["VERIFICATION_FAILED", "a verification was not covered by a granted acceptance"];
    if (result.cleanup?.complete !== true || result.providerViews?.complete !== true || !facts.cleanupComplete)
      return ["CLEANUP_FAILED", "a candidate, view, container or temporary directory was not removed"];
    if (!facts.turns.some(turn => turn.turn === "freshReview" && turn.outcome === "completed") ||
        !facts.turns.some(turn => turn.turn === "leadPlan" && turn.outcome === "completed"))
      return ["ROUTE_MISMATCH", "the run completed without the frozen route's Lead plan and fresh review"];
    return ["PASS", facts.rehearsal ? "offline rehearsal: fake providers and a fake confined backend; never live evidence"
      : "Lead plan, Change Author, host application, confined verification and fresh review completed within the authorized budget"];
  }
  if (result.state === "cancelled" || error?.kind === "Cancelled") return ["CANCELLED", `cancelled during ${who}`];
  switch (reason) {
    case "proposalMalformed": case "malformedResult": return ["MALFORMED_OUTPUT", `${who}: ${error?.safeMessage ?? "malformed output"}`];
    case "proposalRejected": return ["INVALID_CHANGESET", error?.safeMessage ?? "the ChangeSet was refused"];
    case "applicationRejected": return ["INVALID_CHANGESET", "the proposal's SHA-256 preconditions did not match the baseline"];
    case "retryExhausted":
      return result.verification?.passed === false
        ? ["VERIFICATION_FAILED", "the final attempt failed confined verification; the bounded budget is exhausted"]
        : ["INVALID_CHANGESET", "the final attempt's preconditions were stale; the bounded budget is exhausted"];
    case "verificationFailed": return ["VERIFICATION_FAILED", error?.safeMessage ?? "the confined tests did not pass"];
    case "verifierUnavailable": case "platformIncompatible": case "confinementNotAccepted": case "dependencyLaneFailure":
    case "dependencyApprovalRequired": case "verifierFailure": return ["VERIFICATION_FAILED", `confined verification refused: ${reason}`];
    case "unresolvedFindings": return ["FINDINGS_UNRESOLVED", "outstanding findings remain after the bounded review cycles"];
    case "decisionRequested": case "leadRejected": case "riskExceedsFlow": case "humanGateRequiredForRisk":
      return ["DECISION_REQUIRED", `the route stopped for a decision (${reason})`];
    case "reviewUnavailable": return ["POSTURE_BLOCKED", "no eligible fresh Reviewer or adjudicating Lead"];
    case "timedOut": return ["TIMEOUT", `${who}: ${error?.safeMessage ?? "the run exceeded its deadline"}`];
    case "cleanupIncomplete": return ["CLEANUP_FAILED", error?.safeMessage ?? "cleanup was incomplete"];
    case "workspaceFailure": case "unexpectedScope": return ["APPLICATION_FAILED", error?.safeMessage ?? "host application failed"];
    default: break;
  }
  const kind = error?.kind;
  if (kind === "Timeout") return ["TIMEOUT", `${who}: ${error!.safeMessage}`];
  if (kind === "AuthMismatch" || kind === "BillingBlocked") return ["AUTH_BLOCKED", `${who}: ${error!.safeMessage}`];
  if (kind === "CapabilityUnavailable") return [/version/iu.test(error!.safeMessage) ? "VERSION_BLOCKED" : "POSTURE_BLOCKED", `${who}: ${error!.safeMessage}`];
  if (kind === "MalformedOutput") return ["MALFORMED_OUTPUT", `${who}: ${error!.safeMessage}`];
  if (kind === "ProviderIdentityMismatch") return ["MODEL_BLOCKED", `${who}: identity: ${error!.safeMessage}`];
  if (kind === "SecurityViolation") return [result.applied !== undefined ? "APPLICATION_FAILED" : "POSTURE_BLOCKED", `${who}: ${error!.safeMessage}`];
  return ["PROVIDER_FAILED", `${who}: ${reason ?? "unknown"}: ${error?.safeMessage ?? result.state}`];
}

/** Test helper: the namespace's durable turn ledger, entry by entry. */
export async function routeLedger(root: string): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const { readFile } = await import("node:fs/promises");
  const names = await readdir(root).catch(() => [] as string[]);
  if (!names.includes(ROUTE_LEDGER)) return [];
  return (await readFile(join(root, ROUTE_LEDGER), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
}
