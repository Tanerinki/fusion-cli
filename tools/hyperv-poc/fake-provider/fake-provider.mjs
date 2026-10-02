// Fusion v0.6 Hyper-V PoC — FAKE provider / canary, runs INSIDE the worker (node on nanoserver). NO secrets, NO real
// model. Emits ONE machine-readable JSON line (PROBE_JSON {...}) with per-target socket outcomes, a UDP/DNS probe, real
// filesystem read/write outcomes, and process-tree markers. It uses RAW sockets (node net.connect does NOT honour
// HTTP(S)_PROXY), so a "connected" to an off-allowlist target is a genuine network-layer escape, not a proxy artefact.
// The allowed-broker canary exchanges a per-run token so a real round-trip is distinguished from a half-open accept.
import net from "node:net";
import dgram from "node:dgram";
import fs from "node:fs";
import { spawn } from "node:child_process";

const spec = JSON.parse(Buffer.from(process.env.FUSION_PROBE_SPEC || "e30=", "base64").toString("utf8"));
const MS = Number(spec.ms) || 4000;
const TOKEN = String(spec.token || "FUSION_POC_TOKEN");

function tcp(host, port) {
  return new Promise(res => {
    const t0 = Date.now(); let done = false, connected = false, banner = "";
    const s = net.connect({ host, port });
    const fin = (outcome) => { if (done) return; done = true; try { s.destroy(); } catch {} res({ outcome, tokenEchoed: banner.includes(TOKEN), ms: Date.now() - t0 }); };
    s.once("connect", () => { connected = true; s.write(TOKEN + "\n"); });
    s.on("data", d => { banner += d.toString("latin1"); });
    s.once("error", e => fin((connected ? "reset:" : "") + (e.code === "ECONNREFUSED" ? "refused" : (e.code === "ENETUNREACH" || e.code === "EHOSTUNREACH") ? "unreachable" : connected ? "reset" : "blocked")));
    setTimeout(() => fin(connected ? "connected" : "timeout"), MS);
  });
}

// An HTTP CONNECT through the REAL Fusion broker to a destination, using the per-run broker credential. Proves the
// worker -> broker -> provider route (200 + token echo = connected) and that the broker refuses an unauthorized
// destination (403 = refused). This is the intended architecture, not a raw socket to a permissive listener.
function connectVia(proxyHost, proxyPort, cred, destHost, destPort) {
  return new Promise(res => {
    const t0 = Date.now(); let done = false, status = 0, body = "";
    const s = net.connect({ host: proxyHost, port: proxyPort });
    const fin = o => { if (done) return; done = true; try { s.destroy(); } catch {} res({ outcome: o, status, tokenEchoed: body.includes(TOKEN), ms: Date.now() - t0 }); };
    s.once("connect", () => {
      const auth = Buffer.from(`fusion:${cred}`, "utf8").toString("base64");
      s.write(`CONNECT ${destHost}:${destPort} HTTP/1.1\r\nHost: ${destHost}:${destPort}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
    });
    let hdr = "";
    s.on("data", d => {
      const str = d.toString("latin1");
      if (status === 0) {
        hdr += str; const m = /^HTTP\/1\.1 (\d+)/u.exec(hdr); if (m) status = Number(m[1]);
        const end = hdr.indexOf("\r\n\r\n");
        if (status >= 400) return fin("refused");
        if (status === 200 && end >= 0) { body += hdr.slice(end + 4); s.write(TOKEN + "\n"); } // tunnel open: send token, await echo
      } else { body += str; }
      if (status === 200 && body.includes(TOKEN)) fin("connected");
    });
    s.once("error", () => fin(status === 0 ? "blocked" : "reset"));
    setTimeout(() => fin(status === 200 ? "connected" : status >= 400 ? "refused" : "timeout"), MS);
  });
}

function dns(server) {
  return new Promise(res => {
    const t0 = Date.now(); let done = false;
    const s = dgram.createSocket("udp4");
    // A minimal A-query for example.com.
    const q = Buffer.from("abcd01000001000000000000076578616d706c6503636f6d0000010001", "hex");
    const fin = (o) => { if (done) return; done = true; try { s.close(); } catch {} res({ outcome: o, ms: Date.now() - t0 }); };
    s.on("message", () => fin("answered"));
    s.on("error", e => fin(e.code === "ECONNREFUSED" ? "refused" : "blocked"));
    s.send(q, 53, server, err => { if (err) fin("blocked"); });
    setTimeout(() => fin("timeout"), MS);
  });
}

(async () => {
  const out = { marker: "FUSION_POC_FAKE_PROVIDER", tcp: {}, connect: {}, dns: {}, fs: {}, pids: {}, proxyEnvPresent: Boolean(process.env.HTTPS_PROXY || process.env.HTTP_PROXY) };
  for (const [host, port, key] of spec.tcp || []) out.tcp[key] = await tcp(host, port);
  for (const c of spec.connect || []) out.connect[c.key] = await connectVia(c.proxyHost, c.proxyPort, c.cred, c.destHost, c.destPort);
  for (const [server, key] of spec.dns || []) out.dns[key] = await dns(server);
  for (const [path, key] of spec.reads || []) { try { fs.readFileSync(path); out.fs["read_" + key] = "ok"; } catch { out.fs["read_" + key] = "blocked"; } }
  for (const [path, key] of spec.writes || []) { try { fs.writeFileSync(path, "FUSION_POC_WRITE"); out.fs["write_" + key] = "ok"; } catch { out.fs["write_" + key] = "blocked"; } }
  if (spec.spawn) {
    try {
      const child = spawn(process.execPath, ["-e", "const{spawn}=require('child_process');spawn(process.execPath,['-e','setTimeout(()=>{},600000)'],{detached:false});setTimeout(()=>{},600000)"], { detached: false });
      out.pids = { self: process.pid, child: child.pid };
    } catch (e) { out.pids = { error: String(e && e.code) }; }
  }
  process.stdout.write("PROBE_JSON " + JSON.stringify(out) + "\n");
  if (spec.hold) { setTimeout(() => {}, 600000); } // stay alive until the worker is cancelled/killed (lifecycle test)
})();
