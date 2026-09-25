import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ROUTE_ROLES, ROUTE_TURN_CLASSES, ROUTE_VIEW_OF, RouteTurnGate, runRouteRehearsal, SECOND_ATTEMPT_REASONS,
  type RouteAuthorization, type RouteReport, type RouteRefusal } from "../src/app/route-probe.js";
import { REHEARSAL_PLAN, ROUTE_PACKET, ROUTE_TASK } from "../src/app/route-fixture.js";
import type { AgentRole, ProviderAdapter } from "../src/core/domain.js";
import { FusionFailure } from "../src/core/errors.js";
import { inspectTask, verificationPlanReferences, verificationReferenceSignals } from "../src/core/policy/task-inspector.js";
import { reviewMode } from "../src/core/review/policy.js";
import { WORKFLOW_LIMITS } from "../src/core/workflow/engine.js";
import type { Transition, TransitionReason, WorkflowState } from "../src/core/workflow/types.js";
import { REVIEW_CYCLE_LIMIT } from "../src/core/review/policy.js";
import { ROUTE_REHEARSAL_PROFILES } from "../src/providers/probe-profiles.js";
import { DEFAULT_CONFIG } from "../src/providers/registry.js";
import { changeProposalLiveEvidence } from "../src/runtime/provider-profiles.js";
import { liveWriterAuthorization, REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport, writerReadiness } from "../src/app/writer-gate.js";
import { withRoot } from "./fixtures/probe-harness.js";
import { withInstalls, type Installs } from "./fixtures/provider-installs.js";
import { routeCompose, routeEnv, routeRegistry, testRouteAuthorization, testRouteBindings, testRouteProfiles, TEST_ROUTE } from "./fixtures/route-harness.js";
import { gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5B12 — the full-route authorization model: the frozen plan's data, refusals before anything exists, the per-turn gate
 * (unit), and the per-role static preflight. No provider is ever reached; nothing here needs a model turn.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const LIVE_ID = "O5.5B12-LIVE";
const LIVE = ROUTE_REHEARSAL_PROFILES.authorizations[LIVE_ID]!;
const refusal = (value: RouteReport | RouteRefusal): string | false => "refused" in value && value.reason;

// ---------------------------------------------------------------- the frozen plan

test("O5.5B12 plan: PENDING, exact per-role bindings on validated runtimes, cross-family review, the engine's own turn budget", () => {
  // O5.5B13 adds its own one-shot identity for this same plan; the O5.5B12 plan itself never opens.
  assert.deepEqual(Object.keys(ROUTE_REHEARSAL_PROFILES.authorizations), [LIVE_ID, "O5.5B13-LIVE", "O5.5B15-LEAD", "O5.5B17-LEAD", "O5.5B19-LEAD"]);
  assert.deepEqual([LIVE.state, LIVE.milestone, LIVE.evidenceDirectory], ["pending", "O5.5B12", "fusion-o5-5b12-route"]);
  const roles = LIVE.roles;
  assert.deepEqual(ROUTE_ROLES.map(role => [role, roles[role].family, roles[role].executable, roles[role].runtimeVersions,
    roles[role].binding.adapter, roles[role].binding.model, roles[role].binding.effort, roles[role].binding.maxTurns ?? null]), [
    ["Lead", "claude", "claude.exe", ["2.1.280"], "claude-one-shot", "haiku", "low", 6],
    ["Worker", "claude", "claude.exe", ["2.1.280"], "claude-one-shot", "haiku", "low", 6],
    ["Reviewer", "muse", "muse-bin-1.3.0-R3401.1.exe", ["1.3.0-R3401.1"], "muse-exec", "muse-spark-1.3", "low", null]]);
  assert.deepEqual([roles.Lead.binding.options?.canonicalModel, roles.Worker.binding.options?.canonicalModel], ["claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001"]);
  assert.equal(roles.Reviewer.binding.options?.malformedOutputRetries, 0, "no provider-internal retry for the Reviewer");
  assert.deepEqual([roles.Lead.requiredEnvironment, roles.Worker.requiredEnvironment], [["FUSION_CLAUDE_EXE"], ["FUSION_CLAUDE_EXE"]]);
  for (const role of ROUTE_ROLES) {
    assert.ok(roles[role].lanes.length > 0 && roles[role].lanes.every(lane => lane.startsWith("subscription")), `${role}: subscription lanes only`);
    for (const value of [roles[role].binding.model, roles[role].binding.effort, ...roles[role].runtimeVersions, roles[role].executable])
      assert.doesNotMatch(value, /[*?]|^$/u, `${role}: no wildcard`);
  }
  assert.notEqual(roles.Worker.family, roles.Reviewer.family, "the Change Author's work is reviewed by the other family");
  // The route's adapter kinds per role are the production policy's (default bindings); the Change Author is the live-proven profile.
  assert.equal(DEFAULT_CONFIG.bindings.find(b => b.role === "Lead")?.adapter, roles.Lead.binding.adapter);
  assert.equal(DEFAULT_CONFIG.bindings.find(b => b.role === "Reviewer")?.adapter, roles.Reviewer.binding.adapter);
  assert.equal(changeProposalLiveEvidence("claude", "claude-one-shot", "2.1.280", { model: "haiku", effort: "low" })?.outcome, "PASS");
  // The turn budget is the engine's own bounds: one plan, 1 + delegateRetries attempts, REVIEW_CYCLE_LIMIT reviews and adjudications.
  assert.deepEqual(LIVE.turns, { leadPlan: 1, changeAuthor: 1 + WORKFLOW_LIMITS.delegateRetries, freshReview: REVIEW_CYCLE_LIMIT,
    leadAdjudication: REVIEW_CYCLE_LIMIT });
  assert.equal(Object.values(LIVE.turns).reduce((a, b) => a + b, 0), 7, "the maximum model-turn budget");
  assert.deepEqual(ROUTE_TURN_CLASSES.map(turn => ROUTE_VIEW_OF[turn]), ["baseline", "baseline", "candidate", "candidate"]);
});

test("O5.5B12 plan: the fixture task takes the full route under the EXISTING policy (MEDIUM, verification-referenced → fresh review)", () => {
  const inspection = inspectTask(ROUTE_TASK);
  assert.equal(inspection.risk.level, "medium");
  const referenced = verificationReferenceSignals(inspection.paths, verificationPlanReferences(REHEARSAL_PLAN.commands));
  assert.deepEqual(referenced.map(signal => signal.code), ["verificationReferencedPath"]);
  assert.equal(reviewMode("medium", true, [...inspection.risk.signals, ...referenced]), "fresh");
  assert.equal(reviewMode("medium", true, inspection.risk.signals), "lead", "without the test file the policy would pick a Lead review");
  assert.deepEqual([ROUTE_PACKET.scope.allowedFiles, ROUTE_PACKET.scope.forbiddenFiles], [["src/quote.ts", "test/quote.test.ts"], ["package.json", "package-lock.json"]]);
});

// ---------------------------------------------------------------- refusals before anything exists

test("O5.5B12 refusals: pending, unknown and consumed authorizations, a nested session, a foreign namespace, a second attempt — nothing is created",
  async () => withInstalls(async i => withRoot(async dir => {
    const at = (name: string) => join(dir, name);
    const noAdapters = { ...routeRegistry(i, { Lead: "x", Worker: "x", Reviewer: "x" }), factories: new Map() };
    const run = (authorization: string, root: string, profiles = testRouteProfiles(testRouteAuthorization(i)), env = routeEnv()) =>
      runRouteRehearsal({ env, registry: noAdapters, profiles, authorization, evidenceRoot: root, offlineRehearsal: true });
    assert.equal(refusal(await runRouteRehearsal({ env: routeEnv(), registry: noAdapters, profiles: ROUTE_REHEARSAL_PROFILES,
      authorization: LIVE_ID, evidenceRoot: at("a") })), "authorizationPending", "the frozen plan cannot run");
    assert.equal(refusal(await run("O5.5B12-live", at("a"))), "unknownAuthorization", "the token is exact");
    assert.equal(refusal(await run("O5.5B11", at("a"))), "unknownAuthorization", "a proposal authorization is not a route authorization");
    assert.equal(refusal(await run(TEST_ROUTE, at("a"), testRouteProfiles(testRouteAuthorization(i, { state: "consumed" })))), "authorizationConsumed");
    assert.equal(refusal(await run(TEST_ROUTE, at("a"), testRouteProfiles(testRouteAuthorization(i, {}, { Reviewer: { family: "unknown" } })))), "unknownFamily");
    assert.equal(refusal(await run(TEST_ROUTE, at("a"), undefined, routeEnv({ CLAUDECODE: "1" }))), "nestedAgentSession");
    assert.equal(existsSync(at("a")), false, "no namespace, fixture, claim or evidence");
    // The consumed proposal namespaces' shapes are never read as a route namespace.
    await mkdir(at("b11"));
    await writeFile(join(at("b11"), "authorization.json"), JSON.stringify({ authorization: "O5.5B11", milestone: "O5.5B11" }));
    await writeFile(join(at("b11"), "claude.claim.json"), JSON.stringify({ authorization: "O5.5B11", milestone: "O5.5B11" }));
    assert.equal(refusal(await run(TEST_ROUTE, at("b11"))), "namespaceMismatch");
    await mkdir(at("b9"));
    await writeFile(join(at("b9"), "claude.claim.json"), "{}");
    assert.equal(refusal(await run(TEST_ROUTE, at("b9"))), "namespaceMismatch");
    // A replayed route authorization: its claim exists in its own namespace.
    await mkdir(at("replay"));
    await writeFile(join(at("replay"), "authorization.json"), JSON.stringify({ authorization: TEST_ROUTE, milestone: "TEST" }));
    await writeFile(join(at("replay"), "route.claim.json"), JSON.stringify({ authorization: TEST_ROUTE, milestone: "TEST" }));
    assert.equal(refusal(await run(TEST_ROUTE, at("replay"))), "alreadyAttempted");
    assert.deepEqual((await readdir(at("replay"))).sort(), ["authorization.json", "route.claim.json"]);
  })));

test("O5.5B12 live entry: the pending plan, an unknown token and bad usage are refused before anything exists", async () => withRoot(async dir => {
  const entry = resolve(process.cwd(), "dist/test/live/route-rehearsal.js");
  const temp = join(dir, "temp");
  await mkdir(temp);
  // The only route authorization is pending: the entry refuses it before any fixture, claim or process (and the nested-
  // session variable is a second barrier).
  const spawnEntry = (...args: string[]) => spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", timeout: 60_000, windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot ?? "", PATH: process.env.PATH ?? "", TEMP: temp, TMP: temp, CLAUDECODE: "1" } });
  for (const [args, status, message] of [[["--authorization", LIVE_ID], 3, /REFUSED \(authorizationPending\)/u],
    [["--authorization", "O5.5B11"], 3, /REFUSED \(unknownAuthorization\)/u],
    [[], 2, /Route authorizations: O5\.5B12-LIVE \(pending\)/u]] as Array<[string[], number, RegExp]>) {
    const child = spawnEntry(...args);
    assert.equal(child.status, status, `${args.join(" ")}: ${child.stderr}`);
    assert.match(child.stderr, message);
  }
  assert.deepEqual(await readdir(temp), []);
}));

// ---------------------------------------------------------------- the turn gate (unit)

const transition = (to: WorkflowState, reason: TransitionReason, attempt?: number): Transition =>
  ({ from: "received", to, reason, ...(attempt === undefined ? {} : { attempt }) });
function gateOver(authorization: RouteAuthorization, transitions: Transition[]) {
  return new RouteTurnGate(authorization, () => transitions);
}

test("O5.5B12 gate: each turn class only in the engine state that requires it, in order, within budget", async () => withInstalls(async (i: Installs) => {
  const auth = testRouteAuthorization(i);
  const log: Transition[] = [];
  const gate = gateOver(auth, log);
  const admit = (role: string, call: string, request?: unknown) => gate.admit(role, call, request);
  // Nothing runs before the engine asks for it.
  assert.ok("refused" in admit("Lead", "runTurn"));
  log.push(transition("planning", "planRequested"));
  assert.deepEqual(admit("Lead", "runTurn"), { turn: "leadPlan", slot: 1 });
  for (const [role, call, request] of [["Worker", "runTurn"], ["Reviewer", "runTurn"], ["Explorer", "runTurn"], ["Lead", "runChangeProposalTurn"],
    ["Lead", "runStructuredTurn", { kind: "review", cycle: 1 }], ["Reviewer", "runStructuredTurn", { kind: "adjudication", cycle: 1 }]] as const)
    assert.ok("refused" in admit(role, call, request), `${role}.${call}`);
  // A Lead review (MEDIUM without a verification-referenced path) has no budget in this route.
  log.push(transition("reviewing", "reviewRequested"));
  assert.match(String((admit("Lead", "runTurn") as { refused: string }).refused), /may not run runTurn/u);
  // The Change Author's first slot only as attempt 1; its second only after a mechanical retry or correction.
  log.push(transition("delegating", "delegated", 1));
  assert.deepEqual(admit("Worker", "runChangeProposalTurn", { kind: "changeProposal" }), { turn: "changeAuthor", slot: 1 });
  log.push(transition("delegating", "delegated", 2));
  assert.match(String((admit("Worker", "runChangeProposalTurn") as { refused: string }).refused), /attempt 2, not slot 1/u);
  // Review and adjudication slots follow the engine's cycle numbers exactly.
  log.push(transition("reviewing", "freshReviewRequested", 1));
  assert.deepEqual(admit("Reviewer", "runStructuredTurn", { kind: "review", cycle: 1 }), { turn: "freshReview", slot: 1 });
  assert.ok("refused" in admit("Reviewer", "runStructuredTurn", { kind: "review", cycle: 2 }), "a cycle the engine did not start");
  log.push(transition("adjudicating", "adjudicationRequested", 1));
  assert.deepEqual(admit("Lead", "runStructuredTurn", { kind: "adjudication", cycle: 1 }), { turn: "leadAdjudication", slot: 1 });
  assert.equal(SECOND_ATTEMPT_REASONS.length, 3);
}));

test("O5.5B12 gate: the second Change Author slot opens only after reviewFindingsConfirmed, verificationFailed or applicationRejected; a third never",
  async () => withInstalls(async (i: Installs) => {
    const counting = () => {
      const calls: string[] = [];
      const adapter = { runChangeProposalTurn: async () => { calls.push("proposal"); return { status: "completed" }; },
        capabilities: async function (this: unknown) { return this; } } as unknown as ProviderAdapter;
      return { calls, adapter };
    };
    for (const [reason, admitted] of [["reviewFindingsConfirmed", true], ["verificationFailed", true], ["applicationRejected", true],
      ["delegateUnsuccessful", false], [undefined, false]] as Array<[TransitionReason | undefined, boolean]>) {
      const log: Transition[] = [transition("delegating", "delegated", 1)];
      const gate = gateOver(testRouteAuthorization(i), log);
      const { calls, adapter } = counting();
      const wrapped = gate.wrap("Worker" as AgentRole, adapter);
      await wrapped.runChangeProposalTurn!({ id: "s1" } as never, { kind: "changeProposal" } as never);
      if (reason !== undefined) log.push(transition("retrying", reason, 1));
      log.push(transition("delegating", "delegated", 2));
      const second = wrapped.runChangeProposalTurn!({ id: "s2" } as never, { kind: "changeProposal" } as never);
      if (admitted) await second; else await assert.rejects(second, (e: unknown) => e instanceof FusionFailure && e.error.kind === "SecurityViolation");
      assert.equal(calls.length, admitted ? 2 : 1, `${String(reason)}: a refused turn never reaches the adapter`);
      assert.equal(gate.used("changeAuthor"), admitted ? 2 : 1);
      if (admitted) {
        log.push(transition("retrying", "verificationFailed", 2), transition("delegating", "delegated", 3));
        await assert.rejects(wrapped.runChangeProposalTurn!({ id: "s3" } as never, { kind: "changeProposal" } as never));
        assert.equal(calls.length, 2, "the budget of two is never exceeded");
      }
    }
  }));

test("O5.5B12 gate: a failed or malformed turn consumes its slot; the consumption is durable before the provider is reached", async () => withInstalls(async (i: Installs) => {
  const log: Transition[] = [transition("planning", "planRequested")];
  const durable: string[] = [];
  const order: string[] = [];
  const gate = new RouteTurnGate(testRouteAuthorization(i), () => log, async entry => { order.push("ledger"); durable.push(`${String(entry.turn)}#${String(entry.slot)}`); });
  const adapter = { runTurn: async () => { order.push("provider"); return { status: "failed", error: { kind: "MalformedOutput" } }; } } as unknown as ProviderAdapter;
  const wrapped = gate.wrap("Lead" as AgentRole, adapter);
  const result = await wrapped.runTurn({ id: "s1" } as never, {} as never);
  assert.equal((result as { status: string }).status, "failed");
  assert.deepEqual([gate.turns[0]!.outcome, gate.turns[0]!.errorKind, order, durable], ["failed", "MalformedOutput", ["ledger", "provider"], ["leadPlan#1"]]);
  await assert.rejects(wrapped.runTurn({ id: "s2" } as never, {} as never), /leadPlan budget of 1 is exhausted/u);
  assert.deepEqual([order, gate.refusals.length], [["ledger", "provider"], 1], "no retry reaches the provider");
}));

// ---------------------------------------------------------------- per-role static preflight

test("O5.5B12 preflight: a wrong model, effort or version, a PAYG variable, an unauthorized lane or a missing pin is BLOCKED before any process",
  { skip }, async () => withInstalls(async i => withRoot(async dir => {
    const scripts = { Lead: join(dir, "l.json"), Worker: join(dir, "w.json"), Reviewer: join(dir, "r.json") };
    const blocked = async (name: string, options: Readonly<{ authorization?: RouteAuthorization; bindings?: Parameters<typeof testRouteBindings>[2];
      env?: NodeJS.ProcessEnv }> = {}) => {
      const authorization = options.authorization ?? testRouteAuthorization(i);
      const report = await runRouteRehearsal({ env: options.env ?? routeEnv({ FUSION_CLAUDE_EXE: i.claudeExe }), registry: routeRegistry(i, scripts),
        profiles: testRouteProfiles(authorization), authorization: TEST_ROUTE, evidenceRoot: join(dir, name),
        bindings: testRouteBindings(i, authorization, options.bindings), offlineRehearsal: true, compose: routeCompose(dir) });
      assert.ok(!("refused" in report), name);
      const r = report as RouteReport;
      assert.deepEqual([r.evidence.stage, r.modelTurns, r.evidence.launches], ["preflight", 0, undefined], name);
      assert.equal(existsSync(join(dir, name, "route.claim.json")), false, `${name}: a preflight block consumes nothing`);
      return r;
    };
    const model = await blocked("model", { bindings: { Lead: { model: "opus" } } });
    assert.deepEqual([model.outcome, model.detail], ["MODEL_BLOCKED", "Lead: the binding differs from the authorization (model)"]);
    assert.equal((await blocked("effort", { bindings: { Reviewer: { effort: "high" } } })).outcome, "MODEL_BLOCKED");
    assert.equal((await blocked("turns", { bindings: { Worker: { maxTurns: 20 } } })).outcome, "MODEL_BLOCKED");
    assert.equal((await blocked("canonical", { bindings: { Worker: { options: { canonicalModel: "claude-opus-5-5" } } } })).outcome, "MODEL_BLOCKED");
    assert.equal((await blocked("retry", { bindings: { Reviewer: { options: { malformedOutputRetries: 1 } } } })).outcome, "MODEL_BLOCKED",
      "a provider-internal retry the plan does not grant");
    for (const [name, extra] of [["api-key", { ANTHROPIC_API_KEY: "sk-ant-api03-fixture" }], ["muse-key", { MODEL_API_KEY: "fixture" }]] as const)
      assert.equal((await blocked(name, { env: routeEnv({ FUSION_CLAUDE_EXE: i.claudeExe, ...extra }) })).outcome, "AUTH_BLOCKED", name);
    const lane = await blocked("lane", { authorization: testRouteAuthorization(i, {}, { Reviewer: { lanes: ["subscriptionToken"] } }) });
    assert.deepEqual([lane.outcome, lane.detail], ["AUTH_BLOCKED", "Reviewer: credential lane subscription is not authorized (subscriptionToken)"]);
    const pin = await blocked("pin", { authorization: testRouteAuthorization(i, {}, { Lead: { requiredEnvironment: ["FUSION_CLAUDE_EXE"] } }), env: routeEnv() });
    assert.deepEqual([pin.outcome, pin.detail], ["VERSION_BLOCKED", "Lead: the authorization requires the pinned runtime variable(s) FUSION_CLAUDE_EXE"]);
    await writeFile(join(i.dir, "claude-code", "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", version: "2.1.281" }));
    const version = await blocked("version");
    assert.deepEqual([version.outcome, version.detail], ["VERSION_BLOCKED", "Lead: installed 2.1.281 is not a validated claude-one-shot release"]);
  })));

// ---------------------------------------------------------------- readiness

test("O5.5B12 readiness: the harness is implementation evidence only — no live row, aggregate readiness or the live gate moves", () => {
  const rows = Object.fromEntries(writerGateReport().rows.map(row => [row.id, [row.state, row.evidenceKind]]));
  assert.deepEqual(rows.fullRouteRehearsalImplementation, ["satisfied", "fakeProcess"]);
  assert.deepEqual(rows.hostControlledWriterWorkflow, ["partial", "fakeProviderRehearsal"], "no live full route has passed");
  assert.deepEqual(rows.providerChangeProposal, ["satisfied", "recordedLiveProbe"]);
  for (const id of ["primaryProtection", "providerWorkspaceBoundary", "ignoredPathProtection", "dependencySupport", "sharedGitAndIgnoredPaths"])
    assert.equal(rows[id]![0], "partial", id);
  assert.deepEqual(rows.verificationIsolation, ["notEvaluated", "none"]);
  assert.deepEqual(rows.liveGateAuthorization, ["blocked", "none"]);
  assert.deepEqual([writerGateReport().realWriterModeReady, REAL_WRITER_LIVE_GATE_AUTHORIZED, writerReadiness().ready, liveWriterAuthorization().authorized],
    [false, false, false, false]);
  for (const input of ["FULL_ROUTE_LIVE_EVIDENCE: PASS", { kind: "fullRouteRehearsal", outcome: "PASS", evidenceKind: "liveProvider" }])
    assert.deepEqual(writerGateReport({ linuxVerification: input }), writerGateReport(), "no rehearsal evidence moves a row");
});
