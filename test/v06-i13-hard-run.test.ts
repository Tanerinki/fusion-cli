import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { assembleHardRun, HardSetupError, type HardRunRequest } from "../src/app/hard-run.js";
import { ProcessSupervisor } from "../src/platform/process/supervisor.js";
import { SandboxingSupervisor } from "../src/platform/process/sandboxing-supervisor.js";
import type { LauncherIdentity } from "../src/platform/isolation/appcontainer-backend.js";

const fakeLauncher = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures", "fake-sandbox-launcher.mjs");
const LAUNCHER: LauncherIdentity = { path: process.execPath, sha256: "0".repeat(64) };

async function withReq<T>(over: Partial<HardRunRequest>, fn: (req: HardRunRequest, work: string) => Promise<T>): Promise<T> {
  const work = await mkdtemp(join(tmpdir(), "fusion-i13-"));
  for (const d of ["view", "scratch"]) await mkdir(join(work, d), { recursive: true });
  const req: HardRunRequest = { repositoryRoot: work, runId: "r-1", candidateId: "c1", providerFamily: "claude",
    viewPath: join(work, "view"), scratchPath: join(work, "scratch"), endpoint: { host: "api.anthropic.com", port: 443 },
    allowedEnvNames: ["CLAUDE_CODE_OAUTH_TOKEN"], credentialLane: "subscriptionToken", launcher: LAUNCHER, tempBase: work, ...over };
  try { return await fn(req, work); } finally { await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined); }
}

// ---------------------------------------------------------------- happy path: one lifecycle-owned bundle

test("v0.6 I13: a valid HARD Claude request assembles one lifecycle-owned environment (view ro, scratch+canary rw, endpoint allowlist, broker proxy env)", async () =>
  withReq({}, async req => {
    const run = await assembleHardRun(req);
    try {
      assert.deepEqual(run.hardProfile.readPaths, [req.viewPath], "the view is read-only");
      assert.deepEqual([...run.hardProfile.writePaths], [req.scratchPath, run.canaryPath], "scratch AND the canary workspace are writable");
      assert.equal(existsSync(run.canaryPath), true, "the canary workspace exists");
      assert.equal(run.hardProfile.network?.mode, "ALLOWLIST");
      assert.deepEqual(run.hardProfile.network?.allowed, [{ host: "api.anthropic.com", port: 443 }], "only the provider endpoint is allowed");
      assert.equal(run.hardProfile.launcher, LAUNCHER, "the located launcher is bound");
      assert.match(run.proxyEnv.HTTPS_PROXY!, /^http:\/\/fusion:[0-9a-f]{64}@127\.0\.0\.1:\d+$/u, "the broker proxy env is credential-bound to loopback");
      assert.equal(run.hardProfile.childEnvAdditions?.HTTPS_PROXY, run.proxyEnv.HTTPS_PROXY, "the child gets the broker proxy env (host-owned)");
      assert.ok(run.broker.port > 0, "the per-run broker is listening");
    } finally { await run.dispose(); }
  }));

// ---------------------------------------------------------------- fail-closed, typed reasons

test("v0.6 I13: fail-closed — a missing credential lane, missing launcher, and invalid endpoint each throw a typed reason", async () =>
  withReq({}, async req => {
    await assert.rejects(assembleHardRun({ ...req, credentialLane: "none" }),
      (e: unknown) => e instanceof HardSetupError && e.reason === "CREDENTIAL_LANE_UNAVAILABLE", "no token lane");
    await assert.rejects(assembleHardRun({ ...req, providerFamily: "muse", credentialLane: "none" }),
      (e: unknown) => e instanceof HardSetupError && e.reason === "CREDENTIAL_LANE_UNAVAILABLE", "Muse has no HARD lane");
    await assert.rejects(assembleHardRun({ ...req, launcher: null }),
      (e: unknown) => e instanceof HardSetupError && e.reason === "SANDBOX_SETUP_REQUIRED", "launcher not built");
    await assert.rejects(assembleHardRun({ ...req, endpoint: { host: "", port: 443 } }),
      (e: unknown) => e instanceof HardSetupError && e.reason === "NETWORK_POLICY_UNAVAILABLE", "invalid endpoint");
    await assert.rejects(assembleHardRun({ ...req, endpoint: { host: "api.anthropic.com", port: 0 } }),
      (e: unknown) => e instanceof HardSetupError && e.reason === "NETWORK_POLICY_UNAVAILABLE", "invalid port");
  }));

// ---------------------------------------------------------------- lifecycle: dispose revokes/closes everything, idempotent

test("v0.6 I13: dispose() stops the broker (no orphan listener) and removes the canary, and is idempotent", async () =>
  withReq({}, async req => {
    const run = await assembleHardRun(req);
    const port = run.broker.port, canary = run.canaryPath;
    await run.dispose();
    await run.dispose(); // idempotent
    assert.equal(existsSync(canary), false, "the canary workspace is removed");
    const dead = await new Promise<string>(resolve => {
      const s = netConnect(port, "127.0.0.1");
      s.on("connect", () => { s.destroy(); resolve("connected"); });
      s.on("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error"));
    });
    assert.equal(dead, "ECONNREFUSED", "the per-run broker listener is gone (no orphan)");
  }));

// ---------------------------------------------------------------- the assembled profile drives a real sandboxed execution

test("v0.6 I13: the assembled hardProfile routes a provider execution through the sandbox with the broker proxy env", async () =>
  withReq({}, async req => {
    const run = await assembleHardRun(req);
    try {
      // Use the test launcher prefix so the fake launcher (node script) stands in for fusion-sandbox.exe on the SAME path.
      const sup = new SandboxingSupervisor(new ProcessSupervisor(), { ...run.hardProfile, launcherArgvPrefix: [fakeLauncher] });
      const outcome = await sup.start({ executable: process.execPath, args: ["--emit", "OK", "--exit", "0"],
        cwd: req.scratchPath, env: { CLAUDE_CODE_OAUTH_TOKEN: "t" }, timeoutMs: 30_000 }).result;
      assert.equal(outcome.exitCode, 0);
      assert.match(outcome.stdout, /OUT:OK/u, "the provider ran inside the sandbox");
      assert.match(outcome.stdout, /SPEC_ENV:.*HTTPS_PROXY/u, "the broker proxy env reached the child");
      assert.match(outcome.stdout, /SPEC_NETWORK:.*ALLOWLIST.*api\.anthropic\.com/u, "the endpoint allowlist reached the child run spec");
    } finally { await run.dispose(); }
  }));
