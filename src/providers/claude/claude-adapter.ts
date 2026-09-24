import { randomUUID } from "node:crypto";
import type { AuthStatus, CapabilitySnapshot, ChangeProposalRequest, DelegationPacket, ProviderAdapter, ProviderUsage, RoleBinding, Session,
  StructuredTurnRequest, StructuredTurnResult, TurnResult } from "../../core/domain.js";
import { sessionWorkspaceRoot } from "../../platform/workspace/session-workspace.js";
import { ClaudeOneShotTransport } from "./one-shot-transport.js";
import { fail, type ClaudeFixtureBinary, type ClaudeLaunchConfig } from "./types.js";

interface LocalSession { readonly session: Session; readonly workspace?: string; abort: AbortController; busy: boolean;
  usage: ProviderUsage | null }

/** One-shot provider façade. Each turn repeats the guarded auth and runtime assertions. */
export class ClaudeAdapter implements ProviderAdapter {
  private readonly transport: ClaudeOneShotTransport;
  private readonly sessions = new Map<string, LocalSession>();
  constructor(readonly binding: RoleBinding, readonly config: ClaudeLaunchConfig, fixtureBinary?: ClaudeFixtureBinary) {
    if (binding.provider !== "claude" || binding.transport !== "claude-one-shot" ||
        binding.model.id !== config.model.id || binding.model.effort !== config.model.effort ||
        binding.model.maxTurns !== config.model.maxTurns)
      fail("InvalidInput", "Claude binding and launch configuration differ.");
    this.transport = new ClaudeOneShotTransport(config, undefined, fixtureBinary);
  }
  /** Launch-time posture before any session (validated installed runtime only), the observed one after a turn. */
  async capabilities(): Promise<CapabilitySnapshot> { return this.transport.launchCapabilities(); }
  /**
   * Auth readback outside a session. An adapter built for view-bound sessions refuses it: its readback happens inside
   * each session, in that session's view, so no Claude process of it ever starts in the default (primary) workspace.
   */
  async authStatus(): Promise<AuthStatus> {
    if (this.config.requireSessionWorkspace === true)
      fail("CapabilityUnavailable", "This adapter reads back authentication only inside a view-bound session.");
    return this.transport.authStatus();
  }
  async createSession(request: Parameters<ProviderAdapter["createSession"]>[0]): Promise<Session> {
    if (request.role !== this.binding.role || request.model.id !== this.binding.model.id ||
        request.model.effort !== this.binding.model.effort || request.model.maxTurns !== this.binding.model.maxTurns ||
        request.posture !== "readOnly" || request.posture !== this.config.posture)
      fail("InvalidInput", "Claude session request differs from its binding.");
    this.transport.assertStaticRequirements(this.requirements());
    // A bound session runs every process in its Fusion-owned workspace; the primary checkout is refused outright.
    const workspace = await sessionWorkspaceRoot(request.workspace, this.config.forbiddenWorkspaceRoots ?? [],
      this.config.requireSessionWorkspace === true);
    await this.transport.authStatus(workspace);
    const id = randomUUID();
    const session: Session = { id, runId: request.runId, role: request.role, provider: "claude",
      transport: "claude-one-shot", workspaceLeaseId: request.workspaceLeaseId, posture: "readOnly",
      providerSessionRef: id, ...(workspace === undefined ? {} : { workspaceRoot: request.workspace!.root }) };
    this.sessions.set(id, { session, ...(workspace === undefined ? {} : { workspace }), abort: new AbortController(), busy: false,
      usage: null });
    return session;
  }
  async resumeSession(session: Session): Promise<Session> {
    const local = this.sessions.get(session.id);
    if (!local || local.session !== session) fail("CapabilityUnavailable", "Claude one-shot session is unavailable on this host.");
    return local.session;
  }
  async runTurn(session: Session, packet: DelegationPacket, signal?: AbortSignal): Promise<TurnResult> {
    return this.guarded(session, signal, (abort, workspace) => this.transport.run({ packet, requiredCapabilities: this.requirements(),
      signal: abort, ...workspace }));
  }
  /** A review or adjudication turn with the same guards; the output is strict JSON the core still validates. */
  async runStructuredTurn(session: Session, request: StructuredTurnRequest, signal?: AbortSignal): Promise<StructuredTurnResult> {
    return this.guarded(session, signal, (abort, workspace) =>
      this.transport.runStructured({ request, requiredCapabilities: this.requirements(), signal: abort, ...workspace }));
  }
  async runChangeProposalTurn(session: Session, request: ChangeProposalRequest, signal?: AbortSignal): Promise<StructuredTurnResult> {
    if (session.role !== "Worker" || session.posture !== "readOnly")
      fail("CapabilityUnavailable", "Change proposal requires a read-only Worker session.");
    return this.guarded(session, signal, (abort, workspace) =>
      this.transport.runStructured({ request, requiredCapabilities: this.requirements(), signal: abort, ...workspace }));
  }
  async cancel(session: Session): Promise<void> { this.sessions.get(session.id)?.abort.abort(); }
  async usage(session: Session): Promise<ProviderUsage | null> {
    const local = this.sessions.get(session.id);
    if (!local || local.session !== session) fail("InvalidInput", "Unknown Claude session.");
    return local.usage;
  }
  async close(session: Session): Promise<void> {
    const local = this.sessions.get(session.id);
    if (!local || local.session !== session) return;
    local.abort.abort(); this.sessions.delete(session.id);
  }
  /** One turn at a time per session; the caller's signal and `cancel` both reach the running process. */
  private async guarded<T extends { usage?: ProviderUsage }>(session: Session, signal: AbortSignal | undefined,
    work: (abort: AbortSignal, workspace: Readonly<{ workspace?: string }>) => Promise<T>): Promise<T> {
    const local = this.sessions.get(session.id);
    if (!local || local.session !== session) fail("InvalidInput", "Unknown Claude session.");
    if (local.busy) fail("CapabilityUnavailable", "Claude session already has an active turn.");
    local.busy = true;
    local.abort = new AbortController();
    const abort = (): void => local.abort.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const result = await work(local.abort.signal, local.workspace === undefined ? {} : { workspace: local.workspace });
      local.usage = result.usage ?? null;
      return result;
    } finally { local.busy = false; signal?.removeEventListener("abort", abort); }
  }
  private requirements() {
    return { ...this.binding.requires, structuredOutput: true, webToolsDisabled: true,
      modelIdentityReadback: true, subscriptionLaneReadback: true,
      approvalEscalationDisabled: true, personalContextDisabled: true, extensionsQuarantined: true,
      filesystem: { ...this.binding.requires.filesystem, read: true, write: false },
      shell: { ...this.binding.requires.shell, available: false } } as const;
  }
}
