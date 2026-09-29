import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { WriterRehearsal } from "../src/app/writer-rehearsal.js";
import { runCli } from "../src/cli/run.js";
import type { ChangeSet, DelegationPacket } from "../src/core/domain.js";
import { DiagnosticRedactor } from "../src/core/policy/redaction.js";
import type { CandidateId } from "../src/core/tournament/contracts.js";
import { proposalSha256 } from "../src/core/tournament/manifest.js";
import { STRATEGY_BRIEFS } from "../src/core/tournament/strategies.js";
import { EventStore } from "../src/platform/events/event-store.js";
import { RunStore } from "../src/platform/events/run-store.js";
import type { StoredEvent } from "../src/platform/events/types.js";
import { DockerLinuxVerificationBackend } from "../src/platform/verification/docker/backend.js";
import { VerificationService } from "../src/platform/verification/selection.js";
import { OFFLINE_REHEARSAL, PrivateCandidateWorkspacePort } from "../src/platform/workflow/candidates.js";
import { FAKE_DOCKER_EXE, FAKE_IMAGE, FakeDocker, type AttachContext } from "./fixtures/fake-docker.js";
import { changeSet, oracle, scriptedRoles, type Script, type Spy } from "./fixtures/fake-writer.js";
import { FAKE_DEPENDENCY_TREE, QUOTE_BUGGY, QUOTE_FIXED, QUOTE_TEST, QUOTE_TEST_WITH_REGRESSION, QUOTE_WRONG,
  REHEARSAL_PLAN } from "./fixtures/rehearsal-project.js";
import { gitAvailable, primaryEvidence, withRehearsalRepo, type RehearsalRepo } from "./fixtures/writer-rehearsal-harness.js";

/**
 * v0.5 — DETERMINISTIC TOURNAMENT ACCEPTANCE (A–L) through the product: `fusion build` on a real Git repository, the real
 * candidate port, the real Docker backend over the in-memory daemon, and scripted providers that are told apart only by the
 * strategy brief Fusion gave them. Nothing here depends on a real model making a mistake: every "bad" candidate is scripted,
 * and every decision is Fusion's, from host-observed evidence.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const MEDIUM = "Fix quote totals: tax applies to the discounted subtotal. Add a regression test.";
const LOW = "Fix quote totals: tax applies to the discounted subtotal.";
const FIXED_LINE = "basisPoints(subtotal - discount, quote.taxBasisPoints)";
const change = (quote: string, test = true): ChangeSet =>
  changeSet([["src/quote.ts", QUOTE_BUGGY, quote], ...(test ? [["test/quote.test.ts", QUOTE_TEST, QUOTE_TEST_WITH_REGRESSION] as const] : [])]);
const FIX = change(QUOTE_FIXED), WRONG = change(QUOTE_WRONG);
const ALT = change(QUOTE_FIXED.replace(FIXED_LINE, `${FIXED_LINE} /* discounted */`));
const API_BREAK = change(`${QUOTE_FIXED}export const leaked = 1;\n`);
const PADDED = change(`// Quote totals.\n${QUOTE_FIXED}`);
const briefOf = (packet: DelegationPacket): CandidateId | undefined =>
  (["c1", "c2", "c3"] as const).find(id => packet.task.constraints.includes(STRATEGY_BRIEFS[id].brief));

/** The confined guest: `unit` passes exactly when the tax applies to the discounted subtotal; `probe-api` prints the exports. */
function guest(options: Readonly<{ failFixedFrom?: number }> = {}): { attach: (context: AttachContext) => unknown; fixedRuns: () => number } {
  let fixedRuns = 0;
  const attach = oracle((command, context) => {
    const quote = context.files.get("src/quote.ts")?.toString("utf8") ?? "";
    const fixed = quote.includes(FIXED_LINE);
    if (command.id === "typecheck") { if (fixed) fixedRuns++; return { pass: true, stdout: "" }; }
    if (command.id === "unit") return (options.failFixedFrom !== undefined && fixed && fixedRuns >= options.failFixedFrom)
      ? { pass: false, stdout: "1 failing\n" } : { pass: fixed, stdout: fixed ? "all passing\n" : "1 failing\n" };
    if (command.id === "probe-api") return { pass: true, stdout: `${(quote.match(/export /gu) ?? []).length} exports\n` };
    return { pass: false, stdout: "unknown command\n" };
  });
  return { attach, fixedRuns: () => fixedRuns };
}
function seam(repoDir: string, script: Script, attach = guest().attach): { rehearsal: WriterRehearsal; spy: Spy } {
  const fake = new FakeDocker({ attach: attach as never, depsTree: FAKE_DEPENDENCY_TREE });
  const backend = new DockerLinuxVerificationBackend({ image: FAKE_IMAGE, runner: fake, resolveDocker: () => Promise.resolve(FAKE_DOCKER_EXE),
    dependencyStoreDirectory: join(repoDir, "dependency-store") });
  const { roles, spy } = scriptedRoles(script);
  return { spy, rehearsal: { roles, plan: REHEARSAL_PLAN, candidatePort: ({ primaryRoot, git, declaredPlatform }) => new PrivateCandidateWorkspacePort({
    primaryRoot, git, service: new VerificationService([backend]), confinement: OFFLINE_REHEARSAL, declaredPlatform, dependencies: "npm-lockfile",
    prepareDependencies: true }) } };
}
const byBrief = (changes: Readonly<Partial<Record<CandidateId, ChangeSet>>>, single: ChangeSet): Script["worker"] =>
  ({ packet }) => changes[briefOf(packet) ?? "c1"] ?? single;
const probeCommand = { executable: "/usr/local/bin/node", args: ["probe.js"], cwd: ".", timeoutMs: 30_000, mutationPolicy: "readOnly" };
const config = (extra: Record<string, unknown> = {}) => JSON.stringify({ schemaVersion: 1, bindings: [],
  verification: { commands: [], platformRequirement: "linux-compatible", ...extra } });
const REGISTRY = { defaults: { schemaVersion: 1 as const, bindings: [], verification: { commands: [] }, limits: { runTimeoutMs: 600_000 } },
  factories: new Map() };
interface Report { runId: string; outcome: { state: string; code: string; message: string };
  tournament?: { outcome: string; route: { candidates: number; source: string }; selected?: { id: string; revision: string; chosenBy: string };
    tied?: string[]; reasons: string[]; revalidation?: { passed: boolean };
    candidates: Array<{ id: string; state: string; decision?: string; failure?: string; detail: string; contradictions: string[]; mutations: { run: number; survived: number } }> } }
async function build(root: string, rehearsal: WriterRehearsal, task = MEDIUM, paths = ["src/quote.ts", "test/quote.test.ts"], extra: string[] = []) {
  let stdout = "", stderr = "";
  const code = await runCli(["--json", "build", ...extra, ...paths.flatMap(p => ["--path", p]), task],
    { stdout: t => { stdout += t; }, stderr: t => { stderr += t; } }, { env: process.env, cwd: root, registry: REGISTRY, writerRehearsal: rehearsal });
  return { code, stdout, stderr, report: (stdout.trim().startsWith("{") ? JSON.parse(stdout) : undefined) as Report | undefined };
}
async function events(root: string, runId: string): Promise<StoredEvent[]> {
  const list: StoredEvent[] = [];
  for await (const item of EventStore.read(join(root, ".fusion", "runs", runId), runId)) if ("event" in item) list.push(item.event);
  return list;
}
const states = (r: Report) => r.tournament?.candidates.map(c => [c.id, c.state]);
const withRepo = (config_: string, run: (repo: RehearsalRepo) => Promise<void>): Promise<void> =>
  withRehearsalRepo(run, { extraFiles: { "fusion.config.json": config_ } });

test("v0.5 black box A (simple task): the router keeps a low-risk change single — no tournament is started", { skip }, async () =>
  withRepo(config(), async repo => {
    const { rehearsal, spy } = seam(repo.dir, { worker: () => change(QUOTE_FIXED, false) });
    const ran = await build(repo.root, rehearsal, LOW, ["src/quote.ts"]);
    assert.equal(ran.report?.outcome.state, "COMPLETED", ran.stdout + ran.stderr);
    assert.equal(ran.report?.tournament, undefined);
    const log = await events(repo.root, ran.report!.runId);
    assert.deepEqual(log.filter(e => e.type === "RouteDecided").map(e => (e.payload as { route: string }).route), ["single"]);
    assert.equal(log.filter(e => e.type === "TournamentStarted" || e.scope !== undefined).length, 0);
    assert.equal(spy.proposals.length, 1, "one author, one proposal");
  }));

test("v0.5 black box B (clear winner): independent candidates — A fails Fusion's regression check, B passes and is selected", { skip }, async () =>
  withRepo(config(), async repo => {
    const { rehearsal, spy } = seam(repo.dir, { worker: byBrief({ c1: WRONG, c2: FIX }, FIX) });
    const { report } = await build(repo.root, rehearsal);
    assert.deepEqual([report?.tournament?.outcome, report?.tournament?.selected?.id], ["DELIVERY_ELIGIBLE", "c2"]);
    assert.deepEqual(states(report!), [["c1", "rejected"], ["c2", "deliveryEligible"]]);
    assert.match(report!.tournament!.candidates[0]!.detail, /^verificationPassed: /u, "rejected by Fusion's own check");
    // Independent: each author received only its own brief.
    for (const id of ["c1", "c2"] as const) assert.ok(spy.proposals.some(p => briefOf(p) === id), id);
    assert.ok(spy.proposals.every(p => ["c1", "c2"].filter(id => p.task.constraints.includes(STRATEGY_BRIEFS[id as CandidateId].brief)).length === 1));
  }));

test("v0.5 black box C (false model consensus): the models endorse the bad candidate and doubt the good one — Fusion's check decides", { skip }, async () =>
  withRepo(config(), async repo => {
    const { rehearsal } = seam(repo.dir, { worker: byBrief({ c1: WRONG, c2: FIX }, FIX),
      // The reviewer praises the wrong change and raises a doubt about the right one.
      reviewer: ({ request }) => JSON.stringify(request).includes("subtotal + tax") ? { findings: [], summary: "Correct and complete. Ship it." }
        : { findings: [{ id: "F1", severity: "LOW", confidence: "LOW", category: "style", title: "Prefer the other candidate's approach",
          file: "src/quote.ts", facts: [], source: "model", evidence: "", failureScenario: "none" }], summary: "The other approach looks better." } });
    const { report } = await build(repo.root, rehearsal);
    const c1 = report!.tournament!.candidates.find(c => c.id === "c1")!;
    assert.equal(c1.state, "rejected", "model endorsement never outranks a failed deterministic check");
    assert.match(c1.detail, /verificationPassed/u);
    assert.ok(report!.tournament!.selected?.id === "c2" || report!.outcome.state === "DECISION_REQUIRED", "the good candidate wins, or the decision blocks");
    assert.notEqual(report!.tournament!.selected?.id, "c1");
  }));

test("v0.5 black box D (differential discrimination): both pass the ordinary tests; Fusion's preservation probe exposes B; A survives", { skip }, async () =>
  withRepo(config({ experiments: { probes: [{ id: "api", command: probeCommand, expect: "baseline" }] } }), async repo => {
    const { rehearsal } = seam(repo.dir, { worker: byBrief({ c1: FIX, c2: API_BREAK }, FIX) });
    const { report } = await build(repo.root, rehearsal);
    assert.equal(report?.tournament?.selected?.id, "c1", JSON.stringify(report?.tournament));
    const c2 = report!.tournament!.candidates.find(c => c.id === "c2")!;
    assert.deepEqual([c2.state, c2.contradictions], ["rejected", ["probe:api"]]);
  }));

test("v0.5 black box E (mutation weakness): both pass; one candidate's checks miss a targeted mutation — recorded, and selection is deterministic",
  { skip }, async () => withRepo(config({ experiments: { mutation: { maxPerCandidate: 2 } } }), async repo => {
    const results: string[] = [];
    for (let round = 0; round < 2; round++) {
      const { rehearsal } = seam(repo.dir, { worker: byBrief({ c1: FIX, c2: PADDED }, FIX) });
      const { report, stdout, stderr } = await build(repo.root, rehearsal);
      assert.ok(report?.tournament, `${stdout}${stderr}`);
      const c2 = report!.tournament!.candidates.find(c => c.id === "c2")!;
      assert.deepEqual(c2.mutations, { run: 2, survived: 1 }, "the padding's revert is not detected: weaker proof, recorded");
      assert.deepEqual(report!.tournament!.candidates.find(c => c.id === "c1")!.mutations, { run: 1, survived: 0 });
      assert.match(report!.tournament!.reasons.join("\n"), /c1 dominates c2 by Fusion's evidence: fewer mutations its checks did not detect/u);
      results.push(`${report!.tournament!.selected?.id}:${states(report!)!.join(";")}`);
    }
    assert.equal(results[0], results[1], "the same evidence selects the same way");
    assert.match(results[0]!, /^c1:/u);
  }));

test("v0.5 black box F (protected file): an otherwise good candidate that touches a protected file is eliminated", { skip }, async () =>
  withRehearsalRepo(async repo => {
    const local = await readFile(join(repo.root, "config", "local.json"), "utf8");
    const touching = changeSet([["src/quote.ts", QUOTE_BUGGY, QUOTE_FIXED], ["test/quote.test.ts", QUOTE_TEST, QUOTE_TEST_WITH_REGRESSION],
      ["config/local.json", local, local.replace("\"debug\": false", "\"debug\": true")]]);
    const { rehearsal } = seam(repo.dir, { worker: byBrief({ c1: touching, c2: FIX }, FIX) });
    const { report, stdout, stderr } = await build(repo.root, rehearsal, MEDIUM, ["src/quote.ts", "test/quote.test.ts", "config/local.json"]);
    assert.equal(report?.tournament?.selected?.id, "c2", stdout + stderr);
    const c1 = report!.tournament!.candidates.find(c => c.id === "c1")!;
    assert.notEqual(c1.state, "deliveryEligible");
    assert.match(c1.detail, /protectedUnchanged/u);
  }, { extraFiles: { "fusion.config.json": JSON.stringify({ schemaVersion: 1, bindings: [], protection: { ignoredPaths: ["config/local.json"] },
    verification: { commands: [], platformRequirement: "linux-compatible" } }), "config/local.json": "{ \"debug\": false }\n" } }));

test("v0.5 black box G (tie): both objectively VERIFIED, no evidence dominance, no model winner — DECISION_REQUIRED", { skip }, async () =>
  withRepo(config(), async repo => {
    const { rehearsal } = seam(repo.dir, { worker: byBrief({ c1: FIX, c2: ALT }, FIX) });
    const ran = await build(repo.root, rehearsal);
    assert.deepEqual([ran.report?.outcome.state, ran.report?.outcome.code, ran.code], ["DECISION_REQUIRED", "MULTIPLE_VERIFIED_CANDIDATES", 13]);
    assert.deepEqual([ran.report?.tournament?.tied, ran.report?.tournament?.selected], [["c1", "c2"], undefined]);
  }));

test("v0.5 black box H (revalidation failure): the selected candidate fails its fresh reconstruction — no delivery, never retried", { skip }, async () =>
  withRepo(config(), async repo => {
    const g = guest({ failFixedFrom: 2 });
    const { rehearsal } = seam(repo.dir, { worker: byBrief({ c1: WRONG, c2: FIX }, FIX) }, g.attach);
    const { report } = await build(repo.root, rehearsal);
    assert.deepEqual([report?.tournament?.outcome, report?.outcome.state, report?.tournament?.revalidation?.passed],
      ["REVALIDATION_MISMATCH", "DECISION_REQUIRED", false]);
    assert.equal(g.fixedRuns(), 2, "one judged run and exactly one revalidation of the fixed tree");
    assert.equal((report as { delivery?: unknown }).delivery, undefined);
  }));

test("v0.5 black box I (revision binding): a candidate's corrected change is its own revision — the earlier patch's evidence supports nothing",
  { skip }, async () => withRepo(config({ experiments: { probes: [{ id: "api", command: probeCommand, expect: "baseline" }] } }), async repo => {
    const calls = new Map<string, number>();
    const worker: Script["worker"] = ({ packet }) => {
      const id = briefOf(packet) ?? "c1", n = (calls.get(id) ?? 0) + 1;
      calls.set(id, n);
      return id === "c2" && n > 1 ? FIX : WRONG;
    };
    const { rehearsal } = seam(repo.dir, { worker });
    const { report } = await build(repo.root, rehearsal);
    assert.equal(report?.tournament?.selected?.id, "c2", JSON.stringify(report?.tournament));
    const store = await RunStore.open(repo.root, report!.runId, new DiagnosticRedactor());
    const decided = (await events(repo.root, report!.runId)).find(e => e.type === "TournamentDecided")!;
    const artifact = JSON.parse(await readFile(await (await store.openArtifacts()).getArtifactPath((decided.payload as { artifactRef: string }).artifactRef), "utf8")) as
      { candidates: Array<{ id: string; manifest: { proposalSha256: string } | null; nodes: Array<{ id: string; result: string }> }> };
    const c2 = artifact.candidates.find(c => c.id === "c2")!;
    assert.equal(c2.manifest?.proposalSha256, proposalSha256(FIX), "the manifest binds the corrected change");
    assert.notEqual(c2.manifest?.proposalSha256, proposalSha256(WRONG));
    assert.deepEqual(c2.nodes.map(n => [n.id, n.result]), [["probe:api", "pass"]], "Fusion's experiment ran on the corrected tree");
    const evaluated = (await events(repo.root, report!.runId)).filter(e => e.type === "TournamentCandidateEvaluated" && e.scope?.candidate === "c2");
    assert.deepEqual(evaluated.map(e => e.scope?.revision), [report!.tournament!.selected!.revision], "one evaluation, bound to the final revision");
  }));

test("v0.5 black box J (budget): more candidates or attempts than the budget are refused — never expanded", { skip }, async () =>
  withRepo(config(), async repo => {
    const over = seam(repo.dir, { worker: () => FIX });
    const refused = await build(repo.root, over.rehearsal, MEDIUM, ["src/quote.ts", "test/quote.test.ts"], ["--candidates", "4"]);
    assert.equal(refused.code, 2);
    assert.equal(over.spy.proposals.length + over.spy.plans.length, 0, "refused before any model turn");
    const calls = new Map<string, number>();
    const stubborn = seam(repo.dir, { worker: ({ packet }) => { const id = briefOf(packet) ?? "c1"; calls.set(id, (calls.get(id) ?? 0) + 1); return WRONG; } });
    const { report } = await build(repo.root, stubborn.rehearsal);
    assert.equal(report?.tournament?.outcome, "NO_VERIFIED_CANDIDATE");
    assert.ok([...calls.values()].every(n => n <= 2), `each candidate stays within its attempt budget (${JSON.stringify([...calls])})`);
    assert.equal(calls.size, 2, "no extra candidate is spawned");
  }));

test("v0.5 black box K (primary checkout): byte and tree identity unchanged throughout a tournament", { skip }, async () =>
  withRepo(config({ experiments: { probes: [{ id: "api", command: probeCommand, expect: "baseline" }], mutation: { maxPerCandidate: 2 } } }), async repo => {
    const { rehearsal } = seam(repo.dir, { worker: byBrief({ c1: WRONG, c2: FIX }, FIX) });
    const { report } = await build(repo.root, rehearsal);
    assert.equal(report?.tournament?.outcome, "DELIVERY_ELIGIBLE");
    assert.deepEqual(await primaryEvidence(repo.root), repo.before, "the primary is byte-identical, its Git state unchanged");
  }));

test("v0.5 black box L (provider failure): one candidate's author dies — bounded handling, no unsupported winner", { skip }, async () =>
  withRepo(config(), async repo => {
    const { rehearsal } = seam(repo.dir, { worker: ({ packet }) => { if (briefOf(packet) === "c1") throw new Error("provider process died"); return FIX; } });
    const { report } = await build(repo.root, rehearsal);
    const c1 = report!.tournament!.candidates.find(c => c.id === "c1")!;
    assert.deepEqual([c1.state, c1.failure], ["failed", "provider"]);
    assert.equal(report?.tournament?.selected?.id, "c2");
    const dead = seam(repo.dir, { worker: () => { throw new Error("provider process died"); } });
    const none = await build(repo.root, dead.rehearsal);
    assert.deepEqual([none.report?.tournament?.outcome, none.report?.tournament?.selected], ["PROVIDER_FAILURE", undefined], "no author, no winner");
  }));
