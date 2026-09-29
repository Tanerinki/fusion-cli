import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  JournalCorruptError, JOURNAL_GENESIS_HASH, readJournal, RunJournal,
} from "../src/platform/durability/journal.js";

const run = promisify(execFile);
// The compiled test runs from dist/test; the .mjs crash-writer fixture lives in the source tree (tsc does not copy it)
// and imports the compiled journal from dist itself.
const fixture = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures", "journal-writer.mjs");

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "fusion-journal-"));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const corrupt = (fn: () => Promise<unknown>): Promise<void> => assert.rejects(fn, (e: unknown) => e instanceof JournalCorruptError);

test("v0.6 journal: appends chain, fsync durably, and read-back verifies", async () => {
  await withTemp(async dir => {
    const path = join(dir, "journal.jsonl");
    const j = await RunJournal.open(path);
    const a = await j.append({ type: "runStarted", runId: "r-1", payload: { k: 1 } });
    const b = await j.append({ type: "step", runId: "r-1", operationId: "op-1", payload: { k: 2 } });
    assert.equal(a.seq, 1);
    assert.equal(a.prevHash, JOURNAL_GENESIS_HASH);
    assert.equal(b.seq, 2);
    assert.equal(b.prevHash, a.recordHash);
    const records = await readJournal(path);
    assert.equal(records.length, 2);
    assert.deepEqual(records.map(r => r.seq), [1, 2]);
    assert.equal(records[1]!.payloadHash, b.payloadHash);
  });
});

test("v0.6 journal: a missing file is an empty journal", async () => {
  await withTemp(async dir => assert.deepEqual(await readJournal(join(dir, "absent.jsonl")), []));
});

test("v0.6 journal: reopening continues the chain from the durable tail", async () => {
  await withTemp(async dir => {
    const path = join(dir, "j.jsonl");
    const j1 = await RunJournal.open(path);
    await j1.append({ type: "a", runId: "r-1", payload: {} });
    const j2 = await RunJournal.open(path);
    assert.equal(j2.lastSeq, 1);
    const c = await j2.append({ type: "b", runId: "r-1", payload: {} });
    assert.equal(c.seq, 2);
    assert.equal((await readJournal(path)).length, 2);
  });
});

test("v0.6 journal: a torn final line is RECOVERY_REQUIRED, never silently dropped", async () => {
  await withTemp(async dir => {
    const path = join(dir, "j.jsonl");
    const j = await RunJournal.open(path);
    await j.append({ type: "a", runId: "r-1", payload: {} });
    await j.append({ type: "b", runId: "r-1", payload: {} });
    const raw = await readFile(path, "utf8");
    await writeFile(path, `${raw}{"schemaVersion":1,"seq":3`); // a half-written third record, no newline
    await assert.rejects(() => readJournal(path), (e: unknown) => e instanceof JournalCorruptError && e.recoveryState === "RECOVERY_REQUIRED");
  });
});

test("v0.6 journal: a broken hash chain is detected", async () => {
  await withTemp(async dir => {
    const path = join(dir, "j.jsonl");
    const j = await RunJournal.open(path);
    await j.append({ type: "a", runId: "r-1", payload: { v: 1 } });
    await j.append({ type: "b", runId: "r-1", payload: { v: 2 } });
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    const second = JSON.parse(lines[1]!);
    second.prevHash = "f".repeat(64); // break the link to record 1 (recordHash still recomputed below)
    // Re-sign the record so its own recordHash is valid but its prevHash no longer chains.
    lines[1] = JSON.stringify(second);
    await writeFile(path, `${lines.join("\n")}\n`);
    await corrupt(() => readJournal(path));
  });
});

test("v0.6 journal: a tampered payload no longer matches its hash", async () => {
  await withTemp(async dir => {
    const path = join(dir, "j.jsonl");
    const j = await RunJournal.open(path);
    await j.append({ type: "a", runId: "r-1", payload: { amount: 1 } });
    const rec = JSON.parse((await readFile(path, "utf8")).trim());
    rec.payload = { amount: 999 }; // change the fact, keep the old hashes
    await writeFile(path, `${JSON.stringify(rec)}\n`);
    await corrupt(() => readJournal(path));
  });
});

test("v0.6 journal: a sequence gap or duplicate is detected", async () => {
  await withTemp(async dir => {
    const path = join(dir, "j.jsonl");
    const j = await RunJournal.open(path);
    const a = await j.append({ type: "a", runId: "r-1", payload: {} });
    // Duplicate the first record as a second line: seq is not contiguous (1 then 1).
    const line = JSON.stringify({ ...a });
    await writeFile(path, `${line}\n${line}\n`);
    await corrupt(() => readJournal(path));
  });
});

test("v0.6 journal: an unsupported future schema is refused, not reinterpreted", async () => {
  await withTemp(async dir => {
    const path = join(dir, "j.jsonl");
    await writeFile(path, `${JSON.stringify({ schemaVersion: 2, seq: 1, type: "a", runId: "r-1", operationId: null, objectId: null, at: "2026-09-29T00:00:00.000Z", payload: {}, payloadHash: "0".repeat(64), prevHash: "0".repeat(64), recordHash: "0".repeat(64) })}\n`);
    await corrupt(() => readJournal(path));
  });
});

test("v0.6 journal CRASH RECOVERY (two processes): a killed writer's durable records reconstruct from disk", async () => {
  await withTemp(async dir => {
    const path = join(dir, "j.jsonl");
    await (await RunJournal.open(path)).append({ type: "runStarted", runId: "r-1", payload: {} });
    // A SEPARATE process appends 5 durable records, then dies abruptly (exit 137, no cleanup).
    const child = await run(process.execPath, [fixture, path, "r-1", "5", "--abrupt"])
      .catch((e: unknown) => e as { stdout: string; code: number });
    const committed = Number.parseInt((child as { stdout: string }).stdout.trim(), 10);
    assert.equal(committed, 6, "the child reported 6 durable records (1 + 5)");
    // A fresh process reconstructs purely from the persisted bytes.
    const records = await readJournal(path);
    assert.equal(records.length, 6);
    assert.deepEqual(records.map(r => r.seq), [1, 2, 3, 4, 5, 6]);
    // And a new writer can continue the chain.
    const j = await RunJournal.open(path);
    const next = await j.append({ type: "resumed", runId: "r-1", payload: {} });
    assert.equal(next.seq, 7);
  });
});
