import assert from "node:assert/strict";
import { test } from "node:test";
import { routeLedger } from "../src/app/route-probe.js";
import { withRoot } from "./fixtures/probe-harness.js";
import { withInstalls } from "./fixtures/provider-installs.js";
import { adjudication, asRun, plan, PREFIX, proposal, reviewWith, runRoute, sectionOf } from "./fixtures/route-harness.js";
import { FIX_ONLY, gitAvailable, WRONG } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5B12 — the bounded correction path of the full route, offline, with the REAL adapter code: every way the one
 * permitted correction can fail ends classified, within the authorized budget, without an extra model turn.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const confirmed = (cycle = 1) => ({ prefix: PREFIX.adjudication, output: adjudication([`r${cycle}-F1`, "CONFIRMED", "fix"]) });
const finding = { prefix: PREFIX.review, output: reviewWith({ id: "F1", severity: "HIGH" }) };
const lead = (...rest: Array<{ prefix: string; output: string }>) => [{ prefix: PREFIX.plan, output: plan() }, ...rest];
const turnsOf = (run: Parameters<typeof sectionOf>[0]) => sectionOf<Record<string, number>>(run, "turnUse");

test("O5.5B12 D: the correction fails confined verification — the budget is exhausted, never a third attempt or a second review", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    const run = asRun(await runRoute(i, dir, "d", { Lead: lead(confirmed()), Worker: [proposal(FIX_ONLY), proposal(WRONG)], Reviewer: [finding] }));
    assert.deepEqual([run.report.outcome, run.report.detail], ["VERIFICATION_FAILED",
      "the final attempt failed confined verification; the bounded budget is exhausted"]);
    assert.deepEqual(turnsOf(run), { leadPlan: 1, changeAuthor: 2, freshReview: 1, leadAdjudication: 1 });
    assert.deepEqual(sectionOf<{ events: Array<{ passed: boolean }> }>(run, "verification").events.map(e => e.passed), [true, false]);
    assert.deepEqual(sectionOf<{ leftoverOwnedTemporaries: string[] }>(run, "cleanup").leftoverOwnedTemporaries, []);
  })));

test("O5.5B12 E: a finding that persists after the correction stops at the review bound — the full seven-turn budget, then a decision", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    const run = asRun(await runRoute(i, dir, "e", { Lead: lead(confirmed(1), confirmed(2)), Worker: [proposal(FIX_ONLY), proposal(FIX_ONLY)],
      Reviewer: [finding, finding] }));
    assert.equal(run.report.outcome, "FINDINGS_UNRESOLVED", run.report.detail);
    assert.deepEqual(turnsOf(run), { leadPlan: 1, changeAuthor: 2, freshReview: 2, leadAdjudication: 2 });
    assert.equal(run.report.modelTurns, 7, "exactly the maximum authorized budget, never more");
    assert.deepEqual(sectionOf<{ cycles: Array<{ outcome: string }> }>(run, "review").cycles.map(c => c.outcome), ["correction", "gate"]);
    assert.deepEqual((await routeLedger(run.root)).map(entry => `${String(entry.turn)}#${String(entry.slot)}`), ["leadPlan#1", "changeAuthor#1",
      "freshReview#1", "leadAdjudication#1", "changeAuthor#2", "freshReview#2", "leadAdjudication#2"]);
  })));
