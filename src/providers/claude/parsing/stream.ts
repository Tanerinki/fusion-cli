import type { AuthStatus, ProviderUsage, ResultPacket } from "../../../core/domain.js";
import { describeStructuredField, readStructuredEnvelope, type EnvelopeOptions,
  type StructuredOutputDiagnostic } from "../../../platform/process/structured-envelope.js";
import { CLAUDE_SAFE_TOOLS, CLAUDE_VALIDATED_EXTENSION_VERSION, describeLoadedPlugins, fail, record, string,
  type ClaudeRuntimeEvidence } from "../types.js";

const exactStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(x => typeof x === "string");
const empty = (value: unknown): boolean => Array.isArray(value) && value.length === 0;
const finiteNonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const RAW_ONLY: EnvelopeOptions = Object.freeze({ policy: "rawOnly" });

/** Keeps only bounded, non-PII runtime facts. Raw frames never leave this parser. */
export class ClaudeStream {
  private init?: Record<string, unknown>;
  private result?: Record<string, unknown>;
  private output?: StructuredOutputDiagnostic;
  private malformed = false;
  private firstMalformedReason?: string;
  private retryStatus?: number;
  private sawAssistant = false;
  private preinitSystemEvents = 0;
  private hookActivity = false;
  private limitRejected = false;
  private overageActive = false;
  private reject(reason: string): void { this.malformed = true; this.firstMalformedReason ??= reason; }
  accept(value: unknown): void {
    const frame = record(value), type = string(frame?.type);
    if (!frame || !type) { this.reject("invalid-envelope"); return; }
    if (type === "system" && ["hook_started", "hook_progress", "hook_response", "plugin_install",
      "local_command_output", "task_started", "task_progress", "task_notification"].includes(string(frame.subtype) ?? "")) {
      this.hookActivity = true;
      this.reject("extension-activity"); return;
    }
    if (!this.init && !(type === "system" && frame.subtype === "init")) {
      if (type === "system" && string(frame.subtype) && this.preinitSystemEvents++ < 8) {
        if (frame.subtype === "api_retry" && typeof frame.error_status === "number")
          this.retryStatus = frame.error_status;
        return;
      }
      this.reject("init-not-first"); return;
    }
    if (type === "system" && frame.subtype === "init") {
      if (this.init || this.result || this.sawAssistant) this.reject("duplicate-or-late-init");
      else this.init = frame;
    } else if (type === "system" && frame.subtype === "api_retry") {
      if (typeof frame.error_status === "number") this.retryStatus = frame.error_status;
    } else if (type === "rate_limit_event") {
      const info = record(frame.rate_limit_info);
      if (!info || !["allowed", "allowed_warning", "rejected"].includes(string(info.status) ?? "") ||
          typeof info.isUsingOverage !== "boolean") this.reject("rate-limit-event-shape");
      else {
        if (info.status === "rejected") this.limitRejected = true;
        if (info.isUsingOverage) this.overageActive = true;
      }
    } else if (type === "assistant") {
      if (!this.init || this.result) this.reject("assistant-order");
      this.sawAssistant = true;
      const message = record(frame.message);
      if (message?.model !== undefined && message.model !== this.init?.model) this.reject("assistant-model-mismatch");
    } else if (type === "result") {
      if (!this.init || this.result) this.reject("result-order");
      else this.result = frame;
    } else if (type !== "user" && type !== "system")
      this.reject(/^[a-z_]{1,40}$/u.test(type) ? `unknown-event-type:${type}` : "unknown-event-type");
    if (this.result && type !== "result") this.reject("event-after-result");
  }
  get isMalformed(): boolean { return this.malformed; }
  get diagnostic(): string { return this.firstMalformedReason ?? "none"; }
  get isExtensionActivity(): boolean { return this.hookActivity; }
  get isOverageActive(): boolean { return this.overageActive; }
  get hasInit(): boolean { return !!this.init; }
  get hasResult(): boolean { return !!this.result; }
  get rateLimited(): boolean { return this.limitRejected || this.retryStatus === 429 || this.result?.api_error_status === 429; }
  get authError(): boolean { return this.retryStatus === 401 || this.result?.api_error_status === 401; }
  get semanticError(): boolean { return this.result?.is_error === true || this.result?.terminal_reason !== "completed" ||
    this.result?.subtype !== "success"; }
  assertInit(auth: AuthStatus, requestedModel: string, expectedModel: string): ClaudeRuntimeEvidence {
    if (this.malformed || !this.init) fail("ProtocolError", "Claude initialization was missing or malformed.");
    const init = this.init;
    const tools = init.tools, mcp = init.mcp_servers;
    const names = exactStrings(tools) ? [...tools].sort() : null;
    const postureProblems: string[] = [];
    if (init.permissionMode !== "dontAsk") postureProblems.push("permission-mode");
    if (!names || JSON.stringify(names) !== JSON.stringify(CLAUDE_SAFE_TOOLS))
      postureProblems.push(`tool-set:${Array.isArray(tools) ? tools.length : "missing"}`);
    if (!empty(mcp)) postureProblems.push(`mcp:${Array.isArray(mcp) ? mcp.length : "missing"}`);
    // SDK system/init reports successfully loaded plugins. An inventory count cannot prove them inert.
    if (!empty(init.plugins)) postureProblems.push(Array.isArray(init.plugins) ?
      `loaded-plugins:${init.plugins.length}[${describeLoadedPlugins(init.plugins)}]` : "loaded-plugins:missing");
    for (const [field, value] of [["hooks", init.hooks], ["connectors", init.connectors]] as const)
      if (value !== undefined && !empty(value)) postureProblems.push(`${field}:active-or-unknown`);
    if (postureProblems.length)
      fail("SecurityViolation", `Claude read-only posture was not confirmed (${postureProblems.join(",")}).`);
    if (!exactStrings(init.agents) || !exactStrings(init.skills) || !exactStrings(init.slash_commands))
      fail("ProtocolError", "Claude extension inventory shape was not confirmed.");
    const version = string(init.claude_code_version);
    if (!version) fail("ProtocolError", "Claude did not report its runtime version.");
    if (version !== CLAUDE_VALIDATED_EXTENSION_VERSION)
      fail("CapabilityUnavailable", "Claude extension isolation is unvalidated for this runtime version.");
    if (init.apiKeySource !== "none") fail("AuthMismatch", "Claude selected a non-subscription credential source.");
    const model = string(init.model);
    if (model !== expectedModel) fail("ProviderIdentityMismatch", "Claude effective model differs from the configured canonical model.");
    return { auth, apiKeySource: "none", requestedModel, effectiveModel: model, permissionMode: "dontAsk",
      tools: names ?? [], mcpServers: [], runtimeVersion: version,
      extensionInventory: { agents: init.agents.length, skills: init.skills.length,
        slashCommands: init.slash_commands.length, plugins: 0 },
      extensionIsolation: { state: "disabled", managedHooks: "unverified", versionVerified: true,
        evidence: ["claude-2.1.280", "safe-mode-flag", "restricted-flag", "disable-slash-commands-flag", "exact-tool-readback",
          "empty-mcp-readback", "empty-loaded-plugins", "hook-events-monitored"] } };
  }
  usage(): ProviderUsage | undefined {
    const result = this.result;
    if (!result) return undefined;
    const raw = record(result.usage), usage: { inputTokens?: number; outputTokens?: number; estimatedListCostUsd?: number } = {};
    if (finiteNonnegative(raw?.input_tokens)) usage.inputTokens = raw.input_tokens;
    if (finiteNonnegative(raw?.output_tokens)) usage.outputTokens = raw.output_tokens;
    if (finiteNonnegative(result.total_cost_usd)) usage.estimatedListCostUsd = result.total_cost_usd;
    return Object.keys(usage).length ? usage : undefined;
  }
  /**
   * The structure-only diagnostic of the successful result read by `json` (classes, flags and counts; never content),
   * kept whether or not the result was accepted.
   */
  get outputDiagnostic(): StructuredOutputDiagnostic | undefined { return this.output; }
  /**
   * The successful result as one strict JSON value, read under an envelope policy (platform/process/structured-envelope):
   * `rawOnly` (the default) requires the whole result text to be one JSON value; `rawOrSingleJsonFence` also admits
   * exactly one outer json/bare Markdown fence with only whitespace outside it and a schema-conforming object body.
   * Prose, trailing text, several fences or values, or a duplicate key are malformed, never repaired or extracted.
   */
  json(envelope: EnvelopeOptions = RAW_ONLY): unknown {
    if (this.malformed || !this.result) fail("ProtocolError", "Claude stream ended without one valid result.");
    if (this.result.is_error !== false || this.result.terminal_reason !== "completed" || this.result.subtype !== "success")
      fail("ProcessFailure", "Claude did not complete successfully.", this.rateLimited);
    const field: unknown = this.result.structured_output;
    if (field !== undefined) {
      this.output = describeStructuredField(field, envelope);
      return field;
    }
    if (typeof this.result.result !== "string") fail("MalformedOutput", "Claude result text is not a string.");
    const reading = readStructuredEnvelope(this.result.result, envelope);
    this.output = reading.diagnostic;
    if (!reading.accepted)
      fail("MalformedOutput", `Claude structured output was refused: ${reading.diagnostic.classification} under the ${envelope.policy} envelope.`);
    return reading.value;
  }
  packet(): ResultPacket {
    const parsed = this.json();
    const r = record(parsed), status = record(r?.result), changes = record(r?.changes), verification = record(r?.verification);
    if (!r || !status || !exactKeys(r, ["result", "changes", "verification", "uncertainties", "failures", "needsLeadDecision"]) ||
        !exactKeys(status, ["status"]) || typeof status.status !== "string" ||
        !["completed", "partial", "blocked", "failed"].includes(status.status) ||
        !changes || !verification || !exactKeys(changes, ["files", "summary"]) ||
        !exactKeys(verification, ["testsRun", "results"]) ||
        !exactStrings(changes.files) || typeof changes.summary !== "string" ||
        !exactStrings(verification.testsRun) || !exactStrings(verification.results) ||
        !exactStrings(r.uncertainties) || !exactStrings(r.failures) || !exactStrings(r.needsLeadDecision))
      fail("MalformedOutput", "Claude returned an invalid ResultPacket.");
    return parsed as ResultPacket;
  }
}
