import { readFile } from "node:fs/promises";
import { sha256Hex } from "../core/delivery/canonical.js";
import type { WorkflowResult } from "../core/workflow/types.js";
import type { ControlPlane } from "./control-plane.js";
import { deliveryRepository, prepareStoredDelivery } from "./delivery-service.js";

/**
 * v0.1 — the last step of `fusion build`: a completed Writer run becomes a prepared DELIVERY (never applied).
 *
 * Only what the real preparation path accepts is delivered: a completed run, verified under a GRANTED confinement
 * acceptance (an offline rehearsal never can), with every review cycle resolved. The delivery carries the exact validated
 * ChangeSet bytes (no model regeneration), is bound to this checkout and its HEAD at the start of the run (a HEAD that moved
 * refuses), and references the run's recorded evidence by the SHA-256 of its event log. The human then reads it
 * (`fusion inspect-delivery`), approves it by typing its digest (`fusion approve-delivery`) and applies it (`fusion apply`).
 */
export interface BuildDelivery {
  readonly deliveryId: string;
  readonly manifestSha256: string;
}
export async function prepareBuildDelivery(plane: ControlPlane, input: Readonly<{ runId: string; task: string; result: WorkflowResult;
  baseCommit: string; eventLogPath: string; signal?: AbortSignal }>): Promise<BuildDelivery> {
  const repository = await deliveryRepository(plane);
  const evidence = await readFile(input.eventLogPath);
  const paths = input.result.changeSet?.operations.map(op => op.path) ?? [];
  const prepared = await prepareStoredDelivery({ runId: input.runId, taskSha256: sha256Hex(input.task), workflowEvidenceSha256: sha256Hex(evidence),
    result: input.result, scope: { allowedPaths: paths, forbiddenPaths: [] }, baseCommit: input.baseCommit, primaryRoot: repository.root,
    git: repository.git, storeBase: repository.storeBase, ...(input.signal ? { signal: input.signal } : {}) });
  return Object.freeze({ deliveryId: prepared.deliveryId, manifestSha256: prepared.manifestSha256 });
}
