import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { SCOPE_INSTRUCTION } from "../src/app/build-scope.js";
import { CHAT_INSTRUCTION } from "../src/app/conversation.js";
import { SHELL_ANALYSIS_INSTRUCTION } from "../src/app/exploration.js";
import { DIAGNOSIS_INSTRUCTION, FALSIFIER_INSTRUCTION, HYPOTHESIS_INSTRUCTION } from "../src/app/orchestration/claim-check.js";
import { createHomeAssistantFixture, HA_FILES, HA_SENTINELS } from "./fixtures/home-assistant.js";
import { adjudication, cleanReview, fenced, plan, PREFIX, type ScriptedTurn } from "./fixtures/route-harness.js";
import { gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * v0.4 — BLACK-BOX ACCEPTANCE of the reliability engine, driven as a user drives Fusion: the product harness
 * (`test/fixtures/fusion-shell-harness.ts`: `main.js`'s wiring, the REAL Claude and Muse adapters on scripted FAKE provider
 * binaries) runs as a separate process; only what is observable outside counts — the terminal, the exit code, the workspace's
 * bytes and what each fake provider PROCESS received.
 *
 *   A  SIMPLE SUCCESS       a simple question stays one lead turn: no snapshot, no hypotheses, no falsifier, no committee
 *   B  HARD DEBUG           two independent hypotheses (proven concurrent, isolated) → Fusion's checks distinguish them → one
 *                           diagnosis survives
 *   C  FALSE CONSENSUS      two investigators agree on a wrong claim → Fusion's check contradicts it → Fusion refuses it
 *   D  FALSIFIER CATCH      the candidate passes its checks → the falsifier finds a real missing condition → confirmed → one
 *                           correction → re-falsified clean → VERIFIED (never delivered offline)
 *   E  UNVERIFIABLE         a security-sensitive fix Fusion cannot reproduce → explicit UNVERIFIED → no delivery, no false success
 *   F  VERIFIED MUTATION    analysis → claim check → "fix it" with the check's evidence → baseline reproduction → fix → proof
 *                           obligations → VERIFIED (offline: never delivered; with FUSION_DOCKER_LIVE=1: delivery, approval, apply)
 *   G  THE LIVE L2–L4 LINES the live runner types, on the synthetic Home Assistant fixture: they reach the claim-check route
 *                           and the live verdicts PASS on what the product printed
 */
const skip = gitAvailable ? false : "git executable unavailable";
const HARNESS = resolve(process.cwd(), "dist/test/fixtures/fusion-shell-harness.js");
const ROLES = ["Lead", "Worker", "Explorer", "Reviewer"] as const;
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", ["-c", "user.name=Fusion Test", "-c", "user.email=fusion@example.invalid", "-c", "commit.gpgsign=false",
    "-c", "init.defaultBranch=main", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
};
interface Session { code: number | null; stdout: string; stderr: string; prompts: Record<string, string[]>; views: Record<string, Array<Record<string, string>>> }
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
  return sha256(out.sort().join("\n") + git(root, "status", "--porcelain=v1", "-uall"));
}
const everything = (session: Session): string => [session.stdout, session.stderr, ...Object.values(session.prompts).flat(),
  ...Object.values(session.views).flat().flatMap(files => Object.entries(files).flat())].join("\n");
async function withDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "v04-accept-")));
  try { return await work(dir); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}
function evidence(scenario: string, session: Session, unchanged: boolean): void {
  const turns = Object.fromEntries(Object.entries(session.prompts).filter(([, prompts]) => prompts.length > 0).map(([role, prompts]) => [role, prompts.length]));
  const route = [...session.stdout.matchAll(/^ {2}Route: (.+)$/gmu)].at(-1)?.[1] ?? null;
  const decision = (/^Decision: (.+)$/mu.exec(session.stdout) ?? /^ {2}(?:Claim|Diagnosis): (.+)$/mu.exec(session.stdout))?.[1] ?? null;
  console.log(`ACCEPTANCE ${JSON.stringify({ scenario, exitCode: session.code, unchanged, turns, route, decision })}`);
}
/** The live acceptance runner's verdicts (scripts/v04-live-verdicts.mjs), applied to what this black box printed. */
type Verdict = { status: string; detail: string; lines: string[] };
type Verdicts = { judgeL1(segment: string): Verdict; judgeL2(segment: string, unchanged: boolean): Verdict;
  judgeL3(claim: string, segments: readonly string[], unchanged: boolean): Verdict & { falseConsensus: boolean }; judgeL4(segments: readonly string[]): Verdict;
  judgeL5(segments: readonly string[], fixtureOk: boolean): Verdict };
const verdicts = async (): Promise<Verdicts> => await import(pathToFileURL(resolve(process.cwd(), "scripts", "v04-live-verdicts.mjs")).href) as Verdicts;
/** The part of the terminal a typed line produced (up to the next typed line). */
const segmentOf = (stdout: string, line: string, next?: string): string => {
  const start = stdout.indexOf(`> ${line}
`);
  assert.ok(start >= 0, `the line was typed: ${line}`);
  const end = next === undefined ? -1 : stdout.indexOf(`> ${next}
`, start);
  return stdout.slice(start, end < 0 ? undefined : end);
};
const lead = (prefix: string, output: string): ScriptedTurn => ({ prefix: prefix.slice(0, 60), output });
const hypothesis = (id: string, output: Record<string, unknown>, barrier?: string): ScriptedTurn => ({ prefix: HYPOTHESIS_INSTRUCTION.verify.slice(0, 60),
  when: `Investigator: ${id} `, output: JSON.stringify({ hypothesis: "h", summary: "s", evidence: [], checks: [], alternatives: [], ...output }),
  ...(barrier === undefined ? {} : { barrier: { name: barrier, count: 2 } }) });
const falsifier = (output: Record<string, unknown> = {}): ScriptedTurn => ({ prefix: FALSIFIER_INSTRUCTION.slice(0, 60),
  output: JSON.stringify({ verdict: "holds", counterexamples: [], missingEvidence: [], checks: [], ...output }) });

// ---------------------------------------------------------------- the project: add() subtracts

const SUM_BUGGY = "export function add(a, b) {\n  return a - b;\n}\n";
const SUM_FIXED = "export function add(a, b) {\n  return a + b;\n}\n";
const SUM_TEST = "import assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\nimport { add } from \"../src/sum.js\";\n\n" +
  "test(\"adds\", () => {\n  assert.equal(add(2, 3), 5);\n});\n";
const SUM_TEST_FIXED = `${SUM_TEST}\ntest("adds negatives", () => {\n  assert.equal(add(-2, -3), -5);\n});\n`;
const SENTINEL = "V04BB-SENTINEL-4242";
const VERIFICATION = JSON.stringify({ commands: [], platformRequirement: "linux-compatible", dependencies: "none",
  confinedCommands: [{ id: "unit", executable: "/usr/local/bin/node", args: ["--test", "test/sum.test.js"], cwd: ".", timeoutMs: 180_000, mutationPolicy: "readOnly" }] });
/** The offline oracle: the confined check passes only while src/sum.js adds — Fusion can reproduce the defect on the baseline. */
const ADDS = JSON.stringify({ file: "src/sum.js", contains: "return a + b;" });
async function sumProject(dir: string): Promise<string> {
  const root = join(dir, "sum");
  const files: Record<string, string> = { "package.json": JSON.stringify({ name: "sum", type: "module", scripts: { test: "node --test" } }),
    "src/sum.js": SUM_BUGGY, "test/sum.test.js": SUM_TEST, "config/app.yaml": `service: sum\npassword: ${SENTINEL}\n`, ".gitignore": "node_modules/\n" };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, ...path.split("/"))), { recursive: true });
    await writeFile(join(root, ...path.split("/")), content);
  }
  git(root, "init", "-q"); git(root, "add", "."); git(root, "commit", "-qm", "sum with a bug");
  return root;
}
const change = (files: ReadonlyArray<readonly [string, string | null, string]>) => fenced({ schemaVersion: 1, operations: files.map(([path, before, after]) =>
  ({ kind: "writeText", path, expectedSha256: before === null ? null : sha256(before), content: after })) });
/** A falsification finding in the exec provider's strict wire form (every optional property present as null). */
const missingCondition = JSON.stringify({ findings: [{ id: "F1", severity: "HIGH", confidence: "HIGH", category: "tests", file: "test/sum.test.js", lines: null,
  title: "Negative numbers are never checked", evidence: ["Only add(2, 3) is tested; the fix could still break for negatives."],
  failureScenario: "add(-2, -3) regresses and nothing fails.", suggestedFix: "Add a test for negative numbers.", facts: null }], summary: "Broken for negatives." });

// ---------------------------------------------------------------- A: simple success

test("black box v0.4 A (SIMPLE SUCCESS): a simple question is one lead turn — no snapshot, no hypotheses, no falsifier, no committee",
  { skip, timeout: 5 * 60_000 }, async () => withDir(async dir => {
    const root = await sumProject(dir);
    const scripts = await scriptsFor(dir, "a", { Lead: [lead(CHAT_INSTRUCTION, "It names the package and makes it an ES module.")] });
    const before = await fingerprint(root);
    const session = await fusion(root, scripts, ["what does package.json do?", "exit"]);
    assert.equal(session.code, 0, session.stderr);
    assert.match(session.stdout, /^ {2}Route: lead only · 1 model turn · /mu);
    assert.doesNotMatch(session.stdout, /Evidence snapshot|Independent hypotheses|Fresh falsification|Explorer investigations/u);
    assert.deepEqual(ROLES.map(role => session.prompts[role]!.length), [1, 0, 0, 0]);
    const unchanged = await fingerprint(root) === before;
    evidence("v0.4 A simple success", session, unchanged);
    assert.ok(unchanged);
    assert.equal((await verdicts()).judgeL1(segmentOf(session.stdout, "what does package.json do?", "exit")).status, "PASS", "the live L1 verdict");
  }));

// ---------------------------------------------------------------- B: hard debug

test("black box v0.4 B (HARD DEBUG): two isolated hypotheses run AT THE SAME TIME on one snapshot; Fusion's checks leave one diagnosis",
  { skip, timeout: 5 * 60_000 }, async () => withDir(async dir => {
    const root = await sumProject(dir);
    const scripts = await scriptsFor(dir, "b", {
      Explorer: [hypothesis("h1", { hypothesis: "HYP-ONE add() subtracts its arguments", evidence: [{ claim: "return a - b", paths: ["src/sum.js"] }],
        checks: [{ file: "src/sum.js", text: "return a - b;", expect: "present" }] }, "b"),
      hypothesis("h2", { hypothesis: "HYP-TWO the test expects the wrong sum", evidence: [{ claim: "the assertion", paths: ["test/sum.test.js"] }],
        checks: [{ file: "test/sum.test.js", text: "assert.equal(add(2, 3), -1)", expect: "present" }] }, "b")],
      Reviewer: [falsifier()],
      Lead: [lead(DIAGNOSIS_INSTRUCTION, "add() subtracts; the test is right.\n\nFindings:\n1. src/sum.js: add() subtracts instead of adding.")] });
    const before = await fingerprint(root);
    const session = await fusion(root, scripts, ["why does add() return the wrong result?", "exit"]);
    assert.equal(session.code, 0, session.stderr);
    assert.match(session.stdout, /^Diagnosing \(read-only\): why does add\(\) return the wrong result\?$/mu);
    assert.match(session.stdout, /^ {2}Route: evidence snapshot → 2 independent hypotheses → 2 Fusion checks \(1 contradicted a prediction\) → fresh falsification \(could not break it\) → lead diagnosis$/mu);
    // Isolation, observed at the provider processes: the same snapshot, neither conclusion in the other's prompt.
    const [p1, p2] = session.prompts.Explorer!;
    const snapshot = (prompt: string) => prompt.slice(prompt.indexOf("Evidence snapshot (Fusion's own facts"), prompt.indexOf("Investigator: h"));
    assert.equal(snapshot(p1!), snapshot(p2!));
    assert.ok(![p1!, p2!].some(p => p.includes("HYP-ONE") || p.includes("HYP-TWO")), "no investigator sees a conclusion");
    assert.doesNotMatch(session.prompts.Reviewer![0]!, /HYP-TWO|the test is right/u, "the falsifier sees Fusion's facts only");
    assert.match(session.stdout, /^ {4}k2 test\/sum\.test\.js contains "assert\.equal\(add\(2, 3\), -1\)" \.\.\. NO → CONTRADICTS hypothesis h2 \(proposed by h2\)$/mu);
    assert.match(session.stdout, /^ {2}Diagnosis: h1 SUPPORTED by Fusion's checks — HYP-ONE add\(\) subtracts its arguments; h2 CONTRADICTED$/mu);
    assert.ok(!everything(session).includes(SENTINEL), "the masked secret never reaches a provider");
    const unchanged = await fingerprint(root) === before;
    evidence("v0.4 B hard debug", session, unchanged);
    assert.ok(unchanged);
    // The live L2 and L4 verdicts, applied to exactly what the product printed.
    const { judgeL2, judgeL4 } = await verdicts(), segment = segmentOf(session.stdout, "why does add() return the wrong result?", "exit");
    assert.equal(judgeL2(segment, unchanged).status, "PASS", judgeL2(segment, unchanged).detail);
    assert.equal(judgeL2(segment, false).status, "FAIL");
    assert.deepEqual([judgeL4([segment]).status, judgeL4([segment]).detail], ["PASS", "a fresh falsification ran in 1 claim check(s) and was adjudicated"]);
  }));

// ---------------------------------------------------------------- C: false consensus

test("black box v0.4 C (FALSE CONSENSUS): both investigators agree on a wrong claim — Fusion's own check contradicts it; never VERIFIED",
  { skip, timeout: 5 * 60_000 }, async () => withDir(async dir => {
    const root = await sumProject(dir);
    const scripts = await scriptsFor(dir, "c", {
      Explorer: [hypothesis("h1", { verdict: "supported", hypothesis: "add() adds" }), hypothesis("h2", { verdict: "supported", hypothesis: "the code is fine" })],
      Lead: [lead(DIAGNOSIS_INSTRUCTION, "Yes, src/sum.js adds its arguments.")] });
    const session = await fusion(root, scripts, ["is it true that src/sum.js already returns `a + b`?", "exit"]);
    assert.equal(session.code, 0, session.stderr);
    assert.match(session.stdout, /^ {4}k1 src\/sum\.js contains "a \+ b" \.\.\. NO → CONTRADICTS the claim \(proposed by fusion\)$/mu);
    assert.match(session.stdout, /^ {2}Claim: CONTRADICTED — Fusion's own checks contradict it \(1\); Fusion does not accept it, whatever the models concluded \(investigators: 2 support, 0 contradict\)$/mu);
    assert.match(session.stdout, /→ no falsification \(already contradicted by Fusion's checks\) → lead diagnosis$/mu);
    assert.doesNotMatch(session.stdout, /Claim: SUPPORTED|Decision: VERIFIED/u);
    evidence("v0.4 C false consensus", session, true);
    const segment = segmentOf(session.stdout, "is it true that src/sum.js already returns `a + b`?", "exit");
    const l3 = (await verdicts()).judgeL3(segment, [segment], true);
    assert.deepEqual([l3.status, l3.falseConsensus, l3.detail], ["PASS", true,
      "1 model conclusion(s) refused because Fusion's own checks contradicted them: a claim 2 investigator(s) supported (a false consensus Fusion refused)"]);
  }));

// ---------------------------------------------------------------- D: the falsifier catches a missing condition

test("black box v0.4 D (FALSIFIER CATCH): checks pass, the falsifier finds a real missing condition → one correction → re-falsified clean → VERIFIED",
  { skip, timeout: 5 * 60_000 }, async () => withDir(async dir => {
    const root = await sumProject(dir);
    const scripts = await scriptsFor(dir, "d", {
      Lead: [lead(SCOPE_INSTRUCTION, fenced(["src/sum.js", "test/sum.test.js"])), { prefix: PREFIX.plan, output: plan("Plan: make add() add; cover negatives.") },
        { prefix: PREFIX.adjudication, output: adjudication(["r1-F1", "CONFIRMED", "fix"]) }],
      Worker: [{ prefix: PREFIX.proposal, output: change([["src/sum.js", SUM_BUGGY, SUM_FIXED]]) },
        { prefix: PREFIX.proposal, output: change([["src/sum.js", SUM_BUGGY, SUM_FIXED], ["test/sum.test.js", SUM_TEST, SUM_TEST_FIXED]]) }],
      Reviewer: [{ prefix: PREFIX.review, output: missingCondition }, { prefix: PREFIX.review, output: cleanReview }] });
    const before = await fingerprint(root);
    const session = await fusion(root, scripts, ["fix src/sum.js so add() adds, and cover it in test/sum.test.js", "y", "exit"],
      { FUSION_HARNESS_VERIFICATION: VERIFICATION, FUSION_HARNESS_COMPOSE: "offline", FUSION_HARNESS_ORACLE: ADDS });
    assert.equal(session.code, 0, session.stderr);
    // The falsifier's objective reached the real Muse adapter's prompt, with Fusion's baseline facts and no worker text.
    const falsification = session.prompts.Reviewer![0]!;
    assert.match(falsification, /Objective: FALSIFICATION\. Do not approve the change\. Try to BREAK the conclusion/u);
    assert.match(falsification, /Fusion's checks on the unchanged baseline \(Fusion data\): failed before the change: unit\./u);
    assert.equal(session.prompts.Reviewer!.length, 2, "one falsification, one re-falsification after the one correction");
    assert.equal(session.prompts.Worker!.length, 2);
    for (const expected of [/^review cycle 1: 1 finding\(s\), outcome correction$/mu, /^review cycle 2: 0 finding\(s\), outcome clean$/mu,
      /^ {2}reproduced defect \.+ PASS +check unit fails on the unchanged baseline$/mu, /^ {2}fresh falsification \.+ NO BLOCKER /mu,
      /^Decision: VERIFIED \(7 of 7 obligations\)$/mu, /^Build: PASS \(offline rehearsal — never delivered\)$/mu])
      assert.match(session.stdout, expected);
    const unchanged = await fingerprint(root) === before;
    evidence("v0.4 D falsifier catch (offline rehearsal)", session, unchanged);
    assert.ok(unchanged, "an offline rehearsal writes nothing");
  }));

// ---------------------------------------------------------------- E: unverifiable

test("black box v0.4 E (UNVERIFIABLE): a security-sensitive fix Fusion cannot reproduce is UNVERIFIED — no delivery, no false success",
  { skip, timeout: 5 * 60_000 }, async () => withDir(async dir => {
    const root = await sumProject(dir);
    const scripts = await scriptsFor(dir, "e", {
      Lead: [lead(SCOPE_INSTRUCTION, fenced(["src/auth/session.js"])), { prefix: PREFIX.plan, output: plan("Plan: compare the expiry with now.") }],
      Worker: [{ prefix: PREFIX.proposal, output: change([["src/auth/session.js", null, "export const expired = (at, now) => now > at;\n"]]) }],
      Reviewer: [{ prefix: PREFIX.review, output: cleanReview }] });
    const before = await fingerprint(root);
    const session = await fusion(root, scripts, ["fix the session expiry check in src/auth/session.js", "y", "exit"],
      { FUSION_HARNESS_VERIFICATION: VERIFICATION, FUSION_HARNESS_COMPOSE: "offline" });
    assert.equal(session.code, 0, session.stderr);
    for (const expected of [/^ {2}reproduced defect \.+ NOT REPRODUCED +every configured check passes on the unchanged baseline/mu,
      /^Decision: UNVERIFIED — 3 obligation\(s\) not established; no delivery$/mu, /^state: DECISION_REQUIRED$/mu,
      /Fusion's evidence does not permit a delivery \(UNVERIFIED\)/u, /^No change was prepared, so nothing can be applied\. Your files are unchanged\.$/mu])
      assert.match(session.stdout, expected);
    assert.doesNotMatch(session.stdout, /^Build: PASS|Decision: VERIFIED|Ready to apply/mu);
    const unchanged = await fingerprint(root) === before;
    evidence("v0.4 E unverifiable", session, unchanged);
    assert.ok(unchanged);
  }));

// ---------------------------------------------------------------- F: a verified mutation

const F_LINES = ["Analyze this project", "is the first problem really a bug?", "fix it", "exit"] as const;
const F_ANALYSIS = "A tiny module.\n\nFindings:\n1. src/sum.js: add() subtracts instead of adding.";
function fScripts(): Record<string, ScriptedTurn[]> {
  return {
    Lead: [lead(SHELL_ANALYSIS_INSTRUCTION, F_ANALYSIS), lead(DIAGNOSIS_INSTRUCTION, "Confirmed by Fusion's check: src/sum.js returns a - b."),
      lead(SCOPE_INSTRUCTION, fenced(["src/sum.js"]))],
    Explorer: [hypothesis("h1", { verdict: "supported", hypothesis: "add() returns a - b", evidence: [{ claim: "return a - b", paths: ["src/sum.js"] }],
      checks: [{ file: "src/sum.js", text: "return a - b;", expect: "present" }] }, "f"),
    hypothesis("h2", { verdict: "supported", hypothesis: "the one test fails", evidence: [{ claim: "adds(2, 3)", paths: ["test/sum.test.js"] }] }, "f")],
    Reviewer: [falsifier()],
    Worker: [{ prefix: PREFIX.proposal, output: change([["src/sum.js", SUM_BUGGY, SUM_FIXED]]) }] };
}
function assertVerified(session: Session): void {
  for (const expected of [/^Checking whether this holds \(read-only\): src\/sum\.js: add\(\) subtracts instead of adding\.$/mu,
    /^ {2}Claim: SUPPORTED — Fusion's own checks support it \(1\) and none contradicts it \(investigators: 2 support, 0 contradict\)$/mu,
    /^Preparing a verified change: Fix this finding from the analysis: src\/sum\.js: add\(\) subtracts instead of adding\.$/mu,
    /^Scope \(proposed by lead \(claude\); confirm or rerun with --path\): src\/sum\.js$/mu,
    /^ {2}reproduced defect \.+ PASS +check unit fails on the unchanged baseline$/mu,
    /^ {2}defect resolved \.+ PASS +check unit failed before the change and passes after it$/mu,
    // (A CI runner whose environment holds the value "root" sees the word masked by Fusion's value-based redaction.)
    /^ {2}(?:root|\[REDACTED\]) cause \.+ SUPPORTED /mu, /^ {2}protected files \.+ UNCHANGED /mu, /^Decision: VERIFIED \(6 of 6 obligations\)$/mu])
    assert.match(session.stdout, expected);
  // The handoff: the task and the scope planner carry the check's evidence and Fusion's decision about the finding.
  assert.ok(session.prompts.Lead![2]!.includes("(Fusion's checks of this finding: SUPPORTED — 1 consistent, 0 contradicted)"), "the evidence travels with the task");
  assert.ok(!everything(session).includes(SENTINEL), "the masked secret never reaches a provider");
}

test("black box v0.4 F (VERIFIED MUTATION, offline rehearsal): analysis → check → fix it → reproduction → fix → obligations → VERIFIED; nothing written",
  { skip, timeout: 5 * 60_000 }, async () => withDir(async dir => {
    const root = await sumProject(dir);
    const scripts = await scriptsFor(dir, "f-offline", fScripts());
    const before = await fingerprint(root);
    const session = await fusion(root, scripts, [...F_LINES.slice(0, 3), "y", "exit"],
      { FUSION_HARNESS_VERIFICATION: VERIFICATION, FUSION_HARNESS_COMPOSE: "offline", FUSION_HARNESS_ORACLE: ADDS });
    assert.equal(session.code, 0, session.stderr);
    assertVerified(session);
    assert.match(session.stdout, /^Build: PASS \(offline rehearsal — never delivered\)$/mu);
    const unchanged = await fingerprint(root) === before;
    evidence("v0.4 F verified mutation (offline rehearsal)", session, unchanged);
    assert.ok(unchanged, "no direct primary mutation");
    // The live L5 verdict sees every part but the delivery: an offline rehearsal is never a PASS.
    const l5 = (await verdicts()).judgeL5(F_LINES.slice(0, 3).map((line, i) => segmentOf(session.stdout, line, F_LINES[i + 1])), false);
    assert.deepEqual([l5.status, l5.detail], ["FAIL", "checked=yes handoff=yes reproduced=yes resolved=yes verified=yes applied=NO fixture=NO"]);
  }));

const dockerLive = process.env.FUSION_DOCKER_LIVE === "1" ? false : "set FUSION_DOCKER_LIVE=1 (needs Docker with Linux containers and the pinned image)";
test("black box v0.4 F (VERIFIED MUTATION, REAL confined verification): … → VERIFIED → delivery → explicit approval → exact apply",
  { skip: skip || dockerLive, timeout: 15 * 60_000 }, async () => withDir(async dir => {
    const root = await sumProject(dir);
    const scripts = await scriptsFor(dir, "f-live", fScripts());
    const head = git(root, "rev-parse", "HEAD").trim();
    const session = await fusion(root, scripts, [...F_LINES.slice(0, 3), "y", "y", "exit"], { FUSION_HARNESS_VERIFICATION: VERIFICATION });
    assert.equal(session.code, 0, `${session.stdout}\n${session.stderr}`);
    assertVerified(session);
    for (const expected of [/^Build: PASS$/mu, /^ {2}Evidence decision: VERIFIED$/mu, /^Apply these exact verified changes\? \[y\/N\] y$/mu, /^Result: applied \(phase done\)$/mu])
      assert.match(session.stdout, expected);
    assert.equal(await readFile(join(root, "src", "sum.js"), "utf8"), SUM_FIXED);
    assert.deepEqual(git(root, "status", "--porcelain").split("\n").filter(Boolean), [" M src/sum.js"]);
    assert.equal(git(root, "rev-parse", "HEAD").trim(), head, "Fusion never commits");
    evidence("v0.4 F verified mutation (REAL Docker, applied)", session, false);
    const l5 = (await verdicts()).judgeL5(F_LINES.slice(0, 3).map((line, i) => segmentOf(session.stdout, line, F_LINES[i + 1])), true);
    assert.equal(l5.status, "PASS", l5.detail);
  }));

// ---------------------------------------------------------------- G: exactly the lines the live runner types for L2–L4

const G_LINES = ["why does Home Assistant reject requests from my reverse proxy?", "is it true that configuration.yaml already sets `trusted_proxies`?", "history", "exit"] as const;

test("black box v0.4 G (the live L2–L4 lines): a diagnosis and the user's false claim on the Home Assistant fixture — the live verdicts PASS; read-only",
  { skip, timeout: 5 * 60_000 }, async () => withDir(async dir => {
    const root = await createHomeAssistantFixture(dir, "homeassistant-git");
    git(root, "init", "-q"); git(root, "add", "-A"); git(root, "commit", "-qm", "synthetic Home Assistant configuration");
    // The maintainer's posture (FUSION_HARNESS_MUSE=1.4): the explorer binding is unproven, so the validated Reviewer binding
    // investigates — each hypothesis and the falsification in its own fresh session and view copy.
    const scripts = await scriptsFor(dir, "g", {
      Reviewer: [hypothesis("h1", { hypothesis: "use_x_forwarded_for without trusted_proxies", evidence: [{ claim: "http:", paths: ["configuration.yaml"] }],
        checks: [{ file: "configuration.yaml", text: "trusted_proxies", expect: "absent" }] }, "g1"),
      hypothesis("h2", { hypothesis: "the log names the invalid http config", evidence: [{ claim: "Invalid config", paths: ["home-assistant.log"] }],
        checks: [{ file: "home-assistant.log", text: "use_x_forwarded_for without trusted_proxies", expect: "present" }] }, "g1"),
      // The false claim: both investigators agree with it — a false consensus.
      hypothesis("h1", { verdict: "supported", hypothesis: "trusted_proxies is set" }, "g2"), hypothesis("h2", { verdict: "supported", hypothesis: "it is set" }, "g2"), falsifier()],
      Lead: [lead(DIAGNOSIS_INSTRUCTION, "The http integration refuses the config.\n\nFindings:\n1. `configuration.yaml`: use_x_forwarded_for without trusted_proxies."),
        lead(DIAGNOSIS_INSTRUCTION, "Yes, it is set.")] });
    const before = await fingerprint(root);
    const session = await fusion(root, scripts, G_LINES, { FUSION_HARNESS_MUSE: "1.4" });
    assert.equal(session.code, 0, session.stderr);
    assert.ok(session.stdout.includes("\nChecking whether this holds (read-only): configuration.yaml already sets `trusted_proxies`\n"), "the user's claim, as stated");
    assert.deepEqual([session.prompts.Explorer!.length, session.prompts.Reviewer!.length], [0, 5]);
    const unchanged = await fingerprint(root) === before;
    const { judgeL2, judgeL3, judgeL4 } = await verdicts();
    const diagnosis = segmentOf(session.stdout, G_LINES[0], G_LINES[1]), claim = segmentOf(session.stdout, G_LINES[1], G_LINES[2]);
    const l2 = judgeL2(diagnosis, unchanged), l3 = judgeL3(claim, [diagnosis, claim], unchanged), l4 = judgeL4([diagnosis, claim]);
    assert.deepEqual([l2.status, l3.status, l3.falseConsensus, l4.status], ["PASS", "PASS", true, "PASS"], [l2.detail, l3.detail, l4.detail].join("\n"));
    assert.match(claim, /^ {4}k1 configuration\.yaml contains "trusted_proxies" \.\.\. NO → CONTRADICTS the claim \(proposed by fusion\)$/mu);
    // `history` shows the session's reliability counts.
    assert.match(segmentOf(session.stdout, G_LINES[2], G_LINES[3]), /^Evidence: 2 claim checks \(\d+ Fusion checks, 1 contradicted\), 1 falsification \(0 broke a conclusion\); builds: 0 verified, 0 unverified, 0 blocked\.$/mu);
    for (const secret of Object.values(HA_SENTINELS)) assert.ok(!everything(session).includes(secret), secret);
    evidence("v0.4 G the live L2–L4 lines", session, unchanged);
    assert.ok(unchanged);
    assert.equal(await readFile(join(root, "configuration.yaml"), "utf8"), HA_FILES["configuration.yaml"]);
  }));
