import { lstatSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

/**
 * The OS temporary directory in its canonical spelling: the base of every Fusion-owned temporary path (private
 * candidates, verification copies, provider views, provider hosts, evidence), which is later compared exactly with what
 * Git or the filesystem reports for it.
 *
 * Windows can name the temporary directory through 8.3 short names — on GitHub-hosted runners the user-profile segment
 * reads `RUNNER~1` — while Git and `realpath` report the long names. From a short-named base every one of those exact
 * comparisons fails (closed, but for a legitimate directory). Only that spelling is normalized: when any component of the
 * temporary directory is a link or junction, the base is returned exactly as the OS names it, so the strict link checks
 * downstream refuse it as before. Where the OS already names it canonically, the result equals `resolve(tmpdir())`.
 */
export function fusionTemporaryBase(): string {
  const base = resolve(tmpdir());
  try {
    for (let cursor = base; ; cursor = dirname(cursor)) {
      if (lstatSync(cursor).isSymbolicLink()) return base;
      if (dirname(cursor) === cursor) break;
    }
    return realpathSync.native(base);
  } catch {
    return base;
  }
}

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
