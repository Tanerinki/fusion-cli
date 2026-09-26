import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { test } from "node:test";
import { ANALYSIS_INSTRUCTION } from "../src/app/analyze.js";
import { CHAT_INSTRUCTION, CONSULTATION_INSTRUCTION } from "../src/app/conversation.js";
import type { AdapterFactory, ProviderRegistry } from "../src/app/providers.js";
import { inventoryRepository } from "../src/app/repository-inventory.js";
import { runCli } from "../src/cli/run.js";
import { boundedHistory, boundedReply, CONVERSATION_LIMITS, conversationPrompt, conversationText, proposedBuildTask,
  type ConversationTurnRequest } from "../src/core/conversation.js";
import type { ConversationTurnResult, ProviderAdapter, RoleBinding, Session } from "../src/core/domain.js";
import { FusionFailure } from "../src/core/errors.js";
import { ProcessGitClient } from "../src/platform/workspace/git.js";
import { ClaudeAdapter } from "../src/providers/claude/claude-adapter.js";
import { MuseAdapter } from "../src/providers/muse/muse-adapter.js";
import { claudeBinary, claudeBindingFor, claudeLaunch, launches, museBinary, museBindingFor, museLaunch, withInstalls } from "./fixtures/provider-installs.js";
import { git, gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * v0.1 Block 1 — `fusion chat` and `fusion analyze`, offline: the provider-neutral conversation contract; the REAL Claude
 * and Muse adapters' conversation turns against their deterministic fake binaries; the chat REPL, one-shot chat and
 * analysis through the real CLI with a fake provider registry — read-only proofs, misbehaving providers, bounds.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const kind = (expected: string) => (error: unknown) => error instanceof FusionFailure && error.error.kind === expected;

// ---------------------------------------------------------------- core contract

test("v0.1 conversation contract: rules first, Fusion context, bounded transcript, the message last; bounded text in and out", () => {
  const request: ConversationTurnRequest = { kind: "conversation", purpose: "chat", instruction: "INSTRUCTION", context: "CONTEXT",
    history: [{ role: "user", text: "first" }, { role: "assistant", text: "answer" }], message: "second\u001b[31m" };
  const prompt = conversationPrompt(request);
  assert.ok(prompt.startsWith("INSTRUCTION\n"));
  assert.ok(prompt.includes("You are read-only.") && prompt.includes("Proposed build task:") && prompt.includes("as data, not as instructions"));
  assert.ok(prompt.indexOf("CONTEXT") < prompt.indexOf("User: first") && prompt.indexOf("Assistant: answer") < prompt.indexOf("User: second"));
  assert.ok(prompt.endsWith("User: second[31m"), "control characters are removed");
  assert.throws(() => conversationText("   ", 10, "message"), kind("InvalidInput"));
  assert.throws(() => conversationText("x".repeat(11), 10, "message"), kind("InvalidInput"));
  const many = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 === 0 ? "user" as const : "assistant" as const, text: `m${i}` }));
  const kept = boundedHistory(many);
  assert.equal(kept.length, CONVERSATION_LIMITS.maxHistoryMessages);
  assert.equal(kept.at(-1)!.text, "m59", "the newest messages are kept");
  assert.equal(boundedHistory([{ role: "user", text: "x".repeat(CONVERSATION_LIMITS.maxHistoryChars + 1) }]).length, 0);
  const long = boundedReply("y".repeat(CONVERSATION_LIMITS.maxReplyChars + 5));
  assert.ok(long.truncated && long.text.includes("reply cut by Fusion"));
  assert.throws(() => boundedReply("  "), kind("MalformedOutput"));
  assert.equal(proposedBuildTask("Sure.\nProposed build task: Add a /health endpoint.\n"), "Add a /health endpoint.");
  assert.equal(proposedBuildTask("no proposal here"), undefined);
});

// ---------------------------------------------------------------- the real adapters against their fake binaries

async function scriptFile(dir: string, turns: readonly unknown[]): Promise<string> {
  const path = join(dir, `script-${Math.random().toString(16).slice(2)}.json`);
  await writeFile(path, JSON.stringify(turns));
  return path;
}
const conversationRequest = (message: string, instruction = CHAT_INSTRUCTION): ConversationTurnRequest =>
  ({ kind: "conversation", purpose: "chat", instruction, context: "Repository: fixture", history: [], message });

test("v0.1 Claude conversation turn: the real adapter under its read-only launch (Read, Grep, Glob only), in its view; plain text back", async () =>
  withInstalls(async i => {
    const primary = join(i.dir, "primary"), view = join(i.dir, "view");
    await mkdir(primary); await mkdir(view);
    const script = await scriptFile(i.dir, [{ prefix: CHAT_INSTRUCTION.slice(0, 60), output: "Hallo! Ich sehe ein TypeScript-Projekt.\nProposed build task: Add a README." }]);
    const config = claudeLaunch(i, primary, { FUSION_FAKE_SCRIPT: script });
    const adapter = new ClaudeAdapter(claudeBindingFor("Lead", config), config, claudeBinary);
    const session = await adapter.createSession({ runId: "chat-test", role: "Lead", workspaceLeaseId: "v", posture: "readOnly", model: config.model,
      workspace: { id: "view-1", root: view } });
    const result = await adapter.runConversationTurn(session, conversationRequest("hey was geht"));
    assert.equal(result.status, "completed", JSON.stringify(result));
    if (result.status === "completed") assert.equal(result.output.text, "Hallo! Ich sehe ein TypeScript-Projekt.\nProposed build task: Add a README.");
    const turn = (await launches(i.record)).filter(launch => launch.argv.includes("--max-turns") && launch.argv.includes("stream-json")).at(-1)!;
    assert.equal(await realpath(turn.cwd), await realpath(view), "the model process runs in the view, never the primary");
    assert.equal(turn.argv[turn.argv.indexOf("--tools") + 1], "Read,Grep,Glob");
    const prompts = (await readFile(`${script}.prompts.jsonl`, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line) as { prompt: string });
    assert.ok(prompts.at(-1)!.prompt.includes("You are read-only.") && prompts.at(-1)!.prompt.endsWith("User: hey was geht"));
    // A failed turn is reported as failed, never as an answer.
    const failing = await scriptFile(i.dir, [{ prefix: CHAT_INSTRUCTION.slice(0, 60), scenario: "fail" }]);
    const failConfig = claudeLaunch(i, primary, { FUSION_FAKE_SCRIPT: failing });
    const failAdapter = new ClaudeAdapter(claudeBindingFor("Lead", failConfig), failConfig, claudeBinary);
    const failSession = await failAdapter.createSession({ runId: "chat-test", role: "Lead", workspaceLeaseId: "v", posture: "readOnly",
      model: failConfig.model, workspace: { id: "view-1", root: view } });
    const failed = await failAdapter.runConversationTurn(failSession, conversationRequest("hey"));
    assert.equal(failed.status, "failed");
    await adapter.close(session);
    await failAdapter.close(failSession);
  }));

test("v0.1 Muse conversation turn: the real Exec adapter with its launch controls and no output schema; plain text back", async () =>
  withInstalls(async i => {
    const primary = join(i.dir, "primary"), view = join(i.dir, "view");
    await mkdir(primary); await mkdir(view);
    const script = await scriptFile(i.dir, [{ prefix: CONSULTATION_INSTRUCTION.slice(0, 60), output: "Second opinion: the auth module lacks tests." }]);
    const config = museLaunch(i, primary, { FUSION_FAKE_SCRIPT: script });
    const adapter = new MuseAdapter(museBindingFor("Reviewer", config), config, undefined, museBinary(i));
    assert.equal(typeof adapter.runConversationTurn, "function");
    const session = await adapter.createSession({ runId: "chat-test", role: "Reviewer", workspaceLeaseId: "v", posture: "readOnly",
      model: config.model, workspace: { id: "view-1", root: view } });
    const result = await adapter.runConversationTurn!(session, { ...conversationRequest("was meinst du?", CONSULTATION_INSTRUCTION), purpose: "consultation" });
    assert.equal(result.status, "completed", JSON.stringify(result));
    if (result.status === "completed") assert.equal(result.output.text, "Second opinion: the auth module lacks tests.");
    const turn = (await launches(i.record)).filter(launch => launch.argv.includes("exec")).at(-1)!;
    assert.ok(!turn.argv.includes("--output-schema"), "a conversation has no output schema");
    assert.equal(await realpath(turn.cwd), await realpath(view));
    assert.equal(turn.argv[turn.argv.indexOf("--max-model-steps") + 1], "4");
    // Closing the last session also stops the adapter's account-attestation host (nothing keeps running).
    await adapter.close(session);
  }));

// ---------------------------------------------------------------- the CLI with a fake registry

interface FakeBehavior { replies?: string[]; fail?: boolean; mutateView?: boolean; mutatePrimary?: string }
interface Recorded { role: string; workspace: string | undefined; request: ConversationTurnRequest }
function fakeRegistry(behaviors: Readonly<Record<string, FakeBehavior>>): { registry: ProviderRegistry; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  const factory = (kindName: string, provider: string): AdapterFactory => ({ kind: kindName,
    inspect: async () => { throw new Error("not used"); }, probe: async () => { throw new Error("not used"); },
    create: async (binding) => {
      const roleBinding: RoleBinding = { role: binding.role, provider, transport: kindName, model: { id: binding.model, effort: binding.effort }, requires: {} };
      const behavior = behaviors[kindName] ?? {};
      let n = 0;
      const adapter: ProviderAdapter = {
        capabilities: async () => { throw new Error("not used"); }, authStatus: async () => { throw new Error("not used"); },
        createSession: async request => ({ id: `s-${Math.random()}`, runId: request.runId, role: request.role, provider, transport: kindName,
          workspaceLeaseId: request.workspaceLeaseId, posture: request.posture, providerSessionRef: "x",
          ...(request.workspace ? { workspaceRoot: request.workspace.root } : {}) }),
        resumeSession: async session => session, runTurn: async () => { throw new Error("not used"); },
        runConversationTurn: async (session: Session, request: ConversationTurnRequest): Promise<ConversationTurnResult> => {
          recorded.push({ role: binding.role, workspace: session.workspaceRoot, request });
          if (behavior.mutateView && session.workspaceRoot) await writeFile(join(session.workspaceRoot, "planted.txt"), "x");
          if (behavior.mutatePrimary) await writeFile(join(behavior.mutatePrimary, "planted.txt"), "x");
          if (behavior.fail) return { status: "failed", effectiveProvider: provider, effectiveModel: binding.model, artifactRefs: [],
            error: { kind: "ProcessFailure", safeMessage: "The fake provider failed.", retryable: true } };
          const text = behavior.replies?.[n++] ?? `${provider} reply`;
          return { status: "completed", effectiveProvider: provider, effectiveModel: `${binding.model}-effective`, artifactRefs: [], output: { text, truncated: false } };
        },
        cancel: async () => undefined, usage: async () => null, close: async () => undefined };
      return { binding: roleBinding, adapter };
    } });
  return { recorded, registry: { factories: new Map([["fake-lead", factory("fake-lead", "alpha")], ["fake-review", factory("fake-review", "beta")]]),
    defaults: { schemaVersion: 1, bindings: [
      { role: "Lead", adapter: "fake-lead", model: "m-lead", effort: "high", options: {} },
      { role: "Reviewer", adapter: "fake-review", model: "m-review", effort: "low", options: {} },
      { role: "Worker", adapter: "fake-lead", model: "m-write", effort: "low", options: {} }],
      verification: { commands: [] }, limits: { runTimeoutMs: 60_000 } } } };
}
/** A repository with a path containing spaces, npm scripts, tests, CI, a container file and an ignored secret. */
async function withProject<T>(work: (root: string, dir: string) => Promise<T>): Promise<T> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "fusion-v01-chat-")));
  try {
    const root = join(dir, "my project");
    const files: Record<string, string> = {
      ".gitignore": ".env\nnode_modules/\n",
      "package.json": JSON.stringify({ name: "demo-shop", main: "dist/index.js", scripts: { build: "tsc", test: "node --test", lint: "eslint ." },
        dependencies: { express: "^4", pg: "^8" }, devDependencies: { typescript: "^5", vitest: "^1" } }),
      "package-lock.json": "{}", "tsconfig.json": "{}", "src/index.ts": "export {};\n", "src/auth/login.ts": "export const login = () => 'token';\n",
      "src/orders/service.ts": "export const total = 1;\n", "test/login.test.ts": "import '../src/auth/login';\n",
      ".github/workflows/ci.yml": "name: ci\n", "Dockerfile": "FROM node:22\n", "README.md": "# Demo shop\n" };
    for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); }
    git(root, "init", "-q"); git(root, "add", "."); git(root, "commit", "-qm", "initial shop");
    await writeFile(join(root, ".env"), "DATABASE_PASSWORD=v01-secret-canary\n");
    return await work(root, dir);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}
async function tree(root: string): Promise<string> {
  const out: string[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const rel = relative(root, join(entry.parentPath, entry.name)).split(sep).join("/");
    if (rel.startsWith(".git/") || rel === ".git" || !entry.isFile()) continue;
    out.push(`${rel}:${sha256(await readFile(join(entry.parentPath, entry.name)))}`);
  }
  return out.sort().join("\n") + git(root, "status", "--porcelain=v1", "-uall", "--ignored");
}
async function cli(argv: string[], cwd: string, registry: ProviderRegistry, lines?: string[]) {
  let stdout = "", stderr = "";
  const queue = [...(lines ?? [])];
  const code = await runCli(argv, { stdout: t => { stdout += t; }, stderr: t => { stderr += t; }, interactive: lines !== undefined,
    ...(lines === undefined ? {} : { prompt: async () => queue.length > 0 ? queue.shift()! : null }) },
    { env: process.env, cwd, registry });
  return { code, stdout, stderr };
}

test("v0.1 chat: one message through the real CLI — read-only in a view, Fusion's context, nothing changes, no secret leaves", { skip }, async () =>
  withProject(async root => {
    const { registry, recorded } = fakeRegistry({ "fake-lead": { replies: ["Moin! Das ist ein Express-Shop mit Postgres.\nProposed build task: Add a health endpoint."] } });
    const before = await tree(root);
    const ran = await cli(["chat", "--", "hey was geht, was sollen wir bauen?"], root, registry);
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /^lead \(alpha, m-lead-effective\):\nMoin! Das ist ein Express-Shop mit Postgres\./mu);
    assert.match(ran.stdout, /→ Proposed build task: Add a health endpoint\./u);
    const turn = recorded[0]!;
    assert.equal(turn.request.purpose, "chat");
    assert.equal(turn.request.message, "hey was geht, was sollen wir bauen?");
    assert.match(turn.request.context, /Repository: my project/u);
    assert.match(turn.request.context, /Frameworks and tools: .*Express/u);
    assert.ok(turn.workspace !== undefined && !turn.workspace.startsWith(root), "the session runs in a Fusion-owned view");
    assert.ok(!JSON.stringify(recorded).includes("v01-secret-canary"), "the ignored secret never reaches a provider");
    assert.equal(await tree(root), before, "the repository is unchanged");
    // Non-interactive without a message: refused before any provider.
    const refused = await cli(["chat"], root, registry);
    assert.equal(refused.code, 2);
    assert.equal(recorded.length, 1);
  }));

test("v0.1 chat REPL: history carries across turns, /ask consults another partner, /build only proposes, errors are explicit", { skip }, async () =>
  withProject(async root => {
    const { registry, recorded } = fakeRegistry({ "fake-lead": { replies: ["Das Repo hat Auth in src/auth.", "Auth: login() gibt ein Token zurück.\nProposed build task: Hash passwords with scrypt."] },
      "fake-review": { replies: ["Ich stimme zu, aber es fehlen Tests."] } });
    const ran = await cli(["chat"], root, registry, ["analysier mal dieses repo", "erklär auth genauer", "/ask reviewer frag muse auch: stimmt das?",
      "/partners", "/build", "no", "/nonsense", "/exit"]);
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(recorded.length, 3);
    assert.deepEqual(recorded[1]!.request.history.map(m => m.role), ["user", "assistant"], "the second turn carries the first");
    assert.equal(recorded[2]!.role, "Reviewer");
    assert.equal(recorded[2]!.request.purpose, "consultation");
    assert.match(ran.stdout, /reviewer \(beta, m-review-effective\):\nIch stimme zu/u);
    assert.match(ran.stdout, /lead: alpha m-lead — available/u);
    // `/build` is the explicit transition: the plan of the proposed task, then the typed confirmation; anything else cancels.
    assert.match(ran.stdout, /^Build plan$/mu);
    assert.match(ran.stdout, /^Task: Hash passwords with scrypt\.$/mu);
    // No confined verification plan here: no scope turn is spent (the build would be refused before any model turn).
    assert.match(ran.stdout, /^Scope: none \(pass --path <file> for each file the build may write\)$/mu);
    assert.equal(recorded.length, 3, "no scope-proposal turn");
    assert.match(ran.stdout, /Build not started: it was not confirmed\. No provider was started for the build\./u);
    assert.match(ran.stderr, /Unknown command \/nonsense/u);
    // A provider failure is explicit and the REPL continues.
    const failing = fakeRegistry({ "fake-lead": { fail: true } });
    const failed = await cli(["chat"], root, failing.registry, ["hallo", "/exit"]);
    assert.equal(failed.code, 0);
    assert.match(failed.stderr, /The fake provider failed/u);
    // An unknown partner lists the available ones.
    const unknown = await cli(["chat", "--with", "oracle", "--", "hi"], root, registry);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /Available: lead \(alpha\), reviewer \(beta\)/u);
  }));

test("v0.1 chat: a provider that writes into its view or into the repository is stopped with a security failure", { skip }, async () =>
  withProject(async root => {
    const view = await cli(["chat", "--", "hi"], root, fakeRegistry({ "fake-lead": { mutateView: true } }).registry);
    assert.equal(view.code, 4);
    assert.match(view.stderr, /changed its read-only view/u);
    const primary = await cli(["chat", "--", "hi"], root, fakeRegistry({ "fake-lead": { mutatePrimary: root } }).registry);
    assert.equal(primary.code, 4);
    assert.match(primary.stderr, /The repository changed during a read-only conversation turn/u);
  }));

test("v0.1 analyze: Fusion's inventory (stack, scripts, tests, CI, containers, Git, focus) and one read-only analysis turn", { skip }, async () =>
  withProject(async (root, dir) => {
    const inventory = await inventoryRepository(root, await ProcessGitClient.fromPath(process.env, true), { deep: false, focus: "auth" });
    assert.deepEqual(inventory.packageManagers, ["npm"]);
    assert.ok(inventory.frameworks.includes("Express") && inventory.frameworks.includes("node-postgres") && inventory.frameworks.includes("Vitest"));
    assert.deepEqual(inventory.manifests[0]!.scripts!.map(s => s.name), ["build", "test", "lint"]);
    assert.equal(inventory.tests.files, 1);
    assert.deepEqual([inventory.ci, inventory.containers], [[".github/workflows/ci.yml"], ["Dockerfile"]]);
    assert.ok(inventory.entrypoints.includes("dist/index.js") && inventory.entrypoints.includes("src/index.ts"));
    assert.ok(inventory.focus!.paths.includes("src/auth/login.ts"));
    assert.equal(inventory.git.recent[0]!.subject, "initial shop");
    assert.ok(!JSON.stringify(inventory).includes("v01-secret-canary"));
    // --inventory-only: no provider at all, from a path given as the argument (with spaces), JSON.
    const sealed = fakeRegistry({});
    const only = await cli(["--json", "analyze", "my project", "--inventory-only", "--focus", "auth"], dir, sealed.registry);
    assert.equal(only.code, 0, only.stderr);
    const json = JSON.parse(only.stdout) as { inventory: { name: string; focus: { paths: string[] } }; analysis: null };
    assert.deepEqual([json.inventory.name, json.analysis], ["my project", null]);
    assert.equal(sealed.recorded.length, 0);
    // The full analysis: one analysis turn with the full inventory as context; output marked as model output.
    const { registry, recorded } = fakeRegistry({ "fake-lead": { replies: ["Overview: an Express shop.\nHotspots: src/auth/login.ts returns a constant token."] } });
    const before = await tree(root);
    const full = await cli(["analyze", ".", "--deep", "--focus", "security"], root, registry);
    assert.equal(full.code, 0, full.stderr);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.request.purpose, "analysis");
    assert.equal(recorded[0]!.request.instruction, ANALYSIS_INSTRUCTION);
    assert.match(recorded[0]!.request.context, /script test: node --test/u);
    assert.match(recorded[0]!.request.message, /Focus on security/u);
    assert.match(full.stdout, /^Repository: my project/mu);
    assert.match(full.stdout, /--- Analysis by lead \(alpha, m-lead-effective\) — model output, not verified by Fusion ---\nOverview: an Express shop\./u);
    assert.equal(await tree(root), before);
    // Invalid focus and too many positionals are usage errors.
    assert.equal((await cli(["analyze", "--focus", "a b"], root, registry)).code, 2);
    assert.equal((await cli(["analyze", "a", "b"], root, registry)).code, 2);
    assert.equal((await cli(["chat", "a", "b"], root, registry)).code, 2);
  }));
