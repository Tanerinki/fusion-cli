import { canonicalChangeSetJson } from "../change/contract.js";
import type { ChangeScope } from "../domain.js";
import { failWith } from "../errors.js";
import type { WorkflowResult } from "../workflow/types.js";
import { deliveryBundleSha256, DELIVERY_BUNDLE_FORMAT, DELIVERY_BUNDLE_VERSION, validateDeliveryBundle, type DeliveryBundle } from "./bundle.js";
import { canonicalJson, sha256Hex } from "./canonical.js";
import { DELIVERY_FORBIDDEN_CLASSES, DELIVERY_LIMITS, DELIVERY_MANIFEST_FORMAT, DELIVERY_MANIFEST_VERSION, deliveryManifestSha256,
  deliveryPathViolation, platformFamily, validateDeliveryManifest, type DeliveryManifest, type DeliveryOperationKind } from "./manifest.js";

/** What a delivery is prepared from: a finished run's result, its identities and evidence digests, and the primary's identity. */
export interface DeliveryPreparationInput {
  readonly deliveryId: string;
  readonly runId: string;
  /** SHA-256 of the task request the run served. */
  readonly taskSha256: string;
  /** SHA-256 of the run's workflow evidence (its event record). */
  readonly workflowEvidenceSha256: string;
  readonly result: WorkflowResult;
  /** The run's write scope (Fusion's `writerChangeScope`). */
  readonly scope: ChangeScope;
  /** The primary as it was when the run's candidate was cloned: repository identity, baseline commit and tree. */
  readonly primary: Readonly<{ repositoryIdentity: string; baseCommit: string; baseTree: string }>;
  /** Repository-relative paths no delivery may touch (the composition passes the providers' workspace state paths). */
  readonly forbiddenPaths: readonly string[];
  readonly platform?: string;
}
export interface PreparedDelivery {
  readonly manifest: DeliveryManifest;
  readonly bundle: DeliveryBundle;
  readonly manifestSha256: string;
}

/**
 * O5.5C1: the manifest and bundle of a finished run. Only a `completed` run whose final verification passed under a GRANTED
 * confinement acceptance, with every review cycle resolved, qualifies — an offline rehearsal (fake providers, no acceptance)
 * never can. The bundle's bytes are the validated ChangeSet's own content, cross-checked against Fusion's host application
 * ledger (path, kind, before digest, after digest, size): exactly what was applied into the verified candidate, never a
 * model's regeneration. Provider text never enters: the review evidence is reduced to labels and a digest of labels.
 */
export function prepareDelivery(input: DeliveryPreparationInput): PreparedDelivery {
  const { result } = input;
  if (result.state !== "completed" || result.changeSet === undefined || result.applied === undefined || result.verification?.passed !== true)
    failWith("InvalidInput", "Only a completed, verified Writer run can be prepared for delivery.");
  const evidence = result.verification.evidence;
  if (evidence?.acceptance !== "granted")
    failWith("SecurityViolation", "Only a run verified under a granted confinement acceptance can be delivered; a rehearsal never can.");
  if (evidence.commands.length === 0 || evidence.commands.some(command => command.status !== "passed"))
    failWith("InvalidInput", "Every confined verification command of a delivered run must have passed.");
  const reviews = result.reviews;
  if (reviews.length > 0 && reviews.at(-1)!.outcome !== "clean")
    failWith("InvalidInput", "A delivered run's last review cycle must be clean.");
  const changes = result.changeSet, ledger = result.applied;
  if (ledger.length !== changes.operations.length) failWith("SecurityViolation", "The application ledger differs from the approved ChangeSet.");
  const bundleEntries: Array<{ index: number; path: string; sha256: string; bytes: number; content: Buffer }> = [];
  const operations = changes.operations.map((op, index) => {
    const entry = ledger[index]!;
    if (entry.path !== op.path || entry.kind !== op.kind || entry.beforeSha256 !== op.expectedSha256)
      failWith("SecurityViolation", "The application ledger differs from the approved ChangeSet.");
    const violation = deliveryPathViolation(op.path, input.forbiddenPaths);
    if (violation !== undefined) failWith("SecurityViolation", `A delivery never touches this path (${violation}).`);
    if (op.kind === "delete") {
      if (entry.afterSha256 !== null) failWith("SecurityViolation", "The application ledger differs from the approved ChangeSet.");
      return { index, kind: "delete" as DeliveryOperationKind, path: op.path, beforeSha256: op.expectedSha256, afterSha256: null, afterBytes: null };
    }
    const content = Buffer.from(op.content, "utf8"), digest = sha256Hex(content);
    if (entry.afterSha256 !== digest || entry.bytes !== content.length)
      failWith("SecurityViolation", "The application ledger differs from the approved ChangeSet's content.");
    bundleEntries.push({ index, path: op.path, sha256: digest, bytes: content.length, content });
    return { index, kind: (op.expectedSha256 === null ? "create" : "update") as DeliveryOperationKind, path: op.path,
      beforeSha256: op.expectedSha256, afterSha256: digest, afterBytes: content.length };
  });
  const bundle: DeliveryBundle = { format: DELIVERY_BUNDLE_FORMAT, version: DELIVERY_BUNDLE_VERSION, deliveryId: input.deliveryId, entries: bundleEntries };
  const labels = reviews.map(cycle => ({ cycle: cycle.cycle, outcome: cycle.outcome,
    findings: cycle.findings.map(f => ({ id: f.id, severity: f.severity, confidence: f.confidence })),
    adjudications: cycle.adjudications.map(a => ({ findingId: a.finding.id, verdict: a.verdict, requiredAction: a.requiredAction,
      verdictSource: a.verdictSource })) }));
  const raw = {
    format: DELIVERY_MANIFEST_FORMAT, version: DELIVERY_MANIFEST_VERSION, deliveryId: input.deliveryId,
    request: { runId: input.runId, taskSha256: input.taskSha256 },
    source: { workflowEvidenceSha256: input.workflowEvidenceSha256 },
    primary: { repositoryIdentity: input.primary.repositoryIdentity, baseCommit: input.primary.baseCommit, baseTree: input.primary.baseTree,
      cleanTree: "required", touched: operations.map(op => ({ path: op.path, exists: op.beforeSha256 !== null, sha256: op.beforeSha256 })) },
    operations,
    change: { changeSetSha256: sha256Hex(canonicalChangeSetJson(changes)), bundleSha256: deliveryBundleSha256(bundle),
      operationCount: operations.length, totalBytes: operations.reduce((sum, op) => sum + (op.afterBytes ?? 0), 0) },
    quality: {
      verification: { passed: true, acceptance: "granted", backendId: evidence.backendId, confinement: evidence.confinement,
        commands: evidence.commands.map(command => ({ id: command.id, status: command.status })),
        evidenceSha256: sha256Hex(canonicalJson({ passed: true, commandsRun: result.verification.commandsRun, backendId: evidence.backendId,
          confinement: evidence.confinement, platformRequirement: evidence.platformRequirement, acceptance: evidence.acceptance,
          ...(evidence.dependencies ? { dependencies: evidence.dependencies } : {}),
          commands: evidence.commands.map(command => ({ id: command.id, status: command.status, exitCode: command.exitCode })) })) },
      review: reviews.length === 0 ? { state: "notRequired", cycles: 0, findings: 0, outstanding: 0, labelsSha256: null }
        : { state: "clean", cycles: reviews.length, findings: reviews.reduce((sum, cycle) => sum + cycle.findings.length, 0), outstanding: 0,
          labelsSha256: sha256Hex(canonicalJson(labels)) },
      correction: { attempts: result.delegateAttempts, corrections: reviews.filter(cycle => cycle.outcome === "correction").length },
      providerText: "excluded",
    },
    safety: { allowedPaths: [...input.scope.allowedPaths], forbiddenPaths: [...new Set(input.forbiddenPaths)].sort(),
      forbiddenClasses: [...DELIVERY_FORBIDDEN_CLASSES], links: "refuse", ignoredPaths: "refuse",
      caps: { maxOperations: DELIVERY_LIMITS.maxOperations, maxFileBytes: DELIVERY_LIMITS.maxFileBytes, maxTotalBytes: DELIVERY_LIMITS.maxTotalBytes },
      platform: platformFamily(input.platform), scope: "localWorkingTree" },
  };
  const manifest = validateDeliveryManifest(raw);
  return Object.freeze({ manifest, bundle: validateDeliveryBundle(bundle, manifest), manifestSha256: deliveryManifestSha256(manifest) });
}
