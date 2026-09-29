import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";
import { readJournal, RunJournal } from "../src/platform/durability/journal.js";
import { DurableApplyTransaction, type ApplyFaults, type ApplyFileOp } from "../src/platform/durability/apply-transaction.js";

const run = promisify(execFile);
const fixture = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures", "apply-tx-writer.mjs");
const sha = (s: string): string => createHash("sha256").update(Buffer.from(s)).digest("hex");

interface Bed { dir: string; target: string; vault: string; journalPath: string; ops: ApplyFileOp[] }
async function bed(): Promise<Bed> {
  const dir = await mkdtemp(join(tmpdir(), "fusion-applytx-"));
  const target = join(dir, "repo"); const vault = join(dir, "vault");
  await mkdir(target, { recursive: true }); await mkdir(vault, { recursive: true });
  await writeFile(join(target, "a.txt"), "A"); await writeFile(join(target, "b.txt"), "C");
  return { dir, target, vault, journalPath: join(dir, "journal.jsonl"),
    ops: [{ path: "a.txt", beforeSha256: sha("A"), afterSha256: sha("B"), afterBytes: 1 },
          { path: "b.txt", beforeSha256: sha("C"), afterSha256: sha("D"), afterBytes: 1 }] };
}
const content = (i: number): Buffer => Buffer.from(i === 0 ? "B" : "D");
async function openTx(b: Bed, faults: ApplyFaults = {}): Promise<DurableApplyTransaction> {
  return DurableApplyTransaction.open({ txId: "tx-1", runId: "r-1", target: b.target, vaultRoot: b.vault, ops: b.ops, journal: await RunJournal.open(b.journalPath), faults });
}
const read = (b: Bed, f: string): Promise<string> => readFile(join(b.target, f), "utf8");
class Crash extends Error {}
const crash = (): never => { throw new Crash(); };

test("v0.6 apply §63A: a crash before PREPARED leaves the target unchanged", async () => {
  const b = await bed();
  try {
    const tx = await openTx(b);
    await assert.rejects(() => tx.prepare(() => crash())); // die during preparation, before the PREPARED event
    // Nothing applied: files are still their before-images.
    assert.equal(await read(b, "a.txt"), "A");
    assert.equal(await read(b, "b.txt"), "C");
    const rec = await (await openTx(b)).recover(await readJournal(b.journalPath));
    assert.ok(rec.plan === "NOTHING_TO_DO" || rec.plan === "RESUME_APPLY");
  } finally { await rm(b.dir, { recursive: true, force: true }); }
});

test("v0.6 apply §63C: a crash after the first of two files is a detected partial; resume completes it exactly", async () => {
  const b = await bed();
  try {
    const tx = await openTx(b, { afterFileApplied: (i) => { if (i === 0) crash(); } });
    await tx.prepare(content);
    await tx.claim();
    await assert.rejects(() => tx.apply(), (e: unknown) => e instanceof Crash);
    assert.equal(await read(b, "a.txt"), "B"); // first file applied
    assert.equal(await read(b, "b.txt"), "C"); // second not yet
    const recovery = await openTx(b);
    const plan = await recovery.recover(await readJournal(b.journalPath));
    assert.equal(plan.plan, "RESUME_APPLY");
    assert.deepEqual(plan.files.map(f => f.actual), ["after", "before"]);
    await recovery.apply();
    await recovery.verifyAndCommit();
    assert.equal(await read(b, "a.txt"), "B");
    assert.equal(await read(b, "b.txt"), "D");
    assert.equal(recovery.stateFrom(await readJournal(b.journalPath)), "COMMITTED");
  } finally { await rm(b.dir, { recursive: true, force: true }); }
});

test("v0.6 apply §63E: a crash after all files but before COMMITTED resumes to commit without duplicate writes", async () => {
  const b = await bed();
  try {
    const tx = await openTx(b, { afterVerifying: crash });
    await tx.prepare(content); await tx.claim(); await tx.apply();
    await assert.rejects(() => tx.verifyAndCommit(), (e: unknown) => e instanceof Crash);
    assert.equal(await read(b, "a.txt"), "B"); assert.equal(await read(b, "b.txt"), "D");
    const recovery = await openTx(b);
    const plan = await recovery.recover(await readJournal(b.journalPath));
    assert.equal(plan.plan, "RESUME_APPLY");
    assert.deepEqual(plan.files.map(f => f.actual), ["after", "after"]);
    await recovery.verifyAndCommit(); // no apply() needed; no duplicate writes
    assert.equal(recovery.stateFrom(await readJournal(b.journalPath)), "COMMITTED");
  } finally { await rm(b.dir, { recursive: true, force: true }); }
});

test("v0.6 apply §63F/G: after COMMITTED, recovery is COMMITTED and a re-apply does not mutate again", async () => {
  const b = await bed();
  try {
    const tx = await openTx(b);
    await tx.prepare(content); await tx.claim(); await tx.apply(); await tx.verifyAndCommit();
    const recovery = await openTx(b);
    const plan = await recovery.recover(await readJournal(b.journalPath));
    assert.equal(plan.plan, "COMMITTED");
    // A second full attempt cannot re-mutate: the before-images no longer match (files are already after).
    await assert.rejects(async () => (await openTx(b)).prepare(content), (e: unknown) => e instanceof Error);
    assert.equal(await read(b, "a.txt"), "B"); assert.equal(await read(b, "b.txt"), "D");
  } finally { await rm(b.dir, { recursive: true, force: true }); }
});

test("v0.6 apply §63H: a foreign edit during interruption is detected and never overwritten", async () => {
  const b = await bed();
  try {
    const tx = await openTx(b, { afterFileApplied: (i) => { if (i === 0) crash(); } });
    await tx.prepare(content); await tx.claim();
    await assert.rejects(() => tx.apply(), (e: unknown) => e instanceof Crash);
    // A human/tool edits the not-yet-applied second file to something unexpected.
    await writeFile(join(b.target, "b.txt"), "HUMAN-EDIT");
    const recovery = await openTx(b);
    const plan = await recovery.recover(await readJournal(b.journalPath));
    assert.equal(plan.plan, "FOREIGN_MODIFICATION");
    assert.equal(await read(b, "b.txt"), "HUMAN-EDIT", "the foreign content is never overwritten by recovery");
  } finally { await rm(b.dir, { recursive: true, force: true }); }
});

test("v0.6 apply CRASH RECOVERY (two processes): a killed apply is recovered and completed exactly once", async () => {
  const b = await bed();
  try {
    const child = await run(process.execPath, [fixture, b.target, b.vault, b.journalPath])
      .catch((e: unknown) => e as { stdout: string });
    assert.match((child as { stdout: string }).stdout, /crash-after-file-0/u);
    // Process 1 died after the first file. Files: a=B (applied), b=C (not yet).
    assert.equal(await read(b, "a.txt"), "B");
    assert.equal(await read(b, "b.txt"), "C");
    // Process 2 reconstructs from disk and completes the transaction exactly.
    const recovery = await openTx(b);
    const plan = await recovery.recover(await readJournal(b.journalPath));
    assert.equal(plan.plan, "RESUME_APPLY");
    await recovery.apply();
    await recovery.verifyAndCommit();
    assert.equal(await read(b, "a.txt"), "B");
    assert.equal(await read(b, "b.txt"), "D");
    assert.equal(recovery.stateFrom(await readJournal(b.journalPath)), "COMMITTED");
  } finally { await rm(b.dir, { recursive: true, force: true }); }
});
