import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RunRecorder, summarizeRun, type RunSummary } from "../src/app/runs.js";
import type { BuildEvidence } from "../src/core/evidence/build.js";
import { DiagnosticRedactor } from "../src/core/policy/redaction.js";
import type { CandidateId } from "../src/core/tournament/contracts.js";
import type { WorkflowEvent } from "../src/core/workflow/types.js";
import { EventStore } from "../src/platform/events/event-store.js";
import { makeId, StorageError } from "../src/platform/events/shared.js";
import type { EventScope, TournamentDecidedRecord } from "../src/platform/events/types.js";

const REDACTOR = new DiagnosticRedactor();
const REV: Readonly<Record<"c1" | "c2", string>> = { c1: "1".repeat(64), c2: "2".repeat(64) };
const MANIFEST = "9".repeat(64);

function evidence(decision: "VERIFIED" | "UNVERIFIED" | "BLOCKED", deliverable: boolean, taskClass: "bugFix" | "change" = "bugFix"): BuildEvidence {
  const status = decision === "BLOCKED" ? "FAIL" : "PASS";
  return { plan: { profile: { taskClass, sensitive: false }, reproduce: true, freshReview: false, objective: "review", strict: false, obligations: [] },
    graph: { format: "fusion.evidenceGraph", version: 1, claims: [], evidence: [], overflowed: false },
    decision: { decision, deliverable, overflowed: false, obligations: [{ kind: "verificationPassed", tier: "safety", status, reason: "host-observed" }] },
  } as unknown as BuildEvidence;
}
async function withDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "fusion-v05-binding-"));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const transition = (from: string, to: string, reason: string): WorkflowEvent => ({ type: "transition", transition: { from, to, reason } } as WorkflowEvent);

/**
 * One tournament's events, as two concurrent candidates produce them: each candidate's own steps in its own order, merged in
 * `pattern` ("a" = c1's next step, "b" = c2's). c1 is selected and revalidated; c2 is BLOCKED — and c2's evidence decision
 * and final transition can come LAST in the log.
 */
async function tournamentLog(dir: string, pattern: readonly ("a" | "b")[], bind: (ids: Readonly<Record<string, string>>) => Partial<TournamentDecidedRecord> = () => ({}),
  decisions = 1): Promise<Readonly<{ runId: string; ids: Readonly<Record<string, string>> }>> {
  const recorder = await RunRecorder.start(dir, "build", REDACTOR, { task: "Fix the rounding of totals." });
  const tid = makeId("t");
  const ids: Record<string, string> = {};
  await recorder.recordTournamentStart(tid, { policyVersion: "v0.5-route-1", candidates: 2, source: "policy", independence: "separateContext",
    profileSha256: "a".repeat(64), contractSha256: "b".repeat(64), snapshotSha256: "c".repeat(64), reproduced: true });
  const scope = (candidate: CandidateId): EventScope => ({ tournamentId: tid, candidate });
  const steps = (candidate: "c1" | "c2"): Array<() => Promise<void>> => {
    const sink = recorder.sink(scope(candidate));
    const ok = candidate === "c1";
    return [
      () => sink.append(transition("received", "inspected", "taskInspected")),
      () => sink.append({ type: "finding", cycle: 1, finding: { id: "r1-F1", severity: ok ? "LOW" : "HIGH", confidence: "HIGH", category: "correctness",
        title: ok ? "c1 minor naming" : "c2 drops the discount" } } as unknown as WorkflowEvent),
      () => sink.append({ type: "adjudication", cycle: 1, record: { finding: { id: "r1-F1", severity: ok ? "LOW" : "HIGH" }, verdict: ok ? "REJECTED" : "CONFIRMED",
        rationale: "checked", requiredAction: ok ? "none" : "fix", verdictSource: "lead", supportedFacts: [] } } as unknown as WorkflowEvent),
      () => sink.append(transition("verifying", ok ? "completed" : "failed", ok ? "succeeded" : "verificationFailed")),
      async () => {
        ids[`${candidate}:candidate`] = await recorder.recordEvidence(evidence(ok ? "VERIFIED" : "BLOCKED", ok), { ...scope(candidate), revision: REV[candidate], stage: "candidate" });
        await recorder.recordTournamentCandidate({ tournamentId: tid, candidate, revision: REV[candidate] }, { state: ok ? "verified" : "rejected",
          decision: ok ? "VERIFIED" : "BLOCKED", deliverable: ok, profileComplete: true, contradictions: 0, mutationsRun: 0, mutationsSurvived: 0,
          evidenceDecisionId: ids[`${candidate}:candidate`]! });
      },
    ];
  };
  const a = steps("c1"), b = steps("c2");
  for (const next of pattern) await (next === "a" ? a : b).shift()!();
  for (const rest of [...a, ...b]) await rest();
  // The selected candidate's fresh revalidation decision — deliberately not the last evidence decision in the log.
  ids["c1:revalidation"] = await recorder.recordEvidence(evidence("VERIFIED", true), { ...scope("c1"), revision: REV.c1, stage: "revalidation" });
  ids["c2:late"] = await recorder.recordEvidence(evidence("BLOCKED", false, "change"), { ...scope("c2"), revision: REV.c2, stage: "candidate" });
  await recorder.sink(scope("c2")).append(transition("failed", "failed", "verificationFailed"));
  for (let i = 0; i < decisions; i++)
    await recorder.recordTournamentDecision(tid, { outcome: "DELIVERY_ELIGIBLE", selected: "c1", selectedRevision: REV.c1, chosenBy: "fusion",
      evidenceDecisionId: ids["c1:revalidation"]!, manifestSha256: MANIFEST, ...bind(ids) }, { format: "fusion.tournament" });
  await recorder.finish({ state: "COMPLETED", exitCode: 0, code: "completed", message: "done" });
  return { runId: recorder.runId, ids };
}
const summarize = (dir: string, runId: string): Promise<RunSummary> => summarizeRun(dir, runId, REDACTOR);

test("v0.5 binding: the selected candidate's decision resolves through the explicit binding, however the candidates' events interleave", () =>
  withDir(async root => {
    const patterns: ReadonlyArray<readonly ("a" | "b")[]> = [
      ["a", "a", "a", "a", "a", "b", "b", "b", "b", "b"], // c1 entirely first, c2 last
      ["b", "b", "b", "b", "b", "a", "a", "a", "a", "a"], // c2 entirely first
      ["a", "b", "a", "b", "a", "b", "a", "b", "a", "b"], // alternating
      ["b", "a", "b", "a", "b", "a", "b", "a", "b", "a"], // alternating, c2 leading
      ["a", "b", "b", "a", "b", "a", "a", "b", "b", "a"], // irregular
    ];
    for (const [index, pattern] of patterns.entries()) {
      const dir = join(root, `order-${index}`);
      await (await import("node:fs/promises")).mkdir(dir);
      const { runId } = await tournamentLog(dir, pattern);
      const summary = await summarize(dir, runId);
      assert.equal(summary.tournament?.resolved, true, `order ${index}: ${summary.tournament?.reason}`);
      assert.deepEqual([summary.tournament?.selected, summary.tournament?.revision, summary.tournament?.outcome], ["c1", REV.c1, "DELIVERY_ELIGIBLE"]);
      assert.equal(summary.evidence?.decision, "VERIFIED", `order ${index}: the selected candidate's decision, not the last one`);
      assert.equal(summary.evidence?.deliverable, true);
      assert.equal(summary.evidence?.taskClass, "bugFix", `order ${index}: never c2's later decision`);
      assert.equal(summary.finalWorkflowState, "completed", `order ${index}: the selected candidate's final state, not the last transition`);
      // The same finding id in two candidates' reviews is two findings, each with its own adjudication.
      const findings = [...summary.findings].sort((x, y) => (x.candidate ?? "").localeCompare(y.candidate ?? ""));
      assert.deepEqual(findings.map(f => [f.candidate, f.id, f.verdict]), [["c1", "r1-F1", "REJECTED"], ["c2", "r1-F1", "CONFIRMED"]], `order ${index}`);
    }
  }));

test("v0.5 binding: a binding that does not hold is unresolved — no evidence is shown, never a fallback to the last decision", () =>
  withDir(async root => {
    const cases: Array<[string, (ids: Readonly<Record<string, string>>) => Partial<TournamentDecidedRecord>, number, RegExp]> = [
      ["another candidate's decision", ids => ({ evidenceDecisionId: ids["c2:candidate"]! }), 1, /not the selected candidate's revalidation/u],
      ["the candidate-stage decision", ids => ({ evidenceDecisionId: ids["c1:candidate"]! }), 1, /not the selected candidate's revalidation/u],
      ["another revision", () => ({ selectedRevision: "3".repeat(64) }), 1, /not the selected candidate's revalidation/u],
      ["an unknown decision", () => ({ evidenceDecisionId: makeId("e") }), 1, /not in the run's events/u],
      ["an undeliverable decision called eligible", ids => ({ selected: "c2", selectedRevision: REV.c2, evidenceDecisionId: ids["c2:late"]! }), 1,
        /not the selected candidate's revalidation|disagree/u],
      ["two decisions", () => ({}), 2, /more than one decision/u],
      ["no decision", () => ({}), 0, /no decision/u],
    ];
    for (const [index, [what, bind, decisions, reason]] of cases.entries()) {
      const dir = join(root, `case-${index}`);
      await (await import("node:fs/promises")).mkdir(dir);
      const { runId } = await tournamentLog(dir, ["a", "b", "a", "b", "a", "b", "a", "b", "a", "b"], bind, decisions);
      const summary = await summarize(dir, runId);
      assert.equal(summary.tournament?.resolved, false, what);
      assert.match(summary.tournament?.reason ?? "", reason, what);
      assert.equal(summary.evidence, undefined, `${what}: no evidence is shown`);
      assert.equal(summary.finalWorkflowState, undefined, `${what}: no final state is guessed`);
    }
  }));

test("v0.5 binding: a v0.4 run without scopes keeps its v0.4 summary (the last decision and transition)", () =>
  withDir(async dir => {
    const recorder = await RunRecorder.start(dir, "build", REDACTOR, { task: "Fix it." });
    const sink = recorder.sink();
    await sink.append(transition("received", "inspected", "taskInspected"));
    await recorder.recordEvidence(evidence("BLOCKED", false));
    await sink.append(transition("verifying", "completed", "succeeded"));
    await recorder.recordEvidence(evidence("VERIFIED", true, "change"));
    await recorder.finish({ state: "COMPLETED", exitCode: 0, code: "completed", message: "done" });
    const summary = await summarize(dir, recorder.runId);
    assert.equal(summary.tournament, undefined);
    assert.equal(summary.evidence?.decision, "VERIFIED");
    assert.equal(summary.evidence?.taskClass, "change");
    assert.equal(summary.finalWorkflowState, "completed");
  }));

test("v0.5 binding: scopes are strict — a tournament event needs one, each type takes only its shape, and a tampered scope is refused on read", () =>
  withDir(async dir => {
    const recorder = await RunRecorder.start(dir, "build", REDACTOR, { task: "Fix it." });
    const tid = makeId("t");
    const events = recorder.events;
    const refused = async (what: string, input: unknown) =>
      assert.rejects(events.append(input as Parameters<EventStore["append"]>[0]), (e: unknown) => e instanceof StorageError, what);
    const decided = { outcome: "NO_VERIFIED_CANDIDATE", manifestSha256: MANIFEST };
    await refused("a tournament decision without scope", { type: "TournamentDecided", source: "policy", payload: decided });
    await refused("a decision scoped to a candidate", { type: "TournamentDecided", source: "policy", scope: { tournamentId: tid, candidate: "c1" }, payload: decided });
    await refused("an unknown candidate", { type: "WorkflowTransition", source: "runtime", scope: { tournamentId: tid, candidate: "c9" },
      payload: { from: "received", to: "inspected", reason: "taskInspected" } });
    await refused("a revision on a workflow event", { type: "WorkflowTransition", source: "runtime", scope: { tournamentId: tid, candidate: "c1", revision: REV.c1 },
      payload: { from: "received", to: "inspected", reason: "taskInspected" } });
    await refused("an evidence decision scoped to a candidate without its revision", { type: "EvidenceDecisionRecorded", source: "policy",
      scope: { tournamentId: tid, candidate: "c1" }, payload: { decision: "VERIFIED", deliverable: true, taskClass: "bugFix", sensitive: false,
        obligations: [], claims: 0, evidence: 0, overflowed: false } });
    await refused("an unknown scope key", { type: "WorkflowTransition", source: "runtime", scope: { tournamentId: tid, winner: "c1" },
      payload: { from: "received", to: "inspected", reason: "taskInspected" } });
    await refused("a candidate evaluation without its revision", { type: "TournamentCandidateEvaluated", source: "policy", scope: { tournamentId: tid, candidate: "c1" },
      payload: { state: "verified", deliverable: true, profileComplete: true, contradictions: 0, mutationsRun: 0, mutationsSurvived: 0 } });
    await refused("an eligible decision without a selection binding", { type: "TournamentDecided", source: "policy", scope: { tournamentId: tid },
      payload: { outcome: "DELIVERY_ELIGIBLE", selected: "c1", manifestSha256: MANIFEST } });

    await recorder.sink({ tournamentId: tid, candidate: "c1" }).append(transition("received", "inspected", "taskInspected"));
    const log = join(recorder.store.directory, "events.jsonl");
    const lines = (await readFile(log, "utf8")).trimEnd().split("\n");
    const last = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
    assert.deepEqual(last.scope, { tournamentId: tid, candidate: "c1" });
    for (const tampered of [{ tournamentId: tid, candidate: "c2", extra: true }, { tournamentId: "t-bad", candidate: "c1" }, { tournamentId: tid, candidate: "c4" }]) {
      await writeFile(log, `${[...lines.slice(0, -1), JSON.stringify({ ...last, scope: tampered })].join("\n")}\n`);
      await assert.rejects((async () => { for await (const _ of EventStore.read(recorder.store.directory, recorder.runId)) { /* drain */ } })(),
        (e: unknown) => e instanceof StorageError && e.kind === "CorruptEventLog");
    }
  }));
