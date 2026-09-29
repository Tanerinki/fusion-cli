import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareStoredDelivery } from "../src/app/delivery-service.js";
import { runCli } from "../src/cli/run.js";
import type { ChangeSet } from "../src/core/domain.js";
import type { WorkflowResult } from "../src/core/workflow/types.js";
import { defaultDeliveryStoreBase } from "../src/platform/delivery/state-root.js";
import { RunLease } from "../src/platform/durability/lease.js";
import { ProcessGitClient } from "../src/platform/workspace/git.js";
import { changeSet } from "./fixtures/fake-writer.js";
import { git, gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * v0.6 I2 — the REAL `fusion apply` is guarded by the single-writer run lease: a LIVE concurrent owner (a fresh lease
 * with a live PID) refuses a second apply with RUN_ALREADY_CLAIMED; releasing it lets the apply proceed. (Dead-owner
 * takeover is exercised end-to-end by the I1 two-process crash test, which now runs through this lease.)
 */
const skip = gitAvailable ? false : "git executable unavailable";
const sha256 = (v: string | Buffer): string => createHash("sha256").update(v).digest("hex");
const REGISTRY = { factories: new Map(), defaults: { schemaVersion: 1, bindings: [], verification: { commands: [] }, limits: { runTimeoutMs: 60_000 } } };

function acceptedResult(changes: ChangeSet): WorkflowResult {
  return { state: "completed", transitions: [], delegateAttempts: 1, reviews: [], changeSet: changes,
    applied: changes.operations.map(op => op.kind === "delete" ? { kind: op.kind, path: op.path, beforeSha256: op.expectedSha256, afterSha256: null, bytes: 0 }
      : { kind: op.kind, path: op.path, beforeSha256: op.expectedSha256, afterSha256: sha256(op.content), bytes: Buffer.byteLength(op.content) }),
    verification: { passed: true, commandsRun: 1, evidence: { backendId: "docker-linux", confinement: "osSandbox", platformRequirement: "linux-compatible",
      acceptance: "granted", commands: [{ id: "unit", status: "passed", exitCode: 0 }] } } } as unknown as WorkflowResult;
}
interface Bed { dir: string; root: string; env: NodeJS.ProcessEnv; storeBase: string }
async function withBed<T>(fn: (b: Bed) => Promise<T>): Promise<T> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "fusion-i2-")));
  try {
    const root = join(dir, "project");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "a.txt"), "A");
    git(root, "init", "-q"); git(root, "add", "."); git(root, "commit", "-qm", "seed");
    const env = { ...process.env, LOCALAPPDATA: join(dir, "localappdata"), XDG_STATE_HOME: join(dir, "xdg-state") };
    return await fn({ dir, root, env, storeBase: defaultDeliveryStoreBase(env) });
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}
async function cli(b: Bed, argv: string[], answer?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "", stderr = "";
  const host = { env: b.env, cwd: b.root, registry: REGISTRY as never };
  const code = await runCli(argv, { stdout: t => { stdout += t; }, stderr: t => { stderr += t; }, interactive: answer !== undefined,
    ...(answer === undefined ? {} : { prompt: async () => answer }) }, host);
  return { code, stdout, stderr };
}
async function leasePath(b: Bed, id: string): Promise<string> {
  const base = await realpath(b.storeBase);
  const [ns] = await readdir(base);
  return join(base, ns!, id, "run.lease");
}
const MULTI = changeSet([["a.txt", "A", "B"]]);

test("v0.6 I2: a live run-lease owner refuses a concurrent `fusion apply` (RUN_ALREADY_CLAIMED); releasing it lets apply proceed", { skip }, async () => {
  await withBed(async b => {
    const d = await prepareStoredDelivery({ runId: "i2-run", taskSha256: "a".repeat(64), workflowEvidenceSha256: "b".repeat(64), result: acceptedResult(MULTI),
      scope: { allowedPaths: ["a.txt"], forbiddenPaths: [] }, baseCommit: git(b.root, "rev-parse", "HEAD").trim(), primaryRoot: b.root,
      git: await ProcessGitClient.fromPath(process.env, true), storeBase: b.storeBase });
    assert.equal((await cli(b, ["approve-delivery", d.deliveryId], d.manifestSha256)).code, 0);
    // A live owner holds the run lease (fresh heartbeat, this process's PID is alive).
    const held = await RunLease.acquire(await leasePath(b, d.deliveryId));
    const blocked = await cli(b, ["apply", d.deliveryId]);
    assert.equal(blocked.code, 8, blocked.stdout + blocked.stderr);
    assert.match(blocked.stderr, /already claimed/u);
    assert.equal(await readFile(join(b.root, "a.txt"), "utf8"), "A", "the blocked apply wrote nothing");
    // The owner finishes and releases; the apply now proceeds.
    await held.release();
    const applied = await cli(b, ["apply", d.deliveryId]);
    assert.equal(applied.code, 0, applied.stdout + applied.stderr);
    assert.equal(await readFile(join(b.root, "a.txt"), "utf8"), "B");
  });
});
