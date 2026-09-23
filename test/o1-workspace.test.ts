import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { FusionFailure } from "../src/core/errors.js";
import { ProcessGitClient, parseWorktreeList, type GitClient } from "../src/platform/workspace/git.js";
import { WorkspaceLeaseManager } from "../src/platform/workspace/lease.js";

const gitAvailable = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;
const skip = gitAvailable ? false : "git executable unavailable";
const kind = (expected: string) => (error: unknown): boolean => error instanceof FusionFailure && error.error.kind === expected;

async function withTemp<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "fusion-o1-ws-"));
  try { return await run(dir); }
  finally {
    assert.ok(resolve(dir).toLowerCase().startsWith(`${resolve(tmpdir()).toLowerCase()}${sep}`));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
/** Test-only repository setup; production code never uses this. */
function sh(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=Fusion Test", "-c", "user.email=fusion@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", "-c", "init.defaultBranch=main",
    "-c", `core.hooksPath=${join(cwd, ".no-hooks")}`, ...args], { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0 && !(args[0] === "merge" && result.status === 1)) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
}
async function repo(dir: string, state: "clean" | "dirty" | "conflicted" | "detached" | "unborn" = "clean"): Promise<string> {
  const root = join(dir, "repo");
  await mkdir(root);
  sh(root, "init", "-q");
  // Repository-local only: pins checkout line endings so results do not depend on a machine's global config.
  sh(root, "config", "core.autocrlf", "false");
  if (state === "unborn") { await writeFile(join(root, "draft.txt"), "never committed\n"); return root; }
  await writeFile(join(root, "a.txt"), "base\n"); await writeFile(join(root, "b.txt"), "base\n");
  sh(root, "add", "."); sh(root, "commit", "-qm", "init");
  if (state === "dirty") {
    await writeFile(join(root, "a.txt"), "unstaged edit\n");
    await writeFile(join(root, "b.txt"), "staged edit\n"); sh(root, "add", "b.txt");
    await writeFile(join(root, "c.txt"), "untracked\n");
  } else if (state === "conflicted") {
    sh(root, "checkout", "-qb", "feature"); await writeFile(join(root, "a.txt"), "feature\n"); sh(root, "commit", "-qam", "f");
    sh(root, "checkout", "-q", "main"); await writeFile(join(root, "a.txt"), "main\n"); sh(root, "commit", "-qam", "m");
    sh(root, "merge", "feature");
  } else if (state === "detached") {
    sh(root, "checkout", "-q", "--detach"); await writeFile(join(root, "a.txt"), "detached edit\n");
  }
  return root;
}
/** Porcelain status plus a content hash of every user file outside .git and .fusion. */
async function userState(root: string): Promise<string> {
  const lines = [sh(root, "status", "--porcelain=v1", "-uall")];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name), rel = relative(root, path);
    if (!entry.isFile() || rel.startsWith(".git") || rel.startsWith(".fusion")) continue;
    lines.push(`${rel}:${createHash("sha256").update(await readFile(path)).digest("hex")}`);
  }
  return lines.sort().join("\n");
}
const worktrees = (root: string) => parseWorktreeList(sh(root, "worktree", "list", "--porcelain", "-z"));

let git: ProcessGitClient;
test.before(async () => { if (gitAvailable) git = await ProcessGitClient.fromPath(); });

test("O1 clean primary: a lease is an isolated, detached, locked worktree; release is idempotent", { skip }, async () => withTemp(async dir => {
  const root = await repo(dir);
  const before = await userState(root);
  const manager = await WorkspaceLeaseManager.open({ repositoryRoot: root, git });
  const lease = await manager.acquire({ ownerId: "writer-1" });
  assert.notEqual(lease.path.toLowerCase(), root.toLowerCase());
  assert.equal(relative(root, lease.path).split(sep).slice(0, 2).join("/"), ".fusion/worktrees");
  assert.equal(await readFile(join(lease.path, "a.txt"), "utf8"), "base\n");
  const entry = worktrees(root).find(w => resolve(w.path).toLowerCase() === lease.path.toLowerCase());
  assert.ok(entry?.locked, "Fusion locks its worktree against a generic prune");
  assert.equal(entry?.head, lease.baseCommit);
  assert.equal((await manager.get(lease.leaseId)).state, "active");
  assert.equal(await userState(root), before, "acquisition leaves the primary byte-identical");
  await manager.release(lease.leaseId, "writer-1");
  await manager.release(lease.leaseId, "writer-1");
  assert.equal((await manager.get(lease.leaseId)).state, "released");
  assert.equal(worktrees(root).length, 1);
  assert.equal(await userState(root), before);
}));

for (const state of ["dirty", "conflicted", "detached"] as const) {
  test(`O1 ${state} primary stays byte-identical and its uncommitted state never enters the lease`, { skip }, async () => withTemp(async dir => {
    const root = await repo(dir, state);
    const before = await userState(root);
    if (state === "conflicted") assert.match(before, /UU a\.txt/u);
    const manager = await WorkspaceLeaseManager.open({ repositoryRoot: root, git });
    const lease = await manager.acquire({ ownerId: "writer-1" });
    assert.equal(sh(lease.path, "status", "--porcelain=v1", "-uall"), "", "a lease starts clean at the base commit");
    assert.equal(await userState(root), before);
    await manager.release(lease.leaseId, "writer-1");
    assert.equal(await userState(root), before);
  }));
}

test("O1 an unborn branch cannot host a lease and nothing is created", { skip }, async () => withTemp(async dir => {
  const root = await repo(dir, "unborn");
  const before = await userState(root);
  const manager = await WorkspaceLeaseManager.open({ repositoryRoot: root, git });
  await assert.rejects(manager.acquire({ ownerId: "writer-1" }), kind("WorkspaceConflict"));
  assert.deepEqual(await readdir(join(root, ".fusion", "worktrees")), []);
  assert.deepEqual(await readdir(join(root, ".fusion", "leases")), []);
  assert.equal(await userState(root), before);
}));

test("O1 unrelated worktrees, including a prunable one, are never modified or removed", { skip }, async () => withTemp(async dir => {
  const root = await repo(dir);
  const sibling = join(dir, "user-wt"), gone = join(dir, "user-gone");
  sh(root, "worktree", "add", "-q", "-b", "user-branch", sibling);
  await writeFile(join(sibling, "a.txt"), "user work in their own worktree\n");
  sh(root, "worktree", "add", "-q", "--detach", gone);
  await rm(gone, { recursive: true, force: true });
  const siblingBefore = await userState(sibling);
  const manager = await WorkspaceLeaseManager.open({ repositoryRoot: root, git });
  const lease = await manager.acquire({ ownerId: "writer-1" });
  await manager.release(lease.leaseId, "writer-1");
  const stale = await manager.acquire({ ownerId: "writer-2" });
  await writeFile(join(stale.path, "x.txt"), "x\n");
  await manager.release(stale.leaseId, "writer-2", { discardChanges: true });
  const paths = worktrees(root).map(w => resolve(w.path).toLowerCase());
  assert.ok(paths.includes(sibling.toLowerCase()), "the user's worktree stays registered");
  assert.ok(paths.includes(gone.toLowerCase()), "a prunable user worktree is not pruned");
  assert.equal(await userState(sibling), siblingBefore);
}));

test("O1 concurrent acquisitions produce distinct exclusive leases; ownership is enforced", { skip }, async () => withTemp(async dir => {
  const root = await repo(dir);
  const manager = await WorkspaceLeaseManager.open({ repositoryRoot: root, git });
  const leases = await Promise.all(["w1", "w2", "w3", "w4"].map(ownerId => manager.acquire({ ownerId })));
  assert.equal(new Set(leases.map(l => l.leaseId)).size, 4);
  assert.equal(new Set(leases.map(l => l.path.toLowerCase())).size, 4);
  assert.equal(worktrees(root).length, 5);
  await assert.rejects(manager.assertOwner(leases[0]!.leaseId, "w2"), kind("WorkspaceConflict"));
  await assert.rejects(manager.release(leases[0]!.leaseId, "w2"), kind("WorkspaceConflict"));
  assert.equal((await manager.assertOwner(leases[0]!.leaseId, "w1")).path, leases[0]!.path);
  for (const lease of leases) await manager.release(lease.leaseId, lease.ownerId);
  assert.equal(worktrees(root).length, 1);
}));

test("O1 release refuses to discard lease work unless explicitly asked", { skip }, async () => withTemp(async dir => {
  const root = await repo(dir);
  const manager = await WorkspaceLeaseManager.open({ repositoryRoot: root, git });
  const lease = await manager.acquire({ ownerId: "writer-1" });
  await writeFile(join(lease.path, "a.txt"), "writer change\n");
  await assert.rejects(manager.release(lease.leaseId, "writer-1"), kind("WorkspaceConflict"));
  assert.equal(await readFile(join(lease.path, "a.txt"), "utf8"), "writer change\n");
  sh(lease.path, "checkout", "--", "a.txt");
  await writeFile(join(lease.path, "new.txt"), "n\n"); sh(lease.path, "add", "new.txt"); sh(lease.path, "commit", "-qm", "writer");
  await assert.rejects(manager.release(lease.leaseId, "writer-1"), kind("WorkspaceConflict"), "committed lease work is also protected");
  await manager.release(lease.leaseId, "writer-1", { discardChanges: true });
  assert.equal((await manager.get(lease.leaseId)).state, "released");
}));

test("O1 stale leases are detected and repaired individually; a live owner is never repaired", { skip }, async () => withTemp(async dir => {
  const root = await repo(dir);
  const dead = 2_000_000_000;
  const crashed = await WorkspaceLeaseManager.open({ repositoryRoot: root, git, ownerPid: dead, processAlive: pid => pid !== dead });
  const orphan = await crashed.acquire({ ownerId: "crashed-writer" });
  const live = await WorkspaceLeaseManager.open({ repositoryRoot: root, git, processAlive: pid => pid !== dead });
  const healthy = await live.acquire({ ownerId: "live-writer" });
  assert.deepEqual((await live.findStale()).map(r => r.leaseId), [orphan.leaseId]);
  await assert.rejects(live.repairStale(healthy.leaseId), kind("WorkspaceConflict"));
  await writeFile(join(orphan.path, "abandoned.txt"), "work\n");
  await assert.rejects(live.repairStale(orphan.leaseId), kind("WorkspaceConflict"), "repair is not a silent discard");
  await live.repairStale(orphan.leaseId, { discardChanges: true });
  assert.equal((await live.get(orphan.leaseId)).state, "released");
  assert.deepEqual(await live.findStale(), []);
  assert.equal((await live.get(healthy.leaseId)).state, "active");
  await live.release(healthy.leaseId, "live-writer");
}));

test("O1 interrupted creation leaves a discoverable record that repair resolves", { skip }, async () => withTemp(async dir => {
  const root = await repo(dir);
  const manager = await WorkspaceLeaseManager.open({ repositoryRoot: root, git, processAlive: () => false });
  const head = sh(root, "rev-parse", "HEAD").trim();
  const now = new Date().toISOString();
  const ids = ["l-0000000001-" + "a".repeat(32), "l-0000000002-" + "b".repeat(32)];
  for (const leaseId of ids) await writeFile(join(root, ".fusion", "leases", `${leaseId}.json`), JSON.stringify({ schemaVersion: 1,
    leaseId, ownerId: "crashed", state: "creating", baseCommit: head, worktree: `.fusion/worktrees/${leaseId}`,
    ownerPid: 2_000_000_000, createdAt: now, updatedAt: now }));
  // Crash after `git worktree add` but before the record became active.
  sh(root, "worktree", "add", "-q", "--detach", "--lock", join(root, ".fusion", "worktrees", ids[0]!), head);
  assert.deepEqual((await manager.findStale()).map(r => r.leaseId), ids);
  for (const leaseId of ids) await manager.repairStale(leaseId);
  assert.equal(worktrees(root).length, 1);
  for (const leaseId of ids) assert.equal((await manager.get(leaseId)).state, "released");
}));

test("O1 cleanup failure is typed, keeps the record, and a retry completes idempotently", { skip }, async () => withTemp(async dir => {
  const root = await repo(dir);
  let failRemove = true;
  const flaky: GitClient = { run: (args, options) => failRemove && args[0] === "worktree" && args[1] === "remove" ?
    (failRemove = false, Promise.resolve({ exitCode: 1, stdout: "", stderr: "locked by another process" })) : git.run(args, options) };
  const manager = await WorkspaceLeaseManager.open({ repositoryRoot: root, git: flaky });
  const lease = await manager.acquire({ ownerId: "writer-1" });
  await assert.rejects(manager.release(lease.leaseId, "writer-1"), kind("ProcessFailure"));
  assert.equal((await manager.get(lease.leaseId)).state, "releasing");
  await manager.release(lease.leaseId, "writer-1");
  await manager.release(lease.leaseId, "writer-1");
  assert.equal((await manager.get(lease.leaseId)).state, "released");
  assert.equal(worktrees(root).length, 1);
}));

test("O1 lease IDs, owners, refs and records reject traversal, option injection and sibling prefixes", { skip }, async () => withTemp(async dir => {
  const root = await repo(dir);
  const manager = await WorkspaceLeaseManager.open({ repositoryRoot: root, git });
  for (const id of ["../x", "..\\x", "l-../../etc", "C:\\x", "l-0000000001-" + "a".repeat(31), "CON", ""])
    await assert.rejects(manager.release(id, "writer-1"), kind("InvalidInput"), `rejects lease id ${JSON.stringify(id)}`);
  for (const ownerId of ["", "../x", "a b", "-x", "x".repeat(200)])
    await assert.rejects(manager.acquire({ ownerId }), kind("InvalidInput"));
  for (const baseRef of ["--upload-pack=evil", "-x", "HEAD..main", "a b", "HEAD:a.txt", "C:\\x", "HEAD\nrm", "x\u0000y", "..\\x"])
    await assert.rejects(manager.acquire({ ownerId: "writer-1", baseRef }), kind("InvalidInput"), `rejects ref ${JSON.stringify(baseRef)}`);
  await assert.rejects(manager.acquire({ ownerId: "writer-1", baseRef: "refs/heads/does-not-exist" }), kind("WorkspaceConflict"));
  const leaseId = "l-0000000003-" + "c".repeat(32);
  const evil = join(root, ".fusion", "worktrees-evil", leaseId);
  await mkdir(evil, { recursive: true }); await writeFile(join(evil, "keep.txt"), "keep\n");
  const now = new Date().toISOString();
  await writeFile(join(root, ".fusion", "leases", `${leaseId}.json`), JSON.stringify({ schemaVersion: 1, leaseId, ownerId: "writer-1",
    state: "active", baseCommit: sh(root, "rev-parse", "HEAD").trim(), worktree: `.fusion/worktrees-evil/${leaseId}`,
    ownerPid: process.pid, createdAt: now, updatedAt: now }));
  await assert.rejects(manager.release(leaseId, "writer-1", { discardChanges: true }), kind("WorkspaceConflict"));
  assert.equal(await readFile(join(evil, "keep.txt"), "utf8"), "keep\n", "a sibling-prefix path is never touched");
  assert.equal(worktrees(root).length, 1);
}));

test("O1 junctions or symlinks at or inside Fusion lease locations never redirect creation or removal", { skip }, async t => withTemp(async dir => {
  const root = await repo(dir);
  const outside = join(dir, "outside");
  await mkdir(outside); await writeFile(join(outside, "precious.txt"), "precious\n");
  const manager = await WorkspaceLeaseManager.open({ repositoryRoot: root, git });
  const type = process.platform === "win32" ? "junction" : "dir";
  const lease = await manager.acquire({ ownerId: "writer-1" });
  try { await symlink(outside, join(lease.path, "escape"), type); }
  catch (error) { t.skip(`reparse point creation unavailable: ${(error as NodeJS.ErrnoException).code}`); return; }
  await manager.release(lease.leaseId, "writer-1", { discardChanges: true });
  assert.equal(await readFile(join(outside, "precious.txt"), "utf8"), "precious\n", "removal never follows a link inside the lease");
  const second = await manager.acquire({ ownerId: "writer-2" });
  await rm(second.path, { recursive: true, force: true });
  await symlink(outside, second.path, type);
  await assert.rejects(manager.release(second.leaseId, "writer-2", { discardChanges: true }), kind("SecurityViolation"));
  assert.equal(await readFile(join(outside, "precious.txt"), "utf8"), "precious\n");
  await rm(join(root, ".fusion", "worktrees"), { recursive: true, force: true });
  await symlink(outside, join(root, ".fusion", "worktrees"), type);
  await assert.rejects(manager.acquire({ ownerId: "writer-3" }), kind("SecurityViolation"));
  assert.deepEqual((await readdir(outside)).sort(), ["precious.txt"]);
}));

test("O1 repository hooks never run for Fusion's own Git operations", { skip }, async () => withTemp(async dir => {
  const root = await repo(dir);
  const marker = join(dir, "hook-ran.txt").replace(/\\/gu, "/");
  await writeFile(join(root, ".git", "hooks", "post-checkout"), `#!/bin/sh\necho ran >> "${marker}"\n`, { mode: 0o755 });
  // Control: a plain worktree add in this environment does run the hook.
  const control = spawnSync("git", ["worktree", "add", "-q", "--detach", join(dir, "control-wt")], { cwd: root, windowsHide: true });
  assert.equal(control.status, 0);
  assert.equal((await readFile(marker, "utf8").catch(() => "")).trim(), "ran", "the hook fixture must be effective");
  await rm(marker);
  const manager = await WorkspaceLeaseManager.open({ repositoryRoot: root, git });
  const lease = await manager.acquire({ ownerId: "writer-1" });
  await manager.release(lease.leaseId, "writer-1");
  assert.equal(await readFile(marker, "utf8").catch(() => "absent"), "absent");
}));

test("O1 only the top level of a non-bare working tree can open a lease manager; nothing is created elsewhere", { skip }, async () => withTemp(async dir => {
  const plain = join(dir, "plain");
  await mkdir(plain);
  await assert.rejects(WorkspaceLeaseManager.open({ repositoryRoot: plain, git }), kind("WorkspaceConflict"));
  assert.deepEqual(await readdir(plain), [], "no .fusion directory is created outside a repository");
  const root = await repo(dir);
  await mkdir(join(root, "sub"));
  await assert.rejects(WorkspaceLeaseManager.open({ repositoryRoot: join(root, "sub"), git }), kind("WorkspaceConflict"));
  await assert.rejects(WorkspaceLeaseManager.open({ repositoryRoot: "relative/path", git }), kind("InvalidInput"));
  const bare = join(dir, "bare.git");
  sh(dir, "init", "-q", "--bare", bare);
  await assert.rejects(WorkspaceLeaseManager.open({ repositoryRoot: bare, git }), kind("WorkspaceConflict"));
}));
