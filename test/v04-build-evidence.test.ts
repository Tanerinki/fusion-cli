import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { WriterRehearsal } from "../src/app/writer-rehearsal.js";
import { renderBuild, evidenceLines } from "../src/cli/render.js";
import { renderReadyToApply } from "../src/cli/build-flow.js";
import { runCli } from "../src/cli/run.js";
import { assembleBuildEvidence, commandOutcomes } from "../src/core/evidence/build.js";
import { parseEvidenceGraph } from "../src/core/evidence/graph.js";
import { reliabilityPlan } from "../src/core/evidence/policy.js";
import { FusionFailure } from "../src/core/errors.js";
import type { VerificationVerdict } from "../src/core/workflow/types.js";
import { EventStore } from "../src/platform/events/event-store.js";
import { DockerLinuxVerificationBackend } from "../src/platform/verification/docker/backend.js";
import { VerificationService } from "../src/platform/verification/selection.js";
import { OFFLINE_REHEARSAL, PrivateCandidateWorkspacePort } from "../src/platform/workflow/candidates.js";
import { FAKE_DOCKER_EXE, FAKE_IMAGE, FakeDocker, type AttachContext } from "./fixtures/fake-docker.js";
import { changeSet, oracle, scriptedRoles, testSummary, type Script } from "./fixtures/fake-writer.js";
import { FAKE_DEPENDENCY_TREE, QUOTE_BUGGY, QUOTE_FIXED, QUOTE_WRONG, REHEARSAL_PLAN } from "./fixtures/rehearsal-project.js";
import { candidateGone, FIX, FIX_ONLY, gitAvailable, LOW_TASK, rehearsalOracle, rehearse, rig, transitionsOf, withRehearsalRepo } from "./fixtures/writer-rehearsal-harness.js";

/**
 * v0.4 PR B — THE BUILD ROUTE'S EVIDENCE: Fusion runs its own confined checks on the unchanged baseline (a reproduction, no
 * model turn), assembles the run's evidence from host observations only, records the decision BEFORE any delivery exists and
 * lets it gate the delivery. Real engine, real candidate port over real Git, real Docker backend over the in-memory daemon.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const bugFix = (level: Parameters<typeof reliabilityPlan>[1]) => reliabilityPlan({ taskClass: "bugFix", sensitive: false }, level);
const WRONG_ONLY = changeSet([["src/quote.ts", QUOTE_BUGGY, QUOTE_WRONG]]);

test("v0.4 invariant 2 (build): the checks run on the unchanged baseline first — fail before, pass after — and the fix is VERIFIED",
  { skip }, async () => rehearse({ worker: () => FIX_ONLY }, ({ repo, result, events, rig: r, after }) => {
    assert.equal(result.state, "completed", JSON.stringify(result.error));
    assert.equal(result.reproduction?.ran, true);
    const baseline = commandOutcomes((result.reproduction as { verdict: VerificationVerdict }).verdict);
    assert.deepEqual(baseline, [{ id: "typecheck", passed: true }, { id: "unit", passed: false }], "the defect is reproduced by Fusion's own check");
    assert.equal(r.verifications.length, 2, "one baseline run, one run of the change — no model turn added");
    assert.equal(r.streamed[0]!.files.get("src/quote.ts")?.toString("utf8"), QUOTE_BUGGY, "the reproduction saw the unchanged baseline");
    assert.equal(r.streamed[1]!.files.get("src/quote.ts")?.toString("utf8"), QUOTE_FIXED);
    assert.deepEqual(result.cleanup, { candidates: 1, released: 1, complete: true }, "the reproduction reused the first candidate, pristine");
    assert.deepEqual(after, repo.before, "the primary is unchanged");
    const reproduction = events.find(e => e.type === "reproduction");
    assert.deepEqual(reproduction && { ran: reproduction.ran, passed: reproduction.passed, commandsRun: reproduction.commandsRun }, { ran: true, passed: false, commandsRun: 2 });
    const evidence = assembleBuildEvidence({ task: LOW_TASK.summary, scope: ["src/quote.ts"], plan: bugFix(result.risk!), plannedCommands: 2,
      result, protectedChanged: [], baseCommit: "a".repeat(40) });
    assert.deepEqual(evidence.decision.obligations.map(o => `${o.kind}:${o.status}`), ["verificationPassed:PASS", "scopeRespected:PASS",
      "protectedUnchanged:PASS", "defectReproduced:PASS", "reproductionResolved:PASS", "rootCauseSupported:PASS"]);
    assert.deepEqual([evidence.decision.decision, evidence.decision.deliverable], ["VERIFIED", true]);
    assert.equal(evidence.decision.obligations[4]!.reason, "check unit failed before the change and passes after it");
    const graph = parseEvidenceGraph(JSON.parse(JSON.stringify(evidence.graph)));
    assert.deepEqual(graph.claims.map(c => c.id), ["task", "defect", "root-cause", "fix-effect"]);
    assert.ok(graph.evidence.every(e => e.source !== "worker"), "the change author's own report is never evidence");
  }, { task: LOW_TASK, request: { reproduce: true } }));

test("v0.4 invariant 3 (build): a plausible fix that leaves the reproduced check failing is BLOCKED; its root cause is CONTRADICTED",
  { skip }, async () => rehearse({ worker: () => WRONG_ONLY }, ({ result }) => {
    assert.deepEqual([result.state, transitionsOf(result).at(-1)], ["failed", "verifying>failed:verificationFailed"]);
    const evidence = assembleBuildEvidence({ task: LOW_TASK.summary, scope: ["src/quote.ts"], plan: bugFix(result.risk!), plannedCommands: 2,
      result, protectedChanged: [] });
    const status = Object.fromEntries(evidence.decision.obligations.map(o => [o.kind, o.status]));
    assert.deepEqual([status.verificationPassed, status.defectReproduced, status.reproductionResolved, status.rootCauseSupported],
      ["FAIL", "PASS", "FAIL", "FAIL"]);
    assert.deepEqual([evidence.decision.decision, evidence.decision.deliverable], ["BLOCKED", false]);
  }, { task: LOW_TASK, request: { reproduce: true } }));

test("v0.4 E (unverifiable): no way to reproduce means UNKNOWN, never PASS — deliverable only as UNVERIFIED, never when strict",
  { skip }, async () => {
    // A port that cannot verify a pristine candidate: the run completes, the reproduction is recorded as unsupported.
    await rehearse({ worker: () => FIX_ONLY }, ({ result, rig: r }) => {
      assert.equal(result.state, "completed");
      assert.deepEqual(result.reproduction, { ran: false, reason: "unsupported" });
      assert.equal(r.verifications.length, 1);
      const lax = assembleBuildEvidence({ task: LOW_TASK.summary, scope: ["src/quote.ts"], plan: bugFix(result.risk!), plannedCommands: 2, result, protectedChanged: [] });
      assert.deepEqual(lax.decision.obligations.filter(o => o.status !== "PASS").map(o => o.kind), ["defectReproduced", "reproductionResolved", "rootCauseSupported"]);
      assert.deepEqual([lax.decision.decision, lax.decision.deliverable], ["UNVERIFIED", true]);
      const strict = assembleBuildEvidence({ task: LOW_TASK.summary, scope: ["src/quote.ts"], plan: reliabilityPlan({ taskClass: "bugFix", sensitive: true }, result.risk!),
        plannedCommands: 2, result, protectedChanged: [] });
      assert.deepEqual([strict.decision.decision, strict.decision.deliverable], ["UNVERIFIED", false]);
    }, { task: LOW_TASK, request: { reproduce: true }, before: r => { Object.defineProperty(r.port, "verifyBaseline", { value: undefined }); } });
    // A checks run that passes on the baseline: the defect is honestly NOT reproduced.
    await rehearse({ worker: () => FIX_ONLY }, ({ result }) => {
      assert.equal(result.state, "completed");
      const evidence = assembleBuildEvidence({ task: LOW_TASK.summary, scope: ["src/quote.ts"], plan: bugFix(result.risk!), plannedCommands: 2, result, protectedChanged: [] });
      const reproduced = evidence.decision.obligations.find(o => o.kind === "defectReproduced")!;
      assert.deepEqual([reproduced.status, evidence.decision.decision], ["UNKNOWN", "UNVERIFIED"]);
      assert.match(reproduced.reason, /do not reproduce the defect/u);
    }, { task: LOW_TASK, request: { reproduce: true }, docker: { attach: oracle(() => ({ pass: true, stdout: testSummary(10, 0) })) } });
  });

test("v0.4 invariant 11 (build): a failed or refused reproduction is contained — recorded as such, the run goes on, nothing is inferred",
  { skip }, async () => {
    await rehearse({ worker: () => FIX_ONLY }, ({ result, events }) => {
      assert.equal(result.state, "completed");
      assert.deepEqual(result.reproduction, { ran: false, reason: "verifierFailure" });
      assert.deepEqual(events.filter(e => e.type === "reproduction").map(e => e.type === "reproduction" ? e.reason : undefined), ["verifierFailure"]);
    }, { task: LOW_TASK, request: { reproduce: true }, before: r => {
      Object.defineProperty(r.port, "verifyBaseline", { value: async () => { throw new Error("the daemon went away"); } });
    } });
    await rehearse({ worker: () => FIX_ONLY }, ({ result, events }) => {
      assert.equal(result.state, "completed");
      assert.deepEqual(result.reproduction, { ran: false, reason: "backendUnavailable" });
      const event = events.find(e => e.type === "reproduction");
      assert.deepEqual(event?.type === "reproduction" ? [event.refusal, event.reason] : [], ["backendUnavailable", "backendUnavailable"]);
    }, { task: LOW_TASK, request: { reproduce: true }, before: r => {
      Object.defineProperty(r.port, "verifyBaseline", { value: async (): Promise<VerificationVerdict> => ({ passed: false, commandsRun: 0,
        refusal: "backendUnavailable", failure: { kind: "CapabilityUnavailable", retryable: false, safeMessage: "no daemon" } }) });
    } });
  });

test("v0.4 invariant 19 (build): Ctrl+C during the baseline reproduction cancels the run — no model turn, no evidence inferred, candidate discarded, primary unchanged",
  { skip }, async () => {
    const controller = new AbortController();
    let started = false;
    await rehearse({ worker: () => FIX_ONLY }, ({ result, spy, rig: r, events, after, repo }) => {
      assert.ok(started, "the cancellation arrived while Fusion's baseline checks were running");
      assert.deepEqual([result.state, result.error?.kind], ["cancelled", "Cancelled"]);
      assert.equal(spy.proposals.length, 0, "no model turn after the cancellation");
      assert.equal(result.reproduction, undefined, "an interrupted reproduction is not evidence of anything");
      assert.equal(events.filter(e => e.type === "reproduction").length, 0);
      assert.deepEqual([result.cleanup?.complete, r.port.handles.every(candidateGone)], [true, true], "the candidate is discarded");
      assert.deepEqual(after, repo.before, "the primary is unchanged");
    }, { task: LOW_TASK, request: { reproduce: true, signal: controller.signal }, before: r => {
      Object.defineProperty(r.port, "verifyBaseline", { value: async (_handle: unknown, _plan: unknown, signal?: AbortSignal): Promise<VerificationVerdict> => {
        started = true;
        controller.abort();
        // A backend that honours the signal: it stops when the run is cancelled.
        return new Promise((_resolve, reject) => { if (signal?.aborted) reject(new Error("aborted")); else signal?.addEventListener("abort", () => reject(new Error("aborted"))); });
      } });
    } });
  });

test("v0.4 security (build): the reproduction can never change the candidate or the primary — a change voids the run", { skip }, async () =>
  rehearse({ worker: () => FIX_ONLY }, ({ result, spy, after, repo }) => {
    assert.deepEqual([result.state, transitionsOf(result).at(-1)], ["failed", "leased>failed:securityViolation"]);
    assert.equal(result.risk?.level, "critical");
    assert.equal(spy.proposals.length, 0, "no provider turn after the violation");
    assert.deepEqual(after, repo.before);
  }, { task: LOW_TASK, request: { reproduce: true }, before: r => {
    const real = r.port.verifyBaseline.bind(r.port);
    Object.defineProperty(r.port, "verifyBaseline", { value: async (handle: { path: string }, plan: typeof REHEARSAL_PLAN, signal?: AbortSignal) => {
      await writeFile(join(handle.path, "src", "quote.ts"), "tampered\n");
      return real(handle as never, plan, signal);
    } });
  } }));

test("v0.4 port: the baseline verification exists only for a pristine candidate", { skip }, async () => withRehearsalRepo(async repo => {
  const r = await rig(repo);
  const handle = await r.port.acquire("v04-direct.worker");
  try {
    const baseline = await r.port.verifyBaseline(handle, REHEARSAL_PLAN);
    assert.deepEqual([baseline.passed, baseline.evidence?.acceptance, baseline.evidence?.commands.map(c => c.status)],
      [false, "offlineRehearsal", ["passed", "failed"]]);
    await r.port.apply(handle, FIX_ONLY, { allowedPaths: ["src/quote.ts"], forbiddenPaths: [] });
    await assert.rejects(r.port.verifyBaseline(handle, REHEARSAL_PLAN), (e: unknown) => e instanceof FusionFailure && e.error.kind === "WorkspaceConflict");
    assert.equal((await r.port.verify(handle, REHEARSAL_PLAN)).passed, true);
  } finally { await r.port.release(handle); }
}));

test("v0.4 invariant 13 (build): the fresh stage is added only when the host's policy requires it", { skip }, async () => {
  await rehearse({ worker: () => FIX_ONLY }, ({ result, spy }) => {
    assert.equal(result.state, "completed");
    assert.deepEqual([result.reviews.length, spy.reviews.length, spy.plans.length], [0, 0, 0], "a low-risk change: no committee");
  }, { task: LOW_TASK });
  await rehearse({ worker: () => FIX_ONLY }, ({ result, spy }) => {
    assert.equal(result.state, "completed", JSON.stringify(result.error));
    assert.deepEqual([result.reviews.length, spy.reviews.length], [1, 1], "required by the policy: one fresh stage, bounded");
  }, { task: LOW_TASK, request: { requireFreshReview: true } });
});

// ---------------------------------------------------------------- the product path: fusion build

const CONFIG = JSON.stringify({ schemaVersion: 1, bindings: [], verification: { commands: [], platformRequirement: "linux-compatible" } });
const REGISTRY = { defaults: { schemaVersion: 1 as const, bindings: [], verification: { commands: [] }, limits: { runTimeoutMs: 600_000 } },
  factories: new Map() };
function seam(repoDir: string, script: Script, attach: (context: AttachContext) => unknown = rehearsalOracle()): WriterRehearsal {
  const fake = new FakeDocker({ attach: attach as never, depsTree: FAKE_DEPENDENCY_TREE });
  const backend = new DockerLinuxVerificationBackend({ image: FAKE_IMAGE, runner: fake, resolveDocker: () => Promise.resolve(FAKE_DOCKER_EXE),
    dependencyStoreDirectory: join(repoDir, "dependency-store") });
  return { roles: scriptedRoles(script).roles, plan: REHEARSAL_PLAN, candidatePort: ({ primaryRoot, git, declaredPlatform }) =>
    new PrivateCandidateWorkspacePort({ primaryRoot, git, service: new VerificationService([backend]), confinement: OFFLINE_REHEARSAL,
      declaredPlatform, dependencies: "npm-lockfile", prepareDependencies: true }) };
}
async function cli(root: string, argv: string[], rehearsal: WriterRehearsal) {
  let stdout = "", stderr = "";
  const code = await runCli(argv, { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } },
    { env: process.env, cwd: root, registry: REGISTRY, writerRehearsal: rehearsal });
  return { code, stdout, stderr };
}
async function runEvents(root: string, runId: string) {
  const dir = join(root, ".fusion", "runs", runId);
  const events = [];
  for await (const item of EventStore.read(dir, runId)) if ("event" in item) events.push(item.event);
  return { dir, events };
}

test("v0.4 build path: `fusion build` records the evidence decision before any delivery and reports it (JSON, text, show)", { skip }, async () =>
  withRehearsalRepo(async repo => {
    const task = "Fix quote totals: tax applies to the discounted subtotal. Add a regression test.";
    const argv = ["--json", "build", "--path", "src/quote.ts", "--path", "test/quote.test.ts", task];
    const ran = await cli(repo.root, argv, seam(repo.dir, { worker: () => FIX }));
    const report = JSON.parse(ran.stdout) as { runId: string; outcome: { state: string }; intendedWorkflow: string[];
      evidence: { plan: { profile: { taskClass: string }; reproduce: boolean; freshReview: boolean; objective: string };
        decision: { decision: string; deliverable: boolean; obligations: Array<{ kind: string; status: string }> } } };
    assert.equal(report.outcome.state, "COMPLETED", ran.stdout + ran.stderr);
    assert.deepEqual([report.evidence.plan.profile.taskClass, report.evidence.plan.reproduce, report.evidence.plan.freshReview, report.evidence.plan.objective],
      ["bugFix", true, true, "falsify"]);
    assert.deepEqual([report.evidence.decision.decision, report.evidence.decision.deliverable], ["VERIFIED", true]);
    assert.ok(report.intendedWorkflow.includes("Fusion's checks on the unchanged baseline") && report.intendedWorkflow.includes("fresh falsification"));
    const { events } = await runEvents(repo.root, report.runId);
    const types = events.map(e => e.type);
    assert.ok(types.indexOf("ReproductionObserved") < types.indexOf("CandidateVerificationObserved"), "the baseline ran before the change was verified");
    const decided = events.find(e => e.type === "EvidenceDecisionRecorded")!;
    assert.ok(types.indexOf("EvidenceDecisionRecorded") < types.indexOf("RunCompleted"), "recorded before the run's end (and any delivery)");
    const payload = decided.payload as { decision: string; artifactRef: string; obligations: Array<{ kind: string; status: string }> };
    assert.equal(payload.decision, "VERIFIED");
    const { RunStore } = await import("../src/platform/events/run-store.js");
    const { DiagnosticRedactor } = await import("../src/core/policy/redaction.js");
    const artifacts = await (await RunStore.open(repo.root, report.runId, new DiagnosticRedactor())).openArtifacts();
    const record = JSON.parse(await readFile(await artifacts.getArtifactPath(payload.artifactRef), "utf8")) as { format: string; graph: unknown;
      obligations: Array<{ reason: string }> };
    assert.equal(record.format, "fusion.buildEvidence");
    // The artifact is the REDACTED human record (the environment's secrets are masked in every string, ids included), so it is
    // display data; the decision the product reads back is the strictly projected event above.
    const graph = record.graph as { format: string; claims: unknown[]; evidence: unknown[] };
    assert.equal(graph.format, "fusion.evidenceGraph");
    assert.ok(graph.claims.length >= 4 && graph.evidence.length > 0, "the graph is kept with the record");
    assert.ok(record.obligations.every(o => o.reason.length > 0));
    const text = await cli(repo.root, ["show", report.runId], seam(repo.dir, { worker: () => FIX }));
    assert.match(text.stdout, /^evidence: VERIFIED — bugFix; verificationPassed PASS, /mu);
  }, { extraFiles: { "fusion.config.json": CONFIG } }));

test("v0.4 build path: a strict (security-sensitive) fix Fusion cannot reproduce is not delivered — a decision, with the reason", { skip }, async () =>
  withRehearsalRepo(async repo => {
    const session = "export const expired = (at: number, now: number): boolean => now > at;\n";
    const alwaysPass = oracle(() => ({ pass: true, stdout: testSummary(10, 0) }));
    const script: Script = { worker: () => changeSet([["src/auth/session.ts", null, session]]) };
    const ran = await cli(repo.root, ["--json", "build", "--path", "src/auth/session.ts", "Fix the session expiry check."], seam(repo.dir, script, alwaysPass));
    const report = JSON.parse(ran.stdout) as { runId: string; risk: { level: string }; outcome: { state: string; code: string; message: string };
      evidence: { plan: { profile: { sensitive: boolean }; strict: boolean }; decision: { decision: string; deliverable: boolean } } };
    assert.deepEqual([report.evidence.plan.profile.sensitive, report.evidence.plan.strict], [true, true]);
    assert.deepEqual([report.outcome.state, report.outcome.code], ["DECISION_REQUIRED", "evidenceInsufficient"], ran.stdout + ran.stderr);
    assert.deepEqual([report.evidence.decision.decision, report.evidence.decision.deliverable], ["UNVERIFIED", false]);
    assert.match(report.outcome.message, /defectReproduced: every configured check passes on the unchanged baseline/u);
    assert.match(report.outcome.message, /Nothing was delivered or applied\./u);
    const plain = await cli(repo.root, ["build", "--path", "src/auth/session.ts", "Fix the session expiry check."], seam(repo.dir, script, alwaysPass));
    assert.match(plain.stdout, /^ {2}reproduced defect \.+ NOT REPRODUCED +every configured check passes/mu);
    assert.match(plain.stdout, /^Decision: UNVERIFIED — 3 obligation\(s\) not established; no delivery$/mu);
  }, { extraFiles: { "fusion.config.json": CONFIG } }));

test("v0.4 persistence: the new events are projected strictly; a v0.3 run without them still reads", { skip }, async () => withRehearsalRepo(async repo => {
  const { RunStore } = await import("../src/platform/events/run-store.js");
  const { DiagnosticRedactor } = await import("../src/core/policy/redaction.js");
  const store = await RunStore.create(repo.root, { workflowId: "build" }, new DiagnosticRedactor());
  const events = await store.openEvents();
  await events.append({ type: "RunStarted", source: "runtime", payload: { workflowId: "build" } });
  const refused = async (input: unknown) => assert.rejects(events.append(input as never));
  await refused({ type: "ReproductionObserved", source: "verification", payload: { ran: true } });
  await refused({ type: "ReproductionObserved", source: "verification", payload: { ran: false, reason: "somethingElse" } });
  await refused({ type: "EvidenceDecisionRecorded", source: "policy", payload: { decision: "PROBABLY", deliverable: true, taskClass: "bugFix",
    sensitive: false, obligations: [], claims: 1, evidence: 1, overflowed: false } });
  await refused({ type: "EvidenceDecisionRecorded", source: "policy", payload: { decision: "VERIFIED", deliverable: true, taskClass: "bugFix",
    sensitive: false, obligations: [{ kind: "vibes", tier: "safety", status: "PASS" }], claims: 1, evidence: 1, overflowed: false } });
  const kept = await events.append({ type: "EvidenceDecisionRecorded", source: "policy", payload: { decision: "UNVERIFIED", deliverable: false,
    taskClass: "configFix", sensitive: false, obligations: [{ kind: "defectReproduced", tier: "correctness", status: "UNKNOWN" }], claims: 3, evidence: 4,
    overflowed: false, note: "dropped" } as never });
  assert.equal("note" in (kept.payload as object), false, "unknown payload keys are never serialized");
  const { summarizeRun } = await import("../src/app/runs.js");
  const summary = await summarizeRun(repo.root, store.runId, new DiagnosticRedactor());
  assert.deepEqual(summary.evidence, { decision: "UNVERIFIED", deliverable: false, taskClass: "configFix",
    obligations: [{ kind: "defectReproduced", status: "UNKNOWN" }] });
  const old = await RunStore.create(repo.root, { workflowId: "build" }, new DiagnosticRedactor());
  await (await old.openEvents()).append({ type: "RunStarted", source: "runtime", payload: { workflowId: "build" } });
  assert.equal((await summarizeRun(repo.root, old.runId, new DiagnosticRedactor())).evidence, undefined, "a v0.3 run has no evidence section");
}));

test("v0.4 UX: the evidence block, the decision and the apply summary say exactly what was and was not established", () => {
  const result = { state: "completed" as const, transitions: [], delegateAttempts: 1, reviews: [], changedPaths: ["configuration.yaml"],
    verification: { passed: true, commandsRun: 1, evidence: { backendId: "docker-linux", confinement: "osSandbox", platformRequirement: "linux-compatible",
      acceptance: "granted" as const, commands: [{ id: "configuration", status: "passed", exitCode: 0 }] } },
    reproduction: { ran: true as const, verdict: { passed: false, commandsRun: 1, evidence: { backendId: "docker-linux", confinement: "osSandbox",
      platformRequirement: "linux-compatible", acceptance: "granted" as const, commands: [{ id: "configuration", status: "failed", exitCode: 1 }] } } } };
  const low = { level: "low" as const, signals: [], decisive: [], revision: 0 };
  const evidence = assembleBuildEvidence({ task: "Fix this finding: configuration.yaml has no trusted_proxies", scope: ["configuration.yaml"],
    plan: reliabilityPlan({ taskClass: "configFix", sensitive: false }, low), plannedCommands: 1, result, protectedChanged: [] });
  const lines = evidenceLines(evidence).join("\n");
  assert.match(lines, /^ {2}invalid state shown \.+ PASS +check configuration fails on the unchanged baseline$/mu);
  assert.match(lines, /^ {2}corrected state shown \.+ PASS +check configuration failed before the change and passes after it$/mu);
  assert.match(lines, /^ {2}protected files \.+ UNCHANGED /mu);
  assert.match(lines, /^Decision: VERIFIED \(5 of 5 obligations\)$/mu);
  const report = { runId: "r-x", risk: { level: "low", decisive: [] }, writerRequired: true, intendedWorkflow: [], writer: { ready: false, code: "x", prerequisites: [] },
    outcome: { state: "COMPLETED" as const, exitCode: 0, code: "completed", message: "Completed." }, reviews: [], unavailable: [],
    summary: { verification: { passed: true, commands: 1, backendId: "docker-linux", acceptance: "granted" }, review: { cycles: 0, findings: 0, outstanding: 0 },
      delegateAttempts: 1, changedPaths: ["configuration.yaml"] }, delivery: { deliveryId: "d-0123456789abcdef01234567", manifestSha256: "f".repeat(64) }, evidence };
  assert.match(renderBuild(report as never), /^Build: PASS$/mu);
  const unverified = assembleBuildEvidence({ task: "Fix it", scope: ["configuration.yaml"], plan: reliabilityPlan({ taskClass: "configFix", sensitive: false }, low),
    plannedCommands: 1, result: { ...result, reproduction: { ran: false, reason: "unsupported" } }, protectedChanged: [] });
  assert.match(renderBuild({ ...report, evidence: unverified } as never), /^Build: UNVERIFIED \(delivered only for your decision\)$/mu);
  const inspection = { deliveryId: "d-0123456789abcdef01234567", manifestSha256: "f".repeat(64), files: [{ path: "configuration.yaml", kind: "update" }],
    counts: { create: 0, update: 1, delete: 0 }, verification: { passed: true, commands: [{ id: "configuration" }], backendId: "docker-linux", confinement: "osSandbox" },
    review: { state: "notRequired", cycles: 0 } };
  assert.match(renderReadyToApply(inspection as never, { decision: "UNVERIFIED", open: 2 }),
    /^ {2}Evidence decision: UNVERIFIED — 2 proof obligation\(s\) not established \(listed above\); approve only if you accept that$/mu);
  assert.match(renderReadyToApply(inspection as never, { decision: "VERIFIED", open: 0 }), /^ {2}Evidence decision: VERIFIED$/mu);
});
