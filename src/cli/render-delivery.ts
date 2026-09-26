import type { DeliveryApplyPlan, DeliveryApplyReport, DeliveryInspection } from "../app/delivery-service.js";

/**
 * O5.5C2 — terminal views of a stored delivery. Plain data in, text out; the caller makes every line terminal-safe and
 * redacted (`terminalSafe`). Digests are always printed in full: a human compares and types them.
 */
const LETTER = { create: "A", update: "M", delete: "D" } as const;
const hash = (value: string | null): string => value === null ? "none" : `sha256:${value}`;
const counts = (i: DeliveryInspection): string =>
  `${i.counts.create} create, ${i.counts.update} update, ${i.counts.delete} delete`;
const changeLines = (i: DeliveryInspection): string[] => i.files.map(f => `  ${LETTER[f.kind]} ${f.path}`);

export function renderDeliveryInspection(i: DeliveryInspection): string {
  const v = i.verification, r = i.review, s = i.safety;
  const lines = [`Delivery: ${i.deliveryId}`, `State: ${i.state}`, `Manifest: sha256:${i.manifestSha256}`, `Bundle: sha256:${i.bundleSha256}`,
    `Target: repository sha256:${i.target.repositoryIdentity}`, `  base ${i.target.baseCommit} (tree ${i.target.baseTree}), clean tree ${i.target.cleanTree}`,
    `Changes: ${counts(i)}`, ...changeLines(i),
    `Verification: ${v.passed ? "PASS" : "FAIL"} (${v.backendId}, ${v.confinement}, ${v.commands.length} command(s), acceptance ${v.acceptance})`,
    `Review: ${r.state === "clean" ? "CLEAN" : "NOT REQUIRED"} (${r.cycles} cycle(s), ${r.findings} finding(s) adjudicated, ${r.outstanding} outstanding)`,
    `Correction: ${i.correction.corrections} correction(s) in ${i.correction.attempts} attempt(s)`,
    `Safety: scope ${s.scope}, platform ${s.platform}, links ${s.links}, ignored paths ${s.ignoredPaths}; ` +
      `caps ${s.caps.maxOperations} operation(s), ${s.caps.maxFileBytes} bytes/file, ${s.caps.maxTotalBytes} bytes total`,
    `  allowed paths: ${s.allowedPaths.length}; forbidden paths: ${s.forbiddenPaths.join(", ") || "none"}; forbidden classes: ${s.forbiddenClasses.join(", ")}`,
    i.approval === null ? "Approved: NO"
      : `Approved: ${i.approval.approved ? "YES" : "PENDING"} (covers manifest sha256:${i.approval.manifestSha256} and bundle ` +
        `sha256:${i.approval.bundleSha256} in this checkout; ${i.approval.confirmation} at ${i.approval.approvedAt})`,
    `Mutation claim: ${i.mutationClaimed ? "taken (the approval is spent)" : "none"}${i.attemptLocked ? "; an apply attempt is running or was interrupted" : ""}`,
    `Events: ${i.events.map(e => e.type).join(" → ") || "none"}`];
  for (const f of i.files) {
    lines.push("", `${LETTER[f.kind]} ${f.path}`, `  before: ${hash(f.beforeSha256)}`,
      `  after:  ${hash(f.afterSha256)}${f.afterBytes === null ? "" : ` (${f.afterBytes} bytes)`}`);
    if (f.diffStatus === "rendered") lines.push(...f.diff.map(line => `  ${line}`), ...(f.diffTruncated ? ["  … (diff truncated)"] : []));
    else lines.push(`  (no diff shown: ${f.diffStatus === "binary" ? "binary content" : f.diffStatus === "tooLarge" ? "too large"
      : "the baseline preimage could not be read and verified"})`);
  }
  return `${lines.join("\n")}\n`;
}

/** What a human sees before typing the digest; the question itself is asked by the prompt. */
export function renderApprovalSummary(i: DeliveryInspection): string {
  return [`Approve delivery ${i.deliveryId}`, `Manifest SHA-256: ${i.manifestSha256}`, `Bundle SHA-256: ${i.bundleSha256}`,
    `Target: repository sha256:${i.target.repositoryIdentity}`, `Target HEAD: ${i.target.baseCommit} (must be unchanged, clean tree required)`,
    `Operations: ${counts(i)}`, ...changeLines(i),
    `Verification: PASS; Review: ${i.review.state === "clean" ? "CLEAN" : "NOT REQUIRED"}`,
    "This approval covers only this exact manifest digest (and the bundle it names), in this checkout. It authorizes one",
    "`fusion apply`: that apply still runs the full precheck first, and any change to the delivery invalidates the approval.",
    "Run `fusion inspect-delivery` first to read the diff.", ""].join("\n");
}
export const APPROVAL_QUESTION = "Type the exact manifest digest to approve: ";

/** What `fusion apply` shows before its precheck: the approved delivery, the bound checkout and what will change. */
export function renderApplyPlan(plan: DeliveryApplyPlan): string {
  return [`Apply delivery ${plan.deliveryId}`, `Manifest SHA-256: ${plan.manifestSha256}`, `Target checkout: ${plan.checkout}`,
    `  bound checkout sha256:${plan.checkoutSha256}`, `Expected HEAD: ${plan.expectedHead}`,
    `Operations: ${plan.counts.create} create, ${plan.counts.update} update, ${plan.counts.delete} delete`,
    `Approval: human-confirmed (${plan.approval.confirmation}) at ${plan.approval.approvedAt}, for this delivery and checkout only` +
      `${plan.failedPrechecks > 0 ? `; ${plan.failedPrechecks} earlier precheck(s) refused` : ""}`,
    "Precheck first: nothing is written unless every check passes.", ""].join("\n");
}

export function renderApplyReport(report: DeliveryApplyReport): string {
  const lines = [`Delivery: ${report.deliveryId}`, `Manifest: sha256:${report.manifestSha256}`,
    `Result: ${report.result}${report.phase === null ? "" : ` (phase ${report.phase})`}`];
  if (report.reason !== null) lines.push(report.reason);
  if (report.observedHead !== null) lines.push(`Observed HEAD: ${report.observedHead}`);
  for (const op of report.operations)
    lines.push(`  ${LETTER[op.kind]} ${op.path}: ${op.applied ? "applied" : "not applied"}${op.restored === null ? "" : op.restored ? ", restored" : ", NOT restored"}`);
  for (const issue of report.issues.slice(0, 16)) lines.push(`  issue: ${issue.reason}${issue.path === undefined ? "" : ` (${issue.path})`}`);
  if (report.result === "rollbackFailed")
    lines.push("The rollback did not restore every file: inspect the working tree; the staging area is kept for recovery.");
  if (report.result === "precheckFailed")
    lines.push("Nothing was written and the approval is kept: resolve the drift above, then run `fusion apply` again.");
  else if (report.claimed || (report.result === "failed" && !report.approvalKept))
    lines.push("The approval is spent (its one mutation claim was taken): a retry needs a new delivery and a new human approval.");
  if (!report.evidenceRecorded) lines.push(`Evidence: NOT recorded — the result above stands, but the delivery's event log could not be appended.`);
  return `${lines.join("\n")}\n`;
}
