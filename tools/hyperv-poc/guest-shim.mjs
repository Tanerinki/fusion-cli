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
server.on("connect", (req, client, head) => {
  client.on("error", () => {});
  const [h, p] = String(req.url ?? "").split(":");
  // Open the mapped pipe and authenticate for exactly this destination; the broker is the authority.
  const pipe = net.connect(pipePath);
  let buf = Buffer.alloc(0), established = false;
  const fail = (code, text) => { try { client.write(`HTTP/1.1 ${code} ${text}\r\n\r\n`); } catch {} client.destroy(); try { pipe.destroy(); } catch {} };
  pipe.on("error", () => fail(502, "Bad Gateway"));
  pipe.once("connect", () => { pipe.write(encodeAuth(credential, h, Number(p))); if (head && head.length) { /* buffered until AUTH_OK */ } });
  // ALWAYS deframe the pipe stream (the broker sends framed AUTH_OK/DATA/REJECT). The earlier shortcut of writing raw
  // pipe bytes to the client once established corrupted the downstream (the provider's bytes are DATA frames, not raw),
  // which dropped/garbled the provider->worker direction. Maintain one decode buffer for the whole connection.
  pipe.on("data", d => {
    buf = Buffer.concat([buf, d]);
    const { frames, rest, error } = decodeFrames(buf); buf = Buffer.from(rest);
    if (error) return fail(502, "Bad Gateway");
    for (const f of frames) {
      if (f.type === FRAME.AUTH_OK) { if (!established) { established = true; client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head && head.length) pipe.write(encodeFrame(FRAME.DATA, head)); } }
      else if (f.type === FRAME.REJECT) return fail(403, "Forbidden");
      else if (f.type === FRAME.DATA) { if (established) client.write(f.payload); }
    }
  });
  client.on("data", c => { if (established) pipe.write(encodeFrame(FRAME.DATA, c)); });
  client.on("close", () => { try { pipe.destroy(); } catch {} });
});
server.listen(port, "127.0.0.1", () => console.log(`SHIM_READY 127.0.0.1:${port} -> ${pipePath} (dest ${allowedHost}:${allowedPort})`));
