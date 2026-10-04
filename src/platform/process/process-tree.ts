import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Owned process-tree capture + verification for authoritative forced-termination cleanup on the DIRECT (unsandboxed)
 * spawn path. (The HARD/AppContainer path is race-free by OS containment - a kill-on-close Job that terminates the
 * whole tree atomically regardless of when a descendant spawns; see sandboxed-spawn.ts / appcontainer-backend.ts. This
 * module is the best available guarantee WITHOUT such a Job.)
 *
 * The tracked ROOT is verified by its OS handle (Node's `exit`, immune to PID reuse). This module covers DESCENDANTS,
 * which a root exit does not account for. It is explicitly bounded against TOCTOU:
 *  - the owned subtree is snapshotted while the root is ALIVE (and re-snapshotted just before the forced kill, so a
 *    child spawned during the run or grace is captured and killable by PID+creation key);
 *  - after termination, cleanup is "clean" ONLY when the root is gone AND no captured member survives (matched by PID
 *    AND creation key, so PID reuse is never a false survivor) AND no live process still links by parent PID into the
 *    owned set {root} ∪ members - which catches a POST-SNAPSHOT child, because on Windows a process keeps its original
 *    ParentProcessId after the parent dies. A survivor, an owned-linked live process, or an un-enumerable state all
 *    FAIL CLOSED. A member is killed only when it is still the same process (PID+key); a merely parent-linked process
 *    is never killed (its link could be a reused PID) - it only forces fail-closed.
 *
 * PLATFORM DIFFERENCE (explicit, not pretended equivalent): on Windows ParentProcessId persists after a parent exits,
 * so a reparented post-snapshot descendant is still detectable by its parent link. On POSIX a child reparents to init
 * (ppid=1) when its parent dies, so the parent-link check only catches children of a STILL-LIVE owned member; an
 * orphaned post-snapshot descendant is NOT detectable here and is bounded only by the process-group kill (and, for a
 * real guarantee, the HARD path's Job). The Linux identity key uses /proc starttime (fine-grained, boot-relative,
 * reuse-safe); other POSIX falls back to `ps lstart` (second-resolution, weaker).
 */
export interface ProcessEntry { readonly pid: number; readonly ppid: number; readonly key: string; }
export interface OwnedProcess { readonly pid: number; readonly key: string; }
export interface OwnedTreeSnapshot {
  readonly rootPid: number | null;
  /** Transitive descendants of the root at snapshot time (the root itself is verified via its OS handle). */
  readonly members: readonly OwnedProcess[];
  /** False when the process list could not be enumerated: the owned tree is then unverifiable (fail closed). */
  readonly captured: boolean;
}
export interface ProcessTreeInspector {
  snapshot(rootPid: number): Promise<OwnedTreeSnapshot>;
  /** How many owned processes are still alive: captured members (PID+key) AND any live process parent-linked into the
   *  owned set (a post-snapshot child). "unknown" when it cannot be determined. */
  survivingOwned(snapshot: OwnedTreeSnapshot): Promise<number | "unknown">;
  /** Best-effort kill of captured members that are still the SAME process (PID+key); reused PIDs are never touched. */
  killOwned(snapshot: OwnedTreeSnapshot): Promise<void>;
}

/** Pure: the transitive descendants of `rootPid` (not the root itself), each keyed by its creation identity. */
export function buildOwnedSubtree(all: readonly ProcessEntry[], rootPid: number): OwnedProcess[] {
  const byParent = new Map<number, ProcessEntry[]>();
  for (const entry of all) {
    const list = byParent.get(entry.ppid);
    if (list) list.push(entry); else byParent.set(entry.ppid, [entry]);
  }
  const out: OwnedProcess[] = [];
  const seen = new Set<number>([rootPid]);
  const stack = [rootPid];
  while (stack.length > 0) {
    const parent = stack.pop()!;
    for (const child of byParent.get(parent) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push({ pid: child.pid, key: child.key });
      stack.push(child.pid);
    }
  }
  return out;
}

/** The union of two snapshots' members (by PID+key), keeping the first's root/captured. */
export function unionSnapshots(a: OwnedTreeSnapshot, b: OwnedTreeSnapshot): OwnedTreeSnapshot {
  const byId = new Map<string, OwnedProcess>();
  for (const m of [...a.members, ...b.members]) byId.set(`${m.pid}\u0000${m.key}`, m);
  return { rootPid: a.rootPid, members: [...byId.values()], captured: a.captured && b.captured };
}

/**
 * Pure: count owned processes still alive in `current`. An owned process is (1) a captured member still present by PID
 * AND key, or (2) ANY live process whose parent PID is in the owned set {root} ∪ member-pids and is itself NOT a
 * captured member - a post-snapshot child. Case 2 fails closed conservatively (a reused parent PID over-counts, never
 * under-counts); it is used only to refuse "clean", never to kill.
 */
export function countOwnedSurvivors(snapshot: OwnedTreeSnapshot, current: readonly ProcessEntry[]): number {
  const ownedPids = new Set<number>(snapshot.members.map(m => m.pid));
  if (snapshot.rootPid !== null) ownedPids.add(snapshot.rootPid);
  const memberKeys = new Set(snapshot.members.map(m => `${m.pid}\u0000${m.key}`));
  const survivors = new Set<number>();
  for (const p of current) {
    if (memberKeys.has(`${p.pid}\u0000${p.key}`)) survivors.add(p.pid);            // (1) captured member still alive
    else if (ownedPids.has(p.ppid)) survivors.add(p.pid);                           // (2) live child linked into the owned set
  }
  return survivors.size;
}

const LIST_TIMEOUT_MS = 8_000;
const MAX_LIST_BYTES = 8 * 1024 * 1024;

function runList(executable: string, args: readonly string[], parse: (stdout: string) => ProcessEntry[]): Promise<ProcessEntry[] | undefined> {
  return new Promise(resolve => {
    let out = "", bytes = 0, done = false;
    const finish = (value: ProcessEntry[] | undefined): void => { if (done) return; done = true; clearTimeout(timer); try { child.kill("SIGKILL"); } catch { /* gone */ } resolve(value); };
    let child: ReturnType<typeof spawn>;
    try { child = spawn(executable, [...args], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }); }
    catch { resolve(undefined); return; }
    const timer = setTimeout(() => finish(undefined), LIST_TIMEOUT_MS);
    child.once("error", () => finish(undefined));
    child.stdout?.on("data", (d: Buffer) => { bytes += d.length; if (bytes > MAX_LIST_BYTES) return finish(undefined); out += d.toString("utf8"); });
    child.once("close", code => { if (code !== 0) return finish(undefined); try { finish(parse(out)); } catch { finish(undefined); } });
  });
}

/** Windows: Get-CimInstance Win32_Process, keyed by the creation time as 64-bit file-time ticks (reuse-safe). */
function listWindows(): Promise<ProcessEntry[] | undefined> {
  const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const command = "Get-CimInstance Win32_Process | ForEach-Object { " +
    "$k = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }; " +
    "\"$($_.ProcessId)|$($_.ParentProcessId)|$k\" }";
  return runList(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], stdout =>
    stdout.split(/\r?\n/u).map(line => line.trim()).filter(line => line.length > 0).map(line => {
      const [pid, ppid, key] = line.split("|");
      return { pid: Number(pid), ppid: Number(ppid), key: key ?? "0" };
    }).filter(entry => Number.isInteger(entry.pid) && Number.isInteger(entry.ppid)));
}

/** Linux: read /proc/<pid>/stat directly (pid, ppid, field 22 starttime as a fine-grained, boot-relative reuse key). */
function listLinux(): ProcessEntry[] | undefined {
  let pids: string[];
  try { pids = readdirSync("/proc").filter(name => /^\d+$/u.test(name)); } catch { return undefined; }
  const out: ProcessEntry[] = [];
  for (const dir of pids) {
    let stat: string;
    try { stat = readFileSync(join("/proc", dir, "stat"), "utf8"); } catch { continue; } // the process may have exited
    const close = stat.lastIndexOf(")"); // comm is parenthesised and may contain spaces/parens
    if (close < 0) continue;
    const fields = stat.slice(close + 2).trim().split(/\s+/u); // fields from index 0 == stat field 3 (state)
    const ppid = Number(fields[1]);        // field 4
    const starttime = fields[19];          // field 22
    const pid = Number(dir);
    if (Number.isInteger(pid) && Number.isInteger(ppid) && starttime !== undefined) out.push({ pid, ppid, key: starttime });
  }
  return out;
}

/** Other POSIX (e.g. macOS): `ps` with lstart as the creation key (second-resolution; weaker than Linux /proc). */
function listPosixPs(): Promise<ProcessEntry[] | undefined> {
  return runList("/bin/ps", ["-axo", "pid=,ppid=,lstart="], stdout =>
    stdout.split(/\r?\n/u).map(line => line.trim()).filter(line => line.length > 0).map(line => {
      const match = /^(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
      return match ? { pid: Number(match[1]), ppid: Number(match[2]), key: match[3]!.trim() } : null;
    }).filter((entry): entry is ProcessEntry => entry !== null));
}

function listProcesses(): Promise<ProcessEntry[] | undefined> {
  if (process.platform === "win32") return listWindows();
  if (process.platform === "linux") return Promise.resolve(listLinux());
  return listPosixPs();
}

/** The production inspector: enumerates the real OS process tree; fails closed (undefined/"unknown") when it cannot. */
export const defaultProcessTreeInspector: ProcessTreeInspector = {
  async snapshot(rootPid) {
    const all = await listProcesses();
    if (all === undefined) return { rootPid, members: [], captured: false };
    return { rootPid, members: buildOwnedSubtree(all, rootPid), captured: true };
  },
  async survivingOwned(snapshot) {
    if (!snapshot.captured) return "unknown";
    const all = await listProcesses();
    if (all === undefined) return "unknown";
    return countOwnedSurvivors(snapshot, all);
  },
  async killOwned(snapshot) {
    if (snapshot.members.length === 0) return;
    const all = await listProcesses();
    if (all === undefined) return;
    const live = new Set(all.map(entry => `${entry.pid}\u0000${entry.key}`));
    for (const member of snapshot.members) {
      if (!live.has(`${member.pid}\u0000${member.key}`)) continue; // only kill a member that is STILL the same process
      try {
        if (process.platform === "win32") spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
          ["/PID", String(member.pid), "/F"], { windowsHide: true, stdio: "ignore" });
        else process.kill(member.pid, "SIGKILL");
      } catch { /* best effort; survivingOwned re-verifies */ }
    }
  },
};
