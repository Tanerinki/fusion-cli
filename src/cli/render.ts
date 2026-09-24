import type { DiagnosticRedactor } from "../core/policy/redaction.js";
import type { AuditReport, Diagnostics } from "../app/diagnostics.js";
import type { BuildReport, ReviewReport } from "../app/commands.js";
import type { CommandOutcome } from "../app/outcome.js";
import type { RunSummary } from "../app/runs.js";

/**
 * Output is data from repositories, providers and users, so every string is redacted and terminal-safe: C0/C1 control
 * characters (including ESC, so no ANSI sequences) and bidirectional overrides are shown as `\u` escapes.
 */
export function terminalSafe(text: string, redactor: DiagnosticRedactor): string {
  return redactor.redactText(text).replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu,
    c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
/**
 * A single JSON document; values are redacted recursively before serialization. JSON already escapes C0 controls;
 * C1 controls and bidirectional overrides are escaped too, so the document is also safe to print to a terminal.
 */
export function jsonDocument(value: unknown, redactor: DiagnosticRedactor): string {
  return `${JSON.stringify(redactor.redact(value), null, 2).replace(/[\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu,
    c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}\n`;
}

const STATE_LINE = (outcome: CommandOutcome): string => `state: ${outcome.state}${outcome.pendingStage ? ` (pending: ${outcome.pendingStage})` : ""}`;
function outcomeLines(outcome: CommandOutcome): string[] {
  const lines = [STATE_LINE(outcome), outcome.message];
  if (outcome.state === "BLOCKED" && outcome.code === "CapabilityUnavailable")
    lines.push("hint: run `fusion doctor` to see which capability is unknown, unavailable or refused. Unknown is never treated as safe.");
  if (outcome.state === "FAILED" || outcome.state === "TIMED_OUT") lines.push(`code: ${outcome.code}`);
  return lines;
}
function findingLines(report: Readonly<{ reviews: ReviewReport["reviews"] }>): string[] {
  const lines: string[] = [];
  for (const cycle of report.reviews) {
    lines.push(`review cycle ${cycle.cycle}: ${cycle.findings.length} finding(s), outcome ${cycle.outcome}`);
    const verdicts = new Map(cycle.adjudications.map(a => [a.finding.id, a]));
    for (const f of cycle.findings) {
      const verdict = verdicts.get(f.id);
      lines.push(`  [${f.severity}] ${f.id} ${f.title}${f.file ? ` (${f.file}${f.lines ? `:${f.lines.start}-${f.lines.end}` : ""})` : ""}` +
        (verdict ? ` — ${verdict.verdict}${verdict.verdictSource === "fusionEvidence" ? " (Fusion evidence)" : ""}, action ${verdict.requiredAction}` : ""));
    }
  }
  return lines;
}

/** Human names for credential lanes; the identifiers stay the machine-readable form. */
const laneLabel = (lane: string): string => lane === "subscription" ? "subscription login"
  : lane === "subscriptionToken" ? "subscription OAuth token" : lane;

export function renderDoctor(d: Diagnostics): string {
  const lines = [`readiness: ${d.readiness.classes.join(", ")}`,
    `runtime: ${d.runtime.platform}, node ${d.runtime.nodeVersion}, git ${d.runtime.git}`,
    `repository: ${d.repository.detected ? `${d.repository.branch ?? (d.repository.unborn ? "unborn" : "detached")}; ` +
      `${d.repository.changes.staged} staged, ${d.repository.changes.unstaged} unstaged, ${d.repository.changes.untracked} untracked, ` +
      `${d.repository.changes.conflicted} conflicted` : "not detected"}`,
    `config: ${d.config.state}${d.config.source ? ` (${d.config.source})` : ""}${d.config.error ? `: ${d.config.error}` : ""}`,
    `storage: ${d.storage.state}`, `workspace leases: ${d.workspaceLease.state}${d.workspaceLease.reasons.length ? ` (${d.workspaceLease.reasons.join(" ")})` : ""}`,
    `verification: ${d.verification.state} (${d.verification.commands} command(s))`];
  for (const p of d.providers) {
    const i = p.inspection;
    lines.push(`binding ${p.index}: ${p.role} via ${p.adapter} (${p.identity.requested}) — executable ${i?.executable ?? "unknown"}, ` +
      `version ${i?.runtimeVersion ?? "unknown"}, billing guard ${i?.billing.state ?? "unknown"}` +
      `${i?.billing.candidateLane ? ` (candidate lane: ${laneLabel(i.billing.candidateLane)}; unverified until probed)` : ""}` +
      `${i && i.billing.reasons.length ? ` [${i.billing.reasons.join("; ")}]` : ""}${p.inspectionError ? `, ${p.inspectionError}` : ""}`);
    lines.push(`  capabilities: ${Object.entries(p.capabilities).map(([k, v]) => `${k}=${v}`).join(" ")}; structured turns ${i?.structuredTurns ? "yes" : "no"}`);
    lines.push(`  posture evidence: ${p.postureEvidence === "launchTime" ? "launch-time (enforced before any session; re-checked each turn)"
      : p.postureEvidence === "observedSession" ? "observed in a session" : "none (posture unproven)"}`);
    lines.push(`  read-only: ${p.eligibility.readOnly.state}; review: ${p.eligibility.review.state}; writer: ${p.eligibility.writer.state}`);
    for (const reason of new Set([...p.eligibility.readOnly.reasons, ...p.eligibility.review.reasons])) lines.push(`    - ${reason}`);
    if (p.probe) lines.push(`  probe: ${"auth" in p.probe ? `auth ${p.probe.auth.state} (${laneLabel(p.probe.auth.lane)})` +
      `${p.probe.auth.state === "authenticated" ? "" : ` — ${p.probe.auth.detail}`}` : `failed: ${p.probe.error}`}`);
    for (const control of i?.controls ?? []) lines.push(`  control ${control.name}: ${control.state} — ${control.detail}`);
  }
  if (d.providers.length === 0) lines.push("bindings: none configured");
  lines.push(`roles: ${Object.entries(d.roles).map(([role, e]) => role === "Worker" ? `Worker writer=${e.writer}`
    : `${role} read-only=${e.readOnly} review=${e.review}`).join("; ")}`);
  const platform = d.verificationPlatform.assessment;
  lines.push(`verification platform: declared ${platform.declared}, effective ${platform.effective}` +
    `${platform.signals.length ? ` (${platform.signals.length} escalation signal(s): ${platform.signals.slice(0, 4).map(s => s.code).join(", ")})` : ""}`);
  for (const backend of d.verificationPlatform.autonomousBackends)
    lines.push(`  autonomous verification via ${backend.backendId}: ${backend.eligible ? "eligible (availability is checked at run time)" : `refused (${backend.reason})`}`);
  lines.push(`writer: ${d.writer.code}`, ...d.writer.prerequisites.map(p => `  - ${p.text}`));
  lines.push(`writer gates (live gate authorized: ${d.writerGates.liveGateAuthorized ? "yes" : "no"}):`,
    ...d.writerGates.rows.map(row => `  ${row.id}: ${row.state} [${row.evidenceKind}] — ${row.remainingBlocker}`));
  if (!d.probed) lines.push("note: providers were inspected statically; run `fusion doctor --probe` to read back auth.");
  return `${lines.join("\n")}\n`;
}

export function renderAudit(report: AuditReport): string {
  const lines = [`audit: ${report.status} (${report.items.length} item(s))`];
  for (const item of report.items) lines.push(`[${item.severity}] ${item.area}: ${item.title} — ${item.detail}`);
  const classes = Object.entries(report.sensitiveFiles);
  if (classes.length > 0) lines.push(`risk-sensitive tracked files: ${classes.map(([k, v]) => `${k}=${v}`).join(", ")}`);
  lines.push(`readiness: ${report.diagnostics.readiness.classes.join(", ")}`);
  return `${lines.join("\n")}\n`;
}

export function renderReview(report: ReviewReport): string {
  const lines = [`review of changes since ${report.base.label} (${report.change.paths} path(s)${report.change.truncated ? ", evidence truncated" : ""})`];
  if (report.runId) lines.push(`run: ${report.runId}`);
  if (report.risk) lines.push(`risk: ${report.risk}`);
  lines.push(...findingLines(report), ...outcomeLines(report.outcome));
  for (const u of report.unavailable) lines.push(`unavailable binding ${u.index} (${u.role}): ${u.reason}`);
  return `${lines.join("\n")}\n`;
}

export function renderBuild(report: BuildReport): string {
  const lines = [`run: ${report.runId}`, `risk: ${report.risk.level} (${report.risk.decisive.join(", ") || "no signals"})`,
    `intended workflow: ${report.intendedWorkflow.join(" → ")}`, `writer required: ${report.writerRequired ? "yes" : "no"}`];
  lines.push(...findingLines(report), ...outcomeLines(report.outcome));
  const r = report.rehearsal;
  if (r) {
    lines.push(`offline rehearsal: ${r.delegateAttempts} attempt(s), ${r.corrections} correction(s), ${r.operations} host-applied ` +
      `operation(s) on ${r.changedPaths.length} file(s)`);
    if (r.verification) lines.push(`  verification: ${r.verification.passed ? "passed" : "not passed"}` +
      `${r.verification.backendId ? ` on ${r.verification.backendId} (${r.verification.acceptance ?? "unknown"})` : ""}` +
      `${r.verification.refusal ? `, refused: ${r.verification.refusal}` : ""}`);
    if (r.cleanup) lines.push(`  candidates: ${r.cleanup.released}/${r.cleanup.candidates} released${r.cleanup.complete ? "" : " (INCOMPLETE)"}`);
  }
  if (report.writerRequired) lines.push(`writer: ${report.writer.code}`, ...report.writer.prerequisites.map(p => `  - ${p.text}`));
  for (const u of report.unavailable) lines.push(`unavailable binding ${u.index} (${u.role}): ${u.reason}`);
  return `${lines.join("\n")}\n`;
}

export function renderRun(summary: RunSummary): string {
  const outcome = summary.outcome as { state?: string; code?: string; message?: string; pendingStage?: string } | undefined;
  const lines = [`run: ${summary.runId} (${summary.command})`, `status: ${summary.status}${outcome?.state ? `, state ${outcome.state}` : ""}` +
    `${outcome?.pendingStage ? ` (pending: ${outcome.pendingStage})` : ""}`, `created: ${summary.createdAt}`];
  if (summary.completedAt) lines.push(`completed: ${summary.completedAt}`);
  if (summary.risk) lines.push(`risk: ${summary.risk}`);
  if (summary.finalWorkflowState) lines.push(`workflow: ${summary.finalWorkflowState} after ${summary.transitions} transition(s)`);
  if (outcome?.message) lines.push(outcome.message);
  for (const f of summary.findings) lines.push(`  [${f.severity}] ${f.id} ${f.title}${f.verdict ? ` — ${f.verdict}` : ""}`);
  if (summary.eventLog === "truncated") lines.push("note: the event log ends in a truncated line; inspect before relying on it.");
  return `${lines.join("\n")}\n`;
}
