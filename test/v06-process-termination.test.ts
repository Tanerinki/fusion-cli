import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CLEANUP_ERRORS, ProcessSupervisor, type TreeTerminator } from "../src/platform/process/supervisor.js";
import { buildOwnedSubtree, countOwnedSurvivors, createProcessTreeInspector, creationOrdinal, defaultProcessTreeInspector,
  lstartEpochSeconds, type OwnedTreeSnapshot, type ProcessEntry, type ProcessTreeHost,
  type ProcessTreeInspector } from "../src/platform/process/process-tree.js";

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
// A creation identity is a positive decimal ordinal of ONE platform clock: a larger key was created later.
test("v0.6 term pure: descendants only; PID reuse is not a survivor; a POST-SNAPSHOT child is detected", () => {
  const all: ProcessEntry[] = [
    { pid: 10, ppid: 1, key: "1000" }, { pid: 20, ppid: 10, key: "1100" }, { pid: 30, ppid: 20, key: "1200" },
    { pid: 40, ppid: 2, key: "900" }, // unrelated
  ];
  const tree = buildOwnedSubtree(all, 10)!;
  assert.equal(tree.rootKey, "1000");
  assert.deepEqual(tree.members.map(m => m.pid).sort((a, b) => a - b), [20, 30]);
  const snap: OwnedTreeSnapshot = { rootPid: 10, rootKey: tree.rootKey, members: tree.members, captured: true };
  // after kill, everything gone -> 0 survivors
  assert.equal(countOwnedSurvivors(snap, [{ pid: 40, ppid: 2, key: "900" }]), 0);
  // PID 30 REUSED by a different process (different key) and not parent-linked -> NOT a survivor
  assert.equal(countOwnedSurvivors(snap, [{ pid: 30, ppid: 777, key: "5000" }]), 0);
  // same pid AND same key -> a real survivor
  assert.equal(countOwnedSurvivors(snap, [{ pid: 30, ppid: 20, key: "1200" }]), 1);
  // TOCTOU: a child spawned AFTER the snapshot by a member (ppid=20) or the root (ppid=10) -> detected as a survivor
  assert.equal(countOwnedSurvivors(snap, [{ pid: 88, ppid: 20, key: "1300" }]), 1, "post-snapshot child of a member");
  assert.equal(countOwnedSurvivors(snap, [{ pid: 99, ppid: 10, key: "1400" }]), 1, "post-snapshot child of the root");
});

// ---- F1: a stale ParentProcessId never makes a process owned (and so never gets it killed) ------------------------
// Windows never clears a ParentProcessId when the parent exits. EXPLORER (pid 200) was started long ago by a launcher
// whose PID (100) the OS has since handed to Fusion's root: its parent link names the root, but it PREDATES the root.
const ROOT: ProcessEntry = { pid: 100, ppid: 4, key: "5000" };
const EXPLORER: ProcessEntry = { pid: 200, ppid: 100, key: "1000" };     // stale link: created before the root
const EXPLORER_APP: ProcessEntry = { pid: 300, ppid: 200, key: "1500" }; // a descendant of the stale process
const CHILD: ProcessEntry = { pid: 400, ppid: 100, key: "6000" };        // a genuine child, created after the root
const GRANDCHILD: ProcessEntry = { pid: 500, ppid: 400, key: "6000" };   // same clock tick as its parent: not older

test("v0.6 term F1: a stale ParentProcessId naming a reused Fusion PID is NOT adopted; a child created after its parent IS", () => {
  const tree = buildOwnedSubtree([ROOT, EXPLORER, EXPLORER_APP, CHILD, GRANDCHILD], ROOT.pid)!;
  assert.equal(tree.rootKey, ROOT.key);
  assert.deepEqual(tree.members.map(m => m.pid).sort((a, b) => a - b), [400, 500], "only processes created no earlier than their parent");
  const snap: OwnedTreeSnapshot = { rootPid: ROOT.pid, rootKey: tree.rootKey, members: tree.members, captured: true };
  // after the root's exit, the long-running stale process (and its own descendants) are not survivors ...
  assert.equal(countOwnedSurvivors(snap, [EXPLORER, EXPLORER_APP]), 0);
  // ... while a genuine post-snapshot child of the root, or a captured member still alive, is
  assert.equal(countOwnedSurvivors(snap, [EXPLORER, { pid: 600, ppid: 100, key: "7000" }]), 1);
  assert.equal(countOwnedSurvivors(snap, [EXPLORER, GRANDCHILD]), 1);
  // the root's PID taken over by a NEW process: that holder's children are not Fusion's; an orphan created before it is
  const holder: ProcessEntry = { pid: 100, ppid: 4, key: "8000" };
  assert.equal(countOwnedSurvivors(snap, [holder, { pid: 700, ppid: 100, key: "8100" }]), 0, "a child of the PID's new holder");
  assert.equal(countOwnedSurvivors(snap, [holder, { pid: 701, ppid: 100, key: "7500" }]), 1, "Fusion's orphan, created before the takeover");
});

test("v0.6 term F1: without a valid root identity, or with an unidentifiable linked process, ownership fails closed", () => {
  for (const key of ["0", "", "abc", "-5", "01", "12.5"]) {
    assert.equal(creationOrdinal(key), undefined, `key ${JSON.stringify(key)} is no identity`);
    assert.equal(buildOwnedSubtree([{ ...ROOT, key }, CHILD], ROOT.pid), undefined, `root key ${JSON.stringify(key)}`);
    assert.equal(buildOwnedSubtree([ROOT, { ...CHILD, key }], ROOT.pid), undefined, `linked child key ${JSON.stringify(key)}`);
  }
  assert.equal(creationOrdinal("133713371337133713"), 133713371337133713n);
  assert.equal(buildOwnedSubtree([CHILD], ROOT.pid), undefined, "the root is not listed");
  assert.equal(buildOwnedSubtree([ROOT, { ...ROOT, key: "5001" }, CHILD], ROOT.pid), undefined, "the root is listed twice");
  // an unidentifiable process linked into the owned set after termination is UNKNOWN (fail closed), never clean
  const snap: OwnedTreeSnapshot = { rootPid: ROOT.pid, rootKey: ROOT.key, members: [{ pid: CHILD.pid, key: CHILD.key }], captured: true };
  assert.equal(countOwnedSurvivors(snap, [{ pid: 800, ppid: CHILD.pid, key: "0" }]), "unknown");
  assert.equal(countOwnedSurvivors({ rootPid: ROOT.pid, members: [], captured: true }, []), "unknown", "no root identity");
  assert.equal(countOwnedSurvivors(snap, [ROOT]), "unknown", "the identical root still listed after its OS handle reported exit");
  // `ps lstart` (read in UTC, C locale) becomes epoch seconds; anything else is no identity
  assert.equal(lstartEpochSeconds("Thu Oct  8 10:22:33 2026"), String(Date.UTC(2026, 9, 8, 10, 22, 33) / 1000));
  for (const bad of ["", "garbage", "Thu Foo  8 10:22:33 2026", "Thu Oct  8 10:22 2026"]) assert.equal(lstartEpochSeconds(bad), "0", bad);
});

// A fake OS for the REAL inspector logic: a mutable process table, and a record of every PID handed to `kill`.
function fakeHost(table: ProcessEntry[], beforeList?: () => Promise<void>): { host: ProcessTreeHost; killed: number[] } {
  const killed: number[] = [];
  return { killed, host: {
    list: async () => { await beforeList?.(); return table.map(entry => ({ ...entry })); },
    kill: pid => { killed.push(pid); const at = table.findIndex(entry => entry.pid === pid); if (at >= 0) table.splice(at, 1); },
  } };
}
/** Really ends the root and, like the OS, drops it from the fake table; `after` mutates the table post-kill. */
const reapingFrom = (table: ProcessEntry[], after?: () => void): TreeTerminator => async child => {
  child.kill("SIGKILL");
  const at = table.findIndex(entry => entry.pid === child.pid);
  if (at >= 0) table.splice(at, 1);
  after?.();
  return { method: "taskkill" };
};

test("v0.6 term F1: through the supervisor, a stale-linked unrelated process is NEVER passed to kill; a real owned member is", async () => {
  const table: ProcessEntry[] = [];
  const { host, killed } = fakeHost(table);
  const run = new ProcessSupervisor(undefined, reapingFrom(table), createProcessTreeInspector(host)).start({
    executable: process.execPath, args: FOREVER, cwd, env: { ...process.env }, graceMs: 20, killWaitMs: 600 });
  const pid = run.pid ?? 0;
  // the REAL root (alive), an unrelated long-running process whose stale parent PID names the root (plus its own
  // descendant), and one genuine child of the root
  table.push({ pid, ppid: 4, key: "5000" }, { pid: 900001, ppid: pid, key: "1000" }, { pid: 900002, ppid: 900001, key: "1200" },
    { pid: 900003, ppid: pid, key: "6000" });
  try {
    await run.cancel("user");
    const outcome = await run.result;
    assert.deepEqual(killed, [900003], "only the genuine owned member was ever signalled");
    assert.equal(outcome.termination?.cleanupError, undefined, "the stale-linked processes are not owned survivors");
    assert.deepEqual(table.map(entry => entry.pid), [900001, 900002], "the unrelated processes are untouched");
  } finally { killIfAlive(pid); }
});

test("v0.6 term F1: an unidentifiable linked process is never killed and cleanup refuses (uncaptured / unverified)", async () => {
  // at snapshot time: a process linked to the root without a creation identity -> ownership cannot be established
  const atSnapshot: ProcessEntry[] = [];
  const first = fakeHost(atSnapshot);
  const run1 = new ProcessSupervisor(undefined, reapingFrom(atSnapshot), createProcessTreeInspector(first.host)).start({
    executable: process.execPath, args: FOREVER, cwd, env: { ...process.env }, graceMs: 20, killWaitMs: 600 });
  const pid1 = run1.pid ?? 0;
  atSnapshot.push({ pid: pid1, ppid: 4, key: "5000" }, { pid: 900010, ppid: pid1, key: "0" });
  try {
    await run1.cancel("user");
    assert.equal((await run1.result).termination?.cleanupError, CLEANUP_ERRORS.treeUncaptured);
    assert.deepEqual(first.killed, []);
  } finally { killIfAlive(pid1); }
  // after the kill: a new process linked to the owned set without a creation identity -> liveness is undecidable
  const afterKill: ProcessEntry[] = [];
  const second = fakeHost(afterKill);
  const run2 = new ProcessSupervisor(undefined, reapingFrom(afterKill, () => afterKill.push({ pid: 900021, ppid: 900020, key: "" })),
    createProcessTreeInspector(second.host)).start({ executable: process.execPath, args: FOREVER, cwd, env: { ...process.env }, graceMs: 20, killWaitMs: 600 });
  const pid2 = run2.pid ?? 0;
  afterKill.push({ pid: pid2, ppid: 4, key: "5000" }, { pid: 900020, ppid: pid2, key: "6000" });
  try {
    await run2.cancel("user");
    assert.equal((await run2.result).termination?.cleanupError, CLEANUP_ERRORS.treeUnverified);
    assert.equal(second.killed.includes(900021), false, "a process without an identity is never killed");
  } finally { killIfAlive(pid2); }
});

test("v0.6 term F1: a root that exited before its listing completed never identifies children (uncaptured, nothing killed)", async () => {
  const table: ProcessEntry[] = [];
  let listings = 0, pid = 0;
  // Ordering is made deterministic, never a timing guess:
  // - the root exits only when its stdin closes, which the cancellation itself does (keepStdinOpen), so it is alive
  //   when cancellation begins however slowly it started;
  // - the first listing completes only after the OS reports the root gone, plus a margin for Node's exit event. At that
  //   point its PID could already belong to another process.
  const { host, killed } = fakeHost(table, async () => {
    if (listings++ !== 0) return;
    for (let waited = 0; alive(pid) && waited < 15_000; waited += 25) await new Promise(resolve => setTimeout(resolve, 25));
    await new Promise(resolve => setTimeout(resolve, 500));
  });
  const run = new ProcessSupervisor(undefined, reaping("taskkill"), createProcessTreeInspector(host)).start({
    executable: process.execPath, args: ["-e", "process.stdin.on('end', () => process.exit(0)); process.stdin.resume(); setInterval(() => {}, 1000)"],
    cwd, env: { ...process.env }, keepStdinOpen: true, graceMs: 10_000, killWaitMs: 600 });
  pid = run.pid ?? 0;
  table.push({ pid, ppid: 4, key: "5000" }, { pid: 900030, ppid: pid, key: "6000" });
  try {
    await run.cancel("user");
    const outcome = await run.result;
    assert.equal(outcome.exitCode, 0, "the root exited on its own during grace");
    assert.equal(outcome.termination?.cleanupError, CLEANUP_ERRORS.treeUncaptured);
    assert.deepEqual(killed, [], "no listed 'child' of a possibly reused PID is ever killed");
  } finally { killIfAlive(pid); }
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
  const snap: OwnedTreeSnapshot = { rootPid: 5, rootKey: "100", members: [{ pid: 777, key: "200" }], captured: true };
  assert.equal(countOwnedSurvivors(snap, [{ pid: 777, ppid: 1, key: "300" }]), 0, "reused PID (new key, unlinked) is not a survivor");
  assert.equal(countOwnedSurvivors(snap, [{ pid: 777, ppid: 1, key: "200" }]), 1, "same process is a survivor");
});

// A2 / B. REAL: a descendant spawned DURING cancellation grace (after cancellation began; there is ONE snapshot and no
// pre-kill re-snapshot) is reaped by the tree kill (taskkill /T walks the tree as it stands at kill time) and proven
// gone by the post-kill verification, which would detect it as a live child of the owned set -> clean; it must be dead.
test("v0.6 term A2/B: a grace-window grandchild is reaped by the tree kill and proven gone (production inspector)", { skip: process.platform !== "win32" }, async () => {
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
    assert.equal(outcome.termination?.cleanupError, undefined, "the late grandchild was reaped and proven gone -> clean");
    await new Promise(r => setTimeout(r, 100));
    assert.equal(alive(latePid), false, "the grace-window grandchild is dead");
  } finally { killIfAlive(latePid); killIfAlive(rootPid); }
});
