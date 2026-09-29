#!/usr/bin/env node
// v0.5 LIVE ACCEPTANCE (L1–L6) of evidence-driven candidate selection — run BY THE MAINTAINER from a normal PowerShell window,
// never from an AI coding tool (in such a tool's process tree the real Claude lead cannot confirm its subscription login, and
// Fusion refuses it):
//
//   npm ci; npm run build
//   node scripts/v05-live-acceptance.mjs
//
// It runs the REAL `fusion` shell (dist/src/cli/main.js with the real provider registry: your provider logins, your Docker) on
// DISPOSABLE copies of the synthetic Home Assistant Git fixture under %TEMP% — never on this repository or another project. It
// TYPES only the lines listed below, waiting for each prompt like a person. Every [y/N] question (a build plan, the apply of a
// delivery) and a tie choice are handed to YOU: the script never answers an approval or a choice. It forwards only an explicit
// answer you type after the question appears; a closed input counts as No (or as no choice).
//
// Test aid, and the only one: the shell starts at an interactive terminal only, so the child process is started with a preload
// that marks its piped stdin and stdout as a terminal. Nothing else of the product changes.
//
// What it proves (scripts/v05-live-verdicts.mjs decides each part mechanically, from Fusion's own bound run records and output
// lines — never from model text; none of it needs a real model to make a mistake):
//   L1  a simple change stays single-path: its plan runs no tournament (answer n to its question: the plan is enough);
//   L2  a real tournament: the frozen common snapshot and profile, two independent real candidate proposals in separate
//       contexts, the primary checkout unchanged;
//   L3  both candidates materialized in isolated Fusion-owned workspaces, facing the same frozen checks and experiments;
//   L4  Fusion's deterministic preservation probe separates two KNOWN fixture candidates (a correct fix, and the same fix with a
//       new top-level section) in the real confined backend — no model involved;
//   L5  selection by Fusion's evidence (or your tie choice), never a model's preference; the selected candidate revalidated
//       freshly, bound to its exact revision;
//   L6  the selected change goes through the unchanged Delivery, YOUR approval and Apply; the fixture's protected files stay
//       byte-identical and only configuration.yaml changes.
//
// Output: the sessions live on screen, the full transcript in %TEMP%\fusion-v05-live-<stamp>.txt (model text stays on this
// machine), and a SUMMARY to paste back (verdicts, Fusion's labels, counts and digests; no model text). The disposable targets are
// removed at the end unless you pass --keep.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { evaluatePreconditions, parseDoctorReport } from "./v03-live-preconditions.mjs";
import { askHuman } from "./v04-live-human.mjs";
import { discriminate } from "./v05-live-discrimination.mjs";
import { collectFacts } from "./v05-live-records.mjs";
import { judgeL1, judgeL2, judgeL3, judgeL4, judgeL5, judgeL6, overall } from "./v05-live-verdicts.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO, "dist", "src", "cli", "main.js");
const FIXTURE = join(REPO, "scripts", "v02-live-fixture.mjs");
const IMAGE = "node@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e";
const SENTINELS = ["HA-SENTINEL", "ghp_SSSS"];
const TIE = /Choose (c[1-3](?: or c[1-3])+) to revalidate and prepare \(anything else chooses none\): $/u;
const keep = process.argv.includes("--keep");
const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
const base = join(tmpdir(), `v05-live-${randomBytes(4).toString("hex")}`);
const transcriptPath = join(tmpdir(), `fusion-v05-live-${stamp}.txt`);
const plain = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, "").replace(/\r/gu, "");
let transcript = "";
const log = text => { transcript += text; process.stdout.write(text); };
const stop = message => {
  log(`\nSTOPPED: ${message}\n`);
  if (!process.argv.includes("--preconditions-from")) writeFileSync(transcriptPath, transcript);
  process.exit(2);
};

if (!existsSync(CLI)) stop("dist/src/cli/main.js is missing: run `npm ci; npm run build` first (no model turn was spent).");

// ---------------------------------------------------------------- 0. preconditions (no model turn)

// The decision rests on doctor's STRUCTURED report (`--json`), never on its wording (scripts/v03-live-preconditions.mjs). Anything
// else stops here, fail-closed. `--preconditions-from <report.json>` (a test aid) evaluates a saved report and then ALWAYS exits.
const saved = process.argv.indexOf("--preconditions-from");
log(`v0.5 live acceptance — preconditions (fusion --json doctor --probe: no model call${saved >= 0 ? "; from a saved report" : ""})\n`);
const doctorOut = saved >= 0 ? readFileSync(process.argv[saved + 1] ?? "", "utf8")
  : spawnSync(process.execPath, [CLI, "--json", "doctor", "--probe"], { cwd: REPO, encoding: "utf8", windowsHide: true, timeout: 10 * 60_000 }).stdout ?? "";
const preconditions = evaluatePreconditions(parseDoctorReport(doctorOut));
log(`${preconditions.lines.map(line => `  ${line}\n`).join("")}`);
if (!preconditions.confirmed)
  stop(`the required logins and postures are not confirmed: ${preconditions.reasons.join("; ")}. Fix that, then run this again. No model turn was spent.`);
log("  PRECONDITIONS: CONFIRMED\n");
if (saved >= 0) { log("  (saved report: no session is run in this mode)\n"); process.exit(0); }
const docker = spawnSync("docker", ["image", "inspect", IMAGE], { encoding: "utf8", windowsHide: true });
if (docker.status !== 0) stop(`the pinned verification image is not present (docker pull ${IMAGE}). No model turn was spent.`);
log("  Docker: the pinned verification image is present\n");

// ---------------------------------------------------------------- the driver

/** Starts the real shell in `cwd`, types `lines` one per `> ` prompt, hands every [y/N] question and tie choice to the maintainer. */
async function session(title, cwd, lines) {
  log(`\n=== ${title} (in ${cwd}) ===\n`);
  const shim = join(base, "tty-preload.mjs");
  writeFileSync(shim, "Object.defineProperty(process.stdin, \"isTTY\", { value: true });\nObject.defineProperty(process.stdout, \"isTTY\", { value: true });\n");
  const child = spawn(process.execPath, ["--import", pathToFileURL(shim).href, CLI], { cwd, windowsHide: true, env: process.env });
  let text = "", handled = 0, busy = false;
  const offsets = [], pending = [...lines];
  let quiet = Date.now();
  const respond = async () => {
    if (busy) return;
    const view = plain(text);
    if (view.length <= handled) return;
    const tie = TIE.exec(view);
    if (/\[y\/N\]\s*$/u.test(view)) {
      busy = true; handled = view.length;
      const answer = await askHuman(process.stdin, process.stdout, "\n  >>> This question is yours: type y or n and press Enter: ");
      transcript += `[maintainer answered: ${answer}]\n`;
      child.stdin.write(`${answer}\n`);
      busy = false;
    } else if (tie !== null) {
      busy = true; handled = view.length;
      const options = tie[1].split(" or ");
      const answer = await askHuman(process.stdin, process.stdout, `\n  >>> This choice is yours: type ${options.join(", ")} or none, and press Enter: `,
        { accept: new RegExp(`^(?:${options.join("|")}|none)$`, "u"), again: `\n  >>> Please type ${options.join(", ")} or none: ` });
      transcript += `[maintainer chose: ${answer || "none"}]\n`;
      child.stdin.write(`${answer || "none"}\n`);
      busy = false;
    } else if (/(?:^|\n)> $/u.test(view) && pending.length > 0) {
      handled = view.length;
      const line = pending.shift();
      offsets.push(view.length);
      child.stdin.write(`${line}\n`);
      if (pending.length === 0) child.stdin.end();
    }
  };
  const onData = chunk => { const s = chunk.toString("utf8"); text += s; log(plain(s)); quiet = Date.now(); setTimeout(() => void respond(), 250); };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const guard = setInterval(() => { if (Date.now() - quiet > 30 * 60_000) { log("\n[runner: no output for 30 minutes; stopping this session]\n"); child.kill(); } }, 10_000);
  const code = await new Promise(done => child.on("close", done));
  clearInterval(guard);
  log(`\n[${title}: fusion exited with ${code}]\n`);
  const view = plain(text);
  const segments = lines.map((_, i) => view.slice(offsets[i] ?? view.length, offsets[i + 1] ?? view.length));
  return { code, view, segments };
}
const fixture = (dir, ...flags) => {
  const created = spawnSync(process.execPath, [FIXTURE, "create-git", dir, ...flags], { cwd: REPO, encoding: "utf8", windowsHide: true });
  log(plain(`${created.stdout}${created.stderr}`));
  if (created.status !== 0) stop("the Home Assistant fixture could not be created.");
  return join(dir, "homeassistant-git");
};
const results = [];
const record = (id, result) => { results.push({ id, ...result }); };

mkdirSync(base, { recursive: true });
try {
  // ---------------------------------------------------------------- L1: a simple change stays single-path
  const simple = fixture(join(base, "a"));
  const l1 = await session("L1: a simple change (answer n: its plan is all L1 needs)", simple,
    ["add a one-line comment above the hallway automation in automations.yaml that says what it does", "exit"]);
  record("L1", judgeL1(l1.segments[0] ?? ""));

  // ---------------------------------------------------------------- L4: known candidates, the real confined backend, no model
  const known = fixture(join(base, "c"), "--experiments");
  log("\n=== L4: Fusion's preservation probe on two known candidates (real confined backend; no model turn) ===\n");
  let discrimination = null;
  try {
    const { composeProductionWriter } = await import(pathToFileURL(join(REPO, "dist", "src", "app", "writer-composition.js")).href);
    const { defaultRegistry } = await import(pathToFileURL(join(REPO, "dist", "src", "providers", "registry.js")).href);
    discrimination = await discriminate({ root: known, compose: composeProductionWriter, registry: defaultRegistry() });
    log(`  acceptance ${discrimination.acceptance}; known good: ${discrimination.good}; known changed: ${discrimination.bad}; cleanup ${discrimination.cleanup ? "complete" : "INCOMPLETE"}\n`);
  } catch (error) { log(`  the check failed: ${error instanceof Error ? error.message : String(error)}\n`); }
  record("L4", judgeL4(discrimination));

  // ---------------------------------------------------------------- L2, L3, L5, L6: analysis → check → fix it → tournament → apply
  const repo = fixture(join(base, "b"), "--experiments");
  const run = await session("L2/L3/L5/L6: analysis → check → fix it → tournament → apply (you answer the questions)", repo,
    ["Analyze this Home Assistant configuration", "is the trusted_proxies finding really a problem?", "fix it", "exit"]);
  const check = spawnSync(process.execPath, [FIXTURE, "verify-git", join(base, "b")], { cwd: REPO, encoding: "utf8", windowsHide: true });
  log(`\n=== L6: verify-git ===\n${plain(`${check.stdout}${check.stderr}`)}`);
  const facts = await collectFacts(repo);
  record("L2", judgeL2(facts));
  record("L3", judgeL3(facts));
  record("L5", judgeL5(facts));
  record("L6", judgeL6(facts, run.segments[2] ?? "", /V0_2_1_LIVE_BUILD_PATH: PASS/u.test(check.stdout ?? "")));
} finally {
  writeFileSync(transcriptPath, transcript);
  if (!keep) rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

// ---------------------------------------------------------------- summary (no model text)
const seen = SENTINELS.filter(s => transcript.includes(s));
const order = ["L1", "L2", "L3", "L4", "L5", "L6"];
results.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
const summary = ["", "================ SUMMARY (paste this back) ================",
  ...results.flatMap(r => [`V0_5_LIVE_${r.id}: ${r.status} — ${r.detail}`, ...r.lines.map(l => `    ${l}`)]),
  `SENTINELS_SEEN: ${seen.length === 0 ? "NONE" : seen.join(", ")}`,
  `TRANSCRIPT: ${transcriptPath} (stays on this machine)`,
  `V0_5_LIVE_ACCEPTANCE: ${results.length === order.length ? overall(results, seen) : "FAIL"}`,
  "============================================================", ""].join("\n");
log(summary);
writeFileSync(transcriptPath, transcript);
