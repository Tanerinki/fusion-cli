import type { ChangeScope } from "../core/domain.js";
import { failWith } from "../core/errors.js";
import { prepareDelivery, type PreparedDelivery } from "../core/delivery/prepare.js";
import type { WorkflowResult } from "../core/workflow/types.js";
import { LocalFilesystemDeliveryApplier, readPrimaryIdentity, type DeliveryFaults } from "../platform/delivery/applier.js";
import type { GitClient } from "../platform/workspace/git.js";
import { providerWorkspaceStatePaths } from "../runtime/provider-profiles.js";

/**
 * O5.5C1 — the delivery composition, INTERNAL (no command uses it yet). It fixes the future integration shape:
 *
 *   fusion build "..."          -> a private verified result -> `prepareRunDelivery` (manifest + bundle, state `prepared`)
 *   fusion inspect-delivery <id> -> `deliveryPreview` and the evidence digests, for a human to read
 *   fusion apply <id>            -> an explicit human approval of the exact manifest digest -> `deliveryApplier().apply`
 *                                   (precheck, stage, apply, postcheck, rollback)
 *
 * None of these commands exists: O5.5C1 has no human approval authority (only the test-only one), so no real delivery can
 * be approved, and `REAL_WRITER_LIVE_GATE_AUTHORIZED` stays false. The composition supplies what the provider-neutral core
 * and platform cannot name: the registered providers' workspace state paths, which every manifest must forbid.
 */

/**
 * The delivery of a finished run into the primary it ran against: the primary's identity is read (read-only Git) and its
 * HEAD must still be the run's baseline commit; then the manifest and bundle are prepared from the run's result.
 */
export async function prepareRunDelivery(input: Readonly<{ deliveryId: string; runId: string; taskSha256: string; workflowEvidenceSha256: string;
  result: WorkflowResult; scope: ChangeScope; baseCommit: string; primaryRoot: string; git: GitClient; signal?: AbortSignal }>): Promise<PreparedDelivery> {
  const identity = await readPrimaryIdentity(input.primaryRoot, input.git, input.signal);
  if (identity.headCommit !== input.baseCommit)
    failWith("WorkspaceConflict", "The primary's HEAD is no longer the run's baseline; a delivery needs a run against the current HEAD.");
  return prepareDelivery({ deliveryId: input.deliveryId, runId: input.runId, taskSha256: input.taskSha256,
    workflowEvidenceSha256: input.workflowEvidenceSha256, result: input.result, scope: input.scope,
    primary: { repositoryIdentity: identity.repositoryIdentity, baseCommit: identity.headCommit, baseTree: identity.headTree },
    forbiddenPaths: providerWorkspaceStatePaths() });
}

/**
 * The local applier with the providers' state paths as required forbidden paths. `git` must be an isolated-config client
 * (hooks and fsmonitor off, no global or system configuration). `faults` is a test seam only.
 */
export function deliveryApplier(git: GitClient, faults?: DeliveryFaults): LocalFilesystemDeliveryApplier {
  return new LocalFilesystemDeliveryApplier({ git, requiredForbiddenPaths: providerWorkspaceStatePaths(), ...(faults ? { faults } : {}) });
}
