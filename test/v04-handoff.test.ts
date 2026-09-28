import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "../src/app/commands.js";
import { ControlPlane } from "../src/app/control-plane.js";
import { evidenceBasis } from "../src/app/evidence-basis.js";
import { newSessionState, noOrchestration, noReliability, planTurn, readSessionMetadata, writeSessionMetadata } from "../src/app/session.js";
import type { WriterRehearsal } from "../src/app/writer-rehearsal.js";
import { renderReliability } from "../src/cli/shell.js";
import { assembleBuildEvidence } from "../src/core/evidence/build.js";
import { EvidenceGraph } from "../src/core/evidence/graph.js";
import { validateHandoff, type DiagnosisHandoff } from "../src/core/evidence/handoff.js";
import { reliabilityPlan } from "../src/core/evidence/policy.js";
import { classifyIntent } from "../src/core/intent.js";
import { DockerLinuxVerificationBackend } from "../src/platform/verification/docker/backend.js";
import { VerificationService } from "../src/platform/verification/selection.js";
import { OFFLINE_REHEARSAL, PrivateCandidateWorkspacePort } from "../src/platform/workflow/candidates.js";
import { FAKE_DOCKER_EXE, FAKE_IMAGE, FakeDocker, type AttachContext } from "./fixtures/fake-docker.js";
import { oracle, scriptedRoles, testSummary } from "./fixtures/fake-writer.js";
import { FAKE_DEPENDENCY_TREE, REHEARSAL_PLAN } from "./fixtures/rehearsal-project.js";
import { FIX_ONLY, gitAvailable, LOW_TASK, rehearsalOracle, withRehearsalRepo } from "./fixtures/writer-rehearsal-harness.js";

/**
 * v0.4 PR E — THE DIAGNOSIS → FIX HANDOFF, as executable invariants: what a claim check established about a finding is carried
 * into the build as host data with its basis (the checkout's fingerprint then); the build records it as a claim of its own, next
 * to its own root-cause claim, and never adds its verification to it (a passing build does not promote a finding);
 * evidence of an older state is STALE and never satisfies the obligation; competing hypotheses must be addressed; a finding
 * Fusion's checks contradicted is not fixed as stated; the session keeps safe reliability counts.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const BASIS = `files:${"a".repeat(64)}`;
const handoff = (patch: Partial<DiagnosisHandoff> = {}): DiagnosisHandoff => ({ claim: "src/quote.ts taxes the full subtotal", source: "verification",
  status: "SUPPORTED", checks: [{ file: "src/quote.ts", text: "basisPoints(subtotal, quote.taxBasisPoints)", expect: "present", present: true, holds: true }],
  alternatives: [], openChallenges: 0, files: ["src/quote.ts"], basis: BASIS, ...patch });
const low = { level: "low" as const, signals: [], decisive: [], revision: 0 };
/** A completed run that changed src/quote.ts, verified; `reproduced`: the unit check failed on the unchanged baseline. */
const runResult = (reproduced: boolean) => ({ state: "completed" as const, transitions: [], delegateAttempts: 1, reviews: [], changedPaths: ["src/quote.ts"],
  verification: { passed: true, commandsRun: 1, evidence: { backendId: "docker-linux", confinement: "osSandbox", platformRequirement: "linux-compatible",
    acceptance: "granted" as const, commands: [{ id: "unit", status: "passed", exitCode: 0 }] } },
  reproduction: { ran: true as const, verdict: { passed: !reproduced, commandsRun: 1, evidence: { backendId: "docker-linux", confinement: "osSandbox",
    platformRequirement: "linux-compatible", acceptance: "granted" as const, commands: [{ id: "unit", status: reproduced ? "failed" : "passed", exitCode: reproduced ? 1 : 0 }] } } } });
const evidenceOf = (diagnosis: DiagnosisHandoff, currentBasis: string, reproduced = false) => assembleBuildEvidence({ task: LOW_TASK.summary, scope: ["src/quote.ts"],
  plan: reliabilityPlan({ taskClass: "bugFix", sensitive: false }, low, { alternatives: diagnosis.alternatives.length }), plannedCommands: 1,
  result: runResult(reproduced), protectedChanged: [], baseCommit: "b".repeat(40), diagnosis, currentBasis });
const obligation = (evidence: ReturnType<typeof evidenceOf>, kind: string) => evidence.decision.obligations.find(o => o.kind === kind);

test("v0.4 handoff contract: host data, validated again at the build — a malformed or inconsistent handoff is dropped, never repaired", () => {
  assert.deepEqual(validateHandoff(handoff()), handoff());
  for (const bad of [handoff({ basis: `primary:${"a".repeat(64)}` }), handoff({ status: "PROBABLY" as never }), { ...handoff(), checks: [{ ...handoff().checks[0]!, holds: false }] },
    handoff({ files: ["../escape"] }), { ...handoff(), checks: Array(10).fill(handoff().checks[0]) }, { ...handoff(), openChallenges: -1 }])
    assert.equal(validateHandoff(bad), undefined, JSON.stringify(bad).slice(0, 80));
});

test("v0.4 invariant 12 (handoff): the claim check's evidence supports the root cause only against the checkout it was observed on", () => {
  const fresh = evidenceOf(handoff(), BASIS);
  assert.equal(fresh.graph.claims.find(c => c.id === "finding")?.statement, "src/quote.ts taxes the full subtotal", "the checked finding is its own claim");
  assert.deepEqual([obligation(fresh, "rootCauseSupported")?.status, obligation(fresh, "defectReproduced")?.status], ["PASS", "UNKNOWN"]);
  const stale = evidenceOf(handoff(), `files:${"c".repeat(64)}`);
  assert.deepEqual([obligation(stale, "rootCauseSupported")?.status, obligation(stale, "rootCauseSupported")?.reason],
    ["UNKNOWN", "its evidence is stale: the repository changed after it was observed"]);
  // Fusion's own fail-before/pass-after of THIS build is current whatever happened before.
  assert.equal(obligation(evidenceOf(handoff(), `files:${"c".repeat(64)}`, true), "rootCauseSupported")?.status, "PASS");
  // A handoff that Fusion's checks contradicted contradicts the root cause (if it ever reaches a build).
  const refuted = evidenceOf(handoff({ status: "CONTRADICTED", checks: [{ file: "src/quote.ts", text: "x", expect: "present", present: false, holds: false }] }), BASIS);
  assert.deepEqual([obligation(refuted, "rootCauseSupported")?.status, refuted.decision.decision], ["FAIL", "BLOCKED"]);
});

test("v0.4 L5 separation: an UNVERIFIED finding does not forbid a fix the build proves itself — and the build never promotes the finding", () => {
  // The first real v0.4 L5: the finding's claim check ended UNVERIFIED (no check ran); the build then proved its own obligations.
  // Before this fix the build's root-cause claim WAS the finding's text, and its fail-before/pass-after made that text SUPPORTED.
  const unverified = handoff({ status: "UNVERIFIED", checks: [] });
  for (const taskClass of ["bugFix", "configFix"] as const) {
    const built = assembleBuildEvidence({ task: LOW_TASK.summary, scope: ["src/quote.ts"], plan: reliabilityPlan({ taskClass, sensitive: false }, low, { alternatives: 0 }),
      plannedCommands: 1, result: runResult(true), protectedChanged: [], baseCommit: "b".repeat(40), diagnosis: unverified, currentBasis: BASIS });
    assert.equal(built.decision.decision, "VERIFIED", taskClass);
    const graph = EvidenceGraph.from(built.graph);
    assert.deepEqual([graph.assess("finding").status, graph.assess("root-cause").status], ["UNVERIFIED", "SUPPORTED"], taskClass);
    assert.equal(built.graph.claims.find(c => c.id === "root-cause")?.statement, "The defect lies within the confirmed scope: src/quote.ts.");
    assert.deepEqual(built.graph.evidence.filter(e => e.claim === "finding").map(e => e.source), [], "the build adds nothing to the finding");
  }
  // A finding the claim check SUPPORTED keeps exactly the claim check's evidence (its checks), not the build's.
  const supported = EvidenceGraph.from(evidenceOf(handoff(), BASIS, true).graph);
  assert.deepEqual(supported.claims.filter(c => c.id === "finding").length, 1);
  assert.deepEqual(evidenceOf(handoff(), BASIS, true).graph.evidence.filter(e => e.claim === "finding").map(e => e.source), ["fileCheck"]);
});

test("v0.4 alternatives: competing hypotheses of a diagnosis must be addressed — contradicted ones are, untested ones are not", () => {
  const diagnosis = (statuses: Array<"SUPPORTED" | "CONTRADICTED" | "UNVERIFIED">) => handoff({ source: "diagnosis",
    alternatives: statuses.map((status, i) => ({ statement: `alternative ${i + 1}`, status })) });
  assert.equal(obligation(evidenceOf(diagnosis(["CONTRADICTED", "CONTRADICTED"]), BASIS), "alternativesAddressed")?.status, "PASS");
  assert.equal(obligation(evidenceOf(diagnosis(["CONTRADICTED", "UNVERIFIED"]), BASIS), "alternativesAddressed")?.status, "UNKNOWN");
  assert.equal(obligation(evidenceOf(diagnosis(["SUPPORTED"]), BASIS), "alternativesAddressed")?.status, "FAIL");
  assert.equal(obligation(evidenceOf(diagnosis(["CONTRADICTED"]), `files:${"c".repeat(64)}`), "alternativesAddressed")?.status, "UNKNOWN",
    "a stale contradiction settles nothing either");
  assert.equal(obligation(evidenceOf(handoff(), BASIS), "alternativesAddressed"), undefined, "a verification has no competing hypotheses");
});

test("v0.4 fix-it: the verified finding's handoff travels with the task; a contradicted finding is not fixed as stated", () => {
  const state = newSessionState();
  state.findings = ["src/quote.ts: tax is computed on the full subtotal.", "README.md: stale."];
  state.verified = { index: 0, source: "investigations", cited: ["src/quote.ts"], supported: 2, contradicted: 0, status: "SUPPORTED",
    checks: { ran: 1, supported: 1, contradicted: 0 }, handoff: handoff() };
  state.focus = 0;
  const plan = planTurn(classifyIntent("fix it"), state, "git");
  assert.equal(plan.kind, "change");
  if (plan.kind === "change") {
    assert.deepEqual(plan.diagnosis, handoff());
    assert.match(plan.task, /^\(Fusion's checks of this finding: SUPPORTED — 1 consistent, 0 contradicted\)$/mu);
  }
  assert.equal((planTurn(classifyIntent("fix the second finding"), state, "git") as { diagnosis?: unknown }).diagnosis, undefined, "only the verified finding");
  state.verified = { ...state.verified, status: "CONTRADICTED", checks: { ran: 1, supported: 0, contradicted: 1 } };
  const refused = planTurn(classifyIntent("fix the first finding"), state, "git");
  assert.equal(refused.kind, "clarify");
  assert.match(refused.kind === "clarify" ? refused.question : "", /^Fusion's own checks contradict this finding \(1 check\(s\) did not come out as it predicts\)/u);
  // A diagnosis's findings carry the diagnosis's handoff (its leading hypothesis and the competing ones).
  const diagnosed = newSessionState();
  diagnosed.findings = ["configuration.yaml: add trusted_proxies."];
  diagnosed.findingsFrom = "diagnosis";
  diagnosed.diagnosis = handoff({ source: "diagnosis", alternatives: [{ statement: "the proxy header is missing", status: "CONTRADICTED" }] });
  const fix = planTurn(classifyIntent("fix the first finding"), diagnosed, "git");
  assert.equal(fix.kind === "change" ? fix.diagnosis?.source : undefined, "diagnosis");
});

// ---------------------------------------------------------------- end to end through fusion build

const CONFIG = JSON.stringify({ schemaVersion: 1, bindings: [], verification: { commands: [], platformRequirement: "linux-compatible" } });
const REGISTRY = { defaults: { schemaVersion: 1 as const, bindings: [], verification: { commands: [] }, limits: { runTimeoutMs: 600_000 } }, factories: new Map() };
function seam(dir: string, attach: (context: AttachContext) => unknown): WriterRehearsal {
  const backend = new DockerLinuxVerificationBackend({ image: FAKE_IMAGE, runner: new FakeDocker({ attach: attach as never, depsTree: FAKE_DEPENDENCY_TREE }),
    resolveDocker: () => Promise.resolve(FAKE_DOCKER_EXE), dependencyStoreDirectory: join(dir, "dependency-store") });
  return { roles: scriptedRoles({ worker: () => FIX_ONLY }).roles, plan: REHEARSAL_PLAN, candidatePort: ({ primaryRoot, git, declaredPlatform }) =>
    new PrivateCandidateWorkspacePort({ primaryRoot, git, service: new VerificationService([backend]), confinement: OFFLINE_REHEARSAL,
      declaredPlatform, dependencies: "npm-lockfile", prepareDependencies: true }) };
}

test("v0.4 build with a handoff: the checked finding can establish the root cause; after one of its files changes, its evidence is stale", { skip }, async () =>
  withRehearsalRepo(async repo => {
    const env = { ...process.env, LOCALAPPDATA: join(repo.dir, "state"), XDG_STATE_HOME: join(repo.dir, "xdg") };
    // Checks that pass on the baseline: the build cannot reproduce the defect, so the root cause rests on the handoff alone.
    const alwaysPass = oracle(() => ({ pass: true, stdout: testSummary(10, 0) }));
    const plane = new ControlPlane({ registry: REGISTRY, env, cwd: repo.root, writerRehearsal: seam(repo.dir, alwaysPass) });
    // The basis the shell records right after the claim check: the digest of the files the evidence rests on.
    const diagnosis = handoff({ basis: await evidenceBasis(repo.root, ["src/quote.ts"]) });
    const options = { task: LOW_TASK.summary, paths: ["src/quote.ts"], operation: "edit" as const, diagnosis };
    const first = await build(plane, options);
    const root = (report: typeof first) => report.evidence?.decision.obligations.find(o => o.kind === "rootCauseSupported");
    assert.equal(first.evidence?.graph.claims.find(c => c.id === "finding")?.statement, "src/quote.ts taxes the full subtotal");
    assert.equal(root(first)?.status, "PASS", JSON.stringify(first.evidence?.decision.obligations));
    // An unrelated change leaves the evidence current; a change to a file it rests on makes it stale.
    await writeFile(join(repo.root, "notes.txt"), "the user kept working\n");
    assert.equal(root(await build(plane, options))?.status, "PASS");
    await writeFile(join(repo.root, "src", "quote.ts"), "export const edited = true;\n");
    const stale = await build(plane, options);
    assert.deepEqual([root(stale)?.status, root(stale)?.reason], ["UNKNOWN", "its evidence is stale: the repository changed after it was observed"]);
    // With Fusion's own reproduction (fail before, pass after), the build proves the root cause itself, stale handoff or not.
    const reproducing = new ControlPlane({ registry: REGISTRY, env, cwd: repo.root, writerRehearsal: seam(repo.dir, rehearsalOracle()) });
    assert.equal(root(await build(reproducing, options))?.status, "PASS");
  }, { extraFiles: { "fusion.config.json": CONFIG } }));

// ---------------------------------------------------------------- metrics

test("v0.4 metrics: the session metadata keeps safe reliability counts (version 3); v1 and v2 files still read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "v04-metrics-"));
  try {
    const path = join(dir, "session.json");
    const state = newSessionState();
    Object.assign(state.reliability, { claimChecks: 2, fusionChecks: 5, contradictedClaims: 1, falsifications: 2, falsifierBreaks: 1, verifiedBuilds: 1 });
    assert.equal(await writeSessionMetadata(path, "git", state, new Date("2026-09-28T10:00:00.000Z")), true);
    const stored = await readSessionMetadata(path);
    assert.deepEqual([stored?.version, stored?.reliability], [3, { ...noReliability(), claimChecks: 2, fusionChecks: 5, contradictedClaims: 1, falsifications: 2,
      falsifierBreaks: 1, verifiedBuilds: 1 }]);
    assert.ok(!(await readFile(path, "utf8")).includes("claim\""), "counts only");
    await writeFile(path, JSON.stringify({ format: "fusion.shellSession", version: 2, source: "git", lastUsedAt: "2026-09-27T09:00:00.000Z", sessions: 1, turns: 1,
      analyses: 0, changeRequests: 0, lastDeliveryId: null, orchestration: noOrchestration() }));
    assert.deepEqual([(await readSessionMetadata(path))?.version, (await readSessionMetadata(path))?.reliability], [3, noReliability()]);
    await writeFile(path, JSON.stringify({ format: "fusion.shellSession", version: 3, source: "git", lastUsedAt: "2026-09-27T09:00:00.000Z", sessions: 1, turns: 1,
      analyses: 0, changeRequests: 0, lastDeliveryId: null, orchestration: noOrchestration(), reliability: { ...noReliability(), claimChecks: -1 } }));
    assert.equal(await readSessionMetadata(path), undefined, "a malformed count is refused");
    assert.equal(renderReliability(noReliability()), undefined);
    assert.equal(renderReliability({ ...noReliability(), claimChecks: 1, fusionChecks: 2, contradictedClaims: 1, falsifications: 1, blockedBuilds: 1 }),
      "Evidence: 1 claim check (2 Fusion checks, 1 contradicted), 1 falsification (0 broke a conclusion); builds: 0 verified, 0 unverified, 1 blocked.");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
