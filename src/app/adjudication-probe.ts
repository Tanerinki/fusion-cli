import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { validateChangeSet } from "../core/change/contract.js";
import type { AdjudicatedFinding, AdjudicationRequest, Finding, FusionError, ProviderAdapter, ReviewEvidence, Session } from "../core/domain.js";
import { FusionFailure } from "../core/errors.js";
import { NO_EXTRA_CAPABILITIES, resolveRole, type ResolvedRole } from "../core/policy/routing.js";
import { scopeKey } from "../core/policy/task-inspector.js";
import { structuredTurnPrompt } from "../core/review/contract.js";
import { adjudicate, evaluateFacts, validateAdjudicationReport, validateReviewReport, type ObservedState } from "../core/review/findings.js";
import { REVIEW_CYCLE_LIMIT, reviewEvidence, reviewOutcome, type ReviewOutcome } from "../core/review/policy.js";
import { validateStructuredTurnResult } from "../core/workflow/packets.js";
import type { ProviderViewHandle, VerificationVerdict, WorkspaceHandle } from "../core/workflow/types.js";
import { structureOnlyDiagnostic } from "../platform/process/structured-envelope.js";
import { terminalOnlyDiagnostic } from "../platform/process/terminal-diagnostic.js";
import type { LaunchRecord, LaunchSettlement, ProcessPurpose } from "../platform/process/supervisor.js";
import type { CandidateVerificationObservation } from "../platform/workflow/candidates.js";
import { comparablePath, ProcessGitClient } from "../platform/workspace/git.js";
import { bindingValidation, isValidatedForBinding, transportProfile } from "../runtime/provider-profiles.js";
import { parseConfig, type BindingConfig, type FusionConfig } from "./config.js";
import { fileSha256, grantDirectory } from "./executable-identity.js";
import type { ProviderRegistry } from "./providers.js";
import { bindingMismatches, claimNamespace, exists, harnessIdentity, nestedAgentSession, postureOf, primaryEvidence, RecordingViews,
  redactPath, within, type ProbeProfileSet } from "./proposal-probe.js";
import { bindingEligibility } from "./readiness.js";
import { ADJUDICATION_REVIEW_REPORT, adjudicationFindingsIdentity, REHEARSAL_PLAN, REVIEW_CANDIDATE_CHANGE, reviewCandidateIdentity,
  ROUTE_PACKET } from "./route-fixture.js";
import { createRouteFixture, grantedBinding, ROUTE_TURN_CLASSES, routeFixtureIdentity, turnIdentityGaps, type RouteRoleGrant,
  type RouteTurnClass } from "./route-probe.js";
import { composeProductionWriter, type ProductionWriterOptions, type WriterComposition } from "./writer-composition.js";
import { liveWriterAuthorization, REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport } from "./writer-gate.js";
import { fusionTemporaryBase } from "../platform/fs/temporary.js";

/**
 * O5.5B28 — the LEAD-ADJUDICATION-ONLY probe: exactly ONE real Lead adjudication turn of the production Lead binding over a
 * fixed, Fusion-authored finding set, with no Lead plan, no Change Author, no fresh Reviewer and no full route. It exists to
 * exercise the one route branch no live run has reached — the Lead adjudicating a review's findings — before any full route
 * whose review has findings. It never records or validates anything itself (a live PASS is recorded only by a later
 * milestone's independent review).
 *
 * The Lead sees exactly what production's adjudication shows it, built by the production pieces:
 *  - the pinned route fixture and the Fusion-authored candidate change (`REVIEW_CANDIDATE_CHANGE`), validated by the core
 *    and host-applied into a private candidate by the production candidate port — no provider wrote it;
 *  - Fusion's own confined verification of that candidate, run BEFORE the claim and before any provider process;
 *  - the production review evidence (`reviewEvidence`: the task, scope, architecture, Fusion's verification and the observed
 *    diff — never a Worker's, Reviewer's or Lead's rationale or transcript);
 *  - a fixed finding set (`ADJUDICATION_REVIEW_REPORT`) turned into production findings by the production review validator,
 *    with a Fusion-owned provenance (no Reviewer session produced it; provenance never reaches a prompt) and Fusion's own
 *    evaluation of each finding's facts against what Fusion observed (`evaluateFacts`);
 *  - the production adjudication request, routing (`resolveRole` with structured turns, review isolation and workspace
 *    binding), prompt and decoding schema (the adapter's own, from the core contract), the adapter's recorded adjudication
 *    envelope, the production contract (`validateAdjudicationReport`), Fusion's fact override (`adjudicate`) and the
 *    deterministic review policy (`reviewOutcome`);
 *  - a Fusion-owned CANDIDATE view the session is bound to, as the engine binds an adjudication session.
 * Its bounds: a named authorization (`pending` refuses; `open` runs once) whose budget must be exactly one adjudication; a
 * static preflight (exact binding, a release validated for it and authorized, the credential lane, the review surface, the
 * executable's location and bytes when the grant pins them); the session's own pre-claim account readback; a one-shot claim
 * right before the only model turn; a turn gate on the adapter; a pre-launch guard over every provider process (the
 * authorized executable only, the candidate view, the family's read-only controls, the exact model/effort/turn-limit flags,
 * one model process). Evidence is bounded and redacted: labels, counts and digests; never the reply, its rationale or
 * summary, the prompt, the diff or a credential. Nothing here opens any gate: `REAL_WRITER_LIVE_GATE_AUTHORIZED` stays false.
 */

export const ADJUDICATION_PROBE_EVIDENCE_SCHEMA = 1 as const;
/** The only budget a Lead-adjudication probe accepts: one adjudication, and nothing else. */
export const ADJUDICATION_ONLY_TURNS: Readonly<Record<RouteTurnClass, number>> = Object.freeze({ leadPlan: 0, changeAuthor: 0, freshReview: 0,
  leadAdjudication: 1 });
export const ADJUDICATION_PROBE_OUTCOMES = Object.freeze(["PASS", "AUTH_BLOCKED", "VERSION_BLOCKED", "MODEL_BLOCKED", "POSTURE_BLOCKED",
  "TURN_REFUSED", "PROVIDER_FAILED", "TIMEOUT", "CANCELLED", "MALFORMED_OUTPUT", "CONTRACT_REFUSED", "APPLICATION_FAILED",
  "VERIFICATION_FAILED", "VIEW_MUTATED", "PRIMARY_MUTATED", "CLEANUP_FAILED"] as const);
export type AdjudicationProbeOutcome = (typeof ADJUDICATION_PROBE_OUTCOMES)[number];
/** The provenance session of the Fusion-authored finding set: no Reviewer session produced it. Never part of a prompt. */
export const FUSION_AUTHORED_REVIEW_SESSION = "fusion-authored-review";

export interface AdjudicationProbeAuthorization {
  readonly milestone: string;
  readonly evidenceDirectory: string;
  /** `pending`: a plan refused before anything exists. `open`: runnable once. `consumed`: it ran. `retired`: never runs. */
  readonly state: "pending" | "open" | "consumed" | "retired";
  /** The Lead's grant: the route role grant facts (family, executable, releases, lanes, exact binding, turn flags). */
  readonly lead: RouteRoleGrant;
  /** Must be exactly `ADJUDICATION_ONLY_TURNS`. */
  readonly turns: Readonly<Record<RouteTurnClass, number>>;
  /** `routeFixtureIdentity()`, `reviewCandidateIdentity()` and `adjudicationFindingsIdentity()` the authorization was approved for. */
  readonly fixtureSha256: string;
  readonly candidateSha256: string;
  readonly findingsSha256: string;
}
export interface AdjudicationProbeProfileSet {
  /** The family profiles (turn controls), nested-session keys and forbidden variables of the proposal probes. */
  readonly families: ProbeProfileSet;
  readonly authorizations: Readonly<Record<string, AdjudicationProbeAuthorization>>;
}
export interface AdjudicationProbeDependencies {
  readonly env: NodeJS.ProcessEnv;
  readonly registry: ProviderRegistry;
  readonly profiles: AdjudicationProbeProfileSet;
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
export type AdjudicationProbeRefusal = Readonly<{ refused: true; reason: "unknownAuthorization" | "authorizationPending" |
  "authorizationConsumed" | "authorizationRetired" | "unknownFamily" | "budgetNotAdjudicationOnly" | "fixtureMismatch" | "candidateMismatch" |
  "findingsMismatch" | "nestedAgentSession" | "namespaceMismatch" | "alreadyAttempted"; message: string }>;
export interface AdjudicationProbeReport {
  readonly outcome: AdjudicationProbeOutcome;
  readonly detail: string;
  readonly modelTurns: number;
  readonly evidencePath: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}
interface LaunchRefusal { readonly outcome: AdjudicationProbeOutcome; readonly reason: string }
interface ObservedLaunch { readonly record: LaunchRecord; readonly phase: string; settlement?: LaunchSettlement; refused?: LaunchRefusal }
type Block = readonly [AdjudicationProbeOutcome, string];
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
  envelopeIssue?: string;
  adjudicated?: readonly AdjudicatedFinding[];
  decision?: ReviewOutcome;
  readonly facts: Record<string, unknown>;
  readonly released: Record<string, unknown>;
  readonly integrity: Record<"view" | "candidate" | "primary", { before: string; after: string }>;
}

// ---------------------------------------------------------------- the turn gate

/**
 * The Lead adapter as the probe uses it: at most `budget` adjudication turns (kind `adjudication`, cycles in order) and
 * nothing else — no packet turn (plan), no change proposal, no review. A refused call never reaches the provider.
 */
export class AdjudicationTurnGate {
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
        return async () => gate.refuse(property, `a Lead-adjudication probe runs no ${property}`);
      if (property === "runStructuredTurn") return async (...args: unknown[]) => {
        const request = args[1] as { kind?: unknown; cycle?: unknown } | null | undefined;
        if (request?.kind !== "adjudication")
          return gate.refuse(property, `a Lead-adjudication probe runs no ${String(request?.kind ?? "unknown")} turn`);
        if (gate.#used + 1 > gate.budget) return gate.refuse(property, `the leadAdjudication budget of ${gate.budget} is exhausted`);
        if (request.cycle !== gate.#used + 1) return gate.refuse(property, `leadAdjudication cycle ${String(request.cycle)} is out of order`);
        gate.#used++;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
      return (value as (...a: unknown[]) => unknown).bind(target);
    } });
  }
  private refuse(call: string, reason: string): never {
    this.refusals.push(Object.freeze({ call, reason }));
    throw new FusionFailure({ kind: "SecurityViolation", retryable: false,
      safeMessage: `The adjudication probe authorization refuses this call: ${reason}.` });
  }
}

// ---------------------------------------------------------------- the request

/** The fixed finding set exactly as production validates a Reviewer's report: `r1-F1`..., with the Fusion-owned provenance. */
export function adjudicationProbeFindings(runId: string): readonly Finding[] {
  return validateReviewReport(ADJUDICATION_REVIEW_REPORT, { cycle: 1, runId, sessionId: FUSION_AUTHORED_REVIEW_SESSION, role: "Reviewer" });
}
/**
 * Exactly the request the engine sends a Lead in review cycle 1 (`freshReview`): the review evidence, the finding set and
 * Fusion's own evaluation of each finding's facts against what Fusion observed.
 */
export function adjudicationProbeRequest(evidence: ReviewEvidence, findings: readonly Finding[], observed: ObservedState): AdjudicationRequest {
  return { kind: "adjudication", cycle: 1, evidence, findings,
    fusionFacts: findings.map(finding => ({ findingId: finding.id, ...evaluateFacts(finding, observed) })) };
}
/** The probe's Fusion configuration: the Lead binding alone and the route fixture's confined plan. */
export function adjudicationConfig(binding: BindingConfig): FusionConfig {
  return parseConfig({ schemaVersion: 1, bindings: [binding],
    verification: { commands: [], platformRequirement: "linux-compatible", confinedCommands: REHEARSAL_PLAN.commands, dependencies: "npm-lockfile" },
    limits: { runTimeoutMs: ADJUDICATION_PROBE_TIMEOUT_MS }, protection: { ignoredPaths: ["secrets.local"] } });
}
export const ADJUDICATION_PROBE_TIMEOUT_MS = 30 * 60_000;
const CLAIM = "adjudication.claim.json";
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const bounded = async <T>(work: () => Promise<T>, ms: number): Promise<T | undefined> => {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([work(), new Promise<undefined>(done => { timer = setTimeout(() => done(undefined), ms); })]); }
  catch { return undefined; }
  finally { clearTimeout(timer); }
};

// ---------------------------------------------------------------- the probe

/**
 * Runs the one authorized Lead-adjudication probe. Refuses (no fixture, claim, evidence or provider process) for an unknown,
 * pending, retired or consumed authorization, a budget other than one adjudication, a fixture, candidate or finding set
 * other than the pinned ones, inside a nested agent session, for an inconsistent namespace, or when the authorization was
 * already attempted. A block before the claim writes a preflight evidence file and consumes nothing; after the claim
 * exactly one evidence file is written.
 */
export async function runAdjudicationProbe(deps: AdjudicationProbeDependencies): Promise<AdjudicationProbeReport | AdjudicationProbeRefusal> {
  const id = deps.authorization;
  const authorization = Object.hasOwn(deps.profiles.authorizations, id) ? deps.profiles.authorizations[id] : undefined;
  if (authorization === undefined) return { refused: true, reason: "unknownAuthorization", message: "The adjudication probe authorization is not one Fusion knows." };
  if (authorization.state === "pending") return { refused: true, reason: "authorizationPending",
    message: `Adjudication probe authorization ${id} is a plan awaiting explicit human approval; it cannot run.` };
  if (authorization.state === "retired") return { refused: true, reason: "authorizationRetired",
    message: `Adjudication probe authorization ${id} was retired; a new run needs a new human authorization.` };
  if (authorization.state !== "open") return { refused: true, reason: "authorizationConsumed",
    message: `Adjudication probe authorization ${id} is consumed; a new run needs a new human authorization.` };
  const families = deps.profiles.families, grant = authorization.lead;
  if (!Object.hasOwn(families.profiles, grant.family))
    return { refused: true, reason: "unknownFamily", message: "The Lead grant names a family without a probe profile." };
  if (ROUTE_TURN_CLASSES.some(turn => authorization.turns[turn] !== ADJUDICATION_ONLY_TURNS[turn]))
    return { refused: true, reason: "budgetNotAdjudicationOnly", message: "A Lead-adjudication probe runs exactly one adjudication and no other turn." };
  if (authorization.fixtureSha256 !== routeFixtureIdentity())
    return { refused: true, reason: "fixtureMismatch", message: `The fixture is not the one authorization ${id} was approved for.` };
  if (authorization.candidateSha256 !== reviewCandidateIdentity())
    return { refused: true, reason: "candidateMismatch", message: `The candidate change is not the one authorization ${id} was approved for.` };
  if (authorization.findingsSha256 !== adjudicationFindingsIdentity())
    return { refused: true, reason: "findingsMismatch", message: `The finding set is not the one authorization ${id} was approved for.` };
  if (nestedAgentSession(deps.env, families.nestedSessionKeys))
    return { refused: true, reason: "nestedAgentSession", message: "The probe must be started from a normal terminal, not from inside an agent session's tool process tree." };
  const root = resolve(deps.evidenceRoot ?? join(fusionTemporaryBase(), authorization.evidenceDirectory));
  const inconsistent = await claimNamespace(root, id, authorization.milestone);
  if (inconsistent !== undefined) return { refused: true, reason: "namespaceMismatch", message: `${inconsistent} (${redactPath(root, deps.env)}).` };
  const claimPath = join(root, CLAIM);
  if (await exists(claimPath)) return { refused: true, reason: "alreadyAttempted",
    message: "This adjudication probe authorization was already attempted; another run needs a new human authorization." };

  const started = new Date(), clock = performance.now();
  const evidenceKind = deps.offlineRehearsal === true ? "offlineRehearsal" as const : "liveProvider" as const;
  const binding = deps.binding ?? grantedBinding("Lead", grant);
  const family = families.profiles[grant.family]!;
  const runId = `${authorization.milestone.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}-adjudication-${randomBytes(6).toString("hex")}`;
  const base = { schemaVersion: ADJUDICATION_PROBE_EVIDENCE_SCHEMA, kind: "leadAdjudicationProbe", milestone: authorization.milestone, evidenceKind,
    startedAt: started.toISOString(), runId,
    authorization: { id, milestone: authorization.milestone, turns: authorization.turns, lead: grant },
    fixture: { sha256: routeFixtureIdentity(), pinned: authorization.fixtureSha256, candidateSha256: reviewCandidateIdentity(),
      candidatePinned: authorization.candidateSha256, findingsSha256: adjudicationFindingsIdentity(), findingsPinned: authorization.findingsSha256 },
    binding: { adapter: binding.adapter, model: binding.model, effort: binding.effort, ...(binding.maxTurns === undefined ? {} : { maxTurns: binding.maxTurns }),
      options: Object.fromEntries(Object.entries(binding.options).filter(([key]) => !["executable", "binaryDirectory", "versionFile"].includes(key))) },
    harness: await harnessIdentity(deps.compiledRoot, "adjudication-probe.js"), node: process.version, platform: process.platform,
    gates: { liveGateAuthorized: REAL_WRITER_LIVE_GATE_AUTHORIZED, liveWriterAuthorization: liveWriterAuthorization().authorized } };
  const finish = async (name: string, outcome: AdjudicationProbeOutcome, detail: string, stage: "preflight" | "adjudication",
    sections: Record<string, unknown>, modelTurns: number): Promise<AdjudicationProbeReport> => {
    const evidence = { ...base, outcome, detail, stage, durationMs: Math.round(performance.now() - clock), ...sections };
    const path = join(root, name);
    await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
    return { outcome, detail, modelTurns, evidencePath: path, evidence };
  };
  const preflightName = `adjudication.preflight-${started.toISOString().replace(/[:.]/gu, "-")}.json`;

  // 1. Static preflight (no provider process): the exact binding, a release validated for it and authorized, the credential
  // lane, the structured review surface an adjudicating Lead needs, and a pinned binary's location and bytes.
  const git = await ProcessGitClient.fromPath(deps.env, true);
  const primary = await createRouteFixture(root, git);
  // The primary's full identity (every file by content, `git status`, HEAD) before anything else touches the run.
  const initial = await primaryEvidence(primary, git);
  const factory = deps.registry.factories.get(binding.adapter);
  if (factory === undefined)
    return finish(preflightName, "POSTURE_BLOCKED", "Lead: the adapter kind is not registered", "preflight", { primaryRoot: redactPath(primary, deps.env) }, 0);
  const inspection = await factory.inspect(binding, { workspace: primary, env: deps.env, sessionWorkspaces: "required" });
  const surface = bindingEligibility(binding, inspection).review;
  const transport = transportProfile(grant.family, inspection.transport);
  const expectedEnvelope = transport?.adjudicationEnvelope ?? null;
  const lane = inspection.billing.candidateLane;
  const mismatched = bindingMismatches(binding, grant);
  const missing = grant.requiredEnvironment.filter(key => typeof deps.env[key] !== "string" || deps.env[key] === "");
  const pinned = grant.executableDirectory !== undefined || grant.executableSha256 !== undefined;
  const directory = grant.executableDirectory === undefined ? undefined : grantDirectory(grant.executableDirectory, deps.env);
  const pinnedPath = directory === undefined ? undefined : join(directory, grant.executable);
  const path = inspection.executablePath;
  const locationMatches = !pinned || (path !== undefined && pinnedPath !== undefined && comparablePath(path) === comparablePath(pinnedPath) &&
    basename(path).toLowerCase() === grant.executable.toLowerCase());
  const digest = pinned && locationMatches && grant.executableSha256 !== undefined ? await fileSha256(path!).catch(() => "unreadable") : undefined;
  const bytesMatch = grant.executableSha256 === undefined || digest === grant.executableSha256;
  const scoped = bindingValidation(grant.family, inspection.transport, inspection.runtimeVersion, binding);
  const preflight = { family: grant.family, executable: inspection.executable, installedVersion: inspection.runtimeVersion,
    validatedVersions: transport?.compatibility.kind === "validatedVersions" ? transport.compatibility.versions : [],
    validatedForBinding: scoped === undefined ? null : { release: scoped.release, milestone: scoped.milestone },
    authorizedVersions: grant.runtimeVersions,
    executableIdentity: pinned ? { basename: path === undefined ? null : basename(path), locationMatches, sha256Matches: bytesMatch } : "notPinned",
    billing: { state: inspection.billing.state, reasons: inspection.billing.reasons, ...(lane ? { laneIntent: lane } : {}) },
    authorizedLanes: grant.lanes, bindingMatchesAuthorization: mismatched.length === 0, bindingMismatches: mismatched,
    requiredEnvironment: Object.fromEntries(grant.requiredEnvironment.map(key => [key, missing.includes(key) ? "missing" : "set"])),
    eligibility: { surface: "review", state: surface.state, reasons: surface.reasons }, expectedEnvelope,
    controls: inspection.controls.map(control => ({ name: control.name, state: control.state })) };
  const staticBlock: Block | undefined = mismatched.length > 0 ? ["MODEL_BLOCKED", `the binding differs from the authorization (${mismatched.join(", ")})`]
    : missing.length > 0 ? ["VERSION_BLOCKED", `the authorization requires the pinned runtime variable(s) ${missing.join(", ")}`]
    : inspection.executable !== "available" ? ["PROVIDER_FAILED", "the provider executable was not found"]
    : inspection.billing.state !== "clear" ? ["AUTH_BLOCKED", `billing guard: ${inspection.billing.reasons.join("; ") || inspection.billing.state}`]
    : lane === undefined || !grant.lanes.includes(lane) ? ["AUTH_BLOCKED", `credential lane ${lane ?? "unknown"} is not authorized (${grant.lanes.join(", ")})`]
    : !isValidatedForBinding(grant.family, inspection.transport, inspection.runtimeVersion, binding)
      ? ["VERSION_BLOCKED", `installed ${inspection.runtimeVersion} is not a validated ${inspection.transport} release`]
    : !grant.runtimeVersions.includes(inspection.runtimeVersion)
      ? ["VERSION_BLOCKED", `installed ${inspection.runtimeVersion} is not the authorized release (${grant.runtimeVersions.join(", ")})`]
    : !locationMatches ? ["VERSION_BLOCKED", "the executable is not the authorized one at its authorized location"]
    : !bytesMatch ? ["VERSION_BLOCKED", "the executable's SHA-256 differs from the authorized one"]
    : surface.state !== "eligible" ? ["POSTURE_BLOCKED", `review ${surface.state}: ${surface.reasons.join("; ")}`]
    : expectedEnvelope === null ? ["POSTURE_BLOCKED", "the transport records no adjudication envelope"]
    : undefined;
  if (staticBlock !== undefined)
    return finish(preflightName, staticBlock[0], `Lead: ${staticBlock[1]}`, "preflight", { preflight, primaryRoot: redactPath(primary, deps.env) }, 0);

  // 2. Production composition (the Lead binding alone) with the pre-launch guard over every provider process.
  const launches: ObservedLaunch[] = [];
  const observations: CandidateVerificationObservation[] = [];
  const temp = fusionTemporaryBase();
  const temporaryRootOf = (at: string): string | undefined => {
    if (!within(temp, at) || comparablePath(at) === comparablePath(temp) || within(root, at)) return undefined;
    return join(temp, relative(temp, at).split(sep)[0]!);
  };
  let phase: "preflight" | "session" | "turn" | "closed" = "preflight";
  let guardedViews: RecordingViews | undefined;
  let modelTurns = 0;
  const launchRefusal = (record: LaunchRecord): LaunchRefusal | undefined => {
    const posture = (reason: string): LaunchRefusal => ({ outcome: "POSTURE_BLOCKED", reason });
    if (phase === "preflight" || guardedViews === undefined) return posture("a provider process was started before the Lead's session");
    if (phase === "closed") return posture("a provider process was started after the adjudication turn");
    if (basename(record.executable).toLowerCase() !== grant.executable.toLowerCase())
      return posture("a provider process of an executable the authorization does not name");
    if (pinnedPath !== undefined && comparablePath(record.executable) !== comparablePath(pinnedPath))
      return { outcome: "VERSION_BLOCKED", reason: "a provider process of another executable than the authorized one" };
    const view = guardedViews.views.find(v => comparablePath(v.handle.path) === comparablePath(record.cwd) && Object.values(v.checks).every(Boolean));
    const owned = temporaryRootOf(record.cwd);
    const hostDirectory = record.purpose === "providerHost" && owned !== undefined && comparablePath(owned) === comparablePath(record.cwd) &&
      basename(owned).startsWith("fusion-");
    if (view?.handle.kind !== "candidate" && !hostDirectory) return posture("a provider process would start outside the checked candidate view");
    if (record.args.some(arg => isAbsolute(arg) && (within(primary, arg) || within(arg, primary))))
      return posture("a provider process argument names the primary");
    const forbidden = record.envKeys.filter(key => families.forbiddenEnv.test(key));
    if (forbidden.length > 0) return { outcome: "AUTH_BLOCKED", reason: `a forbidden variable would reach a provider process (${forbidden.join(", ")})` };
    if (record.purpose !== "providerTurn") return undefined;
    if (phase !== "turn") return { outcome: "TURN_REFUSED", reason: "a provider model turn outside the one authorized adjudication turn" };
    if (++modelTurns > 1) return { outcome: "TURN_REFUSED", reason: "a second provider model process" };
    if (view?.handle.kind !== "candidate") return posture("the adjudication would run outside its checked candidate view");
    const controls = postureOf(family.turnPosture, record.args);
    if (controls.missing.length > 0 || controls.widening.length > 0)
      return posture("the provider model turn lacks a read-only control or carries a widening flag");
    const identity = turnIdentityGaps(grant.turnArgs ?? [], record.args);
    if (identity.length > 0) return { outcome: "MODEL_BLOCKED", reason: `the adjudication model process does not carry exactly the authorized ${identity.join(", ")}` };
    return undefined;
  };
  const containersBefore = await deps.fusionContainers?.();
  const compose = deps.compose ?? composeProductionWriter;
  const composition = await compose({ root: primary, config: adjudicationConfig(binding), registry: deps.registry, env: deps.env,
    ...(deps.signal ? { signal: deps.signal } : {}),
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
    : composition.unavailable.length > 0 || composition.roles.length !== 1 || composition.roles[0]!.binding.role !== "Lead"
      ? ["POSTURE_BLOCKED", `the composition did not yield exactly the Lead (${composition.unavailable.map(u => u.reason).join("; ")})`]
    : composition.roles[0]!.binding.transport !== grant.binding.adapter
      ? ["POSTURE_BLOCKED", "the Lead is served by another adapter than its authorized one"]
    : undefined;
  if (composedBlock !== undefined)
    return finish(preflightName, composedBlock[0], composedBlock[1], "preflight", { preflight, acceptance, primaryRoot: redactPath(primary, deps.env) }, 0);
  // The production adjudicator routing (the engine's own needs), so a Lead the engine would refuse never runs here.
  let lead: ResolvedRole;
  try {
    lead = await resolveRole("Lead", composition.roles, NO_EXTRA_CAPABILITIES, { structuredTurns: true, reviewIsolation: true, workspaceBinding: true });
  } catch (error) {
    return finish(preflightName, "POSTURE_BLOCKED", `adjudicator routing refused the Lead: ${error instanceof FusionFailure ? error.error.safeMessage : "unknown"}`,
      "preflight", { preflight, acceptance, primaryRoot: redactPath(primary, deps.env) }, 0);
  }

  // 3.–5. Candidate, verification, request, view and session (all before the claim), then the one adjudication turn.
  const port = composition.workspace, plan = composition.plan;
  const gate = new AdjudicationTurnGate(authorization.turns.leadAdjudication);
  const adapter = gate.wrap(lead.adapter);
  const views = new RecordingViews(composition.views, primary);
  const errorOf = (error: unknown): FusionError => error instanceof FusionFailure ? error.error
    : { kind: "InternalError", retryable: false, safeMessage: "The adjudication probe stopped unexpectedly." };
  const adapterFacts = lead.adapter as { terminalDiagnostic?: unknown; structuredOutputDiagnostic?: unknown;
    runtimeEvidence?: Record<string, unknown>; initReadback?: Record<string, unknown> };
  const previousTerminal = adapterFacts.terminalDiagnostic, previousOutput = adapterFacts.structuredOutputDiagnostic;
  const run: RunState = { claimed: false, facts: {}, released: {},
    integrity: { view: { before: "", after: "" }, candidate: { before: "", after: "" }, primary: { before: "", after: "" } } };
  const body = async (): Promise<Block | undefined> => {
    const scope = { allowedPaths: ROUTE_PACKET.scope.allowedFiles, forbiddenPaths: ROUTE_PACKET.scope.forbiddenFiles };
    const lease = await port.acquire(`${runId}.adjudication`, deps.signal);
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
    // Exactly production's review evidence (the engine hands the Lead the same evidence the Reviewer saw).
    const evidence = reviewEvidence(ROUTE_PACKET, { required: true, passed: true, commands: plan.commands.map(command => ({ id: command.id, passed: true })) },
      { kind: "diff", changedPaths, text: diff.text, truncated: diff.truncated });
    // What Fusion itself observed (the engine's `observedState` of a verified Writer attempt: it claims no checks of its own).
    const forbidden = new Set(ROUTE_PACKET.scope.forbiddenFiles.map(scopeKey));
    const observed: ObservedState = { verification: new Map(plan.commands.map(command => [command.id, true])), changedPaths,
      allowedScope: ROUTE_PACKET.scope.allowedFiles.filter(at => !forbidden.has(scopeKey(at))), claimedTests: [] };
    const findings = adjudicationProbeFindings(runId);
    const request = adjudicationProbeRequest(evidence, findings, observed);
    run.facts.request = { kind: request.kind, cycle: request.cycle,
      findings: findings.map(f => ({ id: f.id, severity: f.severity, confidence: f.confidence, category: f.category, factKinds: f.facts.map(fact => fact.kind) })),
      fusionFacts: request.fusionFacts.map(f => ({ findingId: f.findingId, supported: f.supported.length, contradicted: f.contradicted.length })),
      evidence: { changedPaths: evidence.change.changedPaths, changeBytes: Buffer.byteLength(evidence.change.text, "utf8"),
        changeTruncated: evidence.change.truncated, verification: evidence.verification },
      // The provider-neutral contract prompt's digest (never its text): the adapter renders the request from the core contract.
      contractPromptSha256: sha256(structuredTurnPrompt(request)) };

    phase = "session";
    guardedViews = views;
    const view = await views.open(`${runId}.views`, { kind: "candidate", candidate: lease }, deps.signal);
    run.view = view;
    const candidateRoot = dirname(resolve(lease.path));
    if (view.kind !== "candidate" || !Object.values(views.views.at(-1)!.checks).every(Boolean) ||
        within(candidateRoot, view.path) || within(view.path, candidateRoot))
      return ["POSTURE_BLOCKED", "the candidate view is not a checked Fusion-owned view disjoint from the candidate"];
    run.integrity.view.before = await views.fingerprint(view, deps.signal);
    // The session opens in the view; the adapter's own account readback there must confirm an authorized lane (pre-claim).
    let session: Session;
    try {
      session = await adapter.createSession({ runId, role: "Lead", workspaceLeaseId: lease.leaseId, posture: lead.posture,
        model: lead.binding.model, workspace: Object.freeze({ id: view.viewId, root: view.path }) });
    } catch (error) {
      const failure = errorOf(error);
      return [failure.kind === "AuthMismatch" || failure.kind === "BillingBlocked" ? "AUTH_BLOCKED" : "POSTURE_BLOCKED",
        `the Lead session did not open: ${failure.kind}: ${failure.safeMessage}`];
    }
    run.session = session;
    if (session === null || typeof session !== "object" || session.role !== "Lead" || session.posture !== lead.posture ||
        session.workspaceLeaseId !== lease.leaseId || session.runId !== runId || session.provider !== lead.binding.provider ||
        typeof session.id !== "string" || session.workspaceRoot !== view.path)
      return ["POSTURE_BLOCKED", "the provider session does not match the requested role, posture or workspace"];

    // The one-shot claim: from here on the authorization is consumed, whatever happens.
    run.integrity.primary.before = await port.fingerprint(undefined, deps.signal);
    run.integrity.candidate.before = await port.fingerprint(lease, deps.signal);
    await writeFile(claimPath, `${JSON.stringify({ authorization: id, milestone: authorization.milestone, adjudicationOnly: true,
      turns: authorization.turns, claimedAt: new Date().toISOString(), evidenceKind })}\n`, { flag: "wx" });
    run.claimed = true;
    phase = "turn";
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
    const models = [grant.binding.model, grant.binding.options?.canonicalModel].filter((m): m is string => typeof m === "string");
    run.facts.turn = { status: turn.status, provider: turn.effectiveProvider || null,
      observedModel: turn.status === "completed" ? turn.effectiveModel || null : null,
      requestedModel: lead.binding.model.id, effort: lead.binding.model.effort, maxTurns: lead.binding.model.maxTurns ?? null,
      transport: lead.binding.transport };
    if (turn.status !== "completed") {
      // A failed turn may not have observed any identity; a reported one must still be the bound provider (as the engine checks).
      if (turn.effectiveProvider !== "" && turn.effectiveProvider !== lead.binding.provider)
        return ["MODEL_BLOCKED", "the failed adjudication was reported by another provider than the bound one"];
      run.turnError = turn.error;
      return undefined;
    }
    if (turn.effectiveProvider !== lead.binding.provider) return ["MODEL_BLOCKED", "the adjudication was served by another provider than the bound one"];
    if (!models.includes(turn.effectiveModel)) return ["MODEL_BLOCKED", "the adjudication's model readback is not the authorized model"];
    // The reply was read under the transport's recorded adjudication envelope (the shape diagnostic of THIS turn says so).
    const output = adapterFacts.structuredOutputDiagnostic as { accepted?: unknown; policy?: unknown } | undefined;
    if (output === previousOutput || output?.accepted !== true || output.policy !== expectedEnvelope)
      run.envelopeIssue = "the reply was not reported as accepted under the transport's recorded adjudication envelope";
    try {
      const report = validateAdjudicationReport(turn.output, findings);
      // Fusion's facts override the Lead where they hold; the deterministic policy decides (cycle 1 of the route's two).
      run.adjudicated = adjudicate(findings, report, new Map(request.fusionFacts.map(f => [f.findingId, f.supported])));
      run.decision = reviewOutcome(run.adjudicated, request.cycle < REVIEW_CYCLE_LIMIT);
    } catch (error) { run.contractError = errorOf(error); }
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
    // Cleanup, always: the session, the view, the candidate — each within a bound.
    if (session !== undefined) run.released.session = await bounded(async () => { await lead.adapter.close(session); return "closed"; }, 30_000) ?? "unconfirmed";
    if (view !== undefined) run.released.view = await bounded(() => views.release(view), 60_000) ?? { complete: false, reason: "timeout" };
    if (lease !== undefined) run.released.candidate = await bounded(() => port.release(lease), 90_000) ?? { complete: false, reason: "timeout" };
  }
  const settleBy = Date.now() + 30_000;
  while (launches.some(entry => entry.settlement === undefined) && Date.now() < settleBy) await new Promise(done => setTimeout(done, 25));
  const after = await primaryEvidence(primary, git).catch(() => undefined);
  const containersAfter = await deps.fusionContainers?.();
  const digestAfter = run.claimed && pinnedPath !== undefined && grant.executableSha256 !== undefined
    ? await fileSha256(pinnedPath).catch(() => "unreadable") : undefined;

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
      executableIsAuthorized: basename(record.executable).toLowerCase() === grant.executable.toLowerCase() &&
        (pinnedPath === undefined || comparablePath(record.executable) === comparablePath(pinnedPath)),
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
  const { adjudicated, decision, turnError, contractError, integrity } = run;
  const tally = (key: "verdict" | "requiredAction") => adjudicated === undefined ? null
    : Object.fromEntries([...new Set(adjudicated.map(a => a[key]))].sort().map(value => [value, adjudicated.filter(a => a[key] === value).length]));
  const viewUnchanged = integrity.view.before === "" || integrity.view.before === integrity.view.after;
  const candidateUnchanged = integrity.candidate.before === "" || integrity.candidate.before === integrity.candidate.after;
  const primaryUnchanged = initial.digest === after?.digest && (integrity.primary.before === "" || integrity.primary.before === integrity.primary.after);
  const released = run.released as { session?: unknown; view?: { complete?: unknown }; candidate?: { complete?: unknown } };
  const cleanupComplete = leftovers.length === 0 && (containersAfter === undefined || containersAfter === containersBefore) &&
    (run.view === undefined || released.view?.complete === true) && (run.lease === undefined || released.candidate?.complete === true) &&
    (run.session === undefined || released.session === "closed");
  const contract = adjudicated !== undefined ? `accepted:${adjudicated.length} verdict(s)` : contractError !== undefined ? "refused"
    : `notReached:${turnError?.kind ?? (run.crash ? "crashed" : run.block ? "blocked" : "none")}`;
  const runtime = adapterFacts.runtimeEvidence ?? adapterFacts.initReadback;
  const sections: Record<string, unknown> = {
    preflight, acceptance, primaryRoot: redactPath(primary, deps.env),
    candidate: { application: run.facts.application ?? null, released: released.candidate ?? null },
    verification: run.facts.verification ?? null, request: run.facts.request ?? null,
    adjudication: { turn: run.facts.turn ?? null, ...(turnError ? { error: { kind: turnError.kind, safeMessage: turnError.safeMessage,
        ...(turnError.providerDiagnostic ? { providerDiagnostic: turnError.providerDiagnostic } : {}) } } : {}),
      contract, ...(contractError ? { contractError: { kind: contractError.kind, safeMessage: contractError.safeMessage } } : {}),
      // Per finding: Fusion's finding id and severity, and the enum labels the contract accepted (never the rationale or summary).
      verdicts: adjudicated === undefined ? null : adjudicated.map(a => ({ findingId: a.finding.id, severity: a.finding.severity, verdict: a.verdict,
        requiredAction: a.requiredAction, verdictSource: a.verdictSource, supportedFacts: a.supportedFacts.length })),
      byVerdict: tally("verdict"), byRequiredAction: tally("requiredAction"),
      // The deterministic review policy's decision for cycle 1 (a corrective attempt still available, as in the route).
      decision: decision === undefined ? null : { kind: decision.kind, ...(decision.kind === "gate" ? { state: decision.state } : {}),
        ...(decision.kind === "correction" ? { findings: decision.findings.map(f => f.id) } : {}) },
      ...(run.envelopeIssue ? { envelopeIssue: run.envelopeIssue } : {}),
      // The reply's SHAPE (never content) and why the model process ended — only diagnostics this turn produced.
      structuredOutput: outputNow === previousOutput ? null : structureOnlyDiagnostic(outputNow),
      terminal: terminalNow === previousTerminal ? null : terminalOnlyDiagnostic(terminalNow) },
    readback: runtime === undefined ? null : { source: adapterFacts.runtimeEvidence === undefined ? "initOfFailedTurn" : "completedTurn",
      runtimeVersion: runtime.runtimeVersion, requestedModel: runtime.requestedModel, effectiveModel: runtime.effectiveModel,
      apiKeySource: runtime.apiKeySource, permissionMode: runtime.permissionMode, tools: runtime.tools,
      mcpServers: Array.isArray(runtime.mcpServers) ? runtime.mcpServers.length : null, auth: runtime.auth },
    turnBudget: authorization.turns, turnUse: { leadPlan: 0, changeAuthor: 0, freshReview: 0, leadAdjudication: gate.used },
    refusals: { turns: gate.refusals, launches: launchRefusals },
    launches: launchEvidence, launchCounts: counts,
    executableAfter: { checked: digestAfter !== undefined, sha256Matches: digestAfter === undefined ? null : digestAfter === grant.executableSha256 },
    views: views.views.map(v => ({ kind: v.handle.kind, checks: v.checks, fingerprintObservations: v.fingerprints.length,
      unchanged: v.fingerprints.length >= 2 && v.fingerprints.every(value => value === v.fingerprints[0]), released: v.released ?? null })),
    integrity: { viewUnchanged, candidateUnchanged, primaryUnchanged },
    primary: { before: initial.digest, after: after?.digest ?? "unreadable", unchanged: initial.digest === after?.digest, files: initial.files,
      canariesUnchanged: JSON.stringify(initial.canaries) === JSON.stringify(after?.canaries), head: initial.head },
    cleanup: { released, attributedTemporaries: attributable.size, leftoverOwnedTemporaries: leftovers,
      ...(containersBefore === undefined ? {} : { fusionContainersBefore: containersBefore, fusionContainersAfter: containersAfter }) },
    gatesAfter: { liveGateAuthorized: REAL_WRITER_LIVE_GATE_AUTHORIZED,
      reviewAndAdjudication: writerGateReport().rows.find(row => row.id === "reviewAndAdjudication")?.state ?? "missing" },
  };
  const [outcome, detail] = classifyAdjudicationProbe({ claimed: run.claimed, block: run.block, crash: run.crash, turnError, contractError,
    envelopeIssue: run.envelopeIssue, adjudicated, decision, modelTurns: counts.providerTurn ?? 0, turnRefusals: gate.refusals.map(r => r.reason),
    launchRefusals: launchRefusals.map(({ outcome, reason }) => ({ outcome, reason })), viewUnchanged, candidateUnchanged, primaryUnchanged,
    launchesConfined: launchEvidence.every(l => l.refusedBeforeStart !== undefined || (!l.argsReferencePrimary && l.executableIsAuthorized &&
      (l.cwdClass === "providerView:candidate" || (l.purpose === "providerHost" && l.cwdClass === "ownedTemporary")))),
    forbiddenEnv: launchEvidence.some(l => l.refusedBeforeStart === undefined && l.forbiddenEnvKeys.length > 0),
    executableUnchanged: digestAfter === undefined || digestAfter === grant.executableSha256, cleanupComplete, rehearsal: deps.offlineRehearsal === true });
  return finish(run.claimed ? "adjudication.evidence.json" : preflightName, outcome, detail, run.claimed ? "adjudication" : "preflight", sections,
    counts.providerTurn ?? 0);
}

// ---------------------------------------------------------------- classification

export interface AdjudicationProbeFacts {
  readonly claimed: boolean;
  /** A stop Fusion decided before or after the turn (a failed stage, a mismatch), with its outcome. */
  readonly block: Block | undefined;
  readonly crash: FusionError | undefined;
  readonly turnError: FusionError | undefined;
  readonly contractError: FusionError | undefined;
  /** Why the reply's acceptance under the recorded adjudication envelope is not confirmed, if it is not. */
  readonly envelopeIssue: string | undefined;
  readonly adjudicated: readonly AdjudicatedFinding[] | undefined;
  readonly decision: ReviewOutcome | undefined;
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
 * candidate), then refused launches and turns, confinement, the executable's identity, Fusion's own stops, the turn, the
 * envelope, the contract and cleanup. PASS needs exactly one model turn whose reply the recorded adjudication envelope and
 * the production adjudication contract accepted, and a decision of the production review policy.
 */
export function classifyAdjudicationProbe(facts: AdjudicationProbeFacts): Block {
  if (!facts.primaryUnchanged) return ["PRIMARY_MUTATED", "the primary fixture changed"];
  if (!facts.viewUnchanged) return ["VIEW_MUTATED", "the Lead's candidate view changed"];
  if (!facts.candidateUnchanged) return ["VIEW_MUTATED", "the private candidate changed during the adjudication"];
  const launch = facts.launchRefusals[0];
  if (launch !== undefined) return [launch.outcome, `a provider process was refused before it started: ${launch.reason}`];
  const turn = facts.turnRefusals[0];
  if (turn !== undefined) return ["TURN_REFUSED", `a Lead call was refused before it reached the provider: ${turn}`];
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
  if (facts.envelopeIssue !== undefined) return ["MALFORMED_OUTPUT", facts.envelopeIssue];
  if (facts.contractError !== undefined)
    return ["CONTRACT_REFUSED", `the production adjudication contract refused the reply: ${facts.contractError.safeMessage}`];
  if (!facts.cleanupComplete) return ["CLEANUP_FAILED", "a session, view, candidate, container or temporary directory was not removed"];
  if (!facts.claimed || facts.modelTurns !== 1 || facts.adjudicated === undefined || facts.decision === undefined)
    return ["PROVIDER_FAILED", "the probe ended without exactly one accepted adjudication turn"];
  return ["PASS", facts.rehearsal ? "offline rehearsal: a fake provider and a fake confined backend; never live evidence"
    : `one Lead adjudication: envelope and contract accepted (${facts.adjudicated.length} verdict(s)), decision ${facts.decision.kind}, integrity and cleanup complete`];
}
