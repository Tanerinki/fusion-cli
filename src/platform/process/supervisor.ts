import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { statSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import { JsonlDecoder, JsonlError } from "./jsonl.js";
import { assertNativeExecutablePath, containsNul, InvalidProcessInputError } from "./native-executable.js";

export type KillReason = "user" | "timeout" | "outputLimit" | "protocolError" | "shutdown";
export type ProcessIssueKind = "SpawnFailure" | "StreamError" | "ProtocolError" | "OutputLimit" | "Timeout" | "Cancelled";

export interface ProcessIssue {
  readonly kind: ProcessIssueKind;
  readonly safeMessage: string;
}

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
  readonly signal?: AbortSignal;
  readonly onStdoutText?: (text: string) => void;
  readonly onStderrText?: (text: string) => void;
  readonly onJsonl?: (value: unknown) => void;
  readonly gracefulCancel?: (context: GracefulCancelContext) => Promise<void> | void;
}

export interface RunningProcess {
  readonly pid: number | null;
  readonly result: Promise<ProcessOutcome>;
  writeStdin(data: string | Uint8Array): Promise<void>;
  closeStdin(): void;
  cancel(reason?: KillReason): Promise<void>;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new InvalidProcessInputError(`${name} must be a positive safe integer`);
  }
  return result;
}

function waitForCloseOrDelay(closed: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    void closed.then(() => { clearTimeout(timer); resolve(); });
  });
}

async function forceTerminate(child: ChildProcessWithoutNullStreams, taskkill: string): Promise<Pick<TerminationRecord, "method" | "cleanupError">> {
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
        const timer = setTimeout(() => { killer.kill(); finish(false); }, 5_000);
        killer.once("error", () => finish(false));
        killer.once("close", (code) => finish(code === 0));
      });
      if (succeeded) return { method: "taskkill" };
      child.kill("SIGKILL");
      return { method: "directKill", cleanupError: "taskkill failed; direct child kill used" };
    } catch {
      child.kill("SIGKILL");
      return { method: "directKill", cleanupError: "taskkill could not start; direct child kill used" };
    }
  }

  try {
    process.kill(-pid, "SIGKILL");
    return { method: "processGroup" };
  } catch {
    child.kill("SIGKILL");
    return { method: "directKill", cleanupError: "process-group kill failed; direct child kill used" };
  }
}

/** Direct-native process lifecycle primitive. Providers must pass M3 guards before using it. */
export class ProcessSupervisor {
  constructor(
    private readonly taskkillExecutable = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
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
    const graceMs = positiveInteger(spec.graceMs, 300, "graceMs");
    const maxStdoutBytes = positiveInteger(spec.maxStdoutBytes, 8 * 1024 * 1024, "maxStdoutBytes");
    const maxStderrBytes = positiveInteger(spec.maxStderrBytes, 2 * 1024 * 1024, "maxStderrBytes");
    const timeoutMs = spec.timeoutMs === undefined ? undefined : positiveInteger(spec.timeoutMs, 0, "timeoutMs");
    const observerIssues: ObserverIssue[] = [];
    const failedObservers = new Set<ObserverIssue["channel"]>();
    const observerFailed = (channel: ObserverIssue["channel"]): void => {
      if (failedObservers.has(channel)) return;
      failedObservers.add(channel);
      observerIssues.push({ kind: "ObserverFailure", channel, safeMessage: `${channel} observer failed` });
    };
    const jsonl = spec.onJsonl === undefined ? undefined : new JsonlDecoder(
      spec.onJsonl, positiveInteger(spec.maxJsonlLineBytes, 1_048_576, "maxJsonlLineBytes"),
      () => observerFailed("jsonl"),
    );

    const startedAt = new Date().toISOString();
    const startedMono = performance.now();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, [...spec.args], {
        cwd: spec.cwd, env: spec.env, shell: false, windowsHide: true,
        detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      const outcome: ProcessOutcome = {
        executable, args: [...spec.args], cwd: spec.cwd, pid: null,
        startedAt, endedAt: new Date().toISOString(), durationMs: performance.now() - startedMono,
        exitCode: null, signal: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false,
        stdinWriteStatus: spec.stdin === undefined ? "notProvided" : "failed", observerIssues: [],
        issue: { kind: "SpawnFailure", safeMessage: "native process could not be started" },
      };
      return {
        pid: null, result: Promise.resolve(outcome),
        writeStdin: () => Promise.reject(new Error("process did not start")),
        closeStdin: () => {}, cancel: () => Promise.resolve(),
      };
    }

    let settled = false;
    let closed = false;
    let closeCode: number | null = null;
    let closeSignal: NodeJS.Signals | null = null;
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
    const stdoutDecoder = new TextDecoder("utf-8", { fatal: true });
    const stderrDecoder = new TextDecoder("utf-8", { fatal: true });
    let resolveClosed!: () => void;
    const closedPromise = new Promise<void>((resolve) => { resolveClosed = resolve; });
    let resolveResult!: (outcome: ProcessOutcome) => void;
    const result = new Promise<ProcessOutcome>((resolve) => { resolveResult = resolve; });

    const remember = (kind: ProcessIssueKind, safeMessage: string): void => {
      issue ??= { kind, safeMessage };
    };
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
      if (child.stdin.writableEnded || child.exitCode !== null || closed) return;
      if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || code === "ECONNRESET") return;
      remember("StreamError", "process stdin failed");
    };
    const closeStdin = (): void => { if (!child.stdin.destroyed) child.stdin.end(); };
    const writeStdin = (data: string | Uint8Array): Promise<void> => new Promise((resolve, reject) => {
      if (child.stdin.destroyed || child.stdin.writableEnded) {
        reject(new Error("stdin is closed"));
        return;
      }
      child.stdin.write(data, (error) => error ? reject(error) : resolve());
    });

    const cancel = (reason: KillReason = "user"): Promise<void> => {
      if (settled || closed) return Promise.resolve();
      if (cancellation !== undefined) return cancellation;
      if (reason === "timeout") remember("Timeout", "process deadline exceeded");
      else if (reason === "user" || reason === "shutdown") remember("Cancelled", "process cancelled by Fusion");
      termination = { reason, forced: false, method: "none" };
      cancellation = (async () => {
        const deadline = performance.now() + graceMs;
        if (child.pid !== undefined) {
          try {
            const hook = spec.gracefulCancel?.({ pid: child.pid, writeStdin, closeStdin });
            if (hook !== undefined) await Promise.race([hook, waitForCloseOrDelay(closedPromise, graceMs)]);
            else closeStdin();
          } catch {
            // The protocol hook is advisory; hard cleanup still runs.
          }
        }
        if (!closed) await waitForCloseOrDelay(closedPromise, deadline - performance.now());
        if (!closed) {
          const forced = await forceTerminate(child, this.taskkillExecutable);
          termination = { reason, forced: true, ...forced };
        }
      })();
      return cancellation;
    };

    const onData = (channel: "stdout" | "stderr", chunk: Buffer): void => {
      const isStdout = channel === "stdout";
      const available = (isStdout ? maxStdoutBytes - stdoutBytes : maxStderrBytes - stderrBytes);
      const portion = chunk.subarray(0, Math.max(0, available));
      if (isStdout) {
        if (portion.length > 0) stdoutBuffers.push(portion);
        stdoutBytes += portion.length;
      } else {
        if (portion.length > 0) stderrBuffers.push(portion);
        stderrBytes += portion.length;
      }
      if (portion.length > 0) {
        let decoded: string | undefined;
        try {
          decoded = (isStdout ? stdoutDecoder : stderrDecoder).decode(portion, { stream: true });
        } catch {
          remember("ProtocolError", `invalid ${channel} UTF-8`);
          void cancel("protocolError");
        }
        if (decoded !== undefined) {
          notifyObserver(channel, decoded);
          if (isStdout && jsonl !== undefined) {
            try { jsonl.push(portion); }
            catch (error) {
              if (error instanceof JsonlError) {
                remember("ProtocolError", "invalid stdout JSONL");
                void cancel("protocolError");
              } else observerFailed("jsonl");
            }
          }
        }
      }
      if (portion.length < chunk.length) {
        if (isStdout) stdoutTruncated = true;
        else stderrTruncated = true;
        remember("OutputLimit", `${channel} exceeded configured byte limit`);
        void cancel("outputLimit");
      }
    };

    child.stdout.on("data", (chunk: Buffer) => onData("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => onData("stderr", chunk));
    child.once("error", () => remember("SpawnFailure", "native process could not be started"));
    child.stdin.on("error", handleStdinFailure);
    child.stdout.on("error", () => remember("StreamError", "process stdout failed"));
    child.stderr.on("error", () => remember("StreamError", "process stderr failed"));

    const timer = timeoutMs === undefined ? undefined : setTimeout(() => { void cancel("timeout"); }, timeoutMs);
    const abortListener = (): void => { void cancel("user"); };
    spec.signal?.addEventListener("abort", abortListener, { once: true });

    child.once("close", (code, signal) => {
      closed = true;
      closeCode = code;
      closeSignal = signal;
      resolveClosed();
      if (timer !== undefined) clearTimeout(timer);
      spec.signal?.removeEventListener("abort", abortListener);
      void (async () => {
        if (cancellation !== undefined) await cancellation;
        try { const tail = stdoutDecoder.decode(); if (tail) notifyObserver("stdout", tail); }
        catch { remember("ProtocolError", "incomplete stdout UTF-8 at process end"); }
        try { const tail = stderrDecoder.decode(); if (tail) notifyObserver("stderr", tail); }
        catch { remember("ProtocolError", "incomplete stderr UTF-8 at process end"); }
        try { jsonl?.finish(); }
        catch (error) {
          if (error instanceof JsonlError) remember("ProtocolError", "incomplete or invalid JSONL at process end");
          else observerFailed("jsonl");
        }
        settled = true;
        const endedAt = new Date().toISOString();
        resolveResult({
          executable, args: [...spec.args], cwd: spec.cwd, pid: child.pid ?? null,
          startedAt, endedAt, durationMs: performance.now() - startedMono,
          exitCode: closeCode, signal: closeSignal,
          stdout: Buffer.concat(stdoutBuffers).toString("utf8"),
          stderr: Buffer.concat(stderrBuffers).toString("utf8"),
          stdoutTruncated, stderrTruncated,
          stdinWriteStatus,
          observerIssues,
          ...(issue === undefined ? {} : { issue }),
          ...(termination === undefined ? {} : { termination }),
        });
      })();
    });

    if (spec.stdin !== undefined) {
      void writeStdin(spec.stdin).then(
        () => { stdinWriteStatus = "acceptedByPipe"; },
        (error: unknown) => { stdinWriteStatus = "failed"; handleStdinFailure(error); },
      );
    }
    if (!spec.keepStdinOpen) closeStdin();
    if (spec.signal?.aborted) void cancel("user");
    return { pid: child.pid ?? null, result, writeStdin, closeStdin, cancel };
  }
}
