import { canonicalChangeSetJson } from "../change/contract.js";
import { canonicalJson, deepFreeze, sha256Hex } from "../delivery/canonical.js";
import type { ChangeSet } from "../domain.js";
import type { AppliedOperation } from "../workflow/types.js";
import type { CandidateId, Independence } from "./contracts.js";

/**
 * v0.5 — IMMUTABLE MANIFESTS. A candidate is bound cryptographically to everything it was judged on: the task contract and
 * base revision, the evidence snapshot, the frozen verification profile, its own proposal and the tree state Fusion produced
 * from it (the host application ledger), its changed paths and the policy version. Any other revision — a corrected proposal,
 * a mutated change — has another manifest, so its evidence can never stand in for this one's.
 */
export const proposalSha256 = (changes: ChangeSet): string => sha256Hex(canonicalChangeSetJson(changes));
/** The resulting tree state: each operation's path, kind and before/after digests, as Fusion applied it. */
export const patchSha256 = (applied: readonly AppliedOperation[]): string =>
  sha256Hex(canonicalJson(applied.map(op => ({ kind: op.kind, path: op.path, before: op.beforeSha256, after: op.afterSha256, bytes: op.bytes }))));

export interface ContractInput {
  readonly task: string;
  readonly baseCommit: string;
  readonly scope: readonly string[];
  /** Canonical JSON of the frozen delegation packet (the only task context any candidate author receives). */
  readonly packetJson: string;
}
export const contractSha256 = (input: ContractInput): string => sha256Hex(canonicalJson({ task: input.task, baseCommit: input.baseCommit,
  scope: [...input.scope].sort(), packet: sha256Hex(input.packetJson) }));

/** The authoritative evidence every candidate starts from: the baseline reproduction and a checked finding's basis, if any. */
export interface SnapshotInput {
  readonly baseCommit: string;
  readonly reproduction: Readonly<{ ran: boolean; commands: readonly Readonly<{ id: string; passed: boolean }>[] }>;
  readonly handoffBasis?: string;
}
export const snapshotSha256 = (input: SnapshotInput): string => sha256Hex(canonicalJson({ baseCommit: input.baseCommit,
  reproduction: { ran: input.reproduction.ran, commands: input.reproduction.commands.map(c => ({ id: c.id, passed: c.passed })) },
  handoffBasis: input.handoffBasis ?? null }));

export const CANDIDATE_MANIFEST_FORMAT = "fusion.candidateManifest" as const;
export interface CandidateManifest {
  readonly format: typeof CANDIDATE_MANIFEST_FORMAT;
  readonly version: 1;
  readonly tournamentId: string;
  readonly candidate: CandidateId;
  readonly strategy: string;
  readonly contractSha256: string;
  readonly snapshotSha256: string;
  readonly profileSha256: string;
  readonly proposalSha256: string;
  readonly patchSha256: string;
  readonly changedPaths: readonly string[];
  readonly policyVersion: string;
}
export function candidateManifest(input: Omit<CandidateManifest, "format" | "version">): Readonly<{ manifest: CandidateManifest; sha256: string }> {
  const manifest: CandidateManifest = deepFreeze({ format: CANDIDATE_MANIFEST_FORMAT, version: 1, ...input,
    changedPaths: [...input.changedPaths].sort() });
  return Object.freeze({ manifest, sha256: sha256Hex(canonicalJson(manifest)) });
}

export const TOURNAMENT_MANIFEST_FORMAT = "fusion.tournamentManifest" as const;
export interface TournamentManifest {
  readonly format: typeof TOURNAMENT_MANIFEST_FORMAT;
  readonly version: 1;
  readonly tournamentId: string;
  readonly runId: string;
  readonly baseCommit: string;
  readonly contractSha256: string;
  readonly snapshotSha256: string;
  readonly profileSha256: string;
  readonly independence: Independence;
  readonly candidates: readonly Readonly<{ id: CandidateId; state: string; manifestSha256: string | null }>[];
  readonly outcome: string;
  readonly selected: CandidateId | null;
  readonly revalidation: Readonly<{ passed: boolean; patchSha256: string | null }> | null;
}
export function tournamentManifest(input: Omit<TournamentManifest, "format" | "version">): Readonly<{ manifest: TournamentManifest; sha256: string }> {
  const manifest: TournamentManifest = deepFreeze({ format: TOURNAMENT_MANIFEST_FORMAT, version: 1, ...input });
  return Object.freeze({ manifest, sha256: sha256Hex(canonicalJson(manifest)) });
}
