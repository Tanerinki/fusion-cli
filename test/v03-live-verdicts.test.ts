import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { newSessionState, planTurn } from "../src/app/session.js";
import { classifyIntent } from "../src/core/intent.js";

/**
 * v0.3 — the live acceptance's L2 and L4 VERDICTS (scripts/v03-live-verdicts.mjs) and the analysis → verification → fix
 * handoff they check, pinned against the maintainer's REAL run of 2026-09-28 (transcript fusion-v03-live-2026-09-28T01-05-40-528Z):
 *
 *   L2: FAIL although the route recovered by design — `3 parallel investigations (2 failed) → 2 repeats → lead synthesis →
 *       fresh review`, `3 of 3 answered`, clone unchanged. The runner's regex required `parallel investigations → `, so the
 *       documented bounded repeat ("(2 failed) → 2 repeats") could never pass. Now judged by the route contract.
 *   L4: evidence=NO — the lead verified the trusted_proxies finding ITSELF (`lead decision (answer directly) → lead
 *       answer`, citing configuration.yaml and home-assistant.log), and the session kept evidence from investigations only:
 *       the change task carried nothing of the verification. Now the task carries the verification's host-checked
 *       citations, and the runner checks they are exactly what the verification cited, for the same finding.
 *
 * The segments below are the real run's own lines (model text replaced by a placeholder).
 */
type Verdict = { status: string; detail: string };
type Verdicts = { judgeL2(segment: string, unchanged: boolean): Verdict; l2Lines(segment: string): string[];
  judgeL4Evidence(verification: string, change: string): { ok: boolean; detail: string } };
const load = async (): Promise<Verdicts> => await import(pathToFileURL(join(resolve(process.cwd()), "scripts", "v03-live-verdicts.mjs")).href) as Verdicts;

const l2 = (route: string, explorers: string, extra: readonly string[] = []) => ["Looking at copy (read-only)…", "", "(the synthesis: model text)", "",
  "  — lead · Claude (claude-opus-5-5), with 3 investigation reports; model output, not verified by Fusion", `  Route: ${route}`,
  "  Turns: 8 model turns (lead 2 · explorers 5 · reviewer 1) · 1 batch (1 parallel) · 2 repeats · 2 failed · 191 s",
  "  Planning: Claude selected 3 investigation areas (src/, test/, docs/).",
  "  (the explorer binding's read-only posture is not proven on this runtime, so it was not used; the reviewer binding explored instead)",
  `  Explorer investigations: ${explorers}`, ...extra, "", "Second opinion — reviewer · Muse (muse-spark-1.3):", "(the critique: model text)", ""].join("\n");
const REAL_L2 = l2("lead decision → 3 parallel investigations (2 failed) → 2 repeats → lead synthesis → fresh review",
  "3 of 3 answered (src/ by reviewer (meta), test/ by reviewer (meta), docs/ by reviewer (meta))");

test("L2 regression: the real recovered route (2 failed, 2 repeats, 3 of 3 answered) is a PASS by the documented contract; the old regex failed it", async () => {
  const { judgeL2, l2Lines } = await load();
  const route = /^ {2}Route: .+$/mu.exec(REAL_L2)![0].trim();
  assert.equal(/parallel investigations → .*lead synthesis → fresh review/u.test(route), false, "the old runner's predicate: FAIL on the real route");
  assert.deepEqual(judgeL2(REAL_L2, true), { status: "PASS",
    detail: "parallel investigations with bounded recovery (2 failed, 2 repeated once, 3 of 3 answered), lead synthesis, fresh review; clone unchanged: true" });
  // The recovery is only valid with the clone unchanged.
  assert.deepEqual(judgeL2(REAL_L2, false), { status: "FAIL", detail: "the clone changed" });
  // The pasted summary now carries each failed attempt's category (the product prints them since this fix).
  const withCategories = l2("lead decision → 3 parallel investigations (2 failed) → 2 repeats → lead synthesis → fresh review", "3 of 3 answered (…)",
    ["  (explorer for src: attempt 1 failed — provider failure: Muse Exec reported a failed turn. It was repeated once and answered.)"]);
  assert.ok(l2Lines(withCategories).includes("(explorer for src: attempt 1 failed — provider failure: Muse Exec reported a failed turn. It was repeated once and answered.)"));
});

test("L2: an investigation that never answered FAILS — after a failed repeat, or when its failure was not repeatable", async () => {
  const { judgeL2 } = await load();
  const repeatFailed = l2("lead decision → 3 parallel investigations (2 failed) → 2 repeats (1 failed) → lead evidence review → lead synthesis → fresh review",
    "2 of 3 answered (test/ by reviewer (meta), docs/ by reviewer (meta))", ["  (explorer for src failed: provider failure: Muse Exec reported a failed turn.)",
      "  Evidence: incomplete (failed investigations)."]);
  assert.deepEqual(judgeL2(repeatFailed, true), { status: "FAIL",
    detail: "1 of 3 investigation(s) never answered, after the bounded repeat (see the explorer lines)" });
  const notRepeatable = l2("lead decision → 3 parallel investigations (1 failed) → lead evidence review → lead synthesis → fresh review",
    "2 of 3 answered (…)", ["  (explorer for docs failed: authentication: The account login changed.)"]);
  assert.equal(judgeL2(notRepeatable, true).status, "FAIL");
});

test("L2: the other outcomes keep their meaning — clean PASS, answer-directly CHECK, a failed critique or stage FAIL, no unbounded repeats", async () => {
  const { judgeL2 } = await load();
  assert.deepEqual(judgeL2(l2("lead decision → 3 parallel investigations → lead synthesis → fresh review", "3 of 3 answered (…)"), true),
    { status: "PASS", detail: "parallel investigations, lead synthesis, fresh review; clone unchanged: true" });
  assert.equal(judgeL2(l2("lead decision (answer directly) → lead answer", "0 of 0 answered"), true).status, "CHECK");
  assert.match(judgeL2(l2("lead decision → 3 parallel investigations → lead synthesis → fresh review (failed)", "3 of 3 answered (…)"), true).detail,
    /did not end with lead synthesis → fresh review/u, "a failed fresh review is not a fresh review");
  assert.equal(judgeL2(l2("lead decision → 3 investigations → lead synthesis → fresh review", "3 of 3 answered (…)"), true).status, "FAIL", "not parallel");
  assert.match(judgeL2(l2("lead decision → 3 parallel investigations (1 failed) → 2 repeats → lead synthesis → fresh review", "3 of 3 answered (…)"), true).detail,
    /more repeats than failed investigations/u);
  assert.deepEqual(judgeL2(`fusion: The lead's synthesis failed after 3 of 3 investigation report(s): x\n${REAL_L2}`, true),
    { status: "FAIL", detail: "fusion: The lead's synthesis failed after 3 of 3 investigation report(s): x" });
});

// ---------------------------------------------------------------- L4: the real verification and change segments

const CLAIM = "`configuration.yaml`: `use_x_forwarded_for` without `trusted_proxies` makes the `http:` section invalid (the log confirms the error).";
const REAL_VERIFICATION = [`Checking whether this holds (read-only): ${CLAIM}`, "", "(the lead's verification: model text)", "",
  "  — lead · Claude (claude-opus-5-5); model output, not verified by Fusion", "  Route: lead decision (answer directly) → lead answer",
  "  Turns: 2 model turns (lead 2) · 55 s", "  Planning: Claude decided to answer directly (no investigation needed).", "", "Coverage (what Fusion can vouch for):",
  "  Inventoried: 14 files in this repository",
  "  Shared with the AI models: 9 files as they are, 3 with secret values masked, 2 withheld (.storage/auth, .storage/core.config_entries)",
  "  Cited in the final answer: 2 files from the shared copy (configuration.yaml, home-assistant.log)", "  Not cited: .storage/, custom_components/, packages/", "",
  "Next: \"fix it\" prepares a verified change for this finding (you confirm first).", ""].join("\n");
const change = (evidence: string | undefined, finding = CLAIM) => [`Preparing a verified change: Fix this finding from the analysis: ${finding}`,
  "Fusion changes a private copy, verifies it in a sandbox, has it reviewed fresh, and asks you before touching your files.", "Build plan",
  `Task: Fix this finding from the analysis: ${finding}`, ...(evidence === undefined ? [] : ["", evidence]),
  "Scope (proposed by lead (claude); confirm or rerun with --path): configuration.yaml", ""].join("\n");

test("L4 regression: the real run's change task carried NO evidence of the lead's own verification — evidence=NO was a true finding", async () => {
  const { judgeL4Evidence } = await load();
  assert.deepEqual(judgeL4Evidence(REAL_VERIFICATION, change(undefined)), { ok: false, detail: "the change task carries no evidence of the verification" });
  // With the fix, the task carries exactly the verification's host-checked citations, for the same finding.
  assert.deepEqual(judgeL4Evidence(REAL_VERIFICATION, change("(Fusion's verification of this finding cited: configuration.yaml, home-assistant.log)")),
    { ok: true, detail: "verification: configuration.yaml, home-assistant.log" });
});

test("L4 evidence is mechanical: the same finding, the verification's own citations, the right source — nothing else counts", async () => {
  const { judgeL4Evidence } = await load();
  assert.equal(judgeL4Evidence(REAL_VERIFICATION, change("(Fusion's verification of this finding cited: configuration.yaml)")).ok, false, "a partial list");
  assert.equal(judgeL4Evidence(REAL_VERIFICATION, change("(Fusion's verification of this finding cited: automations.yaml, configuration.yaml)")).ok, false,
    "files the verification never cited");
  assert.equal(judgeL4Evidence(REAL_VERIFICATION, change("(Fusion's investigation of this finding cited: configuration.yaml, home-assistant.log)")).ok, false,
    "an investigation the verification did not run");
  assert.match(judgeL4Evidence(REAL_VERIFICATION, change("(Fusion's verification of this finding cited: configuration.yaml, home-assistant.log)",
    "`automations.yaml`: two automations share the ID `motion_hallway`.")).detail, /not bound to the verified finding/u, "another finding");
  assert.equal(judgeL4Evidence("  Route: lead only", change("(Fusion's verification of this finding cited: configuration.yaml)")).ok, false, "no verification");
  // An investigation-based verification (black box F's shape): the route ran investigations and checked the claim.
  const investigated = [`Checking whether this holds (read-only): ${CLAIM}`, "  Route: lead decision → 2 parallel investigations → lead synthesis → fresh review",
    "  Claim checked: 2 investigation(s) support it, 0 contradict it, 0 leave it open.", ""].join("\n");
  assert.deepEqual(judgeL4Evidence(investigated, change("(Fusion's investigation of this finding cited: configuration.yaml)")),
    { ok: true, detail: "investigation: configuration.yaml" });
  // A long citation list is shown truncated in the coverage line: the task's first files must be exactly the ones shown.
  const many = REAL_VERIFICATION.replace("2 files from the shared copy (configuration.yaml, home-assistant.log)",
    "7 files from the shared copy (a.yaml, b.yaml, c.yaml, d.yaml, e.yaml, f.yaml, …)");
  assert.equal(judgeL4Evidence(many, change("(Fusion's verification of this finding cited: a.yaml, b.yaml, c.yaml, d.yaml, e.yaml, f.yaml, g.yaml)")).ok, true);
  assert.equal(judgeL4Evidence(many, change("(Fusion's verification of this finding cited: b.yaml, a.yaml, c.yaml, d.yaml, e.yaml, f.yaml, g.yaml)")).ok, false);
});

test("handoff: \"fix it\" after a verification carries that verification's host evidence, labelled by who cited it; only for the verified finding", () => {
  const state = newSessionState();
  state.findings = ["`home-assistant.log`: a bearer token is logged.", CLAIM];
  state.focus = 1;
  state.verified = { index: 1, source: "lead", cited: ["configuration.yaml", "home-assistant.log"], supported: 0, contradicted: 0 };
  const fix = planTurn(classifyIntent("fix it"), state, "git");
  assert.deepEqual(fix, { kind: "change", task: `Fix this finding from the analysis: ${CLAIM}\n\n(Fusion's verification of this finding cited: configuration.yaml, home-assistant.log)` });
  state.verified = { ...state.verified, source: "investigations" };
  assert.match((planTurn(classifyIntent("fix it"), state, "git") as { task: string }).task, /\n\n\(Fusion's investigation of this finding cited: configuration\.yaml, home-assistant\.log\)$/u);
  // Another finding, or a verification that cited nothing: no evidence line; a folder is still blocked.
  assert.equal((planTurn(classifyIntent("fix the first one"), state, "git") as { task: string }).task, `Fix this finding from the analysis: ${state.findings[0]}`);
  state.verified = { ...state.verified, cited: [] };
  state.focus = 1;
  assert.equal((planTurn(classifyIntent("fix it"), state, "git") as { task: string }).task, `Fix this finding from the analysis: ${CLAIM}`);
  assert.equal(planTurn(classifyIntent("fix it"), state, "folder").kind, "blocked");
});
