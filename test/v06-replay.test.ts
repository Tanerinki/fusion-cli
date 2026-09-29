import assert from "node:assert/strict";
import { test } from "node:test";
import { reconstruct, replay, type ReplayFact, type Reducer } from "../src/core/durability/replay.js";
import { classifyInterrupted, type InterruptedOperation } from "../src/core/durability/recovery.js";
import { isAutoResumable } from "../src/core/durability/states.js";

interface State { readonly seen: readonly number[] }
const reducer: Reducer<State> = (s, f) => ({ seen: [...s.seen, (f.payload as { n: number }).n] });
const facts = (ns: readonly number[]): ReplayFact[] => ns.map((n, i) => ({ seq: i + 1, type: "step", payload: { n } }));

test("v0.6 replay: the same facts reconstruct the same state (deterministic)", () => {
  const a = replay(facts([10, 20, 30]), reducer, { seen: [] });
  const b = replay(facts([10, 20, 30]), reducer, { seen: [] });
  assert.deepEqual(a, b);
  assert.deepEqual(a.seen, [10, 20, 30]);
});

test("v0.6 replay: a checkpoint plus tail reconstructs identically to a full replay", () => {
  const all = facts([1, 2, 3, 4, 5]);
  const full = replay(all, reducer, { seen: [] });
  // A checkpoint taken after seq 3, then only the tail (4,5) replayed onto it.
  const at3 = replay(all.slice(0, 3), reducer, { seen: [] });
  const resumed = reconstruct({ journalSeq: 3, state: at3 }, all, reducer, { seen: [] });
  assert.deepEqual(resumed, full);
  // No checkpoint = full replay.
  assert.deepEqual(reconstruct(null, all, reducer, { seen: [] }), full);
});

test("v0.6 replay: a non-contiguous fact stream is a hard error, never a silent skip", () => {
  const broken: ReplayFact[] = [{ seq: 1, type: "s", payload: { n: 1 } }, { seq: 3, type: "s", payload: { n: 3 } }];
  assert.throws(() => replay(broken, reducer, { seen: [] }));
});

// ---------------------------------------------------------------- recovery classification

const op = (over: Partial<InterruptedOperation>): InterruptedOperation => ({
  effect: "sideEffecting", durableCompletionRecord: false, hasIdempotencyKey: false, evidenceStale: false,
  foreignModification: false, corruptionOrViolation: false, ...over,
});

test("v0.6 recovery: corruption or a security violation is BLOCKED and never auto-resumes", () => {
  const c = classifyInterrupted(op({ corruptionOrViolation: true, durableCompletionRecord: true, hasIdempotencyKey: true }));
  assert.equal(c, "BLOCKED");
  assert.equal(isAutoResumable(c), false);
});

test("v0.6 recovery: a foreign modification requires a human", () => {
  assert.equal(classifyInterrupted(op({ foreignModification: true, hasIdempotencyKey: true })), "REQUIRES_HUMAN");
});

test("v0.6 recovery: a completed read-only op replays; a completed side-effect with a key resumes; without a key it needs a human", () => {
  assert.equal(classifyInterrupted(op({ effect: "readOnly", durableCompletionRecord: true })), "SAFE_TO_REPLAY");
  assert.equal(classifyInterrupted(op({ durableCompletionRecord: true, hasIdempotencyKey: true })), "SAFE_TO_RESUME");
  assert.equal(classifyInterrupted(op({ durableCompletionRecord: true, hasIdempotencyKey: false })), "REQUIRES_HUMAN");
});

test("v0.6 recovery: stale evidence requires revalidation before continuing", () => {
  assert.equal(classifyInterrupted(op({ evidenceStale: true, effect: "sideEffecting" })), "REQUIRES_REVALIDATION");
});

test("v0.6 recovery: a read-only op is safe to replay; a side-effecting op with a key resumes; an ambiguous one needs a human", () => {
  assert.equal(classifyInterrupted(op({ effect: "readOnly" })), "SAFE_TO_REPLAY");
  assert.equal(classifyInterrupted(op({ effect: "sideEffecting", hasIdempotencyKey: true })), "SAFE_TO_RESUME");
  const ambiguous = classifyInterrupted(op({ effect: "sideEffecting", hasIdempotencyKey: false }));
  assert.equal(ambiguous, "REQUIRES_HUMAN");
  assert.equal(isAutoResumable(ambiguous), false);
});
