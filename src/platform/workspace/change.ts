import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { failWith } from "../../core/errors.js";
import { isContainedPath } from "../events/shared.js";
import { readBoundedFile } from "../fs/bounded-read.js";
import { gitOk, type GitClient } from "./git.js";
import { redactUnifiedDiff } from "./sensitive-input.js";
import { SAFE_REF } from "./lease.js";

/** Bounds for observed change evidence; the core clips again, so these only keep Git and file reads cheap. */
export const CHANGE_LIMITS = Object.freeze({
  maxGitBytes: 8 * 1024 * 1024, maxChars: 256 * 1024, maxUntrackedFiles: 200, maxUntrackedBytes: 64 * 1024,
  maxChangedPaths: 1_000,
});
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const split = (stdout: string): string[] => stdout.split("\0").filter(Boolean);

/** An untracked file rendered as a new-file diff block: bounded, never through a link, binary files elided. */
export async function untrackedBlock(root: string, relative: string): Promise<string> {
  const header = `diff --git a/${relative} b/${relative}\nnew file (untracked)\n--- /dev/null\n+++ b/${relative}\n`;
  const path = join(root, relative);
  if (!isContainedPath(root, path)) return `${header}(outside the workspace; not shown)\n`;
  let info;
  try { info = await lstat(path); } catch { return `${header}(unreadable)\n`; }
  if (info.isSymbolicLink()) return `${header}(symbolic link; not followed)\n`;
  if (!info.isFile()) return `${header}(not a regular file)\n`;
  if (info.size > CHANGE_LIMITS.maxUntrackedBytes) return `${header}(${info.size} bytes; too large to show)\n`;
  let bytes: Buffer;
  try { bytes = await readBoundedFile(path, CHANGE_LIMITS.maxUntrackedBytes); } catch { return `${header}(unreadable)\n`; }
  if (bytes.includes(0)) return `${header}(binary)\n`;
  const lines = new TextDecoder("utf-8").decode(bytes).split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  return `${header}${lines.map(line => `+${line}`).join("\n")}\n`;
}

export interface ObservedChange {
  /** Repository-relative, sorted, unique: tracked changes against the base plus untracked files. */
  readonly changedPaths: readonly string[];
  readonly text: string;
  readonly truncated: boolean;
}
/**
 * The change between `baseCommit` and a worktree's current files (committed, staged, unstaged and untracked), read
 * without writing: no index refresh (optional locks are off in the Git client), no intent-to-add, links not followed.
 * The text is for a reviewer: every secret value in it is masked (`redactUnifiedDiff`).
 */
export async function observeChange(git: GitClient, root: string, baseCommit: string, signal?: AbortSignal): Promise<ObservedChange> {
  if (!COMMIT.test(baseCommit)) failWith("InvalidInput", "The change base must be a resolved commit.");
  const signalOption = signal ? { signal } : {};
  const options = { cwd: root, maxStdoutBytes: CHANGE_LIMITS.maxGitBytes, ...signalOption };
  const tracked = await gitOk(git, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames",
    "--ignore-submodules=none", baseCommit, "--"], options, "diff the workspace.");
  const names = split(await gitOk(git, ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff",
    "--ignore-submodules=none", baseCommit, "--"], options, "list the workspace's changes."));
  const untracked = split(await gitOk(git, ["ls-files", "--others", "--exclude-standard", "-z"], options,
    "list the workspace's untracked files.")).sort();
  let truncated = untracked.length > CHANGE_LIMITS.maxUntrackedFiles;
  let text = tracked;
  for (const path of untracked.slice(0, CHANGE_LIMITS.maxUntrackedFiles)) {
    if (text.length > CHANGE_LIMITS.maxChars) { truncated = true; break; }
    text += await untrackedBlock(root, path);
  }
  if (text.length > CHANGE_LIMITS.maxChars) { text = text.slice(0, CHANGE_LIMITS.maxChars); truncated = true; }
  let changedPaths = [...new Set([...names, ...untracked])].sort();
  if (changedPaths.length > CHANGE_LIMITS.maxChangedPaths) {
    changedPaths = changedPaths.slice(0, CHANGE_LIMITS.maxChangedPaths);
    truncated = true;
  }
  // v0.2.1: the text is review evidence a provider reads; secret values are masked (the paths stay exact).
  return { changedPaths, text: redactUnifiedDiff(text).text, truncated };
}

export interface ReviewBase {
  readonly commit: string;
  /** What the user asked for, for display; `HEAD` when no base was given. */
  readonly label: string;
}
/**
 * The deterministic review base: `HEAD` by default (uncommitted work), or the merge base of a local ref with `HEAD`.
 * Refs are resolved locally only; nothing is fetched and no remote branch is chosen implicitly.
 */
export async function resolveReviewBase(git: GitClient, root: string, ref?: string, signal?: AbortSignal): Promise<ReviewBase> {
  const options = { cwd: root, ...(signal ? { signal } : {}) };
  const commitOf = async (name: string): Promise<string | undefined> => {
    const result = await git.run(["rev-parse", "--verify", "--quiet", "--end-of-options", `${name}^{commit}`], options);
    const value = result.stdout.trim();
    return result.exitCode === 0 && COMMIT.test(value) ? value : undefined;
  };
  const head = await commitOf("HEAD");
  if (head === undefined) failWith("InvalidInput", "The repository has no commit yet, so there is no base to review against.");
  if (ref === undefined) return { commit: head, label: "HEAD" };
  if (typeof ref !== "string" || !SAFE_REF.test(ref)) failWith("InvalidInput", "The review base is not a valid local reference.");
  const target = await commitOf(ref);
  if (target === undefined) failWith("InvalidInput", "The review base does not name a local commit; Fusion never fetches or guesses one.");
  const mergeBase = await git.run(["merge-base", target, head], options);
  const commit = mergeBase.stdout.trim();
  if (mergeBase.exitCode !== 0 || !COMMIT.test(commit))
    failWith("InvalidInput", "The review base shares no history with HEAD.");
  return { commit, label: ref };
}
