// Fusion v0.6 Hyper-V PoC — emit the HCN endpoint-ACL modify request JSON for a broker IP:port (from the pure, CI-tested
// builder). run.ps1 writes this to acl-<RunId>.json and apply-acl.ps1 submits it to the worker endpoint.
//   usage: node acl-cli.mjs <brokerIp> <brokerPort>
import { buildBrokerOnlyAcl, toHcnModifyRequest } from "./acl-policy.mjs";
const [ip, portStr] = process.argv.slice(2);
if (!ip || !portStr) { console.error("usage: node acl-cli.mjs <brokerIp> <brokerPort>"); process.exit(64); }
process.stdout.write(JSON.stringify(toHcnModifyRequest(buildBrokerOnlyAcl(ip, Number(portStr)))));
