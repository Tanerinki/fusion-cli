import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type { AuthStatus, CapabilityRequirement, CapabilitySnapshot, ChangeProposalRequest, DelegationPacket, FusionError, PacketTurnPurpose,
  StructuredTurnRequest, StructuredTurnResult, TurnResult, TurnResultBase } from "../../core/domain.js";
import { internalError } from "../../core/errors.js";
import { assertRuntimeEvidence } from "../../core/policy/billing-guard.js";
import { structuredTurnPrompt, structuredTurnSchema } from "../../core/review/contract.js";
import { packetTurnInstruction } from "../../core/workflow/lead-plan.js";
import { jsonSchemaSubset } from "../../platform/process/json-schema.js";
import { assertNativeExecutablePath } from "../../platform/process/native-executable.js";
import { parseStrictJson } from "../../platform/process/strict-json.js";
import type { EnvelopeOptions, StructuredOutputDiagnostic } from "../../platform/process/structured-envelope.js";
import { ProcessSupervisor, supervisorFor, type ProcessOutcome, type RunningProcess } from "../../platform/process/supervisor.js";
import type { TurnTerminalDiagnostic } from "../../platform/process/terminal-diagnostic.js";
import { transportProfile } from "../../runtime/provider-profiles.js";
import { ClaudeStream, isResultPacket } from "./parsing/stream.js";
import { claudeTerminalDiagnostic } from "./parsing/terminal.js";
import { CLAUDE_PREFLIGHT_TIMEOUTS, claudeReadOnlyArgs, convergePluginQuarantine, failOnLifecycleIssue,
  preflightPlugins, withTemporaryPluginSettings } from "./plugin-quarantine.js";
import { claudeCapability } from "./posture.js";
import { CLAUDE_CHILD_SWITCHES, CLAUDE_READ_ONLY_PROFILE, ClaudeFailure, claudeInstallVersion, fail, record, safeEnvironment,
  string, type ClaudeFixtureBinary, type ClaudeLaunchConfig, type ClaudeRuntimeEvidence } from "./types.js";

/** Default deadline for one guarded Claude turn; preflight steps never exceed it. */
export const CLAUDE_TURN_TIMEOUT_MS = 120_000;

export interface ClaudeRunRequest {
  readonly packet: DelegationPacket;
  readonly requiredCapabilities: CapabilityRequirement;
  readonly signal?: AbortSignal;
  /** Working directory of every process of this turn; the configured default when absent. */
  readonly workspace?: string;
  /** Why the engine runs this packet turn; selects the role-specific instruction only. */
  readonly purpose?: PacketTurnPurpose;
}
export interface ClaudeStructuredRequest {
  readonly request: StructuredTurnRequest | ChangeProposalRequest;
  readonly requiredCapabilities: CapabilityRequirement;
  readonly signal?: AbortSignal;
  readonly workspace?: string;
}
/** One guarded turn: the prompt sent on stdin and how the successful result is parsed. */
interface Invocation<T> {
  readonly prompt: string;
  readonly parse: (stream: ClaudeStream) => T;
  readonly requiredCapabilities: CapabilityRequirement;
  readonly signal?: AbortSignal;
  readonly workspace?: string;
}
type Execution<T> = TurnResultBase & (
  | Readonly<{ status: "completed"; output: T; error?: never }>
  | Readonly<{ status: "failed" | "cancelled"; output?: T; error: FusionError }>);

/**
 * A packet turn's prompt: the role-specific instruction (O5.5B16: the planning Lead's contract) or the generic
 * delegated-task wording, then the unchanged reply rule, ResultPacket shape and delegation.
 */
export const packetPrompt = (packet: DelegationPacket, purpose?: PacketTurnPurpose): string => `${packetTurnInstruction(purpose) ?? "Complete this delegated task within its scope."} Your entire response must be one raw JSON object, with no Markdown fence, commentary, or text before or after it. Use exactly this shape: {"result":{"status":"completed"},"changes":{"files":[],"summary":""},"verification":{"testsRun":[],"results":[]},"uncertainties":[],"failures":[],"needsLeadDecision":[]}. Change field values to report the actual outcome; model-reported checks are claims only.\nDelegation:\n${JSON.stringify(packet)}`;
type Prepared = Readonly<{ executable: string; argvPrefix: readonly string[]; env: NodeJS.ProcessEnv; lane: "subscription" | "subscriptionToken" }>;
/**
 * O5.5B10: the reply format again, as the LAST line of a change-proposal prompt (after all data). An instruction only —
 * never the boundary: the envelope reader decides what is accepted even when the instruction is ignored.
 */
export const CLAUDE_PROPOSAL_REPLY_RULE = "Reply format (Fusion checks it mechanically): reply with the raw JSON object alone. " +
  "The first character of your reply must be { and the last must be }. Do not wrap it in a Markdown code fence and add no " +
  "heading, explanation or any other text before or after it.";
/** The prompt of one structured turn: the provider-neutral instruction, plus the reply rule last for a change proposal. */
export function claudeStructuredPrompt(request: StructuredTurnRequest | ChangeProposalRequest): string {
  return request.kind === "changeProposal" ? `${structuredTurnPrompt(request)}\n${CLAUDE_PROPOSAL_REPLY_RULE}` : structuredTurnPrompt(request);
}
/** The Claude schema check: Fusion's JSON Schema subset bound to Claude's typed failure (a decoding aid, never the contract). */
const SCHEMA = jsonSchemaSubset(fail);
/**
 * O5.5B18: the envelope a packet turn's ResultPacket is read under. The Lead's plan uses this transport's recorded
 * `leadPlanEnvelope` (raw JSON or exactly one outer json/bare fence) with the exact ResultPacket shape as the fence body's
 * schema predicate; every other packet turn (exploration, delegate, Lead review) stays raw-only, exactly as before.
 */
export function packetEnvelope(purpose?: PacketTurnPurpose): EnvelopeOptions {
  if (purpose !== "plan") return RAW_ONLY_PACKET;
  const policy = transportProfile("claude", "claude-one-shot")?.leadPlanEnvelope ?? "rawOnly";
  return Object.freeze({ policy, conforms: isResultPacket });
}
const RAW_ONLY_PACKET: EnvelopeOptions = Object.freeze({ policy: "rawOnly" });
/**
 * The envelope a structured turn's result text is read under: a change proposal and (O5.5B22) a Lead adjudication use
 * the policies recorded in this transport's provider profile (raw JSON or exactly one outer json/bare fence); a review
 * turn stays raw-only. Either way the value must also satisfy the turn's decoding schema to pass a fence.
 */
export function structuredEnvelope(request: StructuredTurnRequest | ChangeProposalRequest): EnvelopeOptions {
  const schema = structuredTurnSchema(request);
  const profile = transportProfile("claude", "claude-one-shot");
  const policy = request.kind === "changeProposal" ? profile?.changeProposalEnvelope ?? "rawOnly"
    : request.kind === "adjudication" ? profile?.adjudicationEnvelope ?? "rawOnly" : "rawOnly";
  return Object.freeze({ policy, conforms: (value: unknown) => SCHEMA.validateSchema(value, schema) });
}

/** Guarded one-shot path. The fixture override is not exposed by ClaudeAdapter. */
export class ClaudeOneShotTransport {
  private lastEvidence?: ClaudeRuntimeEvidence;
  private lastInit?: ClaudeRuntimeEvidence;
  private lastOutput: StructuredOutputDiagnostic | undefined;
  private lastTerminal: TurnTerminalDiagnostic | undefined;
  private lastSnapshot?: CapabilitySnapshot;
  constructor(readonly config: ClaudeLaunchConfig, private readonly supervisor: ProcessSupervisor = supervisorFor(config.launchObserver),
    private readonly fixtureBinary?: ClaudeFixtureBinary) {}
  get runtimeEvidence(): ClaudeRuntimeEvidence | undefined { return this.lastEvidence; }
  /**
   * The verified init readback of the most recent turn that got past initialization, whether or not the turn then
   * succeeded (a malformed result, say). Diagnostic evidence only; `runtimeEvidence` stays success-only.
   */
  get initReadback(): ClaudeRuntimeEvidence | undefined { return this.lastInit; }
  /**
   * The structure-only diagnostic of the most recent structured turn's result text — classes, flags and counts, never any
   * part of the text — whether it was accepted or refused; undefined when that turn produced no result to read.
   */
  get structuredOutputDiagnostic(): StructuredOutputDiagnostic | undefined { return this.lastOutput; }
  /**
   * O5.5B14: the bounded terminal diagnostic of the most recent turn's model process — the result frame's subtype,
   * terminal reason and error flag as allowlisted labels, counts, the result text's byte length, how far Fusion's reader
   * got, and the process settlement. Never any text. Undefined when that turn started no model process.
   */
  get terminalDiagnostic(): TurnTerminalDiagnostic | undefined { return this.lastTerminal; }
  private async prepare(): Promise<Prepared> {
    if (this.config.posture !== "readOnly") fail("CapabilityUnavailable", "Claude writer isolation is not implemented.");
    if (!this.config.model.id || !this.config.model.effort || !this.config.expectedCanonicalModel)
      fail("InvalidInput", "Claude model and canonical identity must be configured.");
    if (this.config.model.maxTurns !== undefined &&
        (!Number.isSafeInteger(this.config.model.maxTurns) || this.config.model.maxTurns < 1))
      fail("InvalidInput", "Claude turn limit must be a positive integer.");
    const safe = await safeEnvironment(this.config);
    let executable: string;
    try { executable = assertNativeExecutablePath(this.fixtureBinary?.executable ?? this.config.executablePath); }
    catch { fail("InvalidInput", "Claude executable must be an absolute native binary path."); }
    if (!this.fixtureBinary && basename(executable).toLowerCase() !== "claude.exe")
      fail("InvalidInput", "Claude must use the native claude.exe binary.");
    let regular = false;
    try { regular = (await stat(executable)).isFile(); } catch { /* normalized below */ }
    if (!regular) fail("SpawnFailure", "Claude executable is not a regular file.");
    return { executable, argvPrefix: this.fixtureBinary?.argvPrefix ?? [], env: { ...safe.forSpawn(), ...CLAUDE_CHILD_SWITCHES },
      lane: safe.authLaneIntent };
  }
  private get turnDeadlineMs(): number { return this.config.timeoutMs ?? CLAUDE_TURN_TIMEOUT_MS; }
  private async readAuth(launch: Prepared, signal?: AbortSignal, cwd = this.config.workspace): Promise<AuthStatus> {
    const child = this.supervisor.start({ executable: launch.executable,
      args: [...launch.argvPrefix, "auth", "status"], cwd, env: launch.env, purpose: "providerAuthReadback",
      ...(signal ? { signal } : {}), timeoutMs: Math.min(CLAUDE_PREFLIGHT_TIMEOUTS.authStatusMs, this.turnDeadlineMs),
      maxStdoutBytes: 64 * 1024, maxStderrBytes: 16 * 1024 });
    const outcome = await child.result;
    failOnLifecycleIssue(outcome, "auth probe", signal);
    if (outcome.issue || outcome.exitCode !== 0 || outcome.stdoutTruncated)
      fail("AuthMismatch", "Claude authentication status could not be confirmed.");
    let value: unknown;
    try { value = parseStrictJson(outcome.stdout); }
    catch { fail("AuthMismatch", "Claude authentication status was malformed."); }
    const auth = record(value);
    const loggedIn = auth && (Object.hasOwn(auth, "isLoggedIn") ? auth.isLoggedIn : auth.loggedIn);
    const keySourcePresent = !!auth && Object.hasOwn(auth, "apiKeySource");
    const safeKeySource = keySourcePresent && (auth.apiKeySource === null || auth.apiKeySource === "none");
    // Claude Code 2.1.280 omits apiKeySource for an explicit OAuth-token login.
    // Only the guarded, deliberately forwarded subscription-token lane may use this shape.
    const explicitTokenShape = launch.lane === "subscriptionToken" && !keySourcePresent &&
      auth?.authMethod === "oauth_token";
    if (!auth || loggedIn !== true ||
        (Object.hasOwn(auth, "isLoggedIn") && auth.isLoggedIn !== true) ||
        (Object.hasOwn(auth, "loggedIn") && auth.loggedIn !== true) ||
        (!safeKeySource && !explicitTokenShape) ||
        auth.apiProvider !== "firstParty")
      fail("AuthMismatch", "Claude did not confirm first-party subscription authentication.");
    if (launch.lane === "subscription") {
      if (auth.authMethod !== "claude.ai" || !string(auth.subscriptionType))
        fail("AuthMismatch", "Claude login lacks subscription evidence.");
    } else if (auth.authMethod !== "oauth_token") {
      fail("AuthMismatch", "Claude explicit subscription-token lane was not confirmed.");
    }
    return { state: "authenticated", lane: launch.lane, observedAt: new Date().toISOString(),
      evidence: launch.lane === "subscription" ? ["auth-status:firstParty:subscriptionType"] :
        [explicitTokenShape ? "auth-status:firstParty:explicitOAuthToken:sourceFieldAbsent" :
          "auth-status:firstParty:explicitOAuthToken"] };
  }
  /** Auth readback, started in `workspace` (a session's own directory) or the configured default. */
  async authStatus(workspace?: string): Promise<AuthStatus> { return this.readAuth(await this.prepare(), undefined, workspace); }
  /** Static impossibilities are rejected before launch; init-dependent requirements are checked at runtime. */
  assertStaticRequirements(required: CapabilityRequirement): void {
    const known = claudeCapability();
    for (const [key, expected] of Object.entries(required)) {
      if (key === "filesystem" || key === "shell") {
        if (!record(expected)) fail("InvalidInput", "Claude capability requirement is malformed.");
        for (const [subkey, value] of Object.entries(expected)) {
          const actual = (known[key] as unknown as Record<string, unknown>)[subkey];
          if (typeof value !== "boolean" || actual === undefined) fail("InvalidInput", "Claude capability requirement is malformed.");
          if (actual !== "unknown" && actual !== value) fail("CapabilityUnavailable", "Claude one-shot cannot satisfy the requested capability.");
        }
      } else {
        const actual = (known as unknown as Record<string, unknown>)[key];
        if (typeof expected !== "boolean" || actual === undefined) fail("InvalidInput", "Claude capability requirement is malformed.");
        if (actual !== "unknown" && actual !== expected) fail("CapabilityUnavailable", "Claude one-shot cannot satisfy the requested capability.");
      }
    }
  }
  async run(request: ClaudeRunRequest): Promise<TurnResult> {
    const envelope = packetEnvelope(request.purpose);
    this.lastOutput = undefined;
    return this.execute({ prompt: packetPrompt(request.packet, request.purpose),
      parse: stream => { try { return stream.packet(envelope); } finally { this.lastOutput = stream.outputDiagnostic; } },
      requiredCapabilities: request.requiredCapabilities, ...(request.signal ? { signal: request.signal } : {}),
      ...(request.workspace === undefined ? {} : { workspace: request.workspace }) });
  }
  /**
   * A structured review, adjudication or change-proposal turn under exactly the same guards as `run`. The output is one
   * strict JSON value read under the turn's envelope (`structuredEnvelope`) and still untrusted: the core validates it
   * against its contract (O4 reports, the ChangeSet). A failed or cancelled turn hands back no output; the structure-only
   * diagnostic of its result, if one was read, stays available.
   */
  async runStructured(request: ClaudeStructuredRequest): Promise<StructuredTurnResult> {
    const envelope = structuredEnvelope(request.request);
    this.lastOutput = undefined;
    const turn = await this.execute({ prompt: claudeStructuredPrompt(request.request),
      parse: stream => { try { return stream.json(envelope); } finally { this.lastOutput = stream.outputDiagnostic; } },
      requiredCapabilities: request.requiredCapabilities, ...(request.signal ? { signal: request.signal } : {}),
      ...(request.workspace === undefined ? {} : { workspace: request.workspace }) });
    if (turn.status === "completed") return turn;
    return { status: turn.status, effectiveProvider: turn.effectiveProvider, effectiveModel: turn.effectiveModel,
      error: turn.error, ...(turn.usage ? { usage: turn.usage } : {}), artifactRefs: [] };
  }
  private async execute<T>(request: Invocation<T>): Promise<Execution<T>> {
    let effectiveModel = "";
    // A turn that never starts its model process reports no terminal diagnostic (never the previous turn's).
    this.lastTerminal = undefined;
    // Every process of the turn — auth readback, plugin inventory, init-only probes and the turn itself — starts here.
    const cwd = request.workspace ?? this.config.workspace;
    try {
      if (request.signal?.aborted) fail("Cancelled", "Claude turn was cancelled before launch.");
      this.assertStaticRequirements(request.requiredCapabilities);
      const launch = await this.prepare();
      if (request.signal?.aborted) fail("Cancelled", "Claude turn was cancelled before launch.");
      const auth = await this.readAuth(launch, request.signal, cwd);
      if (request.signal?.aborted) fail("Cancelled", "Claude turn was cancelled before launch.");
      const plugins = await preflightPlugins({ executable: launch.executable, argvPrefix: launch.argvPrefix,
        cwd, env: launch.env }, this.supervisor, this.config.model.id,
        this.config.model.effort, request.signal, this.turnDeadlineMs);
      if (request.signal?.aborted) fail("Cancelled", "Claude turn was cancelled before launch.");
      const completed = await withTemporaryPluginSettings(plugins.ids, async (settingsPath, rewriteSettings) => {
      // Prove the child-only settings on the startup right before the reviewer; plugins can appear between startups.
      const quarantine = await convergePluginQuarantine({ executable: launch.executable, argvPrefix: launch.argvPrefix,
        cwd, env: launch.env }, this.supervisor, this.config.model.id, this.config.model.effort,
        plugins, settingsPath, rewriteSettings, request.signal, this.turnDeadlineMs);
      if (request.signal?.aborted) fail("Cancelled", "Claude turn was cancelled before launch.");
      const stream = new ClaudeStream();
      let earlyFailure: ClaudeFailure | undefined;
      let observed: ClaudeRuntimeEvidence | undefined;
      let child: RunningProcess | undefined;
      const args = [...launch.argvPrefix, ...claudeReadOnlyArgs(this.config.model.id, this.config.model.effort,
        this.config.model.maxTurns ?? 1), "--settings", settingsPath];
      const prompt = request.prompt;
      const rejectEarly = (failure: ClaudeFailure): void => {
        earlyFailure ??= failure;
        void child?.cancel("protocolError");
      };
      let outcome: ProcessOutcome | undefined;
      try {
      child = this.supervisor.start({ executable: launch.executable, args, cwd,
        env: launch.env, stdin: prompt, timeoutMs: this.turnDeadlineMs, purpose: "providerTurn",
        ...(request.signal ? { signal: request.signal } : {}),
        maxStdoutBytes: 8 * 1024 * 1024, maxStderrBytes: 2 * 1024 * 1024,
        onJsonl: value => {
          stream.accept(value);
          if (stream.isMalformed) return rejectEarly(new ClaudeFailure({ kind: stream.isExtensionActivity ? "SecurityViolation" : "ProtocolError",
            safeMessage: `Claude emitted malformed stream events (${stream.diagnostic}).`, retryable: false }));
          if (stream.hasInit && !observed) {
            try { observed = { ...stream.assertInit(auth, this.config.model.id, this.config.expectedCanonicalModel),
              pluginIsolation: { preflight: "explicitTemporaryDisable", installedCount: quarantine.counts.installed,
                builtinCount: quarantine.counts.builtin, runtimeLoadedPlugins: 0,
                verificationRounds: quarantine.verificationRounds } };
              effectiveModel = observed.effectiveModel;
              this.lastInit = observed; }
            catch (error) { if (error instanceof ClaudeFailure) rejectEarly(error); else rejectEarly(new ClaudeFailure({
              kind: "ProtocolError", safeMessage: "Claude initialization could not be verified.", retryable: false })); }
          }
          if (stream.authError) rejectEarly(new ClaudeFailure({ kind: "AuthMismatch",
            safeMessage: "Claude runtime rejected authentication.", retryable: false }));
          else if (stream.isOverageActive) rejectEarly(new ClaudeFailure({ kind: "SecurityViolation",
            safeMessage: "Claude reported active overage billing.", retryable: false }));
          else if (stream.rateLimited) rejectEarly(new ClaudeFailure({ kind: "ProcessFailure",
            safeMessage: "Claude subscription or session rate limit was reached.", retryable: true }));
        } });
      outcome = await child.result;
      if (earlyFailure) throw earlyFailure;
      if (outcome.issue?.kind === "Timeout") fail("Timeout", "Claude exceeded its deadline.", true);
      if (outcome.issue?.kind === "Cancelled" || outcome.termination?.reason === "user") fail("Cancelled", "Claude turn was cancelled.");
      if (outcome.issue?.kind === "SpawnFailure") fail("SpawnFailure", "Claude could not start.", true);
      if (outcome.issue?.kind === "OutputLimit") fail("ProtocolError", "Claude output exceeded Fusion's size limit.");
      if (outcome.issue?.kind === "StreamError") fail("ProtocolError", "Claude output streams failed or were held open after exit.");
      if (outcome.issue || outcome.observerIssues.length || stream.isMalformed) fail("ProtocolError", "Claude stream was invalid or truncated.");
      if (outcome.exitCode !== 0 && !stream.hasInit) fail("ProcessFailure", "Claude process failed before initialization.", true);
      if (!observed || !stream.hasResult) fail("ProtocolError", "Claude ended without initialization and result evidence.");
      if (stream.authError) fail("AuthMismatch", "Claude runtime rejected authentication.");
      if (stream.isOverageActive) fail("SecurityViolation", "Claude reported active overage billing.");
      if (stream.rateLimited) fail("ProcessFailure", "Claude subscription or session rate limit was reached.", true);
      if (stream.semanticError) fail("ProcessFailure", "Claude reported a failed turn.");
      if (outcome.exitCode !== 0) fail("ProcessFailure", "Claude exited unsuccessfully.", true);
      const output = request.parse(stream);
      const usage = stream.usage();
      const caps = claudeCapability(observed.runtimeVersion, "runtimeReadback", usage ? true : "unknown");
      const asserted = assertRuntimeEvidence({ provider: "claude", model: this.config.expectedCanonicalModel,
        authLane: launch.lane, posture: "readOnly", permissionProfileId: CLAUDE_READ_ONLY_PROFILE,
        requiredCapabilities: request.requiredCapabilities }, { auth, effectiveProvider: "claude",
        effectiveModel: observed.effectiveModel, permission: { posture: "readOnly", profileId: CLAUDE_READ_ONLY_PROFILE,
          source: "runtimeReadback", mechanicallyEnforced: true }, capabilities: caps });
      if (!asserted.ok) throw new ClaudeFailure(asserted.error);
      this.lastEvidence = observed;
      this.lastSnapshot = caps;
      return { status: "completed" as const, effectiveProvider: "claude", effectiveModel: observed.effectiveModel, output,
        ...(usage ? { usage } : {}), artifactRefs: [] };
      } finally {
        // O5.5B14: why the model process ended, in bounded labels and counts, whatever the turn's outcome.
        this.lastTerminal = claudeTerminalDiagnostic(stream.terminalFacts(), outcome, child !== undefined);
      }
      });
      // Cancellation observed before the result is handed back wins; the finished packet stays inspectable.
      if (request.signal?.aborted) {
        return { status: "cancelled", effectiveProvider: "claude", effectiveModel: completed.effectiveModel,
          output: completed.output, ...(completed.usage ? { usage: completed.usage } : {}),
          error: { kind: "Cancelled", safeMessage: "Claude turn was cancelled before its result was delivered.", retryable: false },
          artifactRefs: [] };
      }
      return completed;
    } catch (error) {
      const e = error instanceof ClaudeFailure ? error.error : internalError("Claude turn could not complete safely.", error);
      return { status: e.kind === "Cancelled" ? "cancelled" : "failed", effectiveProvider: "claude", effectiveModel,
        error: e, artifactRefs: [] };
    }
  }
  capabilities(): CapabilitySnapshot { return this.lastSnapshot ?? claudeCapability(); }
  /**
   * The facts routing may rely on before any session: an observed snapshot once a turn has run, otherwise the
   * launch-time posture, which holds only when the installed runtime is the validated version.
   */
  async launchCapabilities(): Promise<CapabilitySnapshot> {
    return this.lastSnapshot ?? claudeCapability(await claudeInstallVersion(this.config.executablePath), "launchFlag");
  }
}
