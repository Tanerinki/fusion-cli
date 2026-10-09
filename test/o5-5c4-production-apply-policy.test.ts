import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { checkoutDigest, prepareStoredDelivery } from "../src/app/delivery-service.js";
import type { ProviderRegistry } from "../src/app/providers.js";
import { QUOTE_BUGGY, QUOTE_FIXED, QUOTE_TEST } from "../src/app/route-fixture.js";
import { REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport } from "../src/app/writer-gate.js";
import { runCli } from "../src/cli/run.js";
import { canonicalJson } from "../src/core/delivery/canonical.js";
import type { ChangeSet } from "../src/core/domain.js";
import type { WorkflowResult } from "../src/core/workflow/types.js";
import type { DeliveryFaults } from "../src/platform/delivery/applier.js";
import { defaultDeliveryStoreBase } from "../src/platform/delivery/state-root.js";
import { ProcessGitClient } from "../src/platform/workspace/git.js";
import { changeSet } from "./fixtures/fake-writer.js";
import { git, gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5C4 — the production apply policy, offline, on ORDINARY temporary Git repositories through the NORMAL CLI composition:
 * `runCli` with the process environment (application state redirected into the temporary directory through the OS's own
 * LOCALAPPDATA / XDG_STATE_HOME, exactly as production resolves it), the working directory and an empty provider registry.
 * No disposable-target seam (it no longer exists), no rehearsal entry, no store or Git injection. Only the rollback cases
 * use the existing fault-injection seam, because a real mid-apply write failure cannot be produced portably.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const OLD_DOC = "# Old notes\n", DISCOUNT = "export const FULL = 10_000;\n", CANARY = "# Canary: never changes\n", ENV = "TOKEN=c4-sensitive-canary\n";
const UPDATE = changeSet([["src/quote.ts", QUOTE_BUGGY, QUOTE_FIXED]]);
const CREATE = changeSet([["src/lib/discount.ts", null, DISCOUNT]]);
const DELETE = changeSet([["docs/old.md", OLD_DOC, null]]);
const MULTI = changeSet([["src/quote.ts", QUOTE_BUGGY, QUOTE_FIXED], ["src/lib/discount.ts", null, DISCOUNT], ["docs/old.md", OLD_DOC, null]]);

interface Fixture { dir: string; root: string; env: NodeJS.ProcessEnv; storeBase: string }
/** An ordinary repository: committed files, an untouched canary, an ignored sensitive `.env`. */
async function makeRepository(root: string, seed = "baseline"): Promise<void> {
  const files: Record<string, string> = { ".gitignore": ".env\n", "src/quote.ts": QUOTE_BUGGY, "test/quote.test.ts": QUOTE_TEST, "docs/old.md": OLD_DOC,
    "README.md": `# ${seed}\n`, "CANARY.md": CANARY };
  for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); }
  git(root, "init", "-q"); git(root, "add", "."); git(root, "commit", "-qm", seed);
  await writeFile(join(root, ".env"), ENV);
}
async function withRepository<T>(work: (f: Fixture) => Promise<T>): Promise<T> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "fusion-c4-")));
  try {
    const root = join(dir, "project");
    await makeRepository(root);
    const env = { ...process.env, LOCALAPPDATA: join(dir, "localappdata"), XDG_STATE_HOME: join(dir, "xdg-state") };
    return await work({ dir, root, env, storeBase: defaultDeliveryStoreBase(env) });
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}
async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name), rel = relative(root, path).split(sep).join("/");
    if (!entry.isFile() || rel.startsWith(".git/")) continue;
    files[rel] = sha256(await readFile(path));
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : 1));
}
function acceptedResult(changes: ChangeSet): WorkflowResult {
  return { state: "completed", transitions: [], delegateAttempts: 1, reviews: [], changeSet: changes,
    applied: changes.operations.map(op => op.kind === "delete"
      ? { kind: op.kind, path: op.path, beforeSha256: op.expectedSha256, afterSha256: null, bytes: 0 }
      : { kind: op.kind, path: op.path, beforeSha256: op.expectedSha256, afterSha256: sha256(op.content), bytes: Buffer.byteLength(op.content) }),
    verification: { passed: true, commandsRun: 1, evidence: { backendId: "docker-linux", confinement: "osSandbox", platformRequirement: "linux-compatible",
      acceptance: "granted", commands: [{ id: "unit", status: "passed", exitCode: 0 }] } } };
}
/** A registry with no provider; every access is recorded (the delivery commands must never reach one). */
function sealedRegistry(): { registry: ProviderRegistry; touched: string[] } {
  const touched: string[] = [];
  const factories = new Proxy(new Map(), { get(target, prop) {
    touched.push(String(prop));
    const value = Reflect.get(target, prop, target) as unknown;
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
  } }) as unknown as ProviderRegistry["factories"];
  return { touched, registry: { factories, defaults: { schemaVersion: 1, bindings: [], verification: { commands: [] }, limits: { runTimeoutMs: 60_000 } } } };
}
const REGISTRY = sealedRegistry();
async function prepare(f: Fixture, changes: ChangeSet, runId = "c4-run", root = f.root) {
  return prepareStoredDelivery({ runId, taskSha256: "a".repeat(64), workflowEvidenceSha256: "b".repeat(64), result: acceptedResult(changes),
    scope: { allowedPaths: changes.operations.map(op => op.path), forbiddenPaths: [] }, baseCommit: git(root, "rev-parse", "HEAD").trim(), primaryRoot: root,
    git: await ProcessGitClient.fromPath(process.env, true), storeBase: f.storeBase });
}
interface Ran { code: number; stdout: string; stderr: string }
/** The NORMAL CLI: environment, working directory, provider registry — nothing else (faults only where stated). */
async function cli(f: Fixture, argv: string[], extra: { cwd?: string; answer?: string; faults?: DeliveryFaults } = {}): Promise<Ran> {
  let stdout = "", stderr = "";
  const host = { env: f.env, cwd: extra.cwd ?? f.root, registry: REGISTRY.registry, ...(extra.faults ? { deliveryFaults: extra.faults } : {}) };
  const code = await runCli(argv, { stdout: t => { stdout += t; }, stderr: t => { stderr += t; }, interactive: extra.answer !== undefined,
    ...(extra.answer === undefined ? {} : { prompt: async () => extra.answer! }) }, host);
  return { code, stdout, stderr };
}
async function approved(f: Fixture, changes: ChangeSet, runId = "c4-run") {
  const delivery = await prepare(f, changes, runId);
  const ran = await cli(f, ["approve-delivery", delivery.deliveryId], { answer: delivery.manifestSha256 });
  assert.equal(ran.code, 0, ran.stderr);
  return delivery;
}
const deliveryDir = async (f: Fixture, id: string) => {
  const base = await realpath(f.storeBase);
  const [namespace] = await readdir(base);
  return join(base, namespace!, id);
};
async function events(f: Fixture, id: string): Promise<Array<Record<string, any>>> {
  return (await readFile(join(await deliveryDir(f, id), "events.jsonl"), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, any>);
}
const types = async (f: Fixture, id: string) => (await events(f, id)).map(event => event.type as string);
const APPLIED = ["prepared", "approved", "precheckStarted", "precheckPassed", "claimAcquired", "applyStarted", "applied"];
const stagingEntries = async (root: string) => existsSync(join(root, ".git", "fusion-delivery")) ? await readdir(join(root, ".git", "fusion-delivery")) : [];

// ---------------------------------------------------------------- the production path

test("O5.5C4 (1-3, 16-19, 25, 27, 29): an approved delivery applies in its own ordinary checkout through the normal `fusion apply`", { skip }, async () => {
  for (const [name, changes] of [["update", UPDATE], ["create", CREATE], ["delete", DELETE], ["multi", MULTI]] as const) {
    await withRepository(async f => {
      const delivery = await approved(f, changes);
      const before = await snapshot(f.root);
      const base = git(f.root, "rev-parse", "HEAD").trim();
      const connects: string[] = [];
      const originalConnect = Socket.prototype.connect, originalFetch = globalThis.fetch;
      Socket.prototype.connect = function (this: Socket, ...args: unknown[]) { connects.push(JSON.stringify(args[0] ?? null)); return originalConnect.apply(this, args as never); } as typeof originalConnect;
      globalThis.fetch = (async () => { connects.push("fetch"); throw new Error("no network"); }) as typeof fetch;
      let ran: Ran;
      try { ran = await cli(f, ["apply", delivery.deliveryId]); }
      finally { Socket.prototype.connect = originalConnect; globalThis.fetch = originalFetch; }
      assert.equal(ran.code, 0, `${name}: ${ran.stdout}${ran.stderr}`);
      // The pre-mutation plan, before the result: id, full digest, checkout, expected HEAD, operations, approval.
      const plan = ran.stdout.indexOf(`Apply delivery ${delivery.deliveryId}`), result = ran.stdout.indexOf("Result: applied (phase done)");
      assert.ok(plan >= 0 && result > plan, ran.stdout);
      for (const line of [`Manifest SHA-256: ${delivery.manifestSha256}`, `Target checkout: ${await realpath(f.root)}`, `  bound checkout sha256:${checkoutDigest(await realpath(f.root))}`,
        `Expected HEAD: ${base}`, "Precheck first: nothing is written unless every check passes."]) assert.ok(ran.stdout.split("\n").includes(line), line);
      assert.match(ran.stdout, /^Approval: human-confirmed \(typedManifestSha256\) at .+, for this delivery and checkout only$/mu);
      assert.match(ran.stdout, /The approval is spent \(its one mutation claim was taken\)/u);
      // (17) Exact final hashes; (18, 19) canaries unchanged; nothing else changed.
      const after = await snapshot(f.root);
      for (const op of changes.operations) {
        assert.equal(after[op.path], op.kind === "delete" ? undefined : sha256(op.content), `${name}: ${op.path}`);
        delete after[op.path]; delete before[op.path];
      }
      assert.deepEqual(after, before, `${name}: no undeclared path changed`);
      assert.equal(after["CANARY.md"], sha256(CANARY));
      assert.equal(after[".env"], sha256(ENV));
      // (8 events) the O5.5C4 order, metadata only.
      const log = await events(f, delivery.deliveryId);
      assert.deepEqual(log.map(e => e.type), APPLIED);
      assert.deepEqual([log[3]!.observedHead, log.at(-1)!.observedHead, log.at(-1)!.expectedHead], [base, base, base]);
      assert.ok(!JSON.stringify(log).includes(QUOTE_FIXED.slice(0, 40)) && !JSON.stringify(log).includes("c4-sensitive-canary"));
      // The single-use claim binds delivery, manifest, bundle and checkout.
      const claim = JSON.parse(await readFile(join(await deliveryDir(f, delivery.deliveryId), "apply.claim"), "utf8")) as Record<string, string>;
      assert.deepEqual([claim.format, claim.deliveryId, claim.manifestSha256, claim.checkoutSha256],
        ["fusion.deliveryApplyClaim", delivery.deliveryId, delivery.manifestSha256, checkoutDigest(await realpath(f.root))]);
      assert.ok(!existsSync(join(await deliveryDir(f, delivery.deliveryId), "apply.lock")), "the attempt lock is released");
      // (29) The store stays outside the target; (27) no network; (25) no provider.
      assert.ok(!existsSync(join(f.root, ".fusion")));
      assert.deepEqual(connects, []);
      assert.deepEqual(REGISTRY.touched, []);
      assert.deepEqual(await stagingEntries(f.root), []);
    });
  }
});

test("O5.5C4 (4-8): unapproved, a tampered approval, another repository or a same-content clone is refused before any precheck", { skip }, async () =>
  withRepository(async f => {
    // (4) Unapproved.
    const pending = await prepare(f, UPDATE, "c4-pending");
    const before = await snapshot(f.root);
    const unapproved = await cli(f, ["apply", pending.deliveryId]);
    assert.equal(unapproved.code, 14);
    assert.match(unapproved.stdout, /^Result: approvalRequired$/mu);
    assert.deepEqual(await types(f, pending.deliveryId), ["prepared"]);
    // (5, 6) An approval that does not bind this manifest, bundle or checkout approves nothing: corrupt, nothing runs.
    const delivery = await approved(f, UPDATE);
    const approvalPath = join(await deliveryDir(f, delivery.deliveryId), "approval.json"), original = await readFile(approvalPath, "utf8");
    for (const [field, value] of [["manifestSha256", "0".repeat(64)], ["bundleSha256", "0".repeat(64)], ["checkoutSha256", "0".repeat(64)]] as const) {
      await writeFile(approvalPath, canonicalJson({ ...JSON.parse(original), [field]: value }));
      const ran = await cli(f, ["apply", delivery.deliveryId]);
      assert.equal(ran.code, 4, field);
      assert.match(ran.stderr, /corrupt or tampered/u);
    }
    await writeFile(approvalPath, original);
    assert.deepEqual(await types(f, delivery.deliveryId), ["prepared", "approved"]);
    // (7) Another repository: its own namespace, the id is unknown there.
    const other = join(f.dir, "other");
    await makeRepository(other, "another history");
    assert.equal((await cli(f, ["apply", delivery.deliveryId], { cwd: other })).code, 2);
    // (8) A same-content clone at another path is not the bound checkout — even through `--cwd`.
    const clone = join(f.dir, "clone");
    git(f.dir, "clone", "-q", f.root, clone);
    const cloned = await cli(f, ["apply", delivery.deliveryId], { cwd: clone });
    assert.equal(cloned.code, 2);
    assert.match(cloned.stderr, /prepared in another checkout/u);
    assert.equal((await cli(f, ["--cwd", clone, "apply", delivery.deliveryId], { cwd: f.dir })).code, 2);
    // No option can redirect the target.
    for (const flag of ["--repo", "--target", "--force", "--yes"]) assert.equal((await cli(f, ["apply", delivery.deliveryId, flag, clone])).code, 2, flag);
    assert.deepEqual(await snapshot(f.root), before, "nothing was written");
    assert.deepEqual(await types(f, delivery.deliveryId), ["prepared", "approved"], "nothing recorded, the approval unused");
    // The bound checkout still applies.
    assert.equal((await cli(f, ["apply", delivery.deliveryId])).code, 0);
  }));

test("O5.5C4 (9-13, 24): drift of any kind fails the read-only precheck before any write and KEEPS the approval; resolved, the same approval applies", { skip }, async () => {
  const cases: Array<[string, ChangeSet, (root: string) => Promise<void>, (root: string, base: string) => Promise<void>, string[]]> = [
    ["HEAD drift", UPDATE, async root => { await writeFile(join(root, "README.md"), "# moved\n"); git(root, "commit", "-qam", "moved"); },
      async (root, base) => { git(root, "reset", "-q", "--hard", base); }, ["headMoved", "baseTreeMismatch"]],
    ["dirty tree", UPDATE, async root => writeFile(join(root, "notes.txt"), "user notes\n"), async root => unlink(join(root, "notes.txt")), ["dirtyTree"]],
    ["touched-file drift", UPDATE, async root => writeFile(join(root, "src", "quote.ts"), `${QUOTE_BUGGY}// edit\n`),
      async root => writeFile(join(root, "src", "quote.ts"), QUOTE_BUGGY), ["dirtyTree", "fileChanged:src/quote.ts"]],
    ["create collision", CREATE, async root => { await mkdir(join(root, "src", "lib")); await writeFile(join(root, "src", "lib", "discount.ts"), "mine\n"); },
      async root => rm(join(root, "src", "lib"), { recursive: true }), ["dirtyTree", "fileAppeared:src/lib/discount.ts"]],
    ["missing update target", UPDATE, async root => unlink(join(root, "src", "quote.ts")), async root => writeFile(join(root, "src", "quote.ts"), QUOTE_BUGGY),
      ["dirtyTree", "fileMissing:src/quote.ts"]],
    ["missing delete target", DELETE, async root => unlink(join(root, "docs", "old.md")), async root => writeFile(join(root, "docs", "old.md"), OLD_DOC),
      ["dirtyTree", "fileMissing:docs/old.md"]],
  ];
  for (const [name, changes, drift, restore, expected] of cases) {
    await withRepository(async f => {
      const delivery = await approved(f, changes);
      const base = git(f.root, "rev-parse", "HEAD").trim();
      await drift(f.root);
      const before = await snapshot(f.root);
      for (const attempt of [1, 2]) {
        const ran = await cli(f, ["apply", delivery.deliveryId]);
        assert.equal(ran.code, 8, `${name}: ${ran.stdout}${ran.stderr}`);
        assert.match(ran.stdout, /^Result: precheckFailed \(phase precheck\)$/mu, name);
        assert.match(ran.stdout, /Nothing was written and the approval is kept/u);
        if (attempt === 2) assert.match(ran.stdout, /1 earlier precheck\(s\) refused/u, "the plan counts refused prechecks");
        assert.deepEqual(await snapshot(f.root), before, `${name}: nothing was written`);
        assert.deepEqual(await stagingEntries(f.root), []);
      }
      const log = await events(f, delivery.deliveryId);
      assert.deepEqual(log.map(e => e.type), ["prepared", "approved", "precheckStarted", "precheckFailed", "precheckStarted", "precheckFailed"], name);
      // v0.6: `fileChanged` carries a sanitized digest/size detail suffix (covered by test/v06-checkout-stability);
      // compare which issues fired by stripping it.
      assert.deepEqual([...log.at(-1)!.issues].map(i => (i as string).replace(/\(.*\)$/u, "")).sort(), [...expected].sort(), name);
      assert.equal(log.at(-1)!.expectedHead, base);
      assert.ok(!existsSync(join(await deliveryDir(f, delivery.deliveryId), "apply.claim")), `${name}: no claim was taken`);
      assert.match((await cli(f, ["inspect-delivery", delivery.deliveryId])).stdout, /^State: approved$/mu);
      // (24) The drift resolved, the same approval applies.
      await restore(f.root, base);
      const retry = await cli(f, ["apply", delivery.deliveryId]);
      assert.equal(retry.code, 0, `${name}: ${retry.stdout}${retry.stderr}`);
      assert.deepEqual((await types(f, delivery.deliveryId)).slice(-5), ["precheckStarted", "precheckPassed", "claimAcquired", "applyStarted", "applied"]);
    });
  }
});

test("O5.5C4 (14, 26): links, reparse points and repository-controlled execution are refused before any write; no hook, fsmonitor or filter runs", { skip }, async () => {
  // A touched path's parent replaced by a junction (or symbolic link) to a directory outside the repository.
  await withRepository(async f => {
    const delivery = await approved(f, UPDATE);
    const outside = join(f.dir, "outside-src");
    await cp(join(f.root, "src"), outside, { recursive: true });
    await rm(join(f.root, "src"), { recursive: true });
    let linked = true;
    try { await symlink(outside, join(f.root, "src"), process.platform === "win32" ? "junction" : "dir"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") linked = false; else throw error; }
    if (linked) {
      const ran = await cli(f, ["apply", delivery.deliveryId]);
      assert.equal(ran.code, 8, ran.stdout);
      assert.match(ran.stdout, /^Result: precheckFailed/mu);
      assert.equal(await readFile(join(outside, "quote.ts"), "utf8"), QUOTE_BUGGY, "nothing was written through the link");
    }
    assert.equal((await cli(f, ["apply", "../escape"])).code, 2, "a traversal id is refused");
  });
  // Repository-configured hooks, fsmonitor and a filter driver: none runs; the filter driver refuses the delivery.
  await withRepository(async f => {
    const delivery = await approved(f, UPDATE);
    const marker = join(f.dir, "executed.txt");
    const script = join(f.dir, "hook.sh");
    await writeFile(script, `#!/bin/sh\necho ran >> "${marker.split(sep).join("/")}"\n`, { mode: 0o755 });
    const hooks = join(f.dir, "hooks");
    await mkdir(hooks);
    for (const hook of ["post-index-change", "pre-commit", "post-checkout", "reference-transaction"]) await cp(script, join(hooks, hook));
    await writeFile(join(f.root, ".git", "config"), `${await readFile(join(f.root, ".git", "config"), "utf8")}[core]\n\thooksPath = ${hooks.split(sep).join("/")}\n` +
      `\tfsmonitor = ${script.split(sep).join("/")}\n`);
    const ran = await cli(f, ["apply", delivery.deliveryId]);
    assert.equal(ran.code, 0, ran.stdout + ran.stderr);
    assert.ok(!existsSync(marker), "no repository hook or fsmonitor ran");
    // A configured filter driver could run on status: refused before any write, the approval kept.
    const second = await withFilter(f, marker);
    assert.equal(second.code, 8);
    assert.match(second.stdout, /issue: filterDriverConfigured/u);
    assert.ok(!existsSync(marker), "the filter never ran");
  });
});
async function withFilter(f: Fixture, marker: string): Promise<Ran> {
  // A second, fresh delivery on the (now updated) checkout, with a filter driver configured afterwards.
  // The test's own Git calls must not trigger the repository's fsmonitor or hooks either (the harness points hooks elsewhere).
  git(f.root, "-c", "core.fsmonitor=false", "add", "src/quote.ts");
  git(f.root, "-c", "core.fsmonitor=false", "commit", "-qm", "delivered");
  assert.ok(!existsSync(marker), "the test's own Git calls ran nothing");
  const next = changeSet([["docs/old.md", OLD_DOC, null]]);
  const delivery = await approved(f, next, "c4-filter");
  await writeFile(join(f.root, ".git", "config"), `${await readFile(join(f.root, ".git", "config"), "utf8")}[filter "evil"]\n\tclean = sh -c 'echo ran >> "${marker.split(sep).join("/")}"'\n`);
  return cli(f, ["apply", delivery.deliveryId]);
}

test("O5.5C4 (15, 23): concurrent applies take exactly one mutation claim; a spent approval cannot be replayed", { skip }, async () =>
  withRepository(async f => {
    const delivery = await approved(f, MULTI);
    const runs = await Promise.all([1, 2, 3].map(() => cli(f, ["apply", delivery.deliveryId])));
    const codes = runs.map(run => run.code).sort((a, b) => a - b);
    assert.equal(codes.filter(code => code === 0).length, 1, JSON.stringify(runs.map(r => [r.code, r.stderr])));
    assert.ok(codes.every(code => code === 0 || code === 2 || code === 8), JSON.stringify(codes));
    assert.deepEqual(await types(f, delivery.deliveryId), APPLIED, "one claim, one apply, a valid log");
    // (23) Replay after success: refused, nothing changes.
    const before = await snapshot(f.root);
    const replay = await cli(f, ["apply", delivery.deliveryId]);
    assert.equal(replay.code, 2);
    assert.match(replay.stderr, /approval was spent by its one claimed apply/u);
    assert.equal((await cli(f, ["approve-delivery", delivery.deliveryId], { answer: delivery.manifestSha256 })).code, 2, "no second approval");
    assert.deepEqual(await snapshot(f.root), before);
  }));

test("O5.5C4 (20-23): apply and postcheck failures roll back; a failed rollback is distinct; after the claim nothing is replayable", { skip }, async () => {
  await withRepository(async f => {
    const delivery = await approved(f, MULTI);
    const before = await snapshot(f.root);
    const ran = await cli(f, ["apply", delivery.deliveryId], { faults: { afterOperation: index => { if (index === 1) throw new Error("injected"); } } });
    assert.equal(ran.code, 8);
    assert.match(ran.stdout, /^Result: rolledBack \(phase rollback\)$/mu);
    assert.deepEqual(await snapshot(f.root), before, "every preimage restored");
    assert.deepEqual((await types(f, delivery.deliveryId)).slice(-3), ["claimAcquired", "applyStarted", "rolledBack"]);
    assert.deepEqual((await events(f, delivery.deliveryId)).at(-1)!.rollback, { restored: 2, failed: 0 });
    // A successful rollback does not make the claim replayable.
    assert.equal((await cli(f, ["apply", delivery.deliveryId])).code, 2);
  });
  await withRepository(async f => {
    const delivery = await approved(f, UPDATE);
    const ran = await cli(f, ["apply", delivery.deliveryId], { faults: { beforePostcheck: async primary => writeFile(join(primary, "stray.txt"), "x\n") } });
    assert.equal(ran.code, 8);
    const last = (await events(f, delivery.deliveryId)).at(-1)!;
    assert.equal(last.type, "rolledBack");
    assert.ok((last.issues as string[]).includes("undeclaredChange:stray.txt"));
    assert.equal(sha256(await readFile(join(f.root, "src", "quote.ts"))), sha256(QUOTE_BUGGY));
    assert.equal((await cli(f, ["apply", delivery.deliveryId])).code, 2);
  });
  await withRepository(async f => {
    const delivery = await approved(f, MULTI);
    const ran = await cli(f, ["apply", delivery.deliveryId], { faults: {
      afterOperation: index => { if (index === 2) throw new Error("injected"); },
      beforeRestore: index => { if (index === 0) throw new Error("injected restore failure"); } } });
    assert.equal(ran.code, 1);
    assert.match(ran.stdout, /^Result: rollbackFailed \(phase rollback\)$/mu);
    assert.match(ran.stdout, /NOT restored/u);
    const last = (await events(f, delivery.deliveryId)).at(-1)!;
    assert.deepEqual([last.type, last.rollback], ["rollbackFailed", { restored: 2, failed: 1 }]);
    assert.equal((await cli(f, ["apply", delivery.deliveryId])).code, 2);
  });
});

test("O5.5C4 (28): the Fusion checkout is never selected implicitly — a delivery applies only where the working directory resolves", { skip }, async () =>
  withRepository(async f => {
    const delivery = await approved(f, UPDATE);
    const fusion = resolve(".");
    const status = () => git(fusion, "status", "--porcelain=v1", "-uall");
    const head = git(fusion, "rev-parse", "HEAD"), statusBefore = status();
    const ran = await cli(f, ["apply", delivery.deliveryId], { cwd: fusion });
    assert.equal(ran.code, 2, "the id is unknown in the Fusion checkout's own namespace");
    assert.deepEqual([git(fusion, "rev-parse", "HEAD"), status()], [head, statusBefore], "the Fusion checkout is unchanged");
    assert.deepEqual(await types(f, delivery.deliveryId), ["prepared", "approved"]);
  }));

test("O5.5C4 (31) readiness: implementation row only; ordinary-checkout live apply not run; every other flag unchanged", () => {
  const report = writerGateReport();
  const rows = Object.fromEntries(report.rows.map(row => [row.id, [row.state, row.evidenceKind]]));
  assert.deepEqual(rows.productionApplyPolicyImplementation, ["satisfied", "mechanical"]);
  assert.deepEqual([rows.humanApprovedDelivery, rows.disposablePrimaryApplyLive, rows.hostControlledWriterWorkflow, rows.liveGateAuthorization],
    [["partial", "mechanical"], ["satisfied", "recordedLiveProbe"], ["satisfied", "recordedLiveProbe"], ["blocked", "none"]]);
  const policy = report.rows.find(row => row.id === "productionApplyPolicyImplementation")!;
  assert.match(policy.remainingBlocker, /not yet run live on a designated ordinary repository \(REAL_PRIMARY_APPLY_LIVE not run\)/u);
  assert.deepEqual([report.realWriterModeReady, REAL_WRITER_LIVE_GATE_AUTHORIZED], [false, false]);
});
