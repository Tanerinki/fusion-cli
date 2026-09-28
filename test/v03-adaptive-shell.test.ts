import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { test } from "node:test";
import { SHELL_ANALYSIS_INSTRUCTION } from "../src/app/exploration.js";
import { DIAGNOSIS_INSTRUCTION, FALSIFIER_INSTRUCTION, HYPOTHESIS_INSTRUCTION } from "../src/app/orchestration/claim-check.js";
import type { ProviderRegistry } from "../src/app/providers.js";
import { newSessionState, planTurn, readSessionMetadata, sessionMetadataPath } from "../src/app/session.js";
import { PLAN_QUESTION } from "../src/cli/build-flow.js";
import { runCli, type CliHost } from "../src/cli/run.js";
import type { ConversationTurnRequest } from "../src/core/conversation.js";
import { classifyIntent, grantFor } from "../src/core/intent.js";
import { fakeConversationRegistry, type FakeOptions, type FakeTurn } from "./fixtures/fake-conversation.js";
import { createHomeAssistantFixture, HA_SENTINELS } from "./fixtures/home-assistant.js";
import { git, gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * v0.3 — ADAPTIVE ORCHESTRATION in the shell, through the real CLI and a fake conversation registry that records what every
 * provider turn could read. Simple tasks stay simple; a conversation goes analyze → explain → "is that really a bug?" →
 * "fix it" with host-owned state only; conflicting evidence is surfaced, never merged into a fake consensus; weak evidence
 * escalates within budget; the lead may stop without a conclusion; the user can cancel a parallel batch; the safe metrics
 * are kept; adaptive investigators cannot ask their way around the input policy.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
interface Ran { code: number; stdout: string; stderr: string; questions: string[] }
async function shell(cwd: string, registry: ProviderRegistry, lines: Array<string | null>, env: NodeJS.ProcessEnv, extra: Partial<CliHost> = {}): Promise<Ran> {
  let stdout = "", stderr = "";
  const queue = [...lines], questions: string[] = [];
  const code = await runCli([], { stdout: t => { stdout += t; }, stderr: t => { stderr += t; }, interactive: true,
    prompt: async question => { questions.push(question); return queue.length > 0 ? queue.shift()! : null; } }, { env, cwd, registry, ...extra });
  return { code, stdout, stderr, questions };
}
async function withDir<T>(work: (dir: string, env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "v03-shell-")));
  try { return await work(dir, { ...process.env, LOCALAPPDATA: join(dir, "state-local"), XDG_STATE_HOME: join(dir, "state-xdg") }); }
  finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}
/** A repository of 360 tracked files in five areas (a team route for a broad question), with a tracked secret. */
async function largeRepo(dir: string): Promise<string> {
  const root = join(dir, "big");
  const files: Record<string, string> = { "package.json": JSON.stringify({ name: "big", main: "src/index.ts" }), "README.md": "# Big\n",
    "config/secrets.yaml": "db_password: V03-SENTINEL-9191\n", "src/index.ts": "export {};\n" };
  for (let m = 0; m < 8; m++) for (let f = 0; f < 25; f++) files[`src/module${m}/file${f}.ts`] = `export const v${m}_${f} = ${f};\n`;
  for (let i = 0; i < 70; i++) files[`lib/util${i}.ts`] = `export const u${i} = ${i};\n`;
  for (let i = 0; i < 40; i++) files[`docs/page${i}.md`] = `# Page ${i}\n`;
  for (let i = 0; i < 46; i++) files[`test/t${i}.test.ts`] = "import 'node:test';\n";
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, ...path.split("/"))), { recursive: true });
    await writeFile(join(root, ...path.split("/")), content);
  }
  git(root, "init", "-q"); git(root, "add", "."); git(root, "commit", "-qm", "big");
  return root;
}
async function tree(root: string): Promise<string> {
  const out: string[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const rel = relative(root, join(entry.parentPath, entry.name)).split(sep).join("/");
    if (entry.isFile() && !rel.startsWith(".git/")) out.push(`${rel}:${sha256(await readFile(join(entry.parentPath, entry.name)))}`);
  }
  const isGit = await lstat(join(root, ".git")).then(() => true, () => false);
  return out.sort().join("\n") + (isGit ? git(root, "status", "--porcelain=v1", "-uall") : "");
}
const removed = async (path: string): Promise<boolean> => lstat(path).then(() => false, () => true);
const everything = (turns: readonly FakeTurn[]) => turns.map(t => `${JSON.stringify(t.request)}\n${t.viewText}`).join("\n");
const areaOf = (request: ConversationTurnRequest): string => /^Area: (?:(\S+)\/|files at the project root)/mu.exec(request.context)?.[1] ?? ".";
const CITE: Readonly<Record<string, string>> = { src: "src/module1/file1.ts", lib: "lib/util1.ts", test: "test/t1.test.ts", docs: "docs/page1.md", ".": "README.md",
  config: "config/secrets.yaml" };
const report = (area: string, extra: Record<string, unknown> = {}) => JSON.stringify({ status: "answered", summary: `About ${area}/. DETAIL-${area}`,
  findings: [{ claim: `${area} has something`, paths: [CITE[area] ?? "README.md"] }], openQuestions: [], ...extra });
const byArea = (extra: (area: string) => Record<string, unknown> = () => ({})) => (request: ConversationTurnRequest) => report(areaOf(request), extra(areaOf(request)));
const delegate = (...areas: string[]) => JSON.stringify({ action: "delegate", investigations: areas.map(area => ({ area, question: `What in ${area} matters?` })) });
const SYNTHESIS = "The project is a TypeScript library.\n\nFindings:\n1. src/module1/file1.ts: input is not validated.\n2. lib/util1.ts: no test covers it.";

// ---------------------------------------------------------------- B13: simple tasks stay simple

test("v0.3 simple tasks stay simple: a question, a narrow analysis and a follow-up are one lead turn each — no explorers, no committee",
  { skip }, async () => withDir(async (dir, env) => {
    const root = await largeRepo(dir);
    const before = await tree(root);
    const fake = fakeConversationRegistry({ replies: { Lead: ["package.json names the package and its entry point src/index.ts.",
      "The auth code lives nowhere yet.\n\nFindings: none", "It only exports an empty module."] } });
    const ran = await shell(root, fake.registry, ["what does package.json do?", "are there problems in the auth module?", "what does src/index.ts export?", "exit"], env);
    assert.equal(ran.code, 0, ran.stderr);
    assert.deepEqual(fake.turns.map(t => t.role), ["Lead", "Lead", "Lead"], "three tasks, three lead turns, nothing else");
    assert.equal(fake.turns[1]!.request.instruction, SHELL_ANALYSIS_INSTRUCTION, "a narrow analysis is one answer");
    assert.equal(ran.stdout.split("  Route: lead only").length - 1, 3, ran.stdout);
    assert.match(ran.stdout, /^ {2}Route: lead only · 1 model turn · \d+\.\d s$/mu);
    assert.match(ran.stdout, /^ {2}Turns: 1 model turn \(lead 1\) · /mu);
    assert.doesNotMatch(ran.stdout, /parallel investigations|Explorer investigations|Second opinion/u);
    assert.equal(await tree(root), before);
    // The host classification that keeps them simple: none of these is a verification or a broad analysis.
    assert.equal(classifyIntent("what does package.json do?").verification, undefined);
    assert.deepEqual([classifyIntent("are there problems in the auth module?").kind, classifyIntent("are there problems in the auth module?").broad], ["analysis", false]);
  }));

// ---------------------------------------------------------------- B11: session continuity, verification, conflict, fix

test("v0.3 conversation (v0.4 claim check): analyze → explain → \"is that really a bug?\" (independent hypotheses) → \"fix it\" — host-owned state, no transcript between roles",
  { skip }, async () => withDir(async (dir, env) => {
    const root = await largeRepo(dir);
    const before = await tree(root);
    // v0.4: the verification is a claim check — two independent hypotheses on one snapshot, Fusion's own check, the lead's diagnosis.
    const hypothesis = (request: ConversationTurnRequest) => {
      const supports = /^Investigator: h1 /mu.test(request.context);
      return JSON.stringify({ verdict: supports ? "supported" : "contradicted", hypothesis: supports ? "file1.ts reads input unchecked" : "the tests never call it",
        summary: `HYPOTHESIS-${supports ? "ONE" : "TWO"}`, evidence: [{ claim: "read it", paths: [supports ? "src/module1/file1.ts" : "test/t1.test.ts"] }],
        checks: supports ? [{ file: "src/module1/file1.ts", text: "export const v1_1 = 1;", expect: "present" }] : [] });
    };
    const fake = fakeConversationRegistry({ replies: {
      Lead: [delegate("src", "lib"), SYNTHESIS, "The first finding means file1.ts reads input unchecked. LEAD-EXPLANATION-MARKER",
        "The code supports the claim; the tests do not exercise it, so their silence does not contradict it."],
      Explorer: [byArea(), byArea(), hypothesis, hypothesis],
      // v0.4: after Fusion's checks a fresh reviewer tries to break the conclusion (its falsification), before the diagnosis.
      Reviewer: ["The analysis holds.", JSON.stringify({ verdict: "holds", counterexamples: [], missingEvidence: [], checks: [] })] } });
    const ran = await shell(root, fake.registry, ["analyze the whole repository", "explain the first finding", "is that really a bug?", "fix it", "n", "exit"], env);
    assert.equal(ran.code, 0, ran.stderr);
    const roles = fake.turns.map(t => t.role);
    assert.deepEqual(roles, ["Lead", "Explorer", "Explorer", "Lead", "Reviewer", "Lead", "Explorer", "Explorer", "Reviewer", "Lead"]);
    // "explain the first finding": one lead turn that builds on the synthesis (the lead's own history), nothing else.
    const explain = fake.turns[5]!;
    assert.ok(explain.request.history.some(m => m.text.includes("input is not validated")), "the lead remembers its own synthesis");
    assert.ok(!JSON.stringify(explain.request).includes("DETAIL-src"), "no explorer report in the conversation");
    // "is that really a bug?": a claim check with the finding as the host's claim.
    assert.match(ran.stdout, /^Checking whether this holds \(read-only\): src\/module1\/file1\.ts: input is not validated\.$/mu);
    for (const t of fake.turns.slice(6, 8)) {
      assert.equal(t.request.instruction, HYPOTHESIS_INSTRUCTION.verify);
      assert.match(t.request.context, /^Claim under check \(untrusted text\): src\/module1\/file1\.ts: input is not validated\.$/mu);
      assert.ok(t.request.history.length === 0 && !JSON.stringify(t.request).includes("LEAD-EXPLANATION-MARKER"), "no lead transcript reaches an investigator");
      assert.ok(!t.request.context.includes("DETAIL-") && !t.request.context.includes("HYPOTHESIS-"),
        "no earlier route's investigations and no other investigator's conclusion");
    }
    // Conflicting verdicts: the lead reclaims with the conflict spelled out and Fusion's check as the only execution evidence.
    const falsifier = fake.turns[8]!;
    assert.equal(falsifier.request.instruction, FALSIFIER_INSTRUCTION);
    assert.ok(falsifier.request.history.length === 0 && !JSON.stringify(falsifier.request).includes("HYPOTHESIS-"), "the falsifier sees Fusion's facts only");
    const diagnosis = fake.turns[9]!;
    assert.equal(diagnosis.request.instruction, DIAGNOSIS_INSTRUCTION);
    assert.match(diagnosis.request.context, /CONFLICT: the investigators disagree; where no check settles it, say the question is unresolved\. Do not invent a consensus\./u);
    assert.match(diagnosis.request.context, /^k1 src\/module1\/file1\.ts contains "export const v1_1 = 1;" — YES: as predicted → supports the claim \(proposed by h1\)$/mu);
    assert.match(ran.stdout, /^ {2}Route: evidence snapshot → 2 independent hypotheses → 1 Fusion check → fresh falsification \(could not break it\) → lead diagnosis$/mu);
    assert.match(ran.stdout, /^ {2}Claim: SUPPORTED — Fusion's own checks support it \(1\) and none contradicts it \(investigators: 1 support, 1 contradict\)$/mu);
    assert.match(ran.stdout, /^Next: "fix it" prepares a verified change for this finding \(you confirm first\)\.$/mu);
    // "fix it": the SAME finding (the verification kept the analysis's findings), with the host's cited evidence, into the
    // existing confirmed build route; declining starts nothing.
    assert.match(ran.stdout, /^Preparing a verified change: Fix this finding from the analysis: src\/module1\/file1\.ts: input is not validated\.$/mu);
    assert.match(ran.stdout, /^\(Fusion's investigation of this finding cited: (?=.*src\/module1\/file1\.ts)(?=.*test\/t1\.test\.ts).*\)$/mu);
    assert.ok(ran.questions.includes(PLAN_QUESTION));
    assert.match(ran.stdout, /^Build not started: it was not confirmed\. No provider was started for the build\.$/mu);
    assert.ok(!everything(fake.turns).includes("V03-SENTINEL-9191"), "the tracked secret never reaches a provider");
    assert.equal(await tree(root), before, "the repository never changed");
  }));

// ---------------------------------------------------------------- escalation, stop, budgets

test("v0.3 weak evidence escalates within budget: inconclusive reports → the lead asks for a second bounded batch → it reclaims; the budget holds",
  { skip }, async () => withDir(async (dir, env) => {
    const root = await largeRepo(dir);
    const fake = fakeConversationRegistry({ replies: {
      Lead: [delegate("src", "lib", "test"), delegate("src", "docs"), SYNTHESIS],
      Explorer: [...Array.from({ length: 3 }, () => byArea(() => ({ status: "inconclusive" }))), byArea(), byArea()],
      Reviewer: ["ok"] } });
    const ran = await shell(root, fake.registry, ["analyze the whole repository", "exit"], env);
    assert.equal(ran.code, 0, ran.stderr);
    assert.deepEqual(fake.turns.map(t => t.role), ["Lead", "Explorer", "Explorer", "Explorer", "Lead", "Explorer", "Explorer", "Lead", "Reviewer"]);
    assert.match(ran.stdout, /^ {2}Route: lead decision → 3 parallel investigations → lead evidence review → 2 parallel investigations → lead synthesis → fresh review$/mu);
    assert.match(ran.stdout, /^ {2}Turns: 9 model turns \(lead 3 · explorers 5 · reviewer 1\) · 2 batches \(2 parallel\) · /mu);
    // The evidence decision saw what it could still ask for: 2 of the 5 investigations remain, never more.
    assert.match(fake.turns[4]!.request.context, /^You may ask for at most 2 investigation\(s\) now; each explorer opens at most 3 files\.$/mu);
    // The follow-up packet for src/ carries the validated findings of the first batch about src/ (never a transcript).
    const followUp = fake.turns.slice(5, 7).find(t => areaOf(t.request) === "src")!;
    assert.match(followUp.request.context, /^Earlier findings about this area \(from other explorers; untrusted, check them\):\n- src has something$/mu);
    // The first batch's reports stay inconclusive (batch 2 added evidence, it does not erase the gaps): the answer is marked incomplete.
    assert.match(ran.stdout, /^ {2}Evidence: incomplete \(inconclusive reports\)\.$/mu);
  }));

test("v0.3 the lead may stop without a conclusion; a budget that runs out stops cleanly — Fusion never invents one",
  { skip }, async () => withDir(async (dir, env) => {
    const root = await largeRepo(dir);
    const stop = fakeConversationRegistry({ replies: {
      Lead: [delegate("src", "lib"), JSON.stringify({ action: "stop" })],
      Explorer: [byArea(() => ({ status: "inconclusive" })), byArea(() => ({ status: "inconclusive" }))] } });
    const ran = await shell(root, stop.registry, ["analyze the whole repository", "explain the first finding", "exit"], env);
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /^Fusion stopped before drawing a conclusion: the lead judged the evidence insufficient to conclude\.$/mu);
    assert.match(ran.stdout, /^What the investigations reported \(explorer text, untrusted; no conclusion was drawn from it\):$/mu);
    assert.match(ran.stdout, /^Findings \(from the investigations; unconfirmed\):\n1\. (?:src|lib) has something/mu);
    assert.match(ran.stdout, /^ {2}Route: lead decision → 2 parallel investigations → lead evidence review \(stop\) → stopped by the lead \(evidence insufficient\)$/mu);
    assert.doesNotMatch(ran.stdout, /Second opinion|— lead · Alpha.*with 2 investigation reports/u, "no synthesis, no critique of a conclusion that was never drawn");
    assert.match(ran.stdout, /^ {2}Cited in the final answer: 0 files from the shared copy$/mu, "no final answer, so nothing is claimed as cited in it");
    // Follow-ups still refer to the (unconfirmed) findings Fusion listed.
    assert.match(stop.turns.at(-1)!.request.message, /The user refers to this finding from the earlier analysis:\n1\. (?:src|lib) has something/u);
  }));

// ---------------------------------------------------------------- cancellation, metrics

test("v0.3 Ctrl+C during a parallel batch stops every investigation and removes every view copy; the next line works; metrics are kept",
  { skip }, async () => withDir(async (dir, env) => {
    const root = await largeRepo(dir);
    let current: AbortController | undefined, started = 0;
    const turnScope = () => { const scope = new AbortController(); current = scope; return { signal: scope.signal, release: () => { current = undefined; } }; };
    const fake = fakeConversationRegistry({
      replies: { Lead: [delegate("src", "lib", "test"), "the answer after the cancel"], Explorer: Array.from({ length: 3 }, () => byArea()) },
      // All three investigations are running when the user presses Ctrl+C; each waits to be stopped.
      during: async (turn, signal) => {
        if (turn.role !== "Explorer") return;
        if (++started === 3) current!.abort();
        await new Promise<void>(resolve => { if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true }); });
      } });
    const ran = await shell(root, fake.registry, ["analyze the whole repository", "hello", "history", "exit"], env, { turnScope });
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(ran.stdout.split("Cancelled. Nothing was changed.").length - 1, 1);
    assert.match(ran.stdout, /^the answer after the cancel$/mu, "the shell goes on");
    const explorers = fake.turns.filter(t => t.role === "Explorer");
    assert.equal(explorers.length, 3);
    for (const turn of fake.turns) assert.equal(await removed(turn.workspace), true, "every view copy was removed");
    assert.match(ran.stdout, /^This session: 1 route, 1 model turn \(lead 1 · explorers 0 · reviewer 0\), 0 investigation batches \(0 parallel\)/mu,
      "the cancelled route is not counted as completed work");
    const stored = await readSessionMetadata(sessionMetadataPath(env, root));
    assert.deepEqual([stored?.version, stored?.orchestration.routes, stored?.orchestration.leadTurns], [3, 1, 1]);
  }));

// ---------------------------------------------------------------- G: secrets under adaptive investigation

test("v0.3 secrets (v0.4 claim check): investigators cannot read or probe around the input policy — every copy is filtered, a check on a withheld file is refused",
  { skip }, async () => withDir(async (dir, env) => {
    const workspace = await createHomeAssistantFixture(dir);
    const before = await tree(workspace);
    const HA = "A Home Assistant configuration.\n\nFindings:\n1. configuration.yaml: trusted_proxies is missing while use_x_forwarded_for is on.";
    // v0.4: "is it really a problem?" is a claim check. Its investigators try to probe the authentication store and a secret value.
    const probe = JSON.stringify({ verdict: "supported", hypothesis: "trusted_proxies is not set.", summary: "Read the http block.",
      evidence: [{ claim: "http has no trusted_proxies", paths: ["configuration.yaml"] }], checks: [
        { file: ".storage/auth", text: "refresh_token", expect: "present" }, { file: "secrets.yaml", text: "mqtt_password: correct-horse", expect: "present" },
        { file: "configuration.yaml", text: "trusted_proxies:", expect: "absent" }] });
    const options: FakeOptions = { replies: {
      Lead: [HA, "Confirmed: http.trusted_proxies is missing.\n\nFindings:\n1. configuration.yaml: trusted_proxies is missing."],
      Explorer: Array.from({ length: 3 }, () => probe), Reviewer: ["ok"] } };
    const fake = fakeConversationRegistry(options);
    const ran = await shell(workspace, fake.registry, ["Analyze this Home Assistant configuration", "is the first problem really a problem?", "exit"], env);
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /^ {2}Route: evidence snapshot → 2 independent hypotheses → /mu);
    assert.match(ran.stdout, /^ {4}k1 \.storage\/auth contains "[^"]*" \.\.\. not run \(not shared\)/mu, "a withheld file is never read by a check");
    assert.match(ran.stdout, /^ {4}k2 secrets\.yaml contains "[^"]*" \.\.\. NO → CONTRADICTS the claim/mu, "a masked value never matches");
    const investigations = fake.turns.filter(t => t.role === "Explorer");
    assert.ok(investigations.length >= 1);
    for (const t of investigations) {
      assert.ok(!t.viewFiles.some(f => f.startsWith(".storage/")), "no authentication store in any copy");
      assert.ok(!t.viewFiles.includes("home-assistant_v2.db"));
      assert.ok(/mqtt_password: <redacted/u.test(t.viewText), "secrets.yaml arrives as key names");
    }
    for (const secret of Object.values(HA_SENTINELS))
      assert.ok(!everything(fake.turns).includes(secret) && !ran.stdout.includes(secret) && !ran.stderr.includes(secret), secret);
    assert.equal(await tree(workspace), before, "the folder is byte-identical");
  }));

// ---------------------------------------------------------------- the host's classification of a verification

test("v0.3 host classification: only a line asking whether ONE earlier finding holds becomes a verification; the grant stays read-only", () => {
  const state = newSessionState();
  state.findings = ["configuration.yaml: trusted_proxies is missing.", "automations.yaml: two automations share the id motion_hallway."];
  const plan = (line: string) => { const p = planTurn(classifyIntent(line), state, "git"); return p.kind === "verify" ? `verify ${p.index}` : p.kind; };
  assert.equal(plan("is the first finding really a problem?"), "verify 0");
  assert.equal(plan("is the trusted_proxies finding really a problem?"), "verify 0", "a distinctive term names the finding");
  assert.equal(plan("check whether the second one is true"), "verify 1");
  assert.equal(plan("is that really a bug?"), "verify 1", "the finding in focus");
  assert.equal(plan("stimmt das wirklich?"), "verify 1");
  assert.equal(plan("is this project really finished?"), "ask", "a pronoun alone does not make a verification");
  assert.equal(plan("what does package.json do?"), "ask");
  assert.equal(plan("analyze the whole repository"), "analyze");
  assert.equal(plan("fix the first one"), "change", "a change is never a verification");
  assert.equal(plan("what would you change about the first one?"), "ask", "a plan question stays a plan question");
  const none = newSessionState();
  assert.equal(planTurn(classifyIntent("is the first finding really a problem?"), none, "git").kind, "analyze", "nothing to verify without findings: an analysis, as in v0.2");
  for (const line of ["is the first finding really a problem?", "check whether the second one is true"])
    assert.deepEqual(grantFor(classifyIntent(line).kind), { providers: "readOnly", mutation: "never" });
});
