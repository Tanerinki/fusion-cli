// Fusion v0.6 Hyper-V PoC - synthetic HOST-side token provider (the ONE approved destination; runs on the host, NOT in
// the worker image). Async (net.createServer handles concurrent broker connections, unlike the earlier sequential
// PowerShell Start-Job listener), writes the per-run token on connect, DRAINS whatever the client forwards so the
// subsequent close is a graceful FIN - never a hard RST that would discard the broker's in-flight receive buffer (the
// response token) before the slower multi-hop shim path has read it. Bounded diagnostics go to stderr.
//   usage: node token-provider.mjs <ip> <port> <token> [tag]
import net from "node:net";

const [ip, portStr, token, tag] = process.argv.slice(2);
const port = Number(portStr);
if (!ip || !port || !token) { console.error("usage: node token-provider.mjs <ip> <port> <token> [tag]"); process.exit(64); }
const log = (...a) => { try { process.stderr.write("PROV" + (tag ? ":" + tag : "") + " " + a.join(" ") + "\n"); } catch {} };

let n = 0;
const server = net.createServer(s => {
  const id = ++n; let rx = 0;
  s.on("error", e => log(id, "err", e && e.code));
  s.on("data", d => { rx += d.length; });       // DRAIN the forwarded request so close() is a graceful FIN, not an RST
  s.on("close", () => log(id, "close rx=" + rx));
  log(id, "accept -> write token");
  try { s.write(token + "\n"); } catch (e) { log(id, "write-err", e && e.code); }
  setTimeout(() => { try { s.end(); } catch {} }, 1500);  // keep open long enough for the multi-hop read, then FIN
});
server.on("error", e => { log("server-err", e && e.code); process.exit(1); });
server.listen(port, ip, () => console.log(`PROVIDER_READY ${ip}:${port}`));
