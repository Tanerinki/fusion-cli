import { createHash } from "node:crypto";
import type { AdjudicationReport, AdjudicationRequest, AgentRole, CapabilitySnapshot, ChangeProposalRequest, ChangeSet, DelegationPacket,
  ProviderAdapter, ResultPacket, ReviewReport, ReviewRequest, Session, StructuredTurnRequest, StructuredTurnResult,
  TurnResult } from "../../src/core/domain.js";
import type { RoleCandidate } from "../../src/core/policy/routing.js";
import type { GuestCommand } from "../../src/platform/verification/docker/protocol.js";
import { passingResult, type AttachContext, type AttachReply } from "./fake-docker.js";

/**
 * TEST-ONLY deterministic fake providers for the O5.5B7 offline Writer rehearsal. They are NOT production adapters:
 * they are never registered in any provider registry, their provider id is reserved for tests, and they can only reach
 * the Writer route through the `writerRehearsal` test seam or a hand-built engine. Their realistic output proves
 * workflow wiring only — it can never prove a real provider's posture or open any readiness gate.
 */
export const FAKE_PROVIDER = "fusion-test-fake";
export const FAKE_MODEL = "fusion-test-scripted";
export const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export interface ProposalContext { readonly packet: DelegationPacket; readonly call: number; readonly session: Session;
  readonly signal: AbortSignal | undefined }
export interface ReviewContext { readonly request: ReviewRequest; readonly call: number; readonly session: Session;
  readonly signal: AbortSignal | undefined }
export interface AdjudicationContext { readonly request: AdjudicationRequest; readonly call: number; readonly session: Session;
  readonly signal: AbortSignal | undefined }
export interface PlanContext { readonly packet: DelegationPacket; readonly call: number; readonly session: Session;
  readonly signal: AbortSignal | undefined }
/** A scripted run: every role's behaviour. Unset roles use benign defaults (clean plan, clean review). */
export interface Script {
  readonly lead?: (ctx: PlanContext) => unknown;
  readonly worker: (ctx: ProposalContext) => unknown;
  readonly reviewer?: (ctx: ReviewContext) => unknown;
  readonly adjudicator?: (ctx: AdjudicationContext) => unknown;
}
/** Everything the fakes were asked, for assertions about what each role could and could not see. */
export interface Spy {
  readonly sessions: Session[];
  /** The Fusion-owned workspace root each session was bound to (undefined: none), in session order. */
  readonly workspaces: Array<Readonly<{ role: AgentRole; root: string | undefined }>>;
  readonly plans: DelegationPacket[];
  readonly proposals: DelegationPacket[];
  readonly reviews: ReviewRequest[];
  readonly adjudications: AdjudicationRequest[];
  readonly closed: string[];
  readonly cancelled: string[];
}

const envelope = (value: unknown): boolean => value !== null && typeof value === "object" && "status" in value && "effectiveProvider" in value;
const completed = <T>(output: T): { status: "completed"; output: T; effectiveProvider: string; effectiveModel: string; artifactRefs: [] } =>
  ({ status: "completed", output, effectiveProvider: FAKE_PROVIDER, effectiveModel: FAKE_MODEL, artifactRefs: [] });

/** The strict read-only review surface every role needs (the Worker additionally gets the change-proposal turn). */
export function fakeCapabilities(transport: string, extra: Partial<CapabilitySnapshot> = {}): CapabilitySnapshot {
  return { provider: FAKE_PROVIDER, transport, observedAt: "2026-09-24T00:00:00.000Z", runtimeVersion: "scripted-1",
    persistentSessions: false, structuredOutput: true, webToolsDisabled: true, filesystem: { read: true, write: false },
    shell: { available: false, sandboxed: false }, approvalCallback: false, protocolCancellation: true, usageReporting: false,
    modelIdentityReadback: true, subscriptionLaneReadback: true, approvalEscalationDisabled: true, personalContextDisabled: true,
    extensionsQuarantined: true, workspaceBinding: true, ...extra };
}

class ScriptedAdapter implements ProviderAdapter {
  #calls = new Map<string, number>();
  #sessions = 0;
  constructor(private readonly transport: string, private readonly script: Script, private readonly spy: Spy,
    public caps: CapabilitySnapshot) {}
  #next(key: string): number { const n = (this.#calls.get(key) ?? 0) + 1; this.#calls.set(key, n); return n; }
  async capabilities(): Promise<CapabilitySnapshot> { return this.caps; }
  async authStatus() { return { state: "authenticated" as const, lane: "subscription" as const, observedAt: "", evidence: [] }; }
  async createSession(request: Parameters<ProviderAdapter["createSession"]>[0]): Promise<Session> {
    const session: Session = { id: `${this.transport}-${++this.#sessions}`, runId: request.runId, role: request.role,
      provider: FAKE_PROVIDER, transport: this.transport, workspaceLeaseId: request.workspaceLeaseId, posture: request.posture,
      providerSessionRef: "scripted", ...(request.workspace === undefined ? {} : { workspaceRoot: request.workspace.root }) };
    this.spy.sessions.push(session);
    this.spy.workspaces.push({ role: request.role, root: request.workspace?.root });
    return session;
  }
  async resumeSession(session: Session): Promise<Session> { return session; }
  async runTurn(session: Session, packet: DelegationPacket, signal?: AbortSignal): Promise<TurnResult> {
    this.spy.plans.push(structuredClone(packet));
    const out = await (this.script.lead ?? (() => plan("Plan: implement the change within the delegated scope.")))(
      { packet, call: this.#next("turn"), session, signal });
    return (envelope(out) ? out : completed(out)) as TurnResult;
  }
  async runStructuredTurn(session: Session, request: StructuredTurnRequest, signal?: AbortSignal): Promise<StructuredTurnResult> {
    if (request.kind === "review") {
      this.spy.reviews.push(structuredClone(request));
      const out = await (this.script.reviewer ?? (() => clean()))({ request, call: this.#next("review"), session, signal });
      return (envelope(out) ? out : completed(out)) as StructuredTurnResult;
    }
    this.spy.adjudications.push(structuredClone(request));
    const out = await (this.script.adjudicator ?? (({ request: r }: AdjudicationContext) => judge(r, "CONFIRMED")))(
      { request, call: this.#next("adjudication"), session, signal });
    return (envelope(out) ? out : completed(out)) as StructuredTurnResult;
  }
  async runChangeProposalTurn(session: Session, request: ChangeProposalRequest, signal?: AbortSignal): Promise<StructuredTurnResult> {
    this.spy.proposals.push(structuredClone(request.packet));
    const out = await this.script.worker({ packet: request.packet, call: this.#next("proposal"), session, signal });
    return (envelope(out) ? out : completed(out)) as StructuredTurnResult;
  }
  async cancel(session: Session): Promise<void> { this.spy.cancelled.push(session.id); }
  async usage() { return null; }
  async close(session: Session): Promise<void> { this.spy.closed.push(session.id); }
}

/**
 * Lead (plan, Lead review and adjudication), Worker (change proposals only) and a fresh Reviewer, each a separate fake
 * adapter instance with its own session namespace. `worker` never receives a writable posture: it is routed as a
 * read-only Change Author like any real provider.
 */
export function scriptedRoles(script: Script, overrides: Partial<Record<"lead" | "worker" | "reviewer", Partial<CapabilitySnapshot>>> = {}):
  Readonly<{ roles: RoleCandidate[]; spy: Spy; adapters: Readonly<Record<"lead" | "worker" | "reviewer", ProviderAdapter>> }> {
  const spy: Spy = { sessions: [], workspaces: [], plans: [], proposals: [], reviews: [], adjudications: [], closed: [], cancelled: [] };
  const lead = new ScriptedAdapter("fake-lead", script, spy, fakeCapabilities("fake-lead", overrides.lead));
  const worker = new ScriptedAdapter("fake-worker", script, spy, fakeCapabilities("fake-worker", overrides.worker));
  const reviewer = new ScriptedAdapter("fake-reviewer", script, spy, fakeCapabilities("fake-reviewer", overrides.reviewer));
  const bind = (role: AgentRole, adapter: ScriptedAdapter, transport: string): RoleCandidate => ({ adapter,
    binding: { role, provider: FAKE_PROVIDER, transport, model: { id: FAKE_MODEL, effort: "scripted" }, requires: { structuredOutput: true } } });
  return { spy, adapters: { lead, worker, reviewer }, roles: [bind("Lead", lead, "fake-lead"), bind("Explorer", lead, "fake-lead"),
    bind("Worker", worker, "fake-worker"), bind("Reviewer", reviewer, "fake-reviewer")] };
}

export const plan = (summary: string, patch: Partial<ResultPacket> = {}): ResultPacket => ({ result: { status: "completed" },
  changes: { files: [], summary }, verification: { testsRun: [], results: [] }, uncertainties: [], failures: [], needsLeadDecision: [],
  ...patch });
export const clean = (): ReviewReport => ({ findings: [], summary: "No defect found." });
export function judge(request: AdjudicationRequest, verdict: "CONFIRMED" | "PARTIAL" | "REJECTED" | "UNVERIFIABLE"): AdjudicationReport {
  return { summary: "Adjudicated.", adjudications: request.findings.map(finding => ({ findingId: finding.id, verdict,
    rationale: `Checked ${finding.id} against the evidence.`,
    requiredAction: verdict === "REJECTED" ? "none" : verdict === "UNVERIFIABLE" ? "humanDecision"
      : ["BLOCKER", "HIGH", "MEDIUM"].includes(finding.severity) ? "fix" : "followUp" })) };
}
/** A complete ChangeSet: every entry is `[path, before | null, after | null]` (null after = delete). */
export function changeSet(files: ReadonlyArray<readonly [string, string | null, string | null]>): ChangeSet {
  return { schemaVersion: 1, operations: files.map(([path, before, after]) => after === null
    ? { kind: "delete" as const, path, expectedSha256: sha256(before ?? "") }
    : { kind: "writeText" as const, path, expectedSha256: before === null ? null : sha256(before), content: after }) };
}

/** One verification command's scripted outcome in the fake confined backend. */
export interface OracleStep { readonly pass: boolean; readonly stdout?: string }
/**
 * A deterministic stand-in for a container run, fed the files the real backend streamed (the reconstructed candidate
 * and, when present, the prepared dependency tree). Commands run in order and stop at the first failure, exactly like
 * the guest runner; the result satisfies the real decoder and the daemon exit-code cross-check.
 */
export function oracle(decide: (command: GuestCommand, context: AttachContext) => OracleStep, observed?: AttachContext[]):
  (context: AttachContext) => AttachReply {
  return context => {
    observed?.push(context);
    const commands: Record<string, unknown>[] = [];
    let failed = false;
    for (const command of context.manifest.commands) {
      if (failed) break;
      const step = decide(command, context);
      const stdout = step.stdout ?? (step.pass ? "ok\n" : "not ok\n");
      commands.push({ id: command.id, status: "exited", exitCode: step.pass ? 0 : 1, signal: null, durationMs: 0,
        stdoutTail: stdout, stderrTail: "", stdoutBytes: Buffer.byteLength(stdout), stderrBytes: 0 });
      failed = !step.pass;
    }
    const notRun = context.manifest.commands.slice(commands.length).map(command => command.id);
    return { stdout: `${passingResult(context.manifest, { commands, notRun })}\n`, containerExitCode: failed ? 1 : 0 };
  };
}
/** `node --test` summary lines, as the guest's stdout tail would carry them. */
export const testSummary = (pass: number, fail: number): string =>
  `ℹ tests ${pass + fail}\nℹ pass ${pass}\nℹ fail ${fail}\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n`;
