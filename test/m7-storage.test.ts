import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { presentFailure } from "../src/cli/failure-presentation.js";
import { DiagnosticRedactor } from "../src/core/policy/redaction.js";
import { projectProviderEvidence } from "../src/platform/events/evidence.js";
import { RunStore } from "../src/platform/events/run-store.js";
import { isContainedPath, StorageError } from "../src/platform/events/shared.js";

async function withTemp<T>(prefix: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try { return await run(dir); }
  finally {
    const base = resolve(tmpdir()).toLowerCase(), target = resolve(dir).toLowerCase();
    assert.ok(target.startsWith(`${base}${sep}`), "test cleanup must remain inside temp");
    await rm(dir, { recursive: true, force: true });
  }
}
const kind = (expected: string) => (error: unknown): boolean => error instanceof StorageError && error.kind === expected;

test("M7.8 artifact paths reject traversal, absolute, drive, UNC, device, separator and reserved-character forms", async () => withTemp("fusion-m7-paths-", async repo => {
  const store = await (await RunStore.create(repo)).openArtifacts();
  const rejected = ["../x", "a/../../x", "/abs", "C:/x", "C:x", "c:", "\\\\server\\share\\x", "//server/share/x", "a\\b",
    "CON", "con.txt", "nul", "Nul.json", "COM1.log", "lpt9", "COM¹", "conin$", "CONOUT$.txt", "clock$",
    "a/./b", "a//b", "./a", "a/", "a/b.", "a/b ", "a*b", "a?b", "a<b", "a>b", "a|b", 'a"b', "a\u0000b", "a\nb",
    "x".repeat(600), ""];
  for (const path of rejected)
    assert.throws(() => store.resolveRelativePath(path), kind("InvalidArtifactPath"), `rejects ${JSON.stringify(path)}`);
  for (const path of ["text/a.txt", "a/b/c", "conx", "com10", "nul_.txt", "..a", "a..b"])
    assert.ok(isContainedPath(store.root, store.resolveRelativePath(path)), `accepts ${path}`);
}));

test("M7.8 containment uses path semantics: sibling prefixes, other drives and case rules", () => {
  assert.equal(isContainedPath("C:\\root", "C:\\root-evil\\x", "win32"), false);
  assert.equal(isContainedPath("C:\\root", "C:\\ROOT\\child", "win32"), true, "Windows paths compare case-insensitively");
  assert.equal(isContainedPath("C:\\root", "D:\\root\\child", "win32"), false);
  assert.equal(isContainedPath("C:\\root", "C:\\root\\..\\other", "win32"), false);
  assert.equal(isContainedPath("C:\\root", "C:\\root", "win32"), true);
  assert.equal(isContainedPath("/a/B", "/a/b/x", "linux"), false, "POSIX paths stay case-sensitive");
  assert.equal(isContainedPath("/a/b", "/a/b/..c", "linux"), true);
  assert.equal(isContainedPath("/a/b", "/a/bc", "linux"), false);
});

test("M7.8 a junction or symlink replacing an artifact category is refused and nothing escapes", async t => withTemp("fusion-m7-junction-", async dir => {
  const repo = join(dir, "repo"), outside = join(dir, "outside");
  await mkdir(repo); await mkdir(outside);
  const store = await (await RunStore.create(repo)).openArtifacts();
  try { await symlink(outside, join(store.root, "text"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) {
    t.skip(`reparse point creation unavailable: ${(error as NodeJS.ErrnoException).code ?? "unknown"}`);
    return;
  }
  await assert.rejects(store.storeText("must stay inside the run"), kind("InvalidArtifactPath"));
  assert.deepEqual(await readdir(outside), []);
}));

test("M7.8 file-for-directory, directory-for-file and vanished artifacts fail as typed storage errors", async () => withTemp("fusion-m7-types-", async repo => {
  const store = await (await RunStore.create(repo)).openArtifacts();
  await writeFile(join(store.root, "json"), "user file in place of a category");
  await assert.rejects(store.storeJson({ ok: true }), kind("InvalidArtifactPath"));
  assert.equal(await readFile(join(store.root, "json"), "utf8"), "user file in place of a category");
  const stored = await store.storeText("present");
  const blob = join(store.root, stored.relativePath);
  await rm(blob);
  await mkdir(blob);
  await assert.rejects(store.getArtifactPath(stored.artifactId), kind("InvalidArtifactPath"));
  await rm(blob, { recursive: true });
  await assert.rejects(store.getArtifactPath(stored.artifactId), (error: unknown) =>
    error instanceof StorageError && error.kind === "ArtifactError" && (error.cause as NodeJS.ErrnoException)?.code === "ENOENT",
    "the original filesystem cause stays inspectable");
}));

test("M7.8 a read-only index fails the write, keeps the cause and leaves no orphan blob",
  { skip: process.getuid?.() === 0 ? "file permissions do not bind the root user" : false },
  async () => withTemp("fusion-m7-readonly-", async repo => {
  const store = await (await RunStore.create(repo)).openArtifacts();
  await chmod(store.indexPath, 0o444);
  try {
    await assert.rejects(store.storeText("blocked"), (error: unknown) =>
      error instanceof StorageError && error.kind === "ArtifactError" &&
      ["EPERM", "EACCES"].includes((error.cause as NodeJS.ErrnoException)?.code ?? ""));
    const textDir = join(store.root, "text");
    assert.deepEqual((await readdir(textDir)).filter(name => !name.startsWith(".")), []);
  } finally { await chmod(store.indexPath, 0o644); }
}));

test("M7.6/M7.8 a missing or non-directory repository root is a typed failure that touches nothing", async () => withTemp("fusion-m7-root-", async dir => {
  await assert.rejects(RunStore.create(join(dir, "absent")), (error: unknown) =>
    error instanceof StorageError && /does not exist/u.test(error.message) &&
    (error.cause as NodeJS.ErrnoException)?.code === "ENOENT");
  await writeFile(join(dir, ".fusion"), "a user file named .fusion");
  await assert.rejects(RunStore.create(dir), kind("StorageError"));
  assert.equal(await readFile(join(dir, ".fusion"), "utf8"), "a user file named .fusion");
  await assert.rejects(RunStore.create("relative/path"), kind("StorageError"));
}));

test("M7.6 Fusion storage ignores itself without replacing an existing ignore file", async () => withTemp("fusion-m7-ignore-", async repo => {
  await RunStore.create(repo);
  assert.equal(await readFile(join(repo, ".fusion", ".gitignore"), "utf8"), "# Fusion local run storage; never committed.\n*\n");
  const other = join(repo, "second");
  await mkdir(join(other, ".fusion"), { recursive: true });
  await writeFile(join(other, ".fusion", ".gitignore"), "user-owned rules\n");
  await RunStore.create(other);
  assert.equal(await readFile(join(other, ".fusion", ".gitignore"), "utf8"), "user-owned rules\n");
}));

const gitAvailable = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=Fusion Test", "-c", "user.email=fusion@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", "-c", "init.defaultBranch=main",
    "-c", `core.hooksPath=${join(cwd, ".no-hooks")}`, ...args], { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0 && !(args[0] === "merge" && result.status === 1))
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}
async function userSnapshot(repo: string): Promise<Readonly<{ status: string; files: string }>> {
  const status = git(repo, "status", "--porcelain=v1", "-uall");
  const entries: string[] = [];
  for (const entry of await readdir(repo, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name), rel = relative(repo, path);
    if (!entry.isFile() || rel.startsWith(".git") || rel.startsWith(".fusion")) continue;
    entries.push(`${rel}:${createHash("sha256").update(await readFile(path)).digest("hex")}`);
  }
  return { status, files: entries.sort().join("\n") };
}
/** Exercises every storage write path plus a rejected write and a failed-run manifest update. */
async function fusionStorageActivity(repo: string): Promise<void> {
  const run = await RunStore.create(repo, { workflowId: "review", risk: "medium" });
  const events = await run.openEvents();
  await events.append({ type: "RunStarted", source: "runtime", payload: { workflowId: "review" } });
  const artifacts = await run.openArtifacts();
  await artifacts.storeText("diagnostic");
  await artifacts.storeJson({ summary: "ok" });
  assert.throws(() => artifacts.resolveRelativePath("../../escape.txt"));
  await run.openMetrics().write({ schemaVersion: 1, runId: run.runId, success: false });
  await events.append({ type: "RunFailed", source: "runtime", payload: { errorKind: "Cancelled" } });
  await run.updateManifest({ status: "failed", completedAt: new Date().toISOString() });
}

test("M7.6 user work survives Fusion storage in clean, dirty, conflicted, detached, unborn and worktree repositories",
  { skip: gitAvailable ? false : "git executable unavailable" }, async () => withTemp("fusion-m7-git-", async dir => {
  const scenarios: Array<[string, (repo: string) => Promise<string>]> = [
    ["clean", async repo => { git(repo, "init", "-q"); await writeFile(join(repo, "a.txt"), "one\n"); git(repo, "add", ".");
      git(repo, "commit", "-qm", "init"); return repo; }],
    ["dirty", async repo => { git(repo, "init", "-q"); await writeFile(join(repo, "a.txt"), "one\n");
      await writeFile(join(repo, "b.txt"), "base\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "init");
      await writeFile(join(repo, "a.txt"), "modified but unstaged\n");
      await writeFile(join(repo, "b.txt"), "staged change\n"); git(repo, "add", "b.txt");
      await writeFile(join(repo, "c.txt"), "untracked\n"); return repo; }],
    ["conflicted", async repo => { git(repo, "init", "-q"); await writeFile(join(repo, "a.txt"), "base\n"); git(repo, "add", ".");
      git(repo, "commit", "-qm", "init"); git(repo, "checkout", "-qb", "feature");
      await writeFile(join(repo, "a.txt"), "feature\n"); git(repo, "commit", "-qam", "feature");
      git(repo, "checkout", "-q", "main"); await writeFile(join(repo, "a.txt"), "main\n"); git(repo, "commit", "-qam", "main");
      git(repo, "merge", "feature"); return repo; }],
    ["detached", async repo => { git(repo, "init", "-q"); await writeFile(join(repo, "a.txt"), "one\n"); git(repo, "add", ".");
      git(repo, "commit", "-qm", "init"); git(repo, "checkout", "-q", "--detach");
      await writeFile(join(repo, "a.txt"), "edited on detached head\n"); return repo; }],
    ["unborn", async repo => { git(repo, "init", "-q"); await writeFile(join(repo, "draft.txt"), "never committed\n"); return repo; }],
    ["worktree", async repo => { git(repo, "init", "-q"); await writeFile(join(repo, "a.txt"), "one\n"); git(repo, "add", ".");
      git(repo, "commit", "-qm", "init"); const tree = `${repo}-wt`; git(repo, "worktree", "add", "-q", tree);
      await writeFile(join(tree, "a.txt"), "worktree edit\n"); return tree; }],
  ];
  for (const [name, setup] of scenarios) {
    const root = join(dir, name);
    await mkdir(root);
    const repo = await setup(root);
    const before = await userSnapshot(repo);
    if (name === "conflicted") assert.match(before.status, /^UU a\.txt$/mu, "fixture must produce a real conflict");
    await fusionStorageActivity(repo);
    const after = await userSnapshot(repo);
    assert.equal(after.status, before.status, `${name}: git status must be unchanged, including no .fusion entry`);
    assert.equal(after.files, before.files, `${name}: user file contents must be unchanged`);
  }
}));

test("M7.7 the same synthetic secret never reaches persisted run storage in any form", async () => withTemp("fusion-m7-secrets-", async repo => {
  const known = "fusion-known-secret-7d2e41";
  const unknown = "fusion-unknown-secret-93ab6c";
  const redactor = new DiagnosticRedactor([known]);
  const run = await RunStore.create(repo, { workflowId: `wf ${known}` }, redactor);
  const events = await run.openEvents();
  await events.append({ type: "ProviderObserved", source: "provider", payload: { evidence: {
    providerId: "provider", transportId: "transport", requestedModel: `model ${known}`, runtimeVersion: `v ${known}` } } });
  const artifacts = await run.openArtifacts();
  await artifacts.storeText([known, `${known} and again ${known}`, `https://user:${unknown}@10.1.2.3/repo`,
    `Authorization: Bearer ${unknown}`, `Authorization: Basic ${unknown}`, `Proxy-Authorization: Token ${unknown}`,
    `Cookie: session=${unknown}; theme=dark`, `stderr: token=${unknown}`, `"apiKey": "${unknown}"`,
    `password=${unknown}`, "sk-ant-api03-SYNTHETICFIXTUREVALUE0000", "ghp_SYNTHETICFIXTUREVALUE000000000000"].join("\n"));
  await artifacts.storeJson({ nested: { list: [known, { deeper: `x ${known} y` }] }, url: `https://u:${unknown}@example.test/`,
    header: `Authorization: Basic ${unknown}`, apiKey: unknown });
  await artifacts.storeJsonl([{ line: known }, { cookie: unknown }]);
  const cause = new StorageError("ArtifactError", "Could not write artifact.", undefined,
    { cause: new Error(`EACCES writing C:\\secret\\${known}`) });
  for (const debug of [false, true]) {
    const shown = presentFailure(cause, { debug, redactor }).text;
    assert.doesNotMatch(shown, new RegExp(known, "u"));
    assert.doesNotMatch(shown, /\n\s+at\s/u, "no stack trace");
  }
  const projected = JSON.stringify(projectProviderEvidence({ providerId: "p", transportId: "t",
    requestedModel: `m ${known}`, observedModel: `o ${known}` }, redactor));
  assert.doesNotMatch(projected, new RegExp(known, "u"));
  const leaks: string[] = [];
  for (const entry of await readdir(run.directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name), text = await readFile(path, "utf8");
    for (const secret of [known, unknown, "SYNTHETICFIXTUREVALUE"]) if (text.includes(secret)) leaks.push(`${entry.name}:${secret}`);
  }
  assert.deepEqual(leaks, []);
}));

test("M7.7 redaction survives cycles and extreme nesting without throwing or copying secrets", () => {
  const redactor = new DiagnosticRedactor(["cycle-secret-value"]);
  const cyclic: Record<string, unknown> = { value: "cycle-secret-value" };
  cyclic.self = cyclic;
  const out = JSON.stringify(redactor.redact(cyclic));
  assert.doesNotMatch(out, /cycle-secret-value/u);
  assert.match(out, /REDACTED_CYCLE/u);
  let deep: unknown = "cycle-secret-value";
  for (let i = 0; i < 500; i++) deep = { d: deep };
  const deepOut = JSON.stringify(redactor.redact(deep));
  assert.doesNotMatch(deepOut, /cycle-secret-value/u);
  assert.match(deepOut, /REDACTED_DEPTH/u);
  const shared = { s: "shared" };
  assert.deepEqual(redactor.redact({ a: shared, b: shared }), { a: { s: "shared" }, b: { s: "shared" } }, "shared references are not cycles");
});
