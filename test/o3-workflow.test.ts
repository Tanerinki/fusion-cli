import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { AgentRole, CapabilitySnapshot, ChangeProposalRequest, ChangeScope, ChangeSet, DelegationPacket, ModelProfile,
  ProviderAdapter, ResultPacket, RoleBinding, Session, StructuredTurnResult, TurnResult, VerificationPlan } from "../src/core/domain.js";
import { riskRank } from "../src/core/policy/risk.js";
import { PolicyRoutingFailure, resolveRole, type RoleCandidate } from "../src/core/policy/routing.js";
import type { TaskRequest } from "../src/core/policy/task-inspector.js";
import { WorkflowEngine } from "../src/core/workflow/engine.js";
import { FRESH_CANDIDATE_CONSTRAINT } from "../src/core/workflow/packets.js";
import { PRIMARY_WORKSPACE, type ApplicationOutcome, type CleanupReport, type EventSink, type VerificationVerdict,
  type VerifierPort, type WorkflowEvent, type WorkflowRequest, type WorkflowResult, type WorkspaceHandle,
  type WorkspacePort } from "../src/core/workflow/types.js";

// ---------------------------------------------------------------------------------------------------------------
// Fake, in-memory ports. No process, provider, network or filesystem access.

const PRIMARY = resolve("/fusion-o3-fake/primary");
const CANDIDATES = resolve("/fusion-o3-fake/candidates");
type TurnContext = { session: Session; packet: DelegationPacket; signal: AbortSignal | undefined; call: number; h: Harness };
type Script = (ctx: TurnContext) => unknown;
const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** Least-privilege fake surface: read-only, no shell, web tools disabled; tests widen it explicitly where needed. */
const capabilitySnapshot = (provider: string, transport: string, write: boolean | "unknown",
  extra: Partial<CapabilitySnapshot> = {}): CapabilitySnapshot => ({
  provider, transport, observedAt: "2026-01-01T00:00:00.000Z", runtimeVersion: "fake-1", persistentSessions: true,
  structuredOutput: true, webToolsDisabled: true, filesystem: { read: true, write }, shell: { available: false, sandboxed: false },
  approvalCallback: false, protocolCancellation: true, usageReporting: false, modelIdentityReadback: true,
  subscriptionLaneReadback: true, approvalEscalationDisabled: true, personalContextDisabled: true,
  extensionsQuarantined: true,
  ...(write === true ? { writerIsolation: { workspaceScopedWrites: true, primaryWorkspaceInaccessible: true,
    gitPushDisabled: true, forcePushDisabled: true, credentialOverrideBlocked: true,
    boundedCommands: true, approvalPolicyKnown: true, processTreeSupervised: true,
    workspaceIdentityReadback: true } } : {}), ...extra,
});

class FakeAdapter implements ProviderAdapter {
  readonly sessions: Session[] = [];
  readonly turns: Array<{ session: Session; packet: DelegationPacket; signalAborted: () => boolean }> = [];
  cancels = 0;
  closes = 0;
  constructor(readonly provider: string, readonly transport: string, public snapshot: CapabilitySnapshot,
    private readonly h: Harness) {}
  async capabilities(): Promise<CapabilitySnapshot> { return this.snapshot; }
  async authStatus() { return { state: "authenticated" as const, lane: "subscription" as const, observedAt: "", evidence: [] }; }
  async createSession(request: Parameters<ProviderAdapter["createSession"]>[0]): Promise<Session> {
    const session: Session = { id: `${this.transport}-s${this.sessions.length + 1}`, runId: request.runId, role: request.role,
      provider: this.provider, transport: this.transport, workspaceLeaseId: request.workspaceLeaseId,
      posture: request.posture, providerSessionRef: "opaque" };
    this.sessions.push(session);
    return this.h.sessionOverride?.(session) ?? session;
  }
  async resumeSession(session: Session): Promise<Session> { return session; }
  private async script(session: Session, packet: DelegationPacket, signal?: AbortSignal): Promise<unknown> {
    this.turns.push({ session, packet, signalAborted: () => signal?.aborted === true });
    const calls = this.h.calls.get(session.role) ?? 0;
    this.h.calls.set(session.role, calls + 1);
    const script = this.h.scripts[session.role] ?? (() => ok());
    return script({ session, packet, signal, call: calls + 1, h: this.h });
  }
  async runTurn(session: Session, packet: DelegationPacket, signal?: AbortSignal): Promise<TurnResult> {
    const out = await this.script(session, packet, signal);
    return (isTurn(out) ? out : { status: "completed", output: out, effectiveProvider: this.provider,
      effectiveModel: "opaque-model", artifactRefs: [] }) as TurnResult;
  }
  /** The Worker is a read-only Change Author: its only output is a proposal Fusion validates and applies. */
  async runChangeProposalTurn(session: Session, request: ChangeProposalRequest, signal?: AbortSignal): Promise<StructuredTurnResult> {
    const out = await this.script(session, request.packet, signal);
    return (isTurn(out) ? out : { status: "completed", output: out, effectiveProvider: this.provider,
      effectiveModel: "opaque-model", artifactRefs: [] }) as StructuredTurnResult;
  }
  async cancel(): Promise<void> { this.cancels++; }
  async usage() { return null; }
  async close(): Promise<void> { this.closes++; }
}
const isTurn = (value: unknown): boolean => value !== null && typeof value === "object" && "status" in value && "effectiveProvider" in value;

/** In-memory candidate port: every acquisition is a new candidate outside the primary; it records what Fusion asked of it. */
class FakeWorkspace implements WorkspacePort {
  readonly primaryRoot = PRIMARY;
  readonly leaseRoot = CANDIDATES;
  readonly acquired: WorkspaceHandle[] = [];
  readonly released: string[] = [];
  readonly applied = new Map<string, ChangeSet>();
  readonly changes = new Map<string, string[]>();
  primaryVersion = 0;
  leaseVersion = 0;
  acquireOverride?: (ownerId: string) => Promise<WorkspaceHandle>;
  /** Paths whose SHA-256 precondition fails, per attempt (1-based acquisition index). */
  stale?: (attempt: number) => readonly string[];
  changedOverride?: (handle: WorkspaceHandle) => readonly string[];
  releaseResult?: (handle: WorkspaceHandle) => CleanupReport;
  constructor(private readonly verifier: FakeVerifier) {}
  async acquire(ownerId: string): Promise<WorkspaceHandle> {
    if (this.acquireOverride) return this.acquireOverride(ownerId);
    const handle = { leaseId: `candidate-${this.acquired.length + 1}`, ownerId, path: join(CANDIDATES, `candidate-${this.acquired.length + 1}`) };
    this.acquired.push(handle);
    return handle;
  }
  async apply(handle: WorkspaceHandle, changes: ChangeSet, _scope: ChangeScope): Promise<ApplicationOutcome> {
    const stale = this.stale?.(this.acquired.findIndex(h => h.leaseId === handle.leaseId) + 1) ?? [];
    if (stale.length > 0) return { preconditionFailed: stale };
    this.applied.set(handle.leaseId, changes);
    this.changes.set(handle.leaseId, changes.operations.map(op => op.path));
    return { applied: changes.operations.map(op => op.kind === "delete"
      ? { kind: op.kind, path: op.path, beforeSha256: op.expectedSha256, afterSha256: null, bytes: 0 }
      : { kind: op.kind, path: op.path, beforeSha256: op.expectedSha256, afterSha256: sha(op.content), bytes: Buffer.byteLength(op.content) }) };
  }
  async changedPaths(handle: WorkspaceHandle): Promise<readonly string[]> {
    return this.changedOverride?.(handle) ?? this.changes.get(handle.leaseId) ?? [];
  }
  async fingerprint(handle: WorkspaceHandle | undefined): Promise<string> {
    return handle === undefined ? `primary-${this.primaryVersion}` : `${handle.leaseId}-${this.leaseVersion}`;
  }
  async diff(handle: WorkspaceHandle): Promise<{ text: string; truncated: boolean }> {
    return { text: (this.changes.get(handle.leaseId) ?? []).map(path => `diff --git a/${path} b/${path}\n`).join(""), truncated: false };
  }
  /** Stands in for confined verification: the fake verifier sees the candidate path, never the primary. */
  async verify(handle: WorkspaceHandle, plan: VerificationPlan): Promise<VerificationVerdict> { return this.verifier.verify(plan, handle.path); }
  async release(handle: WorkspaceHandle): Promise<CleanupReport> {
    this.released.push(handle.leaseId);
    return this.releaseResult?.(handle) ?? { complete: true };
  }
}

class FakeVerifier implements VerifierPort {
  readonly calls: Array<{ root: string; commands: number }> = [];
  hook?: () => void;
  constructor(private readonly verdicts: VerificationVerdict[] = []) {}
  async verify(plan: VerificationPlan, root: string): Promise<VerificationVerdict> {
    this.calls.push({ root, commands: plan.commands.length });
    this.hook?.();
    return this.verdicts.shift() ?? { passed: true, commandsRun: plan.commands.length };
  }
}
class RecordingSink implements EventSink {
  readonly events: WorkflowEvent[] = [];
  async append(event: WorkflowEvent): Promise<void> { this.events.push(structuredClone(event)); }
}

const ok = (patch: Partial<ResultPacket> = {}): ResultPacket => ({ result: { status: "completed" },
  changes: { files: [], summary: "done" }, verification: { testsRun: [], results: [] }, uncertainties: [], failures: [],
  needsLeadDecision: [], ...patch });
const failedVerdict = (command = "unit"): VerificationVerdict => ({ passed: false, commandsRun: 1, failedCommand: command,
  failure: { kind: "VerificationFailure", safeMessage: "Verification failed.", retryable: false } });
const proposal = (paths: readonly string[]): ChangeSet => ({ schemaVersion: 1,
  operations: paths.map(path => ({ kind: "writeText" as const, path, expectedSha256: null, content: `implemented ${path}\n` })) });

interface Harness {
  engine: WorkflowEngine;
  workspace: FakeWorkspace;
  verifier: FakeVerifier;
  sink: RecordingSink;
  reader: FakeAdapter;
  writer: FakeAdapter;
  scripts: Partial<Record<AgentRole, Script>>;
  calls: Map<AgentRole, number>;
  sessionOverride?: (session: Session) => Session | undefined;
}
interface HarnessOptions {
  verdicts?: VerificationVerdict[];
  scripts?: Partial<Record<AgentRole, Script>>;
  ids?: { provider: string; model: string };
  writerWrite?: boolean | "unknown";
  extraRoles?: (h: Harness) => RoleCandidate[];
}
/** Default Worker: proposes exactly the files it was allowed to change. */
const writeAllowed: Script = ({ packet }) => proposal(packet.scope.allowedFiles);
function harness(options: HarnessOptions = {}): Harness {
  const ids = options.ids ?? { provider: "provider-one", model: "model-one" };
  const model: ModelProfile = { id: ids.model, effort: "high" };
  const verifier = new FakeVerifier(options.verdicts);
  const h = { workspace: new FakeWorkspace(verifier), verifier, sink: new RecordingSink(),
    scripts: { Lead: () => ok({ changes: { files: [], summary: "Plan: change a then b." } }), Worker: writeAllowed, ...options.scripts },
    calls: new Map<AgentRole, number>() } as Omit<Harness, "engine" | "reader" | "writer"> as Harness;
  h.reader = new FakeAdapter(ids.provider, "read-transport", capabilitySnapshot(ids.provider, "read-transport", false), h);
  h.writer = new FakeAdapter(ids.provider, "write-transport",
    capabilitySnapshot(ids.provider, "write-transport", options.writerWrite ?? false), h);
  const binding = (role: AgentRole, transport: string): RoleBinding =>
    ({ role, provider: ids.provider, transport, model, requires: { structuredOutput: true } });
  const roles: RoleCandidate[] = [...(options.extraRoles?.(h) ?? []),
    { binding: binding("Lead", "read-transport"), adapter: h.reader },
    { binding: binding("Explorer", "read-transport"), adapter: h.reader },
    { binding: binding("Worker", "write-transport"), adapter: h.writer }];
  h.engine = new WorkflowEngine({ roles, workspace: h.workspace, verifier: h.verifier, events: h.sink });
  return h;
}

const unitPlan: VerificationPlan = { commands: [{ id: "unit", executable: resolve("/fake/bin/node.exe"), args: ["test.js"],
  cwd: ".", timeoutMs: 10_000, mutationPolicy: "readOnly" }] };
const packetFor = (allowed: readonly string[], forbidden: readonly string[] = []): DelegationPacket => ({
  task: { goal: "Fix the helper.", constraints: ["Keep the public API."], acceptanceCriteria: ["Unit tests pass."] },
  scope: { relevantFiles: [...allowed], allowedFiles: [...allowed], forbiddenFiles: [...forbidden] },
  architecture: { decisions: ["Use the existing formatter."], invariants: ["No new dependencies."] },
  verification: { requiredTests: ["unit"] }, openQuestions: [] });
const lowTask: TaskRequest = { operation: "edit", summary: "Fix the date formatting helper.", paths: ["src/util/format.ts"],
  scopeKnown: true, expectedMutation: "singleFile", requestedCapabilities: { write: true },
  verification: { required: true, planProvided: true } };
const mediumTask: TaskRequest = { ...lowTask, operation: "implement", summary: "Add a formatter option.",
  paths: ["src/a.ts", "src/b.ts"], expectedMutation: "multiFile" };
const highTask: TaskRequest = { ...mediumTask, indicators: { architectureChange: true } };
const criticalTask: TaskRequest = { ...mediumTask, indicators: { irreversible: true } };
const readTask: TaskRequest = { operation: "analyze", summary: "Explain the parser.", paths: ["src/parser.ts"], scopeKnown: true,
  expectedMutation: "none", requestedCapabilities: {}, verification: { required: false, planProvided: false } };

let runs = 0;
function request(task: TaskRequest, patch: Partial<WorkflowRequest> = {}): WorkflowRequest {
  const packet = packetFor(task.expectedMutation === "none" ? [] : task.paths);
  return { runId: `run-${++runs}`, task, packet, verification: task.verification.planProvided ? unitPlan : { commands: [] }, ...patch };
}
const path = (result: WorkflowResult): string[] => result.transitions.map(t => `${t.from}>${t.to}:${t.reason}`);
const riskLevels = (h: Harness): string[] => h.sink.events.flatMap(e => e.type === "risk" ? [e.level] : []);
const allSessions = (h: Harness): Session[] => [...h.reader.sessions, ...h.writer.sessions];

// ---------------------------------------------------------------------------------------------------------------

test("O3 LOW: inspect → risk gate → read-only Change Author → host-applied candidate → confined verification → completed", async () => {
  const h = harness();
  const result = await h.engine.run(request(lowTask));
  assert.equal(result.state, "completed", JSON.stringify(result.error));
  assert.deepEqual(path(result), ["received>inspected:taskInspected", "inspected>routed:bindingsResolved",
    "routed>leased:leaseAcquired", "leased>delegating:delegated", "delegating>verifying:verificationStarted",
    "verifying>completed:succeeded"]);
  assert.equal(result.risk?.level, "low");
  assert.equal(result.delegateAttempts, 1);
  assert.equal(h.reader.sessions.length, 0, "a low-risk flow runs exactly one role");
  const [worker] = h.writer.sessions;
  assert.deepEqual([worker?.role, worker?.posture, worker?.workspaceLeaseId], ["Worker", "readOnly", result.lease?.leaseId],
    "the Worker never holds a writable posture");
  assert.deepEqual(h.verifier.calls, [{ root: result.lease?.path, commands: 1 }], "the candidate, never the primary, is verified");
  assert.deepEqual(result.changedPaths, ["src/util/format.ts"]);
  assert.deepEqual(result.applied?.map(op => [op.kind, op.path]), [["writeText", "src/util/format.ts"]]);
  assert.equal(result.changeSet?.operations.length, 1);
  assert.deepEqual(result.cleanup, { candidates: 1, released: 1, complete: true });
  assert.deepEqual(h.workspace.released, [result.lease?.leaseId], "the candidate is discarded before the result is returned");
  assert.equal(h.writer.closes, 1);
  assert.match(result.result?.changes.summary ?? "", /^Fusion host-applied 1 operation\(s\) to 1 file\(s\)/u,
    "the delegate result is Fusion's own account, never a model self-report");

  const read = harness();
  const answered = await read.engine.run(request(readTask));
  assert.equal(answered.state, "answered", "a read-only task with nothing to verify is answered, never completed");
  assert.deepEqual(path(answered).slice(2), ["routed>delegating:delegated", "delegating>answered:answeredWithoutVerification"]);
  assert.deepEqual(read.reader.sessions.map(s => [s.role, s.posture, s.workspaceLeaseId]), [["Explorer", "readOnly", PRIMARY_WORKSPACE]]);
  assert.equal(read.writer.sessions.length + read.workspace.acquired.length + read.verifier.calls.length, 0);
  assert.equal(answered.cleanup, undefined);
});

test("O3 LOW: a verifier failure fails the workflow, escalates risk, and is not retried", async () => {
  const h = harness({ verdicts: [failedVerdict()] });
  const result = await h.engine.run(request(lowTask));
  assert.equal(result.state, "failed");
  assert.equal(result.error?.kind, "VerificationFailure");
  assert.equal(result.transitions.at(-1)?.reason, "verificationFailed");
  assert.equal(result.risk?.level, "high");
  assert.ok(result.risk?.decisive.includes("verificationFailed"));
  assert.equal(h.calls.get("Worker"), 1);
  assert.deepEqual(result.cleanup, { candidates: 1, released: 1, complete: true }, "a failed candidate is discarded too");
});

test("O3 MEDIUM: Lead plan → bounded Change Author → host-applied candidate → verification → Lead review → completed", async () => {
  const h = harness();
  const result = await h.engine.run(request(mediumTask));
  assert.equal(result.state, "completed", JSON.stringify(result.error));
  assert.deepEqual(path(result), ["received>inspected:taskInspected", "inspected>routed:bindingsResolved",
    "routed>planning:planRequested", "planning>leased:leaseAcquired", "leased>delegating:delegated",
    "delegating>verifying:verificationStarted", "verifying>reviewing:reviewRequested", "reviewing>completed:succeeded"]);
  assert.deepEqual(result.transitions.filter(t => t.role).map(t => [t.role, t.attempt]),
    [["Lead", undefined], ["Worker", 1], ["Lead", undefined]]);
  assert.deepEqual(h.reader.sessions.map(s => [s.role, s.posture, s.workspaceLeaseId]),
    [["Lead", "readOnly", PRIMARY_WORKSPACE], ["Lead", "readOnly", result.lease?.leaseId]]);
  // Structured packets only: the Worker sees the Lead's bounded plan field, the Lead sees Fusion-observed facts.
  const workerPacket = h.writer.turns[0]!.packet;
  assert.ok(workerPacket.architecture.decisions.includes("Lead plan: Plan: change a then b."));
  const review = h.reader.turns[1]!.packet;
  assert.deepEqual(review.scope.relevantFiles, ["src/a.ts", "src/b.ts"]);
  assert.ok(review.task.constraints.some(c => c === "Fusion verification passed for: unit"));
  assert.ok(review.architecture.decisions.some(d => d.includes("Fusion host-applied 2 operation(s) to 2 file(s)")));
  for (const turn of [...h.reader.turns, ...h.writer.turns])
    assert.deepEqual(Object.keys(turn.packet).sort(), ["architecture", "openQuestions", "scope", "task", "verification"]);
  assert.equal(result.plan?.changes.summary, "Plan: change a then b.");
});

test("O3 a writer never runs without a valid candidate of its own", async () => {
  const h = harness();
  h.workspace.acquireOverride = async () => { throw new Error("git clone failed"); };
  const result = await h.engine.run(request(mediumTask));
  assert.equal(result.state, "failed");
  assert.equal(result.transitions.at(-1)?.reason, "workspaceFailure");
  assert.equal(result.error?.kind, "InternalError");
  assert.equal(h.writer.sessions.length, 0, "no Worker session may exist without a candidate");

  const foreign = harness();
  foreign.workspace.acquireOverride = async () => ({ leaseId: "candidate-x", ownerId: "someone-else", path: join(CANDIDATES, "x") });
  const stolen = await foreign.engine.run(request(lowTask));
  assert.deepEqual([stolen.state, stolen.error?.kind], ["failed", "WorkspaceConflict"]);
  assert.equal(foreign.writer.sessions.length, 0);
  assert.equal(stolen.lease, undefined, "a refused handle is never reported as this run's candidate");

  const mismatched = harness();
  mismatched.sessionOverride = session => session.role === "Worker" ? { ...session, workspaceLeaseId: PRIMARY_WORKSPACE } : undefined;
  const swapped = await mismatched.engine.run(request(lowTask));
  assert.deepEqual([swapped.state, swapped.error?.kind], ["failed", "SecurityViolation"]);
  assert.equal(mismatched.writer.turns.length, 0, "a session bound to the wrong workspace never receives a turn");
  assert.deepEqual(mismatched.workspace.released, ["candidate-1"], "the unused candidate is still discarded");
  const writerPosture = harness();
  writerPosture.sessionOverride = session => session.role === "Worker" ? { ...session, posture: "writer" } : undefined;
  const escalated = await writerPosture.engine.run(request(lowTask));
  assert.deepEqual([escalated.state, escalated.error?.kind], ["failed", "SecurityViolation"], "a session claiming a writer posture is refused");
  assert.equal(writerPosture.writer.turns.length, 0);
});

test("O3 the primary workspace is never assigned to an autonomous writer", async () => {
  for (const handle of [{ leaseId: "candidate-p", path: PRIMARY }, { leaseId: "candidate-q", path: resolve(PRIMARY, "..") },
    { leaseId: "candidate-s", path: join(PRIMARY, "src") }, { leaseId: "candidate-t", path: CANDIDATES },
    { leaseId: PRIMARY_WORKSPACE, path: join(CANDIDATES, "w") }, { leaseId: "candidate-r", path: PRIMARY.toUpperCase() },
    { leaseId: "candidate-u", path: join(PRIMARY, ".fusion", "candidates", "u") }]) {
    if (handle.path === PRIMARY.toUpperCase() && process.platform !== "win32") continue;
    const h = harness();
    h.workspace.acquireOverride = async ownerId => ({ ...handle, ownerId });
    const result = await h.engine.run(request(lowTask));
    assert.deepEqual([result.state, result.error?.kind, result.transitions.at(-1)?.reason],
      ["failed", "SecurityViolation", "securityViolation"], handle.path);
    assert.equal(h.writer.sessions.length, 0);
    assert.equal(result.lease, undefined);
    assert.deepEqual(h.workspace.released, [], "a refused handle is never handed back to the port, even to release it");
  }
  const h = harness();
  await h.engine.run(request(mediumTask));
  assert.ok(allSessions(h).every(s => s.posture === "readOnly"), "no role ever holds a writable posture");

  // A Change Author that reaches outside its turn into the primary is detected and stops the workflow.
  const escape = harness({ scripts: { Worker: ctx => { ctx.h.workspace.primaryVersion++; return writeAllowed(ctx); } } });
  const escaped = await escape.engine.run(request(mediumTask));
  assert.deepEqual([escaped.state, escaped.error?.kind, escaped.risk?.level], ["failed", "SecurityViolation", "critical"]);
  assert.equal(escape.verifier.calls.length, 0);
  assert.equal(escape.workspace.applied.size, 0, "nothing is host-applied after a violation");
  // Likewise a Change Author that writes into its (read-only) candidate.
  const candidate = harness({ scripts: { Worker: ctx => { ctx.h.workspace.leaseVersion++; return writeAllowed(ctx); } } });
  const written = await candidate.engine.run(request(mediumTask));
  assert.deepEqual([written.state, written.error?.kind], ["failed", "SecurityViolation"]);
  assert.equal(candidate.workspace.applied.size, 0);
  // Likewise a read-only role that changes the primary.
  const lead = harness({ scripts: { Lead: ctx => { ctx.h.workspace.primaryVersion++; return ok(); } } });
  const leaked = await lead.engine.run(request(mediumTask));
  assert.deepEqual([leaked.state, leaked.error?.kind], ["failed", "SecurityViolation"]);
  assert.equal(lead.workspace.acquired.length, 0);
});

test("O3 verification failure prevents success; nothing a Worker says counts as a check", async () => {
  const h = harness({ verdicts: [failedVerdict(), failedVerdict()] });
  const result = await h.engine.run(request(mediumTask));
  assert.equal(result.state, "decisionRequired");
  assert.equal(result.transitions.at(-1)?.reason, "retryExhausted");
  assert.equal(result.error?.kind, "VerificationFailure");
  assert.ok(!result.transitions.some(t => t.to === "completed" || t.to === "reviewing"));
  assert.deepEqual(result.cleanup, { candidates: 2, released: 2, complete: true });

  // A Change Author cannot attach claims: anything beside the ChangeSet is a malformed proposal.
  const claims = harness({ scripts: { Worker: ctx => ({ ...proposal(ctx.packet.scope.allowedFiles),
    verification: { testsRun: ["unit"], results: ["all 42 tests passed"] } }) } });
  const claimed = await claims.engine.run(request(mediumTask));
  assert.deepEqual([claimed.state, claimed.transitions.at(-1)?.reason], ["failed", "proposalMalformed"]);
  assert.equal(claims.verifier.calls.length, 0);

  // A verifier port that claims a pass without running every planned command is refused.
  const lying = harness({ verdicts: [{ passed: true, commandsRun: 0 }] });
  const refused = await lying.engine.run(request(lowTask));
  assert.deepEqual([refused.state, refused.transitions.at(-1)?.reason], ["failed", "verifierFailure"]);
  // A verifier that cannot run is an infrastructure failure, not a retryable check result.
  const broken = harness({ verdicts: [{ passed: false, commandsRun: 0,
    failure: { kind: "SpawnFailure", safeMessage: "missing", retryable: false } }] });
  const unavailable = await broken.engine.run(request(mediumTask));
  assert.deepEqual([unavailable.state, unavailable.transitions.at(-1)?.reason, broken.calls.get("Worker")],
    ["failed", "verifierFailure", 1]);
});

test("O3 a capability-ineligible binding fails closed with a typed policy failure before any work", async () => {
  for (const write of ["unknown", true] as const) {
    const h = harness({ writerWrite: write });
    const result = await h.engine.run(request(mediumTask));
    assert.deepEqual([result.state, result.error?.kind, result.transitions.at(-1)?.reason],
      ["failed", "CapabilityUnavailable", "policyFailure"], `a Change Author with filesystem.write=${String(write)} is never routed`);
    assert.equal(allSessions(h).length + h.workspace.acquired.length, 0, "routing precedes every turn and candidate");
  }
  const noProposal = harness();
  (noProposal.writer as { runChangeProposalTurn?: unknown }).runChangeProposalTurn = undefined;
  assert.equal((await noProposal.engine.run(request(mediumTask))).error?.kind, "CapabilityUnavailable",
    "an adapter without a change-proposal turn cannot be the Worker");

  // Configuration order is preference order; ineligible candidates are skipped with typed reasons (legacy writer routing).
  const r = harness();
  const bad = (transport: string, write: boolean | "unknown", provider = "provider-one"): RoleCandidate => ({
    binding: { role: "Worker", provider: "provider-one", transport, model: { id: "m", effort: "e" }, requires: { structuredOutput: true } },
    adapter: new FakeAdapter(provider, transport, capabilitySnapshot(provider, transport, write), r) });
  const failing = bad("t0", true);
  (failing.adapter as FakeAdapter).capabilities = async () => { throw new Error("probe"); };
  const needsSandbox: RoleCandidate = { ...bad("t5", true), binding: { ...bad("t5", true).binding, requires: { approvalCallback: true } } };
  const candidates = [failing, bad("t1", "unknown"), bad("t2", true, "other-provider"), bad("t3", false), needsSandbox];
  await assert.rejects(resolveRole("Worker", candidates), (error: unknown) => error instanceof PolicyRoutingFailure &&
    error.error.kind === "CapabilityUnavailable" && JSON.stringify(error.rejections) === JSON.stringify([
      { index: 0, reason: "probeFailed" }, { index: 1, reason: "postureUnmet" }, { index: 2, reason: "identityMismatch" },
      { index: 3, reason: "postureUnmet" }, { index: 4, reason: "requirementUnmet" }]));
  const chosen = await resolveRole("Worker", [...candidates, bad("t6", true)]);
  assert.equal(chosen.binding.transport, "t6");
  const unproven = bad("t8", true);
  const proofless = { ...(unproven.adapter as FakeAdapter).snapshot };
  delete proofless.writerIsolation;
  (unproven.adapter as FakeAdapter).snapshot = proofless;
  await assert.rejects(resolveRole("Worker", [unproven]), (error: unknown) =>
    error instanceof PolicyRoutingFailure && error.rejections[0]?.reason === "postureUnmet",
  "filesystem.write alone never proves a Writer posture");
  await assert.rejects(resolveRole("Reviewer", candidates), (error: unknown) =>
    error instanceof PolicyRoutingFailure && error.rejections.length === 0);
  // A read-only role never binds to a candidate that can write.
  await assert.rejects(resolveRole("Lead", [{ binding: { ...bad("t7", true).binding, role: "Lead" }, adapter: bad("t7", true).adapter }]),
    PolicyRoutingFailure);
});

test("O3 a Change Author has no decision or status channel: a failed turn stops typed, a packet is malformed", async () => {
  const failing = harness({ scripts: { Worker: ({ session }) => ({ status: "failed", effectiveProvider: session.provider,
    artifactRefs: [], error: { kind: "ProcessFailure", safeMessage: "the provider crashed", retryable: false } }) } });
  const crashed = await failing.engine.run(request(mediumTask));
  assert.deepEqual([crashed.state, crashed.error?.kind, crashed.transitions.at(-1)?.reason], ["failed", "ProcessFailure", "providerFailure"]);
  assert.deepEqual([failing.verifier.calls.length, failing.calls.get("Worker")], [0, 1]);
  const decision = harness({ scripts: { Worker: () => ok({ needsLeadDecision: ["Should the option be public?"] }) } });
  const asked = await decision.engine.run(request(mediumTask));
  assert.deepEqual([asked.state, asked.transitions.at(-1)?.reason, asked.error?.kind], ["failed", "proposalMalformed", "MalformedOutput"],
    "a ResultPacket is not a ChangeSet");
  assert.equal(decision.verifier.calls.length, 0);
});

test("O3 one targeted Worker retry in a fresh candidate, then a decision; never a third attempt", async () => {
  const h = harness();
  h.workspace.stale = () => ["src/a.ts"];
  const result = await h.engine.run(request(mediumTask));
  assert.deepEqual([result.state, result.transitions.at(-1)?.reason, result.delegateAttempts], ["decisionRequired", "retryExhausted", 2]);
  assert.equal(result.error?.kind, "WorkspaceConflict");
  assert.equal(h.calls.get("Worker"), 2);
  const retry = h.writer.turns[1]!.packet;
  assert.ok(retry.task.constraints.includes("Attempt 2 of 2: the proposed file hashes did not match the committed baseline for 1 file(s): src/a.ts."));
  assert.ok(retry.task.constraints.includes(FRESH_CANDIDATE_CONSTRAINT));
  assert.deepEqual(retry.openQuestions, [], "only Fusion's own structured facts carry over, never Worker text");
  assert.equal(h.writer.sessions.length, 2, "each attempt is a fresh session");
  assert.deepEqual(h.writer.sessions.map(s => s.workspaceLeaseId), ["candidate-1", "candidate-2"], "each attempt is a fresh candidate");
  assert.deepEqual(h.workspace.released, ["candidate-1", "candidate-2"], "one candidate at a time: the first is gone before the second exists");
  assert.equal(h.workspace.applied.size, 0, "a stale proposal is never applied");
  assert.equal(h.verifier.calls.length, 0);

  const v = harness({ verdicts: [failedVerdict("lint"), failedVerdict("lint"), failedVerdict("lint")] });
  const verified = await v.engine.run(request(mediumTask));
  assert.equal(verified.state, "decisionRequired");
  assert.deepEqual([v.calls.get("Worker"), v.verifier.calls.length], [2, 2], "no third attempt and no third verification");
  assert.ok(v.writer.turns[1]!.packet.task.constraints.includes("Attempt 2 of 2: Fusion verification command lint did not pass."));
  assert.deepEqual(path(verified).filter(p => p.includes("retrying")), ["verifying>retrying:verificationFailed", "retrying>leased:leaseAcquired"]);
  assert.notEqual(v.verifier.calls[0]!.root, v.verifier.calls[1]!.root, "the correction is verified in a new candidate");

  const low = harness();
  low.workspace.stale = () => ["src/util/format.ts"];
  const single = await low.engine.run(request(lowTask));
  assert.deepEqual([single.state, single.transitions.at(-1)?.reason, low.calls.get("Worker")], ["decisionRequired", "applicationRejected", 1],
    "a low-risk flow gets no retry");
});

test("O3 risk escalation is monotonic: a retried pass is not auto-completed and nothing lowers the level", async () => {
  const h = harness({ verdicts: [failedVerdict()] });
  const result = await h.engine.run(request(mediumTask));
  assert.equal(result.state, "reviewRequired", "a pass after a verifier failure still carries the escalated risk");
  assert.equal(result.pendingStage, "freshReviewAndAdjudication");
  assert.deepEqual(riskLevels(h), ["medium", "high"]);
  const revisions = h.sink.events.flatMap(e => e.type === "risk" ? [e.revision] : []);
  assert.deepEqual(revisions, [0, 1]);
  assert.deepEqual(result.risk?.signals.map(s => s.code).sort(), ["multiFileWriteScope", "verificationFailed"],
    "escalation adds facts; it never re-assesses from scratch or drops the task's own signals");
  assert.equal(h.calls.get("Lead"), 1, "no Lead review can approve an escalated result");
  for (const [task, floor] of [[lowTask, "low"], [mediumTask, "medium"], [highTask, "high"], [criticalTask, "critical"]] as const) {
    const run = harness();
    const outcome = await run.engine.run(request(task));
    assert.ok(riskRank(outcome.risk!.level) >= riskRank(floor), `${floor} was lowered to ${outcome.risk?.level}`);
    const levels = riskLevels(run);
    for (let i = 1; i < levels.length; i++) assert.ok(riskRank(levels[i] as never) >= riskRank(levels[i - 1] as never));
  }
});

test("O3 a proposal outside its scope is refused before any mutation and escalates risk", async () => {
  const h = harness({ scripts: { Worker: () => proposal(["src/a.ts", "src/b.ts", "src/c.ts"]) } });
  const result = await h.engine.run(request(mediumTask));
  assert.deepEqual([result.state, result.transitions.at(-1)?.reason, result.risk?.level, result.error?.kind],
    ["failed", "proposalRejected", "high", "SecurityViolation"]);
  assert.ok(result.risk?.decisive.includes("unexpectedScope"));
  assert.equal(h.verifier.calls.length + h.workspace.applied.size, 0);
  assert.equal(result.changeSet, undefined);

  const secret = harness({ scripts: { Worker: () => proposal([".env"]) } });
  assert.equal((await secret.engine.run(request(lowTask))).risk?.level, "critical");
  const traversal = harness({ scripts: { Worker: () => proposal(["../outside.ts"]) } });
  const escaped = await traversal.engine.run(request(lowTask));
  assert.deepEqual([escaped.state, escaped.risk?.level], ["failed", "critical"]);
  assert.ok(escaped.risk?.decisive.includes("proposalPathViolation"));

  // Forbidden files override allowed ones, and a packet may not widen the inspected scope.
  const forbidden = harness();
  const blocked = await forbidden.engine.run(request(mediumTask, { packet: packetFor(["src/a.ts", "src/b.ts"], ["SRC\\b.ts"]) }));
  assert.deepEqual([blocked.state, blocked.transitions.at(-1)?.reason], ["failed", "proposalRejected"]);
  assert.equal(forbidden.workspace.applied.size, 0);
  const widened = await harness().engine.run(request(mediumTask, { packet: packetFor(["src/a.ts", "src/b.ts", "src/secret.ts"]) }));
  assert.deepEqual([widened.state, widened.error?.kind], ["failed", "InvalidInput"]);

  // Fusion observes the candidate rather than trusting its port: a change beyond the applied ChangeSet is a violation.
  const lying = harness();
  lying.workspace.changedOverride = handle => [...(lying.workspace.changes.get(handle.leaseId) ?? []), "src/extra.ts"];
  const extra = await lying.engine.run(request(mediumTask));
  assert.deepEqual([extra.state, extra.error?.kind], ["failed", "SecurityViolation"]);
  assert.equal(lying.verifier.calls.length, 0);
});

test("O3 workflow and routing logic contain no provider or model names", async () => {
  const forbidden = /claude|muse|anthropic|\bmeta\b|opus|spark|\bgpt|gemini|openai|llama|sonnet|haiku/iu;
  const roots = [join(process.cwd(), "src", "core", "workflow"), join(process.cwd(), "src", "core", "policy")];
  let scanned = 0;
  for (const dir of roots) for (const name of await readdir(dir)) {
    if (!name.endsWith(".ts")) continue;
    assert.doesNotMatch(await readFile(join(dir, name), "utf8"), forbidden, name);
    scanned++;
  }
  assert.ok(scanned >= 7);
  // Behavioral neutrality: swapping every provider/model identity leaves the workflow bit-for-bit identical. Identities
  // appear only as recorded provenance of who served each turn.
  const a = harness({ ids: { provider: "alpha", model: "alpha-large" } });
  const b = harness({ ids: { provider: "zeta-other", model: "z-9" } });
  const ra = await a.engine.run({ ...request(mediumTask), runId: "same-run" });
  const rb = await b.engine.run({ ...request(mediumTask), runId: "same-run" });
  assert.deepEqual(ra.transitions, rb.transitions);
  const anonymous = (events: WorkflowEvent[]) => events.map(event => event.type === "turn" || event.type === "structuredTurn"
    ? { ...event, provenance: { ...event.provenance, provider: "P", requestedModel: "M", sessionId: "S" } } : event);
  assert.deepEqual(anonymous(a.sink.events), anonymous(b.sink.events));
  assert.doesNotMatch(JSON.stringify(anonymous(a.sink.events).filter(e => e.type !== "turn" && e.type !== "structuredTurn")),
    /alpha|large|read-transport|write-transport|fusion-o3-fake/u, "only provenance events carry provider, model or transport identities");
  assert.doesNotMatch(JSON.stringify(a.sink.events), /fusion-o3-fake|candidates/u, "no event carries a candidate path");
});

test("O3 cancellation propagates to the in-flight turn and ends the workflow as cancelled", async () => {
  const controller = new AbortController();
  let seen: AbortSignal | undefined;
  const h = harness({ scripts: { Worker: ({ signal }) => { seen = signal; controller.abort(); return new Promise(() => undefined); } } });
  const result = await h.engine.run(request(mediumTask, { signal: controller.signal }));
  assert.deepEqual([result.state, result.error?.kind, result.transitions.at(-1)?.reason], ["cancelled", "Cancelled", "cancelled"]);
  assert.equal(seen?.aborted, true, "the adapter received the aborted signal");
  assert.equal(h.writer.cancels, 1);
  assert.equal(h.writer.closes, 1);
  assert.equal(h.verifier.calls.length, 0);
  assert.deepEqual(result.cleanup, { candidates: 1, released: 1, complete: true }, "a cancelled run still discards its candidate");

  const early = new AbortController();
  early.abort();
  const pre = harness();
  const none = await pre.engine.run(request(mediumTask, { signal: early.signal }));
  assert.deepEqual([none.state, path(none)], ["cancelled", ["received>cancelled:cancelled"]]);
  assert.equal(allSessions(pre).length, 0);
});

test("O3 timeouts propagate: a workflow deadline and a provider timeout both end as Timeout", async () => {
  let seen: AbortSignal | undefined;
  const h = harness({ scripts: { Worker: ({ signal }) => { seen = signal; return new Promise(() => undefined); } } });
  const result = await h.engine.run(request(mediumTask, { timeoutMs: 50 }));
  assert.deepEqual([result.state, result.error?.kind, result.error?.retryable, result.transitions.at(-1)?.reason],
    ["failed", "Timeout", true, "timedOut"]);
  assert.equal(seen?.aborted, true);
  assert.equal(h.writer.cancels, 1);

  const provider = harness({ scripts: { Worker: ({ session }) => ({ status: "failed", effectiveProvider: session.provider,
    effectiveModel: "m", artifactRefs: [], error: { kind: "Timeout", safeMessage: "turn timed out", retryable: true } }) } });
  const timedOut = await provider.engine.run(request(mediumTask));
  assert.deepEqual([timedOut.state, timedOut.error?.kind, timedOut.transitions.at(-1)?.reason], ["failed", "Timeout", "timedOut"]);
  assert.equal(provider.calls.get("Worker"), 1, "infrastructure failures are not retried as task failures");
});

test("O3 event ordering is deterministic and mirrors the recorded transitions", async () => {
  const runOnce = async () => {
    const h = harness({ verdicts: [failedVerdict()] });
    const result = await h.engine.run({ ...request(mediumTask), runId: "fixed-run" });
    return { h, result };
  };
  const first = await runOnce(), second = await runOnce();
  assert.deepEqual(first.h.sink.events, second.h.sink.events);
  assert.deepEqual(first.result.transitions, second.result.transitions);
  const transitions = first.h.sink.events.flatMap(e => e.type === "transition" ? [e.transition] : []);
  assert.deepEqual(transitions, first.result.transitions);
  for (let i = 1; i < transitions.length; i++) assert.equal(transitions[i]!.from, transitions[i - 1]!.to);
  assert.deepEqual(first.h.sink.events.slice(0, 2).map(e => e.type), ["transition", "risk"]);
  // Each attempt's candidate lifecycle is recorded, in order, before the terminal transition.
  const lifecycle = first.h.sink.events.flatMap(e => e.type === "candidate" ? [`${e.attempt}:${e.phase}`]
    : e.type === "proposal" ? [`${e.attempt}:proposal-${e.outcome}`] : e.type === "verification" ? [`${e.attempt}:verified-${e.passed}`] : []);
  assert.deepEqual(lifecycle, ["1:created", "1:proposal-validated", "1:applied", "1:verified-false", "1:released",
    "2:created", "2:proposal-validated", "2:applied", "2:verified-true", "2:released"]);
  // A sink failure stops the workflow rather than letting state run ahead of the log.
  const broken = harness();
  let appended = 0;
  (broken.sink as { append: EventSink["append"] }).append = async () => { if (++appended === 3) throw new Error("disk full"); };
  const stopped = await broken.engine.run(request(mediumTask));
  assert.deepEqual([stopped.state, stopped.error?.kind], ["failed", "InternalError"]);
  assert.equal(broken.writer.sessions.length, 0);
  // A security violation is never masked by a failing event log.
  const masked = harness({ scripts: { Worker: ctx => { ctx.h.workspace.primaryVersion++; return writeAllowed(ctx); } } });
  let count = 0;
  (masked.sink as { append: EventSink["append"] }).append = async event => { if (event.type === "risk" && ++count === 2) throw new Error("disk full"); };
  const violation = await masked.engine.run(request(mediumTask));
  assert.deepEqual([violation.state, violation.error?.kind, violation.risk?.level], ["failed", "SecurityViolation", "critical"]);
  // A release that cannot be recorded never lets the run finish as a success.
  const release = harness();
  (release.sink as { append: EventSink["append"] }).append = async event => {
    if (event.type === "candidate" && event.phase === "released") throw new Error("disk full"); };
  const unrecorded = await release.engine.run(request(mediumTask));
  assert.deepEqual([unrecorded.state, unrecorded.error?.kind], ["failed", "InternalError"]);
});

test("O3 two concurrent writers can never share one candidate", async () => {
  const shared = { leaseId: "candidate-shared", path: join(CANDIDATES, "shared") };
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  let started!: () => void;
  const running = new Promise<void>(done => { started = done; });
  const first = harness({ scripts: { Worker: async ctx => { started(); await gate; return writeAllowed(ctx); } } });
  const second = harness();
  first.workspace.acquireOverride = async ownerId => ({ ...shared, ownerId });
  second.workspace.acquireOverride = async ownerId => ({ ...shared, leaseId: "candidate-other", ownerId });
  const a = first.engine.run(request(mediumTask));
  await running;
  const b = await second.engine.run(request(mediumTask));
  assert.deepEqual([b.state, b.error?.kind, b.transitions.at(-1)?.reason], ["failed", "WorkspaceConflict", "workspaceFailure"]);
  assert.equal(second.writer.sessions.length, 0);
  release();
  assert.equal((await a).state, "completed");
  // Once the first workflow released its candidate, its claim is gone.
  const third = harness();
  third.workspace.acquireOverride = async ownerId => ({ ...shared, ownerId });
  assert.equal((await third.engine.run(request(mediumTask))).state, "completed");
});

test("O3 HIGH without an eligible fresh Reviewer fails closed before any work (O4 runs the review itself)", async () => {
  const h = harness();
  const result = await h.engine.run(request(highTask, { explore: true }));
  assert.deepEqual([result.state, result.error?.kind, result.transitions.at(-1)?.reason],
    ["failed", "CapabilityUnavailable", "policyFailure"]);
  assert.equal(allSessions(h).length + h.workspace.acquired.length + h.verifier.calls.length, 0,
    "no plan, candidate, writer or verification when the required review cannot happen");
  assert.ok(!result.transitions.some(t => t.to === "completed" || t.to === "reviewRequired"));
});

test("O3 CRITICAL stops at the human gate before any autonomous writer", async () => {
  const h = harness();
  const result = await h.engine.run(request(criticalTask));
  assert.deepEqual([result.state, result.pendingStage, path(result).at(-1)],
    ["humanGateRequired", "humanGate", "planning>humanGateRequired:humanGateRequiredForRisk"]);
  assert.equal(result.risk?.level, "critical");
  assert.equal(h.writer.sessions.length + h.workspace.acquired.length + h.verifier.calls.length, 0);
  assert.deepEqual(h.reader.sessions.map(s => s.role), ["Lead"], "the Lead owns the architecture for the human gate");
});

test("O3 malformed proposals and turn results fail closed without retry", async () => {
  const valid = proposal(["src/a.ts", "src/b.ts"]);
  const op = valid.operations[0]!;
  const cases: Array<[Script, string]> = [
    [() => ({ schemaVersion: 1 }), "proposalMalformed"],
    [() => ({ ...valid, rationale: "because" }), "proposalMalformed"],
    [() => ({ schemaVersion: 2, operations: valid.operations }), "proposalMalformed"],
    [() => ({ schemaVersion: 1, operations: [{ ...op, kind: "chmod" }] }), "proposalMalformed"],
    [() => ({ schemaVersion: 1, operations: [{ ...op, extra: true }] }), "proposalMalformed"],
    [() => ({ schemaVersion: 1, operations: [] }), "proposalMalformed"],
    [() => ({ schemaVersion: 1, operations: Array.from({ length: 33 }, () => op) }), "proposalMalformed"],
    [() => ({ schemaVersion: 1, operations: [{ kind: "delete", path: "src/a.ts", expectedSha256: null }] }), "proposalMalformed"],
    [() => ({ schemaVersion: 1, operations: [{ ...op, expectedSha256: sha(op.kind === "writeText" ? op.content : "") }] }), "proposalMalformed"],
    [() => new Proxy(valid, {}), "proposalMalformed"],
    [() => ({ ...valid, toJSON: () => valid }), "proposalMalformed"],
    [() => null, "proposalMalformed"],
    [({ session }) => ({ status: "weird", effectiveProvider: session.provider }), "malformedResult"],
    [({ session }) => ({ status: "failed", effectiveProvider: session.provider, error: { message: "raw" } }), "malformedResult"],
    [({ session }) => ({ status: "completed", output: valid, effectiveProvider: session.provider }), "malformedResult"],
  ];
  for (const [index, [script, reason]] of cases.entries()) {
    const h = harness({ scripts: { Worker: script } });
    const result = await h.engine.run(request(mediumTask));
    assert.deepEqual([result.state, result.error?.kind, result.transitions.at(-1)?.reason],
      ["failed", "MalformedOutput", reason], `case ${index}`);
    assert.equal(h.calls.get("Worker"), 1);
    assert.equal(h.verifier.calls.length + h.workspace.applied.size, 0);
  }
  const oversized = harness({ scripts: { Worker: () => ({ schemaVersion: 1, operations: [{ ...op, content: "x".repeat(1024 * 1024 + 1) }] }) } });
  assert.deepEqual((await oversized.engine.run(request(mediumTask))).transitions.at(-1)?.reason, "proposalRejected");
  const lead = harness({ scripts: { Lead: () => ({ plan: "free text" }) } });
  assert.equal((await lead.engine.run(request(mediumTask))).error?.kind, "MalformedOutput");
  const identity = harness({ scripts: { Worker: ctx => ({ status: "completed", output: writeAllowed(ctx),
    effectiveProvider: "substituted", effectiveModel: "m", artifactRefs: [] }) } });
  assert.equal((await identity.engine.run(request(mediumTask))).error?.kind, "ProviderIdentityMismatch");
});

test("O3 inconsistent requests are refused before any role runs", async () => {
  const bad: WorkflowRequest[] = [
    request(lowTask, { verification: { commands: [] } }),
    request(readTask, { verification: unitPlan }),
    request({ ...readTask, verification: { required: false, planProvided: true } },
      { verification: { commands: [{ ...unitPlan.commands[0]!, mutationPolicy: "allowMutation" }] } }),
    request(lowTask, { verification: { commands: [{ ...unitPlan.commands[0]!, mutationPolicy: "allowMutation" }] } }),
    request(lowTask, { packet: packetFor(["src\\util\\format.ts"]) }),
    request(lowTask, { packet: packetFor(["./src/util/format.ts"]) }),
    request(lowTask, { packet: packetFor(["src/util/format.ts"], ["src"]) }),
    request(lowTask, { runId: "../escape" }),
    request(lowTask, { timeoutMs: 0 }),
    request(lowTask, { packet: { task: { goal: "x" } } as never }),
    request({ ...lowTask, operation: "hack" as never }),
  ];
  for (const [index, item] of bad.entries()) {
    const h = harness();
    const result = await h.engine.run(item);
    assert.deepEqual([result.state, result.error?.kind], ["failed", "InvalidInput"], `case ${index}`);
    assert.equal(allSessions(h).length + h.workspace.acquired.length, 0);
  }
});

test("O3 a Lead that rejects the reviewed work ends in a decision, not success", async () => {
  const h = harness({ scripts: { Lead: ({ call }) => call === 1 ? ok({ changes: { files: [], summary: "plan" } })
    : ok({ failures: ["The option name conflicts with an existing flag."] }) } });
  const result = await h.engine.run(request(mediumTask));
  assert.deepEqual([result.state, result.transitions.at(-1)?.reason], ["decisionRequired", "leadRejected"]);
  assert.deepEqual(result.cleanup, { candidates: 1, released: 1, complete: true });
  const declined = harness({ scripts: { Lead: () => ok({ result: { status: "blocked" } }) } });
  const stopped = await declined.engine.run(request(mediumTask));
  assert.deepEqual([stopped.state, declined.workspace.acquired.length], ["decisionRequired", 0]);
});

test("O3 what was verified is what is handed on: later candidate changes void the verification", async () => {
  const drift = harness();
  drift.verifier.hook = () => { drift.workspace.leaseVersion++; };
  const moved = await drift.engine.run(request(lowTask));
  assert.deepEqual([moved.state, moved.error?.kind], ["failed", "SecurityViolation"], "verification cannot change the candidate");

  const review = harness({ scripts: { Lead: ({ call, h: hh }) => { if (call === 2) hh.workspace.leaseVersion++; return ok(); } } });
  const edited = await review.engine.run(request(mediumTask));
  assert.deepEqual([edited.state, edited.error?.kind], ["failed", "SecurityViolation"], "the reviewing Lead is read-only on the candidate");
});

test("O3 a proposal that changes nothing is malformed, never a success", async () => {
  const h = harness({ scripts: { Worker: () => ({ schemaVersion: 1, operations: [{ kind: "writeText", path: "src/util/format.ts",
    expectedSha256: sha("same\n"), content: "same\n" }] }) } });
  const result = await h.engine.run(request(lowTask));
  assert.deepEqual([result.state, result.transitions.at(-1)?.reason], ["failed", "proposalMalformed"]);
  assert.equal(h.verifier.calls.length, 0, "a rewrite with identical content is not evidence of any change");
  const nothing = harness();
  nothing.workspace.changedOverride = () => [];
  const unchanged = await nothing.engine.run(request(lowTask));
  assert.deepEqual([unchanged.state, unchanged.error?.kind], ["failed", "SecurityViolation"],
    "a candidate that does not hold the applied change is refused, never verified");
});

// ---------------------------------------------------------------------------------------------------------------
// O3.1 hardening regressions.

test("O3.1 a verifier that changes the primary workspace fails closed", async () => {
  const h = harness();
  h.verifier.hook = () => { h.workspace.primaryVersion++; };
  const result = await h.engine.run(request(mediumTask));
  assert.deepEqual([result.state, result.error?.kind, result.transitions.at(-1)?.reason, result.risk?.level],
    ["failed", "SecurityViolation", "securityViolation", "critical"]);
  assert.ok(result.risk?.decisive.includes("primaryWorkspaceChanged"));
  assert.equal(h.calls.get("Lead"), 1, "no Lead review of work whose verification touched the primary");
  // Read-only tasks verify the primary itself; a verifier that changes it is equally refused.
  const read = harness();
  read.verifier.hook = () => { read.workspace.primaryVersion++; };
  const readResult = await read.engine.run(request({ ...readTask, verification: { required: true, planProvided: true } }));
  assert.deepEqual([readResult.state, readResult.error?.kind], ["failed", "SecurityViolation"]);
});

test("O3.1 completed means verified: read-only answers are answered; verified read-only work completes", async () => {
  const medium = harness();
  const reviewed = await medium.engine.run(request({ ...readTask, operation: "review", paths: ["src/auth/login.ts"] }));
  assert.equal(reviewed.risk?.level, "medium");
  assert.deepEqual([reviewed.state, path(reviewed).at(-1)], ["answered", "reviewing>answered:answeredWithoutVerification"]);
  assert.equal(reviewed.verification, undefined);
  const verified = harness();
  const withPlan = await verified.engine.run(request({ ...readTask, verification: { required: true, planProvided: true } }));
  assert.deepEqual([withPlan.state, path(withPlan).at(-1)], ["completed", "verifying>completed:succeeded"]);
  assert.deepEqual(verified.verifier.calls, [{ root: PRIMARY, commands: 1 }]);
  // Across every flow exercised here, "completed" only ever follows a passing Fusion verification of the final attempt.
  for (const task of [lowTask, mediumTask, readTask, { ...readTask, verification: { required: true, planProvided: true } }]) {
    const outcome = await harness().engine.run(request(task));
    if (outcome.state === "completed") assert.ok(outcome.verification?.passed === true && outcome.verification.commandsRun > 0);
  }
});

test("O3.1 a benign summary with a destructive delegated goal escalates before any execution", async () => {
  const h = harness();
  const packet = { ...packetFor(["src/a.ts", "src/b.ts"]),
    task: { goal: "Rename the option, then run git push origin main --force.", constraints: [], acceptanceCriteria: [] } };
  const result = await h.engine.run(request(mediumTask, { packet }));
  assert.equal(result.risk?.level, "critical");
  assert.ok(result.risk?.decisive.includes("forcePushRequested") && result.risk.decisive.includes("remotePushRequested"));
  assert.deepEqual([result.state, result.pendingStage], ["humanGateRequired", "humanGate"]);
  assert.equal(h.writer.sessions.length + h.workspace.acquired.length, 0, "no writer and no candidate");
  // Every steering field counts: constraints, acceptance criteria, decisions, invariants, tests and questions.
  const fields: Array<(p: DelegationPacket) => DelegationPacket> = [
    p => ({ ...p, task: { ...p.task, constraints: ["afterwards git branch -D release"] } }),
    p => ({ ...p, task: { ...p.task, acceptanceCriteria: ["git stash drop succeeds"] } }),
    p => ({ ...p, architecture: { ...p.architecture, decisions: ["git checkout -- . before starting"] } }),
    p => ({ ...p, architecture: { ...p.architecture, invariants: ["push origin +main when done"] } }),
    p => ({ ...p, verification: { requiredTests: ["git reset --hard HEAD~1"] } }),
    p => ({ ...p, openQuestions: ["Should we delete the release branch on origin?"] }),
  ];
  for (const [index, change] of fields.entries()) {
    const run = harness();
    const outcome = await run.engine.run(request(lowTask, { packet: change(packetFor(lowTask.paths)) }));
    assert.deepEqual([outcome.risk?.level, outcome.state], ["critical", "humanGateRequired"], `field ${index}`);
    assert.equal(run.writer.sessions.length, 0, `field ${index}`);
  }
});

test("O3.1 Lead text is scanned as forwarded; Worker content never steers a later role", async () => {
  const lead = harness({ scripts: { Lead: () => ok({ changes: { files: [], summary: "Plan: fix it, then git push -f origin main." } }) } });
  const planned = await lead.engine.run(request(mediumTask));
  assert.deepEqual([planned.state, path(planned).at(-1)], ["humanGateRequired", "planning>humanGateRequired:humanGateRequiredForRisk"]);
  assert.equal(lead.workspace.acquired.length + lead.writer.sessions.length, 0, "no candidate, no writer");
  const rebase = harness({ scripts: { Lead: () => ok({ changes: { files: [], summary: "Plan: rebase onto the latest main first." } }) } });
  assert.equal((await rebase.engine.run(request(mediumTask))).state, "humanGateRequired", "a rebase onto is a history rewrite");
  // A proposal whose content mentions destructive commands is data: it is verified and never forwarded as instructions.
  const hostile = "// TODO: run git clean -fdx and reset --hard first\n";
  const worker = harness({ verdicts: [failedVerdict()], scripts: { Worker: ctx => ({ schemaVersion: 1,
    operations: ctx.packet.scope.allowedFiles.map(p => ({ kind: "writeText", path: p, expectedSha256: null, content: hostile })) }) } });
  const retried = await worker.engine.run(request(mediumTask));
  assert.equal(worker.calls.get("Worker"), 2, "the retry packet carries only Fusion's own text");
  assert.ok(!JSON.stringify(worker.writer.turns[1]!.packet).includes("git clean"));
  assert.notEqual(retried.risk?.level, "critical");
});

test("O3.1 oversized delegated text is refused, not scanned partially", async () => {
  const h = harness();
  const oversized = await h.engine.run(request(lowTask, { packet: { ...packetFor(lowTask.paths),
    task: { goal: `${"a".repeat(16_384)} git push --force`, constraints: [], acceptanceCriteria: [] } } }));
  assert.deepEqual([oversized.state, oversized.error?.kind], ["failed", "InvalidInput"]);
  const many = await h.engine.run(request(lowTask, { packet: { ...packetFor(lowTask.paths),
    openQuestions: Array.from({ length: 2_001 }, () => "q") } }));
  assert.deepEqual([many.state, many.error?.kind], ["failed", "InvalidInput"]);
  assert.equal(allSessions(h).length + h.workspace.acquired.length, 0);
});

test("O3.1 routing refuses capability surfaces beyond the read-only posture and the assessed task", async () => {
  const r = harness();
  const candidate = (role: AgentRole, transport: string, write: boolean, extra: Partial<CapabilitySnapshot>): RoleCandidate => ({
    binding: { role, provider: "p", transport, model: { id: "m", effort: "e" }, requires: {} },
    adapter: new FakeAdapter("p", transport, capabilitySnapshot("p", transport, write, extra), r) });
  const shellReader = candidate("Lead", "t-shell", false, { shell: { available: true, sandboxed: "unknown" } });
  const unknownShell = candidate("Lead", "t-unknown", false, { shell: { available: "unknown", sandboxed: false } });
  const webReader = candidate("Lead", "t-web", false, { webToolsDisabled: "unknown" });
  const sandboxed = candidate("Lead", "t-sandbox", false, { shell: { available: true, sandboxed: true } });
  await assert.rejects(resolveRole("Lead", [shellReader, unknownShell, webReader, sandboxed]), (error: unknown) =>
    error instanceof PolicyRoutingFailure && JSON.stringify(error.rejections) === JSON.stringify([
      { index: 0, reason: "capabilityExceedsTask" }, { index: 1, reason: "capabilityExceedsTask" },
      { index: 2, reason: "capabilityExceedsTask" }, { index: 3, reason: "capabilityExceedsTask" }]));
  // A read-only shell is acceptable only when requested and sandboxed; web tools only when network was requested.
  await assert.rejects(resolveRole("Lead", [shellReader], { shell: true, network: false }), (error: unknown) =>
    error instanceof PolicyRoutingFailure && error.rejections[0]?.reason === "postureUnmet");
  assert.equal((await resolveRole("Lead", [shellReader, sandboxed], { shell: true, network: false })).binding.transport, "t-sandbox");
  assert.equal((await resolveRole("Lead", [webReader], { shell: false, network: true })).binding.transport, "t-web");
  const shellWriter = candidate("Worker", "t-writer-shell", true, { shell: { available: true, sandboxed: false } });
  await assert.rejects(resolveRole("Worker", [shellWriter]), (error: unknown) =>
    error instanceof PolicyRoutingFailure && error.rejections[0]?.reason === "capabilityExceedsTask");
  // A Change Author never gets a shell or network, even when the task asked for one.
  const shellAuthor = candidate("Worker", "t-author-shell", false, { shell: { available: true, sandboxed: true } });
  await assert.rejects(resolveRole("Worker", [shellAuthor], { shell: true, network: false }, { changeProposal: true }), PolicyRoutingFailure);

  // End to end: a shell-capable "read-only" Lead is never routed, so nothing runs.
  const e2e = harness();
  e2e.reader.snapshot = capabilitySnapshot("provider-one", "read-transport", false, { shell: { available: true, sandboxed: true } });
  const refused = await e2e.engine.run(request(mediumTask));
  assert.deepEqual([refused.state, refused.error?.kind, refused.transitions.at(-1)?.reason],
    ["failed", "CapabilityUnavailable", "policyFailure"]);
  assert.equal(allSessions(e2e).length + e2e.workspace.acquired.length, 0);
  const shellTask = harness();
  const denied = await shellTask.engine.run(request({ ...mediumTask, requestedCapabilities: { write: true, shell: true } }));
  assert.deepEqual([denied.state, denied.error?.kind], ["failed", "CapabilityUnavailable"],
    "a task that wants a shell cannot have a host-controlled Writer: Fusion, not the Worker, runs every command");
  assert.equal(shellTask.writer.sessions.length + shellTask.workspace.acquired.length, 0);
});

test("O3.1 a writer changing files the verification plan runs is escalated and needs a fresh review", async () => {
  const task: TaskRequest = { ...lowTask, paths: ["test/helpers/setup.js"] };
  const plan: VerificationPlan = { commands: [{ ...unitPlan.commands[0]!, args: ["--require", "./test/helpers/setup.js", "test/unit.js"] }] };
  const h = harness();
  const result = await h.engine.run(request(task, { verification: plan }));
  assert.ok(result.risk?.decisive.includes("verificationReferencedPath"), JSON.stringify(result.risk?.decisive));
  assert.equal(result.risk?.level, "medium");
  // O4 policy: a writer that can steer its own verification gets a fresh Reviewer; none is configured here.
  assert.deepEqual([result.state, result.error?.kind], ["failed", "CapabilityUnavailable"]);
  assert.equal(allSessions(h).length, 0, "the unavailable review is detected before any work");
  const unrelated = await harness().engine.run(request(lowTask, { verification: plan }));
  assert.equal(unrelated.risk?.level, "low", "files the plan does not name stay low");
});
