import assert from "node:assert/strict";
import { test } from "node:test";
import { FRESH_CANDIDATE_CONSTRAINT } from "../src/core/workflow/packets.js";
import { changeSet } from "./fixtures/fake-writer.js";
import { QUOTE_BUGGY, QUOTE_FIXED, QUOTE_TEST, QUOTE_TEST_WITH_REGRESSION, QUOTE_WRONG } from "./fixtures/rehearsal-project.js";
import { candidateGone, FIX, FIX_ONLY, gitAvailable, rehearse, testCountsOf, transitionsOf,
  WRONG } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5B7 offline rehearsal: retries and candidate reconstruction through the real engine and the real candidate port.
 * Every attempt is a fresh private candidate at the committed baseline plus one complete ChangeSet; nothing of a
 * discarded attempt survives into the next.
 */
const skip = gitAvailable ? false : "git executable unavailable";

test("O5.5B7 D: a stale SHA precondition is refused before any mutation; the retry starts from a fresh baseline candidate",
  { skip }, async () => {
    const stale = changeSet([["src/quote.ts", "what the Worker wrongly believed\n", QUOTE_FIXED],
      ["test/quote.test.ts", QUOTE_TEST, QUOTE_TEST_WITH_REGRESSION]]);
    await rehearse({ worker: ({ call }) => call === 1 ? stale : FIX }, ({ result, spy, rig, events, after, repo }) => {
      assert.equal(result.state, "completed", JSON.stringify(result.error));
      assert.equal(result.delegateAttempts, 2);
      assert.ok(transitionsOf(result).includes("delegating>retrying:applicationRejected"));
      assert.ok(events.some(e => e.type === "candidate" && e.attempt === 1 && e.phase === "preconditionFailed"));
      assert.equal(rig.streamed.length, 1, "the stale proposal was never verified");
      const retry = spy.proposals[1]!;
      assert.ok(retry.task.constraints.includes(
        "Attempt 2 of 2: the proposed file hashes did not match the committed baseline for 1 file(s): src/quote.ts."));
      assert.ok(retry.task.constraints.includes(FRESH_CANDIDATE_CONSTRAINT));
      assert.deepEqual(rig.port.handles.map(candidateGone), [true, true]);
      assert.notEqual(rig.port.handles[0]!.path, rig.port.handles[1]!.path);
      assert.deepEqual(after, repo.before);
    });
  });

test("O5.5B7 E: a failed confined verification escalates risk and gets one retry in a fresh candidate", { skip }, async () =>
  rehearse({ worker: ({ call }) => call === 1 ? WRONG : FIX }, ({ result, rig, events, after, repo }) => {
    assert.equal(result.state, "completed", JSON.stringify(result.error));
    assert.equal(result.risk?.level, "high", "a verification failure is evidence; risk never goes back down");
    assert.ok(transitionsOf(result).includes("verifying>retrying:verificationFailed"));
    const verified = events.flatMap(e => e.type === "verification" ? [[e.attempt, e.passed, e.evidence?.commands.map(c => `${c.id}:${c.status}`)]] : []);
    assert.deepEqual(verified, [[1, false, ["typecheck:passed", "unit:failed"]], [2, true, ["typecheck:passed", "unit:passed"]]]);
    assert.deepEqual(testCountsOf(rig, 0)[1], ["unit", { tests: 11, pass: 9, fail: 2, cancelled: 0, skipped: 0, todo: 0 }]);
    assert.equal(rig.streamed[1]!.files.get("src/quote.ts")?.toString("utf8"), QUOTE_FIXED,
      "the second candidate holds only the second proposal: nothing of the failed first one survived");
    // The same approved dependency identity serves both attempts: prepared once, then a validated cache hit.
    const deps = events.flatMap(e => e.type === "verification" ? [e.evidence?.dependencies] : []);
    assert.deepEqual(deps.map(d => [d?.prepared, d?.cacheHit]), [[true, false], [false, true]]);
    assert.equal(deps[0]?.key, deps[1]?.key);
    assert.equal(rig.fake.commands("create").filter(args => args.includes("fusion.mode=deps")).length, 1, "one preparation for one identity");
    assert.deepEqual(after, repo.before);
  }));

test("O5.5B7 reconstruction: a discarded attempt's changed and deleted files never leak into the next candidate", { skip }, async () => {
  const messy = changeSet([["src/quote.ts", QUOTE_BUGGY, QUOTE_WRONG], ["test/quote.test.ts", QUOTE_TEST, null]]);
  await rehearse({ worker: ({ call }) => call === 1 ? messy : FIX_ONLY }, ({ result, rig, after, repo }) => {
    assert.equal(rig.streamed[0]!.files.has("test/quote.test.ts"), false, "attempt 1 deleted the test file in its own candidate");
    assert.equal(rig.streamed[1]!.files.get("test/quote.test.ts")?.toString("utf8"), QUOTE_TEST,
      "attempt 2 starts from the committed baseline: the deleted file is back, unchanged");
    assert.equal(rig.streamed[1]!.files.get("src/quote.ts")?.toString("utf8"), QUOTE_FIXED);
    assert.deepEqual(result.changedPaths, ["src/quote.ts"]);
    assert.deepEqual(result.applied?.map(op => op.path), ["src/quote.ts"], "the final ledger is the final ChangeSet only");
    assert.equal(result.state, "completed", JSON.stringify(result.error));
    assert.deepEqual(after, repo.before);
  });
});
