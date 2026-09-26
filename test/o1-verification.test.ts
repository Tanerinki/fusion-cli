import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import type { VerificationCommand } from "../src/core/domain.js";
import { EventStore } from "../src/platform/events/event-store.js";
import { RunStore } from "../src/platform/events/run-store.js";
import { VerificationEngine } from "../src/platform/verification/engine.js";
import { ProcessGitClient } from "../src/platform/workspace/git.js";
import { WorkspaceLeaseManager, type WorkspaceLease } from "../src/platform/workspace/lease.js";
import { fusionTemporaryBase } from "../src/platform/fs/temporary.js";

const gitAvailable = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;
const skip = gitAvailable ? false : "git executable unavailable";
const engine = new VerificationEngine();
const node = process.execPath;

function sh(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=Fusion Test", "-c", "user.email=fusion@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", "-c", `core.hooksPath=${join(cwd, ".no-hooks")}`, ...args],
    { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
}
async function fixture<T>(run: (ctx: { root: string; lease: WorkspaceLease; git: ProcessGitClient; dir: string }) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(fusionTemporaryBase(), "fusion-o1-verify-"));
  try {
    const root = join(dir, "repo");
    await mkdir(root);
    sh(root, "init", "-q"); sh(root, "config", "core.autocrlf", "false");
    await writeFile(join(root, "a.txt"), "base\n"); await mkdir(join(root, "pkg")); await writeFile(join(root, "pkg", "b.txt"), "b\n");
    sh(root, "add", "."); sh(root, "commit", "-qm", "init");
    await writeFile(join(root, "a.txt"), "user's uncommitted edit\n");
    const git = await ProcessGitClient.fromPath();
    const manager = await WorkspaceLeaseManager.open({ repositoryRoot: root, git });
    const lease = await manager.acquire({ ownerId: "verifier-test" });
    try { return await run({ root, lease, git, dir }); }
    finally { await manager.release(lease.leaseId, "verifier-test", { discardChanges: true }); }
  } finally {
    assert.ok(resolve(dir).toLowerCase().startsWith(`${fusionTemporaryBase().toLowerCase()}${sep}`));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
const step = (id: string, script: string, extra: Partial<VerificationCommand> = {}): VerificationCommand =>
  ({ id, executable: node, args: ["-e", script], cwd: ".", timeoutMs: 10_000, mutationPolicy: "readOnly", ...extra });
async function userState(root: string): Promise<string> {
  const lines = [sh(root, "status", "--porcelain=v1", "-uall")];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name), rel = relative(root, path);
    if (!entry.isFile() || rel.startsWith(".git") || rel.startsWith(".fusion")) continue;
    lines.push(`${rel}:${createHash("sha256").update(await readFile(path)).digest("hex")}`);
  }
  return lines.sort().join("\n");
}

test("O1 verification passes only on a Fusion-observed exit 0, records evidence, and leaves the primary untouched", { skip }, async () => fixture(async ({ root, lease, git }) => {
  const before = await userState(root);
  const run = await RunStore.create(root);
  const events = await run.openEvents(), artifacts = await run.openArtifacts();
  const report = await engine.run({ commands: [step("ok", 'process.stdout.write("checks passed\\n")')] },
    { workspaceRoot: lease.path, git, env: { ...process.env }, events, artifacts });
  assert.equal(report.passed, true);
  assert.equal(report.status, "passed");
  const [result] = report.steps;
  assert.equal(result?.passed, true);
  assert.equal(result?.exitCode, 0);
  assert.equal(result?.mutatedRepository, false);
  assert.ok(result?.stdoutArtifact && result.preDiffArtifact && result.postDiffArtifact);
  assert.match(await readFile(await artifacts.getArtifactPath(result.stdoutArtifact), "utf8"), /checks passed/u);
  const stored = await EventStore.read(run.directory, run.runId).next();
  assert.ok(stored.value && "event" in stored.value);
  const types = (await events.listEvents()).events.map(e => e.type);
  assert.deepEqual(types, ["ProcessObserved", "VerificationObserved"]);
  assert.equal(await userState(root), before);
}));

test("O1 failure, timeout, cancellation and spawn failure stay distinct", { skip }, async () => fixture(async ({ lease, git }) => {
  const options = { workspaceRoot: lease.path, git, env: { ...process.env } };
  const failed = await engine.run({ commands: [step("fails", "process.exit(3)")] }, options);
  assert.deepEqual([failed.status, failed.steps[0]?.status, failed.steps[0]?.exitCode, failed.failure?.kind],
    ["failed", "failed", 3, "VerificationFailure"]);
  const timeout = await engine.run({ commands: [step("hangs", "setInterval(() => {}, 1000)", { timeoutMs: 250 })] }, options);
  assert.deepEqual([timeout.steps[0]?.status, timeout.failure?.kind], ["timeout", "Timeout"]);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const cancelled = await engine.run({ commands: [step("long", "setInterval(() => {}, 1000)"), step("after", "")] },
    { ...options, signal: controller.signal });
  assert.deepEqual([cancelled.status, cancelled.steps[0]?.status, cancelled.failure?.kind], ["cancelled", "cancelled", "Cancelled"]);
  assert.deepEqual(cancelled.notRun, ["after"]);
  const missing = await engine.run({ commands: [{ ...step("missing", ""), executable: join(fusionTemporaryBase(), "fusion-no-such-verifier.exe") }] }, options);
  assert.deepEqual([missing.steps[0]?.status, missing.failure?.kind], ["spawnFailure", "SpawnFailure"]);
}));

test("O1 large verifier output is retained within bounds without killing the verifier", { skip }, async () => fixture(async ({ lease, git }) => {
  const report = await engine.run({ commands: [step("chatty",
    'process.stdout.write("o".repeat(3_000_000)); process.stderr.write("e".repeat(3_000_000))')] },
    { workspaceRoot: lease.path, git, env: { ...process.env }, maxOutputBytes: 64 * 1024 });
  assert.equal(report.passed, true, "exit status stays authoritative when output is truncated");
  assert.equal(report.steps[0]?.stdoutTruncated, true);
  assert.equal(report.steps[0]?.stderrTruncated, true);
}));

test("O1 read-only verifiers that change tracked, untracked or already-dirty files fail on policy", { skip }, async () => fixture(async ({ root, lease, git }) => {
  const primaryBefore = await userState(root);
  const options = { workspaceRoot: lease.path, git, env: { ...process.env } };
  const tracked = await engine.run({ commands: [step("edits", 'require("fs").writeFileSync("a.txt", "changed\\n")')] }, options);
  assert.deepEqual([tracked.steps[0]?.status, tracked.failure?.kind, tracked.steps[0]?.exitCode], ["mutationViolation", "SecurityViolation", 0]);
  assert.deepEqual(tracked.steps[0]?.mutations, ["a.txt"]);
  const untracked = await engine.run({ commands: [step("creates", 'require("fs").writeFileSync("pkg/new.txt", "n\\n")')] }, options);
  assert.equal(untracked.steps[0]?.status, "mutationViolation");
  assert.deepEqual(untracked.steps[0]?.mutations, ["pkg/new.txt"]);
  const again = await engine.run({ commands: [step("edits-dirty", 'require("fs").writeFileSync("a.txt", "changed again\\n")')] }, options);
  assert.equal(again.steps[0]?.status, "mutationViolation", "a further change to an already-dirty file is detected");
  const allowed = await engine.run({ commands: [step("builds", 'require("fs").writeFileSync("pkg/out.txt", "o\\n")',
    { mutationPolicy: "allowMutation" })] }, options);
  assert.equal(allowed.passed, true);
  assert.equal(allowed.steps[0]?.mutatedRepository, true);
  assert.equal(await userState(root), primaryBefore, "mutations inside the lease never reach the primary workspace");
}));

test("O1 argv reaches the verifier exactly, with no shell interpolation or command execution", { skip }, async () => fixture(async ({ lease, git, dir }) => {
  const marker = join(dir, "injected.txt");
  const args = ['say "hi" & echo PWN > ' + marker, "%PATH%", "$(whoami)", "`id`", "a|b", "line1\nline2", "ü日本🙂", "trailing\\", ""];
  const run = await RunStore.create(lease.primaryRoot);
  const artifacts = await run.openArtifacts();
  const report = await engine.run({ commands: [{ id: "argv", executable: node, args: ["-e",
    "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...args], cwd: ".", timeoutMs: 10_000, mutationPolicy: "readOnly" }] },
    { workspaceRoot: lease.path, git, env: { ...process.env }, artifacts });
  assert.equal(report.passed, true);
  assert.deepEqual(JSON.parse(await readFile(await artifacts.getArtifactPath(report.steps[0]!.stdoutArtifact), "utf8")), args);
  assert.equal(existsSync(marker), false);
}));

test("O1 state evidence survives files named like forbidden evidence keys", { skip }, async () => fixture(async ({ lease, git }) => {
  for (const name of ["messages", "env", "headers"]) await writeFile(join(lease.path, name), "user file\n");
  const run = await RunStore.create(lease.primaryRoot);
  const report = await engine.run({ commands: [step("ok", "")] },
    { workspaceRoot: lease.path, git, env: { ...process.env }, artifacts: await run.openArtifacts() });
  assert.equal(report.passed, true);
  assert.ok(report.steps[0]?.preDiffArtifact);
}));

test("O1 a multi-step plan stops at the first failure and reports what did not run", { skip }, async () => fixture(async ({ lease, git }) => {
  const report = await engine.run({ commands: [step("first", ""), step("second", "process.exit(1)"), step("third", "")] },
    { workspaceRoot: lease.path, git, env: { ...process.env } });
  assert.equal(report.passed, false);
  assert.deepEqual(report.steps.map(s => [s.commandId, s.status]), [["first", "passed"], ["second", "failed"]]);
  assert.deepEqual(report.notRun, ["third"]);
}));

test("O1 malformed verification configuration fails before any process starts", { skip }, async () => fixture(async ({ root, lease, git, dir }) => {
  const marker = join(dir, "ran.txt");
  const touches = `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`;
  await mkdir(join(dir, "elsewhere"));
  await symlink(join(dir, "elsewhere"), join(lease.path, "link"), process.platform === "win32" ? "junction" : "dir").catch(() => {});
  const options = { workspaceRoot: lease.path, git, env: { ...process.env } };
  const cases: Array<[string, unknown]> = [
    ["empty plan", { commands: [] }],
    ["duplicate IDs", { commands: [step("x", touches), step("x", touches)] }],
    ["relative executable", { commands: [{ ...step("x", touches), executable: "node.exe" }] }],
    ["command wrapper", { commands: [{ ...step("x", touches), executable: join(dir, "npm.cmd") }] }],
    ["non-string argv", { commands: [{ ...step("x", touches), args: ["-e", 42] }] }],
    ["absolute cwd", { commands: [{ ...step("x", touches), cwd: lease.path }] }],
    ["parent cwd", { commands: [{ ...step("x", touches), cwd: "pkg/../.." }] }],
    ["missing cwd", { commands: [{ ...step("x", touches), cwd: "nope" }] }],
    ["junction cwd", { commands: [{ ...step("x", touches), cwd: "link" }] }],
    ["zero timeout", { commands: [{ ...step("x", touches), timeoutMs: 0 }] }],
    ["no mutation policy", { commands: [{ ...step("x", touches), mutationPolicy: undefined }] }],
    ["unsafe ID", { commands: [{ ...step("x", touches), id: "../x" }] }],
  ];
  for (const [label, plan] of cases) {
    const report = await engine.run(plan as never, options);
    assert.equal(report.status, "invalidConfiguration", label);
    assert.equal(report.failure?.kind, "InvalidInput", label);
    assert.deepEqual(report.steps, [], label);
  }
  const notTop = await engine.run({ commands: [step("x", touches)] }, { ...options, workspaceRoot: join(lease.path, "pkg") });
  assert.equal(notTop.status, "invalidConfiguration", "mutation cannot be proven outside a worktree top level");
  const primaryRun = await engine.run({ commands: [step("x", touches)] }, { ...options, workspaceRoot: root });
  assert.equal(primaryRun.passed, true, "the engine itself is workspace-agnostic; leases are enforced by the workflow layer");
  await rm(marker, { force: true });
  assert.equal(existsSync(marker), false);
}));
