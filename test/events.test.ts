import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { appendFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { test } from "node:test";
import { DiagnosticRedactor } from "../src/core/policy/redaction.js";
import type { ProcessOutcome } from "../src/platform/process/supervisor.js";
import { ArtifactStore, pendingArtifactQueueCount } from "../src/platform/events/artifact-store.js";
import { processEvidenceFromOutcome, projectProviderEvidence } from "../src/platform/events/evidence.js";
import { EventStore, pendingEventQueueCount } from "../src/platform/events/event-store.js";
import { aggregateRunMetrics, metricsFromEvents } from "../src/platform/events/metrics.js";
import { RunStore, pendingManifestQueueCount } from "../src/platform/events/run-store.js";
import { enqueuePath, StorageError } from "../src/platform/events/shared.js";

async function withRepo<T>(run: (repo: string) => Promise<T>): Promise<T> {
  const repo = await mkdtemp(join(tmpdir(), "fusion-m6-test-"));
  try { return await run(repo); }
  finally {
    const base = resolve(tmpdir()).toLowerCase(), target = resolve(repo).toLowerCase();
    assert.ok(target.startsWith(`${base}${sep}`), "test cleanup must remain inside temp");
    await rm(repo, { recursive: true, force: true });
  }
}
const hasKind = (kind: string) => (error: unknown): boolean => error instanceof StorageError && error.kind === kind;
const digest = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

test("M6 initializes sortable unique runs and a typed local manifest", async () => withRepo(async repo => {
  const first = await RunStore.create(repo, { workflowId: "review", risk: "high",
    providerBindings: [{ role: "Reviewer", providerId: "claude", transportId: "one-shot", requestedModel: "opus" }] });
  const second = await RunStore.create(repo);
  assert.notEqual(first.runId, second.runId);
  assert.match(first.runId, /^r-[0-9a-z]{10}-[0-9a-f]{32}$/);
  assert.ok(isAbsolute(first.directory));
  assert.ok(first.directory.startsWith(join(repo, ".fusion", "runs")));
  const manifest = await first.readManifest();
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.status, "running");
  assert.equal(manifest.workflowId, "review");
  assert.equal(manifest.risk, "high");
  assert.equal(manifest.providerBindings?.[0]?.requestedModel, "opus");
  assert.match(manifest.workspaceHash, /^[0-9a-f]{64}$/);
  assert.equal((await readFile(join(first.directory, "events.jsonl"))).length, 0);
  assert.deepEqual((await readdir(repo)).sort(), [".fusion"]);
}));

test("M6 manifest updates serialize and leave one complete atomic JSON file", async () => withRepo(async repo => {
  const run = await RunStore.create(repo);
  const other = await RunStore.open(repo, run.runId);
  await Promise.all([run.updateManifest({ workflowId: "audit" }),
    other.updateManifest({ risk: "medium" }), run.updateManifest({ taskClass: "code" })]);
  const final = await run.updateManifest({ status: "completed", completedAt: new Date().toISOString(),
    termination: { reason: "completed" }, verification: { passes: 2, failures: 0 } });
  assert.equal(final.workflowId, "audit"); assert.equal(final.risk, "medium");
  assert.equal(final.taskClass, "code"); assert.equal(final.status, "completed");
  assert.deepEqual(final.verification, { passes: 2, failures: 0 });
  assert.equal(JSON.parse(await readFile(join(run.directory, "run.json"), "utf8")).runId, run.runId);
  assert.deepEqual((await readdir(run.directory)).filter(name => name.endsWith(".tmp")), []);
  await assert.rejects(run.updateManifest({ status: "failed" }), hasKind("StorageError"));
}));

test("M6 manifest rejects malformed and future schemas", async () => withRepo(async repo => {
  const run = await RunStore.create(repo), path = join(run.directory, "run.json");
  await writeFile(path, "{bad", "utf8");
  await assert.rejects(run.readManifest(), hasKind("StorageError"));
  await writeFile(path, JSON.stringify({ schemaVersion: 2, runId: run.runId }), "utf8");
  await assert.rejects(run.readManifest(), hasKind("UnsupportedSchema"));
  await assert.rejects(RunStore.open(repo, run.runId), hasKind("UnsupportedSchema"));
}));

test("M6 EventStore serializes concurrent appends, UTF-8 and reopen", async () => withRepo(async repo => {
  const run = await RunStore.create(repo), store = await run.openEvents();
  const other = await run.openEvents();
  const writes = Array.from({ length: 80 }, (_, i) =>
    (i % 2 ? store : other).append({ type: "RunStarted", source: "runtime",
      payload: { workflowId: `prüfung-${i}` } }));
  await Promise.all(writes);
  const reopened = await EventStore.open(run.directory, run.runId);
  await reopened.append({ type: "RunCompleted", source: "runtime", payload: { wallTimeMs: 12 } });
  const result = await store.listEvents();
  assert.equal(result.events.length, 81);
  assert.deepEqual(result.events.map(event => event.sequence), Array.from({ length: 81 }, (_, i) => i + 1));
  assert.equal(new Set(result.events.map(event => event.eventId)).size, 81);
  assert.equal((result.events[0]?.payload as { workflowId: string }).workflowId.startsWith("prüfung"), true);
  const raw = await readFile(store.path, "utf8");
  assert.equal(raw.endsWith("\n"), true);
  assert.equal(raw.trimEnd().split("\n").length, 81);
  assert.equal(raw.charCodeAt(0) === 0xfeff, false);
}));

test("M6 reader preserves complete events and diagnoses a truncated final line", async () => withRepo(async repo => {
  const run = await RunStore.create(repo), store = await run.openEvents();
  await store.append({ type: "RunStarted", source: "runtime", payload: {} });
  await appendFile(store.path, '{"schemaVersion":1');
  const items = [];
  for await (const item of EventStore.read(run.directory, run.runId)) items.push(item);
  assert.equal(items.length, 2);
  assert.equal("event" in items[0]!, true);
  assert.deepEqual(items[1], { diagnostic: "TruncatedFinalLine", line: 2 });
  await assert.rejects(EventStore.open(run.directory, run.runId), hasKind("CorruptEventLog"));
}));

test("M6 reader rejects malformed middle records and future event schema", async () => withRepo(async repo => {
  const run = await RunStore.create(repo), store = await run.openEvents();
  await store.append({ type: "RunStarted", source: "runtime", payload: {} });
  await appendFile(store.path, "{bad}\n");
  await assert.rejects(async () => { for await (const _ of EventStore.read(run.directory, run.runId)) void _; },
    hasKind("CorruptEventLog"));
  const valid = JSON.parse((await readFile(store.path, "utf8")).split("\n")[0]!);
  await writeFile(store.path, `${JSON.stringify(valid)}\n${JSON.stringify({ ...valid, schemaVersion: 2, sequence: 2 })}\n`);
  await assert.rejects(async () => { for await (const _ of EventStore.read(run.directory, run.runId)) void _; },
    hasKind("UnsupportedSchema"));
}));

test("M6.1 reopening after a transient append failure resumes an intact event log", async () => withRepo(async repo => {
  const run = await RunStore.create(repo), events = await run.openEvents();
  await events.append({ type: "RunStarted", source: "runtime", payload: {} });
  const backup = join(run.directory, "events.backup");
  await rename(events.path, backup);
  await mkdir(events.path);
  await assert.rejects(events.append({ type: "RunCompleted", source: "runtime", payload: {} }),
    hasKind("StorageError"));
  await rmdir(events.path);
  await rename(backup, events.path);
  const reopened = await EventStore.open(run.directory, run.runId);
  const second = await reopened.append({ type: "RunCompleted", source: "runtime", payload: {} });
  assert.equal(second.sequence, 2);
  assert.equal((await reopened.listEvents()).events.length, 2);
}));

test("M6 ArtifactStore writes text, JSON, JSONL and binary with exact hashes", async () => withRepo(async repo => {
  const run = await RunStore.create(repo);
  const artifacts = await run.openArtifacts();
  const text = await artifacts.storeText("Grüße 🌍");
  const json = await artifacts.storeJson({ status: "ok" });
  const jsonl = await artifacts.storeJsonl([{ n: 1 }, { n: 2 }]);
  const binaryBytes = Uint8Array.from([0, 1, 2, 255]);
  const binary = await artifacts.storeBytes(binaryBytes);
  const all = await artifacts.listMetadata();
  assert.equal(all.length, 4);
  for (const metadata of [text, json, jsonl, binary]) {
    const bytes = await readFile(await artifacts.getArtifactPath(metadata.artifactId));
    assert.equal(metadata.byteSize, bytes.length);
    assert.equal(metadata.sha256, digest(bytes));
    assert.equal(metadata.schemaVersion, 1);
    assert.equal(metadata.runId, run.runId);
  }
  assert.equal((await readFile(await artifacts.getArtifactPath(jsonl.artifactId), "utf8")).endsWith("\n"), true);
}));

test("M6 rejects traversal, absolute and Windows alternate artifact paths", async () => withRepo(async repo => {
  const artifacts = await (await RunStore.create(repo)).openArtifacts();
  for (const path of ["../outside", "text/../../outside", "text\\..\\outside", "C:\\outside\\file",
    "/absolute/file", "text/con.txt", "text/trailing. ", "text//empty", "text/./same"]) {
    assert.throws(() => artifacts.resolveRelativePath(path), hasKind("InvalidArtifactPath"));
  }
  assert.ok(artifacts.resolveRelativePath("text/safe.txt").startsWith(artifacts.root));
}));

test("M6 copies an external regular file with bounded streaming and rejects oversized content", async () => withRepo(async repo => {
  const source = join(tmpdir(), `fusion-m6-source-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`);
  const bytes = Buffer.from("external source bytes");
  await writeFile(source, bytes);
  try {
    const run = await RunStore.create(repo);
    const artifacts = await ArtifactStore.open(run.directory, run.runId, undefined, { maxCopiedBytes: 1024 });
    const copied = await artifacts.copyFile(source, "application/octet-stream");
    assert.equal(copied.byteSize, bytes.length);
    assert.equal(copied.sha256, digest(bytes));
    assert.deepEqual(await readFile(await artifacts.getArtifactPath(copied.artifactId)), bytes);
    const small = await ArtifactStore.open(run.directory, run.runId, undefined,
      { maxInMemoryBytes: 2, maxCopiedBytes: 2 });
    assert.throws(() => small.storeText("too long"), hasKind("ArtifactTooLarge"));
    await assert.rejects(small.copyFile(source), hasKind("ArtifactTooLarge"));
    assert.deepEqual((await readdir(join(artifacts.root, "copiedFile"))).filter(name => name.endsWith(".tmp")), []);
  } finally { await rm(source, { force: true }); }
}));

test("M6.1 a source growing during streamed copy exceeds the limit and leaves no partial artifact", async () => withRepo(async repo => {
  const run = await RunStore.create(repo);
  const source = join(repo, "growing.bin");
  await writeFile(source, Buffer.alloc(32 * 1024 * 1024));
  const artifacts = await ArtifactStore.open(run.directory, run.runId, undefined,
    { maxCopiedBytes: 33 * 1024 * 1024 });
  const category = join(artifacts.root, "copiedFile");
  await mkdir(category);
  let started = false;
  let done!: () => void;
  let failed!: (error: Error) => void;
  const appended = new Promise<void>((resolve, reject) => { done = resolve; failed = reject; });
  const watcher = watch(category, () => {
    if (started) return;
    started = true;
    void appendFile(source, Buffer.alloc(4 * 1024 * 1024)).then(done, failed);
  });
  const timeout = setTimeout(() => failed(new Error("copy creation was not observed")), 10000);
  try {
    const copy = artifacts.copyFile(source).then(() => null, error => error as unknown);
    await appended;
    assert.equal(hasKind("ArtifactTooLarge")(await copy), true);
    assert.deepEqual(await readdir(category), []);
    assert.deepEqual(await artifacts.listMetadata(), []);
  } finally { clearTimeout(timeout); watcher.close(); }
}));

test("M6 removes a newly written artifact when its index append fails", async () => withRepo(async repo => {
  const run = await RunStore.create(repo), artifacts = await run.openArtifacts();
  const backup = join(artifacts.root, "index.backup");
  await rename(artifacts.indexPath, backup);
  await mkdir(artifacts.indexPath);
  await assert.rejects(artifacts.storeText("partial artifact"), hasKind("ArtifactError"));
  assert.deepEqual(await readdir(join(artifacts.root, "text")), []);
}));

test("M6 artifact metadata rejects future schema versions", async () => withRepo(async repo => {
  const run = await RunStore.create(repo), artifacts = await run.openArtifacts();
  await appendFile(artifacts.indexPath, `${JSON.stringify({ schemaVersion: 2, artifactId: "future" })}\n`);
  await assert.rejects(artifacts.listMetadata(), hasKind("UnsupportedSchema"));
}));

test("M6 artifact metadata rejects added fields and mismatched paths", async () => withRepo(async repo => {
  const run = await RunStore.create(repo), artifacts = await run.openArtifacts();
  const stored = await artifacts.storeText("safe");
  const index = artifacts.indexPath;
  await writeFile(index, `${JSON.stringify({ ...stored, rawAuth: "unapproved" })}\n`);
  await assert.rejects(artifacts.listMetadata(), hasKind("ArtifactError"));
  await writeFile(index, `${JSON.stringify({ ...stored, relativePath: "json/different.json" })}\n`);
  await assert.rejects(artifacts.listMetadata(), hasKind("InvalidArtifactPath"));
}));

test("M6.1 artifact serialization failures retain typed causes", async () => withRepo(async repo => {
  const run = await RunStore.create(repo), artifacts = await run.openArtifacts();
  const circular: { self?: unknown } = {}; circular.self = circular;
  for (const write of [() => artifacts.storeJson({ v: 1n }), () => artifacts.storeJson(circular),
    () => artifacts.storeJsonl([{ v: 1n }]), () => artifacts.storeJsonl([circular])]) {
    assert.throws(write, error => error instanceof StorageError && error.kind === "ArtifactError" &&
      !(error instanceof TypeError));
  }
  const unopened = await RunStore.create(repo);
  await mkdir(join(unopened.directory, "artifacts", "index.jsonl"));
  await assert.rejects(ArtifactStore.open(unopened.directory, unopened.runId), hasKind("ArtifactError"));
}));

test("M6 rejects symlink artifact sources and replaced artifact destinations where supported", async t => withRepo(async repo => {
  const run = await RunStore.create(repo), artifacts = await run.openArtifacts();
  const source = join(repo, "source.txt"), link = join(repo, "source-link.txt");
  await writeFile(source, "data");
  try { await symlink(source, link, "file"); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      t.skip("symlink creation is unavailable on this Windows account"); return;
    }
    throw error;
  }
  await assert.rejects(artifacts.copyFile(link), hasKind("ArtifactError"));
  const metadata = await artifacts.storeText("safe");
  const path = await artifacts.getArtifactPath(metadata.artifactId);
  await rm(path);
  await symlink(source, path, "file");
  await assert.rejects(artifacts.getArtifactPath(metadata.artifactId), hasKind("InvalidArtifactPath"));
}));

test("M6 provider and process evidence omit raw identity, env, headers and streams", async () => withRepo(async repo => {
  const secret = "sk-private-123", oauth = "oauth-private-456", header = "header-private-789";
  const redactor = new DiagnosticRedactor([secret, oauth, header]);
  const run = await RunStore.create(repo, {}, redactor), events = await run.openEvents();
  const provider = projectProviderEvidence({ providerId: "claude", transportId: "one-shot",
    requestedModel: "alias", observedModel: "canonical", authLane: "subscriptionToken",
    usage: { inputTokens: 10, estimatedListCostUsd: 0.05 },
    rawAuth: { email: "private@example.com", organizationId: "org_private", token: oauth },
  } as never, redactor);
  assert.equal(provider.requestedModel, "alias"); assert.equal(provider.observedModel, "canonical");
  assert.equal(provider.usage?.outputTokens, undefined);
  await events.append({ type: "ProviderObserved", source: "provider", payload: { evidence: provider } });
  const outcome: ProcessOutcome = { executable: "C:\\secret\\claude.exe",
    args: ["--model", "opus", "--token=hidden", oauth, "--tools", "Read"], cwd: "C:\\private\\repo",
    pid: 123, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 20,
    exitCode: null, signal: null, stdout: `stdout ${secret}`, stderr: `stderr ${header}`,
    stdoutTruncated: true, stderrTruncated: false, stdinWriteStatus: "acceptedByPipe",
    observerIssues: [], termination: { reason: "timeout", forced: true, method: "taskkill" },
    environment: { ANTHROPIC_API_KEY: secret } } as ProcessOutcome;
  const processEvidence = processEvidenceFromOutcome(outcome, redactor);
  assert.equal(processEvidence.killedByFusion, true);
  assert.equal(processEvidence.cancellationReason, "timeout");
  assert.equal(processEvidence.cleanup, "taskkill");
  assert.equal(processEvidence.stdoutTruncated, true);
  assert.deepEqual(processEvidence.argumentFlags, ["--model", "--tools"]);
  await events.append({ type: "ProcessObserved", source: "process", payload: { evidence: processEvidence } });
  const raw = await readFile(events.path, "utf8");
  for (const forbidden of [secret, oauth, header, "private@example.com", "org_private", "rawAuth", "organizationId",
    "stdout sk", "C:\\private\\repo", "--token=hidden"]) assert.equal(raw.includes(forbidden), false, forbidden);
  assert.equal(raw.includes("estimatedListCostUsd"), true);
  assert.equal(raw.includes("actualCost"), false);
}));

test("M6.1 normalized subscription quota survives evidence projection without account identity", async () => withRepo(async repo => {
  const run = await RunStore.create(repo), events = await run.openEvents();
  const quota = { tier: "team", observedAtMs: 1000,
    window: { usedPercent: 42, resetsAtMs: 2000, windowDurationMins: 300 },
    weekly: { usedPercent: 17, resetsAtMs: 3000 },
    accountEmail: "private@example.com", organizationId: "org_private" };
  const evidence = projectProviderEvidence({ providerId: "muse", transportId: "msp", requestedModel: "model",
    usage: { subscription: quota } }, new DiagnosticRedactor());
  assert.deepEqual(evidence.usage?.subscription, { tier: "team", observedAtMs: 1000,
    window: { usedPercent: 42, resetsAtMs: 2000, windowDurationMins: 300 },
    weekly: { usedPercent: 17, resetsAtMs: 3000 } });
  assert.equal(projectProviderEvidence({ providerId: "muse", transportId: "msp", requestedModel: "model" },
    new DiagnosticRedactor()).usage, undefined);
  await events.append({ type: "ProviderObserved", source: "provider", payload: { evidence } });
  const raw = await readFile(events.path, "utf8");
  assert.equal(raw.includes("private@example.com"), false);
  assert.equal(raw.includes("org_private"), false);
  assert.equal(raw.includes("subscription"), true);
}));

test("M6 process evidence distinguishes normal exit, graceful cancel and forced kill", () => {
  const base: ProcessOutcome = { executable: "C:\\bin\\worker.exe", args: ["--safe"], cwd: "C:\\workspace",
    pid: 1, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 12,
    exitCode: 0, signal: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: true,
    stdinWriteStatus: "notProvided", observerIssues: [] };
  const redactor = new DiagnosticRedactor();
  const normal = processEvidenceFromOutcome(base, redactor);
  assert.equal(normal.killedByFusion, false); assert.equal(normal.cleanup, "none");
  assert.equal(normal.exitCode, 0); assert.equal(normal.stderrTruncated, true);
  const cancelled = processEvidenceFromOutcome({ ...base, exitCode: null,
    termination: { reason: "user", forced: false, method: "none" } }, redactor);
  assert.equal(cancelled.cancellationReason, "user"); assert.equal(cancelled.killedByFusion, false);
  const forced = processEvidenceFromOutcome({ ...base, exitCode: null,
    termination: { reason: "timeout", forced: true, method: "directKill", cleanupError: "fallback" } }, redactor);
  assert.equal(forced.cancellationReason, "timeout"); assert.equal(forced.killedByFusion, true);
  assert.equal(forced.cleanup, "failed");
});

test("M6 JSON artifacts redact known secrets and refuse raw transcript/env shapes", async () => withRepo(async repo => {
  const redactor = new DiagnosticRedactor(["api-secret", "oauth-secret", "header-secret"]);
  const run = await RunStore.create(repo, {}, redactor), artifacts = await run.openArtifacts();
  const text = await artifacts.storeText("api-secret oauth-secret header-secret private@example.com org_private");
  const rawText = await readFile(await artifacts.getArtifactPath(text.artifactId), "utf8");
  for (const secret of ["api-secret", "oauth-secret", "header-secret", "private@example.com", "org_private"])
    assert.equal(rawText.includes(secret), false);
  const json = await artifacts.storeJson({ apiKey: "api-secret", note: "header-secret" });
  const rawJson = await readFile(await artifacts.getArtifactPath(json.artifactId), "utf8");
  assert.equal(rawJson.includes("api-secret"), false); assert.equal(rawJson.includes("header-secret"), false);
  const nested = await artifacts.storeJson({ items: ["api-secret", { note: "https://example.test/?access_token=url-secret" },
    "Authorization: Bearer bearer-secret"] });
  const nestedRaw = await readFile(await artifacts.getArtifactPath(nested.artifactId), "utf8");
  for (const secret of ["api-secret", "url-secret", "bearer-secret"])
    assert.equal(nestedRaw.includes(secret), false);
  assert.throws(() => artifacts.storeJson({ environment: { HOME: "secret" } }), hasKind("ArtifactError"));
  assert.throws(() => artifacts.storeJsonl([{ transcript: ["raw conversation"] }]), hasKind("ArtifactError"));
}));

test("M6 metrics preserve unknowns and distinguish list estimate from billing", async () => withRepo(async repo => {
  const run = await RunStore.create(repo), events = await run.openEvents();
  const unknown = aggregateRunMetrics(run.runId, []);
  assert.equal(unknown.inputTokens, undefined);
  assert.equal(unknown.estimatedListCostUsd, undefined);
  assert.equal(unknown.providerRunCount, undefined);
  const aggregate = aggregateRunMetrics(run.runId, [{ providerRunCount: 1, inputTokens: 10,
    estimatedListCostUsd: 0.1 }, { providerRunCount: 1, outputTokens: 8, estimatedListCostUsd: 0.2,
      retries: 1, verificationFailures: 2, confirmedFindings: 1 }]);
  assert.equal(aggregate.providerRunCount, 2);
  assert.equal(aggregate.inputTokens, 10); assert.equal(aggregate.outputTokens, 8);
  assert.equal(aggregate.estimatedListCostUsd, 0.30000000000000004);
  assert.equal(JSON.stringify(aggregate).includes("actual"), false);
  const metrics = run.openMetrics(); await metrics.write(aggregate);
  assert.equal((await metrics.read())?.providerRunCount, 2);
  await events.append({ type: "RunStarted", source: "runtime", payload: { workflowId: "review", risk: "high" } });
  await events.append({ type: "ProviderObserved", source: "provider", payload: { evidence: {
    providerId: "claude", transportId: "one-shot", requestedModel: "opus",
    usage: { inputTokens: 7, estimatedListCostUsd: 0.04 } } } });
  await events.append({ type: "RunCompleted", source: "runtime", payload: { wallTimeMs: 100 } });
  const derived = metricsFromEvents(run.runId, (await events.listEvents()).events);
  assert.equal(derived.success, true); assert.equal(derived.wallTimeMs, 100);
  assert.equal(derived.providerRunCount, 1); assert.equal(derived.estimatedListCostUsd, 0.04);
  assert.equal(derived.outputTokens, undefined);
}));

test("M6 metrics reject future schemas and no provider executable is used", async () => withRepo(async repo => {
  const run = await RunStore.create(repo), metrics = run.openMetrics();
  await writeFile(metrics.path, JSON.stringify({ schemaVersion: 2, runId: run.runId }));
  await assert.rejects(metrics.read(), hasKind("UnsupportedSchema"));
  assert.equal((await lstat(join(repo, ".fusion"))).isDirectory(), true);
  assert.equal((await readdir(repo)).includes(".fusion"), true);
}));

test("M6.1 non-finite metric samples fail without becoming persisted values", async () => withRepo(async repo => {
  const run = await RunStore.create(repo);
  for (const sample of [{ retries: Number.NaN }, { inputTokens: Number.POSITIVE_INFINITY },
    { wallTimeMs: Number.NEGATIVE_INFINITY }])
    assert.throws(() => aggregateRunMetrics(run.runId, [sample]), hasKind("StorageError"));
}));

test("M6.1 settled queue entries are released across many runs", async () => withRepo(async repo => {
  const runs = await Promise.all(Array.from({ length: 20 }, () => RunStore.create(repo)));
  await Promise.all(runs.map(async run => {
    await Promise.all([run.updateManifest({ workflowId: "audit" }), run.updateManifest({ risk: "low" })]);
    const events = await run.openEvents(), artifacts = await run.openArtifacts();
    await Promise.all([events.append({ type: "RunStarted", source: "runtime", payload: {} }),
      artifacts.storeText("safe")]);
  }));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(pendingManifestQueueCount(), 0);
  assert.equal(pendingEventQueueCount(), 0);
  assert.equal(pendingArtifactQueueCount(), 0);
}));

test("M6.1 an older settled tail cannot remove a newer same-path queue", async () => {
  const queues = new Map<string, { tail: Promise<void> }>();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = enqueuePath(queues, "path", () => ({ tail: Promise.resolve() }), async () => 1);
  const second = first.then(() => enqueuePath(queues, "path", () => ({ tail: Promise.resolve() }),
    async () => { await gate; return 2; }));
  await first;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(queues.size, 1);
  release();
  assert.equal(await second, 2);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(queues.size, 0);
});
