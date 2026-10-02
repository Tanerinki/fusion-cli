// v0.6 Hyper-V PoC — the VERDICT EVALUATOR (pure, unit-tested in CI).
//
// UNTESTED-ON-HARDWARE NOTICE: this module computes the PoC verdict from mechanically-collected canary results. Its
// existence is NOT evidence that Hyper-V/HNS/VFP satisfies the HARD boundary — only a real maintainer run produces the
// inputs. The evaluator's job is that a human NEVER manually decides PASS: PASS requires every positive control to succeed
// AND every required negative boundary to be mechanically demonstrated DENIED; any UNKNOWN/missing field forces INCOMPLETE,
// and any broken boundary forces FAIL. This is what the harness's negative self-test exercises.

/** A single canary outcome. `blocked`/`refused`/`no-route`/`dns-fail` are all treated as DENIED; `timeout` is NOT (the
 *  target may simply be unreachable — never counted as a proven deny without a positive control). */
export const DENY_OUTCOMES = Object.freeze(["blocked", "refused", "no-route", "dns-fail", "reset", "unreachable"]);
export const ALLOW_OUTCOMES = Object.freeze(["connected", "ok", "allowed", "answered"]);

/** A measurement that was never taken. Treated like UNKNOWN — forces INCOMPLETE, never a silent deny or PASS. */
export const NOT_RUN = "NOT_RUN";

/** Classifies a raw socket/fs result string into ALLOWED / DENIED / UNKNOWN (timeout, NOT_RUN and anything else are UNKNOWN). */
export function classify(outcome) {
  if (typeof outcome !== "string") return "UNKNOWN";
  const o = outcome.toLowerCase();
  if (o === "not_run" || o === "not-run") return "UNKNOWN";
  if (ALLOW_OUTCOMES.includes(o)) return "ALLOWED";
  if (DENY_OUTCOMES.includes(o)) return "DENIED";
  return "UNKNOWN"; // timeout, error, missing, etc. — never silently a deny
}

/**
 * The required positive controls (must be ALLOWED/PASS) and negative boundaries (must be DENIED) for an overall PASS.
 * The network keys mirror the Phase D canary matrix A..J:
 *   brokerEndpoint=A (allow), brokerWrongPort=B, hostLoopbackIpv4=C, hostOtherPort/hostOtherAddress=D, lanAccess=E,
 *   directInternet=F, directProviderBypass=G, rawSocketBypass=H, brokerProviderRoute=I (allow, host-side),
 *   unauthorizedDestinationThroughBroker=J, dnsGateway (UDP/53 to the gateway must be DENIED).
 */
export const REQUIRED_ALLOW = Object.freeze(["brokerEndpoint", "brokerProviderRoute", "viewRead", "scratchWrite"]);
export const REQUIRED_DENY = Object.freeze([
  "brokerWrongPort", "hostLoopbackIpv4", "hostOtherPort", "hostOtherAddress", "lanAccess", "directInternet",
  "directProviderBypass", "rawSocketBypass", "dnsGateway", "unauthorizedDestinationThroughBroker",
  "viewWrite", "primaryAccess", "siblingAccess", "controlPlaneAccess", "hostProfileAccess",
]);
export const REQUIRED_PASS = Object.freeze([
  "processTreeContainment", "forcedKillCleanup", "workerCleanup",
  "noStaleNetworkPolicy", "noStaleMounts", "noStaleProcess", "noBroadHostMount", "noDockerPipe", "hostWorkspaceUncontaminated",
]);

/**
 * The FOCUSED network-boundary requirement set — exactly what proves BROKER_ONLY_NETWORK_BOUNDARY, independently of the
 * filesystem/view-grant proofs (which belong to a separate combined gate). This is the subset the network PoC measures:
 * the worker reaches the broker (and the broker reaches the synthetic provider) and NOTHING else, plus the lifecycle
 * facts this PoC owns (process/forced-kill/stale cleanup, no broad mount, no docker pipe, host workspace uncontaminated).
 */
export const REQUIRED_NETWORK_ALLOW = Object.freeze(["brokerEndpoint", "brokerProviderRoute"]);
export const REQUIRED_NETWORK_DENY = Object.freeze([
  "brokerWrongPort", "hostLoopbackIpv4", "hostOtherPort", "hostOtherAddress", "lanAccess", "directInternet",
  "directProviderBypass", "rawSocketBypass", "dnsGateway", "unauthorizedDestinationThroughBroker",
]);
export const REQUIRED_NETWORK_PASS = Object.freeze([
  "processTreeContainment", "forcedKillCleanup", "workerCleanup",
  "noStaleNetworkPolicy", "noStaleProcess", "noBroadHostMount", "noDockerPipe", "hostWorkspaceUncontaminated",
]);

/**
 * Computes the overall verdict from a results object whose values are ALLOWED/DENIED/PASS/FAIL/UNKNOWN strings. Returns
 * `{ verdict, reasons }` where verdict is PASS only if every requirement is met; FAIL if any boundary is violated; and
 * INCOMPLETE if any required field is UNKNOWN/missing (UNKNOWN is NEVER promoted to PASS).
 */
function evaluateWith(results, allow, deny, pass) {
  const r = results ?? {};
  const reasons = [];
  let incomplete = false, failed = false;
  const need = (key, want) => {
    const v = (r[key] ?? "UNKNOWN");
    if (v === "UNKNOWN" || v === NOT_RUN) { incomplete = true; reasons.push(`${key}: ${v === NOT_RUN ? "NOT_RUN" : "UNKNOWN"} (needs proof)`); return; }
    if (v !== want) { failed = true; reasons.push(`${key}: ${v}, required ${want}`); }
  };
  for (const key of allow) need(key, "ALLOWED");
  for (const key of deny) need(key, "DENIED");
  for (const key of pass) need(key, "PASS");
  // A run is PASS only when nothing failed AND nothing is incomplete.
  const verdict = failed ? "FAIL" : incomplete ? "INCOMPLETE" : "PASS";
  return Object.freeze({ verdict, reasons: Object.freeze(reasons) });
}

/** The FULL HARD PoC verdict (network + filesystem + lifecycle). PASS only when every dimension is proven. */
export function evaluate(results) {
  return evaluateWith(results, REQUIRED_ALLOW, REQUIRED_DENY, REQUIRED_PASS);
}

/** The FOCUSED network-boundary verdict — what BROKER_ONLY_NETWORK_BOUNDARY=PROVEN requires (no FS grants). */
export function evaluateNetwork(results) {
  return evaluateWith(results, REQUIRED_NETWORK_ALLOW, REQUIRED_NETWORK_DENY, REQUIRED_NETWORK_PASS);
}

/**
 * The network verdict for ONE target, combining the worker's own attempt with a HOST POSITIVE CONTROL (the trusted host
 * attempting the identical target). This is how a silent VFP drop is distinguished from "the target was never reachable":
 *   - worker ALLOWED                     → ALLOWED (a reachable target; for a deny-target this is an ESCAPE → FAIL later)
 *   - worker actively DENIED (refused/reset/no-route) → DENIED (no control needed; the stack said no)
 *   - worker ATTEMPTED-but-dropped (exactly "timeout") AND host control ALLOWED → DENIED (service up, host reaches it,
 *                                         worker cannot — isolation proven, NOT a bare timeout)
 *   - worker UNKNOWN for any OTHER reason (a harness "error:*", "not_run", or an unrecognized token) → UNKNOWN even if
 *                                         the host could reach it: the worker did not actually probe, so nothing is
 *                                         proven. This fail-closed rule keeps a malformed canary tuple / harness error
 *                                         from being mis-credited as a DENIED boundary (it strictly reduces false denies).
 *   - worker UNKNOWN AND host control NOT ALLOWED → UNKNOWN (can't prove anything; INCOMPLETE, never PASS)
 * A bare timeout with no positive control, and any harness error, are therefore never promoted to a proven deny.
 */
export function networkVerdict(workerOutcome, hostControlOutcome) {
  const w = classify(workerOutcome), h = classify(hostControlOutcome);
  if (w === "ALLOWED") return "ALLOWED";
  if (w === "DENIED") return "DENIED";
  // Only a genuine attempted-but-dropped probe ("timeout") may be promoted by a host positive control; a harness error
  // / not_run / unrecognized outcome means the probe did not run and can never be a proven deny.
  const attemptedTimeout = typeof workerOutcome === "string" && workerOutcome.trim().toLowerCase() === "timeout";
  if (attemptedTimeout && h === "ALLOWED") return "DENIED"; // worker couldn't, host could → isolation, not unreachability
  return "UNKNOWN";
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
