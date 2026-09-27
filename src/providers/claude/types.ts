import type { AuthStatus, FusionError, ModelProfile, ProviderUsage, ResultPacket, WorkspacePosture } from "../../core/domain.js";
import { basename, dirname, isAbsolute, join } from "node:path";
import { FusionFailure } from "../../core/errors.js";
import { BillingGuard, type PreSpawnBlocker, type SafeChildEnvironment } from "../../core/policy/billing-guard.js";
import { readBoundedFile } from "../../platform/fs/bounded-read.js";
import { parseStrictJson } from "../../platform/process/strict-json.js";
import type { LaunchObserver } from "../../platform/process/supervisor.js";
import { claudeEnvironmentRules, claudeSettingsBlockers, type ClaudeOauthTokenPolicy } from "../../runtime/provider-environment-rules.js";

export const CLAUDE_READ_ONLY_PROFILE = "claude-restricted-read-only-v1";
export const CLAUDE_SETTINGS_MAX_BYTES = 1024 * 1024;
export const CLAUDE_SAFE_TOOLS = ["Glob", "Grep", "Read"] as const;
/**
 * M5.2 validation applies only to the locally probed init/flag semantics. Since the runtime-attestation change, this is the
 * RECORDED validation: later patches of its release line are attested mechanically instead (`runtime-attestation.ts`).
 */
export const CLAUDE_VALIDATED_EXTENSION_VERSION = "2.1.280";
export interface ClaudeLaunchConfig {
  readonly executablePath: string;
  /**
   * The default working directory (doctor probes, legacy sessions without a session workspace). A session bound to a
   * Fusion-owned workspace runs every one of its processes there instead.
   */
  readonly workspace: string;
  /** Roots no session workspace may be, contain or lie inside (the user's primary checkout). */
  readonly forbiddenWorkspaceRoots?: readonly string[];
  /** Refuse any session that has no Fusion-owned session workspace (never fall back to `workspace`). */
  readonly requireSessionWorkspace?: boolean;
  readonly model: ModelProfile;
  /** Canonical identity expected from init, independent of the requested alias. */
  readonly expectedCanonicalModel: string;
  readonly posture: WorkspacePosture;
  readonly sourceEnvironment?: NodeJS.ProcessEnv;
  readonly oauthTokenPolicy?: ClaudeOauthTokenPolicy;
  /** Optional parsed settings supplied by the caller for explicit blocker checks. */
  readonly settings?: unknown;
  readonly timeoutMs?: number;
  /** Observes every process this adapter starts (argv, working directory, environment key names only). */
  readonly launchObserver?: LaunchObserver;
}
/** Internal fixture seam. Public ClaudeAdapter does not accept this. */
export type ClaudeFixtureBinary = Readonly<{ executable: string; argvPrefix: readonly string[] }>;
/** A typed provider failure; being a `FusionFailure`, it keeps its kind wherever it surfaces (never an internal error). */
export class ClaudeFailure extends FusionFailure {
  constructor(error: FusionError) { super(error); this.name = "ClaudeFailure"; }
}
export function fail(kind: FusionError["kind"], safeMessage: string, retryable = false, failureDetail?: string): never {
  throw new ClaudeFailure({ kind, safeMessage, retryable, ...(failureDetail === undefined ? {} : { failureDetail }) });
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
/**
 * Child-only environment switches Fusion sets on every Claude process it starts (preflight probes and turns). They
 * are never written to any settings file. Auto memory would load per-directory personal memory into the turn.
 */
export const CLAUDE_CHILD_SWITCHES: Readonly<Record<string, string>> = Object.freeze({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
export const CLAUDE_PACKAGE_NAME = "@anthropic-ai/claude-code";
/**
 * The installed version beside a native `<package>/bin/claude.exe`, read from the package metadata without starting
 * Claude; `unknown` for any other layout or unreadable metadata. Advisory only: every turn re-reads the version at
 * init and fails closed unless it is the validated one.
 */
export async function claudeInstallVersion(executablePath: string): Promise<string> {
  if (!isAbsolute(executablePath) || basename(executablePath).toLowerCase() !== "claude.exe" ||
      basename(dirname(executablePath)).toLowerCase() !== "bin") return "unknown";
  try {
    const bytes = await readBoundedFile(join(dirname(dirname(executablePath)), "package.json"), 64 * 1024);
    const manifest = record(parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    const version = manifest?.name === CLAUDE_PACKAGE_NAME ? string(manifest.version) : null;
    return version !== null && /^\d{1,4}\.\d{1,4}\.\d{1,6}$/u.test(version) ? version : "unknown";
  } catch { return "unknown"; }
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
    evidence: readonly string[]; versionVerified: true;
    /** How the launch flags' meaning is known for this runtime: recorded live validation, or this process's canary attestation. */
    attestation: "recordedValidation" | "runtimeCanary" }>;
}
export interface ClaudeSuccess {
  readonly output: ResultPacket;
  readonly usage?: ProviderUsage;
  readonly evidence: ClaudeRuntimeEvidence;
}
