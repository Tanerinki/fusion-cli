import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import type { WriterRehearsal } from "../src/app/writer-rehearsal.js";
import { runCli } from "../src/cli/run.js";
import type { ChangeSet, DelegationPacket } from "../src/core/domain.js";
import type { CandidateId } from "../src/core/tournament/contracts.js";
import { STRATEGY_BRIEFS } from "../src/core/tournament/strategies.js";
import { DockerLinuxVerificationBackend } from "../src/platform/verification/docker/backend.js";
import { VerificationService } from "../src/platform/verification/selection.js";
import { OFFLINE_REHEARSAL, PrivateCandidateWorkspacePort } from "../src/platform/workflow/candidates.js";
import { ProcessGitClient } from "../src/platform/workspace/git.js";
import { FAKE_DEPENDENCY_TREE, QUOTE_BUGGY, QUOTE_FIXED, QUOTE_TEST, QUOTE_TEST_WITH_REGRESSION, QUOTE_WRONG, REHEARSAL_PLAN } from "./fixtures/rehearsal-project.js";
import { FAKE_DOCKER_EXE, FAKE_IMAGE, FakeDocker } from "./fixtures/fake-docker.js";
import { changeSet, oracle, scriptedRoles } from "./fixtures/fake-writer.js";
import { gitAvailable, withRehearsalRepo } from "./fixtures/writer-rehearsal-harness.js";

/**
 * v0.5 — the LIVE ACCEPTANCE RUNNER, dry-tested: its verdicts on the shapes that decide them, its records collector over the
 * records the real build route writes, its L4 check over the fake backend (where it can never be a live PASS), its preconditions
 * (no model turn unless confirmed) and its own source (it never answers a question or makes a choice). No real provider runs here.
 */
type Verdict = { status: string; detail: string; lines: string[] };
type Facts = Record<string, unknown>;
type Verdicts = { judgeL1(s: string): Verdict; judgeL2(f: Facts): Verdict; judgeL3(f: Facts): Verdict; judgeL4(d: unknown): Verdict; judgeL5(f: Facts): Verdict;
  judgeL6(f: Facts, segment: string, fixtureOk: boolean): Verdict; overall(results: ReadonlyArray<{ status: string }>, sentinels: readonly string[]): string };
const REPO = process.cwd();
const script = (name: string) => pathToFileURL(join(REPO, "scripts", name)).href;
const verdicts = async (): Promise<Verdicts> => await import(script("v05-live-verdicts.mjs")) as Verdicts;
const skip = gitAvailable ? false : "git executable unavailable";

test("v0.5 live L1: a plan without a tournament PASSES; a tournament for a simple change FAILS; no plan is REVIEW", async () => {
  const { judgeL1 } = await verdicts();
  const plan = (extra: string[] = []) => ["Build plan", "Risk: low (singleFileWriteScope)", "Workflow: lead plan → change author", ...extra, ""].join("\n");
  assert.equal(judgeL1(plan()).status, "PASS");
  assert.equal(judgeL1(plan(["Candidates: 2 independent candidates (policy: risk medium) — …"])).status, "FAIL");
  assert.equal(judgeL1("Looking at the repository (read-only)…").status, "REVIEW");
});

// ---------------------------------------------------------------- records of a real (offline) tournament build

const briefOf = (packet: DelegationPacket): CandidateId | undefined =>
  (["c1", "c2", "c3"] as const).find(id => packet.task.constraints.includes(STRATEGY_BRIEFS[id].brief));
const change = (quote: string): ChangeSet => changeSet([["src/quote.ts", QUOTE_BUGGY, quote], ["test/quote.test.ts", QUOTE_TEST, QUOTE_TEST_WITH_REGRESSION]]);
const FIXED_LINE = "basisPoints(subtotal - discount, quote.taxBasisPoints)";
const probeCommand = { executable: "/usr/local/bin/node", args: ["probe.js"], cwd: ".", timeoutMs: 30_000, mutationPolicy: "readOnly" };
const REGISTRY = { defaults: { schemaVersion: 1 as const, bindings: [], verification: { commands: [] }, limits: { runTimeoutMs: 600_000 } }, factories: new Map() };

test("v0.5 live records: the facts of a real tournament build come from its bound records — and L2, L3 and L5 PASS on them", { skip }, async () =>
  withRehearsalRepo(async repo => {
    const attach = oracle((command, context) => {
      const quote = context.files.get("src/quote.ts")?.toString("utf8") ?? "";
      if (command.id === "unit") return { pass: quote.includes(FIXED_LINE), stdout: "unit\n" };
      if (command.id === "probe-api") return { pass: true, stdout: `${(quote.match(/export /gu) ?? []).length}\n` };
      return { pass: true, stdout: "" };
    });
    const fake = new FakeDocker({ attach: attach as never, depsTree: FAKE_DEPENDENCY_TREE });
    const backend = new DockerLinuxVerificationBackend({ image: FAKE_IMAGE, runner: fake, resolveDocker: () => Promise.resolve(FAKE_DOCKER_EXE),
      dependencyStoreDirectory: join(repo.dir, "dependency-store") });
    const rehearsal: WriterRehearsal = { roles: scriptedRoles({ worker: ({ packet }) => briefOf(packet) === "c1" ? change(QUOTE_WRONG) : change(QUOTE_FIXED) }).roles,
      plan: REHEARSAL_PLAN, candidatePort: ({ primaryRoot, git, declaredPlatform }) => new PrivateCandidateWorkspacePort({ primaryRoot, git,
        service: new VerificationService([backend]), confinement: OFFLINE_REHEARSAL, declaredPlatform, dependencies: "npm-lockfile", prepareDependencies: true }) };
    let out = "";
    await runCli(["--json", "build", "--path", "src/quote.ts", "--path", "test/quote.test.ts", "Fix quote totals: tax applies to the discounted subtotal. Add a regression test."],
      { stdout: t => { out += t; }, stderr: t => { out += t; } }, { env: process.env, cwd: repo.root, registry: REGISTRY, writerRehearsal: rehearsal });
    const { collectFacts } = await import(script("v05-live-records.mjs")) as { collectFacts(root: string): Promise<Facts & {
      route: { route: string }; tournament: { candidates: Array<{ id: string; proposals: number; applied: boolean; checks: string[]; nodes: Array<{ id: string }> }>;
        decided: { selected: string }; primaryUnchanged: boolean } }> };
    const facts = await collectFacts(repo.root);
    assert.equal(facts.route.route, "tournament", out);
    assert.deepEqual(facts.tournament.candidates.map(c => [c.id, c.proposals > 0, c.applied, c.checks]), [["c1", true, true, ["typecheck", "unit"]],
      ["c2", true, true, ["typecheck", "unit"]]]);
    assert.equal(facts.tournament.decided.selected, "c2");
    assert.equal(facts.tournament.primaryUnchanged, true);
    assert.ok(!JSON.stringify(facts).includes("Fix quote totals"), "labels, counts and digests only");
    const { judgeL2, judgeL3, judgeL5 } = await verdicts();
    for (const [name, v] of [["L2", judgeL2(facts)], ["L3", judgeL3(facts)], ["L5", judgeL5(facts)]] as const)
      assert.equal(v.status, "PASS", `${name}: ${v.detail}`);
  }, { extraFiles: { "fusion.config.json": JSON.stringify({ schemaVersion: 1, bindings: [],
    verification: { commands: [], platformRequirement: "linux-compatible", experiments: { probes: [{ id: "api", command: probeCommand, expect: "baseline" }] } } }) } }));

test("v0.5 live L5/L6: a tie or no selection is REVIEW, an unresolved binding or a missing revalidation FAILS; an apply needs your yes and the fixture's check", async () => {
  const { judgeL5, judgeL6, overall } = await verdicts();
  const rev = "a".repeat(64);
  const t = (patch: Record<string, unknown>) => ({ route: { route: "tournament", candidates: 2 }, deliveryId: "d-1", tournament: { resolved: true, reason: null,
    decided: { outcome: "DELIVERY_ELIGIBLE", selected: "c2", selectedRevision: rev, chosenBy: "fusion" }, revalidation: { candidate: "c2", revision: rev, deliverable: true },
    reasons: [], candidates: [], ...patch } });
  assert.equal(judgeL5(t({})).status, "PASS");
  assert.equal(judgeL5(t({ decided: { outcome: "MULTIPLE_VERIFIED_CANDIDATES", tied: ["c1", "c2"] }, revalidation: null })).status, "REVIEW");
  assert.equal(judgeL5(t({ resolved: false, reason: "the tournament recorded more than one decision" })).status, "FAIL");
  assert.equal(judgeL5(t({ revalidation: null })).status, "FAIL", "selected but never revalidated");
  assert.equal(judgeL5(t({ revalidation: { candidate: "c2", revision: "b".repeat(64), deliverable: true } })).status, "FAIL", "another revision");
  assert.equal(judgeL6(t({}), "Decision: VERIFIED\nResult: applied (1 file)", true).status, "PASS");
  assert.equal(judgeL6(t({}), "Decision: VERIFIED\nResult: not applied", true).status, "REVIEW", "you declined");
  assert.equal(judgeL6(t({}), "Result: applied (1 file)", false).status, "FAIL", "the fixture's check failed");
  assert.equal(overall([{ status: "PASS" }, { status: "REVIEW" }], []), "REVIEW");
  assert.equal(overall([{ status: "PASS" }, { status: "PASS" }], ["HA-SENTINEL"]), "FAIL");
});

// ---------------------------------------------------------------- L4 over the fake backend

test("v0.5 live L4: the known good fix keeps the preserved keys, the known changed candidate does not — offline this is REVIEW, never a live PASS",
  { skip }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "v05-live-l4-"));
    try {
      const created = spawnSync(process.execPath, ["scripts/v02-live-fixture.mjs", "create-git", dir, "--experiments"], { cwd: REPO, encoding: "utf8", windowsHide: true });
      assert.equal(created.status, 0, created.stdout + created.stderr);
      const root = join(dir, "homeassistant-git");
      const config = JSON.parse(await readFile(join(root, "fusion.config.json"), "utf8")) as { verification: { experiments: { probes: Array<{ id: string }> } } };
      assert.deepEqual(config.verification.experiments.probes.map(p => p.id), ["preserved"]);
      const attach = oracle((command, context) => {
        const text = context.files.get("configuration.yaml")?.toString("utf8") ?? "";
        const keys = text.split("\n").filter(l => /^[A-Za-z_]+:/u.test(l)).map(l => l.split(":")[0]).sort().join(",");
        return command.id === "probe-preserved" ? { pass: true, stdout: `${keys}\n` } : { pass: true, stdout: "" };
      });
      const backend = new DockerLinuxVerificationBackend({ image: FAKE_IMAGE, runner: new FakeDocker({ attach: attach as never }),
        resolveDocker: () => Promise.resolve(FAKE_DOCKER_EXE), dependencyStoreDirectory: join(dir, "deps") });
      const git = await ProcessGitClient.fromPath(process.env, true);
      const compose = async () => ({ roles: [], unavailable: [], plan: { commands: [] }, views: undefined,
        workspace: new PrivateCandidateWorkspacePort({ primaryRoot: root, git, service: new VerificationService([backend]), confinement: OFFLINE_REHEARSAL,
          declaredPlatform: "linux-compatible", dependencies: "none" }), verification: { acceptance: "offlineRehearsal", reasons: [] } });
      const { discriminate } = await import(script("v05-live-discrimination.mjs")) as { discriminate(o: unknown): Promise<{ acceptance: string; good: string; bad: string; cleanup: boolean }> };
      const result = await discriminate({ root, compose, registry: REGISTRY });
      assert.deepEqual(result, { acceptance: "offlineRehearsal", good: "pass", bad: "fail", cleanup: true });
      const { judgeL4 } = await verdicts();
      assert.equal(judgeL4(result).status, "REVIEW", "offline is never a live result");
      assert.equal(judgeL4({ ...result, acceptance: "granted" }).status, "PASS");
      assert.equal(judgeL4({ ...result, acceptance: "granted", bad: "pass" }).status, "FAIL", "a probe that separates nothing fails");
      assert.equal(judgeL4(null).status, "FAIL");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

// ---------------------------------------------------------------- the runner as a process, and its source

const RUNNER = join(REPO, "scripts", "v05-live-acceptance.mjs");
const CANARY = "canary check passed on this runtime (11 checks: settings, hooks, MCP, agents, skills, commands, tools, plugins)";
type Binding = { role: string; adapter: string; version: string; probe?: Record<string, unknown>; postureEvidence?: string; readOnly?: string };
const provider = (b: Binding, index: number) => ({ index, role: b.role, adapter: b.adapter, requestedModel: "m", effort: "low",
  inspection: { executable: "available", runtimeVersion: b.version, billing: { state: "clear", reasons: [] }, controls: [], structuredTurns: true },
  identity: { requested: `p/${b.role}`, observed: "unobserved" }, capabilities: {}, postureEvidence: b.postureEvidence ?? "none",
  eligibility: { readOnly: { state: b.readOnly ?? "unknown", reasons: [] }, review: { state: "unknown", reasons: [] },
    changeProposal: { state: "unknown", reasons: [] }, writer: { state: "blocked", reasons: [] } }, ...(b.probe ? { probe: b.probe } : {}) });
const doctor = (lane: string) => ({ command: "doctor", exitCode: 15, readiness: { classes: ["DEGRADED"] },
  runtime: { platform: "win32", nodeVersion: "v22", git: "available" }, repository: { detected: false },
  config: { state: "valid", bindings: 4, verificationCommands: 0 }, storage: { state: "unknown" }, leases: { state: "unknown" },
  workspaceLease: { state: "available", reasons: [] }, verification: { state: "notConfigured", commands: 0, notes: [], confinedCommands: 0, platformRequirement: "unknown" },
  providers: [
    { role: "Lead", adapter: "claude-one-shot", version: "2.1.283", probe: { auth: { state: "authenticated", lane, detail: "claude auth status" },
      posture: { state: "attested", version: "2.1.283", detail: CANARY } } },
    { role: "Worker", adapter: "claude-one-shot", version: "2.1.283" },
    { role: "Explorer", adapter: "muse-exec", version: "1.4.0-R4302.1", probe: { auth: { state: "authenticated", lane: "subscription", detail: "account/read" } } },
    { role: "Reviewer", adapter: "muse-exec", version: "1.4.0-R4302.1", postureEvidence: "launchTime", readOnly: "eligible",
      probe: { auth: { state: "authenticated", lane: "subscription", detail: "account/read" } } }].map(provider),
  roles: {}, verificationPlatform: { assessment: { declared: "missing", effective: "unknown", signals: [] }, autonomousBackends: [] },
  writer: { code: "REAL_WRITER_MODE_NOT_READY", prerequisites: [] }, writerGates: { liveGateAuthorized: false, rows: [] }, probed: true });

test("v0.5 live runner: it stops before any model turn unless the logins and postures are confirmed, and a saved report never runs a session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "v05-live-pre-"));
  try {
    const run = async (name: string, value: unknown) => {
      const file = join(dir, `${name}.json`);
      await writeFile(file, typeof value === "string" ? value : JSON.stringify(value, null, 2));
      return spawnSync(process.execPath, [RUNNER, "--preconditions-from", file], { cwd: REPO, encoding: "utf8", windowsHide: true, timeout: 60_000 });
    };
    const confirmed = await run("observed", doctor("subscriptionToken"));
    assert.equal(confirmed.status, 0, confirmed.stdout + confirmed.stderr);
    assert.match(confirmed.stdout, /^ {2}\(saved report: no session is run in this mode\)$/mu);
    const apiKey = await run("api-key", doctor("api"));
    assert.equal(apiKey.status, 2);
    assert.match(apiKey.stdout, /STOPPED: the required logins and postures are not confirmed: .*No model turn was spent\./u);
    for (const out of [confirmed.stdout, apiKey.stdout]) assert.doesNotMatch(out, /=== L\d/u, "no session started");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("v0.5 live runner: every [y/N] question and every tie choice is the maintainer's — the runner never answers or chooses itself", async () => {
  const source = await readFile(RUNNER, "utf8");
  const writes = [...source.matchAll(/child\.stdin\.write\(([^)]*)\)/gu)].map(m => m[1]);
  assert.deepEqual(writes, ["`${answer}\\n`", "`${answer || \"none\"}\\n`", "`${line}\\n`"]);
  assert.equal([...source.matchAll(/const answer = await askHuman\(/gu)].length, 2, "both answers come from the maintainer's own terminal");
  assert.doesNotMatch(source, /"y"|'y'|`y`|\by\\n|"c1"|"c2"/u, "no scripted approval and no scripted choice");
  const typed = [...source.matchAll(/\[("[^\]]+")\]\);/gu)].flatMap(m => JSON.parse(`[${m[1]!}]`) as string[]);
  assert.ok(typed.length >= 5 && !typed.some(line => /^(?:y|yes|n|no|c[1-3]|none)$/iu.test(line)), typed.join(" | "));

  const { PassThrough } = await import("node:stream");
  const { askHuman } = await import(script("v04-live-human.mjs")) as { askHuman(i: NodeJS.ReadableStream, o: NodeJS.WritableStream, q: string,
    options?: { settleMs?: number; maxAsks?: number; accept?: RegExp; again?: string }): Promise<string> };
  const input = new PassThrough(), output = new PassThrough();
  output.resume();
  const answer = askHuman(input, output, "Choose? ", { settleMs: 30, accept: /^(?:c1|c2|none)$/u, again: "again: " });
  await new Promise(resolve => setTimeout(resolve, 80));
  for (const line of ["yes", "c3", "c2"]) { input.write(`${line}\n`); await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.equal(await answer, "c2", "only an offered choice answers; a yes is not a choice");
});
