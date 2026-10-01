// Fusion v0.6 Hyper-V PoC - mapped-pipe / --network none VERDICT evaluator (pure, unit-tested). Computes the five
// dimension verdicts and the gated BROKER_ONLY_NETWORK_BOUNDARY. UNKNOWN/NOT_RUN is never promoted to PASS; a reachable
// forbidden destination is FAIL; a harness error is EXECUTION_ERROR (classified by run.ps1, surfaced here if present).
import { networkVerdict } from "./evaluator.mjs";
import { networkNoneEffective } from "./network-none.mjs";

const V = Object.freeze({ PASS: "PASS", FAIL: "FAIL", INCOMPLETE: "INCOMPLETE", EXEC: "EXECUTION_ERROR" });
const isPass = v => v === V.PASS;

/** Fold a set of required sub-results into one dimension verdict: FAIL dominates, then EXECUTION_ERROR, then INCOMPLETE. */
function fold(entries) {
  const reasons = [];
  let fail = false, exec = false, incomplete = false;
  for (const [key, got, want] of entries) {
    if (got === want) continue;
    if (got === V.FAIL || (want === "DENIED" && got === "ALLOWED")) { fail = true; reasons.push(`${key}: ${got} (want ${want})`); }
    else if (got === V.EXEC) { exec = true; reasons.push(`${key}: EXECUTION_ERROR`); }
    else { incomplete = true; reasons.push(`${key}: ${got} (want ${want})`); }
  }
  const verdict = fail ? V.FAIL : exec ? V.EXEC : incomplete ? V.INCOMPLETE : V.PASS;
  return { verdict, reasons };
}

/**
 * PIPE_TRANSPORT: the allowed route works AND every unauthorized pipe/broker path is denied.
 *   allowedRoute: "connected"(+token) => PASS input; directNoAuth/directWrongCred/directWrongDest/unauthorizedDest/
 *   pipeGuess are DENY-expected; directAuthorized is ALLOW-expected (a fully-authorized direct client reaches ONLY the
 *   one approved destination - no more authority than the shim).
 */
export function pipeTransportVerdict(r) {
  const d = r ?? {};
  return fold([
    ["allowedRoute", d.allowedRoute === "connected" || d.allowedRoute === "ok" ? V.PASS : (d.allowedRoute === undefined ? "NOT_RUN" : "FAIL"), V.PASS],
    ["allowedRouteTokenEchoed", d.allowedRouteTokenEchoed === true ? V.PASS : (d.allowedRouteTokenEchoed === undefined ? "NOT_RUN" : "FAIL"), V.PASS],
    ["directPipeNoAuth", normDeny(d.directPipeNoAuth), "DENIED"],
    ["directPipeWrongCred", normDeny(d.directPipeWrongCred), "DENIED"],
    ["directPipeWrongDest", normDeny(d.directPipeWrongDest), "DENIED"],
    ["unauthorizedDestThroughBroker", normDeny(d.unauthorizedDestThroughBroker), "DENIED"],
    ["pipeNameGuess", normDeny(d.pipeNameGuess), "DENIED"],
    ["directPipeAuthorized", d.directPipeAuthorized === "connected" || d.directPipeAuthorized === "ok" ? V.PASS : (d.directPipeAuthorized === undefined ? "NOT_RUN" : "FAIL"), V.PASS],
  ]);
}

/** Normalizes a deny-target raw outcome to ALLOWED/DENIED/UNKNOWN (reachable => ALLOWED => FAIL). */
function normDeny(v) {
  if (v === undefined || v === null) return "UNKNOWN";
  const s = String(v).toLowerCase();
  if (["connected", "ok", "allowed", "answered"].includes(s)) return "ALLOWED";
  if (["refused", "blocked", "no-route", "unreachable", "reset", "denied", "rejected"].includes(s)) return "DENIED";
  return "UNKNOWN"; // timeout / not_run -> never a silent pass
}

/**
 * NETWORK_NONE_BOUNDARY: the worker has only loopback (networkNoneEffective PASS) AND every raw off-box attempt is denied
 * (B/C/E/F/H) using a host positive control where one exists (networkVerdict), AND unrelated host pipes cannot be OPENED
 * (J), with ENUMERATION distinguished from OPEN access.
 */
export function networkNoneBoundaryVerdict(r) {
  const d = r ?? {};
  const nn = networkNoneEffective(d.facts);
  const pair = (w, h) => networkVerdict(w, h);
  const ctrl = d.hostControls ?? {};
  const entries = [
    ["networkNoneEffective", nn.verdict, V.PASS],
    ["rawInternet", pair(d.rawInternet, ctrl.rawInternet), "DENIED"],
    ["rawHostLan", pair(d.rawHostLan, ctrl.rawHostLan), "DENIED"],
    ["rawDns", pair(d.rawDns, ctrl.rawDns), "DENIED"],
    ["rawDirectProvider", pair(d.rawDirectProvider, ctrl.rawDirectProvider), "DENIED"],
    ["rawSocketBypass", pair(d.rawSocketBypass, ctrl.rawSocketBypass), "DENIED"],
    ["otherHostPipeOpen", normDeny(d.otherHostPipeOpen), "DENIED"], // OPEN/CONNECT attempt, not enumeration
  ];
  // LAN peer (D) is optional: only required if a positive control existed; otherwise it stays INCOMPLETE-tolerant.
  if (d.rawLanPeer !== undefined) entries.push(["rawLanPeer", pair(d.rawLanPeer, ctrl.rawLanPeer), "DENIED"]);
  const folded = fold(entries);
  return { verdict: folded.verdict, reasons: folded.reasons.concat(nn.reasons.map(x => `networkNone: ${x}`)) };
}

/** A simple PASS/FAIL/NOT_RUN label dimension (filesystem, process-tree, cleanup) from a labels object. */
export function labelDimensionVerdict(labels, required) {
  const r = labels ?? {};
  return fold(required.map(k => [k, r[k] === "PASS" ? V.PASS : r[k] === "FAIL" ? V.FAIL : (r[k] ?? "NOT_RUN"), V.PASS]));
}

export const FS_REQUIRED = Object.freeze(["viewRead", "viewWriteDenied", "scratchWrite", "primaryDenied", "siblingDenied", "controlPlaneDenied", "hostProfileDenied", "noBroadHostMount", "noDockerPipe", "envMinimized"]);
export const PROC_REQUIRED = Object.freeze(["processTreeContainment", "forcedKillCleanup"]);
export const CLEANUP_REQUIRED = Object.freeze(["cleanupOk"]);

/**
 * The overall PoC evaluation. BROKER_ONLY_NETWORK_BOUNDARY = PROVEN only when BOTH the pipe transport and the
 * network-none boundary are PASS (network dimension). Full HARD (hardVerdict) additionally needs filesystem + process.
 */
export function evaluatePipePoc(doc) {
  const d = doc ?? {};
  const pipe = pipeTransportVerdict(d.pipe);
  const net = networkNoneBoundaryVerdict(d.network);
  const fs = labelDimensionVerdict(d.filesystem, FS_REQUIRED);
  const proc = labelDimensionVerdict(d.lifecycle, PROC_REQUIRED);
  const cleanup = labelDimensionVerdict(d.cleanup, CLEANUP_REQUIRED);
  const brokerOnly = (isPass(pipe.verdict) && isPass(net.verdict)) ? "PROVEN" : "NOT_PROVEN";
  const hard = (isPass(pipe.verdict) && isPass(net.verdict) && isPass(fs.verdict) && isPass(proc.verdict)) ? "PASS"
    : [pipe, net, fs, proc].some(x => x.verdict === V.FAIL) ? "FAIL"
      : [pipe, net, fs, proc].some(x => x.verdict === V.EXEC) ? "EXECUTION_ERROR" : "INCOMPLETE";
  return Object.freeze({
    PIPE_TRANSPORT: pipe.verdict, NETWORK_NONE_BOUNDARY: net.verdict, FILESYSTEM_BOUNDARY: fs.verdict,
    PROCESS_TREE_BOUNDARY: proc.verdict, CLEANUP_BOUNDARY: cleanup.verdict,
    BROKER_ONLY_NETWORK_BOUNDARY: brokerOnly, HYPERV_PIPE_POC: hard,
    reasons: Object.freeze({ pipe: pipe.reasons, network: net.reasons, filesystem: fs.reasons, lifecycle: proc.reasons, cleanup: cleanup.reasons }),
  });
}
