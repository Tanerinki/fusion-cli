import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const pocDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "hyperv-poc");
const { stripBom, readJsonFile } = await import(pathToFileURL(join(pocDir, "json-io.mjs")).href);

const NET = "5EA0F9EF-9AC4-47CA-9ACC-2936BD08A331";
const EP = "2c1d0000-0000-0000-0000-00000000abcd";
const inspectDoc = JSON.stringify([{ NetworkSettings: { Networks: { "FusionV06Poc-livegate-net": { IPAddress: "10.250.37.22" } } } }]);
const epsDoc = JSON.stringify([{ Id: EP, VirtualNetwork: NET, IPAddress: "10.250.37.22" }]);

function findWinPs(): string | undefined {
  for (const cand of ["powershell.exe", "powershell"]) {
    try { if (execFileSync(cand, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" }).trim().startsWith("5")) return cand; } catch { /* next */ }
  }
  return undefined;
}

// ------------------------------------------------------------------ pure BOM tolerance
test("v0.6 Hyper-V BOM: stripBom/readJsonFile parse BOM-free and BOM-prefixed JSON identically, and fail closed on malformed", () => {
  assert.equal(stripBom("﻿{\"a\":1}"), "{\"a\":1}");
  assert.equal(stripBom("{\"a\":1}"), "{\"a\":1}");
  const dir = mkdtempSync(join(tmpdir(), "fusion-bom-"));
  try {
    const clean = join(dir, "clean.json"); writeFileSync(clean, "{\"x\":1}", "utf8");
    const withBom = join(dir, "bom.json"); writeFileSync(withBom, "﻿{\"x\":1}", "utf8");
    assert.deepEqual(readJsonFile(clean), { x: 1 });
    assert.deepEqual(readJsonFile(withBom), { x: 1 }, "a leading U+FEFF is tolerated and parses identically");
    const bad = join(dir, "bad.json"); writeFileSync(bad, "﻿{not json", "utf8");
    assert.throws(() => readJsonFile(bad), /./u, "malformed JSON still fails closed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ discover-endpoint tolerates a leading BOM (the exact livegate3 failure)
test("v0.6 Hyper-V BOM: discover-endpoint.mjs parses BOM-prefixed inspect/endpoint JSON (the livegate3 crash) and still finds the endpoint", () => {
  const dir = mkdtempSync(join(tmpdir(), "fusion-bom-"));
  try {
    const inspectP = join(dir, "inspect.json"); const epsP = join(dir, "eps.json");
    writeFileSync(inspectP, "﻿" + inspectDoc, "utf8");  // the PS 5.1 Out-File -Encoding utf8 shape that broke it
    writeFileSync(epsP, "﻿" + epsDoc, "utf8");
    const out = execFileSync(process.execPath, [join(pocDir, "discover-endpoint.mjs"), inspectP, "FusionV06Poc-livegate-net", NET, epsP], { encoding: "utf8" });
    assert.match(out, new RegExp(`ENDPOINT_ID=${EP}`, "u"), "the worker endpoint is found despite the BOM");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("v0.6 Hyper-V BOM: discover-endpoint.mjs fails closed (exit 2, MALFORMED) on malformed JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "fusion-bom-"));
  try {
    const inspectP = join(dir, "inspect.json"); const epsP = join(dir, "eps.json");
    writeFileSync(inspectP, "{not json", "utf8"); writeFileSync(epsP, epsDoc, "utf8");
    let code = 0, out = "";
    try { out = execFileSync(process.execPath, [join(pocDir, "discover-endpoint.mjs"), inspectP, "n", NET, epsP], { encoding: "utf8", stdio: "pipe" }); }
    catch (e) { const err = e as { status?: number; stdout?: string }; code = err.status ?? 0; out = err.stdout ?? ""; }
    assert.equal(code, 2, "malformed JSON exits 2 (fail closed)");
    assert.match(out, /ENDPOINT_STATUS=MALFORMED/u);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ producer writes BOM-free (static + Windows-PS byte check)
test("v0.6 Hyper-V BOM: run.ps1 writes inspect/endpoint JSON BOM-free (WriteAllText + UTF8Encoding(false)), never Out-File -Encoding utf8", () => {
  const run = readFileSync(join(pocDir, "run.ps1"), "utf8");
  assert.doesNotMatch(run, /Out-File\s+-Encoding\s+utf8/u, "no PS 5.1 Out-File -Encoding utf8 (it emits a BOM)");
  assert.match(run, /WriteAllText\(\$inspectPath/u, "inspect JSON written via WriteAllText");
  assert.match(run, /WriteAllText\(\$epsPath/u, "endpoint JSON written via WriteAllText");
  assert.match(run, /UTF8Encoding\(\$false\)/u, "BOM-free encoding");
});

test("v0.6 Hyper-V BOM: a WriteAllText(UTF8Encoding(false)) file produced like run.ps1 has no EF BB BF and discover parses it (Windows PS)", () => {
  const ps = findWinPs();
  if (ps === undefined) { console.log("(skipped: Windows PowerShell 5.1 not available)"); return; }
  const dir = mkdtempSync(join(tmpdir(), "fusion bom ")); // spaced path too
  try {
    const inspectP = join(dir, "inspect.json"); const epsP = join(dir, "eps.json");
    const write = (p: string, json: string) => execFileSync(ps, ["-NoProfile", "-Command", `[System.IO.File]::WriteAllText('${p.replace(/'/gu, "''")}', '${json.replace(/'/gu, "''")}', (New-Object System.Text.UTF8Encoding($false)))`], { stdio: "ignore" });
    write(inspectP, inspectDoc); write(epsP, epsDoc);
    for (const p of [inspectP, epsP]) {
      const b = readFileSync(p);
      assert.notEqual([b[0], b[1], b[2]].join(","), "239,187,191", `${p} must have no UTF-8 BOM`);
    }
    const out = execFileSync(process.execPath, [join(pocDir, "discover-endpoint.mjs"), inspectP, "FusionV06Poc-livegate-net", NET, epsP], { encoding: "utf8" });
    assert.match(out, new RegExp(`ENDPOINT_ID=${EP}`, "u"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ run.ps1 fail-closed classification (exception -> EXECUTION_ERROR exit 3, never FAIL)
test("v0.6 Hyper-V BOM: run.ps1 maps a harness exception (missing provision json) to EXECUTION_ERROR exit 3, NEVER a verified FAIL", () => {
  const ps = findWinPs();
  if (ps === undefined) { console.log("(skipped: Windows PowerShell 5.1 not available)"); return; }
  const dir = mkdtempSync(join(tmpdir(), "fusion run ")); // empty OutDir: no provision-<RunId>.json -> Get-Content throws
  let code = 0, out = "";
  try { out = execFileSync(ps, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(pocDir, "run.ps1"), "-RunId", "execerr01", "-OutDir", dir], { encoding: "utf8", stdio: "pipe" }); }
  catch (e) { const err = e as { status?: number; stdout?: string; stderr?: string }; code = err.status ?? 0; out = (err.stdout ?? "") + (err.stderr ?? ""); }
  finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(code, 3, "an execution error exits 3 (EXECUTION_ERROR), not 1 (verified FAIL)");
  assert.match(out, /RUN_EXECUTION_ERROR/u);
  assert.match(out, /no result-execerr01\.json was written/u, "the final line does not imply a result file exists");
});

test("v0.6 Hyper-V BOM: run.ps1 gates ACL/post-canary on a uniquely-discovered GUID and never .Trim() an array; elevated-run maps exit 3", () => {
  const run = readFileSync(join(pocDir, "run.ps1"), "utf8");
  assert.match(run, /Select-Object -First 1/u, "exactly one ENDPOINT_ID line is selected");
  assert.match(run, /\$guidOk\s*=\s*\$endpointId\s*-match/u, "a well-formed GUID is required");
  assert.match(run, /\$discoveryOk/u, "discovery success gates ACL + post-canary");
  assert.match(run, /\$postAcl = if \(\$runCanary\) \{ Invoke-Canary \} else \{ \$null \}/u, "post-ACL canary runs only when discovery+ACL-effective gate (\$runCanary) holds");
  assert.match(run, /\$runCanary = \$discoveryOk -and \(\$SkipAcl -or \(\$aclApplied -ne 'YES'\) -or \(\$aclEffective -eq 'YES'\)\)/u, "an applied-but-not-effective ACL stops before canaries");
  assert.match(run, /catch \{[\s\S]*exit 3/u, "a harness exception exits 3 (EXECUTION_ERROR)");
  const elevated = readFileSync(join(pocDir, "elevated-run.ps1"), "utf8");
  assert.match(elevated, /3 \{ \$runVerdict = 'EXECUTION_ERROR' \}/u, "elevated-run maps run exit 3 to EXECUTION_ERROR");
});

// ------------------------------------------------------------------ effective-policy CLI (accepted != enforced)
test("v0.6 Hyper-V BOM: acl-effective.mjs reports ACL_EFFECTIVE=YES when the two rules are present (BOM-tolerant), NO otherwise", () => {
  const dir = mkdtempSync(join(tmpdir(), "fusion-eff-"));
  try {
    const present = join(dir, "eff.json");
    const effDoc = { runId: "x", endpointId: EP, networkId: NET, endpointIp: "10.250.37.22", Policies: [
      { Type: "ACL", Action: "Allow", Direction: "Out", Protocols: "6", RemoteAddresses: "10.250.37.1/32", RemotePorts: "47610", RuleType: "Switch", Priority: 100 },
      { Type: "ACL", Action: "Block", Direction: "Out", RuleType: "Switch", Priority: 200 },
    ] };
    writeFileSync(present, "﻿" + JSON.stringify(effDoc), "utf8"); // BOM-prefixed: must still be read
    const ok = execFileSync(process.execPath, [join(pocDir, "acl-effective.mjs"), present, "10.250.37.1", "47610"], { encoding: "utf8" });
    assert.match(ok, /ACL_EFFECTIVE=YES/u);
    const missing = join(dir, "eff2.json");
    writeFileSync(missing, JSON.stringify({ Policies: [{ Type: "OutBoundNAT", Settings: {} }] }), "utf8");
    let out = "", code = 0;
    try { out = execFileSync(process.execPath, [join(pocDir, "acl-effective.mjs"), missing, "10.250.37.1", "47610"], { encoding: "utf8", stdio: "pipe" }); }
    catch (e) { const err = e as { status?: number; stdout?: string }; code = err.status ?? 0; out = err.stdout ?? ""; }
    assert.match(out, /ACL_EFFECTIVE=NO/u);
    assert.equal(code, 2, "not-effective exits 2 so run.ps1 can stop before canaries");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
