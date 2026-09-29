import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { prepareBuildDelivery } from "../src/app/build-delivery.js";
import { parseConfig } from "../src/app/config.js";
import { ControlPlane } from "../src/app/control-plane.js";
import { RunRecorder } from "../src/app/runs.js";
import { selectedDelivery, tournamentOutcome } from "../src/app/tournament/build.js";
import { runTournament, type TournamentReport } from "../src/app/tournament/run.js";
import { issueConfirmedPlanAuthorization, issueWriterRunAuthorization, liveWriterAuthorization } from "../src/app/writer-gate.js";
import type { WriterRehearsal } from "../src/app/writer-rehearsal.js";
import { parseArgs, UsageError } from "../src/cli/args.js";
import { renderBuildPlan, renderRun } from "../src/cli/render.js";
import { runCli } from "../src/cli/run.js";
import type { ChangeSet, DelegationPacket } from "../src/core/domain.js";
import { canonicalJson } from "../src/core/delivery/canonical.js";
import { assembleBuildEvidence } from "../src/core/evidence/build.js";
import { reliabilityPlan } from "../src/core/evidence/policy.js";
import { FusionFailure } from "../src/core/errors.js";
import { DiagnosticRedactor } from "../src/core/policy/redaction.js";
import { inspectTask } from "../src/core/policy/task-inspector.js";
import { TOURNAMENT_OUTCOMES, type CandidateId } from "../src/core/tournament/contracts.js";
import { NO_EXPERIMENTS } from "../src/core/tournament/profile.js";
import { TournamentBudgetRefused, tournamentRoute, type RouteFacts } from "../src/core/tournament/route.js";
import { STRATEGY_BRIEFS } from "../src/core/tournament/strategies.js";
import { EventStore } from "../src/platform/events/event-store.js";
import { makeId } from "../src/platform/events/shared.js";
import type { StoredEvent } from "../src/platform/events/types.js";
import { DockerLinuxVerificationBackend } from "../src/platform/verification/docker/backend.js";
import { VerificationService } from "../src/platform/verification/selection.js";
import { OFFLINE_REHEARSAL, PrivateCandidateWorkspacePort } from "../src/platform/workflow/candidates.js";
import { FAKE_DOCKER_EXE, FAKE_IMAGE, FakeDocker } from "./fixtures/fake-docker.js";
import { changeSet, FAKE_MODEL, FAKE_PROVIDER, scriptedRoles, type Script } from "./fixtures/fake-writer.js";
import { GuestPort } from "./fixtures/guest-port.js";
import { MemoryViews } from "./fixtures/memory-port.js";
import { FAKE_DEPENDENCY_TREE, QUOTE_BUGGY, QUOTE_FIXED, QUOTE_TEST, QUOTE_TEST_WITH_REGRESSION, QUOTE_WRONG,
  REHEARSAL_PLAN } from "./fixtures/rehearsal-project.js";
import { FIX, gitAvailable, MEDIUM_PACKET, MEDIUM_TASK, rehearsalOracle, withRehearsalRepo, WRONG } from "./fixtures/writer-rehearsal-harness.js";

const skip = gitAvailable ? false : "git executable unavailable";
const TASK = "Fix quote totals: tax applies to the discounted subtotal. Add a regression test.";
const LOW = "Fix quote totals: tax applies to the discounted subtotal.";
const FIXED_LINE = "basisPoints(subtotal - discount, quote.taxBasisPoints)";
/** A second correct fix: the same fixed expression, annotated — the same files and the same number of changed lines. */
const ALT = changeSet([["src/quote.ts", QUOTE_BUGGY, QUOTE_FIXED.replace(FIXED_LINE, `${FIXED_LINE} /* discounted */`)],
  ["test/quote.test.ts", QUOTE_TEST, QUOTE_TEST_WITH_REGRESSION]]);
const WRONG_ONLY = changeSet([["src/quote.ts", QUOTE_BUGGY, QUOTE_WRONG]]);
const briefOf = (packet: DelegationPacket): CandidateId | undefined =>
  (["c1", "c2", "c3"] as const).find(id => packet.task.constraints.includes(STRATEGY_BRIEFS[id].brief));
/** Each candidate's author proposes by its brief — the fakes never see another candidate. */
const byBrief = (changes: Readonly<Partial<Record<CandidateId, ChangeSet>>>, single: ChangeSet): Script =>
  ({ worker: ({ packet }) => changes[briefOf(packet) ?? "c1"] ?? single });

const CONFIG = (limits: Record<string, unknown> = {}) => JSON.stringify({ schemaVersion: 1, bindings: [],
  verification: { commands: [], platformRequirement: "linux-compatible" }, ...(Object.keys(limits).length > 0 ? { limits: { runTimeoutMs: 600_000, ...limits } } : {}) });
const REGISTRY = { defaults: { schemaVersion: 1 as const, bindings: [], verification: { commands: [] }, limits: { runTimeoutMs: 600_000 } },
  factories: new Map() };
function seam(repoDir: string, script: Script): { rehearsal: WriterRehearsal; turns: () => number } {
  const fake = new FakeDocker({ attach: rehearsalOracle() as never, depsTree: FAKE_DEPENDENCY_TREE });
  const backend = new DockerLinuxVerificationBackend({ image: FAKE_IMAGE, runner: fake, resolveDocker: () => Promise.resolve(FAKE_DOCKER_EXE),
    dependencyStoreDirectory: join(repoDir, "dependency-store") });
  const { roles, spy } = scriptedRoles(script);
  return { turns: () => spy.proposals.length + spy.plans.length + spy.reviews.length, rehearsal: { roles, plan: REHEARSAL_PLAN,
    candidatePort: ({ primaryRoot, git, declaredPlatform }) => new PrivateCandidateWorkspacePort({ primaryRoot, git, service: new VerificationService([backend]),
      confinement: OFFLINE_REHEARSAL, declaredPlatform, dependencies: "npm-lockfile", prepareDependencies: true }) } };
}
async function cli(root: string, argv: string[], rehearsal: WriterRehearsal, answers?: string[]) {
  let stdout = "", stderr = "";
  const questions: string[] = [];
  const io = { stdout: (text: string) => { stdout += text; }, stderr: (text: string) => { stderr += text; },
    ...(answers === undefined ? {} : { interactive: true, prompt: async (question: string) => { questions.push(question); return answers.shift() ?? null; } }) };
  const code = await runCli(argv, io, { env: process.env, cwd: root, registry: REGISTRY, writerRehearsal: rehearsal });
  return { code, stdout, stderr, questions };
}
async function events(root: string, runId: string): Promise<StoredEvent[]> {
  const list: StoredEvent[] = [];
  for await (const item of EventStore.read(join(root, ".fusion", "runs", runId), runId)) if ("event" in item) list.push(item.event);
  return list;
}
interface JsonBuild { runId: string; outcome: { state: string; code: string; message: string }; evidence?: { decision: { decision: string } };
  tournament?: { outcome: string; route: { candidates: number; source: string; reasons: string[] }; selected?: { id: string; revision: string; chosenBy: string };
    tied?: string[]; candidates: Array<{ id: string; state: string; decision?: string }>; revalidation?: { passed: boolean } } }

// ---------------------------------------------------------------- budget, routing and the human's confirmation

const facts = (patch: Partial<RouteFacts> = {}): RouteFacts => ({ writer: true, taskClass: "bugFix", sensitive: false, risk: "medium", alternatives: 0,
  priorFailure: false, ...patch });

test("v0.5 build budget: the repository's cap bounds the policy and the human; flags and config are strict", () => {
  assert.deepEqual([tournamentRoute(facts()).route, tournamentRoute(facts()).candidates], ["tournament", 2]);
  const capped = tournamentRoute(facts(), { cap: 1 });
  assert.deepEqual([capped.route, capped.candidates], ["single", 1]);
  assert.match(capped.reasons.join(";"), /limits\.maxCandidates/u);
  assert.throws(() => tournamentRoute(facts(), { requested: 2, cap: 1 }), (e: unknown) => e instanceof TournamentBudgetRefused && /at most 1 candidate/u.test(e.message));
  assert.equal(tournamentRoute(facts({ risk: "low" }), { requested: 3, cap: 3 }).candidates, 3);
  assert.equal(tournamentRoute(facts({ risk: "low", priorFailure: true })).route, "tournament", "an earlier failed attempt makes a fix eligible");

  assert.equal(parseArgs(["build", "--candidates", "3", "x"]).candidates, 3);
  for (const bad of ["0", "4", "two", "-1"]) assert.throws(() => parseArgs(["build", "--candidates", bad, "x"]), UsageError, bad);
  assert.throws(() => parseArgs(["review", "--candidates", "2"]), UsageError, "only a build takes candidates");
  const base = { schemaVersion: 1, verification: { commands: [] } };
  assert.equal(parseConfig({ ...base, limits: { maxCandidates: 1 } }).limits.maxCandidates, 1);
  for (const bad of [0, 4, 1.5, "2"]) assert.throws(() => parseConfig({ ...base, limits: { maxCandidates: bad } }), FusionFailure, String(bad));
});

test("v0.5 build authorization: the human confirms the candidate count — a confirmation for one never starts a tournament, and v0.4's form is unchanged", () => {
  const request = { task: TASK, paths: ["src/quote.ts"], repositoryRoot: process.cwd() };
  const run = (candidates: number | undefined) => ({ ...request, ...(candidates === undefined ? {} : { candidates }) });
  for (const [issued, asked, authorized] of [[2, 2, true], [2, 1, false], [2, 3, false], [undefined, 1, true], [undefined, 2, false], [1, undefined, true]] as const) {
    const authorization = issueWriterRunAuthorization({ ...run(issued), typed: "build" })!;
    assert.equal(liveWriterAuthorization({ authorization, ...run(asked) }).authorized, authorized, `issued ${issued}, asked ${asked}`);
  }
  const yes = issueConfirmedPlanAuthorization({ ...run(3), answer: "y" })!;
  assert.equal(liveWriterAuthorization({ authorization: yes, ...run(2) }).authorized, false);
});

// ---------------------------------------------------------------- fusion build as a tournament (offline rehearsal)

test("v0.5 build: an eligible fix runs as a tournament; Fusion selects by its own evidence, records every candidate explicitly bound, and shows it",
  { skip }, async () => withRehearsalRepo(async repo => {
    const { rehearsal } = seam(repo.dir, byBrief({ c1: WRONG, c2: FIX }, FIX));
    const ran = await cli(repo.root, ["--json", "build", "--path", "src/quote.ts", "--path", "test/quote.test.ts", TASK], rehearsal);
    const report = JSON.parse(ran.stdout) as JsonBuild;
    assert.equal(report.outcome.state, "COMPLETED", ran.stdout + ran.stderr);
    assert.match(report.outcome.message, /c2 was selected \(by Fusion's evidence\) and revalidated freshly/u);
    assert.match(report.outcome.message, /offline rehearsal/u);
    assert.deepEqual([report.tournament?.outcome, report.tournament?.route.candidates, report.tournament?.route.source], ["DELIVERY_ELIGIBLE", 2, "policy"]);
    assert.deepEqual(report.tournament?.candidates.map(c => [c.id, c.state, c.decision]), [["c1", "rejected", "BLOCKED"], ["c2", "deliveryEligible", "VERIFIED"]]);
    assert.deepEqual([report.tournament?.selected?.id, report.tournament?.selected?.chosenBy], ["c2", "fusion"]);
    assert.match(report.tournament?.selected?.revision ?? "", /^[0-9a-f]{64}$/u);
    assert.equal(report.tournament?.revalidation?.passed, true);
    assert.equal(report.evidence?.decision.decision, "VERIFIED", "the selected candidate's revalidation decision");
    assert.equal((report as { delivery?: unknown }).delivery, undefined, "an offline rehearsal is never delivered");
    const log = await events(repo.root, report.runId);
    assert.equal(log.filter(e => e.type === "TournamentStarted").length, 1);
    const routed = log.filter(e => e.type === "RouteDecided").map(e => e.payload as { route: string; candidates: number; source: string; taskClass: string; risk: string });
    assert.deepEqual(routed.map(r => [r.route, r.candidates, r.source, r.taskClass, r.risk]), [["tournament", 2, "policy", "bugFix", "medium"]],
      "the route decision is recorded once, before any model turn (labels only)");
    assert.ok(log.findIndex(e => e.type === "RouteDecided") < log.findIndex(e => e.type === "AgentTurnObserved" || e.type === "StructuredTurnObserved"));
    assert.ok(log.filter(e => e.type === "WorkflowTransition").every(e => e.scope?.candidate === "c1" || e.scope?.candidate === "c2"),
      "every candidate's workflow event names its candidate");
    assert.equal(log.filter(e => e.type === "EvidenceDecisionRecorded" && e.scope === undefined).length, 0, "no unscoped decision in a tournament");
    const decided = log.filter(e => e.type === "TournamentDecided");
    assert.equal(decided.length, 1);
    assert.deepEqual([(decided[0]!.payload as { selected?: string }).selected, (decided[0]!.payload as { outcome: string }).outcome], ["c2", "DELIVERY_ELIGIBLE"]);
    const shown = await cli(repo.root, ["show", report.runId], rehearsal);
    assert.match(shown.stdout, /^tournament: DELIVERY_ELIGIBLE — c2 selected \(by Fusion's evidence\), revision [0-9a-f]{12}$/mu);
    assert.match(shown.stdout, /^evidence: VERIFIED — bugFix; /mu);
    const text = await cli(repo.root, ["build", "--path", "src/quote.ts", "--path", "test/quote.test.ts", TASK], seam(repo.dir, byBrief({ c1: WRONG, c2: FIX }, FIX)).rehearsal);
    assert.match(text.stdout, /^tournament: 2 candidates \(policy: risk medium\); separate contexts of the same model$/mu);
    assert.match(text.stdout, /^ {2}c1 \(direct\): rejected, BLOCKED — verificationPassed: /mu, "why, in Fusion's words");
    assert.match(text.stdout, /^ {2}selected: c2 \(by Fusion's evidence\)$/mu);
    assert.match(text.stdout, /^ {2}outcome: DELIVERY_ELIGIBLE$/mu);
  }, { extraFiles: { "fusion.config.json": CONFIG() } }));

test("v0.5 build: one candidate — asked for, or the repository's budget — is exactly the v0.4 route; over budget is refused before any model turn",
  { skip }, async () => withRehearsalRepo(async repo => {
    const one = seam(repo.dir, byBrief({}, FIX));
    const asked = JSON.parse((await cli(repo.root, ["--json", "build", "--candidates", "1", "--path", "src/quote.ts", "--path", "test/quote.test.ts", TASK],
      one.rehearsal)).stdout) as JsonBuild;
    assert.equal(asked.outcome.state, "COMPLETED");
    assert.equal(asked.tournament, undefined);
    const single = await events(repo.root, asked.runId);
    assert.ok(single.every(e => e.scope === undefined), "a single build records v0.4 events only (and its route decision)");
    assert.deepEqual(single.filter(e => e.type === "RouteDecided").map(e => (e.payload as { route: string; source: string }).route), ["single"]);
    await writeFile(join(repo.root, "fusion.config.json"), CONFIG({ maxCandidates: 1 }));
    const budget = JSON.parse((await cli(repo.root, ["--json", "build", "--path", "src/quote.ts", "--path", "test/quote.test.ts", TASK],
      seam(repo.dir, byBrief({}, FIX)).rehearsal)).stdout) as JsonBuild;
    assert.deepEqual([budget.outcome.state, budget.tournament], ["COMPLETED", undefined]);
    const over = seam(repo.dir, byBrief({}, FIX));
    const refused = await cli(repo.root, ["--json", "build", "--candidates", "2", "--path", "src/quote.ts", "--path", "test/quote.test.ts", TASK], over.rehearsal);
    assert.equal(refused.code, 2, refused.stdout + refused.stderr);
    assert.match(refused.stdout + refused.stderr, /allows at most 1 candidate \(limits\.maxCandidates\)/u);
    assert.equal(over.turns(), 0, "no model turn");
  }, { extraFiles: { "fusion.config.json": CONFIG() } }));

test("v0.5 build: a tie is a human decision — without a human it is the outcome; at a terminal the human's exact choice is revalidated",
  { skip }, async () => withRehearsalRepo(async repo => {
    const tieScript = () => seam(repo.dir, byBrief({ c1: FIX, c2: ALT }, FIX)).rehearsal;
    const argv = ["build", "--path", "src/quote.ts", "--path", "test/quote.test.ts", TASK];
    const unattended = await cli(repo.root, ["--json", ...argv], tieScript());
    const tie = JSON.parse(unattended.stdout) as JsonBuild;
    assert.deepEqual([tie.outcome.state, tie.outcome.code, unattended.code], ["DECISION_REQUIRED", "MULTIPLE_VERIFIED_CANDIDATES", 13], unattended.stdout);
    assert.deepEqual(tie.tournament?.tied, ["c1", "c2"]);
    assert.equal(tie.tournament?.revalidation, undefined);
    assert.match(tie.outcome.message, /Nothing was delivered or applied\./u);

    const chosen = await cli(repo.root, argv, tieScript(), ["build", "c2"]);
    assert.match(chosen.stdout, /^Candidates: 2 independent candidates \(policy: risk medium\)/mu, "the plan shows the number the human confirms");
    assert.match(chosen.stdout, /^Tie: c1 and c2 are verified, and Fusion's evidence does not separate them\.$/mu);
    assert.match(chosen.questions.at(-1) ?? "", /^Choose c1 or c2 to revalidate and prepare \(anything else chooses none\): $/u);
    assert.match(chosen.stdout, /^ {2}selected: c2 \(your choice among tied candidates\)$/mu);
    assert.match(chosen.stdout, /^ {2}revalidation: passed/mu);

    const declined = await cli(repo.root, argv, tieScript(), ["build", "yes"]);
    assert.match(declined.stdout, /^ {2}outcome: MULTIPLE_VERIFIED_CANDIDATES$/mu, "anything but an exact candidate id chooses none");
  }, { extraFiles: { "fusion.config.json": CONFIG() } }));

test("v0.5 build: an earlier failed attempt at the same task makes a low-risk fix a tournament, with the reason shown",
  { skip }, async () => withRehearsalRepo(async repo => {
    const first = JSON.parse((await cli(repo.root, ["--json", "build", "--path", "src/quote.ts", LOW], seam(repo.dir, byBrief({}, WRONG_ONLY)).rehearsal)).stdout) as JsonBuild;
    assert.notEqual(first.outcome.state, "COMPLETED");
    assert.equal(first.tournament, undefined, "low risk, nothing to compare: one candidate");
    const again = JSON.parse((await cli(repo.root, ["--json", "build", "--path", "src/quote.ts", LOW],
      seam(repo.dir, byBrief({ c1: WRONG_ONLY, c2: changeSet([["src/quote.ts", QUOTE_BUGGY, QUOTE_FIXED]]) }, WRONG_ONLY)).rehearsal)).stdout) as JsonBuild;
    assert.deepEqual([again.tournament?.route.candidates, again.tournament?.route.source], [2, "policy"]);
    assert.ok(again.tournament?.route.reasons.includes("an earlier attempt failed"));
    assert.equal(again.tournament?.selected?.id, "c2");
  }, { extraFiles: { "fusion.config.json": CONFIG() } }));

// ---------------------------------------------------------------- the delivery gate

test("v0.5 delivery: only the selected candidate's revalidated change reaches the real delivery preparation; anything else is refused",
  { skip }, async () => withRehearsalRepo(async repo => {
    const port = new GuestPort({ "src/quote.ts": QUOTE_BUGGY, "test/quote.test.ts": QUOTE_TEST }, (command, tree) => {
      const fixed = (tree.get("src/quote.ts") ?? "").includes(FIXED_LINE);
      return command.id === "unit" ? { exit: fixed ? 0 : 1, stdout: fixed ? "pass\n" : "fail\n" } : { exit: 0, stdout: "" };
    });
    port.acceptance = "granted";
    const recorder = await RunRecorder.start(repo.root, "build", new DiagnosticRedactor(), { task: TASK });
    const profile = { taskClass: "bugFix" as const, sensitive: false };
    const report = await runTournament({ tournamentId: makeId("t"), candidates: 2, source: "policy",
      request: { runId: recorder.runId, task: MEDIUM_TASK, packet: MEDIUM_PACKET, verification: REHEARSAL_PLAN, reproduce: true, timeoutMs: 60_000 },
      contract: { task: TASK, baseCommit: "0".repeat(40), scope: MEDIUM_PACKET.scope.allowedFiles, packetJson: canonicalJson(MEDIUM_PACKET) },
      obligations: reliabilityPlan(profile, inspectTask(MEDIUM_TASK).risk).obligations, falsification: "optional", experiments: NO_EXPERIMENTS }, {
      workspace: port,
      engine: (_id, sink) => ({ roles: scriptedRoles(byBrief({ c1: WRONG, c2: FIX }, FIX)).roles, workspace: port, views: new MemoryViews(),
        verifier: { verify: () => { throw new Error("host verifier"); } }, events: sink }),
      binding: () => ({ provider: FAKE_PROVIDER, model: FAKE_MODEL }),
      evaluate: (result, plannedCommands) => assembleBuildEvidence({ task: TASK, scope: MEDIUM_PACKET.scope.allowedFiles,
        plan: reliabilityPlan(profile, result.risk!), plannedCommands, result, protectedChanged: [] }),
    }, recorder);
    await recorder.finish({ state: "COMPLETED", exitCode: 0, code: "completed", message: "done" });
    assert.equal(report.outcome, "DELIVERY_ELIGIBLE", report.detail);
    const eligible = selectedDelivery(report)!;
    assert.equal(canonicalJson(eligible.result.changeSet), canonicalJson(FIX));
    const plane = new ControlPlane({ registry: REGISTRY, env: process.env, cwd: repo.root });
    const { git } = await import("./fixtures/writer-rehearsal-harness.js");
    const delivery = await prepareBuildDelivery(plane, { runId: recorder.runId, task: TASK, result: eligible.result,
      baseCommit: git(repo.root, "rev-parse", "HEAD").trim(), eventLogPath: recorder.events.path });
    assert.match(delivery.deliveryId, /^d-[0-9a-f]{24}$/u);

    const forged = (patch: (r: TournamentReport) => TournamentReport) => () => selectedDelivery(patch(report));
    const violation = (e: unknown) => e instanceof FusionFailure && e.error.kind === "SecurityViolation";
    assert.throws(forged(r => ({ ...r, delivery: { ...r.delivery!, result: { ...r.delivery!.result, changeSet: WRONG } } })), violation, "another change");
    assert.throws(forged(r => ({ ...r, selected: { ...r.selected!, id: "c1" } })), violation, "another candidate");
    assert.throws(forged(r => ({ ...r, selected: { ...r.selected!, revision: "f".repeat(64) } })), violation, "another revision");
    assert.throws(forged(r => ({ ...r, delivery: { ...r.delivery!, evidence: { ...r.delivery!.evidence,
      decision: { ...r.delivery!.evidence.decision, deliverable: false } } } })), violation, "an undeliverable decision");
    assert.equal(selectedDelivery({ ...report, outcome: "MULTIPLE_VERIFIED_CANDIDATES" }), undefined, "no delivery without eligibility");
  }));

// ---------------------------------------------------------------- what the human reads

test("v0.5 render: a single-candidate plan reads exactly as in v0.4; an unresolved tournament shows no evidence", () => {
  const plan = { repository: "/repo", task: TASK, risk: { level: "medium", decisive: [] }, writerRequired: true, intendedWorkflow: ["lead plan"],
    roles: [], verification: { confinedCommands: ["unit"], platformRequirement: "linux-compatible", dependencies: "none" }, paths: ["src/quote.ts"],
    protected: [], tournament: { candidates: 1, source: "policy" as const, reasons: ["a plain change: one candidate unless the human asks"] } };
  assert.doesNotMatch(renderBuildPlan(plan), /Candidates:/u);
  assert.match(renderBuildPlan({ ...plan, tournament: { candidates: 3, source: "human", reasons: ["the human asked for 3 candidates"] } }),
    /^Candidates: 3 independent candidates \(human: the human asked for 3 candidates\)/mu);
  const summary = { runId: "r-1", command: "build", status: "completed" as const, createdAt: "", transitions: 0, modelTurns: 0, findings: [],
    eventLog: "complete" as const, tournament: { id: "t-1", resolved: false, reason: "the tournament recorded more than one decision" } };
  const shown = renderRun(summary);
  assert.match(shown, /^tournament: UNRESOLVED — the tournament recorded more than one decision; no evidence is shown$/mu);
  assert.doesNotMatch(shown, /^evidence:/mu);
});

test("v0.5 build outcomes: every tournament outcome has its own state and exit code; only DELIVERY_ELIGIBLE completes", () => {
  const expected: Readonly<Record<string, readonly [string, number]>> = {
    DELIVERY_ELIGIBLE: ["COMPLETED", 0], MULTIPLE_VERIFIED_CANDIDATES: ["DECISION_REQUIRED", 13], DISCRIMINATOR_INCONCLUSIVE: ["DECISION_REQUIRED", 13],
    NO_VERIFIED_CANDIDATE: ["DECISION_REQUIRED", 13], VERIFICATION_PROFILE_FAILED: ["DECISION_REQUIRED", 13], FALSIFICATION_REQUIRED_FAILED: ["DECISION_REQUIRED", 13],
    REVALIDATION_MISMATCH: ["DECISION_REQUIRED", 13], TOURNAMENT_BUDGET_EXHAUSTED: ["TIMED_OUT", 7], CANDIDATE_SECURITY_VIOLATION: ["FAILED", 4],
    CANDIDATE_MATERIALIZATION_FAILED: ["FAILED", 8], PROVIDER_FAILURE: ["FAILED", 6], CANCELLED: ["CANCELLED", 130],
    DECISION_REQUESTED: ["DECISION_REQUIRED", 13], HUMAN_GATE_REQUIRED: ["HUMAN_GATE_REQUIRED", 14] };
  assert.deepEqual(Object.keys(expected).sort(), [...TOURNAMENT_OUTCOMES].sort(), "every outcome is mapped");
  for (const outcome of TOURNAMENT_OUTCOMES) {
    const mapped = tournamentOutcome({ outcome, detail: "detail." } as unknown as TournamentReport);
    assert.deepEqual([mapped.state, mapped.exitCode], expected[outcome], outcome);
    assert.equal(mapped.code, outcome === "DELIVERY_ELIGIBLE" ? "completed" : outcome, outcome);
    if (mapped.state === "DECISION_REQUIRED") assert.match(mapped.message, /Nothing was delivered or applied\./u);
  }
});
