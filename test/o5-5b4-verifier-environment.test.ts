import assert from "node:assert/strict";
import { test } from "node:test";
import { FusionFailure } from "../src/core/errors.js";
import { buildVerifierEnvironment, VERIFIER_FORWARDED_KEYS, VERIFIER_INJECTED,
  VERIFIER_REDIRECTED_KEYS } from "../src/platform/verification/verifier-environment.js";

const kind = (name: string) => (error: unknown): boolean => error instanceof FusionFailure && error.error.kind === name;
const ROOT = process.platform === "win32" ? "C:\\fusion\\verif-run" : "/fusion/verif-run";
// A synthetic environment carrying provider credentials and unrelated secrets — none may reach the verifier.
const SOURCE: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin", PATHEXT: ".EXE", SystemRoot: "C:\\WINDOWS", WINDIR: "C:\\WINDOWS",
  ANTHROPIC_API_KEY: "sk-fake-anthropic-MARKER", CLAUDE_CODE_OAUTH_TOKEN: "fake-oauth-MARKER",
  META_API_KEY: "fake-meta-MARKER", MUSE_AUTH_PATH: "C:\\muse-auth-MARKER", MODEL_API_KEY: "fake-model-MARKER",
  GITHUB_TOKEN: "ghp_fakeMARKER", AWS_SECRET_ACCESS_KEY: "fake-aws-MARKER", SSH_AUTH_SOCK: "/tmp/agent-MARKER",
  HOME: "/home/real-user", USERPROFILE: "C:\\Users\\real", APPDATA: "C:\\Users\\real\\AppData\\Roaming",
  TEMP: "C:\\Users\\real\\AppData\\Local\\Temp", NODE_OPTIONS: "--experimental-vm-modules",
};
const MARKERS = ["sk-fake-anthropic-MARKER", "fake-oauth-MARKER", "fake-meta-MARKER", "C:\\muse-auth-MARKER",
  "fake-model-MARKER", "ghp_fakeMARKER", "fake-aws-MARKER", "/tmp/agent-MARKER", "/home/real-user", "C:\\Users\\real"];

test("O5.5B4 the verifier receives no provider credential and no unrelated secret", () => {
  const { env } = buildVerifierEnvironment(SOURCE, ROOT);
  const keys = Object.keys(env);
  // Only allowlisted keys are present.
  const allowed = new Set<string>([...VERIFIER_FORWARDED_KEYS, ...VERIFIER_REDIRECTED_KEYS, ...Object.keys(VERIFIER_INJECTED)]);
  for (const key of keys) assert.ok(allowed.has(key), `unexpected key ${key}`);
  // No credential/provider markers survive, by key or by value.
  for (const [key, value] of Object.entries(env)) {
    assert.doesNotMatch(key.toUpperCase(), /API_KEY|SECRET|TOKEN|CREDENTIAL|PASSWORD|ANTHROPIC|CLAUDE|MUSE|META_|TBH_/u, key);
    for (const marker of MARKERS) assert.ok(!String(value).includes(marker), `marker ${marker} leaked via ${key}`);
  }
  // Named provider variables are absent.
  for (const name of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "META_API_KEY", "MUSE_AUTH_PATH", "MODEL_API_KEY",
    "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "SSH_AUTH_SOCK", "NODE_OPTIONS"])
    assert.equal(env[name], undefined, name);
});

test("O5.5B4 ambient user locations are redirected into the disposable runtime root", () => {
  const { env, summary } = buildVerifierEnvironment(SOURCE, ROOT);
  for (const key of VERIFIER_REDIRECTED_KEYS) assert.equal(env[key], ROOT, key);
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GIT_OPTIONAL_LOCKS, "0");
  // Forwarded non-secret keys keep their source values.
  assert.equal(env.PATH, "/usr/bin:/bin");
  assert.equal(env.SystemRoot, "C:\\WINDOWS");
  assert.deepEqual([...summary.redirected], [...VERIFIER_REDIRECTED_KEYS]);
  assert.deepEqual([...summary.injected], Object.keys(VERIFIER_INJECTED));
  assert.ok(summary.forwarded.includes("PATH"));
});

test("O5.5B4 absent forwarded keys are omitted and reported, not blanked", () => {
  const { env, summary } = buildVerifierEnvironment({ PATH: "/bin" }, ROOT);
  assert.equal(env.PATH, "/bin");
  assert.equal("PATHEXT" in env, false);
  assert.ok(summary.forwarded.includes("PATH"));
  assert.ok(summary.forwardedAbsent.includes("PATHEXT") && summary.forwardedAbsent.includes("WINDIR"));
});

test("O5.5B4 the summary is diagnostic-safe: it names keys only, never values", () => {
  const { summary } = buildVerifierEnvironment(SOURCE, ROOT);
  const text = JSON.stringify(summary);
  for (const marker of MARKERS) assert.ok(!text.includes(marker), `summary leaked ${marker}`);
});

test("O5.5B4 an invalid runtime root fails closed", () => {
  for (const bad of ["", "relative/path", "also/relative", "with\0nul"])
    assert.throws(() => buildVerifierEnvironment(SOURCE, bad), kind("InvalidInput"), bad);
});
