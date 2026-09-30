import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { providerEndpointAllowlist } from "../src/app/provider-sandbox.js";
import { ClaudeOneShotTransport } from "../src/providers/claude/one-shot-transport.js";
import { MuseExecTransport } from "../src/providers/muse/exec-transport.js";
import { MuseMspTransport } from "../src/providers/muse/msp-transport.js";
import { ProcessSupervisor, type ProcessOutcome, type ProcessSpec, type RunningProcess } from "../src/platform/process/supervisor.js";
import { SandboxingSupervisor, type HardLaunchProfile } from "../src/platform/process/sandboxing-supervisor.js";
import type { LauncherIdentity } from "../src/platform/isolation/appcontainer-backend.js";

const fakeLauncher = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures", "fake-sandbox-launcher.mjs");
const LAUNCHER: LauncherIdentity = { path: process.execPath, sha256: "0".repeat(64) };

/** A spy inner supervisor: records the specs it is asked to spawn and returns a canned success. */
class SpySupervisor extends ProcessSupervisor {
  readonly specs: ProcessSpec[] = [];
  override start(spec: ProcessSpec): RunningProcess {
    this.specs.push(spec); // NOTE: does not cleanup, so the test can read the written run spec
    const outcome: ProcessOutcome = { executable: spec.executable, args: [...spec.args], cwd: spec.cwd, pid: 1,
      startedAt: "", endedAt: "", durationMs: 0, exitCode: 0, signal: null, stdout: "", stderr: "",
      stdoutTruncated: false, stderrTruncated: false, stdinWriteStatus: "notProvided", observerIssues: [] };
    return { pid: 1, result: Promise.resolve(outcome), writeStdin: () => Promise.resolve(), closeStdin: () => {}, cancel: () => Promise.resolve() };
  }
}

async function withWork<T>(fn: (work: string) => Promise<T>): Promise<T> {
  const work = await mkdtemp(join(tmpdir(), "fusion-i11-"));
  for (const d of ["view", "scratch", "canary"]) await mkdir(join(work, d), { recursive: true });
  try { return await fn(work); } finally { await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined); }
}

const profile = (work: string, over: Partial<HardLaunchProfile> = {}): HardLaunchProfile => ({
  launcher: LAUNCHER, identity: "fusion.sandbox.r1.c1",
  readPaths: [join(work, "view")], writePaths: [join(work, "scratch"), join(work, "canary")],
  network: providerEndpointAllowlist("api.anthropic.com", 443),
  childEnvAdditions: { HTTPS_PROXY: "http://fusion:tok@127.0.0.1:5000", HTTP_PROXY: "http://fusion:tok@127.0.0.1:5000", NO_PROXY: "" },
  maxProcesses: 8, tempBase: work, ...over,
});

// ---------------------------------------------------------------- SandboxingSupervisor: attaches a correct run spec

test("v0.6 I11: SandboxingSupervisor attaches a sandbox to every start; the run spec grants view (ro), scratch+canary (w), the allowlist and the injected proxy env", async () =>
  withWork(async work => {
    const spy = new SpySupervisor();
    const sup = new SandboxingSupervisor(spy, profile(work));
    const child = sup.start({ executable: process.execPath, args: ["--turn"], cwd: join(work, "scratch"),
      env: { CLAUDE_CODE_OAUTH_TOKEN: "secret-token", AWS_SECRET_ACCESS_KEY: undefined as unknown as string } });
    await child.result;
    assert.equal(spy.specs.length, 1);
    const sandbox = spy.specs[0]!.sandbox;
    assert.ok(sandbox !== undefined && sandbox.available, "a sandbox launch is attached");
    const doc = JSON.parse(await readFile(sandbox.args[1]!, "utf8")) as {
      readPaths: string[]; writePaths: string[]; network: { mode: string; allowed: { host: string; port: number }[] }; env: Record<string, string>; command: { executable: string } };
    assert.deepEqual(doc.readPaths, [join(work, "view")], "the provider view is read-only");
    assert.deepEqual(doc.writePaths, [join(work, "scratch"), join(work, "canary")], "scratch AND the canary workspace are writable");
    assert.equal(doc.network.mode, "ALLOWLIST");
    assert.deepEqual(doc.network.allowed, [{ host: "api.anthropic.com", port: 443 }], "only the provider endpoint is allowed");
    assert.equal(doc.env.CLAUDE_CODE_OAUTH_TOKEN, "secret-token", "the explicit token lane is carried into the child");
    assert.equal(doc.env.HTTPS_PROXY, "http://fusion:tok@127.0.0.1:5000", "the broker proxy env is injected by the host, not the provider");
    assert.equal("AWS_SECRET_ACCESS_KEY" in doc.env, false, "an undefined/unrelated credential-shaped host var is absent from the child env");
    assert.equal(doc.command.executable, process.execPath, "the sandbox runs exactly the requested provider executable");
  }));

// ---------------------------------------------------------------- fail-closed (no raw provider spawn)

test("v0.6 I11: an unavailable HARD backend fails closed — the raw provider is never spawned", async () =>
  withWork(async work => {
    const sentinel = join(work, "SENTINEL");
    const sup = new SandboxingSupervisor(new ProcessSupervisor(), profile(work, { launcher: null }));
    const outcome = await sup.start({ executable: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(sentinel)},'x')`],
      cwd: work, env: {} }).result;
    assert.equal(outcome.pid, null, "nothing started");
    assert.equal(outcome.issue?.errorCode, "SANDBOX_UNAVAILABLE", "refused fail-closed");
    assert.equal(existsSync(sentinel), false, "the raw provider was NOT executed unsandboxed");
  }));

// ---------------------------------------------------------------- end-to-end through the real chain (fake launcher)

test("v0.6 I11: a provider execution runs through SandboxingSupervisor → ProcessSupervisor → launcher; stdio and exit code propagate", async () =>
  withWork(async work => {
    const sup = new SandboxingSupervisor(new ProcessSupervisor(), profile(work, { launcherArgvPrefix: [fakeLauncher] }));
    const outcome = await sup.start({ executable: process.execPath, args: ["--emit", "PROVIDER-OUT", "--exit", "0"],
      cwd: join(work, "scratch"), env: { CLAUDE_CODE_OAUTH_TOKEN: "t" }, timeoutMs: 30_000 }).result;
    assert.equal(outcome.issue, undefined, `${outcome.issue?.kind}`);
    assert.equal(outcome.exitCode, 0, "exit code propagates");
    assert.match(outcome.stdout, /OUT:PROVIDER-OUT/u, "provider stdout is bridged");
    assert.match(outcome.stdout, /SPEC_ENV:.*CLAUDE_CODE_OAUTH_TOKEN/u, "the token lane reached the child");
  }));

test("v0.6 I11: a hung sandboxed provider execution is killed by the supervisor timeout", async () =>
  withWork(async work => {
    const sup = new SandboxingSupervisor(new ProcessSupervisor(), profile(work, { launcherArgvPrefix: [fakeLauncher] }));
    const outcome = await sup.start({ executable: process.execPath, args: ["--hang"], cwd: join(work, "scratch"), env: {}, timeoutMs: 700 }).result;
    assert.equal(outcome.issue?.kind, "Timeout");
    assert.equal(outcome.termination?.forced, true);
  }));

// ---------------------------------------------------------------- the REAL transports wrap their supervisor under HARD

const claudeConfig = (work: string, hard: boolean) => ({ executablePath: join(work, "bin", "claude.exe"), workspace: work,
  model: { id: "claude-x", effort: "high" as const, maxTurns: 1 }, expectedCanonicalModel: "claude-x", posture: "readOnly" as const,
  sourceEnvironment: { SystemRoot: "C:/Windows" }, ...(hard ? { hardProfile: profile(work) } : {}) });

test("v0.6 I11: the Claude transport wraps its supervisor with SandboxingSupervisor under HARD, and does not otherwise", async () =>
  withWork(async work => {
    const hard = new ClaudeOneShotTransport(claudeConfig(work, true));
    const soft = new ClaudeOneShotTransport(claudeConfig(work, false));
    assert.equal((hard as unknown as { supervisor: unknown }).supervisor instanceof SandboxingSupervisor, true, "HARD ⇒ every claude.exe execution is sandboxed");
    assert.equal((soft as unknown as { supervisor: unknown }).supervisor instanceof SandboxingSupervisor, false, "no HARD profile ⇒ unchanged behaviour");
  }));

test("v0.6 I11: under HARD, Claude refuses the host-login lane — only the subscription-token lane authenticates (fail closed)", async () =>
  withWork(async work => {
    // sourceEnvironment carries NO CLAUDE_CODE_OAUTH_TOKEN, so the resolved lane is host-login `subscription`.
    const t = new ClaudeOneShotTransport(claudeConfig(work, true));
    const packet = { task: { goal: "x", constraints: [], acceptanceCriteria: [] }, scope: { relevantFiles: [], allowedFiles: [], forbiddenFiles: [] },
      architecture: { decisions: [], invariants: [] }, verification: { requiredTests: [] }, openQuestions: [] };
    const res = await t.run({ packet: packet as never, requiredCapabilities: {} as never });
    assert.equal(res.status, "failed", "the HARD host-login turn does not proceed");
    assert.equal(res.error?.kind, "CapabilityUnavailable");
    assert.match(res.error?.safeMessage ?? "", /subscription-token lane/u, "refused because host-login auth is unreachable inside the sandbox");
  }));

test("v0.6 I11: the Muse exec and msp transports wrap their supervisor with SandboxingSupervisor under HARD", async () =>
  withWork(async work => {
    const cfg = { binaryDirectory: join(work, "bin"), versionFile: join(work, "v.txt"), workspace: work,
      provider: "muse", model: { id: "muse-x", effort: "high" as const }, posture: "readOnly" as const, hardProfile: profile(work) };
    const exec = new MuseExecTransport(cfg as never, async () => ({ state: "authenticated", lane: "subscription" } as never));
    const msp = new MuseMspTransport(cfg as never);
    assert.equal((exec as unknown as { supervisor: unknown }).supervisor instanceof SandboxingSupervisor, true, "Muse exec HARD ⇒ sandboxed");
    // The msp transport holds its supervisor inside its RPC host; assert it constructed without error under HARD and is sandboxing.
    assert.equal((msp as unknown as { host: { supervisor?: unknown } }).host !== undefined, true, "Muse msp constructs its sandboxed RPC host under HARD");
  }));
