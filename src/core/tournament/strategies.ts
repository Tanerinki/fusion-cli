import type { DelegationPacket } from "../domain.js";
import type { CandidateId } from "./contracts.js";

/**
 * v0.5 — STRATEGY BRIEFS: bounded, Fusion-authored lines that ask independent candidate authors for different kinds of
 * solution, so a tournament is not two copies of one patch. A brief never names, hints at or favours an expected winner, and
 * never asks for artificial complexity: each ends by allowing the sound fix when no real alternative exists. Candidates that
 * still converge are recorded as CONVERGED — useful information, never proof.
 */
export const STRATEGY_BRIEFS: Readonly<Record<CandidateId, Readonly<{ id: string; brief: string }>>> = Object.freeze({
  c1: Object.freeze({ id: "direct", brief: "Strategy for this candidate: make the most direct fix of the stated problem, inside the confirmed scope." }),
  c2: Object.freeze({ id: "root-cause", brief: "Strategy for this candidate: fix the underlying cause so the problem cannot recur the same way, " +
    "inside the confirmed scope; when the direct fix already is that, make it." }),
  c3: Object.freeze({ id: "alternative", brief: "Strategy for this candidate: where a sound alternative to the most obvious fix exists inside " +
    "the confirmed scope, use it; otherwise make the sound fix." }),
});

/**
 * The frozen task contract as one candidate author receives it: the same packet for every candidate, plus its brief as one
 * more constraint. Nothing of another candidate — no proposal, reasoning, patch or result — is ever added.
 */
export function candidatePacket(frozen: DelegationPacket, id: CandidateId): DelegationPacket {
  return Object.freeze({ ...frozen, task: Object.freeze({ ...frozen.task,
    constraints: Object.freeze([...frozen.task.constraints, STRATEGY_BRIEFS[id].brief]) }) });
}
