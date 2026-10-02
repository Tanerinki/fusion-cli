import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const mod = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "hyperv-poc", "owner.mjs");
const { newOwnerState, addProcess, ownedPids, pocFinalVerdict } = await import(pathToFileURL(mod).href);

test("v0.6 Hyper-V owner: durable ownership accumulates PIDs as resources are acquired (partial-provision safe)", () => {
  let st = newOwnerState("r123");
  assert.equal(st.prefix, "FusionV06Poc-r123");
  assert.deepEqual(ownedPids(st), [], "nothing owned yet");
  // failure injection: throw right after the FIRST listener — cleanup must still see that PID.
  st = addProcess(st, "listener-wrongport", 111, "2026-10-01T00:00:00Z");
  assert.deepEqual(ownedPids(st), [111], "after first listener acquisition, PID 111 is durably owned");
  // failure injection: throw right after the broker — all acquired PIDs are owned.
  st = addProcess(st, "listener-provider", 222, "2026-10-01T00:00:01Z");
  st = addProcess(st, "broker", 333, "2026-10-01T00:00:02Z");
  assert.deepEqual(ownedPids(st), [111, 222, 333], "after broker acquisition, every acquired PID is owned");
});

test("v0.6 Hyper-V owner: ownedPids works from the ownership record ALONE (no final provision document needed)", () => {
  const st = addProcess(addProcess(newOwnerState("r9"), "listener-x", 7, null), "broker", 9, null);
  // Simulates: provision threw before writing provision-<RunId>.json, but owner-<RunId>.json is durable.
  assert.deepEqual(ownedPids(st), [7, 9]);
});

test("v0.6 Hyper-V owner: a cleanup-check failure prevents a final PASS (both proofs required)", () => {
  assert.equal(pocFinalVerdict("PASS", "PASS"), "PASS", "both proofs clean → PASS");
  assert.equal(pocFinalVerdict("PASS", "FAIL"), "FAIL", "run PASS but cleanup FAIL → never PASS");
  assert.equal(pocFinalVerdict("PASS", "INCOMPLETE"), "INCOMPLETE", "run PASS but cleanup unproven → not PASS");
  assert.equal(pocFinalVerdict("FAIL", "PASS"), "FAIL", "run dominates when it did not pass");
  assert.equal(pocFinalVerdict("INCOMPLETE", "PASS"), "INCOMPLETE");
  assert.equal(pocFinalVerdict("EXECUTION_ERROR(x)", "PASS"), "EXECUTION_ERROR(x)");
});
