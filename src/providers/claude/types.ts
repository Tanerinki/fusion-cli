import type { AuthStatus, CapabilitySnapshot, FusionError, ModelProfile, ProviderUsage, ResultPacket, WorkspacePosture } from "../../core/domain.js";
import { join } from "node:path";
import { BillingGuard, type PreSpawnBlocker, type SafeChildEnvironment } from "../../core/policy/billing-guard.js";
import { readBoundedFile } from "../../platform/fs/bounded-read.js";
import { parseStrictJson } from "../../platform/process/strict-json.js";
import { claudeEnvironmentRules, claudeSettingsBlockers, type ClaudeOauthTokenPolicy } from "../../runtime/provider-environment-rules.js";

export const CLAUDE_READ_ONLY_PROFILE = "claude-restricted-read-only-v1";
export const CLAUDE_SETTINGS_MAX_BYTES = 1024 * 1024;
export const CLAUDE_SAFE_TOOLS = ["Glob", "Grep", "Read"] as const;
/** M5.2 validation applies only to the locally probed init/flag semantics. */
export const CLAUDE_VALIDATED_EXTENSION_VERSION = "2.1.280";
export interface ClaudeLaunchConfig {
  readonly executablePath: string;
  readonly workspace: string;
  readonly model: ModelProfile;
  /** Canonical identity expected from init, independent of the requested alias. */
  readonly expectedCanonicalModel: string;
  readonly posture: WorkspacePosture;
  readonly sourceEnvironment?: NodeJS.ProcessEnv;
  readonly oauthTokenPolicy?: ClaudeOauthTokenPolicy;
  /** Optional parsed settings supplied by the caller for explicit blocker checks. */
  readonly settings?: unknown;
  readonly timeoutMs?: number;
}
/** Internal fixture seam. Public ClaudeAdapter does not accept this. */
export type ClaudeFixtureBinary = Readonly<{ executable: string; argvPrefix: readonly string[] }>;
export class ClaudeFailure extends Error {
  constructor(readonly error: FusionError) { super(error.safeMessage); this.name = "ClaudeFailure"; }
}
export function fail(kind: FusionError["kind"], safeMessage: string, retryable = false): never {
  throw new ClaudeFailure({ kind, safeMessage, retryable });
}
export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function string(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }
/**
 * Provenance summary of loaded plugins for diagnostics: counts per class only, never names or paths.
 * `builtin` = runtime built-in, `marketplace` = installed/synced `name@marketplace`, `other` = unidentified.
 */
export function describeLoadedPlugins(items: readonly unknown[]): string {
  const counts = { builtin: 0, marketplace: 0, other: 0 };
  for (const item of items) {
    const plugin = record(item), source = string(plugin?.source);
    if (plugin?.path === "builtin" || (source !== null && /@builtin$/iu.test(source))) counts.builtin++;
    else if (source !== null && /^[^@\s]+@[^@\s]+$/u.test(source)) counts.marketplace++;
    else counts.other++;
  }
  return Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(",") || "none";
}
async function fileBlockers(path: string): Promise<readonly PreSpawnBlocker[]> {
  try {
    const bytes = await readBoundedFile(path, CLAUDE_SETTINGS_MAX_BYTES);
    return claudeSettingsBlockers(parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [{ source: "settings", reason: "SETTINGS_UNREADABLE",
      remediation: "Inspect Claude settings before launching this provider." }];
  }
}
export async function safeEnvironment(config: ClaudeLaunchConfig): Promise<SafeChildEnvironment> {
  const source = config.sourceEnvironment ?? process.env;
  const profile = Object.entries(source).find(([key]) => key.toUpperCase() === "USERPROFILE")?.[1] ??
    process.env.USERPROFILE;
  const paths = [join(config.workspace, ".claude", "settings.json"),
    join(config.workspace, ".claude", "settings.local.json"),
    ...(profile ? [join(profile, ".claude", "settings.json")] : [])];
  const blockers = [...(config.settings === undefined ? [] : claudeSettingsBlockers(config.settings)),
    ...(await Promise.all(paths.map(fileBlockers))).flat()];
  const result = new BillingGuard(claudeEnvironmentRules(config.oauthTokenPolicy)).buildChildEnvironment(
    config.sourceEnvironment ?? process.env, blockers);
  if (!result.ok) throw new ClaudeFailure(result.error);
  return result.child;
}
export function capability(version = "unknown", observed = false): CapabilitySnapshot {
  return { provider: "claude", transport: "claude-one-shot", observedAt: new Date().toISOString(), runtimeVersion: version,
    persistentSessions: false, structuredOutput: observed ? true : "unknown", webToolsDisabled: observed ? true : "unknown",
    ...(observed ? { webToolsDisabledEvidence: { source: "runtimeReadback" as const, versionVerified: false } } : {}),
    filesystem: { read: observed ? true : "unknown", write: false }, shell: { available: false, sandboxed: "unknown" },
    approvalCallback: false, protocolCancellation: false, usageReporting: observed ? true : "unknown",
    modelIdentityReadback: observed ? true : "unknown", subscriptionLaneReadback: observed ? true : "unknown" };
}
export interface ClaudeRuntimeEvidence {
  readonly auth: AuthStatus;
  readonly apiKeySource: string;
  readonly requestedModel: string;
  readonly effectiveModel: string;
  readonly permissionMode: string;
  readonly tools: readonly string[];
  readonly mcpServers: readonly string[];
  readonly runtimeVersion: string;
  readonly pluginIsolation?: Readonly<{ preflight: "explicitTemporaryDisable";
    installedCount: number; builtinCount: number; runtimeLoadedPlugins: 0;
    /** Reviewer-shaped init-only startups needed before one reported no loaded plugin (drift is visible here). */
    verificationRounds: number }>;
  /** Init inventories are diagnostic metadata; plugins are loaded extensions. */
  readonly extensionInventory: Readonly<{ agents: number; skills: number; slashCommands: number; plugins: number }>;
  /** Model-invocable extension paths only. Managed policy hooks are a separate, unverified surface. */
  readonly extensionIsolation: Readonly<{ state: "disabled"; managedHooks: "unverified";
    evidence: readonly string[]; versionVerified: true }>;
}
export interface ClaudeSuccess {
  readonly output: ResultPacket;
  readonly usage?: ProviderUsage;
  readonly evidence: ClaudeRuntimeEvidence;
}
