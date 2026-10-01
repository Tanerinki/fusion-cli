import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

// The ACL policy builder lives in the (production-separate) PoC harness; imported here only to unit-test its pure logic.
const mod = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "hyperv-poc", "acl-policy.mjs");
const { buildBrokerOnlyAcl, validateBrokerOnlyAcl, toHnsV1ModifyDocument, toHcnModifyRequest, isIpv4, isPort, PROTO, ACTION, DIRECTION, RULE_TYPE, PRIORITY } =
  await import(pathToFileURL(mod).href);

const IP = "10.250.37.1", PORT = 47610;

test("v0.6 Hyper-V ACL: the broker-only policy is one TCP allow to broker/32:port + a catch-all default block", () => {
  const rules = buildBrokerOnlyAcl(IP, PORT);
  assert.equal(rules.length, 2);
  const allow = rules.find((r: any) => r.action === ACTION.ALLOW);
  const block = rules.find((r: any) => r.action === ACTION.BLOCK);
  assert.ok(allow && block, "both an allow and a block exist");
  assert.equal(allow.protocol, PROTO.TCP);
  assert.equal(allow.direction, DIRECTION.OUT);
  assert.equal(allow.remoteAddresses, `${IP}/32`, "allow is a single /32 host, not a range");
  assert.equal(allow.remotePorts, String(PORT));
  assert.equal(allow.ruleType, RULE_TYPE.SWITCH, "endpoint-scoped VFP rule, not a host-firewall rule");
  assert.equal(block.remoteAddresses, "", "the block is a catch-all (all addresses)");
  assert.equal(block.remotePorts, "", "the block is a catch-all (all ports)");
  assert.equal(block.protocol, PROTO.ANY, "the block covers all protocols incl. UDP/53 DNS");
});

test("v0.6 Hyper-V ACL: the allow out-prioritises the default block (smaller priority wins in VFP)", () => {
  const rules = buildBrokerOnlyAcl(IP, PORT);
  const allow = rules.find((r: any) => r.action === ACTION.ALLOW);
  const block = rules.find((r: any) => r.action === ACTION.BLOCK);
  assert.ok(allow.priority < block.priority, "allow priority must be numerically smaller than block");
  assert.equal(allow.priority, PRIORITY.ALLOW_BROKER);
  assert.equal(block.priority, PRIORITY.BLOCK_DEFAULT);
});

test("v0.6 Hyper-V ACL: validateBrokerOnlyAcl accepts the built policy and pins the exact broker endpoint", () => {
  const rules = buildBrokerOnlyAcl(IP, PORT);
  const v = validateBrokerOnlyAcl(rules, { brokerIp: IP, brokerPort: PORT });
  assert.equal(v.ok, true, v.reasons.join("; "));
});

test("v0.6 Hyper-V ACL: a policy that drops the default block, widens the allow, or inverts priority is rejected", () => {
  const base = () => buildBrokerOnlyAcl(IP, PORT).map((r: any) => ({ ...r }));
  const noBlock = base().filter((r: any) => r.action !== ACTION.BLOCK);
  assert.equal(validateBrokerOnlyAcl(noBlock).ok, false, "no default-deny → rejected");
  const widened = base(); widened[0].remoteAddresses = "10.250.37.0/24";
  assert.equal(validateBrokerOnlyAcl(widened).ok, false, "a subnet allow instead of /32 → rejected");
  const widenedPort = base(); widenedPort[0].remotePorts = "";
  assert.equal(validateBrokerOnlyAcl(widenedPort).ok, false, "an all-ports allow → rejected");
  const inverted = base(); inverted[0].priority = 300; inverted[1].priority = 100;
  assert.equal(validateBrokerOnlyAcl(inverted).ok, false, "block out-prioritising allow would still deny the broker → rejected");
  const wrongBroker = base();
  assert.equal(validateBrokerOnlyAcl(wrongBroker, { brokerIp: "10.0.0.9", brokerPort: PORT }).ok, false, "allow must match the expected broker IP");
});

test("v0.6 Hyper-V ACL: a malformed broker address or port is refused at build time (no silent bad policy)", () => {
  assert.throws(() => buildBrokerOnlyAcl("not-an-ip", PORT), /IPv4/u);
  assert.throws(() => buildBrokerOnlyAcl(IP, 0), /port/u);
  assert.throws(() => buildBrokerOnlyAcl(IP, 70000), /port/u);
  assert.equal(isIpv4("10.250.37.1"), true);
  assert.equal(isIpv4("999.1.1.1"), false);
  assert.equal(isPort(47610), true);
  assert.equal(isPort(-1), false);
});

test("v0.6 Hyper-V ACL: HNS v1 serialization emits Type=ACL, Switch rule, allow before the catch-all block", () => {
  const rules = buildBrokerOnlyAcl(IP, PORT);
  const doc: any = toHnsV1ModifyDocument(rules);
  assert.equal(doc.Policies.length, 2);
  const [a, b] = doc.Policies;
  assert.equal(a.Type, "ACL"); assert.equal(a.Action, "Allow"); assert.equal(a.Direction, "Out");
  assert.equal(a.Protocols, "6"); assert.equal(a.RemoteAddresses, `${IP}/32`); assert.equal(a.RemotePorts, String(PORT));
  assert.equal(a.RuleType, "Switch"); assert.equal(a.Priority, PRIORITY.ALLOW_BROKER);
  assert.equal(b.Action, "Block");
  assert.ok(!("RemoteAddresses" in b), "the catch-all block omits RemoteAddresses (HNS: absence = all)");
  assert.ok(!("Protocols" in b), "the catch-all block omits Protocols (all protocols)");
});

test("v0.6 Hyper-V ACL: HCN v2 serialization wraps AclPolicySetting entries in a Policy/Update modify request", () => {
  const rules = buildBrokerOnlyAcl(IP, PORT);
  const req: any = toHcnModifyRequest(rules);
  assert.equal(req.ResourceType, "Policy");
  assert.equal(req.RequestType, "Update");
  assert.equal(req.Settings.Policies.length, 2);
  const a = req.Settings.Policies[0];
  assert.equal(a.Type, "ACL");
  assert.equal(a.Settings.Action, "Allow");
  assert.equal(a.Settings.RemoteAddresses, `${IP}/32`);
  assert.equal(a.Settings.RuleType, "Switch");
});
