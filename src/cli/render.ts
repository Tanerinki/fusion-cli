import type { DiagnosticRedactor } from "../core/policy/redaction.js";
import type { AuditReport, Diagnostics } from "../app/diagnostics.js";
import type { BuildPlan, BuildReport, ReviewReport } from "../app/commands.js";
import type { FusionConfig } from "../app/config.js";
import type { ConfigReport } from "../app/config-report.js";
import type { CreatePlan } from "../app/create.js";
import type { DecisionRequest } from "../core/workflow/decision.js";
import type { History, RunEntry } from "../app/history.js";
import { BUILD_CONFIRMATION_WORD } from "../app/writer-gate.js";
import type { CommandOutcome } from "../app/outcome.js";
import type { RunSummary } from "../app/runs.js";
import type { BuildTournamentSummary } from "../app/tournament/build.js";
import type { TieChoice } from "../app/tournament/run.js";
import { changeProposalReadiness } from "../app/readiness.js";
import type { BuildEvidence } from "../core/evidence/build.js";
import { obligationLabel, obligationWord } from "../core/evidence/obligations.js";

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
    `verification: ${d.verification.state} (${d.verification.commands} read-only command(s)); confined build plan: ` +
      `${d.verification.confinedCommands} command(s), platform ${d.verification.platformRequirement}`];
  if (d.readiness.classes.includes("WRITER_NOT_READY"))
    lines.splice(1, 0, "note: WRITER_NOT_READY concerns UNATTENDED Writer mode, which stays off. fusion build and fusion create run Writer builds " +
      "you confirm; they need a confined build plan and a running Docker verifier (fusion config shows the plan).");
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
    if (p.probe && "auth" in p.probe && p.probe.posture)
      lines.push(`  runtime posture ${p.probe.posture.version}: ${p.probe.posture.state === "refused" ? "NOT VERIFIED" : p.probe.posture.state} — ${p.probe.posture.detail}`);
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
  const win = d.writerGates.verificationIsolation.windows;
  lines.push(`Windows isolation evidence: ${win.evidenceState}`,
    `Windows confined verification backend: ${win.registrationState} (runtime: ${win.runtimeState})`,
    `Windows verification readiness: ${win.effectiveState}` +
      (win.runtimeState === "notProbed" ? " — run `fusion doctor --probe` to establish the runtime" : ""));
  lines.push(`writer gates (live gate authorized: ${d.writerGates.liveGateAuthorized ? "yes" : "no"}):`,
    ...d.writerGates.rows.map(row => `  ${row.id}: ${row.state} [${row.evidenceKind}] — ${row.remainingBlocker}`));
  if (!d.probed) lines.push("note: providers were inspected statically; run `fusion doctor --probe` to read back auth and check each runtime's " +
    "read-only posture (no model call).");
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

/**
 * v0.4: Fusion's evidence decision as a human reads it: every proof obligation with its word and Fusion's reason, then the
 * decision. Fusion's own observations only; model output is never listed as evidence.
 */
export function evidenceLines(evidence: BuildEvidence): string[] {
  const { plan, decision } = evidence;
  const lines = ["Evidence (Fusion's own observations; model output is not evidence):"];
  for (const o of decision.obligations) {
    const label = obligationLabel(o.kind, plan.profile.taskClass, plan.objective);
    const word = obligationWord(o.kind, o.status);
    lines.push(`  ${label} ${".".repeat(Math.max(2, 23 - label.length))} ${word.padEnd(14)} ${o.reason}`);
  }
  const open = decision.obligations.filter(o => o.status !== "PASS").length;
  lines.push(`Decision: ${decision.decision}${decision.decision === "VERIFIED" ? ` (${decision.obligations.length} of ${decision.obligations.length} obligations)`
    : decision.deliverable ? ` — ${open} obligation(s) not established; the change can be delivered only for your decision`
    : ` — ${open} obligation(s) not established; no delivery`}${decision.overflowed ? " (the evidence record hit its bound)" : ""}`);
  return lines;
}

/** v0.1: the headline of a production build — what the human needs, then the details. */
function buildHeadline(report: BuildReport, expertNext = true): string[] {
  const s = report.summary;
  if (s === undefined) return report.evidence === undefined ? [] : [...evidenceLines(report.evidence), ""];
  const passed = report.outcome.state === "COMPLETED" && report.delivery !== undefined;
  const verified = report.evidence === undefined || report.evidence.decision.decision === "VERIFIED";
  const rehearsal = report.outcome.state === "COMPLETED" && s.verification?.acceptance === "offlineRehearsal";
  const lines = [`Build: ${passed ? (verified ? "PASS" : "UNVERIFIED (delivered only for your decision)") : rehearsal
    ? "PASS (offline rehearsal — never delivered)" : report.outcome.state}`,
    `Verification: ${s.verification === null ? "not run" : `${s.verification.passed ? "PASS" : "FAIL"}${s.verification.backendId ? ` (${s.verification.backendId}, ` +
      `${s.verification.commands} command(s))` : ""}`}`,
    `Review: ${s.review.cycles === 0 ? "not run" : `${s.review.outstanding === 0 && report.outcome.state === "COMPLETED" ? "PASS" : "NOT PASSED"} ` +
      `(${s.review.cycles} cycle(s), ${s.review.findings} finding(s), ${s.review.outstanding} outstanding)`}`,
    ...(report.evidence === undefined ? [] : evidenceLines(report.evidence))];
  if (report.delivery !== undefined) {
    const id = report.delivery.deliveryId;
    // v0.2.3: the shell offers the one-step approval itself right after; the expert commands are for `fusion build`.
    lines.push(`Delivery: ${id}`, "", ...(expertNext ? ["Next:", `  fusion inspect-delivery ${id}`, `  fusion approve-delivery ${id}`, `  fusion apply ${id}`] : []),
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
    // v0.5: several candidates are several full private builds; the number is part of what you confirm.
    ...(plan.tournament.candidates > 1 ? [`Candidates: ${plan.tournament.candidates} independent candidates (${plan.tournament.source}: ` +
      `${plan.tournament.reasons.join("; ")}) — each a full private build; Fusion picks one by its own evidence, or asks you when they tie`] : []),
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

/**
 * v0.1: a role's decision request — what to decide, why the role stopped, what it was unsure about — as bounded lines. The
 * text is the role's own; it is presented as its question, not as a fact Fusion verified.
 */
export function decisionLines(decision: DecisionRequest): string[] {
  const who = decision.role === "Worker" ? "change author" : decision.role.toLowerCase();
  const lines = [`Decision requested by the ${who}${decision.status === "unknown" || decision.status === "completed" ? "" : ` (it reported: ${decision.status})`}:`];
  if (decision.questions.length === 0) lines.push(`  The ${who} stopped without asking a specific question.`);
  decision.questions.forEach((question, index) => lines.push(`  ${index + 1}. ${question}`));
  if (decision.questionsTotal > decision.questions.length)
    lines.push(`  (${decision.questionsTotal - decision.questions.length} more question(s) were beyond Fusion's bounds and are not kept)`);
  if (decision.blockers.length > 0) lines.push(`  Why it stopped: ${decision.blockers.join(" | ")}`);
  if (decision.context.length > 0) lines.push(`  It was unsure about: ${decision.context.join(" | ")}`);
  lines.push(`  (the ${who}'s own words, bounded${decision.clipped ? " and shortened" : ""} by Fusion; not verified)`);
  return lines;
}

export function renderBuild(report: BuildReport, options: Readonly<{ expertNext?: boolean }> = {}): string {
  const lines = [...buildHeadline(report, options.expertNext !== false), `run: ${report.runId}`, `risk: ${report.risk.level} (${report.risk.decisive.join(", ") || "no signals"})`,
    `intended workflow: ${report.intendedWorkflow.join(" → ")}`, `writer required: ${report.writerRequired ? "yes" : "no"}`];
  lines.push(...findingLines(report), ...outcomeLines(report.outcome));
  if (report.decision) lines.push(...decisionLines(report.decision), "Next: decide, then run fusion build again in this repository with your " +
    "decision added to the task (fusion show " + report.runId + " shows this request again). Nothing was changed.");
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
  if (report.tournament) lines.push(...tournamentLines(report.tournament));
  return `${lines.join("\n")}\n`;
}

/** v0.5: a tournament in plain words — who was judged how, what Fusion selected and why, or why nothing was. No score. */
export function tournamentLines(t: BuildTournamentSummary): string[] {
  const lines = [`tournament: ${t.route.candidates} candidates (${t.route.source}: ${t.route.reasons.join("; ")}); ${
    t.independence === "separateContext" ? "separate contexts of the same model" : t.independence === "separateModel" ? "separate models" : "separate providers"}`];
  for (const c of t.candidates) lines.push(`  ${c.id} (${c.strategy}): ${c.state}${c.decision ? `, ${c.decision}` : ""}${c.failure ? `, ${c.failure} failure` : ""}` +
    `${c.contradictions.length > 0 ? `, contradicted by ${c.contradictions.join(", ")}` : ""}` +
    `${c.mutations.run > 0 ? `, mutations ${c.mutations.run - c.mutations.survived}/${c.mutations.run} detected` : ""}` +
    `${c.state === "failed" || c.state === "rejected" || c.state === "unverified" || t.converged?.includes(c.id) === true && c.id !== t.selected?.id ? ` — ${c.detail}` : ""}`);
  for (const reason of t.reasons) lines.push(`  ${reason}`);
  if (t.selected && t.converged) lines.push(`  converged: ${t.converged.join(" = ")} — the identical change, one result (not a contest); ` +
    `${t.selected.id} represents it for revalidation and delivery`);
  else if (t.selected) lines.push(`  selected: ${t.selected.id} (${t.selected.chosenBy === "human" ? "your choice among tied candidates" : "by Fusion's evidence"})`);
  if (t.tied) lines.push(`  tied: ${t.tied.join(", ")} — Fusion's evidence does not separate them; the choice is yours`);
  if (t.revalidation) lines.push(`  revalidation: ${t.revalidation.passed ? "passed" : "FAILED"} — ${t.revalidation.detail}`);
  lines.push(`  outcome: ${t.outcome}`);
  return lines;
}
/** v0.5: a tie, shown to the human before the choice. */
export function renderTie(tie: TieChoice): string {
  return [`Tie: ${tie.candidates.join(" and ")} are verified, and Fusion's evidence does not separate them${tie.inconclusive
    ? " (a discriminating experiment did not complete)" : ""}.`, ...tie.differences.map(d => `  ${d}`),
    "The candidate you choose is revalidated freshly before any delivery; choosing none delivers nothing.", ""].join("\n");
}
export const tieQuestion = (candidates: readonly string[]): string =>
  `Choose ${candidates.join(" or ")} to revalidate and prepare (anything else chooses none): `;

export function renderRun(summary: RunSummary, entry?: RunEntry): string {
  const outcome = summary.outcome as { state?: string; code?: string; message?: string; pendingStage?: string } | undefined;
  const lines = [`run: ${summary.runId} (${summary.command})`, `status: ${summary.status}${outcome?.state ? `, state ${outcome.state}` : ""}` +
    `${outcome?.pendingStage ? ` (pending: ${outcome.pendingStage})` : ""}`, `created: ${summary.createdAt}`];
  if (summary.task) lines.push(`task: ${summary.task.summary}`);
  if (summary.completedAt) lines.push(`completed: ${summary.completedAt}`);
  if (summary.risk) lines.push(`risk: ${summary.risk}`);
  if (summary.finalWorkflowState) lines.push(`workflow: ${summary.finalWorkflowState} after ${summary.transitions} transition(s)`);
  lines.push(`model turns: ${summary.modelTurns}`);
  if (outcome?.message) lines.push(outcome.message);
  for (const f of summary.findings) lines.push(`  [${f.severity}] ${f.id} ${f.title}${f.verdict ? ` — ${f.verdict}` : ""}`);
  if (summary.eventLog === "truncated") lines.push("note: the event log ends in a truncated line; inspect before relying on it.");
  if (summary.decision) lines.push(...decisionLines(summary.decision));
  if (summary.tournament) lines.push(summary.tournament.resolved
    ? `tournament: ${summary.tournament.outcome}${summary.tournament.selected ? summary.tournament.converged
      ? ` — ${summary.tournament.converged.join(" = ")} converged on one change; ${summary.tournament.selected} represents it, revision ${summary.tournament.revision!.slice(0, 12)}`
      : ` — ${summary.tournament.selected} selected (${summary.tournament.chosenBy === "human" ? "your choice" : "by Fusion's evidence"}), revision ${summary.tournament.revision!.slice(0, 12)}` : ""}${
      summary.tournament.tied ? ` — tied: ${summary.tournament.tied.join(", ")}` : ""}`
    : `tournament: UNRESOLVED — ${summary.tournament.reason ?? "its records do not bind a decision"}; no evidence is shown`);
  if (summary.evidence) lines.push(`evidence: ${summary.evidence.decision}${summary.evidence.deliverable ? "" : " (no delivery permitted)"} — ` +
    `${summary.evidence.taskClass}; ${summary.evidence.obligations.map(o => `${o.kind} ${o.status}`).join(", ")}`);
  if (summary.deliveryId) lines.push(`delivery: ${summary.deliveryId}${entry?.delivery ? ` (${entry.delivery.state})` : " (not in this checkout's store)"}`);
  if (entry) lines.push(`next: ${entry.resume.next}`);
  return `${lines.join("\n")}\n`;
}

/** v0.1: `fusion config` — the effective configuration, read-only. */
export function renderConfig(report: ConfigReport): string {
  const lines = [`Configuration: ${report.source === "file" ? report.path : "built-in defaults (no fusion.config.json)"}`];
  if (report.repository) lines.push(`Repository: ${report.repository}`);
  lines.push("", "Roles:");
  for (const role of report.roles)
    lines.push(`  ${role.label.padEnd(36)} ${role.provider ? `${role.provider} via ` : ""}${role.adapter}, model ${role.model}, effort ${role.effort}` +
      `${role.maxTurns ? `, at most ${role.maxTurns} turns` : ""}`);
  if (report.roles.length === 0) lines.push("  none configured (fusion doctor explains what is missing)");
  lines.push(`Conversation partner: ${report.conversationPartner.effective}${report.conversationPartner.configured ? " (conversation.partner)" : " (default)"}`,
    "", "Verification:", `  platform: ${report.verification.platformRequirement}; dependencies: ${report.verification.dependencies}`,
    `  confined commands: ${report.verification.confinedCommands.join("; ") || "none"}`,
    `  read-only commands (review): ${report.verification.readOnlyCommands.join("; ") || "none"}`,
    `  Writer builds: ${report.verification.writerBuilds}${report.verification.reason ? ` — ${report.verification.reason}` : ""}`,
    "", "State:", `  run evidence: ${report.runEvidence ?? "not in a Git repository"}`,
    `  delivery store: ${report.deliveryStore.base ?? `unavailable (${report.deliveryStore.error ?? "unknown"})`}` +
      `${report.deliveryStore.base ? (report.deliveryStore.outsideRepository ? " (outside the repository)" : " (REFUSED: overlaps the repository)") : ""}`,
    "", report.safety, "");
  return lines.join("\n");
}

/** v0.1: the repository's recent runs, newest first, one block each; then deliveries no listed run points to. */
export function renderHistory(listed: History): string {
  const lines = [`Repository: ${listed.repository}`];
  if (listed.runs.length === 0) lines.push("No recorded runs yet (fusion build, fusion review and fusion create record runs here).");
  for (const run of listed.runs) {
    const s = run.summary, outcome = s.outcome as { state?: string } | undefined;
    lines.push("", `${s.createdAt.slice(0, 19).replace("T", " ") || "unknown time"}  ${s.command}  ${outcome?.state ?? s.status.toUpperCase()}  ${s.runId}`);
    if (s.task) lines.push(`  task: ${s.task.summary}`);
    if (s.decision) lines.push(`  decision: ${s.decision.questions[0] ?? `the ${s.decision.role.toLowerCase()} stopped without a specific question`}` +
      `${s.decision.questionsTotal > 1 ? ` (+${s.decision.questionsTotal - 1} more; fusion show ${s.runId})` : ""}`);
    if (s.evidence) lines.push(`  evidence: ${s.evidence.decision}${s.evidence.deliverable ? "" : " (no delivery permitted)"} — ` +
      `${s.evidence.obligations.filter(o => o.status === "PASS").length} of ${s.evidence.obligations.length} obligations established`);
    if (s.deliveryId) lines.push(`  delivery: ${s.deliveryId} (${run.delivery?.state ?? "not in this checkout's store"})`);
    lines.push(`  next: ${run.resume.next}`);
  }
  if (listed.moreRuns) lines.push("", "Older runs exist: fusion history --limit <n> (up to 50).");
  if (listed.otherDeliveries.length > 0) {
    lines.push("", "Other deliveries of this checkout:");
    for (const d of listed.otherDeliveries) lines.push(`  ${d.deliveryId} (${d.state}) — ${d.resume.next}`);
  }
  lines.push("", "Conversations (chat, analyze) are not recorded: their model text stays in memory for the session only.");
  return `${lines.join("\n")}\n`;
}
