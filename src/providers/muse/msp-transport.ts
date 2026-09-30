import type { AuthStatus, CapabilityRequirement, CapabilitySnapshot, DelegationPacket, PacketTurnPurpose, ProviderUsage,
  TurnResult } from "../../core/domain.js";
import { internalError } from "../../core/errors.js";
import { FUSION_VERSION } from "../../platform/events/shared.js";
import { assertRuntimeEvidence } from "../../core/policy/billing-guard.js";
import { meetsCapabilities } from "../../core/capabilities.js";
import { supervisorFor, type ProcessSupervisor } from "../../platform/process/supervisor.js";
import { SandboxingSupervisor } from "../../platform/process/sandboxing-supervisor.js";
import { MuseRpcHost, RpcError, type RpcEvent } from "./protocol/rpc-host.js";
import { MuseFailure, MSP_READ_ONLY_FLAGS, MSP_READ_ONLY_PROFILE, capability, fail, prepareLaunch, positiveInt, record, string, uuidV7, type MuseFixtureBinary, type MuseLaunchConfig } from "./types.js";
import { parsePacket, renderPrompt } from "./structured-output.js";

const REQUIRED_METHODS = ["session/start", "session/read", "turn/start", "turn/cancel", "approval/decide", "approval/listPending", "account/read", "usage/read"] as const;
/** Default deadline for one MSP turn after it was accepted. */
export const MUSE_MSP_TURN_TIMEOUT_MS = 120_000;

/**
 * A turn that did not complete is attributed to why Fusion stopped it: a policy veto is a security
 * outcome, a deadline is a timeout, and only a user/shutdown request is a cancellation.
 */
function failForStop(state: SessionState, detail: string): never {
  const reason = state.cancellationReason;
  if (state.vetoed || reason === "approvalVeto" || reason === "securityViolation")
    fail("SecurityViolation", "Muse requested an action the read-only policy denied; the turn was stopped.");
  if (reason === "timeout") fail("Timeout", "Muse MSP turn exceeded its deadline.", true);
  fail("Cancelled", `Muse MSP turn ${detail}.`);
}
function normalizedRpcFailure(error: unknown): unknown {
  if (error instanceof RpcError) return new MuseFailure({ kind: error.code === -32601 ? "CapabilityUnavailable" : "ProtocolError",
    safeMessage: `Muse MSP request failed with code ${error.code}.`, retryable: false });
  return error;
}
export type ApprovalOutcome = "AllowOnce" | "AllowSession" | "Deny" | "Abort" | "Unknown";
export interface ApprovalRequest {
  readonly sessionId: string;
  readonly approvalId: string;
  readonly requirementId: Readonly<{ approvalId: string; sourceIndex: number }>;
  readonly subjectKind: string;
  readonly choices: readonly ApprovalOutcome[];
}
export type ApprovalPolicy = (request: ApprovalRequest) => Promise<ApprovalOutcome> | ApprovalOutcome;
interface SessionState {
  id: string;
  provider: string;
  model: string;
  viewCursor: string;
  activeTurnId: string | undefined;
  terminal: { turnId: string; status: "completed" | "failed" | "cancelled"; usage?: ProviderUsage } | undefined;
  readonly messages: Map<string, string>;
  cancellationReason: string | undefined;
  cancellationPromise: Promise<void> | undefined;
  /** A negative approval decision was sent for the active turn. */
  vetoed: boolean;
  completed: ((result: SessionState["terminal"]) => void) | undefined;
  readonly decisions: Map<string, Promise<void>>;
  readonly queuedApprovals: Record<string, unknown>[];
  negativeTimer?: NodeJS.Timeout;
}

/** One durable Muse host, fixed to its launch posture. */
export class MuseMspTransport {
  private readonly host: MuseRpcHost;
  private started?: Promise<void>;
  private snapshot?: CapabilitySnapshot;
  private auth?: AuthStatus;
  private state: SessionState | undefined;
  private version = "unknown";
  private fingerprint?: string;
  constructor(readonly config: MuseLaunchConfig, private readonly approvalPolicy: ApprovalPolicy = () => "Deny",
    // v0.6 I11: under HARD, wrap so every Muse execution is sandboxed (no muse binary on the host).
    supervisor: ProcessSupervisor = config.hardProfile === undefined
      ? supervisorFor(config.launchObserver)
      : new SandboxingSupervisor(supervisorFor(config.launchObserver), config.hardProfile),
    requestTimeoutMs = 8_000, private readonly fixtureBinary?: MuseFixtureBinary) {
    this.host = new MuseRpcHost(supervisor, requestTimeoutMs);
  }
  private async start(): Promise<void> { this.started ??= this.startOnce(); await this.started; }
  private async startOnce(): Promise<void> {
    const launch = await prepareLaunch(this.config, this.fixtureBinary);
    this.host.start(launch, ["serve", ...MSP_READ_ONLY_FLAGS], this.config.workspace);
    this.host.onEvent(event => this.onEvent(event));
    try {
      const init = await this.host.request("initialize", { clientInfo: { name: "fusion_cli", version: FUSION_VERSION },
        capabilities: { experimentalApi: true, requestedCapabilities: [], userInputDialogs: false } });
      const info = record(init.serverInfo), schema = record(init.schema);
      if (info?.name !== "muse" || !string(info.version) || schema?.version !== 1 ||
        !/^sha256:[0-9a-f]{64}$/.test(String(schema.fingerprint)) || init.sessionDurability === "ephemeral" ||
        init.experimentalApi !== true) fail("CapabilityUnavailable", "Muse MSP handshake lacks durable experimental support.");
      this.version = info.version as string; this.fingerprint = schema.fingerprint as string;
      await this.host.notify("initialized");
      const available = await this.probeMethods();
      this.snapshot = capability(this.config, "muse-msp", this.version, this.fingerprint, available);
    } catch (error) { await this.host.forceStop(); throw normalizedRpcFailure(error); }
  }
  private async probeMethods(): Promise<boolean> {
    for (const method of REQUIRED_METHODS) {
      try {
        await this.host.request(method, method === "account/read" || method === "usage/read" ? undefined : { __fusionProbe: true });
        if (method !== "account/read" && method !== "usage/read") return false;
      } catch (error) {
        if (!(error instanceof RpcError) || error.code !== -32602) return false;
      }
    }
    return true;
  }
  async capabilities(): Promise<CapabilitySnapshot> { await this.start(); return this.snapshot!; }
  /** O5.5B23: the version the running host reported in its `initialize` handshake (`unknown` before it started). */
  get runtimeVersion(): string { return this.version; }
  async authStatus(): Promise<AuthStatus> {
    await this.start();
    const result = await this.host.request("account/read").catch(error => { throw normalizedRpcFailure(error); });
    const state = string(result.state);
    this.auth = state === "accountLogin" ? { state: "authenticated", lane: "subscription", observedAt: new Date().toISOString(),
      evidence: ["msp:account/read:accountLogin"] } : { state: "ambiguous", lane: "unknown", observedAt: new Date().toISOString(),
      evidence: ["msp:account/read:nonSubscription"] };
    return this.auth;
  }
  async createSession(required: CapabilityRequirement): Promise<string> {
    if (this.config.maxModelSteps !== undefined) fail("CapabilityUnavailable", "Muse MSP cannot enforce a model-step limit.");
    await this.start();
    if (!this.snapshot?.persistentSessions) fail("CapabilityUnavailable", "Muse MSP required method set is unavailable.");
    if (!meetsCapabilities(this.snapshot, required)) fail("CapabilityUnavailable", "Muse MSP lacks a required capability.");
    if (this.state) fail("CapabilityUnavailable", "This Muse MSP host already owns a session.");
    const auth = await this.authStatus();
    if (auth.state !== "authenticated" || auth.lane !== "subscription") fail("AuthMismatch", "Muse MSP account login is not active.");
    try {
      const started = await this.host.request("session/start", { commandId: uuidV7(), providerId: this.config.provider,
        modelId: this.config.model.id, workspaceRoot: this.config.workspace, approvalMode: "denyUnmatched" });
      const session = record(started.session), id = string(session?.sessionId), cursor = string(started.viewCursor);
      if (!id || !cursor) fail("ProtocolError", "Muse MSP returned an invalid session start result.");
      const read = await this.host.request("session/read", { sessionId: id, excludeItems: true });
      const observed = record(read.session), readId = string(observed?.sessionId);
      if (readId !== id || observed?.workspaceRoot !== this.config.workspace) fail("SecurityViolation", "Muse MSP session readback changed workspace identity.");
      const mode = record(observed?.approvalMode);
      if (mode?.mode !== "denyUnmatched") fail("SecurityViolation", "Muse MSP approval mode was not enforced.");
      const asserted = assertRuntimeEvidence({ provider: this.config.provider, model: this.config.model.id,
        authLane: "subscription", posture: "readOnly", permissionProfileId: MSP_READ_ONLY_PROFILE, requiredCapabilities: required },
        { auth, effectiveProvider: string(observed?.providerId), effectiveModel: string(observed?.modelId),
          permission: { posture: "readOnly", profileId: MSP_READ_ONLY_PROFILE, source: "hostEnforcement", mechanicallyEnforced: true },
          capabilities: this.snapshot! });
      if (!asserted.ok) throw new MuseFailure(asserted.error);
      this.state = { id, provider: observed!.providerId as string, model: observed!.modelId as string,
        viewCursor: string(read.viewCursor) ?? cursor, messages: new Map(), decisions: new Map(), activeTurnId: undefined,
        terminal: undefined, completed: undefined, cancellationReason: undefined, cancellationPromise: undefined,
        vetoed: false, queuedApprovals: [] };
      return id;
    } catch (error) { await this.host.forceStop(); throw normalizedRpcFailure(error); }
  }
  private current(id: string): SessionState {
    if (!this.state || this.state.id !== id || !this.host.isAlive) fail("CapabilityUnavailable", "Muse MSP session is unavailable.");
    return this.state;
  }
  async runTurn(id: string, packet: DelegationPacket, signal?: AbortSignal, purpose?: PacketTurnPurpose): Promise<TurnResult> {
    let state: SessionState;
    try {
      state = this.current(id);
      if (signal?.aborted) fail("Cancelled", "Muse MSP turn was cancelled before submission.");
      if (state.activeTurnId) fail("CapabilityUnavailable", "Muse MSP session already has an active turn.");
      state.messages.clear(); state.terminal = undefined; state.decisions.clear();
      state.cancellationReason = undefined; state.cancellationPromise = undefined; state.vetoed = false;
      state.queuedApprovals.length = 0;
      const commandId = uuidV7();
      const terminalPromise = new Promise<SessionState["terminal"]>(resolve => { state.completed = resolve; });
      let ack: Record<string, unknown>;
      try {
        ack = await this.host.request("turn/start", { commandId, sessionId: id,
          input: [{ type: "text", text: renderPrompt(packet, purpose) }], reasoningEffort: this.config.model.effort, ifBusy: "queue" });
      } catch (error) {
        // A timeout can mean the command was accepted while its acknowledgement was lost.
        await this.host.forceStop(); throw error;
      }
      if (ack.commandId !== commandId || ack.status !== "accepted" || ack.disposition !== "started" || !string(ack.turnId)) {
        await this.host.forceStop(); fail("ProtocolError", "Muse MSP rejected or queued the turn unexpectedly.");
      }
      state.activeTurnId = ack.turnId as string;
      for (const queued of state.queuedApprovals.splice(0)) this.routeApproval(state, queued);
      const onAbort = (): void => { this.cancelSafely(id, "user"); };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      const timeout = setTimeout(() => { this.cancelSafely(id, "timeout"); }, this.config.timeoutMs ?? MUSE_MSP_TURN_TIMEOUT_MS);
      let unsubscribeExit = (): void => {};
      const hostExit = new Promise<undefined>(resolve => {
        unsubscribeExit = this.host.onExit(() => resolve(undefined));
      });
      try {
        const terminal = await Promise.race([
          terminalPromise, hostExit,
        ]);
        if (!terminal) {
          if (state.cancellationReason || state.vetoed) failForStop(state, "ended through forced cancellation");
          fail("ProcessFailure", "Muse MSP host exited before the turn terminal event.", true);
        }
        if (terminal.turnId !== state.activeTurnId) fail("ProtocolError", "Muse MSP terminal turn ID did not match.");
        if (terminal.status === "cancelled") failForStop(state, "was cancelled");
        if (terminal.status === "failed") {
          if (state.vetoed) failForStop(state, "failed after an approval veto");
          fail("ProcessFailure", "Muse MSP turn failed.", true);
        }
        if (state.cancellationReason) failForStop(state, "completed after cancellation");
        const output = parsePacket(state.messages.get(state.activeTurnId) ?? "");
        return { status: "completed", effectiveProvider: state.provider, effectiveModel: state.model, output,
          ...(terminal.usage ? { usage: terminal.usage } : {}), artifactRefs: [] };
      } finally {
        unsubscribeExit();
        clearTimeout(timeout); signal?.removeEventListener("abort", onAbort);
        if (state.negativeTimer) clearTimeout(state.negativeTimer);
        state.completed = undefined; state.activeTurnId = undefined;
      }
    } catch (error) {
      if (this.state) this.state.completed = undefined;
      const e = error instanceof MuseFailure ? error.error : error instanceof RpcError ?
        { kind: "ProtocolError" as const, safeMessage: `Muse MSP request failed with code ${error.code}.`, retryable: false } :
        internalError("Muse MSP turn could not complete safely.", error);
      return { status: e.kind === "Cancelled" ? "cancelled" : "failed", effectiveProvider: this.state?.provider ?? "",
        effectiveModel: this.state?.model ?? "", error: e, artifactRefs: [] };
    }
  }
  /** Idempotent: cancelling an idle, closed, or dead session is a no-op rather than an error. */
  async cancel(id: string, reason = "user"): Promise<void> {
    const state = this.state;
    if (!state || state.id !== id || !this.host.isAlive || !state.activeTurnId) return;
    state.cancellationReason ??= reason;
    if (state.cancellationPromise) return state.cancellationPromise;
    const turnId = state.activeTurnId;
    state.cancellationPromise = (async () => { try {
      const commandId = uuidV7();
      const ack = await this.host.request("turn/cancel", { commandId, sessionId: id, turnId });
      if (ack.commandId !== commandId || ack.status !== "accepted" || ack.turnId !== turnId)
        fail("ProtocolError", "Muse MSP did not accept turn cancellation.");
      for (let i = 0; i < 8 && !state.terminal; i++) await new Promise<void>(resolve => setTimeout(resolve, 100));
      if (!state.terminal) await this.host.forceStop();
    } catch { await this.host.forceStop(); } })();
    return state.cancellationPromise;
  }
  private cancelSafely(id: string, reason: string): void {
    void this.cancel(id, reason).catch(() => { void this.host.forceStop().catch(() => {}); });
  }
  async usage(id: string): Promise<ProviderUsage | null> {
    this.current(id);
    const result = await this.host.request("usage/read").catch(error => { throw normalizedRpcFailure(error); });
    const usage = record(result.usage);
    if (!usage) return null;
    const window = record(usage.window), weekly = record(usage.weekly);
    const observedAtMs = positiveInt(usage.observedAtMs), windowUsed = positiveInt(window?.usedPercent),
      windowReset = positiveInt(window?.resetsAtMs), duration = positiveInt(window?.windowDurationMins),
      weeklyUsed = positiveInt(weekly?.usedPercent), weeklyReset = positiveInt(weekly?.resetsAtMs);
    if (!string(usage.tier) || observedAtMs === null || windowUsed === null || windowReset === null ||
      duration === null || duration === 0 || weeklyUsed === null || weeklyReset === null)
      fail("ProtocolError", "Muse MSP returned malformed subscription usage.");
    return { subscription: { tier: usage.tier as string, observedAtMs,
      window: { usedPercent: windowUsed, resetsAtMs: windowReset, windowDurationMins: duration },
      weekly: { usedPercent: weeklyUsed, resetsAtMs: weeklyReset } } };
  }
  async close(): Promise<void> {
    if (this.state?.negativeTimer) clearTimeout(this.state.negativeTimer);
    if (this.state?.activeTurnId && this.host.isAlive) await this.cancel(this.state.id, "shutdown");
    await this.host.stop(); this.state = undefined;
  }
  private onEvent(event: RpcEvent): void {
    const state = this.state;
    if (!state) return;
    const p = event.params;
    if (event.method === "approval/request" || event.method === "approval/requested") {
      if (state.terminal) return;
      if (state.activeTurnId) this.routeApproval(state, p);
      else if (state.queuedApprovals.length < 32) state.queuedApprovals.push(p);
      else void this.host.forceStop().catch(() => {});
    } else if (event.method === "item/completed" && p.sessionId === state.id) {
      const item = record(p.item);
      if (item?.kind === "agentMessage" && string(item.turnId) && typeof item.text === "string")
        state.messages.set(item.turnId as string, item.text);
      if (string(p.viewCursor)) state.viewCursor = p.viewCursor as string;
    } else if (event.method === "turn/completed" && p.sessionId === state.id) {
      const status = p.terminal, turnId = string(p.turnId);
      if (!turnId || !["completed", "failed", "cancelled"].includes(String(status)) || state.terminal) {
        void this.host.forceStop().catch(() => {}); return;
      }
      const usage = record(p.usage), inputTokens = positiveInt(usage?.inputTokens), outputTokens = positiveInt(usage?.outputTokens);
      state.terminal = { turnId, status: status as "completed" | "failed" | "cancelled",
        ...(inputTokens !== null && outputTokens !== null ? { usage: { inputTokens, outputTokens } } : {}) };
      if (state.negativeTimer) clearTimeout(state.negativeTimer);
      state.completed?.(state.terminal);
    }
  }
  private routeApproval(state: SessionState, params: Record<string, unknown>): void {
    void this.handleApproval(state, params).catch(() => {
      if (state.terminal) return;
      if (state.activeTurnId) this.cancelSafely(state.id, "securityViolation");
      else void this.host.forceStop().catch(() => {});
    });
  }
  private async handleApproval(state: SessionState, params: Record<string, unknown>): Promise<void> {
    const approvalId = string(params.approvalId), sessionId = string(params.sessionId), req = record(params.currentRequirementId);
    const reqApproval = string(req?.approvalId), index = positiveInt(req?.sourceIndex), choices = params.availableChoices;
    if (!approvalId || sessionId !== state.id || !reqApproval || index === null || !Array.isArray(choices) ||
      reqApproval !== approvalId || !state.activeTurnId || params.turnId !== state.activeTurnId) fail("SecurityViolation", "Malformed Muse approval request.");
    const key = `${sessionId}:${approvalId}:${reqApproval}:${index}`;
    if (state.decisions.has(key)) return;
    const work = this.decideApproval(state, params, { approvalId: reqApproval, sourceIndex: index }, choices);
    state.decisions.set(key, work);
    await work;
  }
  private async decideApproval(state: SessionState, params: Record<string, unknown>, requirementId: { approvalId: string; sourceIndex: number }, choices: unknown[]): Promise<void> {
    const pending = await this.host.request("approval/listPending", { sessionId: state.id });
    if (state.terminal) return;
    const list = pending.approvals;
    if (!Array.isArray(list) || !list.some(x => {
      const a = record(x), r = record(a?.currentRequirementId);
      return a?.approvalId === params.approvalId && r?.approvalId === requirementId.approvalId && r?.sourceIndex === requirementId.sourceIndex;
    })) fail("SecurityViolation", "Muse approval requirement is stale.");
    const normalized = choices.map(x => {
      const c = record(x), d = string(c?.decision), id = string(c?.choiceId);
      const outcome: ApprovalOutcome = d === "approved" ? "AllowOnce" : d === "approvedForSession" ? "AllowSession" :
        d === "denied" || d === "deniedPolicyAmendment" || d === "timedOut" ? "Deny" : d === "abort" ? "Abort" : "Unknown";
      return { id, outcome };
    });
    if (normalized.some(x => !x.id || x.outcome === "Unknown")) fail("SecurityViolation", "Muse approval choices are malformed.");
    const subject = record(params.subject);
    const requested = await this.approvalPolicy({ sessionId: state.id, approvalId: params.approvalId as string,
      requirementId, subjectKind: string(subject?.kind) ?? "unknown", choices: normalized.map(x => x.outcome) });
    if (state.terminal) return;
    if (requested === "AllowOnce" || requested === "AllowSession") fail("SecurityViolation", "Read-only Muse host cannot approve tool access.");
    const chosen = normalized.find(x => x.outcome === requested);
    if (!chosen?.id) fail("SecurityViolation", "No matching negative Muse approval choice is available.");
    state.vetoed = true;
    const commandId = uuidV7();
    const ack = await this.host.request("approval/decide", { approvalId: params.approvalId, choiceId: chosen.id,
      commandId, requirementId, sessionId: state.id });
    if (ack.commandId !== commandId || ack.approvalId !== params.approvalId || ack.status !== "accepted")
      fail("ProtocolError", "Muse approval decision was not accepted.");
    if (!state.terminal && !state.negativeTimer) state.negativeTimer = setTimeout(() => {
      if (state.activeTurnId && !state.terminal) this.cancelSafely(state.id, "approvalVeto");
    }, 300);
  }
}
