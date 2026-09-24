import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { SessionWorkspace } from "../../core/domain.js";
import { failWith } from "../../core/errors.js";
import { comparablePath } from "./git.js";

/** True when `a` and `b` are the same directory or one contains the other (case-insensitive on Windows). */
export function pathsOverlap(a: string, b: string): boolean {
  const x = comparablePath(resolve(a)), y = comparablePath(resolve(b));
  const separator = process.platform === "win32" ? "\\" : "/";
  return x === y || x.startsWith(`${y}${separator}`) || y.startsWith(`${x}${separator}`);
}

/**
 * The directory an adapter runs every process of a session in. `workspace` is the Fusion-provided session workspace;
 * without one, `required` refuses the session and otherwise `undefined` (the adapter's configured default) applies.
 * A root that is, contains or lies inside a forbidden root (the primary checkout) — by its spelling or by its real path,
 * so a link or junction cannot smuggle the primary in — is a security violation, as is anything but a real directory.
 */
export async function sessionWorkspaceRoot(workspace: SessionWorkspace | undefined, forbiddenRoots: readonly string[],
  required: boolean): Promise<string | undefined> {
  if (workspace === undefined) {
    if (required) failWith("SecurityViolation", "This adapter runs only in a Fusion-owned session workspace.");
    return undefined;
  }
  if (workspace === null || typeof workspace !== "object" || typeof workspace.id !== "string" || workspace.id.length === 0 ||
      typeof workspace.root !== "string" || !isAbsolute(workspace.root))
    failWith("InvalidInput", "The session workspace is malformed.");
  const root = resolve(workspace.root);
  let info;
  try { info = await lstat(root); } catch { failWith("SecurityViolation", "The session workspace does not exist."); }
  if (!info.isDirectory() || info.isSymbolicLink()) failWith("SecurityViolation", "The session workspace must be a real directory.");
  const real = await realpath(root);
  for (const forbidden of forbiddenRoots) {
    const forbiddenReal = await realpath(forbidden).catch(() => resolve(forbidden));
    if ([root, real].some(path => pathsOverlap(path, forbidden) || pathsOverlap(path, forbiddenReal)))
      failWith("SecurityViolation", "A session workspace can never be, contain or lie inside the primary checkout.");
  }
  return root;
}
