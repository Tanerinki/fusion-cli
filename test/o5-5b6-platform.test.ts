import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../src/app/config.js";
import { FusionFailure } from "../src/core/errors.js";
import { assessPlatformRequirement, detectPlatformSignals, PLATFORM_REQUIREMENTS,
  type PlatformRequirement } from "../src/core/policy/platform.js";
import { executeVerification, TrustedHostBackend } from "../src/platform/verification/backend.js";
import { DockerLinuxVerificationBackend } from "../src/platform/verification/docker/backend.js";
import { platformEligibility } from "../src/platform/verification/platform-compat.js";
import { staticEligibility } from "../src/platform/verification/selection.js";
import { FAKE_DOCKER_EXE, FAKE_IMAGE, FakeDocker } from "./fixtures/fake-docker.js";

const kind = (name: string) => (error: unknown): boolean => error instanceof FusionFailure && error.error.kind === name;
const docker = (fake = new FakeDocker()) => new DockerLinuxVerificationBackend({ image: FAKE_IMAGE, runner: fake,
  resolveDocker: () => Promise.resolve(FAKE_DOCKER_EXE) });
const plan = { commands: [{ id: "t", executable: "/usr/local/bin/node", args: ["--test"], cwd: ".", timeoutMs: 1_000,
  mutationPolicy: "readOnly" as const }] };

test("O5.5B6 platform: neutral and Linux tasks are eligible for Docker/Linux; Windows, unknown and missing are not", async () => {
  const backend = docker();
  const expected: Record<string, boolean> = { "platform-neutral": true, "linux-compatible": true, "windows-required": false, unknown: false };
  for (const [requirement, eligible] of Object.entries(expected)) {
    assert.equal(platformEligibility("linux", requirement).eligible, eligible, requirement);
    assert.equal(staticEligibility(backend, { purpose: "autonomousWriter", platformRequirement: requirement }).eligible, eligible, requirement);
  }
  for (const missing of [undefined, null, "", "Linux", "windows", 42])
    assert.equal(staticEligibility(backend, { purpose: "autonomousWriter", platformRequirement: missing }).eligible, false, String(missing));
  // A Windows-required, unknown or missing requirement never reaches Docker at all.
  for (const platformRequirement of ["windows-required", "unknown", undefined] as const) {
    const fake = new FakeDocker();
    await assert.rejects(executeVerification(docker(fake), { plan, workspaceRoot: "/x", git: {} as never, env: {},
      ...(platformRequirement === undefined ? {} : { platformRequirement }) }), kind("CapabilityUnavailable"));
    assert.equal(fake.calls.length, 0, String(platformRequirement));
  }
  // Linux acceptance says nothing about Windows semantics.
  assert.equal(platformEligibility("linux", "windows-required").eligible, false);
});

test("O5.5B6 platform: a missing or invalid declaration is unknown; declared values stand unless escalated", () => {
  assert.deepEqual([assessPlatformRequirement({}).declared, assessPlatformRequirement({}).effective], ["missing", "unknown"]);
  assert.deepEqual([assessPlatformRequirement({ declared: "linux" }).declared, assessPlatformRequirement({ declared: "linux" }).effective],
    ["invalid", "unknown"]);
  for (const declared of PLATFORM_REQUIREMENTS) assert.equal(assessPlatformRequirement({ declared }).effective, declared);
});

test("O5.5B6 platform: deterministic signals escalate and a model can never lower the requirement", () => {
  const signals = detectPlatformSignals({ paths: ["scripts/setup.ps1"] });
  assert.deepEqual(signals.map(signal => signal.code), ["powershellScript"]);
  for (const declared of ["platform-neutral", "linux-compatible"] as const)
    assert.equal(assessPlatformRequirement({ declared, signals }).effective, "windows-required", declared);
  const order: PlatformRequirement[] = ["platform-neutral", "linux-compatible", "windows-required", "unknown"];
  for (const declared of order) for (const suggestion of order) {
    const assessment = assessPlatformRequirement({ declared, modelSuggestion: suggestion });
    assert.equal(order.indexOf(assessment.effective) >= order.indexOf(declared), true, `${declared} + ${suggestion}`);
    assert.equal(assessment.effective, order[Math.max(order.indexOf(declared), order.indexOf(suggestion))]);
    assert.equal(assessment.modelSuggestion?.applied, order.indexOf(suggestion) > order.indexOf(declared));
  }
  // The classic attack: repository/model text claiming neutrality after a deterministic Windows signal.
  const attacked = assessPlatformRequirement({ declared: "platform-neutral", signals, modelSuggestion: "platform-neutral" });
  assert.equal(attacked.effective, "windows-required");
  assert.equal(attacked.modelSuggestion?.applied, false);
  assert.equal(assessPlatformRequirement({ declared: "unknown", modelSuggestion: "linux-compatible" }).effective, "unknown");
  assert.equal(assessPlatformRequirement({ declared: "linux-compatible", modelSuggestion: { lower: true } }).modelSuggestion?.value, "invalid");
  // Order-independent.
  const reversed = assessPlatformRequirement({ declared: "linux-compatible", signals: [...detectPlatformSignals({ paths: ["b.bat", "a.reg"] })].reverse() });
  assert.equal(reversed.effective, "windows-required");
});

test("O5.5B6 platform: Windows signals come from paths, the package manifest and bounded file text — evidence never carries content", () => {
  const codes = (input: Parameters<typeof detectPlatformSignals>[0]) => detectPlatformSignals(input).map(signal => signal.code).sort();
  assert.deepEqual(codes({ paths: ["a.PS1", "b.cmd", "c.vbs", "d.reg", "e.vcxproj", "bin/tool.exe", "src/index.ts"] }),
    ["msbuildNativeProject", "powershellScript", "registryFile", "windowsBatchScript", "windowsBinary", "windowsScriptHost"]);
  assert.deepEqual(codes({ packageJson: { os: ["win32"], dependencies: { winreg: "1.0.0", lodash: "4" } } }),
    ["packageOsWin32Only", "windowsOnlyDependency"]);
  assert.deepEqual(codes({ packageJson: { os: ["win32", "linux"] } }), [], "a cross-platform os list is not a Windows requirement");
  const secret = "SECRET-FILE-CONTENT";
  const fromText = detectPlatformSignals({ files: [
    { path: "src/reg.ts", text: `const key = "HKEY_LOCAL_MACHINE\\\\Software"; // ${secret}` },
    { path: "src/ps.ts", text: `spawn("powershell.exe", ["-Command", "Get-Acl C:\\\\x"]);` },
    { path: "src/svc.ts", text: "execFile('sc.exe', ['create', 'svc']); run('New-Service -Name x'); new ActiveXObject('x'); require('kernel32');" },
    { path: "src/plain.ts", text: "export const platform = process.platform === 'win32' ? 'w' : 'p';" } ] });
  assert.deepEqual([...new Set(fromText.map(signal => signal.code))].sort(),
    ["comAutomation", "ntfsAclSemantics", "powershellInvocation", "registryAccess", "win32Api", "windowsOnlyBinary", "windowsService"]);
  assert.equal(fromText.some(signal => signal.evidence.includes(secret)), false);
  assert.equal(fromText.some(signal => signal.evidence === "src/plain.ts"), false, "a platform switch alone is not a requirement");
  assert.ok(detectPlatformSignals({ paths: Array.from({ length: 1_000 }, (_, i) => `x${i}.bat`) }).length <= 64, "bounded");
});

test("O5.5B6 platform: the project declaration is validated configuration data, never silently ignored", () => {
  const base = { schemaVersion: 1, verification: { commands: [] } };
  assert.equal(parseConfig(base).verification.platformRequirement, undefined);
  assert.equal(parseConfig({ ...base, verification: { commands: [], platformRequirement: "linux-compatible" } })
    .verification.platformRequirement, "linux-compatible");
  for (const bad of ["linux", "LINUX-COMPATIBLE", 1, null])
    assert.throws(() => parseConfig({ ...base, verification: { commands: [], platformRequirement: bad } }), kind("InvalidInput"));
});

test("O5.5B6 platform: the trusted host backend has no platform semantics and is refused for autonomous Writers regardless", () => {
  const host = new TrustedHostBackend();
  for (const requirement of PLATFORM_REQUIREMENTS)
    assert.equal(staticEligibility(host, { purpose: "autonomousWriter", platformRequirement: requirement }).reason, "trusted-host-refused");
  assert.equal(staticEligibility(host, { purpose: "humanApprovedHost", platformRequirement: "unknown" }).eligible, true);
});
