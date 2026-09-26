import { PLATFORM_REQUIREMENTS, type PlatformRequirement } from "../../core/policy/platform.js";

/**
 * Which operating-system semantics a task's verification must demonstrate, declared by the host — never lowered by a
 * model claim; deterministic signals may only escalate it (see `core/policy/platform.ts`). A backend proves only the semantics of
 * the platform it actually runs on: a Linux container PASS says nothing about Windows paths, NTFS ACLs, PowerShell,
 * Win32 APIs or Windows-only native addons. `unknown` is the fail-closed default for every semantics-limited backend.
 */
export const VERIFICATION_PLATFORM_REQUIREMENTS = PLATFORM_REQUIREMENTS;
export type VerificationPlatformRequirement = PlatformRequirement;

/** The OS semantics a backend's PASS actually demonstrates. */
export type VerificationPlatformSemantics = "linux" | "windows";

/** Requirements each semantics may satisfy. `unknown` and anything unlisted are never satisfied. */
const SATISFIES: Readonly<Record<VerificationPlatformSemantics, ReadonlySet<VerificationPlatformRequirement>>> = Object.freeze({
  linux: new Set<VerificationPlatformRequirement>(["platform-neutral", "linux-compatible"]),
  windows: new Set<VerificationPlatformRequirement>(["platform-neutral", "windows-required"]),
});

export interface PlatformEligibility {
  readonly eligible: boolean;
  /** Stable reason, safe to display. */
  readonly reason: string;
}

/** Whether a backend with `semantics` may verify a task declaring `requirement`. Missing or invalid is `unknown`. */
export function platformEligibility(semantics: VerificationPlatformSemantics, requirement: unknown): PlatformEligibility {
  const known = (VERIFICATION_PLATFORM_REQUIREMENTS as readonly unknown[]).includes(requirement)
    ? requirement as VerificationPlatformRequirement : "unknown";
  if (known === "unknown")
    return { eligible: false, reason: "the task's verification platform requirement is unknown; it fails closed" };
  if (!SATISFIES[semantics].has(known))
    return { eligible: false, reason: `a ${semantics} verification backend cannot satisfy a ${known} requirement` };
  return { eligible: true, reason: `${known} verification may run with ${semantics} semantics` };
}
