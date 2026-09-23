import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import type { AdjudicatedFinding, AdjudicationRequest, AgentRole, CapabilitySnapshot, DelegationPacket, ModelProfile,
  ProviderAdapter, ResultPacket, ReviewRequest, ReviewerFinding, Session, StructuredTurnRequest, StructuredTurnResult,
  TurnResult, VerificationPlan } from "../src/core/domain.js";
import { FusionFailure } from "../src/core/errors.js";
import { PolicyRoutingFailure, resolveRole, type RoleCandidate } from "../src/core/policy/routing.js";
import type { TaskRequest } from "../src/core/policy/task-inspector.js";
import { adjudicate, evaluateFacts, REVIEW_LIMITS, validateAdjudicationReport, validateReviewReport } from "../src/core/review/findings.js";
import { REVIEW_EVIDENCE_LIMITS, reviewOutcome } from "../src/core/review/policy.js";
import { WorkflowEngine } from "../src/core/workflow/engine.js";
import type { EventSink, VerificationVerdict, VerifierPort, WorkflowEvent, WorkflowRequest, WorkflowResult, WorkspaceHandle,
  WorkspacePort } from "../src/core/workflow/types.js";
import { RunStore } from "../src/platform/events/run-store.js";
import { StorageError } from "../src/platform/events/shared.js";
import type { EventInput } from "../src/platform/events/types.js";
import { EventStoreWorkflowSink } from "../src/platform/workflow/ports.js";

// ---------------------------------------------------------------------------------------------------------------
// Fake, in-memory ports with a fresh Reviewer and a structured-turn Lead. No provider, process or network access.

const PRIMARY = resolve("/fusion-o4-fake/primary");
const WORKER_MARKER = "WORKER-SELF-REPORT-7f3a";
const PLAN_MARKER = "LEAD-PLAN-REASONING-91c2";

type RoleScript = (ctx: { session: Session; packet: DelegationPacket; call: number; signal: AbortSignal | undefined; h: Harness }) => unknown;
type StructuredScript<R> = (ctx: { session: Session; request: R; call: number; signal: AbortSignal | undefined; h: Harness }) => unknown;

const snapshot = (provider: string, transport: string, write: boolean, extra: Partial<CapabilitySnapshot> = {}): CapabilitySnapshot => ({
  provider, transport, observedAt: "2026-01-01T00:00:00.000Z", runtimeVersion: "fake-1", persistentSessions: true,
  structuredOutput: true, webToolsDisabled: true, filesystem: { read: true, write }, shell: { available: false, sandboxed: false },
  approvalCallback: false, protocolCancellation: true, usageReporting: false, modelIdentityReadback: true,
  subscriptionLaneReadback: true, approvalEscalationDisabled: true, personalContextDisabled: true,
  extensionsQuarantined: true,
  ...(write ? { writerIsolation: { workspaceScopedWrites: true, primaryWorkspaceInaccessible: true,
    gitPushDisabled: true, forcePushDisabled: true, credentialOverrideBlocked: true,
    boundedCommands: true, approvalPolicyKnown: true, processTreeSupervised: true,
    workspaceIdentityReadback: true } } : {}), ...extra });

class FakeAdapter implements ProviderAdapter {
  readonly sessions: Session[] = [];
  readonly packets: DelegationPacket[] = [];
  readonly requests: StructuredTurnRequest[] = [];
  cancels = 0;
  closes = 0;
  reuseSessionId?: string;
  constructor(readonly provider: string, readonly transport: string, public caps: CapabilitySnapshot, private readonly h: Harness) {}
  async capabilities(): Promise<CapabilitySnapshot> { return this.caps; }
  async authStatus() { return { state: "authenticated" as const, lane: "subscription" as const, observedAt: "", evidence: [] }; }
  async createSession(request: Parameters<ProviderAdapter["createSession"]>[0]): Promise<Session> {
    const session: Session = { id: this.reuseSessionId ?? `${this.transport}-s${this.sessions.length + 1}`, runId: request.runId,
      role: request.role, provider: this.provider, transport: this.transport, workspaceLeaseId: request.workspaceLeaseId,
      posture: request.posture, providerSessionRef: "opaque" };
    this.sessions.push(session);
    return session;
  }
  async resumeSession(session: Session): Promise<Session> { return session; }
  async runTurn(session: Session, packet: DelegationPacket, signal?: AbortSignal): Promise<TurnResult> {
    this.packets.push(packet);
    const call = this.h.count(session.role);
    const script = this.h.scripts[session.role] ?? (() => ok());
    const out = await script({ session, packet, call, signal, h: this.h });
    return (isEnvelope(out) ? out : { status: "completed", output: out, effectiveProvider: this.provider,
      effectiveModel: "opaque", artifactRefs: [] }) as TurnResult;
  }
  async runStructuredTurn(session: Session, request: StructuredTurnRequest, signal?: AbortSignal): Promise<StructuredTurnResult> {
    this.requests.push(structuredClone(request));
    const call = this.h.count(request.kind);
    const out = request.kind === "review"
      ? await (this.h.review ?? defaultReview)({ session, request, call, signal, h: this.h })
      : await (this.h.adjudication ?? defaultAdjudication)({ session, request, call, signal, h: this.h });
    return (isEnvelope(out) ? out : { status: "completed", output: out, effectiveProvider: this.provider,
      effectiveModel: "opaque", artifactRefs: [] }) as StructuredTurnResult;
  }
  async cancel(): Promise<void> { this.cancels++; }
  async usage() { return null; }
  async close(): Promise<void> { this.closes++; }
}
const isEnvelope = (value: unknown): boolean => value !== null && typeof value === "object" && "status" in value && "effectiveProvider" in value;

class FakeWorkspace implements WorkspacePort {
  readonly primaryRoot = PRIMARY;
  readonly leaseRoot = join(PRIMARY, ".fusion", "worktrees");
  readonly acquired: WorkspaceHandle[] = [];
  readonly changes = new Map<string, string[]>();
  primaryVersion = 0;
  leaseVersion = 0;
  diffText?: string;
  async acquire(ownerId: string): Promise<WorkspaceHandle> {
    const handle = { leaseId: `lease-${this.acquired.length + 1}`, ownerId, path: join(this.leaseRoot, `lease-${this.acquired.length + 1}`) };
    this.acquired.push(handle);
    return handle;
  }
  async changedPaths(handle: WorkspaceHandle): Promise<readonly string[]> { return this.changes.get(handle.leaseId) ?? []; }
  async fingerprint(handle: WorkspaceHandle | undefined): Promise<string> {
    return handle === undefined ? `primary-${this.primaryVersion}` : `${handle.leaseId}-${this.leaseVersion}`;
  }
  async diff(handle: WorkspaceHandle): Promise<{ text: string; truncated: boolean }> {
    return { text: this.diffText ?? (this.changes.get(handle.leaseId) ?? []).map(p => `diff --git a/${p} b/${p}\n+changed\n`).join(""),
      truncated: false };
  }
}
class FakeVerifier implements VerifierPort {
  readonly calls: string[] = [];
  constructor(private readonly verdicts: VerificationVerdict[] = []) {}
  async verify(plan: VerificationPlan, root: string): Promise<VerificationVerdict> {
    this.calls.push(root);
    return this.verdicts.shift() ?? { passed: true, commandsRun: plan.commands.length };
  }
}
class RecordingSink implements EventSink {
  readonly events: WorkflowEvent[] = [];
  failOn?: (event: WorkflowEvent) => boolean;
  async append(event: WorkflowEvent): Promise<void> {
    if (this.failOn?.(event)) throw new Error("event store unavailable");
    this.events.push(structuredClone(event));
  }
}

const ok = (patch: Partial<ResultPacket> = {}): ResultPacket => ({ result: { status: "completed" },
  changes: { files: [], summary: "done" }, verification: { testsRun: [], results: [] }, uncertainties: [], failures: [],
  needsLeadDecision: [], ...patch });
const finding = (id: string, severity: ReviewerFinding["severity"], patch: Partial<ReviewerFinding> = {}): ReviewerFinding => ({
  id, severity, confidence: "HIGH", category: "correctness", file: "src/a.ts", lines: { start: 3, end: 7 },
  title: `${severity} issue ${id}`, evidence: ["The branch returns before the value is saved."],
  failureScenario: "A caller saves twice and loses the second write.", suggestedFix: "Save before returning.", ...patch });
const report = (...findings: ReviewerFinding[]) => ({ findings, summary: "Reviewed the change." });
const verdicts = (request: AdjudicationRequest, verdict: AdjudicatedFinding["verdict"], action?: AdjudicatedFinding["requiredAction"]) => ({
  summary: "Adjudicated.", adjudications: request.findings.map(f => ({ findingId: f.id, verdict, rationale: `Checked ${f.id}.`,
    requiredAction: action ?? (verdict === "REJECTED" ? "none" : verdict === "UNVERIFIABLE" ? "humanDecision"
      : ["BLOCKER", "HIGH", "MEDIUM"].includes(f.severity) ? "fix" : "followUp") })) });
const defaultReview: StructuredScript<ReviewRequest> = () => report();
const defaultAdjudication: StructuredScript<AdjudicationRequest> = ({ request }) => verdicts(request, "CONFIRMED");

interface Harness {
  engine: WorkflowEngine; workspace: FakeWorkspace; verifier: FakeVerifier; sink: RecordingSink;
  lead: FakeAdapter; reviewer: FakeAdapter; writer: FakeAdapter;
  scripts: Partial<Record<AgentRole, RoleScript>>;
  review?: StructuredScript<ReviewRequest>;
  adjudication?: StructuredScript<AdjudicationRequest>;
  counts: Map<string, number>;
  count(key: string): number;
}
interface Options {
  verdicts?: VerificationVerdict[];
  scripts?: Partial<Record<AgentRole, RoleScript>>;
  review?: StructuredScript<ReviewRequest>;
  adjudication?: StructuredScript<AdjudicationRequest>;
  reviewer?: false | Partial<CapabilitySnapshot>;
  leadStructured?: boolean;
  ids?: { provider: string; model: string };
}
const writeAllowed: RoleScript = ({ session, packet, h }) => {
  h.workspace.changes.set(session.workspaceLeaseId, [...packet.scope.allowedFiles]);
  return ok({ changes: { files: [...packet.scope.allowedFiles], summary: `implemented ${WORKER_MARKER}` },
    verification: { testsRun: ["unit"], results: [`all green ${WORKER_MARKER}`] } });
};
function harness(options: Options = {}): Harness {
  const ids = options.ids ?? { provider: "provider-one", model: "model-one" };
  const model: ModelProfile = { id: ids.model, effort: "high" };
  const counts = new Map<string, number>();
  const h = { workspace: new FakeWorkspace(), verifier: new FakeVerifier(options.verdicts), sink: new RecordingSink(), counts,
    scripts: { Lead: () => ok({ changes: { files: [], summary: `Plan ${PLAN_MARKER}` } }), Worker: writeAllowed,
      Explorer: () => ok({ changes: { files: [], summary: "The parser reads tokens lazily." } }), ...options.scripts },
    count: (key: string) => { const next = (counts.get(key) ?? 0) + 1; counts.set(key, next); return next; },
    ...(options.review ? { review: options.review } : {}), ...(options.adjudication ? { adjudication: options.adjudication } : {}),
  } as unknown as Harness;
  h.lead = new FakeAdapter(ids.provider, "lead-transport", snapshot(ids.provider, "lead-transport", false), h);
  h.writer = new FakeAdapter(ids.provider, "writer-transport", snapshot(ids.provider, "writer-transport", true), h);
  h.reviewer = new FakeAdapter(ids.provider, "review-transport",
    snapshot(ids.provider, "review-transport", false, options.reviewer === false ? {} : options.reviewer ?? {}), h);
  if (options.leadStructured === false) (h.lead as { runStructuredTurn?: unknown }).runStructuredTurn = undefined;
  const bind = (role: AgentRole, adapter: FakeAdapter): RoleCandidate => ({ adapter,
    binding: { role, provider: ids.provider, transport: adapter.transport, model, requires: { structuredOutput: true } } });
  const roles = [bind("Lead", h.lead), bind("Explorer", h.lead), bind("Worker", h.writer),
    ...(options.reviewer === false ? [] : [bind("Reviewer", h.reviewer)])];
  h.engine = new WorkflowEngine({ roles, workspace: h.workspace, verifier: h.verifier, events: h.sink });
  return h;
}

const unitPlan: VerificationPlan = { commands: [{ id: "unit", executable: resolve("/fake/bin/node.exe"), args: ["test.js"],
  cwd: ".", timeoutMs: 10_000, mutationPolicy: "readOnly" }] };
const packetFor = (allowed: readonly string[]): DelegationPacket => ({
  task: { goal: "Make saving idempotent.", constraints: ["Keep the public API."], acceptanceCriteria: ["Unit tests pass."] },
  scope: { relevantFiles: [...allowed], allowedFiles: [...allowed], forbiddenFiles: [] },
  architecture: { decisions: ["Use the existing store."], invariants: ["No new dependencies."] },
  verification: { requiredTests: ["unit"] }, openQuestions: [] });
const mediumTask: TaskRequest = { operation: "implement", summary: "Make saving idempotent.", paths: ["src/a.ts", "src/b.ts"],
  scopeKnown: true, expectedMutation: "multiFile", requestedCapabilities: { write: true }, verification: { required: true, planProvided: true } };
const highTask: TaskRequest = { ...mediumTask, indicators: { architectureChange: true } };
const criticalTask: TaskRequest = { ...mediumTask, indicators: { irreversible: true } };
const highRead: TaskRequest = { operation: "analyze", summary: "Explain the token parser.", paths: ["src/parser.ts"], scopeKnown: true,
  expectedMutation: "none", requestedCapabilities: {}, verification: { required: false, planProvided: false },
  indicators: { ambiguousArchitecture: true } };
let runs = 0;
const request = (task: TaskRequest, patch: Partial<WorkflowRequest> = {}): WorkflowRequest => ({ runId: `o4-run-${++runs}`, task,
  packet: packetFor(task.expectedMutation === "none" ? [] : task.paths),
  verification: task.verification.planProvided ? unitPlan : { commands: [] }, ...patch });
const path = (r: WorkflowResult): string[] => r.transitions.map(t => `${t.from}>${t.to}:${t.reason}`);
const reviewerSessions = (h: Harness) => h.reviewer.sessions.filter(s => s.role === "Reviewer");

// ---------------------------------------------------------------------------------------------------------------
// Fresh Reviewer

test("O4 HIGH: Lead → Worker → verifier → fresh Reviewer → completed when no finding remains", async () => {
  const h = harness();
  const result = await h.engine.run(request(highTask));
  assert.equal(result.state, "completed", JSON.stringify(result.error));
  assert.deepEqual(path(result).slice(-3), ["delegating>verifying:verificationStarted", "verifying>reviewing:freshReviewRequested",
    "reviewing>completed:succeeded"]);
  assert.deepEqual(result.reviews.map(r => [r.cycle, r.findings.length, r.outcome]), [[1, 0, "clean"]]);
  const [session] = reviewerSessions(h);
  assert.deepEqual([session?.role, session?.posture, session?.workspaceLeaseId], ["Reviewer", "readOnly", result.lease?.leaseId]);
  assert.equal(h.counts.get("adjudication"), undefined, "nothing to adjudicate");
  assert.equal(h.writer.sessions.length, 1);
});

test("O4 the Reviewer gets bounded evidence only: no Worker self-report, Lead reasoning or transcript", async () => {
  const h = harness();
  await h.engine.run(request(highTask));
  const [review] = h.reviewer.requests as ReviewRequest[];
  assert.ok(review);
  assert.deepEqual(Object.keys(review).sort(), ["cycle", "evidence", "kind", "limits", "priorFindings"]);
  assert.deepEqual(Object.keys(review.evidence).sort(), ["architecture", "change", "scope", "task", "verification"]);
  const json = JSON.stringify(review);
  assert.ok(!json.includes(WORKER_MARKER), "the implementer's summary and claimed results are withheld");
  assert.ok(!json.includes(PLAN_MARKER), "the Lead's plan is withheld");
  assert.deepEqual(review.evidence.verification, { required: true, passed: true, commands: [{ id: "unit", passed: true }] });
  assert.deepEqual([review.evidence.change.kind, review.evidence.change.truncated], ["diff", false]);
  assert.deepEqual(review.evidence.change.changedPaths, ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(review.priorFindings, []);
  // An oversized change is truncated to the bound and flagged, never forwarded whole.
  const large = harness();
  large.workspace.diffText = "x".repeat(REVIEW_EVIDENCE_LIMITS.maxChangeChars + 10);
  await large.engine.run(request(highTask));
  const [bounded] = large.reviewer.requests as ReviewRequest[];
  assert.deepEqual([bounded?.evidence.change.text.length, bounded?.evidence.change.truncated], [REVIEW_EVIDENCE_LIMITS.maxChangeChars, true]);
});

test("O4 every review is a fresh session; a reused session is refused", async () => {
  const h = harness({ review: ({ call }) => call === 1 ? report(finding("F1", "HIGH")) : report() });
  const result = await h.engine.run(request(highTask));
  assert.equal(result.state, "completed", JSON.stringify(result.error));
  const sessions = reviewerSessions(h);
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0]!.id, sessions[1]!.id);
  assert.equal(h.reviewer.closes, 2, "each Reviewer session is closed after its single turn");
  const reused = harness();
  reused.reviewer.reuseSessionId = "fixed-id";
  reused.review = ({ call }) => call === 1 ? report(finding("F1", "HIGH")) : report();
  const refused = await reused.engine.run(request(highTask));
  assert.deepEqual([refused.state, refused.error?.kind], ["failed", "SecurityViolation"], "the second review would reuse state");
  assert.equal(reused.counts.get("review"), 1);
});

test("O4 without an eligible fresh Reviewer the workflow fails closed; the Worker is never used as a Reviewer", async () => {
  const h = harness({ reviewer: false });
  const result = await h.engine.run(request(highTask));
  assert.deepEqual([result.state, result.error?.kind, result.transitions.at(-1)?.reason], ["failed", "CapabilityUnavailable", "policyFailure"]);
  assert.equal(h.writer.sessions.length + h.lead.sessions.length + h.workspace.acquired.length, 0, "decided before any work");
  // Escalated mid-flow (medium verification failure, then a pass): the typed result is reviewRequired, never success.
  const escalated = harness({ reviewer: false, verdicts: [{ passed: false, commandsRun: 1, failedCommand: "unit",
    failure: { kind: "VerificationFailure", safeMessage: "failed", retryable: false } }] });
  const pending = await escalated.engine.run(request(mediumTask));
  assert.deepEqual([pending.state, pending.error?.kind, pending.pendingStage, pending.transitions.at(-1)?.reason],
    ["reviewRequired", "CapabilityUnavailable", "freshReviewAndAdjudication", "reviewUnavailable"]);
  assert.ok(!escalated.writer.sessions.some(s => s.role === "Reviewer"));
  // A Lead that cannot adjudicate structurally is equally unavailable.
  const noAdjudicator = harness({ leadStructured: false });
  const refused = await noAdjudicator.engine.run(request(highTask));
  assert.deepEqual([refused.state, refused.error?.kind], ["failed", "CapabilityUnavailable"]);
});

test("O4 Reviewer eligibility is capability-driven and keeps the strict read-only surface", async () => {
  const r = harness();
  const candidate = (transport: string, write: boolean, extra: Partial<CapabilitySnapshot>, structured = true): RoleCandidate => {
    const adapter = new FakeAdapter("p", transport, snapshot("p", transport, write, extra), r);
    if (!structured) (adapter as { runStructuredTurn?: unknown }).runStructuredTurn = undefined;
    return { adapter, binding: { role: "Reviewer", provider: "p", transport, model: { id: "m", effort: "e" }, requires: {} } };
  };
  const candidates = [candidate("t-write", true, {}), candidate("t-shell", false, { shell: { available: true, sandboxed: true } }),
    candidate("t-web", false, { webToolsDisabled: "unknown" }), candidate("t-plain", false, {}, false)];
  await assert.rejects(resolveRole("Reviewer", candidates, { shell: false, network: false }, { structuredTurns: true }),
    (e: unknown) => e instanceof PolicyRoutingFailure && JSON.stringify(e.rejections.map(x => x.reason)) ===
      JSON.stringify(["postureUnmet", "capabilityExceedsTask", "capabilityExceedsTask", "structuredTurnUnsupported"]));
  // Even when the task itself requested shell and network, the Reviewer is routed with neither.
  const task = { ...highTask, requestedCapabilities: { write: true, shell: true, network: true } };
  const web = harness({ reviewer: { webToolsDisabled: "unknown" } });
  web.writer.caps = snapshot("provider-one", "writer-transport", true, { shell: { available: true, sandboxed: false }, webToolsDisabled: false });
  const result = await web.engine.run(request(task));
  assert.deepEqual([result.state, result.error?.kind], ["failed", "CapabilityUnavailable"]);
});

// ---------------------------------------------------------------------------------------------------------------
// Findings

const provenance = { cycle: 1, runId: "run-1", sessionId: "s-9", role: "Reviewer" as const };
const malformedOutput = (e: unknown) => e instanceof FusionFailure && e.error.kind === "MalformedOutput";

test("O4 findings are validated, bounded and given deterministic canonical IDs and provenance", () => {
  const input = report(finding("F1", "BLOCKER", { facts: [{ kind: "unrunClaim", test: "e2e" }] }), finding("f-2", "INFO", { lines: undefined as never }));
  delete (input.findings[1] as { lines?: unknown }).lines;
  const [first, second] = validateReviewReport(input, provenance);
  assert.equal(first?.id, "r1-F1");
  assert.deepEqual(first?.source, { role: "Reviewer", runId: "run-1", sessionId: "s-9", cycle: 1 });
  assert.deepEqual(first?.facts, [{ kind: "unrunClaim", test: "e2e" }]);
  assert.equal(second?.id, "r1-f-2");
  assert.deepEqual(validateReviewReport(input, provenance), validateReviewReport(input, provenance), "deterministic");
  assert.equal(validateReviewReport(input, { ...provenance, cycle: 2 })[0]?.id, "r2-F1", "IDs never collide across cycles");
  assert.deepEqual(validateReviewReport(report(), provenance), [], "zero findings is a valid review");
  assert.ok(Object.isFrozen(first));
});

test("O4 malformed, oversized or duplicate findings fail closed", () => {
  const bad: unknown[] = [
    null, "looks good to me", { findings: [], summary: "ok", verdict: "approve" }, { summary: "LGTM" },
    report(finding("F1", "CRITICAL" as never)), report(finding("F1", "HIGH", { confidence: "CERTAIN" as never })),
    report(finding("F1", "HIGH", { evidence: ["x".repeat(REVIEW_LIMITS.maxEvidenceChars + 1)] })),
    report(finding("F1", "HIGH", { evidence: Array.from({ length: REVIEW_LIMITS.maxEvidenceItems + 1 }, () => "e") })),
    report(finding("F1", "HIGH", { evidence: [] })), report(finding("F1", "HIGH", { title: "two\nlines" })),
    report(finding("F1", "HIGH", { file: "../outside.ts" })), report(finding("F1", "HIGH", { lines: { start: 9, end: 2 } })),
    report(finding("F1", "HIGH", { failureScenario: " " })), report(finding("bad id!", "HIGH")),
    report(finding("F1", "HIGH"), finding("f1", "LOW")),
    report(...Array.from({ length: REVIEW_LIMITS.maxFindings + 1 }, (_, i) => finding(`F${i}`, "LOW"))),
    report(finding("F1", "HIGH", { facts: [{ kind: "rumour", text: "trust me" } as never] })),
    { ...report(finding("F1", "HIGH")), transcript: ["..."] },
    { findings: [{ ...finding("F1", "HIGH"), reasoning: "hidden chain of thought" }], summary: "" },
  ];
  for (const [index, value] of bad.entries())
    assert.throws(() => validateReviewReport(value, provenance), malformedOutput, `case ${index}`);
});

test("O4 review outcome policy by severity and verdict", () => {
  const rec = (severity: ReviewerFinding["severity"], verdict: AdjudicatedFinding["verdict"], action: AdjudicatedFinding["requiredAction"]) => {
    const [f] = validateReviewReport(report(finding("F1", severity)), provenance);
    return { finding: f!, verdict, rationale: "r", requiredAction: action, verdictSource: "lead" as const, supportedFacts: [] };
  };
  assert.deepEqual(reviewOutcome([], true), { kind: "clean" });
  assert.deepEqual(reviewOutcome([rec("LOW", "CONFIRMED", "followUp"), rec("INFO", "CONFIRMED", "none")], true), { kind: "clean" });
  assert.equal(reviewOutcome([rec("MEDIUM", "CONFIRMED", "fix")], true).kind, "correction");
  assert.equal(reviewOutcome([rec("HIGH", "PARTIAL", "fix")], true).kind, "correction");
  assert.deepEqual(reviewOutcome([rec("HIGH", "CONFIRMED", "fix")], false), { kind: "gate", state: "decisionRequired" });
  assert.deepEqual(reviewOutcome([rec("BLOCKER", "CONFIRMED", "fix")], false), { kind: "gate", state: "humanGateRequired" });
  assert.deepEqual(reviewOutcome([rec("HIGH", "CONFIRMED", "humanDecision")], true), { kind: "gate", state: "decisionRequired" });
  assert.deepEqual(reviewOutcome([rec("BLOCKER", "UNVERIFIABLE", "humanDecision")], true), { kind: "gate", state: "humanGateRequired" });
  assert.deepEqual(reviewOutcome([rec("HIGH", "UNVERIFIABLE", "none")], true), { kind: "gate", state: "decisionRequired" });
  assert.deepEqual(reviewOutcome([rec("MEDIUM", "UNVERIFIABLE", "none"), rec("BLOCKER", "REJECTED", "none")], true), { kind: "clean" });
});

// ---------------------------------------------------------------------------------------------------------------
// Adjudication

test("O4 adjudication covers exactly the finding set, one consistent verdict each", () => {
  const findings = validateReviewReport(report(finding("F1", "HIGH"), finding("F2", "LOW")), provenance);
  const entry = (findingId: string, verdict: string, requiredAction: string) => ({ findingId, verdict, rationale: "r", requiredAction });
  const good = { summary: "", adjudications: [entry("r1-F1", "PARTIAL", "fix"), entry("r1-F2", "REJECTED", "none")] };
  assert.equal(validateAdjudicationReport(good, findings).adjudications.length, 2);
  const bad: unknown[] = [
    { summary: "", adjudications: [entry("r1-F1", "CONFIRMED", "fix")] },
    { summary: "", adjudications: [entry("r1-F1", "CONFIRMED", "fix"), entry("r1-F1", "REJECTED", "none")] },
    { summary: "", adjudications: [entry("r1-F1", "CONFIRMED", "fix"), entry("r1-F2", "REJECTED", "none"), entry("r1-F3", "REJECTED", "none")] },
    { summary: "", adjudications: [entry("r1-F1", "CONFIRMED", "fix"), entry("r2-F2", "REJECTED", "none")] },
    { summary: "", adjudications: [entry("r1-F1", "APPROVED", "fix"), entry("r1-F2", "REJECTED", "none")] },
    { summary: "", adjudications: [entry("r1-F1", "CONFIRMED", "followUp"), entry("r1-F2", "REJECTED", "none")] },
    { summary: "", adjudications: [entry("r1-F1", "REJECTED", "fix"), entry("r1-F2", "REJECTED", "none")] },
    { summary: "", adjudications: [entry("r1-F1", "UNVERIFIABLE", "fix"), entry("r1-F2", "REJECTED", "none")] },
    { summary: "", adjudications: [{ ...entry("r1-F1", "CONFIRMED", "fix"), rationale: "" }, entry("r1-F2", "REJECTED", "none")] },
    { adjudications: [], summary: "All fine, trust me." }, "CONFIRMED all",
  ];
  for (const [index, value] of bad.entries())
    assert.throws(() => validateAdjudicationReport(value, findings), malformedOutput, `case ${index}`);
});

test("O4 Fusion's deterministic evidence outranks a Lead's rejection", () => {
  const findings = validateReviewReport(report(
    finding("F1", "HIGH", { facts: [{ kind: "verificationCommand", commandId: "unit" }] }),
    finding("F2", "HIGH", { facts: [{ kind: "unrunClaim", test: "e2e" }] }),
    finding("F3", "MEDIUM", { facts: [{ kind: "outOfScopeChange", path: "src/c.ts" }] }),
    finding("F4", "HIGH", { facts: [{ kind: "verificationCommand", commandId: "unit" }] })), provenance);
  const failing = { verification: new Map([["unit", false]]), changedPaths: ["src/a.ts", "src/c.ts"], allowedScope: ["src/a.ts"],
    claimedTests: ["e2e"] };
  const facts = new Map(findings.map(f => [f.id, evaluateFacts(f, failing).supported]));
  const rejected = { summary: "", adjudications: findings.map(f => ({ findingId: f.id, verdict: "REJECTED" as const, rationale: "Not a bug.",
    requiredAction: "none" as const })) };
  const records = adjudicate(findings, validateAdjudicationReport(rejected, findings), facts);
  assert.deepEqual(records.map(r => [r.verdict, r.verdictSource, r.requiredAction]), [
    ["CONFIRMED", "fusionEvidence", "fix"], ["CONFIRMED", "fusionEvidence", "fix"],
    ["CONFIRMED", "fusionEvidence", "fix"], ["CONFIRMED", "fusionEvidence", "fix"]]);
  // A fact Fusion observed to be false does not help the finding, and a Lead may still reject it.
  const passing = { verification: new Map([["unit", true]]), changedPaths: ["src/a.ts"], allowedScope: ["src/a.ts"], claimedTests: [] };
  assert.deepEqual(evaluateFacts(findings[0]!, passing), { supported: [], contradicted: [{ kind: "verificationCommand", commandId: "unit" }] });
  const kept = adjudicate(findings, validateAdjudicationReport(rejected, findings),
    new Map(findings.map(f => [f.id, evaluateFacts(f, passing).supported])));
  assert.ok(kept.every(r => r.verdict === "REJECTED" && r.verdictSource === "lead"));
});

test("O4 in the workflow, a rejected finding backed by Fusion evidence still forces the fix cycle", async () => {
  const h = harness({
    scripts: { Worker: ctx => { const out = writeAllowed(ctx) as ResultPacket; return { ...out, verification: { testsRun: ["unit", "e2e"], results: ["pass"] } }; } },
    review: ({ call }) => call === 1 ? report(finding("F1", "HIGH", { facts: [{ kind: "unrunClaim", test: "e2e" }] })) : report(),
    adjudication: ({ request }) => verdicts(request, "REJECTED") });
  const result = await h.engine.run(request(highTask));
  const first = result.reviews[0]!.adjudications[0]!;
  assert.deepEqual([first.verdict, first.verdictSource, first.supportedFacts], ["CONFIRMED", "fusionEvidence", [{ kind: "unrunClaim", test: "e2e" }]]);
  assert.deepEqual([result.state, result.reviews.map(r => r.outcome)], ["completed", ["correction", "clean"]]);
  const adjudicationRequest = h.lead.requests.find(r => r.kind === "adjudication") as AdjudicationRequest;
  assert.deepEqual(adjudicationRequest.fusionFacts, [{ findingId: "r1-F1", supported: [{ kind: "unrunClaim", test: "e2e" }], contradicted: [] }]);
});

// ---------------------------------------------------------------------------------------------------------------
// Bounded fix cycle

test("O4 a confirmed finding gets exactly one corrective attempt, verification and a fresh re-review", async () => {
  const h = harness({ review: ({ call }) => call === 1 ? report(finding("F1", "HIGH")) : report() });
  const result = await h.engine.run(request(highTask));
  assert.equal(result.state, "completed", JSON.stringify(result.error));
  assert.deepEqual(result.reviews.map(r => [r.cycle, r.outcome]), [[1, "correction"], [2, "clean"]]);
  assert.equal(result.delegateAttempts, 2);
  assert.deepEqual(path(result).filter(p => p.includes("retrying")), ["adjudicating>retrying:reviewFindingsConfirmed", "retrying>delegating:delegated"]);
  const corrective = h.writer.packets[1]!;
  assert.ok(corrective.task.constraints.some(c => c.startsWith("Fix r1-F1 [HIGH] HIGH issue F1") && c.includes("Suggested fix: Save before returning.")));
  const reReview = h.reviewer.requests[1] as ReviewRequest;
  assert.deepEqual([reReview.cycle, reReview.priorFindings.map(f => f.id)], [2, ["r1-F1"]], "only the accepted findings are carried over");
  assert.equal(h.verifier.calls.length, 2);
  assert.notEqual(reviewerSessions(h)[0]!.id, reviewerSessions(h)[1]!.id);
});

test("O4 findings that survive the second review stop at a decision or the human gate; never a third attempt", async () => {
  for (const [severity, state] of [["HIGH", "decisionRequired"], ["MEDIUM", "decisionRequired"], ["BLOCKER", "humanGateRequired"]] as const) {
    const h = harness({ review: () => report(finding("F1", severity)) });
    const result = await h.engine.run(request(highTask));
    assert.deepEqual([result.state, result.transitions.at(-1)?.reason], [state, "unresolvedFindings"], severity);
    assert.equal(h.counts.get("Worker"), 2, `${severity}: never a third Worker attempt`);
    assert.equal(h.counts.get("review"), 2);
    assert.deepEqual(result.reviews.map(r => r.outcome), ["correction", "gate"]);
    if (state === "humanGateRequired") assert.equal(result.pendingStage, "humanGate");
  }
  // Unverifiable or human-decision findings are never sent back for autonomous fixing.
  const unverifiable = harness({ review: () => report(finding("F1", "BLOCKER")), adjudication: ({ request }) => verdicts(request, "UNVERIFIABLE") });
  const stopped = await unverifiable.engine.run(request(highTask));
  assert.deepEqual([stopped.state, unverifiable.counts.get("Worker")], ["humanGateRequired", 1]);
  const rejected = harness({ review: () => report(finding("F1", "BLOCKER")), adjudication: ({ request }) => verdicts(request, "REJECTED") });
  assert.equal((await rejected.engine.run(request(highTask))).state, "completed", "a rejected finding does not block");
});

test("O4 an O3 retry and the corrective attempt share one budget", async () => {
  const failed = { passed: false, commandsRun: 1, failedCommand: "unit",
    failure: { kind: "VerificationFailure" as const, safeMessage: "failed", retryable: false } };
  const h = harness({ verdicts: [failed], review: () => report(finding("F1", "HIGH")) });
  const result = await h.engine.run(request(highTask));
  assert.deepEqual([result.state, h.counts.get("Worker"), h.counts.get("review")], ["decisionRequired", 2, 1],
    "the retry used the second attempt, so the finding cannot trigger a third");
  // Both attempts fail verification: no review ever runs on unverified work.
  const neither = harness({ verdicts: [failed, failed] });
  const stopped = await neither.engine.run(request(highTask));
  assert.deepEqual([stopped.state, stopped.transitions.at(-1)?.reason, neither.reviewer.sessions.length], ["decisionRequired", "retryExhausted", 0]);
  // The corrective attempt fails verification: stop, with no second review.
  const postFix = harness({ verdicts: [{ passed: true, commandsRun: 1 }, failed], review: () => report(finding("F1", "HIGH")) });
  const after = await postFix.engine.run(request(highTask));
  assert.deepEqual([after.state, after.transitions.at(-1)?.reason, after.error?.kind, postFix.counts.get("review")],
    ["decisionRequired", "retryExhausted", "VerificationFailure", 1]);
});

// ---------------------------------------------------------------------------------------------------------------
// Failures, cancellation and timeouts

test("O4 malformed or failed review and adjudication fail closed", async () => {
  for (const review of [() => "Looks good to me!", () => ({ findings: "none", summary: "" }),
    ({ session }: { session: Session }) => ({ status: "completed", effectiveProvider: session.provider })]) {
    const h = harness({ review: review as StructuredScript<ReviewRequest> });
    const result = await h.engine.run(request(highTask));
    assert.deepEqual([result.state, result.error?.kind], ["failed", "MalformedOutput"]);
  }
  const missing = harness({ review: () => report(finding("F1", "HIGH"), finding("F2", "LOW")),
    adjudication: ({ request }) => ({ ...verdicts(request, "CONFIRMED"), adjudications: verdicts(request, "CONFIRMED").adjudications.slice(0, 1) }) });
  const partial = await missing.engine.run(request(highTask));
  assert.deepEqual([partial.state, partial.error?.kind, partial.transitions.at(-1)?.reason], ["failed", "MalformedOutput", "malformedResult"]);
  const failing = harness({ review: () => report(finding("F1", "HIGH")), adjudication: ({ session }) => ({ status: "failed",
    effectiveProvider: session.provider, effectiveModel: "m", artifactRefs: [], error: { kind: "ProcessFailure", safeMessage: "crashed", retryable: false } }) });
  const crashed = await failing.engine.run(request(highTask));
  assert.deepEqual([crashed.state, crashed.error?.kind, crashed.transitions.at(-1)?.reason], ["failed", "ProcessFailure", "providerFailure"]);
});

test("O4 a Reviewer cannot change its result after validation", async () => {
  const h = harness({ review: () => {
    const out = report(finding("F1", "LOW"));
    setImmediate(() => { (out.findings[0] as { severity: string }).severity = "BLOCKER"; });
    return out;
  }, adjudication: ({ request }) => verdicts(request, "CONFIRMED", "followUp") });
  const result = await h.engine.run(request(highTask));
  await new Promise(done => setImmediate(done));
  assert.deepEqual([result.state, result.reviews[0]!.findings[0]!.severity], ["completed", "LOW"]);
});

test("O4 cancellation and timeouts during review and adjudication end the workflow, never in success", async () => {
  const controller = new AbortController();
  const h = harness({ review: () => { controller.abort(); return new Promise(() => undefined); } });
  const cancelled = await h.engine.run(request(highTask, { signal: controller.signal }));
  assert.deepEqual([cancelled.state, cancelled.error?.kind], ["cancelled", "Cancelled"]);
  assert.equal(h.reviewer.cancels, 1);
  const timed = harness({ review: () => new Promise(() => undefined) });
  const timeout = await timed.engine.run(request(highTask, { timeoutMs: 60 }));
  assert.deepEqual([timeout.state, timeout.error?.kind], ["failed", "Timeout"]);
  const adjudicationAbort = new AbortController();
  const a = harness({ review: () => report(finding("F1", "HIGH")), adjudication: () => { adjudicationAbort.abort(); return new Promise(() => undefined); } });
  const stopped = await a.engine.run(request(highTask, { signal: adjudicationAbort.signal }));
  assert.deepEqual([stopped.state, stopped.error?.kind], ["cancelled", "Cancelled"]);
  assert.ok(!stopped.transitions.some(t => t.to === "completed"));
  // Cancelled between verification and review: the Reviewer never starts.
  const between = new AbortController();
  const b = harness();
  b.verifier.verify = async plan => { between.abort(); return { passed: true, commandsRun: plan.commands.length }; };
  const early = await b.engine.run(request(highTask, { signal: between.signal }));
  assert.deepEqual([early.state, b.reviewer.sessions.length], ["cancelled", 0]);
});

test("O4 an event-store failure never turns a review into success, nor masks a security failure", async () => {
  for (const type of ["reviewCycle", "review", "finding", "adjudication"] as const) {
    const h = harness({ review: ({ call }) => call === 1 ? report(finding("F1", "HIGH")) : report() });
    h.sink.failOn = event => event.type === type;
    const result = await h.engine.run(request(highTask));
    assert.deepEqual([result.state, result.error?.kind], ["failed", "InternalError"], type);
  }
  const h = harness({ review: ({ h: hh }) => { hh.workspace.primaryVersion++; return report(); } });
  h.sink.failOn = event => event.type === "risk" && event.level === "critical";
  const result = await h.engine.run(request(highTask));
  assert.deepEqual([result.state, result.error?.kind], ["failed", "SecurityViolation"]);
});

// ---------------------------------------------------------------------------------------------------------------
// State separation, gates and the primary workspace

test("O4 answered never becomes completed, even after a clean fresh review", async () => {
  const h = harness();
  const answered = await h.engine.run(request(highRead));
  assert.equal(answered.risk?.level, "high");
  assert.deepEqual([answered.state, path(answered).at(-1)], ["answered", "reviewing>answered:answeredWithoutVerification"]);
  const review = h.reviewer.requests[0] as ReviewRequest;
  assert.deepEqual([review.evidence.change.kind, review.evidence.verification.passed], ["answer", false]);
  const flagged = harness({ review: () => report(finding("F1", "HIGH")) });
  const gated = await flagged.engine.run(request(highRead));
  assert.equal(gated.state, "decisionRequired", "a read-only answer has no implementer to fix it");
  const verified = await harness().engine.run(request({ ...highRead, verification: { required: true, planProvided: true } }));
  assert.equal(verified.state, "completed", "verified read-only work may complete after review");
});

test("O4 CRITICAL still stops at the human gate before any writer or review", async () => {
  const h = harness();
  const result = await h.engine.run(request(criticalTask));
  assert.deepEqual([result.state, result.pendingStage], ["humanGateRequired", "humanGate"]);
  assert.equal(h.writer.sessions.length + h.reviewer.sessions.length + h.workspace.acquired.length, 0);
});

test("O4 review and adjudication turns are read-only: lease and primary are proven unchanged", async () => {
  const primary = harness({ review: ({ h: hh }) => { hh.workspace.primaryVersion++; return report(); } });
  const touched = await primary.engine.run(request(highTask));
  assert.deepEqual([touched.state, touched.error?.kind, touched.risk?.level], ["failed", "SecurityViolation", "critical"]);
  const lease = harness({ review: () => report(finding("F1", "HIGH")), adjudication: ({ request, h: hh }) => { hh.workspace.leaseVersion++; return verdicts(request, "REJECTED"); } });
  const changed = await lease.engine.run(request(highTask));
  assert.deepEqual([changed.state, changed.error?.kind], ["failed", "SecurityViolation"]);
});

test("O4 medium writers that touch their own verification get a fresh review; other medium work keeps the Lead review", async () => {
  const task: TaskRequest = { ...mediumTask, paths: ["src/a.ts", "jest.config.js"] };
  const h = harness();
  const result = await h.engine.run(request(task));
  assert.equal(result.risk?.level, "medium");
  assert.deepEqual([result.state, result.reviews.length], ["completed", 1]);
  const plain = harness();
  const lead = await plain.engine.run(request(mediumTask));
  assert.deepEqual([lead.state, lead.reviews.length, path(lead).at(-2)], ["completed", 0, "verifying>reviewing:reviewRequested"]);
  assert.equal(plain.reviewer.sessions.length, 0, "no expensive fresh review where the policy does not require one");
});

// ---------------------------------------------------------------------------------------------------------------
// Neutrality, storage and the Writer gate

test("O4 review semantics are provider-neutral: swapping every identity changes nothing", async () => {
  const run = async (ids: { provider: string; model: string }) => {
    const h = harness({ ids, review: ({ call }) => call === 1 ? report(finding("F1", "HIGH")) : report() });
    const result = await h.engine.run({ ...request(highTask), runId: "same-run" });
    return { result, events: h.sink.events };
  };
  const a = await run({ provider: "alpha", model: "alpha-large" }), b = await run({ provider: "zeta", model: "z-9" });
  assert.deepEqual(a.result.transitions, b.result.transitions);
  // Identity appears only as recorded provenance of who served each structured turn, never in review semantics.
  const anonymous = (events: WorkflowEvent[]) => events.map(event => event.type !== "structuredTurn" ? event
    : { ...event, provenance: { ...event.provenance, provider: "P", requestedModel: "M", observedModel: "M" } });
  const strip = (events: WorkflowEvent[]) => JSON.parse(JSON.stringify(anonymous(events)).replace(/lead-transport-s\d+|review-transport-s\d+/gu, "S"));
  assert.deepEqual(strip(a.events), strip(b.events));
  assert.doesNotMatch(JSON.stringify(anonymous(a.events)), /alpha|large/u);
  const provenance = a.events.flatMap(event => event.type === "structuredTurn" ? [event.provenance] : []);
  assert.deepEqual(provenance.map(p => [p.kind, p.role, p.provider, p.requestedModel]),
    [["review", "Reviewer", "alpha", "alpha-large"], ["adjudication", "Lead", "alpha", "alpha-large"], ["review", "Reviewer", "alpha", "alpha-large"]]);
  const forbidden = /claude|muse|anthropic|\bmeta\b|opus|spark|\bgpt|gemini|openai|llama/iu;
  for (const dir of ["review", "workflow", "policy"]) for (const name of await readdir(join(process.cwd(), "src", "core", dir)))
    if (name.endsWith(".ts")) assert.doesNotMatch(await readFile(join(process.cwd(), "src", "core", dir, name), "utf8"), forbidden, name);
});

test("O4 findings and adjudications persist as bounded, redacted events with full records as artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fusion-o4-events-"));
  try {
    const run = await RunStore.create(dir);
    const store = await run.openEvents(), artifacts = await run.openArtifacts();
    const h = harness({ review: ({ call }) => call === 1 ? report(finding("F1", "HIGH")) : report() });
    const engine = new WorkflowEngine({ roles: (h.engine as unknown as { config: { roles: RoleCandidate[] } }).config.roles,
      workspace: h.workspace, verifier: h.verifier, events: new EventStoreWorkflowSink(store, artifacts) });
    const result = await engine.run({ ...request(highTask), runId: run.runId });
    assert.equal(result.state, "completed");
    const events = (await store.listEvents()).events;
    const types = events.map(e => e.type).filter(t => !["WorkflowTransition", "RiskAssessed"].includes(t));
    assert.deepEqual(types, ["ReviewCycleStarted", "ReviewStarted", "StructuredTurnObserved", "FindingRecorded", "ReviewCompleted",
      "StructuredTurnObserved", "AdjudicationRecorded", "ReviewCycleCompleted", "ReviewCycleStarted", "ReviewStarted",
      "StructuredTurnObserved", "ReviewCompleted", "ReviewCycleCompleted"]);
    // Provenance of each structured turn is persisted before its output is used.
    const provenance = events.filter(e => e.type === "StructuredTurnObserved").map(e => e.payload as unknown as Record<string, unknown>);
    assert.deepEqual(provenance.map(p => [p.cycle, p.kind, p.role]), [[1, "review", "Reviewer"], [1, "adjudication", "Lead"], [2, "review", "Reviewer"]]);
    assert.ok(provenance.every(p => typeof p.sessionId === "string" && p.observedModel === "opaque" && typeof p.provider === "string"));
    const recorded = events.find(e => e.type === "FindingRecorded")!.payload as Record<string, unknown>;
    assert.deepEqual([recorded.findingId, recorded.severity, recorded.cycle], ["r1-F1", "HIGH", 1]);
    const adjudicated = events.find(e => e.type === "AdjudicationRecorded")!.payload as Record<string, unknown>;
    assert.deepEqual([adjudicated.verdict, adjudicated.requiredAction, adjudicated.verdictSource], ["CONFIRMED", "fix", "lead"]);
    assert.ok(!JSON.stringify(events).includes("Checked r1-F1"), "rationale lives only in the artifact");
    const full = JSON.parse(await readFile(await artifacts.getArtifactPath(adjudicated.artifactRef as string), "utf8"));
    assert.equal(full.rationale, "Checked r1-F1.");
    // Completion is recorded only after every adjudication.
    const completedAt = events.findIndex(e => e.type === "WorkflowTransition" && (e.payload as { to: string }).to === "completed");
    assert.ok(completedAt > events.findIndex(e => e.type === "AdjudicationRecorded"));
    for (const bad of [{ type: "FindingRecorded", payload: { ...recorded, severity: "CRITICAL" } },
      { type: "FindingRecorded", payload: { ...recorded, findingId: "../x" } },
      { type: "AdjudicationRecorded", payload: { ...adjudicated, verdict: "APPROVED" } },
      { type: "ReviewCompleted", payload: { cycle: 1, findingCount: 10_000 } }])
      await assert.rejects(store.append({ source: "review", ...bad } as unknown as EventInput), StorageError);
  } finally {
    assert.ok(resolve(dir).toLowerCase().startsWith(`${resolve(tmpdir()).toLowerCase()}${sep}`));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("O4 real Writer mode stays blocked: the gate is documented and real adapters cannot write or review", async () => {
  const doc = await readFile(join(process.cwd(), "docs", "o3-workflow.md"), "utf8");
  for (const line of ["REAL_WRITER_MODE_BLOCKED_UNTIL:", "- ignored-path influence is controlled",
    "- shared Git/common-directory state is protected", "- verification executes in an appropriately isolated/reconstructed environment",
    "- real adapter writer posture is capability-proven", "workspace isolation, not a security sandbox"])
    assert.ok(doc.includes(line), line);
  // O5.5A activated read-only structured review turns; neither adapter gained any writer path.
  const { ClaudeAdapter } = await import("../src/providers/claude/claude-adapter.js");
  const { MuseAdapter } = await import("../src/providers/muse/muse-adapter.js");
  assert.equal(typeof (ClaudeAdapter.prototype as { runStructuredTurn?: unknown }).runStructuredTurn, "function");
  assert.equal(typeof (MuseAdapter.prototype as { runStructuredTurn?: unknown }).runStructuredTurn, "undefined",
    "Muse structured turns exist only on an Exec-bound instance");
  const sources = [await readFile(join(process.cwd(), "src", "providers", "claude", "one-shot-transport.ts"), "utf8"),
    await readFile(join(process.cwd(), "src", "providers", "muse", "types.ts"), "utf8")];
  assert.match(sources[0]!, /posture !== "readOnly"\) fail\("CapabilityUnavailable"/u);
  assert.match(sources[1]!, /posture !== "readOnly"\) fail\("CapabilityUnavailable"/u);
});

test("O4 adversarial: reviewer text forwarded to the Worker is risk-scanned; reviewer prose never reaches the Lead", async () => {
  const h = harness({ review: () => ({ ...report(finding("F1", "HIGH", { suggestedFix: "Reset the branch with git push --force origin main." })),
    summary: "REVIEWER-PROSE-5d1e looks good overall" }) });
  const result = await h.engine.run(request(highTask));
  assert.deepEqual([result.state, path(result).at(-1)], ["humanGateRequired", "retrying>humanGateRequired:humanGateRequiredForRisk"]);
  assert.equal(h.counts.get("Worker"), 1, "the destructive suggestion never reaches a second Worker attempt");
  const adjudicationRequest = h.lead.requests.find(r => r.kind === "adjudication");
  assert.ok(adjudicationRequest && !JSON.stringify(adjudicationRequest).includes("REVIEWER-PROSE-5d1e"));
  assert.deepEqual(Object.keys(adjudicationRequest).sort(), ["cycle", "evidence", "findings", "fusionFacts", "kind"]);
});

test("O4 the real lease diff is bounded review evidence and never changes the lease", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { ProcessGitClient } = await import("../src/platform/workspace/git.js");
  const { WorkspaceLeaseManager } = await import("../src/platform/workspace/lease.js");
  const { LeaseWorkspacePort } = await import("../src/platform/workflow/ports.js");
  if (spawnSync("git", ["--version"], { windowsHide: true }).status !== 0) return;
  const dir = await mkdtemp(join(tmpdir(), "fusion-o4-diff-"));
  try {
    const root = join(dir, "repo");
    await mkdir(join(root, "src"), { recursive: true });
    const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false",
      "-c", `core.hooksPath=${join(root, ".no-hooks")}`, ...args], { cwd: root, windowsHide: true });
    git("init", "-q"); git("config", "core.autocrlf", "false");
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
    git("add", "."); git("commit", "-qm", "init");
    const client = await ProcessGitClient.fromPath();
    const leases = await WorkspaceLeaseManager.open({ repositoryRoot: root, git: client });
    const port = new LeaseWorkspacePort(leases, client);
    const handle = await port.acquire("o4-diff-owner");
    try {
      await writeFile(join(handle.path, "src", "a.ts"), "export const a = 2;\n");
      await writeFile(join(handle.path, "src", "new.ts"), "export const b = 3;\n");
      await writeFile(join(handle.path, "src", "blob.bin"), Buffer.from([1, 0, 2, 0]));
      const before = await port.fingerprint(handle);
      const diff = await port.diff(handle);
      assert.equal(await port.fingerprint(handle), before, "taking the diff does not touch the lease or its index");
      assert.match(diff.text, /-export const a = 1;\n\+export const a = 2;/u);
      assert.match(diff.text, /\+\+\+ b\/src\/new\.ts\n\+export const b = 3;/u);
      assert.match(diff.text, /src\/blob\.bin\nnew file \(untracked\)\n--- \/dev\/null\n\+\+\+ b\/src\/blob\.bin\n\(binary\)/u);
      assert.doesNotMatch(diff.text, /\n\+\n$/u, "a final newline does not render as an extra empty line");
      assert.equal(diff.truncated, false);
    } finally { await leases.release(handle.leaseId, handle.ownerId, { discardChanges: true }); }
  } finally {
    assert.ok(resolve(dir).toLowerCase().startsWith(`${resolve(tmpdir()).toLowerCase()}${sep}`));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
