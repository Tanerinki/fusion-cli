import type { ObligationKind } from "../evidence/obligations.js";
import type { VerificationVerdict } from "../workflow/types.js";
import type { CandidateId } from "./contracts.js";
import { requiredChecks, type VerificationProfile } from "./profile.js";

/**
 * v0.5 — THE VERIFICATION MESH: every proof channel a candidate faced, as structured nodes — not "npm test". A node records
 * what ran (a configured check, a probe, a property or fuzz run, a mutation), who defined it, whether its authority is
 * deterministic (Fusion ran it) or a model's (advice only), its host-observed result, the digest of what it printed, and the
 * obligation it bears on.
 *
 * Every node is bound to ONE candidate revision (the candidate manifest's SHA-256): evidence observed on one revision can never
 * support another. The mesh does not decide anything on its own: its deterministic pass/fail nodes enter the v0.4 evidence
 * decision as verification checks, so there is one truth system, not two.
 */
export const MESH_KINDS = ["regression", "reproduction", "scope", "protected", "falsification", "probe", "property", "fuzz", "mutation"] as const;
export type MeshKind = (typeof MESH_KINDS)[number];
export type MeshResult = "pass" | "fail" | "notRun" | "observed";
export interface MeshNode {
  readonly id: string;
  readonly candidate: CandidateId | "baseline";
  /** The candidate manifest's SHA-256 (`baseline` for the unchanged baseline). */
  readonly revision: string;
  readonly kind: MeshKind;
  /** Who defined the check: the repository's configuration, Fusion itself, or a model (a falsifier's finding). */
  readonly source: "configured" | "fusion" | "falsifier";
  readonly authority: "deterministic" | "model";
  readonly result: MeshResult;
  /** SHA-256 of what the check printed (its retained output), when observed. */
  readonly outputSha256?: string;
  /** Whether the output was retained completely (a truncated output is never compared). */
  readonly complete?: boolean;
  readonly exitCode?: number | null;
  readonly durationMs?: number;
  /** Fusion's own bounded account (never provider text). */
  readonly detail: string;
  readonly obligation?: ObligationKind;
}

export class ForeignEvidence extends Error {}
/** A candidate's nodes, all of its exact revision. A node of any other revision is refused, never silently reused. */
export function nodesOf(nodes: readonly MeshNode[], candidate: CandidateId, revision: string): readonly MeshNode[] {
  const mine = nodes.filter(n => n.candidate === candidate);
  const foreign = mine.filter(n => n.revision !== revision);
  if (foreign.length > 0) throw new ForeignEvidence(`${foreign.length} node(s) of ${candidate} were observed on another revision.`);
  return Object.freeze(mine);
}

/**
 * The candidate's verification as the v0.4 evidence decision reads it: the confined checks the engine ran, plus every
 * deterministic experiment of the COMMON profile as one more check (`x:<id>`). An experiment that failed fails
 * `verificationPassed`; one that did not run leaves the verification incomplete, which fails it too (never PASS). `planned`
 * is the number of checks the profile requires.
 */
export function meshVerdict(verdict: VerificationVerdict | undefined, profile: VerificationProfile, nodes: readonly MeshNode[]):
  Readonly<{ verdict: VerificationVerdict | undefined; planned: number }> {
  const experiments = requiredChecks(profile).filter(id => id.includes(":"));
  const planned = profile.commands.length + experiments.length;
  if (verdict === undefined || verdict.refusal !== undefined) return Object.freeze({ verdict, planned });
  const byId = new Map(nodes.filter(n => n.authority === "deterministic").map(n => [n.id, n]));
  const extra = experiments.flatMap(id => {
    const node = byId.get(id);
    return node === undefined || node.result === "notRun" || node.result === "observed" ? []
      : [{ id: `x:${id}`, status: node.result === "pass" ? "passed" : "failed", exitCode: node.exitCode ?? null }];
  });
  const evidence = verdict.evidence === undefined ? undefined : { ...verdict.evidence, commands: [...verdict.evidence.commands, ...extra] };
  const failed = extra.find(c => c.status !== "passed");
  const passed = verdict.passed && failed === undefined && extra.length === experiments.length;
  return Object.freeze({ planned, verdict: Object.freeze({ ...verdict, passed, commandsRun: verdict.commandsRun + extra.length,
    ...(evidence === undefined ? {} : { evidence }), ...(verdict.failedCommand === undefined && failed !== undefined ? { failedCommand: failed.id } : {}) }) });
}
