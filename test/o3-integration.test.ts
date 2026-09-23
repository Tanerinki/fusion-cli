import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import type { CapabilitySnapshot, DelegationPacket, ProviderAdapter, ResultPacket, Session, TurnResult,
  VerificationPlan } from "../src/core/domain.js";
import type { RoleCandidate } from "../src/core/policy/routing.js";
import type { TaskRequest } from "../src/core/policy/task-inspector.js";
import { WorkflowEngine } from "../src/core/workflow/engine.js";
import type { WorkflowResult } from "../src/core/workflow/types.js";
import { RunStore } from "../src/platform/events/run-store.js";
import { StorageError } from "../src/platform/events/shared.js";
import type { EventInput } from "../src/platform/events/types.js";
import { VerificationEngine } from "../src/platform/verification/engine.js";
import { EngineVerifierPort, EventStoreWorkflowSink, LeaseWorkspacePort } from "../src/platform/workflow/ports.js";
import { ProcessGitClient } from "../src/platform/workspace/git.js";
import { WorkspaceLeaseManager } from "../src/platform/workspace/lease.js";

const gitAvailable = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;
const skip = gitAvailable ? false : "git executable unavailable";

function sh(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=Fusion Test", "-c", "user.email=fusion@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", "-c", `core.hooksPath=${join(cwd, ".no-hooks")}`, ...args],
    { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
}
/** Everything a user could lose: status plus the content of every non-Git, non-Fusion file in the primary. */
async function userState(root: string): Promise<string> {
  const lines = [sh(root, "status", "--porcelain=v1", "-uall"), sh(root, "rev-parse", "HEAD")];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name), rel = relative(root, path);
    if (!entry.isFile() || rel.startsWith(".git") || rel.startsWith(".fusion")) continue;
    lines.push(`${rel}:${createHash("sha256").update(await readFile(path)).digest("hex")}`);
  }
  return lines.sort().join("\n");
}

type WorkerScript = (leasePath: string, attempt: number) => Promise<void>;
const packet = (files: string[]): ResultPacket => ({ result: { status: "completed" }, changes: { files, summary: "edited" },
  verification: { testsRun: ["unit"], results: ["passed"] }, uncertainties: [], failures: [], needsLeadDecision: [] });

/** Scripted, in-memory stand-in for a provider: it only touches the workspace it was bound to. */
class ScriptedAdapter implements ProviderAdapter {
  readonly sessions: Session[] = [];
  attempts = 0;
  constructor(private readonly transport: string, private readonly write: boolean, private readonly worktrees: string,
    private readonly script?: WorkerScript) {}
  async capabilities(): Promise<CapabilitySnapshot> {
    return { provider: "scripted", transport: this.transport, observedAt: "2026-01-01T00:00:00.000Z", runtimeVersion: "1",
      persistentSessions: false, structuredOutput: true, webToolsDisabled: true, filesystem: { read: true, write: this.write },
      shell: { available: false, sandboxed: false }, approvalCallback: false, protocolCancellation: true,
      usageReporting: false, modelIdentityReadback: true, subscriptionLaneReadback: false };
  }
  async authStatus() { return { state: "authenticated" as const, lane: "subscription" as const, observedAt: "", evidence: [] }; }
  async createSession(request: Parameters<ProviderAdapter["createSession"]>[0]): Promise<Session> {
    const session = { id: `s-${this.sessions.length}`, runId: request.runId, role: request.role, provider: "scripted",
      transport: this.transport, workspaceLeaseId: request.workspaceLeaseId, posture: request.posture, providerSessionRef: "x" };
    this.sessions.push(session);
    return session;
  }
  async resumeSession(session: Session): Promise<Session> { return session; }
  async runTurn(session: Session, delegation: DelegationPacket): Promise<TurnResult> {
    if (session.posture === "writer" && this.script) await this.script(join(this.worktrees, session.workspaceLeaseId), ++this.attempts);
    return { status: "completed", output: packet([...delegation.scope.allowedFiles]), effectiveProvider: "scripted",
      effectiveModel: "scripted-model", artifactRefs: [] };
  }
  async cancel(): Promise<void> {}
  async usage() { return null; }
  async close(): Promise<void> {}
}

const task: TaskRequest = { operation: "implement", summary: "Fix both helpers.", paths: ["src/a.txt", "src/b.txt"],
  scopeKnown: true, expectedMutation: "multiFile", requestedCapabilities: { write: true },
  verification: { required: true, planProvided: true } };
const delegation: DelegationPacket = { task: { goal: "Fix both helpers.", constraints: [], acceptanceCriteria: ["Files say fixed."] },
  scope: { relevantFiles: ["src/a.txt", "src/b.txt"], allowedFiles: ["src/a.txt", "src/b.txt"], forbiddenFiles: [] },
  architecture: { decisions: [], invariants: [] }, verification: { requiredTests: ["unit"] }, openQuestions: [] };
const plan: VerificationPlan = { commands: [{ id: "unit", executable: process.execPath, cwd: ".", timeoutMs: 20_000,
  mutationPolicy: "readOnly", args: ["-e",
    "const fs=require('fs');for(const f of ['src/a.txt','src/b.txt'])if(fs.readFileSync(f,'utf8')!=='fixed\\n')process.exit(3)"] }] };

async function scenario(script: WorkerScript, check: (ctx: { result: WorkflowResult; root: string; before: string;
  eventsJson: string; transitions: unknown[]; types: string[] }) => Promise<void>, verification = plan): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "fusion-o3-"));
  const root = join(dir, "repo");
  try {
    await mkdir(join(root, "src"), { recursive: true });
    sh(root, "init", "-q"); sh(root, "config", "core.autocrlf", "false");
    await writeFile(join(root, "src", "a.txt"), "old a\n"); await writeFile(join(root, "src", "b.txt"), "old b\n");
    await writeFile(join(root, "README.md"), "readme\n");
    sh(root, "add", "."); sh(root, "commit", "-qm", "init");
    await writeFile(join(root, "README.md"), "the user's uncommitted edit\n");
    await writeFile(join(root, "notes.txt"), "untracked user notes\n");
    const before = await userState(root);

    const git = await ProcessGitClient.fromPath();
    const leases = await WorkspaceLeaseManager.open({ repositoryRoot: root, git });
    const run = await RunStore.create(root);
    const events = await run.openEvents();
    const reader = new ScriptedAdapter("scripted-read", false, leases.worktreesRoot);
    const writer = new ScriptedAdapter("scripted-write", true, leases.worktreesRoot, script);
    const model = { id: "scripted-model", effort: "normal" };
    const roles: RoleCandidate[] = [
      { binding: { role: "Lead", provider: "scripted", transport: "scripted-read", model, requires: {} }, adapter: reader },
      { binding: { role: "Worker", provider: "scripted", transport: "scripted-write", model, requires: {} }, adapter: writer }];
    const engine = new WorkflowEngine({ roles, workspace: new LeaseWorkspacePort(leases, git),
      verifier: new EngineVerifierPort(new VerificationEngine(), { git, env: { ...process.env }, events }),
      events: new EventStoreWorkflowSink(events) });
    const result = await engine.run({ runId: run.runId, task, packet: delegation, verification });
    try {
      const stored = (await events.listEvents()).events;
      await check({ result, root, before, eventsJson: JSON.stringify(stored), types: stored.map(e => e.type),
        transitions: stored.filter(e => e.type === "WorkflowTransition").map(e => e.payload) });
    } finally {
      if (result.lease) await leases.release(result.lease.leaseId, result.lease.ownerId, { discardChanges: true });
    }
  } finally {
    assert.ok(resolve(dir).toLowerCase().startsWith(`${resolve(tmpdir()).toLowerCase()}${sep}`));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

test("O3 integration: MEDIUM flow over real leases, verification and EventStore leaves the primary untouched", { skip }, async () =>
  scenario(async lease => {
    await writeFile(join(lease, "src", "a.txt"), "fixed\n");
    await writeFile(join(lease, "src", "b.txt"), "fixed\n");
  }, async ({ result, root, before, eventsJson, transitions, types }) => {
    assert.equal(result.state, "completed", JSON.stringify(result.error));
    assert.deepEqual(result.changedPaths, ["src/a.txt", "src/b.txt"]);
    assert.equal(await readFile(join(result.lease!.path, "src", "a.txt"), "utf8"), "fixed\n", "the writer's work is kept in its lease");
    assert.equal(await userState(root), before, "the dirty primary workspace is preserved exactly");
    assert.deepEqual(transitions, result.transitions.map(t => ({ ...t })), "the EventStore log mirrors the state machine");
    assert.deepEqual(types.filter(t => t !== "ProcessObserved"), ["WorkflowTransition", "RiskAssessed", "WorkflowTransition",
      "WorkflowTransition", "WorkflowTransition", "WorkflowTransition", "WorkflowTransition", "VerificationObserved",
      "WorkflowTransition", "WorkflowTransition"]);
    assert.doesNotMatch(eventsJson, /scripted|fusion-o3-|Fix both helpers|old a/u, "no identities, paths or task text in events");
  }));

test("O3 integration: a real verifier failure gets one targeted retry and the escalated result awaits review", { skip }, async () =>
  scenario(async (lease, attempt) => {
    await writeFile(join(lease, "src", "a.txt"), attempt === 1 ? "half fixed\n" : "fixed\n");
    await writeFile(join(lease, "src", "b.txt"), "fixed\n");
  }, async ({ result, root, before, types }) => {
    assert.deepEqual([result.state, result.delegateAttempts, result.risk?.level], ["reviewRequired", 2, "high"]);
    assert.equal(result.verification?.passed, true);
    assert.equal(types.filter(t => t === "VerificationObserved").length, 2);
    assert.equal(await userState(root), before);
  }));

test("O3 integration: real out-of-scope and primary-escaping writes are caught", { skip }, async () => {
  await scenario(async lease => {
    await writeFile(join(lease, "src", "a.txt"), "fixed\n");
    await writeFile(join(lease, "src", "c.txt"), "new file outside the delegated scope\n");
    sh(lease, "add", "src/a.txt"); sh(lease, "commit", "-qm", "worker commit");
  }, async ({ result, root, before }) => {
    assert.deepEqual([result.state, result.transitions.at(-1)?.reason], ["decisionRequired", "unexpectedScope"]);
    assert.deepEqual(result.changedPaths, ["src/a.txt", "src/c.txt"], "committed and untracked lease changes are both observed");
    assert.equal(await userState(root), before);
  });
  let primary = "";
  await scenario(async lease => {
    primary = resolve(lease, "..", "..", "..");
    await writeFile(join(primary, "README.md"), "overwritten by an escaping writer\n");
  }, async ({ result }) => {
    assert.deepEqual([result.state, result.error?.kind, result.risk?.level], ["failed", "SecurityViolation", "critical"]);
    assert.equal(result.verification, undefined, "nothing after the escape is trusted or run");
  });
});

test("O3 the EventStore accepts only closed workflow vocabularies and drops anything else", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fusion-o3-events-"));
  try {
    const run = await RunStore.create(dir);
    const events = await run.openEvents();
    const stored = await events.append({ type: "WorkflowTransition", source: "runtime", payload: { from: "received",
      to: "inspected", reason: "taskInspected", role: "Lead", attempt: 1, prompt: "do the secret thing" } } as unknown as EventInput);
    assert.deepEqual(stored.payload, { from: "received", to: "inspected", reason: "taskInspected", role: "Lead", attempt: 1 },
      "unknown keys are never persisted");
    const risk = await events.append({ type: "RiskAssessed", source: "policy",
      payload: { level: "high", decisive: ["verificationFailed"], revision: 1, evidence: "src/.env changed" } } as unknown as EventInput);
    assert.deepEqual(risk.payload, { level: "high", decisive: ["verificationFailed"], revision: 1 });
    const transition = { from: "received", to: "inspected", reason: "taskInspected" };
    const bad: Array<Record<string, unknown>> = [
      { type: "WorkflowTransition", payload: { ...transition, from: "nowhere" } },
      { type: "WorkflowTransition", payload: { ...transition, reason: "because the model said so" } },
      { type: "WorkflowTransition", payload: { ...transition, role: "Boss" } },
      { type: "WorkflowTransition", payload: { ...transition, attempt: 0 } },
      { type: "WorkflowTransition", payload: { ...transition, attempt: 1.5 } },
      { type: "RiskAssessed", payload: { level: "unknown", decisive: [], revision: 0 } },
      { type: "RiskAssessed", payload: { level: "low", decisive: ["path src/.env is sensitive"], revision: 0 } },
      { type: "RiskAssessed", payload: { level: "low", decisive: Array.from({ length: 33 }, (_, i) => `code${i}`), revision: 0 } },
      { type: "RiskAssessed", payload: { level: "low", decisive: [], revision: -1 } },
    ];
    for (const input of bad)
      await assert.rejects(events.append({ source: "runtime", ...input } as unknown as EventInput), StorageError, JSON.stringify(input));
    const { events: read } = await events.listEvents();
    assert.deepEqual(read.map(e => e.type), ["WorkflowTransition", "RiskAssessed"], "the log reads back strictly");
  } finally {
    assert.ok(resolve(dir).toLowerCase().startsWith(`${resolve(tmpdir()).toLowerCase()}${sep}`));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("O3.1 integration: a real verifier that writes to the primary workspace fails the workflow closed", { skip }, async () => {
  // The step is read-only for the lease (it writes nothing there), so only the primary-workspace proof can catch it.
  const touchesPrimary: VerificationPlan = { commands: [...plan.commands, { id: "escape", executable: process.execPath, cwd: ".",
    timeoutMs: 20_000, mutationPolicy: "readOnly", args: ["-e",
      "const p=require('path');require('fs').appendFileSync(p.resolve('..','..','..','README.md'),'verifier edit\\n')"] }] };
  await scenario(async lease => {
    await writeFile(join(lease, "src", "a.txt"), "fixed\n");
    await writeFile(join(lease, "src", "b.txt"), "fixed\n");
  }, async ({ result, root, before, types }) => {
    assert.deepEqual([result.state, result.error?.kind, result.risk?.level], ["failed", "SecurityViolation", "critical"]);
    assert.ok(result.risk?.decisive.includes("primaryWorkspaceChanged"));
    assert.equal(types.filter(t => t === "VerificationObserved").length, 2, "both steps ran and passed their own checks");
    assert.notEqual(await userState(root), before, "the fixture really did change the primary");
    assert.ok(!result.transitions.some(t => t.to === "reviewing" || t.to === "completed"));
  }, touchesPrimary);
});
