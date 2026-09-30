import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";
import { RunRecorder } from "../src/app/runs.js";
import { reconstructRun } from "../src/app/durable-run.js";
import { assertHumanGateUnchanged, humanGateBinding, humanGateObjectHash, type HumanGateObject } from "../src/core/durability/human-gate.js";
import { FusionFailure } from "../src/core/errors.js";
import { DiagnosticRedactor } from "../src/core/policy/redaction.js";
import { gitAvailable, withRehearsalRepo } from "./fixtures/writer-rehearsal-harness.js";

const skip = gitAvailable ? false : "git executable unavailable";
const run = promisify(execFile);
const child = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures", "human-gate-child.mjs");
const TASK = "Rotate the production signing key and re-issue every certificate.";
const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const GATE = (over: Partial<HumanGateObject> = {}): HumanGateObject =>
  ({ taskSha256: sha(TASK), pendingStage: "humanGate", reason: "humanGateRequired", decision: null, ...over });

// ---------------------------------------------------------------- the object binding, directly (pure)

test("v0.6 I8 binding: the same gate object hashes identically; a changed task, reason or decision hashes differently", () => {
  assert.equal(humanGateObjectHash(GATE()), humanGateObjectHash(GATE()), "deterministic for the same object");
  assert.notEqual(humanGateObjectHash(GATE()), humanGateObjectHash(GATE({ taskSha256: sha("a different task") })), "a different task");
  assert.notEqual(humanGateObjectHash(GATE()), humanGateObjectHash(GATE({ reason: "dependencyApprovalRequired" })), "a different reason");
  assert.notEqual(humanGateObjectHash(GATE()), humanGateObjectHash(GATE({ decision: { kind: "approveDependencies" } })), "a different decision");
  // The ephemeral run id is NOT part of the object — the same pending work has one identity across runs.
  assert.equal(/^[0-9a-f]{64}$/u.test(humanGateObjectHash(GATE())), true);
});

test("v0.6 I8 binding: assertHumanGateUnchanged passes for the exact gate and refuses any drift (security stop)", () => {
  const persisted = humanGateBinding(GATE());
  assert.doesNotThrow(() => assertHumanGateUnchanged(persisted, humanGateBinding(GATE())));
  const violation = (e: unknown) => e instanceof FusionFailure && e.error.kind === "SecurityViolation";
  assert.throws(() => assertHumanGateUnchanged(persisted, humanGateBinding(GATE({ taskSha256: sha("other") }))), violation, "a changed object");
  assert.throws(() => assertHumanGateUnchanged(persisted, humanGateBinding(GATE({ reason: "other" }))), violation, "a changed reason");
  assert.throws(() => assertHumanGateUnchanged(persisted, { ...persisted, objectHash: "f".repeat(64) }), violation, "a forged hash");
});

// ---------------------------------------------------------------- a real run stopped at a human gate

test("v0.6 I8: a run stopped at a human gate is durable as a PENDING hash-bound gate — reconstructed as INTERRUPTED, never COMPLETED", { skip }, async () =>
  withRehearsalRepo(async repo => {
    const recorder = await RunRecorder.start(repo.root, "build", new DiagnosticRedactor(), { task: TASK });
    await recorder.finish({ state: "HUMAN_GATE_REQUIRED", exitCode: 14, code: "humanGateRequired", pendingStage: "humanGate",
      message: "a human must approve" });
    const rc = await reconstructRun(repo.root, recorder.runId);
    assert.ok(rc !== null, "the run reconstructs from its journal");
    assert.equal(rc!.state, "INTERRUPTED", "a paused gate is not a completed run");
    assert.notEqual(rc!.state, "COMPLETED");
    assert.ok(rc!.pendingHumanGate !== undefined, "the pending gate is surfaced");
    assert.equal(rc!.pendingHumanGate!.objectHash, humanGateObjectHash(GATE()), "bound to exactly the gate object");
    assert.equal(rc!.pendingHumanGate!.reason, "humanGateRequired");
    // The exact-resume contract: a resume that re-derives the SAME object matches; a different one is refused.
    assert.doesNotThrow(() => assertHumanGateUnchanged(rc!.pendingHumanGate!, humanGateBinding(GATE())));
    assert.throws(() => assertHumanGateUnchanged(rc!.pendingHumanGate!, humanGateBinding(GATE({ decision: { kind: "somethingElse" } }))),
      (e: unknown) => e instanceof FusionFailure);
  }));

test("v0.6 I8 CRASH (two processes): a gate raised by one process is re-presented EXACTLY by a fresh process, hash-bound", { skip }, async () =>
  withRehearsalRepo(async repo => {
    const out = await run(process.execPath, [child, repo.root, TASK]).catch((e: unknown) => e as { stdout: string });
    const runId = /RUNID:(\S+)/u.exec((out as { stdout: string }).stdout)?.[1];
    assert.ok(runId, `the child printed its run id: ${(out as { stdout: string }).stdout}`);
    // A fresh process reconstructs the interrupted run and re-presents the EXACT pending gate.
    const rc = await reconstructRun(repo.root, runId!);
    assert.equal(rc!.state, "INTERRUPTED");
    assert.ok(rc!.pendingHumanGate !== undefined, "the fresh process sees the pending gate");
    assert.equal(rc!.pendingHumanGate!.objectHash, humanGateObjectHash(GATE()), "the re-presented gate is bound to exactly the object the first process recorded");
    // Approving precisely that object is accepted; approving anything else is refused across the restart.
    assert.doesNotThrow(() => assertHumanGateUnchanged(rc!.pendingHumanGate!, humanGateBinding(GATE())));
    assert.throws(() => assertHumanGateUnchanged(rc!.pendingHumanGate!, humanGateBinding(GATE({ taskSha256: sha("a different task entirely") }))),
      (e: unknown) => e instanceof FusionFailure && e.error.kind === "SecurityViolation");
  }));
