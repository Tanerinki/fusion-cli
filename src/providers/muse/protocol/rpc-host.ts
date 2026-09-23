import type { ProcessOutcome, RunningProcess } from "../../../platform/process/supervisor.js";
import { ProcessSupervisor } from "../../../platform/process/supervisor.js";
import { MuseFailure, fail, record, string, type PreparedLaunch } from "../types.js";

type Pending = { resolve(value: Record<string, unknown>): void; reject(error: unknown): void; timer: NodeJS.Timeout };
export type RpcEvent = Readonly<{ method: string; params: Record<string, unknown>; id?: string | number }>;
export class RpcError extends Error {
  constructor(readonly code: number, readonly kind: string) { super(`MSP request failed with code ${code}.`); }
}
/** Cumulative protocol output a single host may produce before Fusion stops it. */
export const MSP_HOST_MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const inputClosed = (): MuseFailure => new MuseFailure({ kind: "ProcessFailure",
  safeMessage: "Muse MSP host input is closed.", retryable: true });

/** Small JSON-RPC 2.0 router tied to exactly one supervised Muse host. */
export class MuseRpcHost {
  private process?: RunningProcess;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(event: RpcEvent) => void>();
  private exited = false;
  private exitOutcome?: ProcessOutcome;
  private readonly exitWaiters = new Set<(outcome: ProcessOutcome) => void>();
  private lateResponses = 0;
  private impossibleResponses = 0;
  constructor(private readonly supervisor = new ProcessSupervisor(), private readonly requestTimeoutMs = 8_000) {}

  start(launch: PreparedLaunch, args: readonly string[], cwd: string): void {
    if (this.process) fail("InternalError", "MSP host was already started.");
    // A long-lived host's stdout is consumed as JSON-RPC and never read back, so it is not retained in memory.
    // The cumulative byte ceiling still applies; a host that exceeds it is stopped and must be restarted.
    this.process = this.supervisor.start({ executable: launch.executable, args: [...launch.argvPrefix, ...args], cwd, env: launch.env,
      keepStdinOpen: true, retainStdout: false, maxStdoutBytes: MSP_HOST_MAX_STDOUT_BYTES, maxStderrBytes: 4 * 1024 * 1024,
      onJsonl: value => this.receive(value) });
    void this.process.result.then(outcome => {
      this.exited = true; this.exitOutcome = outcome;
      for (const waiter of this.exitWaiters) waiter(outcome);
      this.exitWaiters.clear();
      this.rejectAll(new MuseFailure({ kind: outcome.issue?.kind === "Timeout" ? "Timeout" : "ProcessFailure",
        safeMessage: "Muse MSP host exited while requests were pending.", retryable: true }));
      this.listeners.clear();
    });
  }
  onEvent(listener: (event: RpcEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async request(method: string, params?: Record<string, unknown>, timeoutMs = this.requestTimeoutMs): Promise<Record<string, unknown>> {
    if (!this.process || this.exited) fail("ProcessFailure", "Muse MSP host is unavailable.");
    if (this.nextId >= Number.MAX_SAFE_INTEGER) fail("ProtocolError", "MSP request ID space exhausted.");
    const id = this.nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new MuseFailure({ kind: "Timeout", safeMessage: `MSP ${method} timed out.`, retryable: true }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const msg = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
      void this.process!.writeStdin(`${JSON.stringify(msg)}\n`).catch(() => {
        const p = this.pending.get(id); if (!p) return;
        clearTimeout(p.timer); this.pending.delete(id); p.reject(inputClosed());
      });
    });
  }
  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    if (!this.process || this.exited) fail("ProcessFailure", "Muse MSP host is unavailable.");
    try { await this.process.writeStdin(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })}\n`); }
    catch { throw inputClosed(); }
  }
  private receive(value: unknown): void {
    const m = record(value);
    if (!m || m.jsonrpc !== "2.0") return this.protocolFailure();
    const hasId = Object.hasOwn(m, "id"), hasMethod = Object.hasOwn(m, "method");
    if (hasMethod) {
      const method = string(m.method), params = m.params === undefined ? {} : record(m.params);
      if (!method || !params || (hasId && typeof m.id !== "string" && typeof m.id !== "number")) return this.protocolFailure();
      if (hasId) {
        // Presentation receipt only. Decision is a separate approval/decide command.
        if (method === "approval/request" || method === "approval/requested") {
          void this.process?.writeStdin(`${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} })}\n`).catch(() => this.protocolFailure());
        } else {
          void this.process?.writeStdin(`${JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not supported" } })}\n`).catch(() => this.protocolFailure());
          this.protocolFailure(); return;
        }
      }
      for (const listener of this.listeners) { try { listener({ method, params, ...(hasId ? { id: m.id as string | number } : {}) }); } catch { this.protocolFailure(); } }
      return;
    }
    if (!hasId || typeof m.id !== "number" || !Number.isSafeInteger(m.id)) return this.protocolFailure();
    const pending = this.pending.get(m.id);
    if (!pending) {
      if (m.id > 0 && m.id < this.nextId) this.lateResponses = Math.min(65_535, this.lateResponses + 1);
      else {
        this.impossibleResponses = Math.min(3, this.impossibleResponses + 1);
        if (this.impossibleResponses === 3) this.protocolFailure();
      }
      return;
    }
    clearTimeout(pending.timer); this.pending.delete(m.id);
    if (Object.hasOwn(m, "result") === Object.hasOwn(m, "error")) return this.protocolFailure(pending);
    if (Object.hasOwn(m, "result")) {
      const result = record(m.result);
      if (!result) return this.protocolFailure(pending);
      pending.resolve(result); return;
    }
    const e = record(m.error), code = e?.code, data = record(e?.data);
    if (!e || !Number.isSafeInteger(code)) return this.protocolFailure(pending);
    const rawKind = string(data?.kind);
    pending.reject(new RpcError(code as number, rawKind && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(rawKind) ? rawKind : "unknown"));
  }
  private protocolFailure(pending?: Pending): void {
    const error = new MuseFailure({ kind: "ProtocolError", safeMessage: "Muse MSP sent malformed JSON-RPC.", retryable: false });
    pending?.reject(error); this.rejectAll(error); void this.process?.cancel("protocolError");
  }
  private rejectAll(error: unknown): void {
    for (const [id,p] of this.pending) { clearTimeout(p.timer); this.pending.delete(id); p.reject(error); }
  }
  async stop(reason: "shutdown" | "protocolError" = "shutdown"): Promise<ProcessOutcome | undefined> {
    if (!this.process) return undefined;
    if (this.exited) return this.exitOutcome;
    this.process.closeStdin();
    const outcome = await new Promise<ProcessOutcome | undefined>(resolve => {
      const timer = setTimeout(() => resolve(undefined), 800);
      void this.process!.result.then(value => { clearTimeout(timer); resolve(value); });
    });
    if (outcome) return outcome;
    await this.process.cancel(reason);
    return this.process.result;
  }
  async forceStop(): Promise<ProcessOutcome | undefined> {
    if (!this.process) return undefined;
    await this.process.cancel("protocolError"); return this.process.result;
  }
  onExit(listener: (outcome: ProcessOutcome) => void): () => void {
    if (this.exitOutcome) { listener(this.exitOutcome); return () => {}; }
    this.exitWaiters.add(listener);
    return () => this.exitWaiters.delete(listener);
  }
  get isAlive(): boolean { return !!this.process && !this.exited; }
  get diagnostics(): Readonly<{ pendingRequests: number; lateResponses: number; impossibleResponses: number }> {
    return { pendingRequests: this.pending.size, lateResponses: this.lateResponses, impossibleResponses: this.impossibleResponses };
  }
}
