import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { fullRouteLiveCoverage, fullRouteLiveRecords, leadPlanLiveRecords, transportProfile } from "../src/runtime/provider-profiles.js";
import { withRoot } from "./fixtures/probe-harness.js";
import { withInstalls } from "./fixtures/provider-installs.js";
import { asRun, fenced, plan, PREFIX, routeEnv, routeRegistry, runRoute, sectionOf, testRouteAuthorization } from "./fixtures/route-harness.js";
import { gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5B19 — the one authorized Lead CONTRACT retest after O5.5B16 (planning prompt) and O5.5B18 (single-fence Lead
 * envelope): the O5.5B17 shape exactly. Offline: its data, the gate, refusals before anything exists, and the real
 * Claude adapter against the fake binary — every accepted and refused reply format end to end through the route, with the
 * route stopping before the Worker. The production authorization only ever runs against a registry WITHOUT adapters; the
 * live entry is never started with it.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const ID = "O5.5B19-LEAD";
const B19 = ROUTE_REHEARSAL_PROFILES.authorizations[ID]!;
const B17 = ROUTE_REHEARSAL_PROFILES.authorizations["O5.5B17-LEAD"]!;
const CANARY = "LEAD-CONTRACT-SUMMARY-CANARY-8d0e";
const PLAN = plan(`Plan: tax the discounted subtotal in src/quote.ts; add a full-discount test. ${CANARY}`);
const refusal = (value: RouteReport | RouteRefusal): string | false => "refused" in value && value.reason;
type Turn = { claim: string; outcome: string; errorKind?: string; contract: string; structuredOutput: Record<string, unknown> | null;
  terminal: Record<string, unknown> };

test("O5.5B19 authorization: RETIRED after its preflight block, the O5.5B17 shape exactly — same grants, fixture, one-turn budget; only milestone and namespace differ", () => {
  assert.deepEqual(Object.keys(ROUTE_REHEARSAL_PROFILES.authorizations), ["O5.5B12-LIVE", "O5.5B13-LIVE", "O5.5B15-LEAD", "O5.5B17-LEAD", ID, "O5.5B21-LEAD", "O5.5B25-LIVE", "O5.5B27-LIVE"]);
  // Its one attempt stopped in preflight (no claim, no model turn); it is retired and can never run.
  assert.deepEqual([B19.state, B19.milestone, B19.evidenceDirectory], ["retired", "O5.5B19", "fusion-o5-5b19-lead"]);
  const { milestone: _a, evidenceDirectory: _b, state: _c, ...retest } = B19;
  const { milestone: _d, evidenceDirectory: _e, state: _f, ...previous } = B17;
  assert.deepEqual(retest, previous);
  assert.deepEqual(B19.turns, { leadPlan: 1, changeAuthor: 0, freshReview: 0, leadAdjudication: 0 });
  const lead = B19.roles.Lead;
  assert.deepEqual([lead.runtimeVersions, lead.binding.model, lead.binding.options?.canonicalModel, lead.binding.effort, lead.binding.maxTurns,
    lead.turnArgs, lead.lanes], [["2.1.280"], "haiku", "claude-haiku-4-5-20251001", "low", 6,
    [["--model", "haiku"], ["--effort", "low"], ["--max-turns", "6"]], ["subscription", "subscriptionToken"]]);
  assert.equal(B19.fixtureSha256, routeFixtureIdentity());
  const namespaces = [...Object.values(PROPOSAL_PROBE_PROFILES.authorizations), ...Object.values(ROUTE_REHEARSAL_PROFILES.authorizations)]
    .map(entry => entry.evidenceDirectory);
  assert.equal(namespaces.filter(name => name === B19.evidenceDirectory).length, 1, "its own evidence namespace");
  assert.deepEqual(Object.entries(ROUTE_REHEARSAL_PROFILES.authorizations).filter(([id, entry]) => entry.state === "open" && id !== "O5.5B21-LEAD" && id !== "O5.5B25-LIVE" && id !== "O5.5B27-LIVE").map(([id]) => id), [],
    "nothing of its time is open");
  assert.ok(Object.values(PROPOSAL_PROBE_PROFILES.authorizations).every(entry => entry.state === "consumed"));
  // The Lead's contract under test: the O5.5B16 planning prompt (unchanged since O5.5B17) and the O5.5B18 Lead envelope.
  assert.equal(createHash("sha256").update(LEAD_PLAN_INSTRUCTION).digest("hex"), "59d3aed7de0b1d9c5b5c0a1b59b0382311ed05cfce26c4dc6afa9d4daf871387");
  assert.deepEqual([packetEnvelope("plan").policy, transportProfile("claude", "claude-one-shot")!.leadPlanEnvelope], ["rawOrSingleJsonFence", "rawOrSingleJsonFence"]);
});

test("O5.5B19 gate: one Lead plan turn, never a second; the Worker and Reviewer never open a session", async () => {
  const log: Transition[] = [];
  const gate = new RouteTurnGate(B19, () => log);
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

test("O5.5B19 refusals: nested session, unknown or consumed identities, a changed fixture, a reused O5.5B17 namespace and a replay — nothing is created",
  async () => withInstalls(async i => withRoot(async dir => {
    const at = (name: string) => join(dir, name);
    // A registry WITHOUT adapters: even a wrongly admitted run could not start any provider process.
    const noAdapters = { ...routeRegistry(i, { Lead: "x", Worker: "x", Reviewer: "x" }), factories: new Map() };
    const withB19 = (patch: object): RouteProfileSet => ({ ...ROUTE_REHEARSAL_PROFILES,
      authorizations: { ...ROUTE_REHEARSAL_PROFILES.authorizations, [ID]: { ...B19, ...patch } } });
    // The production identity is retired; the checks behind the state gate run on an in-memory OPEN copy of it.
    const open = withB19({ state: "open" });
    const live = (root: string, env = routeEnv(), profiles: RouteProfileSet = open, authorization = ID) =>
      runRouteRehearsal({ env, registry: noAdapters, profiles, authorization, evidenceRoot: root });
    for (const key of PROPOSAL_PROBE_PROFILES.nestedSessionKeys)
      assert.equal(refusal(await live(at("nested"), routeEnv({ [key]: "1" }))), "nestedAgentSession", `inside an agent session (${key})`);
    for (const token of ["O5.5B19-lead", "O5.5B19", " O5.5B19-LEAD"])
      assert.equal(refusal(await live(at("a"), routeEnv(), ROUTE_REHEARSAL_PROFILES, token)), "unknownAuthorization", token);
    assert.equal(refusal(await live(at("a"), routeEnv(), ROUTE_REHEARSAL_PROFILES, "O5.5B17-LEAD")), "authorizationConsumed");
    assert.equal(refusal(await live(at("a"), routeEnv(), ROUTE_REHEARSAL_PROFILES)), "authorizationRetired", "the production identity: retired");
    assert.equal(refusal(await live(at("a"), routeEnv(), withB19({ state: "consumed" }))), "authorizationConsumed");
    assert.equal(refusal(await live(at("a"), routeEnv(), withB19({ state: "open", fixtureSha256: "0".repeat(64) }))), "fixtureMismatch");
    assert.equal(existsSync(at("nested")) || existsSync(at("a")), false, "no namespace, fixture, claim or evidence");
    const namespace = async (name: string, files: Record<string, unknown>) => {
      await mkdir(at(name));
      for (const [file, content] of Object.entries(files)) await writeFile(join(at(name), file), JSON.stringify(content));
      return at(name);
    };
    assert.equal(refusal(await live(await namespace("b17", { "authorization.json": { authorization: "O5.5B17-LEAD", milestone: "O5.5B17" },
      "route.claim.json": { authorization: "O5.5B17-LEAD", milestone: "O5.5B17" } }))), "namespaceMismatch", "no earlier Lead claim is reusable");
    const replay = await namespace("replay", { "authorization.json": { authorization: ID, milestone: "O5.5B19" },
      "route.claim.json": { authorization: ID, milestone: "O5.5B19", route: true } });
    assert.equal(refusal(await live(replay)), "alreadyAttempted", "one-shot: its claim refuses a second run");
    assert.deepEqual((await readdir(replay)).sort(), ["authorization.json", "route.claim.json"]);
  })));

/** One fake Lead-only run under the O5.5B19 budget: the Lead replies with `output` after a successful 5-turn model turn. */
async function leadRun(i: Parameters<typeof testRouteAuthorization>[0], dir: string, name: string, output: string) {
  const run = asRun(await runRoute(i, dir, name, { Lead: [{ prefix: PREFIX.plan, output, resultFrame: { num_turns: 5 } }] },
    { authorization: testRouteAuthorization(i, { turns: B19.turns }) }));
  const [turn, ...rest] = sectionOf<Turn[]>(run, "turns");
  assert.deepEqual(rest, [], name);
  assert.equal(run.prompts.Worker.length + run.prompts.Reviewer.length, 0, `${name}: no later role reached its provider`);
  assert.ok(run.prompts.Lead[0]!.startsWith(LEAD_PLAN_INSTRUCTION), `${name}: the planning prompt`);
  const model = sectionOf<Array<{ purpose: string; args: string[] }>>(run, "launches").find(l => l.purpose === "providerTurn")!;
  assert.equal(model.args[model.args.indexOf("--max-turns") + 1], "6", `${name}: --max-turns 6`);
  assert.deepEqual([turn!.terminal.classification, turn!.terminal.internalTurnCount, turn!.terminal.processExitCode], ["RESULT_OK", 5, 0],
    `${name}: the model turn itself succeeded`);
  const text = await readFile(run.report.evidencePath, "utf8");
  assert.ok(!text.includes(CANARY) && !text.includes("```"), `${name}: no reply text persisted`);
  assert.equal(run.report.evidence.evidenceKind, "offlineRehearsal", `${name}: never live evidence`);
  return { run, turn: turn! };
}

test("O5.5B19 Lead contract PASS shape (fake): raw, json-fenced and bare-fenced valid plans are accepted; the route stops at the Worker",
  { skip }, async () => withInstalls(async i => withRoot(async dir => {
    for (const [name, output, cls] of [["raw", PLAN, "RAW_VALID_JSON"], ["json-fence", fenced(JSON.parse(PLAN)), "SINGLE_FENCED_VALID_JSON"],
      ["bare-fence", `\`\`\`\n${PLAN}\n\`\`\``, "SINGLE_FENCED_VALID_JSON"]] as const) {
      const { run, turn } = await leadRun(i, dir, name, output);
      assert.deepEqual([run.report.outcome, run.report.detail], ["TURN_REFUSED",
        "a role turn was refused before it reached the provider: the Worker role has no authorized turn in this authorization"], name);
      assert.deepEqual([turn.outcome, turn.contract], ["completed", "accepted"], `${name}: the Lead contract passed`);
      assert.deepEqual([turn.structuredOutput?.classification, turn.structuredOutput?.accepted, turn.structuredOutput?.policy,
        turn.structuredOutput?.bodyMatchesExpectedSchema], [cls, true, "rawOrSingleJsonFence", true], name);
      assert.deepEqual([turn.terminal.structuredParsingReached, turn.terminal.schemaValidationReached], [true, true], name);
    }
  })));

test("O5.5B19 Lead contract FAIL shapes (fake): prose, several, unclosed or other-language fences and schema-invalid plans are refused",
  { skip }, async () => withInstalls(async i => withRoot(async dir => {
    const invalid = { ...JSON.parse(PLAN) as object, extra: "x" };
    for (const [name, output, cls] of [["prose", `Here is the plan:\n${fenced(JSON.parse(PLAN))}`, "EXTRA_TEXT"],
      ["two-fences", `${fenced(JSON.parse(PLAN))}${fenced(JSON.parse(PLAN))}`, "MULTIPLE_FENCES"],
      ["unclosed", `\`\`\`json\n${PLAN}\n`, "UNCLOSED_FENCE"], ["js-fence", `\`\`\`js\n${PLAN}\n\`\`\``, "UNSUPPORTED_FENCE"],
      ["schema-invalid-fence", fenced(invalid), "INVALID_SCHEMA"]] as const) {
      const { run, turn } = await leadRun(i, dir, name, output);
      assert.deepEqual([run.report.outcome, run.report.detail], ["MALFORMED_OUTPUT",
        `leadPlan #1 (Lead): Claude structured output was refused: ${cls} under the rawOrSingleJsonFence envelope.`], name);
      assert.deepEqual([turn.outcome, turn.errorKind, turn.contract], ["failed", "MalformedOutput", "notReached:failed"], name);
      assert.deepEqual([turn.structuredOutput?.classification, turn.structuredOutput?.accepted], [cls, false], name);
    }
    // A raw plan that is not a ResultPacket passes the envelope and fails the unchanged contract check.
    const { run, turn } = await leadRun(i, dir, "schema-invalid-raw", JSON.stringify(invalid));
    assert.deepEqual([run.report.outcome, run.report.detail], ["MALFORMED_OUTPUT", "leadPlan #1 (Lead): Claude returned an invalid ResultPacket."]);
    assert.deepEqual([turn.structuredOutput?.classification, turn.structuredOutput?.accepted, turn.terminal.schemaValidationReached],
      ["INVALID_SCHEMA", true, true]);
  })));

test("O5.5B19 readiness: nothing moves offline; the O5.5B13/B15/B17 records stay; no live gate opens", () => {
  assert.deepEqual(leadPlanLiveRecords().slice(0, 2).map(r => [r.milestone, r.outcome, r.modelTurn]), [["O5.5B15", "FAIL", "FAIL"], ["O5.5B17", "FAIL", "PASS"]]);
  assert.deepEqual([fullRouteLiveCoverage().attempts >= 1, fullRouteLiveRecords().filter(r => r.milestone !== "O5.5B27").some(r => r.outcome === "PASS")], [true, false]);
  const report = writerGateReport();
  const rows = Object.fromEntries(report.rows.map(row => [row.id, [row.state, row.evidenceKind]]));
  assert.deepEqual([rows.fullRouteLive, rows.hostControlledWriterWorkflow, rows.providerChangeProposal, rows.liveGateAuthorization],
    [["partial", "recordedLiveProbe"], ["satisfied", "recordedLiveProbe"], ["satisfied", "recordedLiveProbe"], ["blocked", "none"]]);
  for (const input of ["CLAUDE_LEAD_CONTRACT_LIVE: PASS", { leadPlanLive: "PASS", contract: "accepted" }])
    assert.deepEqual(writerGateReport({ linuxVerification: input }), report);
  assert.deepEqual([report.realWriterModeReady, REAL_WRITER_LIVE_GATE_AUTHORIZED], [false, false]);
});

test("O5.5B19 live entry: lists the retired contract-retest identity; bad usage refuses before anything exists (never started with the identity)",
  async () => withRoot(async dir => {
    const temp = join(dir, "temp");
    await mkdir(temp);
    const child = spawnSync(process.execPath, [resolve(process.cwd(), "dist/test/live/route-rehearsal.js")], { encoding: "utf8", timeout: 60_000,
      windowsHide: true, env: { SystemRoot: process.env.SystemRoot ?? "", PATH: process.env.PATH ?? "", TEMP: temp, TMP: temp, CLAUDECODE: "1" } });
    assert.equal(child.status, 2, child.stderr);
    assert.match(child.stderr, /; O5\.5B17-LEAD \(consumed\); O5\.5B19-LEAD \(retired\)[;\n]/u);
    assert.deepEqual(await readdir(temp), []);
  }));
