import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { CRITIQUE_INSTRUCTION, SHELL_ANALYSIS_INSTRUCTION, SYNTHESIS_INSTRUCTION } from "../src/app/exploration.js";
import { ROUTE_PLAN_INSTRUCTION } from "../src/app/orchestration/adaptive.js";
import { INVESTIGATION_INSTRUCTION } from "../src/app/orchestration/investigations.js";
import type { ProviderRegistry } from "../src/app/providers.js";
import { presentFailure } from "../src/cli/failure-presentation.js";
import { runCli } from "../src/cli/run.js";
import { conversationPrompt, type ConversationTurnRequest } from "../src/core/conversation.js";
import type { DelegationPacket, FusionError } from "../src/core/domain.js";
import { ClaudeOneShotTransport } from "../src/providers/claude/one-shot-transport.js";
import { fakeConversationRegistry, type FakeOptions } from "./fixtures/fake-conversation.js";
import { git, gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * v0.2.3 — the broad-analysis route of the shell on a large repository, and SAFE diagnostics for every way it can fail:
 * a Claude turn that fails says which category and which allowlisted protocol fields (never provider text); the lead plans
 * from the bounded inventory only; explorers only run on a partner whose read-only posture is proven (else the reviewer
 * binding explores, else the lead analyses alone); every stage failure is named; the repository never changes.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

// ---------------------------------------------------------------- Claude: a failed turn says why, safely

const fixture = resolve(process.cwd(), "test/fixtures/claude-fake.mjs");
const packet: DelegationPacket = { task: { goal: "line 1\n& | $() ü ☃", constraints: [], acceptanceCriteria: [] },
  scope: { relevantFiles: [], allowedFiles: [], forbiddenFiles: [] }, architecture: { decisions: [], invariants: [] },
  verification: { requiredTests: [] }, openQuestions: [] };
async function claudeFailure(result: Record<string, unknown>, exit = 1): Promise<FusionError> {
  const transport = new ClaudeOneShotTransport({ executablePath: "unused", workspace: process.cwd(), model: { id: "alias", effort: "low", maxTurns: 3 },
    expectedCanonicalModel: "claude-canonical-fixture", posture: "readOnly", timeoutMs: 10_000,
    sourceEnvironment: { SystemRoot: process.env.SystemRoot ?? "", USERPROFILE: resolve(process.cwd(), "test/fixtures/empty-claude-home"),
      FUSION_FAKE_RESULT: JSON.stringify({ ...result, result: "SECRET-PROVIDER-TEXT-must-never-show" }), FUSION_FAKE_EXIT: String(exit) } },
  undefined, { executable: process.execPath, argvPrefix: [fixture] });
  const run = await transport.run({ packet, requiredCapabilities: {} });
  assert.equal(run.status, "failed");
  return (run as { error: FusionError }).error;
}

test("a failed Claude turn carries its category and allowlisted fields; the provider's text never appears", async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ subtype: "error_max_turns", is_error: true, terminal_reason: "max_turns", num_turns: 4, stop_reason: "tool_use", duration_ms: 1234 },
      /^Claude stopped at Fusion's turn limit before it answered \[subtype=error_max_turns terminal_reason=max_turns stop_reason=tool_use is_error=true num_turns=4 max_turns=3 api_error_status=none duration_ms=1234 exit_code=1\]$/u],
    [{ subtype: "error_during_execution", is_error: true, terminal_reason: "prompt_too_long", num_turns: 1 },
      /^Claude reported its input as too large \[subtype=error_during_execution terminal_reason=prompt_too_long /u],
    [{ subtype: "error_during_execution", is_error: true, terminal_reason: "api_error", api_error_status: 529, num_turns: 1 },
      /^Claude reported a provider API error \[.* api_error_status=529 /u],
    [{ subtype: "error_during_execution", is_error: true, terminal_reason: "model_error" }, /^Claude reported a model error \[/u],
    [{ subtype: "success", is_error: true, terminal_reason: "blocking_limit" }, /^Claude reported a usage or rate limit \[/u],
    [{ subtype: "success", is_error: false, terminal_reason: "tool_deferred" }, /^Claude reported a failed turn \[subtype=success terminal_reason=tool_deferred /u],
    [{ subtype: "a new subtype", is_error: true, terminal_reason: "something new; rm -rf /" }, /^Claude reported a failed turn \[subtype=other terminal_reason=other /u],
  ];
  for (const [result, detail] of cases) {
    const error = await claudeFailure(result);
    assert.equal(error.kind, "ProcessFailure");
    assert.equal(error.safeMessage, "Claude reported a failed turn.", "the recorded message is unchanged");
    assert.match(error.failureDetail ?? "", detail, JSON.stringify(result));
    const shown = presentFailure(error).text;
    assert.match(shown, /^fusion: Provider failed: Claude reported a failed turn\.\ndetail: Claude /u);
    assert.ok(!shown.includes("SECRET-PROVIDER-TEXT") && !shown.includes("rm -rf"), shown);
  }
});

// ---------------------------------------------------------------- the large repository through the real shell

interface Ran { code: number; stdout: string; stderr: string }
async function shell(cwd: string, registry: ProviderRegistry, lines: string[], env: NodeJS.ProcessEnv): Promise<Ran> {
  let stdout = "", stderr = "";
  const queue = [...lines];
  const code = await runCli([], { stdout: t => { stdout += t; }, stderr: t => { stderr += t; }, interactive: true,
    prompt: async () => queue.length > 0 ? queue.shift()! : null }, { env, cwd, registry });
  return { code, stdout, stderr };
}
/** A repository of 360 tracked files in five areas, one tracked secrets file with a sentinel. */
async function withLargeRepo<T>(work: (root: string, env: NodeJS.ProcessEnv, tree: () => Promise<string>) => Promise<T>): Promise<T> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "v023-broad-")));
  try {
    const root = join(dir, "big");
    const files: Record<string, string> = { "package.json": JSON.stringify({ name: "big", main: "src/index.ts" }), "README.md": "# Big\n",
      "config/secrets.yaml": "db_password: V023-SENTINEL-4242\n" };
    for (let m = 0; m < 8; m++) for (let f = 0; f < 25; f++) files[`src/module${m}/file${f}.ts`] = `export const v${m}_${f} = ${f};\n`;
    for (let i = 0; i < 70; i++) files[`lib/util${i}.ts`] = `export const u${i} = ${i};\n`;
    for (let i = 0; i < 40; i++) files[`docs/page${i}.md`] = `# Page ${i}\n`;
    for (let i = 0; i < 47; i++) files[`test/t${i}.test.ts`] = "import 'node:test';\n";
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, ...path.split("/"))), { recursive: true });
      await writeFile(join(root, ...path.split("/")), content);
    }
    git(root, "init", "-q"); git(root, "add", "."); git(root, "commit", "-qm", "big");
    const tree = async () => {
      const out: string[] = [];
      for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
        const rel = relative(root, join(entry.parentPath, entry.name)).split(sep).join("/");
        if (entry.isFile() && !rel.startsWith(".git/")) out.push(`${rel}:${sha256(await readFile(join(entry.parentPath, entry.name)))}`);
      }
      return out.sort().join("\n") + git(root, "status", "--porcelain=v1", "-uall");
    };
    return await work(root, { ...process.env, LOCALAPPDATA: join(dir, "state"), XDG_STATE_HOME: join(dir, "xdg") }, tree);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}
// v0.3: the lead's routing decision, structured explorer reports (each citing a file its area really has), the synthesis.
const PLAN = JSON.stringify({ action: "delegate", investigations: [{ area: "src", question: "Which modules handle input?" }, { area: "lib", question: "Are the utilities tested?" }] });
const SYNTHESIZE = JSON.stringify({ action: "synthesize" });
/** v0.2.4: coverage never claims more than Fusion observes — not to the user, not to a model. */
const OVERCLAIM = /examined in depth|read all files|inspected every file/iu;
const SYNTHESIS = "A TypeScript library; src/module1/file1.ts matters most.\n\nFindings:\n1. src/module1/file1.ts: input is not validated.";
const CITED: Readonly<Record<string, string>> = { src: "src/module1/file1.ts", lib: "lib/util1.ts", test: "test/t1.test.ts", docs: "docs/page1.md", ".": "README.md" };
const areaOf = (request: ConversationTurnRequest): string => /^Area: (?:(\S+)\/|files at the project root)/mu.exec(request.context)?.[1] ?? ".";
const REPORT = (area: string) => JSON.stringify({ status: "answered", summary: `${area}: ${area}/x reads input. REPORT-ONLY-DETAIL`,
  findings: [{ claim: `${area} reads input`, paths: [CITED[area] ?? "README.md"] }], openQuestions: [] });
/** An explorer reply for whichever packet it gets (parallel turns take their replies in any order). */
const BY_AREA = (request: ConversationTurnRequest) => REPORT(areaOf(request));
const maxTurns: FusionError = { kind: "ProcessFailure", safeMessage: "Claude reported a failed turn.", retryable: false, failureCategory: "turnLimit",
  failureDetail: "Claude stopped at Fusion's turn limit before it answered [subtype=error_max_turns terminal_reason=max_turns stop_reason=tool_use is_error=true num_turns=9 max_turns=8 api_error_status=none exit_code=1]" };
const apiError: FusionError = { kind: "ProcessFailure", safeMessage: "Claude reported a failed turn.", retryable: false,
  failureDetail: "Claude reported a provider API error [subtype=error_during_execution terminal_reason=api_error stop_reason=missing is_error=true num_turns=1 max_turns=8 api_error_status=529 exit_code=1]" };
const museFailed: FusionError = { kind: "ProcessFailure", safeMessage: "Muse Exec reported a failed turn (provider HTTP 429: rate limited).", retryable: true };
/** Shell sessions over the same large repository, one per scripted set of replies (each its own fresh conversation). */
async function broadEach(sessions: readonly FakeOptions[], lines = ["analyze the whole repository", "exit"]) {
  return withLargeRepo(async (root, env, tree) => {
    const before = await tree();
    const results: Array<{ ran: Ran; turns: ReturnType<typeof fakeConversationRegistry>["turns"] }> = [];
    for (const options of sessions) {
      const fake = fakeConversationRegistry(options);
      const ran = await shell(root, fake.registry, lines, env);
      assert.equal(await tree(), before, "the repository never changes");
      assert.ok(!(ran.stdout + ran.stderr).includes("V023-SENTINEL") && !fake.turns.some(t => JSON.stringify(t.request).includes("V023-SENTINEL") ||
        t.viewText.includes("V023-SENTINEL")), "the tracked secret never reaches a provider or the terminal");
      assert.ok(!OVERCLAIM.test(ran.stdout + ran.stderr) && !fake.turns.some(t => OVERCLAIM.test(JSON.stringify(t.request))), "no coverage overclaim");
      results.push({ ran, turns: fake.turns });
    }
    return results;
  });
}
const broad = async (options: FakeOptions, lines?: string[]) => (await broadEach([options], lines))[0]!;

test("broad analysis of a 360-file repository: the lead's routing decision from the bounded inventory, two parallel investigations, synthesis, fresh critique, coverage",
  { skip }, async () => {
    const { ran, turns } = await broad({ replies: { Lead: [PLAN, SYNTHESIS], Explorer: [BY_AREA, BY_AREA], Reviewer: ["The claim holds."] } });
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /^Git repository · 360 files · 1 sensitive file kept private$/mu);
    assert.deepEqual(turns.map(t => t.role), ["Lead", "Explorer", "Explorer", "Lead", "Reviewer"]);
    assert.ok(turns[0]!.request.instruction.startsWith(ROUTE_PLAN_INSTRUCTION));
    assert.deepEqual(turns.slice(1).map(t => t.request.instruction), [INVESTIGATION_INSTRUCTION, INVESTIGATION_INSTRUCTION, SYNTHESIS_INSTRUCTION, CRITIQUE_INSTRUCTION]);
    // The decision turn: the "plan" purpose, the bounded inventory and the closed list of area ids only, no transcript; its
    // rules ask for the one JSON object and nothing else — no natural-language or proposed-task rule contradicting it.
    const plan = turns[0]!;
    assert.equal(plan.request.purpose, "plan");
    assert.ok(plan.request.context.length <= 48_000 && plan.request.history.length === 0);
    assert.match(plan.request.context, /^Repository: big \(360 tracked files\)$/mu);
    assert.match(plan.request.context, /^Areas you may choose \(id: files\):\n- src: 200 file\(s\)\n- lib: 70 file\(s\)\n/mu);
    assert.match(plan.request.context, /^You may ask for at most 3 investigation\(s\) now; each explorer opens at most 3 files\.$/mu);
    assert.ok(!plan.request.context.includes("export const v1_1"), "no file content in the decision context");
    assert.match(ROUTE_PLAN_INSTRUCTION, /Do not analyze the project and do not open any file in this turn\. Reply with exactly one JSON object and nothing else\.$/u);
    const planPrompt = conversationPrompt(plan.request);
    assert.match(planPrompt, /^- This is a planning turn\. Your whole reply is exactly the one JSON object/mu);
    assert.ok(!planPrompt.includes("Answer in natural language") && !planPrompt.includes("end your reply with one line"), "no rule contradicts the JSON contract");
    assert.match(conversationPrompt(turns[3]!.request), /^- Answer in natural language/mu, "the other turns keep their rules");
    assert.match(conversationPrompt(turns[1]!.request), /^- This is an investigation turn\./mu);
    // Investigations: separate packets in separate view copies, no transcript, their own area only; the synthesis follows their reports.
    const investigations = turns.slice(1, 3);
    assert.deepEqual(investigations.map(t => areaOf(t.request)).sort(), ["lib", "src"]);
    for (const turn of investigations) {
      assert.equal(turn.request.history.length, 0);
      assert.ok(!turn.request.context.includes("analyze the whole repository"));
      assert.notEqual(turn.workspace, plan.workspace);
    }
    assert.ok(turns[3]!.request.context.includes("REPORT-ONLY-DETAIL"));
    assert.match(turns[3]!.request.context, /^Fusion's assessment: 2 structured report\(s\), 0 unstructured, 0 failed; 2 shared file\(s\) cited\.$/mu);
    assert.ok(!turns[4]!.request.context.includes("REPORT-ONLY-DETAIL") && turns[4]!.request.history.length === 0, "the critique is fresh");
    assert.match(ran.stdout, /^ {2}Route: lead decision → 2 parallel investigations → lead synthesis → fresh review$/mu);
    assert.match(ran.stdout, /^ {2}Planning: Alpha selected 2 investigation areas \(src\/, lib\/\)\.$/mu);
    assert.match(ran.stdout, /^ {2}Explorer investigations: 2 of 2 answered \((?=.*src\/ by explorer \(beta\))(?=.*lib\/ by explorer \(beta\)).*\)$/mu);
    assert.match(ran.stdout, /^Second opinion — reviewer · Beta/mu);
    assert.doesNotMatch(ran.stdout, /Evidence: incomplete/u);
    // The whole coverage block: only what Fusion controls (assignments) or observes (citations of shared files).
    assert.match(ran.stdout, /^ {2}Assigned to explorer investigations: (?:src\/, lib\/|lib\/, src\/) \(270 files in those areas\)$/mu);
    assert.match(ran.stdout, /^ {2}Cited in the final answer: 1 file from the shared copy \(src\/module1\/file1\.ts\)$/mu);
    assert.match(ran.stdout, /^ {2}Neither assigned nor cited: (?=.*docs\/)(?=.*test\/)/mu);
    assert.match(ran.stdout, /^ {2}Model turns: 5\. Fusion cannot see which files a model opened: "assigned" is what explorers were asked to look at, "cited" is what the final answer names\.$/mu);
    assert.match(turns[4]!.request.context, /areas assigned to explorer investigations: (?:src, lib|lib, src)\. Fusion cannot see which files a model opened\./u);
  });

test("an explorer binding whose posture is unproven is never used: the proven reviewer binding explores in separate contexts, then critiques fresh",
  { skip }, async () => {
    const { ran, turns } = await broad({ unproven: ["Explorer"], replies: { Lead: [PLAN, SYNTHESIS], Reviewer: [BY_AREA, BY_AREA, "Fresh critique."] } });
    assert.equal(ran.code, 0, ran.stderr);
    assert.deepEqual(turns.map(t => t.role), ["Lead", "Reviewer", "Reviewer", "Lead", "Reviewer"]);
    assert.ok(turns.filter(t => t.role === "Reviewer").every(t => t.request.history.length === 0), "every reviewer turn is its own context");
    assert.equal(new Set(turns.filter(t => t.role === "Reviewer").map(t => t.workspace)).size, 3, "and its own view copy");
    assert.match(ran.stdout, /\(the explorer binding's read-only posture is not proven on this runtime, so it was not used; the reviewer binding explored instead\)/u);
    assert.match(ran.stdout, /Explorer investigations: 2 of 2 answered \((?=.*src\/ by reviewer \(beta\))(?=.*lib\/ by reviewer \(beta\)).*\)/u);
    assert.match(ran.stdout, /^ {2}Planning: Alpha selected 2 investigation areas \(src\/, lib\/\)\.$/mu);
    // No partner with a proven posture besides the lead: the lead analyses alone, and says so.
    const alone = await broad({ unproven: ["Explorer", "Reviewer"], replies: { Lead: [SYNTHESIS] } });
    assert.deepEqual(alone.turns.map(t => [t.role, t.request.instruction]), [["Lead", SHELL_ANALYSIS_INSTRUCTION]]);
    assert.match(alone.ran.stdout, /no other partner with a proven read-only posture, so the lead analysed alone/u);
    assert.match(alone.ran.stdout, /^ {2}Route: no explorer available → lead only$/mu);
  });

test("every failure class of the adaptive route is shown safely and the shell returns to its prompt", { skip }, async () => {
  // 1. The lead's decision turn stops at its turn limit: Fusion selects the bounded areas itself and says why (safe fields only).
  const planLimit = await broad({ replies: { Lead: [{ error: maxTurns }, SYNTHESIS], Explorer: [BY_AREA, BY_AREA, BY_AREA], Reviewer: ["ok"] } });
  assert.equal(planLimit.ran.code, 0);
  assert.match(planLimit.ran.stdout, /^ {2}Planning: Alpha's planning turn failed: Claude reported a failed turn\. \(Claude stopped at Fusion's turn limit before it answered \[subtype=error_max_turns terminal_reason=max_turns .*num_turns=9 max_turns=8 .*\]\); Fusion selected 3 bounded areas instead \(src\/, lib\/, test\/\)\.$/mu);
  assert.match(planLimit.ran.stdout, /Explorer investigations: 3 of 3 answered/u);
  assert.match(planLimit.ran.stdout, /^ {2}Route: lead decision \(failed: turn failed: turnLimit\) → Fusion's own areas → 3 parallel investigations → lead synthesis → fresh review$/mu);
  // 2. Every way a returned decision can be invalid: refused with its safe category only (never any of the reply's text),
  //    and the route continues on Fusion's deterministic areas.
  //    (Every category of the parser is covered in v03-routing-contracts; these are the ones a real lead is likeliest to hit.)
  const invalid: Array<[string, string]> = [
    ["Here is my plan: look at src.", "invalid JSON"],
    [`Sure! PROSE-MARKER\n${PLAN}`, "prose around the JSON"],
    [JSON.stringify({ action: "delegate", investigations: ["src", "lib", "docs", "test"].map(area => ({ area, question: "PROSE-MARKER" })) }), "too many investigations"],
    [JSON.stringify({ action: "delegate", investigations: [{ area: "src", question: "PROSE-MARKER" }, { area: "src/", question: "again" }] }), "duplicate area"],
    [JSON.stringify({ action: "delegate", investigations: [{ area: "src/module1", question: "PROSE-MARKER" }] }), "unknown area"],
    [JSON.stringify({ action: "delegate", investigations: [{ area: "src", question: "PROSE-MARKER", files: 3 }] }), "schema mismatch"],
    [JSON.stringify({ action: "write", paths: ["src/index.ts"] }), "unknown action"],
  ];
  const refusals = await broadEach(invalid.map(([reply]) => ({ replies: { Lead: [reply, SYNTHESIS], Explorer: [BY_AREA, BY_AREA, BY_AREA], Reviewer: ["ok"] } })));
  for (const [index, [, category]] of invalid.entries()) {
    const refused = refusals[index]!;
    assert.equal(refused.ran.code, 0);
    assert.ok(refused.ran.stdout.includes(`  Planning: Alpha's structured plan was invalid (${category}); Fusion selected 3 bounded areas instead (src/, lib/, test/).\n`),
      `${category}\n${refused.ran.stdout}`);
    assert.ok(!refused.ran.stdout.includes("PROSE-MARKER") && !refused.ran.stdout.includes("Sure!"), "nothing of the refused reply is shown");
    assert.match(refused.ran.stdout, /Explorer investigations: 3 of 3 answered/u);
    assert.deepEqual(refused.turns.map(t => t.role), ["Lead", "Explorer", "Explorer", "Explorer", "Lead", "Reviewer"]);
  }
  // 3a. One explorer fails for good (authentication, never repeated): contained, reported; the evidence is weak, so the lead
  //     reviews it and decides to synthesize; coverage says no report came back.
  const denied: FusionError = { kind: "AuthMismatch", safeMessage: "The provider rejected its login.", retryable: false };
  const explorer = await broad({ replies: { Lead: [PLAN, SYNTHESIZE, SYNTHESIS],
    Explorer: Array.from({ length: 2 }, () => (request: ConversationTurnRequest) => areaOf(request) === "src" ? { error: denied } : REPORT(areaOf(request))),
    Reviewer: ["ok"] } });
  assert.match(explorer.ran.stdout, /\(explorer for src failed: authentication: The provider rejected its login\.\)/u);
  assert.match(explorer.ran.stdout, /Explorer investigations: 1 of 2 answered/u);
  assert.match(explorer.ran.stdout, /^ {2}Assigned to explorer investigations: (?:src\/, lib\/|lib\/, src\/) \(270 files in those areas\); no report came back for src\/$/mu);
  assert.match(explorer.ran.stdout, /^ {2}Route: lead decision → 2 parallel investigations \(1 failed\) → lead evidence review → lead synthesis → fresh review$/mu);
  assert.match(explorer.ran.stdout, /^ {2}Evidence: incomplete \(failed investigations\)\.$/mu);
  assert.equal(explorer.turns.filter(t => t.role === "Explorer").length, 2, "an authentication failure is never repeated");
  assert.match(explorer.turns[3]!.request.context, /^\[b1-i\d\] src\/ — explorer \(beta\): no report \(authentication: The provider rejected its login\.\)$/mu);
  // 3b. A transient failure (a rate limit) is repeated once within the retry budget; the repeat reports and the route goes on.
  let srcCalls = 0;
  const transient = await broad({ replies: { Lead: [PLAN, SYNTHESIS],
    Explorer: Array.from({ length: 3 }, () => (request: ConversationTurnRequest) => areaOf(request) === "src" && srcCalls++ === 0 ? { error: museFailed } : REPORT(areaOf(request))),
    Reviewer: ["ok"] } });
  assert.match(transient.ran.stdout, /^ {2}Route: lead decision → 2 parallel investigations \(1 failed\) → 1 repeat → lead synthesis → fresh review$/mu);
  assert.match(transient.ran.stdout, /Explorer investigations: 2 of 2 answered/u);
  assert.equal(transient.turns.filter(t => t.role === "Explorer").length, 3);
  // 4. The synthesis fails with a provider API error: a named stage, the safe detail, back at the prompt; nothing else shown.
  const synthesis = await broad({ replies: { Lead: [PLAN, { error: apiError }], Explorer: [BY_AREA, BY_AREA] } },
    ["analyze the whole repository", "help", "exit"]);
  assert.equal(synthesis.ran.code, 0);
  assert.match(synthesis.ran.stderr, /^fusion: Provider failed: The lead's synthesis failed after 2 of 2 investigation report\(s\): Claude reported a failed turn\.\ndetail: Claude reported a provider API error \[.*api_error_status=529.*\]\nhint: /mu);
  assert.ok(synthesis.ran.stdout.includes("Talk to Fusion in plain words."), "the shell went on to the next line");
  assert.ok(!synthesis.ran.stdout.includes("Coverage"), "no half result is presented as an analysis");
  // 5. The fresh critique fails: the analysis stands, the missing second opinion is explained.
  const critique = await broad({ replies: { Lead: [PLAN, SYNTHESIS], Explorer: [BY_AREA, BY_AREA], Reviewer: [{ error: museFailed }] } });
  assert.match(critique.ran.stdout, /\(No second opinion: Muse Exec reported a failed turn \(provider HTTP 429: rate limited\)\.\)/u);
  assert.match(critique.ran.stdout, /Coverage \(what Fusion can vouch for\):/u);
  assert.match(critique.ran.stdout, /^ {2}Route: lead decision → 2 parallel investigations → lead synthesis → fresh review \(failed\)$/mu);
  // 6. A small project's single answer stops at the turn limit and no partner can explore: named, with the safe fields.
  const small = await withLargeRepo(async (root, env) => {
    await rm(join(root, "src"), { recursive: true, force: true });
    await rm(join(root, "lib"), { recursive: true, force: true });
    await rm(join(root, "docs"), { recursive: true, force: true });
    git(root, "add", "-A"); git(root, "commit", "-qm", "small");
    return shell(root, fakeConversationRegistry({ unproven: ["Explorer", "Reviewer"], replies: { Lead: [{ error: maxTurns }] } }).registry,
      ["analyze this project", "exit"], env);
  });
  assert.match(small.stderr, /^fusion: Provider failed: The lead's analysis turn failed: Claude reported a failed turn\.\ndetail: Claude stopped at Fusion's turn limit/mu);
  assert.equal(small.code, 0);
});

test("a task that turns out harder than one answer escalates: the single answer runs out of steps, the lead delegates, then reclaims",
  { skip }, async () => {
    const plan = JSON.stringify({ action: "delegate", investigations: [{ area: "test", question: "Which tests cover the entry point?" }, { area: ".", question: "What does the manifest declare?" }] });
    const escalated = await withLargeRepo(async (root, env, tree) => {
      for (const dir of ["src", "lib", "docs"]) await rm(join(root, dir), { recursive: true, force: true });
      git(root, "add", "-A"); git(root, "commit", "-qm", "small");
      const before = await tree();
      const fake = fakeConversationRegistry({ replies: { Lead: [{ error: maxTurns }, plan, SYNTHESIS], Explorer: [BY_AREA, BY_AREA], Reviewer: ["ok"] } });
      const ran = await shell(root, fake.registry, ["analyze this project", "exit"], env);
      assert.equal(await tree(), before);
      return { ran, turns: fake.turns };
    });
    assert.equal(escalated.ran.code, 0, escalated.ran.stderr);
    assert.deepEqual(escalated.turns.map(t => t.role), ["Lead", "Lead", "Explorer", "Explorer", "Lead", "Reviewer"]);
    assert.equal(escalated.turns[0]!.request.instruction, SHELL_ANALYSIS_INSTRUCTION, "it started as a simple task");
    assert.match(escalated.ran.stdout, /^ {2}Route: lead answer \(failed: turnLimit\) → escalated \(turn limit\) → lead decision → 2 parallel investigations → lead synthesis → fresh review$/mu);
    assert.match(escalated.ran.stdout, /^ {2}Turns: 6 model turns \(lead 3 · explorers 2 · reviewer 1\) · 1 batch \(1 parallel\) · /mu);
    assert.doesNotMatch(escalated.ran.stderr, /Provider failed/u);
  });
