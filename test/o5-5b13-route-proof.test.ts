import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { AdapterFactory } from "../src/app/providers.js";
import { routeFixtureIdentity, routeLedger } from "../src/app/route-probe.js";
import { REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport } from "../src/app/writer-gate.js";
import { withRoot } from "./fixtures/probe-harness.js";
import { withInstalls } from "./fixtures/provider-installs.js";
import { adjudication, asRun, cleanReview, LEAD_SECRET, plan, PREFIX, proposal, reviewWith, routeRegistry, runRoute, sectionOf,
  testRouteAuthorization, TEST_ROUTE, WORKER_SECRET } from "./fixtures/route-harness.js";
import { FIX, FIX_ONLY, gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5B13 — what the live proof relies on, offline with the REAL adapter code against scripted fake binaries: per-turn
 * claim identities and contract outcomes, unused slots, the model-process identity guard, role substitution at
 * composition, and one-shot claims. Never a provider; every run is `offlineRehearsal`.
 */
const skip = gitAvailable ? false : "git executable unavailable";
type Turn = { claim: string; turn: string; slot: number; role: string; contract: string; outcome: string; sessionId: string | null };
type Launch = { purpose: string; turn: string; args: string[]; identityGaps?: string[]; posture?: { missing: string[]; widening: string[] } };
const leadPlan = { prefix: PREFIX.plan, output: plan() };

test("O5.5B13 straight path: three slots consumed, four unused; every model process carries exactly its role's model, effort and turn limit", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    const run = asRun(await runRoute(i, dir, "straight", { Lead: [leadPlan], Worker: [proposal(FIX)],
      Reviewer: [{ prefix: PREFIX.review, output: cleanReview, excludes: [LEAD_SECRET, WORKER_SECRET] }] }));
    assert.equal(run.report.outcome, "PASS", run.report.detail);
    assert.deepEqual(sectionOf<Record<string, number>>(run, "unusedSlots"), { leadPlan: 0, changeAuthor: 1, freshReview: 1, leadAdjudication: 2 });
    assert.match(sectionOf<string>(run, "runId"), /^test-route-[0-9a-f]{12}$/u);
    assert.deepEqual(sectionOf<{ sha256: string; pinned: string }>(run, "fixture"), { sha256: routeFixtureIdentity(), pinned: routeFixtureIdentity() });
    const turns = sectionOf<Turn[]>(run, "turns");
    assert.deepEqual(turns.map(t => [t.claim, t.role, t.outcome, t.contract]), [
      [`${TEST_ROUTE}:leadPlan#1`, "Lead", "completed", "accepted"],
      [`${TEST_ROUTE}:changeAuthor#1`, "Worker", "completed", "validated"],
      [`${TEST_ROUTE}:freshReview#1`, "Reviewer", "completed", "accepted:0 finding(s)"]]);
    assert.equal(new Set(turns.map(t => t.sessionId)).size, 3, "a fresh session per turn");
    // The identity pairs are checked before each model process starts and recorded after it.
    const models = sectionOf<Launch[]>(run, "launches").filter(l => l.purpose === "providerTurn");
    assert.deepEqual(models.map(l => [l.turn, l.identityGaps, l.posture]), [["leadPlan#1", [], { missing: [], widening: [] }],
      ["changeAuthor#1", [], { missing: [], widening: [] }], ["freshReview#1", [], { missing: [], widening: [] }]]);
    const pairOf = (args: string[], flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
    assert.deepEqual(models.map(l => [pairOf(l.args, "--model"), pairOf(l.args, "--effort") ?? pairOf(l.args, "--reasoning-effort")]),
      [["haiku", "low"], ["haiku", "low"], ["muse-spark-1.3", "low"]]);
    assert.ok(models.every(l => !l.args.some(arg => arg.startsWith("--fallback-model"))));
    // Workspaces and cleanup: primary and views unchanged, nothing left behind.
    assert.equal(sectionOf<{ unchanged: boolean }>(run, "primary").unchanged, true);
    assert.ok(sectionOf<Array<{ unchanged: boolean }>>(run, "views").every(v => v.unchanged));
    assert.deepEqual(sectionOf<{ leftoverOwnedTemporaries: string[] }>(run, "cleanup").leftoverOwnedTemporaries, []);
    // Redaction: no prompt, reply, hidden reasoning, canary or fence is persisted.
    const text = await readFile(run.report.evidencePath, "utf8");
    for (const secret of [LEAD_SECRET, WORKER_SECRET, "```", PREFIX.plan, PREFIX.proposal, PREFIX.review, "synthetic-not-a-secret-7a31",
      "synthetic protected route canary", "No defect found."])
      assert.ok(!text.includes(secret), `evidence leaks ${secret}`);
    // One-shot: the claimed namespace refuses a second run, and the rehearsal moves no live row or gate.
    const again = await runRoute(i, dir, "straight", { Lead: [leadPlan] });
    assert.equal("refused" in again && again.reason, "alreadyAttempted");
    assert.deepEqual((await routeLedger(run.root)).map(entry => `${String(entry.turn)}#${String(entry.slot)}`), ["leadPlan#1", "changeAuthor#1", "freshReview#1"]);
    assert.deepEqual([REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport().realWriterModeReady], [false, false]);
  })));

test("O5.5B13 correction path: the second Change Author slot only after the engine's own confirmed-finding retry; a contract per slot", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    const run = asRun(await runRoute(i, dir, "correction", {
      Lead: [leadPlan, { prefix: PREFIX.adjudication, output: adjudication(["r1-F1", "CONFIRMED", "fix"]) }],
      Worker: [proposal(FIX_ONLY), proposal(FIX)],
      Reviewer: [{ prefix: PREFIX.review, output: reviewWith({ id: "F1", severity: "HIGH" }) }, { prefix: PREFIX.review, output: cleanReview }],
    }));
    assert.equal(run.report.outcome, "PASS", run.report.detail);
    assert.deepEqual(sectionOf<Turn[]>(run, "turns").map(t => [t.claim.replace(`${TEST_ROUTE}:`, ""), t.contract]), [
      ["leadPlan#1", "accepted"], ["changeAuthor#1", "validated"], ["freshReview#1", "accepted:1 finding(s)"],
      ["leadAdjudication#1", "accepted:1 verdict(s)"], ["changeAuthor#2", "validated"], ["freshReview#2", "accepted:0 finding(s)"]]);
    assert.deepEqual(sectionOf<{ retries: string[] }>(run, "route").retries, ["reviewFindingsConfirmed"]);
    assert.deepEqual(sectionOf<Record<string, number>>(run, "unusedSlots"), { leadPlan: 0, changeAuthor: 0, freshReview: 0, leadAdjudication: 1 });
    assert.ok(sectionOf<Launch[]>(run, "launches").filter(l => l.purpose === "providerTurn").every(l => l.identityGaps?.length === 0));
  })));

test("O5.5B13 identity guard: a model process without exactly the authorized effort or model is MODEL_BLOCKED before it starts; the slot is consumed", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    // The binding passes preflight; only the per-process identity differs, so the guard itself must stop the turn.
    const effort = testRouteAuthorization(i, {}, { Worker: { turnArgs: [["--model", "haiku"], ["--effort", "medium"], ["--max-turns", "6"]] } });
    const worker = asRun(await runRoute(i, dir, "effort", { Lead: [leadPlan], Worker: [proposal(FIX)] }, { authorization: effort }));
    assert.deepEqual([worker.report.outcome, worker.report.detail], ["MODEL_BLOCKED", "a provider process was refused before it started: "
      + "the changeAuthor model process does not carry exactly the authorized --effort medium"]);
    assert.deepEqual(sectionOf<Record<string, number>>(worker, "turnUse"), { leadPlan: 1, changeAuthor: 1, freshReview: 0, leadAdjudication: 0 });
    assert.equal(worker.prompts.Worker.length, 0, "the Change Author's model process never started");
    assert.deepEqual(sectionOf<Turn[]>(worker, "turns").map(t => t.contract), ["accepted", "notReached:failed"]);
    const model = testRouteAuthorization(i, {}, { Reviewer: { turnArgs: [["--model", "muse-spark-1.4"], ["--reasoning-effort", "low"], ["--max-model-steps", "4"]] } });
    const reviewer = asRun(await runRoute(i, dir, "model", { Lead: [leadPlan], Worker: [proposal(FIX)], Reviewer: [{ prefix: PREFIX.review, output: cleanReview }] },
      { authorization: model }));
    assert.equal(reviewer.report.outcome, "MODEL_BLOCKED", reviewer.report.detail);
    assert.match(reviewer.report.detail, /the freshReview model process does not carry exactly the authorized --model muse-spark-1\.4$/u);
    assert.equal(reviewer.prompts.Reviewer.length, 0);
    assert.deepEqual(sectionOf<Record<string, number>>(reviewer, "unusedSlots"), { leadPlan: 0, changeAuthor: 1, freshReview: 1, leadAdjudication: 2 });
  })));

test("O5.5B13 composition: a route role served by another adapter kind than its authorized one is refused before the claim", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    const scripts = { Lead: "x", Worker: "x", Reviewer: "x" };
    const real = routeRegistry(i, scripts);
    const claude = real.factories.get("claude-one-shot")!, muse = real.factories.get("muse-exec")!;
    // The Lead's factory quietly builds the other family's adapter.
    const swapped: AdapterFactory = { ...claude, create: async (binding, context) => binding.role === "Lead"
      ? muse.create({ ...binding, adapter: "muse-exec", model: "muse-spark-1.3", options: { provider: "meta", maxModelSteps: 4, malformedOutputRetries: 0 } }, context)
      : claude.create(binding, context) };
    const registry = { ...real, factories: new Map([["claude-one-shot", swapped], ["muse-exec", muse]]) };
    const run = asRun(await runRoute(i, dir, "swap", { Lead: [leadPlan] }, { deps: { registry } }));
    assert.deepEqual([run.report.outcome, run.report.detail, run.report.evidence.stage, run.report.modelTurns],
      ["POSTURE_BLOCKED", "a route role is served by another adapter than its authorized one (Lead)", "preflight", 0]);
    assert.equal(existsSync(join(run.root, "route.claim.json")), false, "nothing consumed");
    assert.equal(existsSync(join(run.root, "route.turns.jsonl")), false);
  })));
