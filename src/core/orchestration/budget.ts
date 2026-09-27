import { failWith } from "../errors.js";

/**
 * v0.3 — HOST-ENFORCED ROUTE BUDGETS for adaptive orchestration. Every model turn an adaptive route takes is reserved here
 * first; a reservation that would exceed any limit is refused, and the route then stops cleanly with an honest, incomplete
 * result instead of taking the turn. The budget comes from the host only (defaults, or the user's configuration within
 * the hard caps). No contract a model answers has a budget field, so no model can raise its own budget.
 *
 * A failed or refused turn still spends what it reserved: a turn that ran is a turn, whatever it returned.
 */
export interface RouteBudget {
  /** Investigations of one batch that run at the same time. */
  readonly maxConcurrentInvestigations: number;
  /** Batches of delegated investigations (retries of failed investigations do not open a new batch). */
  readonly maxInvestigationBatches: number;
  /** Delegated investigations in the whole route, retries excluded. */
  readonly maxInvestigations: number;
  /** Repeats of a failed investigation in the whole route (at most one per investigation). */
  readonly maxRetries: number;
  /** Lead turns: answers, routing decisions and syntheses. */
  readonly maxLeadTurns: number;
  /** Fresh reviewer turns (critiques). */
  readonly maxReviewerTurns: number;
  /** Every model turn of the route. */
  readonly maxModelTurns: number;
  /** One investigation, from its start to its settled cleanup. */
  readonly investigationTimeoutMs: number;
  /** The whole route. */
  readonly routeTimeoutMs: number;
}
export type BudgetKey = keyof RouteBudget;
export const BUDGET_KEYS: readonly BudgetKey[] = Object.freeze(["maxConcurrentInvestigations", "maxInvestigationBatches", "maxInvestigations",
  "maxRetries", "maxLeadTurns", "maxReviewerTurns", "maxModelTurns", "investigationTimeoutMs", "routeTimeoutMs"]);

/** Conservative defaults: one team route of v0.2 (plan, three explorers, synthesis, critique) plus one follow-up batch. */
export const ROUTE_BUDGET_DEFAULTS: RouteBudget = Object.freeze({
  maxConcurrentInvestigations: 3,
  maxInvestigationBatches: 2,
  maxInvestigations: 5,
  maxRetries: 2,
  maxLeadTurns: 4,
  maxReviewerTurns: 1,
  maxModelTurns: 10,
  investigationTimeoutMs: 6 * 60_000,
  routeTimeoutMs: 20 * 60_000,
});
/** Upper bounds no configuration can exceed. */
export const ROUTE_BUDGET_HARD_CAPS: RouteBudget = Object.freeze({
  maxConcurrentInvestigations: 3,
  maxInvestigationBatches: 3,
  maxInvestigations: 8,
  maxRetries: 3,
  maxLeadTurns: 6,
  maxReviewerTurns: 2,
  maxModelTurns: 16,
  investigationTimeoutMs: 15 * 60_000,
  routeTimeoutMs: 45 * 60_000,
});
/** Lower bounds: a route must be able to take at least one lead turn. Zero disables delegation, retries or review. */
const MINIMUMS: RouteBudget = Object.freeze({ maxConcurrentInvestigations: 1, maxInvestigationBatches: 0, maxInvestigations: 0, maxRetries: 0,
  maxLeadTurns: 1, maxReviewerTurns: 0, maxModelTurns: 1, investigationTimeoutMs: 10_000, routeTimeoutMs: 30_000 });

/**
 * A budget from the defaults and host-side overrides (the user's configuration). Every value is a safe integer within
 * [minimum, hard cap]; anything else is refused, never clamped silently.
 */
export function routeBudget(overrides: Readonly<Partial<Record<string, unknown>>> = {}): RouteBudget {
  const budget: Record<string, number> = { ...ROUTE_BUDGET_DEFAULTS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!(BUDGET_KEYS as readonly string[]).includes(key)) failWith("InvalidInput", `Unknown route budget setting "${key.slice(0, 40)}".`);
    const k = key as BudgetKey;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < MINIMUMS[k])
      failWith("InvalidInput", `The route budget setting ${k} must be an integer of at least ${MINIMUMS[k]}.`);
    if (value > ROUTE_BUDGET_HARD_CAPS[k])
      failWith("InvalidInput", `The route budget setting ${k} exceeds its hard cap of ${ROUTE_BUDGET_HARD_CAPS[k]}.`);
    budget[k] = value;
  }
  return Object.freeze(budget) as unknown as RouteBudget;
}

export type TurnRole = "lead" | "explorer" | "reviewer";
export interface BudgetUsage {
  readonly modelTurns: number;
  readonly leadTurns: number;
  readonly explorerTurns: number;
  readonly reviewerTurns: number;
  readonly batches: number;
  readonly investigations: number;
  readonly retries: number;
}
/** Why a reservation was refused (a category, shown to the user as "budget exhausted: …"). */
export type BudgetRefusal = "model turns" | "lead turns" | "reviewer turns" | "investigation batches" | "investigations" | "retries" |
  "concurrent investigations" | "route time";

/**
 * The spent and reserved counts of one route. Reservations are all-or-nothing and happen BEFORE a turn starts, so parallel
 * work can never overrun the budget. `reserveFor` keeps turns back for the steps a route must still be able to take (the
 * lead's synthesis, a required fresh review), so delegation never starves the conclusion.
 */
export class BudgetLedger {
  #model = 0; #lead = 0; #explorer = 0; #reviewer = 0; #batches = 0; #investigations = 0; #retries = 0;
  readonly #started: number;
  constructor(readonly budget: RouteBudget, private readonly clock: () => number = Date.now) { this.#started = clock(); }

  get usage(): BudgetUsage {
    return Object.freeze({ modelTurns: this.#model, leadTurns: this.#lead, explorerTurns: this.#explorer, reviewerTurns: this.#reviewer,
      batches: this.#batches, investigations: this.#investigations, retries: this.#retries });
  }
  get elapsedMs(): number { return Math.max(0, this.clock() - this.#started); }
  /** Milliseconds left in the route (0 when its time is up). */
  get remainingMs(): number { return Math.max(0, this.budget.routeTimeoutMs - this.elapsedMs); }
  get remainingModelTurns(): number { return this.budget.maxModelTurns - this.#model; }
  get remainingLeadTurns(): number { return this.budget.maxLeadTurns - this.#lead; }
  get remainingReviewerTurns(): number { return this.budget.maxReviewerTurns - this.#reviewer; }
  get remainingBatches(): number { return this.budget.maxInvestigationBatches - this.#batches; }
  get remainingInvestigations(): number { return this.budget.maxInvestigations - this.#investigations; }
  get remainingRetries(): number { return this.budget.maxRetries - this.#retries; }

  /** Why one lead turn cannot be reserved while `keep` further turns stay reserved, or undefined when it can. */
  leadRefusal(keep: Readonly<{ lead?: number; reviewer?: number }> = {}): BudgetRefusal | undefined {
    if (this.remainingMs === 0) return "route time";
    if (this.remainingLeadTurns < 1 + (keep.lead ?? 0)) return "lead turns";
    if (this.remainingModelTurns < 1 + (keep.lead ?? 0) + (keep.reviewer ?? 0)) return "model turns";
    return undefined;
  }
  reserveLead(keep: Readonly<{ lead?: number; reviewer?: number }> = {}): BudgetRefusal | undefined {
    const refusal = this.leadRefusal(keep);
    if (refusal === undefined) { this.#lead++; this.#model++; }
    return refusal;
  }
  reviewerRefusal(): BudgetRefusal | undefined {
    if (this.remainingMs === 0) return "route time";
    if (this.remainingReviewerTurns < 1) return "reviewer turns";
    if (this.remainingModelTurns < 1) return "model turns";
    return undefined;
  }
  reserveReviewer(): BudgetRefusal | undefined {
    const refusal = this.reviewerRefusal();
    if (refusal === undefined) { this.#reviewer++; this.#model++; }
    return refusal;
  }
  /**
   * How many investigations a NEW batch may have right now while `keep` turns stay reserved (0: no batch is possible).
   * Bounded by the batch, investigation and model-turn budgets and by the concurrency limit.
   */
  batchCapacity(keep: Readonly<{ lead?: number; reviewer?: number }> = {}): number {
    if (this.remainingMs === 0 || this.remainingBatches < 1) return 0;
    const turns = this.remainingModelTurns - (keep.lead ?? 0) - (keep.reviewer ?? 0);
    if (this.remainingLeadTurns < (keep.lead ?? 0)) return 0;
    return Math.max(0, Math.min(this.remainingInvestigations, turns, this.budget.maxConcurrentInvestigations));
  }
  batchRefusal(size: number, keep: Readonly<{ lead?: number; reviewer?: number }> = {}): BudgetRefusal | undefined {
    if (this.remainingMs === 0) return "route time";
    if (this.remainingBatches < 1) return "investigation batches";
    if (this.remainingInvestigations < size) return "investigations";
    if (this.remainingModelTurns - (keep.lead ?? 0) - (keep.reviewer ?? 0) < size) return "model turns";
    if (this.remainingLeadTurns < (keep.lead ?? 0)) return "lead turns";
    return size > this.budget.maxConcurrentInvestigations ? "concurrent investigations" : undefined;
  }
  /** Reserves a batch of `size` investigations (one explorer turn each), all or nothing. */
  reserveBatch(size: number, keep: Readonly<{ lead?: number; reviewer?: number }> = {}): BudgetRefusal | undefined {
    if (!Number.isSafeInteger(size) || size < 1) return "investigations";
    const refusal = this.batchRefusal(size, keep);
    if (refusal === undefined) { this.#batches++; this.#investigations += size; this.#explorer += size; this.#model += size; }
    return refusal;
  }
  /** How many failed investigations may be repeated now while `keep` turns stay reserved. */
  retryCapacity(keep: Readonly<{ lead?: number; reviewer?: number }> = {}): number {
    if (this.remainingMs === 0) return 0;
    const turns = this.remainingModelTurns - (keep.lead ?? 0) - (keep.reviewer ?? 0);
    return Math.max(0, Math.min(this.remainingRetries, turns, this.budget.maxConcurrentInvestigations));
  }
  /** Reserves `count` repeats (one explorer turn each), all or nothing. */
  reserveRetries(count: number, keep: Readonly<{ lead?: number; reviewer?: number }> = {}): BudgetRefusal | undefined {
    if (!Number.isSafeInteger(count) || count < 1) return "retries";
    if (this.remainingMs === 0) return "route time";
    if (this.remainingRetries < count) return "retries";
    if (this.remainingModelTurns - (keep.lead ?? 0) - (keep.reviewer ?? 0) < count) return "model turns";
    this.#retries += count; this.#explorer += count; this.#model += count;
    return undefined;
  }
}
