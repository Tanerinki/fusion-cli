import assert from "node:assert/strict";
import { copyFile, link, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileSha256 } from "../src/app/executable-identity.js";
import { routeLedger, runRouteRehearsal, routeFixtureIdentity, type RouteAuthorization, type RouteReport } from "../src/app/route-probe.js";
import { REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport, writerReadiness } from "../src/app/writer-gate.js";
import type { AdjudicationRequest, ChangeProposalRequest, DelegationPacket } from "../src/core/domain.js";
import { packetEnvelope, structuredEnvelope } from "../src/providers/claude/one-shot-transport.js";
import { VERIFIED_EXEC_WEB_DISABLE_VERSION } from "../src/providers/muse/types.js";
import { MUSE_1_4_REVIEWER, PROPOSAL_PROBE_PROFILES, REVIEWER_PROBE_PROFILES, ROUTE_REHEARSAL_PROFILES } from "../src/providers/probe-profiles.js";
import { defaultRegistry } from "../src/providers/registry.js";
import { bindingValidation, fullRouteLiveRecords, isValidatedForBinding, isValidatedRuntimeVersion, leadPlanLiveRecords, reviewerLiveRecords,
  transportProfile, type BindingValidation } from "../src/runtime/provider-profiles.js";
import { withRoot } from "./fixtures/probe-harness.js";
import { installMuseVersion, withInstalls, type Installs } from "./fixtures/provider-installs.js";
import { RELEASE, releaseExe } from "./fixtures/reviewer-harness.js";
import { adjudication, asRun, cleanReview, fenced, LEAD_SECRET, plan, PREFIX, proposal, reviewWith, routeEnv, runRoute, sectionOf,
  testRouteAuthorization, WORKER_SECRET, type RoleScripts, type RouteRegistryOptions } from "./fixtures/route-harness.js";
import { FIX, FIX_ONLY, gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5B25 Stage 1 — the first new full-route live rehearsal authorization after O5.5B24: Claude Code 2.1.280 haiku/low for
 * the Lead (plan, adjudication) and the Change Author, the fresh Reviewer exactly the O5.5B24-validated Muse 1.4 binding
 * and binary. Offline only: the production entry is never run; a TEST copy of its exact shape runs on the fake binaries
 * (the Reviewer's fake installed as 1.4.0-R4161.1, its bytes standing in for the validated binary through the test seams).
 */
const skip = gitAvailable ? false : "git executable unavailable";
const ID = "O5.5B25-LIVE";
const B25 = ROUTE_REHEARSAL_PROFILES.authorizations[ID]!;
const [VALIDATION] = transportProfile("muse", "muse-exec")!.bindingValidations;
type Turn = { claim: string; turn: string; slot: number; role: string; contract: string; outcome: string; sessionId: string | null;
  structuredOutput: Record<string, unknown> | null; terminal: Record<string, unknown> | null };
type Launch = { purpose: string; turn: string; executable: string; args: string[]; identityGaps?: string[]; posture?: { missing: string[]; widening: string[] };
  refusedBeforeStart?: string };

/** The O5.5B25 shape on the fake installs: the Reviewer re-pinned to the fake 1.4 binary's location and bytes. */
async function b25(i: Installs, patch: Partial<RouteAuthorization> = {}): Promise<Readonly<{ authorization: RouteAuthorization; registry: RouteRegistryOptions }>> {
  await installMuseVersion(i, RELEASE);
  const sha = await fileSha256(releaseExe(i));
  const reviewer = { ...B25.roles.Reviewer, executableDirectory: i.museDir, executableSha256: sha,
    binding: { ...B25.roles.Reviewer.binding, options: { ...B25.roles.Reviewer.binding.options, timeoutMs: 20_000 } } };
  const validations: readonly BindingValidation[] = [{ ...VALIDATION!, executableSha256: sha }];
  return { authorization: testRouteAuthorization(i, { milestone: "TEST", turns: B25.turns, ...patch }, { Reviewer: reviewer }),
    registry: { museBindingValidations: validations, museExecutable: releaseExe(i) } };
}
const route = async (i: Installs, dir: string, name: string, scripts: RoleScripts, patch: Partial<RouteAuthorization> = {},
  registry?: Partial<RouteRegistryOptions>, extra?: Parameters<typeof runRoute>[4]) => {
  const shape = await b25(i, patch);
  return runRoute(i, dir, name, scripts, { authorization: shape.authorization, registry: { ...shape.registry, ...registry }, ...extra });
};
const turnsOf = (run: ReturnType<typeof asRun>) => sectionOf<Record<string, number>>(run, "turnUse");
const HAPPY: RoleScripts = { Lead: [{ prefix: PREFIX.plan, output: plan() }], Worker: [proposal(FIX)],
  Reviewer: [{ prefix: PREFIX.review, output: cleanReview, excludes: [LEAD_SECRET, WORKER_SECRET] }] };

test("O5.5B25 authorization: the four intended bindings exactly, the engine's bounds, the pinned fixture, its own namespace — never run by a test",
  async () => withRoot(async dir => {
    // Stage 1 prepared it open; it ran once live (Stage 2): consumed.
    assert.deepEqual([B25.milestone, B25.evidenceDirectory, B25.state], ["O5.5B25", "fusion-o5-5b25-route", "consumed"]);
    const claude = { family: "claude", executable: "claude.exe", runtimeVersions: ["2.1.280"], lanes: ["subscription", "subscriptionToken"],
      binding: { adapter: "claude-one-shot", model: "haiku", effort: "low", maxTurns: 6, options: { canonicalModel: "claude-haiku-4-5-20251001", timeoutMs: 180_000 } },
      turnArgs: [["--model", "haiku"], ["--effort", "low"], ["--max-turns", "6"]], requiredEnvironment: ["FUSION_CLAUDE_EXE"] };
    for (const role of ["Lead", "Worker"] as const) {
      assert.deepEqual(JSON.parse(JSON.stringify(B25.roles[role])), claude, role);
      assert.deepEqual(B25.roles[role], ROUTE_REHEARSAL_PROFILES.authorizations["O5.5B13-LIVE"]!.roles[role], `${role}: the route's established binding`);
    }
    assert.equal(B25.roles.Reviewer, MUSE_1_4_REVIEWER, "the Reviewer is exactly the O5.5B24-validated binding and binary");
    assert.deepEqual({ ...B25.turns }, { leadPlan: 1, changeAuthor: 2, freshReview: 2, leadAdjudication: 2 });
    assert.equal(B25.fixtureSha256, routeFixtureIdentity());
    const namespaces = [...Object.entries(ROUTE_REHEARSAL_PROFILES.authorizations).filter(([id]) => id !== ID).map(([, entry]) => entry.evidenceDirectory),
      ...Object.values(PROPOSAL_PROBE_PROFILES.authorizations).map(entry => entry.evidenceDirectory),
      ...Object.values(REVIEWER_PROBE_PROFILES.authorizations).map(entry => entry.evidenceDirectory)];
    assert.ok(!namespaces.includes(B25.evidenceDirectory));
    // Never run by a test: consumed it refuses before anything exists; open, it refused inside an agent session.
    const root = join(dir, "never-created");
    const consumed = await runRouteRehearsal({ env: routeEnv(), registry: defaultRegistry(), profiles: ROUTE_REHEARSAL_PROFILES, authorization: ID, evidenceRoot: root });
    assert.ok("refused" in consumed && consumed.reason === "authorizationConsumed", JSON.stringify(consumed));
    const refused = await runRouteRehearsal({ env: { ...routeEnv(), CLAUDECODE: "1" }, registry: defaultRegistry(), authorization: ID, evidenceRoot: root,
      profiles: { ...ROUTE_REHEARSAL_PROFILES, authorizations: { ...ROUTE_REHEARSAL_PROFILES.authorizations, [ID]: { ...B25, state: "open" } } } });
    assert.ok("refused" in refused && refused.reason === "nestedAgentSession", JSON.stringify(refused));
  }));

test("O5.5B25 Reviewer: Muse 1.4.0-R4161.1 validated for exactly this binding (O5.5B24) — the release, the binary and nothing wider", () => {
  const reviewer = B25.roles.Reviewer;
  const facts = { role: "Reviewer", model: reviewer.binding.model, effort: reviewer.binding.effort, options: { ...reviewer.binding.options } };
  assert.deepEqual([reviewer.runtimeVersions, reviewer.executable, reviewer.executableSha256], [[RELEASE], VALIDATION!.executable, VALIDATION!.executableSha256]);
  assert.equal(bindingValidation("muse", "muse-exec", RELEASE, facts)?.milestone, "O5.5B24");
  assert.equal(isValidatedForBinding("muse", "muse-exec", RELEASE, facts), true);
  assert.equal(isValidatedRuntimeVersion("muse", "muse-exec", RELEASE), false, "not transport-wide");
  assert.deepEqual(reviewerLiveRecords().map(r => [r.milestone, r.outcome]), [["O5.5B24", "PASS"]]);
  assert.deepEqual(reviewer.turnArgs!.map(pair => [...pair]), [["--provider", "meta"], ["--model", "muse-spark-1.3"], ["--reasoning-effort", "low"],
    ["--max-model-steps", "4"]]);
  assert.equal(reviewer.binding.options!.malformedOutputRetries, 0, "no retry");
});

test("O5.5B25 envelopes: Lead plan and adjudication and the Change Author read one outer fence; the Reviewer stays raw-only", () => {
  assert.equal(packetEnvelope("plan").policy, "rawOrSingleJsonFence");
  assert.equal(structuredEnvelope({ kind: "changeProposal", packet: {} as DelegationPacket } as ChangeProposalRequest).policy, "rawOrSingleJsonFence");
  assert.equal(structuredEnvelope({ kind: "adjudication", findings: [] } as unknown as AdjudicationRequest).policy, "rawOrSingleJsonFence");
  assert.equal(structuredEnvelope({ kind: "review", limits: { maxFindings: 5 } } as never).policy, "rawOnly");
  assert.deepEqual([transportProfile("muse", "muse-exec")!.changeProposalEnvelope, transportProfile("muse", "muse-exec")!.adjudicationEnvelope], ["rawOnly", "rawOnly"]);
});

test("O5.5B25 happy path (fake): Lead plan, Change Author and fresh Reviewer once each — no adjudication without findings; diagnostics per role; no text",
  { skip }, async () => withInstalls(async i => withRoot(async dir => {
    const run = asRun(await route(i, dir, "happy", HAPPY));
    assert.equal(run.report.outcome, "PASS", run.report.detail);
    assert.deepEqual(turnsOf(run), { leadPlan: 1, changeAuthor: 1, freshReview: 1, leadAdjudication: 0 }, "only the turns the engine's state required");
    assert.deepEqual(sectionOf<Record<string, number>>(run, "unusedSlots"), { leadPlan: 0, changeAuthor: 1, freshReview: 1, leadAdjudication: 2 });
    assert.deepEqual((await routeLedger(run.root)).map(entry => `${String(entry.turn)}#${String(entry.slot)}`), ["leadPlan#1", "changeAuthor#1", "freshReview#1"]);
    // Every role can start, so every role was preflighted — the Reviewer's validated binary included.
    const preflight = sectionOf<Record<string, Record<string, unknown>>>(run, "preflight");
    assert.deepEqual(["Lead", "Worker", "Reviewer"].map(role => preflight[role]!.active), [true, true, true]);
    assert.deepEqual([preflight.Reviewer!.installedVersion, preflight.Reviewer!.validatedForBinding, preflight.Reviewer!.executableIdentity],
      [RELEASE, { release: RELEASE, milestone: "O5.5B24" }, { basename: `muse-bin-${RELEASE}.exe`, locationMatches: true, sha256Matches: true }]);
    assert.deepEqual(sectionOf<Record<string, unknown>>(run, "executableIdentityAfter"), { Reviewer: { sha256Matches: true } });
    // The Lead plans under the O5.5B16 planning prompt with --max-turns 6; every model process carries its exact identity.
    assert.ok(run.prompts.Lead[0]!.startsWith("You are the planning Lead for this delegated task."));
    const launches = sectionOf<Launch[]>(run, "launches").filter(l => l.purpose === "providerTurn");
    assert.deepEqual(launches.map(l => [l.turn, l.executable, l.identityGaps, l.posture]), [
      ["leadPlan#1", launches[0]!.executable, [], { missing: [], widening: [] }], ["changeAuthor#1", launches[1]!.executable, [], { missing: [], widening: [] }],
      ["freshReview#1", `muse-bin-${RELEASE}.exe`, [], { missing: [], widening: [] }]]);
    assert.equal(launches[0]!.args[launches[0]!.args.indexOf("--max-turns") + 1], "6");
    // Bounded diagnostics for every role turn: envelope classes and terminal classes, never text.
    const turns = sectionOf<Turn[]>(run, "turns");
    assert.deepEqual(turns.map(t => [t.turn, t.contract, t.structuredOutput?.policy, t.structuredOutput?.classification, t.structuredOutput?.accepted,
      t.terminal?.classification, t.terminal?.structuredParsingReached, t.terminal?.schemaValidationReached]), [
      ["leadPlan", "accepted", "rawOrSingleJsonFence", "RAW_VALID_JSON", true, "RESULT_OK", true, true],
      ["changeAuthor", "validated", "rawOrSingleJsonFence", "SINGLE_FENCED_VALID_JSON", true, "RESULT_OK", true, true],
      ["freshReview", "accepted:0 finding(s)", "rawOnly", "RAW_VALID_JSON", true, "RESULT_OK", true, true]]);
    assert.deepEqual(sectionOf<{ unchanged: boolean; canariesUnchanged: boolean }>(run, "primary").unchanged, true);
    assert.deepEqual(sectionOf<{ leftoverOwnedTemporaries: string[] }>(run, "cleanup").leftoverOwnedTemporaries, []);
    const text = await readFile(run.report.evidencePath, "utf8");
    for (const secret of [LEAD_SECRET, WORKER_SECRET, "No defect found.", "a full discount leaves nothing to tax", "synthetic-not-a-secret-7a31"])
      assert.ok(!text.includes(secret), `evidence leaks ${secret}`);
    assert.equal(run.report.evidence.evidenceKind, "offlineRehearsal");
  })));

test("O5.5B25 adjudication only when the review has findings, read under the single-fence envelope; the Reviewer stays fresh", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    const verdict = { adjudications: [{ findingId: "r1-F1", verdict: "REJECTED", rationale: "Covered by the existing tests.", requiredAction: "none" }], summary: "" };
    const run = asRun(await route(i, dir, "adjudicate", { Lead: [{ prefix: PREFIX.plan, output: plan() }, { prefix: PREFIX.adjudication, output: fenced(verdict) }],
      Worker: [proposal(FIX)], Reviewer: [{ prefix: PREFIX.review, output: reviewWith({ id: "F1", severity: "HIGH" }), excludes: [LEAD_SECRET, WORKER_SECRET] }] }));
    assert.equal(run.report.outcome, "PASS", run.report.detail);
    assert.deepEqual(turnsOf(run), { leadPlan: 1, changeAuthor: 1, freshReview: 1, leadAdjudication: 1 });
    const turns = sectionOf<Turn[]>(run, "turns");
    const judged = turns.find(t => t.turn === "leadAdjudication")!;
    assert.deepEqual([judged.contract, judged.structuredOutput?.policy, judged.structuredOutput?.classification, judged.structuredOutput?.accepted],
      ["accepted:1 verdict(s)", "rawOrSingleJsonFence", "SINGLE_FENCED_VALID_JSON", true]);
    assert.equal(turns.find(t => t.turn === "freshReview")!.structuredOutput?.policy, "rawOnly");
    assert.ok(!(await readFile(run.report.evidencePath, "utf8")).includes("Covered by the existing tests."));
  })));

test("O5.5B25 correction within the engine's limits: one correction cycle at most; a finding that survives it stops — never a third turn", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    const finding = { prefix: PREFIX.review, output: reviewWith({ id: "F1", severity: "HIGH" }) };
    const corrected = asRun(await route(i, dir, "corrected", {
      Lead: [{ prefix: PREFIX.plan, output: plan() }, { prefix: PREFIX.adjudication, output: adjudication(["r1-F1", "CONFIRMED", "fix"]) }],
      Worker: [proposal(FIX_ONLY), proposal(FIX)], Reviewer: [finding, { prefix: PREFIX.review, output: cleanReview }] }));
    assert.equal(corrected.report.outcome, "PASS", corrected.report.detail);
    assert.deepEqual(turnsOf(corrected), { leadPlan: 1, changeAuthor: 2, freshReview: 2, leadAdjudication: 1 });
    const stuck = asRun(await route(i, dir, "stuck", {
      Lead: [{ prefix: PREFIX.plan, output: plan() }, { prefix: PREFIX.adjudication, output: adjudication(["r1-F1", "CONFIRMED", "fix"]) },
        { prefix: PREFIX.adjudication, output: adjudication(["r2-F1", "CONFIRMED", "fix"]) }],
      Worker: [proposal(FIX_ONLY), proposal(FIX_ONLY), proposal(FIX)], Reviewer: [finding, finding, finding] }));
    assert.ok(["FINDINGS_UNRESOLVED", "DECISION_REQUIRED"].includes(stuck.report.outcome), `${stuck.report.outcome}: ${stuck.report.detail}`);
    assert.deepEqual(turnsOf(stuck), { leadPlan: 1, changeAuthor: 2, freshReview: 2, leadAdjudication: 2 }, "every class within its bound");
    assert.deepEqual([stuck.prompts.Worker.length, stuck.prompts.Reviewer.length], [2, 2], "no third Change Author or review turn reached a provider");
  })));

test("O5.5B25 exhausted budget: a turn beyond the authorization never reaches a provider", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    const finding = { prefix: PREFIX.review, output: reviewWith({ id: "F1", severity: "HIGH" }) };
    const run = asRun(await route(i, dir, "exhausted", {
      Lead: [{ prefix: PREFIX.plan, output: plan() }, { prefix: PREFIX.adjudication, output: adjudication(["r1-F1", "CONFIRMED", "fix"]) }],
      Worker: [proposal(FIX_ONLY), proposal(FIX)], Reviewer: [finding, { prefix: PREFIX.review, output: cleanReview }] },
      { turns: { ...B25.turns, freshReview: 1 } }));
    assert.deepEqual([run.report.outcome, run.report.detail], ["TURN_REFUSED",
      "a role turn was refused before it reached the provider: freshReview budget of 1 is exhausted"]);
    assert.equal(run.prompts.Reviewer.length, 1, "the Reviewer's fake saw exactly one model turn");
    assert.equal(sectionOf<Launch[]>(run, "launches").filter(l => l.purpose === "providerTurn" && l.turn.startsWith("freshReview")).length, 1);
  })));

test("O5.5B25 preflight: the Reviewer must be the validated Muse 1.4 binary — another release, other bytes or another path are refused", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    const noClaim = async (report: RouteReport, name: string) => {
      assert.equal((await import("node:fs")).existsSync(join(dir, name, "route.claim.json")), false, `${name}: nothing consumed`);
      assert.equal(report.modelTurns, 0, `${name}: no model turn`);
    };
    const bytes = asRun(await route(i, dir, "bytes", HAPPY, { roles: { ...(await b25(i)).authorization.roles,
      Reviewer: { ...(await b25(i)).authorization.roles.Reviewer, executableSha256: "0".repeat(64) } } }));
    assert.deepEqual([bytes.report.outcome, bytes.report.detail], ["VERSION_BLOCKED", "Reviewer: the executable's SHA-256 differs from the authorized one"]);
    await noClaim(bytes.report, "bytes");
    // Without the re-pinned validation the adapter sees other bytes than the validated binary: its facts stay unknown.
    const unvalidated = asRun(await route(i, dir, "unvalidated", HAPPY, {}, { museBindingValidations: [VALIDATION!] }));
    assert.equal(unvalidated.report.outcome, "POSTURE_BLOCKED", unvalidated.report.detail);
    assert.match(unvalidated.report.detail, /^Reviewer: review /u);
    await noClaim(unvalidated.report, "unvalidated");
    // The same name in another directory: refused before the process starts.
    const elsewhere = join(i.dir, "elsewhere");
    await mkdir(elsewhere);
    const copy = join(elsewhere, `muse-bin-${RELEASE}.exe`);
    try { await link(releaseExe(i), copy); } catch { await copyFile(releaseExe(i), copy); }
    const moved = asRun(await route(i, dir, "moved", HAPPY, {}, { museExecutable: copy }));
    assert.equal(moved.report.outcome, "VERSION_BLOCKED", moved.report.detail);
    assert.match(moved.report.detail, /another executable than the authorized one/u);
    assert.equal(sectionOf<Launch[]>(moved, "launches").filter(l => l.executable === `muse-bin-${RELEASE}.exe` && l.refusedBeforeStart === undefined).length, 0);
    // No fallback: with the selector back at the validated 1.3, the Reviewer is refused (1.4 is the only authorized release).
    await installMuseVersion(i, VERIFIED_EXEC_WEB_DISABLE_VERSION);
    const shape = await b25(i);
    await installMuseVersion(i, VERIFIED_EXEC_WEB_DISABLE_VERSION);
    const fallback = asRun(await runRoute(i, dir, "fallback", HAPPY, { authorization: shape.authorization, registry: shape.registry }));
    assert.deepEqual([fallback.report.outcome, fallback.report.detail], ["VERSION_BLOCKED",
      `Reviewer: installed ${VERIFIED_EXEC_WEB_DISABLE_VERSION} is not the authorized release (${RELEASE})`]);
    await noClaim(fallback.report, "fallback");
  })));

test("O5.5B25 integrity: a provider touching the primary or its view is caught; nothing after it runs", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    const view = asRun(await route(i, dir, "view", { ...HAPPY, Reviewer: [{ prefix: PREFIX.review, output: cleanReview, scenario: "mutate" }] }));
    assert.equal(view.report.outcome, "VIEW_MUTATED", view.report.detail);
    assert.equal(sectionOf<{ unchanged: boolean }>(view, "primary").unchanged, true);
    const primary = asRun(await route(i, dir, "primary", { Lead: [{ prefix: PREFIX.plan, output: plan(), scenario: "touchPrimary" }], Worker: [proposal(FIX)] },
      {}, {}, { extra: { Lead: { FUSION_FAKE_EVIDENCE_ROOT: join(dir, "primary") } } }));
    assert.equal(primary.report.outcome, "PRIMARY_MUTATED", primary.report.detail);
    assert.deepEqual(turnsOf(primary), { leadPlan: 1, changeAuthor: 0, freshReview: 0, leadAdjudication: 0 }, "no role runs after a primary change");
  })));

test("O5.5B25 readiness: the live run is recorded as a failure — nothing advances; nothing is open", () => {
  assert.deepEqual(Object.entries(ROUTE_REHEARSAL_PROFILES.authorizations).filter(([id, entry]) => entry.state === "open" && id !== "O5.5B27-LIVE").map(([id]) => id), []);
  assert.ok(Object.entries(REVIEWER_PROBE_PROFILES.authorizations).filter(([id]) => id !== "V0.3-MUSE-R4302-REVIEWER").map(([, entry]) => entry).every(entry => entry.state !== "open"), "only the v0.3 Reviewer authorization may be open");
  assert.ok(Object.values(PROPOSAL_PROBE_PROFILES.authorizations).every(entry => entry.state === "consumed"));
  assert.deepEqual(fullRouteLiveRecords().slice(0, 2).map(r => [r.milestone, r.outcome, r.endedAt]),
    [["O5.5B13", "PROVIDER_FAILED", "leadPlan#1"], ["O5.5B25", "MALFORMED_OUTPUT", "changeAuthor#1"]]);
  assert.equal(fullRouteLiveRecords().find(r => r.milestone === "O5.5B25")!.outcome, "MALFORMED_OUTPUT", "not a full-route pass");
  assert.deepEqual(leadPlanLiveRecords().map(r => [r.milestone, r.outcome]), [["O5.5B15", "FAIL"], ["O5.5B17", "FAIL"], ["O5.5B21", "PASS"]]);
  const report = writerGateReport();
  const rows = Object.fromEntries(report.rows.map(row => [row.id, [row.state, row.evidenceKind]]));
  assert.deepEqual([rows.fullRouteLive, rows.hostControlledWriterWorkflow, rows.providerChangeProposal, rows.reviewAndAdjudication, rows.liveGateAuthorization],
    [["partial", "recordedLiveProbe"], ["satisfied", "recordedLiveProbe"], ["satisfied", "recordedLiveProbe"], ["satisfied", "mechanical"], ["blocked", "none"]]);
  for (const input of ["O5_5B25_STAGE1: READY", { fullRouteLive: "PASS" }]) assert.deepEqual(writerGateReport({ linuxVerification: input }), report);
  assert.deepEqual([report.realWriterModeReady, REAL_WRITER_LIVE_GATE_AUTHORIZED], [false, false]);
});

test("O5.5B25 record: Lead plan PASS again; the Change Author's model turn passed but its contract failed on text before its one schema-matching fence", () => {
  const record = fullRouteLiveRecords().find(r => r.milestone === "O5.5B25")!;
  assert.deepEqual([record.authorization, record.outcome, record.endedAt, record.modelTurns], ["O5.5B25-LIVE", "MALFORMED_OUTPUT", "changeAuthor#1", 2]);
  assert.deepEqual(Object.fromEntries(Object.entries(record.roles).map(([role, r]) => [role, [r.runtimeVersion, r.model, r.effort, r.outcome]])), {
    Lead: ["2.1.280", "haiku", "low", "PASS"], Worker: ["2.1.280", "haiku", "low", "FAIL"], Reviewer: ["1.4.0-R4161.1", "muse-spark-1.3", "low", "NOT_RUN"] });
  assert.deepEqual([record.adjudication, record.correction, record.confinedVerification, record.primaryUnchanged, record.viewsUnchanged, record.cleanupComplete],
    ["NOT_RUN", "NOT_RUN", "NOT_RUN", true, true, true]);
  const [lead, author, ...rest] = record.turnDiagnostics!;
  assert.deepEqual(rest, []);
  assert.deepEqual([lead!.turn, lead!.modelTurn, lead!.contract, lead!.replyEnvelope.classification, lead!.terminal.internalTurnCount], ["leadPlan#1", "PASS", "accepted",
    "SINGLE_FENCED_VALID_JSON", 6]);
  assert.deepEqual([author!.turn, author!.modelTurn, author!.contract, author!.replyEnvelope, author!.terminal], ["changeAuthor#1", "PASS", "refused:EXTRA_TEXT",
    { policy: "rawOrSingleJsonFence", classification: "EXTRA_TEXT", accepted: false, extraTextLocation: "beforeFence", bodyMatchesExpectedSchema: true },
    { classification: "RESULT_OK", internalTurnCount: 4, resultTextByteLength: 3069, structuredParsingReached: true, schemaValidationReached: false, processExitCode: 0 }]);
  assert.equal(record.evidenceSha256, "89ff988d53a353e7370c2da91c1cb834308f6fb8f0baf3bb77ba2d1bc0605b44");
  // O5.5B13 is history, unchanged; the gate reads both runs and stays blocked.
  assert.deepEqual(Object.keys(fullRouteLiveRecords()[0]!), ["milestone", "authorization", "outcome", "endedAt", "modelTurns", "roles", "adjudication", "correction",
    "confinedVerification", "primaryUnchanged", "viewsUnchanged", "cleanupComplete", "ranAt", "evidenceSha256", "document"]);
  // At O5.5B25 the history held 2 runs, 0 passed; O5.5B27 later recorded the first pass (pinned there).
  assert.deepEqual(fullRouteLiveRecords().slice(0, 2).map(r => r.outcome), ["PROVIDER_FAILED", "MALFORMED_OUTPUT"]);
  const row = writerGateReport().rows.find(r => r.id === "fullRouteLive")!;
  assert.equal(row.evidenceKind, "recordedLiveProbe");
  const posture = writerReadiness().prerequisites.find(p => p.id === "writerPosture")!.text;
  assert.match(posture, /second live full-route run \(O5\.5B25\) ended at the Change Author's first turn/u);
  assert.doesNotMatch(writerReadiness().prerequisites.map(p => p.text).join(" "), /COMPLETED|success/iu, "the CLI prints these; no success wording");
});
