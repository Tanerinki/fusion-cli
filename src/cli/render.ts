import type { DiagnosticRedactor } from "../core/policy/redaction.js";
import type { AuditReport, Diagnostics } from "../app/diagnostics.js";
import type { BuildPlan, BuildReport, ReviewReport } from "../app/commands.js";
import type { FusionConfig } from "../app/config.js";
import type { CreatePlan } from "../app/create.js";
import { BUILD_CONFIRMATION_WORD } from "../app/writer-gate.js";
import type { CommandOutcome } from "../app/outcome.js";
import type { RunSummary } from "../app/runs.js";
import { changeProposalReadiness } from "../app/readiness.js";

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
    if (p.role === "Worker") {
      const proposal = changeProposalReadiness(p.eligibility, p.inspection);
      lines.push(`  change proposal: implementation ${proposal.implementation}; live evidence ${proposal.liveEvidence}` +
        `${proposal.liveProbe ? ` (${proposal.liveProbe.milestone}, version ${proposal.liveProbe.runtimeVersion}, ${proposal.liveProbe.model}/${proposal.liveProbe.effort}: ${proposal.liveProbe.outcome})` : ""}; ` +
        `ready ${proposal.ready ? "yes" : "no"}`);
      for (const reason of proposal.reasons) lines.push(`    - ${reason}`);
    }
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

/** v0.1: the headline of a production build — what the human needs, then the details. */
function buildHeadline(report: BuildReport): string[] {
  const s = report.summary;
  if (s === undefined) return [];
  const passed = report.outcome.state === "COMPLETED" && report.delivery !== undefined;
  const rehearsal = report.outcome.state === "COMPLETED" && s.verification?.acceptance === "offlineRehearsal";
  const lines = [`Build: ${passed ? "PASS" : rehearsal ? "PASS (offline rehearsal — never delivered)" : report.outcome.state}`,
    `Verification: ${s.verification === null ? "not run" : `${s.verification.passed ? "PASS" : "FAIL"}${s.verification.backendId ? ` (${s.verification.backendId}, ` +
      `${s.verification.commands} command(s))` : ""}`}`,
    `Review: ${s.review.cycles === 0 ? "not run" : `${s.review.outstanding === 0 && report.outcome.state === "COMPLETED" ? "PASS" : "NOT PASSED"} ` +
      `(${s.review.cycles} cycle(s), ${s.review.findings} finding(s), ${s.review.outstanding} outstanding)`}`];
  if (report.delivery !== undefined) {
    const id = report.delivery.deliveryId;
    lines.push(`Delivery: ${id}`, "", "Next:", `  fusion inspect-delivery ${id}`, `  fusion approve-delivery ${id}`, `  fusion apply ${id}`,
      "Nothing was applied to your working tree: the delivery waits for your approval.", "");
  }
  return lines;
}

/** v0.1: the plan a human confirms before a Writer build starts any provider. */
export function renderBuildPlan(plan: BuildPlan, proposedBy?: string): string {
  return [`Build plan`, `Repository: ${plan.repository}`, `Task: ${plan.task}`,
    plan.paths.length === 0 ? "Scope: none (pass --path <file> for each file the build may write)"
      : `Scope (${proposedBy === undefined ? "given with --path" : `proposed by ${proposedBy}; confirm or rerun with --path`}): ${plan.paths.join(", ")}`,
    `Risk: ${plan.risk.level}${plan.risk.decisive.length > 0 ? ` (${plan.risk.decisive.join(", ")})` : ""}`,
    `Workflow: ${plan.intendedWorkflow.join(" → ")}`,
    `Providers: ${plan.roles.map(r => `${r.role} ${r.adapter} ${r.model}/${r.effort}`).join("; ") || "none configured"}`,
    `Verification: ${plan.verification.confinedCommands.length > 0 ? `confined commands ${plan.verification.confinedCommands.join(", ")}` : "no confined commands configured"} ` +
      `(${plan.verification.platformRequirement}; dependencies ${plan.verification.dependencies})`,
    "Fusion runs these providers read-only in copies of your repository, applies their proposals only to private candidates,",
    "verifies and reviews them, and prepares a delivery. Nothing touches your working tree until you approve and apply it.", ""].join("\n");
}
export const BUILD_QUESTION = `Type "${BUILD_CONFIRMATION_WORD}" to start (anything else cancels): `;

/** v0.1: what `fusion create` will do, before anything is written. */
export function renderCreatePlan(plan: CreatePlan, bindings: FusionConfig["bindings"]): string {
  const services = plan.services.map(s => `${s.label} (${s.variables.map(v => v.name).join(", ")})`);
  return ["Create plan", `Project: ${plan.name} (template ${plan.family}, ${plan.familySource === "default" ? "default — pass --template to choose" : plan.familySource})`,
    `Directory: ${plan.directory}`, "Stack: Node.js 22.18+ with TypeScript (type stripping) and node:test; no dependencies",
    `Services: ${services.length > 0 ? `${services.join(", ")} — configuration placeholders only, never credentials` : "none"}`,
    "Verification: the Node test runner in the confined container (linux-compatible)",
    `Providers: ${bindings.map(b => `${b.role} ${b.adapter} ${b.model}/${b.effort}`).join("; ") || "none configured"}`,
    "Then Fusion writes the template and a Git baseline into the new directory, asks the lead which files the project needs,",
    "and asks you to confirm that build; its result is a delivery you inspect, approve and apply.", ""].join("\n");
}
export const createQuestion = (directory: string): string => `Type "create" to create ${directory} (anything else cancels): `;

export function renderBuild(report: BuildReport): string {
  const lines = [...buildHeadline(report), `run: ${report.runId}`, `risk: ${report.risk.level} (${report.risk.decisive.join(", ") || "no signals"})`,
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
  // The Writer gate's prerequisites only when the gate stopped the build (a confirmed production build does not need them).
  if (report.writerRequired && report.outcome.code === report.writer.code)
    lines.push(`writer: ${report.writer.code}`, ...report.writer.prerequisites.map(p => `  - ${p.text}`));
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
