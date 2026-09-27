import assert from "node:assert/strict";
import { lstat, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { ControlPlane } from "../src/app/control-plane.js";
import { RepositoryConversation } from "../src/app/conversation.js";
import { areaChoices, investigationContext, investigationFailure, investigationPacket, runInvestigation, runInvestigationBatch } from "../src/app/orchestration/investigations.js";
import { runBounded } from "../src/app/orchestration/scheduler.js";
import type { ConversationTurnRequest } from "../src/core/conversation.js";
import { FusionFailure } from "../src/core/errors.js";
import type { InvestigationPacket } from "../src/core/orchestration/contracts.js";
import { ProcessGitClient } from "../src/platform/workspace/git.js";
import { ProviderViewStore } from "../src/platform/workspace/provider-views.js";
import { prepareProviderInput } from "../src/platform/workspace/sensitive-input.js";
import { fakeConversationRegistry, type FakeOptions } from "./fixtures/fake-conversation.js";
import { createHomeAssistantFixture, HA_SENTINELS } from "./fixtures/home-assistant.js";

/**
 * v0.3 PR 2 — PARALLEL INVESTIGATION: the bounded scheduler (concurrency, time budgets, fatal failures, cancellation, every
 * child settled), independent view copies, isolated investigation turns (a fresh session and a fresh view copy each, no
 * transcript), and strict, bounded result packets. Concurrency is proven mechanically: each turn waits at a barrier that only
 * opens when all of them are running at the same time.
 */
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
/** Opens only when `count` callers are inside at once; a caller alone times out (so sequential execution fails the test). */
function barrier(count: number, timeoutMs = 5_000): () => Promise<void> {
  let arrived = 0, open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  return async () => {
    if (++arrived >= count) open();
    await Promise.race([opened, wait(timeoutMs).then(() => { throw new Error(`the barrier of ${count} never opened: not concurrent`); })]);
  };
}
const failure = (kind: "SecurityViolation" | "Cancelled" | "AuthMismatch", safeMessage: string = kind) => new FusionFailure({ kind, safeMessage, retryable: false });
const untilAborted = (signal: AbortSignal) => new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });

// ---------------------------------------------------------------- the scheduler

test("v0.3 scheduler: never more than the concurrency bound (hard cap 3); every started item settles before the batch returns", async () => {
  let running = 0, peak = 0;
  const settled: number[] = [];
  const items = Array.from({ length: 5 }, (_, i) => ({ id: `i${i}`, run: async () => {
    running++; peak = Math.max(peak, running);
    try { await wait(25); return i; } finally { running--; settled.push(i); } } }));
  const report = await runBounded(items, { concurrency: 3, timeoutMs: 5_000, fatal: () => false });
  assert.deepEqual(report.results.map(r => r.status === "fulfilled" ? r.value : -1), [0, 1, 2, 3, 4]);
  assert.deepEqual([report.maxConcurrent, peak, settled.length], [3, 3, 5]);
  peak = 0;
  assert.equal((await runBounded(items, { concurrency: 10, timeoutMs: 5_000, fatal: () => false })).maxConcurrent, 3, "the hard cap holds");
  const arrive = barrier(3);
  const parallel = await runBounded(Array.from({ length: 3 }, (_, i) => ({ id: `p${i}`, run: async () => { await arrive(); return i; } })),
    { concurrency: 3, timeoutMs: 10_000, fatal: () => false });
  assert.equal(parallel.results.every(r => r.status === "fulfilled"), true, "three items ran at the same time (the barrier opened)");
});

test("v0.3 scheduler: a timed-out item is stopped and reported; its siblings finish; its cleanup ran first", async () => {
  const cleaned: string[] = [];
  const report = await runBounded([
    { id: "slow", run: async (signal: AbortSignal) => { try { await untilAborted(signal); throw failure("Cancelled"); } finally { await wait(10); cleaned.push("slow"); } } },
    { id: "fast", run: async () => { await wait(10); cleaned.push("fast"); return "ok"; } },
  ], { concurrency: 2, timeoutMs: 80, fatal: e => e instanceof FusionFailure && (e.error.kind === "Cancelled" || e.error.kind === "SecurityViolation") });
  const [slow, fast] = report.results;
  assert.equal(fast!.status, "fulfilled");
  const stopped = slow!;
  assert.ok(stopped.status === "rejected" && stopped.timedOut && stopped.error instanceof FusionFailure && stopped.error.error.kind === "Timeout" && stopped.error.error.retryable);
  assert.deepEqual(cleaned.sort(), ["fast", "slow"]);
});

test("v0.3 scheduler: a fatal failure stops every sibling, waits for their cleanup, then rethrows; later items never start", async () => {
  const cleaned: string[] = [];
  const started: string[] = [];
  const sibling = (id: string) => ({ id, run: async (signal: AbortSignal) => {
    started.push(id);
    try { await untilAborted(signal); throw failure("Cancelled"); } finally { await wait(15); cleaned.push(id); } } });
  const fatal = (e: unknown) => e instanceof FusionFailure && (e.error.kind === "SecurityViolation" || e.error.kind === "Cancelled");
  await assert.rejects(runBounded([sibling("a"), { id: "b", run: async () => { started.push("b"); await wait(20); throw failure("SecurityViolation", "view changed"); } },
    sibling("c")], { concurrency: 3, timeoutMs: 5_000, fatal }), (e: unknown) => e instanceof FusionFailure && e.error.kind === "SecurityViolation");
  assert.deepEqual(cleaned.sort(), ["a", "c"], "siblings were stopped and cleaned up before the batch rejected");
  started.length = 0;
  await assert.rejects(runBounded([{ id: "x", run: async () => { started.push("x"); throw failure("SecurityViolation"); } }, sibling("y")],
    { concurrency: 1, timeoutMs: 5_000, fatal }));
  assert.deepEqual(started, ["x"], "after a fatal failure nothing new starts");
});

test("v0.3 scheduler: the user's cancellation stops the whole batch after every item settled; an item that ignores it is fatal", async () => {
  const cleaned: string[] = [];
  const controller = new AbortController();
  const item = (id: string) => ({ id, run: async (signal: AbortSignal) => { try { await untilAborted(signal); throw failure("Cancelled"); } finally { cleaned.push(id); } } });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(runBounded([item("a"), item("b"), item("c")], { concurrency: 3, timeoutMs: 5_000, signal: controller.signal, fatal: () => true }),
    (e: unknown) => e instanceof FusionFailure && e.error.kind === "Cancelled");
  assert.deepEqual(cleaned.sort(), ["a", "b", "c"]);
  await assert.rejects(runBounded([{ id: "stuck", run: () => new Promise<never>(() => undefined) }], { concurrency: 1, timeoutMs: 20, settleGraceMs: 40,
    fatal: () => false }), (e: unknown) => e instanceof FusionFailure && e.error.kind === "InternalError" && /did not stop/u.test(e.error.safeMessage));
});

// ---------------------------------------------------------------- independent view copies

async function withDir<T>(work: (dir: string, env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "v03-parallel-")));
  try { return await work(dir, { ...process.env, LOCALAPPDATA: join(dir, "state-local"), XDG_STATE_HOME: join(dir, "state-xdg") }); }
  finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}
async function files(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true }))
    if (entry.isFile()) out[relative(root, join(entry.parentPath, entry.name)).split(sep).join("/")] = await readFile(join(entry.parentPath, entry.name), "utf8");
  return out;
}

test("v0.3 view replica: an independent copy of the filtered view — own identity, same bytes, no secret, source must be intact", async () => withDir(async dir => {
  const workspace = await createHomeAssistantFixture(dir);
  const listed = Object.keys(await files(workspace));
  const store = new ProviderViewStore({ primaryRoot: workspace, git: await ProcessGitClient.fromPath(process.env, true) });
  const source = await store.folder("owner-a", listed, prepareProviderInput);
  const copy = await store.replica("owner-a-i1", source.viewId);
  assert.notEqual(copy.path, source.path);
  assert.notEqual(copy.viewId, source.viewId);
  assert.deepEqual(await files(copy.path), await files(source.path), "the same filtered bytes");
  assert.deepEqual(copy.exposure, source.exposure);
  const text = JSON.stringify(await files(copy.path));
  for (const secret of Object.values(HA_SENTINELS)) assert.ok(!text.includes(secret), `no ${secret} in the copy`);
  assert.equal(await store.fingerprint(copy.viewId), copy.identity);
  await writeFile(join(copy.path, "note.txt"), "a provider must not write\n");
  assert.notEqual(await store.fingerprint(copy.viewId), copy.identity, "a write into a copy is detected");
  assert.equal(await store.fingerprint(source.viewId), source.identity, "and never reaches the source or a sibling");
  assert.deepEqual(await store.release(copy.viewId), { complete: true });
  await assert.rejects(lstat(copy.path));
  await writeFile(join(source.path, "configuration.yaml"), "tampered\n");
  await assert.rejects(store.replica("owner-a-i2", source.viewId), (e: unknown) => e instanceof FusionFailure && e.error.kind === "SecurityViolation");
  assert.deepEqual(store.live().map(v => v.viewId), [source.viewId], "a refused copy leaves nothing behind");
  await store.release(source.viewId);
}));

// ---------------------------------------------------------------- isolated investigation turns

async function open(workspace: string, env: NodeJS.ProcessEnv, options: FakeOptions) {
  const fake = fakeConversationRegistry(options);
  const conversation = await RepositoryConversation.open(new ControlPlane({ registry: fake.registry, env, cwd: workspace }), { allowFolder: true });
  return { conversation, turns: fake.turns };
}
const packetFor = (conversation: RepositoryConversation, id: string, area: string, claim?: string): InvestigationPacket =>
  investigationPacket(conversation.inventory, { id, batch: 1, attempt: 1, area, question: `What in ${area} matters?`, plannedBy: "lead",
    ...(claim ? { claim } : {}) }, []);
const report = (area: string, paths: string[], extra: Record<string, unknown> = {}) => `\`\`\`json\n${JSON.stringify({ status: "answered",
  summary: `The ${area} area.`, findings: [{ claim: `something in ${area}`, paths }], openQuestions: [], ...extra })}\n\`\`\``;
const areaOf = (request: ConversationTurnRequest): string => /^Area: (?:(\S+)\/|files at the project root)/mu.exec(request.context)?.[1] ?? ".";

test("v0.3 investigate: parallel turns, each in its own fresh session and view copy, no transcript, no secret; all torn down", async () => withDir(async (dir, env) => {
  const workspace = await createHomeAssistantFixture(dir);
  const arrive = barrier(3);
  const { conversation, turns } = await open(workspace, env, { replies: {
    Lead: ["The configuration uses MQTT. LEAD-TRANSCRIPT-MARKER"],
    Reviewer: Array.from({ length: 3 }, () => async (request: ConversationTurnRequest) => { await arrive(); return report(areaOf(request), ["configuration.yaml"]); }) } });
  try {
    await conversation.ask("What does this configuration do?");
    const choices = areaChoices(conversation.inventory);
    assert.ok(choices.some(a => a.id === ".storage" && a.withheld === true), "an area of only withheld files is never assignable");
    const areas = choices.filter(a => a.withheld !== true).map(a => a.id).slice(0, 3);
    assert.equal(areas.length, 3, JSON.stringify(choices));
    const { outcomes, report: batch } = await runInvestigationBatch(conversation, areas.map((area, i) => packetFor(conversation, `b1-i${i + 1}`, area)),
      "reviewer", { concurrency: 3, timeoutMs: 10_000 });
    assert.equal(batch.maxConcurrent, 3);
    assert.deepEqual(outcomes.map(o => o.status), ["reported", "reported", "reported"]);
    const explorerTurns = turns.filter(t => t.role === "Reviewer");
    const leadTurn = turns.find(t => t.role === "Lead")!;
    assert.equal(new Set(explorerTurns.map(t => t.workspace)).size, 3, "three independent view copies");
    assert.ok(!explorerTurns.some(t => t.workspace === leadTurn.workspace), "never the conversation's own view");
    for (const t of explorerTurns) {
      assert.deepEqual([t.request.purpose, t.request.history.length], ["investigation", 0], "an investigation carries no transcript");
      assert.ok(!JSON.stringify(t.request).includes("LEAD-TRANSCRIPT-MARKER"));
      for (const secret of Object.values(HA_SENTINELS)) assert.ok(!t.viewText.includes(secret) && !JSON.stringify(t.request).includes(secret), secret);
    }
    assert.equal(conversation.liveViews, 1, "every copy was released; only the conversation's view remains");
    for (const t of explorerTurns) await assert.rejects(lstat(t.workspace), "the copy is gone from disk");
  } finally { await conversation.close(); }
  assert.equal(conversation.liveViews, 0);
}));

test("v0.3 investigate: a provider that writes into its copy stops the route; siblings are stopped and every copy removed", async () => withDir(async (dir, env) => {
  const workspace = await createHomeAssistantFixture(dir);
  const arrive = barrier(2);
  const { conversation, turns } = await open(workspace, env, {
    replies: { Reviewer: Array.from({ length: 2 }, () => async (request: ConversationTurnRequest, turn: { signal?: AbortSignal }) => {
      await arrive();
      if (areaOf(request) === "packages") await untilAborted(turn.signal!);
      return report(areaOf(request), []);
    }) },
    during: async turn => { if (areaOf(turn.request) !== "packages") await writeFile(join(turn.workspace, "planted.txt"), "x"); } });
  const areas = areaChoices(conversation.inventory).filter(a => a.withheld !== true).map(a => a.id);
  const pair = [areas.find(a => a !== "packages")!, "packages"];
  assert.ok(areas.includes("packages"), JSON.stringify(areas));
  await assert.rejects(runInvestigationBatch(conversation, pair.map((area, i) => packetFor(conversation, `b1-i${i + 1}`, area)), "reviewer",
    { concurrency: 2, timeoutMs: 10_000 }), (e: unknown) => e instanceof FusionFailure && e.error.kind === "SecurityViolation" && /changed its read-only view/u.test(e.error.safeMessage));
  assert.equal(conversation.liveViews, 0, "the conversation closed itself and removed every view and copy");
  for (const t of turns) await assert.rejects(lstat(t.workspace));
  await assert.rejects(conversation.investigate("again?", { partner: "reviewer", instruction: "x", context: "y" }), /closed/u);
}));

test("v0.3 result packets: strict reading, cited paths checked against the shared copy, unstructured and failed turns kept safe", async () => withDir(async (dir, env) => {
  const workspace = await createHomeAssistantFixture(dir);
  const { conversation } = await open(workspace, env, { replies: { Reviewer: [
    report(".", ["configuration.yaml", "missing.yaml", "secrets.yaml"]),
    "I looked around and configuration.yaml seems fine.",
    report(".", ["configuration.yaml"]),
    { error: { kind: "AuthMismatch", safeMessage: "The provider rejected its login.", retryable: false } },
  ] } });
  try {
    const controller = new AbortController();
    const first = await runInvestigation(conversation, packetFor(conversation, "b1-i1", "."), "reviewer", controller.signal);
    assert.ok(first.status === "reported");
    assert.deepEqual([first.cited, first.uncitedPaths], [["configuration.yaml", "secrets.yaml"], 1], "only files the copy shared count as cited evidence");
    const prose = await runInvestigation(conversation, packetFor(conversation, "b1-i2", "."), "reviewer", controller.signal);
    assert.ok(prose.status === "unstructured");
    assert.deepEqual([prose.rejection, prose.cited], ["invalid JSON", ["configuration.yaml"]]);
    const noVerdict = await runInvestigation(conversation, packetFor(conversation, "b1-i3", ".", "http is misconfigured"), "reviewer", controller.signal);
    assert.ok(noVerdict.status === "unstructured" && noVerdict.rejection === "verdict missing", "a claim needs a verdict");
    const failed = await runInvestigation(conversation, packetFor(conversation, "b1-i4", "."), "reviewer", controller.signal);
    assert.ok(failed.status === "failed");
    assert.deepEqual(failed.failure, { kind: "AuthMismatch", category: "authentication", message: "The provider rejected its login.", retryable: false });
    assert.match(investigationContext(conversation.inventory, packetFor(conversation, "b1-i5", ".", "a claim")), /^Claim to judge \(verdict: supported, contradicted or unclear\): a claim$/mu);
  } finally { await conversation.close(); }
  assert.deepEqual(investigationFailure(new Error("raw provider text must never show")),
    { kind: "InternalError", category: "internal error", message: "The investigation failed unexpectedly.", retryable: false });
}));

test("v0.3 batch: one investigation exceeds its time budget — it becomes a retryable timeout; the siblings' reports stand", async () => withDir(async (dir, env) => {
  const workspace = await createHomeAssistantFixture(dir);
  const { conversation } = await open(workspace, env, {
    replies: { Reviewer: Array.from({ length: 2 }, () => async (request: ConversationTurnRequest) => report(areaOf(request), ["configuration.yaml"])) },
    during: async (turn, signal) => { if (areaOf(turn.request) === "packages") await untilAborted(signal!); } });
  try {
    const areas = areaChoices(conversation.inventory).filter(a => a.withheld !== true).map(a => a.id);
    const pair = [areas.find(a => a !== "packages")!, "packages"];
    const { outcomes } = await runInvestigationBatch(conversation, pair.map((area, i) => packetFor(conversation, `b1-i${i + 1}`, area)), "reviewer",
      { concurrency: 2, timeoutMs: 3_000 });
    assert.equal(outcomes[0]!.status, "reported");
    const late = outcomes[1]!;
    assert.ok(late.status === "failed");
    assert.deepEqual([late.failure.kind, late.failure.category, late.failure.retryable], ["Timeout", "timeout", true]);
    assert.equal(conversation.liveViews, 1, "the stopped turn's copy was removed");
  } finally { await conversation.close(); }
}));

test("v0.3 guard: the parallel-investigation modules name no provider or model", async () => {
  const forbidden = /claude|muse|anthropic|\bmeta\b|opus|spark|\bgpt|gemini|openai|llama|sonnet|haiku/iu;
  for (const path of ["src/app/orchestration/scheduler.ts", "src/app/orchestration/envelope.ts", "src/app/orchestration/investigations.ts"])
    assert.doesNotMatch(await readFile(join(process.cwd(), path), "utf8"), forbidden, path);
});
