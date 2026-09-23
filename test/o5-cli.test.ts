import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import type { AdjudicationRequest, AgentRole, CapabilitySnapshot, DelegationPacket, ProviderAdapter, ResultPacket, ReviewRequest,
  ReviewerFinding, Session, StructuredTurnRequest, StructuredTurnResult, TurnResult } from "../src/core/domain.js";
import type { BindingConfig } from "../src/app/config.js";
import { outcomeOf } from "../src/app/outcome.js";
import type { AdapterFactory, Availability, BindingInspection, ProviderRegistry } from "../src/app/providers.js";
import { REAL_WRITER_MODE_PREREQUISITES, writerReadiness } from "../src/app/writer-gate.js";
import { parseArgs, UsageError } from "../src/cli/args.js";
import { terminalSafe } from "../src/cli/render.js";
import { createInterruptHandler, runCli } from "../src/cli/run.js";
import { DiagnosticRedactor } from "../src/core/policy/redaction.js";
import type { WorkflowResult } from "../src/core/workflow/types.js";

const gitAvailable = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;
const skip = gitAvailable ? false : "git executable unavailable";

// ---------------------------------------------------------------------------------------------------------------
// Fake provider registry: no provider process, network or account access.

type Script<R> = (ctx: { session: Session; request: R; call: number; signal: AbortSignal | undefined }) => unknown;
interface Behavior {
  caps?: Partial<CapabilitySnapshot>;
  executable?: Availability;
  billing?: BindingInspection["billing"];
  structured?: boolean;
  review?: Script<ReviewRequest>;
  adjudication?: Script<AdjudicationRequest>;
  turn?: Script<DelegationPacket>;
}
interface Spy { creates: AgentRole[]; probes: number; sessions: Session[]; requests: StructuredTurnRequest[] }
const snapshot = (provider: string, transport: string, extra: Partial<CapabilitySnapshot> = {}): CapabilitySnapshot => ({
  provider, transport, observedAt: "2026-01-01T00:00:00.000Z", runtimeVersion: "fake-1", persistentSessions: false,
  structuredOutput: true, webToolsDisabled: true, filesystem: { read: true, write: false }, shell: { available: false, sandboxed: false },
  approvalCallback: false, protocolCancellation: true, usageReporting: false, modelIdentityReadback: true,
  subscriptionLaneReadback: true, ...extra });
const ok = (patch: Partial<ResultPacket> = {}): ResultPacket => ({ result: { status: "completed" },
  changes: { files: [], summary: "The helper formats dates." }, verification: { testsRun: [], results: [] }, uncertainties: [], failures: [],
  needsLeadDecision: [], ...patch });
const finding = (id: string, severity: ReviewerFinding["severity"], patch: Partial<ReviewerFinding> = {}): ReviewerFinding => ({
  id, severity, confidence: "HIGH", category: "correctness", file: "a.txt", title: `${severity} problem ${id}`,
  evidence: ["The value is never saved."], failureScenario: "Saving twice loses data.", ...patch });
const envelope = (value: unknown): boolean => value !== null && typeof value === "object" && "status" in value && "effectiveProvider" in value;

class FakeAdapter implements ProviderAdapter {
  constructor(private readonly provider: string, private readonly transport: string, private readonly behavior: Behavior,
    private readonly spy: Spy) {}
  #count = new Map<string, number>();
  private next(key: string): number { const n = (this.#count.get(key) ?? 0) + 1; this.#count.set(key, n); return n; }
  async capabilities() { return snapshot(this.provider, this.transport, this.behavior.caps); }
  async authStatus() { return { state: "authenticated" as const, lane: "subscription" as const, observedAt: "", evidence: [] }; }
  async createSession(request: Parameters<ProviderAdapter["createSession"]>[0]): Promise<Session> {
    const session: Session = { id: `${this.transport}-${this.spy.sessions.length + 1}`, runId: request.runId, role: request.role,
      provider: this.provider, transport: this.transport, workspaceLeaseId: request.workspaceLeaseId, posture: request.posture,
      providerSessionRef: "opaque" };
    this.spy.sessions.push(session);
    return session;
  }
  async resumeSession(session: Session) { return session; }
  async runTurn(session: Session, packet: DelegationPacket, signal?: AbortSignal): Promise<TurnResult> {
    const out = await (this.behavior.turn ?? (() => ok()))({ session, request: packet, call: this.next("turn"), signal });
    return (envelope(out) ? out : { status: "completed", output: out, effectiveProvider: this.provider, effectiveModel: "m", artifactRefs: [] }) as TurnResult;
  }
  async runStructuredTurn(session: Session, request: StructuredTurnRequest, signal?: AbortSignal): Promise<StructuredTurnResult> {
    this.spy.requests.push(request);
    const out = request.kind === "review"
      ? await (this.behavior.review ?? (() => ({ findings: [], summary: "No issues." })))({ session, request, call: this.next("review"), signal })
      : await (this.behavior.adjudication ?? (({ request: r }) => ({ summary: "", adjudications: r.findings.map(f => ({ findingId: f.id,
        verdict: "CONFIRMED", rationale: "Reproduced.", requiredAction: ["BLOCKER", "HIGH", "MEDIUM"].includes(f.severity) ? "fix" : "followUp" })) })))(
        { session, request: request as AdjudicationRequest, call: this.next("adjudication"), signal });
    return (envelope(out) ? out : { status: "completed", output: out, effectiveProvider: this.provider, effectiveModel: "m", artifactRefs: [] }) as StructuredTurnResult;
  }
  async cancel() {}
  async usage() { return null; }
  async close() {}
}

function factory(kind: string, provider: string, behavior: Behavior, spy: Spy): AdapterFactory {
  return {
    kind,
    async inspect(): Promise<BindingInspection> {
      return { provider, transport: kind, executable: behavior.executable ?? "available", runtimeVersion: "fake-1",
        billing: behavior.billing ?? { state: "clear", reasons: [] }, capabilities: snapshot(provider, kind, behavior.caps),
        structuredTurns: behavior.structured ?? true, controls: [{ name: "fakeControl", state: "available", detail: "test double" }], notes: [] };
    },
    async probe() { spy.probes++; return { auth: { state: "authenticated", lane: "subscription", detail: "fake" } }; },
    async create(binding: BindingConfig) {
      spy.creates.push(binding.role);
      const adapter = new FakeAdapter(provider, kind, behavior, spy);
      if (behavior.structured === false) (adapter as { runStructuredTurn?: unknown }).runStructuredTurn = undefined;
      return { adapter, binding: { role: binding.role, provider, transport: kind, model: { id: binding.model, effort: binding.effort }, requires: {} } };
    },
  };
}
interface Setup { lead?: Behavior; review?: Behavior; provider?: string }
function registry(setup: Setup = {}): { registry: ProviderRegistry; spy: Spy } {
  const spy: Spy = { creates: [], probes: 0, sessions: [], requests: [] };
  const provider = setup.provider ?? "opaque-provider";
  return { spy, registry: { defaults: { schemaVersion: 1, bindings: [], verification: { commands: [] }, limits: { runTimeoutMs: 60_000 } },
    factories: new Map([["fake-lead", factory("fake-lead", provider, setup.lead ?? {}, spy)],
      ["fake-review", factory("fake-review", provider, setup.review ?? {}, spy)],
      ["fake-writer", factory("fake-writer", provider, { caps: { filesystem: { read: true, write: true } } }, spy)]]) } };
}
const BINDINGS = [
  { role: "Lead", adapter: "fake-lead", model: "m-lead", effort: "high" },
  { role: "Explorer", adapter: "fake-lead", model: "m-explore", effort: "low" },
  { role: "Reviewer", adapter: "fake-review", model: "m-review", effort: "low" },
  { role: "Worker", adapter: "fake-writer", model: "m-write", effort: "low" },
];
const passPlan = { commands: [{ id: "unit", executable: process.execPath, args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 20_000,
  mutationPolicy: "readOnly" }] };

function sh(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false",
    "-c", "init.defaultBranch=main", "-c", `core.hooksPath=${join(cwd, ".no-hooks")}`, ...args], { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  return r.stdout;
}
async function userState(root: string): Promise<string> {
  // Ignored files count too, except Fusion's own self-ignored run storage.
  const status = sh(root, "status", "--porcelain=v1", "-uall", "--ignored").split("\n").filter(line => !line.startsWith("!! .fusion/")).join("\n");
  const lines = [status, sh(root, "rev-parse", "HEAD")];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name), rel = relative(root, path);
    if (!entry.isFile() || rel.startsWith(".git") || rel.startsWith(".fusion")) continue;
    lines.push(`${rel}:${createHash("sha256").update(await readFile(path)).digest("hex")}`);
  }
  return lines.sort().join("\n");
}
interface Repo { dir: string; root: string }
async function withRepo<T>(config: Readonly<Record<string, unknown>> | "none", run: (repo: Repo) => Promise<T>, options: { dirty?: boolean } = {}): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "fusion-o5-"));
  const root = join(dir, "repo");
  try {
    await mkdir(root);
    sh(root, "init", "-q"); sh(root, "config", "core.autocrlf", "false");
    await writeFile(join(root, "a.txt"), "old\n");
    await writeFile(join(root, ".gitignore"), "node_modules/\n");
    if (config !== "none") await writeFile(join(root, "fusion.config.json"), JSON.stringify({ schemaVersion: 1, bindings: BINDINGS, ...config }));
    sh(root, "add", "."); sh(root, "commit", "-qm", "init");
    if (options.dirty !== false) await writeFile(join(root, "a.txt"), "new value\n");
    return await run({ dir, root });
  } finally {
    assert.ok(resolve(dir).toLowerCase().startsWith(`${resolve(tmpdir()).toLowerCase()}${sep}`));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
interface Ran { code: number; stdout: string; stderr: string; json?: Record<string, unknown> }
async function cli(argv: string[], cwd: string, reg: ProviderRegistry, extra: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}): Promise<Ran> {
  let stdout = "", stderr = "";
  const code = await runCli(argv, { stdout: t => { stdout += t; }, stderr: t => { stderr += t; } },
    { env: { ...process.env, ...extra.env }, cwd, registry: reg, ...(extra.signal ? { signal: extra.signal } : {}) });
  let json: Record<string, unknown> | undefined;
  if (argv.includes("--json")) json = JSON.parse(stdout) as Record<string, unknown>;
  return { code, stdout, stderr, ...(json ? { json } : {}) };
}
const manifestStatus = async (root: string, runId: string): Promise<string> =>
  (JSON.parse(await readFile(join(root, ".fusion", "runs", runId, "run.json"), "utf8")) as { status: string }).status;

// ---------------------------------------------------------------------------------------------------------------
// CLI surface

test("O5 CLI: help, version and deterministic usage errors", async () => {
  const { registry: reg } = registry();
  const cwd = process.cwd();
  const help = await cli(["--help"], cwd, reg);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: fusion/u);
  for (const cmd of ["doctor", "review", "audit", "build", "show"]) assert.match(help.stdout, new RegExp(`\\b${cmd}\\b`, "u"));
  assert.deepEqual([(await cli(["-V"], cwd, reg)).stdout, (await cli(["--version"], cwd, reg)).code], ["fusion 0.1.0\n", 0]);
  const bad: string[][] = [["frobnicate"], [], ["--version", "doctor"], ["--help", "--version"], ["doctor", "--probe", "--probe"],
    ["review", "--probe"], ["--probe", "doctor"], ["review", "--base"], ["review", "--base", "--no-verify"], ["build"],
    ["build", "a", "b"], ["build", "-rf"], ["build", "--timeout", "abc", "x"], ["build", "--timeout", "0", "x"],
    ["build", "--operation", "hack", "x"], ["doctor", "extra"], ["show"], ["doctor", "--json=yes"], ["audit", "--base=main"],
    ["build", "--path", "--", "x"]];
  for (const argv of bad) {
    const ran = await cli(argv, cwd, reg);
    assert.equal(ran.code, 2, JSON.stringify(argv));
    assert.equal(ran.stdout, "");
    assert.match(ran.stderr, /^fusion: /u);
    assert.doesNotMatch(ran.stderr, /\n\s+at |Error:/u, "no stack traces for usage errors");
  }
  assert.deepEqual(parseArgs(["build", "--", "-rf the build dir"]).positionals, ["-rf the build dir"], "-- ends option parsing");
  assert.deepEqual(parseArgs(["--json", "build", "--path", "a.ts", "--path=b.ts", "task"]).paths, ["a.ts", "b.ts"]);
  assert.throws(() => parseArgs(Array.from({ length: 300 }, () => "x")), UsageError);
});

test("O5 CLI: the real executable entrypoint reports version, help and usage exit codes", { skip }, async () => {
  const main = join(process.cwd(), "dist", "src", "cli", "main.js");
  // Never inside this checkout: a command must not create run storage in the developer's repository.
  const outside = await mkdtemp(join(tmpdir(), "fusion-o5-exe-"));
  try {
    const run = (...args: string[]) => spawnSync(process.execPath, [main, ...args], { cwd: outside, encoding: "utf8", windowsHide: true });
    const version = run("--version");
    assert.deepEqual([version.status, version.stdout], [0, "fusion 0.1.0\n"]);
    assert.equal(run("--help").status, 0);
    const unknown = run("launch", "--everything");
    assert.equal(unknown.status, 2);
    assert.doesNotMatch(unknown.stderr, /\n\s+at /u);
    const injected = run("build", "$(echo pwned) `rm -rf /`");
    assert.equal(injected.status, 2, "outside a repository the build is refused as invalid input");
    assert.doesNotMatch(injected.stdout + injected.stderr, /pwned\n|\n\s+at /u, "arguments are data; nothing is evaluated by a shell");
    assert.deepEqual(await readdir(outside), [], "nothing was created");
  } finally { await rm(outside, { recursive: true, force: true }); }
});

test("O5 CLI: Ctrl+C aborts the run once and forces exit on the second press", () => {
  const messages: string[] = [];
  let forced = 0;
  const handler = createInterruptHandler(text => messages.push(text), () => { forced++; });
  assert.equal(handler.signal.aborted, false);
  handler.interrupt();
  assert.deepEqual([handler.signal.aborted, forced], [true, 0]);
  assert.match(messages[0]!, /cancelling/u);
  handler.interrupt();
  assert.equal(forced, 1);
});

test("O5 outcome mapping: finished, unfinished and failed states have distinct states and exit codes", () => {
  const base = { transitions: [], delegateAttempts: 0, reviews: [] } as unknown as WorkflowResult;
  const map = (patch: Partial<WorkflowResult>) => { const o = outcomeOf({ ...base, ...patch } as WorkflowResult); return [o.state, o.exitCode]; };
  assert.deepEqual(map({ state: "completed" }), ["COMPLETED", 0]);
  assert.deepEqual(map({ state: "answered" }), ["ANSWERED", 0]);
  assert.deepEqual(map({ state: "reviewRequired" }), ["REVIEW_REQUIRED", 12]);
  assert.deepEqual(map({ state: "decisionRequired" }), ["DECISION_REQUIRED", 13]);
  assert.deepEqual(map({ state: "humanGateRequired" }), ["HUMAN_GATE_REQUIRED", 14]);
  assert.deepEqual(map({ state: "cancelled" }), ["CANCELLED", 130]);
  assert.deepEqual(map({ state: "failed", error: { kind: "Timeout", safeMessage: "t", retryable: true } }), ["TIMED_OUT", 7]);
  assert.deepEqual(map({ state: "failed", error: { kind: "VerificationFailure", safeMessage: "v", retryable: false } }), ["FAILED", 9]);
  assert.deepEqual(map({ state: "failed", error: { kind: "MalformedOutput", safeMessage: "m", retryable: false } }), ["FAILED", 6]);
  assert.deepEqual(map({ state: "failed", error: { kind: "CapabilityUnavailable", safeMessage: "c", retryable: false },
    transitions: [{ from: "inspected", to: "failed", reason: "policyFailure" }] }), ["BLOCKED", 5]);
  for (const state of ["reviewRequired", "decisionRequired", "humanGateRequired"] as const)
    assert.doesNotMatch(outcomeOf({ ...base, state }).message, /success|completed/iu, "unfinished work is never described as success");
});

test("O5 output is redacted and terminal-safe", () => {
  const redactor = new DiagnosticRedactor(["sekrit-value-12345"]);
  const text = terminalSafe("token sekrit-value-12345 \u001b[31mred\u001b[0m \u202etxt.exe bell\u0007 ok\n", redactor);
  assert.doesNotMatch(text, /sekrit-value-12345|\u001b|\u202e|\u0007/u);
  assert.match(text, /\[REDACTED\]/u);
  assert.match(text, /\\u001b\[31m/u);
  assert.ok(text.endsWith("ok\n"), "newlines are kept");
});

// ---------------------------------------------------------------------------------------------------------------
// doctor

test("O5 doctor: a healthy read-only setup is REVIEW_READY and Writer is never ready", { skip }, async () => withRepo({}, async ({ root }) => {
  const { registry: reg, spy } = registry();
  const before = await userState(root);
  const ran = await cli(["--json", "doctor"], root, reg);
  const report = ran.json as { readiness: { overall: string; classes: string[] }; roles: Record<string, Record<string, string>>;
    writer: { ready: boolean; code: string }; probed: boolean; providers: Array<{ role: string; eligibility: Record<string, { state: string }> }> };
  assert.equal(ran.code, 0);
  assert.deepEqual(report.readiness.classes, ["REVIEW_READY", "WRITER_NOT_READY"]);
  assert.equal(report.writer.ready, false);
  assert.equal(report.roles.Worker!.writer, "blocked");
  assert.equal(report.providers.find(p => p.role === "Worker")!.eligibility.writer!.state, "blocked");
  assert.deepEqual([spy.creates.length, spy.probes, spy.sessions.length], [0, 0, 0], "doctor builds no adapter and runs no turn");
  assert.equal(report.probed, false);
  assert.equal(await userState(root), before);
  assert.equal((await readdir(root)).includes(".fusion"), false, "doctor creates no storage");
  await cli(["doctor", "--probe"], root, reg);
  assert.equal(spy.probes, 3, "--probe reads back auth for read-only bindings only (never the Worker)");
}));

test("O5 doctor: unavailable, unknown and blocked providers are never reported as ready", { skip }, async () => withRepo({}, async ({ root }) => {
  const cases: Array<[Setup, string, string]> = [
    [{ review: { executable: "unavailable" } }, "unavailable", "READ_ONLY_READY"],
    [{ review: { caps: { webToolsDisabled: "unknown" } } }, "unknown", "READ_ONLY_READY"],
    [{ review: { caps: { shell: { available: "unknown", sandboxed: false } } } }, "unknown", "READ_ONLY_READY"],
    [{ review: { structured: false } }, "ineligible", "READ_ONLY_READY"],
    [{ review: { billing: { state: "blocked", reasons: ["PROVIDER_KEY: API_KEY_OVERRIDE"] } } }, "blocked", "READ_ONLY_READY"],
    [{ lead: { caps: { structuredOutput: "unknown" } }, review: { caps: { webToolsDisabled: "unknown" } } }, "unknown", "DEGRADED"],
  ];
  for (const [setup, reviewerState, overall] of cases) {
    const ran = await cli(["--json", "doctor"], root, registry(setup).registry);
    const report = ran.json as { readiness: { overall: string }; roles: Record<string, { review: string }> };
    assert.equal(report.roles.Reviewer!.review, reviewerState, JSON.stringify(setup));
    assert.equal(report.readiness.overall, overall, JSON.stringify(setup));
    assert.equal(ran.code, overall === "DEGRADED" ? 15 : 0);
  }
  const text = await cli(["doctor"], root, registry({ review: { billing: { state: "blocked", reasons: ["PROVIDER_KEY: API_KEY_OVERRIDE"] } } }).registry,
    { env: { PROVIDER_KEY: "sk-live-abcdefghijklmnop" } });
  assert.match(text.stdout, /billing guard blocked \[PROVIDER_KEY: API_KEY_OVERRIDE\]/u);
  assert.doesNotMatch(text.stdout, /sk-live-abcdefghijklmnop/u, "only key names and reasons are shown, never values");
}));

test("O5 doctor: repository missing, dirty repository and degraded storage", { skip }, async () => {
  const { registry: reg } = registry();
  const empty = await mkdtemp(join(tmpdir(), "fusion-o5-norepo-"));
  try {
    const ran = await cli(["--json", "doctor"], empty, reg);
    assert.deepEqual([ran.code, (ran.json as { readiness: { overall: string } }).readiness.overall], [11, "BLOCKED"]);
    assert.deepEqual(await readdir(empty), [], "nothing is created outside a repository");
  } finally { await rm(empty, { recursive: true, force: true }); }
  await withRepo({}, async ({ root }) => {
    await writeFile(join(root, "new.txt"), "untracked\n");
    sh(root, "add", "a.txt");
    const before = await userState(root);
    const report = (await cli(["--json", "doctor"], root, reg)).json as { repository: { changes: Record<string, number> } };
    assert.deepEqual(report.repository.changes, { staged: 1, unstaged: 0, untracked: 1, conflicted: 0 });
    assert.equal(await userState(root), before, "diagnosing a dirty repository changes nothing");
    await mkdir(join(root, ".fusion", "runs", "r-0000000000-00000000000000000000000000000000"), { recursive: true });
    await writeFile(join(root, ".fusion", "runs", "r-0000000000-00000000000000000000000000000000", "run.json"), "{not json");
    const degraded = (await cli(["--json", "doctor"], root, reg)).json as { storage: { state: string; corruptRuns: number } };
    assert.deepEqual([degraded.storage.state, degraded.storage.corruptRuns], ["degraded", 1]);
    await rm(join(root, ".fusion"), { recursive: true });
    await writeFile(join(root, ".fusion"), "not a directory");
    const unsafe = await cli(["--json", "doctor"], root, reg);
    assert.deepEqual([unsafe.code, (unsafe.json as { storage: { state: string } }).storage.state], [11, "unsafe"]);
  });
});

test("O5 doctor: invalid configuration is reported, strictly, without secrets", { skip }, async () => withRepo("none", async ({ root }) => {
  const { registry: reg } = registry();
  for (const config of [{ schemaVersion: 1, bindigns: [] }, { schemaVersion: 2 },
    { schemaVersion: 1, bindings: [{ ...BINDINGS[0], options: { apiKey: "x" } }] },
    { schemaVersion: 1, bindings: [{ ...BINDINGS[0], role: "Boss" }] }]) {
    await writeFile(join(root, "fusion.config.json"), JSON.stringify(config));
    const ran = await cli(["--json", "doctor"], root, reg);
    const report = ran.json as { config: { state: string; error: string } };
    assert.deepEqual([ran.code, report.config.state], [11, "invalid"], JSON.stringify(config));
  }
  await writeFile(join(root, "fusion.config.json"), '{"schemaVersion":1,"schemaVersion":1}');
  const duplicate = await cli(["review"], root, reg);
  assert.equal(duplicate.code, 2, "duplicate JSON keys are refused");
  assert.doesNotMatch(duplicate.stderr, /\n\s+at /u);
}));

// ---------------------------------------------------------------------------------------------------------------
// review

test("O5 review: a clean read-only review is ANSWERED, with verification COMPLETED; no Writer, primary unchanged", { skip }, async () => {
  await withRepo({}, async ({ root }) => {
    const { registry: reg, spy } = registry();
    const before = await userState(root);
    const ran = await cli(["review"], root, reg);
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /state: ANSWERED/u);
    assert.doesNotMatch(ran.stdout, /COMPLETED|success/iu, "an unverified review is an answer, not a completion");
    assert.equal(await userState(root), before);
    assert.deepEqual(new Set(spy.sessions.map(s => s.role)), new Set(["Reviewer"]), "zero findings: no adjudication, no Writer");
    assert.ok(!spy.creates.includes("Worker"));
    assert.ok(spy.sessions.every(s => s.posture === "readOnly" && s.workspaceLeaseId === "primary"));
    const runId = /run: (r-\S+)/u.exec(ran.stdout)![1]!;
    assert.equal(await manifestStatus(root, runId), "completed");
  });
  await withRepo({ verification: passPlan }, async ({ root }) => {
    const { registry: reg } = registry();
    const ran = await cli(["--json", "review"], root, reg);
    const outcome = (ran.json as { outcome: { state: string } }).outcome;
    assert.deepEqual([ran.code, outcome.state], [0, "COMPLETED"]);
    const skipped = await cli(["--json", "review", "--no-verify"], root, reg);
    assert.equal((skipped.json as { outcome: { state: string } }).outcome.state, "ANSWERED");
  });
  await withRepo({}, async ({ root }) => {
    const nothing = await cli(["review"], root, registry().registry);
    assert.deepEqual([nothing.code, /Nothing to review/u.test(nothing.stdout)], [0, true]);
    assert.equal((await readdir(root)).includes(".fusion"), false, "no run for an empty change");
  }, { dirty: false });
});

test("O5 review: findings and adjudications are shown; unresolved findings leave the run pending", { skip }, async () => withRepo({}, async ({ root }) => {
  const { registry: reg } = registry({ review: { review: () => ({ findings: [finding("F1", "HIGH"), finding("F2", "LOW")], summary: "" }) } });
  const ran = await cli(["review"], root, reg);
  assert.equal(ran.code, 13, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /\[HIGH\] r1-F1 HIGH problem F1 \(a\.txt\) — CONFIRMED, action fix/u);
  assert.match(ran.stdout, /\[LOW\] r1-F2 LOW problem F2 \(a\.txt\) — CONFIRMED, action followUp/u);
  assert.match(ran.stdout, /state: DECISION_REQUIRED/u);
  const runId = /run: (r-\S+)/u.exec(ran.stdout)![1]!;
  assert.equal(await manifestStatus(root, runId), "pending", "unfinished work is never recorded as completed");
  const shown = await cli(["show", runId], root, reg);
  assert.match(shown.stdout, /status: pending, state DECISION_REQUIRED/u);
  assert.match(shown.stdout, /\[HIGH\] r1-F1 HIGH problem F1 — CONFIRMED/u);
  const blocker = await cli(["--json", "review"], root,
    registry({ review: { review: () => ({ findings: [finding("B1", "BLOCKER")], summary: "" }) } }).registry);
  assert.deepEqual([blocker.code, (blocker.json as { outcome: { state: string; pendingStage: string } }).outcome.state], [14, "HUMAN_GATE_REQUIRED"]);
}));

test("O5 review: no eligible or capability-unknown Reviewer fails closed with an actionable diagnostic", { skip }, async () => {
  await withRepo({ bindings: BINDINGS.filter(b => b.role !== "Reviewer") }, async ({ root }) => {
    const { registry: reg, spy } = registry();
    const ran = await cli(["review"], root, reg);
    assert.equal(ran.code, 5);
    assert.match(ran.stdout, /state: BLOCKED/u);
    assert.match(ran.stdout, /fusion doctor/u);
    assert.equal(spy.sessions.length, 0, "nothing ran; the Worker was not used instead");
  });
  await withRepo({}, async ({ root }) => {
    for (const caps of [{ webToolsDisabled: "unknown" as const }, { shell: { available: "unknown" as const, sandboxed: false } },
      { structuredOutput: "unknown" as const }]) {
      const { registry: reg, spy } = registry({ review: { caps } });
      const ran = await cli(["--json", "review"], root, reg);
      assert.deepEqual([ran.code, (ran.json as { outcome: { state: string } }).outcome.state], [5, "BLOCKED"], JSON.stringify(caps));
      assert.equal(spy.sessions.length, 0);
    }
  });
});

test("O5 review: malformed output, timeout and cancellation end in typed, unfinished-or-failed states", { skip }, async () => withRepo({}, async ({ root }) => {
  const malformed = await cli(["review"], root, registry({ review: { review: () => "Looks good to me!" } }).registry);
  assert.equal(malformed.code, 6);
  assert.match(malformed.stdout, /state: FAILED/u);
  const timed = await cli(["review", "--timeout", "1"], root, registry({ review: { review: () => new Promise(() => undefined) } }).registry);
  assert.equal(timed.code, 7);
  assert.match(timed.stdout, /state: TIMED_OUT/u);
  const controller = new AbortController();
  const cancelled = await cli(["--json", "review"], root,
    registry({ review: { review: () => { controller.abort(); return new Promise(() => undefined); } } }).registry, { signal: controller.signal });
  assert.deepEqual([cancelled.code, (cancelled.json as { outcome: { state: string } }).outcome.state], [130, "CANCELLED"]);
  const runId = (cancelled.json as { runId: string }).runId;
  assert.equal(await manifestStatus(root, runId), "cancelled", "the cancellation is recorded before the command returns");
}));

test("O5 review: secrets never reach output, and hostile text cannot drive the terminal", { skip }, async () => withRepo({}, async ({ root }) => {
  const secret = "sk-test-0123456789abcdefghij";
  const reg = registry({ review: { review: () => ({ findings: [finding("F1", "LOW", { title: `Leaked ${secret} here \u202eexe.txt` })], summary: "" }) } }).registry;
  for (const json of [false, true]) {
    const ran = await cli(json ? ["--json", "review"] : ["review"], root, reg, { env: { MY_SERVICE_TOKEN: secret } });
    assert.doesNotMatch(ran.stdout + ran.stderr, new RegExp(secret, "u"));
    assert.doesNotMatch(ran.stdout, /\u202e/u);
    assert.match(ran.stdout, /\[REDACTED\]/u);
  }
}));

// ---------------------------------------------------------------------------------------------------------------
// audit and build

test("O5 audit: deterministic blockers, Writer never ready, no mutation", { skip }, async () => withRepo({}, async ({ root }) => {
  const { registry: reg, spy } = registry({ review: { caps: { webToolsDisabled: "unknown" } } });
  await writeFile(join(root, ".env"), "LOCAL=1\n");
  sh(root, "add", ".env");
  const before = await userState(root);
  const ran = await cli(["--json", "audit"], root, reg);
  const report = ran.json as { status: string; items: Array<{ id: string; severity: string }>; diagnostics: { writer: { ready: boolean } } };
  assert.equal(ran.code, 0);
  assert.equal(report.status, "attention");
  const ids = report.items.map(i => i.id);
  for (const id of ["review-not-ready", "tracked-credentials", "no-verification", ...REAL_WRITER_MODE_PREREQUISITES.map(p => `writer-${p.id}`)])
    assert.ok(ids.includes(id), id);
  assert.equal(report.diagnostics.writer.ready, false);
  assert.equal(await userState(root), before);
  assert.equal((await readdir(root)).includes(".fusion"), false, "the audit creates no run or storage");
  assert.deepEqual([spy.creates.length, spy.sessions.length], [0, 0], "no model-assisted analysis");
  await writeFile(join(root, ".fusion"), "file");
  const blocked = await cli(["--json", "audit"], root, reg);
  assert.deepEqual([blocked.code, (blocked.json as { status: string }).status], [11, "blocked"]);
}));

test("O5 build: Writer-required tasks stop at REAL_WRITER_MODE_NOT_READY; critical ones at the human gate", { skip }, async () => withRepo({}, async ({ root }) => {
  const { registry: reg, spy } = registry();
  const before = await userState(root);
  const ran = await cli(["--json", "build", "--path", "a.txt", "Fix the date helper."], root, reg);
  const report = ran.json as { runId: string; writerRequired: boolean; risk: { level: string }; intendedWorkflow: string[];
    outcome: { state: string; code: string }; writer: { prerequisites: Array<{ id: string }> } };
  assert.deepEqual([ran.code, report.outcome.state, report.outcome.code, report.writerRequired], [11, "BLOCKED", "REAL_WRITER_MODE_NOT_READY", true]);
  assert.equal(report.risk.level, "high", "a writer without a verification plan is high risk");
  assert.deepEqual(report.writer.prerequisites.map(p => p.id), REAL_WRITER_MODE_PREREQUISITES.map(p => p.id));
  assert.deepEqual([spy.creates.length, spy.sessions.length], [0, 0], "no adapter is built and no provider runs");
  assert.equal(await userState(root), before, "the primary workspace is untouched");
  assert.equal(await manifestStatus(root, report.runId), "failed");
  assert.ok(!(await readdir(join(root, ".fusion"))).includes("worktrees") || (await readdir(join(root, ".fusion", "worktrees"))).length === 0,
    "no lease was created");
  const critical = await cli(["--json", "build", "--path", "a.txt", "Fix it, then force-push to main."], root, reg);
  const cr = critical.json as { runId: string; outcome: { state: string; pendingStage: string } };
  assert.deepEqual([critical.code, cr.outcome.state, cr.outcome.pendingStage], [14, "HUMAN_GATE_REQUIRED", "humanGate"]);
  assert.equal(await manifestStatus(root, cr.runId), "pending");
  const text = await cli(["build", "--path", "a.txt", "Fix the helper."], root, reg);
  assert.doesNotMatch(text.stdout, /COMPLETED|success/iu);
  for (const task of ["", "x".repeat(16_385), "ok \u001b[2J", "rename \u202egpj.exe"]) {
    const bad = await cli(["build", "--", task], root, reg);
    assert.equal(bad.code, 2, JSON.stringify(task.slice(0, 20)));
  }
  assert.equal(writerReadiness().ready, false);
}));

test("O5 build: read-only operations run read-only and are answered, never completed without verification", { skip }, async () => withRepo({}, async ({ root }) => {
  const { registry: reg, spy } = registry();
  const ran = await cli(["--json", "build", "--operation", "analyze", "--path", "a.txt", "Explain what a.txt stores."], root, reg);
  const report = ran.json as { outcome: { state: string }; writerRequired: boolean };
  assert.deepEqual([ran.code, report.outcome.state, report.writerRequired], [0, "ANSWERED", false]);
  assert.ok(spy.sessions.every(s => s.posture === "readOnly") && !spy.creates.includes("Worker"));
  const verified = await withRepo({ verification: passPlan }, async ({ root: r2 }) =>
    (await cli(["--json", "build", "--operation", "analyze", "--path", "a.txt", "Explain a.txt."], r2, registry().registry)).json);
  assert.equal((verified as { outcome: { state: string } }).outcome.state, "COMPLETED");
}));

// ---------------------------------------------------------------------------------------------------------------
// Control plane

test("O5 control plane: provider identity swap leaves semantics and output unchanged", { skip }, async () => withRepo({}, async ({ root }) => {
  const run = async (provider: string) => {
    const ran = await cli(["--json", "review"], root, registry({ provider, review: { review: () => ({ findings: [finding("F1", "MEDIUM")], summary: "" }) } }).registry);
    const json = ran.json as Record<string, unknown>;
    delete json.runId;
    return { code: ran.code, json: JSON.stringify(json) };
  };
  const a = await run("alpha-provider"), b = await run("zeta-provider");
  assert.equal(a.code, b.code);
  assert.equal(a.json.replace(/alpha-provider/gu, "P").replace(/r-[0-9a-z]{10}-[0-9a-f]{32}/gu, "R"),
    b.json.replace(/zeta-provider/gu, "P").replace(/r-[0-9a-z]{10}-[0-9a-f]{32}/gu, "R"));
}));

test("O5 control plane: no provider or model names in core, control-plane or CLI semantics", async () => {
  const forbidden = /claude|muse|anthropic|\bmeta\b|opus|spark|\bgpt|gemini|openai|llama/iu;
  let scanned = 0;
  for (const dir of ["src/core/workflow", "src/core/policy", "src/core/review", "src/app", "src/cli"])
    for (const name of await readdir(join(process.cwd(), dir))) if (name.endsWith(".ts")) {
      assert.doesNotMatch(await readFile(join(process.cwd(), dir, name), "utf8"), forbidden, `${dir}/${name}`);
      scanned++;
    }
  assert.ok(scanned >= 20);
});

test("O5 control plane: an event-store failure never becomes success", { skip }, async () => withRepo({}, async ({ root }) => {
  const reg = registry({ review: { review: async () => {
    const runs = join(root, ".fusion", "runs");
    const [runId] = await readdir(runs);
    const events = join(runs, runId!, "events.jsonl");
    await rm(events);
    await mkdir(events);
    return { findings: [], summary: "" };
  } } }).registry;
  const ran = await cli(["review"], root, reg);
  assert.notEqual(ran.code, 0);
  assert.doesNotMatch(ran.stdout, /ANSWERED|COMPLETED/u);
  assert.match(ran.stdout + ran.stderr, /storage|Internal|failed/iu);
}));

test("O5 control plane: Worker bindings are reported as blocked and never constructed", async () => {
  const { buildCandidates } = await import("../src/app/providers.js");
  const { registry: reg, spy } = registry();
  const config = { schemaVersion: 1 as const, verification: { commands: [] }, limits: { runTimeoutMs: 60_000 },
    bindings: BINDINGS.map(b => ({ ...b, options: {} })) as unknown as BindingConfig[] };
  const built = await buildCandidates(config, reg, { workspace: process.cwd(), env: {} }, ["Worker", "Lead", "Reviewer"]);
  assert.deepEqual(built.candidates.map(c => c.binding.role), ["Lead", "Reviewer"]);
  assert.deepEqual(built.unavailable, [{ index: 3, role: "Worker", reason: "REAL_WRITER_MODE_NOT_READY" }]);
  assert.ok(!spy.creates.includes("Worker"), "no Writer adapter is ever instantiated");
});
