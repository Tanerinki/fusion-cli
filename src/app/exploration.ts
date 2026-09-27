import { conversationText } from "../core/conversation.js";
import { FusionFailure } from "../core/errors.js";
import { parseStrictJson } from "../platform/process/strict-json.js";
import { readStructuredEnvelope } from "../platform/process/structured-envelope.js";
import type { ViewExposure } from "../platform/workspace/provider-views.js";
import type { ConversationAnswer, RepositoryConversation } from "./conversation.js";
import { renderInventory, type RepositoryInventory } from "./repository-inventory.js";

/**
 * v0.2 — READ-ONLY EXPLORATION of a project of any size, as a team, with an honest account of what was looked at.
 *
 *   1. Fusion's deterministic inventory (already taken when the conversation opened) is the map: every file is counted,
 *      sensitive files are classified, dependency and cache directories are skipped.
 *   2. Small projects, or a narrow question: ONE analysis turn by the lead partner (no second model for a trivial ask).
 *   3. Large projects with a broad question: the lead DECOMPOSES the work into at most three area packets (a strictly parsed
 *      JSON plan; areas must be inventory directories, else Fusion's own deterministic packets apply), each packet goes to
 *      the explorer partner in an ISOLATED turn (no transcript: only its packet), the lead SYNTHESISES the bounded reports,
 *      and the reviewer partner gives a FRESH critique of the bounded synthesis only.
 *   4. Coverage: what Fusion inventoried, what the view shared, redacted and withheld, which areas were assigned, which
 *      shared files the answers cite, and which areas no answer covered. Fusion cannot observe which files a model opened;
 *      it never claims the whole project was read.
 *
 * Every turn runs through `RepositoryConversation` — read-only views, primary proven unchanged, untrusted text — so this
 * module adds no capability: it only decides which read-only turns to take and how to account for them.
 */
export const EXPLORATION_LIMITS = Object.freeze({
  /** Above this many inventoried files a broad question is explored as a team. */
  teamThresholdFiles: 150,
  maxPackets: 3,
  maxPacketFiles: 24,
  maxQuestionChars: 300,
  /** An explorer report as it enters the synthesis. */
  maxReportChars: 6_000,
  /** The synthesis as the critique sees it. */
  maxCritiqueInputChars: 12_000,
  maxFindings: 12,
  maxFindingChars: 280,
  maxCited: 200,
});

export interface ExplorationPacket {
  readonly id: string;
  /** An inventory directory (`.` for the files at the root). */
  readonly area: string;
  readonly files: number;
  /** Key files of the area Fusion knows from the inventory (a starting point, not a limit). */
  readonly start: readonly string[];
  readonly question: string;
  readonly plannedBy: "lead" | "fusion";
}
export interface ExplorerReport {
  readonly packet: ExplorationPacket;
  readonly partner: string;
  readonly status: "answered" | "failed";
  readonly reason?: string;
}
export interface ExplorationCoverage {
  readonly inventoried: number;
  readonly source: "git" | "folder";
  readonly bounded: boolean;
  readonly skippedDirectories: readonly string[];
  /** From the provider view: files shared unchanged or with values redacted, and files withheld. */
  readonly exposure: Readonly<{ shared: number; redacted: number; withheld: number; withheldExamples: readonly string[] }> | null;
  readonly assignedAreas: readonly string[];
  readonly assignedFiles: number;
  /** Paths the answers name that exist in the shared view. */
  readonly cited: readonly string[];
  /** Inventory areas no answer cited anything in. */
  readonly uncovered: readonly string[];
  readonly modelTurns: number;
}
export interface ExplorationReport {
  readonly mode: "single" | "team";
  readonly analysis: ConversationAnswer;
  readonly explorers: readonly ExplorerReport[];
  readonly critique?: ConversationAnswer;
  readonly critiqueFailure?: string;
  /** v0.2.3: why the lead's plan was not used (Fusion then chose the areas itself); safe text only. */
  readonly planFailure?: string;
  /** v0.2.3: which partner explored and why, when it is not the explorer binding (for example its posture is unproven). */
  readonly explorerNote?: string;
  /** The numbered findings of the analysis (untrusted model text, bounded): what follow-ups refer to. */
  readonly findings: readonly string[];
  readonly coverage: ExplorationCoverage;
}

const FINDINGS_RULE = "End your answer with a section headed exactly 'Findings:' that lists the concrete problems or improvements you " +
  "found as a numbered list (1. 2. 3. ...), most important first, one line each, each naming the file it concerns. Write 'Findings: none' " +
  "when you found nothing concrete.";
/**
 * v0.2.3: every turn has a small, fixed step budget (the binding's turn limit), and each tool call spends a step. A turn that
 * reads until its budget runs out ends without an answer. The instructions therefore state the budget: the lead decides from
 * Fusion's inventory, the explorers read their own area, and the lead's synthesis rests on their reports.
 */
const STEP_BUDGET_RULE = (files: number): string => `Fusion stops a turn after a small, fixed number of steps and every file you open ` +
  `or search spends one, so open at most ${files} file${files === 1 ? "" : "s"} and answer before your budget runs out.`;
export const SHELL_ANALYSIS_INSTRUCTION = "You are the lead analyst inside Fusion, a command-line tool that coordinates several AI models on " +
  "the user's project. Analyze the project in the current directory (a Fusion-owned, read-only copy; credentials and secret values are " +
  "withheld or masked by Fusion, so do not try to find them). Start from Fusion's inventory below, prioritize what the user asked about, " +
  `inspect the files that matter most and cite their paths. ${STEP_BUDGET_RULE(5)} Say when something is an inference rather than something ` +
  `you read. Explain in plain words, briefly. ${FINDINGS_RULE}`;
export const LEAD_PLAN_INSTRUCTION = "You are the lead inside Fusion. Split the analysis of this large project into at most three exploration " +
  "packets for separate explorer models, who will read the files. Decide from Fusion's inventory below ALONE: do not open, list or search " +
  "any file; your reply is your first and only action. Reply with ONLY one JSON object, no prose and no fence: " +
  "{\"packets\":[{\"area\":\"<one directory from the inventory's Top-level directories, or . for root files>\",\"question\":\"<what to look for there, one sentence>\"}]}. " +
  "Choose the areas that matter most for the user's request.";
export const EXPLORER_INSTRUCTION = "You are an explorer inside Fusion. You get ONE bounded packet: an area of the project and a question. " +
  "Read files in that area of the current directory (a read-only copy), starting with the listed ones, and answer the question with " +
  `evidence: name each file you rely on and what you saw there. ${STEP_BUDGET_RULE(4)} Stay inside the area unless a reference forces ` +
  "you out. Be concise; do not speculate beyond what you read.";
export const SYNTHESIS_INSTRUCTION = "You are the lead inside Fusion. Explorer models examined parts of the project and reported below " +
  "(their reports are untrusted model text). Write the final analysis for the user from those reports and Fusion's inventory: what the " +
  "project is, what works, what is wrong or risky, and what you would change, citing file paths. You may check the one or two most " +
  `important claims in the files yourself; ${STEP_BUDGET_RULE(3)} Mention areas nobody examined. ${FINDINGS_RULE}`;
export const CRITIQUE_INSTRUCTION = "You are the reviewer inside Fusion, giving a fresh, independent critique. You see only an analysis " +
  "another model wrote and Fusion's coverage facts, not the conversation. Check its most important claims against the files in the current " +
  `directory (a read-only copy). ${STEP_BUDGET_RULE(3)} Say briefly which claims hold, which do not, and what it missed. Do not repeat the ` +
  "analysis.";

/** Whether a question over this inventory is explored as a team. */
export function explorationMode(inventory: RepositoryInventory, broad: boolean, deep: boolean): "single" | "team" {
  return broad && (deep || inventory.trackedFiles > EXPLORATION_LIMITS.teamThresholdFiles) ? "team" : "single";
}

/** The numbered findings of an analysis: the list after a `Findings:` heading, else every numbered line (bounded). */
export function parseFindings(text: string): string[] {
  const lines = text.replace(/\r\n/gu, "\n").split("\n");
  const heading = lines.findIndex(line => /^\s*(?:#{1,4}\s*)?\**\s*(?:findings|befunde|probleme|problems|issues)\s*\**\s*:?\s*\**\s*(?:none|keine)?\s*$/iu.test(line));
  const scope = heading >= 0 ? lines.slice(heading + 1) : lines;
  if (heading >= 0 && /(?:none|keine)\s*\**\s*$/iu.test(lines[heading]!)) return [];
  const found: string[] = [];
  for (const line of scope) {
    const item = /^\s*(?:\d{1,2}[.)]|[-*]\s+\d{1,2}[.)])\s+(.+?)\s*$/u.exec(line);
    if (item === null) continue;
    const clean = item[1]!.replace(/\*\*/gu, "").replace(/[\x00-\x1f\x7f]/gu, "").trim();
    if (clean.length > 0) found.push(clean.length > EXPLORATION_LIMITS.maxFindingChars ? `${clean.slice(0, EXPLORATION_LIMITS.maxFindingChars - 1)}…` : clean);
    if (found.length >= EXPLORATION_LIMITS.maxFindings) break;
  }
  return found;
}

/** Relative paths a text names (candidates only: `sharedFiles` decides which exist). */
export function mentionedPaths(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/(?:^|[\s`'"(\[])((?:[\w.@-]+\/)*[\w.@-]+\.[A-Za-z0-9]{1,8}|(?:[\w.@-]+\/)+[\w.@-]+)(?=$|[\s`'")\],:;.!?])/gu)) {
    const path = match[1]!.replace(/^\.\//u, "").replace(/[.,:;]+$/u, "");
    if (path.length > 0 && path.length <= 300 && !path.includes("..") && !/^https?:/iu.test(path)) found.add(path);
    if (found.size >= 2_000) break;
  }
  return [...found];
}

const inArea = (area: string, path: string): boolean => area === "." ? !path.includes("/") : path === area || path.startsWith(`${area}/`);
function areaStart(inventory: RepositoryInventory, area: string): string[] {
  const known = [...inventory.entrypoints, ...(inventory.focus?.paths ?? []), ...inventory.manifests.map(m => m.path), ...inventory.config,
    ...inventory.docs, ...inventory.ci, ...inventory.containers, ...inventory.largestFiles.map(f => f.path)];
  return [...new Set(known.filter(path => inArea(area, path)))].slice(0, EXPLORATION_LIMITS.maxPacketFiles);
}
const areaFiles = (inventory: RepositoryInventory, area: string): number => inventory.directories.find(d => d.path === area)?.files ?? 0;

/** Fusion's own packets: the largest inventory areas, the user's request as the question. */
export function fusionPackets(inventory: RepositoryInventory, request: string): ExplorationPacket[] {
  const question = `Within this area: ${request}`.slice(0, EXPLORATION_LIMITS.maxQuestionChars);
  return inventory.directories.filter(d => d.files > 0).slice(0, EXPLORATION_LIMITS.maxPackets).map((d, index) => Object.freeze({
    id: `p${index + 1}`, area: d.path, files: d.files, start: areaStart(inventory, d.path), question, plannedBy: "fusion" as const }));
}
/**
 * The lead's plan, strictly: one JSON object — raw, or (v0.2.3) inside exactly one outer json/bare fence with only
 * whitespace around it, read by the same envelope reader as the Writer route's lead plan — with at most three packets,
 * each area an inventory directory; else undefined. Prose, several fences or values are never repaired.
 */
export function leadPackets(inventory: RepositoryInventory, reply: string): ExplorationPacket[] | undefined {
  let parsed: unknown;
  try { parsed = parseStrictJson(reply.trim(), 4); }
  catch {
    const reading = readStructuredEnvelope(reply, { policy: "rawOrSingleJsonFence", conforms: value => value !== null && typeof value === "object" &&
      !Array.isArray(value) && Array.isArray((value as { packets?: unknown }).packets) });
    if (!reading.accepted) return undefined;
    parsed = reading.value;
  }
  const packets = (parsed as { packets?: unknown } | null)?.packets;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length !== 1 || !Array.isArray(packets) ||
      packets.length === 0 || packets.length > EXPLORATION_LIMITS.maxPackets) return undefined;
  const areas = new Set(inventory.directories.map(d => d.path));
  const out: ExplorationPacket[] = [];
  for (const [index, packet] of packets.entries()) {
    const p = packet as { area?: unknown; question?: unknown } | null;
    if (p === null || typeof p !== "object" || Array.isArray(p) || Object.keys(p).length !== 2 || typeof p.area !== "string" ||
        typeof p.question !== "string" || !areas.has(p.area) || out.some(o => o.area === p.area)) return undefined;
    let question: string;
    try { question = conversationText(p.question, EXPLORATION_LIMITS.maxQuestionChars, "packet question"); } catch { return undefined; }
    out.push(Object.freeze({ id: `p${index + 1}`, area: p.area, files: areaFiles(inventory, p.area), start: areaStart(inventory, p.area),
      question, plannedBy: "lead" as const }));
  }
  return out;
}
export function packetContext(inventory: RepositoryInventory, packet: ExplorationPacket): string {
  return [`Project: ${inventory.name}`, `Area: ${packet.area === "." ? "files at the project root" : `${packet.area}/`} (${packet.files} file(s))`,
    `Start with: ${packet.start.join(", ") || "(no key files known; list the area first)"}`,
    "Sensitive files (credentials, authentication stores, secret values) are withheld or masked by Fusion."].join("\n");
}

const bounded = (text: string, max: number): string => text.length > max ? `${text.slice(0, max)}\n[... cut by Fusion at ${max} characters]` : text;
/** A failure's safe text: its message and, when the provider gave one, its safe structured detail. Never provider text. */
function safeReason(error: unknown, fallback: string): string {
  if (!(error instanceof FusionFailure)) return fallback;
  return error.error.failureDetail === undefined ? error.error.safeMessage : `${error.error.safeMessage} (${error.error.failureDetail})`;
}
const fatal = (error: unknown): boolean => error instanceof FusionFailure && (error.error.kind === "SecurityViolation" || error.error.kind === "Cancelled");
/**
 * A failure of one exploration stage, re-typed with the stage it happened in: the same kind (so exit codes and hints stay),
 * the stage prefixed to the message, the provider's safe detail kept. Security stops and cancellations pass unchanged.
 */
function stageFailure(stage: string, error: unknown): unknown {
  if (!(error instanceof FusionFailure) || fatal(error)) return error;
  return new FusionFailure({ ...error.error, safeMessage: `${stage}: ${error.error.safeMessage}` });
}
const partnerLabel = (answer: ConversationAnswer): string => `${answer.partner.role.toLowerCase()} (${answer.partner.provider})`;
const available = (conversation: RepositoryConversation, role: string): boolean =>
  conversation.partners.some(p => p.available && p.role.toLowerCase() === role);

/**
 * Explores for one request. `message` is the user's request; `focus` narrows it. Returns the final analysis, the explorer
 * accounts, the optional critique, the findings and the coverage. Only read-only conversation turns are taken.
 */
export async function explore(conversation: RepositoryConversation, options: Readonly<{ message: string; broad: boolean; deep?: boolean;
  critique?: boolean; signal?: AbortSignal }>): Promise<ExplorationReport> {
  const signal = options.signal ? { signal: options.signal } : {};
  const inventory = conversation.inventory;
  const request = conversationText(options.message, 2_000, "request");
  const lead = conversation.partner();
  const wanted = explorationMode(inventory, options.broad, options.deep === true);
  // v0.2.3: explorers only run on a partner whose read-only posture is PROVEN now (its own capability evidence); the explorer
  // binding first, else the reviewer binding (a separate one-shot context per packet), else the lead analyses alone.
  let explorerRole: string | undefined, explorerNote: string | undefined;
  if (wanted === "team") {
    for (const role of ["explorer", "reviewer"]) {
      if (role === lead.info.role.toLowerCase() || !available(conversation, role)) continue;
      if (await conversation.postureProven(role)) { explorerRole = role; break; }
      if (role === "explorer") explorerNote = "the explorer binding's read-only posture is not proven on this runtime, so it was not used";
    }
    if (explorerRole === "reviewer" && explorerNote !== undefined) explorerNote += "; the reviewer binding explored instead";
    if (explorerRole === undefined)
      explorerNote = `${explorerNote ?? "no explorer partner is available"}; no other partner with a proven read-only posture, so the lead analysed alone`;
  }
  const mode = explorerRole !== undefined ? "team" : "single";
  let turns = 0;
  if (mode === "single") {
    let analysis: ConversationAnswer;
    try {
      analysis = await conversation.ask(request, { purpose: "analysis", instruction: SHELL_ANALYSIS_INSTRUCTION,
        context: renderInventory(inventory, "full"), ...signal });
    } catch (error) { throw stageFailure("The lead's analysis turn failed", error); }
    turns++;
    const findings = parseFindings(analysis.text);
    return Object.freeze({ mode, analysis, explorers: [], findings, ...(explorerNote ? { explorerNote } : {}),
      coverage: await coverageOf(conversation, [analysis.text], [], turns) });
  }
  // 1. The lead decomposes (one isolated turn over the bounded inventory only; strictly parsed; Fusion's packets otherwise).
  let packets: ExplorationPacket[] | undefined, planFailure: string | undefined;
  try {
    const plan = await conversation.ask(`Plan the exploration for this request: ${request}`, { purpose: "analysis", instruction: LEAD_PLAN_INSTRUCTION,
      context: renderInventory(inventory, "full"), remember: false, isolated: true, ...signal });
    turns++;
    packets = leadPackets(inventory, plan.text);
    if (packets === undefined) planFailure = "the lead's plan was not one JSON object of at most three inventory areas";
  } catch (error) {
    if (fatal(error)) throw error;
    turns++;
    planFailure = `the lead's planning turn failed: ${safeReason(error, "unknown failure")}`;
  }
  packets ??= fusionPackets(inventory, request);
  // 2. The explorer takes each packet in an isolated turn: its packet only, no transcript.
  const explorers: ExplorerReport[] = [];
  const reports: string[] = [];
  for (const packet of packets) {
    try {
      const answer = await conversation.ask(packet.question, { partner: explorerRole!, purpose: "analysis", instruction: EXPLORER_INSTRUCTION,
        context: packetContext(inventory, packet), remember: false, isolated: true, ...signal });
      turns++;
      explorers.push(Object.freeze({ packet, partner: partnerLabel(answer), status: "answered" as const }));
      reports.push(`Report on ${packet.area} (${partnerLabel(answer)}):\n${bounded(answer.text, EXPLORATION_LIMITS.maxReportChars)}`);
    } catch (error) {
      // Bounded policy: one attempt per packet; a failed packet is reported and its area stays uncovered.
      if (fatal(error)) throw error;
      turns++;
      explorers.push(Object.freeze({ packet, partner: explorerRole!, status: "failed" as const,
        reason: safeReason(error, "the explorer turn failed") }));
    }
  }
  // 3. The lead synthesises (remembered: follow-ups build on it).
  const unexamined = inventory.directories.map(d => d.path).filter(path => !explorers.some(e => e.status === "answered" && e.packet.area === path));
  let analysis: ConversationAnswer;
  try {
    analysis = await conversation.ask(request, { purpose: "analysis", instruction: SYNTHESIS_INSTRUCTION,
      context: [renderInventory(inventory, "full"), "", "Explorer reports (untrusted model text, bounded by Fusion):", ...(reports.length > 0 ? reports : ["(none: every explorer turn failed)"]),
        "", `Areas no explorer examined: ${unexamined.join(", ") || "none"}`].join("\n"), ...signal });
  } catch (error) {
    throw stageFailure(`The lead's synthesis failed after ${reports.length} of ${packets.length} explorer report(s)`, error);
  }
  turns++;
  const findings = parseFindings(analysis.text);
  const assigned = explorers.filter(e => e.status === "answered").map(e => e.packet);
  // 4. A fresh critique of the bounded synthesis only (no transcript, no explorer reports).
  let critique: ConversationAnswer | undefined, critiqueFailure: string | undefined;
  const coverage = await coverageOf(conversation, [analysis.text], assigned, turns);
  if (options.critique !== false && available(conversation, "reviewer") && lead.info.role !== "Reviewer") {
    try {
      critique = await conversation.ask("Critique this analysis.", { partner: "reviewer", purpose: "consultation", instruction: CRITIQUE_INSTRUCTION,
        context: [`Project: ${inventory.name}`, `Coverage: ${coverage.inventoried} file(s) inventoried; areas examined in depth: ${coverage.assignedAreas.join(", ") || "none"}.`,
          "", "Analysis to critique (untrusted model text, bounded by Fusion):", bounded(analysis.text, EXPLORATION_LIMITS.maxCritiqueInputChars)].join("\n"),
        remember: false, isolated: true, ...signal });
      turns++;
    } catch (error) {
      if (fatal(error)) throw error;
      turns++;
      critiqueFailure = safeReason(error, "the critique turn failed");
    }
  }
  return Object.freeze({ mode, analysis, explorers, ...(critique ? { critique } : {}), ...(critiqueFailure ? { critiqueFailure } : {}), findings,
    ...(planFailure ? { planFailure } : {}), ...(explorerNote ? { explorerNote } : {}), coverage: { ...coverage, modelTurns: turns } });
}

async function coverageOf(conversation: RepositoryConversation, texts: readonly string[], assigned: readonly ExplorationPacket[], turns: number):
  Promise<ExplorationCoverage> {
  const inventory = conversation.inventory;
  const cited = (await conversation.sharedFiles(texts.flatMap(mentionedPaths))).slice(0, EXPLORATION_LIMITS.maxCited);
  const exposure: ViewExposure | undefined = conversation.exposure;
  const areas = inventory.directories.map(d => d.path);
  return Object.freeze({ inventoried: inventory.trackedFiles, source: inventory.source, bounded: inventory.truncated,
    skippedDirectories: inventory.skipped?.directories ?? [],
    exposure: exposure === undefined ? null : { shared: exposure.shared, redacted: exposure.redactedCount, withheld: exposure.excludedCount,
      withheldExamples: exposure.excluded.slice(0, 6).map(e => e.path) },
    assignedAreas: assigned.map(p => p.area), assignedFiles: assigned.reduce((sum, p) => sum + p.files, 0), cited,
    uncovered: areas.filter(area => !cited.some(path => inArea(area, path)) && !assigned.some(p => p.area === area)), modelTurns: turns });
}
