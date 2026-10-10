import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { CONFIG_FILE, type BindingConfig } from "../src/app/config.js";
import { planCreate, scaffoldProject } from "../src/app/create.js";
import type { AdapterFactory, BindingInspection, BindingProbe, ProviderRegistry } from "../src/app/providers.js";
import { bindingEligibility } from "../src/app/readiness.js";
import { RunRecorder } from "../src/app/runs.js";
import { REAL_WRITER_MODE_NOT_READY } from "../src/app/writer-gate.js";
import { runCli } from "../src/cli/run.js";
import type { DelegationPacket, FusionError } from "../src/core/domain.js";
import { DiagnosticRedactor } from "../src/core/policy/redaction.js";
import { ClaudeOneShotTransport } from "../src/providers/claude/one-shot-transport.js";
import { classifyInitFrame } from "../src/providers/claude/plugin-quarantine.js";
import { claudeCapability } from "../src/providers/claude/posture.js";
import { ClaudeFailure, MODEL_IDENTITY_PREFLIGHT_MESSAGE, modelIdentityDetail, type ClaudeLaunchConfig } from "../src/providers/claude/types.js";
import { DEFAULT_CONFIG } from "../src/providers/registry.js";

/**
 * v0.6.0 release blocker (run r-00mv2b5kd7…): Claude Code 2.1.293 moved the `haiku` alias from Haiku 4.5 to Haiku 5.5,
 * so a Worker that launched `--model haiku` while authorizing claude-haiku-4-5-20251001 could never pass its identity
 * check — and `doctor --probe` still called it eligible, because only the real turn read the init model back. These
 * tests pin the fix: concrete default bindings, the exact identity required on every init-only preflight startup (before
 * any task prompt), the doctor refusing a mismatched binding, the turn-time check kept, and the observed identity
 * surviving in sanitized failure evidence. No alias, family or suffix matching anywhere.
 */

const FIXTURE = resolve(process.cwd(), "test/fixtures/claude-fake.mjs");
const fixtureBinary = { executable: process.execPath, argvPrefix: [FIXTURE] } as const;
const EMPTY_HOME = resolve(process.cwd(), "test/fixtures/empty-claude-home");
const HAIKU_45 = "claude-haiku-4-5-20251001";
// The fake checks that a packet turn's prompt carries exactly this goal (as test/claude.test.ts does).
const packet: DelegationPacket = { task: { goal: "line 1\n& | $() ü ☃", constraints: [], acceptanceCriteria: [] },
  scope: { relevantFiles: [], allowedFiles: [], forbiddenFiles: [] },
  architecture: { decisions: [], invariants: [] }, verification: { requiredTests: [] }, openQuestions: [] };
const CAPS = { structuredOutput: true, webToolsDisabled: true, filesystem: { read: true, write: false }, shell: { available: false },
  modelIdentityReadback: true, subscriptionLaneReadback: true } as const;

interface Bed { readonly dir: string; readonly prompts: string; readonly record: string }
async function withBed<T>(run: (bed: Bed) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "fusion-v060-identity-"));
  try { return await run({ dir, prompts: join(dir, "prompts.log"), record: join(dir, "launches.jsonl") }); }
  finally {
    assert.ok(resolve(dir).toLowerCase().startsWith(`${resolve(tmpdir()).toLowerCase()}${sep}`));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
/** A transport on the fake Claude: `requested` is the launch model, `canonical` the authorized identity, `env` the fake's script. */
function transport(bed: Bed, requested: string, canonical: string, env: Readonly<Record<string, string>>): ClaudeOneShotTransport {
  const config: ClaudeLaunchConfig = { executablePath: "unused", workspace: bed.dir, model: { id: requested, effort: "low", maxTurns: 3 },
    expectedCanonicalModel: canonical, posture: "readOnly", timeoutMs: 20_000,
    sourceEnvironment: { SystemRoot: process.env.SystemRoot ?? "", USERPROFILE: EMPTY_HOME, FUSION_FAKE_EXPECT_MODEL: requested,
      FUSION_FAKE_PROMPT_LOG: bed.prompts, FUSION_FAKE_RECORD: bed.record, ...env } };
  return new ClaudeOneShotTransport(config, undefined, fixtureBinary);
}
const prompts = async (bed: Bed): Promise<string[]> => {
  try { return (await readFile(bed.prompts, "utf8")).split("\n").filter(Boolean); } catch { return []; }
};
const launchCwds = async (bed: Bed): Promise<string[]> => {
  try { return (await readFile(bed.record, "utf8")).split("\n").filter(Boolean).map(line => (JSON.parse(line) as { cwd: string }).cwd); }
  catch { return []; }
};
/** The posture every accepted startup must show, so the model is the only variable in the classifier tests. */
const initFrame = (model: unknown): Record<string, unknown> => ({ type: "system", subtype: "init", claude_code_version: "2.1.296",
  tools: ["Glob", "Grep", "Read"], mcp_servers: [], plugins: [], permissionMode: "dontAsk", apiKeySource: "none",
  ...(model === undefined ? {} : { model }) });

// ---------------------------------------------------------------- 1-4, 15: the init-only classifier

test("v0.6.0 identity: the init-only preflight accepts exactly the authorized canonical model", () => {
  const verdict = classifyInitFrame(initFrame(HAIKU_45), { expectedModel: HAIKU_45 });
  assert.equal(verdict.kind, "accept");
  // Without an expected model (the version-level canary), the classifier is unchanged.
  assert.equal(classifyInitFrame(initFrame("claude-haiku-5-5")).kind, "accept");
});

test("v0.6.0 identity: a different, missing or non-string init model is refused as model_identity", () => {
  const cases: Array<[unknown, string]> = [["claude-haiku-5-5", "claude-haiku-5-5"], [undefined, "(missing)"], [null, "(missing)"],
    [4.5, "(non-string)"], [{ id: HAIKU_45 }, "(non-string)"], [[HAIKU_45], "(non-string)"], ["", "(unprintable)"]];
  for (const [model, observed] of cases) {
    const verdict = classifyInitFrame(initFrame(model), { expectedModel: HAIKU_45 });
    assert.deepEqual(verdict, { kind: "reject", reason: { code: "model_identity", expected: HAIKU_45, observed } }, String(model));
  }
});

test("v0.6.0 identity: no family matching, suffix stripping, case folding or trimming is introduced", () => {
  // Each is "some Haiku" or "almost the authorized string"; every one is refused. Equality is on the raw string.
  for (const model of ["claude-haiku-4-5", "claude-haiku-4-5-20251002", `${HAIKU_45}-v2`, "claude-haiku-5-5", "haiku",
    HAIKU_45.toUpperCase(), ` ${HAIKU_45}`, `${HAIKU_45} `, `${HAIKU_45}\u0000`, `claude-haiku-4-5-2025100​1`])
    assert.equal(classifyInitFrame(initFrame(model), { expectedModel: HAIKU_45 }).kind, "reject", JSON.stringify(model));
  // Posture problems keep precedence over identity, so a widened posture is never reported as a mere model mismatch.
  const widened = classifyInitFrame({ ...initFrame("claude-haiku-5-5"), tools: ["Bash", "Glob", "Grep", "Read"] }, { expectedModel: HAIKU_45 });
  assert.deepEqual(widened, { kind: "reject", reason: { code: "tools_surface" } });
});

// ---------------------------------------------------------------- 1-5, 12, 13: the transport preflight and the turn

test("v0.6.0 identity: an exact identity passes the preflight and the turn runs (init-only startups, then one task)", async () => withBed(async bed => {
  const t = transport(bed, "alias", "claude-canonical-fixture", { FUSION_FAKE_SCENARIO: "ok" });
  const result = await t.run({ packet, requiredCapabilities: CAPS });
  assert.equal(result.status, "completed");
  assert.equal(result.effectiveModel, "claude-canonical-fixture");
  const seen = await prompts(bed);
  assert.equal(seen.filter(kind => kind === "task").length, 1, seen.join(","));
  assert.ok(seen.indexOf("task") === seen.length - 1 && seen.slice(0, -1).every(kind => kind === "init-only"), seen.join(","));
}));

test("v0.6.0 identity: a moved alias (legacy haiku config) is refused at the preflight with an actionable model_identity, before any task prompt",
  async () => withBed(async bed => {
    // Exactly the failed release-acceptance shape: launch `haiku`, authorize Haiku 4.5, the runtime resolves Haiku 5.5.
    const t = transport(bed, "haiku", HAIKU_45, { FUSION_FAKE_SCENARIO: "ok", FUSION_FAKE_INIT_MODEL: "claude-haiku-5-5" });
    const result = await t.run({ packet, requiredCapabilities: CAPS });
    assert.equal(result.status, "failed");
    const error = result.error as FusionError;
    assert.equal(error.kind, "ProviderIdentityMismatch");
    assert.equal(error.safeMessage, MODEL_IDENTITY_PREFLIGHT_MESSAGE);
    assert.match(error.safeMessage, /set the binding's model to its exact canonical model ID/u);
    assert.equal(error.failureDetail,
      "provider identity mismatch: code=model_identity requested=haiku expected=claude-haiku-4-5-20251001 observed=claude-haiku-5-5");
    assert.equal(error.retryable, false);
    const seen = await prompts(bed);
    assert.ok(seen.length >= 1 && seen.every(kind => kind === "init-only"), `no task prompt was ever sent: ${seen.join(",")}`);
    assert.equal(t.initReadback, undefined, "no turn reached its own init");
  }));

test("v0.6.0 identity: a missing or non-string init model fails closed at the preflight, before any task prompt", async () => {
  for (const [scenario, observed] of [["model-missing", "(missing)"], ["model-non-string", "(non-string)"]] as const) {
    await withBed(async bed => {
      const result = await transport(bed, "alias", "claude-canonical-fixture", { FUSION_FAKE_SCENARIO: scenario }).run({ packet, requiredCapabilities: CAPS });
      assert.equal(result.status, "failed", scenario);
      assert.equal(result.error?.kind, "ProviderIdentityMismatch", scenario);
      assert.match(result.error?.failureDetail ?? "", new RegExp(`expected=claude-canonical-fixture observed=\\(${observed.slice(1, -1)}\\)$`, "u"), scenario);
      assert.ok((await prompts(bed)).every(kind => kind === "init-only"), scenario);
    });
  }
});

test("v0.6.0 identity: the turn still checks its own init model exactly after a passing preflight (defense in depth)", async () => withBed(async bed => {
  // Every init-only startup reports the authorized model; the turn itself reports another one.
  const t = transport(bed, "alias", "claude-canonical-fixture", { FUSION_FAKE_SCENARIO: "turn-model-mismatch" });
  const result = await t.run({ packet, requiredCapabilities: CAPS });
  assert.equal(result.status, "failed");
  assert.equal(result.error?.kind, "ProviderIdentityMismatch");
  assert.equal(result.error?.safeMessage, "Claude effective model differs from the configured canonical model.");
  assert.equal(result.error?.failureDetail,
    "provider identity mismatch: code=model_identity requested=alias expected=claude-canonical-fixture observed=claude-other-model");
  assert.deepEqual((await prompts(bed)).filter(kind => kind === "task"), ["task"], "the preflight passed, so the turn was launched");
}));

// ---------------------------------------------------------------- doctor's identity probe (transport level)

test("v0.6.0 identity: verifyModelIdentity attests the exact model in a fresh Fusion-owned workspace, init-only, and refuses a moved alias",
  async () => withBed(async bed => {
    const good = await transport(bed, "alias", "claude-canonical-fixture", { FUSION_FAKE_SCENARIO: "ok" }).verifyModelIdentity();
    assert.deepEqual(good, { requested: "alias", expected: "claude-canonical-fixture", runtimeVersion: "2.1.280" });
    await assert.rejects(transport(bed, "haiku", HAIKU_45, { FUSION_FAKE_SCENARIO: "ok", FUSION_FAKE_INIT_MODEL: "claude-haiku-5-5" })
      .verifyModelIdentity(), (error: unknown) => error instanceof ClaudeFailure && error.error.kind === "ProviderIdentityMismatch" &&
      error.error.failureDetail === modelIdentityDetail("haiku", HAIKU_45, "claude-haiku-5-5"));
    assert.ok((await prompts(bed)).every(kind => kind === "init-only"), "the identity probe never sends a task");
    const cwds = await launchCwds(bed);
    assert.ok(cwds.length > 0 && cwds.every(cwd => resolve(cwd).toLowerCase() !== resolve(bed.dir).toLowerCase()),
      "it never starts in the configured workspace");
    for (const cwd of new Set(cwds)) await assert.rejects(readdir(cwd), "its temporary workspace is removed afterwards");
  }));

// ---------------------------------------------------------------- 6-8: readiness and `fusion doctor --probe`

const claudeInspection = (): BindingInspection => ({ provider: "claude", transport: "claude-one-shot", executable: "available",
  runtimeVersion: "2.1.280", billing: { state: "clear", reasons: [], candidateLane: "subscription" },
  capabilities: claudeCapability("2.1.280", "launchFlag"), structuredTurns: true, controls: [], notes: [] });
const probeWith = (identity: "verified" | "refused", requested: string, expected: string): BindingProbe => ({
  auth: { state: "authenticated", lane: "subscription", detail: "fixture" }, capabilities: claudeCapability("2.1.280", "launchFlag"),
  posture: { state: "recorded", version: "2.1.280", detail: "fixture" },
  modelIdentity: identity === "verified" ? { state: "verified", requested, expected, detail: `init readback is exactly ${expected}` }
    : { state: "refused", requested, expected, detail: `${MODEL_IDENTITY_PREFLIGHT_MESSAGE} (${modelIdentityDetail(requested, expected, "claude-haiku-5-5")})` } });
const binding = (role: BindingConfig["role"], model: string, canonical: string): BindingConfig =>
  ({ role, adapter: "fixture-claude", model, effort: "low", maxTurns: 6, options: { canonicalModel: canonical } });

test("v0.6.0 identity: a refused model identity (or posture) makes a Lead and a Worker not eligible; the Worker's writer stays blocked", () => {
  for (const role of ["Lead", "Worker"] as const) {
    const b = binding(role, "haiku", HAIKU_45);
    const verified = bindingEligibility(b, claudeInspection(), undefined, probeWith("verified", "haiku", HAIKU_45));
    const refused = bindingEligibility(b, claudeInspection(), undefined, probeWith("refused", "haiku", HAIKU_45));
    assert.notEqual(verified.readOnly.state, "blocked", role);
    assert.equal(refused.readOnly.state, "blocked", role);
    assert.ok(refused.readOnly.reasons.some(reason => /model_identity/u.test(reason) && /observed=claude-haiku-5-5/u.test(reason)), role);
    if (role === "Worker") {
      assert.equal(refused.changeProposal.state, "blocked");
      assert.ok(refused.changeProposal.reasons.some(reason => /model_identity/u.test(reason)));
    }
    for (const result of [verified, refused]) assert.deepEqual([result.writer.state, result.writer.reasons], ["blocked", [REAL_WRITER_MODE_NOT_READY]], role);
    const posture = bindingEligibility(b, claudeInspection(), undefined,
      { ...probeWith("verified", "haiku", HAIKU_45), posture: { state: "refused", version: "2.1.296", detail: "canary failed" } });
    assert.equal(posture.readOnly.state, "blocked", `${role}: a refused posture is never eligible`);
  }
});

function sh(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false",
    "-c", "init.defaultBranch=main", "-c", `core.hooksPath=${join(cwd, ".no-hooks")}`, ...args], { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
}
/** A registry whose fixture factory answers `doctor --probe` the way the Claude factory does, per binding. */
function doctorRegistry(identities: Readonly<Record<string, "verified" | "refused">>, probed: string[]): ProviderRegistry {
  const factory: AdapterFactory = {
    kind: "fixture-claude",
    async inspect() { return claudeInspection(); },
    async probe(b: BindingConfig) {
      probed.push(b.role);
      return probeWith(identities[b.role] ?? "verified", b.model, String(b.options?.canonicalModel));
    },
    async create() { throw new Error("doctor never builds an adapter"); },
  };
  return { defaults: { schemaVersion: 1, bindings: [], verification: { commands: [] }, limits: { runTimeoutMs: 60_000 } },
    factories: new Map([["fixture-claude", factory]]) };
}

test("v0.6.0 identity: `fusion doctor --probe` reports a mismatched Lead and Worker not eligible, with model_identity, and runs no turn",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "fusion-v060-doctor-"));
    try {
      const root = join(dir, "repo");
      await mkdir(root);
      sh(root, "init", "-q"); sh(root, "config", "core.autocrlf", "false");
      // A legacy configuration: both Claude bindings request a moving alias while authorizing a concrete model.
      const bindings = [binding("Lead", "opus", "claude-opus-5-5"), binding("Worker", "haiku", HAIKU_45)];
      await writeFile(join(root, CONFIG_FILE), JSON.stringify({ schemaVersion: 1, bindings }));
      sh(root, "add", "."); sh(root, "commit", "-qm", "init");
      for (const [identities, expectBlocked] of [[{ Lead: "refused", Worker: "refused" }, true], [{ Lead: "verified", Worker: "verified" }, false]] as const) {
        const probed: string[] = [];
        let stdout = "";
        const io = { stdout: (text: string) => { stdout += text; }, stderr: () => {} };
        await runCli(["--json", "doctor", "--probe"], io, { env: process.env, cwd: root, registry: doctorRegistry(identities, probed) });
        const report = JSON.parse(stdout) as { roles: Record<string, Record<string, string>>; writer: { ready: boolean; code: string };
          writerGates: { liveGateAuthorized: boolean }; providers: Array<{ role: string; identity: { observed: string };
            eligibility: Record<string, { state: string; reasons: string[] }> }> };
        assert.deepEqual([...probed].sort(), ["Lead", "Worker"]);
        for (const role of ["Lead", "Worker"]) {
          const p = report.providers.find(entry => entry.role === role)!;
          assert.equal(p.eligibility.readOnly!.state === "blocked", expectBlocked, `${role} ${JSON.stringify(identities)}`);
          assert.equal(p.eligibility.readOnly!.reasons.some(reason => /model_identity/u.test(reason)), expectBlocked, role);
          assert.match(p.identity.observed, expectBlocked ? /^refused: model_identity/u : /exact init readback, no model call/u, role);
          assert.deepEqual([p.eligibility.writer!.state, p.eligibility.writer!.reasons], ["blocked", [REAL_WRITER_MODE_NOT_READY]], role);
        }
        if (expectBlocked) assert.notEqual(report.roles.Lead!.readOnly, "eligible");
        assert.equal(report.roles.Worker!.writer, "blocked");
        assert.deepEqual([report.writer.ready, report.writer.code, report.writerGates.liveGateAuthorized],
          [false, "REAL_WRITER_MODE_NOT_READY", false], "identity attestation never touches writer authorization");
        let text = "";
        await runCli(["doctor", "--probe"], { stdout: t => { text += t; }, stderr: () => {} },
          { env: process.env, cwd: root, registry: doctorRegistry(identities, []) });
        assert.match(text, expectBlocked
          ? /model identity \(requested haiku, authorized claude-haiku-4-5-20251001\): REFUSED — .*observed=claude-haiku-5-5/u
          : /model identity \(requested haiku, authorized claude-haiku-4-5-20251001\): verified/u);
      }
    } finally {
      assert.ok(resolve(dir).toLowerCase().startsWith(`${resolve(tmpdir()).toLowerCase()}${sep}`));
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

// ---------------------------------------------------------------- 9-11: concrete defaults and `fusion create`

test("v0.6.0 identity: default Claude production bindings request their exact canonical model, never a moving alias", () => {
  const claude = DEFAULT_CONFIG.bindings.filter(b => b.adapter === "claude-one-shot");
  assert.deepEqual(claude.map(b => [b.role, b.model, b.options?.canonicalModel]),
    [["Lead", "claude-opus-5-5", "claude-opus-5-5"], ["Worker", HAIKU_45, HAIKU_45]]);
  for (const b of claude) {
    assert.equal(b.model, b.options?.canonicalModel, `${b.role}: the launch identity is the authorized identity`);
    assert.doesNotMatch(b.model, /^(haiku|opus|sonnet|fable|default|best)$/u, `${b.role}: no convenience alias`);
    assert.match(b.model, /^claude-[a-z]+-\d+-\d+(?:-\d{8})?$/u, `${b.role}: a concrete model ID`);
  }
});

test("v0.6.0 identity: `fusion create` writes the concrete model IDs into the new project's configuration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fusion-v060-create-"));
  try {
    const plan = planCreate(dir, { description: "a tiny library that describes itself", template: "library", name: "identitylib" });
    const project = await scaffoldProject(plan, process.env, DEFAULT_CONFIG.bindings);
    const written = JSON.parse(await readFile(join(project.root, CONFIG_FILE), "utf8")) as { bindings: BindingConfig[] };
    const claude = written.bindings.filter(b => b.adapter === "claude-one-shot");
    assert.deepEqual(claude.map(b => [b.role, b.model, b.options?.canonicalModel]),
      [["Lead", "claude-opus-5-5", "claude-opus-5-5"], ["Worker", HAIKU_45, HAIKU_45]]);
  } finally {
    assert.ok(resolve(dir).toLowerCase().startsWith(`${resolve(tmpdir()).toLowerCase()}${sep}`));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// ---------------------------------------------------------------- 14: the observed identity survives in the run record

test("v0.6.0 identity: the sanitized expected/observed identity of a mismatch persists in the run's outcome record", async () => withBed(async bed => {
  const result = await transport(bed, "haiku", HAIKU_45, { FUSION_FAKE_SCENARIO: "ok", FUSION_FAKE_INIT_MODEL: "claude-haiku-5-5" })
    .run({ packet, requiredCapabilities: CAPS });
  assert.equal(result.status, "failed");
  const root = join(bed.dir, "repo");
  await mkdir(root);
  sh(root, "init", "-q");
  const recorder = await RunRecorder.start(root, "build", new DiagnosticRedactor(), { task: "Identity fixture task." });
  await recorder.finish({ state: "FAILED", exitCode: 4, code: "ProviderIdentityMismatch", message: result.error!.safeMessage, error: result.error! });
  const artifacts = join(root, ".fusion", "runs", recorder.runId, "artifacts", "json");
  const records = await Promise.all((await readdir(artifacts)).map(async name => JSON.parse(await readFile(join(artifacts, name), "utf8")) as
    { error?: { kind: string; message: string; detail?: string } }));
  const outcome = records.find(r => r.error !== undefined)!;
  assert.deepEqual(outcome.error, { kind: "ProviderIdentityMismatch", message: MODEL_IDENTITY_PREFLIGHT_MESSAGE,
    detail: "provider identity mismatch: code=model_identity requested=haiku expected=claude-haiku-4-5-20251001 observed=claude-haiku-5-5" });
  // Sanitized: an unprintable or overlong observed value never reaches the record raw.
  assert.equal(modelIdentityDetail("haiku", HAIKU_45, `claude-haiku-5-5\u0007\n${"x".repeat(200)}`).length < 200, true);
  assert.equal(modelIdentityDetail("haiku", HAIKU_45, "a b\u0000c\u001b[31m"),
    "provider identity mismatch: code=model_identity requested=haiku expected=claude-haiku-4-5-20251001 observed=abc[31m");
}));
