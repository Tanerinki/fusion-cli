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
