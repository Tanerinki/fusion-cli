import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { SCOPE_INSTRUCTION } from "../src/app/build-scope.js";
import { runResume } from "../src/app/history.js";
import type { RunSummary } from "../src/app/runs.js";
import type { ResultPacket } from "../src/core/domain.js";
import { FusionFailure } from "../src/core/errors.js";
import { boundedDecision, DECISION_LIMITS, decisionRequestOf, parseDecisionRequest } from "../src/core/workflow/decision.js";
import { validateResultPacket } from "../src/core/workflow/packets.js";
import type { WorkflowResult } from "../src/core/workflow/types.js";
import { cleanReview, LEAD_SECRET, plan, PREFIX, proposal } from "./fixtures/route-harness.js";
import { BUILD, DESCRIPTION, line, modelTurns, NAME, SCOPE, withCreate, withRig } from "./fixtures/v01-rig.js";
import { FIX, gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * v0.1 — a decision the Lead requests is a bounded, structured product artifact: the questions of its VALIDATED plan
 * (`needsLeadDecision`), why it stopped (`failures`) and what it was unsure about (`uncertainties`) — flattened, clipped and
 * redacted — recorded with the run, printed by `fusion build`/`create`, `fusion show` and `fusion history`. The plan summary,
 * the transcript and any hidden reasoning never reach the evidence.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const TRANSCRIPT_SECRET = "LEAD-TRANSCRIPT-HIDDEN-7d3a";
const CREDENTIAL = "sk-ant-api03-DECISIONSECRETabcdefghijklmn";
const QUESTION = "Should durations of a day or more be shown in days (1d 2h) or stay in hours (26h)?";
const ESC = String.fromCharCode(27);
const packet = (patch: Partial<ResultPacket> = {}): ResultPacket => ({ result: { status: "completed" }, changes: { files: [], summary: `Plan. ${LEAD_SECRET}` },
  verification: { testsRun: [], results: [] }, uncertainties: [], failures: [], needsLeadDecision: [], ...patch });
/** The Lead's plan reply asking for a decision (raw JSON, as the planning contract requires). */
const decisionPlan = (patch: Partial<ResultPacket> = {}) => ({ prefix: PREFIX.plan, assistant: TRANSCRIPT_SECRET,
  output: JSON.stringify(packet({ uncertainties: ["Whether callers parse the output."], needsLeadDecision: [QUESTION], ...patch })) });

// ---------------------------------------------------------------- the artifact

test("v0.1 decision request: only the validated decision fields, flattened, bounded and counted; re-checked on read", () => {
  const long = "x".repeat(5_000);
  const many = Array.from({ length: 7 }, (_, i) => `Question ${i + 1}?`);
  const request = boundedDecision("Lead", packet({ result: { status: "blocked" }, needsLeadDecision: [`Line one${ESC}[31m\nline two`, "   ", long, ...many],
    failures: ["The spec names no rounding rule."], uncertainties: ["a", "b", "c", "d"] }));
  assert.equal(request.status, "blocked");
  assert.equal(request.questions.length, DECISION_LIMITS.maxQuestions);
  assert.equal(request.questions[0], "Line one [31m line two", "control characters and line breaks are flattened");
  assert.equal(request.questions[1]!.length, DECISION_LIMITS.maxQuestionChars);
  assert.ok(request.questions[1]!.endsWith("…"));
  assert.equal(request.questionsTotal, 9, "the empty item is dropped, the rest counted");
  assert.deepEqual(request.blockers, ["The spec names no rounding rule."]);
  assert.deepEqual(request.context, ["a", "b", "c"]);
  assert.equal(request.clipped, true);
  assert.ok(!JSON.stringify(request).includes(LEAD_SECRET), "never the plan summary");
  assert.deepEqual(parseDecisionRequest(JSON.parse(JSON.stringify(request))), request);
  for (const bad of [null, "text", { ...request, extra: 1 }, { ...request, questions: ["x".repeat(DECISION_LIMITS.maxQuestionChars + 1)] },
    { ...request, questions: many }, { ...request, role: "Oracle" }, { ...request, questions: [`a${ESC}b`] }, { ...request, questionsTotal: 1 }])
    assert.equal(parseDecisionRequest(bad), undefined);
  // Only a REQUESTED decision is one: review-driven or exhausted-retry decisions keep their own evidence.
  const base = { state: "decisionRequired", delegateAttempts: 0, reviews: [], plan: packet({ needsLeadDecision: [QUESTION] }) } as const;
  const requested = decisionRequestOf({ ...base, transitions: [{ from: "planning", to: "decisionRequired", reason: "decisionRequested", role: "Lead" }] } as WorkflowResult);
  assert.deepEqual(requested?.questions, [QUESTION]);
  assert.equal(decisionRequestOf({ ...base, transitions: [{ from: "reviewing", to: "decisionRequired", reason: "retryExhausted" }] } as unknown as WorkflowResult), undefined);
  assert.equal(decisionRequestOf({ ...base, state: "completed", transitions: [] } as unknown as WorkflowResult), undefined);
  // A malformed or oversized decision payload never becomes a packet: the validator fails closed first.
  for (const needsLeadDecision of [[5], "decide", ["x".repeat(64 * 1024 + 1)]])
    assert.throws(() => validateResultPacket({ ...packet(), needsLeadDecision }), (error: unknown) => error instanceof FusionFailure && error.error.kind === "MalformedOutput");
  // The next step names the request instead of the generic human gate.
  const summary = { runId: "r-0000000000-00000000000000000000000000000000", command: "build", status: "pending", createdAt: "", transitions: 1, modelTurns: 1,
    findings: [], eventLog: "complete", outcome: { state: "DECISION_REQUIRED" } } as RunSummary;
  assert.equal(runResume({ ...summary, decision: requested! }, undefined).code, "decisionRequested");
  assert.match(runResume({ ...summary, decision: requested! }, undefined).next, /asked for a decision .*run fusion build again .*Fusion does not resume/u);
  assert.equal(runResume(summary, undefined).code, "humanGate", "a review-driven decision keeps its own next step");
});

// ---------------------------------------------------------------- build, show, history

async function evidenceText(root: string): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...await evidenceText(path));
    else if (entry.isFile() && (await stat(path)).size < 4 * 1024 * 1024) found.push(await readFile(path, "utf8"));
  }
  return found;
}

test("v0.1 build: a Lead decision request stops before any change, is shown and recorded as its bounded request — never the plan or transcript",
  { skip }, async () => withRig("decision", { Lead: [decisionPlan({ needsLeadDecision: [QUESTION, `Use the key ${CREDENTIAL} from .env?`, "x".repeat(900)] }),
    { prefix: PREFIX.plan, output: plan() }], Worker: [proposal(FIX)], Reviewer: [{ prefix: PREFIX.review, output: cleanReview }] }, {}, async rig => {
    const stopped = await rig.cli(BUILD, ["build"]);
    assert.equal(stopped.code, 13, stopped.stdout + stopped.stderr);
    assert.equal(line(stopped, "state: "), "state: DECISION_REQUIRED");
    assert.match(stopped.stdout, /^Decision requested by the lead:$/mu);
    assert.match(stopped.stdout, new RegExp(`^  1\\. ${QUESTION.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "mu"));
    assert.match(stopped.stdout, /^  2\. Use the key \[REDACTED\] from \.env\?$/mu, "credentials are redacted");
    assert.match(stopped.stdout, /^  3\. x{399}…$/mu);
    assert.match(stopped.stdout, /^  It was unsure about: Whether callers parse the output\.$/mu);
    assert.match(stopped.stdout, /^  \(the lead's own words, bounded and shortened by Fusion; not verified\)$/mu);
    assert.match(stopped.stdout, /^Next: decide, then run fusion build again in this repository with your decision added to the task/mu);
    assert.deepEqual([stopped.prompts.Lead.length, stopped.prompts.Worker.length, stopped.prompts.Reviewer.length], [1, 0, 0], "no change was attempted");
    const runId = /^run: (r-\S+)$/mu.exec(stopped.stdout)![1]!;

    // fusion show: the same request, and the next step names it.
    const shown = await rig.cli(["show", runId], []);
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, /^Decision requested by the lead:$/mu);
    assert.ok(shown.stdout.includes(`  1. ${QUESTION}`));
    assert.match(shown.stdout, /^next: The lead asked for a decision before any change was made/mu);
    const json = JSON.parse((await rig.cli(["--json", "show", runId], [])).stdout) as { run: RunSummary; resume: { code: string } };
    assert.deepEqual(json.run.decision?.questions.slice(0, 1), [QUESTION]);
    assert.equal(json.resume.code, "decisionRequested");
    // fusion history: the first question, pointing at show for the rest.
    const history = await rig.cli(["history"], []);
    assert.ok(history.stdout.includes(`  decision: ${QUESTION} (+2 more; fusion show ${runId})`));

    // Trusted evidence holds the bounded request, never the plan summary, the transcript or the credential.
    const evidence = [...await evidenceText(join(rig.root, ".fusion")), ...await evidenceText(join(rig.dir, "localappdata"))];
    assert.ok(evidence.some(text => text.includes(QUESTION)), "the request is recorded");
    for (const text of evidence) {
      assert.ok(!text.includes(LEAD_SECRET), "no plan summary");
      assert.ok(!text.includes(TRANSCRIPT_SECRET), "no transcript");
      assert.ok(!text.includes(CREDENTIAL), "no credential");
    }

    // An ordinary build afterwards is unchanged: it completes, and carries no decision.
    const passed = await rig.cli(BUILD, ["build"]);
    assert.equal(passed.code, 0, passed.stdout + passed.stderr);
    assert.equal(line(passed, "Build: "), "Build: PASS (offline rehearsal — never delivered)");
    assert.doesNotMatch(passed.stdout, /Decision requested/u);
    const report = JSON.parse((await rig.cli(["--json", "history"], [])).stdout) as { history: { runs: Array<{ summary: RunSummary; resume: { code: string } }> } };
    assert.deepEqual(report.history.runs.map(entry => [entry.resume.code, entry.summary.decision === undefined]),
      [["offlineRehearsal", true], ["decisionRequested", false]]);
    assert.equal(modelTurns(passed), 4, "decision run 1 turn; completed run plan, author, review");
  }));

test("v0.1 create: a Lead decision request in the created project's build is shown at once and by fusion show there", { skip }, async () =>
  withCreate("decision-create", { Lead: [{ prefix: SCOPE_INSTRUCTION.slice(0, 60), output: SCOPE }, decisionPlan({ result: { status: "blocked" },
    failures: ["The description does not say how to round partial minutes."] })] }, async rig => {
    const created = await rig.cli(["create", "--template", "library", "--name", NAME, "--", DESCRIPTION], ["create", "build"]);
    assert.equal(created.code, 13, created.stdout + created.stderr);
    assert.match(created.stdout, /^Decision requested by the lead \(it reported: blocked\):$/mu);
    assert.ok(created.stdout.includes(`  1. ${QUESTION}`));
    assert.match(created.stdout, /^  Why it stopped: The description does not say how to round partial minutes\.$/mu);
    assert.deepEqual([created.turns.Lead.length, created.turns.Worker.length, created.turns.Reviewer.length], [2, 0, 0], "scope and plan only");
    const root = join(rig.cwd, NAME);
    const runId = /^run: (r-\S+)$/mu.exec(created.stdout)![1]!;
    const shown = await rig.cli(["show", runId], [], root);
    assert.equal(shown.code, 0, shown.stderr);
    assert.ok(shown.stdout.includes(`  1. ${QUESTION}`));
    assert.match(shown.stdout, /^  Why it stopped: The description does not say how to round partial minutes\.$/mu);
    assert.match(shown.stdout, /^next: The lead asked for a decision before any change was made/mu);
    const history = await rig.cli(["history"], [], root);
    assert.ok(history.stdout.includes(`  decision: ${QUESTION}`));
    for (const text of await evidenceText(join(root, ".fusion"))) {
      assert.ok(!text.includes(LEAD_SECRET));
      assert.ok(!text.includes(TRANSCRIPT_SECRET));
    }
  }));
