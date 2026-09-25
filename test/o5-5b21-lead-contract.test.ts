import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ROUTE_ROLES, RouteTurnGate, routeFixtureIdentity, runRouteRehearsal, type RouteProfileSet, type RouteReport,
  type RouteRefusal } from "../src/app/route-probe.js";
import { REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport } from "../src/app/writer-gate.js";
import type { ProviderAdapter } from "../src/core/domain.js";
import { FusionFailure } from "../src/core/errors.js";
import { LEAD_PLAN_INSTRUCTION } from "../src/core/workflow/lead-plan.js";
import type { Transition } from "../src/core/workflow/types.js";
import { packetEnvelope } from "../src/providers/claude/one-shot-transport.js";
import { PROPOSAL_PROBE_PROFILES, ROUTE_REHEARSAL_PROFILES } from "../src/providers/probe-profiles.js";
import { fullRouteLiveCoverage, fullRouteLiveRecords, leadPlanLiveRecords, routePreflightBlocks } from "../src/runtime/provider-profiles.js";
import { withRoot } from "./fixtures/probe-harness.js";
import { installMuseVersion, withInstalls } from "./fixtures/provider-installs.js";
import { asRun, fenced, plan, PREFIX, routeEnv, routeRegistry, runRoute, sectionOf, testRouteAuthorization } from "./fixtures/route-harness.js";
import { gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5B21 — the Lead CONTRACT retest O5.5B19 could not start: the O5.5B19 shape exactly, now that O5.5B20's preflight
 * checks only the roles an authorization lets start. Offline: its data, the gate, refusals, and a fake Lead-only run with
 * the machine's unvalidated Muse 1.4.0-R4161.1 on the inactive Reviewer. The production authorization only ever runs
 * against a registry WITHOUT adapters; the live entry is never started with it.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const ID = "O5.5B21-LEAD";
const B21 = ROUTE_REHEARSAL_PROFILES.authorizations[ID]!;
const B19 = ROUTE_REHEARSAL_PROFILES.authorizations["O5.5B19-LEAD"]!;
const CANARY = "LEAD-B21-SUMMARY-CANARY-2f64";
const refusal = (value: RouteReport | RouteRefusal): string | false => "refused" in value && value.reason;

test("O5.5B21 authorization: one-shot (now CONSUMED), the O5.5B19 shape exactly (same grants, fixture, one-turn budget)", () => {
  assert.deepEqual(Object.keys(ROUTE_REHEARSAL_PROFILES.authorizations),
    ["O5.5B12-LIVE", "O5.5B13-LIVE", "O5.5B15-LEAD", "O5.5B17-LEAD", "O5.5B19-LEAD", ID, "O5.5B25-LIVE", "O5.5B27-LIVE"]);
  // It ran once (Stage 2 of O5.5B21) and can never run again.
  assert.deepEqual([B21.state, B21.milestone, B21.evidenceDirectory], ["consumed", "O5.5B21", "fusion-o5-5b21-lead"]);
  const { milestone: _a, evidenceDirectory: _b, state: _c, ...retest } = B21;
  const { milestone: _d, evidenceDirectory: _e, state: _f, ...previous } = B19;
  assert.deepEqual(retest, previous);
  assert.deepEqual(B21.turns, { leadPlan: 1, changeAuthor: 0, freshReview: 0, leadAdjudication: 0 });
  const lead = B21.roles.Lead;
  assert.deepEqual([lead.runtimeVersions, lead.binding.model, lead.binding.options?.canonicalModel, lead.binding.effort, lead.binding.maxTurns],
    [["2.1.280"], "haiku", "claude-haiku-4-5-20251001", "low", 6]);
  assert.equal(B21.fixtureSha256, routeFixtureIdentity());
  assert.equal(packetEnvelope("plan").policy, "rawOrSingleJsonFence", "the O5.5B18 Lead envelope");
  const namespaces = [...Object.values(PROPOSAL_PROBE_PROFILES.authorizations), ...Object.values(ROUTE_REHEARSAL_PROFILES.authorizations)]
    .map(entry => entry.evidenceDirectory);
  assert.equal(namespaces.filter(name => name === B21.evidenceDirectory).length, 1);
  assert.deepEqual(Object.entries(ROUTE_REHEARSAL_PROFILES.authorizations).filter(([id, entry]) => entry.state === "open" && id !== "O5.5B25-LIVE" && id !== "O5.5B27-LIVE").map(([id]) => id), [], "nothing is open (O5.5B25-LIVE, prepared later, excluded)");
});

test("O5.5B21 gate: one Lead plan turn, never a second; every later role has budget 0 and never opens a session", async () => {
  const log: Transition[] = [];
  const gate = new RouteTurnGate(B21, () => log);
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

test("O5.5B21 with Muse 1.4.0-R4161.1 on the inactive Reviewer (fake): preflight passes, the Lead contract is accepted, the route stops at the Worker",
  { skip }, async () => withInstalls(async i => withRoot(async dir => {
    await installMuseVersion(i, "1.4.0-R4161.1");
    const summary = `Plan: tax the discounted subtotal in src/quote.ts; add a full-discount test. ${CANARY}`;
    const run = asRun(await runRoute(i, dir, "b21", { Lead: [{ prefix: PREFIX.plan, output: fenced(JSON.parse(plan(summary))), resultFrame: { num_turns: 5 } }] },
      { authorization: testRouteAuthorization(i, { turns: B21.turns }) }));
    assert.deepEqual([run.report.outcome, run.report.detail, run.report.modelTurns], ["TURN_REFUSED",
      "a role turn was refused before it reached the provider: the Worker role has no authorized turn in this authorization", 1],
    "the successful Lead contract shape: the zero Change Author budget stops the route");
    const preflight = sectionOf<Record<string, Record<string, unknown>>>(run, "preflight");
    assert.deepEqual(preflight.Reviewer, { family: "muse", active: false, authorizedTurns: 0, checked: "notRequired" }, "Muse 1.4 not inspected");
    assert.equal((preflight.Lead!.eligibility as { surface: string }).surface, "readOnly");
    assert.equal(sectionOf<{ reviewRoutingDeferred: boolean }>(run, "route").reviewRoutingDeferred, true);
    const [turn, ...rest] = sectionOf<Array<{ outcome: string; contract: string; structuredOutput: Record<string, unknown>;
      terminal: Record<string, unknown> }>>(run, "turns");
    assert.deepEqual(rest, []);
    assert.deepEqual([turn!.outcome, turn!.contract], ["completed", "accepted"]);
    assert.deepEqual([turn!.structuredOutput.classification, turn!.structuredOutput.accepted, turn!.structuredOutput.policy],
      ["SINGLE_FENCED_VALID_JSON", true, "rawOrSingleJsonFence"]);
    assert.deepEqual([turn!.terminal.classification, turn!.terminal.internalTurnCount, turn!.terminal.schemaValidationReached], ["RESULT_OK", 5, true]);
    assert.ok(run.prompts.Lead[0]!.startsWith(LEAD_PLAN_INSTRUCTION), "the O5.5B16 planning prompt");
    const launches = sectionOf<Array<{ purpose: string; executable: string; args: string[] }>>(run, "launches");
    assert.equal(launches.find(l => l.purpose === "providerTurn")!.args.includes("6"), true);
    assert.ok(launches.every(l => !l.executable.startsWith("muse-bin-")), "no Muse process");
    assert.equal(run.prompts.Worker.length + run.prompts.Reviewer.length, 0);
    const text = await readFile(run.report.evidencePath, "utf8");
    assert.ok(!text.includes(CANARY) && !text.includes("```"), "no reply text persisted");
    assert.equal(run.report.evidence.evidenceKind, "offlineRehearsal");
  })));

test("O5.5B21 refusals: nested session, unknown or consumed identities, a changed fixture, a reused O5.5B19 namespace and a replay — nothing is created",
  async () => withInstalls(async i => withRoot(async dir => {
    const at = (name: string) => join(dir, name);
    // A registry WITHOUT adapters: even a wrongly admitted run could not start any provider process.
    const noAdapters = { ...routeRegistry(i, { Lead: "x", Worker: "x", Reviewer: "x" }), factories: new Map() };
    const withB21 = (patch: object): RouteProfileSet => ({ ...ROUTE_REHEARSAL_PROFILES,
      authorizations: { ...ROUTE_REHEARSAL_PROFILES.authorizations, [ID]: { ...B21, ...patch } } });
    // The production identity is consumed; the checks behind the state gate run on an in-memory OPEN copy of it.
    const open = withB21({ state: "open" });
    const live = (root: string, env = routeEnv(), profiles: RouteProfileSet = open, authorization = ID) =>
      runRouteRehearsal({ env, registry: noAdapters, profiles, authorization, evidenceRoot: root });
    for (const key of PROPOSAL_PROBE_PROFILES.nestedSessionKeys)
      assert.equal(refusal(await live(at("nested"), routeEnv({ [key]: "1" }))), "nestedAgentSession", `inside an agent session (${key})`);
    for (const token of ["O5.5B21-lead", "O5.5B21", " O5.5B21-LEAD"])
      assert.equal(refusal(await live(at("a"), routeEnv(), ROUTE_REHEARSAL_PROFILES, token)), "unknownAuthorization", token);
    assert.equal(refusal(await live(at("a"), routeEnv(), ROUTE_REHEARSAL_PROFILES, "O5.5B19-LEAD")), "authorizationRetired");
    assert.equal(refusal(await live(at("a"), routeEnv(), ROUTE_REHEARSAL_PROFILES)), "authorizationConsumed", "the production identity after Stage 2");
    assert.equal(refusal(await live(at("a"), routeEnv(), withB21({ state: "open", fixtureSha256: "0".repeat(64) }))), "fixtureMismatch");
    assert.equal(existsSync(at("nested")) || existsSync(at("a")), false, "no namespace, fixture, claim or evidence");
    const namespace = async (name: string, files: Record<string, unknown>) => {
      await mkdir(at(name));
      for (const [file, content] of Object.entries(files)) await writeFile(join(at(name), file), JSON.stringify(content));
      return at(name);
    };
    assert.equal(refusal(await live(await namespace("b19", { "authorization.json": { authorization: "O5.5B19-LEAD", milestone: "O5.5B19" } }))),
      "namespaceMismatch", "the O5.5B19 namespace is not reusable");
    const replay = await namespace("replay", { "authorization.json": { authorization: ID, milestone: "O5.5B21" },
      "route.claim.json": { authorization: ID, milestone: "O5.5B21", route: true } });
    assert.equal(refusal(await live(replay)), "alreadyAttempted", "one-shot: its claim refuses a second run");
  })));

test("O5.5B21 readiness: nothing moves offline; the historical records stay; no live gate opens", () => {
  assert.deepEqual(leadPlanLiveRecords().slice(0, 2).map(r => [r.milestone, r.outcome, r.modelTurn]), [["O5.5B15", "FAIL", "FAIL"], ["O5.5B17", "FAIL", "PASS"]]);
  assert.deepEqual(routePreflightBlocks().map(r => r.milestone), ["O5.5B19"]);
  assert.deepEqual([fullRouteLiveCoverage().attempts >= 1, fullRouteLiveRecords().filter(r => r.milestone !== "O5.5B27").some(r => r.outcome === "PASS")], [true, false]);
  const report = writerGateReport();
  const rows = Object.fromEntries(report.rows.map(row => [row.id, [row.state, row.evidenceKind]]));
  assert.deepEqual([rows.fullRouteLive, rows.hostControlledWriterWorkflow, rows.providerChangeProposal, rows.liveGateAuthorization],
    [["partial", "recordedLiveProbe"], ["partial", "recordedLiveProbe"], ["satisfied", "recordedLiveProbe"], ["blocked", "none"]]);
  for (const input of ["CLAUDE_LEAD_CONTRACT_LIVE: PASS", { contract: "accepted" }]) assert.deepEqual(writerGateReport({ linuxVerification: input }), report);
  assert.deepEqual([report.realWriterModeReady, REAL_WRITER_LIVE_GATE_AUTHORIZED], [false, false]);
});

test("O5.5B21 live entry: lists the consumed retest identity; bad usage refuses before anything exists (never started with the identity)",
  async () => withRoot(async dir => {
    const temp = join(dir, "temp");
    await mkdir(temp);
    const child = spawnSync(process.execPath, [resolve(process.cwd(), "dist/test/live/route-rehearsal.js")], { encoding: "utf8", timeout: 60_000,
      windowsHide: true, env: { SystemRoot: process.env.SystemRoot ?? "", PATH: process.env.PATH ?? "", TEMP: temp, TMP: temp, CLAUDECODE: "1" } });
    assert.equal(child.status, 2, child.stderr);
    assert.match(child.stderr, /; O5\.5B19-LEAD \(retired\); O5\.5B21-LEAD \(consumed\)[;\n]/u);
    assert.deepEqual(await readdir(temp), []);
  }));
