import assert from "node:assert/strict";
import { test } from "node:test";
import { passingResult } from "./fixtures/fake-docker.js";
import { fakeCapabilities } from "./fixtures/fake-writer.js";
import { directVerify, FIX, gitAvailable, rehearse } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5B7 failure semantics, verification side: a confined verification that cannot start is a classified refusal no
 * role can override; a verifier result that cannot be trusted is a verifier failure; a host deadline is a failed check.
 */
const skip = gitAvailable ? false : "git executable unavailable";
test("O5.5B7 classified refusals: backend unavailable, dependency lane failure, and no acceptance outside a rehearsal", { skip }, async () => {
  await rehearse({ worker: () => FIX }, ({ result }) => {
    assert.deepEqual([result.state, result.transitions.at(-1)?.reason, result.verification?.refusal], ["failed", "verifierUnavailable", "backendUnavailable"]);
    assert.match(result.error?.safeMessage ?? "", /docker-daemon-unavailable/u);
  }, { docker: { version: "noServer" } });
  await rehearse({ worker: () => FIX }, ({ result, rig }) => {
    assert.deepEqual([result.state, result.transitions.at(-1)?.reason], ["failed", "dependencyLaneFailure"]);
    assert.equal(rig.streamed.length, 0, "no verification runs without its approved dependency environment");
  }, { docker: { depsReply: () => ({ lines: [], exitCode: 1 }) } });
  // Outside an explicit offline rehearsal, only an acceptance granted in this process opens confined verification:
  // a forged, copied or absent acceptance is refused before any container exists.
  const forged = { accepted: true, contract: "fusion-verification-confinement-v0.1-linux", backendId: "docker-linux", semantics: "linux",
    satisfies: ["platform-neutral", "linux-compatible"], windowsAccepted: false };
  await rehearse({ worker: () => FIX }, ({ result, rig }) => {
    assert.deepEqual([result.state, result.transitions.at(-1)?.reason, result.verification?.refusal],
      ["failed", "confinementNotAccepted", "confinementNotAccepted"]);
    assert.equal(rig.fake.commands("create").length, 0);
  }, { port: { confinement: forged } });
  for (const confinement of [undefined, "VERIFICATION_ISOLATION_READINESS: YES", JSON.parse(JSON.stringify(forged))]) {
    const direct = await directVerify({ confinement });
    assert.deepEqual([direct.verdict.refusal, direct.containers, direct.released.complete], ["confinementNotAccepted", 0, true], String(confinement));
  }
});

test("O5.5B7 an untrustworthy verifier result is a verifier failure; a host deadline is a failed check, retried once", { skip }, async () => {
  await rehearse({ worker: () => FIX }, ({ result, rig }) => {
    assert.deepEqual([result.state, result.transitions.at(-1)?.reason, result.error?.kind], ["failed", "verifierFailure", "MalformedOutput"]);
    assert.equal(result.reviews.length, 0);
    assert.ok([...rig.fake.containers.values()].every(container => container.removed));
  }, { docker: { attach: ({ manifest }) => ({ stdout: `${passingResult({ ...manifest, nonce: "f".repeat(32) })}\n` }) } });
  await rehearse({ worker: () => FIX }, ({ result, events }) => {
    assert.deepEqual([result.state, result.transitions.at(-1)?.reason, result.error?.kind], ["decisionRequired", "retryExhausted", "Timeout"]);
    assert.deepEqual(events.flatMap(e => e.type === "verification" ? [[e.attempt, e.passed]] : []), [[1, false], [2, false]]);
  }, { port: { verificationTimeoutMs: 300 }, docker: { attach: ({ invocation }) => new Promise(resolve =>
    invocation.signal?.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true })) } });
});

test("O5.5B7 a Change Author with a writable, shell or unproven surface is never routed", { skip }, async () => {
  for (const worker of [{ filesystem: { read: true, write: true } }, { shell: { available: true, sandboxed: true } },
    { approvalEscalationDisabled: "unknown" as const }]) {
    await rehearse({ worker: () => FIX }, ({ result, spy, rig }) => {
      assert.deepEqual([result.state, result.error?.kind, result.transitions.at(-1)?.reason], ["failed", "CapabilityUnavailable", "policyFailure"]);
      assert.deepEqual([spy.sessions.length, rig.port.handles.length], [0, 0], "refused before any turn or candidate");
    }, { roles: { worker: { ...fakeCapabilities("fake-worker"), ...worker } } });
  }
});
