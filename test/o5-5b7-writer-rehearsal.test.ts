import assert from "node:assert/strict";
import { test } from "node:test";
import { judge } from "./fixtures/fake-writer.js";
import { failedVerdict, MemoryPort, memoryRun } from "./fixtures/memory-port.js";
import { QUOTE_FIXED, QUOTE_TEST_WITH_REGRESSION } from "./fixtures/rehearsal-project.js";
import { blocker, CANARIES, candidateGone, FIX, FIX_ONLY, gitAvailable, HIGH_TASK, LOW_TASK, MEDIUM_PACKET, rehearse, sneakyWorker,
  testCountsOf, transitionsOf, WORKER_SECRET } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5B7 offline end-to-end Writer rehearsal, happy paths. Every test runs the real WorkflowEngine with deterministic
 * fake providers, the real host-controlled candidate port over real Git, the real verification service and the real
 * Docker backend over an in-memory daemon (see fixtures). No provider, network or Docker access.
 */
const skip = gitAvailable ? false : "git executable unavailable";

test("O5.5B7 A: MEDIUM end to end — Lead, read-only Worker, host application, confined verification, fresh Reviewer, completed",
  { skip }, async () => rehearse({ worker: sneakyWorker(FIX) }, ({ repo, result, spy, rig, events, after, hostVerifications }) => {
    assert.equal(result.state, "completed", JSON.stringify(result.error));
    assert.deepEqual(transitionsOf(result), ["received>inspected:taskInspected", "inspected>routed:bindingsResolved",
      "routed>planning:planRequested", "planning>leased:leaseAcquired", "leased>delegating:delegated",
      "delegating>verifying:verificationStarted", "verifying>reviewing:freshReviewRequested", "reviewing>completed:succeeded"]);
    assert.equal(result.risk?.level, "medium");
    assert.ok(result.risk?.decisive.includes("verificationReferencedPath"), "a Worker that edits a test the plan runs gets a fresh review");
    // Fusion applied exactly the validated ChangeSet into a private candidate; the Worker never wrote anything.
    assert.deepEqual(result.changeSet, FIX);
    assert.deepEqual(result.applied?.map(op => [op.kind, op.path, op.bytes]), [["writeText", "src/quote.ts", Buffer.byteLength(QUOTE_FIXED)],
      ["writeText", "test/quote.test.ts", Buffer.byteLength(QUOTE_TEST_WITH_REGRESSION)]]);
    assert.deepEqual(result.changedPaths, ["src/quote.ts", "test/quote.test.ts"]);
    assert.ok(spy.sessions.every(session => session.posture === "readOnly"), "no role ever holds a writable posture");
    // Confined verification: the Docker backend (over the in-memory daemon) and the restricted npm lane; never the host.
    assert.equal(hostVerifications, 0);
    const evidence = result.verification?.evidence;
    assert.deepEqual(evidence, { backendId: "docker-linux", confinement: "osSandbox", platformRequirement: "linux-compatible",
      acceptance: "offlineRehearsal", dependencies: { kind: "npm-lockfile", key: evidence?.dependencies?.key, prepared: true, cacheHit: false },
      commands: [{ id: "typecheck", status: "passed", exitCode: 0 }, { id: "unit", status: "passed", exitCode: 0 }] });
    assert.match(evidence?.dependencies?.key ?? "", /^[0-9a-f]{64}$/u);
    assert.deepEqual(testCountsOf(rig, 0), [["typecheck", null], ["unit", { tests: 11, pass: 11, fail: 0, cancelled: 0, skipped: 0, todo: 0 }]]);
    // What entered the container: the committed baseline plus exactly the approved files, and the prepared dependency tree.
    const streamed = rig.streamed[0]!;
    assert.equal(streamed.files.get("src/quote.ts")?.toString("utf8"), QUOTE_FIXED);
    assert.equal(streamed.files.get("test/quote.test.ts")?.toString("utf8"), QUOTE_TEST_WITH_REGRESSION);
    for (const excluded of [".env", "secrets.local", "notes.txt", "node_modules/zod/index.js"])
      assert.equal(streamed.files.has(excluded), false, `${excluded} never enters verification`);
    assert.ok(streamed.dependencyFiles?.has("zod/package.json"), "dependencies come only from the lane's artifact");
    const everything = [...streamed.files.values(), ...(streamed.dependencyFiles?.values() ?? [])].map(b => b.toString("utf8")).join("\n");
    for (const canary of Object.values(CANARIES)) assert.equal(everything.includes(canary), false, canary);
    assert.equal(rig.fake.commands("create").length, 2, "one dependency-preparation container and one verification container");
    assert.ok([...rig.fake.containers.values()].every(container => container.removed), "every container is removed");
    // Fresh review of the real candidate diff; with no finding, the Lead has nothing to adjudicate.
    assert.equal(result.reviews.length, 1);
    assert.equal(spy.adjudications.length, 0);
    const review = spy.reviews[0]!;
    assert.match(review.evidence.change.text, /\+ {2}const tax = basisPoints\(subtotal - discount, quote\.taxBasisPoints\);/u);
    assert.match(review.evidence.change.text, /\+test\("a full discount leaves nothing to tax"/u);
    assert.deepEqual(review.evidence.verification, { required: true, passed: true,
      commands: [{ id: "typecheck", passed: true }, { id: "unit", passed: true }] });
    assert.deepEqual(review.evidence.task.acceptanceCriteria, MEDIUM_PACKET.task.acceptanceCriteria);
    assert.deepEqual(review.evidence.architecture.invariants, MEDIUM_PACKET.architecture.invariants);
    assert.ok(!JSON.stringify(spy.reviews).includes(WORKER_SECRET), "no Worker side channel reaches the Reviewer");
    // The candidate is discarded; the primary checkout is exactly as it was (tracked, untracked, ignored, Git metadata).
    assert.deepEqual(result.cleanup, { candidates: 1, released: 1, complete: true });
    assert.ok(candidateGone(rig.port.handles[0]!));
    assert.deepEqual(after, repo.before);
    // The trace: every stage, in order, with no content, path, secret or canary in any event.
    const stages = events.flatMap(e => e.type === "candidate" ? [`candidate:${e.phase}`] : e.type === "proposal" ? [`proposal:${e.outcome}`]
      : e.type === "verification" ? [`verification:${e.passed}`] : e.type === "structuredTurn" || e.type === "turn" ? [`turn:${e.provenance.kind}`]
      : e.type === "reviewCycle" ? [`cycle:${e.phase}`] : []);
    assert.deepEqual(stages, ["turn:plan", "candidate:created", "turn:changeProposal", "proposal:validated", "candidate:applied",
      "verification:true", "cycle:started", "turn:review", "cycle:completed", "candidate:released"]);
    const json = JSON.stringify(events);
    for (const secret of [...Object.values(CANARIES), WORKER_SECRET, "basisPoints(subtotal", JSON.stringify(repo.root).slice(1, -1),
      repo.root, "fusion-writer-private"])
      assert.equal(json.includes(secret), false, secret);
  }));

// The scenarios below are engine decisions (routing, review, adjudication, bounds): the real engine and the same fake
// providers on the in-memory candidate port. Their candidate and verification behaviour is covered on the real port above
// and in the retry, review and failure suites.

test("O5.5B7 A: LOW runs the read-only Worker alone, with no Lead and no Reviewer", async () => {
  const { result, spy, port } = await memoryRun({ worker: sneakyWorker(FIX_ONLY) }, new MemoryPort(), LOW_TASK);
  assert.equal(result.state, "completed", JSON.stringify(result.error));
  assert.deepEqual(transitionsOf(result).slice(2), ["routed>leased:leaseAcquired", "leased>delegating:delegated",
    "delegating>verifying:verificationStarted", "verifying>completed:succeeded"]);
  assert.deepEqual(spy.sessions.map(s => [s.role, s.posture]), [["Worker", "readOnly"]]);
  assert.deepEqual(port.released, ["candidate-1"]);
});

test("O5.5B7 J: a finding the Lead rejects does not block; the verdict and Fusion's contradicting fact are recorded", async () => {
  const { result, spy, events } = await memoryRun({ worker: () => FIX,
    reviewer: () => ({ findings: [blocker("F1", "HIGH", { facts: [{ kind: "verificationCommand", commandId: "unit" }] })], summary: "" }),
    adjudicator: ({ request }) => judge(request, "REJECTED") });
  assert.equal(result.state, "completed", JSON.stringify(result.error));
  assert.deepEqual(result.reviews[0]!.adjudications.map(a => [a.verdict, a.verdictSource]), [["REJECTED", "lead"]]);
  assert.deepEqual(spy.adjudications[0]!.fusionFacts, [{ findingId: "r1-F1", supported: [],
    contradicted: [{ kind: "verificationCommand", commandId: "unit" }] }], "Fusion's passing check contradicts the claim");
  assert.equal(spy.proposals.length, 1);
  assert.deepEqual(events.flatMap(e => e.type === "adjudication" ? [[e.record.verdict, e.record.requiredAction]] : []), [["REJECTED", "none"]]);
});

test("O5.5B7 I: a correction that does not resolve the BLOCKER stops at the human gate; never a third attempt", async () => {
  const { result, spy, port } = await memoryRun({ worker: () => FIX_ONLY,
    reviewer: () => ({ findings: [blocker("F1", "BLOCKER")], summary: "Still missing." }) });
  assert.deepEqual([result.state, result.transitions.at(-1)?.reason, result.pendingStage], ["humanGateRequired", "unresolvedFindings", "humanGate"]);
  assert.deepEqual([spy.proposals.length, spy.reviews.length, result.reviews.map(r => r.outcome).join()], [2, 2, "correction,gate"]);
  assert.deepEqual([port.verified.length, port.released.length], [2, 2]);
  // A correction that fails verification is never reviewed: it stops at a decision.
  const unverified = await memoryRun({ worker: () => FIX, reviewer: () => ({ findings: [blocker("F1", "HIGH")], summary: "" }) },
    new MemoryPort(attempt => attempt === 1 ? { passed: true, commandsRun: 2 } : failedVerdict()));
  assert.deepEqual([unverified.result.state, unverified.result.transitions.at(-1)?.reason, unverified.spy.reviews.length],
    ["decisionRequired", "retryExhausted", 1]);
});

test("O5.5B7 bounded correction: a finding that never goes away costs exactly two attempts, two verifications, two reviews", async () => {
  const { result, spy, port } = await memoryRun({ worker: () => FIX,
    reviewer: ({ call }) => ({ findings: [blocker(`F${call}`, "HIGH")], summary: "" }) }, new MemoryPort(), HIGH_TASK);
  assert.deepEqual([result.state, result.transitions.at(-1)?.reason], ["decisionRequired", "unresolvedFindings"]);
  assert.deepEqual([spy.proposals.length, port.verified.length, spy.reviews.length, spy.adjudications.length], [2, 2, 2, 2]);
  assert.equal(result.delegateAttempts, 2);
  assert.equal(result.transitions.filter(t => t.to === "retrying").length, 1, "one correction, never a loop");
});
