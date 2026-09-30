import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const pocDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "hyperv-poc");
const { evaluateHostProbe, assertBounded, recommendStack, ALLOWED_KEYS } =
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

// ---------------------------------------------------------------- PowerShell static syntax gate (runs on the Windows CI runner)

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
