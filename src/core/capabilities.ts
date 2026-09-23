import type { CapabilityRequirement, CapabilitySnapshot } from "./domain.js";

const SIMPLE_KEYS = new Set([
  "persistentSessions", "structuredOutput", "approvalCallback", "protocolCancellation",
  "usageReporting", "modelIdentityReadback", "subscriptionLaneReadback", "webToolsDisabled",
]);

/** Exact capability matching: absence, including an unobserved capability, is ineligible. */
export function meetsCapabilities(snapshot: CapabilitySnapshot, required: CapabilityRequirement): boolean {
  for (const [key, value] of Object.entries(required)) {
    if (key === "filesystem" || key === "shell") {
      if (value === null || typeof value !== "object") return false;
      const actual = snapshot[key];
      if (actual === null || typeof actual !== "object") return false;
      for (const [subkey, expected] of Object.entries(value as Record<string, boolean>)) {
        if (typeof expected !== "boolean" || !(subkey in actual)) return false;
        if (actual[subkey as keyof typeof actual] !== expected) return false;
      }
    } else {
      if (!SIMPLE_KEYS.has(key) || typeof value !== "boolean") return false;
      if (snapshot[key as keyof CapabilitySnapshot] !== value) return false;
    }
  }
  return true;
}
