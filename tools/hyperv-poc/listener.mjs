// Fusion v0.6 Hyper-V PoC — a single explicitly-owned TCP token-echo listener (a native process, NOT a PowerShell job,
// so ownership is a real OS PID the orchestrator persists and kills). Binds <ip>:<port> and writes the per-run token to
// every client, so (a) the worker's canary can confirm a real round-trip and (b) the host positive control can confirm
// the target is genuinely reachable. Prints "LISTENER_READY <ip>:<port> pid=<pid>" once bound, then serves until killed.
//   usage: node listener.mjs <ip> <port> <token>
import net from "node:net";
const [ip, portStr, token = "FUSION_POC_TOKEN"] = process.argv.slice(2);
const port = Number(portStr);
if (!ip || !Number.isInteger(port)) { console.error("usage: node listener.mjs <ip> <port> <token>"); process.exit(64); }
const server = net.createServer(sock => {
  sock.on("error", () => {});
  sock.write(token + "\n");
  setTimeout(() => { try { sock.end(); } catch {} }, 1000);
});
server.on("error", e => { console.error(`LISTENER_ERROR ${ip}:${port} ${e.code || e.message}`); process.exit(1); });
server.listen(port, ip, () => { console.log(`LISTENER_READY ${ip}:${port} pid=${process.pid}`); });
