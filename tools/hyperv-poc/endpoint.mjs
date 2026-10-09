// v0.6 Hyper-V PoC — WORKER ENDPOINT DISCOVERY (pure, unit-tested; no admin, no OS calls).
//
// Before an ACL can be applied, the harness must identify the EXACT HNS/HCN endpoint that belongs to the synthetic
// worker — never a guess, never a different container's endpoint. This module joins what `docker inspect` reports for
// the worker (its PoC-network id + its assigned IP) against the `Get-HnsEndpoint` listing, and returns the single
// matching HNS endpoint id, or a typed non-result (NONE / AMBIGUOUS / MALFORMED). Deterministic so the elevated script
// never mutates the wrong endpoint: if discovery is not unambiguous, the run is INCOMPLETE and applies nothing.

/** Normalizes a GUID-ish id for comparison (strip braces, lowercase). */
function normId(v) {
  return typeof v === "string" ? v.replace(/[{}]/gu, "").trim().toLowerCase() : "";
}

/** Coerces a Get-HnsEndpoint payload (single object or array, possibly already parsed) into an array of endpoints. */
export function asEndpointArray(payload) {
  if (payload === null || payload === undefined) return [];
  return Array.isArray(payload) ? payload : [payload];
}

/**
 * Finds the one HNS endpoint belonging to the worker. `selector` carries the facts `docker inspect` gives us:
 *   { networkId:  the PoC network's HNS id (com.docker.network.windowsshim.hnsid),
 *     ipAddress:  the worker's assigned IPv4 on that network }
 * An endpoint matches when its VirtualNetwork id equals networkId AND its IPAddress equals ipAddress. Returns:
 *   { status: "FOUND", endpointId, endpoint }      exactly one match
 *   { status: "NONE" }                             no endpoint matched
 *   { status: "AMBIGUOUS", candidates:[ids] }      more than one matched (never pick one)
 *   { status: "MALFORMED", reason }                the selector or the listing is unusable
 */
export function findWorkerEndpoint(endpoints, selector) {
  const sel = selector ?? {};
  const wantNet = normId(sel.networkId);
  const wantIp = typeof sel.ipAddress === "string" ? sel.ipAddress.trim() : "";
  if (!wantNet) return { status: "MALFORMED", reason: "selector.networkId missing" };
  if (!wantIp) return { status: "MALFORMED", reason: "selector.ipAddress missing" };
  const arr = asEndpointArray(endpoints);
  if (arr.length === 0) return { status: "NONE" };
  const matches = [];
  for (const ep of arr) {
    if (ep === null || typeof ep !== "object") return { status: "MALFORMED", reason: "an endpoint entry is not an object" };
    const id = ep.Id ?? ep.ID ?? ep.id;
    if (typeof id !== "string" || id.length === 0) return { status: "MALFORMED", reason: "an endpoint entry has no Id" };
    const epNet = normId(ep.VirtualNetwork ?? ep.VirtualNetworkId ?? ep.NetworkId);
    const epIp = typeof ep.IPAddress === "string" ? ep.IPAddress.trim() : (typeof ep.IpAddress === "string" ? ep.IpAddress.trim() : "");
    if (epNet === wantNet && epIp === wantIp) matches.push({ id, endpoint: ep });
  }
  if (matches.length === 0) return { status: "NONE" };
  if (matches.length > 1) return { status: "AMBIGUOUS", candidates: matches.map(m => m.id) };
  return { status: "FOUND", endpointId: matches[0].id, endpoint: matches[0].endpoint };
}

/**
 * Extracts the worker's (networkId, ipAddress) from a `docker inspect <container>` JSON for a given Docker network name.
 * Returns { ok, networkId, ipAddress } or { ok:false, reason }. `networkId` is the HNS id carried in the network's
 * `com.docker.network.windowsshim.hnsid` option — the same id `Get-HnsEndpoint` reports as VirtualNetwork.
 */
export function workerSelectorFromInspect(inspectJson, networkName, hnsNetworkId) {
  const arr = Array.isArray(inspectJson) ? inspectJson : [inspectJson];
  const c = arr[0];
  if (!c || typeof c !== "object") return { ok: false, reason: "docker inspect produced no container object" };
  const nets = c.NetworkSettings?.Networks;
  if (!nets || typeof nets !== "object") return { ok: false, reason: "no NetworkSettings.Networks" };
  const net = nets[networkName];
  if (!net || typeof net !== "object") return { ok: false, reason: `the worker is not attached to network '${networkName}'` };
  const ip = typeof net.IPAddress === "string" ? net.IPAddress.trim() : "";
  if (!ip) return { ok: false, reason: "the worker has no IPAddress on the PoC network (not started?)" };
  // Prefer the explicitly-passed HNS id (from `docker network inspect`); fall back to any id Docker echoed on the endpoint.
  const networkId = hnsNetworkId ?? net.NetworkID ?? net.NetworkId ?? "";
  if (!networkId) return { ok: false, reason: "no HNS network id available to bind the endpoint" };
  return { ok: true, networkId, ipAddress: ip };
}
