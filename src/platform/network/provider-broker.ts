import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { lookup as dnsLookup } from "node:dns";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { sha256Hex } from "../../core/delivery/canonical.js";
import type { CapabilityManifest } from "../../core/isolation/capability-manifest.js";

/**
 * v0.6 I12 — the HOST-SIDE PROVIDER NETWORK BROKER. A no-capability AppContainer has DENY_ALL network; a package-SID
 * loopback exemption (Gate #1) lets the sandboxed provider reach ONLY 127.0.0.1. This broker is the trusted host process
 * that listens on loopback, authenticates the sandboxed client with a per-run unguessable credential, enforces a strict
 * host-owned allowlist (exact FQDN + port, bound to the capability manifest), and only then CONNECT-tunnels to the
 * provider endpoint. It is NOT a generic proxy: a non-CONNECT request, a wrong credential, a non-allowlisted host or
 * port, a raw IP (unless policy-bound), or a malformed target is refused. The provider stays untrusted; the broker never
 * sees or logs credentials/bodies (a CONNECT tunnel is opaque after the handshake), bounds connections/bytes/lifetime,
 * and leaves no listener behind when the run ends.
 *
 * LOOPBACK BOUNDARY (honest): `CheckNetIsolation LoopbackExempt` is PER-PACKAGE, not per-port — an exempted AppContainer
 * can reach ANY 127.0.0.1 service, not only this broker. So "broker-only loopback" is NOT enforced at the network layer
 * by the exemption alone; the per-run credential here prevents a different local process from reusing THIS broker's
 * authority, but it does not stop the sandbox from reaching unrelated localhost services directly. That residual is
 * documented and assessed in the matrix; closing it needs WFP package-SID+port scoping (admin), not this module.
 */

export const BROKER_POLICY_VERSION = "0.6.0";
const LOOPBACK = "127.0.0.1";

export interface BrokerLimits {
  readonly maxConnections: number;
  readonly maxBytesPerConnection: number;
  readonly ttlMs: number;
}
export const DEFAULT_BROKER_LIMITS: BrokerLimits = Object.freeze({ maxConnections: 64, maxBytesPerConnection: 256 * 1024 * 1024, ttlMs: 30 * 60_000 });

/** The immutable, host-owned policy a broker enforces, bound to one execution's capability manifest. */
export interface BrokerPolicy {
  readonly executionId: string;
  readonly providerFamily: string;
  /** Exact, already-normalized allowed hostnames (lowercase, no trailing dot). */
  readonly allowedHosts: readonly string[];
  readonly allowedPorts: readonly number[];
  /** Raw-IP CONNECT targets are refused unless the policy explicitly binds them. */
  readonly allowRawIp: boolean;
  readonly policyVersion: string;
  /** SHA-256 binding this policy to the manifest it was derived from (execution/manifest binding). */
  readonly policyHash: string;
}

/** A sanitized broker event — decisions only, NEVER a credential, header value, or payload. */
export interface BrokerLogEvent {
  readonly kind: "refused" | "allowed" | "closed";
  readonly reason?: string;
  readonly host?: string;
  readonly port?: number;
}

export interface BrokerStats {
  readonly attempted: number;
  readonly allowed: number;
  readonly refused: number;
  readonly activeConnections: number;
}

export interface RunningBroker {
  readonly brokerId: string;
  readonly port: number;
  readonly address: string;
  /** The per-run credential the sandboxed client must present (Proxy-Authorization: Basic base64("fusion:"+credential)). */
  readonly credential: string;
  readonly proxyEnv: Readonly<Record<string, string>>;
  stats(): BrokerStats;
  stop(): Promise<void>;
}

/** Normalizes a CONNECT host for exact policy comparison; returns the host and whether it is an IP literal, or null if invalid. */
export function normalizeHost(raw: string): Readonly<{ host: string; isIp: boolean }> | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 253) return null;
  let host = raw.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1); // bracketed IPv6
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.length === 0) return null;
  const ipKind = isIP(host);
  if (ipKind !== 0) return Object.freeze({ host, isIp: true });
  // A valid DNS name: labels of [a-z0-9-], not starting/ending with '-', no empty labels.
  if (!/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/u.test(host)) return null;
  return Object.freeze({ host, isIp: false });
}

/** Builds a broker policy from a provider's capability manifest (its ALLOWLIST network policy) — the host-owned binding. */
export function brokerPolicyFromManifest(manifest: CapabilityManifest, providerFamily: string): BrokerPolicy {
  const hosts: string[] = [], ports = new Set<number>();
  let allowRawIp = false;
  for (const dest of manifest.network.allowed) {
    const n = normalizeHost(dest.host);
    if (n === null) continue;
    hosts.push(n.host);
    if (n.isIp) allowRawIp = true; // only when the policy itself named an IP
    if (dest.port !== null) ports.add(dest.port);
  }
  return Object.freeze({
    executionId: manifest.executionId, providerFamily,
    allowedHosts: Object.freeze([...new Set(hosts)]), allowedPorts: Object.freeze([...ports]),
    allowRawIp, policyVersion: BROKER_POLICY_VERSION,
    policyHash: sha256Hex(JSON.stringify({ v: BROKER_POLICY_VERSION, execution: manifest.executionId, manifest: manifest.manifestHash,
      hosts: [...new Set(hosts)].sort(), ports: [...ports].sort((a, b) => a - b), allowRawIp })),
  });
}

type Resolver = (host: string, cb: (err: Error | null, address: string) => void) => void;
const defaultResolver: Resolver = (host, cb) => dnsLookup(host, { family: 0 }, (err, address) => cb(err, address));

export interface BrokerOptions {
  readonly limits?: BrokerLimits;
  /** Test seam: resolve a hostname to an address (defaults to dns.lookup). Never lets the CLIENT choose the address. */
  readonly resolve?: Resolver;
  readonly log?: (event: BrokerLogEvent) => void;
  /**
   * The host address the broker listens on. Defaults to `127.0.0.1` — the AppContainer (loopback) design — so existing
   * behaviour is unchanged. The Hyper-V backend supplies a DEDICATED worker-facing host/vSwitch IP here so the isolated
   * worker can reach the real broker over its own NIC. A wildcard (`0.0.0.0`/`::`/`*`) is REFUSED: the broker must never
   * listen on every interface.
   */
  readonly bindAddress?: string;
  /** The listen port. Default 0 (ephemeral). A fixed port is only used by callers that must pre-bind an ACL to it. */
  readonly port?: number;
}

/** Resolves/validates the broker bind address. Default loopback; a wildcard or non-IP literal is refused. */
export function resolveBindAddress(bindAddress?: string): string {
  if (bindAddress === undefined) return LOOPBACK;
  const addr = String(bindAddress).trim();
  if (addr === "" || addr === "0.0.0.0" || addr === "::" || addr === "*") throw new Error(`broker bindAddress must not be a wildcard, got: ${JSON.stringify(bindAddress)}`);
  if (isIP(addr) === 0) throw new Error(`broker bindAddress must be an IP literal, got: ${JSON.stringify(bindAddress)}`);
  return addr;
}

/** Formats a host for a proxy URL (bracketing an IPv6 literal). */
function hostForUrl(addr: string): string {
  return isIP(addr) === 6 ? `[${addr}]` : addr;
}

const basicCredential = (credential: string): string => `Basic ${Buffer.from(`fusion:${credential}`, "utf8").toString("base64")}`;
function credentialMatches(header: string | undefined, expected: string): boolean {
  if (typeof header !== "string") return false;
  const a = Buffer.from(header, "utf8"), b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Starts a provider network broker for one execution. Binds 127.0.0.1 on an ephemeral port, enforces the policy, and
 * returns the per-run credential + the proxy environment Fusion (not the provider) injects. `stop()` — and the TTL timer,
 * and an owning AbortSignal — tear the listener and every live socket down, leaving no orphan.
 */
export function startProviderBroker(policy: BrokerPolicy, options: BrokerOptions = {}): Promise<RunningBroker> {
  const limits = options.limits ?? DEFAULT_BROKER_LIMITS;
  const listenPort = options.port ?? 0;
  const resolve = options.resolve ?? defaultResolver;
  const log = (e: BrokerLogEvent): void => { try { options.log?.(e); } catch { /* logging never affects enforcement */ } };
  const brokerId = `broker-${randomBytes(9).toString("hex")}`;
  const credential = randomBytes(32).toString("hex");
  const expectedAuth = basicCredential(credential);
  const sockets = new Set<Socket>();
  let attempted = 0, allowed = 0, refused = 0, stopped = false;

  const server: Server = createServer((_req, res) => {
    // A non-CONNECT request is never proxied — no open HTTP proxy surface.
    res.writeHead(405, { "content-type": "text/plain" }); res.end("method not allowed"); log({ kind: "refused", reason: "nonConnect" });
  });

  const refuse = (client: Socket, code: number, text: string, reason: string, host?: string, port?: number): void => {
    refused++;
    try { client.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); } catch { /* client gone */ }
    client.destroy();
    log({ kind: "refused", reason, ...(host === undefined ? {} : { host }), ...(port === undefined ? {} : { port }) });
  };

  server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
    attempted++;
    client.on("error", () => {});
    if (stopped) return refuse(client, 503, "Service Unavailable", "stopped");
    if (!credentialMatches(req.headers["proxy-authorization"], expectedAuth))
      return refuse(client, 407, "Proxy Authentication Required", "auth");
    const target = String(req.url ?? "");
    const lastColon = target.lastIndexOf(":");
    if (lastColon <= 0) return refuse(client, 400, "Bad Request", "malformedTarget");
    const rawHost = target.slice(0, lastColon), portStr = target.slice(lastColon + 1);
    const port = Number(portStr);
    if (!/^\d{1,5}$/u.test(portStr) || !Number.isInteger(port) || port < 1 || port > 65535)
      return refuse(client, 400, "Bad Request", "malformedPort");
    const norm = normalizeHost(rawHost);
    if (norm === null) return refuse(client, 400, "Bad Request", "malformedHost");
    if (norm.isIp && !policy.allowRawIp) return refuse(client, 403, "Forbidden", "rawIpRefused", norm.host, port);
    if (!policy.allowedHosts.includes(norm.host)) return refuse(client, 403, "Forbidden", "hostNotAllowed", norm.host, port);
    if (!policy.allowedPorts.includes(port)) return refuse(client, 403, "Forbidden", "portNotAllowed", norm.host, port);
    if (sockets.size >= limits.maxConnections) return refuse(client, 429, "Too Many Requests", "connectionBudget", norm.host, port);

    // Resolve once, on the HOST side, and connect to that address — the client never chooses the IP (rebinding defense).
    resolve(norm.host, (err, address) => {
      if (stopped || err || !address) return refuse(client, 502, "Bad Gateway", "resolveFailed", norm.host, port);
      const upstream = netConnect(port, address, () => {
        allowed++;
        sockets.add(client); sockets.add(upstream);
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head && head.length > 0) upstream.write(head);
        let bytes = 0;
        const budget = (chunk: Buffer): boolean => { bytes += chunk.length; if (bytes > limits.maxBytesPerConnection) {
          log({ kind: "closed", reason: "byteBudget", host: norm.host, port }); client.destroy(); upstream.destroy(); return false; } return true; };
        client.on("data", c => { if (budget(c)) upstream.write(c); });
        upstream.on("data", c => { if (budget(c)) client.write(c); });
        log({ kind: "allowed", host: norm.host, port });
      });
      upstream.on("error", () => refuse(client, 502, "Bad Gateway", "upstreamError", norm.host, port));
      const cleanup = (): void => { sockets.delete(client); sockets.delete(upstream); client.destroy(); upstream.destroy(); };
      client.on("close", cleanup); upstream.on("close", cleanup);
    });
  });

  let ttlTimer: NodeJS.Timeout | undefined;
  const stop = async (): Promise<void> => {
    if (stopped) return; stopped = true;
    if (ttlTimer !== undefined) clearTimeout(ttlTimer);
    for (const s of sockets) s.destroy();
    sockets.clear();
    await new Promise<void>(resolve => server.close(() => resolve()));
    log({ kind: "closed", reason: "stopped" });
  };

  return new Promise((resolveStart, rejectStart) => {
    // Resolve the bind address inside the promise so an invalid/wildcard address is a rejection, not a sync throw.
    let bindAddress: string;
    try { bindAddress = resolveBindAddress(options.bindAddress); } catch (e) { rejectStart(e as Error); return; }
    server.once("error", rejectStart);
    // Bind the resolved address (loopback by default; a dedicated worker-facing IP for the Hyper-V backend — never a
    // wildcard), on the requested port (ephemeral by default).
    server.listen(listenPort, bindAddress, () => {
      server.removeListener("error", rejectStart);
      const addr = server.address();
      if (addr === null || typeof addr === "string") { void stop(); rejectStart(new Error(`broker failed to bind ${bindAddress}`)); return; }
      const port = addr.port;
      ttlTimer = setTimeout(() => { void stop(); }, Math.max(1, limits.ttlMs));
      ttlTimer.unref?.();
      const proxyUrl = `http://fusion:${credential}@${hostForUrl(bindAddress)}:${port}`;
      resolveStart(Object.freeze({
        brokerId, port, address: bindAddress, credential,
        // Fusion constructs the proxy env; the provider cannot choose it. NO_PROXY empty so nothing bypasses the broker.
        proxyEnv: Object.freeze({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, NO_PROXY: "" }),
        stats: () => Object.freeze({ attempted, allowed, refused, activeConnections: sockets.size }),
        stop,
      }));
    });
  });
}
