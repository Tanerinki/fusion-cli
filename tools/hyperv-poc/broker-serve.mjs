// Fusion v0.6 Hyper-V PoC — start the REAL production broker (dist/src/platform/network/provider-broker.js) bound to the
// DEDICATED worker-facing IP, so the architecture actually proven is: Hyper-V worker -> real Fusion broker -> synthetic
// provider. No permissive substitute. Writes {port, credential, address} to <credFile> once listening, then serves until
// killed (the orchestrator persists this process's PID and kills it in cleanup). Allowlist permits ONLY the synthetic
// provider stand-in (providerIp:providerPort); any other destination is refused by the broker (proves J from the worker).
//   usage: node broker-serve.mjs <bindIp> <port> <providerIp> <providerPort> <credFile>
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [bindIp, portStr, providerIp, providerPortStr, credFile] = process.argv.slice(2);
if (!bindIp || !portStr || !providerIp || !providerPortStr || !credFile) {
  console.error("usage: node broker-serve.mjs <bindIp> <port> <providerIp> <providerPort> <credFile>"); process.exit(64);
}
const distPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "src", "platform", "network", "provider-broker.js");
let startProviderBroker;
try { ({ startProviderBroker } = await import(pathToFileURL(distPath).href)); }
catch (e) { console.error(`BROKER_ERROR dist not built: ${String(e)}`); process.exit(2); }

const policy = Object.freeze({
  executionId: "poc", providerFamily: "synthetic",
  allowedHosts: Object.freeze([providerIp]), allowedPorts: Object.freeze([Number(providerPortStr)]),
  allowRawIp: true, policyVersion: "0.6.0", policyHash: "poc",
});

const broker = await startProviderBroker(policy, { bindAddress: bindIp, port: Number(portStr) });
writeFileSync(credFile, JSON.stringify({ port: broker.port, credential: broker.credential, address: broker.address }), "utf8");
console.log(`BROKER_READY ${broker.address}:${broker.port} pid=${process.pid}`);
// Keep the process (and the listener) alive until the orchestrator kills it; stop cleanly on signals.
const shutdown = () => { broker.stop().finally(() => process.exit(0)); };
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
setInterval(() => {}, 1 << 30);
