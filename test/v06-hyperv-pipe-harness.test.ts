import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import net from "node:net";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const pocDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "hyperv-poc");
const read = (f: string) => readFileSync(join(pocDir, f), "utf8");

// ---- static root-cause regressions for pipegate3 fixes (deterministic, always run) --------------------------------
test("v0.6 Hyper-V pipe-harness: guest-shim always deframes the pipe (no raw-write-after-established relay bug)", () => {
  const shim = read("guest-shim.mjs");
  assert.doesNotMatch(shim, /if \(established\) \{ client\.write\(d\); return; \}/u, "the raw-write-after-established shortcut (dropped the provider token) must not return");
  assert.match(shim, /ALWAYS deframe/u, "the pipe->client path deframes every chunk");
  assert.match(shim, /f\.type === FRAME\.DATA\)[^\n]*if \(established\)[^\n]*client\.write\(f\.payload\)/u, "only DATA payloads are forwarded to the client");
});

test("v0.6 Hyper-V pipe-harness: the raw-tcp spec is built element-safe (no leading-comma literal that drops rawInternet)", () => {
  const poc = read("pipe-poc.ps1");
  assert.doesNotMatch(poc, /rawTcp = @\(,\s*@\(/u, "the leading-comma array literal (which wrapped/dropped the first tuple) must not return");
  assert.match(poc, /\$rawTcp \+= , @\('1\.1\.1\.1', 443, 'rawInternet'\)/u, "each tuple is appended as one 3-item array");
});

test("v0.6 Hyper-V pipe-harness: host-pipe-escape targets are genuine HOST management pipes, not guest-internal OS pipes", () => {
  const poc = read("pipe-poc.ps1");
  assert.match(poc, /otherHostPipes = @\([^\)]*docker_engine/u, "docker_engine (a real host management pipe) is tested");
  assert.doesNotMatch(poc, /otherHostPipes = @\([^\)]*lsass/u, "lsass is a guest-internal OS pipe, never a host-IPC escape; must not be a host-pipe target");
  assert.doesNotMatch(poc, /otherHostPipes = @\([^\)]*ntsvcs/u, "ntsvcs is guest-internal; must not be a host-pipe target");
});

test("v0.6 Hyper-V pipe-harness: the canary emits structured per-target pipe arrays (stable keys, not backslash paths)", () => {
  const canary = read("pipe-canary.mjs");
  assert.match(canary, /out\.pipeGuess = \[\]/u);
  assert.match(canary, /out\.hostPipes = \[\]/u);
  assert.match(canary, /out\.hostPipes\.push\(\{ target: hp, outcome:/u, "per-host-pipe result recorded with target+outcome");
  assert.doesNotMatch(canary, /out\.otherPipes\[/u, "the fragile backslash-keyed otherPipes map is gone");
  assert.match(canary, /detached: true, stdio: "ignore"/u, "the spawned child is detached/unref'd so docker exec is not blocked ~10min");
});

test("v0.6 Hyper-V pipe-harness: the synthetic provider is async and DRAINS before a graceful close (no sequential/RST pitfalls)", () => {
  const prov = read("token-provider.mjs");
  // Root cause of the shim-path token loss: a SEQUENTIAL PowerShell Start-Job provider left the first (tunnel-held)
  // connection's response token unread by the broker. The replacement is an ASYNC server that DRAINS the forwarded
  // request (so close is a graceful FIN, never an RST that would discard the broker's in-flight receive buffer).
  assert.match(prov, /net\.createServer/u, "the provider is an async server (handles concurrent broker connections)");
  assert.match(prov, /s\.on\("data",[^\n]*\)/u, "the provider DRAINS the forwarded request");
  assert.match(prov, /s\.end\(\)/u, "the provider closes with a graceful FIN (s.end), not a hard reset");
  assert.doesNotMatch(prov, /resetAndDestroy|LingerOption\([^)]*0\s*\)/u, "the provider never forces an RST");
  // pipe-poc.ps1 must launch this async provider (not the old sequential Start-Job echo listener).
  const poc = read("pipe-poc.ps1");
  assert.match(poc, /token-provider\.mjs/u, "the orchestrator launches the async node provider");
  assert.doesNotMatch(poc, /\$echoBlock/u, "the fragile sequential Start-Job echo provider is gone");
});

test("v0.6 Hyper-V pipe-harness: the evaluator NEVER passes PIPE_TRANSPORT on connected-without-token-echo (no timing luck)", async () => {
  const mod = (await import(new URL("../../tools/hyperv-poc/pipe-evaluator.mjs", import.meta.url).href)) as {
    pipeTransportVerdict: (r: Record<string, unknown>) => { verdict: string; reasons: string[] };
  };
  const denies = { directPipeNoAuth: "refused", directPipeWrongCred: "refused", directPipeWrongDest: "refused", unauthorizedDestThroughBroker: "refused", pipeNameGuess: "refused", directPipeAuthorized: "connected" };
  // connected tunnel but the token did NOT round-trip (the exact bug: provider RST / dropped frame) => MUST be FAIL.
  const noEcho = mod.pipeTransportVerdict({ allowedRoute: "connected", allowedRouteTokenEchoed: false, ...denies });
  assert.equal(noEcho.verdict, "FAIL", "connected without token echo must FAIL, never PASS on timing luck");
  assert.ok(noEcho.reasons.some(r => /allowedRouteTokenEchoed/u.test(r)), "the failure names the missing token echo");
  // a timeout that never carried a token must also NOT pass.
  const timedOut = mod.pipeTransportVerdict({ allowedRoute: "timeout", allowedRouteTokenEchoed: false, ...denies });
  assert.equal(timedOut.verdict, "FAIL", "a timed-out allowed route must FAIL");
  // the genuine good path (token echoed + all adversarial paths denied) PASSES.
  const good = mod.pipeTransportVerdict({ allowedRoute: "connected", allowedRouteTokenEchoed: true, ...denies });
  assert.equal(good.verdict, "PASS", "drain -> graceful FIN -> token echoed + all denies => PASS");
});

test("v0.6 Hyper-V pipe-harness: PHASE-C crash/cleanup seams are present and the teardown is sequential, RunId-scoped, and fail-soft", () => {
  const poc = read("pipe-poc.ps1");
  // Crash-injection + mid-run-kill + standalone-cleanup seams exist (used by the live crash/cleanup matrix).
  assert.match(poc, /\[string\]\$CrashAfter = 'none'/u, "the -CrashAfter crash-injection seam exists");
  assert.match(poc, /\[string\]\$KillMidRun = 'none'/u, "the -KillMidRun seam exists");
  assert.match(poc, /\[switch\]\$CleanupOnly/u, "the -CleanupOnly standalone-cleanup seam exists");
  assert.match(poc, /function CrashIf\(\$stage\)/u, "CrashIf helper exists");
  // Two live Hyper-V VMs must NOT be torn down concurrently (it wedged the Docker Windows engine): the finally removes
  // the OTHER container before the worker, and waits for each to be gone.
  assert.match(poc, /foreach \(\$c in @\(\$otherName, \$worker\)\)/u, "the finally tears the other container down before the worker (sequential)");
  // Standalone cleanup must be scoped to THIS run id only and be fail-soft on locked diagnostic files.
  assert.match(poc, /function Invoke-PocCleanupStandalone/u, "standalone cleanup exists");
  assert.match(poc, /CommandLine -match \[regex\]::Escape\(\$RunId\)/u, "standalone cleanup kills ONLY this run's broker/provider processes");
  assert.match(poc, /Remove-Item -Force -ErrorAction SilentlyContinue/u, "file removal is fail-soft (a provider holding its .out must not abort cleanup)");
  // token-provider must carry the RunId on its command line so standalone cleanup can find orphaned providers.
  assert.match(poc, /token-provider\.mjs'\), \$ip, "\$port", \$cred, \$tag, \$RunId/u, "the provider launch passes the RunId (greppable for orphan recovery)");
});

test("v0.6 Hyper-V pipe-harness: PHASE-B negative probes (gateway/alt-vNIC/other-container/hostname/IPv6) must all be DENIED; IPv6 NOT_APPLICABLE is skipped not passed", async () => {
  const mod = (await import(new URL("../../tools/hyperv-poc/pipe-evaluator.mjs", import.meta.url).href)) as {
    networkNoneBoundaryVerdict: (r: Record<string, unknown>) => { verdict: string; reasons: string[] };
  };
  // A minimal baseline that PASSES: worker is loopback-only (no route, no DNS) and every mandatory negative is denied.
  const base = () => ({
    facts: { interfaces: [{ name: "loop", addresses: ["127.0.0.1", "::1"] }], routes: [], dnsServers: [] },
    rawInternet: "unreachable", rawHostLan: "unreachable", rawDns: "blocked", rawDirectProvider: "refused", rawSocketBypass: "unreachable",
    otherHostPipeOpen: "refused",
    rawGateway: "unreachable", rawAltVnic: "unreachable", rawOtherContainer: "unreachable", rawHostname: "blocked", rawIPv6: "unreachable",
    hostControls: { rawInternet: "connected", rawHostLan: "connected", rawDns: "answered", rawDirectProvider: "connected", rawSocketBypass: "connected", rawGateway: "timeout", rawAltVnic: "connected", rawOtherContainer: "connected", rawHostname: "connected", rawIPv6: "connected" },
  });
  assert.equal(mod.networkNoneBoundaryVerdict(base()).verdict, "PASS", "all negatives denied => PASS");
  for (const key of ["rawGateway", "rawAltVnic", "rawOtherContainer", "rawHostname", "rawIPv6"]) {
    const reached = base(); (reached as Record<string, unknown>)[key] = "connected"; // the worker reached it => escape
    assert.equal(mod.networkNoneBoundaryVerdict(reached).verdict, "FAIL", `${key} reachable from the worker must FAIL`);
  }
  // IPv6 genuinely unavailable in the worker: recorded not_applicable => skipped (still PASS), never a silent pass.
  const na = base(); na.rawIPv6 = "not_applicable";
  const naRes = mod.networkNoneBoundaryVerdict(na);
  assert.equal(naRes.verdict, "PASS", "a not_applicable IPv6 probe is skipped, not failed");
  assert.ok(naRes.reasons.some(r => /rawIPv6: NOT_APPLICABLE/u.test(r)), "the skip reason is recorded in evidence");
  // an unexecuted (timeout, no host control) extra probe must NOT silently pass.
  const to = base(); to.rawOtherContainer = "timeout"; to.hostControls.rawOtherContainer = "timeout";
  assert.notEqual(mod.networkNoneBoundaryVerdict(to).verdict, "PASS", "a timed-out probe with no positive control is never a silent PASS");
});

// ---- gated live regression: the shim token round-trip works end to end (Fix A), via the real .NET broker ----------
function findWinPs(): string | undefined {
  for (const c of ["powershell.exe", "powershell"]) { try { if (execFileSync(c, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" }).trim().startsWith("5")) return c; } catch { /* next */ } }
  return undefined;
}
test("v0.6 Hyper-V pipe-harness: worker->shim->pipe->broker->provider echoes the token (Fix A, host-side e2e)", async () => {
  const ps = findWinPs();
  if (ps === undefined) { console.log("(skipped: Windows PowerShell 5.1 not available)"); return; }
  // Unique per-invocation run id / ports so repeated runs never collide on the named pipe or a lingering listener
  // (the broker keeps an always-listening pipe instance; a fixed name flaked across back-to-back test runs).
  const uid = `reg${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`.replace(/[^a-z0-9]/gu, "").slice(0, 20);
  const basePort = 51760 + (process.pid % 97) * 3;
  const CRED = "r".repeat(64), PROV = basePort, SHIM = basePort + 1, PIPE = `\\\\.\\pipe\\FusionV06Poc-${uid}-pipe`, TOKEN = "REGTOKEN";
  const prov = net.createServer(s => { s.on("error", () => {}); s.on("data", () => {}); s.write(TOKEN + "\n"); setTimeout(() => s.end(), 500); });
  await new Promise<void>(r => prov.listen(PROV, "127.0.0.1", () => r()));
  const broker = spawn(ps, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(pocDir, "pipe-broker.ps1"), "-RunId", uid, "-PipeName", `FusionV06Poc-${uid}-pipe`, "-Credential", CRED, "-AllowedHost", "127.0.0.1", "-AllowedPort", String(PROV), "-DaclMode", "broad"], { stdio: ["ignore", "pipe", "pipe"] });
  const shim = spawn(process.execPath, [join(pocDir, "guest-shim.mjs"), String(SHIM), PIPE, CRED, "127.0.0.1", String(PROV)], { stdio: ["ignore", "pipe", "pipe"] });
  const waitFor = (p: ReturnType<typeof spawn>, needle: string, ms: number) => new Promise<void>((res, rej) => { let o = ""; const on = (d: Buffer) => { o += d.toString(); if (o.includes(needle)) { res(); } }; p.stdout!.on("data", on); p.stderr!.on("data", on); setTimeout(() => rej(new Error(`no ${needle}: ${o.slice(0, 300)}`)), ms); });
  try {
    await waitFor(broker, "BROKER_READY", 9000);
    await waitFor(shim, "SHIM_READY", 6000);
    const r = await new Promise<{ status: number; token: boolean }>(res => {
      let buf = "", status = 0, body = "", done = false;
      const c = net.connect({ host: "127.0.0.1", port: SHIM });
      const fin = () => { if (done) return; done = true; try { c.destroy(); } catch {} res({ status, token: body.includes(TOKEN) }); };
      c.once("connect", () => c.write(`CONNECT 127.0.0.1:${PROV} HTTP/1.1\r\nHost: x\r\n\r\n`));
      c.on("data", d => { const s = d.toString("latin1"); if (status === 0) { buf += s; const m = /^HTTP\/1\.1 (\d+)/u.exec(buf); if (m) status = Number(m[1]); const e = buf.indexOf("\r\n\r\n"); if (e >= 0 && status === 200) body += buf.slice(e + 4); if (status >= 400) return fin(); } else body += s; if (status === 200 && body.includes(TOKEN)) fin(); });
      c.once("error", fin); setTimeout(fin, 5000);
    });
    assert.equal(r.status, 200, "the shim established the broker tunnel");
    assert.equal(r.token, true, "the provider token round-tripped through shim->pipe->broker->provider (Fix A)");
  } finally { broker.kill(); shim.kill(); prov.close(); }
});
