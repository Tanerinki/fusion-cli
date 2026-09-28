import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

/**
 * v0.4 — the live acceptance's VERDICTS (scripts/v04-live-verdicts.mjs), pinned on the shapes that decide them. The black box
 * (test/v04-black-box-acceptance.test.ts) applies the same verdicts to what the real shell printed; here the edges: a false
 * success is a FAIL, never a REVIEW; a part the real models gave no chance to show is a REVIEW, never a PASS; a leaked sentinel
 * or a part that never ran fails the whole acceptance. And the runner as a process: its preconditions stop it before any model
 * turn, and a saved report never runs a session.
 */
type Verdict = { status: string; detail: string; lines: string[] };
type Verdicts = { judgeL1(segment: string): Verdict; judgeL2(segment: string, unchanged: boolean): Verdict;
  judgeL3(claim: string, segments: readonly string[], unchanged: boolean): Verdict & { falseConsensus: boolean }; judgeL4(segments: readonly string[]): Verdict;
  judgeL5(segments: readonly string[], fixtureOk: boolean): Verdict; overall(results: ReadonlyArray<{ status: string }>, sentinels: readonly string[]): string;
  claimCheckLines(segment: string): string[] };
const REPO = process.cwd();
const load = async (): Promise<Verdicts> => await import(pathToFileURL(join(REPO, "scripts", "v04-live-verdicts.mjs")).href) as Verdicts;

const SNAPSHOT = "  Evidence snapshot: sha256:0123456789ab… given identically to 2 investigators, each in its own view copy and session; none saw another's conclusion";
const FALSIFIED = "  Fresh falsification (reviewer (meta); a fresh context that saw only Fusion's facts): verdict holds — it tried to break: the conclusion";
const check = (id: string, route: string, extra: readonly string[]) => [`> ${id}`, "Diagnosing (read-only): …", "", "(the diagnosis: model text)", "",
  `  Route: ${route}`, "  Turns: 4 model turns (lead 1 · explorers 2 · reviewer 1) · 1 batch (2 parallel) · 40 s", SNAPSHOT, ...extra, ""].join("\n");
const DIAGNOSIS = check("why?", "evidence snapshot → 2 independent hypotheses → 1 Fusion check → fresh falsification (could not break it) → lead diagnosis",
  ["  Independent hypotheses: 2 of 2 answered (model judgement, untrusted)", "    k1 configuration.yaml lacks \"trusted_proxies:\" ... YES → supports hypothesis h1 (proposed by h1)",
    FALSIFIED, "  Diagnosis: h1 SUPPORTED by Fusion's checks — …; h2 CONTRADICTED"]);
const claim = (status: string, support: number, contradict: number, checks: readonly string[] = []) => check("is it true?",
  `evidence snapshot → 2 independent hypotheses → ${checks.length} Fusion check${checks.length === 1 ? "" : "s"} → no falsification (already contradicted by Fusion's checks) → lead diagnosis`,
  ["  Independent hypotheses: 2 of 2 answered (model judgement, untrusted)", ...checks, "  Fresh falsification: not run — already contradicted by Fusion's checks",
    `  Claim: ${status} — … (investigators: ${support} support, ${contradict} contradict)`]);
const CONTRADICTING = "    k1 configuration.yaml contains \"trusted_proxies\" ... NO → CONTRADICTS the claim (proposed by fusion)";

test("L1: one lead turn PASSES; a committee for a simple question, another route or a Fusion failure FAILS", async () => {
  const { judgeL1 } = await load();
  assert.equal(judgeL1("> what?\n(answer)\n  Route: lead only · 1 model turn · 3.1 s\n").status, "PASS");
  assert.deepEqual([judgeL1(DIAGNOSIS).status, judgeL1(DIAGNOSIS).detail], ["FAIL", "a committee ran for a simple question"]);
  assert.equal(judgeL1("> what?\n  Route: lead decision → lead answer\n").detail, "the route was not `lead only · 1 model turn`");
  assert.deepEqual(judgeL1("> what?\nfusion: the Lead is not ready.\n").status, "FAIL");
});

test("L2: one snapshot, two isolated hypotheses, compared only afterwards; one unanswered hypothesis or a changed checkout FAILS", async () => {
  const { judgeL2, claimCheckLines } = await load();
  assert.deepEqual(judgeL2(DIAGNOSIS, true), { status: "PASS", detail: "one snapshot, two isolated hypotheses answered, compared only afterwards; checkout unchanged",
    lines: claimCheckLines(DIAGNOSIS) });
  // The pasted lines are Fusion's own labels and checks, never the model's text.
  assert.ok(!claimCheckLines(DIAGNOSIS).some(line => line.includes("model text")));
  assert.equal(judgeL2(DIAGNOSIS, false).detail, "the checkout changed");
  const one = DIAGNOSIS.replace("2 of 2 answered", "1 of 2 answered");
  assert.equal(judgeL2(one, true).detail, "1 of 2 independent hypotheses answered (two are needed to compare)");
  const noSnapshot = DIAGNOSIS.replace(SNAPSHOT, "").replace("evidence snapshot → 2 independent hypotheses", "lead decision → 2 parallel investigations");
  assert.equal(judgeL2(noSnapshot, true).status, "FAIL");
});

test("L3 (live integration): the false claim ends CONTRADICTED by Fusion's own check after two real turns, whatever the models said — no model has to err", async () => {
  const { judgeL3 } = await load();
  const l3 = (own: string, others: readonly string[] = [], unchanged = true) => judgeL3(own, [...others, own], unchanged);
  // The first real run: both investigators rejected the false claim; Fusion's own checks contradicted it. The product did
  // exactly what it must, so this is a PASS — the acceptance does not wait for a provider to make a mistake.
  const firstRun = l3(claim("CONTRADICTED", 0, 2, [CONTRADICTING]));
  assert.deepEqual([firstRun.status, firstRun.falseConsensus, firstRun.detail], ["PASS", false,
    "CONTRADICTED by 1 Fusion check(s), whatever the models concluded (investigators: 0 support, 2 contradict): the investigators rejected it too; " +
    "the case where they support it is proven deterministically by the black box"]);
  // A provider that supports the false claim is refused: PASS too (both of them: a false consensus, reported as information).
  const consensus = l3(claim("CONTRADICTED", 2, 0, [CONTRADICTING]));
  assert.deepEqual([consensus.status, consensus.falseConsensus, consensus.detail], ["PASS", true,
    "CONTRADICTED by 1 Fusion check(s), whatever the models concluded (investigators: 2 support, 0 contradict): Fusion refused the 2 investigator(s) " +
    "that supported it (a false consensus)"]);
  assert.deepEqual([l3(claim("CONTRADICTED", 1, 1, [CONTRADICTING])).status, l3(claim("CONTRADICTED", 1, 1, [CONTRADICTING])).falseConsensus], ["PASS", false]);
  // Model errors refused elsewhere in the run are reported, never required.
  const refutedHypothesis = DIAGNOSIS.replace("  Diagnosis:", "    k2 configuration.yaml contains \"proxy: on\" ... NO → CONTRADICTS hypothesis h2 (proposed by h2)\n  Diagnosis:");
  assert.match(l3(claim("CONTRADICTED", 0, 2, [CONTRADICTING]), [refutedHypothesis]).detail, /; elsewhere in the run Fusion's checks refused hypothesis h2$/u);
  // FAIL — model judgement overriding Fusion's evidence, anywhere in the run.
  assert.equal(l3(claim("SUPPORTED", 2, 0)).status, "FAIL");
  assert.equal(l3(claim("SUPPORTED", 2, 0, [CONTRADICTING])).status, "FAIL");
  const leading = refutedHypothesis.replace("h1 SUPPORTED by Fusion's checks — …; h2 CONTRADICTED", "h2 SUPPORTED by Fusion's checks — …");
  assert.deepEqual([l3(claim("CONTRADICTED", 2, 0, [CONTRADICTING]), [leading]).status, l3(claim("CONTRADICTED", 2, 0, [CONTRADICTING]), [leading]).detail],
    ["FAIL", "hypothesis h2 leads the diagnosis although Fusion's check contradicted it"]);
  // FAIL — the integration did not happen: no Fusion check against the claim, a status not taken from it, fewer than two real turns.
  assert.deepEqual([l3(claim("CONTRADICTED", 0, 2)).status, l3(claim("CONTRADICTED", 0, 2)).detail], ["FAIL", "Fusion ran no check of its own that contradicts the false claim"]);
  assert.equal(l3(claim("UNVERIFIED", 1, 1)).status, "FAIL");
  const oneTurn = claim("CONTRADICTED", 0, 1, [CONTRADICTING]).replace("2 of 2 answered", "1 of 2 answered");
  assert.deepEqual([l3(oneTurn).status, l3(oneTurn).detail], ["FAIL", "the false claim's check did not run two independent provider turns (1 of 2 answered)"]);
  assert.equal(l3(claim("CONTRADICTED", 2, 0, [CONTRADICTING]).replace(SNAPSHOT, "")).status, "FAIL", "one snapshot for both investigators");
  assert.equal(l3(claim("CONTRADICTED", 2, 0, [CONTRADICTING]), [], false).detail, "the checkout changed");
  assert.equal(l3("> is it true?\n(no claim line)\n").detail, "no claim decision was reported for the false claim");
  // L3 is PASS or FAIL: it never parks on REVIEW waiting for a provider's mistake.
  for (const shape of [claim("CONTRADICTED", 0, 2, [CONTRADICTING]), claim("CONTRADICTED", 0, 2), claim("UNVERIFIED", 0, 0)])
    assert.notEqual(l3(shape).status, "REVIEW");
});

test("L4: a fresh falsification that ran and was adjudicated PASSES — which is not agreement; a failed one, or an ignored blocker, FAILS; nothing to break is REVIEW", async () => {
  const { judgeL4 } = await load();
  assert.deepEqual([judgeL4([DIAGNOSIS]).status, judgeL4([DIAGNOSIS]).detail], ["PASS", "a fresh falsification ran in 1 claim check(s) and was adjudicated"]);
  // The first real run: verdict unclear, two missing-evidence objections — PASS says they stay open, not that it agreed.
  const unclear = DIAGNOSIS.replace(FALSIFIED, `${FALSIFIED.replace("verdict holds", "verdict unclear")}\n    missing evidence (untrusted): no log links a rejection\n` +
    "    missing evidence (untrusted): the included files were not examined");
  assert.deepEqual([judgeL4([unclear]).status, judgeL4([unclear]).detail], ["PASS",
    "a fresh falsification ran in 1 claim check(s) and was adjudicated; its objections (0 counterexample(s), 2 missing-evidence) stay open, untrusted"]);
  const broke = DIAGNOSIS.replace("  Diagnosis:", "    k2 configuration.yaml contains \"x\" ... NO → CONTRADICTS hypothesis h2 (proposed by falsifier)\n  Diagnosis:");
  assert.match(judgeL4([broke]).detail, /; one of its checks broke a conclusion$/u);
  // A mechanically established blocker that Fusion ignored (the contradicted hypothesis still leads): FAIL.
  const ignored = DIAGNOSIS.replace("  Diagnosis:", "    k2 configuration.yaml contains \"x\" ... NO → CONTRADICTS hypothesis h1 (proposed by falsifier)\n  Diagnosis:");
  assert.deepEqual([judgeL4([ignored]).status, judgeL4([ignored]).detail], ["FAIL", "a conclusion a falsifier check contradicted was still reported SUPPORTED"]);
  assert.equal(judgeL4([claim("CONTRADICTED", 2, 0, [CONTRADICTING])]).status, "REVIEW");
  const failed = DIAGNOSIS.replace(FALSIFIED, "  Fresh falsification (reviewer (meta)): no report — timeout: the turn did not finish");
  assert.deepEqual([judgeL4([failed]).status, judgeL4([failed]).detail], ["FAIL", "the falsification did not run or failed: no report (timeout)"]);
  // The second real run, exactly as printed (Fusion had cut the detail at 400 characters): FAIL, never a PASS or a REVIEW.
  const secondRun = DIAGNOSIS.replace(FALSIFIED, "  Fresh falsification (reviewer (meta)): no report — provider failure: Muse Exec reported a failed turn. (reason_class=unclassified " +
    "reason_chars=53 events=runtime.command.accepted:1,session.run.linked:1,run.model.configured:1,turn.input.user:1,run.lifecycle.started:1,task.stream.linked:12," +
    "task.lifecycle.proposed:12,task.lifecycle.accepted:10,task.lifecycle.scheduled:10,task.lifecycle.side_effect_intent:10,task.lifecycle.started:10," +
    "task.lifecycle.status:8,other:21 max").replace("fresh falsification (could not break it)", "fresh falsification (failed: provider failure)");
  assert.deepEqual([judgeL4([secondRun]).status, judgeL4([secondRun]).detail], ["FAIL", "the falsification did not run or failed: no report (provider failure)"]);
  // No report is no falsifier success: a reply that broke Fusion's structure, and a step limit.
  const unusable = DIAGNOSIS.replace(FALSIFIED, "  Fresh falsification (reviewer (meta)): a reply that did not follow Fusion's structure (invalid JSON); not used");
  assert.deepEqual([judgeL4([unusable]).status, judgeL4([unusable]).detail], ["FAIL", "the falsification did not run or failed: an unusable reply (invalid JSON)"]);
  const stepLimit = DIAGNOSIS.replace(FALSIFIED, "  Fresh falsification (reviewer (meta)): no report — turnLimit: Muse Exec reported a failed turn. (reason_class=stepLimit muse_code=stepLimit)");
  assert.equal(judgeL4([stepLimit]).detail, "the falsification did not run or failed: no report (turnLimit)");
  // One falsification that ran does not cover one that failed elsewhere in the run.
  assert.deepEqual([judgeL4([DIAGNOSIS, stepLimit]).status, judgeL4([DIAGNOSIS, stepLimit]).detail],
    ["FAIL", "the falsification did not run or failed: no report (turnLimit); 1 other falsification(s) ran"]);
  // Not run for Fusion's own reasons is a FAIL; "nothing to break" alone is a REVIEW.
  const budget = claim("SUPPORTED", 2, 0).replace("  Fresh falsification: not run — already contradicted by Fusion's checks", "  Fresh falsification: not run — budget exhausted: reviewer turns");
  assert.deepEqual([judgeL4([budget]).status, judgeL4([budget]).detail], ["FAIL", "the falsification did not run or failed: not run (budget exhausted: reviewer turns)"]);
  const noReviewer = DIAGNOSIS.replace(FALSIFIED, "  Fresh falsification: not run — no fresh reviewer with a proven read-only posture");
  assert.equal(judgeL4([noReviewer]).status, "FAIL");
});

test("L5: every part of the verified mutation is required — reproduction, correction, VERIFIED, the human's apply and the fixture's check", async () => {
  const { judgeL5 } = await load();
  const analysis = "> Analyze\n  Route: lead only · 1 model turn · 30 s\n";
  const verification = check("is it really a problem?", "evidence snapshot → 2 independent hypotheses → 1 Fusion check → fresh falsification (could not break it) → lead diagnosis",
    ["  Claim: SUPPORTED — Fusion's own checks support it (1) and none contradicts it (investigators: 2 support, 0 contradict)"]).replace("Diagnosing", "Checking whether this holds");
  const change = ["> fix it", "Preparing a verified change: Fix this finding from the analysis: …", "(Fusion's checks of this finding: SUPPORTED — 1 consistent, 0 contradicted)",
    "Scope (proposed by lead (claude); confirm or rerun with --path): configuration.yaml",
    "  invalid state shown ........ PASS  check config fails on the unchanged baseline",
    "  corrected state shown ...... PASS  check config failed before the change and passes after it",
    "Decision: VERIFIED (6 of 6 obligations)", "Apply these exact verified changes? [y/N] y", "Result: applied (phase done)", ""].join("\n");
  const passed = judgeL5([analysis, verification, change], true);
  assert.deepEqual([passed.status, passed.detail], ["PASS", "checked=yes handoff=yes reproduced=yes resolved=yes verified=yes applied=yes fixture=yes"]);
  assert.ok(passed.lines.includes("Decision: VERIFIED (6 of 6 obligations)") && passed.lines.includes("Result: applied (phase done)"));
  assert.equal(judgeL5([analysis, verification, change], false).status, "FAIL", "the fixture's own verification decides too");
  for (const [missing, part] of [["  invalid state shown ........ PASS  check config fails on the unchanged baseline\n", "reproduced=NO"],
    ["Decision: VERIFIED (6 of 6 obligations)", "verified=NO"], ["Result: applied (phase done)", "applied=NO"],
    ["(Fusion's checks of this finding: SUPPORTED — 1 consistent, 0 contradicted)", "handoff=NO"]] as const) {
    const result = judgeL5([analysis, verification, change.replace(missing, "")], true);
    assert.equal(result.status, "FAIL", part);
    assert.ok(result.detail.includes(part), result.detail);
  }
  // An UNVERIFIED build that still offered a delivery is not a verified mutation.
  assert.equal(judgeL5([analysis, verification, change.replace("Decision: VERIFIED (6 of 6 obligations)", "Decision: UNVERIFIED — 1 obligation(s) not established")], true).status, "FAIL");
});

test("overall: a FAIL, a part that never ran or a leaked sentinel FAILS; any REVIEW is REVIEW; only all PASS is PASS", async () => {
  const { overall } = await load();
  const pass = { status: "PASS" };
  assert.equal(overall([pass, pass, pass, pass, pass], []), "PASS");
  assert.equal(overall([pass, pass, { status: "REVIEW" }, pass, pass], []), "REVIEW");
  assert.equal(overall([pass, { status: "FAIL" }, { status: "REVIEW" }, pass, pass], []), "FAIL");
  assert.equal(overall([pass, { status: "NOT RUN" }, pass, pass, pass], []), "FAIL");
  assert.equal(overall([pass, pass, pass, pass, pass], ["HA-SENTINEL"]), "FAIL");
});

// ---------------------------------------------------------------- the runner as a process

const RUNNER = resolve(REPO, "scripts", "v04-live-acceptance.mjs");
const CANARY = "canary check passed on this runtime (11 checks: settings, hooks, MCP, agents, skills, commands, tools, plugins)";
type Binding = { role: string; adapter: string; version: string; probe?: Record<string, unknown>; postureEvidence?: string; readOnly?: string };
const provider = (b: Binding, index: number) => ({ index, role: b.role, adapter: b.adapter, requestedModel: "m", effort: "low",
  inspection: { executable: "available", runtimeVersion: b.version, billing: { state: "clear", reasons: [] }, controls: [], structuredTurns: true },
  identity: { requested: `p/${b.role}`, observed: "unobserved" }, capabilities: {}, postureEvidence: b.postureEvidence ?? "none",
  eligibility: { readOnly: { state: b.readOnly ?? "unknown", reasons: [] }, review: { state: "unknown", reasons: [] },
    changeProposal: { state: "unknown", reasons: [] }, writer: { state: "blocked", reasons: [] } }, ...(b.probe ? { probe: b.probe } : {}) });
const doctor = (lane: string) => ({ command: "doctor", exitCode: 15, readiness: { classes: ["DEGRADED"] },
  runtime: { platform: "win32", nodeVersion: "v22", git: "available" }, repository: { detected: false },
  config: { state: "valid", bindings: 4, verificationCommands: 0 }, storage: { state: "unknown" }, leases: { state: "unknown" },
  workspaceLease: { state: "available", reasons: [] }, verification: { state: "notConfigured", commands: 0, notes: [], confinedCommands: 0, platformRequirement: "unknown" },
  providers: [
    { role: "Lead", adapter: "claude-one-shot", version: "2.1.283", probe: { auth: { state: "authenticated", lane, detail: "claude auth status" },
      posture: { state: "attested", version: "2.1.283", detail: CANARY } } },
    { role: "Worker", adapter: "claude-one-shot", version: "2.1.283" },
    { role: "Explorer", adapter: "muse-exec", version: "1.4.0-R4302.1", probe: { auth: { state: "authenticated", lane: "subscription", detail: "account/read" } } },
    { role: "Reviewer", adapter: "muse-exec", version: "1.4.0-R4302.1", postureEvidence: "launchTime", readOnly: "eligible",
      probe: { auth: { state: "authenticated", lane: "subscription", detail: "account/read" } } }].map(provider),
  roles: {}, verificationPlatform: { assessment: { declared: "missing", effective: "unknown", signals: [] }, autonomousBackends: [] },
  writer: { code: "REAL_WRITER_MODE_NOT_READY", prerequisites: [] }, writerGates: { liveGateAuthorized: false, rows: [] }, probed: true });

test("black box: the v0.4 runner stops before any model turn unless the logins and postures are confirmed, and a saved report never runs a session",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "v04-live-pre-"));
    try {
      const run = async (name: string, value: unknown) => {
        const file = join(dir, `${name}.json`);
        await writeFile(file, typeof value === "string" ? value : JSON.stringify(value, null, 2));
        return spawnSync(process.execPath, [RUNNER, "--preconditions-from", file], { cwd: REPO, encoding: "utf8", windowsHide: true, timeout: 60_000 });
      };
      const confirmed = await run("observed", doctor("subscriptionToken"));
      assert.equal(confirmed.status, 0, confirmed.stdout + confirmed.stderr);
      assert.match(confirmed.stdout, /^ {2}PRECONDITIONS: CONFIRMED /mu);
      assert.match(confirmed.stdout, /^ {2}\(saved report: no session is run in this mode\)$/mu);
      const apiKey = await run("api-key", doctor("api"));
      assert.equal(apiKey.status, 2);
      assert.match(apiKey.stdout, /STOPPED: the required logins and postures are not confirmed: .*No model turn was spent\./u);
      const unreadable = await run("text", "binding 0: Lead via claude-one-shot\n  probe: auth authenticated (subscription login)\n");
      assert.equal(unreadable.status, 2);
      for (const out of [confirmed.stdout, apiKey.stdout, unreadable.stdout]) assert.doesNotMatch(out, /=== L\d/u, "no session started");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

test("the runner hands every [y/N] question to the maintainer and never answers one itself", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(RUNNER, "utf8");
  // The only writes to the shell's stdin: the listed lines at a `> ` prompt, and the maintainer's own answer to a [y/N] question.
  const writes = [...source.matchAll(/child\.stdin\.write\(([^)]*)\)/gu)].map(m => m[1]);
  assert.deepEqual(writes, ["`${answer}\\n`", "`${line}\\n`"]);
  assert.match(source, /const answer = await askHuman\(/u);
  assert.doesNotMatch(source, /"y"|'y'|`y`|\by\\n/u, "no scripted approval");
  // The listed lines contain no answer to a question.
  const typed = [...source.matchAll(/\[("[^\]]+")\]\);/gu)].flatMap(m => JSON.parse(`[${m[1]!}]`) as string[]);
  assert.ok(typed.length >= 8 && !typed.some(line => /^(?:y|yes|n|no)$/iu.test(line)), typed.join(" | "));
});

// ---------------------------------------------------------------- the maintainer's answer (scripts/v04-live-human.mjs)

type AskHuman = (input: NodeJS.ReadableStream, output: NodeJS.WritableStream, question: string, options?: { settleMs?: number; maxAsks?: number }) => Promise<string>;
const loadHuman = async (): Promise<AskHuman> =>
  ((await import(pathToFileURL(join(REPO, "scripts", "v04-live-human.mjs")).href)) as { askHuman: AskHuman }).askHuman;

test("L5 regression (third live run): only an explicit y or n typed after the question answers it — typed-ahead lines and empty lines never do; a closed input is No", async () => {
  const { PassThrough } = await import("node:stream");
  const askHuman = await loadHuman();
  const ask = async (before: string, after: readonly string[], end = false, options = { settleMs: 50, maxAsks: 5 }) => {
    const input = new PassThrough(), output = new PassThrough();
    let shown = "";
    output.on("data", chunk => { shown += String(chunk); });
    input.write(before);
    const answer = askHuman(input, output, "Q? ", options);
    await new Promise(resolve => setTimeout(resolve, 120));
    for (const line of after) { input.write(`${line}\n`); await new Promise(resolve => setTimeout(resolve, 20)); }
    if (end) input.end();
    return { answer: await answer, shown };
  };
  // The third run's L5: a stray Enter buffered before the question (then the maintainer's real answer).
  const strayEnter = await ask("\n", ["y"]);
  assert.deepEqual([strayEnter.answer, /\(ignored 1 line\(s\) typed before this question\)/u.test(strayEnter.shown)], ["y", true]);
  // An empty line after the question is asked again; the answer is the maintainer's own, as typed.
  const empty = await ask("", ["", "  ", "n"]);
  assert.equal(empty.answer, "n");
  assert.equal(empty.shown.split("Please type y or n").length - 1, 2, "asked again twice");
  assert.equal((await ask("", ["yes"])).answer, "yes");
  // A closed input is an empty answer (the shell's No); so is running out of asks. Never a made-up "y".
  assert.equal((await ask("", [], true)).answer, "");
  assert.equal((await ask("", ["maybe", "sure", "ok"], false, { settleMs: 50, maxAsks: 3 })).answer, "");
  // Neither the helper nor the runner contains an approval of its own.
  const { readFile } = await import("node:fs/promises");
  assert.doesNotMatch(await readFile(join(REPO, "scripts", "v04-live-human.mjs"), "utf8"), /"y"|'y'|`y`|\by\n/u);
});

test("L4 regression (third live run): the exact printed shape — an unusable falsifier reply next to one that ran — is a FAIL", async () => {
  const { judgeL4 } = await load();
  const unusable = claim("SUPPORTED", 0, 0).replace("  Fresh falsification: not run — already contradicted by Fusion's checks",
    "  Fresh falsification (reviewer (meta)): a reply that did not follow Fusion's structure (prose around the JSON); not used");
  const l4 = judgeL4([DIAGNOSIS, unusable]);
  assert.deepEqual([l4.status, l4.detail], ["FAIL", "the falsification did not run or failed: an unusable reply (prose around the JSON); 1 other falsification(s) ran"]);
});
