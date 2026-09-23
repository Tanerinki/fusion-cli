import { meetsCapabilities } from "../capabilities.js";
import type { AgentRole, CapabilityRequirement, CapabilitySnapshot, ProviderAdapter, RoleBinding,
  WorkspacePosture } from "../domain.js";
import { FusionFailure } from "../errors.js";

/** The posture a role always runs with. Only the Worker may write, and only inside a workspace lease. */
export const ROLE_POSTURE: Readonly<Record<AgentRole, WorkspacePosture>> = Object.freeze({
  Lead: "readOnly", Worker: "writer", Explorer: "readOnly", Reviewer: "readOnly", Auditor: "readOnly",
});

/**
 * Requirements the workflow itself places on any binding for a posture, on top of the binding's configured
 * `requires`. A read-only role must be mechanically unable to write; a writer must be able to.
 */
export function postureRequirement(posture: WorkspacePosture): CapabilityRequirement {
  return posture === "writer"
    ? { structuredOutput: true, filesystem: { read: true, write: true } }
    : { structuredOutput: true, filesystem: { read: true, write: false } };
}

/**
 * One configured way to fill a role: a binding plus the adapter instance that serves it. Adapters have a fixed
 * posture per instance, so the same provider may appear in several candidates.
 */
export interface RoleCandidate {
  readonly binding: RoleBinding;
  readonly adapter: ProviderAdapter;
}
export type BindingRejection = "invalidCandidate" | "probeFailed" | "identityMismatch" | "requirementUnmet" | "postureUnmet";
/** Why each configured candidate for a role was ineligible, by configuration index. Never provider names. */
export interface BindingRejectionRecord { readonly index: number; readonly reason: BindingRejection }

/** Typed fail-closed routing failure: no configured binding satisfies the role's capability requirements. */
export class PolicyRoutingFailure extends FusionFailure {
  constructor(readonly role: AgentRole, readonly posture: WorkspacePosture,
    readonly rejections: readonly BindingRejectionRecord[]) {
    super({ kind: "CapabilityUnavailable", retryable: false, safeMessage: rejections.length === 0
      ? `No binding is configured for the ${role} role.`
      : `No configured binding for the ${role} role satisfies the ${posture} capability requirements.` });
    this.name = "PolicyRoutingFailure";
  }
}

export interface ResolvedRole {
  readonly role: AgentRole;
  readonly posture: WorkspacePosture;
  readonly binding: RoleBinding;
  readonly adapter: ProviderAdapter;
  readonly capabilities: CapabilitySnapshot;
}

/**
 * Picks the first candidate for `role`, in configuration order, whose observed capabilities satisfy both its
 * binding's requirements and the role's posture. Provider and model identities are opaque configuration: they are
 * only compared for equality against the adapter's own snapshot, never interpreted. Unknown never satisfies.
 */
export async function resolveRole(role: AgentRole, candidates: readonly RoleCandidate[]): Promise<ResolvedRole> {
  const posture = ROLE_POSTURE[role];
  const rejections: BindingRejectionRecord[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const binding: RoleBinding | undefined = candidate?.binding, adapter: ProviderAdapter | undefined = candidate?.adapter;
    if (binding === null || typeof binding !== "object" || binding.role !== role) continue;
    if (adapter === null || typeof adapter !== "object" || typeof adapter.capabilities !== "function" ||
        typeof binding.provider !== "string" || typeof binding.transport !== "string") {
      rejections.push({ index, reason: "invalidCandidate" }); continue;
    }
    let capabilities: CapabilitySnapshot;
    try { capabilities = await adapter.capabilities(); }
    catch { rejections.push({ index, reason: "probeFailed" }); continue; }
    if (capabilities === null || typeof capabilities !== "object" || capabilities.provider !== binding.provider ||
        capabilities.transport !== binding.transport) { rejections.push({ index, reason: "identityMismatch" }); continue; }
    if (!meetsCapabilities(capabilities, binding.requires ?? {})) { rejections.push({ index, reason: "requirementUnmet" }); continue; }
    if (!meetsCapabilities(capabilities, postureRequirement(posture))) { rejections.push({ index, reason: "postureUnmet" }); continue; }
    return Object.freeze({ role, posture, binding, adapter, capabilities });
  }
  throw new PolicyRoutingFailure(role, posture, Object.freeze(rejections));
}
