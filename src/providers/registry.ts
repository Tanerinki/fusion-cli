import { stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import type { ProviderAdapter, RoleBinding } from "../core/domain.js";
import { FusionFailure } from "../core/errors.js";
import { BillingGuard, type EnvironmentBuildResult } from "../core/policy/billing-guard.js";
import type { BindingConfig, ConfigValue, FusionConfig } from "../app/config.js";
import type { AdapterFactory, BindingInspection, BindingProbe, ProviderRegistry, ProviderRuntimeContext } from "../app/providers.js";
import { resolveVersionedExecutable } from "../platform/process/native-executable.js";
import { claudeEnvironmentRules, museEnvironmentRules, type ClaudeOauthTokenPolicy } from "../runtime/provider-environment-rules.js";
import { ClaudeAdapter } from "./claude/claude-adapter.js";
import { ClaudeOneShotTransport } from "./claude/one-shot-transport.js";
import { capability as claudeCapability, ClaudeFailure, safeEnvironment, type ClaudeLaunchConfig } from "./claude/types.js";
import { MuseAdapter } from "./muse/muse-adapter.js";
import { MuseMspTransport } from "./muse/msp-transport.js";
import { capability as museCapability, MuseFailure, VERIFIED_EXEC_WEB_DISABLE_VERSION, type MuseLaunchConfig } from "./muse/types.js";

/**
 * Concrete adapter factories and default bindings. This is the only place that turns configuration into provider-
 * specific adapters; the control plane and the core see only the neutral `AdapterFactory` contract. Inspection never
 * starts a provider; `probe` may start the provider CLI for auth readback only; `create` refuses the Worker role
 * because real Writer mode is blocked.
 */
const invalid = (message: string): never => { throw new FusionFailure({ kind: "InvalidInput", retryable: false, safeMessage: message }); };
const text = (value: ConfigValue | undefined, name: string, required = false): string | undefined => {
  if (value === undefined) return required ? invalid(`Binding option ${name} is required.`) : undefined;
  return typeof value === "string" && value.length > 0 && value.length <= 1024 ? value : invalid(`Binding option ${name} must be text.`);
};
const positive = (value: ConfigValue | undefined, name: string): number | undefined => value === undefined ? undefined
  : Number.isSafeInteger(value) && (value as number) > 0 ? value as number : invalid(`Binding option ${name} must be a positive integer.`);
function onlyOptions(binding: BindingConfig, allowed: readonly string[]): void {
  for (const key of Object.keys(binding.options))
    if (!allowed.includes(key)) invalid(`Unknown option ${JSON.stringify(key)} for adapter ${binding.adapter}.`);
}
function refuseWriter(binding: BindingConfig): void {
  if (binding.role === "Worker")
    throw new FusionFailure({ kind: "CapabilityUnavailable", retryable: false,
      safeMessage: "REAL_WRITER_MODE_NOT_READY: no real adapter may be bound as an autonomous Writer." });
}
const blockedReasons = (result: EnvironmentBuildResult): string[] => result.ok ? []
  : [...result.decisions.filter(d => d.action === "BLOCK").map(d => `${d.key}: ${d.reason}`),
    ...result.blockers.map(b => `${b.source}: ${b.reason}`)];
async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

// ------------------------------------------------------------------ one-shot read-only CLI provider (Lead)

const CLAUDE_OPTIONS = ["executable", "canonicalModel", "oauthTokenPolicy", "timeoutMs"];
const OAUTH_POLICIES = new Set(["block", "strip", "forwardExplicitSubscriptionToken"]);
function claudeConfig(binding: BindingConfig, context: ProviderRuntimeContext): ClaudeLaunchConfig {
  onlyOptions(binding, CLAUDE_OPTIONS);
  const policy = text(binding.options.oauthTokenPolicy, "oauthTokenPolicy") ?? "block";
  if (!OAUTH_POLICIES.has(policy)) invalid("oauthTokenPolicy must be block, strip or forwardExplicitSubscriptionToken.");
  const executable = text(binding.options.executable, "executable") ?? context.env.FUSION_CLAUDE_EXE ??
    join(context.env.APPDATA ?? "", "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  const timeoutMs = positive(binding.options.timeoutMs, "timeoutMs");
  return { executablePath: executable, workspace: context.workspace,
    model: { id: binding.model, effort: binding.effort, ...(binding.maxTurns === undefined ? {} : { maxTurns: binding.maxTurns }) },
    expectedCanonicalModel: text(binding.options.canonicalModel, "canonicalModel", true)!, posture: "readOnly",
    sourceEnvironment: context.env, oauthTokenPolicy: policy as ClaudeOauthTokenPolicy, ...(timeoutMs ? { timeoutMs } : {}) };
}
const claudeFactory: AdapterFactory = {
  kind: "claude-one-shot",
  async inspect(binding, context): Promise<BindingInspection> {
    const config = claudeConfig(binding, context);
    const executable = isAbsolute(config.executablePath) && basename(config.executablePath).toLowerCase() === "claude.exe" &&
      await isFile(config.executablePath) ? "available" : "unavailable";
    const env = new BillingGuard(claudeEnvironmentRules(config.oauthTokenPolicy)).buildChildEnvironment(context.env);
    const reasons = blockedReasons(env);
    if (reasons.length === 0) {
      try { await safeEnvironment(config); }
      catch (error) { if (error instanceof ClaudeFailure) reasons.push(`settings: ${error.error.kind}`); }
    }
    return { provider: "claude", transport: "claude-one-shot", executable, runtimeVersion: "unknown",
      billing: { state: reasons.length > 0 ? "blocked" : "clear", reasons }, capabilities: claudeCapability(),
      structuredTurns: false,
      controls: [
        { name: "pluginQuarantine", state: "available",
          detail: "Installed plugins are temporarily disabled per turn; zero loaded plugins is verified before the turn runs." },
        { name: "readOnlyToolProfile", state: "available", detail: "Glob/Grep/Read only; permission posture is read back at init." },
        { name: "webToolsDisabled", state: "unknown", detail: "Read back only during a session; unknown until then." },
      ],
      notes: ["Posture (read access, structured output, disabled web tools) is proven only by a session's init readback.",
        "The adapter has no structured review/adjudication turn yet."] };
  },
  async probe(binding, context, signal): Promise<BindingProbe> {
    const transport = new ClaudeOneShotTransport(claudeConfig(binding, context));
    if (signal?.aborted) invalid("The probe was cancelled.");
    try {
      const auth = await transport.authStatus();
      return { auth: { state: auth.state === "authenticated" ? "authenticated" : auth.state, lane: auth.lane, detail: auth.evidence.join(", ") } };
    } catch (error) {
      return { auth: { state: "failed", lane: "unknown", detail: error instanceof ClaudeFailure ? error.error.safeMessage : "auth probe failed" } };
    }
  },
  async create(binding, context) {
    refuseWriter(binding);
    const config = claudeConfig(binding, context);
    const roleBinding: RoleBinding = { role: binding.role, provider: "claude", transport: "claude-one-shot", model: config.model, requires: {} };
    return { binding: roleBinding, adapter: new ClaudeAdapter(roleBinding, config) as ProviderAdapter };
  },
};

// ------------------------------------------------------------------ Exec / MSP read-only CLI provider

const MUSE_OPTIONS = ["provider", "binaryDirectory", "versionFile", "timeoutMs", "maxModelSteps"];
function museConfig(binding: BindingConfig, context: ProviderRuntimeContext): MuseLaunchConfig {
  onlyOptions(binding, MUSE_OPTIONS);
  const directory = text(binding.options.binaryDirectory, "binaryDirectory") ?? context.env.FUSION_MUSE_BIN_DIR ??
    join(context.env.LOCALAPPDATA ?? "", "Programs", "muse");
  const timeoutMs = positive(binding.options.timeoutMs, "timeoutMs"), maxModelSteps = positive(binding.options.maxModelSteps, "maxModelSteps");
  return { binaryDirectory: directory, versionFile: text(binding.options.versionFile, "versionFile") ?? join(directory, ".muse-version"),
    workspace: context.workspace, provider: text(binding.options.provider, "provider", true)!,
    model: { id: binding.model, effort: binding.effort, ...(binding.maxTurns === undefined ? {} : { maxTurns: binding.maxTurns }) },
    posture: "readOnly", sourceEnvironment: context.env, ...(timeoutMs ? { timeoutMs } : {}), ...(maxModelSteps ? { maxModelSteps } : {}) };
}
function museFactory(transport: "muse-exec" | "muse-msp"): AdapterFactory {
  return {
    kind: transport,
    async inspect(binding, context): Promise<BindingInspection> {
      const config = museConfig(binding, context);
      let version = "unknown", executable: BindingInspection["executable"] = "unavailable";
      try {
        const path = await resolveVersionedExecutable({ directory: config.binaryDirectory, versionFile: config.versionFile, prefix: "muse-bin-" });
        executable = "available";
        version = basename(path).match(/^muse-bin-(.+)\.exe$/iu)?.[1] ?? "unknown";
      } catch { executable = "unavailable"; }
      const reasons = blockedReasons(new BillingGuard(museEnvironmentRules()).buildChildEnvironment(context.env));
      const verified = version === VERIFIED_EXEC_WEB_DISABLE_VERSION;
      return { provider: config.provider, transport, executable, runtimeVersion: version,
        billing: { state: reasons.length > 0 ? "blocked" : "clear", reasons },
        // Exec posture is fixed by launch flags and known statically; MSP capabilities need the host started.
        ...(transport === "muse-exec" && executable === "available" ? { capabilities: museCapability(config, "muse-exec", version) } : {}),
        structuredTurns: false,
        controls: transport === "muse-exec"
          ? [{ name: "launchReadOnlyFlags", state: verified ? "available" : "unknown",
              detail: verified ? "Write, shell and web tools are disabled by launch flags on this verified release."
                : "Web-tool disabling is verified only on a specific release; this version is unverified." }]
          : [{ name: "hostReadOnlyFlags", state: "unknown", detail: "Write and shell are disabled; web tools cannot be disabled on this host." }],
        notes: transport === "muse-msp" ? ["Capabilities are known only after the host starts (fusion doctor --probe)."] : [] };
    },
    async probe(binding, context, signal): Promise<BindingProbe> {
      const msp = new MuseMspTransport(museConfig(binding, context));
      try {
        if (signal?.aborted) invalid("The probe was cancelled.");
        const auth = await msp.authStatus();
        const capabilities = transport === "muse-msp" ? await msp.capabilities() : undefined;
        return { auth: { state: auth.state === "authenticated" ? "authenticated" : auth.state, lane: auth.lane, detail: auth.evidence.join(", ") },
          ...(capabilities ? { capabilities } : {}) };
      } catch (error) {
        return { auth: { state: "failed", lane: "unknown", detail: error instanceof MuseFailure ? error.error.safeMessage : "auth probe failed" } };
      } finally { await msp.close().catch(() => undefined); }
    },
    async create(binding, context) {
      refuseWriter(binding);
      const config = museConfig(binding, context);
      const roleBinding: RoleBinding = { role: binding.role, provider: config.provider, transport, model: config.model, requires: {} };
      return { binding: roleBinding, adapter: new MuseAdapter(roleBinding, config) as ProviderAdapter };
    },
  };
}

/** Default role bindings when a repository has no fusion.config.json (docs/v0.1-build-spec.md §1). */
export const DEFAULT_CONFIG: FusionConfig = Object.freeze({
  schemaVersion: 1,
  bindings: Object.freeze([
    Object.freeze({ role: "Lead" as const, adapter: "claude-one-shot", model: "opus", effort: "high", maxTurns: 8,
      options: Object.freeze({ canonicalModel: "claude-opus-5-5" }) }),
    Object.freeze({ role: "Explorer" as const, adapter: "muse-exec", model: "muse-spark-1.3", effort: "low", maxTurns: 4,
      options: Object.freeze({ provider: "meta" }) }),
    Object.freeze({ role: "Reviewer" as const, adapter: "muse-exec", model: "muse-spark-1.3", effort: "low", maxTurns: 4,
      options: Object.freeze({ provider: "meta" }) }),
  ]),
  verification: Object.freeze({ commands: Object.freeze([]) }),
  limits: Object.freeze({ runTimeoutMs: 30 * 60 * 1000 }),
});

export function defaultRegistry(): ProviderRegistry {
  return { factories: new Map([["claude-one-shot", claudeFactory], ["muse-exec", museFactory("muse-exec")],
    ["muse-msp", museFactory("muse-msp")]]), defaults: DEFAULT_CONFIG };
}
