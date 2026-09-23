import { randomBytes } from "node:crypto";
import type { CapabilitySnapshot, FusionError, ModelProfile, ResultPacket, WorkspacePosture } from "../../core/domain.js";
import { BillingGuard, type SafeChildEnvironment } from "../../core/policy/billing-guard.js";
import { museEnvironmentRules } from "../../runtime/provider-environment-rules.js";
import { resolveVersionedExecutable } from "../../platform/process/native-executable.js";

export const READ_ONLY_PROFILE = "muse-read-only-flags-v1";
export const READ_ONLY_FLAGS = ["--disable-write", "--disable-shell", "--disable-web-tools", "--approval-judge", "off", "--no-foreign-personal-context"] as const;
/** The local runtime report verified this flag on this exact release only. */
export const VERIFIED_EXEC_WEB_DISABLE_VERSION = "1.3.0-R3401.1";
export const MSP_READ_ONLY_PROFILE = "muse-msp-write-shell-disabled-v1";
export const MSP_READ_ONLY_FLAGS = ["--disable-write", "--disable-shell"] as const;

export class MuseFailure extends Error {
  constructor(readonly error: FusionError) { super(error.safeMessage); this.name = "MuseFailure"; }
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
  readonly workspace: string;
  readonly provider: string;
  readonly model: ModelProfile;
  readonly posture: WorkspacePosture;
  readonly sourceEnvironment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly maxModelSteps?: number;
  /** Caller-owned location for retained Exec attempt evidence. */
  readonly evidenceDirectory?: string;
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
export function capability(config: MuseLaunchConfig, transport: "muse-exec" | "muse-msp", version: string,
  fingerprint?: string, mspAvailable = false): CapabilitySnapshot {
  return {
    provider: config.provider, transport, observedAt: new Date().toISOString(), runtimeVersion: version,
    ...(fingerprint === undefined ? {} : { schemaFingerprint: fingerprint }),
    persistentSessions: transport === "muse-msp" ? mspAvailable : false,
    structuredOutput: transport === "muse-exec" ? config.provider === "meta" : "unknown",
    webToolsDisabled: transport === "muse-exec" && version === VERIFIED_EXEC_WEB_DISABLE_VERSION ? true : "unknown",
    ...(transport === "muse-exec" ? { webToolsDisabledEvidence: { source: "launchFlag" as const,
      versionVerified: version === VERIFIED_EXEC_WEB_DISABLE_VERSION } } : {}),
    filesystem: { read: true, write: false }, shell: { available: false, sandboxed: "unknown" },
    approvalCallback: transport === "muse-msp" ? mspAvailable : false,
    protocolCancellation: transport === "muse-msp" ? mspAvailable : false,
    usageReporting: transport === "muse-msp" ? mspAvailable : "unknown",
    modelIdentityReadback: true, subscriptionLaneReadback: transport === "muse-msp" ? mspAvailable : "unknown",
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
