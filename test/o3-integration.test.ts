import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import type { DelegationPacket, VerificationPlan } from "../src/core/domain.js";
import type { TaskRequest } from "../src/core/policy/task-inspector.js";
import { WorkflowEngine } from "../src/core/workflow/engine.js";
import type { WorkflowResult } from "../src/core/workflow/types.js";
import { RunStore } from "../src/platform/events/run-store.js";
import { StorageError } from "../src/platform/events/shared.js";
import type { EventInput } from "../src/platform/events/types.js";
import { DockerLinuxVerificationBackend } from "../src/platform/verification/docker/backend.js";
import { VerificationService } from "../src/platform/verification/selection.js";
import { OFFLINE_REHEARSAL, PrivateCandidateWorkspacePort } from "../src/platform/workflow/candidates.js";
import { EventStoreWorkflowSink } from "../src/platform/workflow/ports.js";
import { ProcessGitClient } from "../src/platform/workspace/git.js";
import { FAKE_DOCKER_EXE, FAKE_IMAGE, FakeDocker, type AttachContext } from "./fixtures/fake-docker.js";
import { changeSet, oracle, scriptedRoles, type ProposalContext } from "./fixtures/fake-writer.js";
import { viewsOver } from "./fixtures/writer-rehearsal-harness.js";

const gitAvailable = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;
const skip = gitAvailable ? false : "git executable unavailable";

function sh(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=Fusion Test", "-c", "user.email=fusion@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", "-c", `core.hooksPath=${join(cwd, ".no-hooks")}`, ...args],
    { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
}
/** Everything a user could lose: status (ignored files included) plus the content of every non-Git, non-Fusion file. */
async function userState(root: string): Promise<string> {
  const status = sh(root, "status", "--porcelain=v1", "-uall", "--ignored").split("\n").filter(line => !line.startsWith("!! .fusion/")).join("\n");
  const lines = [status, sh(root, "rev-parse", "HEAD")];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name), rel = relative(root, path);
    if (!entry.isFile() || rel.startsWith(".git") || rel.startsWith(".fusion")) continue;
    lines.push(`${rel}:${createHash("sha256").update(await readFile(path)).digest("hex")}`);
  }
  return lines.sort().join("\n");
}

const NODE = "/usr/local/bin/node";
const task: TaskRequest = { operation: "implement", summary: "Fix both helpers.", paths: ["src/a.txt", "src/b.txt"],
  scopeKnown: true, expectedMutation: "multiFile", requestedCapabilities: { write: true },
  verification: { required: true, planProvided: true } };
const delegation: DelegationPacket = { task: { goal: "Fix both helpers.", constraints: [], acceptanceCriteria: ["Files say fixed."] },
  scope: { relevantFiles: ["src/a.txt", "src/b.txt"], allowedFiles: ["src/a.txt", "src/b.txt"], forbiddenFiles: [] },
  architecture: { decisions: [], invariants: [] }, verification: { requiredTests: ["unit"] }, openQuestions: [] };
/** Runs inside the confined backend; the fake backend's oracle decides it from the files actually streamed. */
const plan: VerificationPlan = { commands: [{ id: "unit", executable: NODE, cwd: ".", timeoutMs: 20_000, mutationPolicy: "readOnly",
  args: ["--test"] }] };
const fixedFiles = (context: AttachContext): boolean =>
  context.files.get("src/a.txt")?.toString("utf8") === "fixed\n" && context.files.get("src/b.txt")?.toString("utf8") === "fixed\n";

async function scenario(worker: (ctx: ProposalContext, root: string) => unknown, check: (ctx: { result: WorkflowResult; root: string;
  before: string; eventsJson: string; transitions: unknown[]; types: string[]; streamed: AttachContext[]; fake: FakeDocker }) => Promise<void>,
  hooks: { attach?: (context: AttachContext, root: string) => void } = {}): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "fusion-o3-"));
  const root = join(dir, "repo");
  try {
    await mkdir(join(root, "src"), { recursive: true });
    sh(root, "init", "-q"); sh(root, "config", "core.autocrlf", "false");
    await writeFile(join(root, "src", "a.txt"), "old a\n"); await writeFile(join(root, "src", "b.txt"), "old b\n");
    await writeFile(join(root, "README.md"), "readme\n");
    await writeFile(join(root, ".gitignore"), "*.local\n");
    sh(root, "add", "."); sh(root, "commit", "-qm", "init");
    await writeFile(join(root, "README.md"), "the user's uncommitted edit\n");
    await writeFile(join(root, "notes.txt"), "untracked user notes\n");
    await writeFile(join(root, "secrets.local"), "IGNORED-CANARY-5c1e\n");
    const before = await userState(root);

    const streamed: AttachContext[] = [];
    const decide = oracle((_command, context) => ({ pass: fixedFiles(context) }), streamed);
    const fake = new FakeDocker({ attach: context => { hooks.attach?.(context, root); return decide(context); } });
    const backend = new DockerLinuxVerificationBackend({ image: FAKE_IMAGE, runner: fake, resolveDocker: () => Promise.resolve(FAKE_DOCKER_EXE),
      dependencyStoreDirectory: join(dir, "deps") });
    const git = await ProcessGitClient.fromPath(process.env, true);
    const port = new PrivateCandidateWorkspacePort({ primaryRoot: root, git,
      service: new VerificationService([backend]), confinement: OFFLINE_REHEARSAL, declaredPlatform: "platform-neutral" });
    const run = await RunStore.create(root);
    const events = await run.openEvents();
    const { roles } = scriptedRoles({ worker: ctx => worker(ctx, root) });
    const engine = new WorkflowEngine({ roles, workspace: port, views: viewsOver(root, git, port).views, events: new EventStoreWorkflowSink(events),
      verifier: { verify: () => { throw new Error("a Writer candidate is never verified by the primary-workspace verifier"); } } });
    const result = await engine.run({ runId: run.runId, task, packet: delegation, verification: plan });
    const stored = (await events.listEvents()).events;
    await check({ result, root, before, eventsJson: JSON.stringify(stored), types: stored.map(e => e.type), streamed, fake,
      transitions: stored.filter(e => e.type === "WorkflowTransition").map(e => e.payload) });
  } finally {
    assert.ok(resolve(dir).toLowerCase().startsWith(`${resolve(tmpdir()).toLowerCase()}${sep}`));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
const fix = changeSet([["src/a.txt", "old a\n", "fixed\n"], ["src/b.txt", "old b\n", "fixed\n"]]);

test("O3 integration: MEDIUM flow over real private candidates, confined verification and EventStore leaves the primary untouched",
  { skip }, async () => scenario(() => fix, async ({ result, root, before, eventsJson, transitions, types, streamed, fake }) => {
    assert.equal(result.state, "completed", JSON.stringify(result.error));
    assert.deepEqual(result.changedPaths, ["src/a.txt", "src/b.txt"]);
    assert.deepEqual(result.cleanup, { candidates: 1, released: 1, complete: true });
    assert.equal(await userState(root), before, "the dirty primary workspace, its untracked and ignored files, are preserved exactly");
    // The confined backend saw exactly the committed baseline plus the host-applied files: no uncommitted, ignored or Git file.
    const files = [...streamed[0]!.files.keys()].sort();
    assert.deepEqual(files, [".gitignore", "README.md", "src/a.txt", "src/b.txt"]);
    assert.equal(streamed[0]!.files.get("README.md")?.toString("utf8"), "readme\n", "the user's uncommitted edit never enters verification");
    assert.equal(fake.commands("create").length, 1, "one container, zero host mounts (the argv guard refuses any)");
    assert.deepEqual(transitions, result.transitions.map(t => ({ ...t })), "the EventStore log mirrors the state machine");
    assert.deepEqual(types.filter(t => !["AgentTurnObserved", "StructuredTurnObserved", "ProviderViewObserved"].includes(t)), ["WorkflowTransition", "RiskAssessed",
      "WorkflowTransition", "WorkflowTransition", "CandidateObserved", "WorkflowTransition", "WorkflowTransition", "ChangeProposalRecorded",
      "CandidateObserved", "WorkflowTransition", "CandidateVerificationObserved", "WorkflowTransition", "CandidateObserved",
      "WorkflowTransition"]);
    // O5.5B8: two provider views (the Lead/Change Author baseline and the Lead review's candidate copy), each created and released.
    assert.equal(types.filter(t => t === "ProviderViewObserved").length, 4);
    assert.doesNotMatch(eventsJson, /fusion-o3-|Fix both helpers|old a|fixed\\n|IGNORED-CANARY/u, "no paths, task text or content in events");
  }));

test("O3 integration: a confined verification failure gets one fresh-candidate retry and the escalated result gets a fresh review", { skip },
  async () => scenario(({ call }) => call === 1 ? changeSet([["src/a.txt", "old a\n", "half fixed\n"], ["src/b.txt", "old b\n", "fixed\n"]]) : fix,
    async ({ result, root, before, types, streamed }) => {
      assert.deepEqual([result.state, result.delegateAttempts, result.risk?.level], ["completed", 2, "high"]);
      assert.equal(result.reviews.length, 1, "risk rose mid-run, so the Lead review became a fresh review and adjudication");
      assert.ok(!result.transitions.some(t => t.reason === "reviewRequested"), "the escalated run never takes the cheaper Lead review");
      assert.equal(result.verification?.passed, true);
      assert.equal(types.filter(t => t === "CandidateVerificationObserved").length, 2);
      assert.equal(streamed.length, 2);
      assert.equal(streamed[1]!.files.get("src/a.txt")?.toString("utf8"), "fixed\n",
        "the second candidate is reconstructed from the baseline, not the half-fixed first one");
      assert.deepEqual(result.cleanup, { candidates: 2, released: 2, complete: true });
      assert.equal(await userState(root), before);
    }));

test("O3 integration: out-of-scope proposals and primary-escaping providers are caught before anything is applied", { skip }, async () => {
  await scenario(() => changeSet([["src/a.txt", "old a\n", "fixed\n"], ["src/c.txt", null, "outside the scope\n"]]),
    async ({ result, root, before, streamed }) => {
      assert.deepEqual([result.state, result.transitions.at(-1)?.reason], ["failed", "proposalRejected"]);
      assert.equal(result.changedPaths, undefined, "nothing was applied, so nothing changed");
      assert.equal(streamed.length, 0);
      assert.equal(await userState(root), before);
    });
  await scenario(async (_ctx, root) => {
    await writeFile(join(root, "README.md"), "overwritten by an escaping provider\n");
    return fix;
  }, async ({ result, streamed }) => {
    assert.deepEqual([result.state, result.error?.kind, result.risk?.level], ["failed", "SecurityViolation", "critical"]);
    assert.equal(result.verification, undefined, "nothing after the escape is trusted or run");
    assert.equal(streamed.length, 0);
    assert.deepEqual(result.cleanup, { candidates: 1, released: 1, complete: true });
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
    const proposal = await events.append({ type: "ChangeProposalRecorded", source: "runtime",
      payload: { attempt: 1, outcome: "validated", operations: 2, content: "SECRET=1" } } as unknown as EventInput);
    assert.deepEqual(proposal.payload, { attempt: 1, outcome: "validated", operations: 2 }, "proposal content never reaches the log");
    const verified = await events.append({ type: "CandidateVerificationObserved", source: "verification", payload: { attempt: 1,
      passed: true, commandsRun: 1, backendId: "docker-linux", acceptance: "offlineRehearsal",
      commands: [{ id: "unit", status: "passed", exitCode: 0, stdoutTail: "token=abc" }] } } as unknown as EventInput);
    assert.deepEqual(verified.payload, { attempt: 1, passed: true, commandsRun: 1, backendId: "docker-linux", acceptance: "offlineRehearsal",
      commands: [{ id: "unit", status: "passed", exitCode: 0 }] }, "verifier output never reaches the log");
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
      { type: "ChangeProposalRecorded", payload: { attempt: 1, outcome: "applied-by-model", operations: 1 } },
      { type: "ChangeProposalRecorded", payload: { attempt: 17, outcome: "validated", operations: 1 } },
      { type: "CandidateObserved", payload: { attempt: 1, phase: "written-by-provider" } },
      { type: "CandidateObserved", payload: { attempt: 1, phase: "released", complete: "yes" } },
      { type: "CandidateVerificationObserved", payload: { attempt: 1, passed: "true", commandsRun: 1 } },
      { type: "CandidateVerificationObserved", payload: { attempt: 1, passed: false, commandsRun: 0, refusal: "leadSaidSo" } },
      { type: "CandidateVerificationObserved", payload: { attempt: 1, passed: true, commandsRun: 1, acceptance: "trustMe" } },
      { type: "CandidateVerificationObserved", payload: { attempt: 1, passed: true, commandsRun: 1, backendId: "C:\\Users\\x" } },
      { type: "AgentTurnObserved", payload: { kind: "freestyle", attempt: 1, role: "Lead", sessionId: "s", provider: "p", transport: "t",
        requestedModel: "m", observedModel: "m" } },
    ];
    for (const input of bad)
      await assert.rejects(events.append({ source: "runtime", ...input } as unknown as EventInput), StorageError, JSON.stringify(input));
    const { events: read } = await events.listEvents();
    assert.deepEqual(read.map(e => e.type), ["WorkflowTransition", "RiskAssessed", "ChangeProposalRecorded", "CandidateVerificationObserved"],
      "the log reads back strictly");
  } finally {
    assert.ok(resolve(dir).toLowerCase().startsWith(`${resolve(tmpdir()).toLowerCase()}${sep}`));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("O3.1 integration: a verifier backend that touches the primary workspace fails the workflow closed", { skip }, async () => {
  // A confined backend cannot reach the primary; this simulates a broken one to prove the primary proof still catches it.
  await scenario(() => fix, async ({ result, root, before }) => {
    assert.deepEqual([result.state, result.error?.kind, result.risk?.level], ["failed", "SecurityViolation", "critical"]);
    assert.ok(result.risk?.decisive.includes("primaryWorkspaceChanged"));
    assert.notEqual(await userState(root), before, "the fixture really did change the primary");
    assert.ok(!result.transitions.some(t => t.to === "reviewing" || t.to === "completed"));
  }, { attach: (_context, root) => { spawnSync(process.execPath, ["-e",
    `require('fs').appendFileSync(${JSON.stringify(join(root, "README.md"))}, 'verifier edit\\n')`], { windowsHide: true }); } });
});
