import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { prepareBuildDelivery } from "../src/app/build-delivery.js";
import { SCOPE_INSTRUCTION } from "../src/app/build-scope.js";
import { ControlPlane } from "../src/app/control-plane.js";
import type { ChangeSet } from "../src/core/domain.js";
import { FusionFailure } from "../src/core/errors.js";
import type { WorkflowResult } from "../src/core/workflow/types.js";
import { ProcessGitClient } from "../src/platform/workspace/git.js";
import { changeSet } from "./fixtures/fake-writer.js";
import { adjudication, cleanReview, fenced, plan, PREFIX, proposal, reviewWith, type RoleScripts } from "./fixtures/route-harness.js";
import { QUOTE_BUGGY, QUOTE_FIXED, QUOTE_TEST, QUOTE_TEST_WITH_REGRESSION, QUOTE_WRONG } from "./fixtures/rehearsal-project.js";
import { BUILD, line, modelTurns, TASK, withRig } from "./fixtures/v01-rig.js";
import { FIX, gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * v0.1 Block 2 — `fusion build` as a product, offline.
 *
 * The production build branch runs with the REAL CLI, the REAL workflow engine and the REAL Claude and Muse adapters on
 * their deterministic fake binaries (production registry path, `buildWriterCandidates`), host-controlled private candidates
 * and confined verification on a fake Docker daemon. A fake backend can never hold a GRANTED acceptance (only the acceptance
 * authority mints one, for a real Docker backend — a guarded invariant), so these runs are offline rehearsals: the whole
 * route runs, and the result is honestly never delivered. The delivery step itself (`prepareBuildDelivery`, the function
 * the build calls) is then proven on a result verified under a granted acceptance, through approve and apply.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const WRONG = changeSet([["src/quote.ts", QUOTE_BUGGY, QUOTE_WRONG], ["test/quote.test.ts", QUOTE_TEST, QUOTE_TEST_WITH_REGRESSION]]);

test("v0.1 build: confirmed by the human, the real route runs (plan, Change Author, confined verification, fresh review); an offline rehearsal is never delivered",
  { skip }, async () => withRig("pass", { Lead: [{ prefix: PREFIX.plan, output: plan() }], Worker: [proposal(FIX)],
    Reviewer: [{ prefix: PREFIX.review, output: cleanReview }] }, {}, async rig => {
    const built = await rig.cli(BUILD, ["build"]);
    assert.equal(built.code, 0, `${built.stdout}\n${built.stderr}`);
    assert.match(built.questions[0]!, /Type "build" to start/u);
    assert.match(built.stdout, /^Build plan$/mu);
    const planned = /^Risk: (\w+)/mu.exec(built.stdout)?.[1], ran = /^risk: (\w+)/mu.exec(built.stdout)?.[1];
    assert.equal(planned, ran, "the plan the human confirmed carries the risk the run used");
    assert.equal(line(built, "Build: "), "Build: PASS (offline rehearsal — never delivered)");
    assert.equal(line(built, "Verification: "), "Verification: PASS (docker-linux, 2 command(s))");
    assert.equal(line(built, "Review: "), "Review: PASS (1 cycle(s), 0 finding(s), 0 outstanding)");
    assert.equal(line(built, "Delivery: "), undefined, "an offline rehearsal prepares no delivery");
    assert.deepEqual([built.prompts.Lead.length, built.prompts.Worker.length, built.prompts.Reviewer.length], [1, 1, 1]);
    assert.equal(await readFile(join(rig.root, "src", "quote.ts"), "utf8"), QUOTE_BUGGY, "a build never touches the working tree");
  }));

test("v0.1 build: a failed confined verification is retried with a fresh candidate; a confirmed finding is corrected and re-reviewed", { skip }, async () => {
  await withRig("retry", { Lead: [{ prefix: PREFIX.plan, output: plan() }], Worker: [proposal(WRONG), proposal(FIX)],
    Reviewer: [{ prefix: PREFIX.review, output: cleanReview }] }, {}, async rig => {
    const built = await rig.cli(BUILD, ["build"]);
    assert.equal(built.code, 0, `${built.stdout}\n${built.stderr}`);
    assert.equal(built.prompts.Worker.length, 2, "one retry after the failed verification");
    assert.equal(line(built, "Verification: "), "Verification: PASS (docker-linux, 2 command(s))");
  });
  await withRig("correction", { Lead: [{ prefix: PREFIX.plan, output: plan() }, { prefix: PREFIX.adjudication, output: adjudication(["r1-F1", "CONFIRMED", "fix"]) }],
    Worker: [proposal(FIX), proposal(FIX)], Reviewer: [{ prefix: PREFIX.review, output: reviewWith({ id: "F1", severity: "HIGH" }) },
      { prefix: PREFIX.review, output: cleanReview }] }, {}, async rig => {
    const built = await rig.cli(BUILD, ["build"]);
    assert.equal(built.code, 0, `${built.stdout}\n${built.stderr}`);
    assert.deepEqual([built.prompts.Lead.length, built.prompts.Worker.length, built.prompts.Reviewer.length], [2, 2, 2]);
    assert.equal(line(built, "Review: "), "Review: PASS (2 cycle(s), 1 finding(s), 0 outstanding)");
  });
});

test("v0.1 build: no confirmation, a declined confirmation, no confined plan or no verification acceptance — refused before any model turn", { skip }, async () => {
  const scripts: RoleScripts = { Lead: [{ prefix: PREFIX.plan, output: plan() }], Worker: [proposal(FIX)], Reviewer: [{ prefix: PREFIX.review, output: cleanReview }] };
  await withRig("gates", scripts, {}, async rig => {
    const unattended = await rig.cli(BUILD, []);
    assert.equal(unattended.code, 11, unattended.stdout);
    assert.match(unattended.stdout, /a human must confirm at an interactive terminal/u);
    const declined = await rig.cli(BUILD, ["no"]);
    assert.equal(declined.code, 11);
    assert.match(declined.stdout, /Build not started: it was not confirmed/u);
    const json = await rig.cli(["--json", ...BUILD], []);
    assert.equal(JSON.parse(json.stdout).exitCode, 11);
    assert.equal(modelTurns(unattended) + modelTurns(declined) + modelTurns(json), 0);
  });
  await withRig("no-plan", scripts, { confinedPlan: false }, async rig => {
    const built = await rig.cli(BUILD, ["build"]);
    assert.equal(built.code, 11, built.stdout);
    assert.match(built.stdout, /No confined verification plan is configured/u);
    assert.equal(modelTurns(built), 0);
  });
  await withRig("no-acceptance", scripts, { acceptance: "refused" }, async rig => {
    const built = await rig.cli(BUILD, ["build"]);
    assert.equal(built.code, 11, built.stdout);
    assert.match(built.stdout, /Confined verification is not available: test: no acceptance/u);
    assert.equal(modelTurns(built), 0);
    assert.equal(await readFile(join(rig.root, "src", "quote.ts"), "utf8"), QUOTE_BUGGY);
  });
});

test("v0.1 build without --path: the lead proposes the exact scope in one read-only turn, the human confirms it; a hostile proposal stops the build",
  { skip }, async () => {
    const scope = { prefix: SCOPE_INSTRUCTION.slice(0, 60), output: fenced(["src/quote.ts", "test/quote.test.ts"]) };
    await withRig("scoped", { Lead: [scope, { prefix: PREFIX.plan, output: plan() }], Worker: [proposal(FIX)],
      Reviewer: [{ prefix: PREFIX.review, output: cleanReview }] }, {}, async rig => {
      const built = await rig.cli(["build", "--", TASK], ["build"]);
      assert.equal(built.code, 0, `${built.stdout}\n${built.stderr}`);
      assert.match(built.stdout, /^No --path given: asking the lead which files this task needs/mu);
      assert.match(built.stdout, /^Scope \(proposed by lead \([^)]+\); confirm or rerun with --path\): src\/quote\.ts, test\/quote\.test\.ts$/mu);
      assert.equal(line(built, "Build: "), "Build: PASS (offline rehearsal — never delivered)");
      assert.deepEqual([built.prompts.Lead.length, built.prompts.Worker.length, built.prompts.Reviewer.length], [2, 1, 1]);
      assert.ok(built.prompts.Lead[0]!.includes(`Task: ${TASK}`));
    });
    // Without a verifier, a build without --path is refused before the lead's scope turn: no model turn at all.
    await withRig("scope-no-verifier", { Lead: [scope] }, { acceptance: "refused" }, async rig => {
      const built = await rig.cli(["build", "--", TASK], ["build"]);
      assert.equal(built.code, 11, built.stdout + built.stderr);
      assert.match(built.stdout, /^Build not started: Confined verification is not available: test: no acceptance .*No provider was started and nothing was changed\.$/mu);
      assert.equal(built.questions.length, 0);
      assert.equal(modelTurns(built), 0);
    });
    await withRig("hostile-scope",{ Lead: [{ ...scope, output: fenced(["src/quote.ts", "../outside.ts"]) }] }, {}, async rig => {
      const built = await rig.cli(["build", "--", TASK], ["build"]);
      assert.notEqual(built.code, 0);
      assert.match(built.stderr, /not a canonical repository-relative file path/u);
      assert.equal(built.questions.length, 0, "no confirmation is asked for a refused scope");
      assert.deepEqual([built.prompts.Lead.length, built.prompts.Worker.length, built.prompts.Reviewer.length], [1, 0, 0]);
      assert.equal(await readFile(join(rig.root, "src", "quote.ts"), "utf8"), QUOTE_BUGGY);
    });
  });

/** A completed run with `changes`, verified under the given acceptance (only a real accepted backend produces `granted`). */
function verifiedResult(changes: ChangeSet, acceptance: "granted" | "offlineRehearsal"): WorkflowResult {
  return { state: "completed", transitions: [], delegateAttempts: 1, reviews: [], changeSet: changes,
    applied: changes.operations.map(op => op.kind === "delete"
      ? { kind: op.kind, path: op.path, beforeSha256: op.expectedSha256, afterSha256: null, bytes: 0 }
      : { kind: op.kind, path: op.path, beforeSha256: op.expectedSha256, afterSha256: sha256(op.content), bytes: Buffer.byteLength(op.content) }),
    verification: { passed: true, commandsRun: 2, evidence: { backendId: "docker-linux", confinement: "osSandbox", platformRequirement: "linux-compatible",
      acceptance, commands: [{ id: "typecheck", status: "passed", exitCode: 0 }, { id: "unit", status: "passed", exitCode: 0 }] } } };
}

test("v0.1 build delivery: a result verified under a granted acceptance becomes a delivery the human approves and applies; a rehearsal never", { skip }, async () =>
  withRig("delivery", {}, {}, async rig => {
    const plane = new ControlPlane({ registry: rig.registry, env: rig.env, cwd: rig.root });
    const base = (await (await ProcessGitClient.fromPath(process.env, true)).run(["rev-parse", "HEAD"], { cwd: rig.root })).stdout.trim();
    const eventLog = join(rig.dir, "events.jsonl");
    await writeFile(eventLog, `${JSON.stringify({ type: "RunStarted" })}\n`);
    // An offline rehearsal's result is refused by the real preparation path: nothing is stored.
    await assert.rejects(prepareBuildDelivery(plane, { runId: "r-rehearsal", task: TASK, result: verifiedResult(FIX, "offlineRehearsal"), baseCommit: base,
      eventLogPath: eventLog }), (error: unknown) => error instanceof FusionFailure && error.error.kind === "SecurityViolation");
    const delivery = await prepareBuildDelivery(plane, { runId: "r-granted", task: TASK, result: verifiedResult(FIX, "granted"), baseCommit: base, eventLogPath: eventLog });
    assert.match(delivery.deliveryId, /^d-[0-9a-f]{24}$/u);
    assert.equal(await readFile(join(rig.root, "src", "quote.ts"), "utf8"), QUOTE_BUGGY, "preparing applies nothing");
    const inspect = await rig.cli(["inspect-delivery", delivery.deliveryId], []);
    assert.equal(inspect.code, 0, inspect.stderr);
    assert.match(inspect.stdout, new RegExp(`^Manifest: sha256:${delivery.manifestSha256}$`, "mu"));
    assert.equal((await rig.cli(["approve-delivery", delivery.deliveryId], [delivery.manifestSha256])).code, 0);
    const applied = await rig.cli(["apply", delivery.deliveryId], []);
    assert.equal(applied.code, 0, applied.stdout + applied.stderr);
    assert.equal(await readFile(join(rig.root, "src", "quote.ts"), "utf8"), QUOTE_FIXED);
    assert.equal(await readFile(join(rig.root, "test", "quote.test.ts"), "utf8"), QUOTE_TEST_WITH_REGRESSION);
  }));
