import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { prepareBuildDelivery } from "../src/app/build-delivery.js";
import { ControlPlane } from "../src/app/control-plane.js";
import { deliveryRepository, openDeliveryNamespace, type DeliveryStatus } from "../src/app/delivery-service.js";
import { deliveryResume, runResume, type ResumeCode } from "../src/app/history.js";
import { RunRecorder, type RunSummary } from "../src/app/runs.js";
import type { ChangeSet } from "../src/core/domain.js";
import type { WorkflowResult } from "../src/core/workflow/types.js";
import { ProcessGitClient } from "../src/platform/workspace/git.js";
import { cleanReview, plan, PREFIX, proposal } from "./fixtures/route-harness.js";
import { QUOTE_BUGGY, QUOTE_FIXED } from "./fixtures/rehearsal-project.js";
import { BUILD, modelTurns, TASK, withRig, type Built } from "./fixtures/v01-rig.js";
import { FIX, gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * v0.1 Block 4 — session history and safe resume states, offline: `fusion history` and `fusion show` read the run evidence
 * and the delivery store and name the human's next step; they never start a provider, never resume or replay a model turn,
 * never retry an apply and never reuse a spent approval. Conversations are not recorded at all.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const SECRET = "sk-ant-api03-HISTORYSECRETabcdefghijklmnop";

// ---------------------------------------------------------------- classification

const status = (patch: Partial<DeliveryStatus>): DeliveryStatus =>
  ({ deliveryId: "d-0123456789abcdef01234567", state: "prepared", mutationClaimed: false, attemptLocked: false, failedPrechecks: 0, operations: 2, ...patch });
const run = (patch: Partial<RunSummary>): RunSummary =>
  ({ runId: "r-0000000000-00000000000000000000000000000000", command: "build", status: "completed", createdAt: "2026-09-26T10:00:00.000Z", transitions: 0, modelTurns: 0,
    findings: [], eventLog: "complete", ...patch });

test("v0.1 resume states: every delivery and run state names one safe human step; nothing is ever replayed", () => {
  const cases: Array<[DeliveryStatus, ResumeCode, RegExp]> = [
    [status({}), "deliveryPrepared", /fusion inspect-delivery d-.*fusion approve-delivery d-/u],
    [status({ state: "approved" }), "deliveryApproved", /fusion apply d-/u],
    [status({ state: "approved", lastEvent: { type: "precheckFailed", at: "x", phase: "precheck", issues: ["headMoved"] } }), "precheckFailed", /headMoved.*approval is kept/u],
    [status({ state: "approved", attemptLocked: true }), "attemptInterrupted", /nothing was changed.*stays locked/u],
    [status({ state: "applying", mutationClaimed: true }), "applyInterrupted", /never applied again/u],
    [status({ state: "applying", mutationClaimed: true, attemptLocked: true }), "applyInterrupted", /never applied again/u],
    [status({ state: "applied", mutationClaimed: true }), "applied", /never commits or pushes/u],
    [status({ state: "failed", mutationClaimed: true }), "applyFailed", /approval is spent/u],
    [status({ state: "rolledBack", mutationClaimed: true }), "rolledBack", /approval is spent/u],
    [status({ state: "rollbackFailed", mutationClaimed: true }), "rollbackFailed", /check the working tree now/u],
    [status({ state: "corrupt" }), "deliveryUnavailable", /never applied/u],
    [status({ state: "incomplete" }), "deliveryUnavailable", /never applied/u],
    [status({ state: "otherCheckout" }), "deliveryUnavailable", /another checkout/u],
  ];
  for (const [delivery, code, next] of cases) {
    const resume = deliveryResume(delivery);
    assert.equal(resume.code, code, delivery.state);
    assert.match(resume.next, next, delivery.state);
    assert.doesNotMatch(resume.next, /--force|--yes|automatic/u);
  }
  assert.equal(runResume(run({ status: "running" }), undefined).code, "unfinished");
  assert.match(runResume(run({ status: "running" }), undefined).next, /never resumes or replays provider turns/u);
  assert.equal(runResume(run({ outcome: { state: "BLOCKED", code: "REAL_WRITER_MODE_NOT_READY" } }), undefined).code, "confirmationRequired");
  assert.equal(runResume(run({ outcome: { state: "BLOCKED", code: "verificationUnavailable" } }), undefined).code, "blocked");
  assert.equal(runResume(run({ outcome: { state: "COMPLETED" }, offlineRehearsal: true }), undefined).code, "offlineRehearsal");
  assert.equal(runResume(run({ outcome: { state: "COMPLETED" } }), undefined).code, "completed");
  assert.equal(runResume(run({ outcome: { state: "HUMAN_GATE_REQUIRED" } }), undefined).code, "humanGate");
  assert.equal(runResume(run({ outcome: { state: "FAILED" } }), undefined).code, "failed");
  assert.equal(runResume(run({ outcome: { state: "CANCELLED" } }), undefined).code, "cancelled");
  const delivered = run({ outcome: { state: "COMPLETED" }, deliveryId: "d-0123456789abcdef01234567" });
  assert.equal(runResume(delivered, undefined).code, "deliveryUnavailable");
  assert.equal(runResume(delivered, status({ state: "approved" })).code, "deliveryApproved");
});

// ---------------------------------------------------------------- runs

test("v0.1 history: recent runs newest first with the human's task and the next step; show agrees; reading history starts no provider",
  { skip }, async () => withRig("history", { Lead: [{ prefix: PREFIX.plan, output: plan() }], Worker: [proposal(FIX)],
    Reviewer: [{ prefix: PREFIX.review, output: cleanReview }] }, {}, async rig => {
    const empty = await rig.cli(["history"], []);
    assert.equal(empty.code, 0, empty.stderr);
    assert.match(empty.stdout, /No recorded runs yet/u);
    assert.match(empty.stdout, /Conversations \(chat, analyze\) are not recorded/u);
    assert.equal((await rig.cli(BUILD, [])).code, 11, "an unconfirmed build is recorded as blocked");
    const built = await rig.cli(BUILD, ["build"]);
    assert.equal(built.code, 0, built.stdout + built.stderr);
    const turns = modelTurns(built);
    assert.equal(turns, 3);
    // An interrupted run: started (its task recorded first), never finished — with a secret pasted into the task.
    const plane = new ControlPlane({ registry: rig.registry, env: rig.env, cwd: rig.root });
    const interrupted = await RunRecorder.start(rig.root, "build", plane.redactor, { task: `Rotate the leaked key ${SECRET} in config.ts` });

    const listed = await rig.cli(["history"], []);
    assert.equal(listed.code, 0, listed.stderr);
    const blocks = listed.stdout.split("\n\n").filter(block => /  (build|review)  /u.test(block));
    assert.equal(blocks.length, 3);
    assert.ok(blocks[0]!.includes(interrupted.runId), "newest first");
    assert.match(blocks[0]!, /  build  RUNNING  /u);
    assert.match(blocks[0]!, /task: Rotate the leaked key .*in config\.ts/u);
    assert.match(blocks[0]!, /next: No outcome was recorded.*never resumes or replays provider turns/u);
    assert.match(blocks[1]!, /  build  COMPLETED  /u);
    assert.match(blocks[1]!, new RegExp(`task: ${TASK.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));
    assert.match(blocks[1]!, /next: An offline rehearsal: nothing to deliver\./u);
    assert.match(blocks[2]!, /  build  BLOCKED  /u);
    assert.match(blocks[2]!, /next: Never confirmed: rerun fusion build at an interactive terminal/u);
    assert.ok(!listed.stdout.includes(SECRET), "the recorded task is redacted");

    const limited = await rig.cli(["history", "--limit", "1"], []);
    assert.equal(limited.stdout.split("\n\n").filter(block => /  build  /u.test(block)).length, 1);
    assert.match(limited.stdout, /Older runs exist/u);
    const json = await rig.cli(["--json", "history"], []);
    const document = JSON.parse(json.stdout) as { exitCode: number; history: { runs: Array<{ summary: RunSummary; resume: { code: string } }>; conversations: string } };
    assert.equal(document.exitCode, 0);
    assert.deepEqual(document.history.runs.map(entry => entry.resume.code), ["unfinished", "offlineRehearsal", "confirmationRequired"]);
    assert.equal(document.history.conversations, "notRecorded");
    assert.equal((await rig.cli(["history", "--limit", "0"], [])).code, 2);
    assert.equal((await rig.cli(["history", "extra"], [])).code, 2);

    const runId = document.history.runs[1]!.summary.runId;
    const shown = await rig.cli(["show", runId], []);
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, new RegExp(`^task: ${TASK.slice(0, 20)}`, "mu"));
    assert.match(shown.stdout, /^next: An offline rehearsal: nothing to deliver\.$/mu);
    const shownInterrupted = await rig.cli(["show", interrupted.runId], []);
    assert.match(shownInterrupted.stdout, /^next: No outcome was recorded/mu);
    // Reading history replays nothing: no provider turn since the build.
    assert.equal(modelTurns(shownInterrupted), turns);
    // Trusted evidence holds the redacted task, never the secret.
    for (const kind of ["json"]) {
      const directory = join(rig.root, ".fusion", "runs", interrupted.runId, "artifacts", kind);
      for (const file of await readdir(directory)) assert.ok(!(await readFile(join(directory, file), "utf8")).includes(SECRET));
    }
  }));

// ---------------------------------------------------------------- deliveries

/** A completed run with `changes`, verified under a granted acceptance (only a real accepted backend produces one). */
function granted(changes: ChangeSet): WorkflowResult {
  return { state: "completed", transitions: [], delegateAttempts: 1, reviews: [], changeSet: changes,
    applied: changes.operations.map(op => op.kind === "delete"
      ? { kind: op.kind, path: op.path, beforeSha256: op.expectedSha256, afterSha256: null, bytes: 0 }
      : { kind: op.kind, path: op.path, beforeSha256: op.expectedSha256, afterSha256: sha256(op.content), bytes: Buffer.byteLength(op.content) }),
    verification: { passed: true, commandsRun: 2, evidence: { backendId: "docker-linux", confinement: "osSandbox", platformRequirement: "linux-compatible",
      acceptance: "granted", commands: [{ id: "typecheck", status: "passed", exitCode: 0 }, { id: "unit", status: "passed", exitCode: 0 }] } } };
}
const nextOf = (listed: Built, deliveryId: string) => listed.stdout.split("\n").find(entry => entry.includes(deliveryId)) ?? "";

test("v0.1 history of deliveries: prepared → approved → applied; a spent approval, an interrupted claim or an interrupted attempt is never replayed",
  { skip }, async () => withRig("deliveries", {}, {}, async rig => {
    const plane = new ControlPlane({ registry: rig.registry, env: rig.env, cwd: rig.root });
    const base = (await (await ProcessGitClient.fromPath(process.env, true)).run(["rev-parse", "HEAD"], { cwd: rig.root })).stdout.trim();
    const eventLog = join(rig.dir, "events.jsonl");
    await writeFile(eventLog, `${JSON.stringify({ type: "RunStarted" })}\n`);
    const prepare = (runId: string) => prepareBuildDelivery(plane, { runId, task: TASK, result: granted(FIX), baseCommit: base, eventLogPath: eventLog });
    const [one, claimed, locked] = [await prepare("r-one"), await prepare("r-claimed"), await prepare("r-locked")];
    let listed = await rig.cli(["history"], []);
    assert.match(nextOf(listed, one.deliveryId), /\(prepared\) — Inspect it/u);
    for (const delivery of [one, claimed, locked])
      assert.equal((await rig.cli(["approve-delivery", delivery.deliveryId], [delivery.manifestSha256])).code, 0);
    listed = await rig.cli(["history"], []);
    assert.match(nextOf(listed, one.deliveryId), /\(approved\) — Apply it: fusion apply/u);

    // A process that died right after taking the single-use claim (the store's own operations, in the apply's order).
    const namespace = await openDeliveryNamespace(await deliveryRepository(plane), false);
    const event = (type: "precheckStarted" | "precheckPassed" | "applyStarted", deliveryId: string) => namespace.store.appendEvent(deliveryId,
      { type, at: new Date().toISOString(), observedHead: type === "precheckStarted" ? null : base, touchedPaths: 2, phase: type === "applyStarted" ? "apply" : "precheck",
        issues: [], rollback: null });
    await namespace.store.acquireAttempt(claimed.deliveryId);
    await event("precheckStarted", claimed.deliveryId);
    await event("precheckPassed", claimed.deliveryId);
    await namespace.store.claimMutation(claimed.deliveryId, namespace.checkoutSha256, new Date().toISOString());
    await event("applyStarted", claimed.deliveryId);
    // A process that died during its precheck, before any claim.
    await namespace.store.acquireAttempt(locked.deliveryId);
    await event("precheckStarted", locked.deliveryId);

    listed = await rig.cli(["history"], []);
    assert.match(nextOf(listed, claimed.deliveryId), /\(applying\) — An apply holds its single-use claim.*never applied again/u);
    assert.match(nextOf(listed, locked.deliveryId), /\(approved\) — An apply attempt is running, or one was interrupted before its claim/u);
    const replayClaim = await rig.cli(["apply", claimed.deliveryId], []);
    assert.equal(replayClaim.code, 2, replayClaim.stdout + replayClaim.stderr);
    assert.match(replayClaim.stderr, /approval was spent/u);
    const replayLocked = await rig.cli(["apply", locked.deliveryId], []);
    assert.equal(replayLocked.code, 8, replayLocked.stdout + replayLocked.stderr);
    assert.match(replayLocked.stderr, /interrupted before its claim; nothing was changed/u);
    assert.equal(await readFile(join(rig.root, "src", "quote.ts"), "utf8"), QUOTE_BUGGY, "no replayed attempt wrote anything");

    const applied = await rig.cli(["apply", one.deliveryId], []);
    assert.equal(applied.code, 0, applied.stdout + applied.stderr);
    assert.equal(await readFile(join(rig.root, "src", "quote.ts"), "utf8"), QUOTE_FIXED);
    listed = await rig.cli(["history"], []);
    assert.match(nextOf(listed, one.deliveryId), /\(applied\) — Applied to the working tree.*never commits or pushes/u);
    // The consumed claim is never replayed: a second apply is refused and changes nothing.
    await writeFile(join(rig.root, "src", "quote.ts"), QUOTE_BUGGY);
    const again = await rig.cli(["apply", one.deliveryId], []);
    assert.equal(again.code, 2);
    assert.match(again.stderr, /approval was spent by its one claimed apply/u);
    assert.equal(await readFile(join(rig.root, "src", "quote.ts"), "utf8"), QUOTE_BUGGY);
    assert.equal(modelTurns(again), 0, "no provider ran at any point");
  }));
