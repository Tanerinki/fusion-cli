import assert from "node:assert/strict";
import { test } from "node:test";
import type { DelegationPacket } from "../src/core/domain.js";
import type { TaskRequest } from "../src/core/policy/task-inspector.js";
import { changeSet } from "./fixtures/fake-writer.js";
import { QUOTE_BUGGY, QUOTE_FIXED, REHEARSAL_PACKAGE_JSON } from "./fixtures/rehearsal-project.js";
import { directVerify, FIX, gitAvailable, MEDIUM_PACKET, MEDIUM_TASK, rehearse } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5B7 dependency and platform refusals: a confined verification that cannot start is a classified stop no role can
 * override — the human gate for an unapproved dependency change, a failure for an incompatible or undeclared platform.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const withScope = (paths: readonly string[]): { task: TaskRequest; request: { packet: DelegationPacket } } => ({
  task: { ...MEDIUM_TASK, paths: [...paths] },
  request: { packet: { ...MEDIUM_PACKET, scope: { relevantFiles: [...paths], allowedFiles: [...paths], forbiddenFiles: [] } } } });

test("O5.5B7 N: a ChangeSet that changes the dependency environment stops at the human gate before anything runs", { skip }, async () => {
  const withDependency = REHEARSAL_PACKAGE_JSON.replace('"ms": "2.1.3",', '"left-pad": "1.3.0",\n    "ms": "2.1.3",');
  const changes = changeSet([["src/quote.ts", QUOTE_BUGGY, QUOTE_FIXED], ["package.json", REHEARSAL_PACKAGE_JSON, withDependency]]);
  await rehearse({ worker: () => changes }, ({ result, rig, after, repo }) => {
    assert.deepEqual([result.state, result.transitions.at(-1)?.reason, result.pendingStage, result.error?.kind],
      ["humanGateRequired", "dependencyApprovalRequired", "humanGate", "SecurityViolation"]);
    assert.equal(result.verification?.refusal, "dependencyApprovalRequired");
    assert.deepEqual([rig.streamed.length, rig.fake.commands("create").length], [0, 0], "no preparation and no verification ran");
    assert.equal(result.reviews.length, 0);
    assert.deepEqual(after, repo.before);
  }, withScope(["src/quote.ts", "package.json"]));
  // An approval for a different identity is refused by the lane itself: the candidate cannot self-approve.
  await rehearse({ worker: () => changes }, ({ result, rig }) => {
    assert.deepEqual([result.state, result.transitions.at(-1)?.reason, result.error?.kind], ["failed", "dependencyLaneFailure", "SecurityViolation"]);
    assert.equal(rig.streamed.length, 0);
  }, { ...withScope(["src/quote.ts", "package.json"]),
    port: { approvedDependencyIdentity: { packageJsonSha256: "0".repeat(64), lockfileSha256: "0".repeat(64) } } });
});

test("O5.5B7 O: a Windows-required, undeclared or Windows-escalated task is platformIncompatible for the Linux backend", { skip }, async () => {
  await rehearse({ worker: () => FIX }, ({ result, rig }) => {
    assert.deepEqual([result.state, result.transitions.at(-1)?.reason, result.verification?.refusal], ["failed", "platformIncompatible", "platformIncompatible"]);
    assert.equal(rig.streamed.length, 0);
  }, { port: { declaredPlatform: "windows-required" } });
  const powershell = changeSet([["src/quote.ts", QUOTE_BUGGY, QUOTE_FIXED], ["scripts/setup.ps1", null, "Get-Acl C:\\ | Set-Acl C:\\temp\n"]]);
  await rehearse({ worker: () => powershell }, ({ result, rig }) => {
    assert.deepEqual([result.state, result.transitions.at(-1)?.reason], ["failed", "platformIncompatible"],
      "a deterministic Windows signal in the candidate escalates past the Linux declaration");
    assert.equal(rig.streamed.length, 0);
  }, withScope(["src/quote.ts", "scripts/setup.ps1"]));
  const undeclared = await directVerify({ declaredPlatform: undefined });
  assert.deepEqual([undeclared.verdict.refusal, undeclared.verdict.commandsRun, undeclared.containers], ["platformIncompatible", 0, 0],
    "an undeclared platform is unknown, and unknown is refused");
});
