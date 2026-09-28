import assert from "node:assert/strict";
import { test } from "node:test";
import { runBounded, type BatchItem } from "../src/app/orchestration/scheduler.js";
import { FusionFailure } from "../src/core/errors.js";

/**
 * v0.4 — FATAL-FAILURE PRECEDENCE of the bounded scheduler (runInvestigationBatch, the claim check's hypotheses). The full suite
 * exposed a race: an investigation raised the SecurityViolation, stopping the route closed the conversation, a sibling then
 * failed with Cancelled — and whichever the batch observed first was reported. Under load the Cancelled (a consequence) hid
 * the SecurityViolation (the cause).
 *
 * Every race here is FORCED by event-loop order (deferreds and `setImmediate`), never by wall-clock timing.
 */
const failure = (kind: "SecurityViolation" | "Cancelled" | "InternalError", safeMessage: string = kind) => new FusionFailure({ kind, safeMessage, retryable: false });
const kindOf = (e: unknown): string | undefined => e instanceof FusionFailure ? e.error.kind : undefined;
/** The investigation route's own rule (`fatalFailure`): a security violation, a cancellation or an internal error stop the batch. */
const fatal = (e: unknown): boolean => ["SecurityViolation", "Cancelled", "InternalError"].includes(kindOf(e) ?? "");
const untilAborted = (signal: AbortSignal) => new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
/** Resolves after every pending microtask (every settled item's handling in the batch) has run. */
const afterMicrotasks = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>(r => { resolve = r; }), resolve };
}
async function rejection(run: Promise<unknown>): Promise<unknown> {
  try { await run; } catch (error) { return error; }
  assert.fail("the batch must reject");
}

test("A: a SecurityViolation first, a sibling's Cancelled later — the SecurityViolation surfaces; every item settled and cleaned up", async () => {
  const cleaned: string[] = [];
  const items: BatchItem<string>[] = [
    { id: "writer", run: async () => { try { throw failure("SecurityViolation", "view changed"); } finally { cleaned.push("writer"); } } },
    { id: "sibling", run: async signal => { try { await untilAborted(signal); throw failure("Cancelled"); } finally { cleaned.push("sibling"); } } }];
  const error = await rejection(runBounded(items, { concurrency: 2, timeoutMs: 60_000, fatal }));
  assert.equal(kindOf(error), "SecurityViolation");
  assert.deepEqual(cleaned.sort(), ["sibling", "writer"]);
});

test("B: the sibling's Cancelled is OBSERVED FIRST but caused by the concurrent SecurityViolation — the SecurityViolation surfaces", async () => {
  // The live shape: the writing investigation detects its changed view, closes the conversation (which cancels the sibling),
  // and rejects only after its own cleanup. The sibling's cancellation reaches the batch first.
  const conversationClosed = deferred();
  const order: string[] = [];
  const items: BatchItem<string>[] = [
    { id: "writer", run: async () => {
      conversationClosed.resolve();              // `void this.close()`: the sibling is cancelled…
      await afterMicrotasks(); await afterMicrotasks(); // …and fully handled by the batch before this rejects (its cleanup)
      order.push("writer rejects");
      throw failure("SecurityViolation", "The provider changed its read-only view of the repository; the conversation was stopped.");
    } },
    { id: "sibling", run: async () => {
      await conversationClosed.promise;
      order.push("sibling rejects");
      throw failure("Cancelled", "The folder inventory was cancelled.");
    } }];
  const report = runBounded(items, { concurrency: 2, timeoutMs: 60_000, fatal });
  const error = await rejection(report);
  assert.deepEqual(order, ["sibling rejects", "writer rejects"], "the race is forced: the cancellation came first");
  assert.equal(kindOf(error), "SecurityViolation", "the cause, not its consequence");
  assert.match((error as FusionFailure).error.safeMessage, /changed its read-only view/u);
});

test("C: a genuine cancellation with nothing stronger behind it still surfaces as Cancelled — an item's own, and the user's", async () => {
  const cleaned: string[] = [];
  const own: BatchItem<string>[] = [
    { id: "cancelled", run: async () => { try { throw failure("Cancelled", "The provider reported cancellation."); } finally { cleaned.push("cancelled"); } } },
    { id: "sibling", run: async signal => { try { await untilAborted(signal); throw failure("Cancelled"); } finally { cleaned.push("sibling"); } } }];
  const first = await rejection(runBounded(own, { concurrency: 2, timeoutMs: 60_000, fatal }));
  assert.deepEqual([kindOf(first), (first as FusionFailure).error.safeMessage], ["Cancelled", "The provider reported cancellation."], "the first cancellation, not a sibling's");
  assert.deepEqual(cleaned.sort(), ["cancelled", "sibling"]);
  const controller = new AbortController();
  const user: BatchItem<string>[] = ["a", "b"].map(id => ({ id, run: async (signal: AbortSignal) => { await untilAborted(signal); throw failure("Cancelled"); } }));
  const run = runBounded(user, { concurrency: 2, timeoutMs: 60_000, fatal, signal: controller.signal });
  await afterMicrotasks();
  controller.abort();
  const error = await rejection(run);
  assert.deepEqual([kindOf(error), (error as FusionFailure).error.safeMessage], ["Cancelled", "The task was cancelled."]);
});

test("C': a SecurityViolation is never hidden as the user's cancellation or as a time-out", async () => {
  // The user stops the task while an investigation's view is found changed: the violation is still the reported failure.
  const controller = new AbortController();
  const items: BatchItem<string>[] = [
    { id: "writer", run: async signal => { await untilAborted(signal); throw failure("SecurityViolation", "view changed"); } },
    { id: "sibling", run: async signal => { await untilAborted(signal); throw failure("Cancelled"); } }];
  const run = runBounded(items, { concurrency: 2, timeoutMs: 60_000, fatal, signal: controller.signal });
  await afterMicrotasks();
  controller.abort();
  assert.equal(kindOf(await rejection(run)), "SecurityViolation");
  // An item stopped at its time budget that turns out to have changed its view: a SecurityViolation, not a time-out.
  const timed = runBounded([{ id: "slow", run: async (signal: AbortSignal) => { await untilAborted(signal); throw failure("SecurityViolation", "view changed"); } }],
    { concurrency: 1, timeoutMs: 1, fatal });
  assert.equal(kindOf(await rejection(timed)), "SecurityViolation");
});

test("precedence is explicit, not a reordering: among failures of equal rank the first observed stays; a cancellation never replaces one", async () => {
  const later = deferred();
  const items: BatchItem<string>[] = [
    { id: "first", run: async () => { later.resolve(); throw failure("InternalError", "first internal error"); } },
    { id: "second", run: async () => { await later.promise; await afterMicrotasks(); throw failure("InternalError", "second internal error"); } },
    { id: "third", run: async signal => { await untilAborted(signal); await afterMicrotasks(); await afterMicrotasks(); throw failure("Cancelled"); } }];
  const error = await rejection(runBounded(items, { concurrency: 3, timeoutMs: 60_000, fatal }));
  assert.deepEqual([kindOf(error), (error as FusionFailure).error.safeMessage], ["InternalError", "first internal error"]);
  // A Cancelled seen first gives way to a later internal error too (a cancellation is never the cause of another failure).
  const closed = deferred();
  const second = await rejection(runBounded([
    { id: "cancelled", run: async () => { await closed.promise; throw failure("Cancelled"); } },
    { id: "internal", run: async () => { closed.resolve(); await afterMicrotasks(); await afterMicrotasks(); throw failure("InternalError", "the root failure"); } }],
    { concurrency: 2, timeoutMs: 60_000, fatal }));
  assert.deepEqual([kindOf(second), (second as FusionFailure).error.safeMessage], ["InternalError", "the root failure"]);
});

test("D: bounded — the batch never waits for a stronger failure that is not coming; every started item settled before it returned", async () => {
  const settled: string[] = [];
  const items: BatchItem<string>[] = [
    { id: "cancelled", run: async () => { try { throw failure("Cancelled", "own cancellation"); } finally { settled.push("cancelled"); } } },
    { id: "done", run: async () => { try { return "report"; } finally { settled.push("done"); } } },
    { id: "stopped", run: async signal => { try { await untilAborted(signal); return "partial"; } finally { settled.push("stopped"); } } }];
  const error = await rejection(runBounded(items, { concurrency: 3, timeoutMs: 60_000, fatal, settleGraceMs: 60_000 }));
  assert.equal(kindOf(error), "Cancelled");
  assert.deepEqual(settled.sort(), ["cancelled", "done", "stopped"]);
});
