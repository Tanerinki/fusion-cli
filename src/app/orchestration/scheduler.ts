import { FusionFailure } from "../../core/errors.js";

/**
 * v0.3 — THE BOUNDED PARALLEL SCHEDULER of an investigation batch. It runs at most `concurrency` items at the same time
 * (a deterministic start order: the batch's order), gives each its own abort signal and time budget, and never returns
 * before every started item has SETTLED — each item's own cleanup (its provider session and its view copy) has run by then.
 *
 *   - An item that exceeds its time budget is aborted and reported as timed out; its siblings continue.
 *   - A FATAL failure of any item (a security violation, a cancellation that did not come from its own time budget) aborts
 *     every sibling; the batch then waits for all of them to settle and rethrows the fatal failure of the highest
 *     precedence (`fatalPrecedence`; the first observed among equals) — so a cancellation caused by stopping the siblings
 *     never hides the failure that caused it.
 *   - The caller's signal (the user cancelling the task) aborts every item; the batch waits for all to settle, then throws
 *     `Cancelled`.
 *   - An item that does not settle within a grace period after its abort is a fatal failure of the batch (Fusion cannot
 *     vouch that its process is gone), never silently ignored.
 *
 * Items start in order, so with no more items than the concurrency bound every item starts at once.
 */
export interface BatchItem<T> {
  readonly id: string;
  run(signal: AbortSignal): Promise<T>;
}
export type ItemResult<T> =
  | Readonly<{ id: string; status: "fulfilled"; value: T; startedAt: number; endedAt: number }>
  | Readonly<{ id: string; status: "rejected"; error: unknown; timedOut: boolean; startedAt: number; endedAt: number }>;
export interface BatchReport<T> {
  readonly results: readonly ItemResult<T>[];
  /** The most items that were running at the same time. */
  readonly maxConcurrent: number;
  readonly durationMs: number;
}
export interface BatchOptions {
  readonly concurrency: number;
  /** Each item's time budget. */
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Whether a rejection must stop the whole batch. */
  readonly fatal: (error: unknown) => boolean;
  /** How long an aborted item may take to settle. */
  readonly settleGraceMs?: number;
  readonly clock?: () => number;
}
export const SCHEDULER_LIMITS = Object.freeze({ maxConcurrency: 3, settleGraceMs: 30_000 });

export function timeoutFailure(timeoutMs: number): FusionFailure {
  return new FusionFailure({ kind: "Timeout", retryable: true,
    safeMessage: `The investigation exceeded its time budget (${Math.round(timeoutMs / 1000)} s) and was stopped.` });
}
const cancelled = (): FusionFailure => new FusionFailure({ kind: "Cancelled", retryable: false, safeMessage: "The investigation was cancelled." });
/**
 * v0.4 — the explicit, deterministic precedence of the failures that stop a batch. The higher rank wins; among equal ranks the
 * one observed first stays, so unrelated failures are never reordered.
 *   3  SecurityViolation — a root cause: whatever it stops (the siblings, the conversation) follows from it.
 *   2  every other fatal failure — an item that did not settle, an internal error.
 *   1  Cancelled — the weakest: the consequence of another failure stopping its siblings, or a stop of its own.
 * Only failures of items the batch already waits for can compete: nothing waits longer for a stronger one.
 */
export function fatalPrecedence(error: unknown): 1 | 2 | 3 {
  if (!(error instanceof FusionFailure)) return 2;
  return error.error.kind === "SecurityViolation" ? 3 : error.error.kind === "Cancelled" ? 1 : 2;
}
const unsettled = (): FusionFailure => new FusionFailure({ kind: "InternalError", retryable: false,
  safeMessage: "An investigation did not stop after it was cancelled; Fusion stopped the route." });

/** Runs `items` under the bounds; resolves with every item's result, or rejects with a fatal failure or the cancellation. */
export async function runBounded<T>(items: readonly BatchItem<T>[], options: BatchOptions): Promise<BatchReport<T>> {
  const clock = options.clock ?? Date.now;
  const concurrency = Math.max(1, Math.min(options.concurrency, SCHEDULER_LIMITS.maxConcurrency));
  const grace = options.settleGraceMs ?? SCHEDULER_LIMITS.settleGraceMs;
  const batch = new AbortController();
  const relayParent = (): void => batch.abort();
  options.signal?.addEventListener("abort", relayParent, { once: true });
  if (options.signal?.aborted) batch.abort();
  const results: Array<ItemResult<T> | undefined> = new Array(items.length).fill(undefined);
  let next = 0, running = 0, maxConcurrent = 0;
  let fatal: unknown;
  const began = clock();

  async function one(index: number): Promise<void> {
    const item = items[index]!;
    const own = new AbortController();
    const relay = (): void => own.abort();
    batch.signal.addEventListener("abort", relay, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; own.abort(); }, options.timeoutMs);
    running++;
    maxConcurrent = Math.max(maxConcurrent, running);
    const startedAt = clock();
    let graceTimer: NodeJS.Timeout | undefined;
    try {
      // The item must settle; after its abort it has `grace` to do so.
      const late = new Promise<never>((_, reject) => {
        const arm = (): void => { graceTimer = setTimeout(() => reject(unsettled()), grace); };
        if (own.signal.aborted) arm(); else own.signal.addEventListener("abort", arm, { once: true });
      });
      late.catch(() => undefined);
      const value = await Promise.race([item.run(own.signal), late]);
      results[index] = Object.freeze({ id: item.id, status: "fulfilled", value, startedAt, endedAt: clock() });
    } catch (error) {
      const isUnsettled = error instanceof FusionFailure && error.error.kind === "InternalError" && error.error.safeMessage === unsettled().error.safeMessage;
      // A security violation is never re-labelled: not as this item's time-out, not as part of the user's cancellation.
      const security = !isUnsettled && fatalPrecedence(error) === 3 && options.fatal(error);
      const expired = timedOut && !isUnsettled && !security;
      const reported = expired ? timeoutFailure(options.timeoutMs) : error;
      results[index] = Object.freeze({ id: item.id, status: "rejected", error: reported, timedOut: expired, startedAt, endedAt: clock() });
      const stops = isUnsettled || security || (!timedOut && !options.signal?.aborted && options.fatal(error));
      if (stops && (fatal === undefined || fatalPrecedence(reported) > fatalPrecedence(fatal))) { fatal = reported; batch.abort(); }
    } finally {
      clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      batch.signal.removeEventListener("abort", relay);
      running--;
    }
  }
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      if (batch.signal.aborted) {
        const at = clock();
        results[index] = Object.freeze({ id: items[index]!.id, status: "rejected", error: cancelled(), timedOut: false, startedAt: at, endedAt: at });
        continue;
      }
      await one(index);
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  } finally { options.signal?.removeEventListener("abort", relayParent); }
  if (fatal !== undefined) throw fatal;
  if (options.signal?.aborted) throw new FusionFailure({ kind: "Cancelled", retryable: false, safeMessage: "The task was cancelled." });
  return Object.freeze({ results: Object.freeze(results as ItemResult<T>[]), maxConcurrent, durationMs: Math.max(0, clock() - began) });
}
