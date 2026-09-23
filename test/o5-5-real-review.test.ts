import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { copyFile, link, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import type { BindingConfig } from "../src/app/config.js";
import type { AdapterFactory, BindingInspection, ProviderRegistry } from "../src/app/providers.js";
import { bindingEligibility, readinessVerdict } from "../src/app/readiness.js";
import { writerReadiness } from "../src/app/writer-gate.js";
import { runCli } from "../src/cli/run.js";
import { ADJUDICATION_VERDICTS, FINDING_CONFIDENCES, FINDING_SEVERITIES, REQUIRED_ACTIONS, type CapabilitySnapshot,
  type Finding, type ProviderAdapter, type ReviewEvidence, type ReviewRequest, type ReviewerFinding, type RoleBinding,
  type Session, type StructuredTurnResult } from "../src/core/domain.js";
import { FusionFailure } from "../src/core/errors.js";
import { BillingGuard } from "../src/core/policy/billing-guard.js";
import { REVIEW_ISOLATION, resolveRole, type RoleCandidate } from "../src/core/policy/routing.js";
import { adjudicationReportSchema, reviewReportSchema, structuredTurnPrompt, structuredTurnSchema } from "../src/core/review/contract.js";
import { REVIEW_LIMITS, validateAdjudicationReport, validateReviewReport } from "../src/core/review/findings.js";
import { WorkflowEngine } from "../src/core/workflow/engine.js";
import type { WorkflowEvent } from "../src/core/workflow/types.js";
import { ProcessSupervisor } from "../src/platform/process/supervisor.js";
import { ClaudeAdapter } from "../src/providers/claude/claude-adapter.js";
import { ClaudeOneShotTransport } from "../src/providers/claude/one-shot-transport.js";
import { claudeReadOnlyArgs } from "../src/providers/claude/plugin-quarantine.js";
import { claudeCapability, claudeLaunchPosture } from "../src/providers/claude/posture.js";
import { CLAUDE_CHILD_SWITCHES, claudeInstallVersion, type ClaudeLaunchConfig } from "../src/providers/claude/types.js";
import { MuseExecTransport } from "../src/providers/muse/exec-transport.js";
import { MuseAdapter } from "../src/providers/muse/muse-adapter.js";
import { assertSupportedSchema, normalizeWireValue, parseStructured, toMuseStrictSchema, validateSchema } from "../src/providers/muse/structured-output.js";
import { EXEC_CONTROL_FLAGS, VERIFIED_EXEC_WEB_DISABLE_VERSION, capability as museCapability, extensionSwitchesStripped,
  museLaunchPosture, type MuseLaunchConfig } from "../src/providers/muse/types.js";
import { defaultRegistry } from "../src/providers/registry.js";
import { claudeEnvironmentRules } from "../src/runtime/provider-environment-rules.js";

// ---------------------------------------------------------------------------------------------------------------
// O5.5A real read-only review activation. Every provider process is a deterministic local fixture
// (test/fixtures/*-fake.mjs); no test needs a network, an account or a real provider.

const gitAvailable = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;
const skip = gitAvailable ? false : "git executable unavailable";
const CLAUDE_FIXTURE = resolve(process.cwd(), "test/fixtures/claude-fake.mjs");
const MUSE_FIXTURE = resolve(process.cwd(), "test/fixtures/muse-fake.mjs");
const EMPTY_HOME = resolve(process.cwd(), "test/fixtures/empty-claude-home");
const CLAUDE_VERSION = "2.1.280";
const REVIEW_PREFIX = "Fusion fresh review.";
const ADJUDICATION_PREFIX = "Fusion adjudication.";
const claudeBinary = { executable: process.execPath, argvPrefix: [CLAUDE_FIXTURE] } as const;

interface Installs { dir: string; claudeExe: string; museDir: string; museExe: string }
/**
 * A Claude package layout (metadata only; its `claude.exe` is an empty file that is never executed) and a Muse
 * binary directory whose versioned executable is a link to node, so the Muse fixture runs under the verified name.
 */
async function withInstalls<T>(run: (i: Installs) => Promise<T>,
  versions: { claude?: string; muse?: string } = {}): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "fusion-o55-"));
  try {
    const pkg = join(dir, "claude-code");
    await mkdir(join(pkg, "bin"), { recursive: true });
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", version: versions.claude ?? CLAUDE_VERSION }));
    const claudeExe = join(pkg, "bin", "claude.exe");
    await writeFile(claudeExe, "");
    const museDir = join(dir, "muse"), museVersion = versions.muse ?? VERIFIED_EXEC_WEB_DISABLE_VERSION;
    await mkdir(museDir);
    await writeFile(join(museDir, ".muse-version"), museVersion);
    const museExe = join(museDir, `muse-bin-${museVersion}.exe`);
    try { await link(process.execPath, museExe); } catch { await copyFile(process.execPath, museExe); }
    return await run({ dir, claudeExe, museDir, museExe });
  } finally {
    assert.ok(resolve(dir).toLowerCase().startsWith(`${resolve(tmpdir()).toLowerCase()}${sep}`));
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
const museBinary = (i: Installs) => ({ executable: i.museExe, argvPrefix: [MUSE_FIXTURE] }) as const;
type Env = Readonly<Record<string, string>>;
function claudeConfig(i: Installs, env: Env = {}, over: Partial<ClaudeLaunchConfig> = {}): ClaudeLaunchConfig {
  return { executablePath: i.claudeExe, workspace: i.dir, model: { id: "alias", effort: "low", maxTurns: 3 },
    expectedCanonicalModel: "claude-canonical-fixture", posture: "readOnly", timeoutMs: 10_000,
    sourceEnvironment: { SystemRoot: process.env.SystemRoot, USERPROFILE: EMPTY_HOME, ...env }, ...over };
}
function museConfig(i: Installs, env: Env = {}, over: Partial<MuseLaunchConfig> = {}): MuseLaunchConfig {
  return { binaryDirectory: i.museDir, versionFile: join(i.museDir, ".muse-version"), workspace: i.dir, provider: "meta",
    model: { id: "muse-spark-1.3", effort: "low" }, posture: "readOnly", maxModelSteps: 4, timeoutMs: 10_000,
    sourceEnvironment: { SystemRoot: process.env.SystemRoot, ...env }, ...over };
}
const claudeBindingFor = (role: RoleBinding["role"], config: ClaudeLaunchConfig): RoleBinding =>
  ({ role, provider: "claude", transport: "claude-one-shot", model: config.model, requires: {} });
const museBindingFor = (role: RoleBinding["role"], config: MuseLaunchConfig, transport = "muse-exec"): RoleBinding =>
  ({ role, provider: config.provider, transport, model: config.model, requires: {} });

// Evidence whose goal carries unicode and shell metacharacters through stdin and prompt files.
const GOAL = "line 1\n& | $() ü ☃";
const evidence: ReviewEvidence = { task: { goal: GOAL, constraints: [], acceptanceCriteria: [] },
  architecture: { decisions: [], invariants: [] }, scope: { relevantFiles: ["a.txt"], allowedFiles: [], forbiddenFiles: [] },
  verification: { required: false, passed: false, commands: [] },
  change: { kind: "diff", changedPaths: ["a.txt"], text: "diff --git a/a.txt b/a.txt\n-old\n+new value\n", truncated: false } };
const reviewRequest: ReviewRequest = { kind: "review", cycle: 1, evidence, priorFindings: [], limits: { maxFindings: REVIEW_LIMITS.maxFindings } };
const finding = (id: string, severity: ReviewerFinding["severity"], patch: Partial<ReviewerFinding> = {}): ReviewerFinding => ({
  id, severity, confidence: "HIGH", category: "correctness", file: "a.txt", lines: { start: 1, end: 1 },
  title: `${severity} problem ${id}`, evidence: ["The new value drops the old one."], failureScenario: "Saving twice loses data.", ...patch });
/** A finding without a location. */
const unlocated = (id: string, severity: ReviewerFinding["severity"]): ReviewerFinding => {
  const { file: _file, lines: _lines, ...rest } = finding(id, severity);
  return rest;
};
const report = (...findings: ReviewerFinding[]) => ({ findings, summary: "Summary carries no authority." });
/** What a strict-decoding exec provider emits for a canonical value: every omitted optional property is present as null. */
function wireOf(value: unknown, schema: Record<string, unknown> = reviewReportSchema()): unknown {
  if (schema.type === "object" && value !== null && typeof value === "object" && !Array.isArray(value)) {
    const props = schema.properties as Record<string, Record<string, unknown>>;
    return Object.fromEntries(Object.keys(props).map(key =>
      [key, Object.hasOwn(value, key) ? wireOf((value as Record<string, unknown>)[key], props[key]!) : null]));
  }
  if (schema.type === "array" && Array.isArray(value)) return value.map(item => wireOf(item, schema.items as Record<string, unknown>));
  return value;
}
const provenance = { cycle: 1, runId: "run-1", sessionId: "s-1", role: "Reviewer" as const };
const findingsOf = (...drafts: ReviewerFinding[]): readonly Finding[] => validateReviewReport(report(...drafts), provenance);
const adjudicationRequest = (findings: readonly Finding[]) => ({ kind: "adjudication" as const, cycle: 1, evidence, findings,
  fusionFacts: findings.map(f => ({ findingId: f.id, supported: [], contradicted: [] })) });
const malformed = (fn: () => unknown, name: string): void => assert.throws(fn, (error: unknown) =>
  error instanceof FusionFailure && error.error.kind === "MalformedOutput", name);

/** Counts process starts: a guard that refuses before launch must start nothing. */
class CountingSupervisor extends ProcessSupervisor {
  starts = 0;
  override start(...args: Parameters<ProcessSupervisor["start"]>): ReturnType<ProcessSupervisor["start"]> {
    this.starts++;
    return super.start(...args);
  }
}
const claudeTransport = (i: Installs, env: Env, over: Partial<ClaudeLaunchConfig> = {}, supervisor = new ProcessSupervisor()) =>
  new ClaudeOneShotTransport(claudeConfig(i, env, over), supervisor, claudeBinary);
const museAuth = async () => ({ state: "authenticated" as const, lane: "subscription" as const, observedAt: "", evidence: [] });
const museTransport = (i: Installs, env: Env, over: Partial<MuseLaunchConfig> = {}, supervisor = new ProcessSupervisor(),
  attest: () => ReturnType<typeof museAuth> = museAuth) => new MuseExecTransport(museConfig(i, env, over), attest, supervisor, museBinary(i));
const REVIEW_REQUIREMENTS = { ...REVIEW_ISOLATION, structuredOutput: true, webToolsDisabled: true,
  filesystem: { read: true, write: false }, shell: { available: false } } as const;
const claudeStructured = (t: ClaudeOneShotTransport, signal?: AbortSignal) =>
  t.runStructured({ request: reviewRequest, requiredCapabilities: REVIEW_REQUIREMENTS, ...(signal ? { signal } : {}) });
const museStructured = (t: MuseExecTransport, signal?: AbortSignal) =>
  t.runStructured({ request: reviewRequest, requiredCapabilities: REVIEW_REQUIREMENTS, ...(signal ? { signal } : {}) });
const reviewOut = (output: string, scenario = "ok"): Env => ({ FUSION_FAKE_SCENARIO: scenario, FUSION_FAKE_OUTPUT: output,
  FUSION_FAKE_PROMPT_PREFIX: REVIEW_PREFIX });
const failure = (turn: StructuredTurnResult) => [turn.status, turn.status === "completed" ? undefined : turn.error.kind];

// A minimal adapter that only reports a snapshot; routing decisions never need more.
function stub(snapshot: CapabilitySnapshot, structured = true): ProviderAdapter {
  const never = async (): Promise<never> => { throw new Error("no turn may run"); };
  return { capabilities: async () => snapshot, authStatus: never, createSession: never, resumeSession: never, runTurn: never,
    cancel: async () => undefined, usage: async () => null, close: async () => undefined,
    ...(structured ? { runStructuredTurn: never } : {}) };
}
async function routable(snapshot: CapabilitySnapshot): Promise<boolean> {
  const candidate: RoleCandidate = { binding: { role: "Reviewer", provider: snapshot.provider, transport: snapshot.transport,
    model: { id: "m", effort: "e" }, requires: {} }, adapter: stub(snapshot) };
  try { await resolveRole("Reviewer", [candidate], undefined, { structuredTurns: true, reviewIsolation: true }); return true; }
  catch (error) { assert.equal((error as FusionFailure).error.kind, "CapabilityUnavailable"); return false; }
}
const binding = (role: BindingConfig["role"]): BindingConfig => ({ role, adapter: "x", model: "m", effort: "e", options: {} });
const inspection = (capabilities: CapabilitySnapshot, structuredTurns = true): BindingInspection => ({ provider: capabilities.provider,
  transport: capabilities.transport, executable: "available", runtimeVersion: capabilities.runtimeVersion,
  billing: { state: "clear", reasons: [] }, capabilities, structuredTurns, controls: [], notes: [] });
const reviewState = (snapshot: CapabilitySnapshot): string => bindingEligibility(binding("Reviewer"), inspection(snapshot)).review.state;
type Posture = ReturnType<typeof claudeLaunchPosture>;
const applyPosture = (base: CapabilitySnapshot, p: Posture | ReturnType<typeof museLaunchPosture>): CapabilitySnapshot => ({ ...base,
  webToolsDisabled: p.webToolsDisabled, filesystem: { read: "read" in p ? p.read : base.filesystem.read, write: p.write },
  shell: { ...base.shell, available: p.shell }, approvalEscalationDisabled: p.approvalEscalationDisabled,
  personalContextDisabled: p.personalContextDisabled, extensionsQuarantined: p.extensionsQuarantined });
const without = (args: readonly string[], flag: string, valued: boolean): string[] => {
  const at = args.indexOf(flag);
  assert.ok(at >= 0, `${flag} is a launch control`);
  return [...args.slice(0, at), ...args.slice(at + (valued ? 2 : 1))];
};

// ---------------------------------------------------------------------------------------------------------------
// 1-4: pre-session read-only capability proof

test("O5.5A Claude: the launch arguments establish the review posture before any session", async () => withInstalls(async i => {
  assert.equal(await claudeInstallVersion(i.claudeExe), CLAUDE_VERSION);
  assert.equal(await claudeInstallVersion(join(i.dir, "claude-code", "claude.exe")), "unknown", "only <package>/bin/claude.exe");
  assert.equal(await claudeInstallVersion("relative\\bin\\claude.exe"), "unknown");
  const config = claudeConfig(i);
  const adapter = new ClaudeAdapter(claudeBindingFor("Lead", config), config, claudeBinary);
  const caps = await adapter.capabilities();
  assert.deepEqual(caps.postureEvidence, { source: "launchFlag", versionVerified: true });
  assert.deepEqual([caps.structuredOutput, caps.filesystem.read, caps.filesystem.write, caps.shell.available, caps.webToolsDisabled,
    caps.approvalEscalationDisabled, caps.personalContextDisabled, caps.extensionsQuarantined, caps.modelIdentityReadback,
    caps.subscriptionLaneReadback], [true, true, false, false, true, true, true, true, true, true]);
  const resolved = await resolveRole("Lead", [{ binding: claudeBindingFor("Lead", config), adapter }], undefined,
    { structuredTurns: true, reviewIsolation: true });
  assert.equal(resolved.adapter, adapter);
  // Static inspection agrees and never starts the (empty, unexecutable) claude.exe.
  const claude = defaultRegistry().factories.get("claude-one-shot")!;
  const inspected = await claude.inspect({ role: "Lead", adapter: "claude-one-shot", model: "alias", effort: "low", maxTurns: 3,
    options: { executable: i.claudeExe, canonicalModel: "claude-canonical-fixture" } },
  { workspace: i.dir, env: { SystemRoot: process.env.SystemRoot ?? "", USERPROFILE: EMPTY_HOME } });
  assert.deepEqual([inspected.runtimeVersion, inspected.structuredTurns, inspected.executable], [CLAUDE_VERSION, true, "available"]);
  assert.equal(bindingEligibility(binding("Lead"), inspected).review.state, "eligible");
  assert.ok(inspected.controls.every(control => control.state === "available"), JSON.stringify(inspected.controls));
  // The child-only auto-memory switch is part of the posture, and the fixture refuses to run without it (exit 36).
  assert.equal(CLAUDE_CHILD_SWITCHES.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
}));

test("O5.5A Claude: an unvalidated or unreadable installed version leaves the posture unknown", async () => {
  for (const version of ["2.2.0", "not-a-version"]) await withInstalls(async i => {
    const config = claudeConfig(i);
    const caps = await new ClaudeAdapter(claudeBindingFor("Lead", config), config, claudeBinary).capabilities();
    assert.equal(caps.postureEvidence, undefined);
    assert.deepEqual([caps.filesystem.read, caps.approvalEscalationDisabled, caps.extensionsQuarantined], ["unknown", "unknown", "unknown"]);
    assert.equal(await routable(caps), false);
    assert.equal(reviewState(caps), "unknown");
  }, { claude: version });
  assert.equal((await claudeCapability("unknown", "launchFlag")).personalContextDisabled, "unknown");
});

test("O5.5A Muse: Exec launch flags establish the review posture on the verified release only", async () => withInstalls(async i => {
  const config = museConfig(i);
  const exec = museCapability(config, "muse-exec", VERIFIED_EXEC_WEB_DISABLE_VERSION);
  assert.deepEqual(exec.postureEvidence, { source: "launchFlag", versionVerified: true });
  assert.deepEqual([exec.structuredOutput, exec.filesystem.write, exec.shell.available, exec.webToolsDisabled,
    exec.approvalEscalationDisabled, exec.personalContextDisabled, exec.extensionsQuarantined, exec.subscriptionLaneReadback],
  [true, false, false, true, true, true, true, true]);
  assert.equal(await routable(exec), true);
  assert.equal(extensionSwitchesStripped(), true, "the billing guard strips every extension switch from Muse children");
  const unverified = museCapability(config, "muse-exec", "1.3.0-R9999.1");
  assert.deepEqual([unverified.filesystem.write, unverified.shell.available], [false, false], "host flags stay enforced");
  assert.deepEqual([unverified.webToolsDisabled, unverified.approvalEscalationDisabled, unverified.personalContextDisabled,
    unverified.extensionsQuarantined], ["unknown", "unknown", "unknown", "unknown"]);
  assert.equal(await routable(unverified), false);
  const msp = museCapability(config, "muse-msp", VERIFIED_EXEC_WEB_DISABLE_VERSION, undefined, true);
  assert.equal(await routable(msp), false);
  // Structured turns exist on an Exec-bound instance only.
  const execAdapter = new MuseAdapter(museBindingFor("Reviewer", config), config, undefined, museBinary(i));
  const mspAdapter = new MuseAdapter(museBindingFor("Reviewer", config, "muse-msp"), config, undefined, museBinary(i));
  assert.equal(typeof execAdapter.runStructuredTurn, "function");
  assert.equal(mspAdapter.runStructuredTurn, undefined);
  assert.deepEqual((await execAdapter.capabilities()).postureEvidence, { source: "launchFlag", versionVerified: true });
  const muse = defaultRegistry().factories;
  const context = { workspace: i.dir, env: { SystemRoot: process.env.SystemRoot ?? "" } };
  const options = { provider: "meta", binaryDirectory: i.museDir };
  const execInspection = await muse.get("muse-exec")!.inspect({ role: "Reviewer", adapter: "muse-exec", model: "muse-spark-1.3",
    effort: "low", options }, context);
  assert.deepEqual([execInspection.structuredTurns, bindingEligibility(binding("Reviewer"), execInspection).review.state], [true, "eligible"]);
  const mspInspection = await muse.get("muse-msp")!.inspect({ role: "Reviewer", adapter: "muse-msp", model: "muse-spark-1.3",
    effort: "low", options }, context);
  assert.equal(mspInspection.structuredTurns, false);
  assert.notEqual(bindingEligibility(binding("Reviewer"), mspInspection).review.state, "eligible");
}));

test("O5.5A removing any single read-only control makes the binding ineligible", async () => {
  const claudeBase = claudeCapability(CLAUDE_VERSION, "launchFlag");
  const args = claudeReadOnlyArgs("m", "e", 1);
  assert.equal(await routable(applyPosture(claudeBase, claudeLaunchPosture(args, CLAUDE_CHILD_SWITCHES, true))), true);
  const claudeAblations: Array<[string, string[], Env]> = [
    ...([["--tools", true], ["--restricted", false], ["--permission-mode", true], ["--permission-prompts", true], ["--safe-mode", false],
      ["--strict-mcp-config", false], ["--disable-slash-commands", false], ["--include-hook-events", false]] as const)
      .map(([flag, valued]): [string, string[], Env] => [flag, without(args, flag, valued), CLAUDE_CHILD_SWITCHES]),
    ["auto-memory switch", args, {}],
    ["extra tool", args.map(arg => arg === "Read,Grep,Glob" ? "Read,Grep,Glob,Bash" : arg), CLAUDE_CHILD_SWITCHES],
    ["widening flag", [...args, "--mcp-config", "servers.json"], CLAUDE_CHILD_SWITCHES],
    ["permission mode", args.map(arg => arg === "dontAsk" ? "acceptEdits" : arg), CLAUDE_CHILD_SWITCHES],
  ];
  for (const [name, ablated, env] of claudeAblations) {
    const snapshot = applyPosture(claudeBase, claudeLaunchPosture(ablated, env, true));
    assert.equal(await routable(snapshot), false, `Claude without ${name}`);
    assert.notEqual(reviewState(snapshot), "eligible", `Claude readiness without ${name}`);
  }
  const museBase = museCapability({ provider: "meta" } as MuseLaunchConfig, "muse-exec", VERIFIED_EXEC_WEB_DISABLE_VERSION);
  assert.equal(await routable(applyPosture(museBase, museLaunchPosture(EXEC_CONTROL_FLAGS, true))), true);
  const museAblations: Array<[string, readonly string[], boolean]> = [
    ...([["--approval-mode", true], ["--disable-write", false], ["--disable-shell", false], ["--disable-web-tools", false],
      ["--approval-judge", true], ["--no-foreign-personal-context", false]] as const)
      .map(([flag, valued]): [string, readonly string[], boolean] => [flag, without(EXEC_CONTROL_FLAGS, flag, valued), true]),
    ["extension switch quarantine", EXEC_CONTROL_FLAGS, false],
    ["widening flag", [...EXEC_CONTROL_FLAGS, "--yolo"], true],
    ["approval judge", EXEC_CONTROL_FLAGS.map(flag => flag === "off" ? "on" : flag), true],
  ];
  for (const [name, flags, quarantined] of museAblations) {
    const snapshot = applyPosture(museBase, museLaunchPosture(flags, true, quarantined));
    assert.equal(await routable(snapshot), false, `Muse without ${name}`);
    assert.notEqual(reviewState(snapshot), "eligible", `Muse readiness without ${name}`);
  }
});

test("O5.5A an unknown or missing required capability stays ineligible", async () => {
  const full = museCapability({ provider: "meta" } as MuseLaunchConfig, "muse-exec", VERIFIED_EXEC_WEB_DISABLE_VERSION);
  assert.equal(await routable(full), true);
  assert.equal(reviewState(full), "eligible");
  const keys = [...Object.keys(REVIEW_ISOLATION), "structuredOutput", "webToolsDisabled"] as const;
  for (const key of keys) for (const value of ["unknown", undefined] as const) {
    const snapshot = { ...full, [key]: value } as CapabilitySnapshot;
    assert.equal(await routable(snapshot), false, `${key}=${String(value)}`);
    assert.equal(reviewState(snapshot), "unknown", `${key}=${String(value)} is unknown, never eligible`);
    assert.equal(readinessVerdict(false, { Reviewer: { readOnly: "eligible", review: "unknown" }, Lead: { readOnly: "eligible",
      review: "eligible" } }).overall === "REVIEW_READY", false);
  }
  for (const [key, patch] of [["filesystem.read", { filesystem: { read: "unknown", write: false } }],
    ["shell.available", { shell: { available: "unknown", sandboxed: "unknown" } }]] as const) {
    const snapshot = { ...full, ...patch } as CapabilitySnapshot;
    assert.equal(await routable(snapshot), false, key);
    assert.notEqual(reviewState(snapshot), "eligible", key);
  }
  // An adapter without a structured turn is never a review binding, whatever it reports.
  const candidate: RoleCandidate = { binding: { role: "Reviewer", provider: "meta", transport: "muse-exec", model: { id: "m", effort: "e" },
    requires: {} }, adapter: stub(full, false) };
  await assert.rejects(resolveRole("Reviewer", [candidate], undefined, { structuredTurns: true, reviewIsolation: true }));
  assert.equal(bindingEligibility(binding("Reviewer"), inspection(full, false)).review.state, "ineligible");
});

// ---------------------------------------------------------------------------------------------------------------
// 5-7: structured output contracts

test("O5.5A Reviewer output is validated strictly against the O4 contract", async () => {
  const valid = report(finding("F1", "HIGH", { facts: [{ kind: "outOfScopeChange", path: "b.txt" }] }), unlocated("f2", "INFO"));
  const clean = JSON.parse(JSON.stringify(valid)) as unknown;
  assert.equal(validateReviewReport(clean, provenance).length, 2);
  assert.ok(validateSchema(clean, reviewReportSchema()), "the decoding schema accepts every contract-valid report");
  const big = (n: number) => "x".repeat(n);
  const cases: Array<[string, unknown]> = [
    ["not an object", "Looks good"], ["unknown key", { ...valid, verdict: "pass" }],
    ["unknown finding key", report({ ...finding("F1", "HIGH"), confidenceScore: 3 } as ReviewerFinding)],
    ["missing summary", { findings: [] }], ["missing field", { findings: [{ ...finding("F1", "HIGH"), failureScenario: undefined }], summary: "" }],
    ["invalid severity", report({ ...finding("F1", "HIGH"), severity: "CRITICAL" } as unknown as ReviewerFinding)],
    ["invalid confidence", report({ ...finding("F1", "HIGH"), confidence: "SURE" } as unknown as ReviewerFinding)],
    ["too many findings", report(...Array.from({ length: REVIEW_LIMITS.maxFindings + 1 }, (_, n) => finding(`F${n}`, "LOW")))],
    ["inverted line range", report(finding("F1", "HIGH", { lines: { start: 9, end: 3 } }))],
    ["line zero", report(finding("F1", "HIGH", { lines: { start: 0, end: 3 } }))],
    ["lines without file", report({ ...unlocated("F1", "HIGH"), lines: { start: 1, end: 1 } })],
    ["oversized title", report(finding("F1", "HIGH", { title: big(REVIEW_LIMITS.maxTitleChars + 1) }))],
    ["oversized evidence", report(finding("F1", "HIGH", { evidence: [big(REVIEW_LIMITS.maxEvidenceChars + 1)] }))],
    ["oversized summary", { findings: [], summary: big(REVIEW_LIMITS.maxSummaryChars + 1) }],
    ["empty evidence", report(finding("F1", "HIGH", { evidence: [] }))],
    ["duplicate ids", report(finding("F1", "HIGH"), finding("f1", "LOW"))],
    ["absolute path", report(finding("F1", "HIGH", { file: "C:/Windows/win.ini" }))],
  ];
  for (const [name, raw] of cases) malformed(() => validateReviewReport(JSON.parse(JSON.stringify(raw) ?? "null") as unknown, provenance), name);
  // The schema is derived from the same constants: enums match the contract exactly.
  const items = ((reviewReportSchema().properties as Record<string, { items: { properties: Record<string, { enum?: unknown[] }> } }>)
    .findings!.items.properties);
  assert.deepEqual([items.severity!.enum, items.confidence!.enum], [[...FINDING_SEVERITIES], [...FINDING_CONFIDENCES]]);
  // Duplicate JSON keys never resolve last-wins, through either provider.
  const duplicate = '{"findings":[],"findings":[{"id":"F1"}],"summary":""}';
  await withInstalls(async i => {
    assert.deepEqual(failure(await claudeStructured(claudeTransport(i, reviewOut(duplicate)))), ["failed", "MalformedOutput"]);
    assert.deepEqual(failure(await museStructured(museTransport(i, reviewOut(duplicate)))), ["failed", "MalformedOutput"]);
    const claude = await claudeStructured(claudeTransport(i, reviewOut(JSON.stringify(valid))));
    const muse = await museStructured(museTransport(i, reviewOut(JSON.stringify(wireOf(valid)))));
    for (const turn of [claude, muse]) {
      assert.equal(turn.status, "completed");
      if (turn.status === "completed") assert.equal(validateReviewReport(turn.output, provenance).length, 2);
    }
    assert.deepEqual([claude.effectiveProvider, claude.effectiveModel, muse.effectiveProvider, muse.effectiveModel],
      ["claude", "claude-canonical-fixture", "meta", "muse-spark-1.3"], "observed identity is read back");
  });
});

test("O5.5A Lead adjudication covers exactly the finding set with legal verdict/action pairs", async () => {
  const findings = findingsOf(finding("F1", "HIGH"), finding("F2", "LOW"));
  const entry = (findingId: string, verdict: string, requiredAction: string) => ({ findingId, verdict, rationale: "Checked.", requiredAction });
  const valid = { adjudications: [entry("r1-F1", "CONFIRMED", "fix"), entry("r1-F2", "PARTIAL", "followUp")], summary: "" };
  assert.equal(validateAdjudicationReport(valid, findings).adjudications.length, 2);
  assert.ok(validateSchema(valid, adjudicationReportSchema(findings.map(f => f.id))));
  const cases: Array<[string, unknown]> = [
    ["missing verdict", { adjudications: [entry("r1-F1", "CONFIRMED", "fix")], summary: "" }],
    ["duplicate verdict", { adjudications: [entry("r1-F1", "CONFIRMED", "fix"), entry("r1-F1", "REJECTED", "none"),
      entry("r1-F2", "CONFIRMED", "none")], summary: "" }],
    ["unknown finding", { adjudications: [entry("r1-F1", "CONFIRMED", "fix"), entry("r1-F9", "CONFIRMED", "none")], summary: "" }],
    ["REJECTED with an action", { adjudications: [entry("r1-F1", "REJECTED", "fix"), entry("r1-F2", "CONFIRMED", "none")], summary: "" }],
    ["UNVERIFIABLE with fix", { adjudications: [entry("r1-F1", "UNVERIFIABLE", "fix"), entry("r1-F2", "CONFIRMED", "none")], summary: "" }],
    ["material CONFIRMED without fix", { adjudications: [entry("r1-F1", "CONFIRMED", "none"), entry("r1-F2", "CONFIRMED", "none")], summary: "" }],
    ["material PARTIAL as follow-up", { adjudications: [entry("r1-F1", "PARTIAL", "followUp"), entry("r1-F2", "CONFIRMED", "none")], summary: "" }],
    ["invalid verdict", { adjudications: [entry("r1-F1", "ACCEPTED", "fix"), entry("r1-F2", "CONFIRMED", "none")], summary: "" }],
    ["malformed payload", "CONFIRMED"], ["unknown key", { ...valid, confidence: 1 }], ["missing summary", { adjudications: valid.adjudications }],
  ];
  for (const [name, raw] of cases) malformed(() => validateAdjudicationReport(raw, findings), name);
  const schema = adjudicationReportSchema(findings.map(f => f.id));
  const items = (schema.properties as Record<string, { minItems: number; maxItems: number; items: { properties: Record<string, { enum?: unknown[] }> } }>).adjudications!;
  assert.deepEqual([items.minItems, items.maxItems, items.items.properties.findingId!.enum], [2, 2, ["r1-F1", "r1-F2"]]);
  assert.deepEqual([items.items.properties.verdict!.enum, items.items.properties.requiredAction!.enum],
    [[...ADJUDICATION_VERDICTS], [...REQUIRED_ACTIONS]]);
  // The Lead prompt states the legal pairs and separates provider opinion from Fusion evidence.
  const prompt = structuredTurnPrompt(adjudicationRequest(findings));
  assert.ok(prompt.startsWith(ADJUDICATION_PREFIX));
  for (const rule of ["exactly once", "REJECTED requires \"none\"", "provider opinion, not evidence", "Never claim that you did"])
    assert.ok(prompt.includes(rule), rule);
  const reviewPrompt = structuredTurnPrompt(reviewRequest);
  for (const rule of ["independent Reviewer", "carries no authority", "No implementer rationale", "Never claim that you ran"])
    assert.ok(reviewPrompt.includes(rule), rule);
});

test("O5.5A prose around JSON is malformed and never extracted; surrounding whitespace is not prose", async () => withInstalls(async i => {
  const valid = JSON.stringify(report(finding("F1", "LOW"))), museValid = JSON.stringify(wireOf(report(finding("F1", "LOW"))));
  const cases: Array<[string, string]> = [[`Here is my review: ${valid}`, "prose-or-other"], [`\`\`\`json\n${valid}\n\`\`\``, "fenced"],
    [`${valid}\nThanks!`, "object-like"], ["", "empty"]];
  for (const [text, shape] of cases) {
    const claude = await claudeStructured(claudeTransport(i, reviewOut(text)));
    assert.deepEqual(failure(claude), ["failed", "MalformedOutput"], shape);
    if (claude.status !== "completed") assert.match(claude.error.safeMessage, new RegExp(`\\(${shape}\\)`, "u"));
    assert.deepEqual(failure(await museStructured(museTransport(i, reviewOut(text.replace(valid, museValid))))), ["failed", "MalformedOutput"], shape);
  }
  assert.equal((await claudeStructured(claudeTransport(i, reviewOut(`\n  ${valid}  \n`)))).status, "completed");
  assert.equal((await museStructured(museTransport(i, reviewOut(`\n  ${museValid}  \n`)))).status, "completed");
}));

// ---------------------------------------------------------------------------------------------------------------
// 8-13: provider failures are typed and fail closed

test("O5.5A a Reviewer turn that times out or is cancelled ends typed, with no output", async () => withInstalls(async i => {
  const timedOut = await claudeStructured(claudeTransport(i, { FUSION_FAKE_SCENARIO: "timeout", FUSION_FAKE_PROMPT_PREFIX: REVIEW_PREFIX },
    { timeoutMs: 1_500 }));
  assert.deepEqual(failure(timedOut), ["failed", "Timeout"]);
  assert.equal("output" in timedOut, false);
  assert.deepEqual(failure(await museStructured(museTransport(i, { FUSION_FAKE_SCENARIO: "hang" }, { timeoutMs: 1_000 }))),
    ["failed", "Timeout"]);
  const cancel = (): AbortSignal => { const c = new AbortController(); setTimeout(() => c.abort(), 400); return c.signal; };
  const claudeCancelled = await claudeStructured(claudeTransport(i, { FUSION_FAKE_SCENARIO: "cancel",
    FUSION_FAKE_PROMPT_PREFIX: REVIEW_PREFIX }), cancel());
  assert.deepEqual(failure(claudeCancelled), ["cancelled", "Cancelled"]);
  assert.equal("output" in claudeCancelled, false);
  assert.deepEqual(failure(await museStructured(museTransport(i, { FUSION_FAKE_SCENARIO: "hang" }), cancel())), ["cancelled", "Cancelled"]);
  // Through the adapters too: the caller's signal reaches the running turn.
  const config = museConfig(i, { FUSION_FAKE_SCENARIO: "hang" });
  const adapter = new MuseAdapter(museBindingFor("Reviewer", config), config, undefined, museBinary(i));
  const session = await adapter.createSession({ runId: "run-1", role: "Reviewer", workspaceLeaseId: "primary", posture: "readOnly",
    model: config.model });
  const viaAdapter = await adapter.runStructuredTurn!(session, reviewRequest, cancel());
  assert.deepEqual(failure(viaAdapter), ["cancelled", "Cancelled"]);
  await adapter.close(session);
}));

test("O5.5A nonzero exits, missing results and identity mismatches fail typed", async () => withInstalls(async i => {
  const valid = JSON.stringify(report());
  const claude = async (scenario: string) => failure(await claudeStructured(claudeTransport(i, reviewOut(valid, scenario))));
  const muse = async (scenario: string) => failure(await museStructured(museTransport(i, reviewOut(valid, scenario))));
  assert.deepEqual(await claude("nonzero"), ["failed", "ProcessFailure"]);
  assert.deepEqual(await muse("nonzero"), ["failed", "ProcessFailure"]);
  assert.deepEqual(await claude("missing-result"), ["failed", "ProtocolError"]);
  assert.deepEqual(await muse("missing-terminal"), ["failed", "ProtocolError"]);
  assert.deepEqual(failure(await claudeStructured(claudeTransport(i, { FUSION_FAKE_SCENARIO: "result-missing-text",
    FUSION_FAKE_PROMPT_PREFIX: REVIEW_PREFIX }))), ["failed", "MalformedOutput"]);
  assert.deepEqual(await claude("model-mismatch"), ["failed", "ProviderIdentityMismatch"]);
  assert.deepEqual(await muse("model-mismatch"), ["failed", "ProviderIdentityMismatch"]);
  assert.deepEqual(await muse("provider-mismatch"), ["failed", "ProviderIdentityMismatch"]);
  assert.deepEqual(await claude("version-upgrade"), ["failed", "CapabilityUnavailable"], "the init readback stays authoritative");
}));

test("O5.5A the billing guard refuses before any provider process starts", async () => withInstalls(async i => {
  for (const env of [{ ANTHROPIC_API_KEY: "sk-test" }, { ANTHROPIC_BASE_URL: "https://proxy.invalid" },
    { CLAUDE_CODE_USE_BEDROCK: "1" }, { CLAUDE_CODE_USE_VERTEX: "1" }]) {
    const supervisor = new CountingSupervisor();
    const turn = await claudeStructured(claudeTransport(i, { ...reviewOut("{}"), ...env }, {}, supervisor));
    assert.deepEqual(failure(turn), ["failed", "BillingBlocked"], Object.keys(env)[0]);
    assert.equal(supervisor.starts, 0, "no Claude process for a blocked environment");
    assert.doesNotMatch(JSON.stringify(turn), /sk-test|proxy\.invalid/u);
  }
  const supervisor = new CountingSupervisor();
  let attestations = 0;
  const turn = await museStructured(museTransport(i, { ...reviewOut("{}"), META_API_KEY: "mk-test" }, {}, supervisor,
    async () => { attestations++; return museAuth(); }));
  assert.deepEqual(failure(turn), ["failed", "BillingBlocked"]);
  assert.deepEqual([supervisor.starts, attestations], [0, 0]);
}));

test("O5.5A retained Exec evidence never keeps the reviewed change or task text, even when the prompt is echoed", async () =>
  withInstalls(async i => {
    const evidenceDirectory = join(i.dir, "evidence");
    await mkdir(evidenceDirectory);
    const marked: ReviewRequest = { ...reviewRequest, evidence: { ...evidence, change: { ...evidence.change,
      text: "diff --git a/a.txt b/a.txt\n-old\n+CHANGE-MARKER-9d2e line\n" } } };
    const turn = await museTransport(i, { ...reviewOut(JSON.stringify(report())), FUSION_FAKE_SCENARIO: "secret-stderr" })
      .runStructured({ request: marked, requiredCapabilities: REVIEW_REQUIREMENTS, evidenceDirectory });
    assert.equal(turn.status, "completed");
    const stderr = await readFile(turn.artifactRefs[1]!, "utf8");
    assert.doesNotMatch(stderr, /Fusion fresh review\./u, "no prompt text is retained");
    assert.doesNotMatch(stderr, /CHANGE-MARKER-9d2e|\$\(\) ü ☃/u);
    assert.deepEqual((await readdir(dirname(turn.artifactRefs[1]!))).sort(), ["stderr.txt", "stdout.jsonl"], "no prompt or schema file survives");
  }));

// ---------------------------------------------------------------------------------------------------------------
// 14-21: `fusion review` end to end with the real adapters over the fixtures

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false",
    "-c", "init.defaultBranch=main", "-c", `core.hooksPath=${join(cwd, ".no-hooks")}`, ...args], { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  return r.stdout;
}
async function userState(root: string): Promise<string> {
  const status = git(root, "status", "--porcelain=v1", "-uall", "--ignored").split("\n").filter(line => !line.startsWith("!! .fusion/")).join("\n");
  const lines = [status, git(root, "rev-parse", "HEAD"), git(root, "worktree", "list", "--porcelain"),
    git(root, "for-each-ref", "--format=%(refname) %(objectname)")];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name), rel = relative(root, path);
    if (!entry.isFile() || rel.startsWith(".git") || rel.startsWith(".fusion")) continue;
    lines.push(`${rel}:${createHash("sha256").update(await readFile(path)).digest("hex")}`);
  }
  return lines.join("\n");
}
interface Spy { creates: string[]; leadSessions: number }
class CountingClaude extends ClaudeAdapter {
  constructor(b: RoleBinding, c: ClaudeLaunchConfig, private readonly spy: Spy) { super(b, c, claudeBinary); }
  override async createSession(request: Parameters<ClaudeAdapter["createSession"]>[0]): Promise<Session> {
    this.spy.leadSessions++;
    return super.createSession(request);
  }
}
interface Roles { lead?: Env; reviewer?: Env; verification?: boolean }
/** The real registry's factories (option parsing, inspection) with the fixture executables substituted at creation. */
function registry(i: Installs, roles: Roles, spy: Spy): ProviderRegistry {
  const real = defaultRegistry().factories;
  const wrap = (factory: AdapterFactory, build: (binding: RoleBinding, adapter: ProviderAdapter) => ProviderAdapter): AdapterFactory => ({
    ...factory,
    async create(binding, context) {
      spy.creates.push(binding.role);
      const made = await factory.create(binding, context);
      return { binding: made.binding, adapter: build(made.binding, made.adapter) };
    } });
  const claudeEnv = { SystemRoot: process.env.SystemRoot, USERPROFILE: EMPTY_HOME, FUSION_FAKE_PROMPT_PREFIX: ADJUDICATION_PREFIX, ...roles.lead };
  const museEnv = { SystemRoot: process.env.SystemRoot, FUSION_FAKE_PROMPT_PREFIX: REVIEW_PREFIX, ...roles.reviewer };
  return {
    factories: new Map([
      ["claude-one-shot", wrap(real.get("claude-one-shot")!, (b, a) =>
        new CountingClaude(b, { ...(a as ClaudeAdapter).config, sourceEnvironment: claudeEnv }, spy))],
      ["muse-exec", wrap(real.get("muse-exec")!, (b, a) =>
        new MuseAdapter(b, { ...(a as MuseAdapter).config, sourceEnvironment: museEnv }, undefined, museBinary(i)))]]),
    defaults: { schemaVersion: 1, bindings: [
      { role: "Lead", adapter: "claude-one-shot", model: "alias", effort: "low", maxTurns: 3,
        options: { executable: i.claudeExe, canonicalModel: "claude-canonical-fixture", timeoutMs: 15_000 } },
      { role: "Reviewer", adapter: "muse-exec", model: "muse-spark-1.3", effort: "low",
        options: { provider: "meta", binaryDirectory: i.museDir, maxModelSteps: 4, timeoutMs: 15_000 } },
      { role: "Worker", adapter: "claude-one-shot", model: "alias", effort: "low", maxTurns: 3,
        options: { executable: i.claudeExe, canonicalModel: "claude-canonical-fixture" } }],
    verification: { commands: roles.verification ? [{ id: "check", executable: process.execPath, args: ["-e", "process.exit(0)"],
      cwd: ".", timeoutMs: 20_000, mutationPolicy: "readOnly" as const }] : [] },
    limits: { runTimeoutMs: 120_000 } },
  };
}
async function withRepo<T>(run: (i: Installs, root: string) => Promise<T>, installVersions: { claude?: string } = {}): Promise<T> {
  return withInstalls(async i => {
    const root = join(i.dir, "repo");
    await mkdir(root);
    git(root, "init", "-q"); git(root, "config", "core.autocrlf", "false");
    await writeFile(join(root, "a.txt"), "old\n");
    git(root, "add", "."); git(root, "commit", "-qm", "init");
    await writeFile(join(root, "a.txt"), "new value\n");
    return run(i, root);
  }, installVersions);
}
interface Ran { code: number; json: Record<string, unknown>; stdoutChecks: string[] }
/** Runs the CLI; at the moment anything is printed, the run must already be persisted and finished. */
async function review(root: string, reg: ProviderRegistry, argv: string[] = []): Promise<Ran> {
  let stdout = "";
  const stdoutChecks: string[] = [];
  const code = await runCli(["--json", "review", ...argv], { stdout: text => {
    const runs = join(root, ".fusion", "runs");
    for (const id of readdirSync(runs)) {
      const manifest = JSON.parse(readFileSync(join(runs, id, "run.json"), "utf8")) as { status: string };
      stdoutChecks.push(`${manifest.status}:${readFileSync(join(runs, id, "events.jsonl"), "utf8").split("\n").filter(Boolean).length}`);
    }
    stdout += text;
  }, stderr: () => undefined }, { env: { ...process.env }, cwd: root, registry: reg });
  return { code, json: JSON.parse(stdout) as Record<string, unknown>, stdoutChecks };
}
const events = async (root: string, runId: string) => (await readFile(join(root, ".fusion", "runs", runId, "events.jsonl"), "utf8"))
  .split("\n").filter(Boolean).map(line => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
const outcome = (ran: Ran) => ran.json.outcome as { state: string; code: string; exitCode: number };
/** The Reviewer is the exec provider, which emits the strict wire form. */
const reviewerSays = (output: unknown, scenario = "ok"): Env => ({ FUSION_FAKE_SCENARIO: scenario, FUSION_FAKE_OUTPUT: JSON.stringify(wireOf(output)) });
const leadSays = (output: unknown, scenario = "ok"): Env => ({ FUSION_FAKE_SCENARIO: scenario, FUSION_FAKE_OUTPUT: JSON.stringify(output) });

test("O5.5A fusion review runs real read-only providers: no Worker, no lease, primary unchanged, persisted before shown",
  { skip }, async () => withRepo(async (i, root) => {
    const spy: Spy = { creates: [], leadSessions: 0 };
    const reg = registry(i, {
      reviewer: reviewerSays(report(finding("F1", "LOW"))),
      lead: leadSays({ adjudications: [{ findingId: "r1-F1", verdict: "CONFIRMED", rationale: "The diff drops it.", requiredAction: "followUp" }],
        summary: "One minor issue." }) }, spy);
    const before = await userState(root);
    const ran = await review(root, reg);
    assert.deepEqual([ran.code, outcome(ran).state], [0, "ANSWERED"], JSON.stringify(ran.json));
    // 14: only the review roles were built; the configured Worker never was.
    assert.deepEqual([...spy.creates].sort(), ["Lead", "Reviewer"]);
    assert.equal(spy.leadSessions, 1);
    // 15-16: no writer lease, worktree or ref; the primary workspace is byte-for-byte unchanged.
    assert.equal(await userState(root), before);
    assert.equal(git(root, "worktree", "list", "--porcelain").split("\n").filter(line => line.startsWith("worktree ")).length, 1);
    // 18: everything was persisted and finished before the first byte was printed.
    const runId = ran.json.runId as string;
    const recorded = await events(root, runId);
    assert.deepEqual(ran.stdoutChecks, [`completed:${recorded.length}`]);
    // Provenance: requested and observed identity of both turns, recorded before their output was used.
    const turns = recorded.filter(e => e.type === "StructuredTurnObserved").map(e => e.payload);
    assert.deepEqual(turns.map(t => [t.kind, t.role, t.provider, t.transport, t.requestedModel, t.observedModel]), [
      ["review", "Reviewer", "meta", "muse-exec", "muse-spark-1.3", "muse-spark-1.3"],
      ["adjudication", "Lead", "claude", "claude-one-shot", "alias", "claude-canonical-fixture"]]);
    const types = recorded.map(e => e.type);
    assert.ok(types.indexOf("StructuredTurnObserved") < types.indexOf("FindingRecorded"));
    assert.ok(types.lastIndexOf("StructuredTurnObserved") < types.indexOf("AdjudicationRecorded"));
    const reviews = ran.json.reviews as Array<{ adjudications: Array<{ verdict: string; verdictSource: string }> }>;
    assert.deepEqual(reviews[0]!.adjudications.map(a => [a.verdict, a.verdictSource]), [["CONFIRMED", "lead"]]);
    // `fusion show` reads the persisted run.
    let shown = "";
    assert.equal(await runCli(["--json", "show", runId], { stdout: text => { shown += text; }, stderr: () => undefined },
      { env: { ...process.env }, cwd: root, registry: reg }), 0);
    assert.equal((JSON.parse(shown) as { run: { runId: string } }).run.runId, runId);
  }));

test("O5.5A --no-verify never manufactures a verified COMPLETED state", { skip }, async () => withRepo(async (i, root) => {
  const spy: Spy = { creates: [], leadSessions: 0 };
  const reg = registry(i, { reviewer: reviewerSays(report()), verification: true }, spy);
  const verified = await review(root, reg);
  assert.deepEqual([verified.code, outcome(verified).state], [0, "COMPLETED"], "a passing Fusion verification and a clean review");
  const unverified = await review(root, reg, ["--no-verify"]);
  assert.deepEqual([unverified.code, outcome(unverified).state], [0, "ANSWERED"]);
  assert.equal(spy.leadSessions, 0, "no finding, so no adjudication was needed");
}));

test("O5.5A a blocked Reviewer never invokes the Lead", { skip }, async () => withRepo(async (i, root) => {
  const spy: Spy = { creates: [], leadSessions: 0 };
  const reg = registry(i, { reviewer: { ...reviewerSays(report(finding("F1", "HIGH"))), META_API_KEY: "mk-test" } }, spy);
  const before = await userState(root);
  const ran = await review(root, reg);
  assert.deepEqual([ran.code, outcome(ran).state, outcome(ran).code], [3, "BLOCKED", "BillingBlocked"]);
  assert.equal(spy.leadSessions, 0);
  const recorded = await events(root, ran.json.runId as string);
  assert.equal(recorded.some(e => e.type === "StructuredTurnObserved" || e.type === "FindingRecorded"), false);
  assert.equal(await userState(root), before);
  assert.doesNotMatch(JSON.stringify(ran.json), /mk-test/u);
}));

test("O5.5A a Reviewer that succeeds with an unavailable Lead stays blocked, never answered", { skip }, async () => withRepo(async (i, root) => {
  const spy: Spy = { creates: [], leadSessions: 0 };
  const ran = await review(root, registry(i, { reviewer: reviewerSays(report(finding("F1", "HIGH"))),
    lead: { FUSION_FAKE_SCENARIO: "auth-logged-out" } }, spy));
  assert.deepEqual([ran.code, outcome(ran).state, outcome(ran).code], [3, "BLOCKED", "AuthMismatch"]);
  const recorded = await events(root, ran.json.runId as string);
  assert.equal(recorded.filter(e => e.type === "FindingRecorded").length, 1, "the Reviewer's findings are kept");
  assert.equal(recorded.some(e => e.type === "AdjudicationRecorded"), false);
  // With nothing to adjudicate the Lead is not needed, so its unavailability does not matter.
  const clean = await review(root, registry(i, { reviewer: reviewerSays(report()), lead: { FUSION_FAKE_SCENARIO: "auth-logged-out" } },
    { creates: [], leadSessions: 0 }));
  assert.deepEqual([clean.code, outcome(clean).state], [0, "ANSWERED"]);
}));

test("O5.5A an unroutable Lead blocks the review before any provider turn", { skip }, async () => withRepo(async (i, root) => {
  const spy: Spy = { creates: [], leadSessions: 0 };
  const ran = await review(root, registry(i, { reviewer: reviewerSays(report()) }, spy));
  assert.deepEqual([outcome(ran).state, outcome(ran).code], ["BLOCKED", "CapabilityUnavailable"]);
  assert.equal(spy.leadSessions, 0);
  const recorded = await events(root, ran.json.runId as string);
  assert.equal(recorded.some(e => e.type === "StructuredTurnObserved"), false, "the Reviewer never ran either");
}, { claude: "2.2.0" }));

/** An engine over stub adapters that report `snapshot`; any session, lease or verification attempt is counted as a failure. */
function reviewEngine(snapshot: CapabilitySnapshot, turn?: () => unknown):
  { engine: WorkflowEngine; sessions: () => number; recorded: WorkflowEvent[] } {
  let sessions = 0;
  const adapter: ProviderAdapter = { ...stub(snapshot), createSession: async request => {
    sessions++;
    if (turn === undefined) throw new Error("no session may start");
    return { id: `s-${sessions}`, runId: request.runId, role: request.role, provider: snapshot.provider, transport: snapshot.transport,
      workspaceLeaseId: request.workspaceLeaseId, posture: request.posture, providerSessionRef: "opaque" };
  }, ...(turn ? { runStructuredTurn: async () => turn() as StructuredTurnResult } : {}) };
  const roles: RoleCandidate[] = (["Reviewer", "Lead"] as const).map(role => ({ adapter,
    binding: { role, provider: snapshot.provider, transport: snapshot.transport, model: { id: "m", effort: "e" }, requires: {} } }));
  const recorded: WorkflowEvent[] = [];
  const engine = new WorkflowEngine({ roles, events: { append: async event => { recorded.push(event); } },
    verifier: { verify: async () => { throw new Error("no verification may run"); } },
    workspace: { primaryRoot: resolve(tmpdir()), leaseRoot: resolve(tmpdir(), "leases"),
      acquire: async () => { throw new Error("no lease"); }, changedPaths: async () => [], fingerprint: async () => "same",
      diff: async () => ({ text: "", truncated: false }) } });
  return { engine, sessions: () => sessions, recorded };
}
const repositoryReview = (indicators: Readonly<Record<string, boolean>> = {}) => ({ runId: "run-review", verification: { commands: [] },
  task: { operation: "review" as const, summary: "Review the change.", paths: ["a.txt"], scopeKnown: true, expectedMutation: "none" as const,
    requestedCapabilities: {}, verification: { required: false, planProvided: false }, indicators },
  packet: { task: { goal: "Review the change.", constraints: [], acceptanceCriteria: [] },
    scope: { relevantFiles: ["a.txt"], allowedFiles: [], forbiddenFiles: [] }, architecture: { decisions: [], invariants: [] },
    verification: { requiredTests: [] }, openQuestions: [] },
  change: { changedPaths: ["a.txt"], text: "diff", truncated: false } });
const opaque = (): CapabilitySnapshot =>
  ({ ...museCapability({ provider: "opaque" } as MuseLaunchConfig, "muse-exec", VERIFIED_EXEC_WEB_DISABLE_VERSION), structuredOutput: true });

test("O5.5A O5-L1: a critical-risk repository review stops at the human gate before any provider turn", async () => {
  const { engine, sessions, recorded } = reviewEngine(opaque());
  const result = await engine.review(repositoryReview({ irreversible: true }));
  assert.deepEqual([result.state, result.pendingStage, result.risk?.level], ["humanGateRequired", "humanGate", "critical"]);
  assert.equal(sessions(), 0);
  assert.equal(recorded.some(event => event.type === "structuredTurn" || event.type === "review"), false);
});

test("O5.5A a completed structured turn must name the model that served it", async () => {
  for (const effectiveModel of [undefined, "", 42, `model${String.fromCharCode(10)}`, `model${String.fromCharCode(27)}[31m`]) {
    const { engine } = reviewEngine(opaque(), () => ({ status: "completed", output: report(), effectiveProvider: "opaque",
      ...(effectiveModel === undefined ? {} : { effectiveModel }), artifactRefs: [] }));
    const result = await engine.review(repositoryReview());
    assert.deepEqual([result.state, result.error?.kind], ["failed", "MalformedOutput"], String(effectiveModel));
  }
  const { engine, recorded } = reviewEngine(opaque(), () => ({ status: "completed", output: report(), effectiveProvider: "opaque",
    effectiveModel: "served-model", artifactRefs: [] }));
  const result = await engine.review(repositoryReview());
  assert.equal(result.state, "answered");
  const turn = recorded.find(event => event.type === "structuredTurn");
  assert.deepEqual(turn?.type === "structuredTurn" ? [turn.provenance.requestedModel, turn.provenance.observedModel] : [], ["m", "served-model"]);
});

test("O5.5A the engine routes review roles only with review isolation proven", async () => {
  for (const key of Object.keys(REVIEW_ISOLATION)) {
    const { engine, sessions } = reviewEngine({ ...opaque(), [key]: "unknown" } as CapabilitySnapshot);
    const result = await engine.review(repositoryReview());
    assert.deepEqual([result.state, result.error?.kind], ["failed", "CapabilityUnavailable"], key);
    assert.equal(sessions(), 0, key);
  }
});

test("O5.5A no provider name reaches app, CLI or core branching", async () => {
  const forbidden = /claude|muse|anthropic|\bmeta\b|opus|spark|\bgpt|gemini|openai|llama/iu;
  for (const dir of ["src/app", "src/cli", "src/core"])
    for (const entry of await readdir(join(process.cwd(), dir), { recursive: true, withFileTypes: true }))
      if (entry.isFile() && entry.name.endsWith(".ts"))
        assert.doesNotMatch(await readFile(join(entry.parentPath, entry.name), "utf8"), forbidden, join(entry.parentPath, entry.name));
});

// ---------------------------------------------------------------------------------------------------------------
// O5.5A follow-up: the Claude subscription OAuth lane (`CLAUDE_CODE_OAUTH_TOKEN`, from `claude setup-token`).
// Stage 1 classifies the token before spawn; stage 2 reads the credential source back before any turn is trusted.

const TOKEN = "fusion-oauth-canary-7d1e9c4b";
const validReview = JSON.stringify(report());
const withToken = (env: Env = {}): Env => ({ ...reviewOut(validReview), CLAUDE_CODE_OAUTH_TOKEN: TOKEN, ...env });

test("O5.5A OAuth: a token alone is a subscription OAuth candidate; the provider starts and reads the lane back", async () =>
  withInstalls(async i => {
    const guarded = new BillingGuard(claudeEnvironmentRules()).buildChildEnvironment({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    assert.deepEqual(guarded.ok ? guarded.child.authLaneIntent : "blocked", "subscriptionToken");
    const supervisor = new CountingSupervisor();
    const transport = claudeTransport(i, withToken(), {}, supervisor);
    const turn = await claudeStructured(transport);
    assert.equal(turn.status, "completed");
    assert.ok(supervisor.starts > 0, "the provider started");
    assert.deepEqual([transport.runtimeEvidence?.auth.state, transport.runtimeEvidence?.auth.lane], ["authenticated", "subscriptionToken"]);
    assert.deepEqual(await claudeTransport(i, withToken()).authStatus().then(a => [a.state, a.lane]), ["authenticated", "subscriptionToken"]);
    // Opting out keeps working: `strip` omits the token and requires the interactive subscription login instead.
    const stripped = claudeTransport(i, withToken(), { oauthTokenPolicy: "strip" });
    assert.equal((await claudeStructured(stripped)).status, "completed");
    assert.equal(stripped.runtimeEvidence?.auth.lane, "subscription");
    assert.deepEqual(failure(await claudeStructured(claudeTransport(i, withToken(), { oauthTokenPolicy: "block" }))),
      ["failed", "BillingBlocked"]);
  }));

test("O5.5A OAuth: a token never coexists with an API-billed or alternate-provider source; zero process starts", async () =>
  withInstalls(async i => {
    for (const conflict of [{ ANTHROPIC_API_KEY: "sk-conflict" }, { ANTHROPIC_BASE_URL: "https://proxy.invalid" },
      { ANTHROPIC_AUTH_TOKEN: "gateway-conflict" }, { CLAUDE_CODE_USE_BEDROCK: "1" }, { CLAUDE_CODE_USE_VERTEX: "1" },
      { CLAUDE_CODE_USE_FOUNDRY: "1" }]) {
      const supervisor = new CountingSupervisor();
      const transport = claudeTransport(i, withToken(conflict), {}, supervisor);
      const turn = await claudeStructured(transport);
      const name = Object.keys(conflict)[0]!;
      assert.deepEqual(failure(turn), ["failed", "BillingBlocked"], name);
      assert.equal(supervisor.starts, 0, `${name}: no Claude process`);
      assert.doesNotMatch(JSON.stringify(turn), new RegExp(`${TOKEN}|sk-conflict|proxy\\.invalid|gateway-conflict`, "u"));
      await assert.rejects(transport.authStatus(), (error: unknown) => error instanceof FusionFailure && error.error.kind === "BillingBlocked");
      assert.equal(supervisor.starts, 0);
    }
    // The API-key guard itself is unchanged: with or without a token it blocks with the same reason.
    for (const env of [{ ANTHROPIC_API_KEY: "k" }, { ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: TOKEN }]) {
      const result = new BillingGuard(claudeEnvironmentRules()).buildChildEnvironment(env);
      assert.equal(result.ok, false);
      assert.deepEqual(result.decisions.filter(d => d.action === "BLOCK").map(d => [d.key, d.reason]), [["ANTHROPIC_API_KEY", "API_KEY_OVERRIDE"]]);
    }
  }));

test("O5.5A OAuth: the observed credential source decides; the variable name alone never completes a turn", async () =>
  withInstalls(async i => {
    for (const scenario of ["ok", "token-no-key-source"])
      assert.equal((await claudeStructured(claudeTransport(i, withToken({ FUSION_FAKE_SCENARIO: scenario })))).status, "completed", scenario);
    // An API-key or third-party lane, a missing or conflicting login method, or a missing session credential source.
    for (const scenario of ["auth-api-key", "init-api-key", "auth-third-party", "auth-no-method", "auth-login-method",
      "init-no-key-source", "auth-no-login-evidence", "auth-logged-out"]) {
      const turn = await claudeStructured(claudeTransport(i, withToken({ FUSION_FAKE_SCENARIO: scenario })));
      assert.deepEqual(failure(turn), ["failed", "AuthMismatch"], scenario);
      assert.equal("output" in turn, false, scenario);
    }
  }));

/** A registry over the real factories with bindings pointing at the local installs; nothing here starts a model. */
const realRegistry = (i: Installs): ProviderRegistry => ({ factories: defaultRegistry().factories, defaults: { schemaVersion: 1,
  bindings: (["Lead", "Reviewer"] as const).map(role => ({ role, adapter: "claude-one-shot", model: "alias", effort: "low", maxTurns: 3,
    options: { executable: i.claudeExe, canonicalModel: "claude-canonical-fixture" } })),
  verification: { commands: [] }, limits: { runTimeoutMs: 60_000 } } });
const hostEnv = (extra: Env = {}): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, PATHEXT: process.env.PATHEXT,
  SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, USERPROFILE: EMPTY_HOME, ...extra });
async function cliRun(argv: string[], cwd: string, reg: ProviderRegistry, env: NodeJS.ProcessEnv) {
  let stdout = "", stderr = "";
  const code = await runCli(argv, { stdout: t => { stdout += t; }, stderr: t => { stderr += t; } }, { env, cwd, registry: reg });
  return { code, stdout, stderr };
}
async function runFiles(root: string): Promise<string> {
  const runs = join(root, ".fusion", "runs");
  let text = "";
  for (const entry of await readdir(runs, { recursive: true, withFileTypes: true }))
    if (entry.isFile()) text += await readFile(join(entry.parentPath, entry.name), "utf8");
  return text;
}

test("O5.5A OAuth: doctor keeps the static candidate lane apart from observed authentication", { skip }, async () =>
  withRepo(async (i, root) => {
    const reg = realRegistry(i);
    const text = await cliRun(["doctor"], root, reg, hostEnv({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN }));
    assert.equal(text.code, 0);
    assert.match(text.stdout, /billing guard clear \(candidate lane: subscription OAuth token; unverified until probed\)/u);
    assert.match(text.stdout, /readiness: REVIEW_READY, WRITER_NOT_READY/u);
    assert.doesNotMatch(text.stdout, /authenticated/u, "a static doctor never claims authentication");
    const json = JSON.parse((await cliRun(["--json", "doctor"], root, reg, hostEnv({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN }))).stdout) as {
      providers: Array<{ inspection: { billing: { state: string; candidateLane?: string } } }>; writer: { ready: boolean }; probed: boolean };
    assert.deepEqual(json.providers.map(p => [p.inspection.billing.state, p.inspection.billing.candidateLane]),
      [["clear", "subscriptionToken"], ["clear", "subscriptionToken"]]);
    assert.deepEqual([json.writer.ready, json.probed], [false, false]);
    const plain = JSON.parse((await cliRun(["--json", "doctor"], root, reg, hostEnv())).stdout) as typeof json;
    assert.equal(plain.providers[0]!.inspection.billing.candidateLane, "subscription");
    // A conflicting source is refused statically too, with the token recognized but never printed.
    const conflict = await cliRun(["--json", "doctor"], root, reg, hostEnv({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN, ANTHROPIC_API_KEY: "sk-conflict" }));
    const refused = JSON.parse(conflict.stdout) as { readiness: { overall: string }; providers: Array<{ inspection: { billing: { state: string } } }> };
    assert.deepEqual([refused.providers[0]!.inspection.billing.state, refused.readiness.overall], ["blocked", "DEGRADED"]);
    for (const out of [text, conflict]) assert.doesNotMatch(out.stdout + out.stderr, new RegExp(`${TOKEN}|sk-conflict`, "u"));
  }));

test("O5.5A OAuth: a failed auth probe is reported truthfully and blocks the binding; nothing claims authentication", { skip }, async () =>
  withRepo(async (i, root) => {
    // The installed claude.exe here is an empty file, so the auth readback of the probe cannot start.
    const ran = await cliRun(["--json", "doctor", "--probe"], root, realRegistry(i), hostEnv({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN }));
    const report = JSON.parse(ran.stdout) as { readiness: { overall: string; classes: string[] }; roles: Record<string, { review: string }>;
      providers: Array<{ probe: { auth: { state: string; lane: string; detail: string } }; eligibility: { review: { state: string; reasons: string[] } } }> };
    assert.deepEqual([ran.code, report.readiness.overall], [15, "DEGRADED"]);
    assert.ok(report.readiness.classes.includes("WRITER_NOT_READY"));
    for (const provider of report.providers) {
      assert.deepEqual([provider.probe.auth.state, provider.probe.auth.lane], ["failed", "unknown"]);
      assert.equal(provider.eligibility.review.state, "blocked");
      assert.ok(provider.eligibility.review.reasons.some(reason => reason.startsWith("auth probe:")), JSON.stringify(provider.eligibility));
    }
    assert.deepEqual([report.roles.Lead!.review, report.roles.Reviewer!.review], ["blocked", "blocked"]);
    assert.doesNotMatch(ran.stdout + ran.stderr, new RegExp(`${TOKEN}|"authenticated"`, "u"));
    const text = await cliRun(["doctor", "--probe"], root, realRegistry(i), hostEnv({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN }));
    assert.match(text.stdout, /probe: auth failed \(unknown\) — Claude auth probe could not start\./u);
  }));

test("O5.5A OAuth: a probe can only lower eligibility, never raise it", () => {
  const snapshot = claudeCapability(CLAUDE_VERSION, "launchFlag");
  const withLane = (lane: "subscription" | "subscriptionToken" | undefined): BindingInspection => ({ ...inspection(snapshot),
    billing: { state: "clear", reasons: [], ...(lane ? { candidateLane: lane } : {}) } });
  const state = (lane: "subscription" | "subscriptionToken" | undefined, probe?: Parameters<typeof bindingEligibility>[3]) =>
    bindingEligibility(binding("Lead"), withLane(lane), undefined, probe).review.state;
  const auth = (outcome: "authenticated" | "failed" | "unauthenticated", lane: string) => ({ auth: { state: outcome, lane, detail: "d" } });
  assert.equal(state("subscriptionToken"), "eligible");
  assert.equal(state("subscriptionToken", auth("authenticated", "subscriptionToken")), "eligible");
  assert.equal(state("subscriptionToken", auth("failed", "unknown")), "blocked");
  assert.equal(state("subscriptionToken", auth("unauthenticated", "unknown")), "blocked");
  assert.equal(state("subscriptionToken", { error: "probe failed" }), "blocked");
  assert.equal(state("subscriptionToken", auth("authenticated", "api")), "blocked", "an API lane is never accepted");
  for (const lane of ["api", "thirdParty", "unknown"])
    assert.equal(state(undefined, auth("authenticated", lane)), "blocked", `${lane} without a candidate lane`);
  assert.equal(state(undefined, auth("authenticated", "subscription")), "eligible");
  assert.equal(state("subscriptionToken", auth("authenticated", "subscription")), "blocked", "a lane other than the candidate conflicts");
  const unknown = inspection({ ...snapshot, extensionsQuarantined: "unknown" });
  assert.equal(bindingEligibility(binding("Lead"), unknown, undefined, auth("authenticated", "subscription")).review.state, "unknown");
  assert.equal(readinessVerdict(false, { Lead: { readOnly: "blocked", review: "blocked" }, Reviewer: { readOnly: "eligible", review: "eligible" } }).overall,
    "DEGRADED");
});

test("O5.5A OAuth: a real review over the token lane never leaks the token; a conflicting source blocks the Lead", { skip }, async () =>
  withRepo(async (i, root) => {
    const adjudicated = { adjudications: [{ findingId: "r1-F1", verdict: "CONFIRMED", rationale: "Checked.", requiredAction: "followUp" }], summary: "" };
    const spy: Spy = { creates: [], leadSessions: 0 };
    const ran = await review(root, registry(i, { reviewer: reviewerSays(report(finding("F1", "LOW"))),
      lead: { ...leadSays(adjudicated), CLAUDE_CODE_OAUTH_TOKEN: TOKEN } }, spy));
    assert.deepEqual([ran.code, outcome(ran).state], [0, "ANSWERED"], JSON.stringify(ran.json));
    assert.equal(spy.leadSessions, 1);
    const blocked = await review(root, registry(i, { reviewer: reviewerSays(report(finding("F1", "LOW"))),
      lead: { ...leadSays(adjudicated), CLAUDE_CODE_OAUTH_TOKEN: TOKEN, ANTHROPIC_API_KEY: "sk-conflict" } }, spy));
    assert.deepEqual([blocked.code, outcome(blocked).state, outcome(blocked).code], [3, "BLOCKED", "BillingBlocked"]);
    const everything = JSON.stringify(ran.json) + JSON.stringify(blocked.json) + await runFiles(root);
    assert.doesNotMatch(everything, new RegExp(`${TOKEN}|sk-conflict`, "u"), "no output, event or artifact carries a credential");
  }));

test("O5.5A OAuth: Writer stays blocked and credential policy stays out of app, CLI and core", async () => withInstalls(async i => {
  assert.equal(writerReadiness().ready, false);
  const claude = defaultRegistry().factories.get("claude-one-shot")!;
  await assert.rejects(claude.create({ role: "Worker", adapter: "claude-one-shot", model: "alias", effort: "low", maxTurns: 3,
    options: { executable: i.claudeExe, canonicalModel: "claude-canonical-fixture" } },
  { workspace: i.dir, env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN } }), /REAL_WRITER_MODE_NOT_READY/u);
  await assert.rejects(claude.create({ role: "Lead", adapter: "claude-one-shot", model: "alias", effort: "low",
    options: { canonicalModel: "c", oauthTokenPolicy: "allowAnything" } }, { workspace: i.dir, env: {} }), /oauthTokenPolicy/u);
  const forbidden = /CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_|setup-token|oauthTokenPolicy/u;
  for (const dir of ["src/app", "src/cli", "src/core"])
    for (const entry of await readdir(join(process.cwd(), dir), { recursive: true, withFileTypes: true }))
      if (entry.isFile() && entry.name.endsWith(".ts"))
        assert.doesNotMatch(await readFile(join(entry.parentPath, entry.name), "utf8"), forbidden, join(entry.parentPath, entry.name));
}));

test("O5.5A O55A-L1: the fixtures reject duplicated security controls and widening flags", async () => withInstalls(async i => {
  const claude = (extra: string[]) => spawnSync(process.execPath, [CLAUDE_FIXTURE, "-p", ...claudeReadOnlyArgs("alias", "low", 1), ...extra],
    { input: JSON.stringify(GOAL), encoding: "utf8", timeout: 20_000, windowsHide: true,
      env: { SystemRoot: process.env.SystemRoot, FUSION_FAKE_SCENARIO: "ok", ...CLAUDE_CHILD_SWITCHES } }).status;
  assert.equal(claude([]), 0);
  for (const extra of [["--tools", "Read"], ["--safe-mode"], ["--permission-mode", "dontAsk"], ["--include-hook-events"]])
    assert.equal(claude(extra), 38, extra.join(" "));
  for (const extra of [["--mcp-config", "servers.json"], ["--dangerously-skip-permissions"], ["--add-dir=C:\\"], ["--allowedTools", "Bash"],
    ["--append-system-prompt", "x"]])
    assert.equal(claude(extra), 39, extra.join(" "));
  const promptFile = join(i.dir, "prompt.txt");
  await writeFile(promptFile, "review");
  const museArgs = ["exec", "--json", "--prompt-file", promptFile, "--provider", "meta", "--model", "muse-spark-1.3", "--reasoning-effort", "low",
    "--workspace", i.dir, ...EXEC_CONTROL_FLAGS, "--max-model-steps", "4"];
  const muse = (args: readonly string[]) => spawnSync(process.execPath, [MUSE_FIXTURE, ...args],
    { encoding: "utf8", timeout: 20_000, windowsHide: true, env: { SystemRoot: process.env.SystemRoot, FUSION_FAKE_SCENARIO: "ok" } }).status;
  assert.equal(muse(museArgs), 0);
  for (const extra of [["--disable-write"], ["--no-foreign-personal-context"], ["--approval-mode", "on-request"]])
    assert.equal(muse([...museArgs, ...extra]), 10, extra.join(" "));
  for (const extra of [["--yolo"], ["--sandbox-network", "enabled"], ["--enable-shell-tool"], ["--base-url=https://x.invalid"]])
    assert.equal(muse([...museArgs, ...extra]), 11, extra.join(" "));
  assert.equal(muse(museArgs.map(arg => arg === "never" ? "on-request" : arg)), 4, "approval mode must be never");
}));

// ---------------------------------------------------------------------------------------------------------------
// O5.5A follow-up: the exec provider's strict structured decoding. The canonical contract stays provider-neutral; the
// exec adapter sends its strict wire form and maps the output back before canonical and O4 validation.

type Schema = Record<string, unknown>;
const props = (schema: unknown): Record<string, Schema> => (schema as Schema).properties as Record<string, Schema>;
const itemOf = (schema: unknown): Schema => (schema as Schema).items as Schema;
const nullable = (schema: unknown): Schema | undefined => {
  const branches = (schema as Schema).anyOf as Schema[] | undefined;
  return branches && branches.length === 2 && JSON.stringify(branches[1]) === JSON.stringify({ type: "null" }) ? branches[0] : undefined;
};
/** Every object node of a schema, anyOf branches and array items included. */
function objectNodes(schema: unknown, found: Schema[] = []): Schema[] {
  const s = schema as Schema;
  if (Array.isArray(s.anyOf)) for (const branch of s.anyOf) objectNodes(branch, found);
  if (s.type === "object") { found.push(s); for (const child of Object.values(props(s))) objectNodes(child, found); }
  if (s.type === "array") objectNodes(s.items, found);
  return found;
}
const invalidSchema = (fn: () => unknown, name: string): void => assert.throws(fn, (error: unknown) =>
  error instanceof FusionFailure && error.error.kind === "InvalidInput", name);
const WIRE = toMuseStrictSchema(reviewReportSchema());

test("O5.5A Muse wire: the canonical contract is unchanged, provider-neutral and what Claude is prompted with", async () => {
  const canonical = reviewReportSchema();
  const findingItem = itemOf(props(canonical).findings);
  assert.deepEqual(findingItem.required, ["id", "severity", "confidence", "category", "title", "evidence", "failureScenario"]);
  for (const optional of ["file", "lines", "suggestedFix", "facts"]) {
    assert.ok(Object.hasOwn(props(findingItem), optional), optional);
    assert.equal((findingItem.required as string[]).includes(optional), false, `${optional} stays optional`);
  }
  assert.deepEqual(itemOf(props(findingItem).facts).required, ["kind"]);
  for (const schema of [canonical, adjudicationReportSchema(["r1-a"])])
    assert.doesNotMatch(JSON.stringify(schema), /anyOf|"null"/u, "the canonical contract never encodes omission as null");
  // Claude (and any provider without a wire form) is prompted with exactly the canonical schema.
  const claudePrompt = structuredTurnPrompt(reviewRequest);
  assert.ok(claudePrompt.includes(JSON.stringify(structuredTurnSchema(reviewRequest))));
  assert.doesNotMatch(claudePrompt, /anyOf/u);
  assert.equal(claudePrompt, structuredTurnPrompt(reviewRequest, undefined));
  // A supplied decoding schema replaces the canonical one in the prompt, with its note; nothing else changes.
  const musePrompt = structuredTurnPrompt(reviewRequest, { schema: WIRE, note: "NOTE-MARKER" });
  assert.ok(musePrompt.includes(JSON.stringify(WIRE)) && musePrompt.includes("NOTE-MARKER"));
  assert.equal(musePrompt.includes(JSON.stringify(structuredTurnSchema(reviewRequest))), false);
  assert.equal(musePrompt.replace(`${JSON.stringify(WIRE)}\nNOTE-MARKER`, JSON.stringify(structuredTurnSchema(reviewRequest))), claudePrompt);
  // No wire encoding reaches the provider-neutral core.
  for (const entry of await readdir(join(process.cwd(), "src", "core"), { recursive: true, withFileTypes: true }))
    if (entry.isFile() && entry.name.endsWith(".ts"))
      assert.doesNotMatch(await readFile(join(entry.parentPath, entry.name), "utf8"), /anyOf|toMuseStrictSchema|normalizeWireValue/u, entry.name);
});

test("O5.5A Muse wire: every object lists every property as required; only canonically optional ones become nullable", () => {
  const canonical = reviewReportSchema(), before = JSON.stringify(canonical);
  const wire = toMuseStrictSchema(canonical);
  assert.equal(JSON.stringify(canonical), before, "the canonical schema is not modified");
  const nodes = objectNodes(wire);
  assert.equal(nodes.length, 4, "report, finding, lines and fact objects");
  for (const node of nodes) {
    assert.deepEqual([...(node.required as string[])].sort(), Object.keys(props(node)).sort());
    assert.equal(node.additionalProperties, false);
  }
  const canonicalItem = itemOf(props(canonical).findings), wireItem = itemOf(props(wire).findings);
  for (const key of ["file", "lines", "suggestedFix", "facts"]) {
    const inner = nullable(props(wireItem)[key]);
    assert.ok(inner, `${key} is nullable on the wire`);
    assert.deepEqual(inner, key === "file" || key === "suggestedFix" ? props(canonicalItem)[key] : toMuseStrictSchema(props(canonicalItem)[key]));
  }
  for (const key of ["id", "severity", "confidence", "category", "title", "evidence", "failureScenario"]) {
    assert.equal(props(wireItem)[key]!.anyOf, undefined, `${key} stays non-null`);
    assert.deepEqual(props(wireItem)[key], key === "evidence" ? toMuseStrictSchema(props(canonicalItem)[key]) : props(canonicalItem)[key]);
  }
  const fact = itemOf(nullable(props(wireItem).facts));
  assert.equal(props(fact).kind!.anyOf, undefined);
  for (const key of ["commandId", "path", "test"]) assert.deepEqual(nullable(props(fact)[key]), props(itemOf(props(canonicalItem).facts))[key], key);
  const lines = nullable(props(wireItem).lines)!;
  assert.deepEqual(lines.required, ["start", "end"]);
  for (const key of ["start", "end"]) assert.deepEqual(props(lines)[key], { type: "integer", minimum: 1, maximum: REVIEW_LIMITS.maxLine });
  assert.deepEqual([props(wire).summary, (props(wire).findings as Schema).maxItems], [props(canonical).summary, (props(canonical).findings as Schema).maxItems]);
  assertSupportedSchema(wire);
});

test("O5.5A Muse wire: null sentinels normalize back to the canonical shape, which every validator accepts", () => {
  const canonical = reviewReportSchema();
  const wireValue = { summary: "", findings: [
    { id: "F1", severity: "HIGH", confidence: "HIGH", category: "correctness", file: null, lines: null, title: "No location",
      evidence: ["e"], failureScenario: "s", suggestedFix: null, facts: [{ kind: "outOfScopeChange", commandId: null, path: "b.txt", test: null }] },
    { id: "F2", severity: "LOW", confidence: "LOW", category: "style", file: "a.txt", lines: { start: 2, end: 3 }, title: "Located",
      evidence: ["e"], failureScenario: "s", suggestedFix: "Fix it.", facts: null }] };
  const frozen = JSON.stringify(wireValue);
  const deepFreeze = (value: unknown): void => { if (value && typeof value === "object") { Object.freeze(value); Object.values(value).forEach(deepFreeze); } };
  deepFreeze(wireValue);
  const normalized = parseStructured(frozen, canonical, WIRE);
  assert.deepEqual(normalized, { summary: "", findings: [
    { id: "F1", severity: "HIGH", confidence: "HIGH", category: "correctness", title: "No location", evidence: ["e"], failureScenario: "s",
      facts: [{ kind: "outOfScopeChange", path: "b.txt" }] },
    { id: "F2", severity: "LOW", confidence: "LOW", category: "style", file: "a.txt", lines: { start: 2, end: 3 }, title: "Located",
      evidence: ["e"], failureScenario: "s", suggestedFix: "Fix it." }] });
  assert.ok(validateSchema(normalized, canonical));
  assert.equal(validateReviewReport(normalized, provenance).length, 2);
  assert.deepEqual(normalizeWireValue(wireValue, canonical), normalized, "normalization never modifies its input");
  // Only canonically optional properties lose a null; a required one keeps it, so canonical validation rejects it.
  const requiredNull = normalizeWireValue({ summary: null, findings: [{ ...wireValue.findings[0], severity: null, file: null }] }, canonical) as
    { summary: unknown; findings: Array<Record<string, unknown>> };
  assert.equal(requiredNull.summary, null);
  assert.deepEqual([Object.hasOwn(requiredNull.findings[0]!, "severity"), requiredNull.findings[0]!.severity, Object.hasOwn(requiredNull.findings[0]!, "file")],
    [true, null, false]);
  assert.equal(JSON.stringify(wireValue), frozen);
  // The wire form of every fixture report the other tests use round-trips to the canonical value.
  for (const value of [report(), report(finding("F1", "HIGH", { facts: [{ kind: "unrunClaim", test: "unit" }] }), unlocated("f2", "INFO"))])
    assert.deepEqual(parseStructured(JSON.stringify(wireOf(value)), canonical, WIRE), value);
});

test("O5.5A Muse wire: extra properties, bad enums, types and ranges, and nulls where a value is required all fail", () => {
  const canonical = reviewReportSchema();
  const good = wireOf(report(finding("F1", "HIGH", { facts: [{ kind: "unrunClaim", test: "unit" }] }))) as { findings: Array<Record<string, unknown>> };
  const withFinding = (patch: Record<string, unknown>) => JSON.stringify({ ...good, findings: [{ ...good.findings[0], ...patch }] });
  const cases: Array<[string, string]> = [
    ["extra top-level key", JSON.stringify({ ...good, verdict: "pass" })],
    ["prototype-named key", JSON.stringify({ ...good, toString: "x" })],
    ["prototype-named finding key", withFinding({ constructor: 1 })],
    ["extra finding key", withFinding({ score: 1 })],
    ["extra fact key", withFinding({ facts: [{ kind: "unrunClaim", commandId: null, path: null, test: "unit", note: "x" }] })],
    ["extra lines key", withFinding({ lines: { start: 1, end: 1, column: 2 } })],
    ["invalid severity", withFinding({ severity: "CRITICAL" })],
    ["invalid fact kind", withFinding({ facts: [{ kind: "guess", commandId: null, path: null, test: null }] })],
    ["wrong type", withFinding({ title: 7 })],
    ["out of range", withFinding({ lines: { start: 0, end: 1 } })],
    ["null in a required field", withFinding({ severity: null })],
    ["null in nested required field", withFinding({ lines: { start: null, end: 1 } })],
    ["null fact kind", withFinding({ facts: [{ kind: null, commandId: null, path: null, test: null }] })],
    ["null summary", JSON.stringify({ ...good, summary: null })],
    ["null findings", JSON.stringify({ ...good, findings: null })],
    ["null array item", JSON.stringify({ ...good, findings: [null] })],
    ["omitted instead of null", withFinding({ suggestedFix: undefined })],
    ["oversized string", withFinding({ suggestedFix: "x".repeat(REVIEW_LIMITS.maxFixChars + 1) })],
    ["duplicate key", '{"summary":"","summary":"","findings":[]}'],
    ["prose", `Sure: ${JSON.stringify(good)}`],
  ];
  for (const [name, text] of cases)
    assert.throws(() => parseStructured(text, canonical, WIRE), (error: unknown) => error instanceof FusionFailure &&
      error.error.kind === "MalformedOutput", name);
  // The canonical re-check never trusts the wire schema: even a wire schema that admits anything cannot pass bad output.
  for (const loose of [{ type: "object" }, { anyOf: [{ type: "object" }, { type: "null" }] }])
    assert.throws(() => parseStructured(JSON.stringify({ findings: "none", summary: "", extra: 1 }), canonical, loose),
      (error: unknown) => error instanceof FusionFailure && error.error.kind === "MalformedOutput");
});

test("O5.5A Muse wire: malformed anyOf and canonical shapes the transform cannot represent fail closed", () => {
  const nul = { type: "null" }, str = { type: "string" };
  for (const [name, schema] of [
    ["three branches", { anyOf: [str, nul, { type: "integer" }] }], ["two value branches", { anyOf: [str, { type: "integer" }] }],
    ["two null branches", { anyOf: [nul, nul] }], ["one branch", { anyOf: [str] }], ["not an array", { anyOf: str }],
    ["anyOf beside type", { type: "string", anyOf: [str, nul] }], ["nested anyOf", { anyOf: [{ anyOf: [str, nul] }, nul] }],
    ["decorated null branch", { anyOf: [str, { type: "null", description: "x" }] }],
    ["unsupported inner", { anyOf: [{ type: "string", pattern: ".*" }, nul] }],
    ["oneOf", { oneOf: [str, nul] }], ["allOf", { allOf: [str] }], ["$ref", { $ref: "#/x" }],
  ] as Array<[string, unknown]>) {
    invalidSchema(() => assertSupportedSchema(schema), name);
    invalidSchema(() => validateSchema(null, schema), `${name} (validation)`);
  }
  assert.equal(validateSchema(null, { anyOf: [str, nul] }), true);
  assert.equal(validateSchema("x", { anyOf: [nul, str] }), true);
  assert.equal(validateSchema(3, { anyOf: [str, nul] }), false);
  const closed = (extra: Schema = {}): Schema => ({ type: "object", additionalProperties: false, properties: { a: str }, ...extra });
  for (const [name, schema] of [
    ["open object", { type: "object", properties: { a: str } }], ["open object (true)", closed({ additionalProperties: true })],
    ["object without properties", { type: "object", additionalProperties: false }],
    ["required names no property", closed({ required: ["b"] })], ["duplicate required", closed({ required: ["a", "a"] })],
    ["array without items", closed({ properties: { a: { type: "array" } } })], ["canonical null", closed({ properties: { a: nul } })],
    ["canonical anyOf", closed({ properties: { a: { anyOf: [str, nul] } } })], ["untyped node", closed({ properties: { a: { enum: ["x"] } } })],
    ["object keywords on a string", closed({ properties: { a: { type: "string", required: ["x"] } } })],
    ["items on a string", closed({ properties: { a: { type: "string", items: str } } })],
  ] as Array<[string, unknown]>) invalidSchema(() => toMuseStrictSchema(schema), name);
});

test("O5.5A Muse wire: adjudication transforms without widening and parses through the exec transport", async () => withInstalls(async i => {
  const findings = findingsOf(finding("F1", "HIGH"), finding("F2", "LOW"));
  const canonical = adjudicationReportSchema(findings.map(f => f.id));
  assert.deepEqual(toMuseStrictSchema(canonical), canonical, "an all-required closed contract is already strict");
  const valid = { summary: "", adjudications: [{ findingId: "r1-F1", verdict: "CONFIRMED", rationale: "Checked.", requiredAction: "fix" },
    { findingId: "r1-F2", verdict: "REJECTED", rationale: "Not a defect.", requiredAction: "none" }] };
  assert.equal(validateAdjudicationReport(parseStructured(JSON.stringify(valid), canonical, toMuseStrictSchema(canonical)), findings)
    .adjudications.length, 2);
  const turn = await museTransport(i, { FUSION_FAKE_SCENARIO: "ok", FUSION_FAKE_OUTPUT: JSON.stringify(valid),
    FUSION_FAKE_PROMPT_PREFIX: ADJUDICATION_PREFIX }).runStructured({ request: adjudicationRequest(findings),
    requiredCapabilities: REVIEW_REQUIREMENTS });
  assert.equal(turn.status, "completed", JSON.stringify(turn));
  if (turn.status === "completed") assert.equal(validateAdjudicationReport(turn.output, findings).adjudications.length, 2);
  const unknownId = { ...valid, adjudications: [{ ...valid.adjudications[0]!, findingId: "r1-F9" }, valid.adjudications[1]] };
  assert.deepEqual(failure(await museTransport(i, { FUSION_FAKE_SCENARIO: "ok", FUSION_FAKE_OUTPUT: JSON.stringify(unknownId),
    FUSION_FAKE_PROMPT_PREFIX: ADJUDICATION_PREFIX }).runStructured({ request: adjudicationRequest(findings),
    requiredCapabilities: REVIEW_REQUIREMENTS })), ["failed", "MalformedOutput"]);
}));

test("O5.5A Muse wire: the live strict-decoding incompatibility is reproduced and the transform resolves it", async () => withInstalls(async i => {
  const regression = JSON.parse(await readFile(join(process.cwd(), "test", "fixtures", "meta-strict-regression.schema.json"), "utf8")) as Schema;
  const wire = toMuseStrictSchema(regression);
  assert.deepEqual(wire.required, ["id", "facts"], "the canonically optional property is required on the wire");
  assert.deepEqual(nullable(props(wire).facts), props(regression).facts, "and its omission is represented by null");
  assert.equal(wire.additionalProperties, false);
  const exec = async (schema: Schema) => {
    const schemaFile = join(i.dir, `schema-${Date.now()}-${Math.random()}.json`), promptFile = join(i.dir, "prompt.txt");
    await writeFile(schemaFile, JSON.stringify(schema));
    await writeFile(promptFile, "review");
    const ran = spawnSync(process.execPath, [MUSE_FIXTURE, "exec", "--json", "--prompt-file", promptFile, "--provider", "meta",
      "--model", "muse-spark-1.3", "--reasoning-effort", "low", "--workspace", i.dir, ...EXEC_CONTROL_FLAGS, "--max-model-steps", "4",
      "--output-schema", schemaFile], { encoding: "utf8", timeout: 20_000, windowsHide: true,
      env: { SystemRoot: process.env.SystemRoot, FUSION_FAKE_SCENARIO: "ok", FUSION_FAKE_OUTPUT: '{"id":"x","facts":null}' } });
    const terminal = ran.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line) as { payload_type: string; payload: { reason?: string } })
      .find(frame => frame.payload_type.startsWith("run.terminal."));
    return { status: ran.status, terminal: terminal?.payload_type, reason: terminal?.payload.reason };
  };
  assert.deepEqual(await exec(regression), { status: 1, terminal: "run.terminal.failed", reason: "HTTP 400: 'required' is required " +
    "to be supplied and to be an array including every key in properties. Missing 'facts'." });
  assert.deepEqual(await exec(wire), { status: 0, terminal: "run.terminal.completed", reason: undefined });
  // The canonical review schema sent unchanged fails exactly like the live provider; the structured turn sends the wire form.
  const packet = { task: { goal: GOAL, constraints: [], acceptanceCriteria: [] }, scope: { relevantFiles: [], allowedFiles: [], forbiddenFiles: [] },
    architecture: { decisions: [], invariants: [] }, verification: { requiredTests: [] }, openQuestions: [] };
  const raw = await museTransport(i, { FUSION_FAKE_SCENARIO: "ok" }).run({ packet, requiredCapabilities: {}, outputSchema: reviewReportSchema() });
  assert.deepEqual([raw.status, raw.status === "completed" ? undefined : raw.error.kind], ["failed", "ProcessFailure"]);
  assert.equal((await museStructured(museTransport(i, reviewOut(JSON.stringify(wireOf(report(finding("F1", "LOW")))))))).status, "completed");
}));
