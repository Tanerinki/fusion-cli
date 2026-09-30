import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const pocDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "hyperv-poc");
const { evaluateHostProbe, assertBounded, recommendStack, ALLOWED_KEYS, parseReport } =
  await import(pathToFileURL(join(pocDir, "host-probe-eval.mjs")).href);

/** A report describing a fully-capable host (the only shape that may be PASS). */
const capableHost = () => ({
  schema: "fusion.hyperv.hostprobe/1", generatedAt: "2026-09-30T00:00:00Z",
  os: { edition: "Windows 11 Pro", version: "10.0.26200", build: "26200", architecture: "64-bit" },
  hypervisorPresent: true, firmwareVirtualization: { firmwareEnabled: true, slat: true },
  hyperVFeature: "Enabled", containersFeature: "Enabled",
  hcs: { available: true, status: "Running", computeCoreDll: true },
  hns: { available: true, serviceStatus: "Running", moduleCmdlets: true },
  hnsNetworks: [{ name: "nat", type: "NAT" }], vfpAclSupport: "exposed-via-hns-acl-policy",
  containerd: { available: true, version: "containerd 1.7", path: "C:/containerd/ctr.exe" },
  ctr: { available: true, version: "ctr 1.7", path: "C:/containerd/ctr.exe" },
  docker: { available: false, version: null, path: null }, windowsContainerRuntime: "containerd/ctr",
  baseImages: ["mcr.microsoft.com/windows/servercore:ltsc2022"], adapters: [{ name: "Ethernet", status: "Up", kind: "x" }],
  vSwitches: [{ name: "Default Switch", type: "Internal" }], dedicatedWorkerFacingAddressPossible: true,
  hyperVIsolationRequestable: true, canRunCandidateImage: "host-build-26200; match a servercore tag",
});

test("v0.6 host-probe eval: a fully-capable host is PASS and recommends the native containerd/ctr stack", () => {
  const r = evaluateHostProbe(capableHost());
  assert.equal(r.verdict, "PASS");
  assert.equal(r.missing.length, 0);
  assert.match(r.recommendedStack, /containerd\/ctr/u, "prefers native HCS/HNS + containerd, not Docker");
});

test("v0.6 host-probe eval: missing capabilities force INCOMPLETE with the exact prerequisites (never a silent PASS)", () => {
  const noHyperV = capableHost(); noHyperV.hyperVFeature = "Disabled"; noHyperV.hypervisorPresent = false;
  const a = evaluateHostProbe(noHyperV);
  assert.equal(a.verdict, "INCOMPLETE");
  assert.ok(a.missing.some((m: string) => /Hyper-V/u.test(m)), "names the Hyper-V prerequisite");
  const noRuntime = capableHost(); noRuntime.ctr.available = false; noRuntime.containerd.available = false; noRuntime.docker.available = false;
  const b = evaluateHostProbe(noRuntime);
  assert.equal(b.verdict, "INCOMPLETE");
  assert.ok(b.missing.some((m: string) => /runtime/iu.test(m)));
  const noHns = capableHost(); noHns.hns.available = false;
  assert.equal(evaluateHostProbe(noHns).verdict, "INCOMPLETE");
});

test("v0.6 host-probe eval: a field it cannot determine (missing data) yields INCOMPLETE, not PASS", () => {
  const partial = capableHost(); partial.hypervisorPresent = undefined as unknown as boolean;
  assert.equal(evaluateHostProbe(partial).verdict, "INCOMPLETE");
});

test("v0.6 host-probe eval: only Docker present ⇒ recommends Docker as labelled PoC plumbing, not a trust dependency", () => {
  const d = capableHost(); d.ctr.available = false; d.containerd.available = false; d.docker.available = true;
  const r = evaluateHostProbe(d);
  assert.equal(r.verdict, "PASS", "Docker is a usable runtime for the PoC");
  assert.match(r.recommendedStack, /Docker.*not a production trust dependency/u);
});

test("v0.6 host-probe eval: the output schema is bounded — a non-allow-listed field is rejected", () => {
  assert.equal(assertBounded(capableHost()), true);
  assert.throws(() => assertBounded({ ...capableHost(), OPENAI_API_KEY: "leak" }), /non-bounded field/u,
    "a stray/secret field is refused, so the artifact stays bounded");
  assert.ok(ALLOWED_KEYS.length >= 18 && !ALLOWED_KEYS.includes("env"), "the allow-list excludes environment dumps");
  assert.equal(typeof recommendStack(capableHost()), "string");
});

test("v0.6 host-probe eval: a BOM-prefixed report is parsed (PS 5.1 UTF-8 BOM regression)", () => {
  const withBom = "﻿" + JSON.stringify(capableHost());
  const parsed = parseReport(withBom);
  assert.equal(parsed.schema, "fusion.hyperv.hostprobe/1", "the leading BOM is tolerated");
  assert.equal(evaluateHostProbe(parsed).verdict, "PASS");
  assert.equal(parseReport(JSON.stringify(capableHost())).schema, "fusion.hyperv.hostprobe/1", "a BOM-less report parses too");
});

test("v0.6 host-probe eval: a runtime present but Hyper-V isolation UNKNOWN (null) ⇒ INCOMPLETE, not assumed", () => {
  const d = capableHost(); d.hyperVIsolationRequestable = null as unknown as boolean;   // e.g. docker in Windows mode, isolation undeterminable
  const r = evaluateHostProbe(d);
  assert.equal(r.verdict, "INCOMPLETE");
  assert.ok(r.missing.some((m: string) => /could not be determined|unknown/iu.test(m)), "unknown isolation is not assumed usable");
});

test("v0.6 host-probe eval: an unreadable feature state (accessDenied) ⇒ bounded INCOMPLETE with an elevate hint (never blank)", () => {
  const d = capableHost(); d.hyperVFeature = "accessDenied";
  const r = evaluateHostProbe(d);
  assert.equal(r.verdict, "INCOMPLETE");
  const m = r.missing.find((x: string) => /Hyper-V feature state could not be read/u.test(x));
  assert.ok(m && /ELEVATED/u.test(m), "the reason is bounded and tells the maintainer to re-run elevated");
  assert.equal(assertBounded(d), true, "a report carrying reason tokens + null fields is still bounded (no secret fields)");
});

test("v0.6 host-probe eval: dedicatedWorkerFacingAddressPossible is informational and honestly tri-state (true/false/null), not required for PASS", () => {
  for (const v of [true, false, null]) {
    const d = capableHost(); d.dedicatedWorkerFacingAddressPossible = v as unknown as boolean;
    assert.equal(evaluateHostProbe(d).verdict, "PASS", `dedicated=${v} does not change the verdict`);
  }
});

// ---------------------------------------------------------------- PowerShell static syntax gate + BOM-less output (Windows CI)

test("v0.6 Hyper-V PoC: every harness .ps1 parses without syntax errors", () => {
  let ps: string | undefined;
  for (const cand of ["pwsh", "powershell"]) { try { execFileSync(cand, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { stdio: "ignore" }); ps = cand; break; } catch { /* not this one */ } }
  if (ps === undefined) { console.log("(skipped: PowerShell not available on this platform)"); return; }
  const files = readdirSync(pocDir, { recursive: true } as never).filter((f: unknown) => typeof f === "string" && (f as string).endsWith(".ps1")) as string[];
  assert.ok(files.length >= 6, `found harness scripts (${files.length})`);
  for (const rel of files) {
    const full = join(pocDir, rel);
    const script = `$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${full.replace(/'/gu, "''")}',[ref]$null,[ref]$e);if($e -and $e.Count){$e|%{Write-Error $_.Message};exit 3}`;
    // Throws (non-zero exit) if the file has any parse error → the test fails and names the file.
    execFileSync(ps, ["-NoProfile", "-Command", script], { stdio: "pipe" });
  }
});

test("v0.6 Hyper-V PoC: host-probe.ps1 runs READ-ONLY and writes BOM-less valid JSON (Windows CI)", () => {
  let ps: string | undefined;
  for (const cand of ["pwsh", "powershell"]) { try { execFileSync(cand, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { stdio: "ignore" }); ps = cand; break; } catch { /* not this one */ } }
  if (ps === undefined) { console.log("(skipped: PowerShell not available)"); return; }
  const out = join(tmpdir(), `fusion-hostprobe-${Date.now()}.json`);
  try {
    execFileSync(ps, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(pocDir, "host-probe.ps1"), "-OutPath", out], { stdio: "ignore" });
  } catch { /* the eval CLI exits 2 on INCOMPLETE; the report is still written */ }
  const bytes = readFileSync(out);
  assert.notEqual([bytes[0], bytes[1], bytes[2]].join(","), "239,187,191", "output must be BOM-less UTF-8");
  const doc = JSON.parse(bytes.toString("utf8"));
  assert.equal(doc.schema, "fusion.hyperv.hostprobe/1", "the report is valid JSON");
  assert.equal(assertBounded(doc), true, "the real report carries only bounded fields (no secrets)");
  rmSync(out, { force: true });
});
