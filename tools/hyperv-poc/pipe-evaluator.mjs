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

/**
 * WORKER_RUNTIME_SHAPE: the ACTUAL `docker inspect` mount shape must match the single mapped Fusion pipe - NOT inferred
 * from argv. PASS only when there is exactly one mount, Type == npipe, Source == Destination == the exact per-run pipe,
 * no bind mount, and no Docker engine/HCS control pipe. A wrong/extra/bind/engine mount is FAIL (the shape is
 * observable); a missing inspect is INCOMPLETE. (Network-none is proven separately from inside the guest.)
 */
export function workerRuntimeShapeVerdict(shape, expected) {
  const e = expected ?? {};
  if (!shape || typeof shape !== "object" || !Array.isArray(shape.mounts)) return { verdict: "INCOMPLETE", reasons: ["docker inspect mount shape not collected"] };
  const mounts = shape.mounts;
  const reasons = [];
  if (mounts.length !== 1) reasons.push(`expected exactly one mount, got ${mounts.length}`);
  const m = mounts[0];
  if (m) {
    if (String(m.Type).toLowerCase() !== "npipe") reasons.push(`mount Type '${m.Type}' != npipe`);
    if (e.pipe && String(m.Source) !== String(e.pipe)) reasons.push(`mount Source '${m.Source}' != '${e.pipe}'`);
    if (e.pipe && String(m.Destination) !== String(e.pipe)) reasons.push(`mount Destination '${m.Destination}' != '${e.pipe}'`);
  }
  if (mounts.some(x => String(x.Type).toLowerCase() === "bind")) reasons.push("a bind mount is present");
  if (mounts.some(x => /docker_engine|dockerDesktopLinuxEngine/iu.test(String(x.Source) + "|" + String(x.Destination)))) reasons.push("the Docker engine/HCS control pipe is mapped");
  return { verdict: reasons.length === 0 ? "PASS" : "FAIL", reasons };
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
  const shape = workerRuntimeShapeVerdict(d.runtimeShape, d.runtimeShapeExpected);
  const fs = labelDimensionVerdict(d.filesystem, FS_REQUIRED);
  const proc = labelDimensionVerdict(d.lifecycle, PROC_REQUIRED);
  const cleanup = labelDimensionVerdict(d.cleanup, CLEANUP_REQUIRED);
  // PROVEN requires the pipe transport AND network-none AND the actual docker-inspect runtime shape to all PASS.
  const brokerOnly = (isPass(pipe.verdict) && isPass(net.verdict) && isPass(shape.verdict)) ? "PROVEN" : "NOT_PROVEN";
  const hard = (isPass(pipe.verdict) && isPass(net.verdict) && isPass(shape.verdict) && isPass(fs.verdict) && isPass(proc.verdict)) ? "PASS"
    : [pipe, net, shape, fs, proc].some(x => x.verdict === V.FAIL) ? "FAIL"
      : [pipe, net, shape, fs, proc].some(x => x.verdict === V.EXEC) ? "EXECUTION_ERROR" : "INCOMPLETE";
  return Object.freeze({
    PIPE_TRANSPORT: pipe.verdict, NETWORK_NONE_BOUNDARY: net.verdict, WORKER_RUNTIME_SHAPE: shape.verdict,
    FILESYSTEM_BOUNDARY: fs.verdict, PROCESS_TREE_BOUNDARY: proc.verdict, CLEANUP_BOUNDARY: cleanup.verdict,
    BROKER_ONLY_NETWORK_BOUNDARY: brokerOnly, HYPERV_PIPE_POC: hard,
    reasons: Object.freeze({ pipe: pipe.reasons, network: net.reasons, runtimeShape: shape.reasons, filesystem: fs.reasons, lifecycle: proc.reasons, cleanup: cleanup.reasons }),
  });
}
