import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { isContainedPath } from "../platform/events/shared.js";
import { BoundedReadError, readBoundedFile } from "../platform/fs/bounded-read.js";

/**
 * v0.4 — THE BASIS of a claim check's evidence: a digest of exactly the files it rests on, as they are in the checkout now
 * (each file's SHA-256, or that it is absent, a link or too large). The shell computes it right after the check; a later build
 * computes it again for the same files and treats the handoff's evidence as STALE unless both are equal. Content, not Git's
 * index: an unrelated edit elsewhere does not invalidate the evidence, and an edit to one of its files always does.
 */
const MAX_BASIS_FILE_BYTES = 16 * 1024 * 1024;
const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

export async function evidenceBasis(root: string, files: readonly string[]): Promise<string> {
  const entries: Array<readonly [string, string]> = [];
  for (const path of [...new Set(files)].sort()) {
    const full = join(root, ...path.split("/"));
    let state = "absent";
    if (!isContainedPath(root, full) || path.split("/").some(part => part === ".." || part === "")) state = "outside";
    else {
      const info = await lstat(full).catch(() => undefined);
      if (info?.isSymbolicLink() === true) state = "link";
      else if (info?.isFile() === true) {
        try { state = sha256(await readBoundedFile(full, MAX_BASIS_FILE_BYTES)); }
        catch (error) { state = error instanceof BoundedReadError && error.reason === "tooLarge" ? "tooLarge" : "unreadable"; }
      } else if (info !== undefined) state = "other";
    }
    entries.push([path, state]);
  }
  return `files:${sha256(JSON.stringify(entries))}`;
}
