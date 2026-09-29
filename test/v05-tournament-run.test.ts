import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RunRecorder, summarizeRun, type RunSummary } from "../src/app/runs.js";
import { runTournament, type TieChoice, type TournamentReport, type TournamentRuntime } from "../src/app/tournament/run.js";
import type { ChangeSet, VerificationCommand } from "../src/core/domain.js";
import { canonicalJson } from "../src/core/delivery/canonical.js";
import { assembleBuildEvidence } from "../src/core/evidence/build.js";
import { reliabilityPlan, type TaskProfile } from "../src/core/evidence/policy.js";
import { DiagnosticRedactor } from "../src/core/policy/redaction.js";
import { inspectTask } from "../src/core/policy/task-inspector.js";
import type { CandidateId } from "../src/core/tournament/contracts.js";
import { proposalSha256 } from "../src/core/tournament/manifest.js";
import { NO_EXPERIMENTS, type ExperimentSpecs } from "../src/core/tournament/profile.js";
import { TournamentBudgetRefused } from "../src/core/tournament/route.js";
import { STRATEGY_BRIEFS } from "../src/core/tournament/strategies.js";
import { makeId } from "../src/platform/events/shared.js";
import { changeSet, FAKE_MODEL, FAKE_PROVIDER, plan, scriptedRoles, type Script, type Spy } from "./fixtures/fake-writer.js";
import { GuestPort, type Program } from "./fixtures/guest-port.js";
import { MemoryViews } from "./fixtures/memory-port.js";
import { QUOTE_BUGGY, QUOTE_FIXED, QUOTE_TEST, QUOTE_TEST_WITH_REGRESSION, QUOTE_WRONG, REHEARSAL_PLAN } from "./fixtures/rehearsal-project.js";
import { MEDIUM_PACKET, MEDIUM_TASK } from "./fixtures/writer-rehearsal-harness.js";

const REDACTOR = new DiagnosticRedactor();
const BASE_COMMIT = "0".repeat(40);
const PROFILE: TaskProfile = { taskClass: "bugFix", sensitive: false };
const RELIABILITY = reliabilityPlan(PROFILE, inspectTask(MEDIUM_TASK).risk);
const BASELINE = { "src/quote.ts": QUOTE_BUGGY, "test/quote.test.ts": QUOTE_TEST };
const FIXED_LINE = "basisPoints(subtotal - discount, quote.taxBasisPoints)";
const ALT_FIXED = QUOTE_FIXED.replace(FIXED_LINE, "basisPoints(subtotal - discount,  quote.taxBasisPoints)");
const change = (quote: string, withTest = true): ChangeSet =>
  changeSet([["src/quote.ts", QUOTE_BUGGY, quote], ...(withTest ? [["test/quote.test.ts", QUOTE_TEST, QUOTE_TEST_WITH_REGRESSION] as const] : [])]);
const FIX = change(QUOTE_FIXED), ALT = change(ALT_FIXED), WRONG = change(QUOTE_WRONG), SMALL = change(QUOTE_FIXED, false);
const API_BREAK = change(`${QUOTE_FIXED}export const leaked = 1;\n`);

/** The confined guest: the unit run passes exactly when the tax applies to the discounted subtotal. */
const PROGRAM: Program = (command, tree) => {
  const quote = tree.get("src/quote.ts") ?? "";
  const fixed = quote.includes("basisPoints(subtotal - discount,");
  switch (command.id) {
    case "typecheck": return { exit: 0, stdout: "" };
    case "unit": return { exit: fixed ? 0 : 1, stdout: fixed ? "pass\n" : "fail\n" };
    case "probe-api": return { exit: 0, stdout: `${(quote.match(/export /gu) ?? []).length} exports\n` };
    case "probe-shape": return { exit: 0, stdout: quote.includes(",  quote") ? "wide\n" : "narrow\n" };
    default: return { exit: 2, stdout: "unknown\n" };
  }
};
const probe = (id: string): VerificationCommand => Object.freeze({ id: `probe-${id}`, executable: "/usr/local/bin/node", args: Object.freeze([`${id}.js`]),
  cwd: ".", timeoutMs: 30_000, mutationPolicy: "readOnly" as const });
const EXPERIMENTS: ExperimentSpecs = Object.freeze({ ...NO_EXPERIMENTS, probes: Object.freeze([
  Object.freeze({ id: "api", command: probe("api"), expect: Object.freeze({ kind: "baseline" as const }) }),
  Object.freeze({ id: "shape", command: probe("shape"), expect: Object.freeze({ kind: "compare" as const }) })]) });

interface Harness { readonly report: TournamentReport; readonly summary: RunSummary; readonly port: GuestPort; readonly spies: ReadonlyMap<CandidateId, Spy> }
async function tournament(scripts: Partial<Record<CandidateId, Script>>, options: Readonly<{ candidates?: number; experiments?: ExperimentSpecs;
  program?: Program; chooseTie?: (tie: TieChoice) => Promise<CandidateId | undefined>; port?: (port: GuestPort) => void; timeoutMs?: number;
  signal?: AbortSignal }> = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "fusion-v05-tournament-"));
  try {
    const port = new GuestPort(BASELINE, options.program ?? PROGRAM);
    options.port?.(port);
    const recorder = await RunRecorder.start(dir, "build", REDACTOR, { task: MEDIUM_TASK.summary });
    const spies = new Map<CandidateId, Spy>();
    const runtime: TournamentRuntime = {
      workspace: port,
      engine: (id, events) => {
        const { roles, spy } = scriptedRoles(scripts[id] ?? { worker: () => FIX });
        spies.set(id, spy);
        return { roles, workspace: port, views: new MemoryViews(), verifier: { verify: () => { throw new Error("host verifier"); } }, events };
      },
      binding: () => ({ provider: FAKE_PROVIDER, model: FAKE_MODEL }),
      evaluate: (result, plannedCommands) => assembleBuildEvidence({ task: MEDIUM_TASK.summary, scope: MEDIUM_PACKET.scope.allowedFiles,
        plan: reliabilityPlan(PROFILE, result.risk!), plannedCommands, result, protectedChanged: [], baseCommit: BASE_COMMIT }),
    };
    const report = await runTournament({ tournamentId: makeId("t"), candidates: options.candidates ?? 2, source: "policy",
      request: { runId: recorder.runId, task: MEDIUM_TASK, packet: MEDIUM_PACKET, verification: REHEARSAL_PLAN, reproduce: true, timeoutMs: options.timeoutMs ?? 60_000,
        ...(options.signal === undefined ? {} : { signal: options.signal }) },
      contract: { task: MEDIUM_TASK.summary, baseCommit: BASE_COMMIT, scope: MEDIUM_PACKET.scope.allowedFiles, packetJson: canonicalJson(MEDIUM_PACKET) },
      obligations: RELIABILITY.obligations, falsification: "optional", experiments: options.experiments ?? NO_EXPERIMENTS },
    runtime, recorder, options.chooseTie === undefined ? {} : { chooseTie: options.chooseTie });
    await recorder.finish({ state: "COMPLETED", exitCode: 0, code: "completed", message: "done" });
    return { report, summary: await summarizeRun(dir, recorder.runId, REDACTOR), port, spies };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const states = (report: TournamentReport) => report.candidates.map(c => [c.id, c.state]);

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

  const dominated = await tournament({ c1: { worker: () => FIX }, c2: { worker: () => SMALL } });
  assert.equal(dominated.report.outcome, "DELIVERY_ELIGIBLE");
  assert.equal(dominated.report.selected?.id, "c2");
  assert.match(dominated.report.differences.join("\n"), /c2 dominates c1 by Fusion's evidence: fewer changed files/u);
  assert.ok(!JSON.stringify(dominated.report).match(/score|confidence|%/u), "no score of any kind");
});

test("v0.5 tournament: undominated verified candidates are a tie — a human decision; a human's choice is still revalidated", async () => {
  const tie = await tournament({ c1: { worker: () => FIX }, c2: { worker: () => ALT } }, { experiments: EXPERIMENTS });
  assert.equal(tie.report.outcome, "MULTIPLE_VERIFIED_CANDIDATES", tie.report.detail);
  assert.deepEqual(tie.report.tied, ["c1", "c2"]);
  assert.equal(tie.report.delivery, undefined);
  assert.equal(tie.report.revalidation, undefined, "nothing is revalidated before a choice");
  assert.match(tie.report.differences.join("\n"), /probe:shape: the candidates behave differently \(c1 ≠ c2\)/u);
  assert.deepEqual(states(tie.report), [["c1", "tied"], ["c2", "tied"]]);
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
