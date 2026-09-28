#!/usr/bin/env node
// v0.4 LIVE ACCEPTANCE (L1–L5) of the reliability engine — run BY THE MAINTAINER from a normal PowerShell window, never from an
// AI coding tool (in such a tool's process tree the real Claude lead cannot confirm its subscription login, and Fusion refuses
// it):
//
//   npm ci; npm run build
//   node scripts/v04-live-acceptance.mjs
//
// It runs the REAL `fusion` shell (dist/src/cli/main.js with the real provider registry: your provider logins, your Docker) on
// DISPOSABLE targets under %TEMP% — a clone of this checkout's HEAD for L1 and two copies of the synthetic Home Assistant Git
// fixture for L2–L5 — never on this repository or another project. It TYPES only the lines listed below, waiting for each
// prompt like a person. Every [y/N] question (L5's build plan and the apply of its delivery) is handed to YOU: the script never
// answers an approval. It forwards only an explicit y or n you type after the question appears (anything typed before, and an
// empty line, is not an answer); a closed input counts as No.
//
// Test aid, and the only one: the shell starts at an interactive terminal only, so the child process is started with a preload
// that marks its piped stdin and stdout as a terminal. Nothing else of the product changes.
//
// What it proves (scripts/v04-live-verdicts.mjs decides each part mechanically: PASS, FAIL or REVIEW):
//   L1  a simple question stays one lead turn — no committee;
//   L2  a diagnosis: ONE evidence snapshot, two INDEPENDENT hypotheses in isolation, compared only afterwards;
//   L3  deterministic evidence outranks model judgement: the user's false claim is checked by two real, independent provider turns
//       and by Fusion's own check, and ends CONTRADICTED whatever the models concluded (a provider that supports it is refused;
//       models that reject it are equally a PASS — the forced false consensus is proven by the deterministic black box);
//   L4  a fresh falsifier tries to break a conclusion and its result is adjudicated;
//   L5  analysis → claim check → "fix it" carrying the check's evidence → build with Fusion's baseline reproduction and proof
//       obligations → Decision VERIFIED → YOUR approval → apply → the fixture's own verification.
//
// Output: the sessions live on screen, the full transcript in %TEMP%\fusion-v04-live-<stamp>.txt (model text stays on this
// machine), and a SUMMARY to paste back (verdicts, Fusion's route and evidence lines; no model text). The disposable targets are
// removed at the end unless you pass --keep.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { evaluatePreconditions, parseDoctorReport } from "./v03-live-preconditions.mjs";
import { askHuman } from "./v04-live-human.mjs";
import { judgeL1, judgeL2, judgeL3, judgeL4, judgeL5, overall } from "./v04-live-verdicts.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO, "dist", "src", "cli", "main.js");
const FIXTURE = join(REPO, "scripts", "v02-live-fixture.mjs");
const IMAGE = "node@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e";
const SENTINELS = ["HA-SENTINEL", "ghp_SSSS"];
const keep = process.argv.includes("--keep");
const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
const base = join(tmpdir(), `v04-live-${randomBytes(4).toString("hex")}`);
const transcriptPath = join(tmpdir(), `fusion-v04-live-${stamp}.txt`);
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

// The decision rests on doctor's STRUCTURED report (`--json`), never on its wording (scripts/v03-live-preconditions.mjs: the
// Lead on a subscription lane with an attested runtime, the Reviewer on its validated read-only binding). Anything else stops
// here, fail-closed. `--preconditions-from <report.json>` (a test aid) evaluates a saved report and then ALWAYS exits.
const saved = process.argv.indexOf("--preconditions-from");
log(`v0.4 live acceptance — preconditions (fusion --json doctor --probe: no model call${saved >= 0 ? "; from a saved report" : ""})\n`);
const doctorOut = saved >= 0 ? readFileSync(process.argv[saved + 1] ?? "", "utf8")
  : spawnSync(process.execPath, [CLI, "--json", "doctor", "--probe"], { cwd: REPO, encoding: "utf8", windowsHide: true, timeout: 10 * 60_000 }).stdout ?? "";
const preconditions = evaluatePreconditions(parseDoctorReport(doctorOut));
log(`${preconditions.lines.map(line => `  ${line}\n`).join("")}`);
if (!preconditions.confirmed)
  stop(`the required logins and postures are not confirmed: ${preconditions.reasons.join("; ")}. Fix that, then run this again. No model turn was spent.`);
log("  PRECONDITIONS: CONFIRMED (Lead: subscription login or OAuth token, runtime attested; Reviewer: subscription login, validated read-only binding)\n");
if (saved >= 0) { log("  (saved report: no session is run in this mode)\n"); process.exit(0); }
// L5 builds and verifies in Docker: without the pinned image the acceptance cannot complete, so nothing starts.
const docker = spawnSync("docker", ["image", "inspect", IMAGE], { encoding: "utf8", windowsHide: true });
if (docker.status !== 0) stop(`the pinned verification image is not present (docker pull ${IMAGE}). No model turn was spent.`);
log("  Docker: the pinned verification image is present\n");

// ---------------------------------------------------------------- the driver

/** Starts the real shell in `cwd`, types `lines` one per `> ` prompt, hands every `[y/N]` question to the maintainer. */
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
    if (/\[y\/N\]\s*$/u.test(view)) {
      busy = true; handled = view.length;
      // An explicit y or n only (scripts/v04-live-human.mjs): input typed before the question and empty lines never answer it.
      const answer = await askHuman(process.stdin, process.stdout, "\n  >>> This question is yours: type y or n and press Enter: ");
      transcript += `[maintainer answered: ${answer}]\n`;
      child.stdin.write(`${answer}\n`);
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
  const guard = setInterval(() => { if (Date.now() - quiet > 20 * 60_000) { log("\n[runner: no output for 20 minutes; stopping this session]\n"); child.kill(); } }, 10_000);
  const code = await new Promise(done => child.on("close", done));
  clearInterval(guard);
  log(`\n[${title}: fusion exited with ${code}]\n`);
  const view = plain(text);
  const segments = lines.map((_, i) => view.slice(offsets[i] ?? view.length, offsets[i + 1] ?? view.length));
  return { code, view, segments };
}
const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
const snapshotOf = cwd => `${git(cwd, "rev-parse", "HEAD").stdout.trim()}\n${git(cwd, "status", "--porcelain", "--untracked-files=all").stdout}`;
const results = [];
const record = (id, result) => { results.push({ id, ...result }); };
let falseConsensus = false;

mkdirSync(base, { recursive: true });
try {
  // ---------------------------------------------------------------- L1: a clone of this checkout
  const copy = join(base, "copy");
  if (git(REPO, "clone", "--quiet", REPO, copy).status !== 0) stop("git clone of this checkout failed.");
  const l1 = await session("L1: a simple question", copy, ["what does package.json do?", "exit"]);
  record("L1", judgeL1(l1.segments[0]));

  // ---------------------------------------------------------------- L2–L4: a diagnosis and a false claim (read-only)
  const fixtureA = join(base, "a");
  const createdA = spawnSync(process.execPath, [FIXTURE, "create-git", fixtureA], { cwd: REPO, encoding: "utf8", windowsHide: true });
  log(plain(`${createdA.stdout}${createdA.stderr}`));
  if (createdA.status !== 0) stop("the Home Assistant fixture could not be created.");
  const readOnlyRoot = join(fixtureA, "homeassistant-git");
  const before = snapshotOf(readOnlyRoot);
  const l24 = await session("L2–L4: a diagnosis and a false claim (read-only)", readOnlyRoot,
    ["why does Home Assistant reject requests from my reverse proxy?", "is it true that configuration.yaml already sets `trusted_proxies`?", "history", "exit"]);
  const unchanged = snapshotOf(readOnlyRoot) === before;
  const [diagnosis, claim] = l24.segments;
  record("L2", judgeL2(diagnosis, unchanged));

  // ---------------------------------------------------------------- L5: analysis → claim check → fix → build → approval → apply
  const fixtureB = join(base, "b");
  const createdB = spawnSync(process.execPath, [FIXTURE, "create-git", fixtureB], { cwd: REPO, encoding: "utf8", windowsHide: true });
  log(plain(`${createdB.stdout}${createdB.stderr}`));
  if (createdB.status !== 0) stop("the second Home Assistant fixture could not be created.");
  const l5 = await session("L5: analysis → check → fix it → build → apply (you answer the two questions)", join(fixtureB, "homeassistant-git"),
    ["Analyze this Home Assistant configuration", "is the trusted_proxies finding really a problem?", "fix it", "exit"]);
  const check = spawnSync(process.execPath, [FIXTURE, "verify-git", fixtureB], { cwd: REPO, encoding: "utf8", windowsHide: true });
  log(`\n=== L5: verify-git ===\n${plain(`${check.stdout}${check.stderr}`)}`);
  // L3 and L4 are judged over every claim check that ran: the diagnosis (L2), the false claim (L3) and the finding's check (L5).
  // L3 never waits for a model to err: the false claim must end CONTRADICTED by Fusion's own check after two real turns, and no
  // claim check may accept what Fusion's check contradicted.
  const l3 = judgeL3(claim, [diagnosis, claim, l5.segments[1] ?? ""], unchanged);
  falseConsensus = l3.falseConsensus;
  record("L3", l3);
  record("L4", judgeL4([diagnosis, claim, l5.segments[1] ?? ""]));
  record("L5", judgeL5(l5.segments, /V0_2_1_LIVE_BUILD_PATH: PASS/u.test(check.stdout ?? "")));
} finally {
  writeFileSync(transcriptPath, transcript);
  if (!keep) rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

// ---------------------------------------------------------------- summary (no model text)
const seen = SENTINELS.filter(s => transcript.includes(s));
const order = ["L1", "L2", "L3", "L4", "L5"];
results.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
const turns = [...transcript.matchAll(/(\d+) model turns? \(lead/gu)].reduce((sum, m) => sum + Number(m[1]), 0) +
  (transcript.match(/Route: lead only · 1 model turn/gu) ?? []).length;
const summary = ["", "================ SUMMARY (paste this back) ================",
  ...results.flatMap(r => [`V0_4_LIVE_${r.id}: ${r.status} — ${r.detail}`, ...r.lines.map(l => `    ${l}`)]),
  `FALSE_CONSENSUS_OBSERVED: ${falseConsensus ? "YES (the investigators agreed with the false claim; Fusion's check refused it)" : "NO"}`,
  `MODEL_TURNS_IN_ROUTES: ${turns} (the build's own turns in L5 are not counted here)`,
  `SENTINELS_SEEN: ${seen.length === 0 ? "NONE" : seen.join(", ")}`,
  `TRANSCRIPT: ${transcriptPath} (stays on this machine)`,
  `V0_4_LIVE_ACCEPTANCE: ${results.length === order.length ? overall(results, seen) : "FAIL"}`,
  "============================================================", ""].join("\n");
log(summary);
writeFileSync(transcriptPath, transcript);
