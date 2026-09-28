import type { ControlPlane } from "../app/control-plane.js";
import { RepositoryConversation, type ConversationAnswer } from "../app/conversation.js";
import { inspectStoredDelivery, deliveryRepository } from "../app/delivery-service.js";
import { explorationMode, type ExplorationCoverage } from "../app/exploration.js";
import { history } from "../app/history.js";
import { orchestrate, type AdaptiveReport } from "../app/orchestration/adaptive.js";
import type { ClaimCheckReport } from "../app/orchestration/claim-check.js";
import { describeCheck } from "../core/orchestration/hypotheses.js";
import { renderInventory } from "../app/repository-inventory.js";
import { addOrchestration, newSessionState, planTurn, readSessionMetadata, sessionMetadataPath, writeSessionMetadata, type OrchestrationCounts,
  type SessionState, type TurnPlan } from "../app/session.js";
import { build } from "../app/commands.js";
import { FusionFailure } from "../core/errors.js";
import { classifyIntent } from "../core/intent.js";
import { confirmBuild, createFlow, offerDelivery } from "./build-flow.js";
import { EXIT_CODES, presentFailure } from "./failure-presentation.js";
import { renderBuild, renderHistory } from "./render.js";
import type { TurnScope } from "./run.js";

/**
 * v0.2 — `fusion` without a command: a conversational shell over the current project (a Git repository or an ordinary
 * folder). Each line is classified by the host (`core/intent.ts`), planned against the session (`app/session.ts`) and run:
 *
 *   - talking, explaining, planning and analysing are read-only conversation turns (`RepositoryConversation`), broad
 *     analyses of large projects as a team with a coverage account (`app/exploration.ts`);
 *   - a change request enters the confirmed Writer route (`fusion build`'s own plan and gates) and, when it prepared a
 *     delivery, one summary with a single explicit yes approves and applies exactly that delivery;
 *   - in a folder without Git nothing is ever changed; a request to skip Fusion's safety steps is refused.
 *
 * Nothing a model writes is executed or routes the session: model text only ever becomes displayed text, the wording of a
 * follow-up question, or the wording of a task the human confirms.
 */
export interface ShellIO {
  out(text: string): void;
  err(text: string): void;
  prompt(question: string): Promise<string | null>;
  readonly interactive: true;
}
export interface ShellOptions {
  readonly configPath?: string;
  readonly debug: boolean;
  /** The process-wide cancellation (Ctrl+C outside a step, or the second Ctrl+C). */
  readonly signal?: AbortSignal;
  /** Opens a per-step cancellation scope: Ctrl+C during a step cancels only that step. */
  readonly turnScope?: () => TurnScope;
}

export const SHELL_PROMPT = "> ";
export const SHELL_HELP = `Talk to Fusion in plain words. For example:
  analyze this project                 a read-only analysis with a coverage summary
  are there problems in the automations?
  explain the first finding            follow-ups refer to the last analysis
  is the first one really a bug?       checks one finding, with parallel investigations when it pays off
  where is the login handled?
  what would you change?               a plan, nothing is changed
  fix the first one                    prepares a verified change (Git projects only):
                                       private copy → sandbox verification → fresh review → your yes
  apply                                offers the last prepared change again
  history                              recent runs and deliveries
  help, ?                              this help
  exit, quit, Ctrl+C                   leave (Ctrl+C during a step cancels just that step)
Fusion only reads your files unless you confirm a change. It never commits, pushes or skips its checks.
The expert commands still work: fusion --help lists them (build, analyze, inspect-delivery, approve-delivery, apply, ...).
`;
export const NO_GIT_BLOCK = "I can analyze this folder, but I won't change it yet because it has no Git safety baseline. " +
  "Your files have not been modified.";
const NO_GIT_WHY = [
  "Why: without Git, Fusion cannot prove exactly what it changed or give you a clean way back.",
  "To let Fusion prepare verified changes here, first make a baseline yourself:",
  "  1. back up the folder;",
  "  2. create a .gitignore that excludes secrets.yaml, .storage/ and other private files;",
  "  3. run git init, git add -A and git commit -m \"baseline\";",
  "  4. start fusion again in this folder.",
].join("\n");
const BYPASS_REFUSAL = "I won't skip Fusion's safety steps. A change always goes through the same route: a private copy, verification " +
  "in a sandbox, a fresh review, and your yes before anything touches your files. Nothing was changed.";

const cancelled = (error: unknown): boolean => error instanceof FusionFailure && error.error.kind === "Cancelled";
function combined(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  return present.length === 0 ? undefined : present.length === 1 ? present[0] : AbortSignal.any(present);
}
const plural = (n: number, word: string): string => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;

/** The welcome's team line: which providers can talk right now (by product name), and which cannot. */
export function teamLine(conversation: RepositoryConversation): string {
  const available = [...new Set(conversation.partners.filter(p => p.available).map(p => p.displayName))];
  const missing = [...new Set(conversation.partners.filter(p => !p.available && !available.includes(p.displayName)).map(p => p.displayName))];
  if (available.length === 0)
    return "No AI model is available right now. Fusion's own inventory still works; run `fusion doctor` to see what is missing.\n" +
      "Fusion only uses your provider subscriptions; it never switches to a paid API key on its own.";
  return `${available.join(" + ")} available${missing.length > 0 ? ` (not available: ${missing.join(", ")}; see fusion doctor)` : ""}`;
}

function partnerLabel(conversation: RepositoryConversation, answer: ConversationAnswer): string {
  const partner = conversation.partners.find(p => p.role === answer.partner.role && p.provider === answer.partner.provider);
  return `${answer.partner.role.toLowerCase()} · ${partner?.displayName ?? answer.partner.provider}${answer.effectiveModel ? ` (${answer.effectiveModel})` : ""}`;
}

export function renderCoverage(c: ExplorationCoverage): string {
  const lines = ["Coverage (what Fusion can vouch for):",
    `  Inventoried: ${plural(c.inventoried, "file")} in this ${c.source === "git" ? "repository" : "folder"}` +
      `${c.bounded ? " (a bound was hit: not every file is counted)" : ""}` +
      `${c.skippedDirectories.length > 0 ? `; skipped folders: ${c.skippedDirectories.slice(0, 6).join(", ")}${c.skippedDirectories.length > 6 ? ", …" : ""}` : ""}`];
  if (c.exposure !== null)
    lines.push(`  Shared with the AI models: ${plural(c.exposure.shared, "file")} as they are, ${c.exposure.redacted} with secret values masked, ` +
      `${c.exposure.withheld} withheld${c.exposure.withheldExamples.length > 0 ? ` (${c.exposure.withheldExamples.join(", ")}${c.exposure.withheld > c.exposure.withheldExamples.length ? ", …" : ""})` : ""}`);
  // v0.2.4: only what Fusion controls or observes — an area ASSIGNED to an explorer is not a claim that its files were read.
  const areas = (list: readonly string[]) => list.map(a => a === "." ? "(root files)" : `${a}/`).join(", ");
  if (c.assignedAreas.length > 0) lines.push(`  Assigned to explorer investigations: ${areas(c.assignedAreas)} (${plural(c.assignedFiles, "file")} in those areas)` +
    `${c.unanswered.length > 0 ? `; no report came back for ${areas(c.unanswered)}` : ""}`);
  lines.push(`  Cited in the final answer: ${plural(c.cited.length, "file")} from the shared copy` +
    `${c.cited.length > 0 ? ` (${c.cited.slice(0, 6).join(", ")}${c.cited.length > 6 ? ", …" : ""})` : ""}`);
  if (c.uncovered.length > 0) lines.push(`  ${c.assignedAreas.length > 0 ? "Neither assigned nor cited" : "Not cited"}: ${areas(c.uncovered.slice(0, 10))}${c.uncovered.length > 10 ? ", …" : ""}`);
  lines.push(`  Model turns: ${c.modelTurns}. Fusion cannot see which files a model opened${c.assignedAreas.length > 0 ? ": \"assigned\" is what explorers were asked to look at, \"cited\" is what the final answer names" : "; \"cited\" means the answer names a file that was shared"}.`);
  return `${lines.join("\n")}\n`;
}

const areaName = (area: string): string => area === "." ? "root files" : `${area}/`;
const sentence = (text: string): string => /[.!?)]$/u.test(text) ? text : `${text}.`;

/**
 * v0.4: a claim check as the user reads it — the snapshot every investigator got, each independent hypothesis (model
 * judgement, untrusted), the checks Fusion ran itself (the only execution evidence) and Fusion's decision from them.
 */
export function claimCheckLines(c: ClaimCheckReport): string[] {
  const lines = [`  Evidence snapshot: sha256:${c.snapshot.sha256.slice(0, 12)}… given identically to ${c.snapshot.investigators} investigator` +
    `${c.snapshot.investigators === 1 ? "" : "s"}, each in its own view copy and session; none saw another's conclusion`];
  const answered = c.hypotheses.filter(h => h.status !== "failed").length;
  lines.push(`  Independent hypotheses: ${answered} of ${c.hypotheses.length} answered (model judgement, untrusted)`);
  for (const h of c.hypotheses) {
    for (const earlier of c.attempts) if (earlier !== h && earlier.id === h.id && earlier.status === "failed")
      lines.push(`    (${h.id}: attempt ${earlier.attempt} failed — ${earlier.failure!.category}: ${sentence(earlier.failure!.message)} ` +
        `It was repeated once and ${h.status === "failed" ? "failed again" : "answered"}.)`);
    if (h.status === "failed") lines.push(`    ${h.id} (${h.partner}): no report — ${h.failure!.category}: ${h.failure!.message}`);
    else if (h.status === "unstructured") lines.push(`    ${h.id} (${h.partner}): a reply that did not follow Fusion's structure (${h.rejection}); used as untrusted text`);
    else lines.push(`    ${h.id} (${h.partner}): ${c.mode === "verify" ? `${h.report!.verdict === "supported" ? "supports the claim" : h.report!.verdict === "contradicted"
      ? "contradicts the claim" : "undecided"} — ` : ""}${clipLine(h.report!.hypothesis, 200)}`);
  }
  lines.push("  Fusion's checks (run by Fusion on the shared copy; the only execution evidence):");
  if (c.checks.length === 0) lines.push("    none — no check was proposed that Fusion could run");
  for (const k of c.checks) lines.push(`    ${k.id} ${describeCheck(k.check)} ... ${k.outcome.ran ? `${k.outcome.present ? "YES" : "NO"} → ` +
    `${k.outcome.holds ? "supports" : "CONTRADICTS"} ${k.target === "claim" ? "the claim" : `hypothesis ${k.target}`}` : `not run (${k.outcome.reason})`}` +
    ` (proposed by ${k.proposedBy.join(", ")})`);
  const d = c.decision;
  if (d.kind === "claim") {
    const a = d.assessment;
    const why = d.status === "SUPPORTED" ? `Fusion's own checks support it (${a.deterministic.supports}) and none contradicts it`
      : d.status === "CONTRADICTED" ? `Fusion's own checks contradict it (${a.deterministic.contradicts}); Fusion does not accept it, whatever the models concluded`
      : d.status === "STALE" ? "the files changed after Fusion's checks ran"
      : "no check Fusion ran settles it; the investigators' agreement is not evidence";
    lines.push(`  Claim: ${d.status} — ${why} (investigators: ${a.models.supports} support, ${a.models.contradicts} contradict)`);
  } else {
    const leading = d.statuses.find(s => s.id === d.leading);
    const others = d.statuses.filter(s => s.id !== d.leading).map(s => `${s.id} ${s.status}`);
    lines.push(`  Diagnosis: ${leading ? `${leading.id} SUPPORTED by Fusion's checks — ${clipLine(leading.statement, 160)}` : "not settled by Fusion's checks"}` +
      `${others.length > 0 ? `; ${others.join(", ")}` : ""}`);
  }
  return lines;
}
const clipLine = (text: string, max: number): string => { const line = text.replace(/\s+/gu, " ").trim(); return line.length > max ? `${line.slice(0, max - 1)}…` : line; };

/**
 * v0.3: an adaptive route as the user sees it — the answer (or, for a route that stopped, what the investigations reported
 * and why no conclusion was drawn), the route taken, its turns, who planned it, each investigation's state, the host's
 * assessment (conflicts, gaps), the fresh critique and the coverage. Safe labels and counts; model text only where it is the
 * answer, clearly attributed.
 */
export function renderAdaptive(conversation: RepositoryConversation, report: AdaptiveReport, source: "git" | "folder", verify = false): string {
  const latest = [...new Map(report.outcomes.map(o => [o.packet.id, o])).values()];
  const answered = latest.filter(o => o.status !== "failed");
  const lines: string[] = [""];
  if (report.answer === undefined && report.diagnosisFailure !== undefined)
    lines.push(`The lead's diagnosis failed: ${report.diagnosisFailure}. Fusion's own evidence is below; it drew no conclusion from the models.`);
  if (report.answer !== undefined) {
    lines.push(report.answer.text.trim(), "", `  — ${partnerLabel(conversation, report.answer)}` +
      `${latest.length > 0 ? `, with ${answered.length} investigation report${answered.length === 1 ? "" : "s"}` : ""}; model output, not verified by Fusion`);
  } else if (report.result.outcome === "stopped") {
    const why = report.result.reason.kind === "lead" ? "the lead judged the evidence insufficient to conclude"
      : `the route's budget ran out (${report.result.reason.refusal})`;
    lines.push(`Fusion stopped before drawing a conclusion: ${why}.`);
    if (answered.length > 0) {
      lines.push("What the investigations reported (explorer text, untrusted; no conclusion was drawn from it):");
      for (const o of latest) {
        if (o.status === "failed") { lines.push(`  ${areaName(o.packet.area)}: no report (${o.failure.category})`); continue; }
        lines.push(`  ${areaName(o.packet.area)} (${o.partner}): ${clipLine(o.status === "reported" ? o.report.summary : o.text, 300)}`);
      }
    }
    if (report.findings.length > 0) lines.push("", "Findings (from the investigations; unconfirmed):", ...report.findings.map((f, i) => `${i + 1}. ${f}`));
  }
  lines.push(`  Route: ${report.route}`, `  Turns: ${report.turns}`);
  const lead = conversation.partners.find(p => p.role === "Lead" && p.available)?.displayName ?? "the lead";
  const areaList = (areas: readonly string[]) => areas.map(a => a === "." ? "(root files)" : `${a}/`).join(", ");
  const n = (count: number, kind: string) => `${count} ${kind} ${count === 1 ? "area" : "areas"}`;
  const planning = report.planning;
  if (planning?.source === "lead" && "answered" in planning) lines.push(`  Planning: ${lead} decided to answer directly (no investigation needed).`);
  else if (planning?.source === "lead") lines.push(`  Planning: ${lead} selected ${n(planning.areas.length, "investigation")} (${areaList(planning.areas)}).`);
  else if (planning?.source === "fusion")
    lines.push(`  Planning: ${lead}'s ${planning.reason}; Fusion selected ${n(planning.areas.length, "bounded")} instead (${areaList(planning.areas)}).`);
  if (report.explorerNote) lines.push(`  (${report.explorerNote})`);
  if (report.claimCheck !== undefined) lines.push(...claimCheckLines(report.claimCheck));
  if (latest.length > 0) {
    lines.push(`  Explorer investigations: ${answered.length} of ${latest.length} answered` +
      `${answered.length > 0 ? ` (${answered.map(o => `${areaName(o.packet.area)} by ${o.partner}`).join(", ")})` : ""}`);
    const sentence = (text: string) => /[.!?)]$/u.test(text) ? text : `${text}.`;
    for (const o of latest) {
      // A failed attempt a repeat superseded keeps its safe category and message, whatever the repeat did.
      for (const earlier of report.outcomes) {
        if (earlier === o || earlier.packet.id !== o.packet.id || earlier.status !== "failed") continue;
        lines.push(`  (explorer for ${o.packet.area}: attempt ${earlier.packet.attempt} failed — ${earlier.failure.category}: ${sentence(earlier.failure.message)} ` +
          `It was repeated once and ${o.status === "failed" ? "failed again" : "answered"}.)`);
      }
      if (o.status === "failed") lines.push(`  (explorer for ${o.packet.area} failed: ${o.failure.category}: ${o.failure.message})`);
      else if (o.status === "unstructured") lines.push(`  (the report for ${areaName(o.packet.area)} did not follow Fusion's structure (${o.rejection}); it was used as untrusted text)`);
    }
    if (report.claim !== undefined) {
      const verdicts = latest.flatMap(o => o.status === "reported" && o.report.verdict ? [o.report.verdict] : []);
      lines.push(`  Claim checked: ${verdicts.filter(v => v === "supported").length} investigation(s) support it, ` +
        `${verdicts.filter(v => v === "contradicted").length} contradict it, ${latest.length - verdicts.filter(v => v !== "unclear").length} leave it open.`);
    }
    const conflict = report.assessment.conflict;
    if (conflict !== undefined) {
      const areasOf = (ids: readonly string[]) => ids.map(id => areaName(latest.find(o => o.packet.id === id)?.packet.area ?? id)).join(", ");
      lines.push(`  Conflict: the investigations disagree (${areasOf(conflict.supported)} support the claim; ${areasOf(conflict.contradicted)} contradict it)` +
        `${report.answer ? "; the answer above compares their evidence" : ""}.`);
    }
    if (!report.assessment.sufficient) lines.push(`  Evidence: incomplete (${report.assessment.weak.join(", ")}).`);
  }
  if (report.critique) lines.push("", `Second opinion — ${partnerLabel(conversation, report.critique)}:`, report.critique.text.trim());
  else if (report.critiqueFailure) lines.push("", `(No second opinion: ${report.critiqueFailure})`);
  lines.push("", renderCoverage(report.coverage).trimEnd());
  if (verify) lines.push("", source === "git" ? "Next: \"fix it\" prepares a verified change for this finding (you confirm first)." : "Next: \"explain it\", \"what would you change?\"");
  else if (report.findings.length > 0)
    lines.push("", `Next: "explain the first finding", "is the first one really a problem?", "what would you change?"${source === "git" ? ", \"fix the first one\"" : ""}`);
  return `${lines.join("\n")}\n`;
}
/** The host's evidence about one verified finding, as the session keeps it (files Fusion checked, counts and Fusion's decision). */
function verifiedEvidence(index: number, report: AdaptiveReport): NonNullable<SessionState["verified"]> {
  const check = report.claimCheck;
  const answered = report.answer !== undefined ? report.coverage.cited : [];
  if (check !== undefined) {
    const cited = [...new Set(check.hypotheses.flatMap(h => h.status === "failed" ? [] : [...h.cited]))];
    const verdicts = check.hypotheses.flatMap(h => h.status === "reported" ? [h.report!.verdict] : []);
    const ran = check.checks.filter(k => k.outcome.ran);
    return Object.freeze({ index, source: cited.length > 0 || answered.length === 0 ? "investigations" as const : "lead" as const,
      cited: Object.freeze((cited.length > 0 ? cited : [...answered]).slice(0, 8)),
      supported: verdicts.filter(v => v === "supported").length, contradicted: verdicts.filter(v => v === "contradicted").length,
      ...(check.decision.kind === "claim" ? { status: check.decision.status } : {}),
      checks: Object.freeze({ ran: ran.length, supported: ran.filter(k => k.outcome.ran && k.outcome.holds).length,
        contradicted: ran.filter(k => k.outcome.ran && !k.outcome.holds).length }) });
  }
  const latest = [...new Map(report.outcomes.map(o => [o.packet.id, o])).values()];
  const investigated = [...new Set(latest.flatMap(o => o.status === "failed" ? [] : [...o.cited]))];
  return Object.freeze({ index, source: investigated.length > 0 || answered.length === 0 ? "investigations" as const : "lead" as const,
    cited: Object.freeze((investigated.length > 0 ? investigated : [...answered]).slice(0, 8)),
    supported: latest.filter(o => o.status === "reported" && o.report.verdict === "supported").length,
    contradicted: latest.filter(o => o.status === "reported" && o.report.verdict === "contradicted").length });
}

/** v0.3: the session's orchestration so far, in one line (counts only). */
export function renderOrchestration(counts: OrchestrationCounts): string {
  if (counts.routes === 0) return "No AI routes in this session yet.";
  return `This session: ${counts.routes} route${counts.routes === 1 ? "" : "s"}, ${counts.modelTurns} model turn${counts.modelTurns === 1 ? "" : "s"} ` +
    `(lead ${counts.leadTurns} · explorers ${counts.explorerTurns} · reviewer ${counts.reviewerTurns}), ${counts.batches} investigation batch${counts.batches === 1 ? "" : "es"} ` +
    `(${counts.parallelBatches} parallel), ${counts.retries} repeat${counts.retries === 1 ? "" : "s"}, ${counts.failedInvestigations} failed investigation${counts.failedInvestigations === 1 ? "" : "s"}, ` +
    `${counts.escalations} escalation${counts.escalations === 1 ? "" : "s"}, ${counts.budgetStops} budget stop${counts.budgetStops === 1 ? "" : "s"}.`;
}

/** Runs the shell until exit; returns the exit code (0 after exit or end of input; a security stop keeps its code). */
export async function runShell(plane: ControlPlane, io: ShellIO, options: ShellOptions): Promise<number> {
  const request = { ...(options.configPath === undefined ? {} : { configPath: options.configPath }), ...(options.signal ? { signal: options.signal } : {}) };
  const failureText = (error: unknown): string => presentFailure(error, { debug: options.debug, redactor: plane.redactor }).text;
  io.out(`Fusion · ${plane.deps.cwd}\n`);
  let conversation: RepositoryConversation;
  try { conversation = await RepositoryConversation.open(plane, { ...request, allowFolder: true }); }
  catch (error) {
    const failure = presentFailure(error, { debug: options.debug, redactor: plane.redactor });
    io.err(`${failure.text}\n`);
    return failure.exitCode;
  }
  const source = conversation.source, inventory = conversation.inventory;
  const state: SessionState = newSessionState();
  let metadataPath: string | undefined;
  try { metadataPath = sessionMetadataPath(plane.deps.env, conversation.root); } catch { metadataPath = undefined; }
  const kinds = inventory.projects.map(p => p.kind);
  io.out(`${source === "git" ? "Git repository" : "Folder, not a Git repository"}${kinds.length > 0 ? ` · ${kinds.join(", ")}` : ""} · ` +
    `${plural(inventory.trackedFiles, "file")}${inventory.sensitive.count > 0 ? ` · ${plural(inventory.sensitive.count, "sensitive file")} kept private` : ""}\n`);
  io.out(`${teamLine(conversation)}\n`);
  io.out(source === "git" ? "Read-only until you request a change.\n"
    : "Read-only: this folder has no Git baseline, so Fusion will analyze it but not change it.\n");
  const previous = metadataPath === undefined ? undefined : await readSessionMetadata(metadataPath);
  if (source === "git" && previous?.lastDeliveryId) {
    try {
      const pending = await inspectStoredDelivery(await deliveryRepository(plane), previous.lastDeliveryId);
      if (pending.state === "prepared") {
        state.deliveryId = pending.deliveryId;
        io.out(`A verified change from your last session is waiting: ${pending.deliveryId} (say "apply" to review it).\n`);
      }
    } catch { /* gone or elsewhere: nothing to offer */ }
  }
  io.out("Tell me what you want in plain words (\"help\" shows examples, \"exit\" leaves).\n");
  let code: number = EXIT_CODES.success;
  try {
    for (;;) {
      if (options.signal?.aborted) { code = EXIT_CODES.cancelled; break; }
      const line = await io.prompt(SHELL_PROMPT);
      if (line === null) { io.out("\n"); break; }
      const intent = classifyIntent(line);
      const plan = planTurn(intent, state, source);
      if (plan.kind === "local" && plan.what === "empty") continue;
      if (plan.kind === "local" && plan.what === "exit") break;
      state.turns = Math.min(state.turns + 1, 10_000);
      const scope = options.turnScope?.();
      const signal = combined(options.signal, scope?.signal);
      try {
        await step(plan, signal);
      } catch (error) {
        if (cancelled(error) || signal?.aborted) {
          io.out("Cancelled. Nothing was changed.\n");
          if (options.signal?.aborted) { code = EXIT_CODES.cancelled; break; }
          continue;
        }
        io.err(`${failureText(error)}\n`);
        // A read-only violation ends the session (the conversation already closed itself).
        if (error instanceof FusionFailure && error.error.kind === "SecurityViolation") {
          code = presentFailure(error, { debug: options.debug, redactor: plane.redactor }).exitCode;
          break;
        }
      } finally { scope?.release(); }
    }
  } finally {
    await conversation.close();
    if (metadataPath !== undefined) await writeSessionMetadata(metadataPath, source, state);
  }
  return code;

  async function step(plan: TurnPlan, signal: AbortSignal | undefined): Promise<void> {
    const withSignal = signal ? { signal } : {};
    switch (plan.kind) {
      case "local":
        if (plan.what === "help") io.out(SHELL_HELP);
        else if (plan.what === "history") {
          if (source === "folder") io.out("No runs here: Fusion never changes a folder without a Git baseline.\n");
          else io.out(renderHistory(await history(plane, { limit: 5 })));
          io.out(`${renderOrchestration(state.orchestration)}\n`);
        } else if (plan.what === "undo")
          io.out(source === "folder" ? "Fusion has not changed anything in this folder.\n"
            : "Fusion does not undo or reset anything by itself. Changes it applied are ordinary uncommitted edits: review them with " +
              "git diff and restore a file with git restore <file> if you want it back.\n");
        return;
      case "refuse":
        io.out(`${BYPASS_REFUSAL}\n${source === "folder" ? `${NO_GIT_BLOCK}\n` : "If you want the change, say what should change and I'll prepare it the safe way.\n"}`);
        return;
      case "clarify":
        io.out(`${plan.question}\n`);
        return;
      case "ask": {
        const started = Date.now();
        const answer = await conversation.ask(plan.message, withSignal);
        const durationMs = Date.now() - started;
        addOrchestration(state.orchestration, { routes: 1, modelTurns: 1, leadTurns: 1, durationMs });
        io.out(`\n${answer.text.trim()}${answer.truncated ? "\n[reply cut by Fusion]" : ""}\n\n  — ${partnerLabel(conversation, answer)}; read-only\n` +
          `  Route: lead only · 1 model turn · ${(durationMs / 1000).toFixed(1)} s\n`);
        if (answer.proposedTask !== undefined) {
          state.proposal = answer.proposedTask;
          io.out(source === "git" ? `\nSuggested change: ${answer.proposedTask}\nSay "do it" and I'll prepare it the verified way (you confirm before anything starts).\n`
            : `\nSuggested change: ${answer.proposedTask}\n(${NO_GIT_BLOCK})\n`);
        }
        return;
      }
      case "analyze": case "verify": case "diagnose": {
        const verify = plan.kind === "verify";
        io.out(verify ? `Checking whether this holds (read-only): ${clipLine(plan.claim, 200)}\n`
          : plan.kind === "diagnose" ? `Diagnosing (read-only): ${clipLine(plan.message, 200)}\n` : `Looking at ${inventory.name} (read-only)…\n`);
        let report: AdaptiveReport;
        try {
          // v0.3: the host classifies the task (one answer that may escalate, a team route for a broad question on a large
          // project, a verification of one finding); the adaptive route decides every further step within its budget.
          // v0.4: a verification (of a finding or of the user's own claim) and a diagnosis are claim checks.
          report = await orchestrate(conversation, plan.kind === "verify" ? { message: plan.message, mode: "verify", claim: plan.claim,
            claimOrigin: plan.source === "user" ? "user" : "lead", ...withSignal }
            : plan.kind === "diagnose" ? { message: plan.message, mode: "diagnose", ...withSignal }
            : { message: plan.message, mode: explorationMode(inventory, plan.broad, false), ...withSignal });
        } catch (error) {
          if (error instanceof FusionFailure && error.error.kind === "CapabilityUnavailable") {
            // v0.2.5: with its safe detail (Fusion-owned labels only), so a refused turn says which check did not hold.
            io.out(`${error.error.safeMessage}\n${error.error.failureDetail ? `detail: ${error.error.failureDetail}\n` : ""}` +
              `Here is what Fusion found by itself (no AI model involved):\n\n${renderInventory(inventory, "full")}\n`);
            return;
          }
          throw error;
        }
        addOrchestration(state.orchestration, report.metrics);
        state.analyses++;
        if (plan.kind === "verify") {
          // The analysis's findings stay what follow-ups refer to; the host's evidence about this one is remembered: the shared
          // files the investigations cited or, when the lead verified the finding itself (no investigation ran or cited
          // anything), the shared files its answer cited — both checked by Fusion against the shared copy. v0.4: with a claim
          // check, the hypotheses' cited files, and Fusion's own decision about the finding. The user's own claim is no finding.
          if (plan.source === "finding" && plan.index !== undefined) state.verified = verifiedEvidence(plan.index, report);
        } else if (plan.kind === "diagnose") {
          if (report.findings.length > 0) { state.findings = [...report.findings]; delete state.focus; delete state.verified; }
        } else {
          state.findings = [...report.findings];
          delete state.focus;
          delete state.verified;
        }
        io.out(renderAdaptive(conversation, report, source, verify));
        return;
      }
      case "blocked":
        io.out(`${NO_GIT_BLOCK}\n${NO_GIT_WHY}\n${plan.task === undefined ? "" : `The change you asked for: ${plan.task.split("\n")[0]}\n`}`);
        return;
      case "create": {
        io.out("Creating a new project happens next to this folder, through Fusion's confirmed route.\n");
        await createFlow(plane, { description: plan.description, ...request, ...withSignal }, { interactive: io.interactive, prompt: io.prompt, stderr: io.err }, io.out);
        return;
      }
      case "apply": {
        const offer = await offerDelivery(plane, plan.deliveryId, io, io.out);
        if (offer.outcome !== "declined") delete state.deliveryId;
        return;
      }
      case "change": {
        state.changeRequests++;
        io.out(`Preparing a verified change: ${plan.task.split("\n")[0]}\n` +
          "Fusion changes a private copy, verifies it in a sandbox, has it reviewed fresh, and asks you before touching your files.\n");
        const buildOptions = { ...request, ...withSignal, task: plan.task, paths: [] as string[], operation: "implement" as const };
        const confirmation = await confirmBuild(plane, buildOptions, io, io.out, "yesNo");
        if (confirmation.refused !== undefined || confirmation.options === undefined) return;
        const report = await build(plane, confirmation.options);
        io.out(renderBuild(report, { expertNext: false }));
        if (report.delivery === undefined) {
          io.out("No change was prepared, so nothing can be applied. Your files are unchanged.\n");
          return;
        }
        state.deliveryId = report.delivery.deliveryId;
        const decision = report.evidence?.decision;
        const offer = await offerDelivery(plane, report.delivery.deliveryId, io, io.out, decision === undefined ? undefined
          : { decision: decision.decision, open: decision.obligations.filter(o => o.status !== "PASS").length });
        if (offer.outcome !== "declined") delete state.deliveryId;
        return;
      }
    }
  }
}
