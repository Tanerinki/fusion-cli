import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";
import { DurableRun, reconstructRun } from "../src/app/durable-run.js";
import { RunAlreadyClaimedError } from "../src/platform/durability/lease.js";

const run = promisify(execFile);
const child = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures", "durable-run-child.mjs");
async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "fusion-i3-"));
  try { return await fn(root); } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}

test("v0.6 I3: a durable run reconstructs its completed milestones; a completed run is COMPLETED", async () => {
  await withRoot(async root => {
    const r = await DurableRun.begin(root, "r-alpha", { workflowId: "build" });
    await r.milestone("routeDecided", { route: "single", candidates: 1 });
    await r.end({ delivered: false });
    const rec = await reconstructRun(root, "r-alpha");
    assert.equal(rec!.state, "COMPLETED");
    assert.deepEqual(rec!.milestones.map(m => m.type), ["runStarted", "routeDecided", "runCompleted"]);
  });
});

test("v0.6 I3: a second live writer of the SAME run is refused RUN_ALREADY_CLAIMED", async () => {
  await withRoot(async root => {
    const first = await DurableRun.begin(root, "r-beta");
    await assert.rejects(() => DurableRun.begin(root, "r-beta"), (e: unknown) => e instanceof RunAlreadyClaimedError);
    await first.end();
    // Once the owner ends (lease released), the run can be re-opened.
    const second = await DurableRun.begin(root, "r-beta");
    await second.end();
  });
});

test("v0.6 I3 CRASH (two processes): a killed run reconstructs as INTERRUPTED with its completed milestones; a fresh process can re-own it", async () => {
  await withRoot(async root => {
    const out = await run(process.execPath, [child, root, "r-gamma"]).catch((e: unknown) => e as { stdout: string });
    assert.match((out as { stdout: string }).stdout, /STARTED:r-gamma/u);
    // A fresh process reconstructs purely from the persisted journal.
    const rec = await reconstructRun(root, "r-gamma");
    assert.equal(rec!.state, "INTERRUPTED", "the killed run did not forget what completed, and is not falsely COMPLETED");
    assert.deepEqual(rec!.milestones.map(m => m.type), ["runStarted", "routeDecided", "tournamentStarted", "candidateCompleted"]);
    // The dead owner's lease is stale (its PID is gone), so a fresh process can re-own the run to recover it.
    const reowned = await DurableRun.begin(root, "r-gamma");
    await reowned.milestone("runCompleted", {});
    await reowned.end();
  });
});

test("v0.6 I3: reconstructing a run that never began durably is null", async () => {
  await withRoot(async root => assert.equal(await reconstructRun(root, "r-absent"), null));
});
