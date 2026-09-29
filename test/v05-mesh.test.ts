import assert from "node:assert/strict";
import { test } from "node:test";
import type { TournamentReport } from "../src/app/tournament/run.js";
import { TOURNAMENT_LIMITS } from "../src/core/tournament/contracts.js";
import { candidateProfile, freezeProfile, requiredChecks, type ExperimentSpecs } from "../src/core/tournament/profile.js";
import type { Script } from "./fixtures/fake-writer.js";
import { ALT, API_BREAK, EXPERIMENTS, FIX, probe, states, tournament, WRONG } from "./fixtures/tournament-harness.js";

/**
 * v0.5 — THE VERIFICATION MESH (section 32): one frozen profile for every candidate, Fusion's experiments as additional host
 * checks, bound to exact revisions, bounded, and deterministic whatever order concurrent candidates finish in.
 */
const command = (id: string, args: string[]) => Object.freeze({ id, executable: "/usr/local/bin/node", args: Object.freeze(args), cwd: ".", timeoutMs: 30_000,
  mutationPolicy: "readOnly" as const });
const WITH_PROPERTY: ExperimentSpecs = Object.freeze({ ...EXPERIMENTS, property: Object.freeze([Object.freeze({ id: "round", command: command("property-round", ["prop.js"]),
  seedArg: "--seed", casesArg: "--cases", cases: 150 })]), fuzz: Object.freeze([Object.freeze({ id: "parse", command: command("fuzz-parse", ["fuzz.js"]),
  seedArg: "--seed", casesArg: "--runs", cases: 500 })]) });
const outline = (r: TournamentReport) => JSON.stringify({ states: states(r), outcome: r.outcome, selected: r.selected?.id, tied: r.tied,
  differences: r.differences, decisions: r.candidates.map(c => c.decision), nodes: r.candidates.map(c => c.nodes.map(n => `${n.id}:${n.result}`)) });

test("v0.5 mesh: the profile is frozen before any candidate result, and every candidate faces the same mandatory core", async () => {
  const { report, summaryEvents, port } = await tournament({ c1: { worker: () => FIX }, c2: { worker: () => WRONG } }, { experiments: EXPERIMENTS });
  const started = summaryEvents.findIndex(e => e.type === "TournamentStarted");
  const firstCandidate = summaryEvents.findIndex(e => e.scope?.candidate !== undefined);
  assert.ok(started >= 0 && started < firstCandidate, "recorded (with its digest) before any candidate's first event");
  assert.equal(port.runs[0]!.baseline, true, "the frozen baseline ran before any candidate");
  for (const id of ["c1", "c2"] as const) {
    const verified = summaryEvents.filter(e => e.type === "CandidateVerificationObserved" && e.scope?.candidate === id)
      .map(e => (e.payload as { commands?: Array<{ id: string }> }).commands?.map(c => c.id));
    assert.ok(verified.every(ids => JSON.stringify(ids) === JSON.stringify(["typecheck", "unit"]) || ids?.length === 1), `${id}: the common checks`);
  }
  assert.deepEqual(report.candidates.find(c => c.id === "c1")!.nodes.map(n => n.id), ["probe:api", "probe:shape"], "the same configured experiments");
});

test("v0.5 mesh: candidate-specific checks only add requirements — never replace or remove a common one", () => {
  const common = freezeProfile({ policyVersion: "v0.5-route-1", commands: [command("unit", [])], baseline: { reproduced: true, failing: ["unit"] },
    obligations: [{ kind: "verificationPassed", tier: "safety" }], falsification: "optional", experiments: WITH_PROPERTY });
  const before = requiredChecks(common.profile);
  const own = candidateProfile(common, "c1", [{ id: "mutation:m1", kind: "mutation", sha256: "a".repeat(64) }]);
  assert.equal(own.common, common.sha256, "a candidate's profile is the common one, by digest, unchanged");
  assert.deepEqual(own.additions.map(a => a.id), ["mutation:m1"], "plus additions — there is no way to express a removal");
  assert.deepEqual(requiredChecks(common.profile), before);
  for (const collision of ["unit", "probe:api", "property:round", "fuzz:parse"])
    assert.throws(() => candidateProfile(common, "c1", [{ id: collision, kind: "mutation", sha256: "a".repeat(64) }]), collision);
});

test("v0.5 mesh: baseline semantics — a candidate whose own baseline disagrees with the frozen one does not satisfy the profile", async () => {
  let frozen = false;
  // The unchanged baseline passes `unit` the first time (the frozen run) and fails afterwards: it is not deterministic.
  const { report } = await tournament({ c1: { worker: () => FIX }, c2: { worker: () => FIX } }, { program: (cmd, _tree, context) => {
    if (cmd.id !== "unit" || context?.baseline !== true) return undefined;
    if (!frozen) { frozen = true; return { exit: 0, stdout: "pass\n" }; }
    return { exit: 1, stdout: "fail\n" };
  } });
  assert.equal(report.profile.profile.baseline.failing.length, 0, "the frozen profile saw a passing baseline");
  assert.equal(report.outcome, "VERIFICATION_PROFILE_FAILED", report.detail);
  assert.ok(report.candidates.every(c => c.detail === "its own baseline reproduction disagrees with the frozen profile"));
});

test("v0.5 mesh: differential and property evidence discriminate — a counterexample contradicts, a behavioural difference is shown", async () => {
  const property = await tournament({ c1: { worker: () => FIX }, c2: { worker: () => ALT } }, { experiments: WITH_PROPERTY, program: (cmd, tree) => {
    if (cmd.id === "property-round") return (tree.get("src/quote.ts") ?? "").includes(",  quote") ? { exit: 1, stdout: `counterexample ${"x".repeat(5_000)}\n` }
      : { exit: 0, stdout: "150 cases ok\n" };
    if (cmd.id === "fuzz-parse") return { exit: 0, stdout: "no crash\n" };
    return undefined;
  } });
  const c2 = property.report.candidates.find(c => c.id === "c2")!;
  assert.deepEqual([c2.state, c2.facts.contradictions], ["rejected", ["property:round"]]);
  assert.equal(property.report.selected?.id, "c1");
  const fuzzRun = property.port.runs.find(r => r.commands.includes("fuzz-parse"))!;
  const args = fuzzRun.args[fuzzRun.commands.indexOf("fuzz-parse")]!;
  assert.deepEqual([args[1], args[3], args[4]], ["--seed", "--runs", "500"], "a bounded fuzz run with Fusion's seed");

  const differential = await tournament({ c1: { worker: () => FIX }, c2: { worker: () => ALT } }, { experiments: EXPERIMENTS });
  assert.equal(differential.report.outcome, "MULTIPLE_VERIFIED_CANDIDATES");
  assert.ok(differential.report.differences.some(d => /^probe:shape: the candidates behave differently/u.test(d)));
});

test("v0.5 mesh: bounded mutation testing, timeouts and contradictions — each ends as host evidence, never as a pass it did not earn", async () => {
  const mutated = await tournament({ c1: { worker: () => FIX }, c2: { worker: () => WRONG } }, { experiments: { ...EXPERIMENTS, mutation: { enabled: true, maxPerCandidate: 1 } } });
  const c1 = mutated.report.candidates.find(c => c.id === "c1")!;
  assert.ok(c1.nodes.filter(n => n.kind === "mutation").length <= 1, "at most the budget");
  assert.ok(c1.notMutated.some(n => n.path === "test/quote.test.ts" && n.reason === "a test file is not mutated"));

  const timed = await tournament({ c1: { worker: () => FIX }, c2: { worker: () => FIX } }, { experiments: EXPERIMENTS,
    program: cmd => cmd.id === "probe-api" ? { exit: null, status: "timeout" } : undefined });
  assert.ok(timed.report.candidates.every(c => c.nodes.find(n => n.id === "probe:api")?.result === "notRun"));
  assert.notEqual(timed.report.outcome, "DELIVERY_ELIGIBLE", "a required check that timed out never passes");

  const contradicted = await tournament({ c1: { worker: () => API_BREAK }, c2: { worker: () => FIX } }, { experiments: EXPERIMENTS });
  assert.deepEqual(contradicted.report.candidates.find(c => c.id === "c1")!.facts.contradictions, ["probe:api"]);
});

test("v0.5 mesh: the evidence graph links Fusion's experiments to the delivered change; stale re-materialization is refused", async () => {
  const { report } = await tournament({ c1: { worker: () => FIX }, c2: { worker: () => WRONG } }, { experiments: EXPERIMENTS });
  const graph = report.delivery!.evidence.graph;
  assert.ok(graph.evidence.some(e => e.label === "x:probe:api" && e.source === "verification"), "an experiment is verification evidence of the change");
  const stale = await tournament({ c1: { worker: () => FIX }, c2: { worker: () => WRONG } }, { experiments: EXPERIMENTS,
    port: p => { const acquire = p.acquire.bind(p); p.acquire = async (owner: string) => { if (owner.endsWith(".x.r1")) p.tamperLedger = true; return acquire(owner); }; } });
  assert.equal(stale.report.outcome, "CANDIDATE_SECURITY_VIOLATION", "evidence for a tree other than the judged one is never used");
});

test("v0.5 mesh: bounds hold — reproducers are bounded, and a profile over the hard limits is refused", async () => {
  const { report } = await tournament({ c1: { worker: () => ALT }, c2: { worker: () => FIX } }, { experiments: WITH_PROPERTY, program: (cmd, tree) => {
    if (cmd.id === "property-round") return (tree.get("src/quote.ts") ?? "").includes(",  quote") ? { exit: 1, stdout: `counterexample ${"y".repeat(9_000)}\n` } : { exit: 0, stdout: "ok\n" };
    if (cmd.id === "fuzz-parse") return { exit: 0, stdout: "ok\n" };
    return undefined;
  } });
  assert.equal(report.selected?.id, "c2");
  const reproducer = report.candidates.find(c => c.id === "c1")!.reproducers[0]!;
  assert.equal(reproducer.experiment, "property:round");
  assert.ok(reproducer.excerpt.length <= TOURNAMENT_LIMITS.reproducerChars, "a counterexample's excerpt is bounded");
  const tooMany = { ...EXPERIMENTS, probes: Array.from({ length: TOURNAMENT_LIMITS.maxProbes + 1 }, (_, i) => ({ id: `p${i}`, command: probe(`p${i}`), expect: { kind: "baseline" as const } })) };
  assert.throws(() => freezeProfile({ policyVersion: "v0.5-route-1", commands: [], baseline: { reproduced: false, failing: [] }, obligations: [],
    falsification: "optional", experiments: tooMany }), RangeError);
});

test("v0.5 mesh: results are deterministic whatever order concurrent candidates finish in", async () => {
  const ordered = async (first: "c1" | "c2") => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const late: Script["worker"] = async () => { await gate; return first === "c1" ? ALT : FIX; };
    const early: Script["worker"] = () => { release(); return first === "c1" ? FIX : ALT; };
    return tournament(first === "c1" ? { c1: { worker: early }, c2: { worker: late } } : { c1: { worker: late }, c2: { worker: early } },
      { experiments: EXPERIMENTS });
  };
  // c1 proposes FIX and c2 ALT in both runs; only the order in which they finish differs.
  const a = await ordered("c1"), b = await ordered("c2");
  assert.equal(outline(a.report), outline(b.report));
  assert.equal(a.report.outcome, "MULTIPLE_VERIFIED_CANDIDATES");
});
