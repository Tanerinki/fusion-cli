// v0.6 Hyper-V PoC — the VERDICT EVALUATOR (pure, unit-tested in CI).
//
// UNTESTED-ON-HARDWARE NOTICE: this module computes the PoC verdict from mechanically-collected canary results. Its
// existence is NOT evidence that Hyper-V/HNS/VFP satisfies the HARD boundary — only a real maintainer run produces the
// inputs. The evaluator's job is that a human NEVER manually decides PASS: PASS requires every positive control to succeed
// AND every required negative boundary to be mechanically demonstrated DENIED; any UNKNOWN/missing field forces INCOMPLETE,
// and any broken boundary forces FAIL. This is what the harness's negative self-test exercises.

/** A single canary outcome. `blocked`/`refused`/`no-route`/`dns-fail` are all treated as DENIED; `timeout` is NOT (the
 *  target may simply be unreachable — never counted as a proven deny without a positive control). */
export const DENY_OUTCOMES = Object.freeze(["blocked", "refused", "no-route", "dns-fail", "reset"]);
export const ALLOW_OUTCOMES = Object.freeze(["connected", "ok", "allowed"]);

/** Classifies a raw socket/fs result string into ALLOWED / DENIED / UNKNOWN (timeout and anything else are UNKNOWN). */
export function classify(outcome) {
  if (typeof outcome !== "string") return "UNKNOWN";
  const o = outcome.toLowerCase();
  if (ALLOW_OUTCOMES.includes(o)) return "ALLOWED";
  if (DENY_OUTCOMES.includes(o)) return "DENIED";
  return "UNKNOWN"; // timeout, error, missing, etc. — never silently a deny
}

/** The required positive controls (must be ALLOWED/PASS) and negative boundaries (must be DENIED) for an overall PASS. */
export const REQUIRED_ALLOW = Object.freeze(["brokerEndpoint", "viewRead", "scratchWrite"]);
export const REQUIRED_DENY = Object.freeze([
  "brokerWrongPort", "hostLoopbackIpv4", "lanAccess", "directInternet", "directProviderBypass",
  "viewWrite", "primaryAccess", "siblingAccess", "controlPlaneAccess", "hostProfileAccess",
]);
export const REQUIRED_PASS = Object.freeze(["processTreeContainment", "workerCleanup", "noStaleNetworkPolicy", "noStaleMounts", "noStaleProcess"]);

/**
 * Computes the overall verdict from a results object whose values are ALLOWED/DENIED/PASS/FAIL/UNKNOWN strings. Returns
 * `{ verdict, reasons }` where verdict is PASS only if every requirement is met; FAIL if any boundary is violated; and
 * INCOMPLETE if any required field is UNKNOWN/missing (UNKNOWN is NEVER promoted to PASS).
 */
export function evaluate(results) {
  const r = results ?? {};
  const reasons = [];
  let incomplete = false, failed = false;
  const need = (key, want) => {
    const v = (r[key] ?? "UNKNOWN");
    if (v === "UNKNOWN") { incomplete = true; reasons.push(`${key}: UNKNOWN (needs proof)`); return; }
    if (v !== want) { failed = true; reasons.push(`${key}: ${v}, required ${want}`); }
  };
  for (const key of REQUIRED_ALLOW) need(key, "ALLOWED");
  for (const key of REQUIRED_DENY) need(key, "DENIED");
  for (const key of REQUIRED_PASS) need(key, "PASS");
  // A run is PASS only when nothing failed AND nothing is incomplete.
  const verdict = failed ? "FAIL" : incomplete ? "INCOMPLETE" : "PASS";
  return Object.freeze({ verdict, reasons: Object.freeze(reasons) });
}

/** The exact PoC resource prefix for one run. Every created resource carries it, so cleanup/inspect touch ONLY PoC state. */
export function pocPrefix(runId) {
  if (typeof runId !== "string" || !/^[A-Za-z0-9]{4,32}$/u.test(runId)) throw new Error("runId must be 4-32 alphanumerics");
  return `FusionV06Poc-${runId}`;
}

/**
 * Whether a resource name belongs to THIS PoC run — the only names cleanup may remove. A name that does not start with the
 * exact `FusionV06Poc-<runId>` prefix is never matched (cleanup must never delete unrelated HNS/Hyper-V/firewall state).
 */
export function isPocResource(name, runId) {
  if (typeof name !== "string") return false;
  return name.startsWith(`${pocPrefix(runId)}-`) || name === pocPrefix(runId);
}

/** Filters a list of existing resource names to only this run's PoC resources (what cleanup is allowed to remove). */
export function selectForCleanup(names, runId) {
  if (!Array.isArray(names)) return [];
  return names.filter(n => isPocResource(n, runId));
}
