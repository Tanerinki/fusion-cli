// Fusion v0.6 Hyper-V PoC - mapped-named-pipe transport PROTOCOL + AUTHORIZATION (pure, CI-unit-tested; the security
// core). Bounded, deterministic, versioned framing with strict caps; a malformed/oversized frame FAILS CLOSED. The host
// broker (pipe-broker.ps1) mirrors this exact wire format; the guest shim (guest-shim.mjs) uses this module directly.
//
// SECURITY MODEL: a client that opens the mapped pipe DIRECTLY gets no more authority than the loopback shim - both must
// present the per-run credential AND request exactly the one host-approved destination. The broker never offers generic
// TCP forwarding: the only reachable destination is the single synthetic provider endpoint the trusted host configured.

export const MAGIC = Buffer.from("FHP1", "ascii");      // 4 bytes
export const VERSION = 1;
export const FRAME = Object.freeze({ AUTH: 1, AUTH_OK: 2, DATA: 3, REJECT: 4 });
export const MAX_PAYLOAD = 64 * 1024;                   // 64 KiB per frame - strict cap
export const MAX_AUTH_PAYLOAD = 1024;                   // AUTH JSON is tiny
export const HEADER_LEN = MAGIC.length + 1 /*ver*/ + 1 /*type*/ + 4 /*len*/;

/** Encodes one frame. Throws on an out-of-range type or an oversized payload (callers never emit a bad frame). */
export function encodeFrame(type, payload) {
  const body = payload === undefined || payload === null ? Buffer.alloc(0)
    : Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  if (!Object.values(FRAME).includes(type)) throw new Error(`bad frame type ${type}`);
  if (body.length > MAX_PAYLOAD) throw new Error(`payload ${body.length} exceeds MAX_PAYLOAD`);
  const hdr = Buffer.alloc(HEADER_LEN);
  MAGIC.copy(hdr, 0);
  hdr.writeUInt8(VERSION, 4);
  hdr.writeUInt8(type, 5);
  hdr.writeUInt32BE(body.length, 6);
  return Buffer.concat([hdr, body]);
}

/** Builds the AUTH frame payload (JSON). Kept tiny; the broker caps it at MAX_AUTH_PAYLOAD. */
export function encodeAuth(credential, destHost, destPort) {
  return encodeFrame(FRAME.AUTH, Buffer.from(JSON.stringify({ credential: String(credential), destHost: String(destHost), destPort: Number(destPort) }), "utf8"));
}

/**
 * Decodes as many whole frames as are buffered. Returns { frames:[{type,payload}], rest, error }. A bad magic, an
 * unsupported version, or a length over MAX_PAYLOAD sets `error` and stops (FAIL CLOSED - the caller must drop the
 * connection; it never resynchronizes past a malformed frame).
 */
export function decodeFrames(buf) {
  const frames = [];
  let off = 0;
  while (buf.length - off >= HEADER_LEN) {
    if (!buf.subarray(off, off + 4).equals(MAGIC)) return { frames, rest: buf.subarray(off), error: "badMagic" };
    const ver = buf.readUInt8(off + 4);
    if (ver !== VERSION) return { frames, rest: buf.subarray(off), error: "badVersion" };
    const type = buf.readUInt8(off + 5);
    const len = buf.readUInt32BE(off + 6);
    if (len > MAX_PAYLOAD) return { frames, rest: buf.subarray(off), error: "oversize" };
    if (buf.length - off - HEADER_LEN < len) break; // wait for the rest of the payload
    if (!Object.values(FRAME).includes(type)) return { frames, rest: buf.subarray(off), error: "badType" };
    frames.push({ type, payload: buf.subarray(off + HEADER_LEN, off + HEADER_LEN + len) });
    off += HEADER_LEN + len;
  }
  return { frames, rest: buf.subarray(off), error: null };
}

/** Constant-time-ish equality for credentials (no early byte-wise exit for equal-length secrets). */
export function credentialEquals(a, b) {
  const x = Buffer.from(String(a ?? ""), "utf8"), y = Buffer.from(String(b ?? ""), "utf8");
  if (x.length !== y.length || x.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * Parses + authorizes an AUTH payload against the host-owned policy. This is the ONE decision that gates the broker, for
 * BOTH the shim and a direct-pipe adversary. Returns { ok, reason }:
 *   - payload not valid JSON / oversized            -> DENY "malformedAuth"
 *   - credential missing or wrong                    -> DENY "auth"
 *   - destination != the single approved host:port   -> DENY "destNotAllowed"
 *   - otherwise                                      -> ALLOW
 * `policy` = { credential, allowedHost, allowedPort }. There is no wildcard and no multi-destination list - exactly one.
 */
export function authorize(authPayload, policy) {
  const p = policy ?? {};
  const raw = Buffer.isBuffer(authPayload) ? authPayload : Buffer.from(String(authPayload ?? ""), "utf8");
  if (raw.length === 0 || raw.length > MAX_AUTH_PAYLOAD) return { ok: false, reason: "malformedAuth" };
  let obj;
  try { obj = JSON.parse(raw.toString("utf8")); } catch { return { ok: false, reason: "malformedAuth" }; }
  if (obj === null || typeof obj !== "object") return { ok: false, reason: "malformedAuth" };
  if (!credentialEquals(obj.credential, p.credential)) return { ok: false, reason: "auth" };
  if (String(obj.destHost) !== String(p.allowedHost) || Number(obj.destPort) !== Number(p.allowedPort)) return { ok: false, reason: "destNotAllowed" };
  return { ok: true, reason: "ok" };
}
