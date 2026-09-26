import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { validateChangeSet } from "../core/change/contract.js";
import type { AuthStatus, Finding, FusionError, ProviderAdapter, ReviewRequest, Session } from "../core/domain.js";
import { FusionFailure } from "../core/errors.js";
import { NO_EXTRA_CAPABILITIES, resolveRole, type ResolvedRole } from "../core/policy/routing.js";
import { REVIEW_LIMITS, validateReviewReport } from "../core/review/findings.js";
import { reviewEvidence } from "../core/review/policy.js";
import { validateStructuredTurnResult } from "../core/workflow/packets.js";
import type { ProviderViewHandle, VerificationVerdict, WorkspaceHandle } from "../core/workflow/types.js";
import { structureOnlyDiagnostic } from "../platform/process/structured-envelope.js";
import { terminalOnlyDiagnostic } from "../platform/process/terminal-diagnostic.js";
import type { LaunchRecord, LaunchSettlement, ProcessPurpose } from "../platform/process/supervisor.js";
import type { CandidateVerificationObservation } from "../platform/workflow/candidates.js";
import { comparablePath, ProcessGitClient } from "../platform/workspace/git.js";
import { isValidatedRuntimeVersion, transportProfile } from "../runtime/provider-profiles.js";
import { parseConfig, type BindingConfig, type FusionConfig } from "./config.js";
import { fileSha256, grantDirectory } from "./executable-identity.js";
import type { ProviderRegistry } from "./providers.js";
import { bindingMismatches, claimNamespace, exists, harnessIdentity, nestedAgentSession, postureOf, primaryEvidence, RecordingViews,
  redactPath, within, type ProbeProfileSet } from "./proposal-probe.js";
import { bindingEligibility } from "./readiness.js";
import { REHEARSAL_PLAN, REVIEW_CANDIDATE_CHANGE, reviewCandidateIdentity, ROUTE_PACKET } from "./route-fixture.js";
import { createRouteFixture, grantedBinding, ROUTE_TURN_CLASSES, routeFixtureIdentity, turnIdentityGaps, type RouteRoleGrant,
  type RouteTurnClass } from "./route-probe.js";
import { composeProductionWriter, type ProductionWriterOptions, type WriterComposition } from "./writer-composition.js";
import { liveWriterAuthorization, REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport } from "./writer-gate.js";
import { fusionTemporaryBase } from "../platform/fs/temporary.js";

/**
 * O5.5B23 — the REVIEWER-ONLY validation probe: exactly ONE real fresh-review turn of the production Reviewer binding, on
 * a release that is UNDER VALIDATION, with no Lead plan, no Change Author, no adjudication and no full route. It exists to
 * validate the actual installed Reviewer release before any further full-route rehearsal; it never marks anything
 * validated itself (a live PASS is recorded, and a release validated, only by a later milestone's independent review).
 *
 * The Reviewer sees exactly what production's fresh review shows it, built by the production pieces:
 *  - the pinned route fixture (`routeFixtureIdentity`) and a FUSION-AUTHORED candidate change (`REVIEW_CANDIDATE_CHANGE`,
 *    pinned by `reviewCandidateIdentity`), validated by the core and host-applied into a private candidate by the
 *    production candidate port — no provider wrote it;
 *  - Fusion's own confined verification of that candidate (the accepted backend, with its declared dependency stage),
 *    run BEFORE the claim and before any provider process;
 *  - the production review evidence (`reviewEvidence`: the task, scope, architecture, Fusion's verification and the
 *    observed diff — never a Worker's or Lead's rationale or transcript), the production `review` request, routing
 *    (`resolveRole` with structured turns, review isolation and workspace binding) and contract (`validateReviewReport`);
 *  - a Fusion-owned CANDIDATE view the session is bound to, fingerprinted before and after with the candidate and the
 *    primary.
 * Its bounds: a named authorization (`pending` refuses; `open` runs once) whose budget must be exactly one fresh review;
 * a static preflight (exact binding, the one release under validation, the executable's exact location and SHA-256, the
 * credential lane, the review surface); a pre-claim runtime readback (the account lane and the running host's own version
 * report); a one-shot claim right before the only model turn; a turn gate on the adapter; a pre-launch guard over every
 * provider process (the pinned executable only, the candidate view or an empty Fusion-owned host directory, the family's
 * read-only controls, the exact model/effort/step flags, one model process); the executable re-hashed after the turn.
 * Evidence is bounded and redacted: labels, counts and digests; never the reply, the prompt, the diff or a credential.
 * Nothing here opens any gate or validates any release: `REAL_WRITER_LIVE_GATE_AUTHORIZED` stays false.
 */

export const REVIEWER_PROBE_EVIDENCE_SCHEMA = 1 as const;
/** The only budget a Reviewer-only probe accepts: one fresh review, and nothing else. */
export const REVIEWER_ONLY_TURNS: Readonly<Record<RouteTurnClass, number>> = Object.freeze({ leadPlan: 0, changeAuthor: 0, freshReview: 1,
  leadAdjudication: 0 });
export const REVIEWER_PROBE_OUTCOMES = Object.freeze(["PASS", "AUTH_BLOCKED", "VERSION_BLOCKED", "MODEL_BLOCKED", "POSTURE_BLOCKED",
  "TURN_REFUSED", "PROVIDER_FAILED", "TIMEOUT", "CANCELLED", "MALFORMED_OUTPUT", "CONTRACT_REFUSED", "APPLICATION_FAILED",
  "VERIFICATION_FAILED", "VIEW_MUTATED", "PRIMARY_MUTATED", "CLEANUP_FAILED"] as const);
export type ReviewerProbeOutcome = (typeof REVIEWER_PROBE_OUTCOMES)[number];

/** The Reviewer's grant: the route role grant facts plus the executable's exact location and bytes. */
export interface ReviewerProbeGrant extends RouteRoleGrant {
  /** Where the executable must resolve: an absolute directory, or `%LOCALAPPDATA%` followed by a relative path. */
  readonly executableDirectory: string;
  /** SHA-256 of the executable's bytes: checked before the first provider process and again after the turn. */
  readonly executableSha256: string;
}
export interface ReviewerProbeAuthorization {
  readonly milestone: string;
  readonly evidenceDirectory: string;
  /** `pending`: a plan refused before anything exists. `open`: runnable once. `consumed`: it ran. `retired`: never runs. */
  readonly state: "pending" | "open" | "consumed" | "retired";
  readonly reviewer: ReviewerProbeGrant;
  /** Must be exactly `REVIEWER_ONLY_TURNS`. */
  readonly turns: Readonly<Record<RouteTurnClass, number>>;
  /** `routeFixtureIdentity()` and `reviewCandidateIdentity()` the authorization was approved for. */
  readonly fixtureSha256: string;
  readonly candidateSha256: string;
}
export interface ReviewerProbeProfileSet {
  /** The family profiles (turn controls), nested-session keys and forbidden variables of the proposal probes. */
  readonly families: ProbeProfileSet;
  readonly authorizations: Readonly<Record<string, ReviewerProbeAuthorization>>;
}
export interface ReviewerProbeDependencies {
  readonly env: NodeJS.ProcessEnv;
  readonly registry: ProviderRegistry;
  readonly profiles: ReviewerProbeProfileSet;
  readonly authorization: string;
  /** TEST SEAM: where the claim, the evidence and the fixture live; the authorization's namespace under %TEMP% by default. */
  readonly evidenceRoot?: string;
  /** TEST SEAM: a binding other than the granted one (fake installs). The live entry never passes one. */
  readonly binding?: BindingConfig;
  readonly compiledRoot?: string;
  /** TEST SEAM: the composition (default `composeProductionWriter`). */
  readonly compose?: (options: ProductionWriterOptions) => Promise<WriterComposition>;
  /** TEST SEAM: a fake provider and a fake confined backend; the evidence is `offlineRehearsal`, never live evidence. */
  readonly offlineRehearsal?: boolean;
  readonly fusionContainers?: () => Promise<number>;
  /** Cancels the run (the live entry wires Ctrl+C); cleanup still runs. */
  readonly signal?: AbortSignal;
}
export type ReviewerProbeRefusal = Readonly<{ refused: true; reason: "unknownAuthorization" | "authorizationPending" | "authorizationConsumed" |
  "authorizationRetired" | "unknownFamily" | "budgetNotReviewerOnly" | "validationTargetAmbiguous" | "fixtureMismatch" | "candidateMismatch" |
  "nestedAgentSession" | "namespaceMismatch" | "alreadyAttempted"; message: string }>;
export interface ReviewerProbeReport {
  readonly outcome: ReviewerProbeOutcome;
  readonly detail: string;
  readonly modelTurns: number;
  readonly evidencePath: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}
interface LaunchRefusal { readonly outcome: ReviewerProbeOutcome; readonly reason: string }
interface ObservedLaunch { readonly record: LaunchRecord; readonly phase: string; settlement?: LaunchSettlement; refused?: LaunchRefusal }
type Block = readonly [ReviewerProbeOutcome, string];
/** What one run built and observed, for cleanup and evidence. In memory only. */
interface RunState {
  claimed: boolean;
  lease?: WorkspaceHandle;
  view?: ProviderViewHandle;
  session?: Session;
  block?: Block | undefined;
  crash?: FusionError;
  turnError?: FusionError;
  contractError?: FusionError;
  findings?: readonly Finding[];
  readonly facts: Record<string, unknown>;
  readonly released: Record<string, unknown>;
  readonly integrity: Record<"view" | "candidate" | "primary", { before: string; after: string }>;
}

// ---------------------------------------------------------------- the turn gate

/**
 * The Reviewer adapter as the probe uses it: at most `budget` fresh-review turns (kind `review`, cycles in order) and
 * nothing else — no packet turn, no change proposal, no adjudication. A refused call never reaches the provider.
 */
export class ReviewerTurnGate {
  readonly refusals: Array<Readonly<{ call: string; reason: string }>> = [];
  #used = 0;
  constructor(private readonly budget: number) {}
  get used(): number { return this.#used; }
  wrap(adapter: ProviderAdapter): ProviderAdapter {
    const gate = this;
    return new Proxy(adapter, { get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property === "runTurn" || property === "runChangeProposalTurn")
        return async () => gate.refuse(property, `a Reviewer-only probe runs no ${property}`);
      if (property === "runStructuredTurn") return async (...args: unknown[]) => {
        const request = args[1] as { kind?: unknown; cycle?: unknown } | null | undefined;
        if (request?.kind !== "review") return gate.refuse(property, `a Reviewer-only probe runs no ${String(request?.kind ?? "unknown")} turn`);
        if (gate.#used + 1 > gate.budget) return gate.refuse(property, `the freshReview budget of ${gate.budget} is exhausted`);
        if (request.cycle !== gate.#used + 1) return gate.refuse(property, `freshReview cycle ${String(request.cycle)} is out of order`);
        gate.#used++;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
      return (value as (...a: unknown[]) => unknown).bind(target);
    } });
  }
  private refuse(call: string, reason: string): never {
    this.refusals.push(Object.freeze({ call, reason }));
    throw new FusionFailure({ kind: "SecurityViolation", retryable: false,
      safeMessage: `The reviewer probe authorization refuses this call: ${reason}.` });
  }
}

// ---------------------------------------------------------------- identity helpers

export { fileSha256, grantDirectory } from "./executable-identity.js";
/** A reported host version matches the installed release when it is that release or its version core ("1.2.3" of "1.2.3-R4"). */
export function readbackMatches(installed: string, reported: string | undefined): boolean {
  return typeof reported === "string" && /^[0-9]/u.test(reported) && (reported === installed || installed.startsWith(`${reported}-`));
}
/** The probe's Fusion configuration: the Reviewer binding alone and the route fixture's confined plan. */
export function reviewerConfig(binding: BindingConfig): FusionConfig {
  return parseConfig({ schemaVersion: 1, bindings: [binding],
    verification: { commands: [], platformRequirement: "linux-compatible", confinedCommands: REHEARSAL_PLAN.commands, dependencies: "npm-lockfile" },
    limits: { runTimeoutMs: REVIEWER_PROBE_TIMEOUT_MS }, protection: { ignoredPaths: ["secrets.local"] } });
}
export const REVIEWER_PROBE_TIMEOUT_MS = 30 * 60_000;
const CLAIM = "reviewer.claim.json";
const bounded = async <T>(work: () => Promise<T>, ms: number): Promise<T | undefined> => {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([work(), new Promise<undefined>(done => { timer = setTimeout(() => done(undefined), ms); })]); }
  catch { return undefined; }
  finally { clearTimeout(timer); }
};

// ---------------------------------------------------------------- the probe

/**
 * Runs the one authorized Reviewer-only probe. Refuses (no fixture, claim, evidence or provider process) for an unknown,
 * pending, retired or consumed authorization, a budget other than one fresh review, more than one release under
 * validation, a fixture or candidate other than the pinned ones, inside a nested agent session, for an inconsistent
 * namespace, or when the authorization was already attempted. A block before the claim writes a preflight evidence file
 * and consumes nothing; after the claim exactly one evidence file is written.
 */
export async function runReviewerProbe(deps: ReviewerProbeDependencies): Promise<ReviewerProbeReport | ReviewerProbeRefusal> {
  const id = deps.authorization;
  const authorization = Object.hasOwn(deps.profiles.authorizations, id) ? deps.profiles.authorizations[id] : undefined;
  if (authorization === undefined) return { refused: true, reason: "unknownAuthorization", message: "The reviewer probe authorization is not one Fusion knows." };
  if (authorization.state === "pending")
    return { refused: true, reason: "authorizationPending", message: `Reviewer probe authorization ${id} is a plan awaiting explicit human approval; it cannot run.` };
  if (authorization.state === "retired")
    return { refused: true, reason: "authorizationRetired", message: `Reviewer probe authorization ${id} was retired; a new run needs a new human authorization.` };
  if (authorization.state !== "open")
    return { refused: true, reason: "authorizationConsumed", message: `Reviewer probe authorization ${id} is consumed; a new run needs a new human authorization.` };
  const families = deps.profiles.families, grant = authorization.reviewer;
  if (!Object.hasOwn(families.profiles, grant.family))
    return { refused: true, reason: "unknownFamily", message: "The Reviewer grant names a family without a probe profile." };
  if (ROUTE_TURN_CLASSES.some(turn => authorization.turns[turn] !== REVIEWER_ONLY_TURNS[turn]))
    return { refused: true, reason: "budgetNotReviewerOnly", message: "A Reviewer-only probe runs exactly one fresh review and no other turn." };
  if (grant.runtimeVersions.length !== 1)
    return { refused: true, reason: "validationTargetAmbiguous", message: "A Reviewer-only probe validates exactly one release." };
  if (authorization.fixtureSha256 !== routeFixtureIdentity())
    return { refused: true, reason: "fixtureMismatch", message: `The fixture is not the one authorization ${id} was approved for.` };
  if (authorization.candidateSha256 !== reviewCandidateIdentity())
    return { refused: true, reason: "candidateMismatch", message: `The candidate change is not the one authorization ${id} was approved for.` };
  if (nestedAgentSession(deps.env, families.nestedSessionKeys))
    return { refused: true, reason: "nestedAgentSession", message: "The probe must be started from a normal terminal, not from inside an agent session's tool process tree." };
  const root = resolve(deps.evidenceRoot ?? join(fusionTemporaryBase(), authorization.evidenceDirectory));
  const inconsistent = await claimNamespace(root, id, authorization.milestone);
  if (inconsistent !== undefined) return { refused: true, reason: "namespaceMismatch", message: `${inconsistent} (${redactPath(root, deps.env)}).` };
  const claimPath = join(root, CLAIM);
  if (await exists(claimPath)) return { refused: true, reason: "alreadyAttempted",
    message: "This reviewer probe authorization was already attempted; another run needs a new human authorization." };

  const started = new Date(), clock = performance.now();
  const evidenceKind = deps.offlineRehearsal === true ? "offlineRehearsal" as const : "liveProvider" as const;
  const binding = deps.binding ?? grantedBinding("Reviewer", grant);
  const target = Object.freeze({ transport: grant.binding.adapter, version: grant.runtimeVersions[0]! });
  const family = families.profiles[grant.family]!;
  const runId = `${authorization.milestone.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}-reviewer-${randomBytes(6).toString("hex")}`;
  const base = { schemaVersion: REVIEWER_PROBE_EVIDENCE_SCHEMA, kind: "reviewerOnlyProbe", milestone: authorization.milestone, evidenceKind,
    startedAt: started.toISOString(), runId,
    authorization: { id, milestone: authorization.milestone, turns: authorization.turns, reviewer: grant },
    fixture: { sha256: routeFixtureIdentity(), pinned: authorization.fixtureSha256, candidateSha256: reviewCandidateIdentity(),
      candidatePinned: authorization.candidateSha256 },
    runtimeUnderValidation: { transport: target.transport, version: target.version },
    binding: { adapter: binding.adapter, model: binding.model, effort: binding.effort, ...(binding.maxTurns === undefined ? {} : { maxTurns: binding.maxTurns }),
      options: Object.fromEntries(Object.entries(binding.options).filter(([key]) => !["executable", "binaryDirectory", "versionFile"].includes(key))) },
    harness: await harnessIdentity(deps.compiledRoot, "reviewer-probe.js"), node: process.version, platform: process.platform,
    gates: { liveGateAuthorized: REAL_WRITER_LIVE_GATE_AUTHORIZED, liveWriterAuthorization: liveWriterAuthorization().authorized } };
  const finish = async (name: string, outcome: ReviewerProbeOutcome, detail: string, stage: "preflight" | "review",
    sections: Record<string, unknown>, modelTurns: number): Promise<ReviewerProbeReport> => {
    const evidence = { ...base, outcome, detail, stage, durationMs: Math.round(performance.now() - clock), ...sections };
    const path = join(root, name);
    await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
    return { outcome, detail, modelTurns, evidencePath: path, evidence };
  };
  const preflightName = `reviewer.preflight-${started.toISOString().replace(/[:.]/gu, "-")}.json`;

  // 1. Static preflight (no provider process): the exact binding, the ONE release under validation (never another, never
  // a fallback), the executable's exact location and bytes, the credential lane and the review surface under validation.
  const git = await ProcessGitClient.fromPath(deps.env, true);
  const primary = await createRouteFixture(root, git);
  // The primary's full identity (every file by content, `git status`, HEAD) before anything else touches the run.
  const initial = await primaryEvidence(primary, git);
  const factory = deps.registry.factories.get(binding.adapter);
  if (factory === undefined)
    return finish(preflightName, "POSTURE_BLOCKED", "Reviewer: the adapter kind is not registered", "preflight", { primaryRoot: redactPath(primary, deps.env) }, 0);
  const inspection = await factory.inspect(binding, { workspace: primary, env: deps.env, sessionWorkspaces: "required", runtimeUnderValidation: target });
  const surface = bindingEligibility(binding, inspection).review;
  const transport = transportProfile(grant.family, inspection.transport);
  const lane = inspection.billing.candidateLane;
  const mismatched = bindingMismatches(binding, grant);
  const missing = grant.requiredEnvironment.filter(key => typeof deps.env[key] !== "string" || deps.env[key] === "");
  const directory = grantDirectory(grant.executableDirectory, deps.env);
  const pinnedPath = directory === undefined ? undefined : join(directory, grant.executable);
  const path = inspection.executablePath;
  const pathMatches = path !== undefined && pinnedPath !== undefined && comparablePath(path) === comparablePath(pinnedPath);
  const digest = pathMatches ? await fileSha256(path).catch(() => "unreadable") : "notChecked";
  const preflight = { family: grant.family, executable: inspection.executable, installedVersion: inspection.runtimeVersion,
    releaseUnderValidation: target.version, validatedVersions: transport?.compatibility.kind === "validatedVersions" ? transport.compatibility.versions : [],
    installedReleaseValidated: isValidatedRuntimeVersion(grant.family, inspection.transport, inspection.runtimeVersion),
    executableIdentity: { basename: path === undefined ? null : basename(path), path: path === undefined ? null : redactPath(path, deps.env),
      locationMatches: pathMatches, sha256Matches: digest === grant.executableSha256 },
    billing: { state: inspection.billing.state, reasons: inspection.billing.reasons, ...(lane ? { laneIntent: lane } : {}) },
    authorizedLanes: grant.lanes, bindingMatchesAuthorization: mismatched.length === 0, bindingMismatches: mismatched,
    requiredEnvironment: Object.fromEntries(grant.requiredEnvironment.map(key => [key, missing.includes(key) ? "missing" : "set"])),
    eligibility: { surface: "review", state: surface.state, reasons: surface.reasons },
    controls: inspection.controls.map(control => ({ name: control.name, state: control.state })) };
  const staticBlock: Block | undefined = mismatched.length > 0 ? ["MODEL_BLOCKED", `the binding differs from the authorization (${mismatched.join(", ")})`]
    : missing.length > 0 ? ["VERSION_BLOCKED", `the authorization requires the pinned runtime variable(s) ${missing.join(", ")}`]
    : inspection.executable !== "available" ? ["PROVIDER_FAILED", "the provider executable was not found"]
    : inspection.billing.state !== "clear" ? ["AUTH_BLOCKED", `billing guard: ${inspection.billing.reasons.join("; ") || inspection.billing.state}`]
    : lane === undefined || !grant.lanes.includes(lane) ? ["AUTH_BLOCKED", `credential lane ${lane ?? "unknown"} is not authorized (${grant.lanes.join(", ")})`]
    : inspection.runtimeVersion !== target.version
      ? ["VERSION_BLOCKED", `installed ${inspection.runtimeVersion} is not the release under validation (${target.version}); no other release is ever used`]
    : !pathMatches || basename(path!).toLowerCase() !== grant.executable.toLowerCase()
      ? ["VERSION_BLOCKED", "the executable is not the authorized one at its authorized location"]
    : digest !== grant.executableSha256 ? ["VERSION_BLOCKED", "the executable's SHA-256 differs from the authorized one"]
    : surface.state !== "eligible" ? ["POSTURE_BLOCKED", `review ${surface.state}: ${surface.reasons.join("; ")}`]
    : undefined;
  if (staticBlock !== undefined)
    return finish(preflightName, staticBlock[0], `Reviewer: ${staticBlock[1]}`, "preflight", { preflight, primaryRoot: redactPath(primary, deps.env) }, 0);

  // 2. Production composition (the Reviewer binding alone) with the pre-launch guard over every provider process.
  const launches: ObservedLaunch[] = [];
  const observations: CandidateVerificationObservation[] = [];
  const temp = fusionTemporaryBase();
  const temporaryRootOf = (at: string): string | undefined => {
    if (!within(temp, at) || comparablePath(at) === comparablePath(temp) || within(root, at)) return undefined;
    return join(temp, relative(temp, at).split(sep)[0]!);
  };
  let phase: "preflight" | "readback" | "turn" | "closed" = "preflight";
  let guardedViews: RecordingViews | undefined;
  let modelTurns = 0;
  const launchRefusal = (record: LaunchRecord): LaunchRefusal | undefined => {
    const posture = (reason: string): LaunchRefusal => ({ outcome: "POSTURE_BLOCKED", reason });
    if (phase === "preflight" || guardedViews === undefined) return posture("a provider process was started before the Reviewer's session");
    if (comparablePath(record.executable) !== comparablePath(pinnedPath!))
      return { outcome: "VERSION_BLOCKED", reason: "a provider process of another executable than the authorized one" };
    if (record.args.some(arg => isAbsolute(arg) && (within(primary, arg) || within(arg, primary))))
      return posture("a provider process argument names the primary");
    const forbidden = record.envKeys.filter(key => families.forbiddenEnv.test(key));
    if (forbidden.length > 0) return { outcome: "AUTH_BLOCKED", reason: `a forbidden variable would reach a provider process (${forbidden.join(", ")})` };
    if (record.purpose === "providerHost") {
      const owned = temporaryRootOf(record.cwd);
      if (owned === undefined || comparablePath(owned) !== comparablePath(record.cwd) || !basename(owned).startsWith("fusion-"))
        return posture("a provider host would start outside an empty Fusion-owned directory");
      return undefined;
    }
    if (record.purpose !== "providerTurn") return posture(`a ${record.purpose ?? "unlabelled"} process the Reviewer-only probe never starts`);
    if (phase !== "turn") return { outcome: "TURN_REFUSED", reason: "a provider model turn outside the one authorized review turn" };
    if (++modelTurns > 1) return { outcome: "TURN_REFUSED", reason: "a second provider model process" };
    const view = guardedViews.views.find(v => comparablePath(v.handle.path) === comparablePath(record.cwd) && Object.values(v.checks).every(Boolean));
    if (view?.handle.kind !== "candidate") return posture("the review would run outside its checked candidate view");
    const controls = postureOf(family.turnPosture, record.args);
    if (controls.missing.length > 0 || controls.widening.length > 0)
      return posture("the provider model turn lacks a read-only control or carries a widening flag");
    const identity = turnIdentityGaps(grant.turnArgs ?? [], record.args);
    if (identity.length > 0) return { outcome: "MODEL_BLOCKED", reason: `the review model process does not carry exactly the authorized ${identity.join(", ")}` };
    return undefined;
  };
  const containersBefore = await deps.fusionContainers?.();
  const compose = deps.compose ?? composeProductionWriter;
  const composition = await compose({ root: primary, config: reviewerConfig(binding), registry: deps.registry, env: deps.env,
    runtimeUnderValidation: target, ...(deps.signal ? { signal: deps.signal } : {}),
    launchObserver: (record, settled) => {
      const entry: ObservedLaunch = { record, phase };
      launches.push(entry);
      void settled.then(value => { entry.settlement = value; });
      const refusal = launchRefusal(record);
      if (refusal === undefined) return;
      entry.refused = refusal;
      throw new FusionFailure({ kind: "SecurityViolation", retryable: false, safeMessage: `Fusion refused to start a provider process: ${refusal.reason}.` });
    },
    onVerification: observation => observations.push(observation) });
  const acceptance = composition.verification;
  const composedBlock: Block | undefined = acceptance.acceptance !== "granted" && deps.offlineRehearsal !== true
    ? ["VERIFICATION_FAILED", `confined verification not accepted: ${acceptance.reasons.join("; ") || "refused"}`]
    : composition.unavailable.length > 0 || composition.roles.length !== 1 || composition.roles[0]!.binding.role !== "Reviewer"
      ? ["POSTURE_BLOCKED", `the composition did not yield exactly the Reviewer (${composition.unavailable.map(u => u.reason).join("; ")})`]
    : composition.roles[0]!.binding.transport !== grant.binding.adapter
      ? ["POSTURE_BLOCKED", "the Reviewer is served by another adapter than its authorized one"]
    : undefined;
  if (composedBlock !== undefined)
    return finish(preflightName, composedBlock[0], composedBlock[1], "preflight", { preflight, acceptance, primaryRoot: redactPath(primary, deps.env) }, 0);
  // The production fresh-review routing (the engine's own needs), so a Reviewer the engine would refuse never runs here.
  let reviewer: ResolvedRole;
  try {
    reviewer = await resolveRole("Reviewer", composition.roles, NO_EXTRA_CAPABILITIES, { structuredTurns: true, reviewIsolation: true, workspaceBinding: true });
  } catch (error) {
    return finish(preflightName, "POSTURE_BLOCKED", `fresh-review routing refused the Reviewer: ${error instanceof FusionFailure ? error.error.safeMessage : "unknown"}`,
      "preflight", { preflight, acceptance, primaryRoot: redactPath(primary, deps.env) }, 0);
  }

  // 3.–5. Candidate, verification, view, session and runtime readback (all before the claim), then the one review turn.
  const port = composition.workspace, plan = composition.plan;
  const gate = new ReviewerTurnGate(authorization.turns.freshReview);
  const adapter = gate.wrap(reviewer.adapter);
  const views = new RecordingViews(composition.views, primary);
  const errorOf = (error: unknown): FusionError => error instanceof FusionFailure ? error.error
    : { kind: "InternalError", retryable: false, safeMessage: "The reviewer probe stopped unexpectedly." };
  const adapterFacts = reviewer.adapter as { terminalDiagnostic?: unknown; structuredOutputDiagnostic?: unknown; attestedRuntimeVersion?: unknown;
    attestedAuth?: AuthStatus };
  const previousTerminal = adapterFacts.terminalDiagnostic, previousOutput = adapterFacts.structuredOutputDiagnostic;
  const run: RunState = { claimed: false, facts: {}, released: {},
    integrity: { view: { before: "", after: "" }, candidate: { before: "", after: "" }, primary: { before: "", after: "" } } };
  const body = async (): Promise<Block | undefined> => {
    const scope = { allowedPaths: ROUTE_PACKET.scope.allowedFiles, forbiddenPaths: ROUTE_PACKET.scope.forbiddenFiles };
    const lease = await port.acquire(`${runId}.reviewer`, deps.signal);
    run.lease = lease;
    const change = validateChangeSet(REVIEW_CANDIDATE_CHANGE, scope);
    const applied = await port.apply(lease, change, scope);
    if (!("applied" in applied)) return ["APPLICATION_FAILED", "the Fusion-authored candidate change did not apply to the baseline"];
    run.facts.application = applied.applied.map(op => ({ kind: op.kind, path: op.path, beforeSha256: op.beforeSha256, afterSha256: op.afterSha256,
      bytes: op.bytes }));
    const changedPaths = [...new Set(await port.changedPaths(lease))].sort();
    const verdict: VerificationVerdict = await port.verify(lease, plan, deps.signal);
    const accepted = verdict.evidence?.acceptance === "granted" || (deps.offlineRehearsal === true && verdict.evidence?.acceptance === "offlineRehearsal");
    run.facts.verification = { passed: verdict.passed, commandsRun: verdict.commandsRun, ...(verdict.refusal ? { refusal: verdict.refusal } : {}),
      acceptance: verdict.evidence?.acceptance ?? null, dependencies: verdict.evidence?.dependencies ?? null, commands: verdict.evidence?.commands ?? [],
      runs: observations.map(({ durationMs, outcome }) => ({ durationMs, backendId: outcome.verification.selection.backendId,
        confinement: outcome.verification.selection.confinement, platform: outcome.platform.effective, passed: outcome.verification.result.passed })) };
    if (!verdict.passed || verdict.commandsRun !== plan.commands.length || !accepted)
      return ["VERIFICATION_FAILED", `Fusion's confined verification of the candidate did not pass${verdict.refusal ? ` (${verdict.refusal})` : ""}`];
    const diff = await port.diff(lease, deps.signal);
    // Exactly production's fresh-review evidence: the caller's packet, Fusion's verification and the observed change.
    const evidence = reviewEvidence(ROUTE_PACKET, { required: true, passed: true, commands: plan.commands.map(command => ({ id: command.id, passed: true })) },
      { kind: "diff", changedPaths, text: diff.text, truncated: diff.truncated });
    run.facts.reviewEvidence = { changedPaths: evidence.change.changedPaths, changeBytes: Buffer.byteLength(evidence.change.text, "utf8"),
      changeTruncated: evidence.change.truncated, verification: evidence.verification };

    phase = "readback";
    guardedViews = views;
    const view = await views.open(`${runId}.views`, { kind: "candidate", candidate: lease }, deps.signal);
    run.view = view;
    const candidateRoot = dirname(resolve(lease.path));
    if (view.kind !== "candidate" || !Object.values(views.views.at(-1)!.checks).every(Boolean) ||
        within(candidateRoot, view.path) || within(view.path, candidateRoot))
      return ["POSTURE_BLOCKED", "the candidate view is not a checked Fusion-owned view disjoint from the candidate"];
    run.integrity.view.before = await views.fingerprint(view, deps.signal);
    const session = await adapter.createSession({ runId, role: "Reviewer", workspaceLeaseId: lease.leaseId, posture: reviewer.posture,
      model: reviewer.binding.model, workspace: Object.freeze({ id: view.viewId, root: view.path }) });
    run.session = session;
    if (session === null || typeof session !== "object" || session.role !== "Reviewer" || session.posture !== reviewer.posture ||
        session.workspaceLeaseId !== lease.leaseId || session.runId !== runId || session.provider !== reviewer.binding.provider ||
        typeof session.id !== "string" || session.workspaceRoot !== view.path)
      return ["POSTURE_BLOCKED", "the provider session does not match the requested role, posture or workspace"];
    // Runtime readback before the claim: the account lane, and the running host's own report of its release.
    const auth = await adapter.authStatus();
    const reported = typeof adapterFacts.attestedRuntimeVersion === "string" ? adapterFacts.attestedRuntimeVersion : undefined;
    const matches = readbackMatches(inspection.runtimeVersion, reported);
    run.facts.readback = { auth: { state: auth.state, lane: auth.lane, evidence: auth.evidence }, reportedRuntimeVersion: reported ?? "notReported",
      matchesInstalled: matches };
    if (auth.state !== "authenticated" || !grant.lanes.includes(auth.lane))
      return ["AUTH_BLOCKED", `the account attestation is not an authorized lane (${auth.state}, ${auth.lane})`];
    if (!matches) return ["VERSION_BLOCKED", `the running host reported release ${reported ?? "none"}, not the release under validation ${inspection.runtimeVersion}`];

    // The one-shot claim: from here on the authorization is consumed, whatever happens.
    run.integrity.primary.before = await port.fingerprint(undefined, deps.signal);
    run.integrity.candidate.before = await port.fingerprint(lease, deps.signal);
    await writeFile(claimPath, `${JSON.stringify({ authorization: id, milestone: authorization.milestone, reviewerOnly: true,
      turns: authorization.turns, claimedAt: new Date().toISOString(), evidenceKind })}\n`, { flag: "wx" });
    run.claimed = true;
    phase = "turn";
    const request: ReviewRequest = { kind: "review", cycle: 1, evidence, priorFindings: [], limits: { maxFindings: REVIEW_LIMITS.maxFindings } };
    let raw: unknown;
    try { raw = await adapter.runStructuredTurn!(session, request, deps.signal); }
    catch (error) { run.turnError = errorOf(error); }
    phase = "closed";
    run.integrity.view.after = await views.fingerprint(view);
    run.integrity.candidate.after = await port.fingerprint(lease);
    run.integrity.primary.after = await port.fingerprint(undefined);
    if (run.turnError !== undefined) return undefined;
    let turn: ReturnType<typeof validateStructuredTurnResult>;
    try { turn = validateStructuredTurnResult(raw); }
    catch (error) { run.turnError = errorOf(error); return undefined; }
    run.facts.turn = { status: turn.status, provider: turn.effectiveProvider || null,
      observedModel: turn.status === "completed" ? turn.effectiveModel || null : null,
      requestedModel: reviewer.binding.model.id, effort: reviewer.binding.model.effort, transport: reviewer.binding.transport };
    if (turn.status !== "completed") {
      // A failed turn may not have observed any identity; a reported one must still be the bound provider (as the engine checks).
      if (turn.effectiveProvider !== "" && turn.effectiveProvider !== reviewer.binding.provider)
        return ["MODEL_BLOCKED", "the failed review was reported by another provider than the bound one"];
      run.turnError = turn.error;
      return undefined;
    }
    if (turn.effectiveProvider !== reviewer.binding.provider) return ["MODEL_BLOCKED", "the review was served by another provider than the bound one"];
    if (turn.effectiveModel !== grant.binding.model) return ["MODEL_BLOCKED", "the review's model readback is not the authorized model"];
    try { run.findings = validateReviewReport(turn.output, { cycle: 1, runId, sessionId: session.id, role: "Reviewer" }); }
    catch (error) { run.contractError = errorOf(error); }
    return undefined;
  };
  try { run.block = await body(); }
  catch (error) { run.crash = errorOf(error); }
  finally {
    phase = "closed";
    const { session, view, lease, integrity } = run;
    // Integrity after whatever ran (a pre-claim stop included), taken before anything is released.
    const settle = async (take: () => Promise<string>): Promise<string> => { try { return await take(); } catch { return "unreadable"; } };
    if (view !== undefined && integrity.view.before !== "" && integrity.view.after === "") integrity.view.after = await settle(() => views.fingerprint(view));
    if (lease !== undefined && integrity.candidate.before !== "" && integrity.candidate.after === "")
      integrity.candidate.after = await settle(() => port.fingerprint(lease));
    if (integrity.primary.before !== "" && integrity.primary.after === "") integrity.primary.after = await settle(() => port.fingerprint(undefined));
    // Cleanup, always: the session (and with it any provider host), the view, the candidate — each within a bound.
    if (session !== undefined) run.released.session = await bounded(async () => { await reviewer.adapter.close(session); return "closed"; }, 30_000) ?? "unconfirmed";
    if (view !== undefined) run.released.view = await bounded(() => views.release(view), 60_000) ?? { complete: false, reason: "timeout" };
    if (lease !== undefined) run.released.candidate = await bounded(() => port.release(lease), 90_000) ?? { complete: false, reason: "timeout" };
  }
  const settleBy = Date.now() + 30_000;
  while (launches.some(entry => entry.settlement === undefined) && Date.now() < settleBy) await new Promise(done => setTimeout(done, 25));
  const after = await primaryEvidence(primary, git).catch(() => undefined);
  const containersAfter = await deps.fusionContainers?.();
  const digestAfter = run.claimed ? await fileSha256(pinnedPath!).catch(() => "unreadable") : "notChecked";

  // Evidence: labels, counts and digests only.
  const startedLaunches = launches.filter(l => l.refused === undefined);
  const purposes: ProcessPurpose[] = ["providerAuthReadback", "providerInventory", "providerInitProbe", "providerTurn", "providerHost"];
  const counts = Object.fromEntries(purposes.map(purpose => [purpose, startedLaunches.filter(l => l.record.purpose === purpose).length])) as Record<string, number>;
  const launchRefusals = launches.flatMap(l => l.refused === undefined ? [] : [{ purpose: l.record.purpose ?? "unlabelled", phase: l.phase, ...l.refused }]);
  const launchEvidence = launches.map(({ record, phase: at, settlement, refused }) => {
    const owned = temporaryRootOf(record.cwd);
    const seen = views.views.find(v => comparablePath(v.handle.path) === comparablePath(record.cwd));
    const cwdClass = seen !== undefined ? `providerView:${seen.handle.kind}` : within(primary, record.cwd) || within(record.cwd, primary) ? "primary"
      : owned !== undefined && comparablePath(owned) === comparablePath(record.cwd) && basename(owned).startsWith("fusion-") ? "ownedTemporary" : "other";
    return { purpose: record.purpose ?? "unlabelled", phase: at, executable: basename(record.executable),
      executableIsAuthorized: comparablePath(record.executable) === comparablePath(pinnedPath!),
      args: record.args.map(arg => redactPath(arg, deps.env)), cwdClass, envKeyCount: record.envKeys.length,
      forbiddenEnvKeys: record.envKeys.filter(key => families.forbiddenEnv.test(key)),
      argsReferencePrimary: record.args.some(arg => isAbsolute(arg) && (within(primary, arg) || within(arg, primary))),
      ...(record.purpose === "providerTurn" ? { posture: postureOf(family.turnPosture, record.args), identityGaps: turnIdentityGaps(grant.turnArgs ?? [], record.args) } : {}),
      ...(refused === undefined ? {} : { refusedBeforeStart: refused.reason }), settlement: settlement ?? "unsettled" };
  });
  const attributable = new Set<string>([...views.views.map(v => dirname(v.handle.path)), ...(run.lease ? [dirname(resolve(run.lease.path))] : []),
    ...launches.flatMap(({ record }) => [record.cwd, ...record.args.filter(arg => isAbsolute(arg))]).flatMap(at => {
      const owned = temporaryRootOf(at); return owned === undefined ? [] : [owned]; })]);
  const leftovers = (await Promise.all([...attributable].map(async at => await exists(at) ? [redactPath(at, deps.env)] : []))).flat();
  const terminalNow = adapterFacts.terminalDiagnostic, outputNow = adapterFacts.structuredOutputDiagnostic;
  const { findings, turnError, contractError, integrity } = run;
  const tally = (key: "severity" | "confidence") => findings === undefined ? null
    : Object.fromEntries([...new Set(findings.map(f => f[key]))].sort().map(value => [value, findings.filter(f => f[key] === value).length]));
  const viewUnchanged = integrity.view.before === "" || integrity.view.before === integrity.view.after;
  const candidateUnchanged = integrity.candidate.before === "" || integrity.candidate.before === integrity.candidate.after;
  const primaryUnchanged = initial.digest === after?.digest && (integrity.primary.before === "" || integrity.primary.before === integrity.primary.after);
  const released = run.released as { session?: unknown; view?: { complete?: unknown }; candidate?: { complete?: unknown } };
  const cleanupComplete = leftovers.length === 0 && (containersAfter === undefined || containersAfter === containersBefore) &&
    (run.view === undefined || released.view?.complete === true) && (run.lease === undefined || released.candidate?.complete === true) &&
    (run.session === undefined || released.session === "closed");
  const contract = findings !== undefined ? `accepted:${findings.length} finding(s)` : contractError !== undefined ? "refused"
    : `notReached:${turnError?.kind ?? (run.crash ? "crashed" : run.block ? "blocked" : "none")}`;
  const sections: Record<string, unknown> = {
    preflight, acceptance, primaryRoot: redactPath(primary, deps.env),
    candidate: { application: run.facts.application ?? null, released: released.candidate ?? null },
    verification: run.facts.verification ?? null, reviewEvidence: run.facts.reviewEvidence ?? null, readback: run.facts.readback ?? null,
    review: { turn: run.facts.turn ?? null, ...(turnError ? { error: { kind: turnError.kind, safeMessage: turnError.safeMessage,
        ...(turnError.providerDiagnostic ? { providerDiagnostic: turnError.providerDiagnostic } : {}) } } : {}),
      contract, ...(contractError ? { contractError: { kind: contractError.kind, safeMessage: contractError.safeMessage } } : {}),
      findings: findings === undefined ? null : { count: findings.length, bySeverity: tally("severity"), byConfidence: tally("confidence") },
      // The reply's SHAPE (never content) and why the model process ended — only diagnostics this turn produced.
      structuredOutput: outputNow === previousOutput ? null : structureOnlyDiagnostic(outputNow),
      terminal: terminalNow === previousTerminal ? null : terminalOnlyDiagnostic(terminalNow) },
    turnBudget: authorization.turns, turnUse: { leadPlan: 0, changeAuthor: 0, freshReview: gate.used, leadAdjudication: 0 },
    refusals: { turns: gate.refusals, launches: launchRefusals },
    launches: launchEvidence, launchCounts: counts, attestedAuth: adapterFacts.attestedAuth === undefined ? null
      : { state: adapterFacts.attestedAuth.state, lane: adapterFacts.attestedAuth.lane, evidence: adapterFacts.attestedAuth.evidence },
    executableAfter: { checked: run.claimed, sha256Matches: run.claimed ? digestAfter === grant.executableSha256 : null },
    views: views.views.map(v => ({ kind: v.handle.kind, checks: v.checks, fingerprintObservations: v.fingerprints.length,
      unchanged: v.fingerprints.length >= 2 && v.fingerprints.every(value => value === v.fingerprints[0]), released: v.released ?? null })),
    integrity: { viewUnchanged, candidateUnchanged, primaryUnchanged },
    primary: { before: initial.digest, after: after?.digest ?? "unreadable", unchanged: initial.digest === after?.digest, files: initial.files,
      canariesUnchanged: JSON.stringify(initial.canaries) === JSON.stringify(after?.canaries), head: initial.head },
    cleanup: { released, attributedTemporaries: attributable.size, leftoverOwnedTemporaries: leftovers,
      ...(containersBefore === undefined ? {} : { fusionContainersBefore: containersBefore, fusionContainersAfter: containersAfter }) },
    validatedVersionsAfter: transportProfile(grant.family, inspection.transport)?.compatibility.kind === "validatedVersions"
      ? (transportProfile(grant.family, inspection.transport)!.compatibility as { versions: readonly string[] }).versions : [],
    gatesAfter: { liveGateAuthorized: REAL_WRITER_LIVE_GATE_AUTHORIZED,
      providerChangeProposal: writerGateReport().rows.find(row => row.id === "providerChangeProposal")?.state ?? "missing" },
  };
  const [outcome, detail] = classifyReviewerProbe({ claimed: run.claimed, block: run.block, crash: run.crash, turnError, contractError, findings,
    modelTurns: counts.providerTurn ?? 0, turnRefusals: gate.refusals.map(r => r.reason),
    launchRefusals: launchRefusals.map(({ outcome, reason }) => ({ outcome, reason })), viewUnchanged, candidateUnchanged, primaryUnchanged,
    launchesConfined: launchEvidence.every(l => l.refusedBeforeStart !== undefined || (!l.argsReferencePrimary && l.executableIsAuthorized &&
      (l.cwdClass === "providerView:candidate" || (l.purpose === "providerHost" && l.cwdClass === "ownedTemporary")))),
    forbiddenEnv: launchEvidence.some(l => l.refusedBeforeStart === undefined && l.forbiddenEnvKeys.length > 0),
    executableUnchanged: !run.claimed || digestAfter === grant.executableSha256, cleanupComplete, rehearsal: deps.offlineRehearsal === true });
  return finish(run.claimed ? "reviewer.evidence.json" : preflightName, outcome, detail, run.claimed ? "review" : "preflight", sections,
    counts.providerTurn ?? 0);
}

// ---------------------------------------------------------------- classification

export interface ReviewerProbeFacts {
  readonly claimed: boolean;
  /** A stop Fusion decided before or after the turn (a failed stage, a mismatch), with its outcome. */
  readonly block: Block | undefined;
  readonly crash: FusionError | undefined;
  readonly turnError: FusionError | undefined;
  readonly contractError: FusionError | undefined;
  readonly findings: readonly Finding[] | undefined;
  readonly modelTurns: number;
  readonly turnRefusals: readonly string[];
  readonly launchRefusals: readonly LaunchRefusal[];
  readonly viewUnchanged: boolean;
  readonly candidateUnchanged: boolean;
  readonly primaryUnchanged: boolean;
  readonly launchesConfined: boolean;
  readonly forbiddenEnv: boolean;
  readonly executableUnchanged: boolean;
  readonly cleanupComplete: boolean;
  readonly rehearsal: boolean;
}
/**
 * Deterministic outcome from Fusion's own observations; provider text never decides it. Integrity first (primary, view,
 * candidate), then refused launches and turns, confinement, the executable's identity, Fusion's own stops, the turn,
 * the contract and cleanup. PASS needs exactly one model turn whose reply the production review contract accepted.
 */
export function classifyReviewerProbe(facts: ReviewerProbeFacts): Block {
  if (!facts.primaryUnchanged) return ["PRIMARY_MUTATED", "the primary fixture changed"];
  if (!facts.viewUnchanged) return ["VIEW_MUTATED", "the Reviewer's candidate view changed"];
  if (!facts.candidateUnchanged) return ["VIEW_MUTATED", "the private candidate changed during the review"];
  const launch = facts.launchRefusals[0];
  if (launch !== undefined) return [launch.outcome, `a provider process was refused before it started: ${launch.reason}`];
  const turn = facts.turnRefusals[0];
  if (turn !== undefined) return ["TURN_REFUSED", `a Reviewer call was refused before it reached the provider: ${turn}`];
  if (!facts.launchesConfined) return ["POSTURE_BLOCKED", "a provider process ran outside its checked Fusion-owned location or executable"];
  if (facts.forbiddenEnv) return ["AUTH_BLOCKED", "a forbidden credential or override variable reached a provider process"];
  if (!facts.executableUnchanged) return ["VERSION_BLOCKED", "the executable's bytes changed during the probe"];
  if (facts.block !== undefined) return facts.block;
  if (facts.crash !== undefined) return [facts.crash.kind === "Cancelled" ? "CANCELLED" : facts.crash.kind === "Timeout" ? "TIMEOUT" : "PROVIDER_FAILED",
    `the probe stopped: ${facts.crash.kind}: ${facts.crash.safeMessage}`];
  if (facts.modelTurns > 1) return ["TURN_REFUSED", `more than one provider model turn was observed (${facts.modelTurns})`];
  const error = facts.turnError;
  if (error !== undefined) {
    const kind = error.kind;
    if (kind === "Cancelled") return ["CANCELLED", error.safeMessage];
    if (kind === "Timeout") return ["TIMEOUT", error.safeMessage];
    if (kind === "AuthMismatch" || kind === "BillingBlocked") return ["AUTH_BLOCKED", error.safeMessage];
    if (kind === "CapabilityUnavailable") return [/version/iu.test(error.safeMessage) ? "VERSION_BLOCKED" : "POSTURE_BLOCKED", error.safeMessage];
    if (kind === "MalformedOutput") return ["MALFORMED_OUTPUT", error.safeMessage];
    if (kind === "ProviderIdentityMismatch") return ["MODEL_BLOCKED", `identity: ${error.safeMessage}`];
    if (kind === "SecurityViolation") return ["POSTURE_BLOCKED", error.safeMessage];
    return ["PROVIDER_FAILED", `${kind}: ${error.safeMessage}`];
  }
  if (facts.contractError !== undefined) return ["CONTRACT_REFUSED", `the production review contract refused the reply: ${facts.contractError.safeMessage}`];
  if (!facts.cleanupComplete) return ["CLEANUP_FAILED", "a session, view, candidate, container or temporary directory was not removed"];
  if (!facts.claimed || facts.modelTurns !== 1 || facts.findings === undefined)
    return ["PROVIDER_FAILED", "the probe ended without exactly one accepted review turn"];
  return ["PASS", facts.rehearsal ? "offline rehearsal: a fake provider and a fake confined backend; never live evidence"
    : `one fresh review under the release under validation: contract accepted (${facts.findings.length} finding(s)), integrity and cleanup complete`];
}
