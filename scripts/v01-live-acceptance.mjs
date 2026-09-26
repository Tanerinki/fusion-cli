// v0.1 MINIMAL LIVE ACCEPTANCE — run BY THE HUMAN from a normal PowerShell window (never from an agent session):
//
//   npm run build
//   node scripts/v01-live-acceptance.mjs --authorization FUSION-V0.1-FINISH-LIVE --scenario check     (no model turn)
//   node scripts/v01-live-acceptance.mjs --authorization FUSION-V0.1-FINISH-LIVE --scenario chat
//   node scripts/v01-live-acceptance.mjs --authorization FUSION-V0.1-FINISH-LIVE --scenario analyze
//   node scripts/v01-live-acceptance.mjs --authorization FUSION-V0.1-FINISH-LIVE --scenario build
//   node scripts/v01-live-acceptance.mjs --authorization FUSION-V0.1-FINISH-LIVE --scenario create
//   node scripts/v01-live-acceptance.mjs --authorization FUSION-V0.1-FINISH-LIVE --scenario status
//
// Each scenario runs the REAL `fusion` commands (your provider logins, your Docker) against a DISPOSABLE target the script
// creates under %TEMP% — never this repository, never another project. The terminal is handed to you: you type "build",
// "create" and the delivery's manifest digest yourself; the script never answers a prompt for you.
//
// Budget (FUSION-V0.1-FINISH-LIVE): at most 50 provider model turns in total, at most 12 per scenario, at most 2 attempts
// per scenario. Before a scenario starts, its maximum is RESERVED in the ledger; afterwards the turns actually used are
// recorded (from the run's own evidence, plus the lead's scope turn). An attempt that never completes keeps its reservation.
// The ledger holds counts, exit codes and ids only — never provider text:
//   %LOCALAPPDATA%\Fusion\live-ledger\FUSION-V0.1-FINISH-LIVE.jsonl
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LIVE_CREATE_DESCRIPTION, LIVE_CREATE_NAME } from "./v01-live-create-spec.mjs";

const AUTHORIZATION = "FUSION-V0.1-FINISH-LIVE";
const BUDGET = Object.freeze({ total: 50, perScenario: 12, attempts: 2 });
/** The most model turns one attempt can use (build/create: scope, plan, 3 authors, 2 reviews, adjudication). */
const RESERVE = Object.freeze({ chat: 1, analyze: 1, build: 8, create: 8 });
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO, "dist", "src", "cli", "main.js");
const args = process.argv.slice(2);
const option = flag => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
const scenario = option("--scenario");

function fail(message, code = 2) { process.stderr.write(`REFUSED: ${message}\n`); process.exit(code); }
if (option("--authorization") !== AUTHORIZATION) fail(`--authorization ${AUTHORIZATION} is required.`);
if (!["check", "chat", "analyze", "build", "create", "status"].includes(scenario ?? "")) fail("--scenario must be check, chat, analyze, build, create or status.");
if (scenario !== "check" && scenario !== "status" && (process.env.CLAUDECODE !== undefined || process.env.CLAUDE_CODE_ENTRYPOINT !== undefined))
  fail("this runs from a normal terminal window, never from inside an agent session.");
if (!existsSync(CLI)) fail("the CLI is not built: run npm run build first.");

// ---------------------------------------------------------------- ledger
const ledgerDir = process.platform === "win32"
  ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Fusion", "live-ledger")
  : join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "fusion", "live-ledger");
const ledgerPath = join(ledgerDir, `${AUTHORIZATION}.jsonl`);
function ledger() {
  if (!existsSync(ledgerPath)) return [];
  return readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
}
function append(entry) {
  mkdirSync(ledgerDir, { recursive: true });
  appendFileSync(ledgerPath, `${JSON.stringify({ format: "fusion.liveLedger", authorization: AUTHORIZATION, at: new Date().toISOString(), ...entry })}\n`);
}
/** Per attempt: the recorded consumption once completed, else the reservation. */
function accounting(entries = ledger()) {
  const attempts = new Map();
  for (const entry of entries) {
    const key = `${entry.scenario}#${entry.attempt}`;
    const current = attempts.get(key) ?? { scenario: entry.scenario, attempt: entry.attempt, turns: 0, completed: false };
    if (entry.type === "reserved" && !current.completed) current.turns = entry.reservedTurns;
    if (entry.type === "completed") { current.turns = entry.consumedTurns; current.completed = true; current.result = entry.result; }
    attempts.set(key, current);
  }
  const list = [...attempts.values()];
  const total = list.reduce((sum, attempt) => sum + attempt.turns, 0);
  const of = name => list.filter(attempt => attempt.scenario === name);
  return { list, total, of };
}
function printStatus() {
  const { list, total, of } = accounting();
  console.log(`Ledger: ${ledgerPath}`);
  console.log(`Model turns counted: ${total} of ${BUDGET.total}`);
  for (const name of Object.keys(RESERVE)) {
    const attempts = of(name);
    console.log(`  ${name}: ${attempts.length} attempt(s), ${attempts.reduce((sum, a) => sum + a.turns, 0)} turn(s)` +
      attempts.map(a => ` [#${a.attempt} ${a.completed ? `${a.turns} used, ${JSON.stringify(a.result ?? {})}` : `${a.turns} reserved, not completed`}]`).join(""));
  }
  return list;
}
if (scenario === "status") { printStatus(); process.exit(0); }

const before = accounting();
const attempt = before.of(scenario).length + 1;
const reserve = RESERVE[scenario];
if (attempt > BUDGET.attempts) fail(`${scenario} already had ${BUDGET.attempts} attempts.`, 3);
if (before.total + reserve > BUDGET.total) fail(`the total budget would be exceeded (${before.total} + ${reserve} > ${BUDGET.total}).`, 3);
const scenarioTurns = before.of(scenario).reduce((sum, a) => sum + a.turns, 0);
if (scenarioTurns + reserve > BUDGET.perScenario) fail(`the ${scenario} budget would be exceeded (${scenarioTurns} + ${reserve} > ${BUDGET.perScenario}).`, 3);

// ---------------------------------------------------------------- the real CLI, disposable targets
const windows = process.platform === "win32";
function fusion(argv, cwd, interactive) {
  const result = spawnSync(process.execPath, [CLI, ...argv], { cwd, env: process.env, stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"],
    encoding: "utf8", windowsHide: true });
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
function gitIn(cwd, ...argv) {
  const result = spawnSync("git", ["-c", "core.autocrlf=false", "-c", "user.name=Fusion Live", "-c", "user.email=fusion-live@example.invalid",
    "-c", "commit.gpgsign=false", ...argv], { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${argv[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}
function nodeTests(cwd) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "test/**/*.test.ts"], { cwd, env, encoding: "utf8", windowsHide: true });
  const pass = /^# pass (\d+)$/mu.exec(result.stdout)?.[1], failed = /^# fail (\d+)$/mu.exec(result.stdout)?.[1];
  return { exitCode: result.status, pass: Number(pass ?? 0), fail: Number(failed ?? 0) };
}
/** A small, dependency-free TypeScript repository with one real defect and a passing test, committed. */
async function disposableRepository() {
  const { defaultRegistry } = await import(pathToFileURL(join(REPO, "dist", "src", "providers", "registry.js")).href);
  const { TEMPLATE_VERIFICATION } = await import(pathToFileURL(join(REPO, "dist", "src", "app", "create-templates.js")).href);
  const root = join(mkdtempSync(join(tmpdir(), `fusion-v01-live-${scenario}-`)), "slugs");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "test"));
  const files = {
    "package.json": `${JSON.stringify({ name: "live-slugs", version: "0.0.0", private: true, type: "module", scripts: { test: "node --test \"test/**/*.test.ts\"" } }, null, 2)}\n`,
    "README.md": "# live-slugs\n\nA tiny slug helper (a disposable Fusion v0.1 live-acceptance target).\n",
    "src/slug.ts": "/** A URL slug: lowercase words joined by single hyphens. */\nexport function slugify(text: string): string {\n  return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, \"-\");\n}\n",
    "test/slug.test.ts": "import assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\nimport { slugify } from \"../src/slug.ts\";\n\n" +
      "test(\"joins words with hyphens\", () => {\n  assert.equal(slugify(\"Hello World\"), \"hello-world\");\n});\n",
    ".gitignore": "node_modules/\n",
    "fusion.config.json": `${JSON.stringify({ schemaVersion: 1, bindings: defaultRegistry().defaults.bindings,
      verification: { commands: [], ...TEMPLATE_VERIFICATION }, limits: { runTimeoutMs: 30 * 60_000 } }, null, 2)}\n`,
  };
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, ...path.split("/")), content, { flag: "wx" });
  gitIn(root, "init", "-q", "-b", "main");
  gitIn(root, "add", "--all");
  gitIn(root, "commit", "-q", "-m", "baseline");
  return root;
}
/** The newest run recorded in `root` after `since`, as `fusion history` reports it. */
function newestRun(root, since) {
  const listed = fusion(["--json", "history", "--limit", "1"], root, false);
  if (listed.code !== 0) return undefined;
  const run = JSON.parse(listed.stdout).history.runs[0];
  return run && run.summary.createdAt >= since ? run : undefined;
}
async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim().toLowerCase(); } finally { rl.close(); }
}
/** Inspect, approve (YOU type the digest) and apply a delivery into the disposable target, then run its tests. */
async function deliver(root, deliveryId) {
  console.log(`\nDelivery ${deliveryId} was prepared for the disposable target ${root}.`);
  if (await ask("Inspect it, approve it (you type the digest) and apply it there now? Type yes to continue: ") !== "yes") return { delivered: "skipped" };
  fusion(["inspect-delivery", deliveryId], root, true);
  const approved = fusion(["approve-delivery", deliveryId], root, true);
  if (approved.code !== 0) return { delivered: "notApproved", approveExit: approved.code };
  const applied = fusion(["apply", deliveryId], root, true);
  const tests = nodeTests(root);
  return { delivered: applied.code === 0 ? "applied" : "applyFailed", applyExit: applied.code, testsAfterApply: tests,
    changedFiles: gitIn(root, "status", "--porcelain").split("\n").filter(Boolean).length };
}

// ---------------------------------------------------------------- scenarios
if (scenario === "check") {
  // No model turn and no ledger entry: the disposable target, the configuration Fusion reads there, and the read-only doctor.
  const root = await disposableRepository();
  const config = fusion(["config"], root, false);
  const doctor = fusion(["--json", "doctor"], root, false);
  let report;
  try { report = JSON.parse(doctor.stdout); } catch { report = undefined; }
  console.log(config.stdout);
  console.log(`Disposable repository: ${root}`);
  console.log(`Writer builds here: ${/^  Writer builds: supported$/mu.test(config.stdout) ? "supported by the configuration" : "NOT supported (see above)"}`);
  console.log(`fusion doctor: exit ${doctor.code}${report ? `; provider CLIs: ${report.providers.map(p =>
    `${p.role} ${p.inspection?.executable ?? "unknown"}${p.inspection?.runtimeVersion ? ` ${p.inspection.runtimeVersion}` : ""}`).join(", ")}` : ""}`);
  console.log("Confined verification is checked by the build itself before any model turn (Docker must be running with the verification image).");
  printStatus();
  process.exit(0);
}
append({ type: "reserved", scenario, attempt, reservedTurns: reserve });
console.log(`${AUTHORIZATION}: ${scenario}, attempt ${attempt} of ${BUDGET.attempts}; ${reserve} turn(s) reserved; ${before.total} of ${BUDGET.total} counted so far.\n`);
let consumed = reserve, result = {};
try {
  const started = new Date().toISOString();
  if (scenario === "chat" || scenario === "analyze") {
    const root = await disposableRepository();
    console.log(`Disposable repository: ${root}\n`);
    const ran = scenario === "chat"
      ? fusion(["chat", "--", "In two sentences: what does this repository do, and what is one small improvement you would make?"], root, true)
      : fusion(["analyze"], root, true);
    consumed = 1;
    result = { exitCode: ran.code, repositoryUnchanged: gitIn(root, "status", "--porcelain") === "" };
  } else if (scenario === "build") {
    const root = await disposableRepository();
    console.log(`Disposable repository: ${root}\nFusion shows the plan; type "build" to start it (anything else cancels).\n`);
    const task = "Make slugify strip leading and trailing hyphens, so \"  Hello, World!  \" becomes \"hello-world\", and add a test for it.";
    const ran = fusion(["build", "--", task], root, true);
    const run = newestRun(root, started);
    // The lead's scope turn precedes the run; only a verification preflight refusal (exit 11, no run) spends no turn.
    consumed = run ? run.summary.modelTurns + 1 : ran.code === 11 ? 0 : 1;
    result = { exitCode: ran.code, runId: run?.summary.runId, state: run?.summary.outcome?.state, resume: run?.resume.code, modelTurns: run?.summary.modelTurns,
      deliveryId: run?.summary.deliveryId };
    if (run?.summary.deliveryId) Object.assign(result, await deliver(root, run.summary.deliveryId));
  } else {
    const workspace = mkdtempSync(join(tmpdir(), "fusion-v01-live-create-"));
    console.log(`Disposable workspace: ${workspace}\nType "create" to create the project, then "build" to start its build.\n`);
    const ran = fusion(["create", "--template", "library", "--name", LIVE_CREATE_NAME, "--", LIVE_CREATE_DESCRIPTION], workspace, true);
    const root = join(workspace, LIVE_CREATE_NAME);
    const run = existsSync(root) ? newestRun(root, started) : undefined;
    consumed = run ? run.summary.modelTurns + 1 : !existsSync(root) || ran.code === 11 ? 0 : 1;
    result = { exitCode: ran.code, created: existsSync(root), runId: run?.summary.runId, state: run?.summary.outcome?.state, resume: run?.resume.code,
      modelTurns: run?.summary.modelTurns, deliveryId: run?.summary.deliveryId };
    if (run?.summary.deliveryId) Object.assign(result, await deliver(root, run.summary.deliveryId));
  }
} finally {
  append({ type: "completed", scenario, attempt, consumedTurns: consumed, result });
  console.log(`\n${scenario} attempt ${attempt}: ${consumed} model turn(s) counted. ${JSON.stringify(result)}`);
  printStatus();
}
