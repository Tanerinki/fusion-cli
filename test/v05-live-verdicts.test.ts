import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import type { WriterRehearsal } from "../src/app/writer-rehearsal.js";
import { runCli } from "../src/cli/run.js";
import type { DelegationPacket } from "../src/core/domain.js";
import type { CandidateId } from "../src/core/tournament/contracts.js";
import { STRATEGY_BRIEFS } from "../src/core/tournament/strategies.js";
import { DockerLinuxVerificationBackend } from "../src/platform/verification/docker/backend.js";
import { VerificationService } from "../src/platform/verification/selection.js";
import { OFFLINE_REHEARSAL, PrivateCandidateWorkspacePort } from "../src/platform/workflow/candidates.js";
import { ProcessGitClient } from "../src/platform/workspace/git.js";
import { FAKE_DEPENDENCY_TREE, QUOTE_BUGGY, QUOTE_FIXED, QUOTE_WRONG, REHEARSAL_PLAN } from "./fixtures/rehearsal-project.js";
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
type Delivery = Readonly<{ ran: boolean; id?: string; approved?: boolean; state?: string | null; patchSha256?: string | null }>;
type Verdicts = { judgeL1(s: string): Verdict; judgeL2(f: Facts, expected?: Readonly<{ source: string; candidates: number }>): Verdict;
  judgeL3(f: Facts): Verdict; judgeL4(d: unknown): Verdict; judgeL5(f: Facts): Verdict; judgeL6(f: Facts, delivery: Delivery, fixtureOk: boolean): Verdict;
  tournamentDeliverable(f: Facts): boolean; overall(results: ReadonlyArray<{ status: string }>, sentinels: readonly string[]): string };
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
const FIXED_LINE = "basisPoints(subtotal - discount, quote.taxBasisPoints)";
const probeCommand = { executable: "/usr/local/bin/node", args: ["probe.js"], cwd: ".", timeoutMs: 30_000, mutationPolicy: "readOnly" };
const REGISTRY = { defaults: { schemaVersion: 1 as const, bindings: [], verification: { commands: [] }, limits: { runTimeoutMs: 600_000 } }, factories: new Map() };

const LOW_TASK = "Fix quote totals: tax applies to the discounted subtotal.";
const FIX_ONLY = changeSet([["src/quote.ts", QUOTE_BUGGY, QUOTE_FIXED]]), WRONG_ONLY = changeSet([["src/quote.ts", QUOTE_BUGGY, QUOTE_WRONG]]);
function seam(dir: string): WriterRehearsal {
  const attach = oracle((command, context) => {
    const quote = context.files.get("src/quote.ts")?.toString("utf8") ?? "";
    if (command.id === "unit") return { pass: quote.includes(FIXED_LINE), stdout: "unit\n" };
    if (command.id === "probe-api") return { pass: true, stdout: `${(quote.match(/export /gu) ?? []).length}\n` };
    return { pass: true, stdout: "" };
  });
  const fake = new FakeDocker({ attach: attach as never, depsTree: FAKE_DEPENDENCY_TREE });
  const backend = new DockerLinuxVerificationBackend({ image: FAKE_IMAGE, runner: fake, resolveDocker: () => Promise.resolve(FAKE_DOCKER_EXE),
    dependencyStoreDirectory: join(dir, "dependency-store") });
  return { roles: scriptedRoles({ worker: ({ packet }) => briefOf(packet) === "c1" ? WRONG_ONLY : FIX_ONLY }).roles, plan: REHEARSAL_PLAN,
    candidatePort: ({ primaryRoot, git, declaredPlatform }) => new PrivateCandidateWorkspacePort({ primaryRoot, git,
      service: new VerificationService([backend]), confinement: OFFLINE_REHEARSAL, declaredPlatform, dependencies: "npm-lockfile", prepareDependencies: true }) };
}
type LiveFacts = Facts & { route: { route: string; candidates: number; source: string }; deliveryId: string | null;
  tournament: { candidates: Array<{ id: string; proposals: number; applied: boolean; checks: string[] }>; decided: { selected: string };
    primaryUnchanged: boolean; selectedPatchSha256: string | null } | null };
const collect = async (root: string): Promise<LiveFacts> =>
  (await import(script("v05-live-records.mjs")) as { collectFacts(root: string): Promise<LiveFacts> }).collectFacts(root);

test("v0.5 live A/B: the live-like low-risk fix stays one candidate by policy; the L2 scenario's explicit --candidates 2 makes it a human-authorized tournament",
  { skip }, async () => withRehearsalRepo(async repo => {
    const build = async (extra: string[]) => {
      let out = "";
      await runCli(["--json", "build", ...extra, "--path", "src/quote.ts", LOW_TASK], { stdout: t => { out += t; }, stderr: t => { out += t; } },
        { env: process.env, cwd: repo.root, registry: REGISTRY, writerRehearsal: seam(repo.dir) });
      return out;
    };
    // A — the first live run's situation: a low-risk, single-file fix with nothing to compare stays single. Policy-correct.
    const single = await build([]);
    const policy = await collect(repo.root);
    assert.deepEqual([policy.route.route, policy.route.candidates, policy.route.source, policy.tournament], ["single", 1, "policy", null], single);
    const { judgeL2, judgeL3, judgeL5 } = await verdicts();
    assert.equal(judgeL2(policy).status, "FAIL", "no tournament: L2 cannot pass");
    // B — the same task with the explicit, host-owned count the live scenario uses: a tournament whose source is the human.
    const explicit = await build(["--candidates", "2"]);
    const facts = await collect(repo.root);
    assert.deepEqual([facts.route.route, facts.route.candidates, facts.route.source], ["tournament", 2, "human"], explicit);
    assert.deepEqual(facts.tournament!.candidates.map(c => [c.id, c.proposals > 0, c.applied, c.checks]), [["c1", true, true, ["typecheck", "unit"]],
      ["c2", true, true, ["typecheck", "unit"]]]);
    assert.equal(facts.tournament!.decided.selected, "c2");
    assert.equal(facts.tournament!.primaryUnchanged, true);
    assert.match(facts.tournament!.selectedPatchSha256 ?? "", /^[0-9a-f]{64}$/u);
    assert.ok(!JSON.stringify(facts).includes("Fix quote totals"), "labels, counts and digests only");
    for (const [name, v] of [["L2", judgeL2(facts, { source: "human", candidates: 2 })], ["L3", judgeL3(facts)], ["L5", judgeL5(facts)]] as const)
      assert.equal(v.status, "PASS", `${name}: ${v.detail}`);
    assert.equal(judgeL2({ ...facts, route: { ...facts.route, candidates: 3 } }, { source: "human", candidates: 2 }).status, "FAIL",
      "a count other than the authorized one never passes");
    assert.equal(judgeL2({ ...facts, route: { ...facts.route, source: "advice" } }, { source: "human", candidates: 2 }).status, "FAIL",
      "a count that is not the human's never passes");
  }, { extraFiles: { "fusion.config.json": JSON.stringify({ schemaVersion: 1, bindings: [],
    verification: { commands: [], platformRequirement: "linux-compatible", experiments: { probes: [{ id: "api", command: probeCommand, expect: "baseline" }] } } }) } }));

test("v0.5 live A (routing mechanics): the exact facts of the first live run route single — the policy is not weakened", async () => {
  const { tournamentRoute } = await import("../src/core/tournament/route.js");
  const live = tournamentRoute({ writer: true, taskClass: "bugFix", sensitive: false, risk: "low", alternatives: 0, priorFailure: false });
  assert.deepEqual([live.route, live.candidates, live.source], ["single", 1, "policy"]);
  assert.ok(live.reasons.includes("low risk with nothing to compare: one candidate"));
  const asked = tournamentRoute({ writer: true, taskClass: "bugFix", sensitive: false, risk: "low", alternatives: 0, priorFailure: false }, { requested: 2 });
  assert.deepEqual([asked.route, asked.candidates, asked.source], ["tournament", 2, "human"]);
});

test("v0.5 live C: a confirmation for another candidate count blocks the build before any provider or backend is composed", { skip }, async () =>
  withRehearsalRepo(async repo => {
    const { ControlPlane } = await import("../src/app/control-plane.js");
    const { build, planBuild } = await import("../src/app/commands.js");
    const { issueWriterRunAuthorization } = await import("../src/app/writer-gate.js");
    let composed = 0;
    const compose = async () => { composed++; return { roles: [], unavailable: [], plan: { commands: [] }, views: undefined as never,
      workspace: undefined as never, verification: { acceptance: "refused" as const, reasons: ["test: no acceptance"] } }; };
    const plane = new ControlPlane({ registry: REGISTRY, env: process.env, cwd: repo.root, writerComposition: compose as never });
    const options = { task: LOW_TASK, paths: ["src/quote.ts"], operation: "implement" as const, candidates: 2 };
    const plan = await planBuild(plane, options);
    assert.equal(plan.tournament.candidates, 2);
    const confirmedFor = (candidates: number) => issueWriterRunAuthorization({ task: plan.task, paths: plan.paths, repositoryRoot: plan.repository,
      typed: "build", candidates })!;
    const mismatch = await build(plane, { ...options, authorization: confirmedFor(1) });
    assert.equal(mismatch.outcome.code, "REAL_WRITER_MODE_NOT_READY", "a confirmation for one candidate never runs two");
    assert.equal(composed, 0, "blocked before any provider or backend was composed");
    const matching = await build(plane, { ...options, authorization: confirmedFor(2) });
    assert.notEqual(matching.outcome.code, "REAL_WRITER_MODE_NOT_READY", "the confirmation for exactly this count passes the gate");
    assert.equal(composed, 1);
  }, { extraFiles: { "fusion.config.json": JSON.stringify({ schemaVersion: 1, bindings: [], verification: { commands: [], platformRequirement: "linux-compatible" } }) } }));

test("v0.5 live D/E/F: no tournament fails L2, L3 and L5 and leaves L6 NOT RUN; a single-candidate delivery never satisfies L6; only the selected, revalidated winner's exact tree does",
  async () => {
    const { judgeL2, judgeL3, judgeL5, judgeL6, overall, tournamentDeliverable } = await verdicts();
    // D, E — the first live run: a single-candidate build that was delivered and applied.
    const single = { route: { route: "single", candidates: 1, source: "policy" }, deliveryId: "d-000000000000000000000001", tournament: null };
    const applied = { ran: true, id: single.deliveryId, approved: true, state: "applied", patchSha256: "e".repeat(64) };
    const results = [judgeL2(single), judgeL3(single), judgeL5(single), judgeL6(single, applied, true)];
    assert.deepEqual(results.map(r => r.status), ["FAIL", "FAIL", "FAIL", "NOT RUN"]);
    assert.equal(tournamentDeliverable(single), false, "the runner never offers a single-candidate delivery for L6");
    assert.equal(overall([{ status: "PASS" }, ...results, { status: "PASS" }], []), "FAIL");
    // F — a tournament winner: only its exact, revalidated, approved and applied tree passes.
    const rev = "a".repeat(64), patch = "c".repeat(64);
    const facts = { route: { route: "tournament", candidates: 2, source: "human" }, deliveryId: "d-000000000000000000000002",
      tournament: { resolved: true, reason: null, candidates: [], reasons: [], selectedPatchSha256: patch,
        decided: { outcome: "DELIVERY_ELIGIBLE", selected: "c2", selectedRevision: rev, chosenBy: "fusion" },
        revalidation: { candidate: "c2", revision: rev, deliverable: true } } };
    const delivered = { ran: true, id: facts.deliveryId, approved: true, state: "applied", patchSha256: patch };
    assert.equal(tournamentDeliverable(facts), true);
    assert.equal(judgeL6(facts, delivered, true).status, "PASS");
    assert.equal(judgeL6(facts, { ...delivered, patchSha256: "f".repeat(64) }, true).status, "FAIL", "another tree than the selected candidate's");
    assert.equal(judgeL6(facts, { ...delivered, id: "d-000000000000000000000009" }, true).status, "FAIL", "another delivery than the run's");
    assert.equal(judgeL6(facts, { ...delivered, state: "approved" }, true).status, "FAIL", "not applied");
    assert.equal(judgeL6(facts, delivered, false).status, "FAIL", "the fixture's check failed");
    assert.equal(judgeL6(facts, { ...delivered, approved: false, state: "prepared" }, true).status, "REVIEW", "you declined");
    assert.equal(judgeL6(facts, { ran: false }, true).status, "FAIL", "a deliverable winner must be offered");
    const unrevalidated = { ...facts, tournament: { ...facts.tournament, revalidation: null } };
    assert.equal(tournamentDeliverable(unrevalidated), false);
    assert.notEqual(judgeL6(unrevalidated, delivered, true).status, "PASS", "never without the fresh revalidation");
    const otherRevision = { ...facts, tournament: { ...facts.tournament, revalidation: { candidate: "c2", revision: "b".repeat(64), deliverable: true } } };
    assert.equal(tournamentDeliverable(otherRevision), false, "a revalidation of another revision does not count");
    // L5 edges.
    assert.equal(judgeL5(facts).status, "PASS");
    assert.equal(judgeL5({ ...facts, tournament: { ...facts.tournament, decided: { outcome: "MULTIPLE_VERIFIED_CANDIDATES", tied: ["c1", "c2"] }, revalidation: null } }).status, "REVIEW");
    assert.equal(judgeL5({ ...facts, tournament: { ...facts.tournament, resolved: false, reason: "two decisions" } }).status, "FAIL");
    assert.equal(judgeL5(unrevalidated).status, "FAIL");
  });

test("v0.5 live H: empty or stray input authorizes nothing — not the build, not a tie choice", async () => {
  const { issueWriterRunAuthorization, issueConfirmedPlanAuthorization } = await import("../src/app/writer-gate.js");
  const { tieChooser } = await import("../src/cli/build-flow.js");
  const request = { task: LOW_TASK, paths: ["src/quote.ts"], repositoryRoot: REPO, candidates: 2 };
  for (const typed of [null, "", "   ", "\n", "y", "yes", "build now", "b uild"])
    assert.equal(issueWriterRunAuthorization({ ...request, typed }), undefined, JSON.stringify(typed));
  assert.ok(issueWriterRunAuthorization({ ...request, typed: " Build " }), "only the confirmation word itself");
  for (const answer of [null, "", " ", "n", "ok"]) assert.equal(issueConfirmedPlanAuthorization({ ...request, answer }), undefined, JSON.stringify(answer));
  for (const [answer, chosen] of [["", undefined], ["  ", undefined], ["yes", undefined], ["c3", undefined], [null, undefined], ["c2", "c2"], [" C1 ", "c1"]] as const) {
    const choose = tieChooser({ interactive: true, prompt: async () => answer }, () => undefined)!;
    assert.equal(await choose({ tournamentId: "t-1", candidates: ["c1", "c2"], differences: [], inconclusive: false }), chosen, JSON.stringify(answer));
  }
  assert.equal(tieChooser({ interactive: false }, () => undefined), undefined, "without a human at a terminal there is no tie choice at all");
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

test("v0.5 live B/G: the L2–L6 scenario asks for exactly 2 candidates explicitly; every question, digest and choice is the maintainer's", async () => {
  const source = await readFile(RUNNER, "utf8");
  // B — the explicit, host-owned count, in the build's own argv (a model never sees or changes it).
  assert.match(source, /const TOURNAMENT_BUILD = Object\.freeze\(\["build", "--candidates", "2", "--path", "configuration\.yaml", TOURNAMENT_TASK\]\);/u);
  assert.match(source, /const built = interactive\(repo, TOURNAMENT_BUILD\);/u);
  assert.match(source, /judgeL2\(facts, \{ source: "human", candidates: 2 \}\)/u);
  // G — build, approval and apply run at the maintainer's own terminal: the runner cannot type into them.
  assert.match(source, /const interactive = \(cwd, args\) => spawnSync\(process\.execPath, \[CLI, \.\.\.args\], \{ cwd, stdio: "inherit", windowsHide: true \}\)\.status;/u);
  assert.match(source, /interactive\(repo, \["approve-delivery", id\]\)/u);
  // Approval and apply are offered only for a selected, freshly revalidated tournament winner.
  assert.match(source, /if \(tournamentDeliverable\(facts\)\) \{/u);
  // The only writes to a child's stdin: the L1 shell's listed lines and the maintainer's own answers.
  const writes = [...source.matchAll(/child\.stdin\.write\(([^)]*)\)/gu)].map(m => m[1]);
  assert.deepEqual(writes, ["`${answer}\\n`", "`${answer || \"none\"}\\n`", "`${line}\\n`"]);
  assert.equal([...source.matchAll(/const answer = await askHuman\(/gu)].length, 2);
  assert.doesNotMatch(source, /"y"|'y'|`y`|\by\\n|"c1"|"c2"|--yes|manifestSha256\)/u, "no scripted approval, digest or choice");
  const typed = [...source.matchAll(/\[("[^\]]+")\]\);/gu)].flatMap(m => JSON.parse(`[${m[1]!}]`) as string[]);
  assert.ok(typed.length >= 2 && !typed.some(line => /^(?:y|yes|n|no|build|c[1-3]|none|[0-9a-f]{64})$/iu.test(line)), typed.join(" | "));

  const { PassThrough } = await import("node:stream");
  const { askHuman } = await import(script("v04-live-human.mjs")) as { askHuman(i: NodeJS.ReadableStream, o: NodeJS.WritableStream, q: string,
    options?: { settleMs?: number; maxAsks?: number; accept?: RegExp; again?: string }): Promise<string> };
  const input = new PassThrough(), output = new PassThrough();
  output.resume();
  const answer = askHuman(input, output, "Choose? ", { settleMs: 30, accept: /^(?:c1|c2|none)$/u, again: "again: " });
  await new Promise(resolve => setTimeout(resolve, 80));
  for (const line of ["", "yes", "c3", "c2"]) { input.write(`${line}\n`); await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.equal(await answer, "c2", "only an offered choice answers; an empty line or a yes is not a choice");
});
