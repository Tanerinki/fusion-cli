import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { mkdtemp, rmdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { DelegationPacket } from "../../src/core/domain.js";
import { MuseExecTransport } from "../../src/providers/muse/exec-transport.js";
import { MuseMspTransport } from "../../src/providers/muse/msp-transport.js";
import { RESULT_PACKET_SCHEMA } from "../../src/providers/muse/structured-output.js";
import type { MuseLaunchConfig } from "../../src/providers/muse/types.js";

if (process.env.FUSION_LIVE_TESTS !== "1") throw new Error("Live Muse suite requires explicit opt-in.");
const directory = process.env.FUSION_MUSE_BIN_DIR ?? join(process.env.LOCALAPPDATA ?? "", "Programs", "muse");
const versionFile = process.env.FUSION_MUSE_VERSION_FILE ?? join(directory, ".muse-version");
const workspace = process.env.FUSION_MUSE_WORKSPACE ?? process.cwd();
const config: MuseLaunchConfig = { binaryDirectory: directory, versionFile, workspace,
  provider: process.env.FUSION_MUSE_PROVIDER ?? "meta", model: { id: process.env.FUSION_MUSE_MODEL ?? "muse-spark-1.3",
    effort: "minimal", maxTurns: 4 }, posture: "readOnly", timeoutMs: 90_000 };
function packet(goal: string): DelegationPacket {
  return { task: { goal, constraints: ["Read-only; do not modify files."], acceptanceCriteria: ["Return a ResultPacket."] },
    scope: { relevantFiles: [], allowedFiles: [], forbiddenFiles: [] },
    architecture: { decisions: [], invariants: [] }, verification: { requiredTests: [] }, openQuestions: [] };
}

test("live accountLogin and effective MSP provider/model", async () => {
  const msp = new MuseMspTransport(config);
  try { assert.equal((await msp.authStatus()).lane, "subscription");
    assert.equal((await msp.capabilities()).persistentSessions, true);
    const id = await msp.createSession({ modelIdentityReadback: true, subscriptionLaneReadback: true });
    assert.ok(id);
  } finally { await msp.close(); }
});
test("live Exec structured ResultPacket under full read-only flags", async () => {
  const msp = new MuseMspTransport(config);
  try { const exec = new MuseExecTransport({ ...config, maxModelSteps: 4 }, () => msp.authStatus());
    const result = await exec.run({ packet: packet("Report the current workspace path without using tools."),
      requiredCapabilities: { structuredOutput: true, webToolsDisabled: true, filesystem: { write: false }, shell: { available: false } },
      outputSchema: RESULT_PACKET_SCHEMA });
    assert.equal(result.status, "completed");
  } finally { await msp.close(); }
});
test("live U4 approval veto leaves a disposable workspace untouched", async () => {
  const disposable = await mkdtemp(join(tmpdir(), "fusion-live-u4-"));
  const marker = join(disposable, "must-not-exist.txt");
  let approvals = 0;
  const msp = new MuseMspTransport({ ...config, workspace: disposable }, () => { approvals++; return "Deny"; });
  try { const id = await msp.createSession({ approvalCallback: true });
    await msp.runTurn(id, packet(`Attempt to write ${marker} only if an approval is offered; otherwise report that it was blocked.`));
    assert.ok(approvals > 0, "no approval callback was observed");
    await assert.rejects(() => stat(marker), { code: "ENOENT" });
  } finally { await msp.close(); await rmdir(disposable).catch(() => {}); }
});
test("live U5 protocol cancellation returns a non-completed turn", async () => {
  const msp = new MuseMspTransport(config);
  try { const id = await msp.createSession({ protocolCancellation: true });
    const running = msp.runTurn(id, packet("Write a long analysis of the workspace without using tools."));
    await new Promise(resolve => setTimeout(resolve, 250));
    await msp.cancel(id, "liveTest");
    assert.notEqual((await running).status, "completed");
  } finally { await msp.close(); }
});
