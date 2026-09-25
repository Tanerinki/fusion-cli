import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { internalError } from "../../core/errors.js";
import { removeOwnedTemporary } from "../../platform/fs/temporary.js";
import { resolveVersionedExecutable } from "../../platform/process/native-executable.js";
import { sessionWorkspaceRoot } from "../../platform/workspace/session-workspace.js";
import type { AuthStatus, CapabilitySnapshot, ChangeProposalRequest, DelegationPacket, FusionError, PacketTurnPurpose, ProviderAdapter,
  ProviderUsage, RoleBinding, Session, StructuredTurnRequest, StructuredTurnResult, TurnResult } from "../../core/domain.js";
import { REVIEW_ISOLATION } from "../../core/policy/routing.js";
import { MuseExecTransport } from "./exec-transport.js";
import { MuseMspTransport, type ApprovalPolicy } from "./msp-transport.js";
import { RESULT_PACKET_SCHEMA } from "./structured-output.js";
import { MuseFailure, capability, fail, uuidV7, type MuseFixtureBinary, type MuseLaunchConfig } from "./types.js";

/** A turn that failed before or outside the transport; no identity was observed and no output exists. */
type FailedTurn = Readonly<{ status: "failed" | "cancelled"; effectiveProvider: ""; effectiveModel: ""; error: FusionError;
  artifactRefs: readonly string[] }>;
/** Prefix of the empty, Fusion-owned directory the Exec account-attestation host runs in. */
export const MUSE_ATTESTATION_PREFIX = "fusion-muse-attest-";

/** Provider-neutral façade. Binding and posture are immutable for this instance. */
export class MuseAdapter implements ProviderAdapter {
  private readonly msp: MuseMspTransport;
  private readonly exec: MuseExecTransport;
  private readonly sessions = new Map<string, { session: Session; workspace?: string; abort: AbortController; busy: boolean }>();
  /**
   * Exec turns attest the account through an MSP host (`account/read`) before and after every turn. That host runs in
   * an EMPTY Fusion-owned directory — never in the primary checkout or a session's view — and is removed on close.
   */
  #attestation: Promise<Readonly<{ directory: string; host: MuseMspTransport }>> | undefined;
  #attested: AuthStatus | undefined;
  /** The latest account attestation (state, lane and a fixed evidence label; never account data). Evidence, not authority. */
  get attestedAuth(): AuthStatus | undefined { return this.#attested; }
  /** `fixtureBinary` is the internal test seam of both transports; the provider registry never supplies it. */
  constructor(readonly binding: RoleBinding, readonly config: MuseLaunchConfig, private readonly approvalPolicy?: ApprovalPolicy,
    private readonly fixtureBinary?: MuseFixtureBinary) {
    if (binding.provider !== config.provider || binding.model.id !== config.model.id || binding.model.effort !== config.model.effort ||
      !["muse-exec", "muse-msp"].includes(binding.transport)) fail("InvalidInput", "Muse binding and launch configuration differ.");
    this.msp = new MuseMspTransport(config, approvalPolicy, undefined, undefined, fixtureBinary);
    this.exec = new MuseExecTransport(config, () => this.attestAccount(), undefined, fixtureBinary);
    if (binding.transport === "muse-exec")
      this.runStructuredTurn = (session, request, signal) => this.structuredTurn(session, request, signal);
    if (binding.transport === "muse-exec")
      this.runChangeProposalTurn = (session, request, signal) => this.changeProposalTurn(session, request, signal);
  }
  async capabilities(): Promise<CapabilitySnapshot> {
    // An MSP adapter built for view-bound sessions can never run one (its host is started in one fixed workspace), so
    // routing learns that statically — the host is never started in the primary checkout just to be refused.
    if (this.binding.transport === "muse-msp" && this.config.requireSessionWorkspace === true)
      return capability(this.config, "muse-msp", "unknown");
    if (this.binding.transport === "muse-msp") return this.msp.capabilities();
    const executable = await resolveVersionedExecutable({ directory: this.config.binaryDirectory,
      versionFile: this.config.versionFile, prefix: "muse-bin-" });
    const version = basename(executable).match(/^muse-bin-(.+)\.exe$/i)?.[1] ?? "unknown";
    return capability(this.config, "muse-exec", version);
  }
  async authStatus(): Promise<AuthStatus> { return this.attestAccount(); }
  private async attestAccount(): Promise<AuthStatus> {
    if (this.binding.transport === "muse-msp") {
      if (this.config.requireSessionWorkspace === true) fail("CapabilityUnavailable", "Muse MSP cannot bind a Fusion-owned session workspace.");
      return this.msp.authStatus();
    }
    this.#attestation ??= (async () => {
      const directory = await mkdtemp(join(tmpdir(), MUSE_ATTESTATION_PREFIX));
      return Object.freeze({ directory, host: new MuseMspTransport({ ...this.config, workspace: directory }, this.approvalPolicy,
        undefined, undefined, this.fixtureBinary) });
    })();
    const auth = await (await this.#attestation).host.authStatus();
    this.#attested = Object.freeze({ ...auth, evidence: Object.freeze([...auth.evidence]) });
    return auth;
  }
  async createSession(request: Parameters<ProviderAdapter["createSession"]>[0]): Promise<Session> {
    if (request.role !== this.binding.role || request.model.id !== this.binding.model.id ||
      request.model.effort !== this.binding.model.effort || request.posture !== this.config.posture)
      fail("InvalidInput", "Muse session request differs from its binding.");
    // The durable MSP host is started once in its configured workspace: it cannot run a session in a Fusion view.
    if (this.binding.transport === "muse-msp" && (request.workspace !== undefined || this.config.requireSessionWorkspace === true))
      fail("CapabilityUnavailable", "Muse MSP cannot bind a Fusion-owned session workspace.");
    const workspace = await sessionWorkspaceRoot(request.workspace, this.config.forbiddenWorkspaceRoots ?? [],
      this.config.requireSessionWorkspace === true);
    const requirements = { ...this.binding.requires, webToolsDisabled: true } as const;
    const id = this.binding.transport === "muse-msp" ? await this.msp.createSession(requirements) : uuidV7();
    const session: Session = { id, runId: request.runId, role: request.role, provider: this.config.provider,
      transport: this.binding.transport, workspaceLeaseId: request.workspaceLeaseId, posture: request.posture,
      providerSessionRef: id, ...(workspace === undefined ? {} : { workspaceRoot: request.workspace!.root }) };
    this.sessions.set(id, { session, ...(workspace === undefined ? {} : { workspace }), abort: new AbortController(), busy: false });
    return session;
  }
  async resumeSession(session: Session): Promise<Session> {
    const existing = this.sessions.get(session.id);
    if (!existing || existing.session !== session) fail("CapabilityUnavailable", "Muse session cannot be resumed on this host.");
    return existing.session;
  }
  async runTurn(session: Session, packet: DelegationPacket, signal?: AbortSignal, purpose?: PacketTurnPurpose): Promise<TurnResult> {
    return this.guarded(session, signal, (abort, workspace) => this.binding.transport === "muse-msp"
      ? this.msp.runTurn(session.id, packet, abort, purpose)
      : this.exec.run({ packet, requiredCapabilities: { ...this.binding.requires, webToolsDisabled: true }, ...(purpose === undefined ? {} : { purpose }),
        outputSchema: RESULT_PACKET_SCHEMA, malformedOutputRetries: this.config.malformedOutputRetries ?? 1, signal: abort, ...workspace,
        ...(this.config.evidenceDirectory ? { evidenceDirectory: this.config.evidenceDirectory } : {}) }));
  }
  /**
   * Structured review/adjudication turns exist only on the Exec transport, which decodes against the contract's schema
   * under the launch-time read-only controls. The MSP transport has no such channel, so the method is absent there.
   */
  readonly runStructuredTurn?: (session: Session, request: StructuredTurnRequest, signal?: AbortSignal) => Promise<StructuredTurnResult>;
  readonly runChangeProposalTurn?: (session: Session, request: ChangeProposalRequest, signal?: AbortSignal) => Promise<StructuredTurnResult>;
  private changeProposalTurn(session: Session, request: ChangeProposalRequest, signal?: AbortSignal): Promise<StructuredTurnResult> {
    if (session.role !== "Worker" || session.posture !== "readOnly")
      fail("CapabilityUnavailable", "Change proposal requires a read-only Worker session.");
    return this.structuredTurn(session, request, signal);
  }
  private structuredTurn(session: Session, request: StructuredTurnRequest | ChangeProposalRequest, signal?: AbortSignal): Promise<StructuredTurnResult> {
    return this.guarded(session, signal, (abort, workspace) => this.exec.runStructured({ request, signal: abort, ...workspace,
      requiredCapabilities: { ...this.binding.requires, ...REVIEW_ISOLATION, webToolsDisabled: true, structuredOutput: true,
        filesystem: { read: true, write: false }, shell: { available: false } },
      malformedOutputRetries: this.config.malformedOutputRetries ?? 1,
      ...(this.config.evidenceDirectory ? { evidenceDirectory: this.config.evidenceDirectory } : {}) }));
  }
  /** One turn at a time per session; the caller's signal, `cancel` and `close` all reach the running turn. */
  private async guarded<T>(session: Session, signal: AbortSignal | undefined,
    work: (abort: AbortSignal, workspace: Readonly<{ workspace?: string }>) => Promise<T>): Promise<T | FailedTurn> {
    const entry = this.sessions.get(session.id);
    if (!entry || entry.session !== session) fail("InvalidInput", "Unknown Muse session.");
    if (entry.busy) fail("CapabilityUnavailable", "Muse session already has an active turn.");
    entry.busy = true;
    entry.abort = new AbortController();
    const abort = (): void => entry.abort.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try { return await work(entry.abort.signal, entry.workspace === undefined ? {} : { workspace: entry.workspace }); }
    catch (error) {
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
    if (this.sessions.size !== 0) return;
    await this.msp.close();
    const attestation = this.#attestation;
    this.#attestation = undefined;
    if (attestation !== undefined) {
      const { directory, host } = await attestation;
      await host.close();
      await removeOwnedTemporary(directory);
    }
  }
}
