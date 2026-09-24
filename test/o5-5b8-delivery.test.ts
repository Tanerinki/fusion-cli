import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalChangeSetJson, deliveryManifest, deliveryPreflight, type DeliveryManifest } from "../src/app/delivery.js";
import type { ChangeSet } from "../src/core/domain.js";
import { FusionFailure } from "../src/core/errors.js";
import type { WorkflowResult } from "../src/core/workflow/types.js";
import { ProcessGitClient } from "../src/platform/workspace/git.js";
import { changeSet, sha256 } from "./fixtures/fake-writer.js";
import { memoryRun } from "./fixtures/memory-port.js";
import { QUOTE_BUGGY, QUOTE_FIXED } from "./fixtures/rehearsal-project.js";
import { FIX, git, gitAvailable, primaryEvidence, rehearse, withRehearsalRepo } from "./fixtures/writer-rehearsal-harness.js";

const skip = gitAvailable ? false : "git executable unavailable";
const kind = (expected: string) => (error: unknown) => error instanceof FusionFailure && error.error.kind === expected;
/** A completed result as the engine reports one verified under a GRANTED acceptance (only a real accepted backend can produce it). */
function acceptedResult(changes: ChangeSet): WorkflowResult {
  return { state: "completed", transitions: [], delegateAttempts: 1, reviews: [], changeSet: changes,
    applied: changes.operations.map(op => op.kind === "delete"
      ? { kind: op.kind, path: op.path, beforeSha256: op.expectedSha256, afterSha256: null, bytes: 0 }
      : { kind: op.kind, path: op.path, beforeSha256: op.expectedSha256, afterSha256: sha256(op.content), bytes: Buffer.byteLength(op.content) }),
    verification: { passed: true, commandsRun: 2, evidence: { backendId: "docker-linux", confinement: "osSandbox",
      platformRequirement: "linux-compatible", acceptance: "granted", commands: [] } } };
}
const head = (root: string) => git(root, "rev-parse", "HEAD").trim();

test("O5.5B8 delivery manifest: only a completed run verified under a granted acceptance qualifies — never a rehearsal", { skip }, async () => {
  await rehearse({ worker: () => FIX }, ({ result, repo }) => {
    assert.equal(result.state, "completed");
    assert.throws(() => deliveryManifest({ runId: "b8-run", baseCommit: head(repo.root), result }), kind("SecurityViolation"),
      "an offline rehearsal (fake providers) can never become a deliverable change");
  });
  const memory = await memoryRun({ worker: () => FIX });
  assert.throws(() => deliveryManifest({ runId: "b8-run", baseCommit: "a".repeat(40), result: memory.result }), kind("SecurityViolation"));
  assert.throws(() => deliveryManifest({ runId: "b8-run", baseCommit: "a".repeat(40), result: { ...acceptedResult(FIX), state: "decisionRequired" } }),
    kind("InvalidInput"));
  const manifest = deliveryManifest({ runId: "b8-run", baseCommit: "a".repeat(40), result: acceptedResult(FIX) });
  assert.equal(manifest.changeSetSha256, sha256(canonicalChangeSetJson(FIX)));
  assert.deepEqual(manifest.operations.map(op => [op.kind, op.path]), [["writeText", "src/quote.ts"], ["writeText", "test/quote.test.ts"]]);
  assert.equal(JSON.stringify(manifest).includes(QUOTE_FIXED.slice(0, 40)), false, "the manifest carries hashes, never content");
});

test("O5.5B8 delivery preflight: read-only, deliverable on the unchanged baseline, refused on every kind of drift", { skip }, async () =>
  withRehearsalRepo(async repo => {
    const gitClient = await ProcessGitClient.fromPath(process.env, true);
    const baseCommit = head(repo.root);
    const manifest = deliveryManifest({ runId: "b8-run", baseCommit, result: acceptedResult(FIX) });
    const ok = await deliveryPreflight(manifest, repo.root, gitClient);
    assert.deepEqual([ok.deliverable, ok.conflicts], [true, []], "the user's unrelated uncommitted work does not block delivery");
    assert.deepEqual(ok.preview.map(p => [p.path, p.action]), [["src/quote.ts", "modify"], ["test/quote.test.ts", "modify"]]);
    assert.deepEqual(await primaryEvidence(repo.root), repo.before, "a preflight never writes, locks or refreshes anything");
    // The user edited a target file since the baseline.
    await writeFile(join(repo.root, "src", "quote.ts"), `${QUOTE_BUGGY}// the user's own edit\n`);
    assert.deepEqual((await deliveryPreflight(manifest, repo.root, gitClient)).conflicts, [{ path: "src/quote.ts", reason: "fileChanged" }]);
    await writeFile(join(repo.root, "src", "quote.ts"), QUOTE_BUGGY);
    // A file the ChangeSet creates already exists; a file it modifies was deleted; a parent is a link.
    const extra = changeSet([["src/new.ts", null, "export {};\n"], ["src/money.ts", "irrelevant", null]]);
    const drift = deliveryManifest({ runId: "b8-run", baseCommit, result: acceptedResult({ schemaVersion: 1,
      operations: [...FIX.operations, ...extra.operations] }) });
    await writeFile(join(repo.root, "src", "new.ts"), "the user's file\n");
    await rm(join(repo.root, "src", "money.ts"));
    const reasons = (await deliveryPreflight(drift, repo.root, gitClient)).conflicts.map(c => `${c.path}:${c.reason}`);
    assert.deepEqual(reasons, ["src/new.ts:fileAppeared", "src/money.ts:fileMissing"]);
    const outside = await mkdtemp(join(tmpdir(), "fusion-b8-link-target-"));
    try {
      let linked = false;
      try { await symlink(outside, join(repo.root, "linked"), "junction"); linked = true; } catch { /* links unavailable */ }
      if (linked) {
        const viaLink = deliveryManifest({ runId: "b8-run", baseCommit, result: acceptedResult(changeSet([["linked/x.ts", null, "x\n"]])) });
        assert.deepEqual((await deliveryPreflight(viaLink, repo.root, gitClient)).conflicts, [{ path: "linked/x.ts", reason: "parentNotDirectory" }]);
        await rm(join(repo.root, "linked"), { force: true });
      }
    } finally { await rm(outside, { recursive: true, force: true }); }
    // HEAD moved: every delivery is refused until a new run is made against the new baseline.
    await mkdir(join(repo.root, "docs"), { recursive: true });
    await writeFile(join(repo.root, "docs", "note.md"), "note\n");
    git(repo.root, "add", "docs/note.md");
    git(repo.root, "commit", "-qm", "the user committed");
    assert.ok((await deliveryPreflight(manifest, repo.root, gitClient)).conflicts.some(c => c.reason === "headMoved"));
  }));

test("O5.5B8 delivery preflight: a malformed manifest is refused before anything is read", { skip }, async () =>
  withRehearsalRepo(async repo => {
    const gitClient = await ProcessGitClient.fromPath(process.env, true);
    const base = deliveryManifest({ runId: "b8-run", baseCommit: head(repo.root), result: acceptedResult(FIX) });
    const variants: Array<[string, DeliveryManifest]> = [
      ["traversal", { ...base, operations: [{ ...base.operations[0]!, path: "../outside.txt" }] }],
      ["git internals", { ...base, operations: [{ ...base.operations[0]!, path: ".git/config" }] }],
      ["duplicate", { ...base, operations: [base.operations[0]!, base.operations[0]!] }],
      ["no hash", { ...base, changeSetSha256: "x" }],
      ["empty", { ...base, operations: [] }],
    ];
    for (const [name, manifest] of variants)
      await assert.rejects(deliveryPreflight(manifest, repo.root, gitClient), (error: unknown) => error instanceof FusionFailure, name);
  }));
