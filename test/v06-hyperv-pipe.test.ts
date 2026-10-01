import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const pocDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "hyperv-poc");
const proto = await import(pathToFileURL(join(pocDir, "pipe-protocol.mjs")).href);
const { networkNoneEffective } = await import(pathToFileURL(join(pocDir, "network-none.mjs")).href);
const pe = await import(pathToFileURL(join(pocDir, "pipe-evaluator.mjs")).href);

// ------------------------------------------------------------------ framing (bounded, fail-closed)
test("v0.6 Hyper-V pipe: frames round-trip and a partial frame is buffered (rest) until complete", () => {
  const f = proto.encodeFrame(proto.FRAME.DATA, Buffer.from("hello"));
  const whole = proto.decodeFrames(f);
  assert.equal(whole.error, null);
  assert.equal(whole.frames.length, 1);
  assert.equal(whole.frames[0].payload.toString(), "hello");
  const partial = proto.decodeFrames(f.subarray(0, f.length - 2));
  assert.equal(partial.error, null);
  assert.equal(partial.frames.length, 0, "an incomplete frame yields no frames, waits for more");
});

test("v0.6 Hyper-V pipe: a bad magic / bad version / oversized length fails closed (error set, no frame)", () => {
  const bad = Buffer.concat([Buffer.from("XXXX"), Buffer.from([1, 3, 0, 0, 0, 0])]);
  assert.equal(proto.decodeFrames(bad).error, "badMagic");
  const badVer = Buffer.concat([proto.MAGIC, Buffer.from([9, 3, 0, 0, 0, 0])]);
  assert.equal(proto.decodeFrames(badVer).error, "badVersion");
  const oversize = Buffer.concat([proto.MAGIC, Buffer.from([1, 3]), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(proto.MAX_PAYLOAD + 1, 0); return b; })()]);
  assert.equal(proto.decodeFrames(oversize).error, "oversize", "a length over MAX_PAYLOAD is rejected, never allocated");
  assert.throws(() => proto.encodeFrame(proto.FRAME.DATA, Buffer.alloc(proto.MAX_PAYLOAD + 1)), /MAX_PAYLOAD/u);
});

// ------------------------------------------------------------------ authorization (the one gate for shim AND direct pipe)
const policy = { credential: "a".repeat(64), allowedHost: "10.250.37.1", allowedPort: 47630 };
test("v0.6 Hyper-V pipe: authorize ALLOWs only the right credential AND the single approved destination", () => {
  const good = proto.encodeAuth(policy.credential, "10.250.37.1", 47630).subarray(proto.HEADER_LEN);
  assert.deepEqual(proto.authorize(good, policy), { ok: true, reason: "ok" });
});

test("v0.6 Hyper-V pipe: authorize DENies wrong/missing credential, wrong destination, and malformed/oversized auth", () => {
  const wrongCred = proto.encodeAuth("b".repeat(64), "10.250.37.1", 47630).subarray(proto.HEADER_LEN);
  assert.equal(proto.authorize(wrongCred, policy).reason, "auth");
  const noCred = Buffer.from(JSON.stringify({ destHost: "10.250.37.1", destPort: 47630 }), "utf8");
  assert.equal(proto.authorize(noCred, policy).reason, "auth");
  const wrongDest = proto.encodeAuth(policy.credential, "10.250.37.1", 47611).subarray(proto.HEADER_LEN);
  assert.equal(proto.authorize(wrongDest, policy).reason, "destNotAllowed");
  const wrongHost = proto.encodeAuth(policy.credential, "127.0.0.1", 47630).subarray(proto.HEADER_LEN);
  assert.equal(proto.authorize(wrongHost, policy).reason, "destNotAllowed");
  assert.equal(proto.authorize(Buffer.from("{not json"), policy).reason, "malformedAuth");
  assert.equal(proto.authorize(Buffer.alloc(proto.MAX_AUTH_PAYLOAD + 1, 0x41), policy).reason, "malformedAuth");
  assert.equal(proto.authorize(Buffer.alloc(0), policy).reason, "malformedAuth");
});

test("v0.6 Hyper-V pipe: a direct-pipe client gets NO more authority than the shim - same authorize() gate", () => {
  // Whether the request arrives from the loopback shim or a hostile direct-pipe client, authorize() is identical.
  const direct = proto.encodeAuth(policy.credential, "10.250.37.1", 47630).subarray(proto.HEADER_LEN);
  assert.equal(proto.authorize(direct, policy).ok, true, "fully authorized direct client reaches ONLY the one approved dest");
  const directOther = proto.encodeAuth(policy.credential, "10.250.37.1", 22).subarray(proto.HEADER_LEN);
  assert.equal(proto.authorize(directOther, policy).ok, false, "a direct client cannot pick another destination");
});

// ------------------------------------------------------------------ network-none derivation
test("v0.6 Hyper-V pipe: networkNoneEffective PASS only for loopback-only, no default route, no routable DNS", () => {
  assert.equal(networkNoneEffective({ interfaces: [{ name: "lo", addresses: ["127.0.0.1", "::1"] }], routes: ["127.0.0.0/8"], dnsServers: [] }).verdict, "PASS");
  assert.equal(networkNoneEffective({ interfaces: [{ name: "eth", addresses: ["10.250.37.22"] }], routes: [], dnsServers: [] }).verdict, "FAIL", "a non-loopback address is a usable path");
  assert.equal(networkNoneEffective({ interfaces: [{ name: "lo", addresses: ["127.0.0.1"] }], routes: ["0.0.0.0/0"], dnsServers: [] }).verdict, "FAIL", "a default route is a usable path");
  assert.equal(networkNoneEffective({ interfaces: [{ name: "lo", addresses: ["127.0.0.1"] }], routes: [], dnsServers: ["192.168.178.205"] }).verdict, "FAIL", "a routable DNS server is a usable path");
  assert.equal(networkNoneEffective({}).verdict, "INCOMPLETE", "no facts -> INCOMPLETE, never PASS");
});

// ------------------------------------------------------------------ dimension + overall verdicts
function goodPipe(): Record<string, unknown> {
  return { allowedRoute: "connected", allowedRouteTokenEchoed: true, directPipeNoAuth: "refused", directPipeWrongCred: "refused",
    directPipeWrongDest: "refused", unauthorizedDestThroughBroker: "refused", pipeNameGuess: "refused", directPipeAuthorized: "connected" };
}
function goodNet(): Record<string, unknown> {
  return { facts: { interfaces: [{ name: "lo", addresses: ["127.0.0.1"] }], routes: [], dnsServers: [] },
    rawInternet: "timeout", rawHostLan: "timeout", rawDns: "timeout", rawDirectProvider: "timeout", rawSocketBypass: "timeout", otherHostPipeOpen: "refused",
    hostControls: { rawInternet: "connected", rawHostLan: "connected", rawDns: "answered", rawDirectProvider: "connected", rawSocketBypass: "connected" } };
}

test("v0.6 Hyper-V pipe: pipeTransport PASS only when the allowed route works AND every unauthorized path is denied", () => {
  assert.equal(pe.pipeTransportVerdict(goodPipe()).verdict, "PASS");
  const escape = goodPipe(); escape.directPipeNoAuth = "connected";
  assert.equal(pe.pipeTransportVerdict(escape).verdict, "FAIL", "a direct no-auth client reaching the dest is an escape");
  const guess = goodPipe(); guess.pipeNameGuess = "connected";
  assert.equal(pe.pipeTransportVerdict(guess).verdict, "FAIL", "guessing another run's pipe must be denied");
  const notrun = goodPipe(); delete notrun.allowedRoute;
  assert.equal(pe.pipeTransportVerdict(notrun).verdict, "INCOMPLETE");
});

test("v0.6 Hyper-V pipe: networkNoneBoundary turns a worker timeout into a proven DENY only with a host control; a reachable raw target FAILs", () => {
  assert.equal(pe.networkNoneBoundaryVerdict(goodNet()).verdict, "PASS", "loopback-only + host-controlled denies = PASS");
  const noCtrl = goodNet(); noCtrl.hostControls = {};
  assert.equal(pe.networkNoneBoundaryVerdict(noCtrl).verdict, "INCOMPLETE", "worker timeouts with no host control cannot be proven");
  const escape = goodNet(); escape.rawInternet = "connected";
  assert.equal(pe.networkNoneBoundaryVerdict(escape).verdict, "FAIL", "the worker reaching the Internet is an escape");
  const otherPipe = goodNet(); otherPipe.otherHostPipeOpen = "connected";
  assert.equal(pe.networkNoneBoundaryVerdict(otherPipe).verdict, "FAIL", "OPENING an unrelated host pipe is an escape");
});

test("v0.6 Hyper-V pipe: BROKER_ONLY_NETWORK_BOUNDARY is PROVEN only when pipe transport AND network-none both PASS", () => {
  const pipePath = "\\\\.\\pipe\\FusionV06Poc-r1-pipe";
  const doc: Record<string, any> = { pipe: goodPipe(), network: goodNet(),
    runtimeShapeExpected: { pipe: pipePath }, runtimeShape: { mounts: [{ Type: "npipe", Source: pipePath, Destination: pipePath }] },
    filesystem: Object.fromEntries(pe.FS_REQUIRED.map((k: string) => [k, "PASS"])),
    lifecycle: Object.fromEntries(pe.PROC_REQUIRED.map((k: string) => [k, "PASS"])),
    cleanup: { cleanupOk: "PASS" } };
  const r = pe.evaluatePipePoc(doc);
  assert.equal(r.BROKER_ONLY_NETWORK_BOUNDARY, "PROVEN");
  assert.equal(r.HYPERV_PIPE_POC, "PASS");
  // A single pipe escape drops the boundary to NOT_PROVEN and the PoC to FAIL.
  const esc = structuredClone(doc); esc.pipe.directPipeNoAuth = "connected";
  const r2 = pe.evaluatePipePoc(esc);
  assert.equal(r2.BROKER_ONLY_NETWORK_BOUNDARY, "NOT_PROVEN");
  assert.equal(r2.HYPERV_PIPE_POC, "FAIL");
  // Network-none proven but filesystem not run -> boundary still PROVEN (network dimension) but full HARD INCOMPLETE.
  const fsMissing = structuredClone(doc); fsMissing.filesystem = {};
  const r3 = pe.evaluatePipePoc(fsMissing);
  assert.equal(r3.BROKER_ONLY_NETWORK_BOUNDARY, "PROVEN", "the network boundary does not depend on the FS dimension");
  assert.equal(r3.HYPERV_PIPE_POC, "INCOMPLETE", "full HARD still needs filesystem + process");
});

// ------------------------------------------------------------------ host broker wire format mirrors the JS protocol
test("v0.6 Hyper-V pipe: pipe-broker.ps1 mirrors the pipe-protocol wire format (magic/version/types/cap) - no drift", async () => {
  const { readFileSync } = await import("node:fs");
  const ps = readFileSync(join(pocDir, "pipe-broker.ps1"), "utf8");
  for (const b of ["0x46", "0x48", "0x50", "0x31"]) assert.ok(ps.includes(b), `broker encodes MAGIC byte ${b} ('FHP1')`);
  assert.match(ps, /AUTH\s*=\s*1,\s*AUTH_OK\s*=\s*2,\s*DATA\s*=\s*3,\s*REJECT\s*=\s*4/u, "frame type codes match");
  assert.match(ps, /MAX_PAYLOAD\s*=\s*64\s*\*\s*1024/u, "payload cap matches MAX_PAYLOAD (65536)");
  assert.equal(proto.MAX_PAYLOAD, 64 * 1024);
  assert.equal(proto.MAGIC.toString("ascii"), "FHP1");
});

// ------------------------------------------------------------------ runtime-shape gate + host-control evidence (review 9b)
test("v0.6 Hyper-V pipe: WORKER_RUNTIME_SHAPE PASS only for exactly one npipe mount matching the per-run pipe", async () => {
  const { workerRuntimeShapeVerdict } = pe;
  const pipe = "\\.\pipe\FusionV06Poc-r1-pipe";
  const ok = { mounts: [{ Type: "npipe", Source: pipe, Destination: pipe }] };
  assert.equal(workerRuntimeShapeVerdict(ok, { pipe }).verdict, "PASS");
  assert.equal(workerRuntimeShapeVerdict({ mounts: [{ Type: "npipe", Source: pipe, Destination: pipe }, { Type: "npipe", Source: "x", Destination: "x" }] }, { pipe }).verdict, "FAIL", "an extra mount prevents PASS");
  assert.equal(workerRuntimeShapeVerdict({ mounts: [{ Type: "npipe", Source: "\\.\pipe\FusionV06Poc-OTHER-pipe", Destination: pipe }] }, { pipe }).verdict, "FAIL", "wrong pipe source prevents PASS");
  assert.equal(workerRuntimeShapeVerdict({ mounts: [{ Type: "bind", Source: "C:\\", Destination: "C:\h" }] }, { pipe }).verdict, "FAIL", "a bind mount prevents PASS");
  assert.equal(workerRuntimeShapeVerdict({ mounts: [{ Type: "npipe", Source: "\\.\pipe\docker_engine", Destination: "\\.\pipe\docker_engine" }] }, { pipe }).verdict, "FAIL", "the engine pipe prevents PASS");
  assert.equal(workerRuntimeShapeVerdict({}, { pipe }).verdict, "INCOMPLETE", "no inspect shape -> INCOMPLETE, never PASS");
});

test("v0.6 Hyper-V pipe: the runtime shape GATES BROKER_ONLY_NETWORK_BOUNDARY=PROVEN (a bad/extra mount prevents PROVEN)", () => {
  const pipe = "\\.\pipe\FusionV06Poc-r1-pipe";
  const base: Record<string, any> = { pipe: goodPipe(), network: goodNet(), runtimeShapeExpected: { pipe },
    runtimeShape: { mounts: [{ Type: "npipe", Source: pipe, Destination: pipe }] },
    filesystem: {}, lifecycle: {}, cleanup: {} };
  assert.equal(pe.evaluatePipePoc(base).BROKER_ONLY_NETWORK_BOUNDARY, "PROVEN", "correct single mapped pipe allows the gate to PASS");
  const extra = structuredClone(base); extra.runtimeShape.mounts.push({ Type: "npipe", Source: "y", Destination: "y" });
  assert.equal(pe.evaluatePipePoc(extra).BROKER_ONLY_NETWORK_BOUNDARY, "NOT_PROVEN", "an extra npipe mount prevents PROVEN");
  const wrong = structuredClone(base); wrong.runtimeShape.mounts[0].Destination = "\\.\pipe\FusionV06Poc-OTHER-pipe";
  assert.equal(pe.evaluatePipePoc(wrong).BROKER_ONLY_NETWORK_BOUNDARY, "NOT_PROVEN", "a wrong pipe destination prevents PROVEN");
  const missing = structuredClone(base); delete missing.runtimeShape;
  assert.equal(pe.evaluatePipePoc(missing).BROKER_ONLY_NETWORK_BOUNDARY, "NOT_PROVEN", "no docker inspect shape -> not PROVEN");
});

test("v0.6 Hyper-V pipe: rawHostLan/DNS are proven DENIED only with a REAL host positive control, else INCOMPLETE", async () => {
  const nv = (await import(pathToFileURL(join(pocDir, "evaluator.mjs")).href)).networkVerdict;
  assert.equal(nv("timeout", "refused"), "UNKNOWN", "worker timeout + host could NOT reach -> cannot prove (INCOMPLETE)");
  assert.equal(nv("timeout", "connected"), "DENIED", "worker timeout + host CONNECTED -> isolation proven (DENIED)");
  assert.equal(nv("timeout", "not_run"), "UNKNOWN", "no control -> never a silent pass");
  assert.equal(nv("timeout", "answered"), "DENIED", "worker DNS timeout + host DNS ANSWERED -> proven DENIED");
});
