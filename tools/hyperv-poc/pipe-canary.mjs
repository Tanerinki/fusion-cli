// Fusion v0.6 Hyper-V PoC - GUEST CANARY (runs INSIDE the --network none worker). Collects bounded network-none facts,
// attempts every adversarial path, and emits ONE PROBE_JSON line. NO secrets beyond the per-run broker credential it was
// given. It is deliberately hostile: it ignores HTTPS_PROXY for raw attempts, opens the mapped pipe directly, tries
// unrelated host pipes, and guesses other run pipe names.
import net from "node:net";
import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import { encodeAuth, encodeFrame, decodeFrames, FRAME } from "./pipe-protocol.mjs";

const spec = JSON.parse(Buffer.from(process.env.FUSION_PIPE_SPEC || "e30=", "base64").toString("utf8"));
const MS = Number(spec.ms) || 4000, TOKEN = String(spec.token || "FUSION_POC_TOKEN");

function rawTcp(host, port) { // raw socket, ignores any HTTPS_PROXY
  return new Promise(res => {
    const t0 = Date.now(); let done = false, conn = false;
    const s = net.connect({ host, port });
    const fin = o => { if (done) return; done = true; try { s.destroy(); } catch {} res({ outcome: o, ms: Date.now() - t0 }); };
    s.once("connect", () => { conn = true; fin("connected"); });
    s.once("error", e => fin(e.code === "ECONNREFUSED" ? "refused" : (e.code === "ENETUNREACH" || e.code === "EHOSTUNREACH" || e.code === "EADDRNOTAVAIL") ? "unreachable" : conn ? "reset" : "blocked"));
    setTimeout(() => fin(conn ? "connected" : "timeout"), MS);
  });
}
function rawDns(server) {
  return new Promise(res => {
    const t0 = Date.now(); let done = false; const s = dgram.createSocket("udp4");
    const q = Buffer.from("abcd01000001000000000000076578616d706c6503636f6d0000010001", "hex");
    const fin = o => { if (done) return; done = true; try { s.close(); } catch {} res({ outcome: o, ms: Date.now() - t0 }); };
    s.on("message", () => fin("answered")); s.on("error", () => fin("blocked"));
    s.send(q, 53, server, e => { if (e) fin("blocked"); }); setTimeout(() => fin("timeout"), MS);
  });
}
// Open the mapped pipe directly and run one AUTH exchange. Returns connected (AUTH_OK + token echo) / refused / blocked.
function pipeAttempt(pipePath, credential, destHost, destPort) {
  return new Promise(res => {
    let buf = Buffer.alloc(0), done = false, body = ""; const t0 = Date.now();
    const p = net.connect(pipePath);
    const fin = o => { if (done) return; done = true; try { p.destroy(); } catch {} res({ outcome: o, tokenEchoed: body.includes(TOKEN), ms: Date.now() - t0 }); };
    p.once("connect", () => { if (credential === null) { p.write(encodeFrame(FRAME.DATA, "no-auth")); } else { p.write(encodeAuth(credential, destHost, destPort)); } });
    p.on("data", d => { buf = Buffer.concat([buf, d]); const { frames, rest, error } = decodeFrames(buf); buf = Buffer.from(rest); if (error) return fin("blocked");
      for (const f of frames) { if (f.type === FRAME.AUTH_OK) { p.write(encodeFrame(FRAME.DATA, TOKEN + "\n")); } else if (f.type === FRAME.REJECT) return fin("refused"); else if (f.type === FRAME.DATA) { body += f.payload.toString("latin1"); if (body.includes(TOKEN)) return fin("connected"); } } });
    p.once("error", e => fin(e.code === "ENOENT" ? "refused" : "blocked"));
    setTimeout(() => fin(body ? "connected" : "timeout"), MS);
  });
}
function openHostPipe(pipePath) { // attempt to OPEN (not enumerate) an unrelated host pipe
  return new Promise(res => {
    let done = false; const p = net.connect(pipePath);
    const fin = o => { if (done) return; done = true; try { p.destroy(); } catch {} res(o); };
    p.once("connect", () => fin("connected")); p.once("error", e => fin(e.code === "ENOENT" ? "refused" : "blocked"));
    setTimeout(() => fin("timeout"), 2000);
  });
}

(async () => {
  const out = { marker: "FUSION_PIPE_CANARY", facts: {}, raw: {}, dns: {}, pipe: {}, otherPipes: {}, pids: {}, proxyEnvPresent: Boolean(process.env.HTTPS_PROXY) };
  // ALLOWED ROUTE (A): provider -> loopback shim (127.0.0.1:shimPort) -> pipe -> broker -> synthetic provider, token echo.
  if (spec.shimPort) {
    out.pipe.allowedRoute = await new Promise(res => {
      let buf = "", done = false, status = 0, body = ""; const t0 = Date.now();
      const s = net.connect({ host: "127.0.0.1", port: spec.shimPort });
      const fin = o => { if (done) return; done = true; try { s.destroy(); } catch {} res({ outcome: o, status, tokenEchoed: body.includes(TOKEN), ms: Date.now() - t0 }); };
      s.once("connect", () => s.write(`CONNECT ${spec.allowedHost}:${spec.allowedPort} HTTP/1.1\r\nHost: ${spec.allowedHost}:${spec.allowedPort}\r\n\r\n`));
      s.on("data", d => { const str = d.toString("latin1"); if (status === 0) { buf += str; const m = /^HTTP\/1\.1 (\d+)/u.exec(buf); if (m) status = Number(m[1]); const e = buf.indexOf("\r\n\r\n"); if (status >= 400) return fin("refused"); if (status === 200 && e >= 0) { body += buf.slice(e + 4); s.write(TOKEN + "\n"); } } else { body += str; } if (status === 200 && body.includes(TOKEN)) fin("connected"); });
      s.once("error", () => fin(status === 0 ? "blocked" : "reset"));
      setTimeout(() => fin(status === 200 ? "connected" : "timeout"), MS);
    });
    out.pipe.allowedRouteTokenEchoed = out.pipe.allowedRoute.tokenEchoed === true;
  }
  // network-none facts (interfaces/routes/dns) collected from inside the worker
  const nics = os.networkInterfaces();
  out.facts.interfaces = Object.entries(nics).map(([name, addrs]) => ({ name, addresses: (addrs || []).map(a => a.address) }));
  try { out.facts.routes = (await import("node:child_process")).execSync("route print -4", { encoding: "utf8", timeout: 8000 }).split(/\r?\n/).filter(l => /0\.0\.0\.0/.test(l)); } catch { out.facts.routes = []; }
  try { const connStr = (await import("node:child_process")).execSync("ipconfig /all", { encoding: "utf8", timeout: 8000 }); out.facts.dnsServers = (connStr.match(/DNS Servers[^\n]*:\s*([0-9.]+)/g) || []).map(s => s.replace(/.*:\s*/, "")); } catch { out.facts.dnsServers = []; }
  // raw off-box attempts (structural deny expected under --network none)
  for (const [k, h, p] of spec.rawTcp || []) out.raw[k] = await rawTcp(h, p);
  if (spec.dns) out.dns = await rawDns(spec.dns);
  // direct-pipe adversary (I)
  const pp = spec.pipePath;
  if (pp) {
    out.pipe.directNoAuth = await pipeAttempt(pp, null, spec.allowedHost, spec.allowedPort);
    out.pipe.directWrongCred = await pipeAttempt(pp, "wrong-" + "x".repeat(60), spec.allowedHost, spec.allowedPort);
    out.pipe.directWrongDest = await pipeAttempt(pp, spec.credential, spec.allowedHost, (Number(spec.allowedPort) + 1));
    out.pipe.directAuthorized = await pipeAttempt(pp, spec.credential, spec.allowedHost, spec.allowedPort);
    out.pipe.unauthorizedDestThroughBroker = out.pipe.directWrongDest; // same gate, different label for the matrix
  }
  // pipe-name guessing (K)
  for (const g of spec.guessPipes || []) out.otherPipes["guess:" + g] = await openHostPipe(g);
  // other host pipes (J) - OPEN attempts, not enumeration
  for (const hp of spec.otherHostPipes || []) out.otherPipes["host:" + hp] = await openHostPipe(hp);
  // spawn child/grandchild for the process-tree canary
  if (spec.spawn) { try { const cp = await import("node:child_process"); const c = cp.spawn(process.execPath, ["-e", "setTimeout(()=>{},600000)"], { detached: false }); out.pids = { self: process.pid, child: c.pid }; } catch (e) { out.pids = { error: String(e && e.code) }; } }
  process.stdout.write("PROBE_JSON " + JSON.stringify(out) + "\n");
  if (spec.hold) setTimeout(() => {}, 600000);
})();
