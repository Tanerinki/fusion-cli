import { randomBytes } from "node:crypto";
import { FusionFailure } from "../../core/errors.js";
import type { CapabilitySnapshot, CapabilityState, FusionError, ModelProfile, ResultPacket, WorkspacePosture } from "../../core/domain.js";
import { BillingGuard, type SafeChildEnvironment } from "../../core/policy/billing-guard.js";
import { museEnvironmentRules } from "../../runtime/provider-environment-rules.js";
import { resolveVersionedExecutable } from "../../platform/process/native-executable.js";
import type { LaunchObserver } from "../../platform/process/supervisor.js";

export const READ_ONLY_PROFILE = "muse-read-only-flags-v1";
export const READ_ONLY_FLAGS = ["--disable-write", "--disable-shell", "--disable-web-tools", "--approval-judge", "off", "--no-foreign-personal-context"] as const;
/** The local runtime report verified this flag on this exact release only. */
export const VERIFIED_EXEC_WEB_DISABLE_VERSION = "1.3.0-R3401.1";
export const MSP_READ_ONLY_PROFILE = "muse-msp-write-shell-disabled-v1";
export const MSP_READ_ONLY_FLAGS = ["--disable-write", "--disable-shell"] as const;
/** Every posture control an Exec turn is launched with, besides identity, workspace, limits and I/O. */
export const EXEC_CONTROL_FLAGS = ["--approval-mode", "never", ...READ_ONLY_FLAGS] as const;
/** Flags that widen a turn beyond the read-only posture; any of them voids every launch-time fact. */
const WIDENING_FLAGS = new Set(["--yolo", "--trust-workspace", "--disable-approval", "--disable-sandbox", "--enable-shell-tool",
  "--base-url", "--api-key-stdin", "--allow-workspace-switch", "--worktree", "-w", "--permission-profile"]);
/**
 * Environment switches that would enable an extension surface (session MCP servers, managed hooks, web tools). The
 * billing guard strips each from every Muse child; `extensionSwitchesStripped` proves that against the live rules.
 */
export const EXTENSION_SWITCHES = ["MUSE_ENABLE_SESSION_MCP", "TBH_MANAGED_HOOKS_PATH", "MUSE_ENABLE_WEB_TOOLS"] as const;
export function extensionSwitchesStripped(): boolean {
  const guard = new BillingGuard(museEnvironmentRules());
  return EXTENSION_SWITCHES.every(key => {
    const result = guard.buildChildEnvironment({ [key]: "1" });
    // A switch that blocks the launch cannot reach a turn either; any other refusal proves nothing.
    if (!result.ok) return result.decisions.some(decision => decision.key === key && decision.action === "BLOCK");
    return !Object.keys(result.child.forSpawn()).some(name => name.toUpperCase() === key);
  });
}
export interface MuseLaunchPosture {
  readonly write: CapabilityState;
  readonly shell: CapabilityState;
  readonly webToolsDisabled: CapabilityState;
  readonly approvalEscalationDisabled: CapabilityState;
  readonly personalContextDisabled: CapabilityState;
  readonly extensionsQuarantined: CapabilityState;
}
/**
 * The posture a Muse process is launched into, derived from the exact control flags passed to it. Write and shell
 * disabling are host enforcement; the remaining facts hold only on the release those flags were verified on. A
 * missing control, or any widening flag, leaves its fact unknown, never assumed.
 */
export function museLaunchPosture(flags: readonly string[], versionVerified: boolean,
  extensionSwitchesQuarantined = extensionSwitchesStripped()): MuseLaunchPosture {
  const has = (flag: string): boolean => flags.includes(flag);
  const value = (flag: string): string | undefined => { const at = flags.indexOf(flag); return at < 0 ? undefined : flags[at + 1]; };
  const clean = !flags.some(flag => WIDENING_FLAGS.has(flag));
  const holds = (control: boolean, fact: boolean, needsVersion = true): CapabilityState =>
    clean && control && (versionVerified || !needsVersion) ? fact : "unknown";
  return {
    write: holds(has("--disable-write"), false, false),
    shell: holds(has("--disable-shell"), false, false),
    webToolsDisabled: holds(has("--disable-web-tools"), true),
    // No LLM approval judge, and no approval prompt that could grant more than the host flags allow.
    approvalEscalationDisabled: holds(value("--approval-judge") === "off" && value("--approval-mode") === "never", true),
    personalContextDisabled: holds(has("--no-foreign-personal-context"), true),
    // Exec takes no MCP configuration; the switches that enable session MCP, managed hooks or web tools never reach it.
    extensionsQuarantined: holds(extensionSwitchesQuarantined, true),
  };
}

/** A typed provider failure; being a `FusionFailure`, it keeps its kind wherever it surfaces (never an internal error). */
export class MuseFailure extends FusionFailure {
  constructor(error: FusionError) { super(error); this.name = "MuseFailure"; }
}
export function fail(kind: FusionError["kind"], safeMessage: string, retryable = false): never {
  throw new MuseFailure({ kind, safeMessage, retryable });
}
export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function string(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }
export function positiveInt(value: unknown): number | null { return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null; }
export function uuidV7(): string {
  const b = randomBytes(16);
  const ms = BigInt(Date.now());
  for (let i = 5; i >= 0; i--) b[i] = Number((ms >> BigInt((5 - i) * 8)) & 255n);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

export interface MuseLaunchConfig {
  readonly binaryDirectory: string;
  readonly versionFile: string;
  /**
   * The default workspace (doctor probes, the MSP host, legacy sessions without a session workspace). An Exec session
   * bound to a Fusion-owned workspace passes that one as `--workspace` and working directory instead.
   */
  readonly workspace: string;
  /** Roots no session workspace may be, contain or lie inside (the user's primary checkout). */
  readonly forbiddenWorkspaceRoots?: readonly string[];
  /** Refuse any session that has no Fusion-owned session workspace (never fall back to `workspace`). */
  readonly requireSessionWorkspace?: boolean;
  readonly provider: string;
  readonly model: ModelProfile;
  readonly posture: WorkspacePosture;
  readonly sourceEnvironment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly maxModelSteps?: number;
  /**
   * Extra Exec attempts after a malformed structured output (default 1). `0`: one model turn per request, never a
   * silent second one (an authorized single-turn probe).
   */
  readonly malformedOutputRetries?: 0 | 1;
  /** Caller-owned location for retained Exec attempt evidence. */
  readonly evidenceDirectory?: string;
  /**
   * O5.5B23: the ONE Exec release an authorized validation probe runs UNDER VALIDATION. Only the provider registry sets it,
   * and only from a probe's runtime context (`ProviderRuntimeContext.runtimeUnderValidation`) — never from configuration.
   * That release is launched with exactly the verified release's controls, and the launch-flag facts those controls stand
   * for are claimed for it, but reported `versionVerified: false`: they are what the probe exists to test.
   */
  readonly versionUnderValidation?: string;
  /**
   * O5.5B24: releases validated for THIS binding only (the registry derives them from the recorded binding-scoped
   * validations that match the binding exactly), each with the one binary it was validated on. The launch-flag facts
   * hold for such a release only when the executable about to run has exactly that SHA-256 (`validatedBindingIdentity`).
   */
  readonly validatedBindings?: readonly Readonly<{ release: string; executableSha256: string }>[];
  /** Observes every process this adapter's transports start (argv, working directory, environment key names only). */
  readonly launchObserver?: LaunchObserver;
}
/** Internal test seam for native local fixtures. The public MuseAdapter never supplies it. */
export type MuseFixtureBinary = Readonly<{ executable: string; argvPrefix: readonly string[] }>;
export interface PreparedLaunch {
  readonly executable: string;
  readonly argvPrefix: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}
export async function prepareLaunch(config: MuseLaunchConfig, fixtureBinary?: MuseFixtureBinary): Promise<PreparedLaunch> {
  if (config.posture !== "readOnly") fail("CapabilityUnavailable", "Muse autonomous writer isolation is unproven.");
  const result = new BillingGuard(museEnvironmentRules()).buildChildEnvironment(config.sourceEnvironment ?? process.env);
  if (!result.ok) throw new MuseFailure(result.error);
  const safe: SafeChildEnvironment = result.child;
  const executable = fixtureBinary?.executable ?? await resolveVersionedExecutable({
    directory: config.binaryDirectory, versionFile: config.versionFile, prefix: "muse-bin-",
  });
  return { executable, argvPrefix: fixtureBinary?.argvPrefix ?? [], env: safe.forSpawn() };
}
/**
 * Exec capabilities are launch-time facts of `EXEC_CONTROL_FLAGS`; the account lane is attested through `account/read`
 * before and after every Exec turn. MSP capabilities beyond its two host flags need the host started.
 */
export function capability(config: MuseLaunchConfig, transport: "muse-exec" | "muse-msp", version: string,
  fingerprint?: string, mspAvailable = false, bindingIdentity = false): CapabilitySnapshot {
  // O5.5B24: a release validated for this exact binding counts only on its exact binary (`bindingIdentity`, checked by
  // the caller with `validatedBindingIdentity`); it is then reported verified, for this binding only.
  const verified = version === VERIFIED_EXEC_WEB_DISABLE_VERSION ||
    (transport === "muse-exec" && bindingIdentity && (config.validatedBindings ?? []).some(entry => entry.release === version));
  // O5.5B23: an Exec release under validation claims the same launch-flag facts; its evidence still says unverified.
  const underValidation = !verified && transport === "muse-exec" && config.versionUnderValidation !== undefined &&
    config.versionUnderValidation === version;
  const posture = museLaunchPosture(transport === "muse-exec" ? EXEC_CONTROL_FLAGS : MSP_READ_ONLY_FLAGS, verified || underValidation);
  return {
    provider: config.provider, transport, observedAt: new Date().toISOString(), runtimeVersion: version,
    ...(fingerprint === undefined ? {} : { schemaFingerprint: fingerprint }),
    persistentSessions: transport === "muse-msp" ? mspAvailable : false,
    structuredOutput: transport === "muse-exec" ? config.provider === "meta" : "unknown",
    webToolsDisabled: transport === "muse-exec" ? posture.webToolsDisabled : "unknown",
    ...(transport === "muse-exec" ? { webToolsDisabledEvidence: { source: "launchFlag" as const, versionVerified: verified },
      postureEvidence: { source: "launchFlag" as const, versionVerified: verified } } : {}),
    filesystem: { read: true, write: posture.write }, shell: { available: posture.shell, sandboxed: "unknown" },
    approvalEscalationDisabled: transport === "muse-exec" ? posture.approvalEscalationDisabled : "unknown",
    personalContextDisabled: transport === "muse-exec" ? posture.personalContextDisabled : "unknown",
    extensionsQuarantined: transport === "muse-exec" ? posture.extensionsQuarantined : "unknown",
    // Exec takes the workspace per turn; the durable MSP host is started once in its configured workspace.
    workspaceBinding: transport === "muse-exec",
    approvalCallback: transport === "muse-msp" ? mspAvailable : false,
    protocolCancellation: transport === "muse-msp" ? mspAvailable : false,
    usageReporting: transport === "muse-msp" ? mspAvailable : "unknown",
    modelIdentityReadback: true, subscriptionLaneReadback: transport === "muse-msp" ? mspAvailable : true,
  };
}
export function packetShape(value: unknown): value is ResultPacket {
  const r = record(value), result = record(r?.result), changes = record(r?.changes), verification = record(r?.verification);
  const strings = (x: unknown): boolean => Array.isArray(x) && x.every(y => typeof y === "string");
  return !!r && !!result && ["completed","partial","blocked","failed"].includes(String(result.status)) &&
    !!changes && strings(changes.files) && typeof changes.summary === "string" &&
    !!verification && strings(verification.testsRun) && strings(verification.results) &&
    strings(r.uncertainties) && strings(r.failures) && strings(r.needsLeadDecision);
}
