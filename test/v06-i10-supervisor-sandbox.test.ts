import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { providerCapabilityManifest, providerEnvironment, providerRunSpec } from "../src/app/provider-sandbox.js";
import { DENY_ALL_NETWORK, networkPolicy } from "../src/core/isolation/network-policy.js";
import { runSpecDocument, type LauncherIdentity, type SandboxRunSpec } from "../src/platform/isolation/appcontainer-backend.js";
import { ProcessSupervisor, type ProcessOutcome } from "../src/platform/process/supervisor.js";
import { prepareSandboxLaunch, unavailableSandboxLaunch, type SandboxLaunch } from "../src/platform/process/sandboxed-spawn.js";

const fakeLauncher = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures", "fake-sandbox-launcher.mjs");

/**
 * v0.6 I10 — the DETERMINISTIC proof that `ProcessSupervisor` routes a sandboxed execution through the launcher. It uses a
 * FAKE launcher binary (node + a fixture script) driven by the SAME production `ProcessSupervisor.start` sandbox branch a
 * real provider would take; the production spec-writing (`prepareSandboxLaunch` → `runSpecDocument`) is real. The real OS
 * confinement (filesystem/DENY_ALL/no-contamination against real denial) is proven by the maintainer-live suite with the
 * REAL launcher. No real provider, credentials, quota or model call is involved.
 */

/** Prepares a launch that runs the FAKE launcher binary through the production supervisor sandbox branch. */
async function fakeLaunch(spec: SandboxRunSpec, base: string): Promise<SandboxLaunch> {
  // Real production spec-writing: prepareSandboxLaunch writes spec.json (runSpecDocument) and builds cleanup/env.
  const launcher: LauncherIdentity = { path: process.execPath, sha256: "0".repeat(64) };
  const prepared = await prepareSandboxLaunch(launcher, spec, { tempBase: base });
  // Swap only the launcher BINARY for the fake (node + fixture); everything else is the production launch.
  return Object.freeze({ ...prepared, executable: process.execPath, args: Object.freeze([fakeLauncher, ...prepared.args]) });
}

const baseSpec = (over: Partial<SandboxRunSpec>, work: string): SandboxRunSpec => Object.freeze({
  identity: "fusion.sandbox.test.c1", workingDirectory: work, readPaths: [join(work, "view")], writePaths: [work],
  executable: process.execPath, args: ["--emit", "HELLO", "--exit", "0"], timeoutMs: 30_000, maxProcesses: 8,
  env: { PROVIDER_API_BASE: "x" }, network: DENY_ALL_NETWORK, ...over,
});

async function withWork<T>(fn: (work: string) => Promise<T>): Promise<T> {
  const work = await mkdtemp(join(tmpdir(), "fusion-i10-"));
  try { return await fn(work); } finally { await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined); }
}

/** Cleanup after settle is best-effort/async (a killed launcher releases its cwd shortly after); poll for it. */
async function goneWithin(path: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (!existsSync(path)) return true; await new Promise(r => setTimeout(r, 50)); }
  return !existsSync(path);
}

// ---------------------------------------------------------------- wiring, stdio, env, network, stdin

test("v0.6 I10: ProcessSupervisor routes a sandboxed execution through the launcher; stdio, exit code, minimized env and network policy are carried", async () =>
  withWork(async work => {
    const spec = baseSpec({ env: { PROVIDER_API_BASE: "https://api.example" }, network: networkPolicy({ mode: "ALLOWLIST", loopback: "deny", allowed: [{ host: "api.example", port: 443 }] }),
      args: ["--emit", "HELLO", "--emit-stderr", "WARN", "--exit", "0"] }, work);
    const launch = await fakeLaunch(spec, work);
    const running = new ProcessSupervisor().start({ executable: process.execPath, args: [], cwd: work, env: spec.env!,
      sandbox: launch, stdin: "PROMPT-BYTES", timeoutMs: 30_000 });
    const outcome = await running.result;
    assert.equal(outcome.issue, undefined, `${outcome.issue?.kind}: ${outcome.issue?.safeMessage}`);
    assert.equal(outcome.exitCode, 0, "the launcher exits with the child's exit code (propagation)");
    assert.match(outcome.stdout, /SPEC_IDENTITY:fusion\.sandbox\.test\.c1/u, "the launcher — not the raw target — ran");
    assert.match(outcome.stdout, /OUT:HELLO/u, "child stdout is bridged through the supervisor");
    assert.match(outcome.stderr, /ERR:WARN/u, "child stderr is bridged through the supervisor");
    assert.match(outcome.stdout, /SPEC_ENV:\{"PROVIDER_API_BASE":"https:\/\/api\.example"\}/u, "the minimized env is carried into the sandbox and nothing else");
    assert.match(outcome.stdout, /SPEC_NETWORK:.*"mode":"ALLOWLIST".*"host":"api\.example","port":443/u, "the network policy (allowlist) is carried deterministically");
    assert.match(outcome.stdout, /STDIN:PROMPT-BYTES/u, "stdin is bridged to the sandboxed child");
  }));

test("v0.6 I10: a DENY_ALL execution carries deny-all; the run spec always includes a network policy", async () =>
  withWork(async work => {
    const spec = baseSpec({ args: ["--exit", "0"] }, work);
    const doc = runSpecDocument(spec) as { network: { mode: string } };
    assert.equal(doc.network.mode, "DENY_ALL", "runSpecDocument always carries a network policy, deny-all by default");
    const outcome = await new ProcessSupervisor().start({ executable: process.execPath, args: [], cwd: work, env: spec.env!,
      sandbox: await fakeLaunch(spec, work), timeoutMs: 30_000 }).result;
    assert.match(outcome.stdout, /SPEC_NETWORK:.*"mode":"DENY_ALL"/u);
  }));

// ---------------------------------------------------------------- fail-closed (the security-critical property)

test("v0.6 I10: an unavailable HARD sandbox FAILS CLOSED — the target never runs unsandboxed", async () =>
  withWork(async work => {
    const sentinel = join(work, "SENTINEL-SHOULD-NOT-EXIST");
    // The logical target, if ever spawned unsandboxed, would create the sentinel. A fail-closed sandbox must prevent it.
    const running = new ProcessSupervisor().start({
      executable: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'x')`],
      cwd: work, env: {}, sandbox: unavailableSandboxLaunch(process.execPath), timeoutMs: 30_000 });
    const outcome = await running.result;
    assert.equal(outcome.pid, null, "no process was started");
    assert.equal(outcome.issue?.kind, "SpawnFailure");
    assert.equal(outcome.issue?.errorCode, "SANDBOX_UNAVAILABLE", "refused with the fail-closed reason");
    assert.equal(outcome.stdout, "", "nothing ran");
    assert.equal(existsSync(sentinel), false, "the target was NOT executed unsandboxed — no silent downgrade");
  }));

test("v0.6 I10: prepareSandboxLaunch with no launcher is fail-closed; with a launcher it writes the spec and builds the command", async () =>
  withWork(async work => {
    assert.equal((await prepareSandboxLaunch(null, baseSpec({}, work))).available, false, "no launcher ⇒ fail closed");
    const prepared = await prepareSandboxLaunch({ path: process.execPath, sha256: "0".repeat(64) }, baseSpec({ args: ["--exit", "0"] }, work), { tempBase: work });
    assert.equal(prepared.available, true);
    assert.deepEqual(prepared.args.slice(0, 1), ["--spec"]);
    assert.equal(prepared.args[2], "--result");
    const written = JSON.parse(await readFile(prepared.args[1]!, "utf8")) as { mode: string; command: { executable: string } };
    assert.equal(written.mode, "run", "the production run spec is written to disk");
    await prepared.cleanup();
    assert.equal(existsSync(prepared.args[1]!), false, "cleanup removes the launcher scratch");
  }));

// ---------------------------------------------------------------- timeout / cancel / kill / cleanup

test("v0.6 I10: a hung sandboxed execution is killed by the supervisor timeout (Job tear-down)", async () =>
  withWork(async work => {
    const spec = baseSpec({ args: ["--hang"] }, work);
    const launch = await fakeLaunch(spec, work);
    const outcome = await new ProcessSupervisor().start({ executable: process.execPath, args: [], cwd: work, env: spec.env!,
      sandbox: launch, timeoutMs: 700 }).result;
    assert.equal(outcome.issue?.kind, "Timeout", "the deadline is enforced on the sandboxed launcher");
    assert.equal(outcome.termination?.forced, true, "the launcher process was force-terminated (its Job tears down the tree)");
    assert.equal(await goneWithin(launch.cwd, 4_000), true, "the launcher scratch is cleaned up after a killed run (no contamination)");
  }));

test("v0.6 I10: a sandboxed execution can be cancelled through the supervisor", async () =>
  withWork(async work => {
    const spec = baseSpec({ args: ["--hang"] }, work);
    const running = new ProcessSupervisor().start({ executable: process.execPath, args: [], cwd: work, env: spec.env!,
      sandbox: await fakeLaunch(spec, work), timeoutMs: 30_000 });
    await new Promise(r => setTimeout(r, 200));
    await running.cancel("user");
    const outcome: ProcessOutcome = await running.result;
    assert.equal(outcome.issue?.kind, "Cancelled");
    assert.ok(outcome.termination !== undefined, "termination was recorded");
  }));

test("v0.6 I10: a completed sandboxed run cleans up its launcher scratch (no contamination)", async () =>
  withWork(async work => {
    const spec = baseSpec({ args: ["--exit", "3"] }, work);
    const launch = await fakeLaunch(spec, work);
    const outcome = await new ProcessSupervisor().start({ executable: process.execPath, args: [], cwd: work, env: spec.env!,
      sandbox: launch, timeoutMs: 30_000 }).result;
    assert.equal(outcome.exitCode, 3, "a non-zero child exit propagates");
    assert.equal(await goneWithin(launch.cwd, 4_000), true, "the launcher scratch is removed after completion");
  }));

// ---------------------------------------------------------------- production plumbing → run spec

test("v0.6 I10: providerRunSpec maps the capability manifest + minimized env to the launcher run spec (least authority)", () => {
  const input = { executionId: "e1", runId: "r1", candidateId: "c1", candidateRevision: null, backend: "appcontainer" as const,
    sandboxIdentity: "fusion.sandbox.r1.c1", viewPath: "C:/view", scratchPath: "C:/scratch",
    deniedPaths: ["C:/primary", "C:/.fusion"], allowedEnvNames: ["PROVIDER_API_BASE"],
    network: networkPolicy({ mode: "ALLOWLIST", loopback: "deny", allowed: [{ host: "api.example", port: 443 }] }) };
  const manifest = providerCapabilityManifest(input);
  const env = providerEnvironment({ PROVIDER_API_BASE: "https://api.example", AWS_SECRET_ACCESS_KEY: "nope", PATH: "x" }, manifest);
  const spec = providerRunSpec(manifest, env, "C:/providers/worker.exe", ["-p"]);
  assert.deepEqual(spec.readPaths, ["C:/view"], "reads only its view");
  assert.deepEqual(spec.writePaths, ["C:/scratch"], "writes only its scratch");
  assert.equal(spec.identity, "fusion.sandbox.r1.c1");
  assert.equal(spec.network?.mode, "ALLOWLIST");
  assert.deepEqual(spec.network?.allowed, [{ host: "api.example", port: 443 }]);
  assert.deepEqual(Object.keys(spec.env ?? {}), ["PROVIDER_API_BASE"], "only allow-listed env names; a credential is dropped");
  const doc = runSpecDocument(spec) as { network: { mode: string; allowed: unknown[] }; env: Record<string, string> };
  assert.equal(doc.network.mode, "ALLOWLIST", "the allowlist path is carried into the launcher document deterministically");
  assert.equal(doc.env.AWS_SECRET_ACCESS_KEY, undefined, "no credential reaches the sandbox document");
});
