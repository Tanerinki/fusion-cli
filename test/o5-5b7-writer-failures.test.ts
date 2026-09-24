import assert from "node:assert/strict";
import { test } from "node:test";
import { changeSet, plan } from "./fixtures/fake-writer.js";
import { MemoryPort, memoryRun } from "./fixtures/memory-port.js";
import { QUOTE_BUGGY, QUOTE_FIXED } from "./fixtures/rehearsal-project.js";
import { FIX, FIX_ONLY, gitAvailable, rehearse, transitionsOf, WRONG } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5B7 failure semantics, proposal and provider side: every stage ends in a stable, classified state, never a generic
 * success and never a silent fallback. The real engine, the real candidate port and the real backend over a fake daemon.
 */
const skip = gitAvailable ? false : "git executable unavailable";

test("O5.5B7 B: a malformed ChangeSet is proposalMalformed; nothing is applied or verified", { skip }, async () =>
  rehearse({ worker: () => ({ schemaVersion: 1, operations: [{ kind: "writeText", path: "src/quote.ts", content: QUOTE_FIXED }] }) },
    ({ result, rig, events, after, repo }) => {
      assert.deepEqual([result.state, result.transitions.at(-1)?.reason, result.error?.kind], ["failed", "proposalMalformed", "MalformedOutput"]);
      assert.deepEqual(events.flatMap(e => e.type === "proposal" ? [[e.outcome, e.operations]] : []), [["malformed", 1]]);
      assert.equal(rig.streamed.length, 0);
      assert.equal(result.changeSet, undefined);
      assert.deepEqual(result.cleanup, { candidates: 1, released: 1, complete: true });
      assert.deepEqual(after, repo.before);
    }));

test("O5.5B7 C: a proposal touching a forbidden file is proposalRejected and escalates risk to critical", { skip }, async () =>
  rehearse({ worker: () => changeSet([["src/quote.ts", QUOTE_BUGGY, QUOTE_FIXED], ["package.json", null, "{}\n"]]) },
    ({ result, rig, after, repo }) => {
      assert.deepEqual([result.state, result.transitions.at(-1)?.reason, result.error?.kind], ["failed", "proposalRejected", "SecurityViolation"]);
      assert.equal(result.risk?.level, "critical", "a dependency manifest outside the scope is a sensitive unexpected path");
      assert.ok(result.risk?.decisive.includes("unexpectedScope"));
      assert.equal(rig.streamed.length, 0);
      assert.deepEqual(after, repo.before);
    }));

test("O5.5B7 L: a Worker whose provider dies ends as a typed provider failure; the candidate is still discarded", async () => {
  const { result, port } = await memoryRun({ worker: ({ session }) => ({ status: "failed", effectiveProvider: session.provider, artifactRefs: [],
    error: { kind: "ProcessFailure", safeMessage: "the provider process exited", retryable: false } }) });
  assert.deepEqual([result.state, result.transitions.at(-1)?.reason, result.error?.kind], ["failed", "providerFailure", "ProcessFailure"]);
  assert.deepEqual([port.applied.length, port.verified.length, port.released], [0, 0, ["candidate-1"]]);
  const timeout = await memoryRun({ worker: () => new Promise(() => undefined) }, new MemoryPort(), undefined, { timeoutMs: 100 });
  assert.deepEqual([timeout.result.state, timeout.result.error?.kind, timeout.result.transitions.at(-1)?.reason], ["failed", "Timeout", "timedOut"]);
  assert.deepEqual(timeout.port.released, ["candidate-1"], "a timed-out run still discards its candidate");
});

test("O5.5B7 L: cancellation during confined verification stops the container and releases the candidate", { skip }, async () => {
  const controller = new AbortController();
  await rehearse({ worker: () => FIX }, ({ result, rig, after, repo }) => {
    assert.deepEqual([result.state, result.error?.kind], ["cancelled", "Cancelled"]);
    assert.ok(!result.transitions.some(t => t.to === "reviewing" || t.to === "completed"));
    assert.deepEqual(result.cleanup, { candidates: 1, released: 1, complete: true }, "the release waited for the stopped verification");
    assert.ok([...rig.fake.containers.values()].every(container => container.removed), "no container is left behind");
    assert.deepEqual(after, repo.before);
  }, { request: { signal: controller.signal }, docker: { attach: ({ invocation }) => new Promise(resolve => {
    invocation.signal?.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
    controller.abort();
  }) } });
});

test("O5.5B7 M: risk that escalates mid-run to critical stops at the human gate before any candidate exists", async () => {
  const { result, spy, port } = await memoryRun({ lead: () => plan("Plan: fix the tax, then force-push the result to main."), worker: () => FIX });
  assert.deepEqual([result.state, result.pendingStage, result.risk?.level], ["humanGateRequired", "humanGate", "critical"]);
  assert.deepEqual([port.released.length, spy.proposals.length], [0, 0], "no candidate and no Worker turn after critical intent");
});

test("O5.5B7 P: an unproven candidate release is never reported as a success, final or superseded", { skip }, async () => {
  await rehearse({ worker: () => FIX }, ({ result, rig }) => {
    assert.deepEqual([result.state, result.transitions.at(-1)?.reason, result.error?.kind], ["failed", "cleanupIncomplete", "WorkspaceConflict"]);
    assert.ok(result.transitions.some(t => t.to === "reviewing"), "the work itself was reviewed; only the teardown is unproven");
    assert.deepEqual(result.cleanup, { candidates: 1, released: 0, complete: false });
    assert.deepEqual(rig.port.releases, [{ complete: false, reason: "injected" }]);
  }, { before: rig => { rig.port.failRelease = () => true; } });
  await rehearse({ worker: ({ call }) => call === 1 ? WRONG : FIX_ONLY }, ({ result, rig, spy }) => {
    assert.deepEqual([result.state, result.transitions.at(-1)?.reason], ["failed", "cleanupIncomplete"]);
    assert.equal(rig.port.handles.length, 1, "no second candidate while the first is not proven gone");
    assert.equal(spy.proposals.length, 1);
    assert.deepEqual(result.cleanup, { candidates: 1, released: 0, complete: false });
    assert.ok(!transitionsOf(result).some(entry => entry.startsWith("retrying>leased")));
  }, { before: rig => { rig.port.failRelease = handle => handle.leaseId === rig.port.handles[0]?.leaseId; } });
});
