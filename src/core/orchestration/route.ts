import { internalError, FusionFailure } from "../errors.js";
import { BudgetLedger, type BudgetRefusal, type RouteBudget } from "./budget.js";
import { assessEvidence, type AreaChoice, type DecisionReading, type DecisionRules, type EvidenceAssessment, type InvestigationOutcome,
  type InvestigationRequest, type RouteAction } from "./contracts.js";

/**
 * v0.3 — THE ADAPTIVE ROUTE: the host's state machine for one read-only task. Fusion no longer picks one fixed pipeline at
 * the start; after every step it looks at what it observed and decides the next one, within the host policy and the route
 * budget:
 *
 *   start ─ single ───────────────▶ ANSWER ─ completed ─────────────────────────────────▶ finish (answered)
 *     │                               └─ failed: turn limit, escalation allowed ─▶ DECIDE(plan)
 *     └─ team / verify (an explorer with a proven posture, budget for one investigation) ─▶ DECIDE(plan)
 *   DECIDE(plan)      answer ─▶ ANSWER │ delegate ─▶ INVESTIGATE │ refused or failed ─▶ INVESTIGATE (Fusion's areas)
 *   INVESTIGATE       transient failures and retry budget ─▶ INVESTIGATE (repeat, once per investigation)
 *                     evidence sufficient ─▶ SYNTHESIZE (the lead reclaims the task)
 *                     evidence weak and budget for another batch ─▶ DECIDE(evidence)
 *                     evidence weak, no budget ─▶ SYNTHESIZE (incomplete: what is supported, what remains unknown)
 *   DECIDE(evidence)  synthesize ─▶ SYNTHESIZE │ delegate ─▶ INVESTIGATE │ stop ─▶ finish (stopped, no conclusion)
 *                     refused or failed ─▶ SYNTHESIZE
 *   SYNTHESIZE        completed ─▶ REVIEW (a delegated route, a fresh reviewer, budget) │ finish │ failed ─▶ finish (failed)
 *   REVIEW            ─▶ finish (answered)
 *   any step whose reservation the budget refuses ─▶ finish (stopped: budget exhausted)
 *
 * A model only ever PROPOSES the next step (a routing decision the host reads strictly against the actions it allows at
 * that moment). The route authorizes it or refuses it, and every turn is reserved in the ledger before it may start. No
 * decision can widen a view, add a partner, lift a budget or reach the Writer route: this machine has no such step.
 */
export type RouteMode = "single" | "team" | "verify" | "diagnose";
export interface RouteSetup {
  readonly mode: RouteMode;
  readonly budget: RouteBudget;
  /** A partner with a PROVEN read-only posture can take investigations. */
  readonly explorers: boolean;
  /** A fresh reviewer (another partner than the lead) is available. */
  readonly reviewer: boolean;
  readonly areas: readonly AreaChoice[];
  /** Fusion's own investigations when the lead's plan is refused or its turn fails (deterministic, bounded). */
  readonly fallback: readonly InvestigationRequest[];
  /** The claim a verification route investigates (host-supplied: the finding the user refers to). */
  readonly claim?: string;
  /** Whether a single answer that ran out of steps may escalate to delegation. */
  readonly escalate: boolean;
  readonly clock?: () => number;
}
/** One investigation the route authorized (the app turns it into a packet). */
export interface PlannedInvestigation {
  readonly id: string;
  readonly batch: number;
  readonly attempt: number;
  readonly area: string;
  readonly question: string;
  readonly claim?: string;
  readonly plannedBy: "lead" | "fusion";
}
export type StopReason = Readonly<{ kind: "budget"; refusal: BudgetRefusal }> | Readonly<{ kind: "lead" }>;
export type RouteResult =
  | Readonly<{ outcome: "answered"; evidence: "none" | "sufficient" | "incomplete" }>
  | Readonly<{ outcome: "stopped"; reason: StopReason }>
  | Readonly<{ outcome: "failed"; stage: "answer" | "synthesis" }>;
export type RouteStep =
  | Readonly<{ kind: "answer"; reason: "simple" | "decided" | "noExplorer" | "noBudget" }>
  | Readonly<{ kind: "decide"; phase: "plan" | "evidence"; rules: DecisionRules }>
  | Readonly<{ kind: "investigate"; batch: number; retry: boolean; investigations: readonly PlannedInvestigation[] }>
  | Readonly<{ kind: "synthesize"; incomplete: boolean; assessment: EvidenceAssessment }>
  | Readonly<{ kind: "review" }>
  | Readonly<{ kind: "finish"; result: RouteResult }>;

/** What the app observed of one model turn: safe labels only. */
export interface TurnObservation {
  readonly status: "completed" | "failed";
  /** `role (provider)`. */
  readonly partner: string;
  readonly durationMs: number;
  /** A safe failure category (`turnLimit`, `timeout`, …) when it failed. */
  readonly failureCategory?: string;
}
export interface DecisionObservation {
  readonly partner: string;
  readonly durationMs: number;
  /** The strict reading of the reply; absent when the turn itself failed. */
  readonly reading?: DecisionReading;
  readonly failureCategory?: string;
}
export interface BatchObservation {
  readonly outcomes: readonly InvestigationOutcome[];
  /** The most investigations the scheduler observed running at the same time. */
  readonly maxConcurrent: number;
  readonly durationMs: number;
}

/** One safe entry of the route's trace: roles, categories, counts and durations — never model text. */
export interface TraceEntry {
  readonly stage: "answer" | "decision" | "investigations" | "retry" | "synthesis" | "review" | "escalation" | "fallback" | "stop" | "note" |
    /** v0.4 claim checks: the immutable evidence snapshot, the independent hypotheses, Fusion's checks, the fresh falsification, the lead's diagnosis. */
    "snapshot" | "hypotheses" | "checks" | "falsification" | "diagnosis";
  readonly role: "lead" | "explorer" | "reviewer" | "falsifier" | "fusion";
  readonly phase?: "plan" | "evidence";
  readonly partner?: string;
  readonly status?: "completed" | "failed" | "accepted" | "refused" | "skipped";
  /** A safe category: the accepted action, a rejection or failure category, a budget refusal, or a Fusion note label. */
  readonly detail?: string;
  readonly count?: number;
  readonly failed?: number;
  /** The safe failure category of each failed investigation of a batch or repeat (`timeout`, `provider failure`, …). */
  readonly failures?: readonly string[];
  readonly parallel?: number;
  readonly cited?: number;
  readonly durationMs?: number;
}

type Awaiting = RouteStep["kind"] | "none";
const protocol = (what: string): never => { throw new FusionFailure(internalError(`The adaptive route was driven out of order (${what}).`, undefined)); };

export class AdaptiveRoute {
  readonly ledger: BudgetLedger;
  readonly #setup: RouteSetup;
  readonly #trace: TraceEntry[] = [];
  readonly #outcomes: InvestigationOutcome[] = [];
  #awaiting: Awaiting = "none";
  #phase: "plan" | "evidence" = "plan";
  #planned: readonly PlannedInvestigation[] = [];
  #batch = 0;
  #claim: string | undefined;
  #escalated = false;
  #delegated = false;
  #incomplete = false;
  #started = false;
  #result: RouteResult | undefined;

  constructor(setup: RouteSetup) {
    this.#setup = setup;
    this.ledger = new BudgetLedger(setup.budget, setup.clock);
    this.#claim = setup.mode === "verify" ? setup.claim : undefined;
  }
  get trace(): readonly TraceEntry[] { return [...this.#trace]; }
  get outcomes(): readonly InvestigationOutcome[] { return [...this.#outcomes]; }
  get result(): RouteResult | undefined { return this.#result; }
  get mode(): RouteMode { return this.#setup.mode; }
  /** The claim under investigation, if any (host-supplied, or the lead's in a team route). */
  get claim(): string | undefined { return this.#claim; }
  get delegated(): boolean { return this.#delegated; }
  get escalated(): boolean { return this.#escalated; }
  get assessment(): EvidenceAssessment { return assessEvidence(this.#outcomes); }

  /** The first step. */
  start(): RouteStep {
    if (this.#started) protocol("start twice");
    this.#started = true;
    if (this.#setup.mode === "single") return this.#answer("simple");
    if (!this.#setup.explorers) {
      this.#note("no explorer with a proven read-only posture");
      return this.#answer("noExplorer");
    }
    return this.#planDecision();
  }

  answered(observation: TurnObservation): RouteStep {
    this.#expect("answer");
    this.#trace.push({ stage: "answer", role: "lead", partner: observation.partner, status: observation.status, durationMs: observation.durationMs,
      ...(observation.failureCategory ? { detail: observation.failureCategory } : {}) });
    if (observation.status === "completed") return this.#finish({ outcome: "answered", evidence: "none" });
    // A single answer that ran out of steps is evidence the task is larger than one turn: it may escalate to delegation,
    // once, when an explorer is proven and the budget still allows a decision, one investigation and the synthesis.
    if (observation.failureCategory === "turnLimit" && this.#setup.escalate && this.#setup.mode === "single" && !this.#escalated &&
        !this.#delegated && this.#setup.explorers && this.#delegationPossible()) {
      this.#escalated = true;
      this.#trace.push({ stage: "escalation", role: "fusion", detail: "turn limit" });
      return this.#planDecision();
    }
    return this.#finish({ outcome: "failed", stage: "answer" });
  }

  decided(observation: DecisionObservation): RouteStep {
    this.#expect("decide");
    const phase = this.#phase;
    const reading = observation.reading;
    const base = { stage: "decision" as const, role: "lead" as const, phase, partner: observation.partner, durationMs: observation.durationMs };
    if (reading === undefined || !reading.accepted) {
      const detail = reading === undefined ? `turn failed${observation.failureCategory ? `: ${observation.failureCategory}` : ""}` : reading.category;
      this.#trace.push({ ...base, status: reading === undefined ? "failed" : "refused", detail });
      if (phase === "plan") {
        const capacity = this.ledger.batchCapacity(this.#keep());
        const fallback = this.#setup.fallback.filter(r => !this.#withheld(r.area)).slice(0, capacity);
        this.#trace.push({ stage: "fallback", role: "fusion", detail: "Fusion's areas", count: fallback.length });
        if (fallback.length > 0) return this.#batchOf(fallback, "fusion");
        return this.#synthesis();
      }
      this.#trace.push({ stage: "fallback", role: "fusion", detail: "synthesis" });
      return this.#synthesis();
    }
    const decision = reading.decision;
    this.#trace.push({ ...base, status: "accepted", detail: decision.action,
      ...(decision.action === "delegate" ? { count: decision.investigations.length } : {}) });
    switch (decision.action) {
      case "answer": {
        // The lead decided the inventory is enough: it answers alone (the turn kept for a synthesis serves as that answer).
        const refusal = this.ledger.reserveLead();
        if (refusal !== undefined) return this.#stop(refusal);
        this.#awaiting = "answer";
        return Object.freeze({ kind: "answer", reason: "decided" });
      }
      case "delegate":
        if (this.#setup.mode === "team" && decision.claim !== undefined) this.#claim = decision.claim;
        return this.#batchOf(decision.investigations, "lead");
      case "synthesize": return this.#synthesis();
      case "stop":
        this.#trace.push({ stage: "stop", role: "lead", detail: "evidence insufficient" });
        return this.#finish({ outcome: "stopped", reason: { kind: "lead" } });
    }
  }

  investigated(observation: BatchObservation): RouteStep {
    this.#expect("investigate");
    const planned = this.#planned;
    const ids = new Set(planned.map(p => p.id));
    if (observation.outcomes.length !== planned.length || observation.outcomes.some(o => !ids.has(o.packet.id)) ||
        new Set(observation.outcomes.map(o => o.packet.id)).size !== planned.length)
      protocol("outcomes do not match the planned investigations");
    const retry = planned.some(p => p.attempt > 1);
    this.#outcomes.push(...observation.outcomes);
    const failures = observation.outcomes.flatMap(o => o.status === "failed" ? [o.failure.category] : []);
    const failed = failures.length;
    const cited = new Set(observation.outcomes.flatMap(o => o.status === "failed" ? [] : [...o.cited])).size;
    this.#trace.push({ stage: retry ? "retry" : "investigations", role: "explorer", status: failed === planned.length ? "failed" : "completed",
      count: planned.length, failed, ...(failed > 0 ? { failures: Object.freeze(failures) } : {}),
      parallel: Math.max(0, Math.min(observation.maxConcurrent, planned.length)), cited, durationMs: observation.durationMs });
    const assessment = assessEvidence(this.#outcomes);
    // 1. Transient failures are repeated once each, within the retry budget.
    const capacity = this.ledger.retryCapacity(this.#keep());
    const again = assessment.retryable.slice(0, capacity);
    if (again.length > 0 && this.ledger.reserveRetries(again.length, this.#keep()) === undefined) {
      const byId = new Map(this.#allPlanned().map(p => [p.id, p]));
      this.#planned = Object.freeze(again.map(id => Object.freeze({ ...byId.get(id)!, attempt: 2 })));
      this.#awaiting = "investigate";
      return Object.freeze({ kind: "investigate", batch: this.#batch, retry: true, investigations: this.#planned });
    }
    // 2. Enough evidence: the lead reclaims the task.
    if (assessment.sufficient) return this.#synthesis();
    // 3. Weak evidence: the lead may ask for one more bounded batch when the budget allows the decision AND a batch after it.
    if (this.ledger.batchCapacity(this.#keep(2)) >= 1 && this.ledger.reserveLead(this.#keep()) === undefined) {
      this.#phase = "evidence";
      this.#awaiting = "decide";
      return Object.freeze({ kind: "decide", phase: "evidence", rules: Object.freeze({ allowed: Object.freeze<RouteAction[]>(["synthesize", "delegate", "stop"]),
        areas: this.#setup.areas, maxInvestigations: this.ledger.batchCapacity(this.#keep()), claimAllowed: this.#setup.mode === "team" }) });
    }
    this.#trace.push({ stage: "note", role: "fusion", detail: "no budget for another batch" });
    return this.#synthesis();
  }

  synthesized(observation: TurnObservation): RouteStep {
    this.#expect("synthesize");
    this.#trace.push({ stage: "synthesis", role: "lead", partner: observation.partner, status: observation.status, durationMs: observation.durationMs,
      ...(observation.failureCategory ? { detail: observation.failureCategory } : {}) });
    if (observation.status === "failed") return this.#finish({ outcome: "failed", stage: "synthesis" });
    const evidence = this.#incomplete ? "incomplete" as const : "sufficient" as const;
    if (this.#delegated && this.#setup.reviewer) {
      const refusal = this.ledger.reserveReviewer();
      if (refusal === undefined) { this.#awaiting = "review"; return Object.freeze({ kind: "review" }); }
      this.#trace.push({ stage: "review", role: "reviewer", status: "skipped", detail: `budget exhausted: ${refusal}` });
    }
    return this.#finish({ outcome: "answered", evidence });
  }

  reviewed(observation: TurnObservation): RouteStep {
    this.#expect("review");
    this.#trace.push({ stage: "review", role: "reviewer", partner: observation.partner, status: observation.status, durationMs: observation.durationMs,
      ...(observation.failureCategory ? { detail: observation.failureCategory } : {}) });
    return this.#finish({ outcome: "answered", evidence: this.#incomplete ? "incomplete" : "sufficient" });
  }

  /**
   * The route's own deadline ended the step it was waiting for (the host aborted the turn or batch): it stops cleanly as a
   * budget stop, whatever step it awaited. Never a model's decision.
   */
  expire(): RouteStep {
    if (this.#result !== undefined || this.#awaiting === "none") protocol("nothing to expire");
    this.#awaiting = "none";
    return this.#stop("route time");
  }

  // ------------------------------------------------------------ internals

  /** The turns a delegation must leave: the lead's synthesis (`lead` of them) and the fresh review a delegated route gets. */
  #keep(lead = 1): Readonly<{ lead: number; reviewer: number }> {
    return { lead, reviewer: this.#setup.reviewer && this.#setup.budget.maxReviewerTurns > 0 ? 1 : 0 };
  }
  #withheld(area: string): boolean { return this.#setup.areas.find(a => a.id === area)?.withheld === true; }
  #expect(kind: Awaiting): void {
    if (this.#result !== undefined) protocol("the route already finished");
    if (this.#awaiting !== kind) protocol(`expected ${this.#awaiting}, observed ${kind}`);
  }
  #note(detail: string): void { this.#trace.push({ stage: "note", role: "fusion", detail }); }
  #answer(reason: "simple" | "noExplorer" | "noBudget"): RouteStep {
    const refusal = this.ledger.reserveLead();
    if (refusal !== undefined) return this.#stop(refusal);
    this.#awaiting = "answer";
    return Object.freeze({ kind: "answer", reason });
  }
  /** The lead's planning decision, when the budget allows it AND at least one investigation and the synthesis after it. */
  #delegationPossible(): boolean {
    return this.ledger.batchCapacity(this.#keep(2)) >= 1 && this.ledger.leadRefusal(this.#keep()) === undefined;
  }
  #planDecision(): RouteStep {
    if (!this.#delegationPossible()) {
      this.#note("budget allows no delegation");
      return this.#answer("noBudget");
    }
    this.ledger.reserveLead(this.#keep());
    this.#phase = "plan";
    this.#awaiting = "decide";
    return Object.freeze({ kind: "decide", phase: "plan", rules: Object.freeze({ allowed: Object.freeze<RouteAction[]>(["answer", "delegate"]),
      areas: this.#setup.areas, maxInvestigations: this.ledger.batchCapacity(this.#keep()), claimAllowed: this.#setup.mode === "team" }) });
  }
  #allPlanned(): PlannedInvestigation[] {
    const seen = new Map<string, PlannedInvestigation>();
    for (const outcome of this.#outcomes) {
      const p = outcome.packet;
      seen.set(p.id, { id: p.id, batch: p.batch, attempt: p.attempt, area: p.area, question: p.question, plannedBy: p.plannedBy, ...(p.claim ? { claim: p.claim } : {}) });
    }
    return [...seen.values()];
  }
  #batchOf(requests: readonly InvestigationRequest[], plannedBy: "lead" | "fusion"): RouteStep {
    const refusal = this.ledger.reserveBatch(requests.length, this.#keep());
    if (refusal !== undefined) {
      this.#trace.push({ stage: "note", role: "fusion", detail: `budget exhausted: ${refusal}` });
      return this.#synthesis();
    }
    this.#batch++;
    this.#delegated = true;
    this.#planned = Object.freeze(requests.map((request, index) => Object.freeze({ id: `b${this.#batch}-i${index + 1}`, batch: this.#batch, attempt: 1,
      area: request.area, question: request.question, plannedBy, ...(this.#claim === undefined ? {} : { claim: this.#claim }) })));
    this.#awaiting = "investigate";
    return Object.freeze({ kind: "investigate", batch: this.#batch, retry: false, investigations: this.#planned });
  }
  /** The lead reclaims the task: its synthesis over the evidence so far (the turn was kept since the delegation). */
  #synthesis(): RouteStep {
    const assessment = assessEvidence(this.#outcomes);
    this.#incomplete = !assessment.sufficient;
    const refusal = this.ledger.reserveLead({ reviewer: this.#delegated ? this.#keep().reviewer : 0 });
    if (refusal !== undefined) return this.#stop(refusal);
    this.#awaiting = "synthesize";
    return Object.freeze({ kind: "synthesize", incomplete: this.#incomplete, assessment });
  }
  #stop(refusal: BudgetRefusal): RouteStep {
    this.#trace.push({ stage: "stop", role: "fusion", detail: `budget exhausted: ${refusal}` });
    return this.#finish({ outcome: "stopped", reason: { kind: "budget", refusal } });
  }
  #finish(result: RouteResult): RouteStep {
    this.#result = Object.freeze(result);
    this.#awaiting = "none";
    return Object.freeze({ kind: "finish", result: this.#result });
  }
}

// ---------------------------------------------------------------- observability and metrics

export interface RouteMetrics {
  readonly routes: number;
  readonly modelTurns: number;
  readonly leadTurns: number;
  readonly explorerTurns: number;
  readonly reviewerTurns: number;
  readonly batches: number;
  readonly parallelBatches: number;
  readonly retries: number;
  readonly failedInvestigations: number;
  readonly leadReclaims: number;
  readonly escalations: number;
  readonly fallbacks: number;
  readonly budgetStops: number;
  readonly durationMs: number;
}
export const METRIC_KEYS: readonly (keyof RouteMetrics)[] = Object.freeze(["routes", "modelTurns", "leadTurns", "explorerTurns", "reviewerTurns", "batches",
  "parallelBatches", "retries", "failedInvestigations", "leadReclaims", "escalations", "fallbacks", "budgetStops", "durationMs"]);

/** Safe counts of one route, from its trace (turns that actually ran, never reservations). */
export function routeMetrics(trace: readonly TraceEntry[], durationMs: number): RouteMetrics {
  const lead = trace.filter(e => e.role === "lead" && (e.stage === "answer" || e.stage === "decision" || e.stage === "synthesis" || e.stage === "diagnosis")).length;
  // v0.4: a claim check's independent hypotheses are one batch of explorer turns.
  const batches = trace.filter(e => e.stage === "investigations" || e.stage === "hypotheses");
  const retries = trace.filter(e => e.stage === "retry");
  const explorer = [...batches, ...retries].reduce((sum, e) => sum + (e.count ?? 0), 0);
  const reviewer = trace.filter(e => (e.stage === "review" || e.stage === "falsification") && e.status !== "skipped").length;
  const delegated = batches.length > 0;
  return Object.freeze({ routes: 1, modelTurns: lead + explorer + reviewer, leadTurns: lead, explorerTurns: explorer, reviewerTurns: reviewer,
    batches: batches.length, parallelBatches: batches.filter(e => (e.parallel ?? 0) > 1).length,
    retries: retries.reduce((sum, e) => sum + (e.count ?? 0), 0),
    failedInvestigations: [...batches, ...retries].reduce((sum, e) => sum + (e.failed ?? 0), 0),
    leadReclaims: delegated ? trace.filter(e => e.stage === "synthesis" || e.stage === "diagnosis").length : 0,
    escalations: trace.filter(e => e.stage === "escalation").length + trace.filter(e => e.stage === "decision" && e.phase === "evidence" && e.detail === "delegate").length,
    fallbacks: trace.filter(e => e.stage === "fallback").length,
    budgetStops: trace.filter(e => e.stage === "stop" && e.role === "fusion").length,
    durationMs: Math.max(0, Math.round(durationMs)) });
}

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
/** The route as one line: `lead decision → 3 parallel investigations → lead synthesis → fresh review`. */
export function renderRoute(trace: readonly TraceEntry[]): string {
  const parts: string[] = [];
  for (const [index, e] of trace.entries()) {
    switch (e.stage) {
      case "answer": {
        const alone = trace.length === 1 || trace.every(x => x.stage === "answer" || x.stage === "note");
        parts.push(`${alone && e.status === "completed" ? "lead only" : "lead answer"}${e.status === "failed" ? ` (failed${e.detail ? `: ${e.detail}` : ""})` : ""}`);
        break;
      }
      case "escalation": parts.push(`escalated (${e.detail ?? "harder than one turn"})`); break;
      case "decision":
        parts.push(`lead ${e.phase === "evidence" ? "evidence review" : "decision"}` +
          `${e.status === "accepted" ? (e.detail === "answer" ? " (answer directly)" : e.detail === "stop" ? " (stop)" : "") : ` (${e.status}: ${e.detail ?? "unknown"})`}`);
        break;
      case "fallback":
        if (e.detail === "Fusion's areas") parts.push(`Fusion's own areas`);
        break;
      case "investigations": {
        const n = e.count ?? 0;
        parts.push(`${n > 1 && (e.parallel ?? 0) > 1 ? `${n} parallel investigations` : count(n, "investigation")}${e.failed ? ` (${e.failed} failed)` : ""}`);
        break;
      }
      case "retry": parts.push(`${count(e.count ?? 0, "repeat")}${e.failed ? ` (${e.failed} failed)` : ""}`); break;
      case "synthesis": parts.push(`lead synthesis${e.status === "failed" ? " (failed)" : ""}`); break;
      case "review": parts.push(e.status === "skipped" ? `no fresh review (${e.detail ?? "skipped"})` : `fresh review${e.status === "failed" ? " (failed)" : ""}`); break;
      case "stop": parts.push(e.role === "lead" ? "stopped by the lead (evidence insufficient)" : `stopped (${e.detail ?? "budget exhausted"})`); break;
      case "note": if (index === 0 && e.detail === "no explorer with a proven read-only posture") parts.push("no explorer available"); break;
      case "snapshot": parts.push("evidence snapshot"); break;
      case "hypotheses": {
        const n = e.count ?? 0;
        parts.push(`${n === 1 ? "1 hypothesis" : `${n} independent hypotheses`}${e.failed ? ` (${e.failed} failed)` : ""}`);
        break;
      }
      case "checks": parts.push(`${e.count === 0 || e.count === undefined ? "no Fusion check" : count(e.count, "Fusion check")}` +
        `${e.detail ? ` (${e.detail})` : ""}`); break;
      case "falsification": parts.push(e.status === "skipped" ? `no falsification (${e.detail ?? "skipped"})`
        : `fresh falsification${e.status === "failed" ? ` (failed${e.detail ? `: ${e.detail}` : ""})` : e.detail ? ` (${e.detail})` : ""}`); break;
      case "diagnosis": parts.push(`lead diagnosis${e.status === "failed" ? " (failed)" : ""}`); break;
    }
  }
  return parts.join(" → ") || "no model turn";
}
/** `6 model turns (lead 2 · explorers 3 · reviewer 1) · 1 parallel batch · 0 repeats · 38 s`. */
export function renderTurns(metrics: RouteMetrics): string {
  const roles = [`lead ${metrics.leadTurns}`, ...(metrics.explorerTurns > 0 ? [`explorers ${metrics.explorerTurns}`] : []),
    ...(metrics.reviewerTurns > 0 ? [`reviewer ${metrics.reviewerTurns}`] : [])];
  const seconds = metrics.durationMs >= 10_000 ? `${Math.round(metrics.durationMs / 1000)} s` : `${(metrics.durationMs / 1000).toFixed(1)} s`;
  return `${count(metrics.modelTurns, "model turn")} (${roles.join(" · ")})` +
    `${metrics.batches > 0 ? ` · ${count(metrics.batches, "batch", "batches")}${metrics.parallelBatches > 0 ? ` (${metrics.parallelBatches} parallel)` : ""}` : ""}` +
    `${metrics.retries > 0 ? ` · ${count(metrics.retries, "repeat")}` : ""}${metrics.failedInvestigations > 0 ? ` · ${metrics.failedInvestigations} failed` : ""} · ${seconds}`;
}
