import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { SCOPE_INSTRUCTION } from "../src/app/build-scope.js";
import { CHAT_INSTRUCTION } from "../src/app/conversation.js";
import { CRITIQUE_INSTRUCTION, SHELL_ANALYSIS_INSTRUCTION, SYNTHESIS_INSTRUCTION } from "../src/app/exploration.js";
import { ROUTE_EVIDENCE_INSTRUCTION, ROUTE_PLAN_INSTRUCTION } from "../src/app/orchestration/adaptive.js";
import { INVESTIGATION_INSTRUCTION } from "../src/app/orchestration/investigations.js";
import { NO_GIT_BLOCK } from "../src/cli/shell.js";
import { createHomeAssistantFixture, HA_SENTINELS } from "./fixtures/home-assistant.js";
import { cleanReview, fenced, plan, PREFIX, type ScriptedTurn } from "./fixtures/route-harness.js";
import { gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * v0.2.3 — BLACK-BOX ACCEPTANCE: Fusion driven as a user drives it, from outside the process. Each scenario starts the
 * product harness (`test/fixtures/fusion-shell-harness.ts`: `main.js`'s wiring with stdin lines instead of a TTY and the
 * real adapters on scripted fake provider binaries), types lines, and judges ONLY what is observable outside: the terminal
 * output, the exit code, the workspace's bytes and Git status, and what each fake provider process received and could read
 * (its prompt log and a dump of its view). No internal function stands in for the CLI.
 *
 *   A  a Home Assistant folder without Git: analysis, follow-ups, a plan; "fix it" and a bypass are refused; no change
 *   B  a clone of this repository (the maintainer's Live B shape, over 300 files) on Muse 1.4 with a Reviewer-only
 *      validation (v0.3: the adaptive route): the lead's routing decision accepted, two investigations on the proven
 *      reviewer binding that provably run at the same time, the lead's synthesis, fresh critique, truthful coverage
 *   B2 the same, but the lead's routing decision is invalid: Fusion's deterministic fallback is used, observably, with a
 *      safe category only; the rest of the route runs unchanged; no change
 *   C  the same repository with each provider stage failing in turn (v0.3: a failed investigation is repeated once and
 *      weak evidence goes back to the lead): a safe, categorised message; back at the prompt
 *   D  analysis → "fix the first problem" → confirmed build (offline rehearsal); with FUSION_DOCKER_LIVE=1 the REAL
 *      confined Docker verification, a real delivery, the one-step approval and the exact apply (single use)
 */
const skip = gitAvailable ? false : "git executable unavailable";
const HARNESS = resolve(process.cwd(), "dist/test/fixtures/fusion-shell-harness.js");
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", ["-c", "user.name=Fusion Test", "-c", "user.email=fusion@example.invalid", "-c", "commit.gpgsign=false",
    "-c", "init.defaultBranch=main", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
};

interface Session { code: number | null; stdout: string; stderr: string; prompts: Record<string, string[]>; views: Record<string, Array<Record<string, string>>> }
/** Types `lines` into Fusion started in `workspace`, like a user at a terminal, and collects what is observable outside. */
async function fusion(workspace: string, scriptsDir: string, lines: readonly string[], env: Readonly<Record<string, string>> = {},
  argv: readonly string[] = []): Promise<Session> {
  const child = spawn(process.execPath, [HARNESS, ...argv], { cwd: process.cwd(), windowsHide: true,
    env: { ...process.env, FUSION_HARNESS_SCRIPTS: scriptsDir, FUSION_HARNESS_WORKSPACE: workspace, LOCALAPPDATA: join(scriptsDir, "..", "state"),
      XDG_STATE_HOME: join(scriptsDir, "..", "xdg"), ...env } });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdin.end(lines.map(line => `${line}\n`).join(""));
  const code = await new Promise<number | null>(done => child.on("close", done));
  const read = async (file: string) => (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).map(entry => JSON.parse(entry) as
    { prompt?: string; files?: Record<string, string> });
  const prompts: Record<string, string[]> = {}, views: Record<string, Array<Record<string, string>>> = {};
  for (const role of ["Lead", "Worker", "Explorer", "Reviewer"]) {
    prompts[role] = (await read(join(scriptsDir, `${role}.json.prompts.jsonl`))).map(entry => entry.prompt!);
    views[role] = (await read(join(scriptsDir, `${role}.json.views.jsonl`))).map(entry => entry.files!);
  }
  return { code, stdout, stderr, prompts, views };
}
async function scriptsFor(dir: string, name: string, turns: Readonly<Record<string, readonly ScriptedTurn[]>>): Promise<string> {
  const scripts = join(dir, name, "scripts");
  await mkdir(scripts, { recursive: true });
  for (const role of ["Lead", "Worker", "Explorer", "Reviewer"]) await writeFile(join(scripts, `${role}.json`), JSON.stringify(turns[role] ?? []));
  return scripts;
}
/** Every file's digest under `root` (Git internals and Fusion's own run records aside) plus the Git status when it is a repository. */
async function fingerprint(root: string): Promise<string> {
  const out: string[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const rel = relative(root, join(entry.parentPath, entry.name)).split(sep).join("/");
    if (!entry.isFile() || rel.startsWith(".git/") || rel.startsWith(".fusion/")) continue;
    out.push(`${rel}:${sha256(await readFile(join(entry.parentPath, entry.name)))}`);
  }
  const status = await readdir(join(root, ".git")).then(() => git(root, "status", "--porcelain=v1", "-uall"), () => "");
  return sha256(out.sort().join("\n") + status);
}
const everything = (session: Session): string => [session.stdout, session.stderr, ...Object.values(session.prompts).flat(),
  ...Object.values(session.views).flat().flatMap(files => Object.entries(files).flat())].join("\n");
/** What Fusion itself said: to the user, and in every prompt (not the shared file contents, which are the user's own text). */
const said = (session: Session): string => [session.stdout, session.stderr, ...Object.values(session.prompts).flat()].join("\n");
/** One line of acceptance evidence per scenario (a TAP diagnostic): exit code, workspace fingerprint before/after, Git status, turns. */
function evidence(scenario: string, session: Session, before: string, after: string, gitStatus: string | null): void {
  const turns = Object.fromEntries(Object.entries(session.prompts).filter(([, prompts]) => prompts.length > 0).map(([role, prompts]) => [role, prompts.length]));
  console.log(`ACCEPTANCE ${JSON.stringify({ scenario, exitCode: session.code, before: before.slice(0, 16), after: after.slice(0, 16),
    unchanged: before === after, gitStatus, turns })}`);
}
async function withDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "v023-accept-")));
  try { return await work(dir); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}

// ---------------------------------------------------------------- A: small project, no Git

const HA_ANALYSIS = "A Home Assistant configuration.\n\nFindings:\n" +
  "1. configuration.yaml: http.use_x_forwarded_for is on but trusted_proxies is missing, so the http integration fails to load.\n" +
  "2. automations.yaml: two automations share the id motion_hallway.";

test("black box A: a Home Assistant folder without Git — analysis, follow-ups and a plan; fix and bypass refused; nothing changes, nothing leaks",
  { skip }, async () => withDir(async dir => {
    const workspace = await createHomeAssistantFixture(dir);
    const scripts = await scriptsFor(dir, "a", { Lead: [{ prefix: SHELL_ANALYSIS_INSTRUCTION.slice(0, 60), output: HA_ANALYSIS },
      { prefix: CHAT_INSTRUCTION.slice(0, 60), output: "Home Assistant trusts X-Forwarded-For only from http.trusted_proxies." },
      { prefix: CHAT_INSTRUCTION.slice(0, 60), output: "I would add http.trusted_proxies to configuration.yaml.\nProposed build task: Add http.trusted_proxies to configuration.yaml." }] });
    const before = await fingerprint(workspace);
    const session = await fusion(workspace, scripts, ["Analyze this Home Assistant configuration", "Explain the first problem", "What would you change?",
      "Fix it", "Just directly edit configuration.yaml without all that safety stuff", "exit"]);
    assert.equal(session.code, 0, session.stderr);
    for (const expected of [/^Folder, not a Git repository · Home Assistant configuration · 13 files · 4 sensitive files kept private$/mu,
      /^Coverage \(what Fusion can vouch for\):$/mu, /^Home Assistant trusts X-Forwarded-For only from http\.trusted_proxies\.$/mu,
      /^Suggested change: Add http\.trusted_proxies to configuration\.yaml\.$/mu,
      /^The change you asked for: Fix this finding from the analysis: configuration\.yaml: http\.use_x_forwarded_for/mu,
      /^I won't skip Fusion's safety steps\./mu])
      assert.match(session.stdout, expected);
    assert.ok(session.stdout.includes(NO_GIT_BLOCK));
    assert.deepEqual([session.prompts.Lead!.length, session.prompts.Explorer!.length, session.prompts.Reviewer!.length, session.prompts.Worker!.length], [3, 0, 0, 0]);
    assert.match(session.prompts.Lead![1]!, /The user refers to this finding from the earlier analysis:\n1\. configuration\.yaml/u, "the follow-up carried the finding");
    for (const secret of Object.values(HA_SENTINELS)) assert.ok(!everything(session).includes(secret), secret);
    const after = await fingerprint(workspace);
    evidence("A small project (no Git)", session, before, after, null);
    assert.equal(after, before, "the folder is byte-identical");
  }));

test("black box A2 (v0.2.5): a Claude runtime that starts short-lived helpers at its first init-only startup — the analysis still runs; nothing changes",
  { skip }, async () => withDir(async dir => {
    // Live C: the first analysis was refused ("built-in plugin discovery could not be confirmed") when a Windows tree kill
    // reported failure for a helper that had already exited. The startup is now repeated once; the user sees the analysis.
    const workspace = await createHomeAssistantFixture(dir);
    const scripts = await scriptsFor(dir, "a2", { Lead: [{ prefix: SHELL_ANALYSIS_INSTRUCTION.slice(0, 60), output: HA_ANALYSIS }] });
    const before = await fingerprint(workspace);
    const session = await fusion(workspace, scripts, ["Analyze this Home Assistant configuration", "exit"], { FUSION_HARNESS_INIT_HELPERS: "first" });
    assert.equal(session.code, 0, session.stderr);
    assert.match(session.stdout, /^A Home Assistant configuration\.$/mu, "the lead's analysis is shown");
    assert.match(session.stdout, /^ {2}— lead · Claude \(/mu);
    assert.ok(!/could not be confirmed|could not start|failed/u.test(session.stdout + session.stderr), session.stdout + session.stderr);
    // Every init-only startup of the Lead's fake runtime is counted: 2 per turn, 3 when the first one had to be repeated.
    const startups = (await readFile(join(scripts, "Lead.json.init-helpers.startups"), "utf8")).split("\n").filter(Boolean).length;
    assert.ok(startups === 2 || startups === 3, `init-only startups: ${startups}`);
    for (const secret of Object.values(HA_SENTINELS)) assert.ok(!everything(session).includes(secret), secret);
    const after = await fingerprint(workspace);
    evidence(`A2 helpers at the first init-only startup (${startups} init-only startups)`, session, before, after, null);
    assert.equal(after, before, "the folder is byte-identical");
  }));

// ---------------------------------------------------------------- B and C: this repository, the Live B shape (v0.3: adaptive)

/** A structured investigation report as the explorer returns it; it cites files every clone of this repository has. */
const REPORT = (area: string, cite: readonly string[] = ["README.md", "package.json"]) => JSON.stringify({ status: "answered",
  summary: `${area}: the entry points in ${area}/ read their input and keep state in memory. EXPLORER-ONLY-${area}`,
  findings: [{ claim: `${area} keeps state in memory`, paths: cite }], openQuestions: [] });
const SYNTHESIS = "Fusion CLI: a TypeScript command-line tool (src/cli/main.ts).\n\nFindings:\n1. src/cli/shell.ts: the shell has no persisted history.";
const PLAN = { action: "delegate", investigations: [{ area: "src", question: "How is a turn routed and guarded?" }, { area: "test", question: "What do the tests cover?" }] };
const PLAN_JSON = JSON.stringify(PLAN);
/** v0.2.4: coverage never claims more than Fusion observes. */
const OVERCLAIM = /examined in depth|read all files|inspected every file/iu;
const RAW = (n: number) => `RAW-PROVIDER-TEXT-${n}-must-never-reach-the-terminal`;
const turnLimit = (n: number): ScriptedTurn => ({ prefix: "", output: RAW(n), exitCode: 1,
  resultFrame: { subtype: "error_max_turns", is_error: true, terminal_reason: "max_turns", num_turns: 7, stop_reason: "tool_use" } });
const apiError = (n: number): ScriptedTurn => ({ prefix: "", output: RAW(n), exitCode: 1,
  resultFrame: { subtype: "error_during_execution", is_error: true, terminal_reason: "api_error", api_error_status: 529 } });
const lead = (prefix: string, turn: Partial<ScriptedTurn>): ScriptedTurn => ({ ...turn, prefix: prefix.slice(0, 60) });
const reviewer = (prefix: string, output: string, scenario?: ScriptedTurn["scenario"]): ScriptedTurn =>
  ({ prefix: prefix.slice(0, 60), output, ...(scenario ? { scenario } : {}) });
/** An investigation turn of the reviewer binding for one packet (parallel packets take their turns in any order). */
const investigation = (when: string, output: string, extra: Partial<ScriptedTurn> = {}): ScriptedTurn =>
  ({ prefix: INVESTIGATION_INSTRUCTION.slice(0, 60), when, output, ...extra });
/** The fake processes' own start/end record of each turn (test-only). */
async function timeline(scripts: string, role: string): Promise<Array<{ n: number; event: "start" | "end"; at: number; pid: number }>> {
  return (await readFile(join(scripts, `${role}.json.timeline.jsonl`), "utf8").catch(() => "")).split("\n").filter(Boolean).map(line => JSON.parse(line));
}

/**
 * The planted secret is made per run: the clone contains this very test file, so a literal sentinel here would be ordinary
 * source text that every view rightly shows.
 */
const CLONE_SECRET = `LIVEB${"-"}SENTINEL-${randomBytes(8).toString("hex")}`;
async function withClone<T>(work: (dir: string, clone: string) => Promise<T>): Promise<T> {
  return withDir(async dir => {
    const clone = join(dir, "fusion-copy");
    git(dir, "clone", "--quiet", process.cwd(), clone);
    // A tracked secret the maintainer's clone would not have: it must never reach a provider or the terminal.
    await mkdir(join(clone, "config"), { recursive: true });
    await writeFile(join(clone, "config", "secrets.yaml"), `api_token: ${CLONE_SECRET}\n`);
    git(clone, "add", "config/secrets.yaml"); git(clone, "commit", "-qm", "planted secret");
    return work(dir, clone);
  });
}

test("black box B: the whole repository on Muse 1.4 — the lead delegates, two investigations run IN PARALLEL on the reviewer binding, the lead reclaims, a fresh critique, truthful coverage",
  { skip }, async () => withClone(async (dir, clone) => {
    // The decision as real Claude replies write JSON: inside one json fence. Each investigation waits at a barrier that
    // only opens when BOTH provider processes run at the same time: a sequential route fails this test (exit 44).
    const scripts = await scriptsFor(dir, "b", { Lead: [lead(ROUTE_PLAN_INSTRUCTION, { output: fenced(PLAN) }), lead(SYNTHESIS_INSTRUCTION, { output: SYNTHESIS })],
      Reviewer: [investigation("Area: src/", REPORT("src", ["src/cli/shell.ts"]), { barrier: { name: "b1", count: 2 } }),
        investigation("Area: test/", REPORT("test", ["test/v02-shell.test.ts"]), { barrier: { name: "b1", count: 2 } }),
        reviewer(CRITIQUE_INSTRUCTION, "The main claim holds.")] });
    const before = await fingerprint(clone);
    const head = git(clone, "rev-parse", "HEAD");
    const session = await fusion(clone, scripts, ["analyze the whole repository", "exit"], { FUSION_HARNESS_MUSE: "1.4" });
    assert.equal(session.code, 0, session.stderr);
    const files = Number(/^Git repository · (\d+) files · 1 sensitive file kept private$/mu.exec(session.stdout)?.[1]);
    assert.ok(files > 300, `a large repository: ${files} files`);
    // The route, as the user sees it.
    assert.match(session.stdout, /^ {2}Route: lead decision → 2 parallel investigations → lead synthesis → fresh review$/mu);
    assert.match(session.stdout, /^ {2}Turns: 5 model turns \(lead 2 · explorers 2 · reviewer 1\) · 1 batch \(1 parallel\) · /mu);
    assert.match(session.stdout, /^ {2}Planning: Claude selected 2 investigation areas \(src\/, test\/\)\.$/mu);
    assert.match(session.stdout, /\(the explorer binding's read-only posture is not proven on this runtime, so it was not used; the reviewer binding explored instead\)/u);
    assert.match(session.stdout, /^ {2}Explorer investigations: 2 of 2 answered \(src\/ by reviewer \(meta\), test\/ by reviewer \(meta\)\)$/mu);
    assert.match(session.stdout, /^Second opinion — reviewer · Muse/mu);
    // PROOF OF CONCURRENCY, from the provider processes themselves: both investigation processes reached the barrier, and
    // each started before the other ended.
    const turns = (await timeline(scripts, "Reviewer")).filter(entry => entry.n === 0 || entry.n === 1);
    const at = (n: number, event: string) => turns.find(e => e.n === n && e.event === event)!.at;
    assert.ok(at(0, "start") < at(1, "end") && at(1, "start") < at(0, "end"), `the two investigations overlapped: ${JSON.stringify(turns)}`);
    assert.equal(new Set(turns.map(e => e.pid)).size, 2, "two separate provider processes");
    // The whole coverage block, truthful: assigned (what Fusion asked for) and cited (what the answer names), never "read".
    assert.match(session.stdout, /^ {2}Inventoried: \d+ files in this repository$/mu);
    assert.match(session.stdout, /^ {2}Assigned to explorer investigations: src\/, test\/ \(\d+ files in those areas\)$/mu);
    assert.match(session.stdout, /^ {2}Cited in the final answer: 2 files from the shared copy \(src\/cli\/main\.ts, src\/cli\/shell\.ts\)$/mu);
    assert.match(session.stdout, /^ {2}Neither assigned nor cited: .*docs\//mu);
    assert.match(session.stdout, /^ {2}Model turns: 5\. Fusion cannot see which files a model opened: "assigned" is what explorers were asked to look at, "cited" is what the final answer names\.$/mu);
    assert.ok(!OVERCLAIM.test(said(session)), "no coverage overclaim, to the user or to a model");
    // What each fake provider PROCESS received.
    const [planPrompt, synthesisPrompt] = session.prompts.Lead!;
    const reviewerPrompts = session.prompts.Reviewer!;
    const srcPrompt = reviewerPrompts.find(p => /^Area: src\//mu.test(p))!, testPrompt = reviewerPrompts.find(p => /^Area: test\//mu.test(p))!;
    const critiquePrompt = reviewerPrompts.find(p => p.startsWith(CRITIQUE_INSTRUCTION))!;
    assert.deepEqual([session.prompts.Lead!.length, reviewerPrompts.length, session.prompts.Explorer!.length], [2, 3, 0]);
    assert.ok(planPrompt!.startsWith(ROUTE_PLAN_INSTRUCTION) && planPrompt!.length < 60_000, `plan prompt ${planPrompt!.length} chars`);
    assert.match(planPrompt!, /^Repository: fusion-copy \(\d{3} tracked files\)$/mu);
    // The decision turn as the provider process received it: the closed list of area ids, its budget, and only the JSON rule.
    assert.match(planPrompt!, /^Areas you may choose \(id: files\):\n- (?:src|test): \d+ file\(s\)\n/mu);
    assert.match(planPrompt!, /^You may ask for at most 3 investigation\(s\) now; each explorer opens at most 3 files\.$/mu);
    assert.match(planPrompt!, /^- This is a planning turn\. Your whole reply is exactly the one JSON object/mu);
    assert.ok(!planPrompt!.includes("Answer in natural language") && !planPrompt!.includes("Proposed build task: <"), "no rule contradicts the JSON contract");
    assert.ok(!planPrompt!.includes("export async function runShell") && !planPrompt!.includes("Conversation so far"), "no file content, no transcript");
    assert.match(srcPrompt, /^Area: src\/ \(\d+ file\(s\)\)$/mu);
    assert.match(srcPrompt, /^Question: How is a turn routed and guarded\?$/mu);
    assert.match(testPrompt, /^Area: test\/ \(\d+ file\(s\)\)$/mu);
    for (const prompt of [srcPrompt, testPrompt, critiquePrompt])
      assert.ok(!prompt.includes("Conversation so far") && !prompt.includes("analyze the whole repository") && !prompt.includes("EXPLORER-ONLY-"),
        "a packet only: no transcript, no request text beyond its question, no other explorer's report");
    assert.ok(synthesisPrompt!.includes("EXPLORER-ONLY-src") && synthesisPrompt!.includes("EXPLORER-ONLY-test"), "the lead reclaims with the reports");
    assert.match(synthesisPrompt!, /^Fusion's assessment: 2 structured report\(s\), 0 unstructured, 0 failed; 2 shared file\(s\) cited\.$/mu);
    assert.ok(critiquePrompt.startsWith(CRITIQUE_INSTRUCTION) && !critiquePrompt.includes("EXPLORER-ONLY-"), "a fresh critique of the synthesis only");
    assert.ok(!everything(session).includes(CLONE_SECRET), "the tracked secret never leaves");
    assert.ok(session.views.Reviewer!.every(files => files["config/secrets.yaml"]?.includes("api_token: <redacted>")), "every view copy is filtered");
    assert.equal(git(clone, "status", "--porcelain"), "");
    assert.equal(git(clone, "rev-parse", "HEAD"), head);
    const after = await fingerprint(clone);
    evidence("B large repository (Muse 1.4), lead delegates, parallel investigations", session, before, after, git(clone, "status", "--porcelain"));
    assert.equal(after, before);
  }));

test("black box B2: the lead's routing decision is invalid — Fusion's deterministic fallback, observable, with a safe category; the route continues; nothing changes",
  { skip }, async () => withClone(async (dir, clone) => {
    const before = await fingerprint(clone);
    const head = git(clone, "rev-parse", "HEAD");
    const MARKER = "PLAN-REPLY-TEXT-must-never-reach-the-terminal";
    // An unknown area (a subdirectory, not an id from the list) and prose around the JSON: the likeliest real deviations.
    const invalid: Array<[string, string]> = [
      [fenced({ action: "delegate", investigations: [{ area: "src/app", question: MARKER }, { area: "test", question: "tests" }] }), "unknown area"],
      [`Here is the plan (${MARKER}):\n${fenced(PLAN)}`, "prose around the JSON"],
    ];
    for (const [index, [reply, category]] of invalid.entries()) {
      const scripts = await scriptsFor(dir, `b2-${index}`, { Lead: [lead(ROUTE_PLAN_INSTRUCTION, { output: reply }), lead(SYNTHESIS_INSTRUCTION, { output: SYNTHESIS })],
        Reviewer: [investigation("Packet: b1-i1", REPORT("a")), investigation("Packet: b1-i2", REPORT("b")), investigation("Packet: b1-i3", REPORT("c")),
          reviewer(CRITIQUE_INSTRUCTION, "The main claim holds.")] });
      const session = await fusion(clone, scripts, ["analyze the whole repository", "exit"], { FUSION_HARNESS_MUSE: "1.4" });
      assert.equal(session.code, 0, session.stderr);
      const planning = new RegExp(`^ {2}Planning: Claude's structured plan was invalid \\(${category}\\); Fusion selected 3 bounded areas instead \\(([^)]+)\\)\\.$`, "mu").exec(session.stdout);
      assert.ok(planning, `${category}: the fallback is announced\n${session.stdout}`);
      const areas = planning[1]!;
      assert.equal(areas.split(", ").length, 3);
      assert.ok(!(session.stdout + session.stderr).includes(MARKER) && !session.stdout.includes("Here is the plan"), "nothing of the refused reply is shown");
      // The rest of the route runs: three parallel investigations, the synthesis, the fresh critique, truthful coverage.
      assert.match(session.stdout, /^ {2}Explorer investigations: 3 of 3 answered \(/mu);
      assert.match(session.stdout, new RegExp(`^ {2}Route: lead decision \\(refused: ${category}\\) → Fusion's own areas → 3 parallel investigations → lead synthesis → fresh review$`, "mu"));
      assert.deepEqual([session.prompts.Lead!.length, session.prompts.Reviewer!.length, session.prompts.Explorer!.length], [2, 4, 0]);
      assert.ok(session.prompts.Lead![1]!.startsWith(SYNTHESIS_INSTRUCTION) && session.prompts.Reviewer![3]!.startsWith(CRITIQUE_INSTRUCTION));
      assert.ok(!session.prompts.Lead![1]!.includes(MARKER), "the refused decision is not handed on either");
      assert.match(session.stdout, /^Second opinion — reviewer · Muse/mu);
      assert.ok(session.stdout.includes(`  Assigned to explorer investigations: ${areas} (`), "coverage names the areas Fusion assigned");
      assert.ok(!OVERCLAIM.test(said(session)), "no coverage overclaim");
      assert.ok(!everything(session).includes(CLONE_SECRET), "the tracked secret never leaves");
      assert.equal(git(clone, "status", "--porcelain"), "");
      assert.equal(git(clone, "rev-parse", "HEAD"), head);
      const after = await fingerprint(clone);
      evidence(`B2 decision fallback (${category})`, session, before, after, git(clone, "status", "--porcelain"));
      assert.equal(after, before);
    }
  }));

test("black box C: each provider stage of the adaptive route failing in turn — a safe, categorised message; back at the prompt; nothing changes",
  { skip }, async () => withClone(async (dir, clone) => {
    const before = await fingerprint(clone);
    const run = async (name: string, turns: Readonly<Record<string, readonly ScriptedTurn[]>>) => {
      const session = await fusion(clone, await scriptsFor(dir, name, turns), ["analyze the whole repository", "help", "exit"], { FUSION_HARNESS_MUSE: "1.4" });
      assert.equal(session.code, 0, `${name}: ${session.stderr}`);
      assert.ok(session.stdout.includes("Talk to Fusion in plain words."), `${name}: back at the prompt`);
      assert.ok(!/RAW-PROVIDER-TEXT/u.test(session.stdout + session.stderr), `${name}: no raw provider text`);
      assert.ok(!everything(session).includes(CLONE_SECRET), `${name}: no secret`);
      const after = await fingerprint(clone);
      evidence(`C ${name}`, session, before, after, git(clone, "status", "--porcelain"));
      assert.equal(after, before, `${name}: unchanged`);
      return session;
    };
    const fallback3 = [investigation("Packet: b1-i1", REPORT("a")), investigation("Packet: b1-i2", REPORT("b")), investigation("Packet: b1-i3", REPORT("c"))];
    const planned2 = [investigation("Area: src/", REPORT("src")), investigation("Area: test/", REPORT("test"))];
    // 1. The lead's decision turn stops at its turn limit (a provider terminal failure): Fusion's own bounded areas are
    //    used, and the safe fields say why.
    const plan1 = await run("c1", { Lead: [lead(ROUTE_PLAN_INSTRUCTION, turnLimit(1)), lead(SYNTHESIS_INSTRUCTION, { output: SYNTHESIS })],
      Reviewer: [...fallback3, reviewer(CRITIQUE_INSTRUCTION, "ok")] });
    assert.match(plan1.stdout, /^ {2}Planning: Claude's planning turn failed: Claude reported a failed turn\. \(Claude stopped at Fusion's turn limit before it answered \[subtype=error_max_turns terminal_reason=max_turns stop_reason=tool_use is_error=true num_turns=7 max_turns=6 api_error_status=none exit_code=1\]\); Fusion selected 3 bounded areas instead \([^)]+\)\.$/mu);
    assert.match(plan1.stdout, /Explorer investigations: 3 of 3 answered/u);
    // 2. A provider API error at the synthesis: the stage, the category, the status — then the prompt again.
    const terminal = await run("c2", { Lead: [lead(ROUTE_PLAN_INSTRUCTION, { output: PLAN_JSON }), lead(SYNTHESIS_INSTRUCTION, apiError(2))], Reviewer: planned2 });
    assert.match(terminal.stderr, /^fusion: Provider failed: The lead's synthesis failed after 2 of 2 investigation report\(s\): Claude reported a failed turn\.\ndetail: Claude reported a provider API error \[subtype=error_during_execution terminal_reason=api_error .*api_error_status=529 .*exit_code=1\]$/mu);
    // 3. A decision that is no JSON at all.
    const malformed = await run("c3", { Lead: [lead(ROUTE_PLAN_INSTRUCTION, { output: "Look at src first, then maybe test." }), lead(SYNTHESIS_INSTRUCTION, { output: SYNTHESIS })],
      Reviewer: [...fallback3, reviewer(CRITIQUE_INSTRUCTION, "ok")] });
    assert.match(malformed.stdout, /^ {2}Planning: Claude's structured plan was invalid \(invalid JSON\); Fusion selected 3 bounded areas instead \([^)]+\)\.$/mu);
    assert.ok(!malformed.stdout.includes("Look at src first"), "the refused reply is not shown");
    // 4. An explorer fails, and its one repeat fails too: contained and reported; the sibling's report stands; the evidence is
    //    weak, so the lead reviews it (and decides to synthesize); coverage says no report came back.
    const explorer = await run("c4", { Lead: [lead(ROUTE_PLAN_INSTRUCTION, { output: PLAN_JSON }), lead(ROUTE_EVIDENCE_INSTRUCTION, { output: JSON.stringify({ action: "synthesize" }) }),
      lead(SYNTHESIS_INSTRUCTION, { output: SYNTHESIS })],
      Reviewer: [investigation("Area: src/", "", { scenario: "fail" }), investigation("Area: test/", REPORT("test")), investigation("Area: src/", "", { scenario: "fail" }),
        reviewer(CRITIQUE_INSTRUCTION, "ok")] });
    assert.match(explorer.stdout, /\(explorer for src failed: provider failure: Muse Exec reported a failed turn[^)]*\)/u);
    assert.match(explorer.stdout, /Explorer investigations: 1 of 2 answered/u);
    assert.match(explorer.stdout, /^ {2}Route: lead decision → 2 parallel investigations \(1 failed\) → 1 repeat \(1 failed\) → lead evidence review → lead synthesis → fresh review$/mu);
    assert.match(explorer.stdout, /^ {2}Assigned to explorer investigations: src\/, test\/ \(\d+ files in those areas\); no report came back for src\/$/mu);
    assert.match(explorer.stdout, /^ {2}Evidence: incomplete \(failed investigations\)\.$/mu);
    // 5. The synthesis stops at its turn limit.
    const synthesis = await run("c5", { Lead: [lead(ROUTE_PLAN_INSTRUCTION, { output: PLAN_JSON }), lead(SYNTHESIS_INSTRUCTION, turnLimit(5))], Reviewer: planned2 });
    assert.match(synthesis.stderr, /^fusion: Provider failed: The lead's synthesis failed after 2 of 2 investigation report\(s\): Claude reported a failed turn\.\ndetail: Claude stopped at Fusion's turn limit before it answered \[.*num_turns=7 max_turns=6/mu);
    // 6. The fresh critique fails: the analysis stands, the missing second opinion is explained.
    const critique = await run("c6", { Lead: [lead(ROUTE_PLAN_INSTRUCTION, { output: PLAN_JSON }), lead(SYNTHESIS_INSTRUCTION, { output: SYNTHESIS })],
      Reviewer: [...planned2, reviewer(CRITIQUE_INSTRUCTION, "", "fail")] });
    assert.match(critique.stdout, /\(No second opinion: Muse Exec reported a failed turn[^)]*\)/u);
    assert.match(critique.stdout, /Coverage \(what Fusion can vouch for\):/u);
  }));

// ---------------------------------------------------------------- D: analysis → build → approval → apply

const SUM_BUGGY = "export function add(a, b) {\n  return a - b;\n}\n";
const SUM_FIXED = "export function add(a, b) {\n  return a + b;\n}\n";
const SUM_TEST = "import assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\nimport { add } from \"../src/sum.js\";\n\n" +
  "test(\"adds\", () => {\n  assert.equal(add(2, 3), 5);\n});\n";
const SUM_TEST_FIXED = `${SUM_TEST}\ntest("adds negatives", () => {\n  assert.equal(add(-2, -3), -5);\n});\n`;
const VERIFICATION = JSON.stringify({ commands: [], platformRequirement: "linux-compatible", dependencies: "none",
  confinedCommands: [{ id: "unit", executable: "/usr/local/bin/node", args: ["--test", "test/sum.test.js"], cwd: ".", timeoutMs: 180_000, mutationPolicy: "readOnly" }] });
async function sumProject(dir: string): Promise<string> {
  const root = join(dir, "sum");
  const files: Record<string, string> = { "package.json": JSON.stringify({ name: "sum", type: "module", scripts: { test: "node --test" } }),
    "src/sum.js": SUM_BUGGY, "test/sum.test.js": SUM_TEST, "config/app.yaml": "service: sum\npassword: D-SENTINEL-7777\n", ".gitignore": "node_modules/\n" };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, ...path.split("/"))), { recursive: true });
    await writeFile(join(root, ...path.split("/")), content);
  }
  git(root, "init", "-q"); git(root, "add", "."); git(root, "commit", "-qm", "sum with a bug");
  return root;
}
const D_ANALYSIS = "A tiny module.\n\nFindings:\n1. src/sum.js: add() subtracts instead of adding; test/sum.test.js covers only one case.";
function dScripts(): Record<string, ScriptedTurn[]> {
  const change = { schemaVersion: 1, operations: [
    { kind: "writeText", path: "src/sum.js", expectedSha256: sha256(SUM_BUGGY), content: SUM_FIXED },
    { kind: "writeText", path: "test/sum.test.js", expectedSha256: sha256(SUM_TEST), content: SUM_TEST_FIXED }] };
  return { Lead: [lead(SHELL_ANALYSIS_INSTRUCTION, { output: D_ANALYSIS }), lead(SCOPE_INSTRUCTION, { output: fenced(["src/sum.js", "test/sum.test.js"]) }),
      { prefix: PREFIX.plan, output: plan("Plan: make add() add, and cover negatives.") }],
    Worker: [{ prefix: PREFIX.proposal, output: fenced(change) }], Reviewer: [{ prefix: PREFIX.review, output: cleanReview }] };
}

test("black box D (offline rehearsal): analysis → fix the first problem → explicit confirmation → the verified Writer route; never delivered, nothing written",
  { skip }, async () => withDir(async dir => {
    const root = await sumProject(dir);
    const scripts = await scriptsFor(dir, "d-offline", dScripts());
    const before = await fingerprint(root);
    const session = await fusion(root, scripts, ["Analyze this project", "Fix the first problem", "y", "exit"],
      { FUSION_HARNESS_VERIFICATION: VERIFICATION, FUSION_HARNESS_COMPOSE: "offline" });
    assert.equal(session.code, 0, session.stderr);
    for (const expected of [/^Preparing a verified change: Fix this finding from the analysis: src\/sum\.js: add\(\) subtracts instead of adding/mu,
      /^Scope \(proposed by lead \([^)]+\); confirm or rerun with --path\): src\/sum\.js, test\/sum\.test\.js$/mu, /^Start this verified build\? \[y\/N\] y$/mu,
      /^Build: PASS \(offline rehearsal — never delivered\)$/mu, /^Review: PASS \(1 cycle\(s\), 0 finding\(s\), 0 outstanding\)$/mu,
      /^No change was prepared, so nothing can be applied\. Your files are unchanged\.$/mu])
      assert.match(session.stdout, expected);
    assert.deepEqual([session.prompts.Lead!.length, session.prompts.Worker!.length, session.prompts.Reviewer!.length], [3, 1, 1]);
    assert.ok(!everything(session).includes("D-SENTINEL-7777"));
    const after = await fingerprint(root);
    evidence("D analysis to build (offline rehearsal)", session, before, after, git(root, "status", "--porcelain"));
    assert.equal(after, before, "the primary is untouched");
  }));

const dockerLive = process.env.FUSION_DOCKER_LIVE === "1" ? false : "set FUSION_DOCKER_LIVE=1 (needs Docker with Linux containers and the pinned image)";
test("black box D (REAL confined verification): analysis → build → Docker verification → fresh review → delivery → one-step approval → exact apply, once",
  { skip: skip || dockerLive, timeout: 15 * 60_000 }, async () => withDir(async dir => {
    const root = await sumProject(dir);
    const scripts = await scriptsFor(dir, "d-live", dScripts());
    const head = git(root, "rev-parse", "HEAD").trim();
    const before = await fingerprint(root);
    const session = await fusion(root, scripts, ["Analyze this project", "Fix the first problem", "y", "y", "exit"], { FUSION_HARNESS_VERIFICATION: VERIFICATION });
    assert.equal(session.code, 0, `${session.stdout}\n${session.stderr}`);
    assert.ok(!/fusion approve-delivery d-/u.test(session.stdout.split("Ready to apply verified changes")[0]!), "the shell offers its own one-step approval");
    for (const expected of [/^Build: PASS$/mu, /^Verification: PASS \(docker-linux, 1 command\(s\)\)$/mu, /^Review: PASS \(1 cycle\(s\)/mu,
      /^Ready to apply verified changes$/mu, /^ {2}Verification: PASS \(1 command in docker-linux, osSandbox\)$/mu,
      /^Apply these exact verified changes\? \[y\/N\] y$/mu, /^Result: applied \(phase done\)$/mu,
      /^Approval: human-confirmed \(confirmedVerifiedSummary\) at .+, for this delivery and checkout only$/mu])
      assert.match(session.stdout, expected);
    // Exactly the verified bytes, only the two files, uncommitted; no secret reached a provider.
    assert.equal(await readFile(join(root, "src", "sum.js"), "utf8"), SUM_FIXED);
    assert.equal(await readFile(join(root, "test", "sum.test.js"), "utf8"), SUM_TEST_FIXED);
    assert.deepEqual(git(root, "status", "--porcelain").split("\n").filter(Boolean).sort(), [" M src/sum.js", " M test/sum.test.js"]);
    assert.equal(git(root, "rev-parse", "HEAD").trim(), head);
    assert.ok(!everything(session).includes("D-SENTINEL-7777"));
    // Single use: the same delivery never applies twice.
    const id = /^ {2}Delivery: (d-[0-9a-f]{24})$/mu.exec(session.stdout)![1]!;
    const replay = await fusion(root, scripts, [], { FUSION_HARNESS_VERIFICATION: VERIFICATION }, ["apply", id]);
    assert.equal(replay.code, 2, replay.stdout + replay.stderr);
    evidence("D analysis to build (REAL Docker) + replay exit " + String(replay.code), session, before, await fingerprint(root), git(root, "status", "--porcelain"));
  }));

test("black box: the real entry point refuses the shell without a terminal and keeps its expert commands", { skip }, async () => withDir(async dir => {
  const main = resolve(process.cwd(), "dist/src/cli/main.js");
  const piped = spawnSync(process.execPath, [main], { cwd: dir, input: "analyze this project\nexit\n", encoding: "utf8", windowsHide: true });
  assert.equal(piped.status, 2);
  assert.match(piped.stderr, /missing command\. Run `fusion` without arguments in an interactive terminal/u);
  const version = spawnSync(process.execPath, [main, "--version"], { cwd: dir, encoding: "utf8", windowsHide: true });
  assert.deepEqual([version.status, version.stdout], [0, "fusion 0.5.0\n"]);
  assert.deepEqual(await readdir(dir), [], "nothing was written");
}));
