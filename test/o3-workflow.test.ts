import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { AgentRole, CapabilitySnapshot, DelegationPacket, ModelProfile, ProviderAdapter, ResultPacket, RoleBinding,
  Session, TurnResult, VerificationPlan } from "../src/core/domain.js";
import { riskRank } from "../src/core/policy/risk.js";
import { PolicyRoutingFailure, resolveRole, type RoleCandidate } from "../src/core/policy/routing.js";
import type { TaskRequest } from "../src/core/policy/task-inspector.js";
import { WorkflowEngine } from "../src/core/workflow/engine.js";
import { PRIMARY_WORKSPACE, type EventSink, type VerificationVerdict, type VerifierPort, type WorkflowEvent,
  type WorkflowRequest, type WorkflowResult, type WorkspaceHandle, type WorkspacePort } from "../src/core/workflow/types.js";

// ---------------------------------------------------------------------------------------------------------------
// Fake, in-memory ports. No process, provider, network or filesystem access.

const PRIMARY = resolve("/fusion-o3-fake/primary");
type TurnContext = { session: Session; packet: DelegationPacket; signal: AbortSignal | undefined; call: number; h: Harness };
type Script = (ctx: TurnContext) => unknown;

const capabilitySnapshot = (provider: string, transport: string, write: boolean | "unknown"): CapabilitySnapshot => ({
  provider, transport, observedAt: "2026-01-01T00:00:00.000Z", runtimeVersion: "fake-1", persistentSessions: true,
  structuredOutput: true, filesystem: { read: true, write }, shell: { available: true, sandboxed: true },
  approvalCallback: false, protocolCancellation: true, usageReporting: false, modelIdentityReadback: true,
  subscriptionLaneReadback: true,
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
  async runTurn(session: Session, packet: DelegationPacket, signal?: AbortSignal): Promise<TurnResult> {
    this.turns.push({ session, packet, signalAborted: () => signal?.aborted === true });
    const calls = this.h.calls.get(session.role) ?? 0;
    this.h.calls.set(session.role, calls + 1);
    const script = this.h.scripts[session.role] ?? (() => ok());
    const out = await script({ session, packet, signal, call: calls + 1, h: this.h });
    return (isTurn(out) ? out : { status: "completed", output: out, effectiveProvider: this.provider,
      effectiveModel: "opaque-model", artifactRefs: [] }) as TurnResult;
  }
  async cancel(): Promise<void> { this.cancels++; }
  async usage() { return null; }
  async close(): Promise<void> { this.closes++; }
}
const isTurn = (value: unknown): boolean => value !== null && typeof value === "object" && "status" in value && "effectiveProvider" in value;

class FakeWorkspace implements WorkspacePort {
  readonly primaryRoot = PRIMARY;
  readonly leaseRoot = join(PRIMARY, ".fusion", "worktrees");
  readonly acquired: WorkspaceHandle[] = [];
  readonly changes = new Map<string, string[]>();
  primaryVersion = 0;
  leaseVersion = 0;
  acquireOverride?: (ownerId: string) => Promise<WorkspaceHandle>;
  async acquire(ownerId: string): Promise<WorkspaceHandle> {
    if (this.acquireOverride) return this.acquireOverride(ownerId);
    const handle = { leaseId: `lease-${this.acquired.length + 1}`, ownerId,
      path: join(PRIMARY, ".fusion", "worktrees", `lease-${this.acquired.length + 1}`) };
    this.acquired.push(handle);
    return handle;
  }
  async changedPaths(handle: WorkspaceHandle): Promise<readonly string[]> { return this.changes.get(handle.leaseId) ?? []; }
  async fingerprint(handle: WorkspaceHandle | undefined): Promise<string> {
    return handle === undefined ? `primary-${this.primaryVersion}` : `${handle.leaseId}-${this.leaseVersion}`;
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
/** Default Worker: changes exactly the files it was allowed to change. */
const writeAllowed: Script = ({ session, packet, h }) => {
  h.workspace.changes.set(session.workspaceLeaseId, [...packet.scope.allowedFiles]);
  return ok({ changes: { files: [...packet.scope.allowedFiles], summary: "implemented" } });
};
function harness(options: HarnessOptions = {}): Harness {
  const ids = options.ids ?? { provider: "provider-one", model: "model-one" };
  const model: ModelProfile = { id: ids.model, effort: "high" };
  const h = { workspace: new FakeWorkspace(), verifier: new FakeVerifier(options.verdicts), sink: new RecordingSink(),
    scripts: { Lead: () => ok({ changes: { files: [], summary: "Plan: change a then b." } }), Worker: writeAllowed, ...options.scripts },
    calls: new Map<AgentRole, number>() } as Omit<Harness, "engine" | "reader" | "writer"> as Harness;
  h.reader = new FakeAdapter(ids.provider, "read-transport", capabilitySnapshot(ids.provider, "read-transport", false), h);
  h.writer = new FakeAdapter(ids.provider, "write-transport",
    capabilitySnapshot(ids.provider, "write-transport", options.writerWrite ?? true), h);
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

test("O3 LOW: inspect → risk gate → one eligible writer in a lease → Fusion verifier → completed", async () => {
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
  assert.deepEqual([worker?.role, worker?.posture, worker?.workspaceLeaseId], ["Worker", "writer", result.lease?.leaseId]);
  assert.deepEqual(h.verifier.calls, [{ root: result.lease?.path, commands: 1 }], "the lease, never the primary, is verified");
  assert.deepEqual(result.changedPaths, ["src/util/format.ts"]);
  assert.equal(h.writer.closes, 1);

  const read = harness();
  const answered = await read.engine.run(request(readTask));
  assert.equal(answered.state, "completed");
  assert.deepEqual(path(answered).slice(2), ["routed>delegating:delegated", "delegating>completed:succeeded"]);
  assert.deepEqual(read.reader.sessions.map(s => [s.role, s.posture, s.workspaceLeaseId]), [["Explorer", "readOnly", PRIMARY_WORKSPACE]]);
  assert.equal(read.writer.sessions.length + read.workspace.acquired.length + read.verifier.calls.length, 0);
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
});

test("O3 MEDIUM: Lead plan → bounded Worker in a lease → Fusion verifier → Lead review → completed", async () => {
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
  assert.ok(review.architecture.decisions.some(d => d.startsWith("Delegate summary (unverified claim):")));
  for (const turn of [...h.reader.turns, ...h.writer.turns])
    assert.deepEqual(Object.keys(turn.packet).sort(), ["architecture", "openQuestions", "scope", "task", "verification"]);
  assert.equal(result.plan?.changes.summary, "Plan: change a then b.");
});

test("O3 a writer never runs without a valid lease of its own", async () => {
  const h = harness();
  h.workspace.acquireOverride = async () => { throw new Error("git worktree add failed"); };
  const result = await h.engine.run(request(mediumTask));
  assert.equal(result.state, "failed");
  assert.equal(result.transitions.at(-1)?.reason, "workspaceFailure");
  assert.equal(result.error?.kind, "InternalError");
  assert.equal(h.writer.sessions.length, 0, "no writer session may exist without a lease");

  const foreign = harness();
  foreign.workspace.acquireOverride = async () => ({ leaseId: "lease-x", ownerId: "someone-else",
    path: join(PRIMARY, ".fusion", "worktrees", "x") });
  const stolen = await foreign.engine.run(request(lowTask));
  assert.deepEqual([stolen.state, stolen.error?.kind], ["failed", "WorkspaceConflict"]);
  assert.equal(foreign.writer.sessions.length, 0);
  assert.equal(stolen.lease, undefined, "a refused handle is never reported as this run's lease");

  const mismatched = harness();
  mismatched.sessionOverride = session => session.posture === "writer" ? { ...session, workspaceLeaseId: PRIMARY_WORKSPACE } : undefined;
  const swapped = await mismatched.engine.run(request(lowTask));
  assert.deepEqual([swapped.state, swapped.error?.kind], ["failed", "SecurityViolation"]);
  assert.equal(mismatched.writer.turns.length, 0, "a session bound to the wrong workspace never receives a turn");
});

test("O3 the primary workspace is never assigned to an autonomous writer", async () => {
  for (const handle of [{ leaseId: "lease-p", path: PRIMARY }, { leaseId: "lease-q", path: resolve(PRIMARY, "..") },
    { leaseId: "lease-s", path: join(PRIMARY, "src") }, { leaseId: "lease-t", path: join(PRIMARY, ".fusion", "worktrees") },
    { leaseId: PRIMARY_WORKSPACE, path: join(PRIMARY, ".fusion", "w") }, { leaseId: "lease-r", path: PRIMARY.toUpperCase() }]) {
    if (handle.path === PRIMARY.toUpperCase() && process.platform !== "win32") continue;
    const h = harness();
    h.workspace.acquireOverride = async ownerId => ({ ...handle, ownerId });
    const result = await h.engine.run(request(lowTask));
    assert.deepEqual([result.state, result.error?.kind, result.transitions.at(-1)?.reason],
      ["failed", "SecurityViolation", "securityViolation"], handle.path);
    assert.equal(h.writer.sessions.length, 0);
    assert.equal(result.lease, undefined);
  }
  const h = harness();
  await h.engine.run(request(mediumTask));
  assert.ok(allSessions(h).filter(s => s.posture === "writer").every(s => s.workspaceLeaseId !== PRIMARY_WORKSPACE));

  // A writer that reaches outside its lease into the primary is detected and stops the workflow.
  const escape = harness({ scripts: { Worker: ctx => { ctx.h.workspace.primaryVersion++; return writeAllowed(ctx); } } });
  const escaped = await escape.engine.run(request(mediumTask));
  assert.deepEqual([escaped.state, escaped.error?.kind, escaped.risk?.level], ["failed", "SecurityViolation", "critical"]);
  assert.equal(escape.verifier.calls.length, 0);
  // Likewise a read-only role that changes the primary.
  const lead = harness({ scripts: { Lead: ctx => { ctx.h.workspace.primaryVersion++; return ok(); } } });
  const leaked = await lead.engine.run(request(mediumTask));
  assert.deepEqual([leaked.state, leaked.error?.kind], ["failed", "SecurityViolation"]);
  assert.equal(lead.workspace.acquired.length, 0);
});

test("O3 verification failure prevents success; agent-reported checks never count", async () => {
  const claims = ok({ verification: { testsRun: ["unit"], results: ["all 42 tests passed"] } });
  const h = harness({ verdicts: [failedVerdict(), failedVerdict()], scripts: { Worker: ctx => { writeAllowed(ctx); return claims; } } });
  const result = await h.engine.run(request(mediumTask));
  assert.equal(result.state, "decisionRequired");
  assert.equal(result.transitions.at(-1)?.reason, "retryExhausted");
  assert.equal(result.error?.kind, "VerificationFailure");
  assert.ok(!result.transitions.some(t => t.to === "completed" || t.to === "reviewing"));

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
  const h = harness({ writerWrite: "unknown" });
  const result = await h.engine.run(request(mediumTask));
  assert.deepEqual([result.state, result.error?.kind, result.transitions.at(-1)?.reason],
    ["failed", "CapabilityUnavailable", "policyFailure"]);
  assert.equal(allSessions(h).length + h.workspace.acquired.length, 0, "routing precedes every turn and lease");

  // Configuration order is preference order; ineligible candidates are skipped with typed reasons.
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
  await assert.rejects(resolveRole("Reviewer", candidates), (error: unknown) =>
    error instanceof PolicyRoutingFailure && error.rejections.length === 0);
  // A read-only role never binds to a candidate that can write.
  await assert.rejects(resolveRole("Lead", [{ binding: { ...bad("t7", true).binding, role: "Lead" }, adapter: bad("t7", true).adapter }]),
    PolicyRoutingFailure);
});

test("O3 a Worker that asks for a decision stops the workflow for the Lead", async () => {
  const h = harness({ scripts: { Worker: ctx => { writeAllowed(ctx); return ok({ needsLeadDecision: ["Should the option be public?"] }); } } });
  const result = await h.engine.run(request(mediumTask));
  assert.deepEqual([result.state, result.transitions.at(-1)?.reason, result.transitions.at(-1)?.role],
    ["decisionRequired", "decisionRequested", "Worker"]);
  assert.equal(h.verifier.calls.length, 0);
  assert.equal(h.calls.get("Worker"), 1);
  assert.deepEqual(result.result?.needsLeadDecision, ["Should the option be public?"]);
  const blocked = harness({ scripts: { Worker: () => ok({ result: { status: "blocked" } }) } });
  assert.equal((await blocked.engine.run(request(mediumTask))).state, "decisionRequired");
});

test("O3 one targeted Worker retry, then Lead decision; never a third attempt", async () => {
  const h = harness({ scripts: { Worker: () => ok({ result: { status: "failed" }, failures: ["could not find the helper"] }) } });
  const result = await h.engine.run(request(mediumTask));
  assert.deepEqual([result.state, result.transitions.at(-1)?.reason, result.delegateAttempts], ["decisionRequired", "retryExhausted", 2]);
  assert.equal(h.calls.get("Worker"), 2);
  const retry = h.writer.turns[1]!.packet;
  assert.ok(retry.task.constraints.includes("Attempt 2 of 2: the previous attempt reported status failed."));
  assert.deepEqual(retry.openQuestions, ["could not find the helper"], "only structured fields carry over, never a transcript");
  assert.equal(h.writer.sessions.length, 2, "each attempt is a fresh session");
  assert.equal(new Set(h.writer.sessions.map(s => s.workspaceLeaseId)).size, 1, "the retry works in the same lease");

  const v = harness({ verdicts: [failedVerdict("lint"), failedVerdict("lint"), failedVerdict("lint")] });
  const verified = await v.engine.run(request(mediumTask));
  assert.equal(verified.state, "decisionRequired");
  assert.deepEqual([v.calls.get("Worker"), v.verifier.calls.length], [2, 2], "no third attempt and no third verification");
  assert.ok(v.writer.turns[1]!.packet.task.constraints.includes("Attempt 2 of 2: Fusion verification command lint did not pass."));
  assert.deepEqual(path(verified).filter(p => p.includes("retrying")), ["verifying>retrying:verificationFailed", "retrying>delegating:delegated"]);
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

test("O3 unexpected scope prevents automatic success and escalates risk", async () => {
  const h = harness({ scripts: { Worker: ({ session, h: hh }) => {
    hh.workspace.changes.set(session.workspaceLeaseId, ["src/a.ts", "src/b.ts", "src/c.ts"]); return ok(); } } });
  const result = await h.engine.run(request(mediumTask));
  assert.deepEqual([result.state, result.transitions.at(-1)?.reason, result.risk?.level], ["decisionRequired", "unexpectedScope", "high"]);
  assert.equal(h.verifier.calls.length, 0);
  assert.deepEqual(result.changedPaths, ["src/a.ts", "src/b.ts", "src/c.ts"]);

  const secret = harness({ scripts: { Worker: ({ session, h: hh }) => { hh.workspace.changes.set(session.workspaceLeaseId, [".env"]); return ok(); } } });
  assert.equal((await secret.engine.run(request(lowTask))).risk?.level, "critical");

  // Forbidden files override allowed ones, and a packet may not widen the inspected scope.
  const forbidden = harness();
  const blocked = await forbidden.engine.run(request(mediumTask, { packet: packetFor(["src/a.ts", "src/b.ts"], ["SRC\\b.ts"]) }));
  assert.equal(blocked.transitions.at(-1)?.reason, "unexpectedScope");
  const widened = await harness().engine.run(request(mediumTask, { packet: packetFor(["src/a.ts", "src/b.ts", "src/secret.ts"]) }));
  assert.deepEqual([widened.state, widened.error?.kind], ["failed", "InvalidInput"]);
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
  // Behavioral neutrality: swapping every provider/model identity leaves the workflow bit-for-bit identical.
  const a = harness({ ids: { provider: "alpha", model: "alpha-large" } });
  const b = harness({ ids: { provider: "zeta-other", model: "z-9" } });
  const ra = await a.engine.run({ ...request(mediumTask), runId: "same-run" });
  const rb = await b.engine.run({ ...request(mediumTask), runId: "same-run" });
  assert.deepEqual(ra.transitions, rb.transitions);
  assert.deepEqual(a.sink.events, b.sink.events);
  assert.doesNotMatch(JSON.stringify(a.sink.events), /alpha|large|read-transport|write-transport|fusion-o3-fake/u,
    "events carry no provider, model, transport or path identities");
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
});

test("O3 two concurrent writers can never share one lease", async () => {
  const shared = { leaseId: "lease-shared", path: join(PRIMARY, ".fusion", "worktrees", "shared") };
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  let started!: () => void;
  const running = new Promise<void>(done => { started = done; });
  const first = harness({ scripts: { Worker: async ctx => { started(); await gate; return writeAllowed(ctx); } } });
  const second = harness();
  first.workspace.acquireOverride = async ownerId => ({ ...shared, ownerId });
  second.workspace.acquireOverride = async ownerId => ({ ...shared, leaseId: "lease-other", ownerId });
  const a = first.engine.run(request(mediumTask));
  await running;
  const b = await second.engine.run(request(mediumTask));
  assert.deepEqual([b.state, b.error?.kind, b.transitions.at(-1)?.reason], ["failed", "WorkspaceConflict", "workspaceFailure"]);
  assert.equal(second.writer.sessions.length, 0);
  release();
  assert.equal((await a).state, "completed");
  // Once the first workflow has ended, its claim is released.
  const third = harness();
  third.workspace.acquireOverride = async ownerId => ({ ...shared, ownerId });
  assert.equal((await third.engine.run(request(mediumTask))).state, "completed");
});

test("O3 HIGH reaches review-required and leaves fresh review and adjudication to a later stage", async () => {
  const h = harness();
  const result = await h.engine.run(request(highTask, { explore: true }));
  assert.deepEqual([result.state, result.pendingStage, result.transitions.at(-1)?.reason],
    ["reviewRequired", "freshReviewAndAdjudication", "reviewRequiredForRisk"]);
  assert.deepEqual(path(result).slice(2, 6), ["routed>planning:planRequested", "planning>exploring:explorationRequested",
    "exploring>leased:leaseAcquired", "leased>delegating:delegated"]);
  assert.deepEqual(h.reader.sessions.map(s => [s.role, s.posture]), [["Lead", "readOnly"], ["Explorer", "readOnly"]]);
  assert.ok(!allSessions(h).some(s => s.role === "Reviewer" || s.role === "Auditor"), "no simulated fresh review");
  assert.ok(!result.transitions.some(t => t.to === "completed" || t.to === "reviewing"));
  assert.equal(h.verifier.calls.length, 1, "deterministic verification still runs before the review gate");
  assert.ok(h.writer.turns[0]!.packet.architecture.decisions.some(d => d.startsWith("Exploration summary:")));
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

test("O3 malformed ResultPackets and turn results fail closed without retry", async () => {
  const cases: Script[] = [
    () => { const { needsLeadDecision: _, ...rest } = ok(); return rest; },
    () => ({ ...ok(), transcript: ["user: hi", "assistant: hello"] }),
    () => ok({ result: { status: "done" as never } }),
    () => ok({ changes: { files: "src/a.ts" as never, summary: "x" } }),
    ({ session }) => ({ status: "weird", effectiveProvider: session.provider }),
    ({ session }) => ({ status: "failed", effectiveProvider: session.provider, error: { message: "raw" } }),
    () => null,
    () => ok({ failures: Array.from({ length: 1_001 }, () => "x") }),
    () => ok({ changes: { files: [], summary: "x".repeat(64 * 1024 + 1) } }),
    () => new Proxy(ok(), {}),
    () => ({ ...ok(), get needsLeadDecision() { return []; }, toJSON: () => ok() }),
  ];
  for (const [index, script] of cases.entries()) {
    const h = harness({ scripts: { Worker: script } });
    const result = await h.engine.run(request(mediumTask));
    assert.deepEqual([result.state, result.error?.kind, result.transitions.at(-1)?.reason],
      ["failed", "MalformedOutput", "malformedResult"], `case ${index}`);
    assert.equal(h.calls.get("Worker"), 1);
    assert.equal(h.verifier.calls.length, 0);
  }
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
  const declined = harness({ scripts: { Lead: () => ok({ result: { status: "blocked" } }) } });
  const stopped = await declined.engine.run(request(mediumTask));
  assert.deepEqual([stopped.state, declined.workspace.acquired.length], ["decisionRequired", 0]);
});

test("O3 what was verified is what is handed on: later lease changes void the verification", async () => {
  const drift = harness();
  drift.verifier.hook = () => { drift.workspace.leaseVersion++; };
  const moved = await drift.engine.run(request(lowTask));
  assert.deepEqual([moved.state, moved.error?.kind], ["failed", "SecurityViolation"], "a read-only verifier plan cannot change the lease");

  const review = harness({ scripts: { Lead: ({ call, h: hh }) => { if (call === 2) hh.workspace.leaseVersion++; return ok(); } } });
  const edited = await review.engine.run(request(mediumTask));
  assert.deepEqual([edited.state, edited.error?.kind], ["failed", "SecurityViolation"], "the reviewing Lead is read-only on the lease");

  const mutating: VerificationPlan = { commands: [{ ...unitPlan.commands[0]!, mutationPolicy: "allowMutation" }] };
  const build = harness();
  build.verifier.hook = () => {
    const [lease] = build.workspace.acquired;
    build.workspace.changes.set(lease!.leaseId, ["src/util/format.ts", "generated/out.js"]);
    build.workspace.leaseVersion++;
  };
  const generated = await build.engine.run(request(lowTask, { verification: mutating }));
  assert.deepEqual([generated.state, generated.transitions.at(-1)?.reason], ["decisionRequired", "unexpectedScope"],
    "a mutating verifier's out-of-scope output is scope-checked");
  const clean = harness();
  clean.verifier.hook = () => { clean.workspace.leaseVersion++; };
  assert.equal((await clean.engine.run(request(lowTask, { verification: mutating }))).state, "completed");
});

test("O3 a writer that changed nothing is not reported as a success", async () => {
  const h = harness({ scripts: { Worker: () => ok({ changes: { files: ["src/util/format.ts"], summary: "fixed it" } }) } });
  const result = await h.engine.run(request(lowTask));
  assert.deepEqual([result.state, result.transitions.at(-1)?.reason, result.changedPaths], ["decisionRequired", "noChanges", []]);
  assert.equal(h.verifier.calls.length, 0, "claimed file changes are not evidence");
});
