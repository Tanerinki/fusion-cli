import { AGENT_ROLES, type AgentRole, type PacketStatus, type ResultPacket } from "../domain.js";
import type { WorkflowResult } from "./types.js";

/**
 * v0.1 — a decision a role requested, as a bounded product artifact the human can act on later.
 *
 * A role asks for a decision through the structured fields of its VALIDATED ResultPacket (the planning contract: "anything
 * a human must decide in needsLeadDecision"; a status other than completed stops the run as well). Only those decision
 * fields are kept: the questions (`needsLeadDecision`), why the role stopped (`failures`) and what it was unsure about
 * (`uncertainties`). Never the plan summary, file lists, verification claims, a transcript or reasoning. Every item is
 * flattened to one line, stripped of control characters and clipped; items beyond the bounds are counted, not kept.
 * The text is the role's own words: it is shown to the human as the question to decide, never trusted as a fact.
 */
export const DECISION_FORMAT = "fusion.decisionRequest" as const;
export const DECISION_LIMITS = Object.freeze({ maxQuestions: 5, maxQuestionChars: 400, maxContextItems: 3, maxContextChars: 300 });
const STATUSES: readonly string[] = ["completed", "partial", "blocked", "failed"];

export interface DecisionRequest {
  readonly format: typeof DECISION_FORMAT;
  readonly version: 1;
  /** The role that asked. */
  readonly role: AgentRole;
  /** The status the role reported with its request (`unknown` when its packet is not available). */
  readonly status: PacketStatus | "unknown";
  /** What the human must decide, in the role's words (bounded). */
  readonly questions: readonly string[];
  /** How many questions the role asked (more than `questions` holds when some were beyond the bounds). */
  readonly questionsTotal: number;
  /** Why the role stopped (its reported failures), bounded. */
  readonly blockers: readonly string[];
  /** What the role was unsure about (its reported uncertainties), bounded. */
  readonly context: readonly string[];
  /** Some item was cut or left out by the bounds. */
  readonly clipped: boolean;
}

/** One line: control and separator characters become spaces, whitespace collapses, then the text is clipped. */
function line(text: string, max: number): { text: string; clipped: boolean } {
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069]/gu, " ").replace(/\s+/gu, " ").trim();
  return flat.length <= max ? { text: flat, clipped: false } : { text: `${flat.slice(0, max - 1)}…`, clipped: true };
}
function bounded(items: readonly unknown[], count: number, max: number): { kept: string[]; total: number; clipped: boolean } {
  const lines = items.filter((item): item is string => typeof item === "string").map(item => line(item, max)).filter(item => item.text.length > 0);
  return { kept: lines.slice(0, count).map(item => item.text), total: lines.length,
    clipped: lines.length > count || lines.slice(0, count).some(item => item.clipped) };
}

/** The bounded decision request of `role` from its validated packet (or, without one, only who asked). */
export function boundedDecision(role: AgentRole, packet: ResultPacket | undefined): DecisionRequest {
  const questions = bounded(packet?.needsLeadDecision ?? [], DECISION_LIMITS.maxQuestions, DECISION_LIMITS.maxQuestionChars);
  const blockers = bounded(packet?.failures ?? [], DECISION_LIMITS.maxContextItems, DECISION_LIMITS.maxContextChars);
  const context = bounded(packet?.uncertainties ?? [], DECISION_LIMITS.maxContextItems, DECISION_LIMITS.maxContextChars);
  return Object.freeze({ format: DECISION_FORMAT, version: 1, role, status: packet?.result.status ?? "unknown",
    questions: Object.freeze(questions.kept), questionsTotal: questions.total, blockers: Object.freeze(blockers.kept),
    context: Object.freeze(context.kept), clipped: questions.clipped || blockers.clipped || context.clipped });
}

/**
 * The decision a finished run is waiting for: only when it ended in `decisionRequired` because a role REQUESTED one (a
 * review finding, an exhausted retry or a rejected application are decisions of another kind, with their own evidence).
 */
export function decisionRequestOf(result: WorkflowResult): DecisionRequest | undefined {
  if (result.state !== "decisionRequired") return undefined;
  const last = result.transitions.at(-1);
  if (last === undefined || last.reason !== "decisionRequested") return undefined;
  const role = last.role ?? "Lead";
  // The Lead's plan, or the delegate's last packet (an attempt); an Explorer's exploration packet is not retained.
  const packet = role === "Lead" && last.attempt === undefined ? result.plan : last.attempt !== undefined ? result.result : undefined;
  return boundedDecision(role, packet);
}

const KEYS = ["format", "version", "role", "status", "questions", "questionsTotal", "blockers", "context", "clipped"];
const lines = (value: unknown, count: number, max: number): value is string[] => Array.isArray(value) && value.length <= count &&
  value.every(item => typeof item === "string" && item.length > 0 && item.length <= max && !/[\u0000-\u001f\u007f]/u.test(item));
/** A stored decision request, re-checked on read; anything else is not a decision request (undefined). */
export function parseDecisionRequest(value: unknown): DecisionRequest | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== KEYS.length || !KEYS.every(key => Object.hasOwn(v, key)) || v.format !== DECISION_FORMAT || v.version !== 1 ||
      !(AGENT_ROLES as readonly unknown[]).includes(v.role) || !(v.status === "unknown" || STATUSES.includes(String(v.status))) ||
      !lines(v.questions, DECISION_LIMITS.maxQuestions, DECISION_LIMITS.maxQuestionChars) ||
      !Number.isSafeInteger(v.questionsTotal) || (v.questionsTotal as number) < v.questions.length || (v.questionsTotal as number) > 1_000 ||
      !lines(v.blockers, DECISION_LIMITS.maxContextItems, DECISION_LIMITS.maxContextChars) ||
      !lines(v.context, DECISION_LIMITS.maxContextItems, DECISION_LIMITS.maxContextChars) || typeof v.clipped !== "boolean")
    return undefined;
  return Object.freeze({ format: DECISION_FORMAT, version: 1, role: v.role as AgentRole, status: v.status as DecisionRequest["status"],
    questions: Object.freeze([...v.questions]), questionsTotal: v.questionsTotal as number, blockers: Object.freeze([...v.blockers]),
    context: Object.freeze([...v.context]), clipped: v.clipped });
}
