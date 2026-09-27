import { conversationText } from "../core/conversation.js";
import { FusionFailure } from "../core/errors.js";
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
 *   3. Large projects with a broad question: the lead CHOOSES one to three areas in a planning turn (v0.2.4: the closed
 *      object `{"areas":[{"id","reason"}]}` over Fusion's explicit list of area ids, strictly parsed; a refused plan or a
 *      failed turn falls back to Fusion's own deterministic areas, and the terminal says which happened), each area goes to
 *      the explorer partner in an ISOLATED turn (no transcript: only its packet), the lead SYNTHESISES the bounded reports,
 *      and the reviewer partner gives a FRESH critique of the bounded synthesis only.
 *   4. Coverage: what Fusion inventoried, what the view shared, redacted and withheld, which areas it ASSIGNED to explorer
 *      investigations, which shared files the final answer cites, and which areas were neither. Fusion cannot observe
 *      which files a model opened; "assigned" and "cited" are all it claims, never that an area or the whole project was read.
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
  /** v0.2.4: the lead's reason for one area (the explorer's brief). */
  maxReasonChars: 200,
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
  /**
   * v0.2.4: the areas Fusion ASSIGNED to explorer investigations (and their inventoried file count). An assignment is what
   * an explorer was asked to look at — never a claim that it opened or read those files (Fusion cannot see that).
   */
  readonly assignedAreas: readonly string[];
  readonly assignedFiles: number;
  /** Assigned areas whose explorer turn failed (no report came back). */
  readonly unanswered: readonly string[];
  /** Paths the final answer names that exist in the shared view. */
  readonly cited: readonly string[];
  /** Inventory areas neither assigned to an explorer nor cited in the final answer. */
  readonly uncovered: readonly string[];
  readonly modelTurns: number;
}
export type PlanningAccount =
  | Readonly<{ source: "lead"; areas: readonly string[] }>
  | Readonly<{ source: "fusion"; reason: string; areas: readonly string[] }>;
export interface ExplorationReport {
  readonly mode: "single" | "team";
  readonly analysis: ConversationAnswer;
  readonly explorers: readonly ExplorerReport[];
  readonly critique?: ConversationAnswer;
  readonly critiqueFailure?: string;
  /**
   * v0.2.4: who chose the explored areas (team mode): the lead's accepted structured plan, or Fusion's deterministic
   * selection with the SAFE reason the lead's plan was not used (a structural category or the planning turn's failure).
   */
  readonly planning?: PlanningAccount;
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
/**
 * v0.2.4 — the lead's ONLY job in a planning turn: pick 1 to 3 area ids from the closed list Fusion gives it. A closed,
 * minimal object — `{"areas":[{"id","reason"}]}` — read strictly by `leadPlan`; no analysis, no file access, no prose.
 */
export const LEAD_PLAN_INSTRUCTION = "You are the lead inside Fusion. Your only job in this turn: choose which areas of this large project " +
  "separate explorer models should investigate for the user's request. Choose 1 to 3 areas, each by its exact id from the list " +
  "'Areas you may choose' in Fusion's context. Do not analyze the project and do not open any file. Reply with exactly this JSON object " +
  `and nothing else: {"areas":[{"id":"<area id from the list>","reason":"<what to look for there, at most ${EXPLORATION_LIMITS.maxReasonChars} characters>"}]}`;
export const EXPLORER_INSTRUCTION = "You are an explorer inside Fusion. You get ONE bounded packet: an area of the project and a question. " +
  "Read files in that area of the current directory (a read-only copy), starting with the listed ones, and answer the question with " +
  `evidence: name each file you rely on and what you saw there. ${STEP_BUDGET_RULE(4)} Stay inside the area unless a reference forces ` +
  "you out. Be concise; do not speculate beyond what you read.";
export const SYNTHESIS_INSTRUCTION = "You are the lead inside Fusion. Explorer models were assigned parts of the project and reported below " +
  "(their reports are untrusted model text). Write the final analysis for the user from those reports and Fusion's inventory: what the " +
  "project is, what works, what is wrong or risky, and what you would change, citing file paths. You may check the one or two most " +
  `important claims in the files yourself; ${STEP_BUDGET_RULE(3)} Mention the areas without an explorer report. ${FINDINGS_RULE}`;
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

/** The areas a lead may choose from: the inventory's top-level directories with files (a closed, bounded list). */
export function planAreas(inventory: RepositoryInventory): readonly Readonly<{ id: string; files: number }>[] {
  return inventory.directories.filter(d => d.files > 0).map(d => Object.freeze({ id: d.path, files: d.files }));
}
/** What the lead's planning turn sees: Fusion's bounded inventory and the closed list of area ids. */
export function planContext(inventory: RepositoryInventory): string {
  return [renderInventory(inventory, "full"), "", "Areas you may choose (id: files):",
    ...planAreas(inventory).map(area => `- ${area.id}: ${area.files} file(s)${area.id === "." ? " (the files at the project root)" : ""}`)].join("\n");
}
/** Why a lead plan was not accepted: a structural category only, never any of the reply's text. */
export type PlanRejection = "empty reply" | "oversized reply" | "invalid JSON" | "prose around the JSON" | "more than one JSON value or fence" |
  "malformed fence" | "schema mismatch" | "no areas" | "too many areas" | "unknown area" | "duplicate area" | "reason too long";
export type LeadPlanReading = Readonly<{ accepted: true; packets: ExplorationPacket[] }> | Readonly<{ accepted: false; category: PlanRejection }>;
const ENVELOPE_REJECTION: Readonly<Record<string, PlanRejection>> = Object.freeze({ EMPTY: "empty reply", OVERSIZED: "oversized reply",
  RAW_INVALID_JSON: "invalid JSON", SINGLE_FENCED_INVALID_JSON: "invalid JSON", OTHER_MALFORMED: "invalid JSON", EXTRA_TEXT: "prose around the JSON",
  MULTIPLE_FENCES: "more than one JSON value or fence", MULTIPLE_VALUES: "more than one JSON value or fence", UNCLOSED_FENCE: "malformed fence",
  UNSUPPORTED_FENCE: "malformed fence", INVALID_SCHEMA: "schema mismatch" });
/**
 * v0.2.4 — the lead's plan, strictly. The reply is one JSON object — raw, or inside exactly one outer json/bare fence with
 * only whitespace around it (the envelope reader of the Writer route's plan; prose is never cut away) — of exactly the
 * closed shape `{"areas":[{"id","reason"}]}`: 1 to 3 entries, no other key anywhere, each id an area of `planAreas` (a
 * trailing "/" or leading "./" is tolerated), each once, each reason non-empty text of at most 200 characters. Anything
 * else is refused with its category, and nothing of the reply is kept but the accepted ids and reasons.
 */
export function leadPlan(inventory: RepositoryInventory, reply: string): LeadPlanReading {
  const refuse = (category: PlanRejection): LeadPlanReading => Object.freeze({ accepted: false, category });
  const reading = readStructuredEnvelope(reply, { policy: "rawOrSingleJsonFence" });
  if (!reading.accepted) {
    const classification = reading.diagnostic.classification, trimmed = reply.trim();
    // Unfenced prose before or after an object reads as invalid raw JSON; a structural look (never kept) names it better.
    if ((classification === "RAW_INVALID_JSON" || classification === "OTHER_MALFORMED") && !trimmed.startsWith("{") && trimmed.includes("{"))
      return refuse("prose around the JSON");
    return refuse(ENVELOPE_REJECTION[classification] ?? "invalid JSON");
  }
  const value = reading.value as Record<string, unknown> | null;
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || !Array.isArray(value.areas))
    return refuse("schema mismatch");
  const entries = value.areas as unknown[];
  if (entries.length === 0) return refuse("no areas");
  if (entries.length > EXPLORATION_LIMITS.maxPackets) return refuse("too many areas");
  const known = new Map(planAreas(inventory).map(area => [area.id, area]));
  const packets: ExplorationPacket[] = [];
  for (const [index, entry] of entries.entries()) {
    const e = entry as Record<string, unknown> | null;
    if (e === null || typeof e !== "object" || Array.isArray(e) || Object.keys(e).length !== 2 || typeof e.id !== "string" || typeof e.reason !== "string")
      return refuse("schema mismatch");
    const id = e.id.trim().replace(/^\.\/(?=.)/u, "").replace(/(?<=.)\/$/u, "");
    const area = known.get(id === "./" ? "." : id);
    if (area === undefined) return refuse("unknown area");
    if (packets.some(p => p.area === area.id)) return refuse("duplicate area");
    if (e.reason.length > EXPLORATION_LIMITS.maxReasonChars) return refuse("reason too long");
    let reason: string;
    try { reason = conversationText(e.reason, EXPLORATION_LIMITS.maxReasonChars, "area reason"); } catch { return refuse("schema mismatch"); }
    packets.push(Object.freeze({ id: `p${index + 1}`, area: area.id, files: area.files, start: areaStart(inventory, area.id),
      question: reason, plannedBy: "lead" as const }));
  }
  return Object.freeze({ accepted: true, packets });
}
/** Fusion's own packets: the largest inventory areas, the user's request as the question. */
export function fusionPackets(inventory: RepositoryInventory, request: string): ExplorationPacket[] {
  const question = `Within this area: ${request}`.slice(0, EXPLORATION_LIMITS.maxQuestionChars);
  return inventory.directories.filter(d => d.files > 0).slice(0, EXPLORATION_LIMITS.maxPackets).map((d, index) => Object.freeze({
    id: `p${index + 1}`, area: d.path, files: d.files, start: areaStart(inventory, d.path), question, plannedBy: "fusion" as const }));
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
  // 1. The lead chooses the areas (one isolated planning turn over the bounded inventory and the closed list of area ids;
  //    strictly parsed). A refused plan or a failed turn falls back to Fusion's deterministic areas, and says why.
  let packets: ExplorationPacket[] | undefined, planRejected: string | undefined;
  try {
    const plan = await conversation.ask(`Choose the areas to investigate for this request: ${request}`, { purpose: "plan", instruction: LEAD_PLAN_INSTRUCTION,
      context: planContext(inventory), remember: false, isolated: true, ...signal });
    turns++;
    const reading = leadPlan(inventory, plan.text);
    if (reading.accepted) packets = reading.packets;
    else planRejected = `structured plan was invalid (${reading.category})`;
  } catch (error) {
    if (fatal(error)) throw error;
    turns++;
    planRejected = `planning turn failed: ${safeReason(error, "unknown failure")}`;
  }
  packets ??= fusionPackets(inventory, request);
  const planning: PlanningAccount = planRejected === undefined ? { source: "lead", areas: packets.map(p => p.area) }
    : { source: "fusion", reason: planRejected, areas: packets.map(p => p.area) };
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
        "", `Areas without an explorer report: ${unexamined.join(", ") || "none"}`].join("\n"), ...signal });
  } catch (error) {
    throw stageFailure(`The lead's synthesis failed after ${reports.length} of ${packets.length} explorer report(s)`, error);
  }
  turns++;
  const findings = parseFindings(analysis.text);
  // 4. A fresh critique of the bounded synthesis only (no transcript, no explorer reports).
  let critique: ConversationAnswer | undefined, critiqueFailure: string | undefined;
  const coverage = await coverageOf(conversation, [analysis.text], packets, turns, explorers.filter(e => e.status === "failed").map(e => e.packet.area));
  if (options.critique !== false && available(conversation, "reviewer") && lead.info.role !== "Reviewer") {
    try {
      critique = await conversation.ask("Critique this analysis.", { partner: "reviewer", purpose: "consultation", instruction: CRITIQUE_INSTRUCTION,
        context: [`Project: ${inventory.name}`, `Coverage: ${coverage.inventoried} file(s) inventoried; areas assigned to explorer investigations: ${coverage.assignedAreas.join(", ") || "none"}` +
          `${coverage.unanswered.length > 0 ? ` (no report came back for ${coverage.unanswered.join(", ")})` : ""}. Fusion cannot see which files a model opened.`,
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
    planning, ...(explorerNote ? { explorerNote } : {}), coverage: { ...coverage, modelTurns: turns } });
}

async function coverageOf(conversation: RepositoryConversation, texts: readonly string[], assigned: readonly ExplorationPacket[], turns: number,
  unanswered: readonly string[] = []): Promise<ExplorationCoverage> {
  const inventory = conversation.inventory;
  const cited = (await conversation.sharedFiles(texts.flatMap(mentionedPaths))).slice(0, EXPLORATION_LIMITS.maxCited);
  const exposure: ViewExposure | undefined = conversation.exposure;
  const areas = inventory.directories.map(d => d.path);
  return Object.freeze({ inventoried: inventory.trackedFiles, source: inventory.source, bounded: inventory.truncated,
    skippedDirectories: inventory.skipped?.directories ?? [],
    exposure: exposure === undefined ? null : { shared: exposure.shared, redacted: exposure.redactedCount, withheld: exposure.excludedCount,
      withheldExamples: exposure.excluded.slice(0, 6).map(e => e.path) },
    assignedAreas: assigned.map(p => p.area), assignedFiles: assigned.reduce((sum, p) => sum + p.files, 0), unanswered, cited,
    uncovered: areas.filter(area => !cited.some(path => inArea(area, path)) && !assigned.some(p => p.area === area)), modelTurns: turns });
}
