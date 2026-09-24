import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionWorkspace } from "../src/core/domain.js";
import { ProcessGitClient } from "../src/platform/workspace/git.js";
import { ProviderViewStore } from "../src/platform/workspace/provider-views.js";
import { ClaudeAdapter } from "../src/providers/claude/claude-adapter.js";
import { MuseAdapter } from "../src/providers/muse/muse-adapter.js";
import { blocker, FIX, gitAvailable, MEDIUM_PACKET, rehearse, VIEW_EXCLUSIONS, withRehearsalRepo } from "./fixtures/writer-rehearsal-harness.js";
import { plan } from "./fixtures/fake-writer.js";
import { claudeBinary, claudeBindingFor, claudeLaunch, launches, museBinary, museBindingFor, museLaunch,
  withInstalls } from "./fixtures/provider-installs.js";

const skip = gitAvailable ? false : "git executable unavailable";

test("O5.5B8 red team: provider output naming the primary by absolute path is refused, and no path is ever persisted", { skip }, async () => {
  let root = "";
  // A ChangeSet aimed at the primary's own absolute path never reaches host application.
  await rehearse({ worker: () => ({ schemaVersion: 1, operations: [{ kind: "writeText", path: join(root, "src", "quote.ts"),
    expectedSha256: null, content: "pwned\n" }] }) }, ({ result, rig: r }) => {
    assert.deepEqual([result.state, result.transitions.at(-1)?.reason], ["failed", "proposalRejected"]);
    assert.equal(r.verifications.length, 0);
  }, { before: r => { root = r.port.primaryRoot; } });
  // A finding locating a defect by the primary's absolute path is malformed; the Lead never sees it.
  await rehearse({ lead: () => plan(`Plan: edit ${root}\\src\\quote.ts directly.`), worker: () => FIX,
    reviewer: () => ({ findings: [blocker("F1", "HIGH", { file: join(root, "src", "quote.ts") })], summary: "" }) }, ({ result, spy, events }) => {
    assert.deepEqual([result.state, result.error?.kind], ["failed", "MalformedOutput"]);
    assert.equal(spy.adjudications.length, 0);
    const persisted = JSON.stringify(events);
    assert.equal(persisted.toLowerCase().includes(root.toLowerCase()), false, "no event carries the primary's path");
    assert.equal(persisted.includes("fusion-provider-view"), false, "nor a view's");
  }, { before: r => { root = r.port.primaryRoot; } });
});

/** Waits until the fake has recorded `count` launches carrying `marker` in their argv. */
async function launched(record: string, marker: string, count: number): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if ((await launches(record)).filter(call => call.argv.includes(marker)).length >= count) return;
    await delay(25);
  }
  throw new Error(`the fake never reached ${count} launches with ${marker}`);
}

test("O5.5B8 red team: cancelling a real provider process mid-turn kills it — its view can be removed at once", { skip }, async () =>
  withInstalls(async i => withRehearsalRepo(async repo => {
    const store = new ProviderViewStore({ primaryRoot: repo.root, git: await ProcessGitClient.fromPath(process.env, true), excludedPaths: VIEW_EXCLUSIONS });
    // Claude: the turn hangs after its init; the cancellation must end the whole process tree.
    const claudeView = await store.baseline("b8-cancel.views");
    const workspace: SessionWorkspace = { id: claudeView.viewId, root: claudeView.path };
    const config = claudeLaunch(i, repo.root, { FUSION_FAKE_SCENARIO: "cancel", FUSION_FAKE_PROMPT_PREFIX: "Fusion change proposal." },
      { timeoutMs: 60_000 });
    const claude = new ClaudeAdapter(claudeBindingFor("Worker", config), config, claudeBinary);
    const session = await claude.createSession({ runId: "b8", role: "Worker", workspaceLeaseId: "c", posture: "readOnly", model: config.model,
      workspace });
    const controller = new AbortController();
    const turn = claude.runChangeProposalTurn!(session, { kind: "changeProposal", packet: MEDIUM_PACKET }, controller.signal);
    await launched(i.record, "-p", 3);
    controller.abort();
    const result = await turn;
    assert.deepEqual([result.status, result.error?.kind], ["cancelled", "Cancelled"]);
    await claude.close(session);
    assert.deepEqual(await store.release(claudeView.viewId), { complete: true },
      "no surviving process holds the view (Windows refuses to remove a directory a live process runs in)");
    // Muse Exec: the same for its turn process.
    const museView = await store.baseline("b8-cancel.views");
    const museConfig = museLaunch(i, repo.root, { FUSION_FAKE_SCENARIO: "hang", FUSION_FAKE_PROMPT_PREFIX: "Fusion change proposal." },
      { timeoutMs: 60_000 });
    const muse = new MuseAdapter(museBindingFor("Worker", museConfig), museConfig, undefined, museBinary(i));
    const museSession = await muse.createSession({ runId: "b8", role: "Worker", workspaceLeaseId: "c", posture: "readOnly",
      model: museConfig.model, workspace: { id: museView.viewId, root: museView.path } });
    const museAbort = new AbortController();
    const museTurn = muse.runChangeProposalTurn!(museSession, { kind: "changeProposal", packet: MEDIUM_PACKET }, museAbort.signal);
    await launched(i.record, "exec", 1);
    museAbort.abort();
    const museResult = await museTurn;
    assert.equal(museResult.status, "cancelled");
    await muse.close(museSession);
    assert.deepEqual(await store.release(museView.viewId), { complete: true });
  })));
