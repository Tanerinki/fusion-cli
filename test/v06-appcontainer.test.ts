import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { decidePosture, postureOfProbe } from "../src/core/isolation/posture.js";
import { deriveBackendProbe, locateLauncher, type CanaryOutcome } from "../src/platform/isolation/appcontainer-backend.js";
import { CONFINEMENT_FACTS, type ConfinementFact } from "../src/platform/verification/confinement-proof.js";
import { fakeExpectation, fakeProofResult } from "./fixtures/fake-confinement-backend.js";
import { evaluateConfinementProof } from "../src/platform/verification/confinement-proof.js";

/**
 * v0.6 PR B — the AppContainer backend's PURE decision, deterministically. The real OS enforcement is proven separately
 * by the opt-in Windows integration test (`test/live/appcontainer.live.test.ts`); a fake all-pass proof here demonstrates
 * only the host mapping, never confinement (the fake helper observes nothing).
 */

// A canary outcome built from the fake confinement fixture, with a per-fact override set.
function canaryFrom(states: Partial<Record<ConfinementFact, "observedPass" | "observedFail" | "notObserved">> = {}): CanaryOutcome {
  const evaluation = evaluateConfinementProof(fakeProofResult({ states }), fakeExpectation());
  return { ran: true, evaluation, note: evaluation.complete ? "canaryPassed" : "canaryFailed" };
}

test("v0.6 appcontainer: a missing launcher is reported backendMissing and yields UNAVAILABLE posture", () => {
  const probe = deriveBackendProbe(false, null);
  assert.equal(probe.available, false);
  assert.deepEqual([...probe.notes], ["backendMissing"]);
  assert.equal(postureOfProbe(probe), "UNAVAILABLE");
  assert.equal(decidePosture("hard", probe).satisfied, false);
});

test("v0.6 appcontainer: all facts passing map to every dimension enforced (HARD for a deny-all execution)", () => {
  const probe = deriveBackendProbe(true, canaryFrom());
  assert.equal(probe.available, true);
  assert.deepEqual(probe.dimensions, { filesystem: "enforced", network: "enforced", processTree: "enforced" });
  assert.equal(postureOfProbe(probe), "HARD");
  assert.ok(probe.notes.includes("networkNotProvisioned"));
});

test("v0.6 appcontainer: a failed filesystem canary is never reported as enforced", () => {
  const probe = deriveBackendProbe(true, canaryFrom({ ungrantedReadDenied: "observedFail" }));
  assert.equal(probe.dimensions.filesystem, "unavailable");
  assert.equal(probe.available, false);
  assert.notEqual(postureOfProbe(probe), "HARD");
});

test("v0.6 appcontainer: a failed descendant-containment canary drops process-tree enforcement", () => {
  const probe = deriveBackendProbe(true, canaryFrom({ descendantContainment: "observedFail" }));
  assert.equal(probe.dimensions.processTree, "unavailable");
  assert.notEqual(postureOfProbe(probe), "HARD");
});

test("v0.6 appcontainer: no canary evaluation leaves dimensions unknown, never enforced", () => {
  const probe = deriveBackendProbe(true, { ran: false, evaluation: null, note: "canaryFailed" });
  assert.deepEqual(probe.dimensions, { filesystem: "unknown", network: "unknown", processTree: "unknown" });
  assert.equal(probe.available, false);
});

test("v0.6 appcontainer: the backend covers exactly the confinement contract's ten facts", () => {
  assert.equal(CONFINEMENT_FACTS.length, 10);
});

test("v0.6 appcontainer: locateLauncher returns null when the launcher is not built under the given root", async () => {
  const root = await mkdtemp(join(tmpdir(), "fusion-nolauncher-"));
  try { assert.equal(await locateLauncher(root), null); }
  finally { await rm(root, { recursive: true, force: true }); }
});
