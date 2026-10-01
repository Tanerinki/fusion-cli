import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const mod = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "hyperv-poc", "lifecycle.mjs");
const { processTreeVerdict, cleanupLifecycleVerdict } = await import(pathToFileURL(mod).href);

test("v0.6 Hyper-V lifecycle: processTreeContainment is PASS only with a real spawned child AND a gone container", () => {
  assert.equal(processTreeVerdict({ attempted: true, spawned: true, childPid: 4321, containerGoneAfterKill: true }), "PASS");
});

test("v0.6 Hyper-V lifecycle: no false PASS — the mere existence of a result never yields PASS", () => {
  assert.equal(processTreeVerdict({ attempted: false }), "NOT_RUN", "if the spawn canary did not run → NOT_RUN");
  assert.equal(processTreeVerdict({ attempted: true, spawned: false, childPid: 0, containerGoneAfterKill: true }), "NOT_RUN", "no child spawned → nothing proven");
  assert.equal(processTreeVerdict({ attempted: true, spawned: true, childPid: 0, containerGoneAfterKill: true }), "NOT_RUN", "a non-positive childPid is not evidence");
  assert.equal(processTreeVerdict({ attempted: true, spawned: true, childPid: 10, containerGoneAfterKill: false }), "FAIL", "a surviving container/VM after kill → FAIL");
  assert.equal(processTreeVerdict(undefined), "NOT_RUN");
});

test("v0.6 Hyper-V lifecycle: cleanupLifecycleVerdict needs container + endpoint + listeners all gone", () => {
  assert.equal(cleanupLifecycleVerdict({ containerGone: true, endpointGone: true, listenersGone: true }), "PASS");
  assert.equal(cleanupLifecycleVerdict({ containerGone: true, endpointGone: false, listenersGone: true }), "FAIL");
  assert.equal(cleanupLifecycleVerdict({}), "FAIL");
});
