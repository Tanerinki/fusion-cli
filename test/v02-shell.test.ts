import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { test } from "node:test";
import { prepareBuildDelivery } from "../src/app/build-delivery.js";
import { SCOPE_INSTRUCTION } from "../src/app/build-scope.js";
import { ControlPlane } from "../src/app/control-plane.js";
import { deliveryRepository, recordSummaryApproval } from "../src/app/delivery-service.js";
import { CRITIQUE_INSTRUCTION, EXPLORER_INSTRUCTION, LEAD_PLAN_INSTRUCTION, SHELL_ANALYSIS_INSTRUCTION, SYNTHESIS_INSTRUCTION } from "../src/app/exploration.js";
import type { ProviderRegistry } from "../src/app/providers.js";
import { newSessionState, sessionMetadataPath, writeSessionMetadata } from "../src/app/session.js";
import { APPLY_QUESTION, PLAN_QUESTION } from "../src/cli/build-flow.js";
import { runCli, type CliHost } from "../src/cli/run.js";
import { NO_GIT_BLOCK, SHELL_HELP, SHELL_PROMPT } from "../src/cli/shell.js";
import { FusionFailure } from "../src/core/errors.js";
import { fakeConversationRegistry, type FakeTurn } from "./fixtures/fake-conversation.js";
import { createHomeAssistantFixture, HA_SENTINELS } from "./fixtures/home-assistant.js";
import { cleanReview, fenced, plan, PREFIX, proposal } from "./fixtures/route-harness.js";
import { QUOTE_BUGGY, QUOTE_FIXED } from "./fixtures/rehearsal-project.js";
import { grantedResult, line, TASK, withRig } from "./fixtures/v01-rig.js";
import { FIX, git, gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * v0.2 — the conversational shell (`fusion` without a command) through the REAL CLI, offline: a fake conversation registry
 * that records what every provider turn could read, a synthetic Home Assistant folder with sentinel secrets, a synthetic
 * large repository, and the v0.1 product rig (real adapters on scripted fake binaries, host-controlled candidates, confined
 * verification on a fake daemon) for the change and apply transitions.
 *
 *   A  Home Assistant (no Git): analyze → explain → plan → "fix it" is blocked, zero writes, no secret reaches a provider
 *   B  a Git project: a change request enters the confirmed Writer route (declined; and the real route end to end)
 *   C  a large repository: team exploration with isolated packets, a fresh critique and an honest coverage summary
 *   D  "without all that safety stuff" is refused
 *   plus: start/help/exit, cancellation, unavailable providers, the read-only proofs, the simplified approval and apply.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const kind = (expected: string) => (error: unknown) => error instanceof FusionFailure && error.error.kind === expected;
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

interface Ran { code: number; stdout: string; stderr: string; questions: string[] }
async function shell(cwd: string, registry: ProviderRegistry, lines: Array<string | null>, env: NodeJS.ProcessEnv, extra: Partial<CliHost> = {},
  argv: string[] = []): Promise<Ran> {
  let stdout = "", stderr = "";
  const queue = [...lines], questions: string[] = [];
  const code = await runCli(argv, { stdout: t => { stdout += t; }, stderr: t => { stderr += t; }, interactive: true,
    prompt: async question => { questions.push(question); return queue.length > 0 ? queue.shift()! : null; } }, { env, cwd, registry, ...extra });
  return { code, stdout, stderr, questions };
}
async function once(argv: string[], cwd: string, registry: ProviderRegistry, env: NodeJS.ProcessEnv): Promise<Ran> {
  let stdout = "", stderr = "";
  const code = await runCli(argv, { stdout: t => { stdout += t; }, stderr: t => { stderr += t; } }, { env, cwd, registry });
  return { code, stdout, stderr, questions: [] };
}
async function withDir<T>(work: (dir: string, env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "v02-shell-")));
  try { return await work(dir, { ...process.env, LOCALAPPDATA: join(dir, "state-local"), XDG_STATE_HOME: join(dir, "state-xdg") }); }
  finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}
/** Every file (path and digest) under `root` except Git internals, plus the Git status when it is a repository. */
async function tree(root: string): Promise<string> {
  const out: string[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const rel = relative(root, join(entry.parentPath, entry.name)).split(sep).join("/");
    if (rel === ".git" || rel.startsWith(".git/")) continue;
    out.push(entry.isFile() ? `${rel}:${sha256(await readFile(join(entry.parentPath, entry.name)))}` : `${rel}/`);
  }
  const isGit = await lstat(join(root, ".git")).then(() => true, () => false);
  return out.sort().join("\n") + (isGit ? git(root, "status", "--porcelain=v1", "-uall", "--ignored") : "");
}
async function gitProject(dir: string, files: Readonly<Record<string, string>>, name = "my project"): Promise<string> {
  const root = join(dir, name);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, ...path.split("/"))), { recursive: true });
    await writeFile(join(root, ...path.split("/")), content);
  }
  git(root, "init", "-q"); git(root, "add", "."); git(root, "commit", "-qm", "initial");
  return root;
}
const SHOP: Readonly<Record<string, string>> = { ".gitignore": ".env\n", "package.json": JSON.stringify({ name: "shop", scripts: { test: "node --test" } }),
  "src/index.ts": "export {};\n", "src/orders/service.ts": "export const total = 1;\n", "README.md": "# Shop\n" };
const removed = async (path: string): Promise<boolean> => lstat(path).then(() => false, () => true);
const leaks = (turns: readonly FakeTurn[], secrets: readonly string[]): string[] =>
  secrets.filter(secret => turns.some(turn => JSON.stringify(turn.request).includes(secret) || turn.viewText.includes(secret)));

// ---------------------------------------------------------------- start, help, exit

test("v0.2 shell: `fusion` starts the shell at an interactive terminal only; help, exit, quit and end of input leave cleanly", { skip }, async () =>
  withDir(async (dir, env) => {
    const root = await gitProject(dir, SHOP);
    const { registry, turns } = fakeConversationRegistry();
    const ran = await shell(root, registry, ["help", "?", "/help", "quit", "never read"], env);
    assert.equal(ran.code, 0, ran.stderr);
    const [first, second, third, fourth] = ran.stdout.split("\n");
    assert.equal(first, `Fusion · ${root}`);
    assert.match(second!, /^Git repository · 5 files$/u);
    assert.equal(third, "Alpha + Beta available");
    assert.equal(fourth, "Read-only until you request a change.");
    assert.equal(ran.stdout.split(SHELL_HELP).length - 1, 3);
    assert.deepEqual(ran.questions, [SHELL_PROMPT, SHELL_PROMPT, SHELL_PROMPT, SHELL_PROMPT], "nothing after quit is read");
    assert.equal(turns.length, 0, "help and exit start no provider");
    // End of input (or Ctrl+C at the prompt) ends the session cleanly too.
    assert.equal((await shell(root, registry, [], env)).code, 0);
    assert.equal((await shell(root, registry, ["exit"], env)).code, 0);
    // Non-interactive, or with --json: still a usage error (scripts keep their exit code).
    const piped = await once([], root, registry, env);
    assert.equal(piped.code, 2);
    assert.match(piped.stderr, /missing command\. Run `fusion` without arguments in an interactive terminal/u);
    assert.equal((await shell(root, registry, ["hi"], env, {}, ["--json"])).code, 2);
    // The expert commands are unchanged.
    assert.equal((await once(["history"], root, registry, env)).code, 0);
    assert.equal((await once(["--version"], root, registry, env)).code, 0);
  }));

// ---------------------------------------------------------------- A: Home Assistant

const HA_ANALYSIS = ["This is a Home Assistant configuration with automations, scripts, scenes, one package and a custom integration.", "",
  "Findings:",
  "1. configuration.yaml: http.use_x_forwarded_for is on but trusted_proxies is missing, so the http integration fails to load.",
  "2. automations.yaml: the sunset automation targets light.livingroom_lamp, but the entity is light.living_room_lamp.",
  "3. automations.yaml: two automations share the id motion_hallway.",
  "4. custom_components/example/manifest.json: the required version key is missing."].join("\n");

test("v0.2 acceptance A: a Home Assistant folder without Git — analysis, follow-ups and a plan are read-only; \"fix it\" is blocked with zero writes; no secret reaches a provider",
  { skip }, async () => withDir(async (dir, env) => {
    const root = await createHomeAssistantFixture(dir);
    const before = await tree(root);
    const { registry, turns } = fakeConversationRegistry({ replies: { Lead: [HA_ANALYSIS,
      "Home Assistant only trusts X-Forwarded-For headers from proxies listed under http.trusted_proxies; without them it refuses the setting.",
      "I would add http.trusted_proxies with your proxy's address to configuration.yaml.\nProposed build task: Add http.trusted_proxies to configuration.yaml."] } });
    const ran = await shell(root, registry, ["Analyze this Home Assistant configuration", "Explain the first problem", "What would you change?", "Fix it", "exit"], env);
    assert.equal(ran.code, 0, ran.stderr);
    // The welcome tells the truth about the folder.
    assert.match(ran.stdout, /^Folder, not a Git repository · Home Assistant configuration · 13 files · 4 sensitive files kept private$/mu);
    assert.match(ran.stdout, /^Read-only: this folder has no Git baseline, so Fusion will analyze it but not change it\.$/mu);
    // Three read-only turns with the lead only (a small folder needs no team); "Fix it" started none.
    assert.deepEqual(turns.map(t => [t.role, t.request.purpose]), [["Lead", "analysis"], ["Lead", "chat"], ["Lead", "chat"]]);
    const [analysis, explain, planned] = turns;
    assert.equal(analysis!.request.instruction, SHELL_ANALYSIS_INSTRUCTION);
    assert.match(analysis!.request.context, /^Folder: homeassistant \(13 files, not a Git repository\)$/mu);
    assert.match(analysis!.request.context, /^Detected: Home Assistant configuration \(/mu);
    assert.match(analysis!.request.context, /^Not shared in full with AI models: 4 sensitive file\(s\) — .*\.storage\/ \(withheld\).*secrets\.yaml \(key names only\)/mu);
    assert.match(explain!.request.message, /^Explain the first problem\n\n\(The user refers to this finding from the earlier analysis:\n1\. configuration\.yaml: http\.use_x_forwarded_for/u);
    assert.equal(explain!.request.history.length, 2, "the analysis is the context of the follow-up");
    assert.equal(planned!.request.message, "What would you change?");
    // Output: the analysis, the coverage account, the suggestion, and the block.
    assert.match(ran.stdout, /^Coverage \(what Fusion can vouch for\):$/mu);
    assert.match(ran.stdout, /^ {2}Inventoried: 13 files in this folder$/mu);
    assert.match(ran.stdout, /^ {2}Shared with the AI models: 7 files as they are, 3 with secret values masked, 3 withheld \(\.storage\/auth, \.storage\/core\.config_entries, home-assistant_v2\.db\)$/mu);
    assert.match(ran.stdout, /^ {2}Cited in the answer: 3 files \(automations\.yaml, configuration\.yaml, custom_components\/example\/manifest\.json\)$/mu);
    assert.match(ran.stdout, /Fusion cannot see which files a model opened/u);
    assert.match(ran.stdout, /^Suggested change: Add http\.trusted_proxies to configuration\.yaml\.$/mu);
    assert.ok(ran.stdout.includes(`${NO_GIT_BLOCK}\nWhy: without Git`), ran.stdout);
    assert.match(ran.stdout, /^The change you asked for: Fix this finding from the analysis: configuration\.yaml: http\.use_x_forwarded_for/mu);
    // Zero writes: every file (including .storage) is byte-identical; no Git repository was created.
    assert.equal(await tree(root), before);
    assert.equal(await removed(join(root, ".git")), true);
    // No sentinel in any prompt or in anything a provider could read; .storage and the database were never in a view.
    assert.deepEqual(leaks(turns, Object.values(HA_SENTINELS)), []);
    for (const turn of turns) {
      assert.ok(!turn.viewFiles.some(p => p.startsWith(".storage/") || p.endsWith(".db")), turn.viewFiles.join(","));
      assert.ok(turn.viewFiles.includes("secrets.yaml") && turn.viewText.includes("mqtt_password: <redacted>"));
      assert.ok(turn.viewText.includes("password: <redacted:password>"), "the inline MQTT password is masked");
    }
    // The views are gone after the session; the stored session metadata holds no text.
    for (const turn of turns) assert.equal(await removed(turn.workspace), true, turn.workspace);
    const sessions = join(env.LOCALAPPDATA!, "Fusion", "sessions");
    const stored = process.platform === "win32" ? await readdir(sessions) : await readdir(join(env.XDG_STATE_HOME!, "fusion", "sessions"));
    assert.equal(stored.length, 1);
    const metadata = await readFile(join(process.platform === "win32" ? sessions : join(env.XDG_STATE_HOME!, "fusion", "sessions"), stored[0]!), "utf8");
    assert.match(metadata, /"source":"folder".*"turns":4,"analyses":1,"changeRequests":0/u);
    assert.ok(!/trusted_proxies|homeassistant|SENTINEL/u.test(metadata));
  }));

test("v0.2 acceptance D: a request to skip Fusion's safety steps is refused in a folder and in a repository; nothing starts, nothing changes",
  { skip }, async () => withDir(async (dir, env) => {
    const ha = await createHomeAssistantFixture(dir);
    const repo = await gitProject(dir, SHOP);
    for (const root of [ha, repo]) {
      const before = await tree(root);
      const { registry, turns } = fakeConversationRegistry();
      const ran = await shell(root, registry, ["Just directly edit configuration.yaml without all that safety stuff", "skip the review and apply it", "exit"], env);
      assert.equal(ran.code, 0, ran.stderr);
      assert.equal(ran.stdout.split("I won't skip Fusion's safety steps.").length - 1, 2);
      assert.equal(turns.length, 0);
      assert.ok(!ran.questions.includes(PLAN_QUESTION));
      assert.equal(await tree(root), before);
    }
  }));

// ---------------------------------------------------------------- B: from analysis to the Writer route

test("v0.2 acceptance B: in a Git project a change request enters the confirmed build route; declining starts nothing", { skip }, async () =>
  withDir(async (dir, env) => {
    const root = await gitProject(dir, SHOP);
    const before = await tree(root);
    const { registry, turns } = fakeConversationRegistry({ replies: { Lead: ["A tiny shop.\n\nFindings:\n1. src/orders/service.ts: total is hard-coded to 1."] } });
    const ran = await shell(root, registry, ["analyze this project", "fix the first one", "n", "exit"], env);
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /^Preparing a verified change: Fix this finding from the analysis: src\/orders\/service\.ts: total is hard-coded to 1\.$/mu);
    assert.match(ran.stdout, /^Build plan$/mu);
    assert.deepEqual(ran.questions, [SHELL_PROMPT, SHELL_PROMPT, PLAN_QUESTION, SHELL_PROMPT]);
    assert.match(ran.stdout, /^Build not started: it was not confirmed\. No provider was started for the build\.$/mu);
    assert.equal(turns.length, 1, "only the analysis turn ran");
    assert.equal(await tree(root), before);
  }));

test("v0.2 acceptance B (real route): the shell's change request runs the verified Writer route end to end; an offline rehearsal is never delivered",
  { skip }, async () => {
    const scope = { prefix: SCOPE_INSTRUCTION.slice(0, 60), output: fenced(["src/quote.ts", "test/quote.test.ts"]) };
    await withRig("shell-build", { Lead: [scope, { prefix: PREFIX.plan, output: plan() }], Worker: [proposal(FIX)],
      Reviewer: [{ prefix: PREFIX.review, output: cleanReview }] }, {}, async rig => {
      const ran = await rig.cli([], [TASK, "y", "exit"]);
      assert.equal(ran.code, 0, `${ran.stdout}\n${ran.stderr}`);
      assert.match(ran.stdout, /^Preparing a verified change: Fix quote totals: tax applies to the discounted subtotal\. Add a regression test\.$/mu);
      assert.match(ran.stdout, /^Scope \(proposed by lead \([^)]+\); confirm or rerun with --path\): src\/quote\.ts, test\/quote\.test\.ts$/mu);
      assert.deepEqual(ran.questions, [SHELL_PROMPT, PLAN_QUESTION, SHELL_PROMPT]);
      assert.equal(line(ran, "Build: "), "Build: PASS (offline rehearsal — never delivered)");
      assert.equal(line(ran, "Review: "), "Review: PASS (1 cycle(s), 0 finding(s), 0 outstanding)");
      assert.match(ran.stdout, /^No change was prepared, so nothing can be applied\. Your files are unchanged\.$/mu);
      assert.deepEqual([ran.prompts.Lead.length, ran.prompts.Worker.length, ran.prompts.Reviewer.length], [2, 1, 1]);
      assert.equal(await readFile(join(rig.root, "src", "quote.ts"), "utf8"), QUOTE_BUGGY, "the working tree is never touched by a build");
    });
  });

test("v0.2 simplified approval: one summary and an explicit yes approve and apply exactly the prepared delivery; anything else approves nothing",
  { skip }, async () => withRig("shell-apply", {}, {}, async rig => {
    const plane = new ControlPlane({ registry: rig.registry, env: rig.env, cwd: rig.root });
    const base = git(rig.root, "rev-parse", "HEAD").trim();
    const eventLog = join(rig.dir, "events.jsonl");
    await writeFile(eventLog, `${JSON.stringify({ type: "RunStarted" })}\n`);
    const delivery = await prepareBuildDelivery(plane, { runId: "r-shell-apply", task: TASK, result: grantedResult(FIX), baseCommit: base, eventLogPath: eventLog });
    // A shell session prepared it (only its id is remembered).
    const state = newSessionState();
    state.deliveryId = delivery.deliveryId;
    const runtime = await plane.runtime();
    assert.equal(await writeSessionMetadata(sessionMetadataPath(rig.env, runtime.repository.root!), "git", state), true);
    const declined = await rig.cli([], ["apply", "no", "exit"]);
    assert.equal(declined.code, 0, declined.stdout + declined.stderr);
    assert.match(declined.stdout, new RegExp(`^A verified change from your last session is waiting: ${delivery.deliveryId} \\(say "apply" to review it\\)\\.$`, "mu"));
    for (const expected of ["Ready to apply verified changes", "  2 files changed:", "    src/quote.ts (changed)", "    test/quote.test.ts (changed)",
      "  Verification: PASS (1 command in docker-linux, osSandbox)", "  Review: not required (0 review cycles, no open findings)", `  Delivery: ${delivery.deliveryId}`,
      `  Manifest: sha256:${delivery.manifestSha256}`])
      assert.ok(declined.stdout.split("\n").includes(expected), `${expected}\n${declined.stdout}`);
    assert.deepEqual(declined.questions, [SHELL_PROMPT, APPLY_QUESTION, SHELL_PROMPT]);
    assert.match(declined.stdout, /^Not applied\. The delivery stays ready: fusion approve-delivery d-/mu);
    assert.equal(await readFile(join(rig.root, "src", "quote.ts"), "utf8"), QUOTE_BUGGY);
    // The shown digest must still be the stored one; only an explicit yes approves.
    const repository = await deliveryRepository(plane);
    await assert.rejects(recordSummaryApproval(repository, delivery.deliveryId, "0".repeat(64), "y"), kind("SecurityViolation"));
    for (const answer of ["", "n", "yes please", delivery.manifestSha256])
      assert.deepEqual(await recordSummaryApproval(repository, delivery.deliveryId, delivery.manifestSha256, answer),
        { approved: false, manifestSha256: delivery.manifestSha256 }, answer);
    // The declined offer is still waiting in the next session; yes applies it (precheck, single-use claim), without a commit.
    const applied = await rig.cli([], ["apply", "y", "exit"]);
    assert.equal(applied.code, 0, applied.stdout + applied.stderr);
    assert.match(applied.stdout, /^Result: applied \(phase done\)$/mu);
    assert.match(applied.stdout, /^Approval: human-confirmed \(confirmedVerifiedSummary\) at .+, for this delivery and checkout only$/mu);
    assert.match(applied.stdout, /^Applied\. The changes are in your working tree, uncommitted/mu);
    assert.equal(await readFile(join(rig.root, "src", "quote.ts"), "utf8"), QUOTE_FIXED);
    assert.equal(git(rig.root, "rev-parse", "HEAD").trim(), base, "no commit");
    assert.match((await rig.cli(["inspect-delivery", delivery.deliveryId], [])).stdout, /^State: applied$/mu);
    assert.equal((await rig.cli(["apply", delivery.deliveryId], [])).code, 2, "a spent approval is never replayed");
    // Nothing is left to offer.
    const after = await rig.cli([], ["apply", "exit"]);
    assert.match(after.stdout, /^There is no prepared change to apply in this session\./mu);
  }));

// ---------------------------------------------------------------- C: a large repository

test("v0.2 acceptance C: a large repository is explored as a team — lead plan, isolated explorer packets, synthesis, a fresh critique — with an honest coverage summary",
  { skip }, async () => withDir(async (dir, env) => {
    const files: Record<string, string> = { "package.json": JSON.stringify({ name: "big", main: "src/index.ts" }), "README.md": "# Big\n", "src/index.ts": "export {};\n",
      "config/secrets.yaml": "db_password: LARGE-SENTINEL-yaml-4411\n", "deploy/site.key": "LARGE-SENTINEL-key-5522\n" };
    for (let m = 0; m < 10; m++) for (let f = 0; f < 25; f++) files[`src/module${m}/file${f}.ts`] = `export const v${m}_${f} = ${f};\n`;
    for (let i = 0; i < 80; i++) files[`lib/util${i}.ts`] = `export const u${i} = ${i};\n`;
    for (let i = 0; i < 40; i++) files[`docs/page${i}.md`] = `# Page ${i}\n`;
    for (let i = 0; i < 60; i++) files[`test/t${i}.test.ts`] = "import 'node:test';\n";
    const root = await gitProject(dir, files, "big");
    const before = await tree(root);
    const packets = JSON.stringify({ packets: [{ area: "src", question: "Which modules handle input, and is any of it unchecked?" },
      { area: "lib", question: "Are the utilities covered by tests?" }] });
    const synthesis = "The project is a TypeScript library; src/module1/file1.ts and lib/util3.ts matter most.\n\nFindings:\n" +
      "1. src/module1/file1.ts: input is not validated.\n2. lib/util3.ts: no test covers it.";
    const { registry, turns } = fakeConversationRegistry({ replies: {
      Lead: [packets, synthesis],
      Explorer: ["src: src/module1/file1.ts reads input without checks. EXPLORER-ONLY-DETAIL-1", "lib: lib/util3.ts has no test. EXPLORER-ONLY-DETAIL-2"],
      Reviewer: ["The claim about src/module1/file1.ts holds; the analysis did not look at docs/."] } });
    const ran = await shell(root, registry, ["analyze the whole repository", "exit"], env);
    assert.equal(ran.code, 0, ran.stderr);
    assert.deepEqual(turns.map(t => t.role), ["Lead", "Explorer", "Explorer", "Lead", "Reviewer"]);
    const [leadPlan, src, lib, synth, critique] = turns;
    assert.equal(leadPlan!.request.instruction, LEAD_PLAN_INSTRUCTION);
    assert.equal(leadPlan!.request.history.length, 0);
    for (const [turn, area] of [[src!, "src"], [lib!, "lib"]] as const) {
      assert.equal(turn.request.instruction, EXPLORER_INSTRUCTION);
      assert.equal(turn.request.history.length, 0, "an explorer packet carries no transcript");
      assert.match(turn.request.context, new RegExp(`^Area: ${area}/ \\(\\d+ file\\(s\\)\\)$`, "mu"));
      assert.ok(!turn.request.context.includes("analyze the whole repository"), "only its packet");
    }
    assert.match(src!.request.context, /^Area: src\/ \(251 file\(s\)\)$/mu);
    assert.equal(synth!.request.instruction, SYNTHESIS_INSTRUCTION);
    assert.ok(synth!.request.context.includes("EXPLORER-ONLY-DETAIL-1") && synth!.request.context.includes("EXPLORER-ONLY-DETAIL-2"));
    assert.match(synth!.request.context, /^Areas no explorer examined: test, docs, \., config, deploy$/mu);
    assert.equal(critique!.request.instruction, CRITIQUE_INSTRUCTION);
    assert.equal(critique!.request.history.length, 0, "the critique is fresh");
    assert.ok(critique!.request.context.includes("src/module1/file1.ts: input is not validated"), "it sees the synthesis");
    assert.ok(!critique!.request.context.includes("EXPLORER-ONLY-DETAIL"), "and nothing else: no explorer report");
    assert.ok(critique!.request.context.length <= 12_600);
    // Output: the synthesis, the second opinion, and the coverage account.
    assert.match(ran.stdout, /^Second opinion — reviewer · Beta \(m-reviewer-effective\):$/mu);
    assert.match(ran.stdout, /^ {2}Inventoried: 435 files in this repository$/mu);
    assert.match(ran.stdout, /^ {2}Examined in depth by explorers: src\/, lib\/ \(331 files\)$/mu);
    assert.match(ran.stdout, /^ {2}Cited in the answer: 2 files \(lib\/util3\.ts, src\/module1\/file1\.ts\)$/mu);
    assert.match(ran.stdout, /^ {2}Not covered by any answer: .*docs\//mu);
    assert.match(ran.stdout, /^ {2}Model turns: 5\./mu);
    // Tracked secrets in a repository: key names only / withheld in every view.
    assert.deepEqual(leaks(turns, ["LARGE-SENTINEL-yaml-4411", "LARGE-SENTINEL-key-5522"]), []);
    assert.ok(turns.every(t => !t.viewFiles.includes("deploy/site.key") && t.viewFiles.includes("config/secrets.yaml")));
    assert.equal(await tree(root), before);
  }));

// ---------------------------------------------------------------- cancellation, providers, read-only proofs, expert commands

test("v0.2 shell: Ctrl+C during a step cancels only that step; a process-wide cancel ends the session with 130; views are released",
  { skip }, async () => withDir(async (dir, env) => {
    const root = await gitProject(dir, SHOP);
    let current: AbortController | undefined;
    const turnScope = () => { const scope = new AbortController(); current = scope; return { signal: scope.signal, release: () => { current = undefined; } }; };
    const first = fakeConversationRegistry({ replies: { Lead: ["the second answer"] },
      during: async () => { if (first.turns.length === 1) current!.abort(); } });
    const ran = await shell(root, first.registry, ["hello", "hello again", "exit"], env, { turnScope });
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(ran.stdout.split("Cancelled. Nothing was changed.").length - 1, 1);
    assert.match(ran.stdout, /^the second answer$/mu);
    for (const turn of first.turns) assert.equal(await removed(turn.workspace), true);
    const process = new AbortController();
    const second = fakeConversationRegistry({ during: async () => { process.abort(); } });
    const stopped = await shell(root, second.registry, ["hello", "never read"], env, { signal: process.signal });
    assert.equal(stopped.code, 130);
    assert.deepEqual(stopped.questions, [SHELL_PROMPT]);
    for (const turn of second.turns) assert.equal(await removed(turn.workspace), true);
  }));

test("v0.2 shell: unavailable providers are explained in plain words; the analysis falls back to Fusion's own inventory", { skip }, async () =>
  withDir(async (dir, env) => {
    const root = await gitProject(dir, SHOP);
    const none = fakeConversationRegistry({ unavailable: ["Lead", "Explorer", "Reviewer"] });
    const ran = await shell(root, none.registry, ["analyze this project", "exit"], env);
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /^No AI model is available right now\. Fusion's own inventory still works; run `fusion doctor` to see what is missing\.$/mu);
    assert.match(ran.stdout, /never switches to a paid API key on its own/u);
    assert.match(ran.stdout, /^Here is what Fusion found by itself \(no AI model involved\):$/mu);
    assert.match(ran.stdout, /^Repository: my project \(5 tracked files\)$/mu);
    const some = fakeConversationRegistry({ unavailable: ["Explorer", "Reviewer"] });
    assert.match((await shell(root, some.registry, ["exit"], env)).stdout, /^Alpha available \(not available: Beta; see fusion doctor\)$/mu);
  }));

test("v0.2 shell: a provider that changes the folder or its view during a read-only turn stops the session with a security failure", { skip }, async () =>
  withDir(async (dir, env) => {
    const root = await createHomeAssistantFixture(dir);
    const primary = fakeConversationRegistry({ during: async () => { await writeFile(join(root, "planted.yaml"), "x: 1\n"); } });
    const ran = await shell(root, primary.registry, ["hello", "never read"], env);
    assert.equal(ran.code, 4, ran.stdout + ran.stderr);
    assert.match(ran.stderr, /The folder changed during a read-only conversation turn/u);
    assert.deepEqual(ran.questions, [SHELL_PROMPT]);
    await rm(join(root, "planted.yaml"));
    const view = fakeConversationRegistry({ during: async turn => { await writeFile(join(turn.workspace, "planted.txt"), "x"); } });
    const viewRan = await shell(root, view.registry, ["hello"], env);
    assert.equal(viewRan.code, 4);
    assert.match(viewRan.stderr, /changed its read-only view/u);
  }));

test("v0.2 expert commands in a folder without Git: analyze and chat work read-only; build still refuses", { skip }, async () =>
  withDir(async (dir, env) => {
    const root = await createHomeAssistantFixture(dir);
    const before = await tree(root);
    const { registry, turns } = fakeConversationRegistry({ replies: { Lead: ["Hallo! Eine Home-Assistant-Konfiguration."] } });
    const inventory = await once(["analyze", "--inventory-only"], root, registry, env);
    assert.equal(inventory.code, 0, inventory.stderr);
    assert.match(inventory.stdout, /^Folder: homeassistant \(13 files, not a Git repository\)$/mu);
    assert.match(inventory.stdout, /^Not shared in full with AI models: 4 sensitive file\(s\)/mu);
    const chat = await once(["chat", "--", "hallo"], root, registry, env);
    assert.equal(chat.code, 0, chat.stderr);
    assert.match(chat.stdout, /Hallo! Eine Home-Assistant-Konfiguration\./u);
    assert.deepEqual(leaks(turns, Object.values(HA_SENTINELS)), []);
    const refused = await once(["build", "--", "Fix configuration.yaml"], root, registry, env);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /Not inside a Git working tree/u);
    assert.equal(await tree(root), before);
  }));
