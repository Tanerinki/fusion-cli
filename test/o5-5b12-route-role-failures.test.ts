import assert from "node:assert/strict";
import { test } from "node:test";
import { withRoot } from "./fixtures/probe-harness.js";
import { withInstalls } from "./fixtures/provider-installs.js";
import { asRun, plan, PREFIX, proposal, reviewWith, runRoute, sectionOf, testRouteAuthorization, type RoleScripts } from "./fixtures/route-harness.js";
import { FIX, gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5B12 — every role's malformed, failed or timed-out turn in the full route, offline, with the REAL adapter code:
 * classified at exactly that turn, one model process, no retry, no substitute provider or model, full cleanup.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const leadPlan = { prefix: PREFIX.plan, output: plan() };
const finding = (severity = "HIGH") => ({ prefix: PREFIX.review, output: reviewWith({ id: "F1", severity }) });
type Turn = { turn: string; slot: number; outcome: string; errorKind?: string; modelProcesses: number };
const turnsOf = (run: Parameters<typeof sectionOf>[0]) => sectionOf<Record<string, number>>(run, "turnUse");
const short = (i: Parameters<typeof testRouteAuthorization>[0], role: "Lead" | "Worker" | "Reviewer") => {
  const base = testRouteAuthorization(i);
  return testRouteAuthorization(i, {}, { [role]: { binding: { ...base.roles[role].binding,
    options: { ...base.roles[role].binding.options, timeoutMs: 6_000 } } } });
};

test("O5.5B12 malformed output at every role ends MALFORMED_OUTPUT at exactly that turn, after one model process, with no retry", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    const cases: Array<[string, RoleScripts, string, Record<string, number>]> = [
      ["lead", { Lead: [{ prefix: PREFIX.plan, output: "{bad" }] }, "leadPlan #1 (Lead)", { leadPlan: 1, changeAuthor: 0, freshReview: 0, leadAdjudication: 0 }],
      ["worker", { Lead: [leadPlan], Worker: [{ prefix: PREFIX.proposal, output: "I changed src/quote.ts for you." }] }, "changeAuthor #1 (Worker)",
        { leadPlan: 1, changeAuthor: 1, freshReview: 0, leadAdjudication: 0 }],
      ["reviewer", { Lead: [leadPlan], Worker: [proposal(FIX)], Reviewer: [{ prefix: PREFIX.review, output: "```json\n{}\n```" }] }, "freshReview #1 (Reviewer)",
        { leadPlan: 1, changeAuthor: 1, freshReview: 1, leadAdjudication: 0 }],
      ["adjudicator", { Lead: [leadPlan, { prefix: PREFIX.adjudication, output: "CONFIRMED" }], Worker: [proposal(FIX)], Reviewer: [finding()] },
        "leadAdjudication #1 (Lead)", { leadPlan: 1, changeAuthor: 1, freshReview: 1, leadAdjudication: 1 }],
    ];
    for (const [name, scripts, who, use] of cases) {
      const run = asRun(await runRoute(i, dir, name, scripts));
      assert.equal(run.report.outcome, "MALFORMED_OUTPUT", `${name}: ${run.report.detail}`);
      assert.ok(run.report.detail.startsWith(who), `${name}: ${run.report.detail}`);
      assert.deepEqual(turnsOf(run), use, name);
      assert.ok(sectionOf<Turn[]>(run, "turns").every(t => t.modelProcesses === 1), `${name}: one model process per turn`);
      assert.deepEqual(sectionOf<{ leftoverOwnedTemporaries: string[] }>(run, "cleanup").leftoverOwnedTemporaries, [], name);
    }
  })));

test("O5.5B12 a provider failure or timeout at each role ends classified at that turn; nothing substitutes another provider or model", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    const cases: Array<[string, RoleScripts, string, string, ReturnType<typeof testRouteAuthorization> | undefined]> = [
      ["lead-fail", { Lead: [{ prefix: PREFIX.plan, scenario: "fail" }] }, "PROVIDER_FAILED", "leadPlan #1 (Lead)", undefined],
      ["lead-hang", { Lead: [{ prefix: PREFIX.plan, scenario: "hang" }] }, "TIMEOUT", "leadPlan #1 (Lead)", short(i, "Lead")],
      ["worker-fail", { Lead: [leadPlan], Worker: [{ prefix: PREFIX.proposal, scenario: "fail" }] }, "PROVIDER_FAILED", "changeAuthor #1 (Worker)", undefined],
      ["reviewer-fail", { Lead: [leadPlan], Worker: [proposal(FIX)], Reviewer: [{ prefix: PREFIX.review, scenario: "fail" }] },
        "PROVIDER_FAILED", "freshReview #1 (Reviewer)", undefined],
      ["reviewer-hang", { Lead: [leadPlan], Worker: [proposal(FIX)], Reviewer: [{ prefix: PREFIX.review, scenario: "hang" }] },
        "TIMEOUT", "freshReview #1 (Reviewer)", short(i, "Reviewer")],
      ["adjudicator-fail", { Lead: [leadPlan, { prefix: PREFIX.adjudication, scenario: "fail" }], Worker: [proposal(FIX)], Reviewer: [finding()] },
        "PROVIDER_FAILED", "leadAdjudication #1 (Lead)", undefined],
    ];
    for (const [name, scripts, outcome, who, authorization] of cases) {
      const run = asRun(await runRoute(i, dir, name, scripts, authorization ? { authorization } : {}));
      assert.equal(run.report.outcome, outcome, `${name}: ${run.report.detail}`);
      assert.ok(run.report.detail.startsWith(who), `${name}: ${run.report.detail}`);
      const turns = sectionOf<Turn[]>(run, "turns");
      assert.ok(turns.every(t => t.modelProcesses <= 1), name);
      assert.equal(turns.filter(t => t.outcome !== "completed").length, 1, `${name}: exactly the failing turn`);
      assert.deepEqual(sectionOf<{ leftoverOwnedTemporaries: string[] }>(run, "cleanup").leftoverOwnedTemporaries, [], name);
    }
  })));
