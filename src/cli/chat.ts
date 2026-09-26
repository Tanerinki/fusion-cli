import { analysisMessage, ANALYSIS_INSTRUCTION, type AnalyzeReport } from "../app/analyze.js";
import type { ControlPlane } from "../app/control-plane.js";
import { RepositoryConversation, type ConversationAnswer } from "../app/conversation.js";
import { renderInventory } from "../app/repository-inventory.js";
import { FusionFailure } from "../core/errors.js";
import type { DiagnosticRedactor } from "../core/policy/redaction.js";
import { EXIT_CODES, presentFailure } from "./failure-presentation.js";

/**
 * v0.1 — `fusion chat`: an interactive, read-only conversation about the repository (see `app/conversation.ts`). Plain
 * lines go to the default partner (the Lead); slash commands steer the session. Nothing a reply says is executed: a
 * proposed build is only shown, and `/build` starts nothing without the human's explicit confirmation.
 */
export interface ChatIO {
  out(text: string): void;
  err(text: string): void;
  prompt(question: string): Promise<string | null>;
}
/** Starts an explicitly confirmed build from the chat (wired by the CLI); absent, `/build` only shows the command to run. */
export type ChatBuildStarter = (task: string) => Promise<void>;

export const CHAT_HELP = [
  "Commands:",
  "  <message>               talk to the default partner (read-only)",
  "  /ask <partner> <text>   a second opinion from another partner (a role such as reviewer, or a provider id)",
  "  /analyze [focus]        a repository analysis inside the conversation",
  "  /partners               the configured conversation partners",
  "  /context                what Fusion observed about the repository",
  "  /build [task]           start a verified build of the task (or of the last proposed task) — asks for confirmation",
  "  /reset                  forget the conversation so far",
  "  /help                   this help",
  "  /exit                   leave (Ctrl+C or end of input too)",
].join("\n");

export function renderAnswer(answer: ConversationAnswer): string {
  const who = `${answer.partner.role.toLowerCase()} (${answer.partner.provider}${answer.effectiveModel ? `, ${answer.effectiveModel}` : ""})`;
  return `${who}:\n${answer.text}${answer.truncated ? "\n[reply cut by Fusion]" : ""}` +
    `${answer.proposedTask ? `\n\n→ Proposed build task: ${answer.proposedTask}\n  Start it with /build (Fusion asks you to confirm first).` : ""}\n`;
}

export function renderAnalysis(report: AnalyzeReport): string {
  const lines = [renderInventory(report.inventory, "full")];
  if (report.analysis !== null) {
    const a = report.analysis;
    lines.push("", `--- Analysis by ${a.partner.role.toLowerCase()} (${a.partner.provider}${a.effectiveModel ? `, ${a.effectiveModel}` : ""}) ` +
      "— model output, not verified by Fusion ---", a.text, ...(a.truncated ? ["[analysis cut by Fusion]"] : []));
  } else lines.push("", "(inventory only: no provider was started)");
  return `${lines.join("\n")}\n`;
}

/** The REPL. Returns the exit code: 0 after /exit or end of input; a security stop keeps its failure code. */
export async function runChatRepl(conversation: RepositoryConversation, io: ChatIO, options: Readonly<{ partner?: string; debug: boolean;
  redactor: DiagnosticRedactor; startBuild?: ChatBuildStarter; signal?: AbortSignal }>): Promise<number> {
  const available = conversation.partners.filter(p => p.available).map(p => `${p.role.toLowerCase()} (${p.provider}, ${p.model})`);
  io.out(`Fusion chat — read-only conversation about ${conversation.inventory.name}. Partners: ${available.join(", ") || "none available"}.\n` +
    "Type /help for commands, /exit to leave. Nothing here changes your repository.\n");
  let lastProposal: string | undefined;
  for (;;) {
    const line = await io.prompt("you> ");
    if (line === null) { io.out("\n"); return EXIT_CODES.success; }
    const input = line.trim();
    if (input.length === 0) continue;
    try {
      if (!input.startsWith("/")) {
        const answer = await conversation.ask(input, { ...(options.partner === undefined ? {} : { partner: options.partner }),
          ...(options.signal ? { signal: options.signal } : {}) });
        lastProposal = answer.proposedTask ?? lastProposal;
        io.out(renderAnswer(answer));
        continue;
      }
      const [command = "", ...rest] = input.split(/\s+/u);
      const argument = input.slice(command.length).trim();
      switch (command.toLowerCase()) {
        case "/exit": case "/quit": return EXIT_CODES.success;
        case "/help": io.out(`${CHAT_HELP}\n`); break;
        case "/reset": conversation.clearHistory(); io.out("The conversation so far is forgotten.\n"); break;
        case "/context": io.out(`${renderInventory(conversation.inventory, "full")}\n`); break;
        case "/partners":
          io.out(`${conversation.partners.map(p => `  ${p.role.toLowerCase()}: ${p.provider} ${p.model} — ${p.available ? "available" : `unavailable (${p.reason ?? "unknown"})`}`).join("\n")}\n`);
          break;
        case "/ask": {
          const partner = rest[0];
          const message = argument.slice((partner ?? "").length).trim();
          if (partner === undefined || message.length === 0) { io.err("Usage: /ask <partner> <message>\n"); break; }
          io.out(renderAnswer(await conversation.ask(message, { partner, purpose: "consultation", ...(options.signal ? { signal: options.signal } : {}) })));
          break;
        }
        case "/analyze": {
          const focus = argument.length > 0 ? argument : undefined;
          const answer = await conversation.ask(analysisMessage({ deep: false, ...(focus ? { focus } : {}) }), { purpose: "analysis",
            instruction: ANALYSIS_INSTRUCTION, context: renderInventory(conversation.inventory, "full"),
            ...(options.partner === undefined ? {} : { partner: options.partner }), ...(options.signal ? { signal: options.signal } : {}) });
          lastProposal = answer.proposedTask ?? lastProposal;
          io.out(renderAnswer(answer));
          break;
        }
        case "/build": {
          const task = argument.length > 0 ? argument : lastProposal;
          if (task === undefined) { io.err("Usage: /build <task> (or ask for a proposal first).\n"); break; }
          if (options.startBuild === undefined) { io.out(`To build this, run:\n  fusion build ${JSON.stringify(task)}\n`); break; }
          await options.startBuild(task);
          break;
        }
        default: io.err(`Unknown command ${command.slice(0, 40)}. Type /help.\n`);
      }
    } catch (error) {
      const failure = presentFailure(error, { debug: options.debug, redactor: options.redactor });
      io.err(`${failure.text}\n`);
      // A read-only violation ends the conversation (it already closed itself); everything else can continue.
      if (error instanceof FusionFailure && error.error.kind === "SecurityViolation") return failure.exitCode;
    }
  }
}

/** Opens the conversation for a CLI invocation. */
export async function openConversation(plane: ControlPlane, request: Readonly<{ configPath?: string; signal?: AbortSignal }>): Promise<RepositoryConversation> {
  return RepositoryConversation.open(plane, request);
}
