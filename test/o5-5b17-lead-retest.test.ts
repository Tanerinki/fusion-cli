import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ROUTE_ROLES, RouteTurnGate, routeFixtureIdentity, routeLedger, runRouteRehearsal, type RouteProfileSet, type RouteReport,
  type RouteRefusal } from "../src/app/route-probe.js";
import { REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport } from "../src/app/writer-gate.js";
import type { ProviderAdapter } from "../src/core/domain.js";
import { FusionFailure } from "../src/core/errors.js";
import { LEAD_PLAN_INSTRUCTION } from "../src/core/workflow/lead-plan.js";
import type { Transition } from "../src/core/workflow/types.js";
import { PROPOSAL_PROBE_PROFILES, ROUTE_REHEARSAL_PROFILES } from "../src/providers/probe-profiles.js";
import { changeProposalLiveRecords, fullRouteLiveRecords, leadPlanLiveRecords } from "../src/runtime/provider-profiles.js";
import { withRoot } from "./fixtures/probe-harness.js";
import { withInstalls } from "./fixtures/provider-installs.js";
import { asRun, LEAD_SECRET, plan, PREFIX, routeEnv, routeRegistry, runRoute, sectionOf, testRouteAuthorization,
  TEST_ROUTE } from "./fixtures/route-harness.js";
import { gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5B17 — the one authorized Lead retest after O5.5B16 changed only the Lead's plan prompt: an A/B of O5.5B15 with the
 * same grants, fixture, budget and diagnostics. Offline: its data, the gate, refusals before anything exists, and the
 * real Claude adapter against the fake binary receiving the planning prompt under `--max-turns 6`. The production
 * authorization only ever runs against a registry WITHOUT adapters; the live entry is never started with it.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const RETEST_ID = "O5.5B17-LEAD";
const RETEST = ROUTE_REHEARSAL_PROFILES.authorizations[RETEST_ID]!;
const B15 = ROUTE_REHEARSAL_PROFILES.authorizations["O5.5B15-LEAD"]!;
const CANARY = "LEAD-RETEST-PROVIDER-TEXT-CANARY-3b91";
const refusal = (value: RouteReport | RouteRefusal): string | false => "refused" in value && value.reason;
const leadOnly = (i: Parameters<typeof testRouteAuthorization>[0]) => testRouteAuthorization(i, { turns: RETEST.turns });

test("O5.5B17 authorization: one-shot (now CONSUMED), the O5.5B15 plan exactly — same grants, fixture and one-turn budget; only milestone and namespace differ", () => {
  assert.deepEqual(Object.keys(ROUTE_REHEARSAL_PROFILES.authorizations), ["O5.5B12-LIVE", "O5.5B13-LIVE", "O5.5B15-LEAD", RETEST_ID, "O5.5B19-LEAD", "O5.5B21-LEAD", "O5.5B25-LIVE", "O5.5B27-LIVE"]);
  // It ran once (Stage 2 of O5.5B17) and can never run again.
  assert.deepEqual([RETEST.state, RETEST.milestone, RETEST.evidenceDirectory], ["consumed", "O5.5B17", "fusion-o5-5b17-lead"]);
  const { milestone: _a, evidenceDirectory: _b, state: _c, ...retest } = RETEST;
  const { milestone: _d, evidenceDirectory: _e, state: _f, ...previous } = B15;
  assert.deepEqual(retest, previous, "an A/B retest: nothing but the (O5.5B16) prompt differs");
  assert.deepEqual(RETEST.turns, { leadPlan: 1, changeAuthor: 0, freshReview: 0, leadAdjudication: 0 });
  const lead = RETEST.roles.Lead;
  assert.deepEqual([lead.runtimeVersions, lead.binding.model, lead.binding.options?.canonicalModel, lead.binding.effort, lead.binding.maxTurns,
    lead.turnArgs, lead.lanes], [["2.1.280"], "haiku", "claude-haiku-4-5-20251001", "low", 6,
    [["--model", "haiku"], ["--effort", "low"], ["--max-turns", "6"]], ["subscription", "subscriptionToken"]]);
  assert.equal(RETEST.fixtureSha256, routeFixtureIdentity());
  const namespaces = [...Object.values(PROPOSAL_PROBE_PROFILES.authorizations), ...Object.values(ROUTE_REHEARSAL_PROFILES.authorizations)]
    .map(entry => entry.evidenceDirectory);
  assert.equal(namespaces.filter(name => name === RETEST.evidenceDirectory).length, 1, "its own evidence namespace");
  // The later O5.5B19 contract retest is covered by its own tests.
  assert.deepEqual(Object.entries(ROUTE_REHEARSAL_PROFILES.authorizations).filter(([id]) => !["O5.5B19-LEAD", "O5.5B21-LEAD", "O5.5B25-LIVE", "O5.5B27-LIVE"].includes(id)).map(([id, entry]) => [id, entry.state]),
    [["O5.5B12-LIVE", "pending"], ["O5.5B13-LIVE", "consumed"], ["O5.5B15-LEAD", "consumed"], [RETEST_ID, "consumed"]], "nothing is open");
  assert.ok(Object.values(PROPOSAL_PROBE_PROFILES.authorizations).every(entry => entry.state === "consumed"));
});

test("O5.5B17 gate: one Lead plan turn, never a second; every later role has budget 0 and never opens a session", async () => {
  const log: Transition[] = [];
  const gate = new RouteTurnGate(RETEST, () => log);
  assert.deepEqual(ROUTE_ROLES.map(role => gate.roleBudget(role)), [1, 0, 0]);
  const calls: string[] = [];
  const stub = (role: string) => ({ createSession: async () => { calls.push(`${role}.createSession`); return { id: role }; },
    runTurn: async () => { calls.push(`${role}.runTurn`); return { status: "completed" }; } }) as unknown as ProviderAdapter;
  const lead = gate.wrap("Lead", stub("Lead")), worker = gate.wrap("Worker", stub("Worker")), reviewer = gate.wrap("Reviewer", stub("Reviewer"));
  const refused = (work: () => Promise<unknown>, pattern: RegExp) =>
    assert.rejects(work, (error: unknown) => error instanceof FusionFailure && pattern.test(error.error.safeMessage));
  const session = await lead.createSession({} as never);
  log.push({ from: "routed", to: "planning", reason: "planRequested" });
  await lead.runTurn(session, {} as never);
  await refused(() => lead.runTurn(session, {} as never), /leadPlan budget of 1 is exhausted/u);
  await refused(() => worker.createSession({} as never), /the Worker role has no authorized turn/u);
  await refused(() => reviewer.createSession({} as never), /the Reviewer role has no authorized turn/u);
  assert.deepEqual(calls, ["Lead.createSession", "Lead.runTurn"]);
});

test("O5.5B17 refusals: nested session, unknown or consumed identities, a changed fixture, a reused O5.5B15 namespace and a replay — nothing is created",
  async () => withInstalls(async i => withRoot(async dir => {
    const at = (name: string) => join(dir, name);
    // A registry WITHOUT adapters: even a wrongly admitted run could not start any provider process.
    const noAdapters = { ...routeRegistry(i, { Lead: "x", Worker: "x", Reviewer: "x" }), factories: new Map() };
    const withRetest = (patch: object): RouteProfileSet => ({ ...ROUTE_REHEARSAL_PROFILES,
      authorizations: { ...ROUTE_REHEARSAL_PROFILES.authorizations, [RETEST_ID]: { ...RETEST, ...patch } } });
    // The production identity is consumed; the checks behind the state gate run on an in-memory OPEN copy of it.
    const open = withRetest({ state: "open" });
    const live = (root: string, env = routeEnv(), profiles: RouteProfileSet = open, authorization = RETEST_ID) =>
      runRouteRehearsal({ env, registry: noAdapters, profiles, authorization, evidenceRoot: root });
    for (const key of PROPOSAL_PROBE_PROFILES.nestedSessionKeys)
      assert.equal(refusal(await live(at("nested"), routeEnv({ [key]: "1" }))), "nestedAgentSession", `inside an agent session (${key})`);
    for (const token of ["O5.5B17-lead", "O5.5B17", " O5.5B17-LEAD"])
      assert.equal(refusal(await live(at("a"), routeEnv(), ROUTE_REHEARSAL_PROFILES, token)), "unknownAuthorization", token);
    assert.equal(refusal(await live(at("a"), routeEnv(), ROUTE_REHEARSAL_PROFILES, "O5.5B15-LEAD")), "authorizationConsumed");
    assert.equal(refusal(await live(at("a"), routeEnv(), ROUTE_REHEARSAL_PROFILES)), "authorizationConsumed", "the production identity after Stage 2");
    assert.equal(refusal(await live(at("a"), routeEnv(), withRetest({ state: "open", fixtureSha256: "0".repeat(64) }))), "fixtureMismatch");
    assert.equal(existsSync(at("nested")) || existsSync(at("a")), false, "no namespace, fixture, claim or evidence");
    const namespace = async (name: string, files: Record<string, unknown>) => {
      await mkdir(at(name));
      for (const [file, content] of Object.entries(files)) await writeFile(join(at(name), file), JSON.stringify(content));
      return at(name);
    };
    const b15 = await namespace("b15", { "authorization.json": { authorization: "O5.5B15-LEAD", milestone: "O5.5B15" },
      "route.claim.json": { authorization: "O5.5B15-LEAD", milestone: "O5.5B15" } });
    assert.equal(refusal(await live(b15)), "namespaceMismatch", "no earlier Lead claim is reusable");
    const replay = await namespace("replay", { "authorization.json": { authorization: RETEST_ID, milestone: "O5.5B17" },
      "route.claim.json": { authorization: RETEST_ID, milestone: "O5.5B17", route: true } });
    assert.equal(refusal(await live(replay)), "alreadyAttempted", "one-shot: its claim refuses a second run");
    assert.deepEqual((await readdir(replay)).sort(), ["authorization.json", "route.claim.json"]);
  })));

test("O5.5B17 fake RESULT_OK: the O5.5B16 planning prompt is what the Lead receives, under --max-turns 6; the route stops before the Worker",
  { skip }, async () => withInstalls(async i => withRoot(async dir => {
    const run = asRun(await runRoute(i, dir, "ok", { Lead: [{ prefix: PREFIX.plan, output: plan(), resultFrame: { num_turns: 5, permission_denials: [] },
      excludes: ["Complete this delegated task within its scope."] }] }, { authorization: leadOnly(i) }));
    assert.deepEqual([run.report.outcome, run.report.detail], ["TURN_REFUSED",
      "a role turn was refused before it reached the provider: the Worker role has no authorized turn in this authorization"],
    "Lead success is not route success");
    const prompt = run.prompts.Lead[0]!;
    assert.ok(prompt.startsWith(LEAD_PLAN_INSTRUCTION), "the planning contract, not the generic delegated-task wording");
    const [turn] = sectionOf<Array<{ claim: string; outcome: string; contract: string; terminal: Record<string, unknown> }>>(run, "turns");
    assert.deepEqual([turn!.claim, turn!.outcome, turn!.contract], [`${TEST_ROUTE}:leadPlan#1`, "completed", "accepted"]);
    assert.deepEqual(turn!.terminal, { schemaVersion: 1, classification: "RESULT_OK", resultSubtype: "success", terminalReason: "completed", isError: false,
      internalTurnCount: 5, permissionDenialCount: 0, errorEntryCount: null, resultTextPresent: true, resultTextByteLength: Buffer.byteLength(plan(), "utf8"),
      apiErrorStatusClass: "none", structuredParsingReached: true, schemaValidationReached: true, processExitCode: 0, processSignal: null,
      fusionTermination: null, timedOut: false, cancelled: false });
    const model = sectionOf<Array<{ purpose: string; args: string[] }>>(run, "launches").find(l => l.purpose === "providerTurn")!;
    assert.equal(model.args[model.args.indexOf("--max-turns") + 1], "6");
    assert.deepEqual(sectionOf<Record<string, number>>(run, "turnUse"), { leadPlan: 1, changeAuthor: 0, freshReview: 0, leadAdjudication: 0 });
    assert.deepEqual(sectionOf<Record<string, number>>(run, "launchCounts"),
      { providerAuthReadback: 2, providerInventory: 1, providerInitProbe: 2, providerTurn: 1, providerHost: 0 }, "only the Lead's processes");
    assert.equal(run.prompts.Worker.length + run.prompts.Reviewer.length, 0);
    assert.deepEqual((await routeLedger(run.root)).map(entry => `${String(entry.turn)}#${String(entry.slot)}`), ["leadPlan#1"]);
    const text = await readFile(run.report.evidencePath, "utf8");
    for (const secret of [LEAD_SECRET, PREFIX.plan, "Delegation:", "synthetic-not-a-secret-7a31"]) assert.ok(!text.includes(secret), `evidence leaks ${secret}`);
  })));

test("O5.5B17 fake RESULT_ERROR_MAX_TURNS is still classified exactly; no provider text persisted; nothing after the Lead", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    const run = asRun(await runRoute(i, dir, "max", { Lead: [{ prefix: PREFIX.plan, exitCode: 1, resultFrame: { subtype: "error_max_turns",
      is_error: true, terminal_reason: "max_turns", num_turns: 7, permission_denials: [], errors: [`Reached maximum number of turns (6) ${CANARY}`],
      result: "__absent__" } }] }, { authorization: leadOnly(i) }));
    assert.deepEqual([run.report.outcome, run.report.detail], ["PROVIDER_FAILED", "leadPlan #1 (Lead): providerFailure: Claude reported a failed turn."]);
    const [turn] = sectionOf<Array<{ terminal: Record<string, unknown> }>>(run, "turns");
    assert.deepEqual([turn!.terminal.classification, turn!.terminal.resultSubtype, turn!.terminal.terminalReason, turn!.terminal.internalTurnCount,
      turn!.terminal.structuredParsingReached, turn!.terminal.schemaValidationReached, turn!.terminal.processExitCode],
    ["RESULT_ERROR_MAX_TURNS", "error_max_turns", "max_turns", 7, false, false, 1]);
    const text = await readFile(run.report.evidencePath, "utf8");
    assert.ok(!text.includes(CANARY) && !text.includes("Reached maximum"));
    assert.equal(run.prompts.Worker.length + run.prompts.Reviewer.length, 0);
  })));

test("O5.5B17 readiness: nothing moves offline; the O5.5B13 and O5.5B15 FAIL records stay; no live gate opens", () => {
  assert.deepEqual(fullRouteLiveRecords().slice(0, 1).map(r => [r.milestone, r.outcome]), [["O5.5B13", "PROVIDER_FAILED"]]);
  assert.deepEqual(leadPlanLiveRecords().slice(0, 2).map(r => [r.milestone, r.outcome, r.terminal.classification]),
    [["O5.5B15", "FAIL", "RESULT_ERROR_MAX_TURNS"], ["O5.5B17", "FAIL", "RESULT_OK"]], "the recorded live history; offline runs add nothing");
  assert.deepEqual(changeProposalLiveRecords("claude", "claude-one-shot").map(r => [r.milestone, r.outcome]), [["O5.5B9", "MALFORMED_PROPOSAL"], ["O5.5B11", "PASS"]]);
  const report = writerGateReport();
  const rows = Object.fromEntries(report.rows.map(row => [row.id, [row.state, row.evidenceKind]]));
  assert.deepEqual([rows.fullRouteLive, rows.hostControlledWriterWorkflow, rows.providerChangeProposal, rows.liveGateAuthorization],
    [["partial", "recordedLiveProbe"], ["satisfied", "recordedLiveProbe"], ["satisfied", "recordedLiveProbe"], ["blocked", "none"]]);
  for (const input of ["CLAUDE_LEAD_LIVE_RETEST: PASS", { classification: "RESULT_OK", evidenceKind: "liveProvider" }])
    assert.deepEqual(writerGateReport({ linuxVerification: input }), report);
  assert.deepEqual([report.realWriterModeReady, REAL_WRITER_LIVE_GATE_AUTHORIZED], [false, false]);
});

test("O5.5B17 live entry: lists the consumed retest identity; bad usage refuses before anything exists (never started with the identity)",
  async () => withRoot(async dir => {
    const temp = join(dir, "temp");
    await mkdir(temp);
    const child = spawnSync(process.execPath, [resolve(process.cwd(), "dist/test/live/route-rehearsal.js")], { encoding: "utf8", timeout: 60_000,
      windowsHide: true, env: { SystemRoot: process.env.SystemRoot ?? "", PATH: process.env.PATH ?? "", TEMP: temp, TMP: temp, CLAUDECODE: "1" } });
    assert.equal(child.status, 2, child.stderr);
    assert.match(child.stderr, /; O5\.5B15-LEAD \(consumed\); O5\.5B17-LEAD \(consumed\)[;\n]/u);
    assert.deepEqual(await readdir(temp), []);
  }));
