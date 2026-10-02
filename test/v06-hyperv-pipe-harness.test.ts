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
  assert.match(shim, /f\.type === FRAME\.DATA\) \{ if \(established\) client\.write\(f\.payload\)/u, "only DATA payloads are forwarded to the client");
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

// ---- gated live regression: the shim token round-trip works end to end (Fix A), via the real .NET broker ----------
function findWinPs(): string | undefined {
  for (const c of ["powershell.exe", "powershell"]) { try { if (execFileSync(c, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" }).trim().startsWith("5")) return c; } catch { /* next */ } }
  return undefined;
}
test("v0.6 Hyper-V pipe-harness: worker->shim->pipe->broker->provider echoes the token (Fix A, host-side e2e)", async () => {
  const ps = findWinPs();
  if (ps === undefined) { console.log("(skipped: Windows PowerShell 5.1 not available)"); return; }
  const CRED = "r".repeat(64), PROV = 51778, SHIM = 51779, PIPE = "\\\\.\\pipe\\FusionV06Poc-reg1-pipe", TOKEN = "REGTOKEN";
  const prov = net.createServer(s => { s.on("error", () => {}); s.write(TOKEN + "\n"); setTimeout(() => s.end(), 500); });
  await new Promise<void>(r => prov.listen(PROV, "127.0.0.1", () => r()));
  const broker = spawn(ps, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(pocDir, "pipe-broker.ps1"), "-RunId", "reg1", "-PipeName", "FusionV06Poc-reg1-pipe", "-Credential", CRED, "-AllowedHost", "127.0.0.1", "-AllowedPort", String(PROV), "-DaclMode", "broad"], { stdio: ["ignore", "pipe", "pipe"] });
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
