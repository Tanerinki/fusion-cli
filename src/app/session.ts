import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, posix, win32 } from "node:path";
import { grantFor, type IntentReference, type TurnIntent } from "../core/intent.js";
import { defaultDeliveryStoreBase } from "../platform/delivery/state-root.js";

/**
 * v0.2 — THE SHELL'S SESSION: the bounded state that lets follow-ups work ("explain the first one", "fix it") and the turn
 * plan the host derives from a classified intent. Nothing here grants a capability by itself: `planTurn` maps an intent to
 * a plan only within `grantFor(intent.kind)`, and a change plan only ever leads to the confirmed Writer route (and never in
 * a folder without a Git baseline). Findings and proposals are untrusted model text, kept bounded in memory, used only as
 * the wording of a later question or of a task the human confirms.
 *
 * Persisted per project: SAFE METADATA only (counts, times, the source kind, the last delivery id) under Fusion's own
 * application state — never a transcript, a finding, a task text, a path or a secret.
 */
export const SESSION_LIMITS = Object.freeze({ maxFindings: 12, maxTaskChars: 1_200, maxRememberedTurns: 10_000 });

export interface SessionState {
  /** The last analysis's numbered findings (untrusted, bounded). */
  findings: string[];
  /** The finding the conversation is about (0-based), after a follow-up named one. */
  focus?: number;
  /** A task a reply proposed (untrusted; only ever the wording of a task the human confirms). */
  proposal?: string;
  /**
   * v0.3: what Fusion's own verification of one finding established — the shared files it cited and the host's count of
   * verdicts. Host-observed facts only; a later change request about that finding carries them into its task. `source`
   * says who cited them: the explorers' reports (`investigations`), or — when the lead verified the finding itself,
   * without investigations — the lead's answer (`lead`); either way only files Fusion found in the shared copy count.
   */
  verified?: Readonly<{ index: number; source: "investigations" | "lead"; cited: readonly string[]; supported: number; contradicted: number }>;
  /** The last delivery a build in this session prepared. */
  deliveryId?: string;
  turns: number;
  analyses: number;
  changeRequests: number;
  /** v0.3: safe orchestration counts of this session's routes. */
  orchestration: OrchestrationCounts;
}
/** v0.3: safe counts of adaptive routes (no text, no path): what a later optimisation may look at. */
export const ORCHESTRATION_COUNTERS = Object.freeze(["routes", "modelTurns", "leadTurns", "explorerTurns", "reviewerTurns", "batches",
  "parallelBatches", "retries", "failedInvestigations", "leadReclaims", "escalations", "fallbacks", "budgetStops", "durationMs"] as const);
export type OrchestrationCounts = Record<(typeof ORCHESTRATION_COUNTERS)[number], number>;
export const noOrchestration = (): OrchestrationCounts =>
  Object.fromEntries(ORCHESTRATION_COUNTERS.map(key => [key, 0])) as OrchestrationCounts;
/** Adds one route's counts (each capped at the largest safe integer). */
export function addOrchestration(total: OrchestrationCounts, route: Readonly<Partial<Record<keyof OrchestrationCounts, number>>>): void {
  for (const key of ORCHESTRATION_COUNTERS) {
    const value = route[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) total[key] = Math.min(Number.MAX_SAFE_INTEGER, total[key] + value);
  }
}
export const newSessionState = (): SessionState => ({ findings: [], turns: 0, analyses: 0, changeRequests: 0, orchestration: noOrchestration() });

export type TurnPlan =
  | Readonly<{ kind: "local"; what: "empty" | "help" | "exit" | "history" | "undo" }>
  | Readonly<{ kind: "refuse"; what: "bypass" }>
  | Readonly<{ kind: "clarify"; question: string }>
  | Readonly<{ kind: "ask"; message: string }>
  | Readonly<{ kind: "analyze"; message: string; broad: boolean }>
  /** v0.3: a read-only investigation of whether one finding holds (the finding is the route's claim). */
  | Readonly<{ kind: "verify"; message: string; claim: string; index: number }>
  | Readonly<{ kind: "change"; task: string }>
  | Readonly<{ kind: "apply"; deliveryId: string }>
  | Readonly<{ kind: "blocked"; reason: "noGitBaseline"; task?: string }>
  | Readonly<{ kind: "create"; description: string }>;

const clip = (text: string, max: number): string => text.length > max ? `${text.slice(0, max - 1)}…` : text;
function referenced(state: SessionState, reference: IntentReference | undefined): Readonly<{ indices: number[]; text: string }> | undefined {
  if (reference === undefined || state.findings.length === 0) return undefined;
  if (reference.kind === "all") return { indices: state.findings.map((_, i) => i), text: state.findings.map((f, i) => `${i + 1}. ${f}`).join("\n") };
  const index = reference.kind === "index" ? (reference.index < 0 ? state.findings.length - 1 : reference.index) : state.focus;
  if (index === undefined || index < 0 || index >= state.findings.length) return undefined;
  return { indices: [index], text: `${index + 1}. ${state.findings[index]!}` };
}

/** v0.3: words that make a pronoun ("is that really …?") refer to a finding. */
const FINDING_WORD = /\b(?:bug|issue|problem|finding|error|mistake|defect|true|correct|right|real|fehler|problem|befund|stimmt|richtig|korrekt)\b/u;
/**
 * v0.3: the DISTINCTIVE terms of a text, lowercased: its identifier-like tokens (with `_`, `.` or `/`, at least 5
 * characters: `trusted_proxies`, `configuration.yaml`, `custom_components/example/manifest.json`) and each such segment of a
 * path. Whole tokens only: `proxies` is not `trusted_proxies`, and `http` is not `http.use_x_forwarded_for`.
 */
export function distinctiveTerms(text: string): ReadonlySet<string> {
  const terms = new Set<string>();
  for (const token of text.toLowerCase().match(/[a-z0-9][a-z0-9_./-]*[a-z0-9]/gu) ?? []) {
    if (token.length < 5 || !/[_./]/u.test(token)) continue;
    terms.add(token);
    // A path names its file too (`manifest.json`); a dotted key its identifier (`http.use_x_forwarded_for`).
    for (const part of token.split("/")) if (part !== token && part.length >= 5 && /[_.]/u.test(part)) terms.add(part);
    for (const part of token.split(/[/.]/u)) if (part !== token && part.length >= 5 && part.includes("_")) terms.add(part);
  }
  return terms;
}
/**
 * v0.3: which finding of the last analysis a line names by its distinctive terms — deterministic, never a guess:
 *  - `none`: the line names no distinctive term (or there is no finding): references by position or pronoun decide;
 *  - `one`: exactly ONE finding carries every term the line names ("is the trusted_proxies finding really a problem?");
 *  - `ambiguous`: several do — Fusion asks which one;
 *  - `unknown`: none does — Fusion asks; it never falls back to the first finding or to a proposal.
 */
export type FindingSelection = Readonly<{ kind: "none" }> | Readonly<{ kind: "one"; index: number }> |
  Readonly<{ kind: "ambiguous"; indices: readonly number[] }> | Readonly<{ kind: "unknown"; terms: readonly string[] }>;
export function selectFinding(text: string, findings: readonly string[]): FindingSelection {
  const named = [...distinctiveTerms(text)];
  if (named.length === 0 || findings.length === 0) return { kind: "none" };
  const matching = findings.flatMap((finding, index) => { const own = distinctiveTerms(finding); return named.every(term => own.has(term)) ? [index] : []; });
  if (matching.length === 1) return { kind: "one", index: matching[0]! };
  return matching.length > 1 ? { kind: "ambiguous", indices: Object.freeze(matching) } : { kind: "unknown", terms: Object.freeze(named) };
}
/** The question Fusion asks instead of guessing which finding a line means (no model turn; the session is unchanged). */
function whichFinding(state: SessionState, selection: FindingSelection, example: (n: number) => string): TurnPlan {
  if (selection.kind === "ambiguous")
    return { kind: "clarify", question: `That matches ${selection.indices.length} findings of the last analysis:\n` +
      `${selection.indices.map(i => `  ${i + 1}. ${clip(state.findings[i]!, 110)}`).join("\n")}\nWhich one? For example: "${example(selection.indices[0]! + 1)}".` };
  const terms = selection.kind === "unknown" ? selection.terms.map(t => `\`${t}\``).join(", ") : "that";
  return { kind: "clarify", question: `No finding of the last analysis mentions ${terms}. Name one by its number (for example: "${example(1)}"), ` +
    "or ask for a new analysis." };
}

/**
 * The plan for one classified line. `source` is what the shell runs on: in a `folder` (no Git baseline) a change request is
 * BLOCKED, never started. The returned plan never exceeds the intent's grant.
 */
export function planTurn(intent: TurnIntent, state: SessionState, source: "git" | "folder"): TurnPlan {
  const grant = grantFor(intent.kind);
  // v0.3: "is that really a bug?" about ONE earlier finding is investigated as a claim — still a read-only turn.
  const lower = intent.text.toLowerCase();
  if (intent.verification === true && grant.mutation === "never" && grant.providers === "readOnly" && intent.kind !== "plan") {
    const explicit = intent.reference?.kind === "index" || intent.reference?.kind === "all" ? intent.reference : undefined;
    // A finding named by its terms: exactly one, or Fusion asks (several, or none that mentions them) — never a guess.
    const selection = explicit === undefined ? selectFinding(intent.text, state.findings) : { kind: "none" as const };
    if (selection.kind === "ambiguous" || (selection.kind === "unknown" && FINDING_WORD.test(lower)))
      return whichFinding(state, selection, n => `is finding ${n} really a problem?`);
    const named = explicit ?? (selection.kind === "one" ? { kind: "index" as const, index: selection.index } : undefined);
    // "is that really a bug?" refers back; "is this project really done?" does not: a pronoun needs a word about a finding.
    const pronoun = (intent.reference?.kind === "previous" || state.focus !== undefined) && FINDING_WORD.test(lower);
    const ref = referenced(state, named ?? (pronoun ? { kind: "previous" } : undefined));
    if (ref !== undefined && ref.indices.length === 1) {
      const index = ref.indices[0]!;
      state.focus = index;
      return { kind: "verify", claim: state.findings[index]!, index,
        message: `${intent.text}\n\n(The user refers to this finding from the earlier analysis:\n${ref.text})` };
    }
  }
  switch (intent.kind) {
    case "empty": case "help": case "exit": case "history": case "undo": return { kind: "local", what: intent.kind };
    case "bypass": return { kind: "refuse", what: "bypass" };
    case "clarify": return { kind: "clarify", question: "That would remove or rewrite a lot at once. Which files, exactly, and what should happen to them? " +
      "Fusion changes projects only through its verified route, one confirmed task at a time." };
    case "create": return { kind: "create", description: intent.text };
    case "analysis": return { kind: "analyze", message: intent.text, broad: intent.broad };
    case "conversation": case "investigation": case "plan": {
      // Only a reference by position, to all findings or to one finding by its terms adds context; the transcript already
      // carries "it". A finding named this way becomes the active one.
      const selection = intent.reference === undefined ? selectFinding(intent.text, state.findings) : { kind: "none" as const };
      const ref = intent.reference?.kind === "previous" ? undefined
        : referenced(state, intent.reference ?? (selection.kind === "one" ? { kind: "index", index: selection.index } : undefined));
      if (ref !== undefined && ref.indices.length === 1) state.focus = ref.indices[0]!;
      const message = ref === undefined ? intent.text
        : `${intent.text}\n\n(The user refers to ${ref.indices.length === 1 ? "this finding" : "these findings"} from the earlier analysis:\n${ref.text})`;
      return { kind: "ask", message };
    }
    case "change": {
      if (grant.mutation !== "afterConfirmation") return { kind: "clarify", question: "Nothing to change." };
      const words = intent.text.split(/\s+/u).filter(Boolean).length;
      // "apply" (or "apply it") offers the change this session prepared, through the same summary and explicit yes.
      if (words <= 4 && /^(?:please |bitte )?(?:apply|anwenden|uebernehmen|übernehmen)\b/iu.test(intent.text)) {
        if (source === "git" && state.deliveryId !== undefined) return { kind: "apply", deliveryId: state.deliveryId };
        return { kind: "clarify", question: source === "git" ? "There is no prepared change to apply in this session. Ask for a change first " +
          "(for example \"fix the first finding\"), or see fusion history." : "Nothing can be applied here: this folder has no Git baseline." };
      }
      // "fix the trusted_proxies finding": the finding its terms name (exactly one), else Fusion asks rather than falling back
      // to the finding in focus, the first one or a proposal.
      const selection = intent.reference === undefined ? selectFinding(intent.text, state.findings) : { kind: "none" as const };
      if (words <= 6 && (selection.kind === "ambiguous" || (selection.kind === "unknown" && FINDING_WORD.test(lower))))
        return whichFinding(state, selection, n => `fix finding ${n}`);
      const ref = referenced(state, intent.reference ?? (selection.kind === "one" ? { kind: "index", index: selection.index }
        : state.findings.length > 0 || state.proposal !== undefined ? { kind: "previous" } : undefined));
      // A short follow-up ("fix it", "fix the first one", "fix them") takes its wording from what it refers to.
      let task: string | undefined;
      if (words <= 5 && ref !== undefined) task = ref.indices.length === 1 ? `Fix this finding from the analysis: ${state.findings[ref.indices[0]!]!}`
        : `Fix these findings from the analysis:\n${ref.text}`;
      else if (words <= 5 && state.proposal !== undefined) task = state.proposal;
      else if (words > 2 || ref !== undefined) task = ref === undefined ? intent.text : `${intent.text}\n\nIt refers to:\n${ref.text}`;
      if (source === "folder") return { kind: "blocked", reason: "noGitBaseline", ...(task === undefined ? {} : { task: clip(task, SESSION_LIMITS.maxTaskChars) }) };
      if (task === undefined) return { kind: "clarify", question: "What should I change? Name the file or the problem, or ask for an analysis first." };
      if (ref !== undefined && ref.indices.length === 1) state.focus = ref.indices[0]!;
      // v0.3: the host's own evidence about that finding (cited shared files) helps the lead choose the exact file scope.
      const verified = state.verified;
      if (ref !== undefined && ref.indices.length === 1 && verified !== undefined && verified.index === ref.indices[0] && verified.cited.length > 0)
        task = `${task}\n\n(Fusion's ${verified.source === "lead" ? "verification" : "investigation"} of this finding cited: ${verified.cited.slice(0, 8).join(", ")})`;
      return { kind: "change", task: clip(task, SESSION_LIMITS.maxTaskChars) };
    }
  }
}

// ---------------------------------------------------------------- safe metadata

export const SESSION_METADATA_FORMAT = "fusion.shellSession" as const;
export interface SessionMetadata {
  readonly format: typeof SESSION_METADATA_FORMAT;
  /** 2 since v0.3 (orchestration counts); a version-1 file is read as having none. */
  readonly version: 2;
  readonly source: "git" | "folder";
  readonly lastUsedAt: string;
  readonly sessions: number;
  readonly turns: number;
  readonly analyses: number;
  readonly changeRequests: number;
  /** The last delivery a shell build prepared (an id, never content). */
  readonly lastDeliveryId: string | null;
  /** v0.3: safe counts of every adaptive route this project's sessions ran (numbers only). */
  readonly orchestration: Readonly<OrchestrationCounts>;
}
const DELIVERY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** Where a project's session metadata lives: Fusion's application state, keyed by a digest of the project root (never the path). */
export function sessionMetadataPath(env: Readonly<Record<string, string | undefined>>, root: string, platform: NodeJS.Platform = process.platform): string {
  const base = dirname(defaultDeliveryStoreBase(env, platform));
  const normalized = platform === "win32" ? win32.resolve(root).toLowerCase() : posix.resolve(root);
  const key = createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 32);
  return join(base, "sessions", `${key}.json`);
}
/** The stored metadata, or undefined (missing, malformed, a link, too large: treated as none). A version-1 file has no route counts. */
export async function readSessionMetadata(path: string): Promise<SessionMetadata | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 4_096) return undefined;
    const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const keys = ["format", "version", "source", "lastUsedAt", "sessions", "turns", "analyses", "changeRequests", "lastDeliveryId",
      ...(value.version === 2 ? ["orchestration"] : [])];
    if (Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key)) || value.format !== SESSION_METADATA_FORMAT ||
        (value.version !== 1 && value.version !== 2) || (value.source !== "git" && value.source !== "folder") || typeof value.lastUsedAt !== "string" ||
        !ISO.test(value.lastUsedAt) || !count(value.sessions) || !count(value.turns) || !count(value.analyses) || !count(value.changeRequests) ||
        !(value.lastDeliveryId === null || (typeof value.lastDeliveryId === "string" && DELIVERY_ID.test(value.lastDeliveryId)))) return undefined;
    let orchestration = noOrchestration();
    if (value.version === 2) {
      const stored = value.orchestration as Record<string, unknown> | null;
      if (stored === null || typeof stored !== "object" || Array.isArray(stored) || Object.keys(stored).length !== ORCHESTRATION_COUNTERS.length ||
          !ORCHESTRATION_COUNTERS.every(key => count(stored[key]))) return undefined;
      orchestration = Object.fromEntries(ORCHESTRATION_COUNTERS.map(key => [key, stored[key] as number])) as OrchestrationCounts;
    }
    return Object.freeze({ ...value, version: 2, orchestration: Object.freeze(orchestration) }) as unknown as SessionMetadata;
  } catch { return undefined; }
}
/** Adds this session's counts to the stored metadata (atomic replace). Best effort: a failure never affects the session. */
export async function writeSessionMetadata(path: string, source: "git" | "folder", state: SessionState, now: Date = new Date()): Promise<boolean> {
  try {
    const previous = await readSessionMetadata(path);
    const cap = (value: number): number => Math.min(value, Number.MAX_SAFE_INTEGER);
    const orchestration = { ...(previous?.orchestration ?? noOrchestration()) };
    addOrchestration(orchestration, state.orchestration);
    const metadata: SessionMetadata = { format: SESSION_METADATA_FORMAT, version: 2, source, lastUsedAt: now.toISOString(),
      sessions: cap((previous?.sessions ?? 0) + 1), turns: cap((previous?.turns ?? 0) + state.turns), analyses: cap((previous?.analyses ?? 0) + state.analyses),
      changeRequests: cap((previous?.changeRequests ?? 0) + state.changeRequests),
      lastDeliveryId: state.deliveryId !== undefined && DELIVERY_ID.test(state.deliveryId) ? state.deliveryId : previous?.lastDeliveryId ?? null,
      orchestration };
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(metadata)}\n`, { flag: "wx" });
    await rename(temporary, path);
    return true;
  } catch { return false; }
}
