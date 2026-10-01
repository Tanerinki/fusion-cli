// Fusion v0.6 Hyper-V PoC — broker canaries I and J (host-side). Reuses the PRODUCTION broker
// (dist/src/platform/network/provider-broker.js) — no security logic is duplicated here. Proves, against the synthetic
// provider stand-in listener that provision.ps1 started on <brokerIp>:<providerPort>:
//   I  brokerProviderRoute                 = the broker CONNECT-tunnels to the allowed provider destination  → connected
//   J  unauthorizedDestinationThroughBroker = the broker refuses another destination (wrong port)            → refused
// Prints a JSON line. If dist is not built, both are "not_run" (→ INCOMPLETE, never a silent pass).
import net from "node:net";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [brokerIp = "10.250.37.1", providerPortStr = "47630"] = process.argv.slice(2);
const providerPort = Number(providerPortStr);
const wrongPort = providerPort + 1;

const distPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "src", "platform", "network", "provider-broker.js");
let startProviderBroker;
try { ({ startProviderBroker } = await import(pathToFileURL(distPath).href)); }
catch { console.log(JSON.stringify({ brokerProviderRoute: "not_run", unauthorizedDestinationThroughBroker: "not_run", note: "dist not built" })); process.exit(2); }

const policy = Object.freeze({
  executionId: "poc", providerFamily: "synthetic",
  allowedHosts: Object.freeze([brokerIp]), allowedPorts: Object.freeze([providerPort]),
  allowRawIp: true, policyVersion: "0.6.0", policyHash: "poc",
});

function connectThroughBroker(brokerPort, cred, host, port) {
  return new Promise(res => {
    let buf = "", settled = false;
    const s = net.connect(brokerPort, "127.0.0.1", () => {
      const auth = Buffer.from(`fusion:${cred}`, "utf8").toString("base64");
      s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
    });
    const done = o => { if (settled) return; settled = true; try { s.destroy(); } catch {} res(o); };
    s.on("data", d => { buf += d.toString("latin1"); if (buf.includes("\r\n\r\n")) {
      if (/^HTTP\/1\.1 200/u.test(buf)) done("connected");
      else if (/^HTTP\/1\.1 40[37]/u.test(buf)) done("refused");
      else done("blocked");
    } });
    s.on("error", () => done("refused"));
    setTimeout(() => done("timeout"), 4000);
  });
}

const broker = await startProviderBroker(policy);
try {
  const route = await connectThroughBroker(broker.port, broker.credential, brokerIp, providerPort);
  const unauthorized = await connectThroughBroker(broker.port, broker.credential, brokerIp, wrongPort);
  console.log(JSON.stringify({ brokerProviderRoute: route, unauthorizedDestinationThroughBroker: unauthorized }));
} finally {
  await broker.stop();
}
