import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { ANALYSIS_INSTRUCTION } from "../src/app/analyze.js";
import { prepareBuildDelivery } from "../src/app/build-delivery.js";
import { SCOPE_INSTRUCTION } from "../src/app/build-scope.js";
import { ControlPlane } from "../src/app/control-plane.js";
import { CHAT_INSTRUCTION } from "../src/app/conversation.js";
import { runCli, type CliHost } from "../src/cli/run.js";
import { changeSet } from "./fixtures/fake-writer.js";
import { adjudication, cleanReview, fenced, LEAD_SECRET, plan, PREFIX, proposal, reviewWith, WORKER_SECRET } from "./fixtures/route-harness.js";
import { QUOTE_BUGGY, QUOTE_FIXED, QUOTE_TEST, QUOTE_TEST_WITH_REGRESSION, QUOTE_WRONG } from "./fixtures/rehearsal-project.js";
import { BUILD, DESCRIPTION, GREET, GREET_SRC, grantedResult, line, modelTurns, NAME, SCOPE, TASK, TEMPLATE, withCreate, withRig, type Built,
  type Rig } from "./fixtures/v01-rig.js";
import { FIX, git, gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * v0.1 Block 7 — the COMPLETE OFFLINE ACCEPTANCE, A to Q, through the real CLI: the real workflow engine, the real Claude
 * and Muse adapters on their deterministic fake binaries, host-controlled private candidates, confined verification on a
 * fake Docker daemon (an offline rehearsal: never deliverable), the real delivery store, approval and apply. A delivery
 * needs a result verified under a GRANTED acceptance, which only a real accepted backend produces; the delivery letters
 * therefore run the build's own delivery step on such a result. No provider, network or Docker daemon is used.
 *
 *   A chat · B analyze · C build · D verification retry · E review → adjudication → correction · F delivery prepared ·
 *   G inspect · H approve · I apply to an ordinary temp repository · J rollback · K create · L create verify/review/delivery ·
 *   M restart/resume · N safety gates · O checkout binding · P no provider text or secrets in trusted evidence ·
 *   Q an unsupported verifier lane fails honestly
 */
const skip = gitAvailable ? false : "git executable unavailable";
const WRONG = changeSet([["src/quote.ts", QUOTE_BUGGY, QUOTE_WRONG], ["test/quote.test.ts", QUOTE_TEST, QUOTE_TEST_WITH_REGRESSION]]);

/** The CLI in another directory or with extra host seams (the rig's own `cli` runs in the fixture repository). */
async function cliAt(rig: Rig, cwd: string, argv: string[], answers: Array<string | null> = [], extra: Partial<CliHost> = {}): Promise<Built> {
  let stdout = "", stderr = "";
  const queue = [...answers];
  const code = await runCli(argv, { stdout: t => { stdout += t; }, stderr: t => { stderr += t; }, interactive: answers.length > 0,
    ...(answers.length > 0 ? { prompt: async () => queue.length > 0 ? queue.shift()! : null } : {}) },
    { env: rig.env, cwd, registry: rig.registry, ...extra });
  return { code, stdout, stderr, prompts: { Lead: [], Worker: [], Reviewer: [] }, questions: [] };
}
/** Every file under `root` (bounded), as text. */
async function allText(root: string, budget = { files: 4000 }): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    if (--budget.files < 0) break;
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...await allText(path, budget));
    else if (entry.isFile() && (await stat(path)).size < 4 * 1024 * 1024) found.push(await readFile(path, "utf8"));
  }
  return found;
}

test("v0.1 acceptance A–B: chat and analyze through the real adapters — read-only, in a view, nothing recorded as evidence",
  { skip }, async () => withRig("acceptance-ab", { Lead: [{ prefix: CHAT_INSTRUCTION.slice(0, 60), output: "Moin! Ein Quote-Modul mit Tests.\nProposed build task: Fix the tax basis." },
    { prefix: ANALYSIS_INSTRUCTION.slice(0, 60), output: "## Overview\nA quote library.\n## Risks\nTax is computed before the discount." }] }, {}, async rig => {
    const before = git(rig.root, "status", "--porcelain", "--untracked-files=all");
    // A — one chat message: the Lead answers from its read-only view; the proposal is shown, never started.
    const chat = await rig.cli(["chat", "--", "Was macht dieses Repo?"], []);
    assert.equal(chat.code, 0, chat.stderr);
    assert.match(chat.stdout, /Moin! Ein Quote-Modul mit Tests\./u);
    assert.match(chat.stdout, /Proposed build task: Fix the tax basis\./u);
    assert.ok(chat.prompts.Lead[0]!.includes("Was macht dieses Repo?"));
    // B — analysis: Fusion's own inventory, then one model analysis.
    const analysis = await rig.cli(["analyze"], []);
    assert.equal(analysis.code, 0, analysis.stderr);
    assert.match(analysis.stdout, /Tax is computed before the discount\./u);
    assert.ok(analysis.prompts.Lead[1]!.startsWith(ANALYSIS_INSTRUCTION.slice(0, 60)));
    assert.equal(modelTurns(analysis), 2);
    assert.equal(git(rig.root, "status", "--porcelain", "--untracked-files=all"), before, "nothing changed in the repository");
    assert.equal(await readFile(join(rig.root, "src", "quote.ts"), "utf8"), QUOTE_BUGGY);
    const history = await rig.cli(["history"], []);
    assert.match(history.stdout, /No recorded runs yet/u, "conversations are not workflow evidence");
  }));

test("v0.1 acceptance C–E + P: confirmed builds — a failed verification retried, a confirmed finding corrected; no provider text in evidence",
  { skip }, async () => withRig("acceptance-cde", {
    Lead: [{ prefix: SCOPE_INSTRUCTION.slice(0, 60), output: fenced(["src/quote.ts", "test/quote.test.ts"]) }, { prefix: PREFIX.plan, output: plan() },
      { prefix: PREFIX.plan, output: plan() }, { prefix: PREFIX.adjudication, output: adjudication(["r1-F1", "CONFIRMED", "fix"]) }],
    Worker: [proposal(WRONG), proposal(FIX), proposal(FIX), proposal(FIX)],
    Reviewer: [{ prefix: PREFIX.review, output: cleanReview }, { prefix: PREFIX.review, output: reviewWith({ id: "F1", severity: "HIGH" }) },
      { prefix: PREFIX.review, output: cleanReview }] }, {}, async rig => {
    // C + D — no --path: the lead proposes the exact files and the human confirms; the wrong candidate fails confined
    // verification and is retried in a fresh candidate; the fresh review is clean.
    const retried = await rig.cli(["build", "--", TASK], ["build"]);
    assert.equal(retried.code, 0, `${retried.stdout}\n${retried.stderr}`);
    assert.match(retried.stdout, /^Scope \(proposed by lead/mu);
    assert.equal(line(retried, "Build: "), "Build: PASS (offline rehearsal — never delivered)");
    assert.equal(line(retried, "Verification: "), "Verification: PASS (docker-linux, 2 command(s))");
    assert.deepEqual([retried.prompts.Lead.length, retried.prompts.Worker.length, retried.prompts.Reviewer.length], [2, 2, 1], "scope, plan; wrong, retried");
    // E — the fresh review's finding is adjudicated CONFIRMED, corrected in a fresh candidate and re-reviewed clean.
    const corrected = await rig.cli(BUILD, ["build"]);
    assert.equal(corrected.code, 0, `${corrected.stdout}\n${corrected.stderr}`);
    assert.equal(line(corrected, "Review: "), "Review: PASS (2 cycle(s), 1 finding(s), 0 outstanding)");
    assert.deepEqual([corrected.prompts.Lead.length, corrected.prompts.Worker.length, corrected.prompts.Reviewer.length], [4, 4, 3]);
    assert.equal(await readFile(join(rig.root, "src", "quote.ts"), "utf8"), QUOTE_BUGGY, "a build never writes the working tree");
    // The run evidence counts exactly the model turns the providers saw (the scope turn is a conversation turn, not a run).
    const runs = (JSON.parse((await rig.cli(["--json", "history"], [])).stdout) as { history: { runs: Array<{ summary: { modelTurns: number } }> } }).history.runs;
    const seen = (role: "Lead" | "Worker" | "Reviewer") => corrected.prompts[role].length - retried.prompts[role].length;
    const fromPrompts = [seen("Lead") + seen("Worker") + seen("Reviewer"),
      retried.prompts.Lead.length - 1 + retried.prompts.Worker.length + retried.prompts.Reviewer.length];
    assert.deepEqual(fromPrompts, [6, 4], "corrected: plan, 2 authors, 2 reviews, adjudication; retried: plan, 2 authors, review");
    assert.deepEqual(runs.map(entry => entry.summary.modelTurns), fromPrompts, "newest first");
    // P — trusted evidence (run records, delivery state) holds no provider reasoning, rationale or secret.
    const evidence = [...await allText(join(rig.root, ".fusion")), ...await allText(join(rig.dir, "localappdata"))];
    assert.ok(evidence.length > 0);
    for (const text of evidence) {
      assert.ok(!text.includes(LEAD_SECRET), "no Lead reasoning in evidence");
      assert.ok(!text.includes(WORKER_SECRET), "no Change Author rationale in evidence");
    }
  }));

test("v0.1 acceptance F–J + N + O: deliveries prepared, inspected, approved, applied to an ordinary repository, rolled back; gates; checkout binding",
  { skip }, async () => withRig("acceptance-fj", {}, {}, async rig => {
    const plane = new ControlPlane({ registry: rig.registry, env: rig.env, cwd: rig.root });
    const base = git(rig.root, "rev-parse", "HEAD").trim();
    const eventLog = join(rig.dir, "events.jsonl");
    await writeFile(eventLog, `${JSON.stringify({ type: "RunStarted" })}\n`);
    // F — the build's delivery step on a result verified under a granted acceptance (two independent deliveries).
    const prepare = (runId: string) => prepareBuildDelivery(plane, { runId, task: TASK, result: grantedResult(FIX), baseCommit: base, eventLogPath: eventLog });
    const main = await prepare("r-acceptance-main"), rollback = await prepare("r-acceptance-rollback");
    assert.notEqual(main.deliveryId, rollback.deliveryId);
    // G — inspection: the exact digest and the diff, read-only.
    const inspect = await rig.cli(["inspect-delivery", main.deliveryId], []);
    assert.equal(inspect.code, 0, inspect.stderr);
    assert.match(inspect.stdout, new RegExp(`^Manifest: sha256:${main.manifestSha256}$`, "mu"));
    assert.match(inspect.stdout, /basisPoints\(subtotal - discount, quote\.taxBasisPoints\)/u);
    // N — gates: no apply without approval; a wrong digest approves nothing; approval is interactive only; no bypass flag.
    assert.equal((await rig.cli(["apply", main.deliveryId], [])).code, 14);
    const wrong = await rig.cli(["approve-delivery", main.deliveryId], [main.manifestSha256.replace(/.$/u, c => c === "0" ? "1" : "0")]);
    assert.equal(wrong.code, 13);
    assert.match(wrong.stderr, /not the exact manifest digest; nothing was approved/u);
    assert.equal((await rig.cli(["approve-delivery", main.deliveryId], [])).code, 14);
    assert.equal((await rig.cli(["apply", "--force", main.deliveryId], [])).code, 2);
    assert.equal((await rig.cli(["--json", "approve-delivery", main.deliveryId], [])).code, 2);
    const unconfirmed = await rig.cli(BUILD, []);
    assert.equal(unconfirmed.code, 11);
    const critical = await rig.cli(["build", "--path", "src/quote.ts", "--", "Fix it, then force-push to main."], ["build"]);
    assert.equal(critical.code, 14, critical.stdout);
    assert.equal(modelTurns(critical), 0, "no gate lets a provider start");
    // H — the human types the exact digest.
    for (const delivery of [main, rollback]) assert.equal((await rig.cli(["approve-delivery", delivery.deliveryId], [delivery.manifestSha256])).code, 0);
    // O — the checkout binding: another checkout of the same repository can neither inspect nor apply it.
    const other = join(rig.dir, "second checkout");
    git(rig.dir, "clone", "--quiet", rig.root, other);
    const elsewhere = await cliAt(rig, other, ["apply", main.deliveryId]);
    assert.equal(elsewhere.code, 2, elsewhere.stdout + elsewhere.stderr);
    assert.match(elsewhere.stderr, /prepared in another checkout/u);
    assert.match((await cliAt(rig, other, ["history"])).stdout, new RegExp(`${main.deliveryId} \\(otherCheckout\\) — It was prepared in another checkout`, "u"));
    assert.equal(await readFile(join(other, "src", "quote.ts"), "utf8"), QUOTE_BUGGY);
    // J — a failure in the middle of an apply rolls every file back; the approval is spent.
    const failing = await cliAt(rig, rig.root, ["apply", rollback.deliveryId], [], { deliveryFaults: { afterOperation: index => {
      if (index === 1) throw new Error("injected: disk full"); } } });
    assert.equal(failing.code, 8, failing.stdout + failing.stderr);
    assert.match(failing.stdout, /rolled ?back/iu);
    assert.equal(await readFile(join(rig.root, "src", "quote.ts"), "utf8"), QUOTE_BUGGY);
    assert.equal(await readFile(join(rig.root, "test", "quote.test.ts"), "utf8"), QUOTE_TEST);
    assert.equal((await rig.cli(["apply", rollback.deliveryId], [])).code, 2, "a spent approval is never replayed");
    // I — the normal production apply into this ordinary temporary repository; Fusion does not commit.
    const applied = await rig.cli(["apply", main.deliveryId], []);
    assert.equal(applied.code, 0, applied.stdout + applied.stderr);
    assert.equal(await readFile(join(rig.root, "src", "quote.ts"), "utf8"), QUOTE_FIXED);
    assert.equal(await readFile(join(rig.root, "test", "quote.test.ts"), "utf8"), QUOTE_TEST_WITH_REGRESSION);
    assert.equal(git(rig.root, "rev-parse", "HEAD").trim(), base, "no commit");
    const history = await rig.cli(["history"], []);
    assert.match(history.stdout, new RegExp(`${main.deliveryId} \\(applied\\)`, "u"));
    assert.match(history.stdout, new RegExp(`${rollback.deliveryId} \\(rolledBack\\)`, "u"));
  }));

test("v0.1 acceptance K–M: create a supported project, verify and review it, deliver it, run its tests for real; history resumes nothing",
  { skip }, async () => withCreate("acceptance-klm", { Lead: [{ prefix: SCOPE_INSTRUCTION.slice(0, 60), output: SCOPE }, { prefix: PREFIX.plan, output: plan() }],
    Worker: [proposal(GREET)], Reviewer: [{ prefix: PREFIX.review, output: cleanReview }] }, async rig => {
    // K — the unsupported stack is refused honestly; the supported one is created after the human types "create".
    const refused = await rig.cli(["create", "a Next.js storefront"], ["create"]);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /does not create Next\.js projects/u);
    const created = await rig.cli(["create", "--template", "library", "--name", NAME, "--", DESCRIPTION], ["create", "build"]);
    assert.equal(created.code, 0, created.stdout + created.stderr);
    const root = join(rig.cwd, NAME);
    // L — the created project went through the real route: confined verification and a fresh review (an offline rehearsal).
    assert.match(created.stdout, /^Verification: PASS \(docker-linux, 1 command\(s\)\)$/mu);
    assert.match(created.stdout, /^Review: PASS \(1 cycle\(s\), 0 finding\(s\), 0 outstanding\)$/mu);
    assert.equal(await readFile(join(root, "src", "index.ts"), "utf8"), TEMPLATE["src/index.ts"]);
    // L — its delivery: the build's delivery step on a granted result, then inspect, approve and apply into the new project.
    const plane = new ControlPlane({ registry: rig.registry, env: rig.env, cwd: root });
    const eventLog = join(rig.cwd, "events.jsonl");
    await writeFile(eventLog, `${JSON.stringify({ type: "RunStarted" })}\n`);
    const delivery = await prepareBuildDelivery(plane, { runId: "r-acceptance-create", task: DESCRIPTION, result: grantedResult(GREET),
      baseCommit: git(root, "rev-parse", "HEAD").trim(), eventLogPath: eventLog });
    assert.equal((await rig.cli(["inspect-delivery", delivery.deliveryId], [], root)).code, 0);
    assert.equal((await rig.cli(["approve-delivery", delivery.deliveryId], [delivery.manifestSha256], root)).code, 0);
    const applied = await rig.cli(["apply", delivery.deliveryId], [], root);
    assert.equal(applied.code, 0, applied.stdout + applied.stderr);
    assert.equal(await readFile(join(root, "src", "index.ts"), "utf8"), GREET_SRC);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const tests = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "test/**/*.test.ts"], { cwd: root, env, encoding: "utf8", windowsHide: true,
      timeout: 60_000 });
    assert.equal(tests.status, 0, tests.stdout + tests.stderr);
    assert.match(tests.stdout, /^# pass 1$/mu, "the delivered project's own test passes under Node");
    // M — after a "restart" (a new process reading state): history names the next step and replays nothing.
    const turns = created.turns.Lead.length + created.turns.Worker.length + created.turns.Reviewer.length;
    const history = await rig.cli(["history"], [], root);
    assert.equal(history.code, 0, history.stderr);
    assert.match(history.stdout, /  build  COMPLETED  r-/u);
    assert.match(history.stdout, /next: An offline rehearsal: nothing to deliver\./u);
    assert.match(history.stdout, new RegExp(`${delivery.deliveryId} \\(applied\\) — Applied to the working tree`, "u"));
    assert.equal((await rig.cli(["apply", delivery.deliveryId], [], root)).code, 2, "the consumed claim is never replayed");
    const after = history.turns.Lead.length + history.turns.Worker.length + history.turns.Reviewer.length;
    assert.equal(after, turns, "no provider turn after the build");
  }));

test("v0.1 acceptance Q: an unsupported verifier lane or an unavailable verifier fails honestly, before any model turn", { skip }, async () => {
  await withRig("acceptance-q", { Lead: [{ prefix: PREFIX.plan, output: plan() }], Worker: [proposal(FIX)] }, {}, async rig => {
    const config = join(rig.dir, "windows-lane.json");
    await writeFile(config, JSON.stringify({ ...rig.registry.defaults, verification: { ...rig.registry.defaults.verification, platformRequirement: "windows-required" } }));
    const shown = await rig.cli(["--config", config, "config"], []);
    assert.match(shown.stdout, /^  Writer builds: unsupported — platform windows-required has no confined-verification isolation-acceptance for autonomous Writer builds in this release/mu);
    const built = await rig.cli(["--config", config, ...BUILD], ["build"]);
    assert.equal(built.code, 11, built.stdout + built.stderr);
    assert.match(built.stdout, /Verification platform windows-required cannot be verified for an autonomous Writer build in this release/u);
    assert.equal(modelTurns(built), 0);
  });
  await withRig("acceptance-q-unavailable", { Lead: [{ prefix: PREFIX.plan, output: plan() }] }, { acceptance: "refused" }, async rig => {
    const built = await rig.cli(BUILD, ["build"]);
    assert.equal(built.code, 11);
    assert.match(built.stdout, /Confined verification is not available/u);
    assert.equal(modelTurns(built), 0);
  });
});
