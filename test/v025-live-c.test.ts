import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { CapabilityRequirement, DelegationPacket } from "../src/core/domain.js";
import { ProcessSupervisor, type ProcessSpec, type RunningProcess, type TreeTerminator } from "../src/platform/process/supervisor.js";
import { runCli } from "../src/cli/run.js";
import { ClaudeOneShotTransport } from "../src/providers/claude/one-shot-transport.js";
import { CLAUDE_INIT_PROBE_ATTEMPTS } from "../src/providers/claude/plugin-quarantine.js";
import type { ClaudeLaunchConfig } from "../src/providers/claude/types.js";
import { fakeConversationRegistry } from "./fixtures/fake-conversation.js";
import { gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * v0.2.5 — Live C follow-ups.
 *
 *   1. The Live-C fixture verifier: its marker check matched the bare text "<redacted" and so the fixture's own confined
 *      check in fusion.config.json; it now matches Fusion's marker syntax (<redacted>, <redacted:kind:N>) in every file.
 *   2. An init-only Claude startup (plugin discovery or quarantine verification) is cancelled at system/init and its
 *      process tree killed. On Windows `taskkill /T /F` reports failure when a short-lived helper of the runtime exits while
 *      the tree is walked, although nothing survives — and Fusion refused the whole turn ("built-in plugin discovery could
 *      not be confirmed"). Such a startup is now repeated ONCE when it is the only doubt (everything shown was verified and
 *      the started process exited); the repeat must be clean, and every refusal names its safe cause.
 *   3. A process error names its platform code and whether the process had started (a failed kill is not a failed start).
 */
const skip = gitAvailable ? false : "git executable unavailable";

// ---------------------------------------------------------------- 1. the Live-C fixture verifier

const fixtureScript = (...args: string[]) => spawnSync(process.execPath, ["scripts/v02-live-fixture.mjs", ...args], { encoding: "utf8", windowsHide: true });

test("the Live-C verifier passes the exact applied fix, is not tripped by the fixture's own confined check, and fails on a real marker",
  { skip }, async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "v025-livec-")));
    try {
      const created = fixtureScript("create-git", dir);
      assert.equal(created.status, 0, created.stderr);
      const repo = join(dir, "homeassistant-git");
      // The confined check itself looks for the bare text; that is what the old verifier tripped over.
      assert.ok((await readFile(join(repo, "fusion.config.json"), "utf8")).includes("includes('<redacted')"));
      const before = fixtureScript("verify-git", dir);
      assert.equal(before.status, 1, "nothing applied yet");
      assert.match(before.stdout, /^PASS no file contains a Fusion redaction marker$/mu, before.stdout);
      assert.match(before.stdout, /^FAIL configuration\.yaml has trusted_proxies \(the applied fix\)$/mu);
      // The fix exactly as the live delivery applied it: three lines under http:, nothing else.
      const config = join(repo, "configuration.yaml");
      const original = await readFile(config, "utf8");
      assert.ok(original.includes("  use_x_forwarded_for: true\n"));
      await writeFile(config, original.replace("  use_x_forwarded_for: true\n", "  use_x_forwarded_for: true\n  trusted_proxies:\n    - 127.0.0.1\n    - ::1\n"));
      const applied = fixtureScript("verify-git", dir);
      assert.equal(applied.status, 0, applied.stdout);
      assert.equal(applied.stdout.trim().split("\n").at(-1), "V0_2_1_LIVE_BUILD_PATH: PASS");
      assert.ok(!/^FAIL /mu.test(applied.stdout), applied.stdout);
      // A marker as Fusion writes one fails the check, in any file and in either form.
      const fixed = await readFile(config, "utf8");
      for (const [path, marker] of [["configuration.yaml", "<redacted:password:1>"], ["scenes.yaml", "<redacted>"], ["fusion.config.json", "<redacted:token:2>"]] as const) {
        const file = join(repo, path);
        const kept = await readFile(file, "utf8");
        await writeFile(file, `${kept}# ${marker}\n`);
        const marked = fixtureScript("verify-git", dir);
        assert.equal(marked.status, 1, `${path}: ${marked.stdout}`);
        assert.match(marked.stdout, /^FAIL no file contains a Fusion redaction marker$/mu, path);
        assert.equal(marked.stdout.trim().split("\n").at(-1), "V0_2_1_LIVE_BUILD_PATH: FAIL");
        await writeFile(file, kept);
      }
      assert.equal(await readFile(config, "utf8"), fixed);
      // No secret value is ever printed by the verifier.
      const { HA_SENTINELS } = await import("./fixtures/home-assistant.js");
      for (const value of Object.values(HA_SENTINELS)) assert.ok(!(before.stdout + applied.stdout).includes(value));
    } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  });

// ---------------------------------------------------------------- 3. process errors name their code

test("a process that cannot start reports its platform error code and that it never started", async () => {
  const outcome = await new ProcessSupervisor().start({ executable: join(tmpdir(), "fusion-v025-missing-binary.exe"), args: [], cwd: tmpdir(),
    env: { SystemRoot: process.env.SystemRoot ?? "" }, timeoutMs: 5_000 }).result;
  assert.equal(outcome.issue?.kind, "SpawnFailure");
  assert.equal(outcome.issue?.errorCode, "ENOENT");
  assert.equal(outcome.issue?.afterSpawn, false);
});

// ---------------------------------------------------------------- 2. init-only startups and their tree cleanup

const fixture = resolve(process.cwd(), "test/fixtures/claude-fake.mjs");
const fixtureBinary = { executable: process.execPath, argvPrefix: [fixture] } as const;
const packet: DelegationPacket = { task: { goal: "line 1\n& | $() ü ☃", constraints: [], acceptanceCriteria: [] },
  scope: { relevantFiles: [], allowedFiles: [], forbiddenFiles: [] }, architecture: { decisions: [], invariants: [] },
  verification: { requiredTests: [] }, openQuestions: [] };
const LEAD: CapabilityRequirement = { structuredOutput: true, webToolsDisabled: true, modelIdentityReadback: true, subscriptionLaneReadback: true,
  approvalEscalationDisabled: true, personalContextDisabled: true, extensionsQuarantined: true, filesystem: { read: true, write: false },
  shell: { available: false } };
const TASKKILL_FAILED = "taskkill failed; direct child kill used";

/** Counts every start by purpose; its tree terminator is the test's. */
class CountingSupervisor extends ProcessSupervisor {
  readonly purposes: string[] = [];
  constructor(terminator: TreeTerminator) { super(undefined, terminator); }
  override start(spec: ProcessSpec): RunningProcess { this.purposes.push(spec.purpose ?? "unlabelled"); return super.start(spec); }
  count(purpose: string): number { return this.purposes.filter(p => p === purpose).length; }
}
/**
 * The Windows behaviour seen live, made deterministic: the tree kill ends the process, but reports failure on the listed
 * calls (1-based) — exactly what `taskkill /T /F` does when a helper exits while the tree is walked. `survive` lists calls
 * on which the process is NOT ended (a real survivor).
 */
function treeKill(failOn: readonly number[], survive: readonly number[] = []): { terminator: TreeTerminator; calls: () => number; survivors: Array<{ kill(): boolean }> } {
  let calls = 0;
  const survivors: Array<{ kill(): boolean }> = [];
  const terminator: TreeTerminator = async child => {
    calls++;
    if (survive.includes(calls)) { survivors.push(child); return { method: "directKill", cleanupError: TASKKILL_FAILED }; }
    child.kill();
    return failOn.includes(calls) ? { method: "directKill", cleanupError: TASKKILL_FAILED } : { method: "taskkill" };
  };
  return { terminator, calls: () => calls, survivors };
}
function transport(supervisor: ProcessSupervisor, env: Readonly<Record<string, string>> = {}): ClaudeOneShotTransport {
  const config: ClaudeLaunchConfig = { executablePath: "unused", workspace: process.cwd(), model: { id: "alias", effort: "low", maxTurns: 3 },
    expectedCanonicalModel: "claude-canonical-fixture", posture: "readOnly", timeoutMs: 20_000,
    sourceEnvironment: { FUSION_FAKE_SCENARIO: "ok", SystemRoot: process.env.SystemRoot ?? "", USERPROFILE: resolve(process.cwd(), "test/fixtures/empty-claude-home"), ...env } };
  return new ClaudeOneShotTransport(config, supervisor, fixtureBinary);
}

test("an init-only startup whose only doubt is the tree cleanup is repeated once; the turn then runs", async () => {
  assert.equal(CLAUDE_INIT_PROBE_ATTEMPTS, 2);
  // Discovery's first tree kill reports failure (as live): repeated, clean, then verification and the turn.
  const discovery = treeKill([1]);
  const s1 = new CountingSupervisor(discovery.terminator);
  const r1 = await transport(s1).run({ packet, requiredCapabilities: LEAD });
  assert.equal(r1.status, "completed", JSON.stringify(r1.status === "completed" ? {} : r1.error));
  assert.deepEqual([s1.count("providerInitProbe"), s1.count("providerTurn"), discovery.calls()], [3, 1, 3]);
  // The same for the quarantine verification startup.
  const verification = treeKill([2]);
  const s2 = new CountingSupervisor(verification.terminator);
  const r2 = await transport(s2).run({ packet, requiredCapabilities: LEAD });
  assert.equal(r2.status, "completed");
  assert.deepEqual([s2.count("providerInitProbe"), s2.count("providerTurn")], [3, 1]);
});

test("the repeat must be clean: a second unconfirmed cleanup refuses the turn with its safe cause, before any model turn", async () => {
  const twice = treeKill([1, 2]);
  const s = new CountingSupervisor(twice.terminator);
  const result = await transport(s).run({ packet, requiredCapabilities: LEAD });
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.error.kind, "CapabilityUnavailable");
  assert.equal(result.error.safeMessage, "Claude built-in plugin discovery could not be confirmed.");
  assert.match(result.error.failureDetail ?? "", /^Claude plugin discovery startup was not confirmed \[init_seen=yes issue=none observer_issues=0 termination=directKill cleanup=taskkill_failed process_exited=yes exit_code=\S+ attempts=2\]$/u);
  assert.deepEqual([s.count("providerInitProbe"), s.count("providerTurn")], [2, 0], "bounded: two startups, no model turn");
  // The verification step says so in its own words.
  const verify = treeKill([2, 3]);
  const v = new CountingSupervisor(verify.terminator);
  const refused = await transport(v).run({ packet, requiredCapabilities: LEAD });
  assert.equal(refused.status === "failed" ? refused.error.safeMessage : "", "Claude plugin quarantine verification could not be confirmed.");
  assert.match(refused.status === "failed" ? refused.error.failureDetail ?? "" : "", /^Claude plugin verification startup was not confirmed \[.*cleanup=taskkill_failed process_exited=yes .*attempts=2\]$/u);
  assert.equal(v.count("providerTurn"), 0);
});

test("a started process that did not exit is never repeated: the turn is refused at once", async () => {
  const stubborn = treeKill([], [1]);
  const s = new CountingSupervisor(stubborn.terminator);
  try {
    const result = await transport(s).run({ packet, requiredCapabilities: LEAD });
    assert.equal(result.status, "failed");
    assert.match(result.status === "failed" ? result.error.failureDetail ?? "" : "", /\[init_seen=yes .*cleanup=taskkill_failed process_exited=no exit_code=none attempts=1\]$/u);
    assert.deepEqual([s.count("providerInitProbe"), s.count("providerTurn")], [1, 0], "no second Claude while the first may still run");
  } finally { for (const survivor of stubborn.survivors) survivor.kill(); }
});

test("the shell shows a refused analysis turn with its safe detail line, then Fusion's own inventory", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "v025-shell-")));
  try {
    await writeFile(join(dir, "configuration.yaml"), "http:\n  use_x_forwarded_for: true\n");
    await writeFile(join(dir, "automations.yaml"), "[]\n");
    const detail = "Claude plugin discovery startup was not confirmed [init_seen=yes issue=none observer_issues=0 termination=directKill " +
      "cleanup=taskkill_failed process_exited=yes exit_code=1 attempts=2]";
    const { registry, turns } = fakeConversationRegistry({ replies: { Lead: [{ error: { kind: "CapabilityUnavailable", retryable: false,
      safeMessage: "Claude built-in plugin discovery could not be confirmed.", failureDetail: detail } }] } });
    let stdout = "", stderr = "";
    const lines = ["Analyze this configuration", "exit"];
    const code = await runCli([], { stdout: t => { stdout += t; }, stderr: t => { stderr += t; }, interactive: true,
      prompt: async () => lines.shift() ?? null }, { env: { ...process.env, LOCALAPPDATA: join(dir, "state"), XDG_STATE_HOME: join(dir, "xdg") }, cwd: dir, registry });
    assert.equal(code, 0, stderr);
    assert.equal(turns.length, 1);
    assert.ok(stdout.includes(`The lead's analysis turn failed: Claude built-in plugin discovery could not be confirmed.\ndetail: ${detail}\n` +
      "Here is what Fusion found by itself (no AI model involved):\n"), stdout);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test("the runtime attestation (doctor --probe) repeats a cleanup-only startup the same way, and keeps the cause when it refuses", async () => {
  // An attestable patch: the canary runs its own discovery and verification startups.
  const once = treeKill([1]);
  const s1 = new CountingSupervisor(once.terminator);
  const attested = await transport(s1, { FUSION_FAKE_VERSION: "2.1.283" }).attestRuntime();
  assert.deepEqual([attested.version, attested.method, s1.count("providerInitProbe")], ["2.1.283", "runtimeCanary", 3]);
  const twice = treeKill([1, 2]);
  const s2 = new CountingSupervisor(twice.terminator);
  await assert.rejects(transport(s2, { FUSION_FAKE_VERSION: "2.1.283" }).attestRuntime(), (error: unknown) => {
    const e = (error as { error?: { kind: string; safeMessage: string; failureDetail?: string } }).error;
    assert.equal(e?.kind, "CapabilityUnavailable");
    assert.match(e?.safeMessage ?? "", /^Fusion has not verified the safety posture of Claude Code this runtime \(its canary check failed: Claude built-in plugin discovery could not be confirmed\.\)/u);
    assert.match(e?.failureDetail ?? "", /cleanup=taskkill_failed process_exited=yes .*attempts=2\]$/u);
    return true;
  });
});
