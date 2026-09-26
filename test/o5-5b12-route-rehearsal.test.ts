import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { routeLedger } from "../src/app/route-probe.js";
import { REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport } from "../src/app/writer-gate.js";
import { changeProposalLiveRecords } from "../src/runtime/provider-profiles.js";
import { withRoot } from "./fixtures/probe-harness.js";
import { withInstalls } from "./fixtures/provider-installs.js";
import { adjudication, asRun, cleanReview, LEAD_SECRET, plan, PREFIX, proposal, reviewWith, runRoute, sectionOf, WORKER_SECRET } from "./fixtures/route-harness.js";
import { FIX, FIX_ONLY, gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5B12 — the full-route rehearsal, offline: the REAL Claude (Lead, Change Author) and Muse (fresh Reviewer) adapter code
 * against scripted fake native binaries, the real engine, candidate port, views and Docker backend (in-memory daemon, npm
 * lane). Success paths, freshness and workspaces; failures are in o5-5b12-route-failures.test.ts.
 */
const skip = gitAvailable ? false : "git executable unavailable";
type Turn = { turn: string; slot: number; role: string; outcome: string; sessionId: string | null; viewKinds: string[];
  modelProcesses: number; processes: Record<string, number>; observedModel: string | null; structuredOutput: { classification?: string } | null };

test("O5.5B12 A: straight-through — Lead plan, Change Author, host application, confined verification, fresh Reviewer; PASS (rehearsal)", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    const run = asRun(await runRoute(i, dir, "a", {
      Lead: [{ prefix: PREFIX.plan, output: plan() }],
      Worker: [proposal(FIX)],
      Reviewer: [{ prefix: PREFIX.review, output: cleanReview, excludes: [LEAD_SECRET, WORKER_SECRET] }],
    }));
    const { report } = run;
    assert.equal(report.outcome, "PASS", `${report.detail} ${JSON.stringify(report.evidence.workflow)}`);
    assert.deepEqual([report.evidence.evidenceKind, report.evidence.kind], ["offlineRehearsal", "fullRouteRehearsal"]);
    // Exactly three model turns: the straight-through budget. No adjudication without findings.
    assert.deepEqual(sectionOf<Record<string, number>>(run, "turnUse"), { leadPlan: 1, changeAuthor: 1, freshReview: 1, leadAdjudication: 0 });
    assert.equal(report.modelTurns, 3);
    // Process purposes, separately: per one-shot turn 2 auth readbacks, 1 inventory, 2 init-only startups, 1 model turn;
    // per exec turn 1 account-attestation host, 1 model turn. Only `providerTurn` is a model turn.
    assert.deepEqual(sectionOf<Record<string, number>>(run, "launchCounts"),
      { providerAuthReadback: 4, providerInventory: 2, providerInitProbe: 4, providerTurn: 3, providerHost: 1 });
    const turns = sectionOf<Turn[]>(run, "turns");
    assert.deepEqual(turns.map(t => [t.turn, t.slot, t.role, t.outcome, t.modelProcesses, t.viewKinds.join(",")]), [
      ["leadPlan", 1, "Lead", "completed", 1, "baseline"], ["changeAuthor", 1, "Worker", "completed", 1, "baseline"],
      ["freshReview", 1, "Reviewer", "completed", 1, "candidate"]]);
    assert.deepEqual(turns.map(t => t.observedModel), ["claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001", "muse-spark-1.3"]);
    assert.equal(turns[1]!.structuredOutput?.classification, "SINGLE_FENCED_VALID_JSON");
    assert.equal(new Set(turns.map(t => t.sessionId)).size, 3, "a fresh session per role turn");
    // Freshness: the Reviewer's prompt holds neither the Lead's reasoning nor the Worker's transcript (the fake would
    // have failed the turn; the logged prompt proves it too).
    for (const prompt of run.prompts.Reviewer) for (const secret of [LEAD_SECRET, WORKER_SECRET]) assert.ok(!prompt.includes(secret), secret);
    assert.ok(run.prompts.Worker[0]!.includes(LEAD_SECRET), "the Lead's plan is delegated to the Change Author, as designed");
    assert.ok(run.prompts.Reviewer[0]!.includes("a full discount leaves nothing to tax"), "the Reviewer sees the real candidate diff");
    // Mechanical facts: verification in the confined backend (rehearsal label), candidate and views released, primary unchanged.
    assert.deepEqual(sectionOf<{ changedPaths: string[] }>(run, "candidates").changedPaths, ["src/quote.ts", "test/quote.test.ts"]);
    assert.deepEqual(sectionOf<{ events: Array<{ passed: boolean; acceptance: string }> }>(run, "verification").events.map(e => [e.passed, e.acceptance]),
      [[true, "offlineRehearsal"]]);
    assert.deepEqual(sectionOf<{ unchanged: boolean; canariesUnchanged: boolean }>(run, "primary"), { ...sectionOf<object>(run, "primary"), unchanged: true, canariesUnchanged: true });
    assert.ok(sectionOf<Array<{ unchanged: boolean }>>(run, "views").every(v => v.unchanged));
    assert.deepEqual(sectionOf<{ leftoverOwnedTemporaries: string[] }>(run, "cleanup").leftoverOwnedTemporaries, []);
    assert.equal(sectionOf<{ freshReview: boolean }>(run, "route").freshReview, true);
    // Every model process carried its family's read-only controls and no widening flag; each ran in its turn's view kind.
    const modelLaunches = sectionOf<Array<{ purpose: string; turn: string; cwdClass: string; posture?: { missing: string[]; widening: string[] } }>>(run, "launches")
      .filter(l => l.purpose === "providerTurn");
    assert.deepEqual(modelLaunches.map(l => [l.turn, l.cwdClass, l.posture]), [["leadPlan#1", "providerView:baseline", { missing: [], widening: [] }],
      ["changeAuthor#1", "providerView:baseline", { missing: [], widening: [] }], ["freshReview#1", "providerView:candidate", { missing: [], widening: [] }]]);
    assert.ok(sectionOf<Array<{ cwdClass: string }>>(run, "launches").every(l => l.cwdClass.startsWith("providerView:") || l.cwdClass === "ownedTemporary"),
      "no process of any role ever ran in the primary");
    // The durable turn ledger: one line per consumed slot, written before the provider was reached.
    assert.deepEqual((await routeLedger(run.root)).map(entry => `${String(entry.turn)}#${String(entry.slot)}`),
      ["leadPlan#1", "changeAuthor#1", "freshReview#1"]);
    // Redaction: no reply, prompt, secret or canary is persisted.
    const text = await readFile(report.evidencePath, "utf8");
    for (const secret of [LEAD_SECRET, WORKER_SECRET, "```", PREFIX.review, PREFIX.adjudication, "synthetic-not-a-secret-7a31", "synthetic protected route canary"])
      assert.ok(!text.includes(secret), `evidence leaks ${secret}`);
    // A rehearsal is never live evidence and opens nothing.
    assert.equal(changeProposalLiveRecords("claude", "claude-one-shot").some(record => record.milestone === "TEST"), false);
    assert.deepEqual([REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport().realWriterModeReady], [false, false]);
  })));

test("O5.5B12 B: a reviewer finding the Lead rejects does not block — one adjudication, no correction", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    const run = asRun(await runRoute(i, dir, "b", {
      Lead: [{ prefix: PREFIX.plan, output: plan() },
        { prefix: PREFIX.adjudication, output: adjudication(["r1-F1", "REJECTED", "none"]), excludes: [LEAD_SECRET, WORKER_SECRET] }],
      Worker: [proposal(FIX)],
      Reviewer: [{ prefix: PREFIX.review, output: reviewWith({ id: "F1", severity: "HIGH" }), excludes: [LEAD_SECRET, WORKER_SECRET] }],
    }));
    assert.equal(run.report.outcome, "PASS", run.report.detail);
    assert.deepEqual(sectionOf<Record<string, number>>(run, "turnUse"), { leadPlan: 1, changeAuthor: 1, freshReview: 1, leadAdjudication: 1 });
    assert.deepEqual(sectionOf<{ adjudications: Array<{ verdict: string }> }>(run, "review").adjudications.map(a => a.verdict), ["REJECTED"]);
    assert.equal(sectionOf<{ corrections: number }>(run, "route").corrections, 0);
    // The adjudicating Lead is a fresh session in the candidate view, without its own plan's reasoning.
    const turns = sectionOf<Turn[]>(run, "turns");
    assert.deepEqual(turns.at(-1)!.viewKinds, ["candidate"]);
    assert.notEqual(turns[0]!.sessionId, turns.at(-1)!.sessionId);
    for (const prompt of run.prompts.Lead.slice(1)) assert.ok(!prompt.includes(LEAD_SECRET) && !prompt.includes(WORKER_SECRET));
  })));

test("O5.5B12 C: a confirmed finding gets exactly one correction — fresh candidate, verified again, freshly re-reviewed; PASS", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    const run = asRun(await runRoute(i, dir, "c", {
      Lead: [{ prefix: PREFIX.plan, output: plan() }, { prefix: PREFIX.adjudication, output: adjudication(["r1-F1", "CONFIRMED", "fix"]) }],
      Worker: [proposal(FIX_ONLY), { ...proposal(FIX), excludes: [WORKER_SECRET] }],
      Reviewer: [{ prefix: PREFIX.review, output: reviewWith({ id: "F1", severity: "HIGH" }) },
        { prefix: PREFIX.review, output: cleanReview, excludes: [WORKER_SECRET, LEAD_SECRET] }],
    }));
    assert.equal(run.report.outcome, "PASS", `${run.report.detail} ${JSON.stringify(run.report.evidence.workflow)}`);
    assert.deepEqual(sectionOf<Record<string, number>>(run, "turnUse"), { leadPlan: 1, changeAuthor: 2, freshReview: 2, leadAdjudication: 1 });
    assert.equal(sectionOf<{ corrections: number }>(run, "route").corrections, 1);
    assert.deepEqual(sectionOf<{ retries: string[] }>(run, "route").retries, ["reviewFindingsConfirmed"]);
    const turns = sectionOf<Turn[]>(run, "turns");
    const reviews = turns.filter(t => t.turn === "freshReview");
    assert.notEqual(reviews[0]!.sessionId, reviews[1]!.sessionId, "the re-review is a fresh session");
    // The correction is told only the approved finding; the second review sees the prior finding and the new diff.
    assert.ok(run.prompts.Worker[1]!.includes("no regression test for a full discount"));
    assert.ok(!run.prompts.Worker[1]!.includes(WORKER_SECRET), "the Change Author's own earlier transcript is never replayed");
    assert.ok(run.prompts.Reviewer[1]!.includes("a full discount leaves nothing to tax"));
    assert.deepEqual(sectionOf<{ created: number; released: number }>(run, "candidates"), { ...sectionOf<object>(run, "candidates"), created: 2, released: 2 });
    assert.deepEqual(sectionOf<{ events: Array<{ passed: boolean }> }>(run, "verification").events.map(e => e.passed), [true, true]);
    assert.deepEqual((await routeLedger(run.root)).map(entry => `${String(entry.turn)}#${String(entry.slot)}`),
      ["leadPlan#1", "changeAuthor#1", "freshReview#1", "leadAdjudication#1", "changeAuthor#2", "freshReview#2"]);
  })));
