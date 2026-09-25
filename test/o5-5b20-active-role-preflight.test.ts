import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { AdapterFactory, ProviderRegistry } from "../src/app/providers.js";
import { runRouteRehearsal, type RouteAuthorization, type RouteReport } from "../src/app/route-probe.js";
import { REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport } from "../src/app/writer-gate.js";
import { resolveRole } from "../src/core/policy/routing.js";
import { ROUTE_REHEARSAL_PROFILES } from "../src/providers/probe-profiles.js";
import { fullRouteLiveCoverage, leadPlanLiveRecords, routePreflightBlocks } from "../src/runtime/provider-profiles.js";
import { withRoot } from "./fixtures/probe-harness.js";
import { installMuseVersion, withInstalls, type Installs } from "./fixtures/provider-installs.js";
import { asRun, plan, PREFIX, routeCompose, routeEnv, routeRegistry, runRoute, sectionOf, testRouteAuthorization, testRouteBindings,
  testRouteProfiles, TEST_ROUTE } from "./fixtures/route-harness.js";
import { gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5B20 — preflight checks only the roles an authorization lets start. A role with no authorized turn is never
 * inspected (it cannot even open a session), a Lead that only plans is held to the read-only surface its plan needs, and
 * with no fresh-review budget the engine does not route the review roles before work starts. Every role with a nonzero
 * budget stays fail-closed exactly as before. Real adapter code against fake binaries; no provider is reached.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const MUSE_1_4 = "1.4.0-R4161.1";
const LEAD_ONLY = Object.freeze({ leadPlan: 1, changeAuthor: 0, freshReview: 0, leadAdjudication: 0 });
type Preflight = Record<string, { active: boolean; authorizedTurns: number; checked?: string; eligibility?: { surface: string } }>;

/** Preflight (and, when it passes, the rest of the run with a scripted Lead plan) under `authorization`. */
async function attempt(i: Installs, dir: string, name: string, authorization: RouteAuthorization,
  options: Readonly<{ env?: NodeJS.ProcessEnv; registry?: (scripts: Record<"Lead" | "Worker" | "Reviewer", string>) => ProviderRegistry }> = {}) {
  const scripts = { Lead: join(dir, `${name}-l.json`), Worker: join(dir, `${name}-w.json`), Reviewer: join(dir, `${name}-r.json`) };
  await writeFile(scripts.Lead, JSON.stringify([{ prefix: PREFIX.plan, output: plan() }]));
  await writeFile(scripts.Worker, "[]");
  await writeFile(scripts.Reviewer, "[]");
  return await runRouteRehearsal({ env: options.env ?? routeEnv({ FUSION_CLAUDE_EXE: i.claudeExe }),
    registry: options.registry?.(scripts) ?? routeRegistry(i, scripts), profiles: testRouteProfiles(authorization), authorization: TEST_ROUTE,
    evidenceRoot: join(dir, name), bindings: testRouteBindings(i, authorization), offlineRehearsal: true, compose: routeCompose(dir) }) as RouteReport;
}
const blocked = (report: RouteReport) => [report.outcome, report.detail, report.evidence.stage, report.modelTurns];

test("O5.5B20 Lead-only with an unvalidated Muse 1.4.0-R4161.1 installed: the zero-budget Reviewer is never inspected; the Lead runs",
  { skip }, async () => withInstalls(async i => withRoot(async dir => {
    await installMuseVersion(i, MUSE_1_4);
    const report = await attempt(i, dir, "lead-only", testRouteAuthorization(i, { turns: LEAD_ONLY }));
    assert.deepEqual([report.outcome, report.detail, report.evidence.stage, report.modelTurns], ["TURN_REFUSED",
      "a role turn was refused before it reached the provider: the Worker role has no authorized turn in this authorization", "workflow", 1],
    "preflight passed, routing passed, the Lead plan ran, the zero budget stopped the Worker");
    const preflight = report.evidence.preflight as Preflight;
    assert.deepEqual(preflight.Reviewer, { family: "muse", active: false, authorizedTurns: 0, checked: "notRequired" });
    assert.deepEqual(preflight.Worker, { family: "claude", active: false, authorizedTurns: 0, checked: "notRequired" });
    assert.deepEqual([preflight.Lead!.active, preflight.Lead!.authorizedTurns, preflight.Lead!.eligibility!.surface], [true, 1, "readOnly"]);
    assert.equal((report.evidence.route as { reviewRoutingDeferred: boolean }).reviewRoutingDeferred, true);
    const launches = report.evidence.launches as Array<{ executable: string }>;
    assert.ok(launches.length > 0 && launches.every(l => !l.executable.startsWith("muse-bin-")), "no Muse process of any kind");
    assert.ok(existsSync(join(dir, "lead-only", "route.claim.json")), "the claim was written only once preflight passed");
  })));

test("O5.5B20 the engine change was necessary: an unvalidated Muse cannot be routed as a fresh Reviewer, so up-front routing would fail",
  async () => withInstalls(async i => {
    await installMuseVersion(i, MUSE_1_4);
    const authorization = testRouteAuthorization(i);
    const registry = routeRegistry(i, { Lead: "x", Worker: "x", Reviewer: "x" });
    const reviewer = await registry.factories.get("muse-exec")!.create(testRouteBindings(i, authorization).Reviewer,
      { workspace: dir(i), env: routeEnv(), sessionWorkspaces: "required" });
    await assert.rejects(resolveRole("Reviewer", [reviewer], undefined, { structuredTurns: true, reviewIsolation: true, workspaceBinding: true }),
      /Reviewer/u, "fresh-review routing refuses it: its read-only controls are unknown for 1.4");
  }));
const dir = (i: Installs) => i.dir;

test("O5.5B20 an active Lead is still fully validated: Claude version, model, turn limit, credential and pin", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    const leadOnly = (roles: Parameters<typeof testRouteAuthorization>[2] = {}) => testRouteAuthorization(i, { turns: LEAD_ONLY }, roles);
    const apiKey = await attempt(i, dir, "api-key", leadOnly(), { env: routeEnv({ FUSION_CLAUDE_EXE: i.claudeExe, ANTHROPIC_API_KEY: "sk-ant-x" }) });
    assert.deepEqual([apiKey.outcome, apiKey.evidence.stage, apiKey.modelTurns], ["AUTH_BLOCKED", "preflight", 0]);
    assert.match(apiKey.detail, /^Lead: /u, "the active Lead is the role refused");
    assert.deepEqual(blocked(await attempt(i, dir, "pin", leadOnly({ Lead: { requiredEnvironment: ["FUSION_CLAUDE_EXE"] } }), { env: routeEnv() })),
      ["VERSION_BLOCKED", "Lead: the authorization requires the pinned runtime variable(s) FUSION_CLAUDE_EXE", "preflight", 0]);
    const model = await runRouteRehearsal({ env: routeEnv({ FUSION_CLAUDE_EXE: i.claudeExe }), registry: routeRegistry(i, { Lead: "x", Worker: "x", Reviewer: "x" }),
      profiles: testRouteProfiles(leadOnly()), authorization: TEST_ROUTE, evidenceRoot: join(dir, "model"),
      bindings: testRouteBindings(i, leadOnly(), { Lead: { model: "opus" } }), offlineRehearsal: true, compose: routeCompose(dir) }) as RouteReport;
    assert.deepEqual(blocked(model), ["MODEL_BLOCKED", "Lead: the binding differs from the authorization (model)", "preflight", 0]);
    const limit = await runRouteRehearsal({ env: routeEnv({ FUSION_CLAUDE_EXE: i.claudeExe }), registry: routeRegistry(i, { Lead: "x", Worker: "x", Reviewer: "x" }),
      profiles: testRouteProfiles(leadOnly()), authorization: TEST_ROUTE, evidenceRoot: join(dir, "limit"),
      bindings: testRouteBindings(i, leadOnly(), { Lead: { maxTurns: 12 } }), offlineRehearsal: true, compose: routeCompose(dir) }) as RouteReport;
    assert.deepEqual([limit.outcome, limit.evidence.stage, limit.modelTurns], ["MODEL_BLOCKED", "preflight", 0], "a different --max-turns");
    await writeFile(join(i.dir, "claude-code", "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", version: "2.1.281" }));
    assert.deepEqual(blocked(await attempt(i, dir, "version", leadOnly())),
      ["VERSION_BLOCKED", "Lead: installed 2.1.281 is not a validated claude-one-shot release", "preflight", 0]);
  })));

test("O5.5B20 a Reviewer with authorized turns still blocks on Muse 1.4.0-R4161.1 where its grant authorizes 1.3 only — full route or Reviewer budget alone",
  { skip }, async () => withInstalls(async i => withRoot(async dir => {
    await installMuseVersion(i, MUSE_1_4);
    for (const [name, turns] of [["full", ROUTE_REHEARSAL_PROFILES.authorizations["O5.5B13-LIVE"]!.turns],
      ["reviewer-one", { leadPlan: 1, changeAuthor: 1, freshReview: 1, leadAdjudication: 0 }]] as const) {
      const report = await attempt(i, dir, name, testRouteAuthorization(i, { turns }));
      // Since O5.5B24, 1.4.0-R4161.1 is validated for exactly this Reviewer binding; a grant authorizing 1.3 only still blocks it.
      assert.deepEqual(blocked(report), ["VERSION_BLOCKED", `Reviewer: installed ${MUSE_1_4} is not the authorized release (1.3.0-R3401.1)`, "preflight", 0], name);
      assert.equal(existsSync(join(dir, name, "route.claim.json")), false, `${name}: nothing consumed`);
      assert.equal(report.evidence.launches, undefined, `${name}: no process`);
    }
  })));

test("O5.5B20 changeAuthor=0: a Worker-only requirement does not block; with a Change Author budget it does", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    const workerPin = { Worker: { requiredEnvironment: ["FUSION_WORKER_ONLY_PIN"] } };
    const leadOnly = await attempt(i, dir, "worker-inactive", testRouteAuthorization(i, { turns: LEAD_ONLY }, workerPin));
    assert.equal(leadOnly.evidence.stage, "workflow", `${leadOnly.outcome}: ${leadOnly.detail}`);
    assert.deepEqual((leadOnly.evidence.preflight as Preflight).Worker, { family: "claude", active: false, authorizedTurns: 0, checked: "notRequired" });
    const withAuthor = await attempt(i, dir, "worker-active", testRouteAuthorization(i, { turns: { ...LEAD_ONLY, changeAuthor: 1 } }, workerPin));
    assert.deepEqual(blocked(withAuthor), ["VERSION_BLOCKED", "Worker: the authorization requires the pinned runtime variable(s) FUSION_WORKER_ONLY_PIN",
      "preflight", 0]);
  })));

test("O5.5B20 leadAdjudication=0: the adjudication-only (structured review) surface does not block a planning Lead; with an adjudication budget it does",
  { skip }, async () => withInstalls(async i => withRoot(async dir => {
    // An adapter kind whose inspection reports no structured turns: read-only plans are fine, adjudication is not.
    const noStructured = (scripts: Record<"Lead" | "Worker" | "Reviewer", string>): ProviderRegistry => {
      const real = routeRegistry(i, scripts);
      const claude = real.factories.get("claude-one-shot")!;
      const inspectOnly: AdapterFactory = { ...claude, inspect: async (binding, context) => ({ ...await claude.inspect(binding, context), structuredTurns: false }) };
      return { ...real, factories: new Map([...real.factories, ["claude-one-shot", inspectOnly]]) };
    };
    const planning = await attempt(i, dir, "plan-only", testRouteAuthorization(i, { turns: LEAD_ONLY }), { registry: noStructured });
    assert.equal(planning.evidence.stage, "workflow", `${planning.outcome}: ${planning.detail}`);
    assert.deepEqual((planning.evidence.preflight as Preflight).Lead!.eligibility!.surface, "readOnly");
    const adjudicating = await attempt(i, dir, "adjudicating", testRouteAuthorization(i, { turns: { ...LEAD_ONLY, leadAdjudication: 1 } }),
      { registry: noStructured });
    assert.deepEqual(blocked(adjudicating), ["POSTURE_BLOCKED",
      "Lead: review ineligible: the adapter has no structured review/adjudication turn", "preflight", 0]);
  })));

test("O5.5B20 readiness: nothing moves — histories, rows and the live gate are unchanged", () => {
  assert.deepEqual(routePreflightBlocks().map(r => [r.milestone, r.outcome, r.blockedRole]), [["O5.5B19", "VERSION_BLOCKED", "Reviewer"]]);
  assert.deepEqual(leadPlanLiveRecords().slice(0, 2).map(r => [r.milestone, r.outcome]), [["O5.5B15", "FAIL"], ["O5.5B17", "FAIL"]]);
  assert.deepEqual([fullRouteLiveCoverage().attempts >= 1, fullRouteLiveCoverage().passed], [true, 0]);
  const report = writerGateReport();
  const rows = Object.fromEntries(report.rows.map(row => [row.id, [row.state, row.evidenceKind]]));
  assert.deepEqual([rows.fullRouteLive, rows.hostControlledWriterWorkflow, rows.providerChangeProposal, rows.liveGateAuthorization],
    [["blocked", "recordedLiveProbe"], ["partial", "fakeProviderRehearsal"], ["satisfied", "recordedLiveProbe"], ["blocked", "none"]]);
  assert.deepEqual([report.realWriterModeReady, REAL_WRITER_LIVE_GATE_AUTHORIZED], [false, false]);
  // Only the later O5.5B21 Lead contract retest may be open (its own tests cover it).
  assert.ok(Object.entries(ROUTE_REHEARSAL_PROFILES.authorizations).every(([id, entry]) => id === "O5.5B21-LEAD" || id === "O5.5B25-LIVE" || entry.state !== "open"),
    "no other live authorization is open");
});

test("O5.5B20 the fresh-review path is unchanged when the Reviewer has a budget (fake, full route)", { skip }, async () => withInstalls(async i => withRoot(async dir => {
  const run = asRun(await runRoute(i, dir, "full", { Lead: [{ prefix: PREFIX.plan, output: plan() }],
    Worker: [{ prefix: PREFIX.proposal, output: "```json\n{}\n```" }] }));
  const preflight = sectionOf<Preflight>(run, "preflight");
  assert.deepEqual([preflight.Lead!.eligibility!.surface, preflight.Worker!.eligibility!.surface, preflight.Reviewer!.eligibility!.surface],
    ["review", "changeProposal", "review"], "every active role keeps its full check");
  assert.equal(sectionOf<{ reviewRoutingDeferred: boolean }>(run, "route").reviewRoutingDeferred, false);
})));
