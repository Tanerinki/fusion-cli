import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import type { AuthStatus, DelegationPacket } from "../src/core/domain.js";
import { ClaudeOneShotTransport } from "../src/providers/claude/one-shot-transport.js";
import type { ClaudeLaunchConfig } from "../src/providers/claude/types.js";
import { MuseExecTransport } from "../src/providers/muse/exec-transport.js";
import { MuseMspTransport } from "../src/providers/muse/msp-transport.js";
import { RESULT_PACKET_SCHEMA } from "../src/providers/muse/structured-output.js";
import type { MuseLaunchConfig } from "../src/providers/muse/types.js";

const claudeFixture = { executable: process.execPath, argvPrefix: [resolve(process.cwd(), "test/fixtures/claude-fake.mjs")] } as const;
const museFixture = { executable: process.execPath, argvPrefix: [resolve(process.cwd(), "test/fixtures/muse-fake.mjs")] } as const;
const claudePacket: DelegationPacket = { task: { goal: "line 1\n& | $() ü ☃", constraints: [], acceptanceCriteria: [] },
  scope: { relevantFiles: [], allowedFiles: [], forbiddenFiles: [] },
  architecture: { decisions: [], invariants: [] }, verification: { requiredTests: [] }, openQuestions: [] };
const musePacket: DelegationPacket = { ...claudePacket, task: { goal: "Summarize the confidential roadmap for project alpha-omega",
  constraints: ["Never reveal the internal codename bluefin-seven"], acceptanceCriteria: [] } };
const auth: AuthStatus = { state: "authenticated", lane: "subscription", observedAt: new Date().toISOString(), evidence: ["fixture"] };
const unhandled: unknown[] = [];
process.on("unhandledRejection", reason => { unhandled.push(reason); });

function claude(scenario: string, timeoutMs = 2_000): ClaudeOneShotTransport {
  const config: ClaudeLaunchConfig = { executablePath: "unused", workspace: process.cwd(),
    model: { id: "alias", effort: "low", maxTurns: 3 }, expectedCanonicalModel: "claude-canonical-fixture",
    posture: "readOnly", timeoutMs, sourceEnvironment: { FUSION_FAKE_SCENARIO: scenario, SystemRoot: process.env.SystemRoot,
      USERPROFILE: resolve(process.cwd(), "test/fixtures/empty-claude-home") } };
  return new ClaudeOneShotTransport(config, undefined, claudeFixture);
}
const runClaude = (scenario: string, timeoutMs?: number, signal?: AbortSignal) =>
  claude(scenario, timeoutMs).run({ packet: claudePacket, requiredCapabilities: {}, ...(signal ? { signal } : {}) });

function museConfig(scenario: string, extra: Partial<MuseLaunchConfig> = {}, env: NodeJS.ProcessEnv = {}): MuseLaunchConfig {
  return { binaryDirectory: "unused", versionFile: "unused", workspace: process.cwd(), provider: "meta",
    model: { id: "muse-spark-1.3", effort: "low", maxTurns: 4 }, posture: "readOnly",
    sourceEnvironment: { FUSION_FAKE_SCENARIO: scenario, SystemRoot: process.env.SystemRoot, ...env },
    timeoutMs: 2_000, maxModelSteps: 4, ...extra };
}
const exec = (config: MuseLaunchConfig, attestor: () => Promise<AuthStatus> = async () => auth) =>
  new MuseExecTransport(config, attestor, undefined, museFixture);

test("M7.1 Claude cancellation during the auth probe is prompt and typed", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  const started = performance.now();
  const result = await runClaude("auth-hang", 10_000, controller.signal);
  assert.equal(result.status, "cancelled");
  if (result.status === "cancelled") assert.equal(result.error.kind, "Cancelled");
  assert.ok(performance.now() - started < 4_000, "cancellation must not wait for the auth probe deadline");
});

test("M7.2 Claude preflight deadlines report Timeout, not a capability verdict", async () => {
  for (const scenario of ["auth-hang", "plugin-list-hang"]) {
    const result = await runClaude(scenario, 400);
    assert.equal(result.status, "failed");
    if (result.status === "failed") { assert.equal(result.error.kind, "Timeout", scenario); assert.equal(result.error.retryable, true); }
  }
});

for (const [scenario, kind] of [
  ["whitespace-output", "ProtocolError"], ["truncated-json", "ProtocolError"], ["garbage-after-json", "ProtocolError"],
  ["primitive-frame", "ProtocolError"], ["deep-frame", "ProtocolError"], ["long-line", "ProtocolError"],
  ["duplicate-frame-key", "ProtocolError"], ["stderr-protocol", "ProtocolError"], ["multiple-results", "ProtocolError"],
  ["duplicate-status", "MalformedOutput"], ["deep-packet", "MalformedOutput"], ["packet-trailing-garbage", "MalformedOutput"],
  ["result-missing-text", "MalformedOutput"], ["contradictory-result", "ProcessFailure"], ["auth-duplicate-key", "AuthMismatch"],
] as const) {
  test(`M7.4 Claude hostile output ${scenario} fails closed as ${kind}`, async () => {
    const result = await runClaude(scenario);
    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.error.kind, kind);
      assert.equal(result.output, undefined, "no packet is accepted from hostile output");
      assert.doesNotMatch(result.error.safeMessage, /bypassPermissions|trailing|x{20}/u);
    }
  });
}

test("M7.4 Claude tolerates invalid UTF-8 on stderr only", async () => {
  assert.equal((await runClaude("stderr-invalid-utf8")).status, "completed");
});

test("M7.2 Muse Exec deadline and user cancellation are distinct", async () => {
  const timeout = await exec(museConfig("hang", { timeoutMs: 300 })).run({ packet: musePacket, requiredCapabilities: {} });
  assert.equal(timeout.status, "failed");
  if (timeout.status === "failed") assert.equal(timeout.error.kind, "Timeout");
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  const cancelled = await exec(museConfig("hang")).run({ packet: musePacket, requiredCapabilities: {}, signal: controller.signal });
  assert.equal(cancelled.status, "cancelled");
  if (cancelled.status === "cancelled") assert.equal(cancelled.error.kind, "Cancelled");
});

test("M7.1-E evidence I/O failure after a timeout never masks the timeout", async () => {
  const evidenceDirectory = await mkdtemp(join(tmpdir(), "fusion-m7-evidence-"));
  try {
    const result = await exec(museConfig("delete-attempt-dir", { timeoutMs: 400 }))
      .run({ packet: musePacket, requiredCapabilities: {}, evidenceDirectory });
    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.equal(result.error.kind, "Timeout");
    assert.deepEqual(result.artifactRefs, [], "evidence that could not be written is not referenced");
  } finally { await rm(evidenceDirectory, { recursive: true, force: true }); }
});

test("M7.1-A/F Muse Exec honours cancellation during attestation and after the child exits", async () => {
  const hanging = new AbortController();
  setTimeout(() => hanging.abort(), 100);
  const started = performance.now();
  const during = await exec(museConfig("ok"), () => new Promise<AuthStatus>(() => {}))
    .run({ packet: musePacket, requiredCapabilities: {}, signal: hanging.signal });
  assert.equal(during.status, "cancelled");
  assert.ok(performance.now() - started < 2_000);

  const late = new AbortController();
  let calls = 0;
  const afterExit = await exec(museConfig("ok"), async () => { calls += 1; if (calls === 2) late.abort(); return auth; })
    .run({ packet: musePacket, requiredCapabilities: {}, outputSchema: RESULT_PACKET_SCHEMA, signal: late.signal });
  assert.equal(calls, 2, "the child ran and exited before cancellation arrived");
  assert.equal(afterExit.status, "cancelled", "cancellation observed before delivery is never reported as success");
  if (afterExit.status === "cancelled") assert.equal(afterExit.error.kind, "Cancelled");
});

for (const [scenario, status, kind] of [
  ["duplicate-status-packet", "failed", "MalformedOutput"], ["duplicate-envelope-key", "failed", "ProtocolError"],
  ["stderr-invalid-utf8", "completed", ""],
] as const) {
  test(`M7.4 Muse Exec ${scenario}`, async () => {
    const result = await exec(museConfig(scenario)).run({ packet: musePacket, requiredCapabilities: {}, outputSchema: RESULT_PACKET_SCHEMA });
    assert.equal(result.status, status);
    if (result.status === "failed") assert.equal(result.error.kind, kind);
  });
}

test("M7.7 Muse Exec evidence redacts pattern secrets and delegated task text; no prompt file survives", async () => {
  const secret = "synthetic-pattern-secret-4f1c9e2a";
  const evidenceDirectory = await mkdtemp(join(tmpdir(), "fusion-m7-secret-"));
  try {
    const result = await exec(museConfig("secret-stderr", {}, { FUSION_FIXTURE_PAYLOAD: secret }))
      .run({ packet: musePacket, requiredCapabilities: {}, outputSchema: RESULT_PACKET_SCHEMA, evidenceDirectory });
    assert.equal(result.status, "completed");
    const files: string[] = [];
    for (const entry of await readdir(evidenceDirectory, { recursive: true, withFileTypes: true }))
      if (entry.isFile()) files.push(join(entry.parentPath, entry.name));
    assert.deepEqual(files.map(file => file.split(/[\\/]/u).pop()).sort(), ["stderr.txt", "stdout.jsonl"]);
    for (const file of files) {
      const text = await readFile(file, "utf8");
      assert.doesNotMatch(text, new RegExp(secret, "u"), file);
      assert.doesNotMatch(text, /alpha-omega|bluefin-seven/u, `${file} must not retain delegated task text`);
    }
    assert.match(await readFile(result.artifactRefs[1]!, "utf8"), /\[REDACTED/u);
  } finally { await rm(evidenceDirectory, { recursive: true, force: true }); }
});

test("M7.2 Muse MSP deadline is a Timeout; host-side cancellation stays Cancelled", async () => {
  const slow = new MuseMspTransport(museConfig("cancel-accepted", { timeoutMs: 200, maxModelSteps: undefined as never }),
    undefined, undefined, 250, museFixture);
  try {
    const id = await slow.createSession({});
    const result = await slow.runTurn(id, musePacket);
    assert.equal(result.status, "failed");
    if (result.status === "failed") { assert.equal(result.error.kind, "Timeout"); assert.equal(result.error.retryable, true); }
  } finally { await slow.close(); }
  const hostCancelled = new MuseMspTransport(museConfig("turn-cancelled", { maxModelSteps: undefined as never }),
    undefined, undefined, 250, museFixture);
  try {
    const id = await hostCancelled.createSession({});
    const result = await hostCancelled.runTurn(id, musePacket);
    assert.equal(result.status, "cancelled");
  } finally { await hostCancelled.close(); }
});

test("M7.1-G Muse MSP cancellation is idempotent, including after host death", async () => {
  const transport = new MuseMspTransport(museConfig("cancel-accepted", { maxModelSteps: undefined as never }),
    undefined, undefined, 250, museFixture);
  try {
    const id = await transport.createSession({});
    const running = transport.runTurn(id, musePacket);
    await new Promise(resolve => setTimeout(resolve, 50));
    await Promise.all([transport.cancel(id), transport.cancel(id), transport.cancel(id)]);
    const result = await running;
    assert.equal(result.status, "cancelled");
    await transport.cancel(id);
    await transport.cancel("unknown-session");
  } finally { await transport.close(); }
  const dead = new MuseMspTransport(museConfig("host-dies", { maxModelSteps: undefined as never }), undefined, undefined, 250, museFixture);
  try {
    const id = await dead.createSession({});
    assert.notEqual((await dead.runTurn(id, musePacket)).status, "completed");
    await dead.cancel(id);
  } finally { await dead.close(); }
});

test("M7.1 provider cancellation paths leave no unhandled rejections", async () => {
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(unhandled, []);
});
