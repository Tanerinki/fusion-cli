// Fusion v0.6 Hyper-V PoC - EFFECTIVE-POLICY check. Given the worker endpoint's Policies AFTER HcnModifyEndpoint (re-read
// from the live endpoint), prints ACL_EFFECTIVE=YES|NO based on whether the two expected broker-only ACL rules are
// present. This proves the policy was ACCEPTED/STORED on the endpoint (necessary); it does NOT prove VFP enforcement -
// only the live canaries do that (an ICS/internal endpoint can even show the stored policy yet not enforce it).
//   usage: node acl-effective.mjs <effective-endpoint.json> <brokerIp> <brokerPort>
import { readJsonFile } from "./json-io.mjs";
import { aclRulesPresent } from "./acl-policy.mjs";

const [path, brokerIp, brokerPortStr] = process.argv.slice(2);
if (!path || !brokerIp || !brokerPortStr) { console.error("usage: node acl-effective.mjs <effective-endpoint.json> <brokerIp> <brokerPort>"); process.exit(64); }
let doc;
try { doc = readJsonFile(path); } catch (e) { console.log("ACL_EFFECTIVE=NO (effective-endpoint unreadable)"); console.error(String(e)); process.exit(2); }
// Accept an endpoint object, a {Policies:[...]} wrapper, or a raw array of policies.
const policies = Array.isArray(doc) ? doc : (doc.Policies ?? doc.policies ?? doc.endpoint?.Policies ?? []);
const r = aclRulesPresent(policies, brokerIp, Number(brokerPortStr));
console.log(`ACL_EFFECTIVE=${r.present ? "YES" : "NO"} (allow=${r.allowFound} block=${r.blockFound} aclCount=${r.aclCount})`);
process.exit(r.present ? 0 : 2);
