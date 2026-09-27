#!/usr/bin/env node
// v0.3 LIVE ACCEPTANCE (L1–L4) — run BY THE MAINTAINER from a normal PowerShell window, never from an AI coding tool (in
// such a tool's process tree the real Claude lead cannot confirm its subscription login, and Fusion refuses it):
//
//   npm ci; npm run build
//   node scripts/v03-live-acceptance.mjs
//
// It runs the REAL `fusion` shell (dist/src/cli/main.js with the real provider registry: your provider logins, your Docker)
// on DISPOSABLE targets under %TEMP% — a clone of this checkout's HEAD for L1–L3 and the synthetic Home Assistant Git
// fixture for L4 — never on this repository or another project. It TYPES only the read-only lines listed below, waiting for
// each prompt like a person. Every [y/N] question (L4's build plan and the apply of its delivery) is handed to YOU: the
// script never answers an approval.
//
// Test aid, and the only one: the shell starts at an interactive terminal only, so the child process is started with a
// preload that marks its piped stdin and stdout as a terminal. Nothing else of the product changes.
//
// Output: the sessions live on screen, the full transcript in %TEMP%\fusion-v03-live-<stamp>.txt (model text stays on
// this machine), and a SUMMARY to paste back (verdicts, the Route: and Turns: lines, sentinels; no model text). The
// disposable targets are removed at the end unless you pass --keep.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO, "dist", "src", "cli", "main.js");
const FIXTURE = join(REPO, "scripts", "v02-live-fixture.mjs");
const IMAGE = "node@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e";
const SENTINELS = ["HA-SENTINEL", "ghp_SSSS"];
const keep = process.argv.includes("--keep");
const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
const base = join(tmpdir(), `v03-live-${randomBytes(4).toString("hex")}`);
const transcriptPath = join(tmpdir(), `fusion-v03-live-${stamp}.txt`);
const plain = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, "").replace(/\r/gu, "");
let transcript = "";
const log = text => { transcript += text; process.stdout.write(text); };
const stop = (message) => { log(`\nSTOPPED: ${message}\n`); writeFileSync(transcriptPath, transcript); process.exit(2); };

if (!existsSync(CLI)) stop("dist/src/cli/main.js is missing: run `npm ci; npm run build` first (no model turn was spent).");

// ---------------------------------------------------------------- 0. preconditions (no model turn)

log("v0.3 live acceptance — preconditions (fusion doctor --probe: no model call)\n");
const doctor = spawnSync(process.execPath, [CLI, "doctor", "--probe"], { cwd: REPO, encoding: "utf8", windowsHide: true, timeout: 10 * 60_000 });
const doctorText = plain(`${doctor.stdout ?? ""}${doctor.stderr ?? ""}`);
const block = role => doctorText.split(/\n(?=binding \d+: )/u).find(part => new RegExp(`^binding \\d+: ${role} via`, "u").test(part)) ?? "";
for (const role of ["Lead", "Reviewer"]) {
  const lines = block(role).split("\n").filter(line => /probe: auth|runtime posture/u.test(line)).map(line => `  ${role}: ${line.trim()}`);
  log(`${lines.join("\n") || `  ${role}: (no probe line)`}\n`);
  if (!/probe: auth authenticated \(subscription login\)/u.test(block(role)))
    stop(`the ${role} binding's subscription login is not confirmed (fusion doctor --probe). Sign in, then run this again. No model turn was spent.`);
}
const docker = spawnSync("docker", ["image", "inspect", IMAGE], { encoding: "utf8", windowsHide: true });
const dockerReady = docker.status === 0;
log(`  Docker: ${dockerReady ? "the pinned verification image is present" : "the pinned image is missing — L4 will not run (docker pull the image from the README)"}\n`);

// ---------------------------------------------------------------- the driver

/** One line from the maintainer's own terminal. No input (a closed stdin) is an empty answer: the question's default, No. */
async function askHuman(question) {
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await reader.question(question)).trim(); } catch { return ""; } finally { reader.close(); }
}

/**
 * Starts the real shell in `cwd`, types `lines` one per `> ` prompt, hands every `[y/N]` question to the maintainer, and
 * returns the plain transcript with the offset at which each typed line was sent.
 */
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
      const answer = await askHuman("\n  >>> This question is yours: type y or n and press Enter: ");
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
const routeOf = segment => (segment.match(/^ {2}Route: .+$/gmu) ?? []).map(l => l.trim());
const turnsOf = segment => (segment.match(/^ {2}Turns: .+$/gmu) ?? []).map(l => l.trim());
const results = [];
const verdict = (id, status, detail, lines = []) => { results.push({ id, status, detail, lines }); };

mkdirSync(base, { recursive: true });
try {
  // ---------------------------------------------------------------- L1–L3: a clone of this checkout
  const copy = join(base, "copy");
  if (git(REPO, "clone", "--quiet", REPO, copy).status !== 0) stop("git clone of this checkout failed.");
  const head = git(copy, "rev-parse", "HEAD").stdout.trim();
  const l13 = await session("L1–L3: a clone of this repository", copy, ["what does package.json do?", "analyze the whole repository",
    "is the first finding really a problem?", "exit"]);
  const unchanged = git(copy, "status", "--porcelain").stdout.trim() === "" && git(copy, "rev-parse", "HEAD").stdout.trim() === head;
  const [s1, s2, s3] = l13.segments;
  const failed = segment => /^fusion: /mu.test(segment) ? segment.match(/^fusion: .+$/mu)[0] : undefined;
  verdict("L1", /^ {2}Route: lead only · 1 model turn/mu.test(s1) && !/Explorer investigations|Second opinion/u.test(s1) ? "PASS" : "FAIL",
    failed(s1) ?? "one lead turn, no explorer, no reviewer", routeOf(s1));
  const r2 = routeOf(s2).join(" | ");
  verdict("L2", failed(s2) ? "FAIL" : /parallel investigations → .*lead synthesis → fresh review/u.test(r2) && unchanged ? "PASS"
    : /answer directly/u.test(r2) && unchanged ? "CHECK" : "FAIL",
    failed(s2) ?? (/answer directly/u.test(r2) ? "the lead chose to answer directly (a finding about its choice, not a failure)"
      : `parallel investigations, lead synthesis, fresh review; clone unchanged: ${unchanged}`),
    [...routeOf(s2), ...turnsOf(s2), ...(s2.match(/^ {2}(?:Planning|Explorer investigations|Evidence|\(the explorer binding).+$/gmu) ?? []).map(l => l.trim())]);
  const verified = /^Checking whether this holds \(read-only\): /mu.test(s3);
  verdict("L3", failed(s3) ? "FAIL" : verified && /parallel investigations|answer directly/u.test(routeOf(s3).join(" ")) && unchanged ? "PASS" : "FAIL",
    failed(s3) ?? (verified ? `a verification of the first finding; clone unchanged: ${unchanged}` : "the line was not treated as a verification (did L2 list findings?)"),
    [...routeOf(s3), ...turnsOf(s3), ...(s3.match(/^ {2}(?:Claim checked|Conflict|Evidence).+$/gmu) ?? []).map(l => l.trim())]);

  // ---------------------------------------------------------------- L4: analysis → verification → fix → apply
  if (!dockerReady) verdict("L4", "NOT RUN", "the pinned Docker image is missing");
  else {
    const fixture = join(base, "c");
    const created = spawnSync(process.execPath, [FIXTURE, "create-git", fixture], { cwd: REPO, encoding: "utf8", windowsHide: true });
    log(plain(`${created.stdout}${created.stderr}`));
    if (created.status !== 0) stop("the Live C fixture could not be created.");
    const l4 = await session("L4: analysis → verification → fix it → apply (you answer the two questions)", join(fixture, "homeassistant-git"),
      ["Analyze this Home Assistant configuration", "is the trusted_proxies finding really a problem?", "fix it", "exit"]);
    const check = spawnSync(process.execPath, [FIXTURE, "verify-git", fixture], { cwd: REPO, encoding: "utf8", windowsHide: true });
    log(`\n=== L4: verify-git ===\n${plain(`${check.stdout}${check.stderr}`)}`);
    const v = l4.view, [, t2] = l4.segments;
    const parts = {
      verification: /^Checking whether this holds \(read-only\): /mu.test(t2),
      evidence: /\(Fusion's investigation of this finding cited: [^)]+\)/u.test(v),
      scope: /^Scope \(.*\): configuration\.yaml$/mu.test(v),
      verified: /^Verification: PASS/mu.test(v),
      applied: /^Result: applied/mu.test(v),
      fixture: /V0_2_1_LIVE_BUILD_PATH: PASS/u.test(check.stdout ?? ""),
    };
    verdict("L4", Object.values(parts).every(Boolean) ? "PASS" : "FAIL", Object.entries(parts).map(([k, ok]) => `${k}=${ok ? "yes" : "NO"}`).join(" "),
      [...routeOf(v), ...turnsOf(v), ...(v.match(/^(?:Scope \(.+|Verification: .+|Review: .+|Result: .+)$/gmu) ?? []).map(l => l.trim())]);
  }
} finally {
  writeFileSync(transcriptPath, transcript);
  if (!keep) rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

// ---------------------------------------------------------------- summary (no model text)
const seen = SENTINELS.filter(s => transcript.includes(s));
const turns = [...transcript.matchAll(/(\d+) model turns? \(lead/gu)].reduce((sum, m) => sum + Number(m[1]), 0) +
  (transcript.match(/Route: lead only · 1 model turn/gu) ?? []).length;
const summary = ["", "================ SUMMARY (paste this back) ================",
  ...results.flatMap(r => [`V0_3_LIVE_${r.id}: ${r.status} — ${r.detail}`, ...r.lines.map(l => `    ${l}`)]),
  `MODEL_TURNS_IN_ROUTES: ${turns} (the build's own turns in L4 are not counted here)`,
  `SENTINELS_SEEN: ${seen.length === 0 ? "NONE" : seen.join(", ")}`,
  `TRANSCRIPT: ${transcriptPath} (stays on this machine)`,
  `V0_3_LIVE_ACCEPTANCE: ${results.length === 4 && results.every(r => r.status === "PASS") && seen.length === 0 ? "PASS" : "REVIEW"}`,
  "============================================================", ""].join("\n");
log(summary);
writeFileSync(transcriptPath, transcript);
