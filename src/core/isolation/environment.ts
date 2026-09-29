import type { CapabilityManifest } from "./capability-manifest.js";

/**
 * v0.6 — ENVIRONMENT MINIMIZATION (§20, pure). An untrusted execution does not inherit the host environment. Given the
 * host environment and a capability manifest, this produces the child's environment as an explicit ALLOW-LIST: only the
 * variable NAMES the manifest declares pass through, with their host values; everything else is dropped. Deny by default.
 *
 * The report carries counts and, for observability/audit, the NAMES of dropped credential-shaped variables — never a
 * value (§21, §67). Windows environment names are case-insensitive, so matching is case-insensitive while the host's
 * actual key spelling is preserved so its value is found.
 */

/** A variable name whose shape suggests a secret; used only to LABEL what was dropped, never to pass or read a value. */
const CREDENTIAL_SHAPE = /(?:^|_)(?:API_?KEY|ACCESS_?KEY|SECRET|PASSWORD|PASSWD|TOKEN|CREDENTIAL|PRIVATE_?KEY|AUTHORIZATION|AUTH_?TOKEN|COOKIE|SESSION|SSH_?AUTH_?SOCK|AWS_|AZURE_|GCP_|GH_?TOKEN|NPM_?TOKEN)(?:$|_)/u;
const MAX_LABELLED = 32;

export interface EnvironmentMinimizationReport {
  /** How many variables passed the allow-list. */
  readonly allowed: number;
  /** How many host variables were dropped. */
  readonly droppedTotal: number;
  /** How many dropped variables had a credential-like NAME (a subset of droppedTotal). */
  readonly droppedSensitiveCount: number;
  /** Bounded, sorted NAMES (uppercased) of dropped credential-shaped variables — for audit; never values. */
  readonly droppedSensitiveNames: readonly string[];
}
export interface MinimizedEnvironment {
  readonly env: Readonly<Record<string, string>>;
  readonly report: EnvironmentMinimizationReport;
}

/**
 * Builds the minimal child environment for an untrusted execution: exactly the manifest's `allowedNames`, matched
 * case-insensitively against the host environment, with host values. Names the manifest allows but the host does not
 * define are simply absent (nothing is invented). A value is never copied for a name that is not allowed.
 */
export function minimizeEnvironment(hostEnv: Readonly<Record<string, string | undefined>>, manifest: CapabilityManifest): MinimizedEnvironment {
  const allowed = new Set(manifest.environment.allowedNames.map(name => name.toUpperCase()));
  const env: Record<string, string> = {};
  let passed = 0, droppedTotal = 0, droppedSensitive = 0;
  const sensitive: string[] = [];
  for (const [key, value] of Object.entries(hostEnv)) {
    if (value === undefined) continue;
    if (allowed.has(key.toUpperCase())) { env[key] = value; passed++; continue; }
    droppedTotal++;
    if (CREDENTIAL_SHAPE.test(key.toUpperCase())) {
      droppedSensitive++;
      if (sensitive.length < MAX_LABELLED && !sensitive.includes(key.toUpperCase())) sensitive.push(key.toUpperCase());
    }
  }
  return Object.freeze({
    env: Object.freeze(env),
    report: Object.freeze({ allowed: passed, droppedTotal, droppedSensitiveCount: droppedSensitive,
      droppedSensitiveNames: Object.freeze(sensitive.sort()) }),
  });
}

/** Whether a variable name has a credential-like shape (exposed for the doctor/audit and tests). */
export const looksSensitive = (name: string): boolean => CREDENTIAL_SHAPE.test(name.toUpperCase());
