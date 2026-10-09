import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileSha256 } from "../src/app/executable-identity.js";
import { routeFixtureIdentity, runRouteRehearsal, type RouteAuthorization } from "../src/app/route-probe.js";
import { liveWriterAuthorization, REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport, writerReadiness } from "../src/app/writer-gate.js";
import type { ChangeProposalRequest } from "../src/core/domain.js";
import { structuredTurnPrompt } from "../src/core/review/contract.js";
import { CLAUDE_PROPOSAL_REPLY_RULE, claudeStructuredPrompt } from "../src/providers/claude/one-shot-transport.js";
import { PROPOSAL_PROBE_PROFILES, REVIEWER_PROBE_PROFILES, ROUTE_REHEARSAL_PROFILES } from "../src/providers/probe-profiles.js";
import { defaultRegistry } from "../src/providers/registry.js";
import { fullRouteLiveCoverage, fullRouteLiveRecords, transportProfile, type BindingValidation } from "../src/runtime/provider-profiles.js";
import { withRoot } from "./fixtures/probe-harness.js";
import { installMuseVersion, withInstalls, type Installs } from "./fixtures/provider-installs.js";
import { RELEASE, releaseExe } from "./fixtures/reviewer-harness.js";
import { asRun, cleanReview, fenced, LEAD_SECRET, plan, PREFIX, proposal, routeEnv, runRoute, sectionOf, testRouteAuthorization, WORKER_SECRET,
  type RoleScripts } from "./fixtures/route-harness.js";
import { FIX, gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5B27 Stage 1 — the full-route live rehearsal after O5.5B26: exactly the O5.5B25 plan (roles, bindings, budgets,
 * fixture), with the O5.5B26 Change Author output discipline as the one behavioural difference. Offline only: the
 * production entry is never run; a TEST copy of its exact shape runs on the fake binaries.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const ID = "O5.5B27-LIVE";
const B27 = ROUTE_REHEARSAL_PROFILES.authorizations[ID]!;
const B25 = ROUTE_REHEARSAL_PROFILES.authorizations["O5.5B25-LIVE"]!;
const [VALIDATION] = transportProfile("muse", "muse-exec")!.bindingValidations;
/** The Claude reply rule every route before O5.5B26 carried (O5.5B10 to O5.5B25). */
const PREVIOUS_RULE = "Reply format (Fusion checks it mechanically): reply with the raw JSON object alone. The first character of your reply must be { " +
  "and the last must be }. Do not wrap it in a Markdown code fence and add no heading, explanation or any other text before or after it.";

async function b27(i: Installs): Promise<Readonly<{ authorization: RouteAuthorization; validations: readonly BindingValidation[] }>> {
  await installMuseVersion(i, RELEASE);
  const sha = await fileSha256(releaseExe(i));
  const reviewer = { ...B27.roles.Reviewer, executableDirectory: i.museDir, executableSha256: sha,
    binding: { ...B27.roles.Reviewer.binding, options: { ...B27.roles.Reviewer.binding.options, timeoutMs: 20_000 } } };
  return { authorization: testRouteAuthorization(i, { milestone: "TEST", turns: B27.turns }, { Reviewer: reviewer }),
    validations: [{ ...VALIDATION!, executableSha256: sha }] };
}
const route = async (i: Installs, dir: string, name: string, scripts: RoleScripts) => {
  const shape = await b27(i);
  return runRoute(i, dir, name, scripts, { authorization: shape.authorization,
    registry: { museBindingValidations: shape.validations, museExecutable: releaseExe(i) } });
};

test("O5.5B27 authorization: exactly the O5.5B25 plan — the same role grants, bindings, budgets and fixture; only milestone, namespace and state differ",
  async () => withRoot(async dir => {
    // Stage 1 prepared it open; it ran once live (Stage 2): consumed.
    assert.deepEqual([B27.milestone, B27.evidenceDirectory, B27.state], ["O5.5B27", "fusion-o5-5b27-route", "consumed"]);
    assert.equal(B27.roles, B25.roles, "the very same role grants (Claude 2.1.280 haiku/low --max-turns 6; the validated Muse 1.4 Reviewer)");
    assert.equal(B27.turns, B25.turns);
    assert.deepEqual({ ...B27.turns }, { leadPlan: 1, changeAuthor: 2, freshReview: 2, leadAdjudication: 2 });
    assert.deepEqual([B27.fixtureSha256, B25.fixtureSha256], [routeFixtureIdentity(), routeFixtureIdentity()]);
    assert.deepEqual({ ...B27, milestone: "x", evidenceDirectory: "x", state: "x" }, { ...B25, milestone: "x", evidenceDirectory: "x", state: "x" });
    const namespaces = [...Object.entries(ROUTE_REHEARSAL_PROFILES.authorizations).filter(([id]) => id !== ID).map(([, entry]) => entry.evidenceDirectory),
      ...Object.values(PROPOSAL_PROBE_PROFILES.authorizations).map(entry => entry.evidenceDirectory),
      ...Object.values(REVIEWER_PROBE_PROFILES.authorizations).map(entry => entry.evidenceDirectory)];
    assert.ok(!namespaces.includes(B27.evidenceDirectory));
    // Never run by a test: consumed it refuses before anything exists; open, it refused inside an agent session.
    const consumed = await runRouteRehearsal({ env: routeEnv(), registry: defaultRegistry(), profiles: ROUTE_REHEARSAL_PROFILES, authorization: ID,
      evidenceRoot: join(dir, "never-created") });
    assert.ok("refused" in consumed && consumed.reason === "authorizationConsumed", JSON.stringify(consumed));
    const refused = await runRouteRehearsal({ env: { ...routeEnv(), CLAUDECODE: "1" }, registry: defaultRegistry(), authorization: ID,
      evidenceRoot: join(dir, "never-created"),
      profiles: { ...ROUTE_REHEARSAL_PROFILES, authorizations: { ...ROUTE_REHEARSAL_PROFILES.authorizations, [ID]: { ...B27, state: "open" } } } });
    assert.ok("refused" in refused && refused.reason === "nestedAgentSession", JSON.stringify(refused));
  }));

test("O5.5B27 the one behavioural difference from O5.5B25: the Change Author's reply rule — the neutral contract and every other prompt are equal", () => {
  const request: ChangeProposalRequest = { kind: "changeProposal", packet: { task: { goal: "Fix quote totals.", constraints: [], acceptanceCriteria: [] },
    scope: { relevantFiles: ["src/quote.ts"], allowedFiles: ["src/quote.ts"], forbiddenFiles: [] }, architecture: { decisions: [], invariants: [] },
    verification: { requiredTests: [] }, openQuestions: [] } };
  const now = claudeStructuredPrompt(request), then = `${structuredTurnPrompt(request)}\n${PREVIOUS_RULE}`;
  assert.equal(now.slice(0, now.length - CLAUDE_PROPOSAL_REPLY_RULE.length), then.slice(0, then.length - PREVIOUS_RULE.length), "everything before the rule is equal");
  assert.notEqual(CLAUDE_PROPOSAL_REPLY_RULE, PREVIOUS_RULE);
  assert.ok(CLAUDE_PROPOSAL_REPLY_RULE.includes("You are the Change Author.") && CLAUDE_PROPOSAL_REPLY_RULE.endsWith("Stop immediately after the payload."));
  // The unchanged prompts and the parser are pinned byte for byte in test/o5-5b26-change-author-output.test.ts.
});

test("O5.5B27 happy path (fake, the O5.5B27 shape): Lead, a compliant Change Author and the fresh Reviewer once each; the route passes", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    const run = asRun(await route(i, dir, "happy", { Lead: [{ prefix: PREFIX.plan, output: plan() }], Worker: [proposal(FIX)],
      Reviewer: [{ prefix: PREFIX.review, output: cleanReview, excludes: [LEAD_SECRET, WORKER_SECRET] }] }));
    assert.equal(run.report.outcome, "PASS", run.report.detail);
    assert.deepEqual(sectionOf<Record<string, number>>(run, "turnUse"), { leadPlan: 1, changeAuthor: 1, freshReview: 1, leadAdjudication: 0 });
    assert.ok(run.prompts.Worker[0]!.endsWith(CLAUDE_PROPOSAL_REPLY_RULE), "the Change Author reads the O5.5B26 discipline last");
    assert.ok(!run.prompts.Worker[0]!.includes(PREVIOUS_RULE));
    const turns = sectionOf<Array<{ turn: string; structuredOutput: Record<string, unknown> | null; terminal: Record<string, unknown> | null }>>(run, "turns");
    assert.deepEqual(turns.map(t => [t.turn, t.structuredOutput?.policy, t.terminal?.classification]), [["leadPlan", "rawOrSingleJsonFence", "RESULT_OK"],
      ["changeAuthor", "rawOrSingleJsonFence", "RESULT_OK"], ["freshReview", "rawOnly", "RESULT_OK"]]);
    const preflight = sectionOf<Record<string, Record<string, unknown>>>(run, "preflight");
    assert.deepEqual(preflight.Reviewer!.validatedForBinding, { release: RELEASE, milestone: "O5.5B24" });
    assert.ok(!(await readFile(run.report.evidencePath, "utf8")).includes("```"), "no reply text persisted");
  })));

test("O5.5B27 the parser is not widened: the O5.5B25 reply shape (prose before one schema-matching fence) is still refused at changeAuthor #1", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    const run = asRun(await route(i, dir, "b25-shape", { Lead: [{ prefix: PREFIX.plan, output: plan() }],
      Worker: [{ prefix: PREFIX.proposal, output: `I inspected the files; here is the proposal:\n${fenced(FIX)}` }] }));
    assert.deepEqual([run.report.outcome, run.report.detail], ["MALFORMED_OUTPUT",
      "changeAuthor #1 (Worker): Claude structured output was refused: EXTRA_TEXT under the rawOrSingleJsonFence envelope."]);
    assert.deepEqual(sectionOf<Record<string, number>>(run, "turnUse"), { leadPlan: 1, changeAuthor: 1, freshReview: 0, leadAdjudication: 0 }, "no retry, no review");
  })));

test("O5.5B27 record: the first full-route PASS — four model turns, the second Change Author turn after a failed confined verification, a clean review", () => {
  const record = fullRouteLiveRecords().find(r => r.milestone === "O5.5B27")!;
  assert.deepEqual([record.authorization, record.outcome, record.endedAt, record.modelTurns], ["O5.5B27-LIVE", "PASS", undefined, 4]);
  assert.deepEqual(Object.fromEntries(Object.entries(record.roles).map(([role, r]) => [role, [r.runtimeVersion, r.model, r.effort, r.outcome]])), {
    Lead: ["2.1.280", "haiku", "low", "PASS"], Worker: ["2.1.280", "haiku", "low", "PASS"], Reviewer: ["1.4.0-R4161.1", "muse-spark-1.3", "low", "PASS"] });
  assert.deepEqual([record.adjudication, record.correction, record.confinedVerification, record.primaryUnchanged, record.viewsUnchanged, record.cleanupComplete],
    ["NOT_RUN", "NOT_RUN", "PASS", true, true, true], "no findings, so no adjudication; the retry was mechanical, not a review correction");
  assert.deepEqual(record.turnDiagnostics!.map(d => [d.turn, d.modelTurn, d.contract, d.replyEnvelope.classification, d.replyEnvelope.policy, d.terminal.classification,
    d.terminal.internalTurnCount]), [
    ["leadPlan#1", "PASS", "accepted", "SINGLE_FENCED_VALID_JSON", "rawOrSingleJsonFence", "RESULT_OK", 6],
    ["changeAuthor#1", "PASS", "validated", "SINGLE_FENCED_VALID_JSON", "rawOrSingleJsonFence", "RESULT_OK", 3],
    ["changeAuthor#2", "PASS", "validated", "SINGLE_FENCED_VALID_JSON", "rawOrSingleJsonFence", "RESULT_OK", 3],
    ["freshReview#1", "PASS", "accepted:0 finding(s)", "RAW_VALID_JSON", "rawOnly", "RESULT_OK", null]]);
  assert.ok(record.turnDiagnostics!.every(d => d.replyEnvelope.accepted && d.replyEnvelope.extraTextLocation === "none" && d.terminal.processExitCode === 0));
  // Why changeAuthor #2 ran: the engine's retrying:verificationFailed after attempt 1's confined verification failed.
  assert.deepEqual(record.retries, ["verificationFailed"]);
  assert.deepEqual(record.verificationAttempts, [{ attempt: 1, passed: false, commandsRun: 2, unitTests: { tests: 11, fail: 1 } },
    { attempt: 2, passed: true, commandsRun: 2, unitTests: { tests: 12, fail: 0 } }]);
  assert.equal(record.evidenceSha256, "4b93df3b315b7ede9fdc6147443bcaf27913efda20586fc9048c33b91010f242");
  assert.deepEqual(fullRouteLiveRecords().map(r => [r.milestone, r.outcome]), [["O5.5B13", "PROVIDER_FAILED"], ["O5.5B25", "MALFORMED_OUTPUT"], ["O5.5B27", "PASS"]]);
  assert.deepEqual(fullRouteLiveCoverage(), { attempts: 3, passed: 1, latest: { milestone: "O5.5B27", outcome: "PASS", modelTurns: 4, rolesRun: 3 } });
});

test("O5.5B27 readiness: the pass moves the full-route rows to partial with live evidence — never the Writer, O5.5B, O6 or the live gate", () => {
  assert.deepEqual(Object.entries(ROUTE_REHEARSAL_PROFILES.authorizations).filter(([, entry]) => entry.state === "open").map(([id]) => id), [], "nothing is open");
  assert.ok(Object.values(REVIEWER_PROBE_PROFILES.authorizations).every(entry => entry.state !== "open"));
  assert.ok(Object.values(PROPOSAL_PROBE_PROFILES.authorizations).every(entry => entry.state === "consumed"));
  const report = writerGateReport();
  const row = (id: string) => report.rows.find(r => r.id === id)!;
  const rows = Object.fromEntries(report.rows.map(r => [r.id, [r.state, r.evidenceKind]]));
  // A single pass on one fixture: partial, with recorded live evidence; the branches it did not take are named.
  assert.deepEqual(rows.fullRouteLive, ["partial", "recordedLiveProbe"]);
  assert.match(row("fullRouteLive").evidence, /3 run, 1 passed\. The latest \(O5\.5B27\) ended PASS after 4 model turn\(s\), 3 of 3 roles run\./u);
  // Since O5.5B29/O5.5B31 the adjudication and the correction are named as live only in isolation (pinned there); no passing route ran them.
  assert.match(row("fullRouteLive").remainingBlocker, /single sample on one throw-away fixture; it authorizes no Writer run\. Never run live in a passing route: Lead adjudication of review findings[^;]*; review-driven correction and re-review(?: \([^)]*\))?\./u);
  // O5.5B27 left the row partial; since O5.5B31 every turn kind ran live (pinned there): satisfied for the private candidate only.
  assert.deepEqual(rows.hostControlledWriterWorkflow, ["satisfied", "recordedLiveProbe"]);
  assert.match(row("hostControlledWriterWorkflow").evidence, /Live: 1 authorized full-route run\(s\) passed with real providers for every role/u);
  assert.match(row("hostControlledWriterWorkflow").remainingBlocker, /Never run live in a route: Lead adjudication of review findings[^;]*; review-driven correction and re-review[^;]*; never run live at all: a cycle-2 Lead adjudication .*Single samples on one throw-away fixture\. These probes end in a private candidate\. The normal, human-confirmed `fusion build` carries a verified run on to a prepared delivery, live on disposable primaries only/u);
  // Unchanged rows: the substrate boundaries and the gate itself.
  assert.deepEqual([rows.primaryProtection, rows.providerWorkspaceBoundary, rows.ignoredPathProtection, rows.sharedGitAndIgnoredPaths, rows.dependencySupport],
    [["partial", "mechanical"], ["partial", "fakeProcess"], ["partial", "mechanical"], ["partial", "mechanical"], ["partial", "mechanical"]]);
  assert.deepEqual([rows.providerChangeProposal, rows.reviewAndAdjudication, rows.hostControlledApplication, rows.liveGateAuthorization],
    [["satisfied", "recordedLiveProbe"], ["satisfied", "mechanical"], ["satisfied", "mechanical"], ["blocked", "none"]]);
  assert.deepEqual(rows.verificationIsolation, ["notEvaluated", "none"], "no Linux acceptance in this process; Windows is tracked by its own evidence-derived row");
  assert.equal(report.verificationIsolation.windows.evidenceState, "proven");
  // registered on a Windows host but not probed => unknown (never assumed ready); probed-ready only with a runtime probe.
  assert.equal(writerGateReport({ hostPlatform: "win32" }).verificationIsolation.windows.effectiveState, "unknown");
  assert.equal(writerGateReport({ hostPlatform: "win32", windowsRuntime: "proven" }).verificationIsolation.windows.effectiveState, "ready");
  assert.equal(writerGateReport({ hostPlatform: "linux" }).verificationIsolation.windows.effectiveState, "blocked", "off-Windows host fails closed");
  for (const input of ["FULL_ROUTE_LIVE: PASS", { fullRouteLive: "PASS" }]) assert.deepEqual(writerGateReport({ linuxVerification: input }), report);
  assert.deepEqual([report.realWriterModeReady, REAL_WRITER_LIVE_GATE_AUTHORIZED, liveWriterAuthorization().authorized], [false, false, false]);
  const posture = writerReadiness().prerequisites.find(p => p.id === "writerPosture")!.text;
  assert.match(posture, /The third live full-route run \(O5\.5B27\), after the Change Author's output discipline \(O5\.5B26\), passed/u);
  assert.match(posture, /No adjudication or review-driven correction ran; nothing was delivered to a primary checkout\./u);
  assert.doesNotMatch(writerReadiness().prerequisites.map(p => p.text).join(" "), /COMPLETED|success/iu, "the CLI prints these; no success wording");
});
