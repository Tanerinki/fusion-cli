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
  /** The last delivery a build in this session prepared. */
  deliveryId?: string;
  turns: number;
  analyses: number;
  changeRequests: number;
}
export const newSessionState = (): SessionState => ({ findings: [], turns: 0, analyses: 0, changeRequests: 0 });

export type TurnPlan =
  | Readonly<{ kind: "local"; what: "empty" | "help" | "exit" | "history" | "undo" }>
  | Readonly<{ kind: "refuse"; what: "bypass" }>
  | Readonly<{ kind: "clarify"; question: string }>
  | Readonly<{ kind: "ask"; message: string }>
  | Readonly<{ kind: "analyze"; message: string; broad: boolean }>
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

/**
 * The plan for one classified line. `source` is what the shell runs on: in a `folder` (no Git baseline) a change request is
 * BLOCKED, never started. The returned plan never exceeds the intent's grant.
 */
export function planTurn(intent: TurnIntent, state: SessionState, source: "git" | "folder"): TurnPlan {
  const grant = grantFor(intent.kind);
  switch (intent.kind) {
    case "empty": case "help": case "exit": case "history": case "undo": return { kind: "local", what: intent.kind };
    case "bypass": return { kind: "refuse", what: "bypass" };
    case "clarify": return { kind: "clarify", question: "That would remove or rewrite a lot at once. Which files, exactly, and what should happen to them? " +
      "Fusion changes projects only through its verified route, one confirmed task at a time." };
    case "create": return { kind: "create", description: intent.text };
    case "analysis": return { kind: "analyze", message: intent.text, broad: intent.broad };
    case "conversation": case "investigation": case "plan": {
      // Only a reference by position (or to all findings) adds context; the transcript already carries "it".
      const ref = intent.reference?.kind === "previous" ? undefined : referenced(state, intent.reference);
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
      const ref = referenced(state, intent.reference ?? (state.findings.length > 0 || state.proposal !== undefined ? { kind: "previous" } : undefined));
      // A short follow-up ("fix it", "fix the first one", "fix them") takes its wording from what it refers to.
      let task: string | undefined;
      if (words <= 5 && ref !== undefined) task = ref.indices.length === 1 ? `Fix this finding from the analysis: ${state.findings[ref.indices[0]!]!}`
        : `Fix these findings from the analysis:\n${ref.text}`;
      else if (words <= 5 && state.proposal !== undefined) task = state.proposal;
      else if (words > 2 || ref !== undefined) task = ref === undefined ? intent.text : `${intent.text}\n\nIt refers to:\n${ref.text}`;
      if (source === "folder") return { kind: "blocked", reason: "noGitBaseline", ...(task === undefined ? {} : { task: clip(task, SESSION_LIMITS.maxTaskChars) }) };
      if (task === undefined) return { kind: "clarify", question: "What should I change? Name the file or the problem, or ask for an analysis first." };
      if (ref !== undefined && ref.indices.length === 1) state.focus = ref.indices[0]!;
      return { kind: "change", task: clip(task, SESSION_LIMITS.maxTaskChars) };
    }
  }
}

// ---------------------------------------------------------------- safe metadata

export const SESSION_METADATA_FORMAT = "fusion.shellSession" as const;
export interface SessionMetadata {
  readonly format: typeof SESSION_METADATA_FORMAT;
  readonly version: 1;
  readonly source: "git" | "folder";
  readonly lastUsedAt: string;
  readonly sessions: number;
  readonly turns: number;
  readonly analyses: number;
  readonly changeRequests: number;
  /** The last delivery a shell build prepared (an id, never content). */
  readonly lastDeliveryId: string | null;
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
/** The stored metadata, or undefined (missing, malformed, a link, too large: treated as none). */
export async function readSessionMetadata(path: string): Promise<SessionMetadata | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 4_096) return undefined;
    const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const keys = ["format", "version", "source", "lastUsedAt", "sessions", "turns", "analyses", "changeRequests", "lastDeliveryId"];
    if (Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key)) || value.format !== SESSION_METADATA_FORMAT ||
        value.version !== 1 || (value.source !== "git" && value.source !== "folder") || typeof value.lastUsedAt !== "string" || !ISO.test(value.lastUsedAt) ||
        !count(value.sessions) || !count(value.turns) || !count(value.analyses) || !count(value.changeRequests) ||
        !(value.lastDeliveryId === null || (typeof value.lastDeliveryId === "string" && DELIVERY_ID.test(value.lastDeliveryId)))) return undefined;
    return Object.freeze(value) as unknown as SessionMetadata;
  } catch { return undefined; }
}
/** Adds this session's counts to the stored metadata (atomic replace). Best effort: a failure never affects the session. */
export async function writeSessionMetadata(path: string, source: "git" | "folder", state: SessionState, now: Date = new Date()): Promise<boolean> {
  try {
    const previous = await readSessionMetadata(path);
    const cap = (value: number): number => Math.min(value, Number.MAX_SAFE_INTEGER);
    const metadata: SessionMetadata = { format: SESSION_METADATA_FORMAT, version: 1, source, lastUsedAt: now.toISOString(),
      sessions: cap((previous?.sessions ?? 0) + 1), turns: cap((previous?.turns ?? 0) + state.turns), analyses: cap((previous?.analyses ?? 0) + state.analyses),
      changeRequests: cap((previous?.changeRequests ?? 0) + state.changeRequests),
      lastDeliveryId: state.deliveryId !== undefined && DELIVERY_ID.test(state.deliveryId) ? state.deliveryId : previous?.lastDeliveryId ?? null };
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(metadata)}\n`, { flag: "wx" });
    await rename(temporary, path);
    return true;
  } catch { return false; }
}
