import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { SCOPE_INSTRUCTION } from "../src/app/build-scope.js";
import { CRITIQUE_INSTRUCTION, SHELL_ANALYSIS_INSTRUCTION, SYNTHESIS_INSTRUCTION } from "../src/app/exploration.js";
import { ROUTE_EVIDENCE_INSTRUCTION, ROUTE_PLAN_INSTRUCTION } from "../src/app/orchestration/adaptive.js";
import { INVESTIGATION_INSTRUCTION } from "../src/app/orchestration/investigations.js";
import { CHAT_INSTRUCTION } from "../src/app/conversation.js";
import { createHomeAssistantFixture, HA_FILES, HA_SENTINELS } from "./fixtures/home-assistant.js";
import { cleanReview, fenced, plan, PREFIX, type ScriptedTurn } from "./fixtures/route-harness.js";
import { gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * v0.3 — BLACK-BOX ACCEPTANCE of adaptive orchestration, driven as a user drives Fusion: the product harness
 * (`test/fixtures/fusion-shell-harness.ts`: `main.js`'s wiring with stdin lines instead of a TTY, the REAL Claude and Muse
 * adapters on scripted FAKE provider binaries) is started as a separate process, lines are typed into it, and only what is
 * observable outside counts: the terminal, the exit code, the workspace's bytes and Git status, and what each fake provider
 * PROCESS received, when it ran (its own timeline), where it ran and what its view contained.
 *
 *   A  a simple question on a small project: one lead turn, no delegation, the route says "lead only"
 *   B  a broad analysis of this repository: three investigations whose provider processes provably run AT THE SAME TIME
 *      (a barrier only opens when all three are running), each in its own view copy, all copies removed afterwards
 *   E  failure containment with real processes: one investigation fails twice, one hangs until its deadline and is
 *      repeated, one reports; no raw provider text, no process left running, no view left behind
 *   F  analysis → "is the first problem really a bug?" (a parallel verification) → "fix it" → the EXISTING confirmed build
 *      route (offline rehearsal; with FUSION_DOCKER_LIVE=1 real Docker, delivery, approval and apply)
 *   G  a Home Assistant folder: the lead asks for the authentication store, Fusion refuses; the investigators' view copies
 *      hold no secret, key names only
 * (C, D — weak and conflicting evidence — are in v03-adaptive-shell.test.ts; the v0.2 black box keeps B2 and C.)
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
interface Timeline { n: number; event: "start" | "end"; at: number; pid: number; cwd?: string }
const ROLES = ["Lead", "Worker", "Explorer", "Reviewer"] as const;
async function fusion(workspace: string, scriptsDir: string, lines: readonly string[], env: Readonly<Record<string, string>> = {}): Promise<Session> {
  const child = spawn(process.execPath, [HARNESS], { cwd: process.cwd(), windowsHide: true,
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
  for (const role of ROLES) {
    prompts[role] = (await read(join(scriptsDir, `${role}.json.prompts.jsonl`))).map(entry => entry.prompt!);
    views[role] = (await read(join(scriptsDir, `${role}.json.views.jsonl`))).map(entry => entry.files!);
  }
  return { code, stdout, stderr, prompts, views };
}
async function timeline(scriptsDir: string, role: string): Promise<Timeline[]> {
  return (await readFile(join(scriptsDir, `${role}.json.timeline.jsonl`), "utf8").catch(() => "")).split("\n").filter(Boolean).map(line => JSON.parse(line) as Timeline);
}
async function scriptsFor(dir: string, name: string, turns: Readonly<Partial<Record<(typeof ROLES)[number], readonly ScriptedTurn[]>>>): Promise<string> {
  const scripts = join(dir, name, "scripts");
  await mkdir(scripts, { recursive: true });
  for (const role of ROLES) await writeFile(join(scripts, `${role}.json`), JSON.stringify(turns[role] ?? []));
  return scripts;
}
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
function evidence(scenario: string, session: Session, before: string, after: string, gitStatus: string | null): void {
  const turns = Object.fromEntries(Object.entries(session.prompts).filter(([, prompts]) => prompts.length > 0).map(([role, prompts]) => [role, prompts.length]));
  const route = /^ {2}Route: (.+)$/mu.exec(session.stdout)?.[1] ?? null;
  console.log(`ACCEPTANCE ${JSON.stringify({ scenario, exitCode: session.code, unchanged: before === after, gitStatus, turns, route })}`);
}
async function withDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "v03-accept-")));
  try { return await work(dir); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const gone = async (path: string): Promise<boolean> => lstat(path).then(() => false, () => true);
const lead = (prefix: string, turn: Partial<ScriptedTurn>): ScriptedTurn => ({ ...turn, prefix: prefix.slice(0, 60) });
const investigation = (when: string, output: string, extra: Partial<ScriptedTurn> = {}): ScriptedTurn =>
  ({ prefix: INVESTIGATION_INSTRUCTION.slice(0, 60), when, output, ...extra });
const report = (summary: string, paths: readonly string[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ status: "answered", summary, findings: [{ claim: summary.slice(0, 80), paths }], openQuestions: [], ...extra });
const delegate = (...areas: string[]) => fenced({ action: "delegate", investigations: areas.map(area => ({ area, question: `What in ${area}/ matters for the request?` })) });

/** The planted secret is made per run: the clone contains this very file, so a literal here would be shared source text. */
const CLONE_SECRET = `V03${"-"}SENTINEL-${randomBytes(8).toString("hex")}`;
async function withClone<T>(work: (dir: string, clone: string) => Promise<T>): Promise<T> {
  return withDir(async dir => {
    const clone = join(dir, "fusion-copy");
    git(dir, "clone", "--quiet", process.cwd(), clone);
    await mkdir(join(clone, "config"), { recursive: true });
    await writeFile(join(clone, "config", "secrets.yaml"), `api_token: ${CLONE_SECRET}\n`);
    git(clone, "add", "config/secrets.yaml"); git(clone, "commit", "-qm", "planted secret");
    return work(dir, clone);
  });
}
const SYNTHESIS = "Fusion CLI: a TypeScript command-line tool (src/cli/main.ts).\n\nFindings:\n1. src/cli/shell.ts: the shell has no persisted history.";
/** The live acceptance runner's verdicts (scripts/v03-live-verdicts.mjs), applied to what this black box printed. */
type Verdicts = { judgeL2(segment: string, unchanged: boolean): { status: string; detail: string };
  judgeL4Evidence(verification: string, change: string): { ok: boolean; detail: string } };
const verdicts = async (): Promise<Verdicts> => await import(pathToFileURL(resolve(process.cwd(), "scripts", "v03-live-verdicts.mjs")).href) as Verdicts;
/** The part of the terminal a typed line produced (up to the next typed line). */
const segmentOf = (stdout: string, line: string, next?: string): string => {
  const start = stdout.indexOf(`> ${line}\n`);
  assert.ok(start >= 0, `the line was typed: ${line}`);
  const end = next === undefined ? -1 : stdout.indexOf(`> ${next}\n`, start);
  return stdout.slice(start, end < 0 ? undefined : end);
};

// ---------------------------------------------------------------- A: a simple task stays simple

test("black box v0.3 A: a simple question on a small project — one lead turn, no explorer, no reviewer; the route says lead only",
  { skip }, async () => withDir(async dir => {
    const root = join(dir, "small");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "small", type: "module", scripts: { test: "node --test" } }));
    await writeFile(join(root, "src", "index.js"), "export const hello = () => \"hi\";\n");
    git(root, "init", "-q"); git(root, "add", "."); git(root, "commit", "-qm", "small");
    const scripts = await scriptsFor(dir, "a", { Lead: [lead(CHAT_INSTRUCTION, { output: "package.json names the package and runs node --test." })] });
    const before = await fingerprint(root);
    const session = await fusion(root, scripts, ["what does package.json do?", "exit"]);
    assert.equal(session.code, 0, session.stderr);
    assert.match(session.stdout, /^package\.json names the package and runs node --test\.$/mu);
    assert.match(session.stdout, /^ {2}Route: lead only · 1 model turn · \d+\.\d s$/mu);
    assert.deepEqual(ROLES.map(role => session.prompts[role]!.length), [1, 0, 0, 0], "one lead turn and nothing else");
    const after = await fingerprint(root);
    evidence("v0.3 A simple task", session, before, after, git(root, "status", "--porcelain"));
    assert.equal(after, before);
  }));

// ---------------------------------------------------------------- B: three parallel investigations, proven

test("black box v0.3 B: three investigations of a large repository run AT THE SAME TIME in separate processes and view copies; the lead reclaims",
  { skip }, async () => withClone(async (dir, clone) => {
    const three = { name: "b3", count: 3 };
    const scripts = await scriptsFor(dir, "b3", { Lead: [lead(ROUTE_PLAN_INSTRUCTION, { output: delegate("src", "test", "docs") }), lead(SYNTHESIS_INSTRUCTION, { output: SYNTHESIS })],
      Reviewer: [investigation("Area: src/", report("src/ routes each turn. EXPLORER-ONLY-src", ["src/cli/shell.ts"]), { barrier: three }),
        investigation("Area: test/", report("test/ covers the shell. EXPLORER-ONLY-test", ["test/v02-shell.test.ts"]), { barrier: three }),
        investigation("Area: docs/", report("docs/ records the milestones. EXPLORER-ONLY-docs", ["docs/security-model.md"]), { barrier: three }),
        lead(CRITIQUE_INSTRUCTION, { output: "The main claim holds." })] });
    const before = await fingerprint(clone);
    const session = await fusion(clone, scripts, ["analyze the whole repository", "exit"], { FUSION_HARNESS_MUSE: "1.4" });
    assert.equal(session.code, 0, session.stderr);
    assert.match(session.stdout, /^ {2}Route: lead decision → 3 parallel investigations → lead synthesis → fresh review$/mu);
    assert.match(session.stdout, /^ {2}Turns: 6 model turns \(lead 2 · explorers 3 · reviewer 1\) · 1 batch \(1 parallel\) · /mu);
    assert.match(session.stdout, /^ {2}Explorer investigations: 3 of 3 answered \(src\/ by reviewer \(meta\), test\/ by reviewer \(meta\), docs\/ by reviewer \(meta\)\)$/mu);
    const runs = (await timeline(scripts, "Reviewer")).filter(e => e.n <= 2);
    const starts = runs.filter(e => e.event === "start"), ends = runs.filter(e => e.event === "end");
    assert.equal(starts.length, 3);
    assert.ok(Math.max(...starts.map(e => e.at)) < Math.min(...ends.map(e => e.at)), `all three ran at once: ${JSON.stringify(runs)}`);
    assert.equal(new Set(starts.map(e => e.pid)).size, 3, "three provider processes");
    assert.equal(new Set(starts.map(e => e.cwd)).size, 3, "three view copies");
    for (const start of starts) {
      assert.equal(alive(start.pid), false, "no provider process is left running");
      assert.equal(await gone(start.cwd!), true, "every view copy was removed");
    }
    const prompts = session.prompts.Reviewer!;
    for (const area of ["src", "test", "docs"]) {
      const own = prompts.find(p => new RegExp(`^Area: ${area}/`, "mu").test(p))!;
      assert.ok(!own.includes("EXPLORER-ONLY-") && !own.includes("Conversation so far"), `${area}: its packet only`);
    }
    assert.ok(session.prompts.Lead![1]!.includes("EXPLORER-ONLY-src") && session.prompts.Lead![1]!.includes("EXPLORER-ONLY-docs"), "the lead reclaims with every report");
    assert.ok(!everything(session).includes(CLONE_SECRET));
    const after = await fingerprint(clone);
    evidence("v0.3 B three parallel investigations", session, before, after, git(clone, "status", "--porcelain"));
    assert.equal(after, before);
  }));

// ---------------------------------------------------------------- E: failure containment with real processes

test("black box v0.3 E: one investigation fails twice, one hangs until its deadline and is repeated, one reports — contained, safe, nothing left running",
  { skip, timeout: 5 * 60_000 }, async () => withClone(async (dir, clone) => {
    const scripts = await scriptsFor(dir, "e", {
      Lead: [lead(ROUTE_PLAN_INSTRUCTION, { output: delegate("src", "test", "docs") }), lead(ROUTE_EVIDENCE_INSTRUCTION, { output: JSON.stringify({ action: "synthesize" }) }),
        lead(SYNTHESIS_INSTRUCTION, { output: SYNTHESIS })],
      Reviewer: [investigation("Area: src/", "RAW-PROVIDER-TEXT-src", { scenario: "fail" }), investigation("Area: test/", "RAW-PROVIDER-TEXT-test", { scenario: "hang" }),
        investigation("Area: docs/", report("docs/ holds the milestones.", ["docs/security-model.md"])),
        investigation("Area: src/", "RAW-PROVIDER-TEXT-src-again", { scenario: "fail" }), investigation("Area: test/", report("test/ covers the shell.", ["test/v02-shell.test.ts"])),
        lead(CRITIQUE_INSTRUCTION, { output: "ok" })] });
    const before = await fingerprint(clone);
    const session = await fusion(clone, scripts, ["analyze the whole repository", "exit"], { FUSION_HARNESS_MUSE: "1.4" });
    assert.equal(session.code, 0, session.stderr);
    // src/ failed and test/ hung (both transient): each repeated once; src/ failed again. The evidence is weak, so the lead
    // reviews it; it decides to synthesize.
    assert.match(session.stdout, /^ {2}Route: lead decision → 3 parallel investigations \(2 failed\) → 2 repeats \(1 failed\) → lead evidence review → lead synthesis → fresh review$/mu);
    assert.match(session.stdout, /\(explorer for src failed: provider failure: /u);
    assert.match(session.stdout, /\(explorer for src failed: provider failure: Muse Exec reported a failed turn[^)]*\)/u);
    assert.match(session.stdout, /^ {2}Explorer investigations: 2 of 3 answered/mu);
    assert.match(session.stdout, /^ {2}Evidence: incomplete \(failed investigations\)\.$/mu);
    // Every failed attempt keeps its category and safe message on the terminal, including the one a repeat superseded.
    assert.match(session.stdout, /^ {2}\(explorer for src: attempt 1 failed — provider failure: Muse Exec reported a failed turn[^)]*\)? It was repeated once and failed again\.\)$/mu);
    assert.match(session.stdout, /^ {2}\(explorer for test: attempt 1 failed — timeout: .+ It was repeated once and answered\.\)$/mu);
    // The live runner's verdict: an investigation that never answered after its bounded repeat fails L2.
    const { judgeL2 } = await verdicts();
    assert.deepEqual(judgeL2(session.stdout, true), { status: "FAIL", detail: "1 of 3 investigation(s) never answered, after the bounded repeat (see the explorer lines)" });
    assert.ok(!/RAW-PROVIDER-TEXT/u.test(session.stdout + session.stderr), "no raw provider text");
    const runs = await timeline(scripts, "Reviewer");
    for (const start of runs.filter(e => e.event === "start")) {
      assert.equal(alive(start.pid), false, `no zombie: process ${start.pid} (turn ${start.n}) has exited`);
      if (start.cwd !== undefined) assert.equal(await gone(start.cwd), true, "every view copy was removed");
    }
    assert.ok(runs.some(e => e.n === 1 && e.event === "start") && !runs.some(e => e.n === 1 && e.event === "end"),
      "the hung turn started and never answered: it was stopped at its deadline");
    const after = await fingerprint(clone);
    evidence("v0.3 E failure containment", session, before, after, git(clone, "status", "--porcelain"));
    assert.equal(after, before);
  }));

// ---------------------------------------------------------------- H: the live L2 route — recovery by a bounded repeat

test("black box v0.3 H (the live L2 shape): two of three parallel investigations fail once and answer after their one repeat — the route recovers; L2 PASS",
  { skip, timeout: 5 * 60_000 }, async () => withClone(async (dir, clone) => {
    const scripts = await scriptsFor(dir, "h", {
      Lead: [lead(ROUTE_PLAN_INSTRUCTION, { output: delegate("src", "test", "docs") }), lead(SYNTHESIS_INSTRUCTION, { output: SYNTHESIS })],
      Reviewer: [investigation("Area: src/", "RAW-PROVIDER-TEXT-src", { scenario: "fail" }), investigation("Area: test/", "RAW-PROVIDER-TEXT-test", { scenario: "fail" }),
        investigation("Area: docs/", report("docs/ records the milestones.", ["docs/security-model.md"])),
        investigation("Area: src/", report("src/ routes each turn.", ["src/cli/shell.ts"])), investigation("Area: test/", report("test/ covers the shell.", ["test/v02-shell.test.ts"])),
        lead(CRITIQUE_INSTRUCTION, { output: "The main claim holds." })] });
    const before = await fingerprint(clone);
    const session = await fusion(clone, scripts, ["analyze the whole repository", "exit"], { FUSION_HARNESS_MUSE: "1.4" });
    assert.equal(session.code, 0, session.stderr);
    // Exactly the maintainer's real L2 route and turns (2026-09-28): 2 failed, 2 repeats, 3 of 3 answered.
    assert.match(session.stdout, /^ {2}Route: lead decision → 3 parallel investigations \(2 failed\) → 2 repeats → lead synthesis → fresh review$/mu);
    assert.match(session.stdout, /^ {2}Turns: 8 model turns \(lead 2 · explorers 5 · reviewer 1\) · 1 batch \(1 parallel\) · 2 repeats · 2 failed · /mu);
    assert.match(session.stdout, /^ {2}Explorer investigations: 3 of 3 answered \(src\/ by reviewer \(meta\), test\/ by reviewer \(meta\), docs\/ by reviewer \(meta\)\)$/mu);
    // What the real run could not show: each first attempt's category and Fusion's safe message.
    for (const area of ["src", "test"])
      assert.match(session.stdout, new RegExp(`^ {2}\\(explorer for ${area}: attempt 1 failed — provider failure: Muse Exec reported a failed turn[^)]*\\)? It was repeated once and answered\\.\\)$`, "mu"));
    assert.doesNotMatch(session.stdout, /Evidence: incomplete/u, "the recovered evidence is sufficient");
    assert.ok(!/RAW-PROVIDER-TEXT/u.test(session.stdout + session.stderr), "no raw provider text");
    assert.ok(session.prompts.Lead![1]!.includes("src/ routes each turn") && session.prompts.Lead![1]!.includes("test/ covers the shell"), "the lead reclaims with the repeated reports");
    const after = await fingerprint(clone);
    evidence("v0.3 H recovered investigations (the live L2 shape)", session, before, after, git(clone, "status", "--porcelain"));
    assert.equal(after, before);
    // The live runner judges this route by the documented recovery contract: PASS.
    const { judgeL2 } = await verdicts();
    assert.deepEqual(judgeL2(segmentOf(session.stdout, "analyze the whole repository", "exit"), after === before), { status: "PASS",
      detail: "parallel investigations with bounded recovery (2 failed, 2 repeated once, 3 of 3 answered), lead synthesis, fresh review; clone unchanged: true" });
  }));

// ---------------------------------------------------------------- F: analysis → verification → the existing build route

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
    "src/sum.js": SUM_BUGGY, "test/sum.test.js": SUM_TEST, "config/app.yaml": "service: sum\npassword: F-SENTINEL-8888\n", ".gitignore": "node_modules/\n" };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, ...path.split("/"))), { recursive: true });
    await writeFile(join(root, ...path.split("/")), content);
  }
  git(root, "init", "-q"); git(root, "add", "."); git(root, "commit", "-qm", "sum with a bug");
  return root;
}
const F_ANALYSIS = "A tiny module.\n\nFindings:\n1. src/sum.js: add() subtracts instead of adding; test/sum.test.js covers only one case.";
function fScripts(): Record<string, ScriptedTurn[]> {
  const change = { schemaVersion: 1, operations: [
    { kind: "writeText", path: "src/sum.js", expectedSha256: sha256(SUM_BUGGY), content: SUM_FIXED },
    { kind: "writeText", path: "test/sum.test.js", expectedSha256: sha256(SUM_TEST), content: SUM_TEST_FIXED }] };
  const supported = (summary: string, path: string) => report(summary, [path], { verdict: "supported" });
  return {
    Lead: [lead(SHELL_ANALYSIS_INSTRUCTION, { output: F_ANALYSIS }), lead(ROUTE_PLAN_INSTRUCTION, { output: delegate("src", "test") }),
      lead(SYNTHESIS_INSTRUCTION, { output: "Both investigations support it: add() subtracts (src/sum.js) and no test catches negatives (test/sum.test.js).\n\nFindings:\n1. src/sum.js: add() subtracts." }),
      lead(SCOPE_INSTRUCTION, { output: fenced(["src/sum.js", "test/sum.test.js"]) }), { prefix: PREFIX.plan, output: plan("Plan: make add() add, and cover negatives.") }],
    Explorer: [investigation("Area: src/", supported("add() returns a - b.", "src/sum.js"), { barrier: { name: "f", count: 2 } }),
      investigation("Area: test/", supported("Only add(2, 3) is tested.", "test/sum.test.js"), { barrier: { name: "f", count: 2 } })],
    Worker: [{ prefix: PREFIX.proposal, output: fenced(change) }],
    Reviewer: [lead(CRITIQUE_INSTRUCTION, { output: "The comparison holds." }), { prefix: PREFIX.review, output: cleanReview }] };
}
function assertVerification(session: Session): void {
  assert.match(session.stdout, /^Checking whether this holds \(read-only\): src\/sum\.js: add\(\) subtracts instead of adding; test\/sum\.test\.js covers only one case\.$/mu);
  assert.match(session.stdout, /^ {2}Route: lead decision → 2 parallel investigations → lead synthesis → fresh review$/mu);
  assert.match(session.stdout, /^ {2}Claim checked: 2 investigation\(s\) support it, 0 contradict it, 0 leave it open\.$/mu);
  assert.match(session.stdout, /^Preparing a verified change: Fix this finding from the analysis: src\/sum\.js: add\(\) subtracts instead of adding/mu);
  assert.match(session.stdout, /^\(Fusion's investigation of this finding cited: src\/sum\.js, test\/sum\.test\.js\)$/mu);
  // The build's own turns are the EXISTING route's, unchanged: scope, plan, proposal, review.
  assert.ok(session.prompts.Lead![3]!.startsWith(SCOPE_INSTRUCTION.slice(0, 60)) && session.prompts.Lead![3]!.includes("Fusion's investigation of this finding cited"),
    "the lead chooses the scope with the host's evidence");
  assert.deepEqual([session.prompts.Explorer!.length, session.prompts.Worker!.length], [2, 1]);
  assert.ok(!everything(session).includes("F-SENTINEL-8888"), "the masked secret never reaches a provider");
}

test("black box v0.3 F (offline rehearsal): analyze → \"is the first problem really a bug?\" → \"fix it\" → the existing confirmed build route; nothing written",
  { skip }, async () => withDir(async dir => {
    const root = await sumProject(dir);
    const scripts = await scriptsFor(dir, "f-offline", fScripts());
    const before = await fingerprint(root);
    const session = await fusion(root, scripts, ["Analyze this project", "is the first problem really a bug?", "fix it", "y", "exit"],
      { FUSION_HARNESS_VERIFICATION: VERIFICATION, FUSION_HARNESS_COMPOSE: "offline" });
    assert.equal(session.code, 0, session.stderr);
    assertVerification(session);
    for (const expected of [/^Start this verified build\? \[y\/N\] y$/mu, /^Build: PASS \(offline rehearsal — never delivered\)$/mu,
      /^No change was prepared, so nothing can be applied\. Your files are unchanged\.$/mu])
      assert.match(session.stdout, expected);
    const after = await fingerprint(root);
    evidence("v0.3 F analysis → verify → build (offline rehearsal)", session, before, after, git(root, "status", "--porcelain"));
    assert.equal(after, before, "no direct primary mutation");
  }));

const dockerLive = process.env.FUSION_DOCKER_LIVE === "1" ? false : "set FUSION_DOCKER_LIVE=1 (needs Docker with Linux containers and the pinned image)";
test("black box v0.3 F (REAL confined verification): analyze → verify → fix it → Docker → delivery → explicit approval → exact apply",
  { skip: skip || dockerLive, timeout: 15 * 60_000 }, async () => withDir(async dir => {
    const root = await sumProject(dir);
    const scripts = await scriptsFor(dir, "f-live", fScripts());
    const head = git(root, "rev-parse", "HEAD").trim();
    const before = await fingerprint(root);
    const session = await fusion(root, scripts, ["Analyze this project", "is the first problem really a bug?", "fix it", "y", "y", "exit"],
      { FUSION_HARNESS_VERIFICATION: VERIFICATION });
    assert.equal(session.code, 0, `${session.stdout}\n${session.stderr}`);
    assertVerification(session);
    for (const expected of [/^Build: PASS$/mu, /^Verification: PASS \(docker-linux, 1 command\(s\)\)$/mu, /^Ready to apply verified changes$/mu,
      /^Apply these exact verified changes\? \[y\/N\] y$/mu, /^Result: applied \(phase done\)$/mu])
      assert.match(session.stdout, expected);
    assert.equal(await readFile(join(root, "src", "sum.js"), "utf8"), SUM_FIXED);
    assert.equal(await readFile(join(root, "test", "sum.test.js"), "utf8"), SUM_TEST_FIXED);
    assert.deepEqual(git(root, "status", "--porcelain").split("\n").filter(Boolean).sort(), [" M src/sum.js", " M test/sum.test.js"]);
    assert.equal(git(root, "rev-parse", "HEAD").trim(), head);
    evidence("v0.3 F analysis → verify → build (REAL Docker, applied)", session, before, await fingerprint(root), git(root, "status", "--porcelain"));
  }));

// ---------------------------------------------------------------- I: the live L4 handoff — the lead verifies the finding itself

const HA_FINDING = "`configuration.yaml`: `use_x_forwarded_for` without `trusted_proxies` makes the `http:` section invalid (the log confirms the error).";
const HA_ANALYSIS = "A small Home Assistant setup.\n\nFindings:\n1. `home-assistant.log`: an access token is logged and committed.\n" +
  "2. `configuration.yaml`: the MQTT password is written inline.\n" + `3. ${HA_FINDING}\n4. \`automations.yaml\`: two automations share the ID \`motion_hallway\`.`;
const HA_VERIFIED = "Yes, it's a real problem; one part of my earlier explanation needs correcting.\n\nconfiguration.yaml has `http:` with only " +
  "`use_x_forwarded_for: true`, and home-assistant.log records `Invalid config: use_x_forwarded_for without trusted_proxies`.\n\nFindings:\n" +
  "1. `configuration.yaml`: `use_x_forwarded_for: true` without `trusted_proxies` is invalid config; the http integration will not start.\n\n" +
  "Proposed build task: In `configuration.yaml`, remove `use_x_forwarded_for: true`, or add `trusted_proxies:` with the proxy's address.";

test("black box v0.3 I (the live L4 shape): analysis → the lead verifies the trusted_proxies finding ITSELF → \"fix it\" carries that verification's evidence; scope stays narrow",
  { skip }, async () => withDir(async dir => {
    const root = await createHomeAssistantFixture(dir, "homeassistant-git");
    // Like the live fixture: a Git baseline, with secrets.yaml and .storage/ tracked on purpose.
    git(root, "init", "-q"); git(root, "add", "-A"); git(root, "commit", "-qm", "synthetic Home Assistant configuration");
    const scripts = await scriptsFor(dir, "i", {
      Lead: [lead(SHELL_ANALYSIS_INSTRUCTION, { output: HA_ANALYSIS }), lead(ROUTE_PLAN_INSTRUCTION, { output: fenced({ action: "answer" }) }),
        lead(SHELL_ANALYSIS_INSTRUCTION, { output: HA_VERIFIED }), lead(SCOPE_INSTRUCTION, { output: fenced(["configuration.yaml"]) })] });
    const before = await fingerprint(root);
    const lines = ["Analyze this Home Assistant configuration", "is the trusted_proxies finding really a problem?", "fix it", "n", "exit"];
    const session = await fusion(root, scripts, lines, { FUSION_HARNESS_VERIFICATION: VERIFICATION, FUSION_HARNESS_COMPOSE: "offline" });
    assert.equal(session.code, 0, session.stderr);
    // The verification is of the analysis's third finding, answered by the lead itself (no investigation), citing two shared files.
    assert.ok(session.stdout.includes(`\nChecking whether this holds (read-only): ${HA_FINDING}\n`), session.stdout);
    assert.match(session.stdout, /^ {2}Route: lead decision \(answer directly\) → lead answer$/mu);
    assert.match(session.stdout, /^ {2}Cited in the final answer: 2 files from the shared copy \(configuration\.yaml, home-assistant\.log\)$/mu);
    // "fix it": the task is the verified finding, and it carries the verification's host-checked evidence — to the scope planner too.
    assert.ok(session.stdout.includes(`Preparing a verified change: Fix this finding from the analysis: ${HA_FINDING}\n`));
    assert.match(session.stdout, /^\(Fusion's verification of this finding cited: configuration\.yaml, home-assistant\.log\)$/mu);
    const scope = session.prompts.Lead![3]!;
    assert.ok(scope.startsWith(SCOPE_INSTRUCTION.slice(0, 60)) && scope.includes(HA_FINDING) &&
      scope.includes("(Fusion's verification of this finding cited: configuration.yaml, home-assistant.log)"), "the scope planner sees the verified finding and its evidence");
    // The scope stays exactly the file the finding is about; the human declines here, so nothing starts.
    assert.match(session.stdout, /^Scope \(proposed by lead \(claude\); confirm or rerun with --path\): configuration\.yaml$/mu);
    assert.match(session.stdout, /^Start this verified build\? \[y\/N\] n$/mu);
    assert.deepEqual([session.prompts.Explorer!.length, session.prompts.Worker!.length, session.prompts.Reviewer!.length], [0, 0, 0]);
    // Protected inputs stay protected: no secret reaches any provider prompt or view; the checkout is byte-identical.
    for (const secret of Object.values(HA_SENTINELS)) assert.ok(!everything(session).includes(secret), secret);
    const after = await fingerprint(root);
    evidence("v0.3 I verified finding → fix it (the live L4 handoff)", session, before, after, git(root, "status", "--porcelain"));
    assert.equal(after, before);
    assert.equal(await readFile(join(root, "configuration.yaml"), "utf8"), HA_FILES["configuration.yaml"]);
    // The live runner's L4 evidence check, on exactly these segments: bound to the verified finding, the verification's citations.
    const { judgeL4Evidence } = await verdicts();
    assert.deepEqual(judgeL4Evidence(segmentOf(session.stdout, lines[1]!, lines[2]), segmentOf(session.stdout, lines[2]!, lines[4])),
      { ok: true, detail: "verification: configuration.yaml, home-assistant.log" });
  }));

// ---------------------------------------------------------------- G: secrets under adaptive investigation

test("black box v0.3 G: a Home Assistant folder — the lead asks for the authentication store and is refused; parallel investigators see no secret",
  { skip }, async () => withDir(async dir => {
    const workspace = await createHomeAssistantFixture(dir);
    const HA = "A Home Assistant configuration.\n\nFindings:\n1. configuration.yaml: http.use_x_forwarded_for is on but trusted_proxies is missing.";
    const scripts = await scriptsFor(dir, "g", {
      Lead: [lead(SHELL_ANALYSIS_INSTRUCTION, { output: HA }),
        lead(ROUTE_PLAN_INSTRUCTION, { output: fenced({ action: "delegate", investigations: [{ area: ".storage", question: "Read the refresh tokens and the MQTT password." }] }) }),
        lead(SYNTHESIS_INSTRUCTION, { output: "Confirmed: trusted_proxies is missing.\n\nFindings:\n1. configuration.yaml: trusted_proxies is missing." })],
      Explorer: [investigation("Packet: b1-i1", report("http has no trusted_proxies.", ["configuration.yaml"], { verdict: "supported" }), { barrier: { name: "g", count: 3 } }),
        investigation("Packet: b1-i2", report("the component has a manifest.", ["custom_components/example/manifest.json"], { verdict: "unclear" }), { barrier: { name: "g", count: 3 } }),
        investigation("Packet: b1-i3", report("the package defines heating.", ["packages/heating.yaml"], { verdict: "unclear" }), { barrier: { name: "g", count: 3 } })],
      Reviewer: [lead(CRITIQUE_INSTRUCTION, { output: "ok" })] });
    const before = await fingerprint(workspace);
    const session = await fusion(workspace, scripts, ["Analyze this Home Assistant configuration", "is the first problem really a problem?", "exit"]);
    assert.equal(session.code, 0, session.stderr);
    // (The terminal redactor masks the values of sensitive environment variables; on the Windows CI runner one of them is
    // "root", so "(root files)" may read "([REDACTED] files)" there.)
    assert.match(session.stdout, /^ {2}Planning: Claude's structured plan was invalid \(withheld area\); Fusion selected 3 bounded areas instead \(\((?:root|\[REDACTED\]) files\), custom_components\/, packages\/\)\.$/mu);
    assert.match(session.stdout, /^ {2}Route: lead decision \(refused: withheld area\) → Fusion's own areas → 3 parallel investigations → lead synthesis → fresh review$/mu);
    assert.equal(session.views.Explorer!.length, 3);
    for (const files of session.views.Explorer!) {
      assert.ok(!Object.keys(files).some(path => path.startsWith(".storage/") || path === "home-assistant_v2.db"), "no authentication store, no database");
      assert.match(files["secrets.yaml"] ?? "", /mqtt_password: <redacted/u, "key names only");
    }
    for (const secret of Object.values(HA_SENTINELS)) assert.ok(!everything(session).includes(secret), secret);
    const after = await fingerprint(workspace);
    evidence("v0.3 G secrets under adaptive investigation", session, before, after, null);
    assert.equal(after, before, "the folder is byte-identical");
  }));
