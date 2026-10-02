// Fusion v0.6 Hyper-V PoC - GUEST SHIM (runs INSIDE the worker). Convenience/compatibility only - NOT a security
// boundary (the host broker stays safe even if the payload ignores it and opens the pipe directly). Listens on the
// worker's own loopback 127.0.0.1:<port>, accepts HTTP CONNECT (the provider's HTTPS_PROXY), authenticates to the host
// broker over the mapped named pipe with the per-run credential, and relays bytes. It can ONLY reach the single
// host-approved destination (the broker enforces that); the shim never widens authority.
//   usage: node guest-shim.mjs <listenPort> <pipePath> <credential> <allowedHost> <allowedPort>
import http from "node:http";
import net from "node:net";
import { encodeAuth, encodeFrame, decodeFrames, FRAME } from "./pipe-protocol.mjs";

const [portStr, pipePath, credential, allowedHost, allowedPortStr] = process.argv.slice(2);
const port = Number(portStr), allowedPort = Number(allowedPortStr);
if (!port || !pipePath || !credential || !allowedHost || !allowedPort) { console.error("usage: node guest-shim.mjs <port> <pipe> <cred> <host> <port>"); process.exit(64); }

const server = http.createServer((_q, res) => { res.writeHead(405).end("method not allowed"); }); // no plain-HTTP proxy surface
const log = (...a) => { try { process.stderr.write("SHIM " + a.join(" ") + "\n"); } catch {} };
server.on("connect", (req, client, head) => {
  client.on("error", () => {});
  const [h, p] = String(req.url ?? "").split(":");
  log("connect", h + ":" + p, "head=" + (head ? head.length : 0));
  // Open the mapped pipe and authenticate for exactly this destination; the broker is the authority.
  const pipe = net.connect(pipePath);
  let buf = Buffer.alloc(0), established = false, toClient = 0, toPipe = 0;
  const fail = (code, text) => { log("fail", code, text, "toClient=" + toClient); try { client.write(`HTTP/1.1 ${code} ${text}\r\n\r\n`); } catch {} client.destroy(); try { pipe.destroy(); } catch {} };
  pipe.on("error", e => { log("pipe-error", e && e.code); fail(502, "Bad Gateway"); });
  pipe.on("close", () => log("pipe-close", "established=" + established, "toClient=" + toClient));
  client.on("close", () => log("client-close", "toClient=" + toClient, "toPipe=" + toPipe));
  pipe.once("connect", () => { log("pipe-connect auth"); pipe.write(encodeAuth(credential, h, Number(p))); if (head && head.length) { /* buffered until AUTH_OK */ } });
  // ALWAYS deframe the pipe stream (the broker sends framed AUTH_OK/DATA/REJECT). The earlier shortcut of writing raw
  // pipe bytes to the client once established corrupted the downstream (the provider's bytes are DATA frames, not raw),
  // which dropped/garbled the provider->worker direction. Maintain one decode buffer for the whole connection.
  pipe.on("data", d => {
    buf = Buffer.concat([buf, d]);
    const { frames, rest, error } = decodeFrames(buf); buf = Buffer.from(rest);
    log("pipe-data", "bytes=" + d.length, "frames=" + frames.map(f => f.type).join(",") || "0", "rest=" + buf.length, "err=" + Boolean(error));
    if (error) return fail(502, "Bad Gateway");
    for (const f of frames) {
      if (f.type === FRAME.AUTH_OK) { if (!established) { log("auth-ok -> 200"); established = true; client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head && head.length) pipe.write(encodeFrame(FRAME.DATA, head)); } }
      else if (f.type === FRAME.REJECT) { log("reject", f.payload.toString("latin1").slice(0, 40)); return fail(403, "Forbidden"); }
      else if (f.type === FRAME.DATA) { if (established) { toClient += f.payload.length; client.write(f.payload); } else log("data-before-established", f.payload.length); }
    }
  });
  client.on("data", c => { if (established) { toPipe += c.length; pipe.write(encodeFrame(FRAME.DATA, c)); } else log("client-data-before-established", c.length); });
  client.on("close", () => { try { pipe.destroy(); } catch {} });
});
server.listen(port, "127.0.0.1", () => console.log(`SHIM_READY 127.0.0.1:${port} -> ${pipePath} (dest ${allowedHost}:${allowedPort})`));
