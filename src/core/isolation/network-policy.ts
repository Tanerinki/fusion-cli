import { failWith } from "../errors.js";

/**
 * v0.6 — NETWORK POLICY (pure). Filesystem isolation without network isolation is incomplete (section 17). An untrusted
 * execution is DENY_ALL by default; ALLOWLIST names the exact destinations it may reach. There is no "unrestricted" mode
 * for untrusted command execution — a policy is one of these two shapes, always. Whether a backend can ENFORCE a policy
 * is a separate question answered by the posture probe; this module only defines and validates the intent.
 */
export const NETWORK_MODES = Object.freeze(["DENY_ALL", "ALLOWLIST"] as const);
export type NetworkMode = (typeof NETWORK_MODES)[number];

/** How loopback (127.0.0.0/8, ::1) is treated. Denied by default; a backend may need admin provisioning to allow it. */
export const LOOPBACK_POLICIES = Object.freeze(["deny", "allow"] as const);
export type LoopbackPolicy = (typeof LOOPBACK_POLICIES)[number];

/**
 * One allowed destination: a host (DNS name or literal IP) and an optional port. A host is a bounded, conservative token
 * — a DNS name, an IPv4 literal, or a bracketless IPv6 literal — never a URL, scheme, path or wildcard-with-scheme. `"*"`
 * is refused: an allowlist names destinations, it does not re-open everything.
 */
export interface NetworkDestination {
  readonly host: string;
  /** 1–65535, or `null` for any port on that host. */
  readonly port: number | null;
}
export interface NetworkPolicy {
  readonly mode: NetworkMode;
  readonly loopback: LoopbackPolicy;
  /** Non-empty only for ALLOWLIST; sorted, de-duplicated, bounded. */
  readonly allowed: readonly NetworkDestination[];
}

export const NETWORK_LIMITS = Object.freeze({ maxDestinations: 64, maxHostLength: 253 });
// A DNS name (labels, no scheme/path), an IPv4 literal, or a hex:colon IPv6 literal. Deliberately conservative.
const HOST = /^(?:(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?|(?:\d{1,3}\.){3}\d{1,3}|[0-9A-Fa-f:]{2,45})$/u;

const validPort = (value: unknown): value is number =>
  value === null || (Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 65535);

/** The default posture for untrusted execution: deny everything, including loopback. */
export const DENY_ALL_NETWORK: NetworkPolicy = Object.freeze({ mode: "DENY_ALL", loopback: "deny", allowed: Object.freeze([]) });

/**
 * Builds a validated, canonical network policy. DENY_ALL carries no destinations; ALLOWLIST carries at least one, each a
 * conservative host token with an optional port, sorted and de-duplicated so equal policies serialize equally. A `"*"`
 * host, a scheme, a path or an out-of-range port is refused — the host never widens its own network by policy text.
 */
export function networkPolicy(input: Readonly<{ mode: NetworkMode; loopback?: LoopbackPolicy;
  allowed?: readonly NetworkDestination[] }>): NetworkPolicy {
  if (!(NETWORK_MODES as readonly unknown[]).includes(input.mode)) failWith("InvalidInput", "Unknown network mode.");
  const loopback = input.loopback ?? "deny";
  if (!(LOOPBACK_POLICIES as readonly unknown[]).includes(loopback)) failWith("InvalidInput", "Unknown loopback policy.");
  const raw = input.allowed ?? [];
  if (!Array.isArray(raw)) failWith("InvalidInput", "Network destinations must be a list.");
  if (input.mode === "DENY_ALL") {
    if (raw.length > 0) failWith("InvalidInput", "A DENY_ALL policy names no destinations.");
    return Object.freeze({ mode: "DENY_ALL", loopback, allowed: Object.freeze([]) });
  }
  if (raw.length === 0) failWith("InvalidInput", "An ALLOWLIST policy needs at least one destination.");
  if (raw.length > NETWORK_LIMITS.maxDestinations) failWith("InvalidInput", "Too many network destinations.");
  const seen = new Set<string>();
  const dests: NetworkDestination[] = [];
  for (const d of raw) {
    const rec = d as Record<string, unknown> | null;
    if (rec === null || typeof rec !== "object" || Array.isArray(rec) || Object.keys(rec).length !== 2 ||
        !Object.hasOwn(rec, "host") || !Object.hasOwn(rec, "port") || typeof rec.host !== "string" ||
        rec.host.length === 0 || rec.host.length > NETWORK_LIMITS.maxHostLength || rec.host === "*" || !HOST.test(rec.host) ||
        !validPort(rec.port))
      failWith("InvalidInput", "A network destination is malformed (a host token and an optional port only).");
    const host = rec.host.toLowerCase();
    const key = `${host}\u0000${rec.port ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dests.push(Object.freeze({ host, port: rec.port as number | null }));
  }
  dests.sort((a, b) => a.host === b.host ? (a.port ?? 0) - (b.port ?? 0) : a.host < b.host ? -1 : 1);
  return Object.freeze({ mode: "ALLOWLIST", loopback, allowed: Object.freeze(dests) });
}

/** Validates an untrusted stored/received network policy into its canonical form (re-runs every rule). */
export function validateNetworkPolicy(value: unknown): NetworkPolicy {
  const p = value as Record<string, unknown> | null;
  if (p === null || typeof p !== "object" || Array.isArray(p) || Object.keys(p).length !== 3 ||
      !["mode", "loopback", "allowed"].every(k => Object.hasOwn(p, k)))
    failWith("InvalidInput", "The network policy is malformed.");
  return networkPolicy({ mode: p.mode as NetworkMode, loopback: p.loopback as LoopbackPolicy,
    allowed: p.allowed as readonly NetworkDestination[] });
}
