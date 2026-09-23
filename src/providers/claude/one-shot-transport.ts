import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type { AuthStatus, CapabilityRequirement, CapabilitySnapshot, DelegationPacket, TurnResult } from "../../core/domain.js";
import { internalError } from "../../core/errors.js";
import { assertRuntimeEvidence } from "../../core/policy/billing-guard.js";
import { assertNativeExecutablePath } from "../../platform/process/native-executable.js";
import { parseStrictJson } from "../../platform/process/strict-json.js";
import { ProcessSupervisor, type RunningProcess } from "../../platform/process/supervisor.js";
import { ClaudeStream } from "./parsing/stream.js";
import { CLAUDE_PREFLIGHT_TIMEOUTS, claudeReadOnlyArgs, convergePluginQuarantine, failOnLifecycleIssue,
  preflightPlugins, withTemporaryPluginSettings } from "./plugin-quarantine.js";
import { CLAUDE_READ_ONLY_PROFILE, ClaudeFailure, capability, fail, record, safeEnvironment, string,
  type ClaudeFixtureBinary, type ClaudeLaunchConfig, type ClaudeRuntimeEvidence } from "./types.js";

/** Default deadline for one guarded Claude turn; preflight steps never exceed it. */
export const CLAUDE_TURN_TIMEOUT_MS = 120_000;

export interface ClaudeRunRequest {
  readonly packet: DelegationPacket;
  readonly requiredCapabilities: CapabilityRequirement;
  readonly signal?: AbortSignal;
}
type Prepared = Readonly<{ executable: string; argvPrefix: readonly string[]; env: NodeJS.ProcessEnv; lane: "subscription" | "subscriptionToken" }>;

/** Guarded one-shot path. The fixture override is not exposed by ClaudeAdapter. */
export class ClaudeOneShotTransport {
  private lastEvidence?: ClaudeRuntimeEvidence;
  private lastSnapshot?: CapabilitySnapshot;
  constructor(readonly config: ClaudeLaunchConfig, private readonly supervisor = new ProcessSupervisor(),
    private readonly fixtureBinary?: ClaudeFixtureBinary) {}
  get runtimeEvidence(): ClaudeRuntimeEvidence | undefined { return this.lastEvidence; }
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
    return { executable, argvPrefix: this.fixtureBinary?.argvPrefix ?? [], env: safe.forSpawn(), lane: safe.authLaneIntent };
  }
  private get turnDeadlineMs(): number { return this.config.timeoutMs ?? CLAUDE_TURN_TIMEOUT_MS; }
  private async readAuth(launch: Prepared, signal?: AbortSignal): Promise<AuthStatus> {
    const child = this.supervisor.start({ executable: launch.executable,
      args: [...launch.argvPrefix, "auth", "status"], cwd: this.config.workspace, env: launch.env,
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
  async authStatus(): Promise<AuthStatus> { return this.readAuth(await this.prepare()); }
  /** Static impossibilities are rejected before launch; init-dependent requirements are checked at runtime. */
  assertStaticRequirements(required: CapabilityRequirement): void {
    const known = capability();
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
    let effectiveModel = "";
    try {
      if (request.signal?.aborted) fail("Cancelled", "Claude turn was cancelled before launch.");
      this.assertStaticRequirements(request.requiredCapabilities);
      const launch = await this.prepare();
      if (request.signal?.aborted) fail("Cancelled", "Claude turn was cancelled before launch.");
      const auth = await this.readAuth(launch, request.signal);
      if (request.signal?.aborted) fail("Cancelled", "Claude turn was cancelled before launch.");
      const plugins = await preflightPlugins({ executable: launch.executable, argvPrefix: launch.argvPrefix,
        cwd: this.config.workspace, env: launch.env }, this.supervisor, this.config.model.id,
        this.config.model.effort, request.signal, this.turnDeadlineMs);
      if (request.signal?.aborted) fail("Cancelled", "Claude turn was cancelled before launch.");
      const completed = await withTemporaryPluginSettings(plugins.ids, async (settingsPath, rewriteSettings) => {
      // Prove the child-only settings on the startup right before the reviewer; plugins can appear between startups.
      const quarantine = await convergePluginQuarantine({ executable: launch.executable, argvPrefix: launch.argvPrefix,
        cwd: this.config.workspace, env: launch.env }, this.supervisor, this.config.model.id, this.config.model.effort,
        plugins, settingsPath, rewriteSettings, request.signal, this.turnDeadlineMs);
      if (request.signal?.aborted) fail("Cancelled", "Claude turn was cancelled before launch.");
      const stream = new ClaudeStream();
      let earlyFailure: ClaudeFailure | undefined;
      let observed: ClaudeRuntimeEvidence | undefined;
      let child: RunningProcess | undefined;
      const args = [...launch.argvPrefix, ...claudeReadOnlyArgs(this.config.model.id, this.config.model.effort,
        this.config.model.maxTurns ?? 1), "--settings", settingsPath];
      const prompt = `Complete this delegated task within its scope. Your entire response must be one raw JSON object, with no Markdown fence, commentary, or text before or after it. Use exactly this shape: {"result":{"status":"completed"},"changes":{"files":[],"summary":""},"verification":{"testsRun":[],"results":[]},"uncertainties":[],"failures":[],"needsLeadDecision":[]}. Change field values to report the actual outcome; model-reported checks are claims only.\nDelegation:\n${JSON.stringify(request.packet)}`;
      const rejectEarly = (failure: ClaudeFailure): void => {
        earlyFailure ??= failure;
        void child?.cancel("protocolError");
      };
      child = this.supervisor.start({ executable: launch.executable, args, cwd: this.config.workspace,
        env: launch.env, stdin: prompt, timeoutMs: this.turnDeadlineMs,
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
              effectiveModel = observed.effectiveModel; }
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
      const outcome = await child.result;
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
      const output = stream.packet();
      const usage = stream.usage();
      const caps = { ...capability(observed.runtimeVersion, true), usageReporting: usage ? true as const : "unknown" as const };
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
  capabilities(): CapabilitySnapshot { return this.lastSnapshot ?? capability(); }
}
