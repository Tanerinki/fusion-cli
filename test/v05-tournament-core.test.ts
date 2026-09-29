import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { ChangeSet, DelegationPacket, VerificationCommand } from "../src/core/domain.js";
import { advance, CANDIDATE_STATES, IllegalCandidateTransition, independenceOf, TOURNAMENT_LIMITS, type CandidateState } from "../src/core/tournament/contracts.js";
import { candidateManifest, contractSha256, patchSha256, proposalSha256, snapshotSha256 } from "../src/core/tournament/manifest.js";
import { ForeignEvidence, meshVerdict, nodesOf, type MeshNode } from "../src/core/tournament/mesh.js";
import { isTestPath, lineHunks, planMutations, revertHunk } from "../src/core/tournament/mutation.js";
import { candidateProfile, freezeProfile, NO_EXPERIMENTS, ProfileWeakened, requiredChecks, type ProfileInput } from "../src/core/tournament/profile.js";
import { TournamentBudgetRefused, tournamentRoute, type RouteFacts } from "../src/core/tournament/route.js";
import { selectCandidate, type CandidateFacts } from "../src/core/tournament/selection.js";
import { candidatePacket, STRATEGY_BRIEFS } from "../src/core/tournament/strategies.js";
import type { VerificationVerdict } from "../src/core/workflow/types.js";
import { validateChangeSet } from "../src/core/change/contract.js";
import { sha256Hex } from "../src/core/delivery/canonical.js";

/**
 * v0.5 PR A — THE TOURNAMENT CORE, as executable invariants (pure: no provider, no process, no filesystem): budgets and the
 * routing policy, the candidate lifecycle, strategy briefs over one frozen contract, the profile frozen before results, the
 * verification mesh bound to exact revisions, evidence-based selection with honest ties, immutable manifests, and Fusion-owned
 * mutations of a candidate's own change.
 */
const command = (id: string, args: readonly string[] = ["--test"]): VerificationCommand => ({ id, executable: "/usr/local/bin/node", args,
  cwd: ".", timeoutMs: 60_000, mutationPolicy: "readOnly" });
const profileInput = (patch: Partial<ProfileInput> = {}): ProfileInput => ({ policyVersion: "v0.5-route-1", commands: [command("unit")],
  baseline: { reproduced: true, failing: ["unit"] }, obligations: [{ kind: "verificationPassed", tier: "safety" }], falsification: "optional",
  experiments: NO_EXPERIMENTS, ...patch });
const facts = (id: "c1" | "c2" | "c3", patch: Partial<CandidateFacts> = {}): CandidateFacts => ({ id, revision: `rev-${id}`, patchSha256: `patch-${id}`,
  failed: false, securityViolation: false, decision: "VERIFIED", deliverable: true, failedObligations: [], contradictions: [], profileComplete: true,
  falsification: "notRequired", mutation: { run: 1, survived: 0 }, newDependency: false, changedFiles: 1, changedLines: 2, ...patch });
const route = (patch: Partial<RouteFacts> = {}): RouteFacts => ({ writer: true, taskClass: "bugFix", sensitive: false, risk: "low", alternatives: 0,
  priorFailure: false, ...patch });

// ---------------------------------------------------------------- budgets and the routing policy

test("v0.5 routing: a simple task stays one candidate; an eligible fix gets 2; a plain change only when a human asks", () => {
  assert.deepEqual([tournamentRoute(route()).route, tournamentRoute(route()).candidates], ["single", 1], "low-risk fix: nothing to compare");
  assert.deepEqual([tournamentRoute(route({ risk: "medium" })).route, tournamentRoute(route({ risk: "medium" })).candidates], ["tournament", 2]);
  assert.equal(tournamentRoute(route({ sensitive: true })).route, "tournament");
  assert.equal(tournamentRoute(route({ alternatives: 2 })).route, "tournament");
  assert.equal(tournamentRoute(route({ taskClass: "change", risk: "medium" })).route, "single", "a feature stays single by policy");
  assert.equal(tournamentRoute(route({ risk: "critical" })).route, "single", "critical: the human gate first");
  assert.equal(tournamentRoute(route({ writer: false, risk: "high" })).route, "single", "read-only: nothing to compare");
  // A human may ask for 1–3; never more.
  assert.deepEqual([tournamentRoute(route(), { requested: 3 }).candidates, tournamentRoute(route(), { requested: 3 }).source], [3, "human"]);
  assert.equal(tournamentRoute(route({ risk: "high" }), { requested: 1 }).route, "single", "a human may choose one candidate");
  for (const n of [0, 4, 99, 1.5]) assert.throws(() => tournamentRoute(route(), { requested: n }), TournamentBudgetRefused, String(n));
  assert.equal(TOURNAMENT_LIMITS.maxCandidates, 3);
});

test("v0.5 routing: a model's advice is advice — it can start the default tournament for an eligible task, never exceed or lower the policy", () => {
  const advised = tournamentRoute(route({ taskClass: "change", risk: "medium" }), { advice: "tournament" });
  assert.deepEqual([advised.route, advised.candidates, advised.source], ["tournament", 2, "advice"]);
  assert.equal(tournamentRoute(route(), { advice: "tournament" }).route, "single", "not for an ineligible task");
  assert.equal(tournamentRoute(route({ risk: "medium" }), { advice: "single" }).route, "tournament", "advice never lowers the policy");
  assert.ok(tournamentRoute(route({ risk: "high" }), { advice: "tournament" }).candidates <= TOURNAMENT_LIMITS.defaultCandidates, "advice never adds candidates");
});

// ---------------------------------------------------------------- the lifecycle

test("v0.5 lifecycle: only allowed transitions — a candidate can never jump to selected, and nothing leaves a terminal rejection", () => {
  const path: CandidateState[] = ["proposed", "materialized", "verified", "survivor", "selected", "revalidated", "deliveryEligible"];
  for (let i = 1; i < path.length; i++) assert.equal(advance(path[i - 1]!, path[i]!), path[i]);
  for (const [from, to] of [["proposed", "selected"], ["materialized", "selected"], ["verified", "selected"], ["selected", "deliveryEligible"],
    ["rejected", "survivor"], ["unverified", "survivor"], ["failed", "materialized"], ["notSelected", "selected"], ["deliveryEligible", "proposed"]] as const)
    assert.throws(() => advance(from, to), IllegalCandidateTransition, `${from} → ${to}`);
  // A tie is resolved only to selected or not selected (by the human), and a selection still needs revalidation.
  assert.equal(advance("tied", "selected"), "selected");
  assert.throws(() => advance("tied", "revalidated"), IllegalCandidateTransition);
  assert.ok(CANDIDATE_STATES.includes("tied") && CANDIDATE_STATES.includes("revalidated"));
});

// ---------------------------------------------------------------- strategy briefs over one frozen contract

test("v0.5 independence: every candidate author gets the same frozen contract plus its own brief; briefs name no winner", () => {
  const frozen: DelegationPacket = { task: { goal: "fix add()", constraints: ["keep the API"], acceptanceCriteria: ["tests pass"] },
    scope: { relevantFiles: ["src/sum.js"], allowedFiles: ["src/sum.js"], forbiddenFiles: [] }, architecture: { decisions: [], invariants: [] },
    verification: { requiredTests: ["unit"] }, openQuestions: [] };
  const packets = (["c1", "c2", "c3"] as const).map(id => candidatePacket(frozen, id));
  for (const [i, p] of packets.entries()) {
    assert.deepEqual({ ...p, task: { ...p.task, constraints: p.task.constraints.slice(0, -1) } }, frozen, "the frozen contract, unchanged");
    assert.equal(p.task.constraints.length, frozen.task.constraints.length + 1, "exactly one more line: the brief");
    assert.ok(!packets.some((q, j) => j !== i && q.task.constraints.includes(p.task.constraints.at(-1)!)), "a brief of its own");
  }
  for (const brief of Object.values(STRATEGY_BRIEFS)) assert.doesNotMatch(brief.brief, /\bc[123]\b|win|best|prefer|score|other candidate/iu);
  assert.deepEqual(frozen.task.constraints, ["keep the API"], "the frozen packet itself is never modified");
  assert.deepEqual([independenceOf([{ provider: "claude", model: "haiku" }, { provider: "claude", model: "haiku" }]),
    independenceOf([{ provider: "claude", model: "haiku" }, { provider: "claude", model: "opus" }]),
    independenceOf([{ provider: "claude", model: "haiku" }, { provider: "meta", model: "spark" }])], ["separateContext", "separateModel", "separateProvider"]);
});

// ---------------------------------------------------------------- the frozen profile

test("v0.5 profile: frozen before results — a canonical hash over every check; any change is a different profile; additions only add", () => {
  const a = freezeProfile(profileInput()), b = freezeProfile(profileInput());
  assert.equal(a.sha256, b.sha256, "deterministic");
  assert.ok(Object.isFrozen(a.profile) && Object.isFrozen(a.profile.commands), "immutable");
  for (const changed of [profileInput({ commands: [command("unit", ["--test", "only-one.js"])] }), profileInput({ falsification: "required" }),
    profileInput({ baseline: { reproduced: false, failing: [] } }), profileInput({ obligations: [] }),
    profileInput({ experiments: { ...NO_EXPERIMENTS, mutation: { enabled: true, maxPerCandidate: 2 } } })])
    assert.notEqual(freezeProfile(changed).sha256, a.sha256);
  const probes = freezeProfile(profileInput({ experiments: { ...NO_EXPERIMENTS, probes: [{ id: "same", command: command("same"), expect: { kind: "baseline" } },
    { id: "diff", command: command("diff"), expect: { kind: "compare" } }] } }));
  assert.deepEqual(requiredChecks(probes.profile), ["unit", "probe:same"], "a compare probe has no oracle: not a pass/fail check");
  // A candidate profile can only add: a collision would replace a common check and is refused.
  const cp = candidateProfile(probes, "c1", [{ id: "mutation:m1", kind: "mutation", sha256: "x" }]);
  assert.equal(cp.common, probes.sha256);
  for (const id of ["unit", "probe:same"]) assert.throws(() => candidateProfile(probes, "c1", [{ id, kind: "mutation", sha256: "x" }]), ProfileWeakened, id);
  assert.throws(() => freezeProfile(profileInput({ experiments: { ...NO_EXPERIMENTS, mutation: { enabled: true, maxPerCandidate: 9 } } })), RangeError, "bounded");
  assert.throws(() => freezeProfile(profileInput({ experiments: { ...NO_EXPERIMENTS, probes: Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`,
    command: command(`p${i}`), expect: { kind: "baseline" as const } })) } })), RangeError);
});

// ---------------------------------------------------------------- the verification mesh

const verdict = (passed = true): VerificationVerdict => ({ passed, commandsRun: 1, evidence: { backendId: "docker-linux", confinement: "osSandbox",
  platformRequirement: "linux-compatible", acceptance: "granted", commands: [{ id: "unit", status: passed ? "passed" : "failed", exitCode: passed ? 0 : 1 }] } });
const node = (patch: Partial<MeshNode> & Pick<MeshNode, "id">): MeshNode => ({ candidate: "c1", revision: "rev-1", kind: "probe", source: "configured",
  authority: "deterministic", result: "pass", detail: "d", ...patch });

test("v0.5 mesh: Fusion's experiments enter the v0.4 decision as checks; a model's claim is no evidence; a missing check never passes", () => {
  const frozen = freezeProfile(profileInput({ experiments: { ...NO_EXPERIMENTS, probes: [{ id: "same", command: command("same"), expect: { kind: "baseline" } }] } }));
  const ok = meshVerdict(verdict(), frozen.profile, [node({ id: "probe:same" })]);
  assert.deepEqual([ok.verdict?.passed, ok.verdict?.commandsRun, ok.planned], [true, 2, 2]);
  const failed = meshVerdict(verdict(), frozen.profile, [node({ id: "probe:same", result: "fail", exitCode: 3 })]);
  assert.deepEqual([failed.verdict?.passed, failed.verdict?.failedCommand], [false, "x:probe:same"]);
  // A model saying the probe passed is not a node Fusion observed: the check is missing, so the verification is incomplete.
  const claimed = meshVerdict(verdict(), frozen.profile, [node({ id: "probe:same", authority: "model", source: "falsifier" })]);
  assert.deepEqual([claimed.verdict?.passed, claimed.verdict?.commandsRun, claimed.planned], [false, 1, 2]);
  assert.equal(meshVerdict(verdict(), frozen.profile, []).verdict?.passed, false, "not run: never a pass");
});

test("v0.5 revision binding: evidence of one candidate revision can never support another", () => {
  const nodes = [node({ id: "unit", revision: "rev-1" }), node({ id: "probe:x", revision: "rev-1" }), node({ id: "unit", candidate: "c2", revision: "rev-9" })];
  assert.equal(nodesOf(nodes, "c1", "rev-1").length, 2);
  assert.throws(() => nodesOf(nodes, "c1", "rev-2"), ForeignEvidence, "a corrected revision needs its own evidence");
  assert.throws(() => nodesOf([...nodes, node({ id: "late", revision: "rev-0" })], "c1", "rev-1"), ForeignEvidence, "a stale node is refused, not skipped");
});

// ---------------------------------------------------------------- selection

test("v0.5 selection: a clear winner by Fusion's evidence; eliminations say why; a security violation stops everything", () => {
  const clear = selectCandidate([facts("c1", { decision: "BLOCKED", deliverable: false, failedObligations: ["verificationPassed"] }), facts("c2")]);
  assert.equal(clear.kind, "selected");
  assert.equal(clear.kind === "selected" ? clear.winner : undefined, "c2");
  assert.deepEqual(clear.kind === "selected" ? clear.eliminated : [], [{ id: "c1", reason: "failed obligation(s): verificationPassed" }]);
  assert.equal(selectCandidate([facts("c1", { contradictions: ["probe:boundary"] }), facts("c2")]).kind === "selected", true);
  assert.deepEqual(selectCandidate([facts("c1", { securityViolation: true }), facts("c2")]), { kind: "none", outcome: "CANDIDATE_SECURITY_VIOLATION",
    eliminated: [{ id: "c1", reason: "a security violation stopped the tournament" }] }, "even with a verified sibling");
  for (const [patch, outcome] of [[{ failed: true, deliverable: false }, "PROVIDER_FAILURE"],
    [{ profileComplete: false }, "VERIFICATION_PROFILE_FAILED"], [{ falsification: "failed" }, "FALSIFICATION_REQUIRED_FAILED"],
    [{ decision: "UNVERIFIED", deliverable: false }, "NO_VERIFIED_CANDIDATE"]] as const) {
    const none = selectCandidate([facts("c1", patch), facts("c2", patch)]);
    assert.deepEqual([none.kind, none.kind === "none" ? none.outcome : undefined], ["none", outcome]);
  }
});

test("v0.5 selection: no fake score — dominance over host-observed dimensions, or an honest tie; identical changes converge", () => {
  // Equal on everything Fusion observed: a tie, never a model-chosen winner.
  const tie = selectCandidate([facts("c1"), facts("c2")]);
  assert.deepEqual(tie.kind === "tie" ? [tie.candidates, tie.differences] : tie.kind, [["c1", "c2"], ["no host-observed difference"]]);
  // Fewer undetected mutations and no worse elsewhere: dominance.
  const stronger = selectCandidate([facts("c1", { mutation: { run: 2, survived: 1 } }), facts("c2", { mutation: { run: 2, survived: 0 } })]);
  assert.deepEqual(stronger.kind === "selected" ? [stronger.winner, stronger.dominated] : stronger.kind,
    ["c2", [{ id: "c1", by: "c2", dimensions: ["undetectedMutations"] }]]);
  // Better on one dimension, worse on another: no dominance — a smaller patch never wins over stronger evidence by itself.
  const mixed = selectCandidate([facts("c1", { mutation: { run: 2, survived: 0 }, changedLines: 9 }), facts("c2", { mutation: { run: 2, survived: 1 }, changedLines: 2 })]);
  assert.equal(mixed.kind, "tie");
  assert.deepEqual(mixed.kind === "tie" ? mixed.differences : [], ["fewer mutations its checks did not detect: c1=0, c2=1", "fewer changed lines: c1=9, c2=2"]);
  // Mutation evidence is compared only when every candidate had a mutation run.
  const incomparable = selectCandidate([facts("c1", { mutation: { run: 0, survived: 0 } }), facts("c2", { mutation: { run: 2, survived: 2 } })]);
  assert.equal(incomparable.kind, "tie");
  const converged = selectCandidate([facts("c1", { patchSha256: "same" }), facts("c2", { patchSha256: "same" })]);
  assert.deepEqual(converged.kind === "selected" ? [converged.winner, converged.converged] : converged.kind, ["c1", ["c1", "c2"]]);
  // The facts carry no model preference at all: there is no field a model could fill to choose a winner.
  assert.ok(!("preference" in facts("c1")) && !("score" in facts("c1")));
});

// ---------------------------------------------------------------- manifests

test("v0.5 manifests: a candidate is bound to its contract, snapshot, profile, proposal, tree state, paths and policy", () => {
  const changes: ChangeSet = { schemaVersion: 1, operations: [{ kind: "writeText", path: "src/sum.js", expectedSha256: "a".repeat(64), content: "x\n" }] };
  const base = { tournamentId: "t-1", candidate: "c1" as const, strategy: "direct", contractSha256: contractSha256({ task: "fix", baseCommit: "b".repeat(40),
    scope: ["src/sum.js"], packetJson: "{}" }), snapshotSha256: snapshotSha256({ baseCommit: "b".repeat(40), reproduction: { ran: true, commands: [{ id: "unit", passed: false }] } }),
    profileSha256: "p".repeat(64), proposalSha256: proposalSha256(changes), patchSha256: patchSha256([{ kind: "writeText", path: "src/sum.js",
      beforeSha256: "a".repeat(64), afterSha256: "c".repeat(64), bytes: 2 }]), changedPaths: ["src/sum.js"], policyVersion: "v0.5-route-1" };
  const one = candidateManifest(base);
  assert.equal(candidateManifest({ ...base, changedPaths: [...base.changedPaths] }).sha256, one.sha256, "deterministic");
  for (const [key, value] of [["contractSha256", "x"], ["snapshotSha256", "x"], ["profileSha256", "x"], ["proposalSha256", "x"], ["patchSha256", "x"],
    ["changedPaths", ["other.js"]], ["policyVersion", "v9"], ["strategy", "alternative"], ["candidate", "c2"]] as const)
    assert.notEqual(candidateManifest({ ...base, [key]: value } as typeof base).sha256, one.sha256, key);
  assert.notEqual(proposalSha256({ ...changes, operations: [{ ...changes.operations[0]!, content: "y\n" }] as never }), base.proposalSha256);
});

// ---------------------------------------------------------------- Fusion-owned mutations

test("v0.5 mutations: Fusion reverts one changed region of the candidate's own non-test change at a time — bounded and deterministic", () => {
  const before = ["function add(a, b) {", "  return a - b;", "}", "", "function sub(a, b) {", "  return a + b;", "}"].join("\n");
  const after = ["function add(a, b) {", "  return a + b;", "}", "", "function sub(a, b) {", "  return a - b;", "}"].join("\n");
  const hunks = lineHunks(before, after)!;
  assert.equal(hunks.length, 2, "two separate regions");
  assert.equal(revertHunk(after, hunks, 0), ["function add(a, b) {", "  return a - b;", "}", "", "function sub(a, b) {", "  return a - b;", "}"].join("\n"));
  assert.equal(revertHunk(after, hunks, 1), ["function add(a, b) {", "  return a + b;", "}", "", "function sub(a, b) {", "  return a + b;", "}"].join("\n"));
  assert.deepEqual(lineHunks("same\n", "same\n"), []);
  assert.equal(lineHunks("x\n".repeat(5000), "y\n"), undefined, "beyond the bound Fusion does not guess");
  const changes: ChangeSet = { schemaVersion: 1, operations: [{ kind: "writeText", path: "src/sum.js", expectedSha256: "a".repeat(64), content: after },
    { kind: "writeText", path: "test/sum.test.js", expectedSha256: "b".repeat(64), content: "new test\n" },
    { kind: "writeText", path: "src/new.js", expectedSha256: null, content: "created\n" }] };
  const plan = planMutations("c1", changes, new Map([["src/sum.js", before], ["test/sum.test.js", "old test\n"], ["src/new.js", null]]), 3);
  assert.deepEqual(plan.mutations.map(m => [m.id, m.path, m.hunk]), [["m1", "src/sum.js", 0], ["m2", "src/sum.js", 1]]);
  assert.deepEqual(plan.notMutated, [{ path: "test/sum.test.js", reason: "a test file is not mutated" }, { path: "src/new.js", reason: "a created file is not mutated" }]);
  assert.deepEqual(plan.mutations[0]!.changes.operations.slice(1), changes.operations.slice(1), "every other operation is kept");
  assert.equal(planMutations("c1", changes, new Map([["src/sum.js", before]]), 1).mutations.length, 1, "bounded by the budget");
  assert.equal(planMutations("c1", changes, new Map([["src/sum.js", before]]), 99).mutations.length, 2, "never above the hard limit");
  assert.deepEqual([isTestPath("test/a.js"), isTestPath("src/a.test.ts"), isTestPath("src/__tests__/x.js"), isTestPath("src/contest.js")], [true, true, true, false]);
});

// ---------------------------------------------------------------- guard

test("v0.5 guard: the tournament core names no provider or model and imports nothing outside the core", async () => {
  const dir = join(process.cwd(), "src", "core", "tournament");
  for (const file of await readdir(dir)) {
    const text = await readFile(join(dir, file), "utf8");
    assert.doesNotMatch(text, /\b(claude|muse|anthropic|openai|gemini|opus|haiku|sonnet)\b/iu, file);
    for (const m of text.matchAll(/from "([^"]+)"/gu)) assert.ok(m[1]!.startsWith("./") || m[1]!.startsWith("../") && !m[1]!.includes("/app/") &&
      !m[1]!.includes("/platform/") && !m[1]!.includes("/providers/"), `${file}: ${m[1]}`);
  }
});

test("v0.5 regression: reverting a file's only change drops that file from the mutation — never a no-op rewrite the port refuses", () => {
  const base = "export const a = 1;\n";
  const both = { schemaVersion: 1 as const, operations: [
    { kind: "writeText" as const, path: "src/a.ts", expectedSha256: sha256Hex(base), content: "export const a = 2;\n" },
    { kind: "writeText" as const, path: "test/a.test.ts", expectedSha256: null, content: "test\n" }] };
  const planned = planMutations("c1", both, new Map([["src/a.ts", base]]), 3);
  assert.equal(planned.mutations.length, 1);
  assert.deepEqual(planned.mutations[0]!.changes.operations.map(op => op.path), ["test/a.test.ts"], "the reverted file is simply not written");
  const scope = { allowedPaths: ["src/a.ts", "test/a.test.ts"], forbiddenPaths: [] };
  for (const m of planned.mutations) assert.doesNotThrow(() => validateChangeSet(m.changes, scope), "every planned mutation is a valid ChangeSet");
  const alone = planMutations("c1", { schemaVersion: 1, operations: [both.operations[0]!] }, new Map([["src/a.ts", base]]), 3);
  assert.deepEqual([alone.mutations.length, alone.notMutated.map(n => n.reason)], [0, ["reverting its only change is the unchanged baseline, already observed"]]);
});

test("v0.5 regression: when nothing is verified, the outcome names every candidate's PRIMARY cause — a blocked check is not a falsification failure", () => {
  const blocked = [facts("c1", { decision: "BLOCKED", deliverable: false, falsification: "failed", failedObligations: ["verificationPassed"] }),
    facts("c2", { decision: "BLOCKED", deliverable: false, falsification: "failed", failedObligations: ["verificationPassed"] })];
  assert.equal((selectCandidate(blocked) as { outcome: string }).outcome, "NO_VERIFIED_CANDIDATE");
  const falsified = [facts("c1", { falsification: "failed" }), facts("c2", { falsification: "failed" })];
  assert.equal((selectCandidate(falsified) as { outcome: string }).outcome, "FALSIFICATION_REQUIRED_FAILED");
});
