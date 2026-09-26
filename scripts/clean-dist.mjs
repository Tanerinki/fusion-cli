// Deterministically removes the repository's own compiled output directory before a build, so a `dist/` left over
// from another branch (with sources that no longer exist) can never be executed by `npm test`. `tsc` emits into
// `dist/` but never prunes orphaned files, so without this a branch switch can run stale compiled tests.
//
// This is repository-scoped and explicit: it removes exactly `<repoRoot>/dist` and nothing else, only when the given
// root actually looks like this repository (it contains package.json). It never follows a symlink for `dist`, and it
// never touches unrelated directories or user data.
import { lstatSync, rmSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Remove `<root>/dist` if present. Refuses a root that is not a package (no package.json) and refuses a linked dist. */
export function cleanDist(root = REPO_ROOT) {
  const base = resolve(root);
  if (!existsSync(join(base, "package.json")))
    throw new Error(`Refusing to clean: ${base} is not a package root (no package.json).`);
  const dist = join(base, "dist");
  let info;
  try { info = lstatSync(dist); }
  catch (error) { if (error.code === "ENOENT") return { removed: false, dist }; throw error; }
  if (info.isSymbolicLink())
    throw new Error(`Refusing to remove a symlinked dist at ${dist}.`);
  if (!info.isDirectory())
    throw new Error(`Refusing to remove a non-directory dist at ${dist}.`);
  rmSync(dist, { recursive: true, force: true });
  return { removed: true, dist };
}

// Run as a CLI only when invoked directly (not when imported by a test).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { cleanDist(); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
