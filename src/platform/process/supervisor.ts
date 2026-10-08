import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { statSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import { JsonlDecoder, JsonlError } from "./jsonl.js";
import { defaultProcessTreeInspector, type OwnedTreeSnapshot, type ProcessTreeInspector } from "./process-tree.js";
import { assertNativeExecutablePath, containsNul, InvalidProcessInputError } from "./native-executable.js";
import type { SandboxLaunch } from "./sandboxed-spawn.js";

export type KillReason = "user" | "timeout" | "outputLimit" | "protocolError" | "shutdown";
export type ProcessIssueKind = "SpawnFailure" | "StreamError" | "ProtocolError" | "OutputLimit" | "Timeout" | "Cancelled";

export interface ProcessIssue {
  readonly kind: ProcessIssueKind;
  readonly safeMessage: string;
  /**
   * v0.2.5, SpawnFailure only: the system error code the platform reported (a label such as ENOENT, never a message) and
   * whether the process had already started when the error came (a failed kill of a running process, not a failed start).
   */
  readonly errorCode?: string;
  readonly afterSpawn?: boolean;
}
/** A system error code as a safe label, or nothing. */
const errorCodeOf = (error: unknown): Readonly<{ errorCode?: string }> => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/u.test(code) ? { errorCode: code } : {};
};

export interface ObserverIssue {
  readonly kind: "ObserverFailure";
  readonly channel: "stdout" | "stderr" | "jsonl";
  readonly safeMessage: string;
}

export interface TerminationRecord {
  readonly reason: KillReason;
  readonly forced: boolean;
  readonly method: "none" | "taskkill" | "directKill" | "processGroup";
  readonly cleanupError?: string;
}

export interface ProcessOutcome {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly pid: number | null;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  /** Pipe write status. Acceptance does not prove the child consumed the bytes. */
  readonly stdinWriteStatus: "notProvided" | "acceptedByPipe" | "failed" | "unknown";
  readonly issue?: ProcessIssue;
  readonly observerIssues: readonly ObserverIssue[];
  readonly termination?: TerminationRecord;
}

export interface GracefulCancelContext {
  readonly pid: number;
  writeStdin(data: string | Uint8Array): Promise<void>;
  closeStdin(): void;
}

export interface ProcessSpec {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdin?: string | Uint8Array;
  readonly keepStdinOpen?: boolean;
  readonly timeoutMs?: number;
  readonly graceMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly maxJsonlLineBytes?: number;
  /** Maximum JSON nesting accepted per JSONL record. */
  readonly maxJsonlDepth?: number;
  /** After the child exits, how long to wait for its stdio to reach EOF (a descendant may hold the pipes). */
  readonly stdioDrainMs?: number;
  /** After forced termination, how long to wait for the child to exit before settling without an exit status. */
  readonly killWaitMs?: number;
  /** Keep stdout bytes in the outcome. Byte limits and observers apply either way. Default true. */
  readonly retainStdout?: boolean;
  /**
   * `cancel` (default) stops the child at a byte ceiling. `truncate` keeps the child running, stops retaining
   * bytes and marks the stream truncated; for diagnostic output such as verifier logs, not for protocols.
   */
  readonly outputLimitAction?: "cancel" | "truncate";
  /** `strict` (default) treats invalid stdout UTF-8 as a protocol error; `replace` decodes it lossily. */
  readonly stdoutDecoding?: "strict" | "replace";
  readonly signal?: AbortSignal;
  readonly onStdoutText?: (text: string) => void;
  readonly onStderrText?: (text: string) => void;
  readonly onJsonl?: (value: unknown) => void;
  readonly gracefulCancel?: (context: GracefulCancelContext) => Promise<void> | void;
  /** What a provider process is for; a label for launch observers only, never interpreted by the supervisor. */
  readonly purpose?: ProcessPurpose;
  /**
   * v0.6 I10: when set, the process runs INSIDE the AppContainer HARD sandbox. The supervisor spawns the launcher named
   * here (which runs `executable`/`args` inside the sandbox and bridges stdio), so all machinery below is unchanged. A
   * fail-closed launch (`available:false`) makes the supervisor REFUSE to start — it never runs `executable` unsandboxed.
   */
  readonly sandbox?: SandboxLaunch;
}
/**
 * - `providerAuthReadback`: credential/lane readback, never inference.
 * - `providerInventory`: a static listing (for example installed plugins), never inference.
 * - `providerInitProbe`: a startup cancelled at its initialization report, before any assistant output.
 * - `providerTurn`: a model turn.
 * - `providerHost`: a long-lived protocol host (for example account attestation).
 */
export type ProcessPurpose = "providerAuthReadback" | "providerInventory" | "providerInitProbe" | "providerTurn" | "providerHost";
/** What a launch observer sees of a start: never stdin, never environment VALUES. */
export interface LaunchRecord {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly envKeys: readonly string[];
  readonly purpose?: ProcessPurpose;
}
/** A launch summary once the process settled: exit status and Fusion's own termination classification only. */
export interface LaunchSettlement {
  readonly exitCode: number | null;
  readonly issue?: ProcessIssueKind;
  readonly killReason?: KillReason;
  /** The observer refused the start: no process was spawned. */
  readonly refused?: true;
}
export type LaunchObserver = (launch: LaunchRecord, settled: Promise<LaunchSettlement>) => void;

export interface RunningProcess {
  readonly pid: number | null;
  readonly result: Promise<ProcessOutcome>;
  writeStdin(data: string | Uint8Array): Promise<void>;
  closeStdin(): void;
  cancel(reason?: KillReason): Promise<void>;
}

/**
 * Tree terminator seam. The default uses taskkill on Windows and the process group on POSIX. It reports only the METHOD
 * it used: whether cleanup succeeded is never its own claim (taskkill's exit code is not authoritative); the supervisor
 * decides that from the root's OS handle and the owned-tree verification (`CLEANUP_ERRORS`). `cleanupError?: never`
 * makes a terminator that still self-reports a cleanup verdict a compile error rather than a silently ignored claim.
 */
export type TerminatorReport = Readonly<{ method: TerminationRecord["method"]; cleanupError?: never }>;
export type TreeTerminator = (child: ChildProcessWithoutNullStreams, taskkill: string) => Promise<TerminatorReport>;

/**
 * The supervisor's AUTHORITATIVE cleanup verdicts (`TerminationRecord.cleanupError`), in Fusion's own words. Two are
 * positive evidence that something survived; two are ambiguity (nothing is known to survive, but the owned tree could
 * not be proven gone). Consumers match these exact values, never free text.
 */
export const CLEANUP_ERRORS = Object.freeze({
  /** Evidence: the root did not exit after forced termination (its OS handle reported no exit). */
  processSurvived: "process did not exit after forced termination",
  /** Ambiguity: the owned tree could not be established (listing unreadable, the root not provably listed while
   *  alive, or a process linked into the tree without a usable creation identity). */
  treeUncaptured: "owned process tree could not be captured for verification",
  /** Ambiguity: after termination, whether an owned process is still alive could not be decided. */
  treeUnverified: "owned process tree liveness could not be verified",
  /** Evidence: an owned descendant was still alive after the bounded kill + re-verify. */
  descendantSurvived: "an owned descendant process survived forced termination",
});

export const PROCESS_DEFAULTS = Object.freeze({
  graceMs: 300,
  maxStdoutBytes: 8 * 1024 * 1024,
  maxStderrBytes: 2 * 1024 * 1024,
  maxJsonlLineBytes: 1_048_576,
  maxJsonlDepth: 64,
  stdioDrainMs: 2_000,
  killWaitMs: 5_000,
  taskkillTimeoutMs: 5_000,
});
/** Bounded reap of surviving owned descendants: kill, then RE-VERIFY (the authoritative check), a few times. */
const OWNED_TREE_REAP_ATTEMPTS = 3;
const OWNED_TREE_REAP_INTERVAL_MS = 200;

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new InvalidProcessInputError(`${name} must be a positive safe integer`);
  }
  return result;
}

function waitForSignalOrDelay(done: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    void done.then(() => { clearTimeout(timer); resolve(); });
  });
}

const defaultTerminator: TreeTerminator = async (child, taskkill) => {
  const pid = child.pid;
  if (pid === undefined) return { method: "none" };

  if (process.platform === "win32") {
    try {
      const killer = spawn(taskkill, ["/PID", String(pid), "/T", "/F"], {
        shell: false, windowsHide: true, stdio: "ignore",
      });
      const succeeded = await new Promise<boolean>((resolve) => {
        let resolved = false;
        const finish = (value: boolean): void => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          resolve(value);
        };
        const timer = setTimeout(() => { killer.kill(); finish(false); }, PROCESS_DEFAULTS.taskkillTimeoutMs);
        killer.once("error", () => finish(false));
        killer.once("close", (code) => finish(code === 0));
      });
      // The taskkill EXIT CODE never decides cleanup success: a non-zero exit is often just a short-lived descendant
      // (a messaging/telemetry helper) exiting during the /T tree walk, with nothing surviving. A direct SIGKILL of the
      // root backstops a non-zero taskkill, and the supervisor then verifies the owned tree is actually gone (the OS
      // handle for the root, and the owned-tree probe for descendants) before classifying cleanup.
      if (!succeeded) child.kill("SIGKILL");
      return { method: succeeded ? "taskkill" : "directKill" };
    } catch {
      child.kill("SIGKILL");
      return { method: "directKill" };
    }
  }

  try {
    process.kill(-pid, "SIGKILL");
    return { method: "processGroup" };
  } catch {
    child.kill("SIGKILL");
    return { method: "directKill" };
  }
};

/** Direct-native process lifecycle primitive. Providers must pass M3 guards before using it. */
export class ProcessSupervisor {
  constructor(
    private readonly taskkillExecutable = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
    /** Internal test seam; production uses the platform default. */
    private readonly terminator: TreeTerminator = defaultTerminator,
    /** Owned process-tree capture + verification seam; the production default enumerates the real OS tree. */
    private readonly treeInspector: ProcessTreeInspector = defaultProcessTreeInspector,
  ) {}

  start(spec: ProcessSpec): RunningProcess {
    const executable = assertNativeExecutablePath(spec.executable);
    if (typeof spec.cwd !== "string" || containsNul(spec.cwd) || !isAbsolute(spec.cwd)) {
      throw new InvalidProcessInputError("cwd must be an absolute path without NUL");
    }
    try {
      if (!statSync(spec.cwd).isDirectory()) throw new InvalidProcessInputError("cwd must be a directory");
    } catch (error) {
      if (error instanceof InvalidProcessInputError) throw error;
      throw new InvalidProcessInputError("cwd does not exist or is inaccessible");
    }
    if (!Array.isArray(spec.args) || !spec.args.every((arg) => typeof arg === "string" && !containsNul(arg))) {
      throw new InvalidProcessInputError("args must be strings without NUL");
    }
    if (spec.env === null || typeof spec.env !== "object") {
      throw new InvalidProcessInputError("env must be an object");
    }
    for (const [key, value] of Object.entries(spec.env)) {
      if (containsNul(key) || (value !== undefined && (typeof value !== "string" || containsNul(value)))) {
        throw new InvalidProcessInputError("env contains an invalid key or value");
      }
    }
    const graceMs = positiveInteger(spec.graceMs, PROCESS_DEFAULTS.graceMs, "graceMs");
    const maxStdoutBytes = positiveInteger(spec.maxStdoutBytes, PROCESS_DEFAULTS.maxStdoutBytes, "maxStdoutBytes");
    const maxStderrBytes = positiveInteger(spec.maxStderrBytes, PROCESS_DEFAULTS.maxStderrBytes, "maxStderrBytes");
    const stdioDrainMs = positiveInteger(spec.stdioDrainMs, PROCESS_DEFAULTS.stdioDrainMs, "stdioDrainMs");
    const killWaitMs = positiveInteger(spec.killWaitMs, PROCESS_DEFAULTS.killWaitMs, "killWaitMs");
    const timeoutMs = spec.timeoutMs === undefined ? undefined : positiveInteger(spec.timeoutMs, 0, "timeoutMs");
    const retainStdout = spec.retainStdout ?? true;
    const truncateAtLimit = spec.outputLimitAction === "truncate";
    if (spec.outputLimitAction !== undefined && spec.outputLimitAction !== "cancel" && !truncateAtLimit)
      throw new InvalidProcessInputError("outputLimitAction must be cancel or truncate");
    if (spec.stdoutDecoding !== undefined && spec.stdoutDecoding !== "strict" && spec.stdoutDecoding !== "replace")
      throw new InvalidProcessInputError("stdoutDecoding must be strict or replace");
    if (spec.onJsonl !== undefined && (spec.stdoutDecoding === "replace" || truncateAtLimit))
      throw new InvalidProcessInputError("JSONL protocols require strict stdout decoding and cancel-at-limit");
    const observerIssues: ObserverIssue[] = [];
    const failedObservers = new Set<ObserverIssue["channel"]>();
    const observerFailed = (channel: ObserverIssue["channel"]): void => {
      if (failedObservers.has(channel)) return;
      failedObservers.add(channel);
      observerIssues.push({ kind: "ObserverFailure", channel, safeMessage: `${channel} observer failed` });
    };
    const jsonl = spec.onJsonl === undefined ? undefined : new JsonlDecoder(
      spec.onJsonl, positiveInteger(spec.maxJsonlLineBytes, PROCESS_DEFAULTS.maxJsonlLineBytes, "maxJsonlLineBytes"),
      () => observerFailed("jsonl"),
      positiveInteger(spec.maxJsonlDepth, PROCESS_DEFAULTS.maxJsonlDepth, "maxJsonlDepth"),
    );

    const startedAt = new Date().toISOString();
    const startedMono = performance.now();
    const notStarted = (issue: ProcessIssue, termination?: TerminationRecord): RunningProcess => {
      // A refused/aborted start never leaves the sandbox scratch (spec/result) behind.
      if (spec.sandbox !== undefined) void spec.sandbox.cleanup();
      const outcome: ProcessOutcome = {
        executable, args: [...spec.args], cwd: spec.cwd, pid: null,
        startedAt, endedAt: new Date().toISOString(), durationMs: performance.now() - startedMono,
        exitCode: null, signal: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false,
        stdinWriteStatus: spec.stdin === undefined ? "notProvided" : "failed", observerIssues: [], issue,
        ...(termination === undefined ? {} : { termination }),
      };
      return {
        pid: null, result: Promise.resolve(outcome),
        writeStdin: () => Promise.reject(new InvalidProcessInputError("process did not start")),
        closeStdin: () => {}, cancel: () => Promise.resolve(),
      };
    };
    // Cancellation requested before launch never starts the child.
    if (spec.signal?.aborted) {
      return notStarted({ kind: "Cancelled", safeMessage: "process cancelled by Fusion before launch" },
        { reason: "user", forced: false, method: "none" });
    }
    // v0.6 I10 — HARD sandbox routing. A fail-closed sandbox (backend unavailable) REFUSES to start: the target is never
    // run unsandboxed. Otherwise the supervisor spawns the LAUNCHER (which runs the target inside the AppContainer and
    // bridges stdio, exiting with the child's code), so every stream/timeout/cancel path below operates unchanged.
    const sandbox = spec.sandbox;
    if (sandbox !== undefined && !sandbox.available) {
      return notStarted({ kind: "SpawnFailure", safeMessage: "hard sandbox unavailable; refusing to run unsandboxed",
        errorCode: "SANDBOX_UNAVAILABLE", afterSpawn: false });
    }
    let spawnExecutable = executable, spawnArgs = [...spec.args], spawnCwd = spec.cwd;
    let spawnEnv: NodeJS.ProcessEnv = spec.env;
    if (sandbox !== undefined) {
      try { spawnExecutable = assertNativeExecutablePath(sandbox.executable); }
      catch (error) { return notStarted({ kind: "SpawnFailure", safeMessage: "sandbox launcher is not a valid executable", ...errorCodeOf(error), afterSpawn: false }); }
      spawnArgs = [...sandbox.args];
      spawnCwd = sandbox.cwd;
      spawnEnv = { ...sandbox.launcherEnv };
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(spawnExecutable, spawnArgs, {
        cwd: spawnCwd, env: spawnEnv, shell: false, windowsHide: true,
        detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      return notStarted({ kind: "SpawnFailure", safeMessage: "native process could not be started", ...errorCodeOf(error), afterSpawn: false });
    }

    let settled = false;
    let finalizing: Promise<void> | undefined;
    let closed = false;
    let exited = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let issue: ProcessIssue | undefined;
    let stdinWriteStatus: ProcessOutcome["stdinWriteStatus"] = spec.stdin === undefined ? "notProvided" : "unknown";
    let termination: TerminationRecord | undefined;
    let cancellation: Promise<void> | undefined;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const stdoutBuffers: Buffer[] = [];
    const stderrBuffers: Buffer[] = [];
    const stdoutDecoder = new TextDecoder("utf-8", { fatal: spec.stdoutDecoding !== "replace" });
    // stderr is diagnostic only: malformed bytes are replaced rather than failing a healthy child.
    const stderrDecoder = new TextDecoder("utf-8", { fatal: false });
    let resolveExited!: () => void;
    const exitedPromise = new Promise<void>((resolve) => { resolveExited = resolve; });
    let resolveResult!: (outcome: ProcessOutcome) => void;
    const result = new Promise<ProcessOutcome>((resolve) => { resolveResult = resolve; });
    let drainTimer: NodeJS.Timeout | undefined;

    const remember = (kind: ProcessIssueKind, safeMessage: string, facts: Readonly<{ errorCode?: string; afterSpawn?: boolean }> = {}): void => {
      issue ??= { kind, safeMessage, ...facts };
    };
    let spawned = false;
    const notifyObserver = (channel: "stdout" | "stderr", text: string): void => {
      if (failedObservers.has(channel)) return;
      try {
        if (channel === "stdout") spec.onStdoutText?.(text);
        else spec.onStderrText?.(text);
      } catch {
        observerFailed(channel);
      }
    };
    const handleStdinFailure = (error: unknown): void => {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      // A peer that has already closed its input can race the initial write.
      // Explicit writeStdin callers still receive the rejected promise.
      if (child.stdin.writableEnded || exited || closed || settled) return;
      if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || code === "ECONNRESET") return;
      remember("StreamError", "process stdin failed");
    };
    const closeStdin = (): void => { if (!child.stdin.destroyed) child.stdin.end(); };
    const writeStdin = (data: string | Uint8Array): Promise<void> => new Promise((resolve, reject) => {
      if (child.stdin.destroyed || child.stdin.writableEnded || settled) {
        reject(new InvalidProcessInputError("stdin is closed"));
        return;
      }
      child.stdin.write(data, (error) => error ? reject(error) : resolve());
    });
    const destroyStreams = (): void => {
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
    };

    const timer = timeoutMs === undefined ? undefined : setTimeout(() => { void cancel("timeout"); }, timeoutMs);
    const abortListener = (): void => { void cancel("user"); };

    const finalize = (): Promise<void> => {
      finalizing ??= (async () => {
        if (timer !== undefined) clearTimeout(timer);
        if (drainTimer !== undefined) clearTimeout(drainTimer);
        spec.signal?.removeEventListener("abort", abortListener);
        if (cancellation !== undefined) await cancellation;
        try { const tail = stdoutDecoder.decode(); if (tail) notifyObserver("stdout", tail); }
        catch { remember("ProtocolError", "incomplete stdout UTF-8 at process end"); }
        const stderrTail = stderrDecoder.decode();
        if (stderrTail) notifyObserver("stderr", stderrTail);
        try { jsonl?.finish(); }
        catch (error) {
          if (error instanceof JsonlError) remember("ProtocolError", "incomplete or invalid JSONL at process end");
          else observerFailed("jsonl");
        }
        if (!child.stdin.destroyed) child.stdin.destroy();
        settled = true;
        // v0.6 I10: the launcher has exited (its kill-on-close Job has torn down the sandboxed tree); remove its scratch.
        if (sandbox !== undefined) void sandbox.cleanup();
        const endedAt = new Date().toISOString();
        resolveResult({
          executable, args: [...spec.args], cwd: spec.cwd, pid: child.pid ?? null,
          startedAt, endedAt, durationMs: performance.now() - startedMono,
          exitCode, signal: exitSignal,
          stdout: retainStdout ? Buffer.concat(stdoutBuffers).toString("utf8") : "",
          stderr: Buffer.concat(stderrBuffers).toString("utf8"),
          stdoutTruncated, stderrTruncated,
          stdinWriteStatus,
          observerIssues,
          ...(issue === undefined ? {} : { issue }),
          ...(termination === undefined ? {} : { termination }),
        });
      })();
      return finalizing;
    };

    const cancel = (reason: KillReason = "user"): Promise<void> => {
      if (settled || closed || finalizing !== undefined) return Promise.resolve();
      if (cancellation !== undefined) return cancellation;
      if (reason === "timeout") remember("Timeout", "process deadline exceeded");
      else if (reason === "user" || reason === "shutdown") remember("Cancelled", "process cancelled by Fusion");
      termination = { reason, forced: false, method: "none" };
      // Snapshot the OWNED SUBTREE now, once, BEFORE any kill, so reparenting cannot drop a descendant from the
      // verification set and a helper spawned during the run is covered. Each member carries its creation key, so the
      // set stays valid (and PID-reuse-safe) even after the root exits during grace. The listing identifies the root
      // only if the root was still ALIVE when the listing COMPLETED: until Node reports the exit, the root's PID cannot
      // be reused, so the listed root is Fusion's root and its creation key the root's identity. A root that exited
      // before cleanup began, or before its listing completed, may have handed its PID to an unrelated process whose
      // children must never be adopted: the owned tree is UNVERIFIABLE and cleanup fails closed (never "clean" merely
      // because the root is gone).
      const rootPid = child.pid;
      const uncaptured = (pid: number): OwnedTreeSnapshot => ({ rootPid: pid, members: [], captured: false });
      const snapshotPromise: Promise<OwnedTreeSnapshot> = rootPid === undefined
        ? Promise.resolve({ rootPid: null, members: [], captured: true })
        : exited
        ? Promise.resolve(uncaptured(rootPid))
        : this.treeInspector.snapshot(rootPid).then(snapshot => exited ? uncaptured(rootPid) : snapshot, () => uncaptured(rootPid));

      // AUTHORITATIVE cleanup classification: the root must be proven gone (OS handle) AND every captured owned
      // descendant proven gone (survivors are killed, then re-verified by PID+creation key). taskkill's exit code is
      // never authoritative, "root exited" is never equivalent to "owned tree gone", and an unverifiable state (could
      // not enumerate, or a survivor remained) fails CLOSED. Re-verification - not a sleep - is the correctness check.
      const verifyOwnedTree = async (snapshot: OwnedTreeSnapshot): Promise<{ cleanupError?: string; killedDescendant: boolean }> => {
        if (!exited) return { cleanupError: CLEANUP_ERRORS.processSurvived, killedDescendant: false };
        if (snapshot.rootPid === null) return { killedDescendant: false };
        if (!snapshot.captured) return { cleanupError: CLEANUP_ERRORS.treeUncaptured, killedDescendant: false };
        let surviving = await this.treeInspector.survivingOwned(snapshot).catch((): "unknown" => "unknown");
        let killedDescendant = false;
        for (let attempt = 0; surviving !== "unknown" && surviving > 0 && attempt < OWNED_TREE_REAP_ATTEMPTS; attempt++) {
          killedDescendant = true;
          await this.treeInspector.killOwned(snapshot).catch(() => undefined);
          await waitForSignalOrDelay(new Promise<void>(() => { /* bounded; re-verify below is authoritative */ }), OWNED_TREE_REAP_INTERVAL_MS);
          surviving = await this.treeInspector.survivingOwned(snapshot).catch((): "unknown" => "unknown");
        }
        const cleanupError = surviving === "unknown" ? CLEANUP_ERRORS.treeUnverified
          : surviving > 0 ? CLEANUP_ERRORS.descendantSurvived : undefined;
        return { ...(cleanupError === undefined ? {} : { cleanupError }), killedDescendant };
      };

      if (exited) {
        // The root already exited before cleanup began, so its PID is unsafe to enumerate: the owned tree is
        // unverifiable and fails closed (the snapshot is marked uncaptured above).
        cancellation = (async () => {
          const { cleanupError, killedDescendant } = await verifyOwnedTree(await snapshotPromise);
          termination = { reason, forced: killedDescendant, method: killedDescendant ? "directKill" : "none",
            ...(cleanupError === undefined ? {} : { cleanupError }) };
          destroyStreams();
        })();
        void cancellation.then(() => finalize());
        return cancellation;
      }
      cancellation = (async () => {
        const deadline = performance.now() + graceMs;
        if (child.pid !== undefined) {
          try {
            const hook = spec.gracefulCancel?.({ pid: child.pid, writeStdin, closeStdin });
            if (hook !== undefined) await Promise.race([hook, waitForSignalOrDelay(exitedPromise, graceMs)]);
            else closeStdin();
          } catch {
            // The protocol hook is advisory; hard cleanup still runs.
          }
        }
        if (!exited) await waitForSignalOrDelay(exitedPromise, deadline - performance.now());
        if (!exited) {
          // The single reap-start snapshot (listed while the root was alive) is the member set; there is no second
          // listing before the kill. taskkill /T reaps the tree as it stands at kill time (so a child spawned during
          // grace is killed even if it is not a captured member), and the post-kill child check (countOwnedSurvivors)
          // catches any live child of the owned set - a post-snapshot child - and FAILS CLOSED. This bounds the TOCTOU
          // window to a descendant spawned-and-orphaned from the owned set within the final kill window (closed fully
          // only by the HARD Job).
          const snapshot = await snapshotPromise;
          let method: TerminationRecord["method"] = "none";
          try {
            let bound: NodeJS.Timeout | undefined;
            const forced = await Promise.race([
              this.terminator(child, this.taskkillExecutable),
              new Promise<Pick<TerminationRecord, "method">>(resolve => {
                bound = setTimeout(() => resolve({ method: "none" }), PROCESS_DEFAULTS.taskkillTimeoutMs + 1_000);
              }),
            ]).finally(() => clearTimeout(bound));
            method = forced.method;
          } catch { method = "none"; }
          if (!exited) await waitForSignalOrDelay(exitedPromise, killWaitMs);
          const { cleanupError } = await verifyOwnedTree(snapshot);
          termination = { reason, forced: true, method, ...(cleanupError === undefined ? {} : { cleanupError }) };
          if (!exited) destroyStreams();
        } else {
          // The root exited on its own during grace. The reap-start snapshot verifies + reaps any descendant that
          // remains - but only if its listing completed while the root was still alive; otherwise it is uncaptured
          // and cleanup fails closed.
          const { cleanupError, killedDescendant } = await verifyOwnedTree(await snapshotPromise);
          termination = { reason, forced: killedDescendant, method: killedDescendant ? "directKill" : "none",
            ...(cleanupError === undefined ? {} : { cleanupError }) };
          destroyStreams();
        }
      })();
      // A child that never exits cannot produce 'close'; settle from the bounded cancellation instead. (When it does
      // exit, 'close' triggers finalize, which awaits this same cancellation so its owned-tree verdict is included.)
      void cancellation.then(() => { if (!exited) void finalize(); });
      return cancellation;
    };

    const onData = (channel: "stdout" | "stderr", chunk: Buffer): void => {
      const isStdout = channel === "stdout";
      const available = (isStdout ? maxStdoutBytes - stdoutBytes : maxStderrBytes - stderrBytes);
      const portion = chunk.subarray(0, Math.max(0, available));
      if (isStdout) {
        if (portion.length > 0 && retainStdout) stdoutBuffers.push(portion);
        stdoutBytes += portion.length;
      } else {
        if (portion.length > 0) stderrBuffers.push(portion);
        stderrBytes += portion.length;
      }
      if (portion.length > 0) {
        if (isStdout) {
          let decoded: string | undefined;
          try {
            decoded = stdoutDecoder.decode(portion, { stream: true });
          } catch {
            remember("ProtocolError", "invalid stdout UTF-8");
            void cancel("protocolError");
          }
          if (decoded !== undefined) {
            notifyObserver(channel, decoded);
            if (jsonl !== undefined) {
              try { jsonl.push(portion); }
              catch (error) {
                if (error instanceof JsonlError) {
                  remember("ProtocolError", "invalid stdout JSONL");
                  void cancel("protocolError");
                } else observerFailed("jsonl");
              }
            }
          }
        } else {
          notifyObserver(channel, stderrDecoder.decode(portion, { stream: true }));
        }
      }
      if (portion.length < chunk.length) {
        if (isStdout) stdoutTruncated = true;
        else stderrTruncated = true;
        if (truncateAtLimit) return;
        remember("OutputLimit", `${channel} exceeded configured byte limit`);
        void cancel("outputLimit");
      }
    };

    child.stdout.on("data", (chunk: Buffer) => onData("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => onData("stderr", chunk));
    child.once("spawn", () => { spawned = true; });
    child.once("error", (error) => {
      if (!exited) remember("SpawnFailure", "native process could not be started", { ...errorCodeOf(error), afterSpawn: spawned });
    });
    child.stdin.on("error", handleStdinFailure);
    child.stdout.on("error", () => { if (finalizing === undefined) remember("StreamError", "process stdout failed"); });
    child.stderr.on("error", () => { if (finalizing === undefined) remember("StreamError", "process stderr failed"); });
    spec.signal?.addEventListener("abort", abortListener, { once: true });

    child.once("exit", (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      resolveExited();
      if (timer !== undefined) clearTimeout(timer);
      drainTimer = setTimeout(() => {
        if (closed || finalizing !== undefined) return;
        // A descendant inherited the pipes and outlived the child. Stop waiting for EOF.
        remember("StreamError", "process exited but its output streams stayed open");
        if (process.platform !== "win32" && child.pid !== undefined) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { /* group already gone */ }
        }
        destroyStreams();
        void finalize();
      }, stdioDrainMs);
    });
    child.once("close", (code, signal) => {
      closed = true;
      if (!exited) { exitCode = code; exitSignal = signal; }
      resolveExited();
      void finalize();
    });

    if (spec.stdin !== undefined) {
      void writeStdin(spec.stdin).then(
        () => { stdinWriteStatus = "acceptedByPipe"; },
        (error: unknown) => { stdinWriteStatus = "failed"; handleStdinFailure(error); },
      );
    }
    if (!spec.keepStdinOpen) closeStdin();
    return { pid: child.pid ?? null, result, writeStdin, closeStdin, cancel };
  }
}

/**
 * A supervisor that reports every start to an observer BEFORE the process exists (a throwing observer refuses the start,
 * so no process ever runs unobserved) and its settlement afterwards. The observer never sees stdin or environment values.
 */
export class ObservedProcessSupervisor extends ProcessSupervisor {
  constructor(private readonly observer: LaunchObserver) { super(); }
  override start(spec: ProcessSpec): RunningProcess {
    let settle!: (value: LaunchSettlement) => void;
    const settled = new Promise<LaunchSettlement>(resolve => { settle = resolve; });
    try {
      this.observer(Object.freeze({ executable: spec.executable, args: Object.freeze([...spec.args]), cwd: spec.cwd,
        envKeys: Object.freeze(Object.keys(spec.env).sort()), ...(spec.purpose === undefined ? {} : { purpose: spec.purpose }) }), settled);
    } catch (error) {
      // A throwing observer refuses the start: nothing is spawned, and the launch settles as refused.
      settle({ exitCode: null, refused: true });
      throw error;
    }
    let running: RunningProcess;
    try { running = super.start(spec); }
    catch (error) { settle({ exitCode: null, issue: "SpawnFailure" }); throw error; }
    void running.result.then(outcome => settle({ exitCode: outcome.exitCode, ...(outcome.issue ? { issue: outcome.issue.kind } : {}),
      ...(outcome.termination ? { killReason: outcome.termination.reason } : {}) }), () => settle({ exitCode: null, issue: "StreamError" }));
    return running;
  }
}
/** The supervisor a provider transport starts its processes with: observed when an observer is configured. */
export function supervisorFor(observer: LaunchObserver | undefined): ProcessSupervisor {
  return observer === undefined ? new ProcessSupervisor() : new ObservedProcessSupervisor(observer);
}
