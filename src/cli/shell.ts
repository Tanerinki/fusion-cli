import type { ControlPlane } from "../app/control-plane.js";
import { RepositoryConversation, type ConversationAnswer } from "../app/conversation.js";
import { inspectStoredDelivery, deliveryRepository } from "../app/delivery-service.js";
import { explore, type ExplorationCoverage, type ExplorationReport } from "../app/exploration.js";
import { history } from "../app/history.js";
import { renderInventory } from "../app/repository-inventory.js";
import { newSessionState, planTurn, readSessionMetadata, sessionMetadataPath, writeSessionMetadata, type SessionState,
  type TurnPlan } from "../app/session.js";
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
  if (c.assignedAreas.length > 0) lines.push(`  Examined in depth by explorers: ${c.assignedAreas.map(a => a === "." ? "(root files)" : `${a}/`).join(", ")} (${plural(c.assignedFiles, "file")})`);
  lines.push(`  Cited in the answer: ${plural(c.cited.length, "file")}${c.cited.length > 0 ? ` (${c.cited.slice(0, 6).join(", ")}${c.cited.length > 6 ? ", …" : ""})` : ""}`);
  if (c.uncovered.length > 0) lines.push(`  Not covered by any answer: ${c.uncovered.slice(0, 10).map(a => a === "." ? "(root files)" : `${a}/`).join(", ")}${c.uncovered.length > 10 ? ", …" : ""}`);
  lines.push(`  Model turns: ${c.modelTurns}. Fusion cannot see which files a model opened; "cited" means the answer names a file that was shared.`);
  return `${lines.join("\n")}\n`;
}

function renderExploration(conversation: RepositoryConversation, report: ExplorationReport, source: "git" | "folder"): string {
  const lines = ["", report.analysis.text.trim(), "", `  — ${partnerLabel(conversation, report.analysis)}${report.mode === "team" ? ", with explorer reports" : ""}; model output, not verified by Fusion`];
  if (report.planFailure) lines.push(`  (Fusion chose the explored areas itself: ${report.planFailure})`);
  if (report.explorerNote) lines.push(`  (${report.explorerNote})`);
  const answered = report.explorers.filter(e => e.status === "answered");
  if (report.mode === "team")
    lines.push(`  Explorers: ${answered.length} of ${report.explorers.length} answered` +
      `${answered.length > 0 ? ` (${answered.map(e => `${e.packet.area === "." ? "root files" : `${e.packet.area}/`} by ${e.partner}`).join(", ")})` : ""}`);
  for (const e of report.explorers.filter(x => x.status === "failed")) lines.push(`  (explorer for ${e.packet.area} failed: ${e.reason ?? "unknown"})`);
  if (report.critique) lines.push("", `Second opinion — ${partnerLabel(conversation, report.critique)}:`, report.critique.text.trim());
  else if (report.critiqueFailure) lines.push("", `(No second opinion: ${report.critiqueFailure})`);
  lines.push("", renderCoverage(report.coverage).trimEnd());
  if (report.findings.length > 0)
    lines.push("", `Next: "explain the first finding", "what would you change?"${source === "git" ? ", \"fix the first one\"" : ""}`);
  return `${lines.join("\n")}\n`;
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
        const answer = await conversation.ask(plan.message, withSignal);
        io.out(`\n${answer.text.trim()}${answer.truncated ? "\n[reply cut by Fusion]" : ""}\n\n  — ${partnerLabel(conversation, answer)}; read-only\n`);
        if (answer.proposedTask !== undefined) {
          state.proposal = answer.proposedTask;
          io.out(source === "git" ? `\nSuggested change: ${answer.proposedTask}\nSay "do it" and I'll prepare it the verified way (you confirm before anything starts).\n`
            : `\nSuggested change: ${answer.proposedTask}\n(${NO_GIT_BLOCK})\n`);
        }
        return;
      }
      case "analyze": {
        io.out(`Looking at ${inventory.name} (read-only)…\n`);
        let report: ExplorationReport;
        try { report = await explore(conversation, { message: plan.message, broad: plan.broad, ...withSignal }); }
        catch (error) {
          if (error instanceof FusionFailure && error.error.kind === "CapabilityUnavailable") {
            io.out(`${error.error.safeMessage}\nHere is what Fusion found by itself (no AI model involved):\n\n${renderInventory(inventory, "full")}\n`);
            return;
          }
          throw error;
        }
        state.findings = [...report.findings];
        delete state.focus;
        state.analyses++;
        io.out(renderExploration(conversation, report, source));
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
        const offer = await offerDelivery(plane, report.delivery.deliveryId, io, io.out);
        if (offer.outcome !== "declined") delete state.deliveryId;
        return;
      }
    }
  }
}
