import { basename } from "node:path";
import { internalError } from "../../core/errors.js";
import { resolveVersionedExecutable } from "../../platform/process/native-executable.js";
import type { AuthStatus, CapabilitySnapshot, DelegationPacket, ProviderAdapter, ProviderUsage, RoleBinding, Session, TurnResult } from "../../core/domain.js";
import { MuseExecTransport } from "./exec-transport.js";
import { MuseMspTransport, type ApprovalPolicy } from "./msp-transport.js";
import { RESULT_PACKET_SCHEMA } from "./structured-output.js";
import { MuseFailure, capability, fail, uuidV7, type MuseLaunchConfig } from "./types.js";

/** Provider-neutral façade. Binding and posture are immutable for this instance. */
export class MuseAdapter implements ProviderAdapter {
  private readonly msp: MuseMspTransport;
  private readonly exec: MuseExecTransport;
  private readonly sessions = new Map<string, { session: Session; abort: AbortController; busy: boolean }>();
  constructor(readonly binding: RoleBinding, readonly config: MuseLaunchConfig, approvalPolicy?: ApprovalPolicy) {
    if (binding.provider !== config.provider || binding.model.id !== config.model.id || binding.model.effort !== config.model.effort ||
      !["muse-exec", "muse-msp"].includes(binding.transport)) fail("InvalidInput", "Muse binding and launch configuration differ.");
    this.msp = new MuseMspTransport(config, approvalPolicy);
    this.exec = new MuseExecTransport(config, () => this.msp.authStatus());
  }
  async capabilities(): Promise<CapabilitySnapshot> {
    if (this.binding.transport === "muse-msp") return this.msp.capabilities();
    const executable = await resolveVersionedExecutable({ directory: this.config.binaryDirectory,
      versionFile: this.config.versionFile, prefix: "muse-bin-" });
    const version = basename(executable).match(/^muse-bin-(.+)\.exe$/i)?.[1] ?? "unknown";
    return capability(this.config, "muse-exec", version);
  }
  async authStatus(): Promise<AuthStatus> { return this.msp.authStatus(); }
  async createSession(request: Parameters<ProviderAdapter["createSession"]>[0]): Promise<Session> {
    if (request.role !== this.binding.role || request.model.id !== this.binding.model.id ||
      request.model.effort !== this.binding.model.effort || request.posture !== this.config.posture)
      fail("InvalidInput", "Muse session request differs from its binding.");
    const requirements = { ...this.binding.requires, webToolsDisabled: true } as const;
    const id = this.binding.transport === "muse-msp" ? await this.msp.createSession(requirements) : uuidV7();
    const session: Session = { id, runId: request.runId, role: request.role, provider: this.config.provider,
      transport: this.binding.transport, workspaceLeaseId: request.workspaceLeaseId, posture: request.posture,
      providerSessionRef: id };
    this.sessions.set(id, { session, abort: new AbortController(), busy: false });
    return session;
  }
  async resumeSession(session: Session): Promise<Session> {
    const existing = this.sessions.get(session.id);
    if (!existing || existing.session !== session) fail("CapabilityUnavailable", "Muse session cannot be resumed on this host.");
    return existing.session;
  }
  async runTurn(session: Session, packet: DelegationPacket, signal?: AbortSignal): Promise<TurnResult> {
    const entry = this.sessions.get(session.id);
    if (!entry || entry.session !== session) fail("InvalidInput", "Unknown Muse session.");
    if (entry.busy) fail("CapabilityUnavailable", "Muse session already has an active turn.");
    entry.busy = true;
    entry.abort = new AbortController();
    const abort = (): void => entry.abort.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      return this.binding.transport === "muse-msp" ? await this.msp.runTurn(session.id, packet, entry.abort.signal) :
        await this.exec.run({ packet, requiredCapabilities: { ...this.binding.requires, webToolsDisabled: true },
          outputSchema: RESULT_PACKET_SCHEMA, malformedOutputRetries: 1, signal: entry.abort.signal,
          ...(this.config.evidenceDirectory ? { evidenceDirectory: this.config.evidenceDirectory } : {}) });
    } catch (error) {
      const e = error instanceof MuseFailure ? error.error : internalError("Muse adapter could not complete safely.", error);
      return { status: e.kind === "Cancelled" ? "cancelled" : "failed", effectiveProvider: "", effectiveModel: "",
        error: e, artifactRefs: [] };
    } finally { signal?.removeEventListener("abort", abort); entry.busy = false; }
  }
  async cancel(session: Session): Promise<void> {
    const entry = this.sessions.get(session.id);
    if (!entry) return;
    entry.abort.abort();
    if (this.binding.transport === "muse-msp") await this.msp.cancel(session.id);
  }
  async usage(session: Session): Promise<ProviderUsage | null> {
    if (!this.sessions.has(session.id)) fail("InvalidInput", "Unknown Muse session.");
    return this.binding.transport === "muse-msp" ? this.msp.usage(session.id) : null;
  }
  /** Closing a session also stops its in-flight turn; nothing keeps running untracked. */
  async close(session: Session): Promise<void> {
    this.sessions.get(session.id)?.abort.abort();
    this.sessions.delete(session.id);
    if (this.sessions.size === 0) await this.msp.close();
  }
}
