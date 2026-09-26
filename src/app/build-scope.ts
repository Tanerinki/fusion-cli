import { CHANGE_LIMITS, canonicalChangePath } from "../core/change/contract.js";
import { FusionFailure } from "../core/errors.js";
import type { CommandRequest, ControlPlane } from "./control-plane.js";
import { RepositoryConversation } from "./conversation.js";
import { renderInventory } from "./repository-inventory.js";

/**
 * v0.1 — the write scope of a build started WITHOUT `--path`. The workflow engine only ever lets a Writer touch an exact
 * list of files fixed before any role runs; this module proposes that list: ONE read-only turn by the Lead (a conversation
 * turn in a Fusion-owned view, the primary proven unchanged), whose reply Fusion reads as a JSON array of paths and checks
 * strictly (canonical repository-relative file paths, no `.git`/`.fusion`, no traversal, bounded). The proposal is
 * untrusted: the human sees the exact list in the build plan and confirms it — or passes `--path` instead.
 */
export const MAX_PROPOSED_PATHS = 24;
export const SCOPE_INSTRUCTION = "You are Fusion's scope planner. List every repository file that must be created or changed to implement the " +
  "task below, including the tests that cover it and any documentation it needs. Inspect the repository first. Reply with ONLY a JSON " +
  `array of repository-relative file paths using forward slashes, for example ["src/orders.ts", "test/orders.test.ts"]. At most ${MAX_PROPOSED_PATHS} ` +
  "paths. Never include package lock files, .git, .fusion or files with secrets. No prose.";

export interface ScopeProposal {
  readonly paths: readonly string[];
  readonly partner: Readonly<{ role: string; provider: string; model: string }>;
}

/** The paths a reply lists: the whole reply, or its first JSON array (a fenced block or bare), strictly checked. */
export function parseProposedScope(reply: string): readonly string[] {
  const candidates = [reply.trim(), /```(?:json)?\s*(\[[\s\S]*?\])\s*```/u.exec(reply)?.[1], /(\[[\s\S]*?\])/u.exec(reply)?.[1]];
  let value: unknown;
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    try { value = JSON.parse(candidate); break; } catch { /* try the next reading */ }
  }
  if (!Array.isArray(value) || value.length === 0)
    throw new FusionFailure({ kind: "MalformedOutput", retryable: false, safeMessage: "The proposed scope is not a JSON array of file paths." });
  const paths = new Set<string>();
  for (const entry of value) {
    let path: string;
    try { path = canonicalChangePath(entry); }
    catch { throw new FusionFailure({ kind: "SecurityViolation", retryable: false, safeMessage: "The proposed scope contains a path that is not a canonical repository-relative file path." }); }
    if (/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/iu.test(path) || /(^|\/)\.env(\.|$)/iu.test(path))
      throw new FusionFailure({ kind: "SecurityViolation", retryable: false, safeMessage: `The proposed scope names a file a build may not write (${path}).` });
    paths.add(path);
  }
  if (paths.size > Math.min(MAX_PROPOSED_PATHS, CHANGE_LIMITS.maxOperations))
    throw new FusionFailure({ kind: "InvalidInput", retryable: false, safeMessage: `The proposed scope lists more than ${MAX_PROPOSED_PATHS} files; narrow the task or pass --path.` });
  return Object.freeze([...paths]);
}

/** One read-only scope-planning turn by the Lead for `task`; the proposal still needs the human's confirmation. */
export async function proposeBuildScope(plane: ControlPlane, task: string, request: CommandRequest = {}): Promise<ScopeProposal> {
  const conversation = await RepositoryConversation.open(plane, request);
  try {
    // Always the Lead (whatever partner chat defaults to): the scope is part of the Lead's planning.
    const answer = await conversation.ask(`Task: ${task}`, { partner: "lead", purpose: "analysis", instruction: SCOPE_INSTRUCTION,
      context: renderInventory(conversation.inventory, "full"), remember: false, ...(request.signal ? { signal: request.signal } : {}) });
    return Object.freeze({ paths: parseProposedScope(answer.text), partner: answer.partner });
  } finally { await conversation.close(); }
}
