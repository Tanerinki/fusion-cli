import { canonicalChangeSetJson } from "../change/contract.js";
import { sha256Hex } from "../delivery/canonical.js";
import type { ChangeOperation, ChangeSet } from "../domain.js";
import type { CandidateId } from "./contracts.js";
import { TOURNAMENT_LIMITS } from "./contracts.js";

/**
 * v0.5 — FUSION-OWNED MUTATIONS. The question a mutation answers: "if this candidate's fix were subtly undone, would our
 * verification notice?" Fusion — never a model — derives each mutation from the candidate's OWN change: one changed region
 * (hunk) of one non-test file reverted to the baseline. The mutated change is materialized in a fresh candidate and verified
 * against the common checks. A mutation the checks detect (a check fails) is KILLED; one they do not detect SURVIVED — an
 * evidence weakness of that candidate, never by itself a failure.
 *
 * Test files are never mutated (reverting a test only removes a check). A file larger than the diff bound, or a change that
 * only creates or deletes files, yields no mutation — and that is reported, not hidden.
 */
export interface Hunk {
  /** Line index in the BEFORE text where the region starts. */
  readonly beforeStart: number;
  readonly beforeLines: readonly string[];
  readonly afterStart: number;
  readonly afterLines: readonly string[];
}
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs)\/|\.(test|spec)\.[a-z0-9]+$/iu;
export const isTestPath = (path: string): boolean => TEST_PATH.test(path.replace(/\\/gu, "/"));

/**
 * The changed regions between two texts, line-based (a common prefix and suffix, then a longest common subsequence of the
 * middle, bounded). `undefined` when either text exceeds the bound — Fusion then does not guess.
 */
export function lineHunks(before: string, after: string, maxLines: number = TOURNAMENT_LIMITS.mutationMaxLines): readonly Hunk[] | undefined {
  const a = before.split("\n"), b = after.split("\n");
  if (a.length > maxLines || b.length > maxLines) return undefined;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const midA = a.slice(start, endA), midB = b.slice(start, endB);
  if (midA.length === 0 && midB.length === 0) return Object.freeze([]);
  // LCS over the middle only; past a size bound the whole middle is one region (still exact, just coarser).
  if (midA.length * midB.length > 250_000)
    return Object.freeze([Object.freeze({ beforeStart: start, beforeLines: Object.freeze(midA), afterStart: start, afterLines: Object.freeze(midB) })]);
  const n = midA.length, m = midB.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    lcs[i]![j] = midA[i] === midB[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const hunks: Hunk[] = [];
  let i = 0, j = 0, open: { bs: number; bl: string[]; as: number; al: string[] } | undefined;
  const close = (): void => { if (open) { hunks.push(Object.freeze({ beforeStart: open.bs, beforeLines: Object.freeze(open.bl), afterStart: open.as,
    afterLines: Object.freeze(open.al) })); open = undefined; } };
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) { close(); i++; j++; continue; }
    open ??= { bs: start + i, bl: [], as: start + j, al: [] };
    if (j < m && (i >= n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) { open.al.push(midB[j]!); j++; }
    else { open.bl.push(midA[i]!); i++; }
  }
  close();
  return Object.freeze(hunks);
}

/** The after text with one hunk reverted to its before lines (every other change kept). */
export function revertHunk(after: string, hunks: readonly Hunk[], index: number): string {
  const hunk = hunks[index];
  if (hunk === undefined) throw new RangeError("No such hunk.");
  const lines = after.split("\n");
  return [...lines.slice(0, hunk.afterStart), ...hunk.beforeLines, ...lines.slice(hunk.afterStart + hunk.afterLines.length)].join("\n");
}

export interface Mutation {
  readonly id: string;
  readonly candidate: CandidateId;
  readonly path: string;
  readonly hunk: number;
  /** Fusion's own description (line numbers only; no content). */
  readonly description: string;
  readonly changes: ChangeSet;
  readonly sha256: string;
}
export type MutationPlan = Readonly<{ mutations: readonly Mutation[]; notMutated: readonly Readonly<{ path: string; reason: string }>[] }>;

/**
 * Up to `max` mutations of one candidate's change, in a deterministic order (operation order, then region order). `baseline`
 * holds the unchanged text of each updated file (`null`: it did not exist).
 */
export function planMutations(candidate: CandidateId, changes: ChangeSet, baseline: ReadonlyMap<string, string | null>, max: number): MutationPlan {
  const mutations: Mutation[] = [];
  const notMutated: Array<{ path: string; reason: string }> = [];
  const bound = Math.max(0, Math.min(max, TOURNAMENT_LIMITS.maxMutationsPerCandidate));
  changes.operations.forEach((op, index) => {
    if (op.kind !== "writeText") { notMutated.push({ path: op.path, reason: "a deletion is not mutated" }); return; }
    if (isTestPath(op.path)) { notMutated.push({ path: op.path, reason: "a test file is not mutated" }); return; }
    const before = baseline.get(op.path);
    if (before === undefined || before === null) { notMutated.push({ path: op.path, reason: "a created file is not mutated" }); return; }
    const hunks = lineHunks(before, op.content);
    if (hunks === undefined) { notMutated.push({ path: op.path, reason: `larger than ${TOURNAMENT_LIMITS.mutationMaxLines} lines` }); return; }
    hunks.forEach((hunk, h) => {
      if (mutations.length >= bound) return;
      const mutated: ChangeOperation = { kind: "writeText", path: op.path, expectedSha256: op.expectedSha256, content: revertHunk(op.content, hunks, h) };
      const operations = changes.operations.map((other, k) => k === index ? mutated : other);
      const changeSet: ChangeSet = Object.freeze({ schemaVersion: 1, operations: Object.freeze(operations) });
      const id = `m${mutations.length + 1}`;
      mutations.push(Object.freeze({ id, candidate, path: op.path, hunk: h,
        description: `lines ${hunk.afterStart + 1}–${hunk.afterStart + Math.max(1, hunk.afterLines.length)} of ${op.path} reverted to the baseline`,
        changes: changeSet, sha256: sha256Hex(canonicalChangeSetJson(changeSet)) }));
    });
  });
  return Object.freeze({ mutations: Object.freeze(mutations), notMutated: Object.freeze(notMutated.map(n => Object.freeze(n))) });
}
