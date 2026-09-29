import assert from "node:assert/strict";
import { test } from "node:test";
import type { TieChoice } from "../src/app/tournament/run.js";
import { proposalSha256 } from "../src/core/tournament/manifest.js";
import { TournamentBudgetRefused } from "../src/core/tournament/route.js";
import { STRATEGY_BRIEFS } from "../src/core/tournament/strategies.js";
import { plan, type Script } from "./fixtures/fake-writer.js";
import { GuestPort, type Program } from "./fixtures/guest-port.js";
import { QUOTE_FIXED } from "./fixtures/rehearsal-project.js";
import { ALT, ALT_FIXED, API_BREAK, EXPERIMENTS, FIX, PROGRAM, SMALL, states, tournament, WRONG } from "./fixtures/tournament-harness.js";


test("v0.5 tournament: a failed obligation eliminates a candidate; the verified one is selected, revalidated freshly and bound for delivery", async () => {
  assert.notEqual(ALT_FIXED, QUOTE_FIXED);
  const { report, summary, port, spies } = await tournament({ c1: { worker: () => WRONG }, c2: { worker: () => FIX } });
  assert.equal(report.outcome, "DELIVERY_ELIGIBLE", report.detail);
  assert.deepEqual(report.selected && [report.selected.id, report.selected.chosenBy], ["c2", "fusion"]);
  assert.deepEqual(states(report), [["c1", "rejected"], ["c2", "deliveryEligible"]]);
  assert.equal(report.candidates[0]!.decision, "BLOCKED");
  assert.equal(report.revalidation?.passed, true);
  // Delivery gets exactly the selected candidate's change, bound by its proposal digest.
  assert.equal(report.delivery?.proposalSha256, proposalSha256(FIX));
  assert.equal(proposalSha256(report.delivery!.result.changeSet!), proposalSha256(FIX));
  assert.equal(report.delivery?.evidence.decision.deliverable, true);
  // The profile was frozen on the unchanged baseline before any candidate was touched.
  assert.equal(port.runs[0]!.baseline, true);
  assert.deepEqual(port.runs[0]!.commands, ["typecheck", "unit"]);
  assert.equal(report.profile.profile.baseline.reproduced, true);
  assert.deepEqual(report.profile.profile.baseline.failing, ["unit"]);
  // Exactly one revalidation, and every candidate Fusion or an engine materialized is released; the primary never changed.
  assert.equal(port.acquired.filter(owner => owner.endsWith(".revalidate")).length, 1);
  assert.equal(port.released.length, port.acquired.length);
  assert.equal(report.primaryUnchanged, true);
  assert.equal(report.cleanup.complete, true);
  // Independent generation: each author saw its own brief only; independence is stated honestly.
  for (const [id, other] of [["c1", "c2"], ["c2", "c1"]] as const) {
    const constraints = spies.get(id)!.proposals.flatMap(p => p.task.constraints);
    assert.ok(constraints.includes(STRATEGY_BRIEFS[id].brief), id);
    assert.ok(!constraints.includes(STRATEGY_BRIEFS[other].brief), `${id} never sees ${other}'s brief`);
  }
  assert.equal(report.independence, "separateContext");
  // The run summary resolves the selected candidate's decision through the binding.
  assert.deepEqual([summary.tournament?.resolved, summary.tournament?.selected, summary.tournament?.revision], [true, "c2", report.selected!.revision]);
  assert.deepEqual([summary.evidence?.decision, summary.evidence?.deliverable], ["VERIFIED", true]);
});

test("v0.5 tournament: identical changes converge; a smaller verified change dominates; nothing is scored", async () => {
  const converged = await tournament({ c1: { worker: () => FIX }, c2: { worker: () => FIX } });
  assert.equal(converged.report.outcome, "DELIVERY_ELIGIBLE");
  assert.equal(converged.report.selected?.id, "c1");
  assert.equal(converged.report.selection?.kind === "selected" && converged.report.selection.converged.length, 2);
  assert.deepEqual(states(converged.report), [["c1", "deliveryEligible"], ["c2", "notSelected"]]);
  assert.deepEqual(converged.report.converged, ["c1", "c2"], "recorded as CONVERGED — one result");
  assert.match(converged.report.detail, /^c1 and c2 made the identical change \(converged: one result\); c1 represents it/u);
  assert.equal(converged.report.candidates.find(c => c.id === "c2")!.detail, "the identical change as c1 (converged: one result)");
  const decided = converged.summaryEvents.find(e => e.type === "TournamentDecided")!.payload as { converged?: string[]; selected?: string };
  assert.deepEqual([decided.converged, decided.selected], [["c1", "c2"], "c1"], "the decision record says CONVERGED");
  assert.deepEqual(converged.summary.tournament?.converged, ["c1", "c2"]);

  const dominated = await tournament({ c1: { worker: () => FIX }, c2: { worker: () => SMALL } });
  assert.equal(dominated.report.outcome, "DELIVERY_ELIGIBLE");
  assert.equal(dominated.report.selected?.id, "c2");
  assert.match(dominated.report.differences.join("\n"), /c2 dominates c1 by Fusion's evidence: fewer changed files/u);
  assert.ok(!JSON.stringify(dominated.report).match(/score|confidence|%/u), "no score of any kind");
  assert.equal(dominated.report.converged, undefined, "different changes never converge");
});

test("v0.5 tournament: undominated verified candidates are a tie — a human decision; a human's choice is still revalidated", async () => {
  const tie = await tournament({ c1: { worker: () => FIX }, c2: { worker: () => ALT } }, { experiments: EXPERIMENTS });
  assert.equal(tie.report.outcome, "MULTIPLE_VERIFIED_CANDIDATES", tie.report.detail);
  assert.deepEqual(tie.report.tied, ["c1", "c2"]);
  assert.equal(tie.report.delivery, undefined);
  assert.equal(tie.report.revalidation, undefined, "nothing is revalidated before a choice");
  assert.match(tie.report.differences.join("\n"), /probe:shape: the candidates behave differently \(c1 ≠ c2\)/u);
  assert.deepEqual(states(tie.report), [["c1", "tied"], ["c2", "tied"]]);
  assert.equal(tie.report.converged, undefined, "materially different verified candidates are a tie, never a convergence");
  assert.deepEqual([tie.summary.tournament?.resolved, tie.summary.tournament?.outcome, tie.summary.evidence], [true, "MULTIPLE_VERIFIED_CANDIDATES", undefined]);

  const offered: TieChoice[] = [];
  const chosen = await tournament({ c1: { worker: () => FIX }, c2: { worker: () => ALT } },
    { experiments: EXPERIMENTS, chooseTie: async choice => { offered.push(choice); return "c2"; } });
  assert.deepEqual(offered.map(o => o.candidates), [["c1", "c2"]]);
  assert.equal(chosen.report.outcome, "DELIVERY_ELIGIBLE");
  assert.deepEqual(chosen.report.selected && [chosen.report.selected.id, chosen.report.selected.chosenBy], ["c2", "human"]);
  assert.equal(chosen.report.revalidation?.passed, true);
  assert.equal(chosen.port.acquired.filter(owner => owner.endsWith(".revalidate")).length, 1);
  assert.deepEqual([chosen.summary.tournament?.selected, chosen.summary.tournament?.chosenBy], ["c2", "human"]);

  const foreign = await tournament({ c1: { worker: () => FIX }, c2: { worker: () => ALT } }, { chooseTie: async () => "c3" });
  assert.equal(foreign.report.outcome, "MULTIPLE_VERIFIED_CANDIDATES", "a choice outside the tie is no choice");
  assert.equal(foreign.report.delivery, undefined);
});

test("v0.5 tournament: Fusion's own experiment contradicts a candidate its v0.4 checks passed — it is rejected, not a model's opinion", async () => {
  const { report } = await tournament({ c1: { worker: () => API_BREAK }, c2: { worker: () => FIX } }, { experiments: EXPERIMENTS });
  assert.equal(report.outcome, "DELIVERY_ELIGIBLE");
  assert.equal(report.selected?.id, "c2");
  const c1 = report.candidates.find(c => c.id === "c1")!;
  assert.equal(c1.state, "rejected");
  assert.deepEqual(c1.facts.contradictions, ["probe:api"]);
  assert.ok(c1.nodes.every(n => n.revision === c1.revision), "every node is bound to the candidate's exact revision");
});

test("v0.5 tournament: nothing verified, providers failing and a revalidation mismatch each end fail-closed with their own outcome", async () => {
  const none = await tournament({ c1: { worker: () => WRONG }, c2: { worker: () => WRONG } });
  assert.equal(none.report.outcome, "NO_VERIFIED_CANDIDATE");
  assert.equal(none.report.delivery, undefined);
  assert.equal(none.report.revalidation, undefined);

  const failing = await tournament({ c1: { worker: () => { throw new Error("provider down"); } }, c2: { worker: () => ({ not: "a change set" }) } });
  assert.equal(failing.report.outcome, "PROVIDER_FAILURE", failing.report.detail);
  assert.deepEqual(states(failing.report), [["c1", "failed"], ["c2", "failed"]]);

  // The unit run passes while the candidates are judged, and fails on the fresh revalidation: never retried until it passes.
  let revalidating = false;
  const flaky: Program = (command, tree, context) => {
    if (command.id === "unit" && revalidating) return { exit: 1, stdout: "fail\n" };
    return PROGRAM(command, tree, context);
  };
  const mismatch = await tournament({ c1: { worker: () => WRONG }, c2: { worker: () => FIX } }, { program: flaky, port: port => {
    const acquire = port.acquire.bind(port);
    port.acquire = async (owner: string) => { if (owner.endsWith(".revalidate")) revalidating = true; return acquire(owner); };
  } });
  assert.equal(mismatch.report.outcome, "REVALIDATION_MISMATCH");
  assert.equal(mismatch.report.revalidation?.passed, false);
  assert.equal(mismatch.report.delivery, undefined);
  assert.equal(mismatch.port.acquired.filter(owner => owner.endsWith(".revalidate")).length, 1, "exactly one revalidation");
  assert.deepEqual(states(mismatch.report), [["c1", "rejected"], ["c2", "rejected"]]);
  assert.deepEqual([mismatch.summary.tournament?.resolved, mismatch.summary.evidence?.deliverable], [true, false]);
});

test("v0.5 tournament: a change of the primary checkout stops the tournament as a security violation — nothing is delivered", async () => {
  let port: GuestPort | undefined;
  const { report, summary } = await tournament({ c1: { worker: () => { port!.primaryVersion++; return FIX; } }, c2: { worker: () => FIX } },
    { port: p => { port = p; } });
  assert.equal(report.outcome, "CANDIDATE_SECURITY_VIOLATION", report.detail);
  assert.equal(report.delivery, undefined);
  assert.equal(report.primaryUnchanged, false);
  assert.equal(summary.evidence, undefined);
});

test("v0.5 tournament: the budget is enforced before any model turn", async () => {
  for (const candidates of [0, 4]) {
    let turns = 0;
    await assert.rejects(tournament({ c1: { worker: () => { turns++; return FIX; } } }, { candidates }), TournamentBudgetRefused);
    assert.equal(turns, 0);
  }
  const single = await tournament({ c1: { worker: () => FIX } }, { candidates: 1 });
  assert.equal(single.report.outcome, "DELIVERY_ELIGIBLE");
  assert.deepEqual(single.report.candidates.map(c => c.id), ["c1"]);
});

/** A Worker that never answers: only its deadline or a cancellation ends its turn. */
const hanging: Script = { worker: ({ signal }) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("stopped")), { once: true })) };

test("v0.5 tournament: candidates stopped by their deadline exhaust the budget; a cancellation is CANCELLED — neither is 'failed' in general", async () => {
  const exhausted = await tournament({ c1: hanging, c2: hanging }, { timeoutMs: 400 });
  assert.equal(exhausted.report.outcome, "TOURNAMENT_BUDGET_EXHAUSTED", exhausted.report.detail);
  assert.deepEqual(exhausted.report.candidates.map(c => [c.state, c.failure]), [["failed", "budget"], ["failed", "budget"]]);
  assert.equal(exhausted.report.delivery, undefined);

  const controller = new AbortController();
  const cancelled = await tournament({ c1: { worker: ({ signal }) => { controller.abort(); return hanging.worker({ signal } as never); } }, c2: hanging },
    { signal: controller.signal });
  assert.equal(cancelled.report.outcome, "CANCELLED", cancelled.report.detail);
  assert.equal(cancelled.report.delivery, undefined);
  assert.deepEqual([cancelled.summary.tournament?.resolved, cancelled.summary.tournament?.outcome], [true, "CANCELLED"]);
});

test("v0.5 tournament: a candidate that asks the human stops the whole tournament — no sibling is selected on an assumption", async () => {
  const asking: Script = { lead: () => plan("Plan.", { needsLeadDecision: ["Should a full discount also waive the shipping fee?"] }), worker: () => FIX };
  const { report, summary } = await tournament({ c1: asking, c2: { worker: () => FIX } });
  assert.equal(report.outcome, "DECISION_REQUESTED", report.detail);
  assert.equal(report.asked?.candidate, "c1");
  assert.equal(report.asked?.result.state, "decisionRequired");
  assert.deepEqual([report.selected, report.revalidation, report.delivery], [undefined, undefined, undefined]);
  assert.ok(report.candidates.every(c => c.state !== "selected" && c.state !== "deliveryEligible"));
  assert.deepEqual([summary.tournament?.resolved, summary.tournament?.outcome, summary.evidence], [true, "DECISION_REQUESTED", undefined]);
});

test("v0.5 tournament: at most 2 candidates run at once — the parallelism bound holds with 3 candidates", async () => {
  let active = 0, peak = 0;
  const gates: Array<() => void> = [];
  const worker: Script["worker"] = async () => {
    active++; peak = Math.max(peak, active);
    // The first two authors wait for each other; the third can only start after one of them finished.
    if (gates.length < 2) await new Promise<void>(resolve => { gates.push(resolve); if (gates.length === 2) gates.forEach(open => open()); });
    active--;
    return FIX;
  };
  const { report } = await tournament({ c1: { worker }, c2: { worker }, c3: { worker } }, { candidates: 3 });
  assert.equal(report.candidates.length, 3);
  assert.equal(peak, 2, "never more than the bound, and the bound is used");
});

test("v0.5 convergence: identical changes are one result — shown as CONVERGED with a canonical representative, never as a winner", async () => {
  const { tournamentSummary } = await import("../src/app/tournament/build.js");
  const { tournamentLines, renderRun } = await import("../src/cli/render.js");
  const { report, summary } = await tournament({ c1: { worker: () => FIX }, c2: { worker: () => FIX } });
  const route = { route: "tournament" as const, candidates: 2, eligible: true, source: "human" as const, reasons: ["the human asked for 2 candidates"] };
  const lines = tournamentLines(tournamentSummary(report, route)).join("\n");
  assert.match(lines, /^ {2}converged: c1 = c2 — the identical change, one result \(not a contest\); c1 represents it for revalidation and delivery$/mu);
  assert.match(lines, /^ {2}c2 \(root-cause\): notSelected, VERIFIED — the identical change as c1 \(converged: one result\)$/mu);
  assert.doesNotMatch(lines, /selected: c1 \(by Fusion's evidence\)/u, "no candidate is said to have beaten an identical one");
  assert.match(renderRun(summary), /^tournament: DELIVERY_ELIGIBLE — c1 = c2 converged on one change; c1 represents it, revision [0-9a-f]{12}$/mu);
  // Materially different, both verified, neither dominating: a tie, a human decision — never a convergence.
  const tie = await tournament({ c1: { worker: () => FIX }, c2: { worker: () => ALT } });
  assert.deepEqual([tie.report.outcome, tie.report.converged, tie.report.selected], ["MULTIPLE_VERIFIED_CANDIDATES", undefined, undefined]);
});
