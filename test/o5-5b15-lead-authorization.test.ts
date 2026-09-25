import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ROUTE_ROLE_OF, ROUTE_ROLES, ROUTE_TURN_CLASSES, RouteTurnGate, routeFixtureIdentity, runRouteRehearsal, type RouteProfileSet,
  type RouteReport, type RouteRefusal } from "../src/app/route-probe.js";
import type { ProviderAdapter } from "../src/core/domain.js";
import { FusionFailure } from "../src/core/errors.js";
import type { Transition, TransitionReason, WorkflowState } from "../src/core/workflow/types.js";
import { PROPOSAL_PROBE_PROFILES, ROUTE_REHEARSAL_PROFILES } from "../src/providers/probe-profiles.js";
import { withRoot } from "./fixtures/probe-harness.js";
import { withInstalls } from "./fixtures/provider-installs.js";
import { routeEnv, routeRegistry } from "./fixtures/route-harness.js";

/**
 * O5.5B15 — the one-shot Lead-plan-only live authorization: its data, the turn gate with every non-Lead budget at 0 (no
 * second Lead turn, no later role's session), and every refusal before anything exists. Nothing here reaches a provider:
 * the production authorization only ever runs against a registry WITHOUT adapters, and the live entry is never started
 * with it.
 */
const LEAD_ID = "O5.5B15-LEAD";
const LEAD = ROUTE_REHEARSAL_PROFILES.authorizations[LEAD_ID]!;
const B13 = ROUTE_REHEARSAL_PROFILES.authorizations["O5.5B13-LIVE"]!;
const refusal = (value: RouteReport | RouteRefusal): string | false => "refused" in value && value.reason;

test("O5.5B15 authorization: one-shot (now CONSUMED), one Lead-plan turn and nothing else, the O5.5B13 bindings and fixture, its own namespace", () => {
  assert.deepEqual(Object.keys(ROUTE_REHEARSAL_PROFILES.authorizations), ["O5.5B12-LIVE", "O5.5B13-LIVE", LEAD_ID, "O5.5B17-LEAD", "O5.5B19-LEAD", "O5.5B21-LEAD"]);
  // It ran once (Stage 2 of O5.5B15) and can never run again.
  assert.deepEqual([LEAD.state, LEAD.milestone, LEAD.evidenceDirectory], ["consumed", "O5.5B15", "fusion-o5-5b15-lead"]);
  assert.deepEqual(LEAD.turns, { leadPlan: 1, changeAuthor: 0, freshReview: 0, leadAdjudication: 0 });
  assert.equal(Object.values(LEAD.turns).reduce((a, b) => a + b, 0), 1, "exactly one real model turn");
  // Unchanged before the probe: the same role grants (Claude 2.1.280 haiku/low, --max-turns 6, subscription lanes) and fixture.
  assert.deepEqual(LEAD.roles, B13.roles);
  const lead = LEAD.roles.Lead;
  assert.deepEqual([lead.family, lead.executable, lead.runtimeVersions, lead.lanes, lead.binding.adapter, lead.binding.model, lead.binding.effort,
    lead.binding.maxTurns, lead.binding.options?.canonicalModel, lead.turnArgs, lead.requiredEnvironment],
  ["claude", "claude.exe", ["2.1.280"], ["subscription", "subscriptionToken"], "claude-one-shot", "haiku", "low", 6, "claude-haiku-4-5-20251001",
    [["--model", "haiku"], ["--effort", "low"], ["--max-turns", "6"]], ["FUSION_CLAUDE_EXE"]]);
  assert.equal(LEAD.fixtureSha256, routeFixtureIdentity());
  assert.doesNotMatch(JSON.stringify(LEAD), /opus|sonnet|"high"|"max"|2\.1\.281|payg|apiKey/iu);
  assert.ok(Object.isFrozen(LEAD) && Object.isFrozen(LEAD.turns));
  const namespaces = [...Object.values(PROPOSAL_PROBE_PROFILES.authorizations), ...Object.values(ROUTE_REHEARSAL_PROFILES.authorizations)]
    .map(entry => entry.evidenceDirectory);
  assert.equal(namespaces.filter(name => name === LEAD.evidenceDirectory).length, 1, "its own evidence namespace");
  // No authorization of its time is open (the later O5.5B17 and O5.5B19 retests are covered by their own tests).
  assert.deepEqual(Object.entries(ROUTE_REHEARSAL_PROFILES.authorizations).filter(([id]) => !["O5.5B17-LEAD", "O5.5B19-LEAD", "O5.5B21-LEAD"].includes(id)).map(([id, entry]) => [id, entry.state]),
    [["O5.5B12-LIVE", "pending"], ["O5.5B13-LIVE", "consumed"], [LEAD_ID, "consumed"]]);
  assert.ok(Object.values(PROPOSAL_PROBE_PROFILES.authorizations).every(entry => entry.state === "consumed"));
  // Budget per role: the Lead's one plan turn; every other role has none.
  const gate = new RouteTurnGate(LEAD, () => []);
  assert.deepEqual(ROUTE_ROLES.map(role => gate.roleBudget(role)), [1, 0, 0]);
  assert.deepEqual(ROUTE_TURN_CLASSES.map(turn => ROUTE_ROLE_OF[turn]), ["Lead", "Worker", "Reviewer", "Lead"]);
});

// ---------------------------------------------------------------- the gate (unit)

const transition = (to: WorkflowState, reason: TransitionReason, attempt?: number): Transition =>
  ({ from: "received", to, reason, ...(attempt === undefined ? {} : { attempt }) });

test("O5.5B15 gate: one Lead plan turn, never a second; every other turn class refused in its own engine state; no later role opens a session",
  async () => {
    const log: Transition[] = [];
    const gate = new RouteTurnGate(LEAD, () => log);
    const calls: string[] = [];
    const stub = (role: string) => ({ createSession: async () => { calls.push(`${role}.createSession`); return { id: `${role}-session` }; },
      runTurn: async () => { calls.push(`${role}.runTurn`); return { status: "completed" }; },
      runStructuredTurn: async () => { calls.push(`${role}.runStructuredTurn`); return { status: "completed" }; },
      runChangeProposalTurn: async () => { calls.push(`${role}.runChangeProposalTurn`); return { status: "completed" }; } }) as unknown as ProviderAdapter;
    const lead = gate.wrap("Lead", stub("Lead")), worker = gate.wrap("Worker", stub("Worker")), reviewer = gate.wrap("Reviewer", stub("Reviewer"));
    const refused = async (work: () => Promise<unknown>, pattern: RegExp) => {
      await assert.rejects(work, (error: unknown) => error instanceof FusionFailure && error.error.kind === "SecurityViolation" && pattern.test(error.error.safeMessage));
    };
    // The Lead opens its session and runs its one plan turn.
    const session = await lead.createSession({} as never);
    log.push(transition("planning", "planRequested"));
    assert.equal((await lead.runTurn(session, {} as never) as { status: string }).status, "completed");
    await refused(() => lead.runTurn(session, {} as never), /leadPlan budget of 1 is exhausted/u);
    // The Worker and Reviewer never open a session: not even their auth readback can start.
    await refused(() => worker.createSession({} as never), /the Worker role has no authorized turn/u);
    await refused(() => reviewer.createSession({} as never), /the Reviewer role has no authorized turn/u);
    // Even in the engine state that would admit them, their turns have no budget.
    log.push(transition("delegating", "delegated", 1));
    await refused(() => worker.runChangeProposalTurn!(session, { kind: "changeProposal" } as never), /changeAuthor budget of 0 is exhausted/u);
    log.push(transition("reviewing", "freshReviewRequested", 1));
    await refused(() => reviewer.runStructuredTurn!(session, { kind: "review", cycle: 1 } as never), /freshReview budget of 0 is exhausted/u);
    log.push(transition("adjudicating", "adjudicationRequested", 1));
    await refused(() => lead.runStructuredTurn!(session, { kind: "adjudication", cycle: 1 } as never), /leadAdjudication budget of 0 is exhausted/u);
    assert.deepEqual(calls, ["Lead.createSession", "Lead.runTurn"], "only the Lead's session and its one plan turn reached the adapter");
    assert.deepEqual(gate.turns.map(record => `${record.turn}#${record.slot}`), ["leadPlan#1"]);
    assert.deepEqual(gate.refusals.map(r => `${r.role}.${r.call}`), ["Lead.runTurn", "Worker.createSession", "Reviewer.createSession",
      "Worker.runChangeProposalTurn", "Reviewer.runStructuredTurn", "Lead.runStructuredTurn"]);
  });

// ---------------------------------------------------------------- refusals before anything exists

test("O5.5B15 refusals: nested session, unknown or consumed identities, a changed fixture, reused O5.5B11/B13 namespaces and a replay — nothing is created",
  async () => withInstalls(async i => withRoot(async dir => {
    const at = (name: string) => join(dir, name);
    // A registry WITHOUT adapters: even a wrongly admitted run could not start any provider process.
    const noAdapters = { ...routeRegistry(i, { Lead: "x", Worker: "x", Reviewer: "x" }), factories: new Map() };
    const withLead = (patch: object): RouteProfileSet => ({ ...ROUTE_REHEARSAL_PROFILES,
      authorizations: { ...ROUTE_REHEARSAL_PROFILES.authorizations, [LEAD_ID]: { ...LEAD, ...patch } } });
    // The production identity is consumed; the checks behind the state gate run on an in-memory OPEN copy of it.
    const open = withLead({ state: "open" });
    const live = (root: string, env = routeEnv(), profiles: RouteProfileSet = open, authorization = LEAD_ID) =>
      runRouteRehearsal({ env, registry: noAdapters, profiles, authorization, evidenceRoot: root });
    for (const key of PROPOSAL_PROBE_PROFILES.nestedSessionKeys)
      assert.equal(refusal(await live(at("nested"), routeEnv({ [key]: "1" }))), "nestedAgentSession", `inside an agent session (${key})`);
    for (const token of ["O5.5B15-lead", "O5.5B15", "O5.5B15-LIVE", " O5.5B15-LEAD"])
      assert.equal(refusal(await live(at("a"), routeEnv(), ROUTE_REHEARSAL_PROFILES, token)), "unknownAuthorization", token);
    assert.equal(refusal(await live(at("a"), routeEnv(), ROUTE_REHEARSAL_PROFILES)), "authorizationConsumed", "the production identity after Stage 2");
    assert.equal(refusal(await live(at("a"), routeEnv(), withLead({ state: "open", fixtureSha256: "0".repeat(64) }))), "fixtureMismatch");
    assert.equal(refusal(await live(at("a"), routeEnv(), ROUTE_REHEARSAL_PROFILES, "O5.5B13-LIVE")), "authorizationConsumed");
    assert.equal(existsSync(at("nested")) || existsSync(at("a")), false, "no namespace, fixture, claim or evidence");
    const namespace = async (name: string, files: Record<string, unknown>) => {
      await mkdir(at(name));
      for (const [file, content] of Object.entries(files)) await writeFile(join(at(name), file), JSON.stringify(content));
      return at(name);
    };
    for (const [name, files] of [
      ["b13", { "authorization.json": { authorization: "O5.5B13-LIVE", milestone: "O5.5B13" }, "route.claim.json": { authorization: "O5.5B13-LIVE", milestone: "O5.5B13" } }],
      ["b11", { "authorization.json": { authorization: "O5.5B11", milestone: "O5.5B11" }, "claude.claim.json": { authorization: "O5.5B11", milestone: "O5.5B11" } }],
      ["unmarked", { "route.claim.json": { authorization: LEAD_ID, milestone: "O5.5B15" } }],
    ] as Array<[string, Record<string, unknown>]>) {
      const root = await namespace(name, files);
      assert.equal(refusal(await live(root)), "namespaceMismatch", name);
      assert.deepEqual((await readdir(root)).sort(), Object.keys(files).sort(), `${name}: untouched`);
    }
    const replay = await namespace("replay", { "authorization.json": { authorization: LEAD_ID, milestone: "O5.5B15" },
      "route.claim.json": { authorization: LEAD_ID, milestone: "O5.5B15", route: true } });
    assert.equal(refusal(await live(replay)), "alreadyAttempted", "one-shot: its claim refuses a second run");
    assert.deepEqual((await readdir(replay)).sort(), ["authorization.json", "route.claim.json"]);
  })));

test("O5.5B15 live entry: lists the consumed Lead-only identity; bad usage refuses before anything exists (never started with the identity)",
  async () => withRoot(async dir => {
    const temp = join(dir, "temp");
    await mkdir(temp);
    const child = spawnSync(process.execPath, [resolve(process.cwd(), "dist/test/live/route-rehearsal.js")], { encoding: "utf8", timeout: 60_000,
      windowsHide: true, env: { SystemRoot: process.env.SystemRoot ?? "", PATH: process.env.PATH ?? "", TEMP: temp, TMP: temp, CLAUDECODE: "1" } });
    assert.equal(child.status, 2, child.stderr);
    assert.match(child.stderr, /Route authorizations: O5\.5B12-LIVE \(pending\); O5\.5B13-LIVE \(consumed\); O5\.5B15-LEAD \(consumed\)[;\n]/u);
    assert.deepEqual(await readdir(temp), []);
  }));
