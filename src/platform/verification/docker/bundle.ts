import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { failWith } from "../../../core/errors.js";
import { removeOwnedTemporary } from "../../fs/temporary.js";
import { comparablePath } from "../../workspace/git.js";
import { RUN_ID } from "./config.js";

/**
 * Host side of the data flow. Per run Fusion creates one disposable directory it owns:
 *
 *   <base>/fusion-docker-XXXXXX/
 *     .fusion-docker-run      ownership marker holding the run id; removal refuses a directory without it
 *     input/                  the ONLY path mounted into the container, read-only
 *       runner.mjs            guest runner (hash recorded)
 *       manifest.json         host-authored verify manifest
 *       canary.json           host-authored canary manifest (evidence collection only)
 *       canary/readable.txt   synthetic readable canary
 *       src/                  candidate snapshot: regular files and directories only, `.git` excluded
 *     private-sibling/        host-private synthetic marker, never mounted
 *
 * The candidate snapshot never follows or copies a symbolic link or junction: one fails the whole run, because a
 * link could pull an arbitrary host file into the bundle. The private candidate itself is never mounted.
 */
export const BUNDLE_LIMITS = Object.freeze({ maxEntries: 20_000, maxFileBytes: 32 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024 });
export const RUN_ROOT_PREFIX = "fusion-docker-";
const MARKER = ".fusion-docker-run";

export interface RunDirectories {
  readonly runRoot: string;
  readonly input: string;
  readonly privateSibling: string;
}

export async function createRunDirectories(runId: string, base: string = tmpdir()): Promise<RunDirectories> {
  if (!RUN_ID.test(runId)) failWith("InvalidInput", "Docker run id is invalid.");
  const runRoot = await mkdtemp(join(resolve(base), RUN_ROOT_PREFIX));
  await writeFile(join(runRoot, MARKER), runId, { flag: "wx" });
  const input = join(runRoot, "input"), privateSibling = join(runRoot, "private-sibling");
  await mkdir(join(input, "canary"), { recursive: true });
  await mkdir(privateSibling);
  return Object.freeze({ runRoot, input, privateSibling });
}

/**
 * Removes a run directory only when it is provably this run's: a direct child of `base` with the Fusion prefix, not
 * a link, and carrying the ownership marker with the expected run id. Anything else is left in place and reported.
 */
export async function removeRunDirectories(directories: RunDirectories, runId: string, base: string = tmpdir()): Promise<boolean> {
  const root = resolve(directories.runRoot);
  if (comparablePath(dirname(root)) !== comparablePath(resolve(base)) || !basename(root).startsWith(RUN_ROOT_PREFIX)) return false;
  try {
    const info = await lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory()) return false;
    if ((await readFile(join(root, MARKER), "utf8")) !== runId) return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" && await lstat(root).then(() => false, () => true);
  }
  await removeOwnedTemporary(root);
  return lstat(root).then(() => false, () => true);
}

export interface SnapshotStats {
  readonly files: number;
  readonly directories: number;
  readonly bytes: number;
}

/** Copies the candidate's regular files and directories into `destination`; any link or special file fails closed. */
export async function copyCandidateSnapshot(sourceRoot: string, destination: string): Promise<SnapshotStats> {
  const root = resolve(sourceRoot);
  const rootInfo = await lstat(root).catch(() => failWith("InvalidInput", "Verification candidate does not exist."));
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) failWith("InvalidInput", "Verification candidate must be a real directory.");
  await mkdir(destination);
  let files = 0, directories = 0, bytes = 0;
  const pending: [string, string][] = [[root, destination]];
  while (pending.length > 0) {
    const [from, to] = pending.pop()!;
    for (const name of (await readdir(from)).sort()) {
      // Repository metadata is not part of the verified candidate; a verifier never needs Git credentials or history.
      if (from === root && name === ".git") continue;
      if (files + directories >= BUNDLE_LIMITS.maxEntries) failWith("InvalidInput", "Verification candidate has too many entries.");
      const source = join(from, name), target = join(to, name);
      const info = await lstat(source);
      if (info.isSymbolicLink())
        failWith("SecurityViolation", "Verification candidate contains a symbolic link or junction; it is never copied or followed.");
      if (info.isDirectory()) {
        await mkdir(target);
        directories++;
        pending.push([source, target]);
      } else if (info.isFile()) {
        bytes += info.size;
        if (info.size > BUNDLE_LIMITS.maxFileBytes || bytes > BUNDLE_LIMITS.maxTotalBytes)
          failWith("InvalidInput", "Verification candidate exceeds the bundle size limit.");
        await copyFile(source, target, constants.COPYFILE_EXCL);
        files++;
      } else failWith("SecurityViolation", "Verification candidate contains a special file.");
    }
  }
  return Object.freeze({ files, directories, bytes });
}

/** The compiled guest runner, read from next to this module, with its SHA-256. */
export async function loadGuestRunner(): Promise<Readonly<{ bytes: Buffer; sha256: string }>> {
  const bytes = await readFile(new URL("./guest-runner.js", import.meta.url));
  return Object.freeze({ bytes, sha256: createHash("sha256").update(bytes).digest("hex") });
}
