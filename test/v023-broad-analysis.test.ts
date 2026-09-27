import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { CRITIQUE_INSTRUCTION, EXPLORER_INSTRUCTION, LEAD_PLAN_INSTRUCTION, SHELL_ANALYSIS_INSTRUCTION, SYNTHESIS_INSTRUCTION } from "../src/app/exploration.js";
import type { ProviderRegistry } from "../src/app/providers.js";
import { presentFailure } from "../src/cli/failure-presentation.js";
import { runCli } from "../src/cli/run.js";
import { conversationPrompt } from "../src/core/conversation.js";
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
const PLAN = JSON.stringify({ areas: [{ id: "src", reason: "Which modules handle input?" }, { id: "lib", reason: "Are the utilities tested?" }] });
/** v0.2.4: coverage never claims more than Fusion observes — not to the user, not to a model. */
const OVERCLAIM = /examined in depth|read all files|inspected every file/iu;
const SYNTHESIS = "A TypeScript library; src/module1/file1.ts matters most.\n\nFindings:\n1. src/module1/file1.ts: input is not validated.";
const REPORT = (area: string) => `${area}: ${area}/x reads input. REPORT-ONLY-DETAIL`;
const maxTurns: FusionError = { kind: "ProcessFailure", safeMessage: "Claude reported a failed turn.", retryable: false,
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

test("broad analysis of a 360-file repository: lead plan from the bounded inventory, two isolated explorer packets, synthesis, fresh critique, coverage",
  { skip }, async () => {
    const { ran, turns } = await broad({ replies: { Lead: [PLAN, SYNTHESIS], Explorer: [REPORT("src"), REPORT("lib")], Reviewer: ["The claim holds."] } });
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /^Git repository · 360 files · 1 sensitive file kept private$/mu);
    assert.deepEqual(turns.map(t => [t.role, t.request.instruction]), [["Lead", LEAD_PLAN_INSTRUCTION], ["Explorer", EXPLORER_INSTRUCTION],
      ["Explorer", EXPLORER_INSTRUCTION], ["Lead", SYNTHESIS_INSTRUCTION], ["Reviewer", CRITIQUE_INSTRUCTION]]);
    // The plan turn (v0.2.4): its own "plan" purpose, the bounded inventory and the closed list of area ids only, no
    // transcript; its rules ask for the one JSON object and nothing else — no natural-language or proposed-task rule
    // contradicting it (the cause of the refused real plan).
    const plan = turns[0]!;
    assert.equal(plan.request.purpose, "plan");
    assert.ok(plan.request.context.length <= 48_000 && plan.request.history.length === 0);
    assert.match(plan.request.context, /^Repository: big \(360 tracked files\)$/mu);
    assert.match(plan.request.context, /^Areas you may choose \(id: files\):\n- src: 200 file\(s\)\n- lib: 70 file\(s\)\n/mu);
    assert.ok(!plan.request.context.includes("export const v1_1"), "no file content in the planning packet");
    assert.match(LEAD_PLAN_INSTRUCTION, /Do not analyze the project and do not open any file\. Reply with exactly this JSON object and nothing else: \{"areas":\[\{"id"/u);
    const planPrompt = conversationPrompt(plan.request);
    assert.match(planPrompt, /^- This is a planning turn\. Your whole reply is exactly the one JSON object/mu);
    assert.ok(!planPrompt.includes("Answer in natural language") && !planPrompt.includes("end your reply with one line"), "no rule contradicts the JSON contract");
    assert.match(conversationPrompt(turns[3]!.request), /^- Answer in natural language/mu, "the other turns keep their rules");
    // Explorers: separate packets, no transcript, their own area only; the synthesis follows their reports.
    for (const [turn, area] of [[turns[1]!, "src"], [turns[2]!, "lib"]] as const) {
      assert.equal(turn.request.history.length, 0);
      assert.match(turn.request.context, new RegExp(`^Area: ${area}/`, "mu"));
      assert.ok(!turn.request.context.includes("analyze the whole repository"));
    }
    assert.ok(turns[3]!.request.context.includes("REPORT-ONLY-DETAIL"));
    assert.ok(!turns[4]!.request.context.includes("REPORT-ONLY-DETAIL") && turns[4]!.request.history.length === 0, "the critique is fresh");
    assert.match(ran.stdout, /^ {2}Planning: Alpha selected 2 investigation areas \(src\/, lib\/\)\.$/mu);
    assert.match(ran.stdout, /^ {2}Explorer investigations: 2 of 2 answered \(src\/ by explorer \(beta\), lib\/ by explorer \(beta\)\)$/mu);
    assert.match(ran.stdout, /^Second opinion — reviewer · Beta/mu);
    // The whole coverage block: only what Fusion controls (assignments) or observes (citations of shared files).
    assert.match(ran.stdout, /^ {2}Assigned to explorer investigations: src\/, lib\/ \(270 files in those areas\)$/mu);
    assert.match(ran.stdout, /^ {2}Cited in the final answer: 1 file from the shared copy \(src\/module1\/file1\.ts\)$/mu);
    assert.match(ran.stdout, /^ {2}Neither assigned nor cited: (?=.*docs\/)(?=.*test\/)/mu);
    assert.match(ran.stdout, /^ {2}Model turns: 5\. Fusion cannot see which files a model opened: "assigned" is what explorers were asked to look at, "cited" is what the final answer names\.$/mu);
    assert.match(turns[4]!.request.context, /areas assigned to explorer investigations: src, lib\. Fusion cannot see which files a model opened\./u);
  });

test("an explorer binding whose posture is unproven is never used: the proven reviewer binding explores in separate contexts, then critiques fresh",
  { skip }, async () => {
    const { ran, turns } = await broad({ unproven: ["Explorer"], replies: { Lead: [PLAN, SYNTHESIS], Reviewer: [REPORT("src"), REPORT("lib"), "Fresh critique."] } });
    assert.equal(ran.code, 0, ran.stderr);
    assert.deepEqual(turns.map(t => t.role), ["Lead", "Reviewer", "Reviewer", "Lead", "Reviewer"]);
    assert.ok(turns.filter(t => t.role === "Reviewer").every(t => t.request.history.length === 0), "every reviewer turn is its own context");
    assert.match(ran.stdout, /\(the explorer binding's read-only posture is not proven on this runtime, so it was not used; the reviewer binding explored instead\)/u);
    assert.match(ran.stdout, /Explorer investigations: 2 of 2 answered \(src\/ by reviewer \(beta\), lib\/ by reviewer \(beta\)\)/u);
    assert.match(ran.stdout, /^ {2}Planning: Alpha selected 2 investigation areas \(src\/, lib\/\)\.$/mu);
    // No partner with a proven posture besides the lead: the lead analyses alone, and says so.
    const alone = await broad({ unproven: ["Explorer", "Reviewer"], replies: { Lead: [SYNTHESIS] } });
    assert.deepEqual(alone.turns.map(t => [t.role, t.request.instruction]), [["Lead", SHELL_ANALYSIS_INSTRUCTION]]);
    assert.match(alone.ran.stdout, /no other partner with a proven read-only posture, so the lead analysed alone/u);
  });

test("every failure class of the broad route is shown safely and the shell returns to its prompt", { skip }, async () => {
  // 1. The lead's planning turn stops at its turn limit (a provider terminal failure): Fusion selects the bounded areas
  //    itself and says why, with the safe fields only.
  const planLimit = await broad({ replies: { Lead: [{ error: maxTurns }, SYNTHESIS], Explorer: [REPORT("src"), REPORT("lib"), REPORT("test")], Reviewer: ["ok"] } });
  assert.equal(planLimit.ran.code, 0);
  assert.match(planLimit.ran.stdout, /^ {2}Planning: Alpha's planning turn failed: Claude reported a failed turn\. \(Claude stopped at Fusion's turn limit before it answered \[subtype=error_max_turns terminal_reason=max_turns .*num_turns=9 max_turns=8 .*\]\); Fusion selected 3 bounded areas instead \(src\/, lib\/, test\/\)\.$/mu);
  assert.match(planLimit.ran.stdout, /Explorer investigations: 3 of 3 answered/u);
  // 2. Every way a returned plan can be invalid: refused with its safe category only (never any of the reply's text),
  //    and the analysis continues on Fusion's deterministic areas.
  //    (Every category of the parser is covered in v02-foundations; these are the ones a real lead is likeliest to hit.)
  const invalid: Array<[string, string]> = [
    ["Here is my plan: look at src.", "invalid JSON"],
    [`Sure! PROSE-MARKER\n${PLAN}`, "prose around the JSON"],
    [JSON.stringify({ areas: ["src", "lib", "docs", "test"].map(id => ({ id, reason: "PROSE-MARKER" })) }), "too many areas"],
    [JSON.stringify({ areas: [{ id: "src", reason: "PROSE-MARKER" }, { id: "src/", reason: "again" }] }), "duplicate area"],
    [JSON.stringify({ areas: [{ id: "src/module1", reason: "PROSE-MARKER" }] }), "unknown area"],
    [JSON.stringify({ areas: [{ id: "src", reason: "PROSE-MARKER", files: 3 }] }), "schema mismatch"],
  ];
  const refusals = await broadEach(invalid.map(([reply]) => ({ replies: { Lead: [reply, SYNTHESIS], Explorer: ["a", "b", "c"], Reviewer: ["ok"] } })));
  for (const [index, [, category]] of invalid.entries()) {
    const refused = refusals[index]!;
    assert.equal(refused.ran.code, 0);
    assert.ok(refused.ran.stdout.includes(`  Planning: Alpha's structured plan was invalid (${category}); Fusion selected 3 bounded areas instead (src/, lib/, test/).\n`), category);
    assert.ok(!refused.ran.stdout.includes("PROSE-MARKER") && !refused.ran.stdout.includes("Sure!"), "nothing of the refused reply is shown");
    assert.match(refused.ran.stdout, /Explorer investigations: 3 of 3 answered/u);
    assert.deepEqual(refused.turns.map(t => t.role), ["Lead", "Explorer", "Explorer", "Explorer", "Lead", "Reviewer"]);
  }
  // 3. One explorer fails: bounded (one attempt), reported, the rest continues; coverage says no report came back.
  const explorer = await broad({ replies: { Lead: [PLAN, SYNTHESIS], Explorer: [{ error: museFailed }, REPORT("lib")], Reviewer: ["ok"] } });
  assert.match(explorer.ran.stdout, /\(explorer for src failed: Muse Exec reported a failed turn \(provider HTTP 429: rate limited\)\.\)/u);
  assert.match(explorer.ran.stdout, /Explorer investigations: 1 of 2 answered/u);
  assert.match(explorer.ran.stdout, /^ {2}Assigned to explorer investigations: src\/, lib\/ \(270 files in those areas\); no report came back for src\/$/mu);
  assert.equal(explorer.turns.filter(t => t.role === "Explorer").length, 2, "no retry");
  // 4. The synthesis fails with a provider API error: a named stage, the safe detail, back at the prompt; nothing else shown.
  const synthesis = await broad({ replies: { Lead: [PLAN, { error: apiError }], Explorer: [REPORT("src"), REPORT("lib")] } },
    ["analyze the whole repository", "help", "exit"]);
  assert.equal(synthesis.ran.code, 0);
  assert.match(synthesis.ran.stderr, /^fusion: Provider failed: The lead's synthesis failed after 2 of 2 explorer report\(s\): Claude reported a failed turn\.\ndetail: Claude reported a provider API error \[.*api_error_status=529.*\]\nhint: /mu);
  assert.ok(synthesis.ran.stdout.includes("Talk to Fusion in plain words."), "the shell went on to the next line");
  assert.ok(!synthesis.ran.stdout.includes("Coverage"), "no half result is presented as an analysis");
  // 5. The fresh critique fails: the analysis stands, the missing second opinion is explained.
  const critique = await broad({ replies: { Lead: [PLAN, SYNTHESIS], Explorer: [REPORT("src"), REPORT("lib")], Reviewer: [{ error: museFailed }] } });
  assert.match(critique.ran.stdout, /\(No second opinion: Muse Exec reported a failed turn \(provider HTTP 429: rate limited\)\.\)/u);
  assert.match(critique.ran.stdout, /Coverage \(what Fusion can vouch for\):/u);
  // 6. A small project's single analysis turn stops at the turn limit: named, with the safe fields.
  const small = await withLargeRepo(async (root, env) => {
    await rm(join(root, "src"), { recursive: true, force: true });
    await rm(join(root, "lib"), { recursive: true, force: true });
    await rm(join(root, "docs"), { recursive: true, force: true });
    git(root, "add", "-A"); git(root, "commit", "-qm", "small");
    return shell(root, fakeConversationRegistry({ replies: { Lead: [{ error: maxTurns }] } }).registry, ["analyze this project", "exit"], env);
  });
  assert.match(small.stderr, /^fusion: Provider failed: The lead's analysis turn failed: Claude reported a failed turn\.\ndetail: Claude stopped at Fusion's turn limit/mu);
  assert.equal(small.code, 0);
});
