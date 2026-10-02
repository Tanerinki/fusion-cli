import assert from "node:assert/strict";
import { connect as netConnect, createServer, type Server, type Socket } from "node:net";
import { test } from "node:test";
import { providerCapabilityManifest, providerEndpointAllowlist } from "../src/app/provider-sandbox.js";
import { brokerPolicyFromManifest, normalizeHost, resolveBindAddress, startProviderBroker, type BrokerLogEvent } from "../src/platform/network/provider-broker.js";

// ---------------------------------------------------------------- test rig: a fake upstream + a raw CONNECT client

interface Upstream { readonly port: number; close(): Promise<void> }
function echoUpstream(): Promise<Upstream> {
  const srv: Server = createServer(s => { s.on("error", () => {}); s.on("data", d => s.write(d)); });
  return new Promise(res => srv.listen(0, "127.0.0.1", () => {
    const a = srv.address(); const port = typeof a === "object" && a ? a.port : 0;
    res({ port, close: () => new Promise<void>(r => srv.close(() => r())) });
  }));
}

interface ConnectResult { status: number; socket?: Socket; leftover: string }
function brokerConnect(port: number, target: string, credential?: string): Promise<ConnectResult> {
  return new Promise(resolve => {
    const sock = netConnect(port, "127.0.0.1", () => {
      const auth = credential === undefined ? "" : `Proxy-Authorization: Basic ${Buffer.from(`fusion:${credential}`, "utf8").toString("base64")}\r\n`;
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`);
    });
    let buf = "";
    const onData = (c: Buffer): void => {
      buf += c.toString("latin1");
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      const status = Number(/^HTTP\/1\.1 (\d+)/u.exec(buf)?.[1] ?? 0);
      sock.removeListener("data", onData);
      if (status === 200) resolve({ status, socket: sock, leftover: buf.slice(end + 4) });
      else { sock.destroy(); resolve({ status, leftover: "" }); }
    };
    sock.on("data", onData);
    sock.on("error", () => resolve({ status: 0, leftover: buf }));
  });
}

/** Sends bytes through an established tunnel and resolves with the echoed reply. */
function roundtrip(socket: Socket, payload: string): Promise<string> {
  return new Promise(resolve => {
    let got = "";
    socket.on("data", c => { got += c.toString("utf8"); if (got.length >= payload.length) resolve(got); });
    socket.on("close", () => resolve(got));
    socket.write(payload);
  });
}

const manifestFor = (allowHost: string, allowPort: number) => providerCapabilityManifest({
  executionId: "e1", runId: "r1", candidateId: "c1", candidateRevision: null, backend: "appcontainer",
  sandboxIdentity: "fusion.sandbox.r1.c1", viewPath: "C:/view", scratchPath: "C:/scratch",
  allowedEnvNames: ["CLAUDE_CODE_OAUTH_TOKEN"], network: providerEndpointAllowlist(allowHost, allowPort) });

async function brokerFor(upstreamPort: number, opts: { host?: string; port?: number; log?: (e: BrokerLogEvent) => void; limits?: { maxConnections: number; maxBytesPerConnection: number; ttlMs: number } } = {}) {
  const policy = brokerPolicyFromManifest(manifestFor(opts.host ?? "api.fake.test", opts.port ?? upstreamPort), "claude");
  const broker = await startProviderBroker(policy, {
    // Resolve the allowlisted hostname to the local fake upstream (the CLIENT never chooses the address).
    resolve: (_host, cb) => cb(null, "127.0.0.1"),
    ...(opts.log ? { log: opts.log } : {}), ...(opts.limits ? { limits: opts.limits } : {}),
  });
  return { broker, policy };
}

// ---------------------------------------------------------------- 1. allowlisted CONNECT succeeds

test("v0.6 I12 broker: an allowlisted CONNECT destination succeeds and tunnels bytes", async () => {
  const up = await echoUpstream();
  const { broker } = await brokerFor(up.port);
  try {
    const r = await brokerConnect(broker.port, `api.fake.test:${up.port}`, broker.credential);
    assert.equal(r.status, 200, "the allowlisted destination is tunneled");
    assert.equal(await roundtrip(r.socket!, "PING-THROUGH-BROKER"), "PING-THROUGH-BROKER", "bytes flow end to end");
    r.socket!.destroy();
  } finally { await broker.stop(); await up.close(); }
});

// ---------------------------------------------------------------- 2-5. destination policy refusals

test("v0.6 I12 broker: non-allowlisted host, wrong port, raw IP, and malformed targets are refused", async () => {
  const up = await echoUpstream();
  const { broker } = await brokerFor(up.port);
  try {
    assert.equal((await brokerConnect(broker.port, `evil.example:${up.port}`, broker.credential)).status, 403, "non-allowlisted hostname refused");
    assert.equal((await brokerConnect(broker.port, `api.fake.test:${up.port + 1}`, broker.credential)).status, 403, "allowlisted host on the wrong port refused");
    assert.equal((await brokerConnect(broker.port, `127.0.0.1:${up.port}`, broker.credential)).status, 403, "raw-IP destination refused");
    assert.equal((await brokerConnect(broker.port, `api.fake.test`, broker.credential)).status, 400, "malformed target (no port) refused");
    assert.equal((await brokerConnect(broker.port, `api.fake.test:notaport`, broker.credential)).status, 400, "malformed port refused");
  } finally { await broker.stop(); await up.close(); }
});

// ---------------------------------------------------------------- 6/12. credential (authority) binding

test("v0.6 I12 broker: a missing or wrong per-run credential is refused; one broker's credential does not work on another", async () => {
  const up = await echoUpstream();
  const a = await brokerFor(up.port);
  const b = await brokerFor(up.port);
  try {
    assert.notEqual(a.broker.credential, b.broker.credential, "each run has a distinct unguessable credential");
    assert.equal((await brokerConnect(a.broker.port, `api.fake.test:${up.port}`)).status, 407, "no credential is refused");
    assert.equal((await brokerConnect(a.broker.port, `api.fake.test:${up.port}`, "wrong-credential")).status, 407, "a wrong credential is refused");
    assert.equal((await brokerConnect(a.broker.port, `api.fake.test:${up.port}`, b.broker.credential)).status, 407, "another run's credential cannot reuse this broker's authority");
    assert.match(a.policy.policyHash, /^[0-9a-f]{64}$/u, "the policy is hash-bound to the manifest/execution");
  } finally { await a.broker.stop(); await b.broker.stop(); await up.close(); }
});

// ---------------------------------------------------------------- 7. unrelated localhost service not proxied

test("v0.6 I12 broker: the broker will not proxy to an unrelated localhost service", async () => {
  const up = await echoUpstream();
  const unrelated = await echoUpstream(); // a different local listener, not in the allowlist
  const { broker } = await brokerFor(up.port);
  try {
    // Even though the process could reach 127.0.0.1 directly, the BROKER refuses to tunnel there (raw IP + not allowlisted).
    assert.equal((await brokerConnect(broker.port, `127.0.0.1:${unrelated.port}`, broker.credential)).status, 403, "unrelated localhost port refused (raw IP)");
    assert.equal((await brokerConnect(broker.port, `localhost:${unrelated.port}`, broker.credential)).status, 403, "unrelated localhost by name refused (not allowlisted)");
  } finally { await broker.stop(); await up.close(); await unrelated.close(); }
});

// ---------------------------------------------------------------- 8/9. lifecycle: terminates with the run, no orphan

test("v0.6 I12 broker: stop() terminates the listener with the run and leaves no orphan", async () => {
  const up = await echoUpstream();
  const { broker } = await brokerFor(up.port);
  await broker.stop();
  const dead = await new Promise<string>(resolve => {
    const s = netConnect(broker.port, "127.0.0.1");
    s.on("connect", () => { s.destroy(); resolve("connected"); });
    s.on("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error"));
  });
  assert.equal(dead, "ECONNREFUSED", "after stop the loopback listener is gone (no orphan)");
  await up.close();
});

// ---------------------------------------------------------------- 10. secrets absent from logs

test("v0.6 I12 broker: sanitized logs never contain the credential or any Authorization value", async () => {
  const up = await echoUpstream();
  const events: BrokerLogEvent[] = [];
  const { broker } = await brokerFor(up.port, { log: e => events.push(e) });
  try {
    const r = await brokerConnect(broker.port, `api.fake.test:${up.port}`, broker.credential);
    r.socket?.destroy();
    await brokerConnect(broker.port, `evil.example:${up.port}`, broker.credential);
    await brokerConnect(broker.port, `api.fake.test:${up.port}`, "wrong");
    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes(broker.credential), false, "the per-run credential never appears in logs");
    assert.equal(/basic\s|authorization|proxy-auth/iu.test(serialized), false, "no Authorization/proxy-auth material in logs");
    assert.ok(events.some(e => e.kind === "allowed") && events.some(e => e.kind === "refused"), "decisions are logged (host/port/decision only)");
  } finally { await broker.stop(); await up.close(); }
});

// ---------------------------------------------------------------- 11. byte budget enforced

test("v0.6 I12 broker: a connection exceeding its byte budget is torn down", async () => {
  const up = await echoUpstream();
  const { broker } = await brokerFor(up.port, { limits: { maxConnections: 8, maxBytesPerConnection: 16, ttlMs: 30_000 } });
  try {
    const r = await brokerConnect(broker.port, `api.fake.test:${up.port}`, broker.credential);
    assert.equal(r.status, 200);
    const closed = await new Promise<boolean>(resolve => {
      r.socket!.on("close", () => resolve(true));
      r.socket!.on("data", () => {});
      r.socket!.write("X".repeat(64)); // exceeds the 16-byte budget
      setTimeout(() => resolve(false), 2_000);
    });
    assert.equal(closed, true, "the tunnel is destroyed once the byte budget is exceeded");
  } finally { await broker.stop(); await up.close(); }
});

// ---------------------------------------------------------------- non-CONNECT / open-proxy surface

test("v0.6 I12 broker: a non-CONNECT request is refused (no open HTTP proxy surface)", async () => {
  const up = await echoUpstream();
  const { broker } = await brokerFor(up.port);
  try {
    const status = await new Promise<number>(resolve => {
      const s = netConnect(broker.port, "127.0.0.1", () => s.write(`GET http://api.fake.test/ HTTP/1.1\r\nHost: api.fake.test\r\n\r\n`));
      let buf = ""; s.on("data", c => { buf += c.toString("latin1"); if (buf.includes("\r\n")) { resolve(Number(/^HTTP\/1\.1 (\d+)/u.exec(buf)?.[1] ?? 0)); s.destroy(); } });
      s.on("error", () => resolve(0));
    });
    assert.equal(status, 405, "a plain GET (open-proxy attempt) is refused");
  } finally { await broker.stop(); await up.close(); }
});

// ---------------------------------------------------------------- hostname normalization (confusion defense)

test("v0.6 I12 broker: normalizeHost folds case/trailing-dot, brackets IPv6, and rejects malformed names", () => {
  assert.deepEqual(normalizeHost("API.Fake.Test."), { host: "api.fake.test", isIp: false });
  assert.deepEqual(normalizeHost("[::1]"), { host: "::1", isIp: true });
  assert.deepEqual(normalizeHost("10.0.0.1"), { host: "10.0.0.1", isIp: true });
  for (const bad of ["", "-bad.example", "bad-.example", "a..b", "has space.example", "x".repeat(300)])
    assert.equal(normalizeHost(bad), null, `${bad} is rejected`);
});

// ---------------------------------------------------------------- proxy env is Fusion-constructed, run-bound

test("v0.6 I12 broker: the proxy env is Fusion-constructed, loopback-only, credential-bound, with empty NO_PROXY", async () => {
  const up = await echoUpstream();
  const { broker } = await brokerFor(up.port);
  try {
    assert.equal(broker.address, "127.0.0.1", "binds loopback only");
    assert.match(broker.proxyEnv.HTTPS_PROXY!, new RegExp(`^http://fusion:${broker.credential}@127\\.0\\.0\\.1:${broker.port}$`, "u"), "HTTPS_PROXY carries the run credential and loopback endpoint");
    assert.equal(broker.proxyEnv.HTTP_PROXY, broker.proxyEnv.HTTPS_PROXY);
    assert.equal(broker.proxyEnv.NO_PROXY, "", "NO_PROXY is empty so nothing bypasses the broker");
  } finally { await broker.stop(); await up.close(); }
});

// ---------------------------------------------------------------- bindAddress (Hyper-V backend; loopback default kept)

test("v0.6 I12 broker: resolveBindAddress defaults to loopback and refuses a wildcard or non-IP", () => {
  assert.equal(resolveBindAddress(undefined), "127.0.0.1", "default is loopback (AppContainer semantics unchanged)");
  assert.equal(resolveBindAddress("10.250.37.1"), "10.250.37.1", "a dedicated worker-facing IP is accepted");
  for (const bad of ["0.0.0.0", "::", "*", "", "not-an-ip"]) assert.throws(() => resolveBindAddress(bad), /wildcard|IP literal/u, `refuses ${bad}`);
});

test("v0.6 I12 broker: by default the broker still binds loopback and advertises it", async () => {
  const up = await echoUpstream();
  const policy = { executionId: "e", providerFamily: "synthetic", allowedHosts: ["127.0.0.1"], allowedPorts: [up.port], allowRawIp: true, policyVersion: "0.6.0", policyHash: "h" };
  const broker = await startProviderBroker(policy);
  try {
    assert.equal(broker.address, "127.0.0.1");
    assert.ok(String(broker.proxyEnv.HTTPS_PROXY).includes("@127.0.0.1:"), "proxy env advertises loopback by default");
  } finally { await broker.stop(); await up.close(); }
});

test("v0.6 I12 broker: a dedicated worker-facing bindAddress is advertised in proxyEnv; wildcard is rejected at start", async () => {
  const up = await echoUpstream();
  const policy = { executionId: "e", providerFamily: "synthetic", allowedHosts: ["127.0.0.1"], allowedPorts: [up.port], allowRawIp: true, policyVersion: "0.6.0", policyHash: "h" };
  // 127.0.0.2 is a loopback-range address bindable without external NICs — proves non-default bindAddress plumbs through.
  const broker = await startProviderBroker(policy, { bindAddress: "127.0.0.2" });
  try {
    assert.equal(broker.address, "127.0.0.2");
    assert.ok(String(broker.proxyEnv.HTTPS_PROXY).includes("@127.0.0.2:"), "proxy env advertises the selected worker-facing address");
  } finally { await broker.stop(); await up.close(); }
  await assert.rejects(startProviderBroker(policy, { bindAddress: "0.0.0.0" }), /wildcard/u, "a wildcard bind is refused");
});
