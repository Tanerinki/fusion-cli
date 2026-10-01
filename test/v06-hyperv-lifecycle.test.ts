import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const pocDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "hyperv-poc");
const mod = join(pocDir, "lifecycle.mjs");
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

test("v0.6 Hyper-V lifecycle: a --rm PT container auto-removed by docker kill is EXPECTED success (child captured + gone)", () => {
  // livegate4 shape: container ran, child captured, `docker kill` auto-removed it (--rm) → absent afterwards → PASS.
  assert.equal(processTreeVerdict({ attempted: true, ptStarted: true, spawned: true, childPid: 777, containerGoneAfterKill: true }), "PASS");
});

test("v0.6 Hyper-V lifecycle: container disappearing BEFORE probe/child evidence is NOT a PASS", () => {
  assert.equal(processTreeVerdict({ attempted: true, ptStarted: true, spawned: false, childPid: 0, containerGoneAfterKill: true }), "NOT_RUN",
    "vanished before evidence → cannot prove containment → NOT_RUN, never PASS");
});

test("v0.6 Hyper-V lifecycle: a PT worker that fails to start is an EXECUTION_ERROR, not PASS/FAIL", () => {
  assert.equal(processTreeVerdict({ attempted: true, ptStarted: false }), "EXECUTION_ERROR");
});

test("v0.6 Hyper-V lifecycle: the process-tree CLI honors the ptStarted arg (and stays backward-compatible without it)", async () => {
  const run = (args: string[]) => import("node:child_process").then(cp => cp.execFileSync(process.execPath, [mod, "process-tree", ...args], { encoding: "utf8" }));
  assert.equal(await run(["555", "true", "true"]), "PASS");
  assert.equal(await run(["0", "true", "false"]), "EXECUTION_ERROR", "ptStarted=false → EXECUTION_ERROR");
  assert.equal(await run(["0", "true"]), "NOT_RUN", "omitted ptStarted stays backward-compatible (no false EXECUTION_ERROR)");
});

test("v0.6 Hyper-V lifecycle: cleanupLifecycleVerdict needs container + endpoint + listeners all gone", () => {
  assert.equal(cleanupLifecycleVerdict({ containerGone: true, endpointGone: true, listenersGone: true }), "PASS");
  assert.equal(cleanupLifecycleVerdict({ containerGone: true, endpointGone: false, listenersGone: true }), "FAIL");
  assert.equal(cleanupLifecycleVerdict({}), "FAIL");
});

test("v0.6 Hyper-V lifecycle: run.ps1 persists network evidence BEFORE the process-tree canary and isolates PT failures", () => {
  const run = readFileSync(join(pocDir, "run.ps1"), "utf8");
  const netIdx = run.indexOf("network-evidence-$RunId.json");
  const ptIdx = run.indexOf("# --- 7. Dedicated process-tree");
  assert.ok(netIdx > 0 && ptIdx > 0 && netIdx < ptIdx, "the network-evidence file is written before the PT canary");
  // The PT canary is wrapped so its failure cannot abort the run (the livegate4 regression).
  const ptBlock = run.slice(ptIdx);
  assert.match(ptBlock, /try \{[\s\S]*catch \{[\s\S]*PROCESS_TREE_CANARY_ERROR/u, "the PT canary is isolated in its own try/catch");
  assert.match(ptBlock, /kill \$ptWorker[\s\S]*-not \(& docker ps -a/u, "kill then poll for absence (idempotent for a --rm container)");
  assert.match(ptBlock, /ptStarted/u, "docker run exit is captured as ptStarted");
  assert.doesNotMatch(ptBlock, /kill \$ptWorker 2>\$null \| Out-Null; & docker rm -f \$ptWorker/u, "no unconditional rm -f immediately after kill (the --rm race)");
});
