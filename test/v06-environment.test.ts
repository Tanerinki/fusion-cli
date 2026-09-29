import assert from "node:assert/strict";
import { test } from "node:test";
import { capabilityManifest, type CapabilityManifestInput, type ResourceLimits } from "../src/core/isolation/capability-manifest.js";
import { looksSensitive, minimizeEnvironment } from "../src/core/isolation/environment.js";

const LIMITS: ResourceLimits = Object.freeze({ timeoutMs: 60_000, maxProcesses: 8, maxOutputBytes: 1024 * 1024, maxMemoryBytes: null, maxCpuMs: null });
const manifest = (allowedEnvNames: readonly string[]): ReturnType<typeof capabilityManifest> => {
  const input: CapabilityManifestInput = { executionId: "x-1", runId: "r-1", backend: "appcontainer", sandboxIdentity: "id.1",
    writePaths: ["C:\\w"], workingDirectory: "C:\\w", limits: LIMITS, policyVersion: "0.6.0", allowedEnvNames };
  return capabilityManifest(input);
};

test("v0.6 env: only the allow-listed names pass; everything else is dropped (deny by default)", () => {
  const host = { SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32", ANTHROPIC_API_KEY: "secret", HOME: "C:\\Users\\x" };
  const { env, report } = minimizeEnvironment(host, manifest(["SystemRoot", "PATH"]));
  assert.deepEqual(Object.keys(env).sort(), ["PATH", "SystemRoot"]);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(report.allowed, 2);
  assert.equal(report.droppedTotal, 2);
});

test("v0.6 env: a dropped credential-shaped name is recorded (name only), a value is never copied", () => {
  const host = { API_TOKEN: "t", AWS_SECRET_ACCESS_KEY: "s", SSH_AUTH_SOCK: "\\\\.\\pipe\\ssh", GITHUB_TOKEN: "g", ORDINARY: "1", PATH: "p" };
  const { env, report } = minimizeEnvironment(host, manifest(["PATH"]));
  assert.deepEqual(Object.keys(env), ["PATH"]);
  assert.ok(report.droppedSensitiveCount >= 3, `sensitive dropped: ${report.droppedSensitiveCount}`);
  assert.ok(report.droppedSensitiveNames.includes("AWS_SECRET_ACCESS_KEY"));
  assert.ok(report.droppedSensitiveNames.includes("GITHUB_TOKEN"));
  // No value string of a dropped var appears anywhere in the report.
  const blob = JSON.stringify(report);
  for (const secret of ["t", "s", "g"]) assert.ok(!blob.includes(`"${secret}"`));
});

test("v0.6 env: matching is case-insensitive but the host's key spelling is preserved", () => {
  const host = { Path: "p", systemroot: "r" };
  const { env } = minimizeEnvironment(host, manifest(["PATH", "SystemRoot"]));
  assert.equal(env.Path, "p");
  assert.equal(env.systemroot, "r");
});

test("v0.6 env: an allowed name the host does not define is simply absent (nothing invented)", () => {
  const { env, report } = minimizeEnvironment({ PATH: "p" }, manifest(["PATH", "NOT_SET"]));
  assert.deepEqual(Object.keys(env), ["PATH"]);
  assert.equal(report.allowed, 1);
});

test("v0.6 env: an empty allow-list yields an empty environment", () => {
  const { env, report } = minimizeEnvironment({ PATH: "p", TOKEN: "t" }, manifest([]));
  assert.deepEqual(Object.keys(env), []);
  assert.equal(report.allowed, 0);
  assert.equal(report.droppedTotal, 2);
});

test("v0.6 env: looksSensitive flags credential shapes and not ordinary names", () => {
  for (const s of ["ANTHROPIC_API_KEY", "aws_secret_access_key", "GITHUB_TOKEN", "MY_PASSWORD", "SSH_AUTH_SOCK", "SESSION_TOKEN"])
    assert.ok(looksSensitive(s), s);
  for (const o of ["PATH", "SystemRoot", "TEMP", "LANG", "NODE_ENV", "HOME"]) assert.ok(!looksSensitive(o), o);
});
