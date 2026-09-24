import { isAbsolute } from "node:path";
import { failWith } from "../../core/errors.js";

/**
 * Least-privilege environment for a Fusion-owned verification process. A verifier is untrusted repository code, so it
 * receives ZERO provider credentials and no ambient user state: only a small allowlist of non-secret runtime variables,
 * with the home/temp/config locations redirected into a Fusion-owned disposable root. This is an allowlist, not a
 * denylist — a credential can never appear because it is never copied — and a final assertion rejects any credential
 * marker as defense in depth. No provider auth (Claude, Muse), API key, or Git/SSH credential is ever forwarded.
 */

/** Non-secret host variables copied through verbatim when present (executable and DLL resolution needs them). */
export const VERIFIER_FORWARDED_KEYS = Object.freeze(["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR"] as const);
/** Ambient user locations redirected into the disposable runtime root so the verifier cannot read or write real ones. */
export const VERIFIER_REDIRECTED_KEYS = Object.freeze(["TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA",
  "XDG_CONFIG_HOME"] as const);
/** Fixed non-secret values Fusion always sets for a verifier. */
export const VERIFIER_INJECTED = Object.freeze({ GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" });

/** Any of these key shapes surviving into a verifier environment is a defect; they are never in the allowlist. */
const CREDENTIAL_MARKER =
  /(?:^|_)(?:API_KEY|ACCESS_KEY|SECRET|PASSWORD|PASSWD|PASSPHRASE|PRIVATE_KEY|TOKEN|CREDENTIAL|AUTHORIZATION|COOKIE)(?:$|_)/u;
const PROVIDER_MARKER = /^(?:ANTHROPIC_|CLAUDE_?|CLAUDECODE|MUSE_|META_|TBH_)/u;

export interface VerifierEnvironmentSummary {
  /** Key names only — never values. Forwarded keys that were present in the source. */
  readonly forwarded: readonly string[];
  /** Forwarded keys that were absent in the source and so omitted. */
  readonly forwardedAbsent: readonly string[];
  readonly redirected: readonly string[];
  readonly injected: readonly string[];
}
export interface VerifierEnvironment {
  readonly env: NodeJS.ProcessEnv;
  readonly summary: VerifierEnvironmentSummary;
}

const forwardable = (value: unknown): value is string => typeof value === "string" && !value.includes("\0");

/**
 * Builds the environment for a verifier confined to `runtimeRoot`. `runtimeRoot` must be an absolute Fusion-owned
 * disposable directory; the verifier's home, temp and config all point at it.
 */
export function buildVerifierEnvironment(source: NodeJS.ProcessEnv, runtimeRoot: string): VerifierEnvironment {
  if (typeof runtimeRoot !== "string" || runtimeRoot.length === 0 || runtimeRoot.includes("\0") || !isAbsolute(runtimeRoot))
    failWith("InvalidInput", "Verifier environment requires an absolute runtime root.");
  const env: NodeJS.ProcessEnv = {};
  const forwarded: string[] = [], forwardedAbsent: string[] = [];
  for (const key of VERIFIER_FORWARDED_KEYS) {
    const value = source[key];
    if (forwardable(value)) { env[key] = value; forwarded.push(key); }
    else forwardedAbsent.push(key);
  }
  for (const key of VERIFIER_REDIRECTED_KEYS) env[key] = runtimeRoot;
  for (const [key, value] of Object.entries(VERIFIER_INJECTED)) env[key] = value;
  // Defense in depth: the allowlist cannot introduce a credential, but assert it regardless so a future edit that
  // widens the allowlist fails loudly instead of leaking a secret to untrusted verifier code.
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (CREDENTIAL_MARKER.test(upper) || PROVIDER_MARKER.test(upper))
      failWith("SecurityViolation", "A verifier environment must contain no provider or credential variable.");
  }
  return { env, summary: { forwarded: Object.freeze(forwarded), forwardedAbsent: Object.freeze(forwardedAbsent),
    redirected: Object.freeze([...VERIFIER_REDIRECTED_KEYS]), injected: Object.freeze(Object.keys(VERIFIER_INJECTED)) } };
}
