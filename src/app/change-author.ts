import { changeScope } from "../core/change/contract.js";
import type { DelegationPacket, RunId, WorkspaceLeaseId } from "../core/domain.js";
import { FusionFailure } from "../core/errors.js";
import { resolveRole, type RoleCandidate } from "../core/policy/routing.js";
import type { VerificationReport } from "../platform/verification/engine.js";
import type { MutationLedgerEntry } from "../platform/workspace/change-applier.js";
import { PrivateWriterWorkspace } from "../platform/workspace/private-writer.js";

export interface HostChangeResult {
  readonly ledger: readonly MutationLedgerEntry[];
  readonly verification: VerificationReport;
}

/** Offline host path; production CLI still refuses autonomous Writer mode until all runtime gates are proven. */
export async function proposeApplyAndVerify(input: Readonly<{ candidates: readonly RoleCandidate[];
  workspace: PrivateWriterWorkspace; packet: DelegationPacket; runId: RunId; leaseId: WorkspaceLeaseId;
  signal?: AbortSignal }>): Promise<HostChangeResult> {
  const role = await resolveRole("Worker", input.candidates, undefined, { changeProposal: true });
  if (role.posture !== "readOnly" || typeof role.adapter.runChangeProposalTurn !== "function")
    throw new FusionFailure({ kind: "CapabilityUnavailable", retryable: false,
      safeMessage: "A read-only structured Change Author is required." });
  const session = await role.adapter.createSession({ runId: input.runId, role: "Worker", workspaceLeaseId: input.leaseId,
    posture: "readOnly", model: role.binding.model });
  try {
    if (session.posture !== "readOnly" || session.role !== "Worker")
      throw new FusionFailure({ kind: "SecurityViolation", retryable: false,
        safeMessage: "Change Author session posture differs from the routed read-only posture." });
    const turn = await role.adapter.runChangeProposalTurn(session,
      { kind: "changeProposal", packet: input.packet }, input.signal);
    if (turn.status !== "completed") throw new FusionFailure(turn.error);
    if (input.signal?.aborted)
      throw new FusionFailure({ kind: "Cancelled", retryable: false,
        safeMessage: "Change proposal was cancelled before host application." });
    const scope = changeScope(input.packet);
    const ledger = await input.workspace.applyChangeSet(input.workspace.ownerId, turn.output, scope);
    const verification = await input.workspace.verify(input.workspace.ownerId, ledger.map(entry => entry.path),
      undefined, process.env, input.signal);
    return { ledger, verification };
  } finally { await role.adapter.close(session); }
}
