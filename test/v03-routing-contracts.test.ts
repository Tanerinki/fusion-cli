import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BudgetLedger, ROUTE_BUDGET_DEFAULTS, ROUTE_BUDGET_HARD_CAPS, routeBudget, BUDGET_KEYS } from "../src/core/orchestration/budget.js";
import { assessEvidence, citedPath, investigationReportFrom, renderEvidence, routingDecisionFrom, type AreaChoice, type DecisionRules,
  type InvestigationOutcome, type InvestigationPacket } from "../src/core/orchestration/contracts.js";
import { AdaptiveRoute, renderRoute, renderTurns, routeMetrics, type PlannedInvestigation, type RouteSetup, type RouteStep } from "../src/core/orchestration/route.js";
import { FusionFailure } from "../src/core/errors.js";

/**
 * v0.3 PR 1 — the provider-neutral contracts of adaptive orchestration: host-enforced budgets with hard caps, the strict
 * routing-decision and investigation-report contracts, the host's evidence assessment, and the adaptive route's state
 * machine with its safe trace. Pure: no provider, process or file.
 */

const AREAS: readonly AreaChoice[] = [{ id: "src", files: 120 }, { id: "test", files: 90 }, { id: "docs", files: 40 }, { id: ".", files: 6 },
  { id: ".storage", files: 3, withheld: true }];
const rules = (patch: Partial<DecisionRules> = {}): DecisionRules =>
  ({ allowed: ["answer", "delegate"], areas: AREAS, maxInvestigations: 3, claimAllowed: true, ...patch });

// ---------------------------------------------------------------- budgets

test("v0.3 budgets: conservative defaults under hard caps; overrides are validated, never clamped; unknown keys refused", () => {
  for (const key of BUDGET_KEYS) assert.ok(ROUTE_BUDGET_DEFAULTS[key] <= ROUTE_BUDGET_HARD_CAPS[key], key);
  assert.deepEqual(routeBudget(), ROUTE_BUDGET_DEFAULTS);
  assert.equal(routeBudget({ maxModelTurns: 12 }).maxModelTurns, 12);
  const refused = (overrides: Record<string, unknown>, pattern: RegExp) =>
    assert.throws(() => routeBudget(overrides), (e: unknown) => e instanceof FusionFailure && e.error.kind === "InvalidInput" && pattern.test(e.error.safeMessage));
  refused({ maxModelTurns: 17 }, /exceeds its hard cap of 16/u);
  refused({ maxConcurrentInvestigations: 4 }, /hard cap of 3/u);
  refused({ maxLeadTurns: 0 }, /at least 1/u);
  refused({ maxRetries: 1.5 }, /integer/u);
  refused({ maxRetries: "2" }, /integer/u);
  refused({ unlimited: true }, /Unknown route budget setting/u);
  assert.ok(Object.isFrozen(routeBudget()));
});

test("v0.3 budget ledger: reservations are all-or-nothing, keep turns back for the conclusion, and stop at route time", () => {
  let now = 1_000;
  const ledger = new BudgetLedger(routeBudget({ maxModelTurns: 6, maxInvestigations: 4 }), () => now);
  assert.equal(ledger.reserveLead({ lead: 1, reviewer: 1 }), undefined);
  assert.equal(ledger.batchCapacity({ lead: 1, reviewer: 1 }), 3, "6 turns - 1 decision - 1 synthesis - 1 review = 3");
  assert.equal(ledger.reserveBatch(4, { lead: 1, reviewer: 1 }), "model turns", "more than the turn budget leaves is refused whole");
  assert.equal(ledger.usage.explorerTurns, 0, "a refused batch reserves nothing");
  assert.equal(ledger.reserveBatch(3, { lead: 1, reviewer: 1 }), undefined);
  assert.equal(ledger.batchCapacity({ lead: 1, reviewer: 1 }), 0);
  assert.equal(ledger.reserveRetries(1, { lead: 1, reviewer: 1 }), "model turns", "a retry never eats the synthesis or the review");
  assert.equal(ledger.reserveLead({ reviewer: 1 }), undefined);
  assert.equal(ledger.reserveReviewer(), undefined);
  assert.equal(ledger.reserveReviewer(), "reviewer turns");
  assert.deepEqual(ledger.usage, { modelTurns: 6, leadTurns: 2, explorerTurns: 3, reviewerTurns: 1, batches: 1, investigations: 3, retries: 0 });
  const timed = new BudgetLedger(routeBudget({ routeTimeoutMs: 30_000 }), () => now);
  now += 30_001;
  assert.equal(timed.reserveLead(), "route time");
  assert.equal(timed.batchCapacity(), 0);
});

// ---------------------------------------------------------------- routing decisions

test("v0.3 routing decision: the closed shapes are accepted; area spellings normalized; nothing else repaired", () => {
  const delegate = routingDecisionFrom({ action: "delegate", claim: "The retry loop never ends.", investigations: [
    { area: "./src/", question: "Where is the retry loop bounded?" }, { area: "test", question: "Which test covers the retry bound?" }] }, rules());
  assert.deepEqual(delegate, { accepted: true, decision: { action: "delegate", claim: "The retry loop never ends.", investigations: [
    { area: "src", question: "Where is the retry loop bounded?" }, { area: "test", question: "Which test covers the retry bound?" }] } });
  assert.deepEqual(routingDecisionFrom({ action: "answer" }, rules()), { accepted: true, decision: { action: "answer" } });
  assert.deepEqual(routingDecisionFrom({ action: "delegate", investigations: [{ area: "./", question: "root files?" }] }, rules()),
    { accepted: true, decision: { action: "delegate", investigations: [{ area: ".", question: "root files?" }] } });
  const evidence = rules({ allowed: ["synthesize", "delegate", "stop"] });
  assert.deepEqual(routingDecisionFrom({ action: "stop" }, evidence), { accepted: true, decision: { action: "stop" } });
  assert.deepEqual(routingDecisionFrom({ action: "synthesize" }, evidence), { accepted: true, decision: { action: "synthesize" } });
});

test("v0.3 routing decision: every malformed, unknown, oversized or authority-seeking decision is refused with a category only", () => {
  const q = (area: string, question = "What is there?") => ({ area, question });
  const cases: Array<[unknown, DecisionRules, string]> = [
    [null, rules(), "schema mismatch"], [[], rules(), "schema mismatch"], [{ areas: [{ id: "src", reason: "x" }] }, rules(), "schema mismatch"],
    [{ action: "escalate" }, rules(), "unknown action"], [{ action: "write", investigations: [q("src")] }, rules(), "unknown action"],
    [{ action: "stop" }, rules(), "action not allowed now"], [{ action: "synthesize" }, rules(), "action not allowed now"],
    [{ action: "answer", text: "here is my answer" }, rules(), "schema mismatch"],
    [{ action: "delegate", investigations: [] }, rules(), "no investigations"],
    [{ action: "delegate", investigations: [q("src"), q("test"), q("docs"), q(".")] }, rules(), "too many investigations"],
    [{ action: "delegate", investigations: [q("src")] }, rules({ maxInvestigations: 0 }), "action not allowed now"],
    [{ action: "delegate", investigations: [q("lib")] }, rules(), "unknown area"],
    [{ action: "delegate", investigations: [q("src/auth")] }, rules(), "unknown area"],
    [{ action: "delegate", investigations: [q("../outside")] }, rules(), "unknown area"],
    [{ action: "delegate", investigations: [q("C:/Windows")] }, rules(), "unknown area"],
    [{ action: "delegate", investigations: [q(".storage")] }, rules(), "withheld area"],
    [{ action: "delegate", investigations: [q("src"), q("src/")] }, rules(), "duplicate area"],
    [{ action: "delegate", investigations: [q("src", "x".repeat(201))] }, rules(), "question too long"],
    [{ action: "delegate", investigations: [q("src", "   ")] }, rules(), "schema mismatch"],
    [{ action: "delegate", claim: "y".repeat(301), investigations: [q("src")] }, rules(), "claim too long"],
    [{ action: "delegate", claim: "a lead claim", investigations: [q("src")] }, rules({ claimAllowed: false }), "claim not allowed"],
    // No field can widen access, raise a budget, add a partner or grant a write.
    [{ action: "delegate", investigations: [q("src")], budget: { maxModelTurns: 99 } }, rules(), "schema mismatch"],
    [{ action: "delegate", investigations: [q("src")], maxInvestigations: 8 }, rules(), "schema mismatch"],
    [{ action: "delegate", investigations: [{ ...q("src"), partner: "lead" }] }, rules(), "schema mismatch"],
    [{ action: "delegate", investigations: [{ ...q("src"), paths: ["secrets.yaml"] }] }, rules(), "schema mismatch"],
    [{ action: "delegate", investigations: [{ ...q("src"), write: true }] }, rules(), "schema mismatch"],
    [{ action: "delegate", investigations: [{ area: 3, question: "x" }] }, rules(), "schema mismatch"],
  ];
  for (const [value, r, category] of cases) assert.deepEqual(routingDecisionFrom(value, r), { accepted: false, category }, JSON.stringify(value).slice(0, 80));
});

// ---------------------------------------------------------------- investigation reports

test("v0.3 investigation report: the closed, bounded shape; cited paths are relative and clean; a claim needs a verdict", () => {
  const report = { status: "answered", verdict: "supported", summary: "The loop is unbounded.\u0007",
    findings: [{ claim: "retry() loops without a limit", paths: ["src/retry.ts:12-20", "./src/retry.ts", "`test/retry.test.ts`"] }],
    openQuestions: ["Is the caller bounded?", " "], contradictions: [] };
  const read = investigationReportFrom(report, { claim: "The loop never ends." });
  assert.ok(read.accepted);
  assert.deepEqual(read.report, { status: "answered", verdict: "supported", summary: "The loop is unbounded.",
    findings: [{ claim: "retry() loops without a limit", paths: ["src/retry.ts", "test/retry.test.ts"] }], openQuestions: ["Is the caller bounded?"],
    contradictions: [] });
  const without = { status: "inconclusive", summary: "Could not find it.", findings: [], openQuestions: [] };
  assert.ok(investigationReportFrom(without, {}).accepted);
  const cases: Array<[unknown, string, string | undefined]> = [
    [without, "verdict missing", "a claim"], [{ ...without, status: "done" }, "unknown status", undefined],
    [{ ...without, verdict: "maybe" }, "unknown verdict", undefined], [{ ...without, reasoning: "hidden" }, "schema mismatch", undefined],
    [{ ...without, summary: "s".repeat(1_501) }, "summary too long", undefined],
    [{ ...without, findings: Array.from({ length: 9 }, () => ({ claim: "c", paths: [] })) }, "too many findings", undefined],
    [{ ...without, findings: [{ claim: "c", paths: ["/etc/passwd"] }] }, "invalid path", undefined],
    [{ ...without, findings: [{ claim: "c", paths: ["../outside.txt"] }] }, "invalid path", undefined],
    [{ ...without, findings: [{ claim: "c", paths: ["src\\a.ts"] }] }, "invalid path", undefined],
    [{ ...without, findings: [{ claim: "c", paths: ["https://example.invalid/x"] }] }, "invalid path", undefined],
    [{ ...without, findings: [{ claim: "c", paths: ["C:/x.ts"] }] }, "invalid path", undefined],
    [{ ...without, findings: [{ claim: "c", paths: Array.from({ length: 7 }, (_, i) => `f${i}.ts`) }] }, "too many paths", undefined],
    [{ ...without, openQuestions: ["a", "b", "c", "d", "e"] }, "too many questions", undefined],
    [{ ...without, openQuestions: ["q".repeat(201)] }, "note too long", undefined],
  ];
  for (const [value, category, claim] of cases)
    assert.deepEqual(investigationReportFrom(value, claim ? { claim } : {}), { accepted: false, category }, category);
  assert.equal(citedPath("src/a.ts"), "src/a.ts");
  assert.equal(citedPath("src//a.ts"), undefined);
  assert.equal(citedPath(42), undefined);
});

// ---------------------------------------------------------------- the host's assessment

function packet(id: string, area: string, patch: Partial<InvestigationPacket> = {}): InvestigationPacket {
  return { id, batch: Number(id.slice(1, 2)), attempt: 1, area, files: 10, start: [], question: `What is in ${area}?`, plannedBy: "lead", priorFindings: [],
    maxFiles: 4, ...patch };
}
const reported = (p: InvestigationPacket, patch: Partial<{ status: "answered" | "inconclusive"; verdict: "supported" | "contradicted" | "unclear"; cited: string[] }> = {}): InvestigationOutcome =>
  ({ packet: p, partner: "reviewer (beta)", durationMs: 5, status: "reported", uncitedPaths: 0, cited: patch.cited ?? [`${p.area}/a.ts`],
    report: { status: patch.status ?? "answered", ...(patch.verdict ? { verdict: patch.verdict } : {}), summary: `About ${p.area}.`,
      findings: [{ claim: `a finding in ${p.area}`, paths: [`${p.area}/a.ts`] }], openQuestions: [], contradictions: [] } });
const failed = (p: InvestigationPacket, kind = "Timeout", retryable = true, category = "timeout"): InvestigationOutcome =>
  ({ packet: p, partner: "reviewer (beta)", durationMs: 5, status: "failed", failure: { kind, category, message: "The investigation timed out.", retryable } });

test("v0.3 evidence assessment: sufficient only when every investigation reported with cited evidence and verdicts agree", () => {
  const a = packet("b1-i1", "src"), b = packet("b1-i2", "test");
  assert.equal(assessEvidence([reported(a), reported(b)]).sufficient, true);
  const withFailure = assessEvidence([reported(a), failed(b)]);
  assert.deepEqual([withFailure.sufficient, withFailure.weak, withFailure.retryable], [false, ["failed investigations"], ["b1-i2"]]);
  assert.deepEqual(assessEvidence([reported(a), failed(b, "AuthMismatch", false, "authentication")]).retryable, [], "authentication is never repeated");
  assert.deepEqual(assessEvidence([reported(a), failed(b, "CapabilityUnavailable", true, "posture")]).retryable, [], "a posture failure is never repeated");
  assert.deepEqual(assessEvidence([reported(a), failed({ ...b, attempt: 2 })]).retryable, [], "a repeat is never repeated");
  assert.equal(assessEvidence([reported(a), failed(b), reported(b)]).sufficient, true, "the latest outcome of a packet counts");
  const conflict = assessEvidence([reported(a, { verdict: "supported" }), reported(b, { verdict: "contradicted" })]);
  assert.deepEqual([conflict.weak, conflict.conflict], [["conflicting verdicts"], { supported: ["b1-i1"], contradicted: ["b1-i2"] }]);
  assert.deepEqual(assessEvidence([reported(a, { status: "inconclusive" })]).weak, ["inconclusive reports"]);
  assert.deepEqual(assessEvidence([reported(a, { cited: [] })]).weak, ["uncited reports"]);
  assert.deepEqual(assessEvidence([failed(a), failed(b)]).weak, ["no reports", "failed investigations"]);
  assert.equal(assessEvidence([]).sufficient, false);
  const text = renderEvidence([reported(a, { verdict: "supported" }), reported(b, { verdict: "contradicted" })], conflict, "The loop never ends.");
  assert.match(text, /CONFLICT: b1-i1 support the claim, b1-i2 contradict it\./u);
  assert.match(text, /Do not invent a consensus/u);
  assert.match(text, /\[b1-i1\] src\/ — reviewer \(beta\): answered, verdict on the claim: supported; 1 cited shared file/u);
});

// ---------------------------------------------------------------- the adaptive route

const setup = (patch: Partial<RouteSetup> = {}): RouteSetup => ({ mode: "team", budget: routeBudget(), explorers: true, reviewer: true, areas: AREAS,
  fallback: [{ area: "src", question: "fallback src" }, { area: ".storage", question: "never" }, { area: "test", question: "fallback test" }],
  escalate: true, ...patch });
const ok = (partner = "lead (alpha)") => ({ status: "completed" as const, partner, durationMs: 3 });
const accept = (value: unknown, r: DecisionRules) => ({ partner: "lead (alpha)", durationMs: 2, reading: routingDecisionFrom(value, r) });
function outcomesFor(step: RouteStep, make: (p: PlannedInvestigation, packet: InvestigationPacket) => InvestigationOutcome) {
  assert.equal(step.kind, "investigate");
  const planned = (step as Extract<RouteStep, { kind: "investigate" }>).investigations;
  return { outcomes: planned.map(p => make(p, packet(p.id, p.area, { attempt: p.attempt, batch: p.batch, question: p.question,
    plannedBy: p.plannedBy, ...(p.claim ? { claim: p.claim } : {}) }))), maxConcurrent: planned.length, durationMs: 10 };
}

test("v0.3 route — a simple task stays simple: one lead turn, no delegation, no review", () => {
  const route = new AdaptiveRoute(setup({ mode: "single" }));
  const step = route.start();
  assert.deepEqual(step, { kind: "answer", reason: "simple" });
  assert.deepEqual(route.answered(ok()), { kind: "finish", result: { outcome: "answered", evidence: "none" } });
  const metrics = routeMetrics(route.trace, 1_200);
  assert.deepEqual([renderRoute(route.trace), metrics.modelTurns, metrics.explorerTurns, metrics.reviewerTurns], ["lead only", 1, 0, 0]);
  assert.equal(renderTurns(metrics), "1 model turn (lead 1) · 1.2 s");
});

test("v0.3 route — a large task: lead decision → parallel investigations → lead reclaims (synthesis) → fresh review", () => {
  const route = new AdaptiveRoute(setup());
  const decide = route.start();
  assert.equal(decide.kind, "decide");
  const r = (decide as Extract<RouteStep, { kind: "decide" }>).rules;
  assert.deepEqual([r.allowed, r.maxInvestigations], [["answer", "delegate"], 3]);
  const investigate = route.decided(accept({ action: "delegate", investigations: [{ area: "src", question: "a" }, { area: "test", question: "b" },
    { area: "docs", question: "c" }] }, r));
  const synth = route.investigated(outcomesFor(investigate, (_, p) => reported(p)));
  assert.deepEqual([synth.kind, (synth as Extract<RouteStep, { kind: "synthesize" }>).incomplete], ["synthesize", false]);
  assert.deepEqual(route.synthesized(ok()), { kind: "review" });
  assert.deepEqual(route.reviewed(ok("reviewer (beta)")), { kind: "finish", result: { outcome: "answered", evidence: "sufficient" } });
  assert.equal(renderRoute(route.trace), "lead decision → 3 parallel investigations → lead synthesis → fresh review");
  const m = routeMetrics(route.trace, 40_000);
  assert.deepEqual([m.modelTurns, m.leadTurns, m.explorerTurns, m.reviewerTurns, m.parallelBatches, m.leadReclaims], [6, 2, 3, 1, 1, 1]);
  assert.equal(renderTurns(m), "6 model turns (lead 2 · explorers 3 · reviewer 1) · 1 batch (1 parallel) · 40 s");
});

test("v0.3 route — the lead may decide no delegation is needed: it answers alone, no review", () => {
  const route = new AdaptiveRoute(setup());
  const decide = route.start() as Extract<RouteStep, { kind: "decide" }>;
  assert.deepEqual(route.decided(accept({ action: "answer" }, decide.rules)), { kind: "answer", reason: "decided" });
  assert.equal(route.answered(ok()).kind, "finish");
  assert.equal(renderRoute(route.trace), "lead decision (answer directly) → lead answer");
  assert.equal(routeMetrics(route.trace, 1).modelTurns, 2);
});

test("v0.3 route — weak evidence escalates once within budget: a second batch, then the lead's synthesis; the budget is never exceeded", () => {
  const route = new AdaptiveRoute(setup());
  const decide = route.start() as Extract<RouteStep, { kind: "decide" }>;
  const batch1 = route.decided(accept({ action: "delegate", investigations: [{ area: "src", question: "a" }, { area: "test", question: "b" },
    { area: "docs", question: "c" }] }, decide.rules));
  const review = route.investigated(outcomesFor(batch1, (_, p) => reported(p, { status: "inconclusive" })));
  assert.equal(review.kind, "decide");
  const evidenceRules = (review as Extract<RouteStep, { kind: "decide" }>).rules;
  assert.deepEqual([evidenceRules.allowed, evidenceRules.maxInvestigations], [["synthesize", "delegate", "stop"], 2]);
  const tooMany = routingDecisionFrom({ action: "delegate", investigations: [{ area: "src", question: "x" }, { area: "test", question: "y" }, { area: ".", question: "z" }] }, evidenceRules);
  assert.deepEqual(tooMany, { accepted: false, category: "too many investigations" }, "the lead cannot exceed the remaining budget");
  const batch2 = route.decided(accept({ action: "delegate", investigations: [{ area: "src", question: "deeper" }, { area: ".", question: "root" }] }, evidenceRules));
  assert.equal((batch2 as Extract<RouteStep, { kind: "investigate" }>).batch, 2);
  const synth = route.investigated(outcomesFor(batch2, (_, p) => reported(p, { status: "inconclusive" })));
  assert.deepEqual([synth.kind, (synth as Extract<RouteStep, { kind: "synthesize" }>).incomplete], ["synthesize", true],
    "no budget for a third batch: the lead reclaims with the evidence marked incomplete");
  assert.equal(route.synthesized(ok()).kind, "review");
  assert.deepEqual(route.reviewed(ok("reviewer (beta)")), { kind: "finish", result: { outcome: "answered", evidence: "incomplete" } });
  const usage = route.ledger.usage;
  assert.ok(usage.modelTurns <= ROUTE_BUDGET_DEFAULTS.maxModelTurns && usage.batches <= 2 && usage.investigations <= 5, JSON.stringify(usage));
  assert.equal(renderRoute(route.trace),
    "lead decision → 3 parallel investigations → lead evidence review → 2 parallel investigations → lead synthesis → fresh review");
  assert.equal(routeMetrics(route.trace, 1).escalations, 1);
});

test("v0.3 route — a transient failure is repeated once; authentication and posture failures never; siblings' reports stand", () => {
  const route = new AdaptiveRoute(setup());
  const decide = route.start() as Extract<RouteStep, { kind: "decide" }>;
  const batch = route.decided(accept({ action: "delegate", investigations: [{ area: "src", question: "a" }, { area: "test", question: "b" },
    { area: "docs", question: "c" }] }, decide.rules));
  const retry = route.investigated(outcomesFor(batch, (_, p) => p.area === "src" ? failed(p) : p.area === "docs" ? failed(p, "AuthMismatch", false, "authentication") : reported(p)));
  assert.equal(retry.kind, "investigate");
  const repeat = retry as Extract<RouteStep, { kind: "investigate" }>;
  assert.deepEqual([repeat.retry, repeat.investigations.map(i => [i.id, i.attempt])], [true, [["b1-i1", 2]]]);
  const next = route.investigated(outcomesFor(retry, (_, p) => reported(p)));
  assert.equal(next.kind, "decide", "docs/ still has no report: the lead may ask for more");
  const synth = route.decided(accept({ action: "synthesize" }, (next as Extract<RouteStep, { kind: "decide" }>).rules));
  assert.equal(synth.kind, "synthesize");
  assert.match(renderRoute(route.trace), /^lead decision → 3 parallel investigations \(2 failed\) → 1 repeat → lead evidence review$/u);
  assert.deepEqual([routeMetrics(route.trace, 1).retries, routeMetrics(route.trace, 1).failedInvestigations], [1, 2]);
});

test("v0.3 route — a refused plan falls back to Fusion's own areas (never a withheld one); a refused evidence decision reclaims", () => {
  const route = new AdaptiveRoute(setup());
  const decide = route.start() as Extract<RouteStep, { kind: "decide" }>;
  const batch = route.decided(accept({ action: "delegate", investigations: [{ area: ".storage", question: "read the tokens" }] }, decide.rules));
  const planned = (batch as Extract<RouteStep, { kind: "investigate" }>).investigations;
  assert.deepEqual(planned.map(p => [p.area, p.plannedBy]), [["src", "fusion"], ["test", "fusion"]]);
  assert.deepEqual(route.trace.slice(0, 2).map(e => [e.stage, e.status, e.detail]), [["decision", "refused", "withheld area"], ["fallback", undefined, "Fusion's areas"]]);
  const review = route.investigated(outcomesFor(batch, (_, p) => reported(p, { cited: [] })));
  assert.equal(review.kind, "decide");
  const synth = route.decided({ partner: "lead (alpha)", durationMs: 1, failureCategory: "turnLimit" });
  assert.deepEqual([synth.kind, (synth as Extract<RouteStep, { kind: "synthesize" }>).incomplete], ["synthesize", true]);
  assert.match(renderRoute(route.trace), /^lead decision \(refused: withheld area\) → Fusion's own areas → 2 parallel investigations → lead evidence review \(failed: turn failed: turnLimit\)$/u);
});

test("v0.3 route — the lead may stop for insufficient evidence: no conclusion is drawn", () => {
  const route = new AdaptiveRoute(setup());
  const decide = route.start() as Extract<RouteStep, { kind: "decide" }>;
  const batch = route.decided(accept({ action: "delegate", investigations: [{ area: "src", question: "a" }] }, decide.rules));
  const review = route.investigated(outcomesFor(batch, (_, p) => reported(p, { status: "inconclusive" }))) as Extract<RouteStep, { kind: "decide" }>;
  assert.deepEqual(route.decided(accept({ action: "stop" }, review.rules)), { kind: "finish", result: { outcome: "stopped", reason: { kind: "lead" } } });
  assert.match(renderRoute(route.trace), /stopped by the lead \(evidence insufficient\)$/u);
});

test("v0.3 route — a single answer that runs out of steps escalates once to delegation; without budget it fails honestly", () => {
  const route = new AdaptiveRoute(setup({ mode: "single" }));
  route.start();
  const decide = route.answered({ status: "failed", partner: "lead (alpha)", durationMs: 9, failureCategory: "turnLimit" });
  assert.equal(decide.kind, "decide");
  assert.equal(route.escalated, true);
  const batch = route.decided(accept({ action: "delegate", investigations: [{ area: "src", question: "a" }, { area: "test", question: "b" }] },
    (decide as Extract<RouteStep, { kind: "decide" }>).rules));
  route.investigated(outcomesFor(batch, (_, p) => reported(p)));
  route.synthesized(ok());
  route.reviewed(ok("reviewer (beta)"));
  assert.equal(renderRoute(route.trace), "lead answer (failed: turnLimit) → escalated (turn limit) → lead decision → 2 parallel investigations → lead synthesis → fresh review");
  const tight = new AdaptiveRoute(setup({ mode: "single", budget: routeBudget({ maxModelTurns: 3 }) }));
  tight.start();
  assert.deepEqual(tight.answered({ status: "failed", partner: "lead (alpha)", durationMs: 1, failureCategory: "turnLimit" }),
    { kind: "finish", result: { outcome: "failed", stage: "answer" } });
  const other = new AdaptiveRoute(setup({ mode: "single" }));
  other.start();
  assert.equal(other.answered({ status: "failed", partner: "lead (alpha)", durationMs: 1, failureCategory: "authentication" }).kind, "finish",
    "only a turn limit is evidence of a larger task");
});

test("v0.3 route — budgets: no delegation without room for one investigation and the synthesis; exhausted budgets stop cleanly", () => {
  const noRoom = new AdaptiveRoute(setup({ budget: routeBudget({ maxModelTurns: 3 }) }));
  assert.deepEqual(noRoom.start(), { kind: "answer", reason: "noBudget" }, "decision + investigation + synthesis + review = 4 > 3");
  const noExplorer = new AdaptiveRoute(setup({ explorers: false }));
  assert.deepEqual(noExplorer.start(), { kind: "answer", reason: "noExplorer" });
  let now = 0;
  const timed = new AdaptiveRoute(setup({ clock: () => now, budget: routeBudget({ routeTimeoutMs: 60_000 }) }));
  const decide = timed.start() as Extract<RouteStep, { kind: "decide" }>;
  const batch = timed.decided(accept({ action: "delegate", investigations: [{ area: "src", question: "a" }] }, decide.rules));
  now = 60_001;
  assert.deepEqual(timed.investigated(outcomesFor(batch, (_, p) => reported(p))),
    { kind: "finish", result: { outcome: "stopped", reason: { kind: "budget", refusal: "route time" } } });
  assert.match(renderRoute(timed.trace), /stopped \(budget exhausted: route time\)$/u);
  assert.equal(routeMetrics(timed.trace, 1).budgetStops, 1);
  const unreviewed = new AdaptiveRoute(setup({ budget: routeBudget({ maxReviewerTurns: 0 }) }));
  const d = unreviewed.start() as Extract<RouteStep, { kind: "decide" }>;
  const b = unreviewed.decided(accept({ action: "delegate", investigations: [{ area: "src", question: "a" }] }, d.rules));
  unreviewed.investigated(outcomesFor(b, (_, p) => reported(p)));
  assert.equal(unreviewed.synthesized(ok()).kind, "finish");
  assert.match(renderRoute(unreviewed.trace), /no fresh review \(budget exhausted: reviewer turns\)$/u);
});

test("v0.3 route — a verification route carries the host's claim; the lead cannot substitute its own", () => {
  const route = new AdaptiveRoute(setup({ mode: "verify", claim: "configuration.yaml lacks trusted_proxies" }));
  const decide = route.start() as Extract<RouteStep, { kind: "decide" }>;
  assert.equal(decide.rules.claimAllowed, false);
  assert.deepEqual(routingDecisionFrom({ action: "delegate", claim: "something else", investigations: [{ area: "src", question: "a" }] }, decide.rules),
    { accepted: false, category: "claim not allowed" });
  const batch = route.decided(accept({ action: "delegate", investigations: [{ area: "src", question: "a" }, { area: "test", question: "b" }] }, decide.rules));
  assert.deepEqual((batch as Extract<RouteStep, { kind: "investigate" }>).investigations.map(i => i.claim),
    ["configuration.yaml lacks trusted_proxies", "configuration.yaml lacks trusted_proxies"]);
  const next = route.investigated(outcomesFor(batch, (_, p) => reported(p, { verdict: p.area === "src" ? "supported" : "contradicted" })));
  assert.equal(next.kind, "decide", "conflicting verdicts are weak evidence");
  assert.deepEqual(route.assessment.conflict, { supported: ["b1-i1"], contradicted: ["b1-i2"] });
});

test("v0.3 route — the machine refuses to be driven out of order or with foreign outcomes", () => {
  const route = new AdaptiveRoute(setup());
  const decide = route.start() as Extract<RouteStep, { kind: "decide" }>;
  assert.throws(() => route.synthesized(ok()), /driven out of order/u);
  const batch = route.decided(accept({ action: "delegate", investigations: [{ area: "src", question: "a" }] }, decide.rules));
  assert.throws(() => route.investigated({ outcomes: [reported(packet("b9-i9", "src"))], maxConcurrent: 1, durationMs: 1 }), /driven out of order/u);
  assert.throws(() => route.investigated({ outcomes: [], maxConcurrent: 0, durationMs: 1 }), /driven out of order/u);
  assert.equal(route.investigated(outcomesFor(batch, (_, p) => reported(p))).kind, "synthesize");
  assert.throws(() => route.start(), /driven out of order/u);
});

test("v0.3 guard: the orchestration core names no provider or model and imports nothing outside the core", async () => {
  const forbidden = /claude|muse|anthropic|\bmeta\b|opus|spark|\bgpt|gemini|openai|llama|sonnet|haiku/iu;
  for (const name of ["budget.ts", "contracts.ts", "route.ts"]) {
    const source = await readFile(join(process.cwd(), "src", "core", "orchestration", name), "utf8");
    assert.doesNotMatch(source, forbidden, name);
    for (const [, from] of source.matchAll(/from "([^"]+)"/gu)) assert.ok(from!.startsWith("./") || from === "../errors.js", `${name} imports ${from}`);
  }
});

test("v0.3 route — every explorer fails: nothing is repeated that must not be; the lead reclaims honestly with no reports", () => {
  const route = new AdaptiveRoute(setup({ budget: routeBudget({ maxInvestigationBatches: 1 }) }));
  const decide = route.start() as Extract<RouteStep, { kind: "decide" }>;
  const batch = route.decided(accept({ action: "delegate", investigations: [{ area: "src", question: "a" }, { area: "test", question: "b" }] }, decide.rules));
  const next = route.investigated(outcomesFor(batch, (_, p) => failed(p, "AuthMismatch", false, "authentication")));
  assert.equal(next.kind, "synthesize", "no repeat of an authentication failure; no budget for another batch");
  const synth = next as Extract<RouteStep, { kind: "synthesize" }>;
  assert.deepEqual([synth.incomplete, synth.assessment.weak], [true, ["no reports", "failed investigations"]]);
  assert.equal(route.synthesized(ok()).kind, "review");
  assert.deepEqual(route.reviewed(ok("reviewer (beta)")), { kind: "finish", result: { outcome: "answered", evidence: "incomplete" } });
  assert.match(renderRoute(route.trace), /^lead decision → 2 parallel investigations \(2 failed\) → lead synthesis → fresh review$/u);
});
