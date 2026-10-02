// Fusion v0.6 Hyper-V PoC - NETWORK_NONE derivation (pure, unit-tested). Mechanically decides, from facts collected
// INSIDE the worker, whether the worker genuinely has no usable IP network path (only its own loopback) - the structural
// basis for "raw sockets have nowhere to go". Never trusts docker argv alone.

const LOOPBACK_V4 = /^127\./u;

/** True only for loopback addresses (127.0.0.0/8, ::1). */
function loopbackOnlyAddr(a) {
  if (typeof a !== "string") return false;
  return LOOPBACK_V4.test(a) || a === "::1";
}

/**
 * Derives NETWORK_NONE_EFFECTIVE from { interfaces:[{name, addresses:[ip]}], routes:[cidr|dest], dnsServers:[ip] }.
 *   PASS  - every interface address is loopback, there is NO default route (0.0.0.0/0 or ::/0), and no non-loopback DNS.
 *   FAIL  - a non-loopback address, a default route, or a routable DNS server exists (a usable network path).
 *   INCOMPLETE - the facts were not collected (missing/empty) so nothing can be concluded.
 */
export function networkNoneEffective(facts) {
  const f = facts ?? {};
  if (!Array.isArray(f.interfaces) || f.interfaces.length === 0) return { verdict: "INCOMPLETE", reasons: ["no interface facts"] };
  const reasons = [];
  const addrs = f.interfaces.flatMap(i => Array.isArray(i?.addresses) ? i.addresses : []);
  const nonLoopback = addrs.filter(a => typeof a === "string" && a.length > 0 && !loopbackOnlyAddr(a) && !a.toLowerCase().startsWith("fe80")); // link-local v6 w/o a router is not usable egress
  if (nonLoopback.length > 0) reasons.push(`non-loopback address(es): ${nonLoopback.join(", ")}`);
  const routes = Array.isArray(f.routes) ? f.routes.map(String) : [];
  const defaultRoute = routes.some(r => r.includes("0.0.0.0/0") || r.trim().startsWith("0.0.0.0") || r.includes("::/0"));
  if (defaultRoute) reasons.push("a default route exists");
  const dns = (Array.isArray(f.dnsServers) ? f.dnsServers : []).filter(d => typeof d === "string" && d.length > 0 && !loopbackOnlyAddr(d));
  if (dns.length > 0) reasons.push(`routable DNS server(s): ${dns.join(", ")}`);
  return { verdict: reasons.length === 0 ? "PASS" : "FAIL", reasons };
}

export { loopbackOnlyAddr };
