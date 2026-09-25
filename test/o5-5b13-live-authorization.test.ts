import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { postureOf } from "../src/app/proposal-probe.js";
import { REHEARSAL_FILES, REHEARSAL_PLAN, ROUTE_PACKET, ROUTE_TASK } from "../src/app/route-fixture.js";
import { ROUTE_CANARIES, ROUTE_ROLES, routeFixtureIdentity, runRouteRehearsal, turnIdentityGaps, type RouteProfileSet, type RouteReport,
  type RouteRefusal } from "../src/app/route-probe.js";
import { PROPOSAL_PROBE_PROFILES, ROUTE_REHEARSAL_PROFILES } from "../src/providers/probe-profiles.js";
import { withRoot } from "./fixtures/probe-harness.js";
import { withInstalls } from "./fixtures/provider-installs.js";
import { routeEnv, routeRegistry, testRouteAuthorization, testRouteProfiles, TEST_ROUTE } from "./fixtures/route-harness.js";

/**
 * O5.5B13 — the one-shot live authorization of the full route: its data, the pinned fixture, the model-process identity
 * pairs, and every refusal before anything exists. Nothing here reaches a provider: the production authorization is only
 * ever run against a registry WITHOUT adapters, and the live entry is never started with it.
 */
const LIVE_ID = "O5.5B13-LIVE";
const LIVE = ROUTE_REHEARSAL_PROFILES.authorizations[LIVE_ID]!;
const PLAN = ROUTE_REHEARSAL_PROFILES.authorizations["O5.5B12-LIVE"]!;
const refusal = (value: RouteReport | RouteRefusal): string | false => "refused" in value && value.reason;
const CLAUDE_ARGS: Array<[string, string]> = [["--model", "haiku"], ["--effort", "low"], ["--max-turns", "6"]];
const MUSE_ARGS: Array<[string, string]> = [["--model", "muse-spark-1.3"], ["--reasoning-effort", "low"], ["--max-model-steps", "4"]];

test("O5.5B13 authorization: one one-shot identity (now CONSUMED) for exactly the approved plan — per-role budgets, runtimes, models, efforts, lanes, own namespace", () => {
  assert.deepEqual(Object.keys(ROUTE_REHEARSAL_PROFILES.authorizations), ["O5.5B12-LIVE", LIVE_ID]);
  // It ran once (Stage 2 of O5.5B13) and can never run again.
  assert.deepEqual([LIVE.state, LIVE.milestone, LIVE.evidenceDirectory], ["consumed", "O5.5B13", "fusion-o5-5b13-route"]);
  assert.equal(PLAN.state, "pending", "the O5.5B12 plan itself never opens");
  // Exactly the plan the human approved: same roles, same budget, nothing widened.
  assert.deepEqual(LIVE.roles, PLAN.roles);
  assert.deepEqual(LIVE.turns, { leadPlan: 1, changeAuthor: 2, freshReview: 2, leadAdjudication: 2 });
  assert.equal(Object.values(LIVE.turns).reduce((a, b) => a + b, 0), 7, "at most seven real model turns");
  assert.deepEqual(ROUTE_ROLES.map(role => { const grant = LIVE.roles[role];
    return [role, grant.family, grant.executable, grant.runtimeVersions, grant.lanes, grant.binding.adapter, grant.binding.model, grant.binding.effort,
      grant.binding.maxTurns ?? null, grant.requiredEnvironment]; }), [
    ["Lead", "claude", "claude.exe", ["2.1.280"], ["subscription", "subscriptionToken"], "claude-one-shot", "haiku", "low", 6, ["FUSION_CLAUDE_EXE"]],
    ["Worker", "claude", "claude.exe", ["2.1.280"], ["subscription", "subscriptionToken"], "claude-one-shot", "haiku", "low", 6, ["FUSION_CLAUDE_EXE"]],
    ["Reviewer", "muse", "muse-bin-1.3.0-R3401.1.exe", ["1.3.0-R3401.1"], ["subscription"], "muse-exec", "muse-spark-1.3", "low", null, []]]);
  assert.deepEqual([LIVE.roles.Lead.binding.options?.canonicalModel, LIVE.roles.Worker.binding.options?.canonicalModel],
    ["claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001"]);
  assert.deepEqual([LIVE.roles.Reviewer.binding.options?.malformedOutputRetries, LIVE.roles.Reviewer.binding.options?.maxModelSteps], [0, 4],
    "the Reviewer's provider-internal retry is off");
  // Every model process of a role must carry exactly its model, effort and turn limit.
  assert.deepEqual(ROUTE_ROLES.map(role => LIVE.roles[role].turnArgs), [CLAUDE_ARGS, CLAUDE_ARGS, MUSE_ARGS]);
  for (const role of ROUTE_ROLES) {
    const pairs = new Map(LIVE.roles[role].turnArgs!.map(([flag, value]) => [flag, value]));
    assert.equal(pairs.get("--model"), LIVE.roles[role].binding.model, `${role}: argv model is the granted model`);
    assert.equal(pairs.get("--effort") ?? pairs.get("--reasoning-effort"), LIVE.roles[role].binding.effort, `${role}: argv effort is the granted effort`);
  }
  // No other model, effort or runtime: no Opus/Sonnet, no high effort, not Claude 2.1.281, no API-key lane.
  const text = JSON.stringify(LIVE);
  assert.doesNotMatch(text, /opus|sonnet|"high"|"max"|2\.1\.281|payg|apiKey/iu);
  // The pinned fixture, the frozen data, the own namespace.
  assert.match(LIVE.fixtureSha256 ?? "", /^[0-9a-f]{64}$/u);
  assert.deepEqual([LIVE.fixtureSha256, PLAN.fixtureSha256], [routeFixtureIdentity(), routeFixtureIdentity()]);
  for (const value of [LIVE, LIVE.roles, LIVE.turns, LIVE.roles.Lead, LIVE.roles.Lead.turnArgs, LIVE.roles.Lead.turnArgs![0], LIVE.roles.Reviewer.turnArgs])
    assert.ok(Object.isFrozen(value));
  const namespaces = [...Object.values(PROPOSAL_PROBE_PROFILES.authorizations), ...Object.values(ROUTE_REHEARSAL_PROFILES.authorizations)]
    .map(entry => entry.evidenceDirectory);
  assert.equal(namespaces.filter(name => name === LIVE.evidenceDirectory).length, 1, "no other authorization shares its evidence namespace");
  // No proposal authorization was added or reopened: O5.5B9 and O5.5B11 stay consumed.
  assert.deepEqual(Object.entries(PROPOSAL_PROBE_PROFILES.authorizations).map(([id, entry]) => [id, entry.state]),
    [["O5.5B9", "consumed"], ["O5.5B11", "consumed"]]);
  assert.equal(ROUTE_REHEARSAL_PROFILES.families, PROPOSAL_PROBE_PROFILES);
});

test("O5.5B13 fixture identity: SHA-256 over every fixture file, canary, plan command, the task and the packet; the pin is today's fixture", () => {
  const sorted = (record: Readonly<Record<string, string>>) => Object.entries(record).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const expected = createHash("sha256").update(JSON.stringify({ files: sorted(REHEARSAL_FILES), canaries: sorted(ROUTE_CANARIES),
    plan: REHEARSAL_PLAN.commands, task: ROUTE_TASK, packet: ROUTE_PACKET })).digest("hex");
  assert.equal(routeFixtureIdentity(), expected);
  assert.equal(routeFixtureIdentity(), routeFixtureIdentity(), "deterministic");
  assert.equal(expected, "59c19d1f876f944410d0e3bee5a7d390770380993a563a978231e5355b938326", "the fixture the human approved");
});

test("O5.5B13 model-process identity: each authorized pair exactly once, in its separate form, with exactly its value", () => {
  const base = ["-p", "--model", "haiku", "--effort", "low", "--max-turns", "6", "--tools", "Read,Grep,Glob"];
  assert.deepEqual(turnIdentityGaps(CLAUDE_ARGS, base), []);
  const gaps = (args: string[]) => turnIdentityGaps(CLAUDE_ARGS, args);
  assert.deepEqual(gaps(["--model", "haiku", "--effort", "low"]), ["--max-turns 6"], "a missing turn limit");
  assert.deepEqual(gaps(base.map(arg => arg === "haiku" ? "opus" : arg)), ["--model haiku"], "another model");
  assert.deepEqual(gaps(base.map(arg => arg === "low" ? "high" : arg)), ["--effort low"], "another effort");
  assert.deepEqual(gaps([...base, "--model", "opus"]), ["--model haiku"], "a repeated flag whose later value could win");
  assert.deepEqual(gaps([...base, "--model=opus"]), ["--model haiku"], "an inline spelling");
  assert.deepEqual(gaps(["--model=haiku", "--effort", "low", "--max-turns", "6"]), ["--model haiku"], "only the separate form is accepted");
  assert.deepEqual(gaps(["--model", "haiku", "--max-turns", "6", "--effort"]), ["--effort low"], "a flag without its value");
  assert.deepEqual(turnIdentityGaps(MUSE_ARGS, ["exec", "--model", "muse-spark-1.3", "--reasoning-effort", "minimal",
    "--max-model-steps", "4"]), ["--reasoning-effort low"]);
  // Claude's model fallback is a widening flag for every Claude model process, route or probe.
  const claude = PROPOSAL_PROBE_PROFILES.profiles.claude!.turnPosture;
  assert.deepEqual(postureOf(claude, ["--fallback-model", "sonnet"]).widening, ["--fallback-model"]);
  assert.deepEqual(postureOf(claude, ["--fallback-model=sonnet"]).widening, ["--fallback-model=sonnet"]);
});

// ---------------------------------------------------------------- refusals before anything exists

test("O5.5B13 refusals: nested session, the pending plan, consumed or unknown identities, a changed fixture, reused O5.5B9/B11/B12 namespaces and a replay — nothing is created",
  async () => withInstalls(async i => withRoot(async dir => {
    const at = (name: string) => join(dir, name);
    // A registry WITHOUT adapters: even a wrongly admitted run could not start any provider process.
    const noAdapters = { ...routeRegistry(i, { Lead: "x", Worker: "x", Reviewer: "x" }), factories: new Map() };
    // The production identity is consumed; the checks behind the state gate run on an in-memory OPEN copy of it.
    const withLive = (patch: object): RouteProfileSet => ({ ...ROUTE_REHEARSAL_PROFILES,
      authorizations: { ...ROUTE_REHEARSAL_PROFILES.authorizations, [LIVE_ID]: { ...LIVE, ...patch } } });
    const open = withLive({ state: "open" });
    const live = (root: string, env = routeEnv(), profiles: RouteProfileSet = open, authorization = LIVE_ID) =>
      runRouteRehearsal({ env, registry: noAdapters, profiles, authorization, evidenceRoot: root });
    assert.equal(refusal(await live(at("a"), routeEnv(), ROUTE_REHEARSAL_PROFILES)), "authorizationConsumed", "after Stage 2 it can never run again");
    // Inside an agent session an open authorization is refused, for every session key.
    for (const key of PROPOSAL_PROBE_PROFILES.nestedSessionKeys)
      assert.equal(refusal(await live(at("nested"), routeEnv({ [key]: "1" }))), "nestedAgentSession", key);
    assert.equal(refusal(await live(at("nested"), routeEnv({ claudecode: "1" }))), "nestedAgentSession", "keys compare case-insensitively");
    assert.equal(refusal(await live(at("a"), routeEnv(), ROUTE_REHEARSAL_PROFILES, "O5.5B12-LIVE")), "authorizationPending");
    for (const token of ["O5.5B13-live", "O5.5B13", "O5.5B11", "O5.5B9", " O5.5B13-LIVE"])
      assert.equal(refusal(await live(at("a"), routeEnv(), ROUTE_REHEARSAL_PROFILES, token)), "unknownAuthorization", token);
    assert.equal(refusal(await live(at("a"), routeEnv(), withLive({ state: "open", fixtureSha256: "0".repeat(64) }))), "fixtureMismatch");
    assert.equal(refusal(await runRouteRehearsal({ env: routeEnv(), registry: noAdapters, authorization: TEST_ROUTE, evidenceRoot: at("a"),
      offlineRehearsal: true, profiles: testRouteProfiles(testRouteAuthorization(i, { fixtureSha256: routeFixtureIdentity().replace(/^./u, "f") })) })),
    "fixtureMismatch", "one changed digit");
    assert.equal(existsSync(at("nested")) || existsSync(at("a")), false, "no namespace, fixture, claim or evidence");
    // No prior claim is reusable: the O5.5B9 and O5.5B11 proposal namespaces and the O5.5B12 route namespace are foreign.
    const namespace = async (name: string, files: Record<string, unknown>) => {
      await mkdir(at(name));
      for (const [file, content] of Object.entries(files)) await writeFile(join(at(name), file), JSON.stringify(content));
      return at(name);
    };
    for (const [name, files] of [
      ["b9", { "authorization.json": { authorization: "O5.5B9", milestone: "O5.5B9" }, "claude.claim.json": { authorization: "O5.5B9", milestone: "O5.5B9" } }],
      ["b11", { "authorization.json": { authorization: "O5.5B11", milestone: "O5.5B11" }, "claude.claim.json": { authorization: "O5.5B11", milestone: "O5.5B11" } }],
      ["b12", { "authorization.json": { authorization: "O5.5B12-LIVE", milestone: "O5.5B12" } }],
      ["unmarked", { "route.claim.json": { authorization: LIVE_ID, milestone: "O5.5B13" } }],
      ["foreignClaim", { "authorization.json": { authorization: LIVE_ID, milestone: "O5.5B13" }, "claude.claim.json": { authorization: "O5.5B11", milestone: "O5.5B11" } }],
    ] as Array<[string, Record<string, unknown>]>) {
      const root = await namespace(name, files);
      assert.equal(refusal(await live(root)), "namespaceMismatch", name);
      assert.deepEqual((await readdir(root)).sort(), Object.keys(files).sort(), `${name}: untouched`);
    }
    // The replay: the O5.5B13 claim exists in its own namespace.
    const replay = await namespace("replay", { "authorization.json": { authorization: LIVE_ID, milestone: "O5.5B13" },
      "route.claim.json": { authorization: LIVE_ID, milestone: "O5.5B13", route: true } });
    assert.equal(refusal(await live(replay)), "alreadyAttempted");
    assert.deepEqual((await readdir(replay)).sort(), ["authorization.json", "route.claim.json"]);
  })));

test("O5.5B13 live entry: lists the pending plan and the consumed identity; bad usage refuses before anything exists (never started with the identity)",
  async () => withRoot(async dir => {
    const entry = resolve(process.cwd(), "dist/test/live/route-rehearsal.js");
    const temp = join(dir, "temp");
    await mkdir(temp);
    const child = spawnSync(process.execPath, [entry], { encoding: "utf8", timeout: 60_000, windowsHide: true,
      env: { SystemRoot: process.env.SystemRoot ?? "", PATH: process.env.PATH ?? "", TEMP: temp, TMP: temp, CLAUDECODE: "1" } });
    assert.equal(child.status, 2, child.stderr);
    assert.match(child.stderr, /Route authorizations: O5\.5B12-LIVE \(pending\); O5\.5B13-LIVE \(consumed\)\n/u);
    assert.deepEqual(await readdir(temp), []);
  }));
