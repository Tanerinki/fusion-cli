import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { DIAGNOSIS_INSTRUCTION, FALSIFIER_INSTRUCTION, HYPOTHESIS_INSTRUCTION } from "../src/app/orchestration/claim-check.js";
import type { ProviderRegistry } from "../src/app/providers.js";
import { runCli } from "../src/cli/run.js";
import type { ConversationTurnRequest } from "../src/core/conversation.js";
import { assembleBuildEvidence } from "../src/core/evidence/build.js";
import { decide, evaluateObligations } from "../src/core/evidence/obligations.js";
import { reliabilityPlan } from "../src/core/evidence/policy.js";
import type { FusionError } from "../src/core/domain.js";
import { falsificationReportFrom } from "../src/core/orchestration/hypotheses.js";
import { structuredTurnPrompt } from "../src/core/review/contract.js";
import { fakeConversationRegistry, type FakeReply, type FakeTurn } from "./fixtures/fake-conversation.js";
import { judge } from "./fixtures/fake-writer.js";
import { blocker, FIX, FIX_ONLY, git, gitAvailable, LOW_TASK, MEDIUM_TASK, rehearse, sneakyWorker, transitionsOf, WORKER_SECRET } from "./fixtures/writer-rehearsal-harness.js";

/**
 * v0.4 PR D — THE FALSIFIER, as executable invariants: a fresh context whose objective is to BREAK the current conclusion, fed
 * only Fusion's facts; its checks run by Fusion, its counterexamples adjudicated; read-only; bounded. In the read-only claim
 * check and in the build route (the fresh Reviewer with a falsification objective, adjudicated by the Lead, at most one
 * correction and one re-falsification).
 */
const skip = gitAvailable ? false : "git executable unavailable";
interface Ran { code: number; stdout: string; stderr: string }
async function shell(cwd: string, registry: ProviderRegistry, lines: Array<string | null>, env: NodeJS.ProcessEnv): Promise<Ran> {
  let stdout = "", stderr = "";
  const queue = [...lines];
  const code = await runCli([], { stdout: t => { stdout += t; }, stderr: t => { stderr += t; }, interactive: true,
    prompt: async () => queue.length > 0 ? queue.shift()! : null }, { env, cwd, registry });
  return { code, stdout, stderr };
}
async function withRepo<T>(work: (root: string, env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "v04-falsify-")));
  try {
    const root = join(dir, "repo");
    const files: Record<string, string> = { "configuration.yaml": "homeassistant:\n  name: Home\nhttp:\n  use_x_forwarded_for: true\n",
      "packages/proxy.yaml": "# the proxy lives on 10.0.0.2\n", "README.md": "# Home\n" };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, ...path.split("/"))), { recursive: true });
      await writeFile(join(root, ...path.split("/")), content);
    }
    git(root, "init", "-q"); git(root, "add", "."); git(root, "commit", "-qm", "base");
    return await work(root, { ...process.env, LOCALAPPDATA: join(dir, "state-local"), XDG_STATE_HOME: join(dir, "state-xdg") });
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}
const hypothesis = (patch: Record<string, unknown>) => () => JSON.stringify({ verdict: "supported", hypothesis: "HYPOTHESIS-TEXT trusted_proxies is missing",
  summary: "INVESTIGATOR-SUMMARY", evidence: [{ claim: "no entry", paths: ["configuration.yaml"] }],
  checks: [{ file: "configuration.yaml", text: "trusted_proxies:", expect: "absent" }], ...patch });
const falsify = (value: Record<string, unknown>) => JSON.stringify({ verdict: "unclear", counterexamples: [], missingEvidence: [], checks: [], ...value });
const turnsOf = (turns: readonly FakeTurn[], instruction: string) => turns.filter(t => t.request.instruction.startsWith(instruction.slice(0, 80)));
const CLAIM = "is it true that the http block lacks trusted proxies?";

test("v0.4 falsification contract: closed and bounded; its checks are the same exact literals", () => {
  assert.equal(falsificationReportFrom({ verdict: "broken", counterexamples: [{ claim: "set in packages/proxy.yaml", paths: ["packages/proxy.yaml"] }],
    missingEvidence: ["no log was read"], checks: [{ file: "packages/proxy.yaml", text: "trusted_proxies", expect: "absent" }] }).accepted, true);
  const category = (value: unknown) => { const r = falsificationReportFrom(value); return r.accepted ? "accepted" : r.category; };
  assert.equal(category({ verdict: "broken", counterexamples: [], checks: [], approve: true }), "schema mismatch");
  assert.equal(category({ verdict: "fine", counterexamples: [], checks: [] }), "unknown verdict");
  assert.equal(category({ verdict: "broken", counterexamples: [], checks: [{ file: "a", text: "x\ny", expect: "present" }] }), "invalid check");
  assert.equal(category({ verdict: "broken", counterexamples: [], checks: [1, 2, 3, 4] }), "too many checks");
});

test("v0.4 invariant 8: the falsifier is a FRESH context — its own view copy and session, only Fusion's facts, no hypothesis or lead text",
  { skip }, async () => withRepo(async (root, env) => {
    const fake = fakeConversationRegistry({ replies: {
      Lead: [(request: ConversationTurnRequest) => request.instruction === DIAGNOSIS_INSTRUCTION ? "LEAD-DIAGNOSIS: it lacks trusted_proxies." : "x"],
      Explorer: [hypothesis({}), hypothesis({})],
      Reviewer: [falsify({ verdict: "broken", counterexamples: [{ claim: "trusted_proxies is set in packages/proxy.yaml", paths: ["packages/proxy.yaml"] }],
        checks: [{ file: "packages/proxy.yaml", text: "trusted_proxies", expect: "absent" }] })] } });
    const ran = await shell(root, fake.registry, [CLAIM, "exit"], env);
    assert.equal(ran.code, 0, ran.stderr);
    const [falsifier] = turnsOf(fake.turns, FALSIFIER_INSTRUCTION);
    assert.ok(falsifier !== undefined && falsifier.role === "Reviewer", "a fresh reviewer, never the lead");
    assert.deepEqual(falsifier.request.history, [], "no transcript");
    assert.match(falsifier.request.context, /^Conclusion to break \(untrusted text\): The claim holds: the http block lacks trusted proxies$/mu);
    assert.match(falsifier.request.context, /^configuration\.yaml lacks "trusted_proxies:": NO → consistent with the conclusion$/mu, "Fusion's facts only");
    assert.doesNotMatch(JSON.stringify(falsifier.request), /HYPOTHESIS-TEXT|INVESTIGATOR-SUMMARY|LEAD-DIAGNOSIS/u, "no investigator's or lead's reasoning");
    for (const t of turnsOf(fake.turns, HYPOTHESIS_INSTRUCTION.verify)) assert.notEqual(t.workspace, falsifier.workspace, "its own view copy");
    assert.ok(fake.turns.indexOf(falsifier) < fake.turns.findIndex(t => t.request.instruction === DIAGNOSIS_INSTRUCTION), "falsified before the diagnosis");
    // The lead adjudicates the counterexample; Fusion's own check (proposed by the falsifier) decides it.
    const diagnosis = fake.turns.find(t => t.request.instruction === DIAGNOSIS_INSTRUCTION)!;
    assert.match(diagnosis.request.context, /^counterexample 1: trusted_proxies is set in packages\/proxy\.yaml \[packages\/proxy\.yaml\]$/mu);
    assert.match(diagnosis.request.context, /Adjudicate each counterexample/u);
    assert.match(ran.stdout, /^ {4}k2 packages\/proxy\.yaml lacks "trusted_proxies" \.\.\. NO → supports the claim \(proposed by falsifier\)$/mu);
    assert.match(ran.stdout, /^ {2}Route: evidence snapshot → 2 independent hypotheses → 1 Fusion check → fresh falsification \(1 counterexample, verdict broken\) → lead diagnosis$/mu);
    assert.match(ran.stdout, /^ {2}Fresh falsification \(reviewer \(beta\); a fresh context that saw only Fusion's facts\): verdict broken — it tried to break: /mu);
    assert.match(ran.stdout, /^ {2}Claim: SUPPORTED — .*; 1 open challenge from the falsifier that no Fusion check settled \(the answer above adjudicates it\)$/mu);
    assert.match(ran.stdout, /^ {2}Turns: 4 model turns \(lead 1 · explorers 2 · reviewer 1\)/mu);
  }));

test("v0.4 L4 semantics (the live shape): an UNCLEAR verdict with missing-evidence objections stays open — never shown as agreement, never dropped",
  { skip }, async () => withRepo(async (root, env) => {
    // The first real v0.4 L4: verdict unclear, two missing-evidence objections, every falsifier check consistent with the
    // conclusion. The route said "could not break it" and the objections were counted nowhere (nor handed to a fix).
    const fake = fakeConversationRegistry({ replies: {
      Lead: [() => "It lacks trusted_proxies."], Explorer: [hypothesis({}), hypothesis({})],
      Reviewer: [falsify({ verdict: "unclear", missingEvidence: ["no log links a rejected request to the setting", "the included packages/ files were not examined"],
        checks: [{ file: "configuration.yaml", text: "use_x_forwarded_for: true", expect: "present" }] })] } });
    const ran = await shell(root, fake.registry, [CLAIM, "exit"], env);
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /→ fresh falsification \(2 missing-evidence objections, verdict unclear\) → lead diagnosis$/mu);
    assert.doesNotMatch(ran.stdout, /could not break it/u, "an unclear verdict is not agreement");
    assert.match(ran.stdout, /^ {4}missing evidence \(untrusted\): the included packages\/ files were not examined$/mu);
    // Fusion's checks decide the status (the objections are not evidence either way); the objections stay OPEN on the decision line.
    assert.match(ran.stdout, /^ {2}Claim: SUPPORTED — Fusion's own checks support it \(2\) and none contradicts it .*; 2 open challenges from the falsifier that no Fusion check settled \(the answer above adjudicates them\)$/mu);
    const diagnosis = fake.turns.find(t => t.request.instruction === DIAGNOSIS_INSTRUCTION)!;
    assert.match(diagnosis.request.context, /^missing evidence: the included packages\/ files were not examined$/mu, "the lead adjudicates them");
    assert.match(diagnosis.request.context, /Adjudicate each counterexample and each missing-evidence objection/u);
  }));

// ---------------------------------------------------------------- the second real run: a falsifier turn that fails

/** The live verdict of L4 (scripts/v04-live-verdicts.mjs), applied to what the product printed. */
const judgeL4 = async (segment: string): Promise<{ status: string; detail: string }> =>
  ((await import(pathToFileURL(resolve(process.cwd(), "scripts", "v04-live-verdicts.mjs")).href)) as { judgeL4(s: readonly string[]): { status: string; detail: string } }).judgeL4([segment]);
/** A failed Muse turn as the real adapter reports it: Fusion's safe message, category and label-only detail. */
const failedTurn = (category: FusionError["failureCategory"] | undefined, detail: string): Readonly<{ error: FusionError }> => ({ error: { kind: "ProcessFailure",
  safeMessage: "Muse Exec reported a failed turn.", retryable: true, ...(category === undefined ? {} : { failureCategory: category }), failureDetail: detail } });
/** The second live run's detail, reordered as Fusion now writes it, with 13 distinct event labels (the live falsifier's shape). */
const LIVE_DETAIL = "reason_class=stepLimit muse_code=stepLimit reason_chars=53 max_model_steps=4 text_chars=0 exit_code=1 prompt_chars=2210 " +
  "terminal_fields=reason,terminal,text events=runtime.command.accepted:1,session.run.linked:1,run.model.configured:1,turn.input.user:1," +
  "run.lifecycle.started:1,task.stream.linked:12,task.lifecycle.proposed:12,task.lifecycle.accepted:10,task.lifecycle.scheduled:10," +
  "task.lifecycle.side_effect_intent:10,task.lifecycle.started:10,task.lifecycle.status:8,run.terminal.failed:1";

test("v0.4 L4 regression (second live run): a falsifier turn that fails — a step limit, a provider failure, an unusable reply — is never a falsification",
  { skip }, async () => withRepo(async (root, env) => {
    const run = async (reviewer: FakeReply[]) => {
      const fake = fakeConversationRegistry({ replies: { Lead: [() => "It lacks trusted_proxies."], Explorer: [hypothesis({}), hypothesis({})], Reviewer: reviewer } });
      const ran = await shell(root, fake.registry, [CLAIM, "exit"], env);
      assert.equal(ran.code, 0, ran.stderr);
      assert.equal(turnsOf(fake.turns, FALSIFIER_INSTRUCTION).length, 1, "ONE fresh falsification, never repeated");
      return ran.stdout;
    };
    // A step limit (Muse's own stepLimit code): the whole safe detail is shown — nothing cut before the exit code or the fields.
    const stepLimit = await run([failedTurn("turnLimit", LIVE_DETAIL)]);
    assert.match(stepLimit, /→ fresh falsification \(failed: turnLimit\) → lead diagnosis$/mu);
    assert.ok(stepLimit.includes(`  Fresh falsification (reviewer (beta)): no report — turnLimit: Muse Exec reported a failed turn. (${LIVE_DETAIL})\n`), "the full detail");
    // Fusion's own checks alone decide the claim; the failed falsification adds nothing either way.
    assert.match(stepLimit, /^ {2}Claim: SUPPORTED — Fusion's own checks support it \(1\) and none contradicts it \(investigators: 2 support, 0 contradict\)$/mu);
    assert.deepEqual([(await judgeL4(stepLimit)).status, (await judgeL4(stepLimit)).detail], ["FAIL", "the falsification did not run or failed: no report (turnLimit)"]);
    // A provider failure without a category, and a reply that breaks Fusion's structure: no report, so no falsifier success.
    const provider = await run([failedTurn(undefined, "reason_class=unclassified reason_chars=53 max_model_steps=4 text_chars=0 exit_code=1")]);
    assert.deepEqual([(await judgeL4(provider)).status, (await judgeL4(provider)).detail], ["FAIL", "the falsification did not run or failed: no report (provider failure)"]);
    const unusable = await run(["I think the conclusion is fine."]);
    assert.match(unusable, /^ {2}Fresh falsification \(reviewer \(beta\)\): a reply that did not follow Fusion's structure \([^)]+\); not used$/mu);
    assert.equal((await judgeL4(unusable)).status, "FAIL");
    // The same claim with a falsifier that did run: L4 PASS.
    const ran = await run([falsify({ verdict: "holds" })]);
    assert.equal((await judgeL4(ran)).status, "PASS");
  }));

test("v0.4 L4 regression: neither a failed nor an agreeing falsifier promotes a claim Fusion's checks do not settle — it stays UNVERIFIED",
  { skip }, async () => withRepo(async (root, env) => {
    for (const reviewer of [failedTurn("turnLimit", LIVE_DETAIL), falsify({ verdict: "holds" })]) {
      // Two investigators support the claim but propose no check, and the claim has no literal Fusion could derive one from.
      const fake = fakeConversationRegistry({ replies: { Lead: [() => "Probably."], Explorer: [hypothesis({ checks: [] }), hypothesis({ checks: [] })], Reviewer: [reviewer] } });
      const ran = await shell(root, fake.registry, [CLAIM, "exit"], env);
      assert.equal(ran.code, 0, ran.stderr);
      assert.equal(turnsOf(fake.turns, FALSIFIER_INSTRUCTION).length, 1, "the models' support made it a conclusion to break");
      assert.match(ran.stdout, /^ {2}Claim: UNVERIFIED — no check Fusion ran settles it; the investigators' agreement is not evidence \(investigators: 2 support, 0 contradict\)/mu,
        typeof reviewer === "string" ? "agreeing falsifier" : "failed falsifier");
    }
  }));

test("v0.4 policy: a fresh falsification in the BUILD is required exactly where the policy says — and one that fails there is never VERIFIED, never delivered", () => {
  const low = { level: "low" as const, signals: [], decisive: [], revision: 0 }, medium = { ...low, level: "medium" as const };
  const fresh = (p: ReturnType<typeof reliabilityPlan>) => p.obligations.find(o => o.kind === "freshReviewClear");
  // The second live run's L5: a low-risk, non-sensitive configuration fix — falsification is OPTIONAL there (5 obligations).
  const l5 = reliabilityPlan({ taskClass: "configFix", sensitive: false }, low);
  assert.deepEqual([l5.freshReview, fresh(l5), l5.obligations.length], [false, undefined, 5]);
  // REQUIRED: a fix at medium risk or above (as a falsification), or any sensitive task (then also strict).
  for (const [plan, strict] of [[reliabilityPlan({ taskClass: "configFix", sensitive: false }, medium), false], [reliabilityPlan({ taskClass: "bugFix", sensitive: false }, medium), false],
    [reliabilityPlan({ taskClass: "configFix", sensitive: true }, low), true]] as const) {
    assert.deepEqual([fresh(plan)?.tier, plan.objective, plan.strict], ["safety", "falsify", strict]);
    // Required and failed (it never ran): UNKNOWN — a SAFETY obligation, so never VERIFIED and never deliverable, strict or not.
    const results = evaluateObligations(plan.obligations, { verification: { passed: true, complete: true, commands: [{ id: "unit", passed: true }] },
      reproduction: { ran: true, commands: [{ id: "unit", passed: false }] }, changedPaths: ["a.yaml"], allowedScope: ["a.yaml"], scopeViolation: false, protectedChanged: [],
      freshReview: { ran: false, clean: false, outstanding: 0, objective: "falsify", reason: "the fresh falsification failed: turnLimit" } });
    assert.deepEqual([results.find(r => r.kind === "freshReviewClear")?.status, results.find(r => r.kind === "freshReviewClear")?.reason],
      ["UNKNOWN", "the fresh falsification failed: turnLimit"]);
    const decision = decide(results);
    assert.notEqual(decision.decision, "VERIFIED");
    assert.equal(decision.deliverable, false);
    assert.equal(plan.obligations.find(o => o.kind === "freshReviewClear")?.tier, "safety", strict ? "strict" : "not strict");
  }
});

test("v0.4 D (read-only): the falsifier's own check breaks the conclusion — the claim is CONTRADICTED whatever the investigators said",
  { skip }, async () => withRepo(async (root, env) => {
    const fake = fakeConversationRegistry({ replies: {
      Lead: ["The claim holds."], Explorer: [hypothesis({ checks: [] }), hypothesis({ checks: [] })],
      Reviewer: [falsify({ verdict: "broken", checks: [{ file: "configuration.yaml", text: "use_x_forwarded_for: true", expect: "absent" }] })] } });
    const ran = await shell(root, fake.registry, [CLAIM, "exit"], env);
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /^ {4}k1 configuration\.yaml lacks "use_x_forwarded_for: true" \.\.\. YES → CONTRADICTS the claim \(proposed by falsifier\)$/mu);
    assert.match(ran.stdout, /fresh falsification \(1 check broke the conclusion\)/u);
    assert.match(ran.stdout, /^ {2}Claim: CONTRADICTED — Fusion's own checks contradict it \(1\); Fusion does not accept it, whatever the models concluded \(investigators: 2 support, 0 contradict\)$/mu);
  }));

test("v0.4 falsification is skipped honestly: nothing to break, or no fresh reviewer — never a silent pass", { skip }, async () => withRepo(async (root, env) => {
  const contradicted = fakeConversationRegistry({ replies: { Lead: ["No."], Explorer: [hypothesis({ checks: [{ file: "README.md", text: "# Home", expect: "absent" }] }),
    hypothesis({ checks: [] })] } });
  const first = await shell(root, contradicted.registry, [CLAIM, "exit"], env);
  assert.match(first.stdout, /→ no falsification \(already contradicted by Fusion's checks\) → lead diagnosis$/mu);
  assert.equal(turnsOf(contradicted.turns, FALSIFIER_INSTRUCTION).length, 0);
  const alone = fakeConversationRegistry({ unavailable: ["Reviewer"], replies: { Lead: ["ok"], Explorer: [hypothesis({}), hypothesis({})] } });
  const second = await shell(root, alone.registry, [CLAIM, "exit"], env);
  assert.match(second.stdout, /^ {2}Fresh falsification: not run — no fresh reviewer with a proven read-only posture$/mu);
}));

test("v0.4 invariant 9: a falsifier that writes to its view copy stops the session with a security failure; nothing is kept from it",
  { skip }, async () => withRepo(async (root, env) => {
    const fake = fakeConversationRegistry({ during: async turn => {
      if (turn.request.instruction === FALSIFIER_INSTRUCTION) await writeFile(join(turn.workspace, "configuration.yaml"), "trusted_proxies: [tampered]\n");
    }, replies: { Lead: ["x"], Explorer: [hypothesis({}), hypothesis({})], Reviewer: [falsify({ verdict: "holds" })] } });
    const before = git(root, "status", "--porcelain");
    const ran = await shell(root, fake.registry, [CLAIM, "what does it do?", "exit"], env);
    assert.notEqual(ran.code, 0);
    assert.match(ran.stderr, /changed its read-only view/u);
    assert.equal(turnsOf(fake.turns, "You are the conversation partner").length, 0, "the session ended: the next line never ran");
    assert.equal(git(root, "status", "--porcelain"), before, "the primary is untouched");
    assert.deepEqual(await readdir(root).then(names => names.sort()), [".git", "README.md", "configuration.yaml", "packages"].sort());
  }));

// ---------------------------------------------------------------- the build route

const plan = (taskClass: "bugFix" | "configFix", level: Parameters<typeof reliabilityPlan>[1]) => reliabilityPlan({ taskClass, sensitive: false }, level);

test("v0.4 invariant 8/9 (build): the falsifier gets the conclusion and Fusion's baseline facts — never the change author's transcript or rationale",
  { skip }, async () => rehearse({ worker: sneakyWorker(FIX), reviewer: () => ({ findings: [], summary: "Could not break it." }) }, ({ result, spy }) => {
    assert.equal(result.state, "completed", JSON.stringify(result.error));
    const request = spy.reviews[0]!;
    assert.match(request.falsification?.conclusion ?? "", /^This change correctly and completely does what the task asks: /u);
    assert.deepEqual(request.falsification?.baseline, [{ id: "typecheck", passed: true }, { id: "unit", passed: false }]);
    const prompt = structuredTurnPrompt(request);
    assert.match(prompt, /^Objective: FALSIFICATION\. Do not approve the change\. Try to BREAK the conclusion/mu);
    assert.match(prompt, /^Fusion's checks on the unchanged baseline \(Fusion data\): failed before the change: unit\.$/mu);
    assert.ok(!JSON.stringify(request).includes(WORKER_SECRET) && !prompt.includes(WORKER_SECRET), "no worker rationale, note or usage");
    const reviewer = spy.sessions.find(s => s.role === "Reviewer")!;
    assert.equal(reviewer.posture, "readOnly", "the falsifier is read-only");
    const evidence = assembleBuildEvidence({ task: MEDIUM_TASK.summary, scope: MEDIUM_TASK.paths, plan: plan("bugFix", result.risk!), plannedCommands: 2,
      result, protectedChanged: [] });
    assert.equal(evidence.decision.obligations.find(o => o.kind === "freshReviewClear")?.status, "PASS");
    assert.equal(evidence.decision.decision, "VERIFIED");
  }, { request: { reproduce: true, requireFreshReview: true, falsify: true } }));

test("v0.4 invariant 9 (build): a falsifying Reviewer that writes to its view voids the run — a security failure, nothing delivered, the primary unchanged",
  { skip }, async () => rehearse({ worker: () => FIX, reviewer: async ({ session }) => {
    assert.ok(session.workspaceRoot !== undefined, "the falsifier runs in a Fusion-owned view");
    await writeFile(join(session.workspaceRoot!, "falsifier-note.txt"), "a falsifier must not write\n");
    return { findings: [], summary: "Could not break it." };
  } }, ({ result, spy, after, repo }) => {
    assert.ok(spy.reviews.every(r => r.falsification !== undefined), "it was the falsification objective");
    assert.deepEqual([result.state, result.error?.kind], ["failed", "SecurityViolation"], JSON.stringify(result.error));
    assert.equal(result.risk?.level, "critical");
    assert.equal(spy.adjudications.length, 0, "nobody adjudicates a mutated view away");
    assert.deepEqual(after, repo.before, "the primary is unchanged");
  }, { request: { reproduce: true, requireFreshReview: true, falsify: true } }));

test("v0.4 build: a REQUIRED falsification whose provider turn fails leaves the obligation UNKNOWN — the fix is never VERIFIED, never retried past its bound",
  { skip }, async () => rehearse({ worker: () => FIX, reviewer: () => ({ status: "failed", effectiveProvider: "fake", effectiveModel: "fake-model", artifactRefs: [],
    error: { kind: "ProcessFailure", safeMessage: "Muse Exec reported a failed turn.", retryable: true, failureCategory: "turnLimit", failureDetail: LIVE_DETAIL } }) },
  ({ result, spy, after, repo }) => {
    assert.ok(spy.reviews.length >= 1 && spy.reviews.every(r => r.falsification !== undefined), "the falsification objective was used");
    assert.ok(spy.reviews.length <= 2, "bounded");
    const evidence = assembleBuildEvidence({ task: MEDIUM_TASK.summary, scope: MEDIUM_TASK.paths, plan: plan("bugFix", result.risk!), plannedCommands: 2,
      result, protectedChanged: [] });
    const fresh = evidence.decision.obligations.find(o => o.kind === "freshReviewClear");
    assert.equal(fresh?.status, "UNKNOWN", JSON.stringify(fresh));
    assert.notEqual(evidence.decision.decision, "VERIFIED");
    assert.equal(spy.adjudications.length, 0, "nothing to adjudicate: no report");
    assert.deepEqual(after, repo.before, "the primary is unchanged");
  }, { request: { reproduce: true, requireFreshReview: true, falsify: true } }));

test("v0.4 D (build, correction path): the falsifier finds a real missing condition → confirmed → ONE correction → re-falsified clean → VERIFIED",
  { skip }, async () => rehearse({
    worker: ({ call }) => call === 1 ? FIX_ONLY : FIX,
    reviewer: ({ call }) => call === 1 ? { findings: [blocker("F1", "HIGH")], summary: "It breaks for a full discount." } : { findings: [], summary: "Could not break it." },
    adjudicator: ({ request }) => judge(request, "CONFIRMED"),
  }, ({ result, spy }) => {
    assert.equal(result.state, "completed", JSON.stringify(result.error));
    assert.deepEqual(result.reviews.map(r => [r.cycle, r.outcome]), [[1, "correction"], [2, "clean"]], "one falsification, one correction, one re-falsification");
    assert.ok(spy.reviews.every(r => r.falsification !== undefined), "the re-review is a falsification too");
    const evidence = assembleBuildEvidence({ task: MEDIUM_TASK.summary, scope: MEDIUM_TASK.paths, plan: plan("bugFix", result.risk!), plannedCommands: 2,
      result, protectedChanged: [] });
    assert.deepEqual([evidence.decision.decision, evidence.decision.deliverable], ["VERIFIED", true]);
    assert.ok(evidence.graph.claims.some(c => c.kind === "counterexample" && c.origin === "falsifier" && c.challenges === "task"), "the catch stays on record");
  }, { request: { reproduce: true, requireFreshReview: true, falsify: true } }));

test("v0.4 D (build, no correction left): a confirmed falsification finding leaves the obligation FAILED — BLOCKED, never delivered; bounded",
  { skip }, async () => rehearse({
    worker: () => FIX_ONLY,
    reviewer: () => ({ findings: [blocker("F1", "HIGH")], summary: "It breaks for a full discount." }),
    adjudicator: ({ request }) => judge(request, "CONFIRMED"),
  }, ({ result, spy }) => {
    assert.deepEqual([result.state, transitionsOf(result).at(-1)], ["decisionRequired", "adjudicating>decisionRequired:unresolvedFindings"]);
    assert.equal(spy.reviews.length, 1, "no loop: a low-risk flow has no corrective attempt left");
    // The plan that asks for this falsification at low risk: security-sensitive work (strict tiers, falsification required).
    const evidence = assembleBuildEvidence({ task: LOW_TASK.summary, scope: LOW_TASK.paths, plan: reliabilityPlan({ taskClass: "bugFix", sensitive: true }, result.risk!),
      plannedCommands: 2, result, protectedChanged: [] });
    const fresh = evidence.decision.obligations.find(o => o.kind === "freshReviewClear");
    assert.deepEqual([fresh?.status, fresh?.reason], ["FAIL", "the fresh falsification left 1 outstanding finding(s)"]);
    assert.deepEqual([evidence.decision.decision, evidence.decision.deliverable], ["BLOCKED", false]);
  }, { task: LOW_TASK, request: { reproduce: true, requireFreshReview: true, falsify: true } }));
