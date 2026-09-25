import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ADJUDICATION_ONLY_TURNS, adjudicationProbeFindings, classifyAdjudicationProbe, runAdjudicationProbe,
  type AdjudicationProbeFacts } from "../src/app/adjudication-probe.js";
import { adjudicationFindingsIdentity, reviewCandidateIdentity } from "../src/app/route-fixture.js";
import { routeFixtureIdentity } from "../src/app/route-probe.js";
import { REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport, writerReadiness } from "../src/app/writer-gate.js";
import type { AdjudicatedFinding } from "../src/core/domain.js";
import { adjudicate, validateAdjudicationReport } from "../src/core/review/findings.js";
import { reviewOutcome } from "../src/core/review/policy.js";
import { ADJUDICATION_PROBE_PROFILES, PROPOSAL_PROBE_PROFILES, REVIEWER_PROBE_PROFILES, ROUTE_LEAD_ADJUDICATOR,
  ROUTE_REHEARSAL_PROFILES } from "../src/providers/probe-profiles.js";
import { defaultRegistry } from "../src/providers/registry.js";
import { adjudicationLiveRecords, fullRouteLiveRecords } from "../src/runtime/provider-profiles.js";
import { asAdjudicationRun, evidenceOf, runAdjudication, testLeadGrant } from "./fixtures/adjudication-harness.js";
import { withRoot } from "./fixtures/probe-harness.js";
import { withInstalls } from "./fixtures/provider-installs.js";
import { fenced, PREFIX, routeEnv } from "./fixtures/route-harness.js";
import { gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5B29 — ONE authorized real Claude Lead adjudication turn. Stage 1 prepared `O5.5B29-ADJUDICATION` (exactly the O5.5B28
 * probe with the route Lead's exact binding, one adjudication and nothing else, the pinned fixture, candidate and finding
 * set, its own namespace); the human ran it once (PASS). Stage 2 records the independently validated result. No test ever
 * calls a provider; no row state, aggregate or gate moves.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const ID = "O5.5B29-ADJUDICATION";
const B29 = ADJUDICATION_PROBE_PROFILES.authorizations[ID]!;
const VERDICTS = { adjudications: [{ findingId: "r1-F1", verdict: "REJECTED", rationale: "A partial discount test exists.", requiredAction: "none" },
  { findingId: "r1-F2", verdict: "CONFIRMED", rationale: "The comment omits the rounding order.", requiredAction: "followUp" },
  { findingId: "r1-F3", verdict: "REJECTED", rationale: "Fusion's verification passed.", requiredAction: "none" }], summary: "" };

test("O5.5B29 authorization: consumed, one Lead adjudication and nothing else, the exact O5.5B28 binding, the pinned inputs, its own namespace", () => {
  assert.deepEqual([B29.milestone, B29.evidenceDirectory, B29.state], ["O5.5B29", "fusion-o5-5b29-adjudication", "consumed"]);
  assert.equal(B29.lead, ROUTE_LEAD_ADJUDICATOR, "the route Lead's grant object itself");
  assert.equal(B29.lead, ROUTE_REHEARSAL_PROFILES.authorizations["O5.5B27-LIVE"]!.roles.Lead);
  assert.deepEqual(B29.turns, ADJUDICATION_ONLY_TURNS);
  assert.deepEqual(B29.turns, { leadPlan: 0, changeAuthor: 0, freshReview: 0, leadAdjudication: 1 });
  assert.deepEqual([B29.fixtureSha256, B29.candidateSha256, B29.findingsSha256], [routeFixtureIdentity(), reviewCandidateIdentity(), adjudicationFindingsIdentity()]);
  assert.deepEqual([B29.fixtureSha256, B29.candidateSha256, B29.findingsSha256], ["59c19d1f876f944410d0e3bee5a7d390770380993a563a978231e5355b938326",
    "a8e6622d5a41356aac23fce1327d3873cc7ce19d7bebcca8a210ab4245824952", "905bd34b72eda2c6a371ab249eeafd44dd7b7109c50144141d1027978062eec0"]);
  // The exact binding: Claude Code 2.1.280, haiku (canonical claude-haiku-4-5-20251001), low, --max-turns 6, subscription lanes.
  assert.deepEqual([B29.lead.family, B29.lead.executable, B29.lead.runtimeVersions, B29.lead.lanes, B29.lead.binding, B29.lead.turnArgs,
    B29.lead.requiredEnvironment], ["claude", "claude.exe", ["2.1.280"], ["subscription", "subscriptionToken"], { adapter: "claude-one-shot", model: "haiku",
    effort: "low", maxTurns: 6, options: { canonicalModel: "claude-haiku-4-5-20251001", timeoutMs: 180_000 } },
  [["--model", "haiku"], ["--effort", "low"], ["--max-turns", "6"]], ["FUSION_CLAUDE_EXE"]]);
  // No fallback: the binding names none, and the flag is a widening flag every model process is refused for.
  assert.ok(!Object.keys(B29.lead.binding.options ?? {}).some(key => /fallback/iu.test(key)));
  assert.ok(PROPOSAL_PROBE_PROFILES.profiles.claude!.turnPosture.widening.includes("--fallback-model"));
  // Stage 1 prepared it open; it ran once live (Stage 2): consumed. Nothing is open anywhere; its namespace is its own.
  assert.deepEqual(Object.entries(ADJUDICATION_PROBE_PROFILES.authorizations).map(([id, entry]) => [id, entry.state]), [[ID, "consumed"]]);
  for (const set of [ROUTE_REHEARSAL_PROFILES, REVIEWER_PROBE_PROFILES, PROPOSAL_PROBE_PROFILES])
    assert.ok(Object.values(set.authorizations).every(entry => entry.state !== "open"));
  const others = [...Object.values(PROPOSAL_PROBE_PROFILES.authorizations), ...Object.values(ROUTE_REHEARSAL_PROFILES.authorizations),
    ...Object.values(REVIEWER_PROBE_PROFILES.authorizations)].map(entry => entry.evidenceDirectory);
  assert.ok(!others.includes(B29.evidenceDirectory));
});

test("O5.5B29 is never run by a test: consumed it refuses before anything exists; open, it refused inside an agent session", async () => withRoot(async dir => {
  const consumed = await runAdjudicationProbe({ env: routeEnv(), registry: defaultRegistry(), profiles: ADJUDICATION_PROBE_PROFILES,
    authorization: ID, evidenceRoot: join(dir, "never-created") });
  assert.ok("refused" in consumed && consumed.reason === "authorizationConsumed", JSON.stringify(consumed));
  const refused = await runAdjudicationProbe({ env: routeEnv({ CLAUDECODE: "1" }), registry: defaultRegistry(), authorization: ID,
    profiles: { ...ADJUDICATION_PROBE_PROFILES, authorizations: { [ID]: { ...B29, state: "open" } } }, evidenceRoot: join(dir, "never-created") });
  assert.ok("refused" in refused && refused.reason === "nestedAgentSession", JSON.stringify(refused));
  assert.deepEqual(await readdir(dir), []);
}));

test("O5.5B29 plan offline (fake): exactly the authorized plan, only the fake executable and timeout substituted, passes end to end", { skip },
  async () => withInstalls(async i => withRoot(async dir => {
    const lead = testLeadGrant();
    // The substitution is the test seam only: executable name, required variable and timeout; every other grant fact is the live one.
    assert.deepEqual({ ...lead, executable: B29.lead.executable, requiredEnvironment: B29.lead.requiredEnvironment,
      binding: { ...lead.binding, options: { ...lead.binding.options, timeoutMs: 180_000 } } }, { ...B29.lead });
    const run = asAdjudicationRun(await runAdjudication(i, dir, "b29-plan", [{ prefix: PREFIX.adjudication, output: fenced(VERDICTS) }],
      { authorization: { ...B29, state: "open", milestone: "TEST", evidenceDirectory: "fusion-test-b29", lead } }));
    assert.equal(run.report.outcome, "PASS", run.report.detail);
    assert.deepEqual(evidenceOf<Record<string, number>>(run, "turnUse"), { leadPlan: 0, changeAuthor: 0, freshReview: 0, leadAdjudication: 1 });
    assert.equal(evidenceOf<Record<string, number>>(run, "launchCounts").providerTurn, 1);
    const adjudication = evidenceOf<{ contract: string; decision: unknown; structuredOutput: Record<string, unknown> }>(run, "adjudication");
    assert.deepEqual([adjudication.contract, adjudication.decision, adjudication.structuredOutput.policy], ["accepted:3 verdict(s)", { kind: "clean" },
      "rawOrSingleJsonFence"]);
  })));

test("O5.5B29 PASS definition: one model turn, envelope and contract accepted, a production decision, integrity and cleanup; no retry", () => {
  const verdict = { finding: { id: "r1-F1", severity: "MEDIUM" }, verdict: "REJECTED", requiredAction: "none" } as unknown as AdjudicatedFinding;
  const pass: AdjudicationProbeFacts = { claimed: true, block: undefined, crash: undefined, turnError: undefined, contractError: undefined,
    envelopeIssue: undefined, adjudicated: [verdict], decision: { kind: "clean" }, modelTurns: 1, turnRefusals: [], launchRefusals: [],
    viewUnchanged: true, candidateUnchanged: true, primaryUnchanged: true, launchesConfined: true, forbiddenEnv: false, executableUnchanged: true,
    cleanupComplete: true, rehearsal: false };
  assert.deepEqual(classifyAdjudicationProbe(pass), ["PASS",
    "one Lead adjudication: envelope and contract accepted (1 verdict(s)), decision clean, integrity and cleanup complete"]);
  const outcome = (patch: Partial<AdjudicationProbeFacts>) => classifyAdjudicationProbe({ ...pass, ...patch })[0];
  assert.equal(outcome({ decision: { kind: "gate", state: "decisionRequired" } }), "PASS", "any production decision is valid");
  assert.equal(outcome({ modelTurns: 2 }), "TURN_REFUSED", "no retry: a second model turn fails the probe");
  assert.equal(outcome({ turnError: { kind: "MalformedOutput", retryable: false, safeMessage: "refused" } }), "MALFORMED_OUTPUT");
  assert.equal(outcome({ envelopeIssue: "not confirmed" }), "MALFORMED_OUTPUT");
  assert.equal(outcome({ contractError: { kind: "MalformedOutput", retryable: false, safeMessage: "bad" } }), "CONTRACT_REFUSED");
  assert.equal(outcome({ decision: undefined }), "PROVIDER_FAILED");
  assert.equal(outcome({ claimed: false }), "PROVIDER_FAILED");
  assert.equal(outcome({ primaryUnchanged: false }), "PRIMARY_MUTATED");
  assert.equal(outcome({ viewUnchanged: false }), "VIEW_MUTATED");
  assert.equal(outcome({ cleanupComplete: false }), "CLEANUP_FAILED");
  assert.equal(outcome({ launchRefusals: [{ outcome: "POSTURE_BLOCKED", reason: "another executable" }] }), "POSTURE_BLOCKED",
    "no other provider role runs");
});

test("O5.5B29 live entry: lists the open authorization; bad usage refuses before anything exists (never started with the identity)",
  async () => withRoot(async dir => {
    const temp = join(dir, "temp");
    await mkdir(temp);
    const child = spawnSync(process.execPath, [resolve(process.cwd(), "dist/test/live/adjudication-probe.js")], { encoding: "utf8", timeout: 60_000,
      windowsHide: true, env: { SystemRoot: process.env.SystemRoot ?? "", PATH: process.env.PATH ?? "", TEMP: temp, TMP: temp, CLAUDECODE: "1" } });
    assert.equal(child.status, 2, child.stderr);
    assert.equal(child.stderr, "Usage: node dist/test/live/adjudication-probe.js --authorization <id>\nAdjudication-only authorizations: O5.5B29-ADJUDICATION (consumed)\n");
    assert.deepEqual(await readdir(temp), []);
  }));

test("O5.5B29 record: the live PASS exactly as independently validated — one adjudication, envelope and contract accepted, decision correction for r1-F1", () => {
  assert.deepEqual(adjudicationLiveRecords().map(r => [r.milestone, r.outcome]), [["O5.5B29", "PASS"]]);
  const record = adjudicationLiveRecords()[0]!;
  assert.deepEqual([record.authorization, record.provider, record.transport, record.runtimeVersion, record.model, record.canonicalModel, record.effort,
    record.maxTurns, record.modelTurns], [ID, "claude", "claude-one-shot", "2.1.280", "haiku", "claude-haiku-4-5-20251001", "low", 6, 1]);
  // The recorded binding is the authorized one.
  assert.deepEqual([record.model, record.effort, record.maxTurns, record.canonicalModel], [B29.lead.binding.model, B29.lead.binding.effort,
    B29.lead.binding.maxTurns, B29.lead.binding.options?.canonicalModel]);
  assert.equal(record.contract, "accepted:3 verdict(s)");
  assert.deepEqual(record.verdicts.map(v => [v.findingId, v.severity, v.verdict, v.requiredAction, v.verdictSource]),
    [["r1-F1", "MEDIUM", "CONFIRMED", "fix", "lead"], ["r1-F2", "LOW", "CONFIRMED", "fix", "lead"], ["r1-F3", "HIGH", "REJECTED", "none", "lead"]]);
  // The production policy sends back only the outstanding finding: r1-F2 is LOW (not material), r1-F3 is REJECTED.
  assert.deepEqual(record.decision, { kind: "correction", findings: ["r1-F1"] });
  const findings = adjudicationProbeFindings("recorded");
  const report = { adjudications: record.verdicts.map(v => ({ findingId: v.findingId, verdict: v.verdict, rationale: "label", requiredAction: v.requiredAction })),
    summary: "" };
  const decision = reviewOutcome(adjudicate(findings, validateAdjudicationReport(report, findings), new Map()), true);
  assert.deepEqual(decision.kind === "correction" ? decision.findings.map(f => f.id) : decision.kind, ["r1-F1"], "the recorded labels reproduce the decision");
  assert.deepEqual(record.replyEnvelope, { policy: "rawOrSingleJsonFence", classification: "SINGLE_FENCED_VALID_JSON", accepted: true });
  assert.deepEqual(record.terminal, { classification: "RESULT_OK", resultSubtype: "success", terminalReason: "completed", isError: false, internalTurnCount: 1,
    resultTextByteLength: 1279, structuredParsingReached: true, schemaValidationReached: true, processExitCode: 0 });
  assert.deepEqual(record.candidateVerification, { passed: true, commandsRun: 2, acceptance: "granted" });
  assert.equal(record.findingsSha256, adjudicationFindingsIdentity());
  assert.deepEqual([record.contractPromptSha256, record.evidenceSha256, record.ranAt, record.document], [
    "07446ac799b55ff3266696abea22fac5de5451f42bd30fa313121035d0eae031", "aa1a22d948bbadeb9278bc15de8cb5d801640b6b90bef9f94b21698d708fdc11",
    "2026-09-25T21:52:13.843Z", "docs/o5-5b29-adjudication-live.md"]);
  // An isolated probe, not a route: no full-route record claims an adjudication.
  assert.ok(fullRouteLiveRecords().every(r => r.adjudication !== "PASS"));
});

test("O5.5B29 readiness: an isolated live adjudication is named as such; no row state, aggregate or gate moves", () => {
  const report = writerGateReport();
  const rows = Object.fromEntries(report.rows.map(row => [row.id, [row.state, row.evidenceKind]]));
  assert.deepEqual([rows.fullRouteLive, rows.hostControlledWriterWorkflow, rows.reviewAndAdjudication, rows.structuredOutputEnvelope, rows.liveGateAuthorization],
    [["partial", "recordedLiveProbe"], ["partial", "recordedLiveProbe"], ["satisfied", "mechanical"], ["satisfied", "fakeProcess"], ["blocked", "none"]]);
  const row = (id: string) => report.rows.find(r => r.id === id)!;
  assert.match(row("hostControlledWriterWorkflow").remainingBlocker,
    /^Never run live in a route: Lead adjudication of review findings \(live only as an isolated probe: O5\.5B29\); review-driven correction and re-review\. /u);
  assert.match(row("fullRouteLive").remainingBlocker,
    /Never run live in a passing route: Lead adjudication of review findings \(live only as an isolated probe: O5\.5B29\); review-driven correction and re-review\./u);
  assert.match(row("structuredOutputEnvelope").remainingBlocker, /Lead adjudications only as an isolated probe \(O5\.5B29\)\./u);
  assert.match(row("billingAndAuthPosture").remainingBlocker, /the Lead adjudication probe O5\.5B29\)/u);
  assert.deepEqual([report.realWriterModeReady, REAL_WRITER_LIVE_GATE_AUTHORIZED], [false, false]);
  assert.doesNotMatch(writerReadiness().prerequisites.map(p => p.text).join(" "), /COMPLETED|success/iu);
});
