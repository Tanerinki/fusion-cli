import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildCheckpoint, CheckpointInvalidError, readNewestCheckpoint, reconcileCheckpoint, validateCheckpoint, writeCheckpoint,
} from "../src/platform/durability/checkpoint.js";
import { reconstruct, replay, type Reducer, type ReplayFact } from "../src/core/durability/replay.js";
import { RunJournal, readJournal } from "../src/platform/durability/journal.js";

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "fusion-cp-"));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("v0.6 checkpoint: build, hash-bind, validate round-trip; a tampered field is rejected", () => {
  const cp = buildCheckpoint({ runId: "r-1", journalSeq: 3, journalHeadHash: "a".repeat(64), stateSchemaVersion: 1, state: { x: 1 }, at: "2026-09-29T00:00:00.000Z" });
  assert.deepEqual(validateCheckpoint(JSON.parse(JSON.stringify(cp))), cp);
  const tampered = { ...JSON.parse(JSON.stringify(cp)), journalSeq: 4 };
  assert.throws(() => validateCheckpoint(tampered), (e: unknown) => e instanceof CheckpointInvalidError);
});

test("v0.6 checkpoint: crash-safe write and read-newest returns the highest valid checkpoint", async () => {
  await withTemp(async dir => {
    await writeCheckpoint(dir, buildCheckpoint({ runId: "r-1", journalSeq: 1, journalHeadHash: "a".repeat(64), stateSchemaVersion: 1, state: { n: 1 } }));
    await writeCheckpoint(dir, buildCheckpoint({ runId: "r-1", journalSeq: 5, journalHeadHash: "b".repeat(64), stateSchemaVersion: 1, state: { n: 5 } }));
    const newest = await readNewestCheckpoint(dir);
    assert.equal(newest!.journalSeq, 5);
  });
});

test("v0.6 checkpoint: a partially-written (invalid) newest file is skipped for an older valid one", async () => {
  await withTemp(async dir => {
    await writeCheckpoint(dir, buildCheckpoint({ runId: "r-1", journalSeq: 2, journalHeadHash: "a".repeat(64), stateSchemaVersion: 1, state: { n: 2 } }));
    await writeFile(join(dir, "checkpoint-9.json"), "{ this is not valid json"); // a torn newer checkpoint
    const newest = await readNewestCheckpoint(dir);
    assert.equal(newest!.journalSeq, 2, "the valid older checkpoint is used; the torn one never blocks recovery");
  });
});

test("v0.6 checkpoint: reconcile accepts a checkpoint that binds the journal and rejects a mismatch", async () => {
  await withTemp(async dir => {
    const path = join(dir, "j.jsonl");
    const j = await RunJournal.open(path);
    await j.append({ type: "a", runId: "r-1", payload: { n: 1 } });
    const r2 = await j.append({ type: "b", runId: "r-1", payload: { n: 2 } });
    const records = await readJournal(path);
    const good = buildCheckpoint({ runId: "r-1", journalSeq: 2, journalHeadHash: r2.recordHash, stateSchemaVersion: 1, state: { sum: 3 } });
    assert.deepEqual(reconcileCheckpoint(good, records), { journalSeq: 2, state: { sum: 3 } });
    const wrong = buildCheckpoint({ runId: "r-1", journalSeq: 2, journalHeadHash: "f".repeat(64), stateSchemaVersion: 1, state: { sum: 3 } });
    assert.throws(() => reconcileCheckpoint(wrong, records), (e: unknown) => e instanceof CheckpointInvalidError && e.recoveryState === "CHECKPOINT_INVALID");
    const ahead = buildCheckpoint({ runId: "r-1", journalSeq: 9, journalHeadHash: r2.recordHash, stateSchemaVersion: 1, state: {} });
    assert.throws(() => reconcileCheckpoint(ahead, records), (e: unknown) => e instanceof CheckpointInvalidError);
  });
});

test("v0.6 checkpoint: end-to-end — journal + checkpoint reconstruct equals a full replay", async () => {
  await withTemp(async dir => {
    const path = join(dir, "j.jsonl");
    const j = await RunJournal.open(path);
    const reducer: Reducer<{ seen: number[] }> = (s, f) => ({ seen: [...s.seen, (f.payload as { n: number }).n] });
    for (const n of [1, 2, 3, 4, 5]) await j.append({ type: "step", runId: "r-1", payload: { n } });
    const records = await readJournal(path);
    const asReplayFacts: ReplayFact[] = records.map(r => ({ seq: r.seq, type: r.type, payload: r.payload }));
    const full = replay(asReplayFacts, reducer, { seen: [] });
    // Take a checkpoint after seq 3 and persist it.
    const at3 = replay(asReplayFacts.slice(0, 3), reducer, { seen: [] });
    const head3 = records[2]!.recordHash;
    await writeCheckpoint(dir, buildCheckpoint({ runId: "r-1", journalSeq: 3, journalHeadHash: head3, stateSchemaVersion: 1, state: at3 }));
    // A fresh reconstruction: newest checkpoint + reconcile + replay tail.
    const cp = await readNewestCheckpoint(dir);
    const snapshot = reconcileCheckpoint(cp as never, records) as { journalSeq: number; state: { seen: number[] } };
    const resumed = reconstruct(snapshot, asReplayFacts, reducer, { seen: [] });
    assert.deepEqual(resumed, full);
    assert.deepEqual(resumed.seen, [1, 2, 3, 4, 5]);
  });
});
