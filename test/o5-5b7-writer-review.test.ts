import assert from "node:assert/strict";
import { test } from "node:test";
import { FRESH_CANDIDATE_CONSTRAINT } from "../src/core/workflow/packets.js";
import { judge } from "./fixtures/fake-writer.js";
import { MemoryPort, memoryRun } from "./fixtures/memory-port.js";
import { blocker, FIX, FIX_ONLY, gitAvailable, rehearse, transitionsOf } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5B7 offline rehearsal: fresh review, Lead adjudication and the bounded correction through the real engine. The
 * correction runs on the real candidate port: a complete ChangeSet in a fresh candidate, verified and freshly re-reviewed.
 */
const skip = gitAvailable ? false : "git executable unavailable";

test("O5.5B7 F/G/H: a BLOCKER finding the Lead confirms gets exactly one correction, verified and freshly re-reviewed", { skip }, async () =>
  rehearse({
    worker: ({ call }) => call === 1 ? FIX_ONLY : FIX,
    reviewer: ({ call }) => call === 1 ? { findings: [blocker("F1", "BLOCKER")], summary: "One blocker." } : { findings: [], summary: "Resolved." },
    adjudicator: ({ request }) => judge(request, "CONFIRMED"),
  }, ({ result, spy, rig, after, repo }) => {
    assert.equal(result.state, "completed", JSON.stringify(result.error));
    assert.deepEqual(result.reviews.map(r => [r.cycle, r.outcome, r.findings.map(f => f.severity)]), [[1, "correction", ["BLOCKER"]], [2, "clean", []]]);
    assert.deepEqual(result.reviews[0]!.adjudications.map(a => [a.verdict, a.requiredAction, a.verdictSource]), [["CONFIRMED", "fix", "lead"]]);
    assert.equal(result.delegateAttempts, 2);
    assert.ok(transitionsOf(result).includes("adjudicating>retrying:reviewFindingsConfirmed"));
    const correction = spy.proposals[1]!;
    assert.ok(correction.task.constraints.some(c => c.startsWith("Fix r1-F1 [BLOCKER]") && c.includes("Suggested fix: Add a test")));
    assert.ok(correction.task.constraints.includes(FRESH_CANDIDATE_CONSTRAINT));
    assert.deepEqual(spy.reviews[1]!.priorFindings.map(f => f.id), ["r1-F1"]);
    assert.equal(rig.streamed.length, 2, "the correction is verified again");
    assert.match(spy.reviews[1]!.evidence.change.text, /a full discount leaves nothing to tax/u, "the re-review sees the corrected candidate");
    const [first, second] = spy.sessions.filter(s => s.role === "Reviewer");
    assert.notEqual(first!.id, second!.id, "the re-review is a new session");
    assert.deepEqual([first!.workspaceLeaseId, second!.workspaceLeaseId], rig.port.handles.map(h => h.leaseId), "each review sees its own candidate");
    assert.deepEqual(result.cleanup, { candidates: 2, released: 2, complete: true });
    assert.deepEqual(after, repo.before);
  }));

test("O5.5B7 K: a malformed Reviewer packet fails closed after verification and never reaches the Lead", async () => {
  for (const reviewer of [() => "LGTM", () => ({ findings: [], summary: "LGTM", reasoning: "hidden chain of thought" }),
    () => ({ findings: [{ ...blocker("F1", "HIGH"), severity: "CRITICAL" }], summary: "" })]) {
    const { result, spy, port } = await memoryRun({ worker: () => FIX, reviewer });
    assert.deepEqual([result.state, result.transitions.at(-1)?.reason, result.error?.kind], ["failed", "malformedResult", "MalformedOutput"]);
    assert.equal(port.verified.length, 1);
    assert.equal(spy.adjudications.length, 0, "a malformed review never reaches the Lead");
    assert.deepEqual(port.released, ["candidate-1"]);
  }
  const lead = await memoryRun({ worker: () => FIX, reviewer: () => ({ findings: [blocker("F1", "HIGH")], summary: "" }),
    adjudicator: () => ({ adjudications: [], summary: "All fine, trust me." }) }, new MemoryPort());
  assert.deepEqual([lead.result.state, lead.result.transitions.at(-1)?.reason], ["failed", "malformedResult"],
    "an adjudication that skips a finding is malformed");
});
