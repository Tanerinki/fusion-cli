import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { failWith } from "../src/core/errors.js";
import { gitOk, ProcessGitClient, type GitClient, type GitResult, type GitRunOptions } from "../src/platform/workspace/git.js";
import { IGNORED_MONITOR_LIMITS, observeIgnored, PrimaryWorkspaceMonitor } from "../src/platform/workspace/ignored-monitor.js";
import { PrivateWriterWorkspace } from "../src/platform/workspace/private-writer.js";
import { captureSnapshot, observeWorkspace, parseStatus, type WorkspaceSnapshot } from "../src/platform/workspace/snapshot.js";
import { CANARIES, FIX, git, gitAvailable, rehearse, withRehearsalRepo } from "./fixtures/writer-rehearsal-harness.js";

const skip = gitAvailable ? false : "git executable unavailable";
/** Counts the Git processes a client starts. */
class CountingGit implements GitClient {
  count = 0;
  constructor(private readonly inner: GitClient) {}
  run(args: readonly string[], options: GitRunOptions): Promise<GitResult> { this.count++; return this.inner.run(args, options); }
}

// ---------------------------------------------------------------------------------------------------------------
// Ignored-path protection (Phase E)

test("O5.5B8 primary monitor: tracked, untracked, Git metadata, sensitive ignored and new ignored entries are all detected", { skip },
  async () => withRehearsalRepo(async repo => {
    const monitor = new PrimaryWorkspaceMonitor(repo.root, await ProcessGitClient.fromPath(process.env, true));
    const baseline = await monitor.fingerprint();
    assert.equal(await monitor.fingerprint(), baseline, "deterministic");
    // Restores rewrite the original bytes: restoring through Git would itself rewrite .git/index (and be detected).
    const money = await readFile(join(repo.root, "src", "money.ts"));
    const gitConfig = await readFile(join(repo.root, ".git", "config"));
    const cases: Array<[string, () => Promise<void>, () => Promise<void>]> = [
      ["tracked", () => writeFile(join(repo.root, "src", "money.ts"), "// edited\n"), () => writeFile(join(repo.root, "src", "money.ts"), money)],
      ["untracked", () => writeFile(join(repo.root, "draft.txt"), "x\n"), () => rm(join(repo.root, "draft.txt"))],
      ["git metadata", async () => { git(repo.root, "config", "--local", "fusion.test", "1"); },
        () => writeFile(join(repo.root, ".git", "config"), gitConfig)],
      // Same size, different content: only a content hash can see it.
      [".env content", () => writeFile(join(repo.root, ".env"), `API_TOKEN=${CANARIES.env.slice(0, -1)}X\n`),
        () => writeFile(join(repo.root, ".env"), `API_TOKEN=${CANARIES.env}\n`)],
      ["new sensitive ignored file", () => writeFile(join(repo.root, ".env"), `API_TOKEN=${CANARIES.env}\n`).then(() =>
        writeFile(join(repo.root, "prod.local"), "SECRET=1\n")), () => rm(join(repo.root, "prod.local"))],
      ["new dependency next to the managed tree", () => mkdir(join(repo.root, "node_modules", "left-pad")),
        () => rm(join(repo.root, "node_modules", "left-pad"), { recursive: true })],
    ];
    for (const [name, mutate, restore] of cases) {
      await mutate();
      assert.notEqual(await monitor.fingerprint(), baseline, `${name} is detected`);
      await restore();
      // A managed directory's signal includes its own metadata: adding and removing a child is still a change.
      if (name.startsWith("new dependency")) assert.notEqual(await monitor.fingerprint(), baseline, "a directory touch stays visible");
      else assert.equal(await monitor.fingerprint(), baseline, `${name} restored`);
    }
  }));

test("O5.5B8 primary monitor: a provider editing a sensitive ignored file during an autonomous run fails it closed", { skip },
  async () => {
    let root: string | undefined;
    await rehearse({ worker: async () => { await writeFile(join(root!, "secrets.local"), "rotated\n"); return FIX; } }, ({ result }) => {
      assert.deepEqual([result.state, result.error?.kind, result.risk?.level], ["failed", "SecurityViolation", "critical"]);
      assert.ok(result.risk!.decisive.includes("primaryWorkspaceChanged"));
    }, { before: rig => { root = rig.port.primaryRoot; } });
  });

test("O5.5B8 primary monitor: managed trees are bounded, their contents explicitly unmonitored unless protected", { skip }, async () =>
  withRehearsalRepo(async repo => {
    const git_ = await ProcessGitClient.fromPath(process.env, true);
    // A dependency tree well beyond every bound: 3,000 files.
    for (let d = 0; d < 30; d++) {
      await mkdir(join(repo.root, "node_modules", `pkg-${d}`, "lib"), { recursive: true });
      for (let f = 0; f < 100; f++) await writeFile(join(repo.root, "node_modules", `pkg-${d}`, "lib", `f${f}.js`), `module.exports=${f};\n`);
    }
    const monitor = new PrimaryWorkspaceMonitor(repo.root, git_);
    const started = performance.now();
    const before = await monitor.observe();
    const elapsed = performance.now() - started;
    const coverage = before.ignored.coverage;
    assert.equal(coverage.state, "partial", "never a false 'complete'");
    assert.ok(coverage.reasons.includes("managedDirectoryContents"));
    assert.equal(coverage.managedDirectories, 1);
    assert.ok(coverage.contentFiles + coverage.metadataFiles <= 10, `only the top-level ignored files are hashed: ${JSON.stringify(coverage)}`);
    assert.ok(elapsed < 20_000, `bounded: ${Math.round(elapsed)} ms`);
    // A nested edit inside the managed tree is NOT detected (documented partial coverage)…
    await writeFile(join(repo.root, "node_modules", "pkg-3", "lib", "f7.js"), "module.exports='changed';\n");
    assert.equal(await monitor.fingerprint(), before.digest, "the documented blind spot: contents of managed directories");
    // …unless the user declares the path protected.
    const protectedMonitor = new PrimaryWorkspaceMonitor(repo.root, git_, { protectedPaths: ["node_modules/pkg-3/lib/f7.js", "node_modules/zod/"] });
    const guarded = await protectedMonitor.fingerprint();
    await writeFile(join(repo.root, "node_modules", "pkg-3", "lib", "f7.js"), "module.exports='changed again';\n");
    assert.notEqual(await protectedMonitor.fingerprint(), guarded, "a protected path is content-monitored");
    const zodBefore = await protectedMonitor.fingerprint();
    await writeFile(join(repo.root, "node_modules", "zod", "index.js"), `module.exports = "${CANARIES.nodeModules}!";\n`);
    assert.notEqual(await protectedMonitor.fingerprint(), zodBefore, "a protected directory is walked by content");
    assert.equal(protectedMonitor.coverage?.protectedPaths, 2);
  }));

test("O5.5B8 primary monitor: huge non-managed ignored trees fall back to a directory signal; sensitive directories are walked", { skip },
  async () => withRehearsalRepo(async repo => {
    const gitignore = `${await readFile(join(repo.root, ".gitignore"), "utf8")}logs/\n.aws/\n`;
    await writeFile(join(repo.root, ".gitignore"), gitignore);
    git(repo.root, "add", ".gitignore");
    git(repo.root, "commit", "-qm", "ignore logs");
    await mkdir(join(repo.root, "logs"));
    for (let f = 0; f < IGNORED_MONITOR_LIMITS.maxWalkEntries + 50; f++) await writeFile(join(repo.root, "logs", `${f}.log`), "x\n");
    await mkdir(join(repo.root, ".aws"));
    await writeFile(join(repo.root, ".aws", "config"), "[default]\nregion = x\n");
    const monitor = new PrimaryWorkspaceMonitor(repo.root, await ProcessGitClient.fromPath(process.env, true));
    const before = await monitor.observe();
    assert.equal(before.ignored.coverage.truncatedDirectories, 1);
    assert.ok(before.ignored.coverage.reasons.includes("directoryWalkBound"));
    await writeFile(join(repo.root, ".aws", "config"), "[default]\nregion = y\n");
    assert.notEqual(await monitor.fingerprint(), before.digest, "a file inside a sensitive ignored directory is content-monitored");
  }));

test("O5.5B8 primary monitor: only digests and counts leave the monitor — never a value, a path or content", { skip }, async () =>
  withRehearsalRepo(async repo => {
    const monitor = new PrimaryWorkspaceMonitor(repo.root, await ProcessGitClient.fromPath(process.env, true), { protectedPaths: [".env"] });
    const digest = await monitor.fingerprint();
    assert.match(digest, /^[0-9a-f]{64}$/u);
    const exported = JSON.stringify({ digest, coverage: monitor.coverage });
    for (const needle of [...Object.values(CANARIES), ".env", "secrets.local", "API_TOKEN", repo.root])
      assert.equal(exported.includes(needle), false, needle);
    const direct = await observeIgnored(repo.root, [".env", "secrets.local"]);
    assert.equal(JSON.stringify(direct).includes(CANARIES.env), false);
    assert.equal(direct.coverage.sensitiveFiles, 2, ".env and *.local are sensitive by name");
  }));

// ---------------------------------------------------------------------------------------------------------------
// Git fingerprint optimization (Phase H): same result, fewer processes

/** The O5.5B7 implementation, verbatim in behaviour: seven sequential Git processes. */
async function referenceSnapshot(gitClient: GitClient, root: string): Promise<WorkspaceSnapshot> {
  const { lstat, readlink, readdir } = await import("node:fs/promises");
  const { createReadStream } = await import("node:fs");
  const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  const options = { cwd: root };
  const head = await gitClient.run(["rev-parse", "--verify", "--quiet", "HEAD"], options);
  const ref = await gitClient.run(["symbolic-ref", "--quiet", "HEAD"], options);
  const index = await gitClient.run(["ls-files", "--stage", "-z"], options);
  const flags = await gitClient.run(["ls-files", "-v", "-z"], options);
  const locations = await gitClient.run(["rev-parse", "--git-dir", "--git-common-dir"], options);
  const [rawGitDir, rawCommonDir] = locations.stdout.trim().split(/\r?\n/u);
  const gitDir = await realpath(isAbsolute(rawGitDir!) ? rawGitDir! : resolve(root, rawGitDir!));
  const commonDir = await realpath(isAbsolute(rawCommonDir!) ? rawCommonDir! : resolve(root, rawCommonDir!));
  const config = await gitClient.run(["config", "--list", "--includes", "--null", "--show-origin"], { ...options, maxStdoutBytes: 8 * 1024 * 1024 });
  const selected = [join(gitDir, "HEAD"), join(gitDir, "index"), join(gitDir, "config.worktree"), join(gitDir, "commondir"),
    join(commonDir, "config"), join(commonDir, "packed-refs"), join(commonDir, "refs"), join(commonDir, "hooks"), join(commonDir, "info"),
    join(commonDir, "objects", "info", "alternates")];
  const digest = createHash("sha256");
  const visit = async (path: string): Promise<void> => {
    let info;
    try { info = await lstat(path); } catch { digest.update(`${path}\0missing\0`); return; }
    digest.update(`${path}\0${info.mode}\0`);
    if (info.isSymbolicLink()) digest.update(`link:${await readlink(path)}\0`);
    else if (info.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    else if (info.isFile()) for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  };
  for (const path of selected) await visit(path);
  const status = await gitClient.run(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=none"], options);
  const entries = parseStatus(status.stdout);
  const digests: Record<string, string> = {};
  for (const entry of entries) {
    const path = join(root, entry.path);
    let info;
    try { info = await lstat(path); } catch { digests[entry.path] = "<missing>"; continue; }
    if (info.isSymbolicLink()) { digests[entry.path] = `link:${hash(await readlink(path))}`; continue; }
    if (info.isDirectory()) { digests[entry.path] = "<directory>"; continue; }
    const content = createHash("sha256");
    for await (const chunk of createReadStream(path)) content.update(chunk as Buffer);
    digests[entry.path] = `sha256:${content.digest("hex")}`;
  }
  if (config.exitCode !== 0 || index.exitCode !== 0 || flags.exitCode !== 0) failWith("ProcessFailure", "reference snapshot failed");
  return { head: head.exitCode === 0 ? head.stdout.trim() : null, headRef: ref.exitCode === 0 ? ref.stdout.trim() : null,
    indexDigest: hash(index.stdout), gitState: { gitDir, commonDir, metadataDigest: digest.digest("hex"),
      effectiveConfigDigest: hash(config.stdout), indexFlagsDigest: hash(flags.stdout) }, entries, digests, complete: true };
}

test("O5.5B8 Git optimization: the 4-process snapshot equals the 7-process O5.5B7 snapshot in every repository state", { skip },
  async () => withRehearsalRepo(async repo => {
    const base = await ProcessGitClient.fromPath(process.env, true);
    const states: Array<[string, () => Promise<void> | void]> = [
      ["dirty primary (uncommitted, untracked, ignored)", () => undefined],
      ["staged", () => { git(repo.root, "add", "CHANGELOG.md"); }],
      ["deleted", () => rm(join(repo.root, "src", "money.ts"))],
      ["assume-unchanged and skip-worktree", () => { git(repo.root, "update-index", "--assume-unchanged", "package.json");
        git(repo.root, "update-index", "--skip-worktree", "src/quote.ts"); }],
      ["detached HEAD", () => { git(repo.root, "checkout", "-q", "--detach"); }],
      ["another commit on the branch", async () => { git(repo.root, "checkout", "-q", "-"); git(repo.root, "commit", "-qm", "staged changelog"); }],
    ];
    for (const [name, arrange] of states) {
      await arrange();
      const referenceGit = new CountingGit(base), optimizedGit = new CountingGit(base);
      const reference = await referenceSnapshot(referenceGit, repo.root);
      const optimized = await captureSnapshot(optimizedGit, repo.root);
      assert.deepEqual(optimized, reference, name);
      assert.deepEqual([referenceGit.count, optimizedGit.count], [7, 4], `${name}: seven processes became four`);
    }
    // With the ignored listing: the same snapshot, plus ignored entries (never in entries or digests).
    const withIgnored = await observeWorkspace(base, repo.root, { ignored: true });
    assert.deepEqual(withIgnored.snapshot, await captureSnapshot(base, repo.root));
    assert.ok(withIgnored.ignored!.includes(".env") && withIgnored.ignored!.includes("node_modules/"));
  }));

test("O5.5B8 Git optimization: an unborn repository and a merge conflict observe identically too", { skip }, async () =>
  withRehearsalRepo(async repo => {
    const base = await ProcessGitClient.fromPath(process.env, true);
    git(repo.root, "checkout", "-q", "-b", "side");
    await writeFile(join(repo.root, "src", "money.ts"), "// side\n");
    git(repo.root, "commit", "-qam", "side");
    git(repo.root, "checkout", "-q", "-");
    await writeFile(join(repo.root, "src", "money.ts"), "// main\n");
    git(repo.root, "commit", "-qam", "main");
    try { git(repo.root, "merge", "side"); } catch { /* the conflict is the point */ }
    assert.deepEqual(await captureSnapshot(base, repo.root), await referenceSnapshot(base, repo.root), "unmerged stages");
    const unborn = join(repo.dir, "unborn");
    await mkdir(unborn);
    git(unborn, "init", "-q");
    await writeFile(join(unborn, "draft.txt"), "never committed\n");
    assert.deepEqual(await captureSnapshot(base, unborn), await referenceSnapshot(base, unborn), "unborn HEAD");
  }));

test("O5.5B8 Git optimization: candidate changed paths from one status equal diff HEAD plus untracked, and detect the same changes",
  { skip }, async () => withRehearsalRepo(async repo => {
    const base = await ProcessGitClient.fromPath(process.env, true);
    const workspace = await PrivateWriterWorkspace.open(repo.root, "b8-paths.worker", base, undefined);
    try {
      const reference = async (): Promise<string[]> => {
        const tracked = await gitOk(base, ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "HEAD", "--"],
          { cwd: workspace.path }, "diff");
        const untracked = await gitOk(base, ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: workspace.path }, "list");
        return [...new Set([...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean))].sort();
      };
      assert.deepEqual(await workspace.observedChanges("b8-paths.worker"), await reference(), "pristine: nothing changed");
      await writeFile(join(workspace.path, "src", "quote.ts"), "// modified\n");
      await rm(join(workspace.path, "src", "money.ts"));
      await mkdir(join(workspace.path, "src", "new", "deep"), { recursive: true });
      await writeFile(join(workspace.path, "src", "new", "deep", "added.ts"), "export {};\n");
      await writeFile(join(workspace.path, "ignored.local"), "ignored by *.local\n");
      const observed = await workspace.observedChanges("b8-paths.worker");
      assert.deepEqual(observed, await reference());
      assert.deepEqual(observed, ["src/money.ts", "src/new/deep/added.ts", "src/quote.ts"]);
      // A Git-metadata change is still refused by the same observation.
      git(workspace.path, "config", "--local", "fusion.test", "1");
      await assert.rejects(workspace.observedChanges("b8-paths.worker"), (error: unknown) =>
        (error as { error?: { kind?: string } }).error?.kind === "SecurityViolation");
    } finally { await workspace.close("b8-paths.worker", { discardChanges: true }); }
  }));

test("O5.5B8 Git optimization: one medium Writer attempt starts far fewer Git processes than O5.5B7's 236", { skip }, async t => {
  const original = ProcessGitClient.prototype.run;
  let count = 0;
  ProcessGitClient.prototype.run = function (this: ProcessGitClient, args: readonly string[], options: GitRunOptions) {
    count++; return original.call(this, args, options);
  };
  try {
    const started = performance.now();
    await rehearse({ worker: () => FIX }, ({ result }) => assert.equal(result.state, "completed", JSON.stringify(result.error)));
    t.diagnostic(`git processes: ${count} (O5.5B7 baseline 236); wall ${Math.round(performance.now() - started)} ms`);
    assert.ok(count <= 160, `git processes for one medium attempt: ${count}`);
  } finally { ProcessGitClient.prototype.run = original; }
});
