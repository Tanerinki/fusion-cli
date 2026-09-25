import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { AdapterFactory } from "../src/app/providers.js";
import { routeLedger, runRouteRehearsal, type RouteAuthorization, type RouteReport } from "../src/app/route-probe.js";
import { REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport } from "../src/app/writer-gate.js";
import { ROUTE_REHEARSAL_PROFILES } from "../src/providers/probe-profiles.js";
import { changeProposalLiveRecords, fullRouteLiveRecords } from "../src/runtime/provider-profiles.js";
import { withRoot } from "./fixtures/probe-harness.js";
import { withInstalls, type Installs } from "./fixtures/provider-installs.js";
import { asRun, LEAD_SECRET, plan, PREFIX, routeCompose, routeEnv, routeRegistry, runRoute, sectionOf, testRouteAuthorization, testRouteBindings,
  testRouteProfiles, TEST_ROUTE, type ScriptedTurn } from "./fixtures/route-harness.js";
import { gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5B15 — the Lead-plan-only probe, offline with the REAL Claude adapter against the fake binary: one Lead turn, its
 * bounded terminal diagnostic in the evidence, and nothing after the Lead — the Worker never opens a session, no
 * Change Author, Reviewer or adjudication process starts. Every run is `offlineRehearsal`; nothing becomes live evidence.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const CANARY = "LEAD-PROBE-PROVIDER-TEXT-CANARY-7c20";
const LEAD_TURNS = ROUTE_REHEARSAL_PROFILES.authorizations["O5.5B15-LEAD"]!.turns;
/** The production Lead-only plan with the fake installs' executables and short timeouts. */
const leadOnly = (i: Installs, roles: Parameters<typeof testRouteAuthorization>[2] = {}): RouteAuthorization =>
  testRouteAuthorization(i, { turns: LEAD_TURNS }, roles);
type Turn = { claim: string; turn: string; outcome: string; contract: string; terminal: Record<string, unknown> | null };
const lead = (turn: Omit<ScriptedTurn, "prefix">): ScriptedTurn => ({ prefix: PREFIX.plan, ...turn });
const errorFrame = (subtype: string, terminalReason: string) => ({ subtype, is_error: true, terminal_reason: terminalReason, num_turns: 7,
  errors: [`${subtype}: ${CANARY}`], permission_denials: [{ tool_name: "Write", tool_use_id: "toolu_private", tool_input: { file_path: CANARY } }],
  result: "__absent__" });

async function assertLeadOnly(run: ReturnType<typeof asRun>, candidates = 0): Promise<Turn> {
  assert.deepEqual(sectionOf<Record<string, number>>(run, "turnUse"), { leadPlan: 1, changeAuthor: 0, freshReview: 0, leadAdjudication: 0 });
  assert.deepEqual(sectionOf<Record<string, number>>(run, "unusedSlots"), { leadPlan: 0, changeAuthor: 0, freshReview: 0, leadAdjudication: 0 });
  assert.equal(run.report.modelTurns, 1);
  // Only the Lead's processes: its session readback, and the turn's readback, inventory, two init probes and one model turn.
  assert.deepEqual(sectionOf<Record<string, number>>(run, "launchCounts"),
    { providerAuthReadback: 2, providerInventory: 1, providerInitProbe: 2, providerTurn: 1, providerHost: 0 });
  assert.equal(run.prompts.Worker.length + run.prompts.Reviewer.length, 0, "no later role reached its provider");
  // After an accepted plan the engine acquires the attempt's private candidate (a host-side clone, no provider process)
  // before the Worker's session is refused; it is released and proven gone. Nothing is applied or verified.
  assert.deepEqual([sectionOf<{ created: number }>(run, "candidates").created, sectionOf<{ released: number }>(run, "candidates").released],
    [candidates, candidates]);
  assert.deepEqual(sectionOf<{ events: unknown[]; runs: unknown[] }>(run, "verification"), { events: [], runs: [] });
  assert.deepEqual(sectionOf<unknown[]>(run, "proposals"), []);
  assert.equal(sectionOf<{ unchanged: boolean }>(run, "primary").unchanged, true);
  assert.deepEqual(sectionOf<{ leftoverOwnedTemporaries: string[] }>(run, "cleanup").leftoverOwnedTemporaries, []);
  assert.deepEqual((await routeLedger(run.root)).map(entry => `${String(entry.turn)}#${String(entry.slot)}`), ["leadPlan#1"]);
  const text = await readFile(run.report.evidencePath, "utf8");
  for (const secret of [CANARY, LEAD_SECRET, "toolu_private", PREFIX.plan, "Delegation:", "synthetic-not-a-secret-7a31"])
    assert.ok(!text.includes(secret), `evidence leaks ${secret}`);
  assert.equal(run.report.evidence.evidenceKind, "offlineRehearsal");
  const turns = sectionOf<Turn[]>(run, "turns");
  assert.equal(turns.length, 1);
  return turns[0]!;
}

test("O5.5B15 RESULT_OK: the Lead plan is accepted and recorded; the route then stops before the Worker opens a session", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    const run = asRun(await runRoute(i, dir, "ok", { Lead: [lead({ output: plan(), resultFrame: { num_turns: 3, permission_denials: [] } })] },
      { authorization: leadOnly(i) }));
    assert.deepEqual([run.report.outcome, run.report.detail], ["TURN_REFUSED",
      "a role turn was refused before it reached the provider: the Worker role has no authorized turn in this authorization"],
    "Lead success is not route success: the zero budget stops the route before any later role starts");
    const turn = await assertLeadOnly(run, 1);
    assert.deepEqual([turn.claim, turn.outcome, turn.contract], [`${TEST_ROUTE}:leadPlan#1`, "completed", "accepted"]);
    assert.deepEqual(turn.terminal, { schemaVersion: 1, classification: "RESULT_OK", resultSubtype: "success", terminalReason: "completed",
      isError: false, internalTurnCount: 3, permissionDenialCount: 0, errorEntryCount: null, resultTextPresent: true,
      resultTextByteLength: Buffer.byteLength(plan(), "utf8"), apiErrorStatusClass: "none", structuredParsingReached: true, schemaValidationReached: true,
      processExitCode: 0, processSignal: null, fusionTermination: null, timedOut: false, cancelled: false });
    assert.deepEqual(sectionOf<{ turns: Array<{ role: string; call: string }> }>(run, "refusals").turns.map(r => `${r.role}.${r.call}`),
      ["Worker.createSession"]);
  })));

test("O5.5B15 RESULT_ERROR_MAX_TURNS and RESULT_ERROR_DURING_EXECUTION: PROVIDER_FAILED with the diagnostic that says which; nothing after the Lead",
  { skip }, async () => withInstalls(async i => withRoot(async dir => {
    for (const [name, subtype, reason, classification] of [["max-turns", "error_max_turns", "max_turns", "RESULT_ERROR_MAX_TURNS"],
      ["execution", "error_during_execution", "model_error", "RESULT_ERROR_DURING_EXECUTION"]] as const) {
      const run = asRun(await runRoute(i, dir, name, { Lead: [lead({ exitCode: 1, resultFrame: errorFrame(subtype, reason) })] },
        { authorization: leadOnly(i) }));
      assert.deepEqual([run.report.outcome, run.report.detail], ["PROVIDER_FAILED", "leadPlan #1 (Lead): providerFailure: Claude reported a failed turn."], name);
      const turn = await assertLeadOnly(run);
      assert.deepEqual([turn.outcome, turn.contract], ["failed", "notReached:failed"], name);
      assert.deepEqual(turn.terminal, { schemaVersion: 1, classification, resultSubtype: subtype, terminalReason: reason, isError: true,
        internalTurnCount: 7, permissionDenialCount: 1, errorEntryCount: 1, resultTextPresent: false, resultTextByteLength: 0,
        apiErrorStatusClass: "none", structuredParsingReached: false, schemaValidationReached: false, processExitCode: 1, processSignal: null,
        fusionTermination: null, timedOut: false, cancelled: false }, name);
      assert.deepEqual(sectionOf<{ turns: unknown[] }>(run, "refusals").turns, [], `${name}: the engine stops at the failed plan`);
    }
  })));

test("O5.5B15 a wrong model, effort, turn limit, version, lane, credential or provider is BLOCKED before any model process", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    const scripts = { Lead: join(dir, "l.json"), Worker: join(dir, "w.json"), Reviewer: join(dir, "r.json") };
    const blocked = async (name: string, options: Readonly<{ authorization?: RouteAuthorization; bindings?: Parameters<typeof testRouteBindings>[2];
      env?: NodeJS.ProcessEnv }> = {}) => {
      const authorization = options.authorization ?? leadOnly(i);
      const report = await runRouteRehearsal({ env: options.env ?? routeEnv({ FUSION_CLAUDE_EXE: i.claudeExe }), registry: routeRegistry(i, scripts),
        profiles: testRouteProfiles(authorization), authorization: TEST_ROUTE, evidenceRoot: join(dir, name),
        bindings: testRouteBindings(i, authorization, options.bindings), offlineRehearsal: true, compose: routeCompose(dir) });
      assert.ok(!("refused" in report), name);
      const r = report as RouteReport;
      assert.deepEqual([r.evidence.stage, r.modelTurns], ["preflight", 0], name);
      assert.equal(existsSync(join(dir, name, "route.claim.json")), false, `${name}: nothing consumed`);
      return r;
    };
    assert.deepEqual([(await blocked("model", { bindings: { Lead: { model: "opus" } } })).detail], ["Lead: the binding differs from the authorization (model)"]);
    for (const [name, bindings] of [["effort", { Lead: { effort: "high" } }], ["turns", { Lead: { maxTurns: 12 } }],
      ["canonical", { Lead: { options: { canonicalModel: "claude-opus-5-5" } } }]] as const)
      assert.equal((await blocked(name, { bindings })).outcome, "MODEL_BLOCKED", name);
    assert.equal((await blocked("api-key", { env: routeEnv({ FUSION_CLAUDE_EXE: i.claudeExe, ANTHROPIC_API_KEY: "sk-ant-api03-fixture" }) })).outcome,
      "AUTH_BLOCKED", "no API-key or PAYG fallback");
    assert.equal((await blocked("lane", { authorization: leadOnly(i, { Lead: { lanes: ["subscription"] } }),
      env: routeEnv({ FUSION_CLAUDE_EXE: i.claudeExe, CLAUDE_CODE_OAUTH_TOKEN: "fixture-token" }) })).outcome, "AUTH_BLOCKED");
    // A provider substitution: the Lead's factory quietly builds the other family's adapter.
    const real = routeRegistry(i, scripts);
    const claude = real.factories.get("claude-one-shot")!, muse = real.factories.get("muse-exec")!;
    const swapped: AdapterFactory = { ...claude, create: async (binding, context) => binding.role === "Lead"
      ? muse.create({ ...binding, adapter: "muse-exec", model: "muse-spark-1.3", options: { provider: "meta", maxModelSteps: 4, malformedOutputRetries: 0 } }, context)
      : claude.create(binding, context) };
    const swap = asRun(await runRoute(i, dir, "swap", { Lead: [lead({ output: plan() })] }, { authorization: leadOnly(i),
      deps: { registry: { ...real, factories: new Map([["claude-one-shot", swapped], ["muse-exec", muse]]) } } }));
    assert.deepEqual([swap.report.outcome, swap.report.evidence.stage, swap.report.modelTurns], ["POSTURE_BLOCKED", "preflight", 0]);
    // A model process without exactly the authorized effort is refused by the guard; the one Lead slot is consumed, nothing retried.
    const identity = asRun(await runRoute(i, dir, "identity", { Lead: [lead({ output: plan() })] }, { authorization: leadOnly(i,
      { Lead: { turnArgs: [["--model", "haiku"], ["--effort", "medium"], ["--max-turns", "6"]] } }) }));
    assert.equal(identity.report.outcome, "MODEL_BLOCKED", identity.report.detail);
    assert.deepEqual([identity.prompts.Lead.length, sectionOf<Record<string, number>>(identity, "turnUse").leadPlan], [0, 1]);
    // Last: Claude 2.1.281 installed instead of the pinned 2.1.280.
    await writeFile(join(i.dir, "claude-code", "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", version: "2.1.281" }));
    assert.deepEqual([(await blocked("version")).detail], ["Lead: installed 2.1.281 is not a validated claude-one-shot release"]);
  })));

test("O5.5B15 no live gate opens: fake Lead runs move no row; the O5.5B13 record and the Change Author live history are unchanged", () => {
  const report = writerGateReport();
  const rows = Object.fromEntries(report.rows.map(row => [row.id, [row.state, row.evidenceKind]]));
  assert.deepEqual([rows.fullRouteLive, rows.hostControlledWriterWorkflow, rows.providerChangeProposal, rows.liveGateAuthorization],
    [["partial", "recordedLiveProbe"], ["satisfied", "recordedLiveProbe"], ["satisfied", "recordedLiveProbe"], ["blocked", "none"]]);
  assert.deepEqual(fullRouteLiveRecords().slice(0, 1).map(record => [record.milestone, record.outcome]), [["O5.5B13", "PROVIDER_FAILED"]]);
  assert.deepEqual(changeProposalLiveRecords("claude", "claude-one-shot").map(record => [record.milestone, record.outcome]),
    [["O5.5B9", "MALFORMED_PROPOSAL"], ["O5.5B11", "PASS"]]);
  for (const input of ["CLAUDE_LEAD_LIVE_PROBE: PASS", { classification: "RESULT_OK", evidenceKind: "liveProvider" }])
    assert.deepEqual(writerGateReport({ linuxVerification: input }), report);
  assert.deepEqual([report.realWriterModeReady, REAL_WRITER_LIVE_GATE_AUTHORIZED], [false, false]);
});
