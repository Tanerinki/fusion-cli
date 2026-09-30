import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";
import { RunRecorder } from "../src/app/runs.js";
import { CandidateResultStore } from "../src/app/candidate-store.js";
import { runBuildTournament } from "../src/app/tournament/build.js";
import { runTournament } from "../src/app/tournament/run.js";
import { canonicalJson } from "../src/core/delivery/canonical.js";
import type { ChangeSet, DelegationPacket } from "../src/core/domain.js";
import { assembleBuildEvidence } from "../src/core/evidence/build.js";
import { reliabilityPlan } from "../src/core/evidence/policy.js";
import { DiagnosticRedactor } from "../src/core/policy/redaction.js";
import { inspectTask } from "../src/core/policy/task-inspector.js";
import type { CandidateId } from "../src/core/tournament/contracts.js";
import { NO_EXPERIMENTS } from "../src/core/tournament/profile.js";
import { STRATEGY_BRIEFS } from "../src/core/tournament/strategies.js";
import type { WorkflowResult } from "../src/core/workflow/types.js";
import { makeId } from "../src/platform/events/shared.js";
import { changeSet, FAKE_MODEL, FAKE_PROVIDER, scriptedRoles, type Script } from "./fixtures/fake-writer.js";
import { GuestPort } from "./fixtures/guest-port.js";
import { MemoryViews } from "./fixtures/memory-port.js";
import { FIX, gitAvailable, MEDIUM_PACKET, MEDIUM_TASK, withRehearsalRepo, WRONG } from "./fixtures/writer-rehearsal-harness.js";
import { QUOTE_BUGGY, QUOTE_TEST, REHEARSAL_PLAN } from "./fixtures/rehearsal-project.js";

const skip = gitAvailable ? false : "git executable unavailable";
const run = promisify(execFile);
const child = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures", "candidate-store-child.mjs");
const SCOPE = { allowedPaths: MEDIUM_PACKET.scope.allowedFiles, forbiddenPaths: [] };
const TASK = "Fix quote totals: tax applies to the discounted subtotal. Add a regression test.";
const FIXED_LINE = "basisPoints(subtotal - discount, quote.taxBasisPoints)";
const briefOf = (packet: DelegationPacket): CandidateId | undefined =>
  (["c1", "c2", "c3"] as const).find(id => packet.task.constraints.includes(STRATEGY_BRIEFS[id].brief));
const byBrief = (changes: Readonly<Partial<Record<CandidateId, ChangeSet>>>, single: ChangeSet): Script =>
  ({ worker: ({ packet }) => changes[briefOf(packet) ?? "c1"] ?? single });

// ---------------------------------------------------------------- the store, directly

const completed = (content: string): WorkflowResult => ({ state: "completed", transitions: [], delegateAttempts: 1, reviews: [],
  changeSet: changeSet([["src/quote.ts", QUOTE_BUGGY, content]]),
  applied: [{ kind: "update", path: "src/quote.ts", beforeSha256: "a".repeat(64), afterSha256: "b".repeat(64), bytes: content.length }] } as unknown as WorkflowResult);

test("v0.6 I7 store: a completed candidate round-trips; a non-completed one is not persisted", { skip }, async () => withRehearsalRepo(async repo => {
  const store = await CandidateResultStore.open(repo.root, makeId("r"), SCOPE);
  assert.equal(await store.persist("c1", completed("X\n")), true);
  const back = await store.load("c1");
  assert.equal(canonicalJson(back!.changeSet!), canonicalJson(completed("X\n").changeSet!));
  assert.equal(await store.persist("c2", { state: "failed", transitions: [], delegateAttempts: 0, reviews: [] } as unknown as WorkflowResult), false);
  assert.equal(await store.load("c2"), null);
  assert.equal(await store.load("c3"), null);
}));

test("v0.6 I7 store: a torn or tampered entry is ignored (the candidate is re-run, never reused wrongly)", { skip }, async () => withRehearsalRepo(async repo => {
  const runId = makeId("r");
  const store = await CandidateResultStore.open(repo.root, runId, SCOPE);
  await store.persist("c1", completed("X\n"));
  const path = join(repo.root, ".fusion", "durable", runId, "candidates", "c1.json");
  const raw = JSON.parse(await readFile(path, "utf8"));
  raw.result.changeSet.operations[0].content = "TAMPERED\n"; // change bytes, keep the old hash
  await writeFile(path, JSON.stringify(raw));
  assert.equal(await store.load("c1"), null, "a tampered entry no longer matches its hash");
  await writeFile(path, "{ not json");
  assert.equal(await store.load("c1"), null, "a torn entry is ignored");
}));

test("v0.6 I7 store CRASH (two processes): a candidate persisted by a separate process reconstructs from disk", { skip }, async () => withRehearsalRepo(async repo => {
  const runId = makeId("r");
  const out = await run(process.execPath, [child, repo.root, runId, "c1"]).catch((e: unknown) => e as { stdout: string });
  assert.match((out as { stdout: string }).stdout, /PERSISTED:true/u);
  const store = await CandidateResultStore.open(repo.root, runId, { allowedPaths: ["src/x.ts"], forbiddenPaths: [] });
  const back = await store.load("c1");
  assert.ok(back !== null && back.changeSet !== undefined, "the fresh process reconstructs the candidate result");
  assert.match((back!.changeSet!.operations[0] as { content: string }).content, /CHILD_CHANGE/u);
}));

// ---------------------------------------------------------------- reuse inside the real tournament

interface Tourney { outcome: string; selectedChange?: string; enginesRun: CandidateId[] }
async function tourney(repoRoot: string, runId: string, store: CandidateResultStore, engineForbidden: readonly CandidateId[] = []): Promise<Tourney> {
  const port = new GuestPort({ "src/quote.ts": QUOTE_BUGGY, "test/quote.test.ts": QUOTE_TEST }, (command, tree) => {
    const fixed = (tree.get("src/quote.ts") ?? "").includes(FIXED_LINE);
    return command.id === "unit" ? { exit: fixed ? 0 : 1, stdout: fixed ? "pass\n" : "fail\n" } : { exit: 0, stdout: "" };
  });
  port.acceptance = "granted";
  const recorder = await RunRecorder.start(repoRoot, "build", new DiagnosticRedactor(), { task: TASK });
  const profile = { taskClass: "bugFix" as const, sensitive: false };
  const enginesRun: CandidateId[] = [];
  const report = await runTournament({ tournamentId: makeId("t"), candidates: 2, source: "policy",
    request: { runId, task: MEDIUM_TASK, packet: MEDIUM_PACKET, verification: REHEARSAL_PLAN, reproduce: true, timeoutMs: 60_000 },
    contract: { task: TASK, baseCommit: "0".repeat(40), scope: MEDIUM_PACKET.scope.allowedFiles, packetJson: canonicalJson(MEDIUM_PACKET) },
    obligations: reliabilityPlan(profile, inspectTask(MEDIUM_TASK).risk).obligations, falsification: "optional", experiments: NO_EXPERIMENTS }, {
    workspace: port,
    engine: (id, sink) => {
      enginesRun.push(id);
      if (engineForbidden.includes(id)) throw new Error(`candidate ${id} must be reused, not regenerated`);
      return { roles: scriptedRoles(byBrief({ c1: WRONG, c2: FIX }, FIX)).roles, workspace: port, views: new MemoryViews(),
        verifier: { verify: () => { throw new Error("host verifier"); } }, events: sink };
    },
    binding: () => ({ provider: FAKE_PROVIDER, model: FAKE_MODEL }),
    evaluate: (result, plannedCommands) => assembleBuildEvidence({ task: TASK, scope: MEDIUM_PACKET.scope.allowedFiles,
      plan: reliabilityPlan(profile, result.risk!), plannedCommands, result, protectedChanged: [] }),
  }, recorder, { resultStore: store });
  await recorder.finish({ state: "COMPLETED", exitCode: 0, code: "completed", message: "done" });
  const change = report.delivery?.result?.changeSet;
  return { outcome: report.outcome, ...(change ? { selectedChange: canonicalJson(change) } : {}), enginesRun };
}

test("v0.6 I7: a fully-persisted run resumes WITHOUT re-running any candidate, to the identical decision (§13, §16)", { skip }, async () => withRehearsalRepo(async repo => {
  const runId = makeId("r");
  const first = await tourney(repo.root, runId, await CandidateResultStore.open(repo.root, runId, SCOPE));
  assert.equal(first.outcome, "DELIVERY_ELIGIBLE", "the uninterrupted run selects the fix");
  assert.deepEqual(first.enginesRun.sort(), ["c1", "c2"], "both candidates ran the first time");
  // Resume: same store namespace; the engine THROWS if any candidate is regenerated. Both are reused.
  const resumed = await tourney(repo.root, runId, await CandidateResultStore.open(repo.root, runId, SCOPE), ["c1", "c2"]);
  assert.deepEqual(resumed.enginesRun, [], "no candidate's provider turn is re-run on resume");
  assert.equal(resumed.outcome, first.outcome, "the resumed decision is identical to the uninterrupted one");
  assert.equal(resumed.selectedChange, first.selectedChange, "the same change is selected");
}));

test("v0.6 I7: a partial run resumes — the completed candidate is reused, the interrupted one is regenerated (§15)", { skip }, async () => withRehearsalRepo(async repo => {
  const runId = makeId("r");
  const first = await tourney(repo.root, runId, await CandidateResultStore.open(repo.root, runId, SCOPE));
  assert.equal(first.outcome, "DELIVERY_ELIGIBLE");
  // Simulate a crash after c1 completed but before c2's result was durable: drop c2's store entry.
  await rm(join(repo.root, ".fusion", "durable", runId, "candidates", "c2.json"), { force: true });
  // Resume: c1 must be REUSED (engine throws if it runs); c2 is regenerated.
  const resumed = await tourney(repo.root, runId, await CandidateResultStore.open(repo.root, runId, SCOPE), ["c1"]);
  assert.deepEqual(resumed.enginesRun, ["c2"], "only the interrupted candidate is regenerated; c1 is reused");
  assert.equal(resumed.outcome, first.outcome, "the resumed decision matches the uninterrupted one");
}));

// ---------------------------------------------------------------- reuse through the REAL build entry point

/** Drives `runBuildTournament` (the real `fusion build` composition) over the offline candidate port, sharing one store. */
async function buildTourney(repoRoot: string, store: CandidateResultStore): Promise<Readonly<{ outcome: string; workerTurns: number; selectedChange?: string }>> {
  const port = new GuestPort({ "src/quote.ts": QUOTE_BUGGY, "test/quote.test.ts": QUOTE_TEST }, (command, tree) => {
    const fixed = (tree.get("src/quote.ts") ?? "").includes(FIXED_LINE);
    return command.id === "unit" ? { exit: fixed ? 0 : 1, stdout: fixed ? "pass\n" : "fail\n" } : { exit: 0, stdout: "" };
  });
  port.acceptance = "granted";
  const recorder = await RunRecorder.start(repoRoot, "build", new DiagnosticRedactor(), { task: TASK });
  const profile = { taskClass: "bugFix" as const, sensitive: false };
  const scripted = scriptedRoles(byBrief({ c1: WRONG, c2: FIX }, FIX));
  const report = await runBuildTournament({ tournamentId: makeId("t"), recorder, roles: scripted.roles, workspace: port,
    views: new MemoryViews(), verifier: { verify: () => { throw new Error("host verifier"); } },
    route: { route: "tournament", candidates: 2, eligible: true, source: "policy", reasons: [] },
    request: { runId: recorder.runId, task: MEDIUM_TASK, packet: MEDIUM_PACKET, verification: REHEARSAL_PLAN, reproduce: true, timeoutMs: 60_000 },
    contract: { task: TASK, baseCommit: "0".repeat(40), scope: MEDIUM_PACKET.scope.allowedFiles, packetJson: canonicalJson(MEDIUM_PACKET) },
    reliability: reliabilityPlan(profile, inspectTask(MEDIUM_TASK).risk), experiments: NO_EXPERIMENTS,
    evaluate: async (result, plannedCommands) => assembleBuildEvidence({ task: TASK, scope: MEDIUM_PACKET.scope.allowedFiles,
      plan: reliabilityPlan(profile, result.risk!), plannedCommands, result, protectedChanged: [] }),
    resultStore: store });
  await recorder.finish({ state: "COMPLETED", exitCode: 0, code: "completed", message: "done" });
  const change = report.delivery?.result?.changeSet;
  return { outcome: report.outcome, workerTurns: scripted.spy.proposals.length + scripted.spy.plans.length + scripted.spy.reviews.length,
    ...(change ? { selectedChange: canonicalJson(change) } : {}) };
}

test("v0.6 I7: the REAL build entry point (runBuildTournament) reuses persisted candidates on resume, to the identical decision", { skip }, async () =>
  withRehearsalRepo(async repo => {
    // One store instance stands in for the run's durable store re-adopted on resume (the real path opens it by run id).
    const store = await CandidateResultStore.open(repo.root, makeId("r"), SCOPE);
    const first = await buildTourney(repo.root, store);
    assert.equal(first.outcome, "DELIVERY_ELIGIBLE", "the uninterrupted real build selects the fix");
    assert.ok(first.workerTurns > 0, "the first real build runs its candidates' authors");
    const resumed = await buildTourney(repo.root, store);
    assert.equal(resumed.workerTurns, 0, "on resume no candidate author runs — every candidate is reused from the durable store");
    assert.equal(resumed.outcome, first.outcome, "the resumed real build reaches the identical decision");
    assert.equal(resumed.selectedChange, first.selectedChange, "the same change is selected");
  }));
