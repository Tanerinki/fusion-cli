import assert from "node:assert/strict";
import { test } from "node:test";
import { withRoot } from "./fixtures/probe-harness.js";
import { withInstalls } from "./fixtures/provider-installs.js";
import { adjudication, asRun, cleanReview, plan, PREFIX, proposal, reviewWith, runRoute, sectionOf, testRouteAuthorization,
  type ComposeHooks } from "./fixtures/route-harness.js";
import { FIX, FIX_ONLY, gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5B12 — the correction budget of the full route, offline, with the REAL adapter code: a malformed or timed-out
 * correction, a correction or re-review beyond the authorized budget, and a cleanup failure between attempts.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const confirmed = (cycle = 1) => ({ prefix: PREFIX.adjudication, output: adjudication([`r${cycle}-F1`, "CONFIRMED", "fix"]) });
const finding = { prefix: PREFIX.review, output: reviewWith({ id: "F1", severity: "HIGH" }) };
const lead = (...rest: Array<{ prefix: string; output: string }>) => [{ prefix: PREFIX.plan, output: plan() }, ...rest];
const turnsOf = (run: Parameters<typeof sectionOf>[0]) => sectionOf<Record<string, number>>(run, "turnUse");

test("O5.5B12 F/G: a malformed or timed-out correction ends the run at changeAuthor #2 — no retry, nothing verified", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    const malformed = asRun(await runRoute(i, dir, "f", { Lead: lead(confirmed()), Reviewer: [finding],
      Worker: [proposal(FIX_ONLY), { prefix: PREFIX.proposal, output: "Here is the corrected ChangeSet: {}" }] }));
    assert.equal(malformed.report.outcome, "MALFORMED_OUTPUT");
    assert.match(malformed.report.detail, /^changeAuthor #2 \(Worker\): Claude structured output was refused: OTHER_MALFORMED/u);
    assert.deepEqual(turnsOf(malformed), { leadPlan: 1, changeAuthor: 2, freshReview: 1, leadAdjudication: 1 });
    assert.equal(sectionOf<{ events: unknown[] }>(malformed, "verification").events.length, 1, "the malformed correction is never verified");
    const slow = testRouteAuthorization(i, {}, { Worker: { binding: { ...testRouteAuthorization(i).roles.Worker.binding,
      options: { ...testRouteAuthorization(i).roles.Worker.binding.options, timeoutMs: 6_000 } } } });
    const timedOut = asRun(await runRoute(i, dir, "g", { Lead: lead(confirmed()), Reviewer: [finding],
      Worker: [proposal(FIX_ONLY), { prefix: PREFIX.proposal, scenario: "hang" }] }, { authorization: slow }));
    assert.equal(timedOut.report.outcome, "TIMEOUT", timedOut.report.detail);
    assert.match(timedOut.report.detail, /^changeAuthor #2 \(Worker\)/u);
    assert.deepEqual(turnsOf(timedOut), { leadPlan: 1, changeAuthor: 2, freshReview: 1, leadAdjudication: 1 });
    assert.deepEqual(sectionOf<{ leftoverOwnedTemporaries: string[] }>(timedOut, "cleanup").leftoverOwnedTemporaries, []);
  })));

test("O5.5B12 H: a correction or re-review beyond the authorized budget is refused before the provider is reached", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    const base = testRouteAuthorization(i);
    const noCorrection = asRun(await runRoute(i, dir, "h1", { Lead: lead(confirmed()), Worker: [proposal(FIX_ONLY), proposal(FIX)], Reviewer: [finding, finding] },
      { authorization: { ...base, turns: { ...base.turns, changeAuthor: 1 } } }));
    assert.deepEqual([noCorrection.report.outcome, noCorrection.report.detail], ["TURN_REFUSED",
      "a role turn was refused before it reached the provider: changeAuthor budget of 1 is exhausted"]);
    assert.deepEqual(turnsOf(noCorrection), { leadPlan: 1, changeAuthor: 1, freshReview: 1, leadAdjudication: 1 });
    assert.equal(noCorrection.prompts.Worker.length, 1, "the Change Author's fake saw exactly one model turn");
    const noReReview = asRun(await runRoute(i, dir, "h2", { Lead: lead(confirmed()), Worker: [proposal(FIX_ONLY), proposal(FIX)],
      Reviewer: [finding, { prefix: PREFIX.review, output: cleanReview }] }, { authorization: { ...base, turns: { ...base.turns, freshReview: 1 } } }));
    assert.deepEqual([noReReview.report.outcome, noReReview.report.detail], ["TURN_REFUSED",
      "a role turn was refused before it reached the provider: freshReview budget of 1 is exhausted"]);
    assert.equal(noReReview.prompts.Reviewer.length, 1);
    for (const run of [noCorrection, noReReview])
      assert.deepEqual(sectionOf<{ leftoverOwnedTemporaries: string[] }>(run, "cleanup").leftoverOwnedTemporaries, []);
  })));

test("O5.5B12 cleanup: an unproven release of the superseded candidate between attempts stops the route — never a success", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    const kept: ComposeHooks["kept"] = [];
    try {
      const run = asRun(await runRoute(i, dir, "cleanup", { Lead: lead(confirmed()), Worker: [proposal(FIX_ONLY), proposal(FIX)],
        Reviewer: [finding, { prefix: PREFIX.review, output: cleanReview }] }, { hooks: { failRelease: index => index === 0, kept } }));
      assert.deepEqual([run.report.outcome, run.report.detail], ["CLEANUP_FAILED", "A superseded Writer candidate could not be removed completely."]);
      assert.deepEqual(turnsOf(run), { leadPlan: 1, changeAuthor: 1, freshReview: 1, leadAdjudication: 1 }, "no correction turn after the failed release");
    } finally { for (const release of kept) await release(); }
  })));
