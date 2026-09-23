import { rm } from "node:fs/promises";

/**
 * Removes a Fusion-owned temporary directory. Node retries EBUSY/EPERM/ENOTEMPTY, which Windows reports
 * while a scanner or indexer briefly holds a freshly written file. Failure is returned to the caller;
 * it is never swallowed here.
 */
export async function removeOwnedTemporary(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

/**
 * Runs `work`, then always attempts cleanup. The primary failure wins over a cleanup failure; a cleanup
 * failure after success is reported through `onCleanupFailure`, which must throw a typed error.
 */
export async function withCleanup<T>(work: () => Promise<T>, cleanup: () => Promise<void>,
  onCleanupFailure: (error: unknown) => never): Promise<T> {
  let value: T;
  try { value = await work(); }
  catch (primary) {
    await cleanup().catch(() => { /* the primary failure is the reported outcome */ });
    throw primary;
  }
  try { await cleanup(); }
  catch (error) { onCleanupFailure(error); }
  return value;
}
