import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

/** Includes ignored and untracked files. The private repository's top-level `.git` is captured separately. */
export interface ControlledTreeSnapshot {
  readonly digests: Readonly<Record<string, string>>;
  readonly complete: boolean;
}
export const CONTROLLED_TREE_LIMITS = Object.freeze({ maxEntries: 50_000, maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024 });

export async function captureControlledTree(root: string, includeGit = false): Promise<ControlledTreeSnapshot> {
  const digests: Record<string, string> = Object.create(null) as Record<string, string>;
  const pending = [root];
  let entries = 0, bytes = 0, complete = true;
  while (pending.length > 0 && complete) {
    const directory = pending.pop()!;
    let names: string[];
    try { names = (await readdir(directory)).sort(); } catch { complete = false; break; }
    for (const name of names) {
      if (directory === root && name === ".git" && !includeGit) continue;
      if (++entries > CONTROLLED_TREE_LIMITS.maxEntries) { complete = false; break; }
      const path = join(directory, name), key = relative(root, path).replace(/\\/gu, "/");
      let info;
      try { info = await lstat(path); } catch { complete = false; break; }
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) { complete = false; break; }
      if (info.isDirectory()) {
        if (name === ".git" && directory !== root) { complete = false; break; }
        digests[key] = "directory";
        pending.push(path);
      } else {
        bytes += info.size;
        if (info.size > CONTROLLED_TREE_LIMITS.maxFileBytes || bytes > CONTROLLED_TREE_LIMITS.maxTotalBytes) {
          complete = false; break;
        }
        const hash = createHash("sha256");
        try { for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer); }
        catch { complete = false; break; }
        digests[key] = hash.digest("hex");
      }
    }
  }
  return { digests, complete };
}

export function compareControlledTrees(before: ControlledTreeSnapshot, after: ControlledTreeSnapshot): readonly string[] {
  return [...new Set([...Object.keys(before.digests), ...Object.keys(after.digests)])]
    .filter(path => before.digests[path] !== after.digests[path]).sort();
}
