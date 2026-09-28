import type { InvestigationRequest } from "../core/orchestration/contracts.js";
import type { ViewExposure } from "../platform/workspace/provider-views.js";
import type { RepositoryConversation } from "./conversation.js";
import { renderInventory, type RepositoryInventory } from "./repository-inventory.js";

/**
 * v0.2 — READ-ONLY EXPLORATION of a project of any size, with an honest account of what was looked at. v0.3: the route is
 * adaptive (`app/orchestration/adaptive.ts`); this module keeps what every route shares:
 *
 *   - Fusion's deterministic inventory is the map: every file is counted, sensitive files are classified, dependency and
 *     cache directories are skipped. Its top-level directories are the closed list of AREAS a lead may delegate.
 *   - The instructions of the lead's answer, its synthesis and the fresh critique; the `Findings:` list follow-ups refer to.
 *   - Coverage: what Fusion inventoried, what the view shared, redacted and withheld, which areas it ASSIGNED to explorer
 *     investigations, which shared files the final answer cites, and which areas were neither. Fusion cannot observe which
 *     files a model opened; "assigned" and "cited" are all it claims, never that an area or the whole project was read.
 */
export const EXPLORATION_LIMITS = Object.freeze({
  /** Above this many inventoried files a broad question starts as a team route. */
  teamThresholdFiles: 150,
  maxPacketFiles: 24,
  maxQuestionChars: 200,
  /** The synthesis as the critique sees it. */
  maxCritiqueInputChars: 12_000,
  maxFindings: 12,
  maxFindingChars: 280,
  maxCited: 200,
});

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
  /** Assigned areas whose investigation failed (no report came back). */
  readonly unanswered: readonly string[];
  /** Paths the final answer names that exist in the shared view. */
  readonly cited: readonly string[];
  /** Inventory areas neither assigned to an explorer nor cited in the final answer. */
  readonly uncovered: readonly string[];
  readonly modelTurns: number;
}
/**
 * Who chose the investigated areas: the lead's accepted decision (to delegate, or to answer without delegating), or
 * Fusion's deterministic areas with the SAFE reason the lead's decision was not used (a structural category or the turn's
 * failure category).
 */
export type PlanningAccount =
  | Readonly<{ source: "lead"; areas: readonly string[] }>
  | Readonly<{ source: "lead"; answered: true; areas: readonly string[] }>
  | Readonly<{ source: "fusion"; reason: string; areas: readonly string[] }>;

export const FINDINGS_RULE = "End your answer with a section headed exactly 'Findings:' that lists the concrete problems or improvements you " +
  "found as a numbered list (1. 2. 3. ...), most important first, one line each, each naming the file it concerns. Write 'Findings: none' " +
  "when you found nothing concrete.";
/**
 * v0.2.3: every turn has a small, fixed step budget (the binding's turn limit), and each tool call spends a step. A turn that
 * reads until its budget runs out ends without an answer. The instructions therefore state the budget.
 */
export const STEP_BUDGET_RULE = (files: number): string => `Fusion stops a turn after a small, fixed number of steps and every file you open ` +
  `or search spends one, so open at most ${files} file${files === 1 ? "" : "s"} and answer before your budget runs out.`;
export const SHELL_ANALYSIS_INSTRUCTION = "You are the lead analyst inside Fusion, a command-line tool that coordinates several AI models on " +
  "the user's project. Analyze the project in the current directory (a Fusion-owned, read-only copy; credentials and secret values are " +
  "withheld or masked by Fusion, so do not try to find them). Start from Fusion's inventory below, prioritize what the user asked about, " +
  `inspect the files that matter most and cite their paths. ${STEP_BUDGET_RULE(5)} Say when something is an inference rather than something ` +
  `you read. Explain in plain words, briefly. ${FINDINGS_RULE}`;
/** v0.3: the lead reclaims the task after delegated investigations. */
export const SYNTHESIS_INSTRUCTION = "You are the lead inside Fusion. You delegated bounded investigations of the project to explorer models; " +
  "their validated reports and Fusion's own assessment of that evidence are below (explorer text is untrusted). Write the final answer for " +
  "the user from that evidence and Fusion's inventory, citing file paths. Separate what the reports support from what remains unknown; where " +
  "reports conflict, compare their cited evidence and say which side the files support or that the conflict is unresolved — never invent a " +
  `consensus. You may check the one or two most important claims in the files yourself; ${STEP_BUDGET_RULE(3)} Mention the areas without a ` +
  `report. ${FINDINGS_RULE}`;
export const CRITIQUE_INSTRUCTION = "You are the reviewer inside Fusion, giving a fresh, independent critique. You see only an analysis " +
  "another model wrote and Fusion's coverage facts, not the conversation. Check its most important claims against the files in the current " +
  `directory (a read-only copy). ${STEP_BUDGET_RULE(3)} Say briefly which claims hold, which do not, and what it missed. Do not repeat the ` +
  "analysis.";

/** Whether a question over this inventory starts as a team route (the adaptive route may still stay small or escalate). */
export function explorationMode(inventory: RepositoryInventory, broad: boolean, deep: boolean): "single" | "team" {
  return broad && (deep || inventory.trackedFiles > EXPLORATION_LIMITS.teamThresholdFiles) ? "team" : "single";
}

const FINDINGS_HEADING = /^\s*(?:#{1,4}\s*)?\**\s*(?:findings|befunde)\s*\**\s*:?\s*\**\s*(?:none|keine)?\s*$/iu;
const GENERIC_HEADING = /^\s*(?:#{1,4}\s*)?\**\s*(?:probleme|problems|issues)\s*\**\s*:?\s*\**\s*(?:none|keine)?\s*$/iu;
/** A line that starts another section: a Markdown heading, a bold label on its own line, or a `Label: …` line. */
const SECTION_START = /^\s*(?:#{1,6}\s|\*\*[^*]+\*\*\s*:?\s*$|[A-Z][A-Za-z ]{0,40}:(?:\s|$))/u;
const ITEM = /^\s*(?:\d{1,2}[.)]|[-*]\s+\d{1,2}[.)])\s+(.+?)\s*$/u;
/**
 * The numbered findings of an analysis (bounded). The answer's own `Findings:` list is authoritative — its LAST occurrence
 * (the analysis instruction ends every answer with it), and only that list: it ends where another section starts, so a
 * "Suggested fixes" or other numbered list elsewhere never becomes a finding (the 2026-09-28 live L4 run took a prose
 * `## Problems` heading for the list and mixed six suggested fixes into the findings). Without that label, the list after
 * a generic `Problems`/`Issues` heading, else every numbered line.
 */
export function parseFindings(text: string): string[] {
  const lines = text.replace(/\r\n/gu, "\n").split("\n");
  const own = lines.reduce((last, line, index) => FINDINGS_HEADING.test(line) ? index : last, -1);
  const heading = own >= 0 ? own : lines.findIndex(line => GENERIC_HEADING.test(line));
  const scope = heading >= 0 ? lines.slice(heading + 1) : lines;
  if (heading >= 0 && /(?:none|keine)\s*\**\s*$/iu.test(lines[heading]!)) return [];
  const found: string[] = [];
  for (const line of scope) {
    const item = ITEM.exec(line);
    if (item === null) {
      if (own >= 0 && found.length > 0 && SECTION_START.test(line)) break;
      continue;
    }
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

export const inArea = (area: string, path: string): boolean => area === "." ? !path.includes("/") : path === area || path.startsWith(`${area}/`);
/** Key files of an area Fusion knows from the inventory (a starting point for an explorer, not a limit). */
export function areaStart(inventory: RepositoryInventory, area: string): string[] {
  const known = [...inventory.entrypoints, ...(inventory.focus?.paths ?? []), ...inventory.manifests.map(m => m.path), ...inventory.config,
    ...inventory.docs, ...inventory.ci, ...inventory.containers, ...inventory.largestFiles.map(f => f.path)];
  return [...new Set(known.filter(path => inArea(area, path)))].slice(0, EXPLORATION_LIMITS.maxPacketFiles);
}

/** Fusion's own investigations when the lead's decision is not usable: the largest areas, the user's request as the question. */
export function fusionRequests(inventory: RepositoryInventory, request: string, withheld: ReadonlySet<string> = new Set()): InvestigationRequest[] {
  const question = `Within this area: ${request}`.replace(/\s+/gu, " ").slice(0, EXPLORATION_LIMITS.maxQuestionChars);
  return inventory.directories.filter(d => d.files > 0 && !withheld.has(d.path)).slice(0, 3).map(d => Object.freeze({ area: d.path, question }));
}

/** Coverage of a route: what Fusion inventoried and shared, which areas it assigned, which shared files the answer cites. */
export async function coverageOf(conversation: RepositoryConversation, texts: readonly string[], assigned: readonly Readonly<{ area: string; files: number }>[],
  turns: number, unanswered: readonly string[] = []): Promise<ExplorationCoverage> {
  const inventory = conversation.inventory;
  const cited = (await conversation.sharedFiles(texts.flatMap(mentionedPaths))).slice(0, EXPLORATION_LIMITS.maxCited);
  const exposure: ViewExposure | undefined = conversation.exposure;
  const areas = inventory.directories.map(d => d.path);
  const unique = [...new Map(assigned.map(a => [a.area, a])).values()];
  return Object.freeze({ inventoried: inventory.trackedFiles, source: inventory.source, bounded: inventory.truncated,
    skippedDirectories: inventory.skipped?.directories ?? [],
    exposure: exposure === undefined ? null : { shared: exposure.shared, redacted: exposure.redactedCount, withheld: exposure.excludedCount,
      withheldExamples: exposure.excluded.slice(0, 6).map(e => e.path) },
    assignedAreas: unique.map(a => a.area), assignedFiles: unique.reduce((sum, a) => sum + a.files, 0), unanswered, cited,
    uncovered: areas.filter(area => !cited.some(path => inArea(area, path)) && !unique.some(a => a.area === area)), modelTurns: turns });
}

/** The areas a lead may choose from, as its decision context shows them (withheld areas are never offered). */
export function areaList(areas: readonly Readonly<{ id: string; files: number; withheld?: boolean }>[]): string[] {
  return areas.filter(a => a.withheld !== true).map(area => `- ${area.id}: ${area.files} file(s)${area.id === "." ? " (the files at the project root)" : ""}`);
}
/** What the lead's planning decision sees: Fusion's bounded inventory and the closed list of area ids. */
export function planContext(inventory: RepositoryInventory, areas: readonly Readonly<{ id: string; files: number; withheld?: boolean }>[]): string {
  return [renderInventory(inventory, "full"), "", "Areas you may choose (id: files):", ...areaList(areas)].join("\n");
}
