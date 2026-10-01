// v0.6 Hyper-V PoC — the ENDPOINT ACL POLICY BUILDER (pure, unit-tested in CI; no admin, no OS calls).
//
// The broker-only network invariant, expressed as an ENDPOINT-SCOPED VFP ACL (RuleType "Switch"): the worker endpoint
// may open an outbound TCP connection ONLY to the exact Fusion broker IP + port; every other outbound packet (other host
// ports on the same vNIC, host loopback, LAN, Internet, the direct provider endpoint, and UDP/53 DNS to the gateway) is
// BLOCKED. This module builds that ordered rule set and serializes it to BOTH the shapes the host networking stack
// accepts — the legacy HNS v1 endpoint "Policies" array and the HCN v2 `AclPolicySetting` document — so the elevated
// maintainer script can submit whichever the machine's API accepts. It makes NO host change itself; applying the policy
// needs administrator + the HCN API (see docs/v0.6-hyperv-vfp-acl-plan.md). The builder's correctness (allow is exactly
// one destination, the default-block covers everything incl. UDP, allow out-prioritises block) is what CI proves.

/** VFP/HNS ACL enumerations. Protocol numbers are IANA: 6=TCP, 17=UDP. "256" is the HNS "all protocols" marker. */
export const PROTO = Object.freeze({ TCP: "6", UDP: "17", ANY: "256" });
export const ACTION = Object.freeze({ ALLOW: "Allow", BLOCK: "Block" });
export const DIRECTION = Object.freeze({ OUT: "Out", IN: "In" });
/** "Switch" = VFP (the virtual switch port, endpoint-scoped) — what we want; "Host" = WFP (host firewall). */
export const RULE_TYPE = Object.freeze({ SWITCH: "Switch", HOST: "Host" });

/** In HNS/VFP ACLs a NUMERICALLY SMALLER Priority wins. The allow must out-prioritise the default block. */
export const PRIORITY = Object.freeze({ ALLOW_BROKER: 100, BLOCK_DEFAULT: 200 });

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/u;

/** Validates an IPv4 literal (the broker address must be an exact host address, never a range/wildcard here). */
export function isIpv4(addr) {
  return typeof addr === "string" && IPV4_RE.test(addr);
}

/** Validates a TCP port number (1..65535). */
export function isPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Builds the ordered, provider-neutral ACL rule set for the broker-only boundary. Returns a frozen array of abstract
 * rules (highest-precedence first) that the serializers below map to HNS v1 / HCN v2. Throws on an invalid broker
 * address/port so a malformed policy can never be silently serialized.
 *
 * Rule 1 (ALLOW):  Out, TCP, Remote = brokerIp/32, RemotePort = brokerPort,  Priority ALLOW_BROKER (wins).
 * Rule 2 (BLOCK):  Out, ALL protocols, ALL remote addresses/ports,           Priority BLOCK_DEFAULT (default-deny).
 *
 * The default-block deliberately carries NO RemoteAddresses/RemotePorts and ALL protocols, so it also denies UDP/53 DNS
 * to the gateway, other ports on the broker's own host IP, the LAN, the Internet and the direct provider endpoint. The
 * only hole is the single allow rule above.
 */
export function buildBrokerOnlyAcl(brokerIp, brokerPort) {
  if (!isIpv4(brokerIp)) throw new Error(`broker IP must be an IPv4 literal, got: ${JSON.stringify(brokerIp)}`);
  if (!isPort(brokerPort)) throw new Error(`broker port must be 1..65535, got: ${JSON.stringify(brokerPort)}`);
  return Object.freeze([
    Object.freeze({
      id: "allow-broker", action: ACTION.ALLOW, direction: DIRECTION.OUT, protocol: PROTO.TCP,
      remoteAddresses: `${brokerIp}/32`, remotePorts: String(brokerPort), ruleType: RULE_TYPE.SWITCH,
      priority: PRIORITY.ALLOW_BROKER,
    }),
    Object.freeze({
      id: "block-default-out", action: ACTION.BLOCK, direction: DIRECTION.OUT, protocol: PROTO.ANY,
      remoteAddresses: "", remotePorts: "", ruleType: RULE_TYPE.SWITCH, priority: PRIORITY.BLOCK_DEFAULT,
    }),
  ]);
}

/** One HNS v1 endpoint "Policies[]" entry (Type "ACL"). Empty string fields are omitted (HNS treats absence as "all"). */
function toHnsV1Policy(rule) {
  const p = { Type: "ACL", Action: rule.action, Direction: rule.direction, RuleType: rule.ruleType, Priority: rule.priority };
  if (rule.protocol && rule.protocol !== PROTO.ANY) p.Protocols = rule.protocol;
  if (rule.remoteAddresses) p.RemoteAddresses = rule.remoteAddresses;
  if (rule.remotePorts) p.RemotePorts = rule.remotePorts;
  return p;
}

/** The legacy HNS v1 modify document: POST /endpoints/<id> with an apply-policy request carrying the ACL policies. */
export function toHnsV1ModifyDocument(rules) {
  return Object.freeze({
    Policies: rules.map(toHnsV1Policy),
  });
}

/** One HCN v2 `AclPolicySetting` entry ({ Type:"ACL", Settings:{...} }); absence of a field means "all". */
function toHcnPolicy(rule) {
  const s = { Action: rule.action, Direction: rule.direction, RuleType: rule.ruleType, Priority: rule.priority };
  if (rule.protocol && rule.protocol !== PROTO.ANY) s.Protocols = rule.protocol;
  if (rule.remoteAddresses) s.RemoteAddresses = rule.remoteAddresses;
  if (rule.remotePorts) s.RemotePorts = rule.remotePorts;
  return { Type: "ACL", Settings: s };
}

/** The HCN `HcnModifyEndpointSettings` request document (ResourceType Policy, RequestType Update). This is the preferred
 *  mechanism on a modern host; the elevated script submits it via computenetwork.dll. */
export function toHcnModifyRequest(rules) {
  return Object.freeze({
    ResourceType: "Policy",
    RequestType: "Update",
    Settings: { Policies: rules.map(toHcnPolicy) },
  });
}

/**
 * Validates a built rule set against the broker-only invariant, independently of how it was produced (so a hand-edited
 * or round-tripped policy is checked too). Returns `{ ok, reasons }`. Fails if: there is not exactly one outbound ALLOW;
 * the allow is not a single TCP host (/32) + single port; there is no catch-all outbound BLOCK; the block does not
 * out-rank... is out-ranked by nothing (i.e. allow.priority < block.priority); or any rule is not Switch/VFP-scoped.
 */
export function validateBrokerOnlyAcl(rules, expected = {}) {
  const reasons = [];
  if (!Array.isArray(rules)) return { ok: false, reasons: ["not an array"] };
  const out = rules.filter(r => r && r.direction === DIRECTION.OUT);
  const allows = out.filter(r => r.action === ACTION.ALLOW);
  const blocks = out.filter(r => r.action === ACTION.BLOCK);
  if (allows.length !== 1) reasons.push(`expected exactly one outbound ALLOW, got ${allows.length}`);
  const a = allows[0];
  if (a) {
    if (a.protocol !== PROTO.TCP) reasons.push("the broker allow must be TCP");
    if (!/^(\d{1,3}\.){3}\d{1,3}\/32$/u.test(a.remoteAddresses)) reasons.push(`the allow must be a single /32 host, got ${a.remoteAddresses}`);
    if (!/^\d{1,5}$/u.test(a.remotePorts)) reasons.push(`the allow must name a single port, got ${a.remotePorts}`);
    if (a.ruleType !== RULE_TYPE.SWITCH) reasons.push("the allow must be a Switch/VFP rule, not a host-firewall rule");
    if (expected.brokerIp && a.remoteAddresses !== `${expected.brokerIp}/32`) reasons.push(`allow remote ${a.remoteAddresses} != expected ${expected.brokerIp}/32`);
    if (expected.brokerPort && a.remotePorts !== String(expected.brokerPort)) reasons.push(`allow port ${a.remotePorts} != expected ${expected.brokerPort}`);
  }
  const catchAll = blocks.find(b => !b.remoteAddresses && !b.remotePorts && (b.protocol === PROTO.ANY));
  if (!catchAll) reasons.push("missing a catch-all outbound BLOCK (all protocols, all addresses/ports)");
  if (a && catchAll && !(a.priority < catchAll.priority)) reasons.push("the broker ALLOW does not out-prioritise the default BLOCK (smaller priority wins)");
  if (blocks.some(b => b.ruleType !== RULE_TYPE.SWITCH)) reasons.push("every block must be a Switch/VFP rule");
  return { ok: reasons.length === 0, reasons };
}
