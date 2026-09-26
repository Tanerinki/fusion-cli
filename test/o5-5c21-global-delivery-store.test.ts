import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { ControlPlane } from "../src/app/control-plane.js";
import { deliveryRepository, openDeliveryNamespace, prepareStoredDelivery } from "../src/app/delivery-service.js";
import type { ProviderRegistry } from "../src/app/providers.js";
import { QUOTE_BUGGY, QUOTE_FIXED, QUOTE_TEST } from "../src/app/route-fixture.js";
import { runCli } from "../src/cli/run.js";
import type { ChangeSet } from "../src/core/domain.js";
import { FusionFailure } from "../src/core/errors.js";
import type { WorkflowResult } from "../src/core/workflow/types.js";
import { defaultDeliveryStoreBase } from "../src/platform/delivery/state-root.js";
import { FilesystemDeliveryStore } from "../src/platform/delivery/store.js";
import { isContainedPath } from "../src/platform/events/shared.js";
import { ProcessGitClient } from "../src/platform/workspace/git.js";
import { ProviderViewStore } from "../src/platform/workspace/provider-views.js";
import { changeSet } from "./fixtures/fake-writer.js";
import { git, gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5C2.1 — the delivery store lives in Fusion's application state OUTSIDE the target repository: the production default
 * (`%LOCALAPPDATA%\Fusion\deliveries`, `$XDG_STATE_HOME/fusion/deliveries`), one namespace per repository identity, each
 * delivery bound to its checkout. Offline; the application-state variables point into a temporary directory, never at the
 * real user profile.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const kind = (expected: string) => (error: unknown) => error instanceof FusionFailure && error.error.kind === expected;
const UPDATE = changeSet([["src/quote.ts", QUOTE_BUGGY, QUOTE_FIXED]]);
const DELIVERY_FILES = new Set(["manifest.json", "bundle.json", "record.json", "events.jsonl", "approval.json", "apply.claim"]);

async function withTemp<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "fusion-c21-")));
  try { return await work(dir); }
  finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}
/** A clean committed repository with an ignored `.env` canary. */
async function primary(root: string, seed = "baseline"): Promise<string> {
  const files: Record<string, string> = { ".gitignore": ".env\n", "src/quote.ts": QUOTE_BUGGY, "test/quote.test.ts": QUOTE_TEST, "README.md": `# ${seed}\n` };
  for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); }
  git(root, "init", "-q"); git(root, "add", "."); git(root, "commit", "-qm", seed);
  await writeFile(join(root, ".env"), "TOKEN=c21-canary\n");
  return root;
}
function acceptedResult(changes: ChangeSet): WorkflowResult {
  return { state: "completed", transitions: [], delegateAttempts: 1, reviews: [], changeSet: changes,
    applied: changes.operations.map(op => op.kind === "delete"
      ? { kind: op.kind, path: op.path, beforeSha256: op.expectedSha256, afterSha256: null, bytes: 0 }
      : { kind: op.kind, path: op.path, beforeSha256: op.expectedSha256, afterSha256: sha256(op.content), bytes: Buffer.byteLength(op.content) }),
    verification: { passed: true, commandsRun: 1, evidence: { backendId: "docker-linux", confinement: "osSandbox", platformRequirement: "linux-compatible",
      acceptance: "granted", commands: [{ id: "unit", status: "passed", exitCode: 0 }] } } };
}
const registry: ProviderRegistry = { factories: new Map(), defaults: { schemaVersion: 1, bindings: [], verification: { commands: [] }, limits: { runTimeoutMs: 60_000 } } };
/** The production environment's view of application state, redirected into the temporary directory. */
const appStateEnv = (dir: string): NodeJS.ProcessEnv => ({ ...process.env, LOCALAPPDATA: join(dir, "localappdata"), XDG_STATE_HOME: join(dir, "xdg-state") });
async function prepare(root: string, storeBase: string, runId = "c21-run") {
  return prepareStoredDelivery({ runId, taskSha256: "a".repeat(64), workflowEvidenceSha256: "b".repeat(64), result: acceptedResult(UPDATE),
    scope: { allowedPaths: ["src/quote.ts"], forbiddenPaths: [] }, baseCommit: git(root, "rev-parse", "HEAD").trim(), primaryRoot: root,
    git: await ProcessGitClient.fromPath(process.env, true), storeBase });
}
async function cli(argv: string[], cwd: string, env: NodeJS.ProcessEnv, extra: { storeRoot?: string; answer?: string } = {}) {
  let stdout = "", stderr = "";
  const code = await runCli(argv, { stdout: t => { stdout += t; }, stderr: t => { stderr += t; }, interactive: extra.answer !== undefined,
    ...(extra.answer === undefined ? {} : { prompt: async () => extra.answer! }) },
    { env, cwd, registry, ...(extra.storeRoot === undefined ? {} : { deliveryStoreRoot: extra.storeRoot }) });
  return { code, stdout, stderr };
}
async function filesUnder(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  return (await readdir(root, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())
    .map(entry => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/")).sort();
}

test("O5.5C2.1 (1): the production default is the OS application state, outside any repository; relative, empty or network values fall back", () => {
  assert.equal(defaultDeliveryStoreBase({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32", "C:\\Users\\u"), "C:\\Users\\u\\AppData\\Local\\Fusion\\deliveries");
  for (const bad of [undefined, "", "relative\\dir", "\\\\server\\share\\AppData", "/unix/path"])
    assert.equal(defaultDeliveryStoreBase({ ...(bad === undefined ? {} : { LOCALAPPDATA: bad }) }, "win32", "C:\\Users\\u"),
      "C:\\Users\\u\\AppData\\Local\\Fusion\\deliveries", String(bad));
  assert.equal(defaultDeliveryStoreBase({ XDG_STATE_HOME: "/var/state/u" }, "linux", "/home/u"), "/var/state/u/fusion/deliveries");
  for (const bad of [undefined, "", "relative/state"])
    assert.equal(defaultDeliveryStoreBase({ ...(bad === undefined ? {} : { XDG_STATE_HOME: bad }) }, "linux", "/home/u"), "/home/u/.local/state/fusion/deliveries");
  assert.throws(() => defaultDeliveryStoreBase({}, "linux", "relative-home"), kind("InvalidInput"));
});

test("O5.5C2.1 (1, 2, 5): without a seam the CLI uses the application state; preparing writes nothing into the target repository", { skip }, async () =>
  withTemp(async dir => {
    const root = await primary(join(dir, "primary"));
    const env = appStateEnv(dir);
    const repository = await deliveryRepository(new ControlPlane({ registry, env, cwd: root }));
    assert.equal(repository.storeBase, defaultDeliveryStoreBase(env));
    assert.ok(!isContainedPath(root, repository.storeBase) && !isContainedPath(repository.storeBase, root), "the default base is outside the repository");
    const statusBefore = git(root, "status", "--porcelain=v1", "-uall", "--ignored");
    const delivery = await prepare(root, repository.storeBase);
    const namespace = await openDeliveryNamespace(repository, false);
    assert.equal(namespace.base, await realpath(repository.storeBase));
    assert.match(relative(namespace.base, namespace.store.root), /^[0-9a-f]{64}$/u, "one namespace per repository identity, never a path or name");
    assert.deepEqual(await filesUnder(join(namespace.store.root, delivery.deliveryId)), ["bundle.json", "events.jsonl", "manifest.json", "record.json"]);
    // (2) Nothing in the repository: no `.fusion`, no new file, ignored files included.
    assert.ok(!existsSync(join(root, ".fusion")));
    assert.equal(git(root, "status", "--porcelain=v1", "-uall", "--ignored"), statusBefore);
    // Lookup by id works through the production default (the CLI sets no store seam here).
    const inspect = await cli(["inspect-delivery", delivery.deliveryId], root, env);
    assert.equal(inspect.code, 0, inspect.stderr);
    assert.match(inspect.stdout, new RegExp(`^Manifest: sha256:${delivery.manifestSha256}$`, "mu"));
    // (5) An injected root is used instead, for deterministic tests.
    const injected = join(dir, "injected-state");
    const second = await prepare(root, injected, "c21-run-2");
    assert.ok(existsSync(join(injected, namespace.repositoryIdentity, second.deliveryId, "manifest.json")));
    assert.equal((await cli(["inspect-delivery", second.deliveryId], root, env, { storeRoot: injected })).code, 0);
    assert.equal((await cli(["inspect-delivery", second.deliveryId], root, env)).code, 2, "the default store does not hold it");
    // The entry point never injects a root; the store modules read no variable themselves.
    const main = await readFile(resolve("dist", "src", "cli", "main.js"), "utf8");
    assert.ok(!main.includes("deliveryStoreRoot"));
    for (const file of ["src/platform/delivery/state-root.js", "src/platform/delivery/store.js", "src/app/delivery-service.js"]) {
      const text = await readFile(resolve("dist", file), "utf8");
      for (const banned of ["process.env", "FUSION_", ".fusion", "child_process", "node:net", "fetch("]) assert.ok(!text.includes(banned), `${file}: ${banned}`);
    }
  }));

test("O5.5C2.1 (5): a base that overlaps the target repository is refused before anything is created — seam, variable or link", { skip }, async () =>
  withTemp(async dir => {
    const root = await primary(join(dir, "primary"));
    const before = git(root, "status", "--porcelain=v1", "-uall", "--ignored");
    for (const [name, base] of [["inside", join(root, "state")], ["the repository itself", root], ["containing it", dir]] as const) {
      await assert.rejects(prepare(root, base), kind("SecurityViolation"), name);
      assert.equal((await cli(["inspect-delivery", "d-anything"], root, process.env, { storeRoot: base })).code, 4, name);
    }
    // The production variable pointing into the repository is refused too.
    const env = { ...process.env, LOCALAPPDATA: join(root, "appdata"), XDG_STATE_HOME: join(root, "state") };
    const repository = await deliveryRepository(new ControlPlane({ registry, env, cwd: root }));
    await assert.rejects(prepare(root, repository.storeBase), kind("SecurityViolation"));
    // A link outside the repository that resolves into it: refused before any directory is created inside.
    const link = join(dir, "state-link");
    let linked = true;
    try { await symlink(root, link, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") linked = false; else throw error; }
    if (linked) await assert.rejects(prepare(root, join(link, "Fusion", "deliveries")), kind("SecurityViolation"));
    assert.equal(git(root, "status", "--porcelain=v1", "-uall", "--ignored"), before, "nothing was created in the repository");
    assert.ok(!existsSync(join(root, "state")) && !existsSync(join(root, "appdata")) && !existsSync(join(root, "Fusion")));
  }));

test("O5.5C2.1 (3): a provider view of the target repository cannot contain the delivery store", { skip }, async () =>
  withTemp(async dir => {
    const root = await primary(join(dir, "primary"));
    const base = defaultDeliveryStoreBase(appStateEnv(dir));
    await prepare(root, base);
    const views = new ProviderViewStore({ primaryRoot: root, git: await ProcessGitClient.fromPath(process.env, true) });
    for (const view of [await views.workingTree("c21-owner"), await views.baseline("c21-owner")]) {
      const files = await filesUnder(view.path);
      assert.ok(files.length > 0);
      assert.ok(files.every(path => !DELIVERY_FILES.has(path.split("/").at(-1)!)), `${view.kind}: no delivery artifact in the view`);
      assert.ok(!isContainedPath(view.path, base) && !isContainedPath(base, view.path));
      await views.release(view.viewId);
    }
    assert.ok(!isContainedPath(root, base), "repository-relative discovery never reaches the store");
  }));

test("O5.5C2.1 (4): the store survives a clean, a checkout and the repository's deletion; another checkout or repository cannot use it", { skip }, async () =>
  withTemp(async dir => {
    const root = await primary(join(dir, "primary"));
    const env = appStateEnv(dir);
    const base = defaultDeliveryStoreBase(env);
    const delivery = await prepare(root, base);
    const approve = await cli(["approve-delivery", delivery.deliveryId], root, env, { answer: delivery.manifestSha256 });
    assert.equal(approve.code, 0, approve.stderr);
    const namespace = await openDeliveryNamespace(await deliveryRepository(new ControlPlane({ registry, env, cwd: root })), false);
    const dirOf = join(namespace.store.root, delivery.deliveryId);
    const files = Object.fromEntries(await Promise.all((await filesUnder(dirOf)).map(async name => [name, sha256(await readFile(join(dirOf, name)))] as const)));
    // A clean of ignored files (which removed an in-repository `.fusion`) and a checkout leave the store intact.
    git(root, "clean", "-fdxq");
    git(root, "checkout", "-q", "--", ".");
    assert.equal((await namespace.store.load(delivery.deliveryId)).state, "approved");
    // Another checkout of the same repository (a clone: same identity) finds the namespace but not the right to use it.
    const clone = join(dir, "clone");
    git(dir, "clone", "-q", root, clone);
    const elsewhere = await cli(["apply", delivery.deliveryId], clone, env);
    assert.equal(elsewhere.code, 2);
    assert.match(elsewhere.stderr, /prepared in another checkout/u);
    // Another repository (other root commits) has its own namespace: the id is unknown there; a copied delivery is refused.
    const other = await primary(join(dir, "other"), "another history");
    assert.equal((await cli(["inspect-delivery", delivery.deliveryId], other, env)).code, 2);
    const otherNamespace = await openDeliveryNamespace(await deliveryRepository(new ControlPlane({ registry, env, cwd: other })), false);
    assert.notEqual(otherNamespace.repositoryIdentity, namespace.repositoryIdentity);
    await mkdir(otherNamespace.store.root, { recursive: true });
    await cp(dirOf, join(otherNamespace.store.root, delivery.deliveryId), { recursive: true });
    const misfiled = await cli(["inspect-delivery", delivery.deliveryId], other, env);
    assert.equal(misfiled.code, 4);
    assert.match(misfiled.stderr, /filed under another repository/u);
    // Deleting the repository does not erase its deliveries.
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    const survivor = await new FilesystemDeliveryStore(namespace.store.root).load(delivery.deliveryId);
    assert.equal(survivor.state, "approved");
    assert.deepEqual(Object.fromEntries(await Promise.all((await filesUnder(dirOf)).map(async name => [name, sha256(await readFile(join(dirOf, name)))] as const))), files);
    // (6) Invalid ids are still refused.
    assert.equal((await cli(["inspect-delivery", "../x"], clone, env)).code, 2);
  }));
