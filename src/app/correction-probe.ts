import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { validateChangeSet, writerChangeScope } from "../core/change/contract.js";
import type { AdjudicatedFinding, ChangeSet, DelegationPacket, Finding, FusionError, ProviderAdapter, ReviewRequest, Session } from "../core/domain.js";
import { FusionFailure } from "../core/errors.js";
import { NO_EXTRA_CAPABILITIES, resolveRole, type ResolvedRole } from "../core/policy/routing.js";
import { scopeKey, unexpectedScopeSignals } from "../core/policy/task-inspector.js";
import { structuredTurnPrompt } from "../core/review/contract.js";
import { adjudicate, evaluateFacts, REVIEW_LIMITS, validateAdjudicationReport, validateReviewReport, type ObservedState } from "../core/review/findings.js";
import { isOutstanding, REVIEW_CYCLE_LIMIT, reviewEvidence, reviewOutcome, type ReviewOutcome } from "../core/review/policy.js";
import { WORKFLOW_LIMITS } from "../core/workflow/engine.js";
import { delegatePacket, validateStructuredTurnResult } from "../core/workflow/packets.js";
import type { ProviderViewHandle, VerificationVerdict, WorkspaceHandle } from "../core/workflow/types.js";
import { structureOnlyDiagnostic } from "../platform/process/structured-envelope.js";
import { terminalOnlyDiagnostic } from "../platform/process/terminal-diagnostic.js";
import type { LaunchRecord, LaunchSettlement, ProcessPurpose } from "../platform/process/supervisor.js";
import type { CandidateVerificationObservation } from "../platform/workflow/candidates.js";
import { comparablePath, ProcessGitClient } from "../platform/workspace/git.js";
import { bindingValidation, isValidatedForBinding, transportProfile } from "../runtime/provider-profiles.js";
import { FUSION_AUTHORED_REVIEW_SESSION } from "./adjudication-probe.js";
import { parseConfig, type BindingConfig, type FusionConfig } from "./config.js";
import { fileSha256, grantDirectory } from "./executable-identity.js";
import type { ProviderRegistry } from "./providers.js";
import { bindingMismatches, claimNamespace, exists, harnessIdentity, nestedAgentSession, postureOf, primaryEvidence, RecordingViews,
  redactPath, within, type ProbeProfileSet } from "./proposal-probe.js";
import { bindingEligibility } from "./readiness.js";
import { ADJUDICATION_REVIEW_REPORT, adjudicationFindingsIdentity, CORRECTION_ADJUDICATION_REPORT, correctionAdjudicationIdentity,
  REHEARSAL_PLAN, REVIEW_CANDIDATE_CHANGE, reviewCandidateIdentity, ROUTE_PACKET } from "./route-fixture.js";
import { createRouteFixture, grantedBinding, ROUTE_TURN_CLASSES, routeFixtureIdentity, turnIdentityGaps, type RouteRoleGrant,
  type RouteTurnClass } from "./route-probe.js";
import { composeProductionWriter, type ProductionWriterOptions, type WriterComposition } from "./writer-composition.js";
import { liveWriterAuthorization, REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport } from "./writer-gate.js";

/**
 * O5.5B30 — the REVIEW-DRIVEN CORRECTION BRANCH probe: the one Writer branch no live run has reached, entered exactly at
 * the post-adjudication boundary. Before the boundary everything is Fusion-owned and deterministic; after it, exactly two
 * real model turns may run:
 *
 *   [Fusion-owned] starting candidate (`REVIEW_CANDIDATE_CHANGE`) host-applied and confined-verified (attempt 1)
 *   [Fusion-owned] review cycle 1 = the fixed finding set (`ADJUDICATION_REVIEW_REPORT`, production-validated)
 *   [Fusion-owned] adjudication cycle 1 = the O5.5B29 live verdict LABELS (`CORRECTION_ADJUDICATION_REPORT`), production
 *                  contract, Fusion's fact override and the deterministic policy: decision `correction`
 *   ── boundary: the engine's `retrying:reviewFindingsConfirmed` ──
 *   [model turn 1] the corrective Change Author: a fresh session in the baseline view; the production correction packet
 *                  (`delegatePacket` with the engine's retry context: attempt 2 of 2, a fresh candidate, the confirmed
 *                  outstanding findings as bounded constraints) and Fusion's baseline hashes; the production ChangeSet
 *   [Fusion]       ChangeSet validation, host application into a FRESH private candidate (attempt 2), the scope check
 *   [Fusion]       confined verification — a failure ends the branch: no re-review (attempts are exhausted)
 *   [model turn 2] fresh re-review, cycle 2: a NEW Reviewer session in a NEW view of the corrected candidate; production
 *                  review evidence of that candidate (never a rationale or transcript) and the outstanding cycle-1 findings
 *   [Fusion]       a clean re-review completes the branch (policy decision `clean`); findings stop it before the cycle-2
 *                  adjudication, which this probe never runs (`REREVIEW_FINDINGS`)
 *
 * Every step after the boundary is the engine's own step for attempt 2, built from the production functions the engine
 * uses (packets, contracts, policy, candidate and view ports, routing). The pre-boundary state carries no provider text:
 * the rationales of the adjudication are Fusion-authored placeholders and, as in production, reach no prompt.
 * Bounds: a named authorization (budget exactly one correction and one re-review), pinned fixture, candidate, finding set
 * and adjudication; per-role static preflight; one claim before the first model turn; a turn gate (the re-review only
 * after verification passed); a pre-launch guard over every process; bounded, redacted evidence. Opens no gate.
 */

export const CORRECTION_PROBE_EVIDENCE_SCHEMA = 1 as const;
/** The only budget a correction probe accepts: one corrective Change Author turn and one fresh re-review. */
export const CORRECTION_ONLY_TURNS: Readonly<Record<RouteTurnClass, number>> = Object.freeze({ leadPlan: 0, changeAuthor: 1, freshReview: 1,
  leadAdjudication: 0 });
export const CORRECTION_PROBE_OUTCOMES = Object.freeze(["PASS", "AUTH_BLOCKED", "VERSION_BLOCKED", "MODEL_BLOCKED", "POSTURE_BLOCKED",
  "TURN_REFUSED", "PROVIDER_FAILED", "TIMEOUT", "CANCELLED", "MALFORMED_OUTPUT", "INVALID_CHANGESET", "APPLICATION_FAILED", "DECISION_REQUIRED",
  "VERIFICATION_FAILED", "CONTRACT_REFUSED", "REREVIEW_FINDINGS", "VIEW_MUTATED", "PRIMARY_MUTATED", "CLEANUP_FAILED"] as const);
export type CorrectionProbeOutcome = (typeof CORRECTION_PROBE_OUTCOMES)[number];
export const CORRECTION_ROLES = Object.freeze(["Worker", "Reviewer"] as const);
export type CorrectionRole = (typeof CORRECTION_ROLES)[number];

export interface CorrectionProbeAuthorization {
  readonly milestone: string;
  readonly evidenceDirectory: string;
  /** `pending`: a plan refused before anything exists. `open`: runnable once. `consumed`: it ran. `retired`: never runs. */
  readonly state: "pending" | "open" | "consumed" | "retired";
  /** The corrective Change Author (Worker) and the fresh Reviewer: route role grants (a pinned binary when the grant pins it). */
  readonly roles: Readonly<Record<CorrectionRole, RouteRoleGrant>>;
  /** Must be exactly `CORRECTION_ONLY_TURNS`. */
  readonly turns: Readonly<Record<RouteTurnClass, number>>;
  /** The identities the authorization was approved for: fixture, starting candidate, finding set, adjudication. */
  readonly fixtureSha256: string;
  readonly candidateSha256: string;
  readonly findingsSha256: string;
  readonly adjudicationSha256: string;
}
export interface CorrectionProbeProfileSet {
  readonly families: ProbeProfileSet;
  readonly authorizations: Readonly<Record<string, CorrectionProbeAuthorization>>;
}
export interface CorrectionProbeDependencies {
  readonly env: NodeJS.ProcessEnv;
  readonly registry: ProviderRegistry;
  readonly profiles: CorrectionProbeProfileSet;
  readonly authorization: string;
  /** TEST SEAM: where the claim, the evidence and the fixture live; the authorization's namespace under %TEMP% by default. */
  readonly evidenceRoot?: string;
  /** TEST SEAM: bindings other than the granted ones (fake installs). The live entry never passes any. */
  readonly bindings?: Partial<Record<CorrectionRole, BindingConfig>>;
  readonly compiledRoot?: string;
  /** TEST SEAM: the composition (default `composeProductionWriter`). */
  readonly compose?: (options: ProductionWriterOptions) => Promise<WriterComposition>;
  /** TEST SEAM: fake providers and a fake confined backend; the evidence is `offlineRehearsal`, never live evidence. */
  readonly offlineRehearsal?: boolean;
  readonly fusionContainers?: () => Promise<number>;
  readonly signal?: AbortSignal;
}
export type CorrectionProbeRefusal = Readonly<{ refused: true; reason: "unknownAuthorization" | "authorizationPending" | "authorizationConsumed" |
  "authorizationRetired" | "unknownFamily" | "budgetNotCorrectionOnly" | "fixtureMismatch" | "candidateMismatch" | "findingsMismatch" |
  "adjudicationMismatch" | "nestedAgentSession" | "namespaceMismatch" | "alreadyAttempted"; message: string }>;
export interface CorrectionProbeReport {
  readonly outcome: CorrectionProbeOutcome;
  readonly detail: string;
  readonly modelTurns: number;
  readonly evidencePath: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}
interface LaunchRefusal { readonly outcome: CorrectionProbeOutcome; readonly reason: string }
type Phase = "preflight" | "boundary" | "authorSession" | "authorTurn" | "fusion" | "rereview" | "closed";
interface ObservedLaunch { readonly record: LaunchRecord; readonly phase: Phase; readonly role: CorrectionRole | null; settlement?: LaunchSettlement;
  refused?: LaunchRefusal }
type Block = readonly [CorrectionProbeOutcome, string];

// ---------------------------------------------------------------- the boundary (pure)

/** What the engine holds at `retrying:reviewFindingsConfirmed` after review cycle 1, rebuilt from the production functions. */
export interface CorrectionBoundary {
  /** Review cycle 1: the fixed finding set as the production validator returns it. */
  readonly findings: readonly Finding[];
  /** Adjudication cycle 1: the recorded labels through the production contract and Fusion's fact override. */
  readonly adjudicated: readonly AdjudicatedFinding[];
  /** The policy's decision for cycle 1 (a corrective attempt available): must be `correction`. */
  readonly decision: ReviewOutcome;
  /** The engine's retry context for the corrective attempt, and the packet it builds from it. */
  readonly retry: NonNullable<Parameters<typeof delegatePacket>[2]>;
  readonly packet: DelegationPacket;
  /** What the cycle-2 re-review is told was accepted before (the outstanding cycle-1 findings). */
  readonly priorFindings: readonly Finding[];
}
/**
 * The post-adjudication boundary exactly as the engine reaches it for this route (a MEDIUM Writer: two attempts, two review
 * cycles), from Fusion's observations of the starting candidate. No Lead plan exists at this entry point, so the packet
 * carries no plan line; every other packet field is `delegatePacket`'s own.
 */
export function correctionBoundary(runId: string, observed: ObservedState): CorrectionBoundary {
  const findings = validateReviewReport(ADJUDICATION_REVIEW_REPORT, { cycle: 1, runId, sessionId: FUSION_AUTHORED_REVIEW_SESSION, role: "Reviewer" });
  const facts = new Map(findings.map(finding => [finding.id, evaluateFacts(finding, observed)]));
  const adjudicated = adjudicate(findings, validateAdjudicationReport(CORRECTION_ADJUDICATION_REPORT, findings),
    new Map([...facts].map(([id, evaluation]) => [id, evaluation.supported])));
  const limit = 1 + WORKFLOW_LIMITS.delegateRetries, attempt = 1, cycle = 1;
  const decision = reviewOutcome(adjudicated, attempt < limit && cycle < REVIEW_CYCLE_LIMIT);
  const corrections = decision.kind === "correction" ? decision.findings : [];
  const retry = { attempt: attempt + 1, limit, freshCandidate: true, reason: `Fusion review confirmed ${corrections.length} finding(s) to fix.`,
    findings: corrections };
  return { findings, adjudicated, decision, retry, packet: delegatePacket(ROUTE_PACKET, {}, retry),
    priorFindings: adjudicated.filter(isOutstanding).map(entry => entry.finding) };
}
/** The probe's Fusion configuration: the Change Author and the Reviewer bindings and the route fixture's confined plan. */
export function correctionConfig(bindings: Readonly<Record<CorrectionRole, BindingConfig>>): FusionConfig {
  return parseConfig({ schemaVersion: 1, bindings: CORRECTION_ROLES.map(role => bindings[role]),
    verification: { commands: [], platformRequirement: "linux-compatible", confinedCommands: REHEARSAL_PLAN.commands, dependencies: "npm-lockfile" },
    limits: { runTimeoutMs: CORRECTION_PROBE_TIMEOUT_MS }, protection: { ignoredPaths: ["secrets.local"] } });
}
export const CORRECTION_PROBE_TIMEOUT_MS = 40 * 60_000;

// ---------------------------------------------------------------- the turn gate

/**
 * The two adapters as the probe uses them: the Change Author runs at most one change proposal and nothing else; the
 * Reviewer runs at most one review, cycle 2, and only after Fusion's verification of the corrected candidate passed.
 * No plan, adjudication or other turn reaches either provider.
 */
export class CorrectionTurnGate {
  readonly refusals: Array<Readonly<{ role: CorrectionRole; call: string; reason: string }>> = [];
  readonly used: Record<"changeAuthor" | "freshReview", number> = { changeAuthor: 0, freshReview: 0 };
  /** Set by the probe only after the corrected candidate's confined verification passed. */
  verified = false;
  constructor(private readonly turns: Readonly<Record<RouteTurnClass, number>>) {}
  wrap(role: CorrectionRole, adapter: ProviderAdapter): ProviderAdapter {
    const gate = this;
    return new Proxy(adapter, { get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property !== "runTurn" && property !== "runChangeProposalTurn" && property !== "runStructuredTurn")
        return (value as (...a: unknown[]) => unknown).bind(target);
      return async (...args: unknown[]) => {
        const request = args[1] as { kind?: unknown; cycle?: unknown } | null | undefined;
        if (role === "Worker") {
          if (property !== "runChangeProposalTurn") return gate.refuse(role, property, `the corrective Change Author runs no ${property}`);
          if (gate.used.changeAuthor + 1 > gate.turns.changeAuthor)
            return gate.refuse(role, property, `the changeAuthor budget of ${gate.turns.changeAuthor} is exhausted`);
          gate.used.changeAuthor++;
        } else {
          if (property !== "runStructuredTurn" || request?.kind !== "review")
            return gate.refuse(role, property, `the Reviewer runs no ${property === "runStructuredTurn" ? String(request?.kind ?? "unknown") : property} turn here`);
          if (request.cycle !== 2) return gate.refuse(role, property, `review cycle ${String(request.cycle)} is not the re-review (cycle 2)`);
          if (!gate.verified) return gate.refuse(role, property, "the re-review may start only after the corrected candidate's verification passed");
          if (gate.used.freshReview + 1 > gate.turns.freshReview)
            return gate.refuse(role, property, `the freshReview budget of ${gate.turns.freshReview} is exhausted`);
          gate.used.freshReview++;
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    } });
  }
  private refuse(role: CorrectionRole, call: string, reason: string): never {
    this.refusals.push(Object.freeze({ role, call, reason }));
    throw new FusionFailure({ kind: "SecurityViolation", retryable: false, safeMessage: `The correction probe authorization refuses this call: ${reason}.` });
  }
}

// ---------------------------------------------------------------- the probe

const CLAIM = "correction.claim.json";
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const bounded = async <T>(work: () => Promise<T>, ms: number): Promise<T | undefined> => {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([work(), new Promise<undefined>(done => { timer = setTimeout(() => done(undefined), ms); })]); }
  catch { return undefined; }
  finally { clearTimeout(timer); }
};
const SURFACE: Readonly<Record<CorrectionRole, "changeProposal" | "review">> = Object.freeze({ Worker: "changeProposal", Reviewer: "review" });

/**
 * Runs the one authorized correction probe. Refuses (no fixture, claim, evidence or provider process) for an unknown,
 * pending, retired or consumed authorization, a budget other than one correction and one re-review, any identity other
 * than the pinned ones, inside a nested agent session, for an inconsistent namespace, or when already attempted. A stop
 * before the claim writes a preflight evidence file and consumes nothing; after the claim exactly one evidence file.
 */
export async function runCorrectionProbe(deps: CorrectionProbeDependencies): Promise<CorrectionProbeReport | CorrectionProbeRefusal> {
  const id = deps.authorization;
  const authorization = Object.hasOwn(deps.profiles.authorizations, id) ? deps.profiles.authorizations[id] : undefined;
  if (authorization === undefined) return { refused: true, reason: "unknownAuthorization", message: "The correction probe authorization is not one Fusion knows." };
  if (authorization.state === "pending") return { refused: true, reason: "authorizationPending",
    message: `Correction probe authorization ${id} is a plan awaiting explicit human approval; it cannot run.` };
  if (authorization.state === "retired") return { refused: true, reason: "authorizationRetired",
    message: `Correction probe authorization ${id} was retired; a new run needs a new human authorization.` };
  if (authorization.state !== "open") return { refused: true, reason: "authorizationConsumed",
    message: `Correction probe authorization ${id} is consumed; a new run needs a new human authorization.` };
  const families = deps.profiles.families;
  for (const role of CORRECTION_ROLES) if (!Object.hasOwn(families.profiles, authorization.roles[role].family))
    return { refused: true, reason: "unknownFamily", message: `The ${role} grant names a family without a probe profile.` };
  if (ROUTE_TURN_CLASSES.some(turn => authorization.turns[turn] !== CORRECTION_ONLY_TURNS[turn]))
    return { refused: true, reason: "budgetNotCorrectionOnly", message: "A correction probe runs exactly one corrective Change Author turn and one re-review." };
  const pins: ReadonlyArray<readonly [string, string, CorrectionProbeRefusal["reason"], string]> = [
    [authorization.fixtureSha256, routeFixtureIdentity(), "fixtureMismatch", "fixture"],
    [authorization.candidateSha256, reviewCandidateIdentity(), "candidateMismatch", "starting candidate"],
    [authorization.findingsSha256, adjudicationFindingsIdentity(), "findingsMismatch", "finding set"],
    [authorization.adjudicationSha256, correctionAdjudicationIdentity(), "adjudicationMismatch", "adjudication"]];
  for (const [pinned, actual, reason, what] of pins)
    if (pinned !== actual) return { refused: true, reason, message: `The ${what} is not the one authorization ${id} was approved for.` };
  if (nestedAgentSession(deps.env, families.nestedSessionKeys))
    return { refused: true, reason: "nestedAgentSession", message: "The probe must be started from a normal terminal, not from inside an agent session's tool process tree." };
  const root = resolve(deps.evidenceRoot ?? join(tmpdir(), authorization.evidenceDirectory));
  const inconsistent = await claimNamespace(root, id, authorization.milestone);
  if (inconsistent !== undefined) return { refused: true, reason: "namespaceMismatch", message: `${inconsistent} (${redactPath(root, deps.env)}).` };
  const claimPath = join(root, CLAIM);
  if (await exists(claimPath)) return { refused: true, reason: "alreadyAttempted",
    message: "This correction probe authorization was already attempted; another run needs a new human authorization." };

  const started = new Date(), clock = performance.now();
  const evidenceKind = deps.offlineRehearsal === true ? "offlineRehearsal" as const : "liveProvider" as const;
  const bindings = Object.fromEntries(CORRECTION_ROLES.map(role => [role, deps.bindings?.[role] ?? grantedBinding(role, authorization.roles[role])])) as
    Record<CorrectionRole, BindingConfig>;
  const publicBinding = (binding: BindingConfig) => ({ adapter: binding.adapter, model: binding.model, effort: binding.effort,
    ...(binding.maxTurns === undefined ? {} : { maxTurns: binding.maxTurns }),
    options: Object.fromEntries(Object.entries(binding.options).filter(([key]) => !["executable", "binaryDirectory", "versionFile"].includes(key))) });
  const runId = `${authorization.milestone.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}-correction-${randomBytes(6).toString("hex")}`;
  const base = { schemaVersion: CORRECTION_PROBE_EVIDENCE_SCHEMA, kind: "reviewCorrectionProbe", milestone: authorization.milestone, evidenceKind,
    startedAt: started.toISOString(), runId, authorization: { id, milestone: authorization.milestone, turns: authorization.turns, roles: authorization.roles },
    fixture: { sha256: routeFixtureIdentity(), pinned: authorization.fixtureSha256, candidateSha256: reviewCandidateIdentity(),
      candidatePinned: authorization.candidateSha256, findingsSha256: adjudicationFindingsIdentity(), findingsPinned: authorization.findingsSha256,
      adjudicationSha256: correctionAdjudicationIdentity(), adjudicationPinned: authorization.adjudicationSha256 },
    bindings: Object.fromEntries(CORRECTION_ROLES.map(role => [role, publicBinding(bindings[role])])),
    harness: await harnessIdentity(deps.compiledRoot, "correction-probe.js"), node: process.version, platform: process.platform,
    gates: { liveGateAuthorized: REAL_WRITER_LIVE_GATE_AUTHORIZED, liveWriterAuthorization: liveWriterAuthorization().authorized } };
  const finish = async (name: string, outcome: CorrectionProbeOutcome, detail: string, stage: "preflight" | "correction",
    sections: Record<string, unknown>, modelTurns: number): Promise<CorrectionProbeReport> => {
    const evidence = { ...base, outcome, detail, stage, durationMs: Math.round(performance.now() - clock), ...sections };
    const path = join(root, name);
    await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
    return { outcome, detail, modelTurns, evidencePath: path, evidence };
  };
  const preflightName = `correction.preflight-${started.toISOString().replace(/[:.]/gu, "-")}.json`;

  // 1. Static preflight per role (no provider process): the exact binding, a release validated for it and authorized, the
  // lane, the surface the role's turn needs, a pinned binary's location and bytes.
  const git = await ProcessGitClient.fromPath(deps.env, true);
  const primary = await createRouteFixture(root, git);
  const initial = await primaryEvidence(primary, git);
  const preflight: Record<string, unknown> = {};
  const pinnedPaths = new Map<CorrectionRole, string>();
  for (const role of CORRECTION_ROLES) {
    const grant = authorization.roles[role], binding = bindings[role];
    const factory = deps.registry.factories.get(binding.adapter);
    if (factory === undefined || (role === "Worker" && factory.createChangeAuthor === undefined))
      return finish(preflightName, "POSTURE_BLOCKED", `${role}: the adapter kind cannot serve this role`, "preflight", { preflight, primaryRoot: redactPath(primary, deps.env) }, 0);
    const inspection = await factory.inspect(binding, { workspace: primary, env: deps.env, sessionWorkspaces: "required" });
    const surface = bindingEligibility(binding, inspection)[SURFACE[role]];
    const transport = transportProfile(grant.family, inspection.transport);
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
    if (pinnedPath !== undefined) pinnedPaths.set(role, pinnedPath);
    const scoped = bindingValidation(grant.family, inspection.transport, inspection.runtimeVersion, binding);
    const envelope = role === "Worker" ? transport?.changeProposalEnvelope ?? null : "rawOnly";
    preflight[role] = { family: grant.family, executable: inspection.executable, installedVersion: inspection.runtimeVersion,
      validatedVersions: transport?.compatibility.kind === "validatedVersions" ? transport.compatibility.versions : [],
      validatedForBinding: scoped === undefined ? null : { release: scoped.release, milestone: scoped.milestone }, authorizedVersions: grant.runtimeVersions,
      executableIdentity: pinned ? { basename: path === undefined ? null : basename(path), locationMatches, sha256Matches: bytesMatch } : "notPinned",
      billing: { state: inspection.billing.state, reasons: inspection.billing.reasons, ...(lane ? { laneIntent: lane } : {}) }, authorizedLanes: grant.lanes,
      bindingMatchesAuthorization: mismatched.length === 0, bindingMismatches: mismatched,
      requiredEnvironment: Object.fromEntries(grant.requiredEnvironment.map(key => [key, missing.includes(key) ? "missing" : "set"])),
      eligibility: { surface: SURFACE[role], state: surface.state, reasons: surface.reasons }, expectedEnvelope: envelope };
    const blocked: Block | undefined = mismatched.length > 0 ? ["MODEL_BLOCKED", `the binding differs from the authorization (${mismatched.join(", ")})`]
      : missing.length > 0 ? ["VERSION_BLOCKED", `the authorization requires the pinned runtime variable(s) ${missing.join(", ")}`]
      : inspection.executable !== "available" ? ["PROVIDER_FAILED", "the provider executable was not found"]
      : inspection.billing.state !== "clear" ? ["AUTH_BLOCKED", `billing guard: ${inspection.billing.reasons.join("; ") || inspection.billing.state}`]
      : lane === undefined || !grant.lanes.includes(lane) ? ["AUTH_BLOCKED", `credential lane ${lane ?? "unknown"} is not authorized (${grant.lanes.join(", ")})`]
      : !isValidatedForBinding(grant.family, inspection.transport, inspection.runtimeVersion, binding)
        ? ["VERSION_BLOCKED", `installed ${inspection.runtimeVersion} is not a validated ${inspection.transport} release for this binding`]
      : !grant.runtimeVersions.includes(inspection.runtimeVersion)
        ? ["VERSION_BLOCKED", `installed ${inspection.runtimeVersion} is not the authorized release (${grant.runtimeVersions.join(", ")})`]
      : !locationMatches ? ["VERSION_BLOCKED", "the executable is not the authorized one at its authorized location"]
      : !bytesMatch ? ["VERSION_BLOCKED", "the executable's SHA-256 differs from the authorized one"]
      : surface.state !== "eligible" ? ["POSTURE_BLOCKED", `${SURFACE[role]} ${surface.state}: ${surface.reasons.join("; ")}`]
      : envelope === null ? ["POSTURE_BLOCKED", "the transport records no change-proposal envelope"]
      : undefined;
    if (blocked !== undefined)
      return finish(preflightName, blocked[0], `${role}: ${blocked[1]}`, "preflight", { preflight, primaryRoot: redactPath(primary, deps.env) }, 0);
  }

  // 2. Production composition (the two roles) with the pre-launch guard over every provider process.
  const launches: ObservedLaunch[] = [];
  const observations: CandidateVerificationObservation[] = [];
  const temp = resolve(tmpdir());
  const temporaryRootOf = (at: string): string | undefined => {
    if (!within(temp, at) || comparablePath(at) === comparablePath(temp) || within(root, at)) return undefined;
    return join(temp, relative(temp, at).split(sep)[0]!);
  };
  const roleOf = (record: LaunchRecord): CorrectionRole | null =>
    CORRECTION_ROLES.find(role => basename(record.executable).toLowerCase() === authorization.roles[role].executable.toLowerCase()) ?? null;
  let phase: Phase = "preflight";
  let guardedViews: RecordingViews | undefined;
  const modelProcesses: Record<CorrectionRole, number> = { Worker: 0, Reviewer: 0 };
  /** The view each role's model turn must run in: the baseline view (Change Author), the corrected candidate's view (Reviewer). */
  const turnView: Partial<Record<CorrectionRole, string>> = {};
  const launchRefusal = (record: LaunchRecord, role: CorrectionRole | null): LaunchRefusal | undefined => {
    const posture = (reason: string): LaunchRefusal => ({ outcome: "POSTURE_BLOCKED", reason });
    if (guardedViews === undefined || phase === "preflight" || phase === "boundary" || phase === "fusion" || phase === "closed")
      return posture(`a provider process was started outside a model-turn stage (${phase})`);
    if (role === null) return posture("a provider process of an executable the authorization does not name");
    const active: CorrectionRole = phase === "rereview" ? "Reviewer" : "Worker";
    if (role !== active) return posture(`a ${role} process during the ${active === "Worker" ? "corrective Change Author" : "re-review"} stage`);
    const pinnedPath = pinnedPaths.get(role);
    if (pinnedPath !== undefined && comparablePath(record.executable) !== comparablePath(pinnedPath))
      return { outcome: "VERSION_BLOCKED", reason: "a provider process of another executable than the authorized one" };
    const view = guardedViews.views.find(v => comparablePath(v.handle.path) === comparablePath(record.cwd) && Object.values(v.checks).every(Boolean));
    const owned = temporaryRootOf(record.cwd);
    const hostDirectory = record.purpose === "providerHost" && owned !== undefined && comparablePath(owned) === comparablePath(record.cwd) &&
      basename(owned).startsWith("fusion-");
    const inTurnView = view !== undefined && turnView[role] !== undefined && comparablePath(view.handle.path) === comparablePath(turnView[role]!);
    if (!inTurnView && !hostDirectory) return posture(`a ${role} process would start outside its checked Fusion-owned view`);
    if (record.args.some(arg => isAbsolute(arg) && (within(primary, arg) || within(arg, primary)))) return posture("a provider process argument names the primary");
    const forbidden = record.envKeys.filter(key => families.forbiddenEnv.test(key));
    if (forbidden.length > 0) return { outcome: "AUTH_BLOCKED", reason: `a forbidden variable would reach a provider process (${forbidden.join(", ")})` };
    if (record.purpose !== "providerTurn") return undefined;
    if (phase === "authorSession") return { outcome: "TURN_REFUSED", reason: "a model process before the claimed corrective turn" };
    if (++modelProcesses[role] > 1) return { outcome: "TURN_REFUSED", reason: `a second ${role} model process` };
    if (!inTurnView) return posture(`the ${role} model turn would run outside its view`);
    const controls = postureOf(families.profiles[authorization.roles[role].family]!.turnPosture, record.args);
    if (controls.missing.length > 0 || controls.widening.length > 0) return posture("the provider model turn lacks a read-only control or carries a widening flag");
    const identity = turnIdentityGaps(authorization.roles[role].turnArgs ?? [], record.args);
    if (identity.length > 0) return { outcome: "MODEL_BLOCKED", reason: `the ${role} model process does not carry exactly the authorized ${identity.join(", ")}` };
    return undefined;
  };
  const containersBefore = await deps.fusionContainers?.();
  const compose = deps.compose ?? composeProductionWriter;
  const composition = await compose({ root: primary, config: correctionConfig(bindings), registry: deps.registry, env: deps.env,
    ...(deps.signal ? { signal: deps.signal } : {}),
    launchObserver: (record, settled) => {
      const role = roleOf(record);
      const entry: ObservedLaunch = { record, phase, role };
      launches.push(entry);
      void settled.then(value => { entry.settlement = value; });
      const refusal = launchRefusal(record, role);
      if (refusal === undefined) return;
      entry.refused = refusal;
      throw new FusionFailure({ kind: "SecurityViolation", retryable: false, safeMessage: `Fusion refused to start a provider process: ${refusal.reason}.` });
    },
    onVerification: observation => observations.push(observation) });
  const acceptance = composition.verification;
  const byRole = new Map(CORRECTION_ROLES.map(role => [role, composition.roles.filter(candidate => candidate.binding.role === role)]));
  const composedBlock: Block | undefined = acceptance.acceptance !== "granted" && deps.offlineRehearsal !== true
    ? ["VERIFICATION_FAILED", `confined verification not accepted: ${acceptance.reasons.join("; ") || "refused"}`]
    : composition.unavailable.length > 0 || composition.roles.length !== CORRECTION_ROLES.length || CORRECTION_ROLES.some(role => byRole.get(role)!.length !== 1)
      ? ["POSTURE_BLOCKED", `the composition did not yield exactly the Change Author and the Reviewer (${composition.unavailable.map(u => u.reason).join("; ")})`]
    : CORRECTION_ROLES.some(role => byRole.get(role)![0]!.binding.transport !== authorization.roles[role].binding.adapter)
      ? ["POSTURE_BLOCKED", "a role is served by another adapter than its authorized one"]
    : undefined;
  if (composedBlock !== undefined)
    return finish(preflightName, composedBlock[0], composedBlock[1], "preflight", { preflight, acceptance, primaryRoot: redactPath(primary, deps.env) }, 0);
  // The production routing of each role for its turn: the Change Author as the engine routes a Writer's delegate, the
  // Reviewer as it routes a fresh review.
  let author: ResolvedRole, reviewer: ResolvedRole;
  try {
    author = await resolveRole("Worker", composition.roles, NO_EXTRA_CAPABILITIES, { changeProposal: true, workspaceBinding: true });
    reviewer = await resolveRole("Reviewer", composition.roles, NO_EXTRA_CAPABILITIES, { structuredTurns: true, reviewIsolation: true, workspaceBinding: true });
  } catch (error) {
    return finish(preflightName, "POSTURE_BLOCKED", `routing refused a role: ${error instanceof FusionFailure ? error.error.safeMessage : "unknown"}`,
      "preflight", { preflight, acceptance, primaryRoot: redactPath(primary, deps.env) }, 0);
  }

  // 3. The boundary (Fusion-owned), then the corrective attempt, verification and the re-review.
  const port = composition.workspace, plan = composition.plan;
  const scope = writerChangeScope(ROUTE_PACKET);
  const gate = new CorrectionTurnGate(authorization.turns);
  const adapters = { Worker: gate.wrap("Worker", author.adapter), Reviewer: gate.wrap("Reviewer", reviewer.adapter) };
  const views = new RecordingViews(composition.views, primary);
  guardedViews = views;
  const errorOf = (error: unknown): FusionError => error instanceof FusionFailure ? error.error
    : { kind: "InternalError", retryable: false, safeMessage: "The correction probe stopped unexpectedly." };
  type Diagnostics = { terminalDiagnostic?: unknown; structuredOutputDiagnostic?: unknown; runtimeEvidence?: Record<string, unknown>;
    initReadback?: Record<string, unknown>; attestedRuntimeVersion?: unknown; attestedAuth?: { state: string; lane: string; evidence: readonly string[] } };
  const facts = { Worker: author.adapter as Diagnostics, Reviewer: reviewer.adapter as Diagnostics };
  const turnDiagnostics: Record<CorrectionRole, { structuredOutput: unknown; terminal: unknown }> = {
    Worker: { structuredOutput: null, terminal: null }, Reviewer: { structuredOutput: null, terminal: null } };
  const run = { claimed: false, stage: "boundary" as string, block: undefined as Block | undefined, crash: undefined as FusionError | undefined,
    turnError: undefined as (FusionError & { role: CorrectionRole }) | undefined, contractError: undefined as FusionError | undefined,
    reviewFindings: undefined as readonly Finding[] | undefined, decision: undefined as ReviewOutcome | undefined,
    starting: undefined as WorkspaceHandle | undefined, corrected: undefined as WorkspaceHandle | undefined,
    sessions: [] as Array<{ role: CorrectionRole; session: Session }>, openViews: [] as ProviderViewHandle[],
    facts: {} as Record<string, unknown>, released: {} as Record<string, unknown>,
    integrity: { baselineView: { before: "", after: "" }, reviewView: { before: "", after: "" }, candidate: { before: "", after: "" },
      primary: { before: "", after: "" } } };
  const verifyInto = async (lease: WorkspaceHandle, key: string): Promise<boolean> => {
    const from = observations.length;
    const verdict: VerificationVerdict = await port.verify(lease, plan, deps.signal);
    const accepted = verdict.evidence?.acceptance === "granted" || (deps.offlineRehearsal === true && verdict.evidence?.acceptance === "offlineRehearsal");
    run.facts[key] = { passed: verdict.passed, commandsRun: verdict.commandsRun, ...(verdict.refusal ? { refusal: verdict.refusal } : {}),
      acceptance: verdict.evidence?.acceptance ?? null, commands: verdict.evidence?.commands ?? [],
      runs: observations.slice(from).map(({ durationMs, outcome }) => ({ durationMs, backendId: outcome.verification.selection.backendId,
        confinement: outcome.verification.selection.confinement, platform: outcome.platform.effective, passed: outcome.verification.result.passed })) };
    return verdict.passed && verdict.commandsRun === plan.commands.length && accepted;
  };
  const openSession = async (role: CorrectionRole, lease: WorkspaceHandle, view: ProviderViewHandle, resolved: ResolvedRole): Promise<Session> => {
    const session = await adapters[role].createSession({ runId, role, workspaceLeaseId: lease.leaseId, posture: resolved.posture,
      model: resolved.binding.model, workspace: Object.freeze({ id: view.viewId, root: view.path }) });
    run.sessions.push({ role, session });
    if (session === null || typeof session !== "object" || session.role !== role || session.posture !== resolved.posture ||
        session.workspaceLeaseId !== lease.leaseId || session.runId !== runId || session.provider !== resolved.binding.provider ||
        typeof session.id !== "string" || session.workspaceRoot !== view.path || run.sessions.filter(s => s.session.id === session.id).length > 1)
      throw new FusionFailure({ kind: "SecurityViolation", retryable: false, safeMessage: `The ${role} session does not match the requested role, posture or workspace.` });
    return session;
  };
  const closeSession = async (role: CorrectionRole, session: Session, resolved: ResolvedRole): Promise<void> => {
    run.released[`${role}Session`] = await bounded(async () => { await resolved.adapter.close(session); return "closed"; }, 30_000) ?? "unconfirmed";
  };
  const observedTurn = async <T>(role: CorrectionRole, work: () => Promise<T>): Promise<T | undefined> => {
    const before = { terminal: facts[role].terminalDiagnostic, output: facts[role].structuredOutputDiagnostic };
    try { return await work(); }
    catch (error) { run.turnError = { ...errorOf(error), role }; return undefined; }
    finally {
      const output = facts[role].structuredOutputDiagnostic, terminal = facts[role].terminalDiagnostic;
      turnDiagnostics[role] = { structuredOutput: output === before.output ? null : structureOnlyDiagnostic(output),
        terminal: terminal === before.terminal ? null : terminalOnlyDiagnostic(terminal) };
    }
  };
  /** The turn result as the engine reads it: a completed turn by exactly the bound provider, or the recorded failure. */
  const completedOutput = (role: CorrectionRole, resolved: ResolvedRole, raw: unknown): { output: unknown } | Block | undefined => {
    let turn: ReturnType<typeof validateStructuredTurnResult>;
    try { turn = validateStructuredTurnResult(raw); }
    catch (error) { run.turnError = { ...errorOf(error), role }; return undefined; }
    const models = [authorization.roles[role].binding.model, authorization.roles[role].binding.options?.canonicalModel].filter((m): m is string => typeof m === "string");
    run.facts[`${role}Turn`] = { status: turn.status, provider: turn.effectiveProvider || null,
      observedModel: turn.status === "completed" ? turn.effectiveModel || null : null, requestedModel: resolved.binding.model.id,
      effort: resolved.binding.model.effort, ...(resolved.binding.model.maxTurns === undefined ? {} : { maxTurns: resolved.binding.model.maxTurns }),
      transport: resolved.binding.transport };
    if (turn.status !== "completed") {
      if (turn.effectiveProvider !== "" && turn.effectiveProvider !== resolved.binding.provider)
        return ["MODEL_BLOCKED", `the failed ${role} turn was reported by another provider than the bound one`];
      run.turnError = { ...turn.error, role };
      return undefined;
    }
    if (turn.effectiveProvider !== resolved.binding.provider) return ["MODEL_BLOCKED", `the ${role} turn was served by another provider than the bound one`];
    if (!models.includes(turn.effectiveModel)) return ["MODEL_BLOCKED", `the ${role} turn's model readback is not the authorized model`];
    return { output: turn.output };
  };

  const body = async (): Promise<Block | undefined> => {
    // 3a. The Fusion-owned starting candidate (attempt 1): host-applied and verified exactly as the engine does before review.
    phase = "boundary";
    const starting = await port.acquire(`${runId}.attempt1`, deps.signal);
    run.starting = starting;
    const applied1 = await port.apply(starting, validateChangeSet(REVIEW_CANDIDATE_CHANGE, scope), scope);
    if (!("applied" in applied1)) return ["APPLICATION_FAILED", "the Fusion-authored starting candidate did not apply to the baseline"];
    const changed1 = [...new Set(await port.changedPaths(starting))].sort();
    run.facts.startingCandidate = { changedPaths: changed1, application: applied1.applied.map(op => ({ path: op.path, afterSha256: op.afterSha256 })) };
    if (!await verifyInto(starting, "startingVerification"))
      return ["VERIFICATION_FAILED", "Fusion's confined verification of the starting candidate did not pass"];
    // 3b. Review cycle 1 and its adjudication (Fusion-owned), the policy's decision, and the engine's corrective retry context.
    const forbidden = new Set(ROUTE_PACKET.scope.forbiddenFiles.map(scopeKey));
    const observed: ObservedState = { verification: new Map(plan.commands.map(command => [command.id, true])), changedPaths: changed1,
      allowedScope: ROUTE_PACKET.scope.allowedFiles.filter(at => !forbidden.has(scopeKey(at))), claimedTests: [] };
    const boundary = correctionBoundary(runId, observed);
    run.facts.boundary = {
      reviewCycle1: boundary.findings.map(f => ({ id: f.id, severity: f.severity })),
      adjudicationCycle1: boundary.adjudicated.map(a => ({ findingId: a.finding.id, verdict: a.verdict, requiredAction: a.requiredAction,
        verdictSource: a.verdictSource, outstanding: isOutstanding(a) })),
      decision: boundary.decision.kind === "correction" ? { kind: "correction", findings: boundary.decision.findings.map(f => f.id) } : { kind: boundary.decision.kind },
      retry: { attempt: boundary.retry.attempt, limit: boundary.retry.limit, freshCandidate: boundary.retry.freshCandidate === true,
        findings: (boundary.retry.findings ?? []).map(f => f.id) },
      priorFindings: boundary.priorFindings.map(f => f.id),
      correctionPacket: { constraints: boundary.packet.task.constraints.length, sha256: sha256(JSON.stringify(boundary.packet)) } };
    if (boundary.decision.kind !== "correction") return ["DECISION_REQUIRED", `the boundary decision is ${boundary.decision.kind}, not a correction`];
    // The superseded candidate is discarded before a fresh one exists (one candidate at a time).
    run.released.startingCandidate = await bounded(() => port.release(starting), 90_000) ?? { complete: false, reason: "timeout" };
    run.starting = undefined;
    if ((run.released.startingCandidate as { complete?: unknown }).complete !== true)
      return ["CLEANUP_FAILED", "the superseded starting candidate could not be removed before the corrective attempt"];

    // 4. The corrective attempt (attempt 2): a fresh candidate, Fusion's baseline hashes, the Change Author in the baseline view.
    const lease = await port.acquire(`${runId}.attempt2`, deps.signal);
    run.corrected = lease;
    const baseline = await port.baselineHashes(lease, scope.allowedPaths);
    if (baseline.length !== scope.allowedPaths.length || baseline.some((file, index) => file.path !== scope.allowedPaths[index]))
      return ["POSTURE_BLOCKED", "the workspace port returned an invalid baseline observation"];
    phase = "authorSession";
    const baselineView = await views.open(`${runId}.views`, { kind: "baseline" }, deps.signal);
    run.openViews.push(baselineView);
    if (baselineView.kind !== "baseline" || !Object.values(views.views.at(-1)!.checks).every(Boolean))
      return ["POSTURE_BLOCKED", "the Change Author's view is not a checked Fusion-owned baseline view"];
    turnView.Worker = baselineView.path;
    run.integrity.baselineView.before = await views.fingerprint(baselineView, deps.signal);
    let authorSession: Session;
    try { authorSession = await openSession("Worker", lease, baselineView, author); }
    catch (error) {
      const failure = errorOf(error);
      return [failure.kind === "AuthMismatch" || failure.kind === "BillingBlocked" ? "AUTH_BLOCKED" : "POSTURE_BLOCKED",
        `the Change Author session did not open: ${failure.kind}: ${failure.safeMessage}`];
    }
    // The one-shot claim, right before the first model turn: from here on the authorization is consumed, whatever happens.
    run.integrity.primary.before = await port.fingerprint(undefined, deps.signal);
    await writeFile(claimPath, `${JSON.stringify({ authorization: id, milestone: authorization.milestone, correctionOnly: true,
      turns: authorization.turns, claimedAt: new Date().toISOString(), evidenceKind })}\n`, { flag: "wx" });
    run.claimed = true;
    phase = "authorTurn";
    run.stage = "correctionAuthor";
    const request = { kind: "changeProposal" as const, packet: boundary.packet, baseline };
    const rawProposal = await observedTurn("Worker", () => adapters.Worker.runChangeProposalTurn!(authorSession, request, deps.signal));
    phase = "fusion";
    await closeSession("Worker", authorSession, author);
    run.integrity.baselineView.after = await views.fingerprint(baselineView);
    if (run.turnError !== undefined) return undefined;
    const proposal = completedOutput("Worker", author, rawProposal);
    if (proposal === undefined) return undefined;
    if (!("output" in proposal)) return proposal;
    // 5. Fusion: the production ChangeSet contract, host application into the fresh candidate, the candidate/scope checks.
    run.stage = "application";
    let changes: ChangeSet;
    try { changes = validateChangeSet(proposal.output, scope); }
    catch (error) {
      const failure = errorOf(error);
      run.facts.proposal = { outcome: failure.kind === "MalformedOutput" ? "malformed" : "rejected" };
      return ["INVALID_CHANGESET", `the corrective ChangeSet was refused: ${failure.safeMessage}`];
    }
    run.facts.proposal = { outcome: "validated", operations: changes.operations.length, paths: changes.operations.map(op => op.path) };
    const applied = await port.apply(lease, changes, scope);
    if (!("applied" in applied)) return ["APPLICATION_FAILED", `the corrective ChangeSet's baseline hashes did not match (${applied.preconditionFailed.join(", ")})`];
    run.facts.application = applied.applied.map(op => ({ kind: op.kind, path: op.path, beforeSha256: op.beforeSha256, afterSha256: op.afterSha256, bytes: op.bytes }));
    const changed = [...new Set(await port.changedPaths(lease))].sort();
    if (JSON.stringify(changed) !== JSON.stringify([...new Set(applied.applied.map(op => op.path))].sort()))
      return ["POSTURE_BLOCKED", "the candidate differs from the host-applied ChangeSet"];
    if (unexpectedScopeSignals(observed.allowedScope, changed).length > 0) return ["DECISION_REQUIRED", "the corrective change reaches outside its scope"];
    const scoped = await port.fingerprint(lease, deps.signal);
    // 6. Fusion's confined verification of the corrected candidate. Attempts are exhausted (2 of 2): a failure ends the branch.
    run.stage = "verification";
    if (!await verifyInto(lease, "correctionVerification"))
      return ["VERIFICATION_FAILED", "Fusion's confined verification of the corrected candidate did not pass; attempts are exhausted and no re-review runs"];
    const verifiedState = await port.fingerprint(lease, deps.signal);
    if (verifiedState !== scoped) return ["VIEW_MUTATED", "the corrected candidate changed during verification"];
    gate.verified = true;
    // 7. The fresh re-review (cycle 2): production review evidence of the corrected candidate, a NEW session in a NEW view.
    const diff = await port.diff(lease, deps.signal);
    const evidence = reviewEvidence(ROUTE_PACKET, { required: true, passed: true, commands: plan.commands.map(command => ({ id: command.id, passed: true })) },
      { kind: "diff", changedPaths: changed, text: diff.text, truncated: diff.truncated });
    const review: ReviewRequest = { kind: "review", cycle: 2, evidence, priorFindings: boundary.priorFindings, limits: { maxFindings: REVIEW_LIMITS.maxFindings } };
    run.facts.reviewRequest = { cycle: 2, priorFindings: boundary.priorFindings.map(f => f.id), changedPaths: evidence.change.changedPaths,
      changeBytes: Buffer.byteLength(evidence.change.text, "utf8"), changeTruncated: evidence.change.truncated, verification: evidence.verification,
      contractPromptSha256: sha256(structuredTurnPrompt(review)) };
    phase = "rereview";
    run.stage = "rereview";
    const reviewView = await views.open(`${runId}.views`, { kind: "candidate", candidate: lease }, deps.signal);
    run.openViews.push(reviewView);
    const candidateRoot = dirname(resolve(lease.path));
    if (reviewView.kind !== "candidate" || !Object.values(views.views.at(-1)!.checks).every(Boolean) ||
        within(candidateRoot, reviewView.path) || within(reviewView.path, candidateRoot))
      return ["POSTURE_BLOCKED", "the re-review view is not a checked Fusion-owned view of the corrected candidate"];
    turnView.Reviewer = reviewView.path;
    run.integrity.reviewView.before = await views.fingerprint(reviewView, deps.signal);
    run.integrity.candidate.before = verifiedState;
    let reviewSession: Session;
    try { reviewSession = await openSession("Reviewer", lease, reviewView, reviewer); }
    catch (error) { const failure = errorOf(error); return [failure.kind === "AuthMismatch" ? "AUTH_BLOCKED" : "POSTURE_BLOCKED",
      `the Reviewer session did not open: ${failure.kind}: ${failure.safeMessage}`]; }
    const rawReview = await observedTurn("Reviewer", () => adapters.Reviewer.runStructuredTurn!(reviewSession, review, deps.signal));
    phase = "closed";
    await closeSession("Reviewer", reviewSession, reviewer);
    run.integrity.reviewView.after = await views.fingerprint(reviewView);
    run.integrity.candidate.after = await port.fingerprint(lease);
    if (run.turnError !== undefined) return undefined;
    const reviewed = completedOutput("Reviewer", reviewer, rawReview);
    if (reviewed === undefined) return undefined;
    if (!("output" in reviewed)) return reviewed;
    try { run.reviewFindings = validateReviewReport(reviewed.output, { cycle: 2, runId, sessionId: reviewSession.id, role: "Reviewer" }); }
    catch (error) { run.contractError = errorOf(error); return undefined; }
    // 8. The bounded policy: a clean re-review completes the branch; findings need a cycle-2 adjudication this probe never runs.
    if (run.reviewFindings.length === 0) run.decision = reviewOutcome([], 2 < REVIEW_CYCLE_LIMIT);
    return undefined;
  };
  try { run.block = await body(); }
  catch (error) { run.crash = errorOf(error); }
  finally {
    phase = "closed";
    const settle = async (take: () => Promise<string>): Promise<string> => { try { return await take(); } catch { return "unreadable"; } };
    const [baselineView, reviewView] = [run.openViews.find(v => v.kind === "baseline"), run.openViews.find(v => v.kind === "candidate")];
    if (baselineView !== undefined && run.integrity.baselineView.before !== "" && run.integrity.baselineView.after === "")
      run.integrity.baselineView.after = await settle(() => views.fingerprint(baselineView));
    if (reviewView !== undefined && run.integrity.reviewView.before !== "" && run.integrity.reviewView.after === "")
      run.integrity.reviewView.after = await settle(() => views.fingerprint(reviewView));
    if (run.corrected !== undefined && run.integrity.candidate.before !== "" && run.integrity.candidate.after === "")
      run.integrity.candidate.after = await settle(() => port.fingerprint(run.corrected));
    if (run.integrity.primary.before !== "" && run.integrity.primary.after === "") run.integrity.primary.after = await settle(() => port.fingerprint(undefined));
    for (const { role, session } of run.sessions) if (run.released[`${role}Session`] === undefined)
      run.released[`${role}Session`] = await bounded(async () => { await (role === "Worker" ? author : reviewer).adapter.close(session); return "closed"; }, 30_000) ?? "unconfirmed";
    run.released.views = await Promise.all(run.openViews.map(async view => await bounded(() => views.release(view), 60_000) ?? { complete: false, reason: "timeout" }));
    if (run.starting !== undefined) run.released.startingCandidate = await bounded(() => port.release(run.starting!), 90_000) ?? { complete: false, reason: "timeout" };
    if (run.corrected !== undefined) run.released.correctedCandidate = await bounded(() => port.release(run.corrected!), 90_000) ?? { complete: false, reason: "timeout" };
  }
  const settleBy = Date.now() + 30_000;
  while (launches.some(entry => entry.settlement === undefined) && Date.now() < settleBy) await new Promise(done => setTimeout(done, 25));
  const after = await primaryEvidence(primary, git).catch(() => undefined);
  const containersAfter = await deps.fusionContainers?.();
  const identityAfter = Object.fromEntries(await Promise.all([...pinnedPaths].map(async ([role, path]) => {
    const expected = authorization.roles[role].executableSha256;
    return [role, { sha256Matches: expected === undefined ? null : await fileSha256(path).catch(() => "unreadable") === expected }] as const;
  })));

  // Evidence: labels, counts and digests only.
  const startedLaunches = launches.filter(l => l.refused === undefined);
  const purposes: ProcessPurpose[] = ["providerAuthReadback", "providerInventory", "providerInitProbe", "providerTurn", "providerHost"];
  const countsOf = (role: CorrectionRole) => Object.fromEntries(purposes.map(purpose =>
    [purpose, startedLaunches.filter(l => l.role === role && l.record.purpose === purpose).length])) as Record<string, number>;
  const counts = { Worker: countsOf("Worker"), Reviewer: countsOf("Reviewer") };
  const modelTurns = startedLaunches.filter(l => l.record.purpose === "providerTurn").length;
  const launchRefusals = launches.flatMap(l => l.refused === undefined ? [] : [{ purpose: l.record.purpose ?? "unlabelled", phase: l.phase, role: l.role, ...l.refused }]);
  const launchEvidence = launches.map(({ record, phase: at, role, settlement, refused }) => {
    const owned = temporaryRootOf(record.cwd);
    const seen = views.views.find(v => comparablePath(v.handle.path) === comparablePath(record.cwd));
    const cwdClass = seen !== undefined ? `providerView:${seen.handle.kind}` : within(primary, record.cwd) || within(record.cwd, primary) ? "primary"
      : owned !== undefined && comparablePath(owned) === comparablePath(record.cwd) && basename(owned).startsWith("fusion-") ? "ownedTemporary" : "other";
    const pinnedPath = role === null ? undefined : pinnedPaths.get(role);
    return { purpose: record.purpose ?? "unlabelled", phase: at, role, executable: basename(record.executable),
      executableIsAuthorized: role !== null && (pinnedPath === undefined || comparablePath(record.executable) === comparablePath(pinnedPath)),
      args: record.args.map(arg => redactPath(arg, deps.env)), cwdClass, envKeyCount: record.envKeys.length,
      forbiddenEnvKeys: record.envKeys.filter(key => families.forbiddenEnv.test(key)),
      argsReferencePrimary: record.args.some(arg => isAbsolute(arg) && (within(primary, arg) || within(arg, primary))),
      ...(record.purpose === "providerTurn" && role !== null ? { posture: postureOf(families.profiles[authorization.roles[role].family]!.turnPosture, record.args),
        identityGaps: turnIdentityGaps(authorization.roles[role].turnArgs ?? [], record.args) } : {}),
      ...(refused === undefined ? {} : { refusedBeforeStart: refused.reason }), settlement: settlement ?? "unsettled" };
  });
  const attributable = new Set<string>([...views.views.map(v => dirname(v.handle.path)),
    ...[run.starting, run.corrected].flatMap(lease => lease === undefined ? [] : [dirname(resolve(lease.path))]),
    ...launches.flatMap(({ record }) => [record.cwd, ...record.args.filter(arg => isAbsolute(arg))]).flatMap(at => {
      const owned = temporaryRootOf(at); return owned === undefined ? [] : [owned]; })]);
  const leftovers = (await Promise.all([...attributable].map(async at => await exists(at) ? [redactPath(at, deps.env)] : []))).flat();
  const { integrity, reviewFindings, decision, turnError, contractError } = run;
  const same = (pair: { before: string; after: string }) => pair.before === "" || pair.before === pair.after;
  const viewsUnchanged = same(integrity.baselineView) && same(integrity.reviewView);
  const candidateUnchanged = same(integrity.candidate);
  const primaryUnchanged = initial.digest === after?.digest && same(integrity.primary);
  const released = run.released as Record<string, unknown>;
  const complete = (value: unknown) => (value as { complete?: unknown } | undefined)?.complete === true;
  const cleanupComplete = leftovers.length === 0 && (containersAfter === undefined || containersAfter === containersBefore) &&
    (released.startingCandidate === undefined || complete(released.startingCandidate)) &&
    (released.correctedCandidate === undefined || complete(released.correctedCandidate)) &&
    ((released.views as unknown[] | undefined) ?? []).every(complete) &&
    run.sessions.every(({ role }) => released[`${role}Session`] === "closed");
  const readbackOf = (role: CorrectionRole) => {
    const runtime = facts[role].runtimeEvidence ?? facts[role].initReadback;
    return { runtime: runtime === undefined ? null : { source: facts[role].runtimeEvidence === undefined ? "initOfFailedTurn" : "completedTurn",
      runtimeVersion: runtime.runtimeVersion, requestedModel: runtime.requestedModel, effectiveModel: runtime.effectiveModel,
      apiKeySource: runtime.apiKeySource, permissionMode: runtime.permissionMode, tools: runtime.tools,
      mcpServers: Array.isArray(runtime.mcpServers) ? runtime.mcpServers.length : null, auth: runtime.auth },
      attestedAuth: facts[role].attestedAuth === undefined ? null : { state: facts[role].attestedAuth!.state, lane: facts[role].attestedAuth!.lane,
        evidence: facts[role].attestedAuth!.evidence },
      attestedRuntimeVersion: typeof facts[role].attestedRuntimeVersion === "string" ? facts[role].attestedRuntimeVersion : null };
  };
  const tally = (key: "severity" | "confidence") => reviewFindings === undefined ? null
    : Object.fromEntries([...new Set(reviewFindings.map(f => f[key]))].sort().map(value => [value, reviewFindings.filter(f => f[key] === value).length]));
  const sections: Record<string, unknown> = {
    preflight, acceptance, primaryRoot: redactPath(primary, deps.env), boundary: run.facts.boundary ?? null,
    startingCandidate: run.facts.startingCandidate ?? null, startingVerification: run.facts.startingVerification ?? null,
    correctionAuthor: { turn: run.facts.WorkerTurn ?? null, ...(turnError?.role === "Worker" ? { error: { kind: turnError.kind, safeMessage: turnError.safeMessage } } : {}),
      structuredOutput: turnDiagnostics.Worker.structuredOutput, terminal: turnDiagnostics.Worker.terminal, proposal: run.facts.proposal ?? null },
    application: run.facts.application ?? null, correctionVerification: run.facts.correctionVerification ?? null,
    rereview: { request: run.facts.reviewRequest ?? null, turn: run.facts.ReviewerTurn ?? null,
      ...(turnError?.role === "Reviewer" ? { error: { kind: turnError.kind, safeMessage: turnError.safeMessage } } : {}),
      contract: reviewFindings !== undefined ? `accepted:${reviewFindings.length} finding(s)` : contractError !== undefined ? "refused" : "notReached",
      ...(contractError ? { contractError: { kind: contractError.kind, safeMessage: contractError.safeMessage } } : {}),
      findings: reviewFindings === undefined ? null : { count: reviewFindings.length, bySeverity: tally("severity"), byConfidence: tally("confidence") },
      decision: decision === undefined ? (reviewFindings !== undefined && reviewFindings.length > 0 ? { kind: "adjudicationRequired", cycle: 2, authorized: false } : null)
        : { kind: decision.kind },
      structuredOutput: turnDiagnostics.Reviewer.structuredOutput, terminal: turnDiagnostics.Reviewer.terminal },
    readbacks: { Worker: readbackOf("Worker"), Reviewer: readbackOf("Reviewer") },
    turnBudget: authorization.turns, turnUse: { leadPlan: 0, changeAuthor: gate.used.changeAuthor, freshReview: gate.used.freshReview, leadAdjudication: 0 },
    refusals: { turns: gate.refusals, launches: launchRefusals }, launches: launchEvidence, launchCounts: counts,
    sessions: run.sessions.map(({ role, session }) => ({ role, viewKind: run.openViews.find(v => v.path === session.workspaceRoot)?.kind ?? null })),
    executableIdentityAfter: identityAfter,
    views: views.views.map(v => ({ kind: v.handle.kind, checks: v.checks, fingerprintObservations: v.fingerprints.length,
      unchanged: v.fingerprints.length >= 2 && v.fingerprints.every(value => value === v.fingerprints[0]), released: v.released ?? null })),
    integrity: { viewsUnchanged, candidateUnchanged, primaryUnchanged },
    primary: { before: initial.digest, after: after?.digest ?? "unreadable", unchanged: initial.digest === after?.digest, files: initial.files,
      canariesUnchanged: JSON.stringify(initial.canaries) === JSON.stringify(after?.canaries), head: initial.head },
    cleanup: { released, attributedTemporaries: attributable.size, leftoverOwnedTemporaries: leftovers,
      ...(containersBefore === undefined ? {} : { fusionContainersBefore: containersBefore, fusionContainersAfter: containersAfter }) },
    gatesAfter: { liveGateAuthorized: REAL_WRITER_LIVE_GATE_AUTHORIZED,
      hostControlledWriterWorkflow: writerGateReport().rows.find(row => row.id === "hostControlledWriterWorkflow")?.state ?? "missing" },
  };
  const [outcome, detail] = classifyCorrectionProbe({ claimed: run.claimed, stage: run.stage, block: run.block, crash: run.crash, turnError,
    contractError, reviewFindings, decision, modelTurns, turnRefusals: gate.refusals.map(r => r.reason),
    launchRefusals: launchRefusals.map(({ outcome, reason }) => ({ outcome, reason })), viewsUnchanged, candidateUnchanged, primaryUnchanged,
    launchesConfined: launchEvidence.every(l => l.refusedBeforeStart !== undefined || (!l.argsReferencePrimary && l.executableIsAuthorized &&
      ((l.role === "Worker" && l.cwdClass === "providerView:baseline") || (l.role === "Reviewer" && (l.cwdClass === "providerView:candidate" ||
        (l.purpose === "providerHost" && l.cwdClass === "ownedTemporary")))))),
    forbiddenEnv: launchEvidence.some(l => l.refusedBeforeStart === undefined && l.forbiddenEnvKeys.length > 0),
    executablesUnchanged: Object.values(identityAfter).every(entry => entry.sha256Matches !== false), cleanupComplete,
    rehearsal: deps.offlineRehearsal === true });
  return finish(run.claimed ? "correction.evidence.json" : preflightName, outcome, detail, run.claimed ? "correction" : "preflight", sections, modelTurns);
}

// ---------------------------------------------------------------- classification

export interface CorrectionProbeFacts {
  readonly claimed: boolean;
  /** The stage the branch reached: correctionAuthor, application, verification, rereview (before the claim: boundary). */
  readonly stage: string;
  readonly block: Block | undefined;
  readonly crash: FusionError | undefined;
  readonly turnError: (FusionError & { role: CorrectionRole }) | undefined;
  readonly contractError: FusionError | undefined;
  readonly reviewFindings: readonly Finding[] | undefined;
  readonly decision: ReviewOutcome | undefined;
  readonly modelTurns: number;
  readonly turnRefusals: readonly string[];
  readonly launchRefusals: readonly LaunchRefusal[];
  readonly viewsUnchanged: boolean;
  readonly candidateUnchanged: boolean;
  readonly primaryUnchanged: boolean;
  readonly launchesConfined: boolean;
  readonly forbiddenEnv: boolean;
  readonly executablesUnchanged: boolean;
  readonly cleanupComplete: boolean;
  readonly rehearsal: boolean;
}
/**
 * Deterministic outcome from Fusion's own observations; provider text never decides it. Integrity first, then refused
 * launches and turns, confinement, executables, Fusion's own stops (the ChangeSet, application, verification), a crash, the
 * turn errors, the re-review contract, cleanup. PASS needs both model turns, a validated and applied ChangeSet, a passed
 * verification, an accepted re-review with no finding (the policy's `clean`), and integrity and cleanup.
 */
export function classifyCorrectionProbe(facts: CorrectionProbeFacts): Block {
  if (!facts.primaryUnchanged) return ["PRIMARY_MUTATED", "the primary fixture changed"];
  if (!facts.viewsUnchanged) return ["VIEW_MUTATED", "a provider view changed"];
  if (!facts.candidateUnchanged) return ["VIEW_MUTATED", "the corrected candidate changed during the re-review"];
  const launch = facts.launchRefusals[0];
  if (launch !== undefined) return [launch.outcome, `a provider process was refused before it started: ${launch.reason}`];
  const turn = facts.turnRefusals[0];
  if (turn !== undefined) return ["TURN_REFUSED", `a call was refused before it reached the provider: ${turn}`];
  if (!facts.launchesConfined) return ["POSTURE_BLOCKED", "a provider process ran outside its checked Fusion-owned location or executable"];
  if (facts.forbiddenEnv) return ["AUTH_BLOCKED", "a forbidden credential or override variable reached a provider process"];
  if (!facts.executablesUnchanged) return ["VERSION_BLOCKED", "a pinned executable's bytes changed during the probe"];
  if (facts.block !== undefined) return [facts.block[0], `${facts.stage}: ${facts.block[1]}`];
  if (facts.crash !== undefined) return [facts.crash.kind === "Cancelled" ? "CANCELLED" : facts.crash.kind === "Timeout" ? "TIMEOUT" : "PROVIDER_FAILED",
    `${facts.stage}: the probe stopped: ${facts.crash.kind}: ${facts.crash.safeMessage}`];
  if (facts.modelTurns > 2) return ["TURN_REFUSED", `more than two provider model turns were observed (${facts.modelTurns})`];
  const error = facts.turnError;
  if (error !== undefined) {
    const where = error.role === "Worker" ? "correctionAuthor" : "rereview";
    const kind = error.kind;
    if (kind === "Cancelled") return ["CANCELLED", `${where}: ${error.safeMessage}`];
    if (kind === "Timeout") return ["TIMEOUT", `${where}: ${error.safeMessage}`];
    if (kind === "AuthMismatch" || kind === "BillingBlocked") return ["AUTH_BLOCKED", `${where}: ${error.safeMessage}`];
    if (kind === "CapabilityUnavailable") return [/version/iu.test(error.safeMessage) ? "VERSION_BLOCKED" : "POSTURE_BLOCKED", `${where}: ${error.safeMessage}`];
    if (kind === "MalformedOutput") return ["MALFORMED_OUTPUT", `${where}: ${error.safeMessage}`];
    if (kind === "ProviderIdentityMismatch") return ["MODEL_BLOCKED", `${where}: identity: ${error.safeMessage}`];
    if (kind === "SecurityViolation") return ["POSTURE_BLOCKED", `${where}: ${error.safeMessage}`];
    return ["PROVIDER_FAILED", `${where}: ${kind}: ${error.safeMessage}`];
  }
  if (facts.contractError !== undefined) return ["CONTRACT_REFUSED", `rereview: the production review contract refused the reply: ${facts.contractError.safeMessage}`];
  if (!facts.cleanupComplete) return ["CLEANUP_FAILED", "a session, view, candidate, container or temporary directory was not removed"];
  if (facts.reviewFindings !== undefined && facts.reviewFindings.length > 0)
    return ["REREVIEW_FINDINGS", `rereview: ${facts.reviewFindings.length} finding(s); the bounded policy next needs a cycle-2 Lead adjudication, which this probe never runs, and no further correction is available`];
  if (!facts.claimed || facts.modelTurns !== 2 || facts.reviewFindings === undefined || facts.decision?.kind !== "clean")
    return ["PROVIDER_FAILED", "the probe ended without a corrective turn, a passed verification and a clean re-review"];
  return ["PASS", facts.rehearsal ? "offline rehearsal: fake providers and a fake confined backend; never live evidence"
    : "the corrective Change Author's ChangeSet was validated, host-applied into a fresh private candidate and verified; the fresh re-review accepted it with no finding (decision clean); integrity and cleanup complete"];
}
