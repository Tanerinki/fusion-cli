import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const pocDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "hyperv-poc");

function findPwsh(): string | undefined {
  for (const cand of ["pwsh", "powershell"]) {
    try { execFileSync(cand, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { stdio: "ignore" }); return cand; } catch { /* next */ }
  }
  return undefined;
}

test("v0.6 Hyper-V launch: native-launch.ps1 quotes a node script path containing spaces as ONE argument", () => {
  const ps = findPwsh();
  if (ps === undefined) { console.log("(skipped: PowerShell not available)"); return; }
  const helper = join(pocDir, "native-launch.ps1").replace(/'/gu, "''");
  const spaced = "C:\\some directory\\fusion cli\\tools\\hyperv-poc\\listener.mjs";
  const script = `. '${helper}'; [Console]::Out.Write((Get-NativeArgString @('${spaced.replace(/'/gu, "''")}','10.0.0.1','47610','tok')))`;
  const out = execFileSync(ps, ["-NoProfile", "-Command", script], { encoding: "utf8" });
  assert.ok(out.includes(`"${spaced}"`), `the spaced path is a single quoted token: ${out}`);
  // And it must NOT appear unquoted/split (no bare "C:\some directory\..." starting a token without the opening quote).
  assert.ok(!/(^|\s)C:\\some directory\\/u.test(out), `the spaced path must not be split into multiple args: ${out}`);
  assert.ok(out.trim().endsWith("10.0.0.1 47610 tok"), `the remaining simple args are preserved: ${out}`);
});

test("v0.6 Hyper-V launch: the broker launch argv preserves a spaced script path AND a spaced ReadyFile as single quoted tokens", () => {
  const ps = findPwsh();
  if (ps === undefined) { console.log("(skipped: PowerShell not available)"); return; }
  const helper = join(pocDir, "native-launch.ps1").replace(/'/gu, "''");
  // The exact shape pipe-poc.ps1 builds: -File <pipe-broker.ps1 under a spaced dir> ... -ReadyFile <spaced path>.
  const scriptPath = "D:\apps backup\fusion-cli\tools\hyperv-poc\pipe-broker.ps1";
  const readyFile = "D:\apps backup\fusion-cli\tools\hyperv-poc\FusionV06Poc-pg1-broker.ready";
  const argList = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
    "-RunId", "pg1", "-PipeName", "FusionV06Poc-pg1-pipe", "-Credential", "deadbeef", "-AllowedHost", "127.0.0.1",
    "-AllowedPort", "51730", "-DaclMode", "broad", "-ReadyFile", readyFile];
  const psArr = argList.map(a => `'${a.replace(/'/gu, "''")}'`).join(",");
  const script = `. '${helper}'; [Console]::Out.Write((Get-NativeArgString @(${psArr})))`;
  const out = execFileSync(ps, ["-NoProfile", "-Command", script], { encoding: "utf8" });
  assert.ok(out.includes(`"${scriptPath}"`), `the spaced -File script path is one quoted token: ${out}`);
  assert.ok(out.includes(`"${readyFile}"`), `the spaced -ReadyFile path is one quoted token: ${out}`);
  // Every non-spaced argument is preserved verbatim and in order.
  for (const tok of ["-File", "-RunId", "pg1", "-PipeName", "FusionV06Poc-pg1-pipe", "-ReadyFile", "-AllowedPort", "51730"]) assert.ok(out.includes(tok), `arg preserved: ${tok}`);
  // The spaced path must never appear UNQUOTED (not immediately preceded by a double quote) -- that would mean it split.
  const bare = "D:\\apps backup";
  for (let i = out.indexOf(bare); i >= 0; i = out.indexOf(bare, i + 1)) assert.equal(out[i - 1], '"', `the spaced path occurrence at ${i} must be inside quotes (not split): ${out}`);
});
