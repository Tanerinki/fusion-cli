import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseConfig } from "../src/app/config.js";
import { experimentCommands, experimentSeed, planCandidateMutations, runBaselineProbes, runCandidateExperiments, runMutations,
  type MaterializedTarget } from "../src/app/tournament/experiments.js";
import type { ChangeScope, ChangeSet, VerificationCommand, VerificationPlan } from "../src/core/domain.js";
import { FusionFailure } from "../src/core/errors.js";
import { TOURNAMENT_LIMITS } from "../src/core/tournament/contracts.js";
import { patchSha256 } from "../src/core/tournament/manifest.js";
import { meshVerdict } from "../src/core/tournament/mesh.js";
import { freezeProfile, NO_EXPERIMENTS, type ExperimentSpecs } from "../src/core/tournament/profile.js";
import type { AppliedOperation } from "../src/core/workflow/types.js";
import type { GuestCommand } from "../src/platform/verification/docker/protocol.js";
import { passingResult } from "./fixtures/fake-docker.js";
import { changeSet } from "./fixtures/fake-writer.js";
import { GuestPort, type Program } from "./fixtures/guest-port.js";
import { gitAvailable, rig, withRehearsalRepo } from "./fixtures/writer-rehearsal-harness.js";
import { QUOTE_BUGGY, QUOTE_FIXED, REHEARSAL_PLAN } from "./fixtures/rehearsal-project.js";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const invalidInput = (error: unknown): boolean => error instanceof FusionFailure && error.error.kind === "InvalidInput";
const skip = gitAvailable ? false : "git executable unavailable";

const cmd = (id: string, args: string[] = []): VerificationCommand =>
  Object.freeze({ id, executable: "/usr/local/bin/node", args: Object.freeze(args), cwd: ".", timeoutMs: 60_000, mutationPolicy: "readOnly" as const });
const SCOPE: ChangeScope = { allowedPaths: ["src/huge.js", "src/lib.js", "test/lib.test.js"], forbiddenPaths: [] };
const BASE_LIB = "export const round = (x) => Math.round(x);\nexport const fmt = (x) => `${x}`;\n";
const FIXED_LIB = "export const round = (x) => Math.round(x * 100) / 100;\nexport const fmt = (x) => `${x}`;\n";
const WRONG_LIB = "export const round = (x) => Math.round(x * 100) / 100;\nexport const fmt = (x) => `v${x}`;\n";
const BASELINE = { "src/lib.js": BASE_LIB, "test/lib.test.js": "t\n" };
const fix = (content: string): ChangeSet => changeSet([["src/lib.js", BASE_LIB, content]]);
function target(candidate: "c1" | "c2" | "c3", changes: ChangeSet): MaterializedTarget {
  // The ledger the candidate was judged on, as the port produces it.
  const applied: AppliedOperation[] = changes.operations.map(op => op.kind === "delete"
    ? { kind: op.kind, path: op.path, beforeSha256: op.expectedSha256, afterSha256: null, bytes: 0 }
    : { kind: op.kind, path: op.path, beforeSha256: op.expectedSha256, afterSha256: sha256(op.content), bytes: Buffer.byteLength(op.content) });
  return { candidate, revision: `rev-${candidate}`, changes, scope: SCOPE, patchSha256: patchSha256(applied) };
}
/** A program: `fmt` prints the formatter's output (a preservation probe), `round` checks the fix, property finds a
 *  counterexample only in a tree without the fix, fuzz always passes. */
const PROGRAM: Program = (command, tree) => {
  const lib = tree.get("src/lib.js") ?? "";
  switch (command.id) {
    case "probe-fmt": return { exit: 0, stdout: lib.includes("`v${x}`") ? "v1\n" : "1\n" };
    case "probe-round": return { exit: lib.includes("x * 100") ? 0 : 1, stdout: lib.includes("x * 100") ? "1.23\n" : "1\n" };
    case "probe-shape": return { exit: 0, stdout: lib.length % 2 === 0 ? "even\n" : "odd\n" };
    case "property-round": return lib.includes("x * 100") ? { exit: 0, stdout: "200 cases ok\n" } : { exit: 1, stdout: "counterexample: 1.005\n" };
    case "fuzz-parse": return { exit: 0, stdout: "no crash\n" };
    case "unit": return { exit: lib.includes("x * 100") ? 0 : 1, stdout: "" };
    default: return { exit: 2, stdout: "unknown\n" };
  }
};
const SPECS: ExperimentSpecs = Object.freeze({
  probes: Object.freeze([
    Object.freeze({ id: "fmt", command: cmd("probe-fmt"), expect: Object.freeze({ kind: "baseline" as const }) }),
    Object.freeze({ id: "round", command: cmd("probe-round"), expect: Object.freeze({ kind: "output" as const, exitCode: 0, stdout: "1.23\n" }) }),
    Object.freeze({ id: "shape", command: cmd("probe-shape"), expect: Object.freeze({ kind: "compare" as const }) })]),
  property: Object.freeze([Object.freeze({ id: "round", command: cmd("property-round", ["prop.js"]), seedArg: "--seed", casesArg: "--cases", cases: 200 })]),
  fuzz: Object.freeze([Object.freeze({ id: "parse", command: cmd("fuzz-parse", ["fuzz.js"]), seedArg: "--seed", casesArg: "--runs", cases: 500 })]),
  mutation: Object.freeze({ enabled: true, maxPerCandidate: 2 }),
});
const PROFILE = "a".repeat(64);
const result = (nodes: readonly { id: string; result: string }[], id: string): string | undefined => nodes.find(n => n.id === id)?.result;

// ---------------------------------------------------------------------------------------------------------------
// Configuration

const CONFINED = [{ id: "unit", executable: "/usr/local/bin/node", args: ["--test"], cwd: ".", timeoutMs: 60_000, mutationPolicy: "readOnly" }];
const experimentConfig = (experiments: unknown) => ({ schemaVersion: 1, verification: { commands: [], confinedCommands: CONFINED, experiments } });
const probeCommand = { executable: "/usr/local/bin/node", args: ["probe.js"], cwd: ".", timeoutMs: 30_000, mutationPolicy: "readOnly" };

test("v0.5 experiments config: strict, bounded, read-only confined commands whose ids Fusion derives", () => {
  const parsed = parseConfig(experimentConfig({
    probes: [{ id: "fmt", command: probeCommand, expect: "baseline" }, { id: "cli", command: probeCommand, expect: { exitCode: 0, stdout: "ok\n" } },
      { id: "shape", command: probeCommand, expect: "compare" }],
    property: [{ id: "round", command: probeCommand, seedArg: "--seed", casesArg: "--cases", cases: 100 }],
    fuzz: [{ id: "parse", command: probeCommand, seedArg: "--seed", casesArg: "--runs", cases: 500 }],
    mutation: { maxPerCandidate: 3 } })).verification.experiments!;
  assert.deepEqual(parsed.probes.map(p => p.command.id), ["probe-fmt", "probe-cli", "probe-shape"]);
  assert.deepEqual(parsed.probes.map(p => p.expect), [{ kind: "baseline" }, { kind: "output", exitCode: 0, stdout: "ok\n" }, { kind: "compare" }]);
  assert.equal(parsed.property[0]!.command.id, "property-round");
  assert.equal(parsed.fuzz[0]!.command.id, "fuzz-parse");
  assert.deepEqual(parsed.mutation, { enabled: true, maxPerCandidate: 3 });
  assert.equal(parseConfig(experimentConfig({})).verification.experiments!.mutation.enabled, false, "mutations are opt-in");
  assert.equal(parseConfig({ schemaVersion: 1, verification: { commands: [] } }).verification.experiments, undefined);

  const probe = (patch: Record<string, unknown>) => experimentConfig({ probes: [{ id: "p", command: probeCommand, expect: "baseline", ...patch }] });
  const refused: Array<[string, unknown]> = [
    ["a command id of its own", probe({ command: { ...probeCommand, id: "unit" } })],
    ["a host executable", probe({ command: { ...probeCommand, executable: "C:\\tools\\node.exe" } })],
    ["a mutating command", probe({ command: { ...probeCommand, mutationPolicy: "allowMutation" } })],
    ["an unknown expectation", probe({ expect: "whatever" })],
    ["an exit code out of range", probe({ expect: { exitCode: 256 } })],
    ["an unknown key", probe({ weight: 2 })],
    ["an unsafe id", probe({ id: "../x" })],
    ["too many probes", experimentConfig({ probes: Array.from({ length: TOURNAMENT_LIMITS.maxProbes + 1 }, (_, i) =>
      ({ id: `p${i}`, command: probeCommand, expect: "baseline" })) })],
    ["a duplicate id", experimentConfig({ probes: [{ id: "p", command: probeCommand, expect: "baseline" }],
      property: [{ id: "p", command: probeCommand, seedArg: "--seed", casesArg: "--cases", cases: 1 }] })],
    ["too many property cases", experimentConfig({ property: [{ id: "r", command: probeCommand, seedArg: "--seed", casesArg: "--cases",
      cases: TOURNAMENT_LIMITS.maxPropertyCases + 1 }] })],
    ["an argument that is not a flag", experimentConfig({ fuzz: [{ id: "f", command: probeCommand, seedArg: "; rm -rf /", casesArg: "--runs", cases: 1 }] })],
    ["too many mutations", experimentConfig({ mutation: { maxPerCandidate: TOURNAMENT_LIMITS.maxMutationsPerCandidate + 1 } })],
    ["an unknown section", experimentConfig({ oracle: "model" })],
    ["a shadowed confined check", { schemaVersion: 1, verification: { commands: [], experiments: { probes: [{ id: "p", command: probeCommand, expect: "baseline" }] },
      confinedCommands: [...CONFINED, { ...CONFINED[0], id: "probe-p" }] } }],
  ];
  for (const [what, config] of refused) assert.throws(() => parseConfig(config), invalidInput, what);
});

test("v0.5 experiments: the limits fit one confined run and seeds are deterministic, per experiment and profile", () => {
  assert.ok(TOURNAMENT_LIMITS.maxProbes + TOURNAMENT_LIMITS.maxPropertyRuns + TOURNAMENT_LIMITS.maxFuzzRuns <= 8);
  const commands = experimentCommands(SPECS, PROFILE);
  assert.deepEqual(commands.map(c => c.id), ["probe-fmt", "probe-round", "probe-shape", "property-round", "fuzz-parse"]);
  const seed = experimentSeed(PROFILE, "property-round");
  assert.deepEqual(commands[3]!.args, ["prop.js", "--seed", String(seed), "--cases", "200"]);
  assert.equal(experimentSeed(PROFILE, "property-round"), seed);
  assert.notEqual(experimentSeed("b".repeat(64), "property-round"), seed);
  assert.deepEqual(SPECS.property[0]!.command.args, ["prop.js"], "the configured command is never changed");
});

// ---------------------------------------------------------------------------------------------------------------
// Execution

test("v0.5 experiments: probes, property and fuzz runs become revision-bound mesh nodes; each experiment runs exactly once", async () => {
  const port = new GuestPort(BASELINE, PROGRAM);
  const reference = await runBaselineProbes(port, "run.baseline", SPECS);
  assert.equal(reference.observations.get("fmt")?.complete, true);
  assert.deepEqual(port.runs.map(r => [r.baseline, r.commands]), [[true, ["probe-fmt"]]], "only the baseline probes run on the baseline");

  const good = await runCandidateExperiments(port, "run.c1.x", target("c1", fix(FIXED_LIB)), SPECS, PROFILE, reference.observations);
  assert.equal(good.violation, undefined);
  assert.deepEqual(good.nodes.map(n => [n.id, n.result]), [["probe:fmt", "pass"], ["probe:round", "pass"], ["probe:shape", "observed"],
    ["property:round", "pass"], ["fuzz:parse", "pass"]]);
  assert.ok(good.nodes.every(n => n.candidate === "c1" && n.revision === "rev-c1" && n.authority === "deterministic" && n.source === "configured"));
  assert.equal(good.nodes.find(n => n.id === "probe:fmt")!.obligation, "behaviorPreserved");
  assert.equal(good.reproducers.length, 0);
  assert.deepEqual(port.runs.slice(1).map(r => [r.baseline, r.commands.length]), [[false, 5]], "one confined run when nothing fails");
  assert.deepEqual([port.acquired.length, port.released.length, good.cleanup.length], [2, 2, 1]);
});

test("v0.5 experiments: a preservation difference fails, a counterexample is a replayable reproducer, and a failed run continues", async () => {
  const port = new GuestPort(BASELINE, PROGRAM);
  const reference = await runBaselineProbes(port, "run.baseline", SPECS);
  port.runs.length = 0;
  // A candidate that changes the formatter and misses the fix: probe-round fails (exit 1) and the guest stops there; Fusion
  // continues with the remaining experiments on a new materialization.
  const unfixed = changeSet([["src/lib.js", BASE_LIB, BASE_LIB.replace("`${x}`", "`v${x}`")]]);
  const batch = await runCandidateExperiments(port, "run.c3.x", target("c3", unfixed), SPECS, PROFILE, reference.observations);
  assert.deepEqual(batch.nodes.map(n => [n.id, n.result]), [["probe:fmt", "fail"], ["probe:round", "fail"], ["probe:shape", "observed"],
    ["property:round", "fail"], ["fuzz:parse", "pass"]]);
  assert.match(batch.nodes.find(n => n.id === "probe:fmt")!.detail, /differs from the unchanged baseline/u);
  assert.deepEqual(port.runs.map(r => r.commands), [
    ["probe-fmt", "probe-round", "probe-shape", "property-round", "fuzz-parse"],
    ["probe-shape", "property-round", "fuzz-parse"],
    ["fuzz-parse"]], "each run starts after the last command the previous one observed");
  assert.ok(port.runs.every(r => !r.baseline));
  assert.equal(port.released.length, port.acquired.length, "every materialization is released");
  assert.equal(batch.cleanup.length, 3);
  const seed = experimentSeed(PROFILE, "property-round");
  assert.deepEqual(batch.reproducers.map(r => [r.candidate, r.experiment, r.seed, r.cases]), [["c3", "property:round", seed, 200]]);
  assert.match(batch.reproducers[0]!.excerpt, /counterexample/u);
  assert.match(batch.nodes.find(n => n.id === "property:round")!.detail, new RegExp(`seed ${seed}`, "u"));
});

test("v0.5 experiments: a difference from the baseline in output alone fails the preservation probe", async () => {
  const port = new GuestPort(BASELINE, PROGRAM);
  const reference = await runBaselineProbes(port, "run.baseline", SPECS);
  const batch = await runCandidateExperiments(port, "run.c2.x", target("c2", fix(WRONG_LIB)), SPECS, PROFILE, reference.observations);
  assert.equal(result(batch.nodes, "probe:fmt"), "fail");
  assert.equal(result(batch.nodes, "probe:round"), "pass");
});

test("v0.5 experiments: nothing is compared that was not retained completely — truncated output is never a pass or a fail", async () => {
  const truncating: Program = (command, tree) => ({ ...PROGRAM(command, tree), truncated: command.id !== "fuzz-parse" });
  const port = new GuestPort(BASELINE, truncating);
  const reference = await runBaselineProbes(port, "run.baseline", SPECS);
  const batch = await runCandidateExperiments(port, "run.c1.x", target("c1", fix(FIXED_LIB)), SPECS, PROFILE, reference.observations);
  assert.equal(result(batch.nodes, "probe:fmt"), "notRun");
  assert.equal(result(batch.nodes, "probe:round"), "notRun", "an expected output cannot be checked on a truncated one");
  assert.equal(result(batch.nodes, "probe:shape"), "notRun");
  assert.equal(result(batch.nodes, "property:round"), "pass", "a property run is judged by its exit code");
  // A port that reports no output at all: an output expectation stays unchecked, exit-code-only experiments still count.
  const silent = new GuestPort(BASELINE, (command, tree) => ({ exit: PROGRAM(command, tree).exit }));
  const quiet = await runCandidateExperiments(silent, "run.c1.x", target("c1", fix(FIXED_LIB)), SPECS, PROFILE, new Map());
  assert.deepEqual(quiet.nodes.map(n => n.result), ["notRun", "notRun", "notRun", "pass", "pass"]);
});

test("v0.5 experiments: a timeout or a refusal detects nothing — the experiments stay unrun, never passed or failed", async () => {
  const timing: Program = (command, tree) => command.id === "property-round" ? { exit: null, status: "timeout" } : PROGRAM(command, tree);
  const port = new GuestPort(BASELINE, timing);
  const batch = await runCandidateExperiments(port, "run.c1.x", target("c1", fix(FIXED_LIB)), SPECS, PROFILE, new Map());
  assert.equal(result(batch.nodes, "property:round"), "notRun");
  assert.match(batch.nodes.find(n => n.id === "property:round")!.detail, /timeout/u);
  assert.equal(result(batch.nodes, "fuzz:parse"), "pass", "the run continues after a timeout");
  assert.equal(batch.reproducers.length, 0);

  const refusing = new GuestPort(BASELINE, PROGRAM);
  refusing.refuse = "confinementNotAccepted";
  const refused = await runCandidateExperiments(refusing, "run.c1.x", target("c1", fix(FIXED_LIB)), SPECS, PROFILE, new Map());
  assert.ok(refused.nodes.every(n => n.result === "notRun" && /refused \(confinementNotAccepted\)/u.test(n.detail)));
  assert.equal(refusing.runs.length, 1, "a refusal is not retried");
  // The mesh turns unrun required experiments into an incomplete verification, which never passes.
  const { profile } = freezeProfile({ policyVersion: "v0.5-route-1", commands: [cmd("unit")], baseline: { reproduced: true, failing: ["unit"] },
    obligations: [{ kind: "verificationPassed", tier: "safety" }], falsification: "optional", experiments: SPECS });
  const verdict = meshVerdict({ passed: true, commandsRun: 1 }, profile, refused.nodes).verdict!;
  assert.equal(verdict.passed, false);
});

test("v0.5 experiments: Fusion's re-materialization must reproduce the judged tree; a foreign or primary candidate is a violation", async () => {
  const port = new GuestPort(BASELINE, PROGRAM);
  port.tamperLedger = true;
  const tampered = await runCandidateExperiments(port, "run.c1.x", target("c1", fix(FIXED_LIB)), SPECS, PROFILE, new Map());
  assert.match(tampered.violation ?? "", /different tree/u);
  assert.equal(port.runs.length, 0, "nothing runs on a candidate that is not the judged one");
  assert.ok(tampered.nodes.every(n => n.result === "notRun"));
  assert.deepEqual(port.released, port.applied, "the one candidate Fusion applied to is released");
  assert.equal(port.released.length, 1);

  for (const hostile of [(lease: string) => join(tmpdir(), "fusion-v05-guest", "primary", lease), () => join(tmpdir(), "elsewhere"),
    () => join(tmpdir(), "fusion-v05-guest", "candidates")]) {
    const foreign = new GuestPort(BASELINE, PROGRAM);
    foreign.handlePath = hostile;
    const batch = await runCandidateExperiments(foreign, "run.c1.x", target("c1", fix(FIXED_LIB)), SPECS, PROFILE, new Map());
    assert.match(batch.violation ?? "", /outside its private root/u);
    assert.equal(foreign.applied.length, 0, "nothing is applied to a candidate outside the private root");
    assert.equal(foreign.released.length, 1);
  }
  const stale = new GuestPort({ ...BASELINE, "src/lib.js": "moved on\n" }, PROGRAM);
  const gone = await runCandidateExperiments(stale, "run.c1.x", target("c1", fix(FIXED_LIB)), SPECS, PROFILE, new Map());
  assert.equal(gone.violation, undefined);
  assert.ok(gone.nodes.every(n => n.result === "notRun" && /no longer applies/u.test(n.detail)));

  const exploding = new GuestPort(BASELINE, PROGRAM);
  exploding.throwOnVerify = true;
  await assert.rejects(runCandidateExperiments(exploding, "run.c1.x", target("c1", fix(FIXED_LIB)), SPECS, PROFILE, new Map()), /exploded/u);
  assert.equal(exploding.released.length, 1, "a candidate is released even when the backend throws");
});

test("v0.5 mutations: derived from the baseline Fusion reads itself; killed, survived and unverifiable are kept apart", async () => {
  const two = "export const round = (x) => Math.round(x * 100) / 100;\nexport const fmt = (x) => `${x}`;\nexport const extra = 1;\n";
  const changes = changeSet([["src/lib.js", BASE_LIB, two], ["test/lib.test.js", "t\n", "t2\n"]]);
  const port = new GuestPort(BASELINE, PROGRAM);
  const planned = await planCandidateMutations(port, "run.c1.m", "c1", changes, 3);
  assert.deepEqual(planned.plan.mutations.map(m => m.path), ["src/lib.js", "src/lib.js"]);
  assert.deepEqual(planned.plan.notMutated, [{ path: "test/lib.test.js", reason: "a test file is not mutated" }]);
  assert.equal(port.released.length, 1);

  const commonPlan: VerificationPlan = { commands: [cmd("unit")] };
  const batch = await runMutations(port, "run.c1.m", target("c1", changes), planned.plan.mutations, commonPlan);
  // Reverting the rounding fix is detected by `unit` (killed); reverting the unrelated addition is not (survived).
  assert.deepEqual(batch.nodes.map(n => [n.id, n.result]), [["mutation:m1", "pass"], ["mutation:m2", "fail"]]);
  assert.match(batch.nodes[0]!.detail, /killed/u);
  assert.match(batch.nodes[1]!.detail, /survived/u);
  assert.ok(batch.nodes.every(n => n.source === "fusion" && n.authority === "deterministic" && n.revision === "rev-c1"));
  assert.equal(port.released.length, port.acquired.length);

  // A timeout never kills a mutation; a refusal leaves it unverified.
  const timing = new GuestPort(BASELINE, () => ({ exit: null, status: "timeout" }));
  const timed = await runMutations(timing, "run.c1.m", target("c1", changes), planned.plan.mutations, commonPlan);
  assert.ok(timed.nodes.every(n => n.result === "notRun"));

  // Files Fusion cannot read exactly are not mutated, and it says why.
  const huge = changeSet([["src/huge.js", "a\n", "b\n"], ["src/lib.js", BASE_LIB, FIXED_LIB]]);
  const bigPort = new GuestPort({ ...BASELINE, "src/huge.js": "a\n" }, PROGRAM);
  const bigPlan = await planCandidateMutations(bigPort, "run.c1.m", "c1", huge, 3);
  assert.deepEqual(bigPlan.plan.notMutated, [{ path: "src/huge.js", reason: "larger than the sharing bound" }]);
  const drifted = new GuestPort({ ...BASELINE, "src/lib.js": "drifted\n" }, PROGRAM);
  const driftPlan = await planCandidateMutations(drifted, "run.c1.m", "c1", fix(FIXED_LIB), 3);
  assert.deepEqual(driftPlan.plan.notMutated, [{ path: "src/lib.js", reason: "its baseline could not be read exactly" }]);
  assert.equal(driftPlan.plan.mutations.length, 0);
  const none = await planCandidateMutations(new GuestPort(BASELINE, PROGRAM), "run.c1.m", "c1", fix(FIXED_LIB), 0);
  assert.equal(none.plan.mutations.length, 0);
  assert.equal(none.cleanup.length, 0, "no candidate is materialized when no mutation is wanted");
});

test("v0.5 experiments: no experiments configured means no confined run at all", async () => {
  const port = new GuestPort(BASELINE, PROGRAM);
  const reference = await runBaselineProbes(port, "run.baseline", NO_EXPERIMENTS);
  const batch = await runCandidateExperiments(port, "run.c1.x", target("c1", fix(FIXED_LIB)), NO_EXPERIMENTS, PROFILE, reference.observations);
  assert.deepEqual([batch.nodes.length, port.acquired.length], [0, 0]);
});

// ---------------------------------------------------------------------------------------------------------------
// The real candidate port and Docker backend (in-memory daemon)

test("v0.5 port: confined verification reports each command's retained output digest, and whether it was complete", { skip }, () =>
  withRehearsalRepo(async repo => {
    const attach = (context: { manifest: Parameters<typeof passingResult>[0] }) => {
      const commands = context.manifest.commands.map((command: GuestCommand) => {
        const long = command.id === "unit";
        const stdoutTail = long ? "y".repeat(8_192) : `${command.id} out\n`;
        return { id: command.id, status: "exited", exitCode: 0, signal: null, durationMs: 0, stdoutTail, stderrTail: "",
          stdoutBytes: long ? 20_000 : Buffer.byteLength(stdoutTail), stderrBytes: 0 };
      });
      return { stdout: `${passingResult(context.manifest, { commands, notRun: [] })}\n`, containerExitCode: 0 };
    };
    const { port } = await rig(repo, { docker: { attach } });
    const handle = await port.acquire("v05.observations");
    try {
      const verdict = await port.verifyBaseline(handle, REHEARSAL_PLAN);
      assert.equal(verdict.passed, true);
      const observed = new Map((verdict.observations ?? []).map(o => [o.id, o]));
      assert.equal(observed.get("typecheck")?.stdoutSha256, sha256("typecheck out\n"));
      assert.equal(observed.get("typecheck")?.complete, true);
      assert.equal(observed.get("unit")?.complete, false, "a truncated tail is marked incomplete");
      assert.ok((observed.get("unit")?.excerpt.length ?? 0) <= 2_000, "the in-memory excerpt is bounded");
    } finally { await port.release(handle); }
  }));

test("v0.5 port: the baseline texts are read from a pristine candidate only", { skip }, () =>
  withRehearsalRepo(async repo => {
    const { port } = await rig(repo);
    const pristine = await port.acquire("v05.baseline");
    try {
      const texts = await port.baselineTexts(pristine, ["src/quote.ts", "src/missing.ts"]);
      assert.equal(texts.get("src/quote.ts"), QUOTE_BUGGY);
      assert.equal(texts.get("src/missing.ts"), null);
    } finally { await port.release(pristine); }
    const changed = await port.acquire("v05.changed");
    try {
      const outcome = await port.apply(changed, changeSet([["src/quote.ts", QUOTE_BUGGY, QUOTE_FIXED]]), { allowedPaths: ["src/quote.ts"], forbiddenPaths: [] });
      assert.ok("applied" in outcome);
      await assert.rejects(port.baselineTexts(changed, ["src/quote.ts"]), (error: unknown) => error instanceof FusionFailure);
    } finally { await port.release(changed); }
  }));
