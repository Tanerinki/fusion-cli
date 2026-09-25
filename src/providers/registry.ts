import { stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import type { ProviderAdapter, RoleBinding } from "../core/domain.js";
import { FusionFailure } from "../core/errors.js";
import { BillingGuard, type EnvironmentBuildResult } from "../core/policy/billing-guard.js";
import type { BindingConfig, ConfigValue, FusionConfig } from "../app/config.js";
import type { AdapterFactory, BindingInspection, BindingProbe, ProviderRegistry, ProviderRuntimeContext } from "../app/providers.js";
import { REAL_WRITER_MODE_NOT_READY } from "../app/writer-gate.js";
import { resolveVersionedExecutable } from "../platform/process/native-executable.js";
import { claudeEnvironmentRules, DEFAULT_CLAUDE_OAUTH_TOKEN_POLICY, museEnvironmentRules,
  type ClaudeOauthTokenPolicy } from "../runtime/provider-environment-rules.js";
import { changeProposalLiveEvidence, providerWorkspaceStatePaths, transportProfile, type BindingValidation } from "../runtime/provider-profiles.js";
import { ClaudeAdapter } from "./claude/claude-adapter.js";
import { ClaudeOneShotTransport } from "./claude/one-shot-transport.js";
import { claudeCapability } from "./claude/posture.js";
import { CLAUDE_VALIDATED_EXTENSION_VERSION, ClaudeFailure, claudeInstallVersion, safeEnvironment,
  type ClaudeLaunchConfig } from "./claude/types.js";
import { validatedBindingIdentity } from "./muse/identity.js";
import { MuseAdapter } from "./muse/muse-adapter.js";
import { MuseMspTransport } from "./muse/msp-transport.js";
import { capability as museCapability, MuseFailure, VERIFIED_EXEC_WEB_DISABLE_VERSION, type MuseLaunchConfig } from "./muse/types.js";

/**
 * Concrete adapter factories and default bindings. This is the only place that turns configuration into provider-
 * specific adapters; the control plane and the core see only the neutral `AdapterFactory` contract. Inspection never
 * starts a provider; `probe` may start the provider CLI for auth readback only; `create` refuses the Worker role;
 * `createChangeAuthor` builds a Worker only as a read-only Change Author whose sessions run only in Fusion-owned
 * views (the live Writer gate still refuses every actual Writer run).
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
      safeMessage: `${REAL_WRITER_MODE_NOT_READY}: no real adapter may be bound as an autonomous Writer.` });
}
function requireWorker(binding: BindingConfig): void {
  if (binding.role !== "Worker") invalid("Only a Worker binding can be built as a Change Author.");
}
const blockedReasons = (result: EnvironmentBuildResult): string[] => result.ok ? []
  : [...result.decisions.filter(d => d.action === "BLOCK").map(d => `${d.key}: ${d.reason}`),
    ...result.blockers.map(b => `${b.source}: ${b.reason}`)];
async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

// ------------------------------------------------------------------ one-shot read-only CLI provider (Lead)

const CLAUDE_OPTIONS = ["executable", "canonicalModel", "oauthTokenPolicy", "timeoutMs"];
const OAUTH_POLICIES = new Set(["subscriptionOAuth", "strip", "block", "forwardExplicitSubscriptionToken"]);
function claudeConfig(binding: BindingConfig, context: ProviderRuntimeContext): ClaudeLaunchConfig {
  onlyOptions(binding, CLAUDE_OPTIONS);
  const policy = text(binding.options.oauthTokenPolicy, "oauthTokenPolicy") ?? DEFAULT_CLAUDE_OAUTH_TOKEN_POLICY;
  if (!OAUTH_POLICIES.has(policy)) invalid("oauthTokenPolicy must be subscriptionOAuth, strip or block.");
  const executable = text(binding.options.executable, "executable") ?? context.env.FUSION_CLAUDE_EXE ??
    join(context.env.APPDATA ?? "", "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  const timeoutMs = positive(binding.options.timeoutMs, "timeoutMs");
  return { executablePath: executable, workspace: context.workspace, forbiddenWorkspaceRoots: [context.workspace],
    ...(context.sessionWorkspaces === "required" ? { requireSessionWorkspace: true } : {}),
    model: { id: binding.model, effort: binding.effort, ...(binding.maxTurns === undefined ? {} : { maxTurns: binding.maxTurns }) },
    expectedCanonicalModel: text(binding.options.canonicalModel, "canonicalModel", true)!, posture: "readOnly",
    sourceEnvironment: context.env, oauthTokenPolicy: policy as ClaudeOauthTokenPolicy, ...(timeoutMs ? { timeoutMs } : {}),
    ...(context.launchObserver ? { launchObserver: context.launchObserver } : {}) };
}
const claudeFactory: AdapterFactory = {
  kind: "claude-one-shot",
  async inspect(binding, context): Promise<BindingInspection> {
    const config = claudeConfig(binding, context);
    const executable = isAbsolute(config.executablePath) && basename(config.executablePath).toLowerCase() === "claude.exe" &&
      await isFile(config.executablePath) ? "available" : "unavailable";
    const env = new BillingGuard(claudeEnvironmentRules(config.oauthTokenPolicy)).buildChildEnvironment(context.env);
    const reasons = blockedReasons(env);
    const candidateLane = env.ok ? env.child.authLaneIntent : undefined;
    if (reasons.length === 0) {
      try { await safeEnvironment(config); }
      catch (error) { if (error instanceof ClaudeFailure) reasons.push(`settings: ${error.error.kind}`); }
    }
    const version = executable === "available" ? await claudeInstallVersion(config.executablePath) : "unknown";
    const facts = claudeCapability(version, "launchFlag");
    const state = (value: unknown): BindingInspection["controls"][number]["state"] => value === "unknown" ? "unknown" : "available";
    const live = changeProposalLiveEvidence("claude", "claude-one-shot", version, { model: binding.model, effort: binding.effort });
    return { provider: "claude", transport: "claude-one-shot", executable, runtimeVersion: version, ...(live ? { liveChangeProposal: live } : {}),
      billing: { state: reasons.length > 0 ? "blocked" : "clear", reasons,
        ...(reasons.length === 0 && candidateLane ? { candidateLane } : {}) }, capabilities: facts,
      structuredTurns: true,
      controls: [
        { name: "readOnlyToolProfile", state: state(facts.filesystem.write),
          detail: "Launch allowlist Read, Grep, Glob with --restricted: no write, shell or web tool; the tool set is read back at init." },
        { name: "approvalEscalation", state: state(facts.approvalEscalationDisabled),
          detail: "--permission-mode dontAsk with --permission-prompts none; the permission mode is read back at init." },
        { name: "personalContext", state: state(facts.personalContextDisabled),
          detail: "--safe-mode (no CLAUDE.md), --restricted (no user, project or local settings), auto memory off for the child only." },
        { name: "pluginQuarantine", state: "available",
          detail: "Plugins are disabled per turn with child-only settings; zero loaded plugins is verified before the turn runs." },
        { name: "extensionIsolation", state: state(facts.extensionsQuarantined),
          detail: "--safe-mode, --strict-mcp-config and --disable-slash-commands; any hook activity fails the turn." },
        { name: "subscriptionLane", state: state(facts.subscriptionLaneReadback),
          detail: "Auth status and the init credential source are read back before every turn; an API-key source fails closed." },
      ],
      notes: [version === CLAUDE_VALIDATED_EXTENSION_VERSION
        ? "Launch-time posture holds for the validated runtime; every turn re-verifies it at init and fails closed."
        : version === "unknown" ? "The installed version could not be read statically, so the launch-time posture is unknown."
          : "The installed version is not the validated one, so the launch-time posture is unknown."] };
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
  /** The same read-only launch posture, bound to the Worker role; its sessions only ever run in a Fusion view. */
  async createChangeAuthor(binding, context) {
    requireWorker(binding);
    const config: ClaudeLaunchConfig = { ...claudeConfig(binding, context), requireSessionWorkspace: true };
    const roleBinding: RoleBinding = { role: "Worker", provider: "claude", transport: "claude-one-shot", model: config.model, requires: {} };
    return { binding: roleBinding, adapter: new ClaudeAdapter(roleBinding, config) as ProviderAdapter };
  },
};

// ------------------------------------------------------------------ Exec / MSP read-only CLI provider

const MUSE_OPTIONS = ["provider", "binaryDirectory", "versionFile", "timeoutMs", "maxModelSteps", "malformedOutputRetries"];
/**
 * O5.5B23: the Exec release an authorized validation probe's runtime context puts under validation, if any. Only the
 * context carries it (never a binding option), and only the Exec transport supports it.
 */
export function museVersionUnderValidation(context: ProviderRuntimeContext, adapter: string): string | undefined {
  const target = context.runtimeUnderValidation;
  return adapter === "muse-exec" && target !== undefined && target.transport === adapter ? target.version : undefined;
}
/**
 * O5.5B24: the recorded binding-scoped validations that cover exactly this binding (role, model, effort and each listed
 * option), with the one binary each was validated on. Any other binding gets none.
 */
export function museValidatedBindings(binding: BindingConfig, validations: readonly BindingValidation[]): readonly Readonly<{ release: string; executableSha256: string }>[] {
  return Object.freeze(validations.filter(entry => entry.role === binding.role && entry.model === binding.model && entry.effort === binding.effort &&
    Object.entries(entry.options).every(([key, value]) => binding.options[key] === value))
    .map(entry => Object.freeze({ release: entry.release, executableSha256: entry.executableSha256 })));
}
function museConfigOf(binding: BindingConfig, context: ProviderRuntimeContext, validations: readonly BindingValidation[] = []): MuseLaunchConfig {
  onlyOptions(binding, MUSE_OPTIONS);
  const directory = text(binding.options.binaryDirectory, "binaryDirectory") ?? context.env.FUSION_MUSE_BIN_DIR ??
    join(context.env.LOCALAPPDATA ?? "", "Programs", "muse");
  const timeoutMs = positive(binding.options.timeoutMs, "timeoutMs"), maxModelSteps = positive(binding.options.maxModelSteps, "maxModelSteps");
  const retries = binding.options.malformedOutputRetries;
  if (retries !== undefined && retries !== 0 && retries !== 1) invalid("Binding option malformedOutputRetries must be 0 or 1.");
  const underValidation = museVersionUnderValidation(context, binding.adapter);
  const validated = binding.adapter === "muse-exec" ? museValidatedBindings(binding, validations) : [];
  return { binaryDirectory: directory, versionFile: text(binding.options.versionFile, "versionFile") ?? join(directory, ".muse-version"),
    ...(underValidation === undefined ? {} : { versionUnderValidation: underValidation }),
    ...(validated.length === 0 ? {} : { validatedBindings: validated }),
    workspace: context.workspace, forbiddenWorkspaceRoots: [context.workspace],
    ...(context.sessionWorkspaces === "required" ? { requireSessionWorkspace: true } : {}),
    provider: text(binding.options.provider, "provider", true)!,
    model: { id: binding.model, effort: binding.effort, ...(binding.maxTurns === undefined ? {} : { maxTurns: binding.maxTurns }) },
    posture: "readOnly", sourceEnvironment: context.env, ...(timeoutMs ? { timeoutMs } : {}), ...(maxModelSteps ? { maxModelSteps } : {}),
    ...(retries === undefined ? {} : { malformedOutputRetries: retries as 0 | 1 }),
    ...(context.launchObserver ? { launchObserver: context.launchObserver } : {}) };
}
function museFactory(transport: "muse-exec" | "muse-msp",
  validations: readonly BindingValidation[] = transportProfile("muse", transport)?.bindingValidations ?? []): AdapterFactory {
  const museConfig = (binding: BindingConfig, context: ProviderRuntimeContext): MuseLaunchConfig => museConfigOf(binding, context, validations);
  return {
    kind: transport,
    async inspect(binding, context): Promise<BindingInspection> {
      const config = museConfig(binding, context);
      let version = "unknown", executable: BindingInspection["executable"] = "unavailable", executablePath: string | undefined;
      try {
        const path = await resolveVersionedExecutable({ directory: config.binaryDirectory, versionFile: config.versionFile, prefix: "muse-bin-" });
        executable = "available";
        executablePath = path;
        version = basename(path).match(/^muse-bin-(.+)\.exe$/iu)?.[1] ?? "unknown";
      } catch { executable = "unavailable"; }
      const guarded = new BillingGuard(museEnvironmentRules()).buildChildEnvironment(context.env);
      const reasons = blockedReasons(guarded);
      const verified = version === VERIFIED_EXEC_WEB_DISABLE_VERSION;
      // O5.5B24: a release validated for exactly this binding, on its exact binary (its bytes are read, never launched).
      const identity = transport === "muse-exec" && executablePath !== undefined && !verified
        ? await validatedBindingIdentity(config, executablePath, version) : false;
      const bindingValidated = !verified && identity;
      // O5.5B23: a release a validation probe runs under validation: the same launch controls, claimed but unverified.
      const underValidation = !verified && !bindingValidated && transport === "muse-exec" && config.versionUnderValidation === version;
      // Exec posture is fixed by launch controls and known statically; MSP capabilities need the host started.
      const facts = transport === "muse-exec" && executable === "available" ? museCapability(config, "muse-exec", version, undefined, false, identity) : undefined;
      const state = (value: unknown): BindingInspection["controls"][number]["state"] => value === true || value === false ? "available" : "unknown";
      const live = changeProposalLiveEvidence("muse", transport, version, { model: binding.model, effort: binding.effort });
      return { provider: config.provider, transport, executable, runtimeVersion: version, ...(executablePath ? { executablePath } : {}),
        ...(live ? { liveChangeProposal: live } : {}),
        billing: { state: reasons.length > 0 ? "blocked" : "clear", reasons,
          ...(guarded.ok ? { candidateLane: guarded.child.authLaneIntent } : {}) },
        ...(facts ? { capabilities: facts } : {}),
        structuredTurns: transport === "muse-exec",
        controls: transport === "muse-exec"
          ? [{ name: "launchReadOnlyFlags", state: verified || bindingValidated || underValidation ? "available" : "unknown",
              detail: verified ? "--disable-write, --disable-shell and --disable-web-tools on this verified release."
                : bindingValidated ? "--disable-write, --disable-shell and --disable-web-tools: validated on this release for exactly this binding and binary."
                : underValidation ? "--disable-write, --disable-shell and --disable-web-tools: the verified release's controls, claimed UNDER VALIDATION on this release."
                : "Web-tool disabling is verified only on a specific release; this version is unverified." },
            { name: "approvalEscalation", state: state(facts?.approvalEscalationDisabled),
              detail: "--approval-judge off with --approval-mode never: no model-judged or prompted approval." },
            { name: "personalContext", state: state(facts?.personalContextDisabled), detail: "--no-foreign-personal-context." },
            { name: "extensionIsolation", state: state(facts?.extensionsQuarantined),
              detail: "Exec takes no MCP configuration; session-MCP, managed-hook and web-tool switches are stripped from the child environment." },
            { name: "subscriptionLane", state: state(facts?.subscriptionLaneReadback),
              detail: "The account login is attested before and after every Exec turn; an API-key login fails closed." }]
          : [{ name: "hostReadOnlyFlags", state: "unknown", detail: "Write and shell are disabled; web tools cannot be disabled on this host." }],
        notes: transport === "muse-msp" ? ["Capabilities are known only after the host starts (fusion doctor --probe).",
          "The MSP transport has no structured review/adjudication channel."]
          : verified ? [] : bindingValidated ? ["This release is validated only for exactly this binding on exactly this binary; " +
            "any other role, model, effort, step budget, retry policy or binary stays unverified."] : underValidation ? ["This release runs UNDER VALIDATION for an authorized probe: posture facts beyond write and " +
            "shell are claimed from the verified release's controls, pending live evidence; the release is not validated."]
          : ["Posture facts beyond write and shell hold only on the verified release."] };
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
    // Only Exec has the structured change-proposal turn and per-session workspaces; MSP never serves as a Change Author.
    ...(transport === "muse-exec" ? { async createChangeAuthor(binding: BindingConfig, context: ProviderRuntimeContext) {
      requireWorker(binding);
      const config: MuseLaunchConfig = { ...museConfig(binding, context), requireSessionWorkspace: true };
      const roleBinding: RoleBinding = { role: "Worker", provider: config.provider, transport, model: config.model, requires: {} };
      return { binding: roleBinding, adapter: new MuseAdapter(roleBinding, config) as ProviderAdapter };
    } } : {}),
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

/**
 * The production registry. `museBindingValidations` replaces the recorded binding-scoped validations of the Exec transport
 * (TEST SEAM: fake binaries have other bytes than the validated one); production never passes it.
 */
export function defaultRegistry(options: Readonly<{ museBindingValidations?: readonly BindingValidation[] }> = {}): ProviderRegistry {
  return { factories: new Map([["claude-one-shot", claudeFactory], ["muse-exec", museFactory("muse-exec", options.museBindingValidations)],
    ["muse-msp", museFactory("muse-msp")]]), defaults: DEFAULT_CONFIG, workspaceStatePaths: providerWorkspaceStatePaths() };
}
