import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProcessSupervisor, type TreeTerminator } from "../src/platform/process/supervisor.js";
import { buildOwnedSubtree, countOwnedSurvivors, defaultProcessTreeInspector,
  type OwnedTreeSnapshot, type ProcessEntry, type ProcessTreeInspector } from "../src/platform/process/process-tree.js";

// Windows process-termination cleanup is AUTHORITATIVE on the owned process tree (root via the OS handle + descendants
// via a pre-kill snapshot verified by PID+creation key), never on taskkill's exit code. No model inference anywhere.
const cwd = mkdtempSync(join(tmpdir(), "fusion-term-"));
const FOREVER = ["-e", "setInterval(() => {}, 1000)"];
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const killIfAlive = (pid: number): void => { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } };

const reaping = (method: "taskkill" | "directKill"): TreeTerminator => async child => { child.kill("SIGKILL"); return { method }; };
// A fake inspector driving deterministic descendant scenarios; `survivors` is consumed per survivingOwned() call.
const fakeInspector = (opts: { captured?: boolean; survivors?: (number | "unknown")[] }): ProcessTreeInspector => {
  let i = 0;
  return {
    snapshot: async rootPid => ({ rootPid, members: [{ pid: 4242, key: "k" }], captured: opts.captured ?? true }),
    survivingOwned: async () => { const seq = opts.survivors ?? [0]; return seq[Math.min(i++, seq.length - 1)]!; },
    killOwned: async () => { /* no-op; survivingOwned sequence models the effect */ },
  };
};

async function forcedOutcome(terminator: TreeTerminator, inspector: ProcessTreeInspector) {
  const run = new ProcessSupervisor(undefined, terminator, inspector).start({ executable: process.execPath, args: FOREVER,
    cwd, env: { ...process.env }, graceMs: 20, killWaitMs: 600 });
  const pid = run.pid ?? 0;
  try { await run.cancel("user"); return { outcome: await run.result, pid }; }
  finally { killIfAlive(pid); }
}

// ---- pure owned-subtree logic (PID-reuse safety + TOCTOU post-snapshot detection) --------------------------------
test("v0.6 term pure: descendants only; PID reuse is not a survivor; a POST-SNAPSHOT child is detected", () => {
  const all: ProcessEntry[] = [
    { pid: 10, ppid: 1, key: "r" }, { pid: 20, ppid: 10, key: "c" }, { pid: 30, ppid: 20, key: "g" },
    { pid: 40, ppid: 2, key: "u" }, // unrelated
  ];
  const members = buildOwnedSubtree(all, 10);
  assert.deepEqual(members.map(m => m.pid).sort((a, b) => a - b), [20, 30]);
  const snap: OwnedTreeSnapshot = { rootPid: 10, members, captured: true };
  // after kill, everything gone -> 0 survivors
  assert.equal(countOwnedSurvivors(snap, [{ pid: 40, ppid: 2, key: "u" }]), 0);
  // PID 30 REUSED by a different process (different key) and not parent-linked -> NOT a survivor
  assert.equal(countOwnedSurvivors(snap, [{ pid: 30, ppid: 777, key: "DIFFERENT" }]), 0);
  // same pid AND same key -> a real survivor
  assert.equal(countOwnedSurvivors(snap, [{ pid: 30, ppid: 20, key: "g" }]), 1);
  // TOCTOU: a child spawned AFTER the snapshot by a member (ppid=20) or the root (ppid=10) -> detected as a survivor
  assert.equal(countOwnedSurvivors(snap, [{ pid: 88, ppid: 20, key: "late-child" }]), 1, "post-snapshot child of a member");
  assert.equal(countOwnedSurvivors(snap, [{ pid: 99, ppid: 10, key: "late-root-child" }]), 1, "post-snapshot child of the root");
});

// 1 / C. taskkill non-zero fallback + no surviving descendant -> cleanup clean (THE canary false-failure fix)
test("v0.6 term 1/C: taskkill non-zero + owned tree proven gone -> clean", async () => {
  const { outcome } = await forcedOutcome(reaping("directKill"), fakeInspector({ survivors: [0] }));
  assert.equal(outcome.termination?.forced, true);
  assert.equal(outcome.termination?.method, "directKill");
  assert.equal(outcome.termination?.cleanupError, undefined);
});

// B / D. root reaped (taskkill "succeeded") but a descendant survives -> NOT clean (root exit != owned tree gone)
test("v0.6 term B/D: a surviving owned descendant fails cleanup even when the root is gone and taskkill 'succeeded'", async () => {
  const { outcome } = await forcedOutcome(reaping("taskkill"), fakeInspector({ survivors: [2, 2, 2, 2] }));
  assert.equal(outcome.termination?.method, "taskkill");
  assert.match(outcome.termination?.cleanupError ?? "", /descendant.*survived/u);
});

// a survivor that is reaped on retry then verified gone -> clean (kill + RE-VERIFY, not a sleep, is the proof)
test("v0.6 term: a descendant killed and then re-verified gone -> clean", async () => {
  const { outcome } = await forcedOutcome(reaping("taskkill"), fakeInspector({ survivors: [1, 0] }));
  assert.equal(outcome.termination?.cleanupError, undefined);
});

// unknown owned-tree state fails CLOSED
test("v0.6 term: unverifiable owned-tree state fails closed", async () => {
  const unknown = await forcedOutcome(reaping("taskkill"), fakeInspector({ survivors: ["unknown"] }));
  assert.match(unknown.outcome.termination?.cleanupError ?? "", /could not be verified/u);
  const uncaptured = await forcedOutcome(reaping("taskkill"), fakeInspector({ captured: false }));
  assert.match(uncaptured.outcome.termination?.cleanupError ?? "", /could not be captured/u);
});

// 5. timeout remains Timeout; 6. cancellation remains Cancelled; 8. a clean cleanup never masks the run issue
test("v0.6 term 5/6/8: timeout/cancel issues are preserved and never masked by a clean cleanup", async () => {
  const run = new ProcessSupervisor(undefined, reaping("directKill"), fakeInspector({ survivors: [0] })).start({
    executable: process.execPath, args: FOREVER, cwd, env: { ...process.env }, timeoutMs: 120, killWaitMs: 600 });
  const pid = run.pid ?? 0;
  try {
    const o = await run.result;
    assert.equal(o.termination?.cleanupError, undefined, "cleanup clean");
    assert.equal(o.issue?.kind, "Timeout", "...yet the Timeout is preserved");
    assert.notEqual(o.exitCode, 0);
  } finally { killIfAlive(pid); }
  const { outcome } = await forcedOutcome(reaping("directKill"), fakeInspector({ survivors: [0] }));
  assert.equal(outcome.issue?.kind, "Cancelled");
  const fail = new ProcessSupervisor().start({ executable: process.execPath, args: ["-e", "process.exit(3)"], cwd, env: { ...process.env } });
  assert.equal((await fail.result).exitCode, 3, "a non-zero child exit is never masked");
});

// 7. spawn failure remains SpawnFailure
test("v0.6 term 7: a non-existent executable stays a SpawnFailure", async () => {
  const run = new ProcessSupervisor().start({ executable: join(cwd, "does-not-exist.exe"), args: [], cwd, env: { ...process.env } });
  assert.equal((await run.result).issue?.kind, "SpawnFailure");
});

// ---- PRODUCTION regressions with the REAL default inspector + real process trees ---------------------------------
async function realTree(): Promise<{ outcome: Awaited<ReturnType<ProcessSupervisor["start"]>["result"]>; rootPid: number; gcPid: number }> {
  // a real parent that spawns a real (non-detached) grandchild and prints its PID, then both run forever
  const parent = "const{spawn}=require('node:child_process');const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});" +
    "process.stdout.write('GC '+g.pid+'\\n');setInterval(()=>{},1000);";
  let gcPid = 0;
  const run = new ProcessSupervisor(undefined, undefined, defaultProcessTreeInspector).start({
    executable: process.execPath, args: ["-e", parent], cwd, env: { ...process.env }, graceMs: 50, killWaitMs: 4000,
    onStdoutText: t => { const m = /GC (\d+)/u.exec(t); if (m) gcPid = Number(m[1]); } });
  const rootPid = run.pid ?? 0;
  for (let i = 0; i < 100 && gcPid === 0; i++) await new Promise(r => setTimeout(r, 50)); // wait for the grandchild to report
  await run.cancel("user");
  return { outcome: await run.result, rootPid, gcPid };
}

// A. real grandchild: forced termination detects + kills + PROVES the whole owned tree gone
test("v0.6 term A: a real grandchild is detected, killed and proven gone (production inspector)", { skip: process.platform !== "win32" }, async () => {
  const { outcome, gcPid } = await realTree();
  try {
    assert.ok(gcPid > 0, "grandchild reported its pid");
    assert.equal(outcome.termination?.forced, true);
    assert.equal(outcome.termination?.cleanupError, undefined, "owned tree proven gone -> clean");
    await new Promise(r => setTimeout(r, 100));
    assert.equal(alive(gcPid), false, "the grandchild is actually dead");
  } finally { killIfAlive(gcPid); }
});

// E. PID reuse during verification cannot produce a false survivor OR a false clean
test("v0.6 term E: survivors match on PID+creation key (no PID-reuse false result)", () => {
  const snap: OwnedTreeSnapshot = { rootPid: 5, members: [{ pid: 777, key: "born-at-A" }], captured: true };
  assert.equal(countOwnedSurvivors(snap, [{ pid: 777, ppid: 1, key: "born-at-B" }]), 0, "reused PID (new key, unlinked) is not a survivor");
  assert.equal(countOwnedSurvivors(snap, [{ pid: 777, ppid: 1, key: "born-at-A" }]), 1, "same process is a survivor");
});

// A2 / B. REAL: a descendant spawned DURING cancellation grace (after the reap-start snapshot) is captured by the
// pre-kill re-snapshot, reaped, and proven gone -> clean; the late grandchild must be dead.
test("v0.6 term A2/B: a grace-window grandchild is captured, reaped and proven gone (production inspector)", { skip: process.platform !== "win32" }, async () => {
  // parent spawns a grandchild ~150ms in (after cancel+reap-start snapshot, during the grace window), both run forever
  const parent = "const{spawn}=require('node:child_process');" +
    "setTimeout(()=>{const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write('LATE '+g.pid+'\\n');},150);" +
    "setInterval(()=>{},1000);";
  let latePid = 0;
  const run = new ProcessSupervisor(undefined, undefined, defaultProcessTreeInspector).start({
    executable: process.execPath, args: ["-e", parent], cwd, env: { ...process.env }, graceMs: 600, killWaitMs: 4000,
    onStdoutText: t => { const m = /LATE (\d+)/u.exec(t); if (m) latePid = Number(m[1]); } });
  const rootPid = run.pid ?? 0;
  try {
    await new Promise(r => setTimeout(r, 40)); // cancel BEFORE the grandchild is spawned (it is born during grace)
    await run.cancel("user");
    const outcome = await run.result;
    assert.ok(latePid > 0, "grace-window grandchild was spawned and reported");
    assert.equal(outcome.termination?.cleanupError, undefined, "the late grandchild was captured, reaped and proven gone -> clean");
    await new Promise(r => setTimeout(r, 100));
    assert.equal(alive(latePid), false, "the grace-window grandchild is dead");
  } finally { killIfAlive(latePid); killIfAlive(rootPid); }
});
