import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";
import { prepareStoredDelivery } from "../src/app/delivery-service.js";
import { runCli } from "../src/cli/run.js";
import type { ChangeSet } from "../src/core/domain.js";
import type { WorkflowResult } from "../src/core/workflow/types.js";
import { defaultDeliveryStoreBase } from "../src/platform/delivery/state-root.js";
import { ProcessGitClient } from "../src/platform/workspace/git.js";
import { createHash } from "node:crypto";
import { changeSet } from "./fixtures/fake-writer.js";
import { git, gitAvailable } from "./fixtures/writer-rehearsal-harness.js";
const sha256 = (v: string | Buffer): string => createHash("sha256").update(v).digest("hex");

/**
 * v0.6 I1 — the REAL `fusion apply` recovers an INTERRUPTED apply (process death mid-write), driven through the normal
 * CLI on an ordinary temporary Git repository. The crash is a genuine SEPARATE process that exits 137 after the first
 * file; a fresh process then recovers. Not an in-process exception (which would roll back, not interrupt).
 */
const skip = gitAvailable ? false : "git executable unavailable";
const child = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures", "apply-crash-child.mjs");
const run = promisify(execFile);
const REGISTRY = { factories: new Map(), defaults: { schemaVersion: 1, bindings: [], verification: { commands: [] }, limits: { runTimeoutMs: 60_000 } } };

function acceptedResult(changes: ChangeSet): WorkflowResult {
  return { state: "completed", transitions: [], delegateAttempts: 1, reviews: [], changeSet: changes,
    applied: changes.operations.map(op => op.kind === "delete"
      ? { kind: op.kind, path: op.path, beforeSha256: op.expectedSha256, afterSha256: null, bytes: 0 }
      : { kind: op.kind, path: op.path, beforeSha256: op.expectedSha256, afterSha256: sha256(op.content), bytes: Buffer.byteLength(op.content) }),
    verification: { passed: true, commandsRun: 1, evidence: { backendId: "docker-linux", confinement: "osSandbox", platformRequirement: "linux-compatible",
      acceptance: "granted", commands: [{ id: "unit", status: "passed", exitCode: 0 }] } } } as unknown as WorkflowResult;
}

interface Bed { dir: string; root: string; env: NodeJS.ProcessEnv; storeBase: string }
async function withBed<T>(fn: (b: Bed) => Promise<T>): Promise<T> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "fusion-i1-")));
  try {
    const root = join(dir, "project");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "a.txt"), "A"); await writeFile(join(root, "b.txt"), "C");
    git(root, "init", "-q"); git(root, "add", "."); git(root, "commit", "-qm", "seed");
    const env = { ...process.env, LOCALAPPDATA: join(dir, "localappdata"), XDG_STATE_HOME: join(dir, "xdg-state") };
    return await fn({ dir, root, env, storeBase: defaultDeliveryStoreBase(env) });
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}
async function cliApply(b: Bed, id: string): Promise<{ code: number; stdout: string }> {
  let stdout = "";
  const host = { env: b.env, cwd: b.root, registry: REGISTRY as never };
  const code = await runCli(["apply", id], { stdout: t => { stdout += t; }, stderr: () => {}, interactive: false }, host);
  return { code, stdout };
}
async function approve(b: Bed, id: string, digest: string): Promise<void> {
  const host = { env: b.env, cwd: b.root, registry: REGISTRY as never };
  const code = await runCli(["approve-delivery", id], { stdout: () => {}, stderr: () => {}, interactive: true, prompt: async () => digest }, host);
  assert.equal(code, 0);
}
async function prepared(b: Bed, changes: ChangeSet): Promise<{ id: string; digest: string }> {
  const d = await prepareStoredDelivery({ runId: "i1-run", taskSha256: "a".repeat(64), workflowEvidenceSha256: "b".repeat(64), result: acceptedResult(changes),
    scope: { allowedPaths: changes.operations.map(op => op.path), forbiddenPaths: [] }, baseCommit: git(b.root, "rev-parse", "HEAD").trim(), primaryRoot: b.root,
    git: await ProcessGitClient.fromPath(process.env, true), storeBase: b.storeBase });
  return { id: d.deliveryId, digest: d.manifestSha256 };
}
const read = (b: Bed, f: string): Promise<string> => readFile(join(b.root, f), "utf8");
async function deliveryEvents(b: Bed, id: string): Promise<string[]> {
  const base = await realpath(b.storeBase);
  const [ns] = await readdir(base);
  const text = await readFile(join(base, ns!, id, "events.jsonl"), "utf8");
  return text.split("\n").filter(Boolean).map(l => (JSON.parse(l) as { type: string }).type);
}
const MULTI = changeSet([["a.txt", "A", "B"], ["b.txt", "C", "D"]]);

test("v0.6 I1: a process death mid-apply leaves the delivery `applying`; a fresh `fusion apply` recovers it exactly once", { skip }, async () => {
  await withBed(async b => {
    const { id, digest } = await prepared(b, MULTI);
    await approve(b, id, digest);
    // Process 1: real `fusion apply` that dies after the first file.
    const crashed = await run(process.execPath, [child, b.root, b.env.LOCALAPPDATA!, b.env.XDG_STATE_HOME!, id]).catch((e: unknown) => e as { stdout: string });
    assert.match((crashed as { stdout: string }).stdout, /CRASH_AFTER_0/u);
    // Exactly one file is applied; the delivery is durably interrupted.
    const applied = [await read(b, "a.txt"), await read(b, "b.txt")];
    assert.equal(applied.filter(v => v === "B" || v === "D").length, 1, "one file applied, one not");
    const t1 = await deliveryEvents(b, id);
    assert.ok(t1.includes("applyStarted") && !t1.includes("applied"), `interrupted: ${t1.join(",")}`);
    // Process 2: recovery through the normal CLI.
    const rec = await cliApply(b, id);
    assert.equal(rec.code, 0, rec.stdout);
    assert.match(rec.stdout, /^Result: applied\b/mu);
    assert.equal(await read(b, "a.txt"), "B");
    assert.equal(await read(b, "b.txt"), "D");
    const t2 = await deliveryEvents(b, id);
    assert.equal(t2.filter(x => x === "applied").length, 1, "committed exactly once");
    // Idempotent: a further apply of the now-consumed delivery does not mutate again.
    const again = await cliApply(b, id);
    assert.notEqual(again.code, 0);
    assert.equal(await read(b, "a.txt"), "B");
  });
});

test("v0.6 I1: a foreign edit during interruption is detected and never overwritten", { skip }, async () => {
  await withBed(async b => {
    const { id, digest } = await prepared(b, MULTI);
    await approve(b, id, digest);
    const crashed = await run(process.execPath, [child, b.root, b.env.LOCALAPPDATA!, b.env.XDG_STATE_HOME!, id]).catch((e: unknown) => e as { stdout: string });
    assert.match((crashed as { stdout: string }).stdout, /CRASH_AFTER_0/u);
    // A human edits the not-yet-applied file to something unexpected.
    const untouched = (await read(b, "a.txt")) === "A" ? "a.txt" : "b.txt";
    await writeFile(join(b.root, untouched), "HUMAN-EDIT");
    const rec = await cliApply(b, id);
    assert.notEqual(rec.code, 0, "recovery does not report success on a foreign modification");
    assert.match(rec.stdout, /foreignModification/u);
    assert.equal(await read(b, untouched), "HUMAN-EDIT", "the foreign content is never overwritten");
    assert.ok(!existsSync(join(b.root, ".git", "MERGE_HEAD")));
  });
});
