import { meetsCapabilities } from "../capabilities.js";
import type { AgentRole, CapabilityRequirement, CapabilitySnapshot, ProviderAdapter, RoleBinding,
  WorkspacePosture } from "../domain.js";
import { FusionFailure } from "../errors.js";

/** Legacy O3 default postures. A Change Author Worker explicitly routes read-only via `changeProposal`. */
export const ROLE_POSTURE: Readonly<Record<AgentRole, WorkspacePosture>> = Object.freeze({
  Lead: "readOnly", Worker: "writer", Explorer: "readOnly", Reviewer: "readOnly", Auditor: "readOnly",
});

/** Facts a real Writer adapter must prove independently of its model name and read-only review posture. */
export const WRITER_ISOLATION: CapabilityRequirement = Object.freeze({
  modelIdentityReadback: true, subscriptionLaneReadback: true, protocolCancellation: true,
  approvalEscalationDisabled: true, personalContextDisabled: true, extensionsQuarantined: true,
  writerIsolation: Object.freeze({ workspaceScopedWrites: true, primaryWorkspaceInaccessible: true,
    gitPushDisabled: true, forcePushDisabled: true, credentialOverrideBlocked: true,
    boundedCommands: true, approvalPolicyKnown: true, processTreeSupervised: true,
    workspaceIdentityReadback: true }),
});

/**
 * Requirements the workflow itself places on any binding for a posture, on top of the binding's configured
 * `requires`. A read-only role must be mechanically unable to write through its file tools; the legacy direct writer
 * path retains its separate isolation requirement. Shell and network are constrained by `surfaceViolation`.
 */
export function postureRequirement(posture: WorkspacePosture): CapabilityRequirement {
  return posture === "writer"
    ? { structuredOutput: true, filesystem: { read: true, write: true }, ...WRITER_ISOLATION }
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
export type BindingRejection = "invalidCandidate" | "probeFailed" | "identityMismatch" | "requirementUnmet" | "postureUnmet" |
  "capabilityExceedsTask" | "structuredTurnUnsupported" | "workspaceBindingUnsupported";
/**
 * Role needs beyond the posture. Fresh review and adjudication require structured (non-packet) turns and review
 * isolation (`REVIEW_ISOLATION`), both established before the role's first turn.
 */
export interface RoleNeeds {
  readonly structuredTurns?: boolean;
  readonly reviewIsolation?: boolean;
  /** Worker proposes a ChangeSet under read-only tools; Fusion owns subsequent mutation. */
  readonly changeProposal?: boolean;
  /** Every session runs in a Fusion-owned provider view: the adapter must honor a per-session workspace root. */
  readonly workspaceBinding?: boolean;
}
/**
 * Isolation a fresh Reviewer or adjudicating Lead needs on top of the strict read-only surface: no approval path can
 * widen the posture, no personal/foreign context or extension surface reaches the turn, and the provider reads back
 * its model identity and subscription lane. Only capability facts count; provider output never establishes them.
 */
export const REVIEW_ISOLATION: CapabilityRequirement = Object.freeze({
  approvalEscalationDisabled: true, personalContextDisabled: true, extensionsQuarantined: true,
  modelIdentityReadback: true, subscriptionLaneReadback: true,
});
/**
 * A Change Author additionally runs without shell or web tools, and only ever in the Fusion-owned view it is given:
 * never the primary checkout, never the private candidate Fusion applies into.
 */
export const CHANGE_PROPOSAL_REQUIREMENT: CapabilityRequirement = Object.freeze({
  ...postureRequirement("readOnly"), ...REVIEW_ISOLATION, shell: Object.freeze({ available: false }),
  webToolsDisabled: true, workspaceBinding: true,
});

/**
 * The capability surface the risk gate assessed for a task. A role may not hold more than this: the default
 * grants no shell and no network, so an omitted surface can only make routing stricter.
 */
export interface TaskCapabilitySurface {
  readonly shell: boolean;
  readonly network: boolean;
}
export const NO_EXTRA_CAPABILITIES: TaskCapabilitySurface = Object.freeze({ shell: false, network: false });

/**
 * Observed capabilities beyond the posture. A shell (or one that cannot be proven absent) is only acceptable when
 * the task requested it, and for a read-only role only when the adapter reports it sandboxed. Model-facing web
 * tools must be mechanically disabled unless the task requested network access. `null` means acceptable.
 */
export function surfaceViolation(posture: WorkspacePosture, capabilities: CapabilitySnapshot,
  surface: TaskCapabilitySurface): BindingRejection | null {
  const shell: unknown = capabilities.shell;
  if (shell === null || typeof shell !== "object") return "postureUnmet";
  const { available, sandboxed } = shell as CapabilitySnapshot["shell"];
  if (available !== false) {
    if (!surface.shell) return "capabilityExceedsTask";
    if (posture === "readOnly" && sandboxed !== true) return "postureUnmet";
  }
  if (capabilities.webToolsDisabled !== true && !surface.network) return "capabilityExceedsTask";
  return null;
}
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
 * Picks the first candidate for `role`, in configuration order, whose observed capabilities satisfy its binding's
 * requirements, the role's posture and the task's assessed capability surface. Provider and model identities are
 * opaque configuration: they are only compared for equality against the adapter's own snapshot, never interpreted.
 * Unknown never satisfies.
 */
export async function resolveRole(role: AgentRole, candidates: readonly RoleCandidate[],
  surface: TaskCapabilitySurface = NO_EXTRA_CAPABILITIES, needs: RoleNeeds = {}): Promise<ResolvedRole> {
  const posture = role === "Worker" && needs.changeProposal === true ? "readOnly" : ROLE_POSTURE[role];
  if (needs.changeProposal === true && (role !== "Worker" || surface.shell || surface.network))
    throw new PolicyRoutingFailure(role, posture, []);
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
    if (needs.changeProposal === true && (!meetsCapabilities(capabilities, CHANGE_PROPOSAL_REQUIREMENT) ||
        typeof adapter.runChangeProposalTurn !== "function")) {
      rejections.push({ index, reason: "postureUnmet" }); continue;
    }
    const violation = surfaceViolation(posture, capabilities, surface);
    if (violation !== null) { rejections.push({ index, reason: violation }); continue; }
    if (needs.reviewIsolation === true && !meetsCapabilities(capabilities, REVIEW_ISOLATION)) {
      rejections.push({ index, reason: "postureUnmet" }); continue;
    }
    if (needs.structuredTurns === true && typeof adapter.runStructuredTurn !== "function") {
      rejections.push({ index, reason: "structuredTurnUnsupported" }); continue;
    }
    if (needs.workspaceBinding === true && !meetsCapabilities(capabilities, { workspaceBinding: true })) {
      rejections.push({ index, reason: "workspaceBindingUnsupported" }); continue;
    }
    return Object.freeze({ role, posture, binding, adapter, capabilities });
  }
  throw new PolicyRoutingFailure(role, posture, Object.freeze(rejections));
}
