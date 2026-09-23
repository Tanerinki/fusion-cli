import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { test } from "node:test";
import type { VerificationPlan } from "../src/core/domain.js";
import { FusionFailure } from "../src/core/errors.js";
import { PrivateWriterWorkspace } from "../src/platform/workspace/private-writer.js";
import { ProcessGitClient } from "../src/platform/workspace/git.js";

const available = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;
const skip = available ? false : "git executable unavailable";
const node = process.execPath;
const kind = (expected: string) => (error: unknown): boolean => error instanceof FusionFailure && error.error.kind === expected;
function sh(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=Fusion Test", "-c", "user.email=fusion@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", "-c", `core.hooksPath=${join(cwd, ".no-hooks")}`,
    ...args], { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
}
async function fixture<T>(run: (root: string, dir: string, git: ProcessGitClient) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "fusion o5b "));
  try {
    const root = join(dir, "primary repo");
    await mkdir(root);
    sh(root, "init", "-q");
    await writeFile(join(root, "a.txt"), "base\n");
    await writeFile(join(root, ".gitignore"), "ignored.env\n");
    sh(root, "add", "."); sh(root, "commit", "-qm", "base");
    return await run(root, dir, await ProcessGitClient.fromPath(process.env, true));
  } finally {
    assert.ok(resolve(dir).toLowerCase().startsWith(`${resolve(tmpdir()).toLowerCase()}${sep}`));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
const plan = (script: string): VerificationPlan => ({ commands: [{ id: "check", executable: node, args: ["-e", script],
  cwd: ".", timeoutMs: 10_000, mutationPolicy: "readOnly" }] });

test("O5.5B private Writer and verifier are separate Git repositories; only approved candidate files cross", { skip },
  async () => fixture(async (root, _dir, git) => {
    await writeFile(join(root, "a.txt"), "primary dirty\n");
    await assert.rejects(PrivateWriterWorkspace.open(root, "owner-1", await ProcessGitClient.fromPath(), plan("")),
      kind("SecurityViolation"), "ambient Git config is not accepted for a private clone");
    const script = `const fs=require("fs"); if(fs.readFileSync("a.txt","utf8")!=="writer change\\n" ||
      fs.existsSync("ignored.env") || process.env.OPENAI_API_KEY || process.env.GIT_DIR) process.exit(7);`;
    const writer = await PrivateWriterWorkspace.open(root, "owner-1", git, plan(script));
    try {
      assert.notEqual(writer.path.toLowerCase(), root.toLowerCase());
      assert.ok(existsSync(join(writer.path, ".git")));
      assert.equal(sh(writer.path, "remote"), "", "the private clone has no automatic push remote");
      assert.equal(await readFile(join(writer.path, "a.txt"), "utf8"), "base\n");
      await writeFile(join(writer.path, "a.txt"), "writer change\n");
      await writeFile(join(writer.path, "ignored.env"), "MUST_NOT_ENTER_VERIFIER\n");
      const report = await writer.verify("owner-1", ["a.txt"], undefined,
        { ...process.env, OPENAI_API_KEY: "synthetic-secret", GIT_DIR: join(root, ".git") });
      assert.equal(report.passed, true);
      assert.equal(await readFile(join(root, "a.txt"), "utf8"), "primary dirty\n");
      await assert.rejects(writer.close("owner-1"), kind("WorkspaceConflict"));
    } finally { await writer.close("owner-1", { discardChanges: true }); }
  }));

test("O5.5B reconstructed verifier detects writes to ignored paths and refuses unapproved untracked config", { skip },
  async () => fixture(async (root, _dir, git) => {
    await assert.rejects(PrivateWriterWorkspace.open(root, "owner-1", git,
      { commands: [{ ...plan("").commands[0]!, mutationPolicy: "allowMutation" }] }), kind("InvalidInput"));
    const writer = await PrivateWriterWorkspace.open(root, "owner-1", git,
      plan('require("fs").writeFileSync("ignored.env","bad")'));
    try {
      await writeFile(join(writer.path, "a.txt"), "candidate\n");
      const report = await writer.verify("owner-1", ["a.txt"]);
      assert.equal(report.passed, false);
      assert.equal(report.steps[0]?.status, "mutationViolation");
      assert.ok(report.steps[0]?.mutations.includes("ignored.env"));
      await writeFile(join(writer.path, ".npmrc"), "registry=https://example.invalid\n");
      await assert.rejects(writer.verify("owner-1", ["a.txt"]), kind("SecurityViolation"));
      await unlink(join(writer.path, ".npmrc"));
      await assert.rejects(writer.verify("owner-2", ["a.txt"]), kind("WorkspaceConflict"));
      for (const path of ["../a.txt", "C:/outside", ".git/config", "CON", "a.txt:ads"])
        await assert.rejects(writer.verify("owner-1", [path]), kind("SecurityViolation"));
    } finally { await writer.close("owner-1", { discardChanges: true }); }
  }));

test("O5.5B primary edits and private Git config, hooks, refs and index flags stop candidate verification", { skip },
  async () => fixture(async (root, _dir, git) => {
    const writer = await PrivateWriterWorkspace.open(root, "owner-1", git, plan(""));
    try {
      await writeFile(join(writer.path, "a.txt"), "candidate\n");
      await writeFile(join(root, "a.txt"), "primary intrusion\n");
      await assert.rejects(writer.verify("owner-1", ["a.txt"]), kind("SecurityViolation"));
      await writeFile(join(root, "a.txt"), "base\n");
      const configPath = join(writer.path, ".git", "config"), originalConfig = await readFile(configPath);
      await writeFile(configPath, Buffer.concat([originalConfig, Buffer.from("\n[alias]\n  surprise = status\n")]));
      await assert.rejects(writer.verify("owner-1", ["a.txt"]), kind("SecurityViolation"));
      await writeFile(configPath, originalConfig);
      const hook = join(writer.path, ".git", "hooks", "pre-commit");
      await writeFile(hook, "#!/bin/sh\nexit 1\n");
      await assert.rejects(writer.verify("owner-1", ["a.txt"]), kind("SecurityViolation"));
      await unlink(hook);
      const ref = join(writer.path, ".git", "refs", "heads", "evil");
      await writeFile(ref, writer.baseCommit + "\n");
      await assert.rejects(writer.verify("owner-1", ["a.txt"]), kind("SecurityViolation"));
      await unlink(ref);
      const packed = join(writer.path, ".git", "packed-refs");
      await writeFile(packed, "# pack-refs with: peeled fully-peeled sorted\n");
      await assert.rejects(writer.verify("owner-1", ["a.txt"]), kind("SecurityViolation"));
      await unlink(packed);
      const exclude = join(writer.path, ".git", "info", "exclude"), originalExclude = await readFile(exclude);
      await writeFile(exclude, Buffer.concat([originalExclude, Buffer.from("\nsecrets.env\n")]));
      await assert.rejects(writer.verify("owner-1", ["a.txt"]), kind("SecurityViolation"));
      await writeFile(exclude, originalExclude);
      sh(writer.path, "update-index", "--assume-unchanged", "a.txt");
      await assert.rejects(writer.verify("owner-1", ["a.txt"]), kind("SecurityViolation"));
      sh(writer.path, "update-index", "--no-assume-unchanged", "a.txt");
      await writeFile(join(writer.path, ".git", "commondir"), join(root, ".git") + "\n");
      await assert.rejects(writer.verify("owner-1", ["a.txt"]), (error: unknown) => error instanceof FusionFailure,
        "a private clone may never be redirected to the primary common directory");
    } finally { await writer.close("owner-1", { discardChanges: true }); }
  }));

test("O5.5B a candidate junction is refused and cleanup cannot follow it", { skip }, async t => fixture(async (root, dir, git) => {
  const writer = await PrivateWriterWorkspace.open(root, "owner-1", git, plan(""));
  const outside = join(dir, "outside");
  await mkdir(outside); await writeFile(join(outside, "keep.txt"), "untouched\n");
  try {
    try { await symlink(outside, join(writer.path, "escape"), process.platform === "win32" ? "junction" : "dir"); }
    catch (error) { t.skip(`reparse point unavailable: ${(error as NodeJS.ErrnoException).code}`); return; }
    await assert.rejects(writer.verify("owner-1", []), kind("SecurityViolation"));
  } finally { await writer.close("owner-1", { discardChanges: true }); }
  assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "untouched\n");
}));

test("O5.5B verifier writes inside its private Git object store are policy violations", { skip },
  async () => fixture(async (root, _dir, git) => {
    const writer = await PrivateWriterWorkspace.open(root, "owner-1", git,
      plan('require("fs").writeFileSync(".git/objects/stray-object", "bad")'));
    try {
      const report = await writer.verify("owner-1", []);
      assert.equal(report.passed, false);
      assert.equal(report.steps[0]?.status, "mutationViolation");
      assert.ok(report.steps[0]?.mutations.includes(".git/objects/stray-object"));
    } finally { await writer.close("owner-1"); }
  }));

test("O5.5B private clone has no push remote; an explicit push or force-push to the throwaway primary is detected", { skip },
  async () => fixture(async (root, _dir, git) => {
    for (const force of [false, true]) {
      const writer = await PrivateWriterWorkspace.open(root, force ? "force" : "normal", git, plan(""));
      try {
        assert.equal(sh(writer.path, "remote"), "");
        sh(writer.path, "push", ...(force ? ["--force"] : []), root, `HEAD:refs/heads/${force ? "forced" : "pushed"}`);
        await assert.rejects(writer.verify(writer.ownerId, []), kind("SecurityViolation"));
      } finally { await writer.close(writer.ownerId, { discardChanges: true }); }
    }
  }));

test("O5.5B malicious task-like argv stays literal; parallel use of one private lease is refused", { skip },
  async () => fixture(async (root, dir, git) => {
    const marker = join(dir, "shell-injected.txt"), task = `fix & echo PWN > ${marker} | $(whoami) %PATH%`;
    const script = `if(process.argv[1]!==${JSON.stringify(task)}) process.exit(7); setTimeout(()=>{},900);`;
    const taskPlan: VerificationPlan = { commands: [{ ...plan(script).commands[0]!, args: ["-e", script, task] }] };
    const writer = await PrivateWriterWorkspace.open(root, "owner-1", git, taskPlan);
    try {
      const running = writer.verify("owner-1", []);
      await assert.rejects(writer.verify("owner-1", []), kind("WorkspaceConflict"));
      assert.equal((await running).passed, true);
      assert.equal(existsSync(marker), false);
    } finally { await writer.close("owner-1"); }
  }));

test("O5.5B cancellation kills a verifier descendant and removes the reconstructed workspace", { skip },
  async () => fixture(async (root, dir, git) => {
    const marker = join(dir, "descendant.pid"), controller = new AbortController();
    const script = `const cp=require("child_process"), fs=require("fs");
      const c=cp.spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});
      fs.writeFileSync(${JSON.stringify(marker)},String(c.pid)); setInterval(()=>{},1000);`;
    const writer = await PrivateWriterWorkspace.open(root, "owner-1", git, plan(script));
    try {
      const running = writer.verify("owner-1", [], undefined, process.env, controller.signal);
      const until = Date.now() + 15_000;
      while (!existsSync(marker) && Date.now() < until) await new Promise(done => setTimeout(done, 100));
      assert.equal(existsSync(marker), true, "the descendant was started before cancellation");
      const pid = Number(await readFile(marker, "utf8"));
      controller.abort();
      const report = await running;
      assert.equal(report.status, "cancelled");
      const gone = Date.now() + 5_000;
      let alive = true;
      while (alive && Date.now() < gone) {
        try { process.kill(pid, 0); await new Promise(done => setTimeout(done, 100)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; else throw error; }
      }
      assert.equal(alive, false, "owned descendant process must be gone");
    } finally { controller.abort(); await writer.close("owner-1", { discardChanges: true }); }
  }));

test("O5.5B missing Fusion-owned cleanup root is reported and stale private leases can be discovered", { skip },
  async () => fixture(async (root, _dir, git) => {
    const writer = await PrivateWriterWorkspace.open(root, "owner-1", git, plan(""));
    const ownedRoot = dirname(writer.path);
    assert.ok(resolve(ownedRoot).toLowerCase().startsWith(`${resolve(tmpdir()).toLowerCase()}${sep}`));
    await rm(ownedRoot, { recursive: true, force: true });
    await assert.rejects(writer.close("owner-1", { discardChanges: true }), kind("WorkspaceConflict"));
    const fake = await mkdtemp(join(tmpdir(), "fusion-writer-private-"));
    try {
      await writeFile(join(fake, ".fusion-owner"), JSON.stringify({ ownerPid: 2_000_000_000 }));
      assert.ok((await PrivateWriterWorkspace.findStale()).includes(fake));
    } finally { await rm(fake, { recursive: true, force: true }); }
  }));
