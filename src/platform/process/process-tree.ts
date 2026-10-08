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
 * which a root exit does not account for. OWNERSHIP comes from ONE process listing and is never inferred from a parent
 * PID alone:
 *  - every listed process carries its CREATION IDENTITY `key`: a positive decimal creation ordinal in the listing
 *    platform's own clock (Windows FILETIME ticks, Linux /proc starttime ticks, other POSIX `ps lstart` epoch seconds).
 *    Keys are compared only within one platform's listings, never across clocks. A missing, zero or unparseable key is
 *    NO identity: such a process is never adopted and never killed, and where it links into the owned tree the tree is
 *    ambiguous and fails closed;
 *  - the ROOT must be listed exactly once with a valid identity, and the supervisor uses the snapshot only when the
 *    root was still ALIVE when the listing completed: until Node reports the exit the root's PID cannot be reused, so
 *    the listed root IS Fusion's root and its key is the root's creation identity;
 *  - a process is a CHILD of an owned process only when its parent PID names that process AND it was created no earlier
 *    than it. On Windows a ParentProcessId outlives its parent and is never cleared, so an unrelated long-running process
 *    (say an explorer.exe whose launcher exited at logon) can name a PID the OS later hands to Fusion's root. It predates
 *    the root, so it is never adopted - and therefore never killed.
 *
 * The snapshot is taken ONCE, when cancellation starts, while the root is alive. After termination, cleanup is "clean"
 * ONLY when the root is gone AND no captured member survives (matched by PID AND creation key, so PID reuse is never a
 * false survivor) AND no live process is still a child of the owned set - a POST-SNAPSHOT child, detectable because on
 * Windows a process keeps its original ParentProcessId after the parent dies. A stale link (created before the owned
 * process it names, or after another process took over that PID) is not owned and is ignored. A survivor fails closed;
 * an un-enumerable listing, a linked process without a usable identity, or a listing that contradicts the root's exit is
 * UNKNOWN and fails closed. Only a captured member that is still the same process (PID + key) is ever killed; a merely
 * parent-linked process is never killed.
 *
 * REMAINING TOCTOU (explicit): an owned process can spawn a child between the listing and the kill, and a member can
 * exit and have its PID reused between the kill path's re-listing and its signal; a descendant spawned and orphaned
 * from the owned set inside that window can escape. Windows and `ps` creation times are wall-clock values, so the
 * ordering also assumes no backward clock step between a parent's and its child's creation. Only an OS Job Object
 * (kill-on-close, the HARD path) closes the Windows race completely.
 *
 * PLATFORM DIFFERENCE (explicit, not pretended equivalent): on Windows ParentProcessId persists after a parent exits,
 * so a reparented post-snapshot descendant is still detectable by its parent link. On POSIX a child reparents to init
 * (ppid=1) when its parent dies, so the parent-link check only catches children of a STILL-LIVE owned member; an
 * orphaned post-snapshot descendant is NOT detectable here and is bounded only by the process-group kill (and, for a
 * real guarantee, the HARD path's Job). The Linux identity uses /proc starttime (fine-grained, boot-relative,
 * reuse-safe); other POSIX uses `ps lstart` read in UTC (second-resolution, weaker).
 */
export interface ProcessEntry { readonly pid: number; readonly ppid: number; readonly key: string; }
export interface OwnedProcess { readonly pid: number; readonly key: string; }
export interface OwnedTreeSnapshot {
  readonly rootPid: number | null;
  /** The root's creation identity, as listed while the root was provably alive (always set when the tree was captured). */
  readonly rootKey?: string;
  /** Transitive descendants of the root at snapshot time (the root itself is verified via its OS handle). */
  readonly members: readonly OwnedProcess[];
  /** False when ownership could not be established: the owned tree is then unverifiable (fail closed). */
  readonly captured: boolean;
}
export interface ProcessTreeInspector {
  snapshot(rootPid: number): Promise<OwnedTreeSnapshot>;
  /** How many owned processes are still alive: captured members (PID+key) AND any live CHILD of the owned set (a
   *  post-snapshot child). "unknown" when it cannot be determined. */
  survivingOwned(snapshot: OwnedTreeSnapshot): Promise<number | "unknown">;
  /** Best-effort kill of captured members that are still the SAME process (PID+key); nothing else is ever touched. */
  killOwned(snapshot: OwnedTreeSnapshot): Promise<void>;
}

/** A creation identity as an ordinal, or undefined when it is missing, zero or unparseable (no identity at all). */
export function creationOrdinal(key: string | undefined): bigint | undefined {
  return typeof key === "string" && /^[1-9][0-9]{0,30}$/u.test(key) ? BigInt(key) : undefined;
}

export interface OwnedSubtree { readonly rootKey: string; readonly members: readonly OwnedProcess[]; }
/**
 * Pure: the root's creation identity and its transitive descendants (not the root itself) in one listing, or undefined
 * when ownership cannot be established - the root is not listed exactly once with a valid identity, or a process linked
 * into the owned tree has no usable identity (it may be a genuine descendant: ambiguous, fail closed). A process whose
 * parent PID names an owned process but which was created BEFORE that process is a stale link and is not adopted.
 */
export function buildOwnedSubtree(all: readonly ProcessEntry[], rootPid: number): OwnedSubtree | undefined {
  const listed = all.filter(entry => entry.pid === rootPid);
  const root = listed.length === 1 ? listed[0]! : undefined;
  const rootCreated = creationOrdinal(root?.key);
  if (root === undefined || rootCreated === undefined) return undefined;
  const byParent = new Map<number, ProcessEntry[]>();
  for (const entry of all) {
    if (entry.pid === entry.ppid) continue;
    const list = byParent.get(entry.ppid);
    if (list) list.push(entry); else byParent.set(entry.ppid, [entry]);
  }
  const members: OwnedProcess[] = [];
  const seen = new Set<number>([rootPid]);
  const stack: Array<Readonly<{ pid: number; created: bigint }>> = [{ pid: rootPid, created: rootCreated }];
  while (stack.length > 0) {
    const parent = stack.pop()!;
    for (const child of byParent.get(parent.pid) ?? []) {
      if (seen.has(child.pid)) continue;
      const created = creationOrdinal(child.key);
      if (created === undefined) return undefined;   // linked, but without an identity: ownership is ambiguous
      if (created < parent.created) continue;        // a stale parent PID: it predates the process it names
      seen.add(child.pid);
      members.push({ pid: child.pid, key: child.key });
      stack.push({ pid: child.pid, created });
    }
  }
  return { rootKey: root.key, members };
}

/**
 * Pure: how many owned processes are still alive in `current`, or "unknown" when that cannot be decided. Owned: (1) a
 * captured member still present by PID AND key, or (2) a live CHILD of an owned process (the root or a member): its
 * parent PID names that process, it was created no earlier than it, and - when another process has since taken that
 * PID - it was created before that newer holder (a process cannot be created by a parent that has already exited). That
 * is a post-snapshot child. A stale link is not owned. A linked process without a usable identity, a snapshot without
 * the root's identity, or a listing that still shows the identical root (whose OS handle already reported its exit) is
 * "unknown". Case 2 is used only to refuse "clean", never to kill.
 */
export function countOwnedSurvivors(snapshot: OwnedTreeSnapshot, current: readonly ProcessEntry[]): number | "unknown" {
  const owned = new Map<number, Readonly<{ key: string; created: bigint }>>();
  if (snapshot.rootPid !== null) {
    const created = creationOrdinal(snapshot.rootKey);
    if (created === undefined) return "unknown";
    owned.set(snapshot.rootPid, { key: snapshot.rootKey!, created });
  }
  for (const member of snapshot.members) {
    const created = creationOrdinal(member.key);
    if (created === undefined) return "unknown";
    owned.set(member.pid, { key: member.key, created });
  }
  const survivors = new Set<number>();
  for (const entry of current) {
    const self = owned.get(entry.pid);
    if (self !== undefined && self.key === entry.key) {
      if (entry.pid === snapshot.rootPid) return "unknown";  // contradicts the root's OS-reported exit
      survivors.add(entry.pid);                              // (1) captured member still alive
      continue;
    }
    const parent = owned.get(entry.ppid);
    if (parent === undefined || entry.pid === entry.ppid) continue;   // not linked into the owned set
    const created = creationOrdinal(entry.key);
    if (created === undefined) return "unknown";           // linked, but without an identity: ambiguous
    if (created < parent.created) continue;                // stale: it predates the owned process its parent PID names
    const holder = current.find(other => other.pid === entry.ppid && other.key !== parent.key);
    if (holder !== undefined) {
      const holderCreated = creationOrdinal(holder.key);
      if (holderCreated === undefined || holderCreated === created) return "unknown";
      if (created > holderCreated) continue;               // a child of the PID's newer holder, not of the owned process
    }
    survivors.add(entry.pid);                              // (2) live child linked into the owned set
  }
  return survivors.size;
}

const LIST_TIMEOUT_MS = 8_000;
const MAX_LIST_BYTES = 8 * 1024 * 1024;

function runList(executable: string, args: readonly string[], parse: (stdout: string) => ProcessEntry[],
  env?: NodeJS.ProcessEnv): Promise<ProcessEntry[] | undefined> {
  return new Promise(resolve => {
    let out = "", bytes = 0, done = false;
    const finish = (value: ProcessEntry[] | undefined): void => { if (done) return; done = true; clearTimeout(timer); try { child.kill("SIGKILL"); } catch { /* gone */ } resolve(value); };
    let child: ReturnType<typeof spawn>;
    try { child = spawn(executable, [...args], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"], ...(env ? { env } : {}) }); }
    catch { resolve(undefined); return; }
    const timer = setTimeout(() => finish(undefined), LIST_TIMEOUT_MS);
    child.once("error", () => finish(undefined));
    child.stdout?.on("data", (d: Buffer) => { bytes += d.length; if (bytes > MAX_LIST_BYTES) return finish(undefined); out += d.toString("utf8"); });
    child.once("close", code => { if (code !== 0) return finish(undefined); try { finish(parse(out)); } catch { finish(undefined); } });
  });
}

/** Windows: Get-CimInstance Win32_Process, keyed by the creation time as 64-bit file-time ticks (0 when unreadable). */
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Pure: a `ps lstart` value read in UTC and the C locale ("Thu Oct  8 10:22:33 2026") as epoch seconds; "0" if unparseable. */
export function lstartEpochSeconds(text: string): string {
  const match = /^[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/u.exec(text.trim());
  const month = match ? MONTHS.indexOf(match[1]!) : -1;
  if (!match || month < 0) return "0";
  const ms = Date.UTC(Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]));
  return Number.isSafeInteger(ms) && ms > 0 ? String(ms / 1000) : "0";
}

/** Other POSIX (e.g. macOS): `ps` with lstart as the creation key (second-resolution; weaker than Linux /proc). */
function listPosixPs(): Promise<ProcessEntry[] | undefined> {
  // UTC and the C locale give lstart one fixed format: no localized month names and no daylight-saving fold.
  return runList("/bin/ps", ["-axo", "pid=,ppid=,lstart="], stdout =>
    stdout.split(/\r?\n/u).map(line => line.trim()).filter(line => line.length > 0).map(line => {
      const match = /^(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
      return match ? { pid: Number(match[1]), ppid: Number(match[2]), key: lstartEpochSeconds(match[3]!) } : null;
    }).filter((entry): entry is ProcessEntry => entry !== null), { ...process.env, TZ: "UTC", LC_ALL: "C" });
}

function listProcesses(): Promise<ProcessEntry[] | undefined> {
  if (process.platform === "win32") return listWindows();
  if (process.platform === "linux") return Promise.resolve(listLinux());
  return listPosixPs();
}

function killProcess(pid: number): void {
  if (process.platform === "win32") {
    spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(pid), "/F"],
      { windowsHide: true, stdio: "ignore" }).once("error", () => { /* best effort; survivingOwned re-verifies */ });
  } else process.kill(pid, "SIGKILL");
}

/** The OS access an inspector needs: one listing, and a kill of a single PID. */
export interface ProcessTreeHost {
  /** Every process, or undefined when the listing cannot be read (the owned tree is then unverifiable). */
  list(): Promise<readonly ProcessEntry[] | undefined>;
  /** Forcibly ends one process. Called only for a captured member still listed with the same PID AND creation key. */
  kill(pid: number): void;
}
/** An inspector over `host`; it fails closed (uncaptured / "unknown") whenever ownership cannot be established. */
export function createProcessTreeInspector(host: ProcessTreeHost): ProcessTreeInspector {
  return {
    async snapshot(rootPid) {
      const all = await host.list();
      const tree = all === undefined ? undefined : buildOwnedSubtree(all, rootPid);
      return tree === undefined ? { rootPid, members: [], captured: false }
        : { rootPid, rootKey: tree.rootKey, members: tree.members, captured: true };
    },
    async survivingOwned(snapshot) {
      if (!snapshot.captured) return "unknown";
      const all = await host.list();
      if (all === undefined) return "unknown";
      return countOwnedSurvivors(snapshot, all);
    },
    async killOwned(snapshot) {
      if (!snapshot.captured || snapshot.members.length === 0) return;
      const all = await host.list();
      if (all === undefined) return;
      const live = new Set(all.map(entry => `${entry.pid}\u0000${entry.key}`));
      for (const member of snapshot.members) {
        // Only a member with a real identity that is STILL the same process (PID + creation key) is ever signalled.
        if (creationOrdinal(member.key) === undefined || !live.has(`${member.pid}\u0000${member.key}`)) continue;
        try { host.kill(member.pid); } catch { /* best effort; survivingOwned re-verifies */ }
      }
    },
  };
}

/** The production inspector: enumerates the real OS process tree; fails closed (uncaptured/"unknown") when it cannot. */
export const defaultProcessTreeInspector: ProcessTreeInspector = createProcessTreeInspector({ list: listProcesses, kill: killProcess });
