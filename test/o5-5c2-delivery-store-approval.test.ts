import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { prepareRunDelivery } from "../src/app/delivery-composition.js";
import { deliveryIdFor, isDisposableDeliveryTarget, liveDeliveryAuthorization, checkoutDigest, prepareStoredDelivery } from "../src/app/delivery-service.js";
import type { ProviderRegistry } from "../src/app/providers.js";
import { QUOTE_BUGGY, QUOTE_FIXED, QUOTE_TEST } from "../src/app/route-fixture.js";
import { REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport } from "../src/app/writer-gate.js";
import { parseArgs, USAGE, UsageError } from "../src/cli/args.js";
import { APPROVAL_QUESTION } from "../src/cli/render-delivery.js";
import { runCli } from "../src/cli/run.js";
import { approvalFromHumanRecord, DeliveryRecord, humanApprovalRecord } from "../src/core/delivery/approval.js";
import { canonicalJson } from "../src/core/delivery/canonical.js";
import { MAX_DIFF_LINES, unifiedDiff } from "../src/core/delivery/diff.js";
import type { ChangeSet } from "../src/core/domain.js";
import { FusionFailure } from "../src/core/errors.js";
import type { WorkflowResult } from "../src/core/workflow/types.js";
import { LocalFilesystemDeliveryApplier, type DeliveryFaults } from "../src/platform/delivery/applier.js";
import { DELIVERY_STORE_LIMITS, FilesystemDeliveryStore } from "../src/platform/delivery/store.js";
import { ProcessGitClient, type GitClient, type GitResult, type GitRunOptions } from "../src/platform/workspace/git.js";
import { providerWorkspaceStatePaths } from "../src/runtime/provider-profiles.js";
import { changeSet } from "./fixtures/fake-writer.js";
import { git, gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5C2 — the persistent delivery store, `fusion inspect-delivery`, durable human approval and the gated `fusion apply`,
 * offline: throw-away Git repositories under the system temporary directory only. No provider, no model, no network; the
 * fusion-cli checkout itself is never a target.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const kind = (expected: string) => (error: unknown) => error instanceof FusionFailure && error.error.kind === expected;
const MONEY = "export const cents = (value: number): number => Math.round(value);\n";
const OLD_DOC = "# Old notes\n";
const ENV_CANARY = "FUSION-DELIVERY-ENV-CANARY-7c20";
const PROVIDER_CANARY = "PROVIDER-REPLY-CANARY-c2f1";
const DISCOUNT = "export const FULL = 10_000;\n";
const UPDATE = changeSet([["src/quote.ts", QUOTE_BUGGY, QUOTE_FIXED]]);
const CREATE = changeSet([["src/lib/discount.ts", null, DISCOUNT]]);
const DELETE = changeSet([["docs/old.md", OLD_DOC, null]]);
const MULTI = changeSet([["src/quote.ts", QUOTE_BUGGY, QUOTE_FIXED], ["src/lib/discount.ts", null, DISCOUNT], ["docs/old.md", OLD_DOC, null]]);
const FIXED_NOW = () => new Date("2026-09-26T10:00:00.000Z");

/** A clean throw-away primary under the temporary directory: committed files, an ignored `.env` canary, nothing else. */
async function withPrimary<T>(work: (root: string, dir: string) => Promise<T>): Promise<T> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "fusion-c2-")));
  try {
    const root = join(dir, "primary");
    const files: Record<string, string> = { ".gitignore": "node_modules/\n.env\n*.local\n", "src/quote.ts": QUOTE_BUGGY, "test/quote.test.ts": QUOTE_TEST,
      "src/money.ts": MONEY, "docs/old.md": OLD_DOC, "README.md": "# Primary\n" };
    for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); }
    git(root, "init", "-q");
    git(root, "add", ".");
    git(root, "commit", "-qm", "baseline");
    await writeFile(join(root, ".env"), `TOKEN=${ENV_CANARY}\n`);
    return await work(root, dir);
  } finally {
    assert.ok(dir.toLowerCase().startsWith(`${(await realpath(tmpdir())).toLowerCase()}${sep}`), "only temporary repositories are used");
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
/** Every file of the primary outside `.git`, by content digest (O5.5C2.1: Fusion writes no state into the primary). */
async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name), rel = relative(root, path).split(sep).join("/");
    if (!entry.isFile() || rel.startsWith(".git/")) continue;
    files[rel] = sha256(await readFile(path));
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : 1));
}
function acceptedResult(changes: ChangeSet, reviews: WorkflowResult["reviews"] = []): WorkflowResult {
  return { state: "completed", transitions: [], delegateAttempts: 1, reviews, changeSet: changes,
    applied: changes.operations.map(op => op.kind === "delete"
      ? { kind: op.kind, path: op.path, beforeSha256: op.expectedSha256, afterSha256: null, bytes: 0 }
      : { kind: op.kind, path: op.path, beforeSha256: op.expectedSha256, afterSha256: sha256(op.content), bytes: Buffer.byteLength(op.content) }),
    verification: { passed: true, commandsRun: 2, evidence: { backendId: "docker-linux", confinement: "osSandbox", platformRequirement: "linux-compatible",
      acceptance: "granted", commands: [{ id: "typecheck", status: "passed", exitCode: 0 }, { id: "unit", status: "passed", exitCode: 0 }] } } };
}
/** A clean review whose one finding (carrying provider text) was adjudicated away. */
function reviewedClean(): WorkflowResult["reviews"] {
  const finding = { id: "r1-F1", severity: "LOW" as const, confidence: "HIGH" as const, category: "tests", title: `title ${PROVIDER_CANARY}`,
    evidence: [`evidence ${PROVIDER_CANARY}`], failureScenario: PROVIDER_CANARY, facts: [], source: { role: "Reviewer" as const, runId: "c2-run", sessionId: "s", cycle: 1 } };
  return [{ cycle: 1, outcome: "clean", findings: [finding], adjudications: [{ finding, verdict: "REJECTED", rationale: `rationale ${PROVIDER_CANARY}`,
    requiredAction: "none", verdictSource: "lead", supportedFacts: [] }] }];
}
/** Records every Git invocation (argv) and forwards it to the isolated-config client. */
class SpyGit implements GitClient {
  readonly calls: string[][] = [];
  constructor(private readonly inner: GitClient) {}
  run(args: readonly string[], options: GitRunOptions): Promise<GitResult> { this.calls.push([...args]); return this.inner.run(args, options); }
}
const isolatedGit = async () => new SpyGit(await ProcessGitClient.fromPath(process.env, true));
const scopeOf = (changes: ChangeSet) => ({ allowedPaths: changes.operations.map(op => op.path), forbiddenPaths: [] });
const baseOf = (root: string) => git(root, "rev-parse", "HEAD").trim();
async function stored(root: string, changes: ChangeSet, gitClient: GitClient, options: { reviews?: WorkflowResult["reviews"]; runId?: string } = {}) {
  return prepareStoredDelivery({ runId: options.runId ?? "c2-run", taskSha256: "a".repeat(64), workflowEvidenceSha256: "b".repeat(64),
    result: acceptedResult(changes, options.reviews), scope: scopeOf(changes), baseCommit: baseOf(root), primaryRoot: root, git: gitClient,
    storeBase: stateBase(root), now: FIXED_NOW });
}
/** The injected delivery-state base: next to the primary, OUTSIDE it (O5.5C2.1), inside the temporary directory. */
const stateBase = (root: string) => join(dirname(root), "delivery-state");
const identityOf = (root: string) => sha256(git(root, "rev-list", "--max-parents=0", "HEAD").split(/\r?\n/u).filter(Boolean).sort().join("\n"));
const namespaceOf = (root: string) => join(stateBase(root), identityOf(root));
const storeOf = (root: string) => new FilesystemDeliveryStore(namespaceOf(root));
const storeDir = (root: string, id: string) => join(namespaceOf(root), id);
/** Only the identity reads that locate a delivery (no status, no check-ignore, no config: no precheck ran). */
const identityReadsOnly = (calls: readonly string[][]) => calls.length > 0 && calls.every(call => call[0] === "rev-parse" || call[0] === "rev-list");
async function storeFiles(root: string, id: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of (await readdir(storeDir(root, id))).sort()) out[name] = sha256(await readFile(join(storeDir(root, id), name)));
  return out;
}
async function eventsOf(root: string, id: string): Promise<Array<Record<string, any>>> {
  const text = await readFile(join(storeDir(root, id), "events.jsonl"), "utf8");
  return text.split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, any>);
}
const eventTypes = async (root: string, id: string) => (await eventsOf(root, id)).map(event => event.type as string);

/** A registry whose every access is recorded: the delivery commands must never reach a provider factory. */
function sealedRegistry(): { registry: ProviderRegistry; touched: string[] } {
  const touched: string[] = [];
  const factories = new Proxy(new Map(), { get(target, prop) {
    touched.push(String(prop));
    const value = Reflect.get(target, prop, target) as unknown;
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
  } }) as unknown as ProviderRegistry["factories"];
  return { touched, registry: { factories, defaults: { schemaVersion: 1, bindings: [], verification: { commands: [] }, limits: { runTimeoutMs: 60_000 } } } };
}
interface Ran { code: number; stdout: string; stderr: string; questions: string[] }
interface CliOptions {
  git?: GitClient; disposable?: readonly string[]; faults?: DeliveryFaults; interactive?: boolean; env?: NodeJS.ProcessEnv; registry?: ProviderRegistry;
  answer?: string | null | ((question: string) => Promise<string | null>);
}
async function cli(argv: string[], cwd: string, options: CliOptions = {}): Promise<Ran> {
  let stdout = "", stderr = "";
  const questions: string[] = [];
  const answer = options.answer;
  const code = await runCli(argv, { stdout: t => { stdout += t; }, stderr: t => { stderr += t; }, interactive: options.interactive ?? false,
    ...(answer === undefined ? {} : { prompt: async (question: string) => {
      questions.push(question);
      return typeof answer === "function" ? answer(question) : answer;
    } }) },
    { env: { ...process.env, ...options.env }, cwd, registry: options.registry ?? sealedRegistry().registry, deliveryStoreRoot: stateBase(cwd), ...(options.git ? { git: options.git } : {}),
      ...(options.disposable ? { disposableDeliveryTargets: options.disposable } : {}), ...(options.faults ? { deliveryFaults: options.faults } : {}) });
  return { code, stdout, stderr, questions };
}
/** A stored delivery a human approved by typing its digest (the CLI path). */
async function approvedDelivery(root: string, changes: ChangeSet, gitClient: GitClient) {
  const delivery = await stored(root, changes, gitClient);
  const ran = await cli(["approve-delivery", delivery.deliveryId], root, { git: gitClient, interactive: true, answer: delivery.manifestSha256 });
  assert.equal(ran.code, 0, ran.stderr);
  return delivery;
}
/** The serialized bundle with the first post-image's content changed (same length, still valid base64). */
function tamperedBundle(text: string): string {
  const changed = text.replace(/"contentBase64":"([A-Za-z0-9+/]{4})/u, (_m, head: string) => `"contentBase64":"${head === "AAAA" ? "BBBB" : "AAAA"}`);
  assert.notEqual(changed, text, "the bundle was really tampered with");
  return changed;
}
const stagingEntries = async (root: string) => {
  const parent = join(root, ".git", "fusion-delivery");
  return existsSync(parent) ? await readdir(parent) : [];
};

// ---------------------------------------------------------------- store (O5.5C2.1: the injected root is outside the primary)

test("O5.5C2 store (1-3): prepare persists the exact canonical artifacts outside the tracked tree, write-once; the same id with other bytes is refused", { skip }, async () =>
  withPrimary(async root => {
    const gitClient = await isolatedGit();
    const before = await snapshot(root);
    const delivery = await stored(root, MULTI, gitClient, { reviews: reviewedClean() });
    assert.equal(delivery.state, "prepared");
    assert.match(delivery.deliveryId, /^d-[0-9a-f]{24}$/u);
    assert.equal(delivery.deliveryId, deliveryIdFor("c2-run", acceptedResult(MULTI), baseOf(root)), "the id is deterministic in the run, change and baseline");
    const dir = storeDir(root, delivery.deliveryId);
    assert.deepEqual((await readdir(dir)).sort(), ["bundle.json", "events.jsonl", "manifest.json", "record.json"], "no approval yet, no temporary file left");
    const manifestText = await readFile(join(dir, "manifest.json"), "utf8");
    assert.equal(sha256(manifestText), delivery.manifestSha256, "the stored manifest bytes are the digest's preimage");
    assert.equal(canonicalJson(JSON.parse(manifestText)), manifestText, "stored canonical");
    const manifest = JSON.parse(manifestText) as Record<string, any>;
    const record = JSON.parse(await readFile(join(dir, "record.json"), "utf8")) as Record<string, any>;
    assert.deepEqual([record.format, record.deliveryId, record.manifestSha256, record.bundleSha256, record.bundleFileSha256, record.reference],
      ["fusion.deliveryStoreRecord", delivery.deliveryId, delivery.manifestSha256, manifest.change.bundleSha256,
        sha256(await readFile(join(dir, "bundle.json"))), { runId: "c2-run", workflowEvidenceSha256: "b".repeat(64), checkoutSha256: checkoutDigest(root) }]);
    const events = await eventsOf(root, delivery.deliveryId);
    assert.deepEqual(events.map(e => [e.seq, e.type, e.at, e.touchedPaths, e.expectedHead]), [[1, "prepared", "2026-09-26T10:00:00.000Z", 3, baseOf(root)]]);
    // The primary is untouched; the store is outside it (O5.5C2.1).
    assert.deepEqual(await snapshot(root), before);
    assert.equal(git(root, "status", "--porcelain=v1", "-uall"), "");
    assert.ok(relative(root, dir).startsWith(".."), "the store is outside the primary");
    assert.ok(!existsSync(join(root, ".fusion")), "nothing is written into the primary");
    // Idempotent: the same delivery prepared again changes nothing.
    const files = await storeFiles(root, delivery.deliveryId);
    const again = await stored(root, MULTI, gitClient, { reviews: reviewedClean() });
    assert.deepEqual([again.deliveryId, again.manifestSha256, again.state], [delivery.deliveryId, delivery.manifestSha256, "prepared"]);
    assert.deepEqual(await storeFiles(root, delivery.deliveryId), files);
    // The same id with different bytes is refused; nothing is replaced.
    const other = await prepareRunDelivery({ deliveryId: delivery.deliveryId, runId: "c2-run", taskSha256: "a".repeat(64), workflowEvidenceSha256: "b".repeat(64),
      result: acceptedResult(UPDATE), scope: scopeOf(UPDATE), baseCommit: baseOf(root), primaryRoot: root, git: gitClient });
    const store = storeOf(root);
    await assert.rejects(store.put(other, { runId: "c2-run", workflowEvidenceSha256: "b".repeat(64), checkoutSha256: checkoutDigest(root) },
      FIXED_NOW().toISOString()), kind("SecurityViolation"));
    assert.deepEqual(await storeFiles(root, delivery.deliveryId), files, "stored artifacts are never replaced");
    assert.deepEqual(await store.list(), [delivery.deliveryId]);
    // No provider text and no credential is persisted; only the bundle carries file content (the exact post-images).
    for (const name of ["manifest.json", "record.json", "events.jsonl"]) {
      const text = await readFile(join(dir, name), "utf8");
      for (const hidden of [PROVIDER_CANARY, ENV_CANARY, "rationale", QUOTE_FIXED.slice(0, 40)]) assert.ok(!text.includes(hidden), `${name} carries no ${hidden}`);
    }
    const bundleText = await readFile(join(dir, "bundle.json"), "utf8");
    for (const hidden of [PROVIDER_CANARY, ENV_CANARY]) assert.ok(!bundleText.includes(hidden));
  }));

test("O5.5C2 store (4, 5): every read revalidates every artifact; corruption and tampering fail closed; the id alone is never trusted", { skip }, async () =>
  withPrimary(async root => {
    const gitClient = await isolatedGit();
    const delivery = await stored(root, MULTI, gitClient);
    const id = delivery.deliveryId, dir = storeDir(root, id), store = storeOf(root);
    const original: Record<string, Buffer> = {};
    for (const name of await readdir(dir)) original[name] = await readFile(join(dir, name));
    const restore = async () => {
      for (const name of await readdir(dir)) if (!(name in original)) await unlink(join(dir, name));
      for (const [name, bytes] of Object.entries(original)) await writeFile(join(dir, name), bytes);
    };
    const text = (name: string) => original[name]!.toString("utf8");
    const manifest = JSON.parse(text("manifest.json")) as Record<string, any>;
    const record = JSON.parse(text("record.json")) as Record<string, any>;
    const event = JSON.parse(text("events.jsonl").trim()) as Record<string, any>;
    const variants: Array<[string, () => Promise<void>]> = [
      ["manifest not canonical", () => writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2))],
      ["manifest content changed", () => writeFile(join(dir, "manifest.json"), canonicalJson({ ...manifest, request: { ...manifest.request, taskSha256: "c".repeat(64) } }))],
      ["manifest missing", () => unlink(join(dir, "manifest.json"))],
      ["manifest oversized", () => writeFile(join(dir, "manifest.json"), " ".repeat(DELIVERY_STORE_LIMITS.manifestBytes + 1))],
      ["bundle content changed", () => writeFile(join(dir, "bundle.json"), tamperedBundle(text("bundle.json")))],
      ["record binds another manifest", () => writeFile(join(dir, "record.json"), canonicalJson({ ...record, manifestSha256: "0".repeat(64) }))],
      ["record extra field", () => writeFile(join(dir, "record.json"), canonicalJson({ ...record, note: "x" }))],
      ["torn event", () => writeFile(join(dir, "events.jsonl"), text("events.jsonl").trimEnd())],
      ["empty event log", () => writeFile(join(dir, "events.jsonl"), "")],
      ["event out of order", () => writeFile(join(dir, "events.jsonl"), `${text("events.jsonl")}${canonicalJson({ ...event, seq: 2, type: "applied" })}\n`)],
      ["event of another manifest", () => writeFile(join(dir, "events.jsonl"), `${canonicalJson({ ...event, manifestSha256: "0".repeat(64) })}\n`)],
      ["event not canonical", () => writeFile(join(dir, "events.jsonl"), `${JSON.stringify(event, null, 1).replace(/\n/gu, "")}\n`)],
      ["forged approval", () => writeFile(join(dir, "approval.json"), canonicalJson({ ...humanApprovalRecord({ manifest: manifest as any, typed: delivery.manifestSha256,
        approvedAt: FIXED_NOW().toISOString() }), manifestSha256: "0".repeat(64) }))],
      ["approval without its event after apply", async () => {
        await writeFile(join(dir, "approval.json"), canonicalJson(humanApprovalRecord({ manifest: manifest as any, typed: delivery.manifestSha256, approvedAt: FIXED_NOW().toISOString() })));
        await writeFile(join(dir, "events.jsonl"), `${text("events.jsonl")}${canonicalJson({ ...event, seq: 2, type: "applyStarted" })}\n`);
      }],
    ];
    for (const [name, tamper] of variants) {
      await tamper();
      await assert.rejects(store.load(id), (error: unknown) => kind("SecurityViolation")(error) &&
        /corrupt/u.test((error as FusionFailure).error.safeMessage), name);
      const ran = await cli(["inspect-delivery", id], root, { git: gitClient });
      assert.deepEqual([ran.code, ran.stdout], [4, ""], `${name}: inspect refuses corrupt data`);
      assert.match(ran.stderr, /corrupt/u);
      await restore();
      assert.equal((await store.load(id)).state, "prepared", `${name}: restored`);
    }
    // The directory name is never trusted alone: the same artifacts under another id are refused.
    await cp(dir, storeDir(root, "d-renamed"), { recursive: true });
    await assert.rejects(store.load("d-renamed"), kind("SecurityViolation"));
    await rm(storeDir(root, "d-renamed"), { recursive: true });
    for (const bad of ["../x", "a/b", "", ".hidden", "x".repeat(101)]) await assert.rejects(store.load(bad), kind("InvalidInput"), bad);
    await assert.rejects(store.load("d-unknown"), kind("InvalidInput"));
    assert.equal((await cli(["inspect-delivery", "d-unknown"], root, { git: gitClient })).code, 2);
    assert.equal((await cli(["inspect-delivery", "../x"], root, { git: gitClient })).code, 2);
  }));

test("O5.5C2 store (6): links and reparse points are refused for the root and each delivery; the root must be absolute", { skip }, async () =>
  withPrimary(async (root, dir) => {
    assert.throws(() => new FilesystemDeliveryStore("relative/store"), kind("InvalidInput"));
    const gitClient = await isolatedGit();
    const delivery = await stored(root, UPDATE, gitClient);
    const outside = join(dir, "outside");
    await cp(storeDir(root, delivery.deliveryId), join(outside, delivery.deliveryId), { recursive: true });
    const link = async (target: string, path: string) => {
      try { await symlink(target, path, process.platform === "win32" ? "junction" : "dir"); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") return false; throw error; }
    };
    // A delivery directory that is a link (junction) to identical artifacts elsewhere.
    const linked = join(namespaceOf(root), "d-linked");
    if (await link(join(outside, delivery.deliveryId), linked))
      await assert.rejects(storeOf(root).load("d-linked"), kind("SecurityViolation"));
    // A store root that is a link.
    const linkedRoot = join(dir, "linked-root");
    if (await link(namespaceOf(root), linkedRoot))
      await assert.rejects(new FilesystemDeliveryStore(linkedRoot).load(delivery.deliveryId), kind("SecurityViolation"));
  }));

// ---------------------------------------------------------------- preparation

test("O5.5C2 preparation: only a completed, verified, review-clean result is stored; a refusal stores nothing and the primary is untouched", { skip }, async () =>
  withPrimary(async root => {
    const gitClient = await isolatedGit();
    const before = await snapshot(root);
    const accepted = acceptedResult(UPDATE);
    const base = { runId: "c2-run", taskSha256: "a".repeat(64), workflowEvidenceSha256: "b".repeat(64), scope: scopeOf(UPDATE), primaryRoot: root, git: gitClient,
      storeBase: stateBase(root) };
    const refusals: Array<[string, WorkflowResult, string, string?]> = [
      ["failed run", { ...accepted, state: "decisionRequired" }, "InvalidInput"],
      ["verification failed", { ...accepted, verification: { ...accepted.verification!, passed: false } }, "InvalidInput"],
      ["unverified (offline rehearsal)", { ...accepted, verification: { ...accepted.verification!, evidence: { ...accepted.verification!.evidence!, acceptance: "offlineRehearsal" } } },
        "SecurityViolation"],
      ["review-blocked", { ...accepted, reviews: [{ cycle: 1, outcome: "correction", findings: [], adjudications: [] }] }, "InvalidInput"],
      ["baseline is not HEAD", accepted, "WorkspaceConflict", "0".repeat(40)],
    ];
    for (const [name, result, expected, baseCommit] of refusals) {
      await assert.rejects(prepareStoredDelivery({ ...base, result, baseCommit: baseCommit ?? baseOf(root) }), kind(expected), name);
      assert.ok(!existsSync(stateBase(root)), `${name}: nothing stored`);
    }
    assert.deepEqual(await snapshot(root), before, "the primary is untouched");
  }));

// ---------------------------------------------------------------- inspect

test("O5.5C2 inspect (7-10): digests, target, changes, hashes, evidence, policy, approval and a verified diff; read-only and provider-free", { skip }, async () =>
  withPrimary(async root => {
    const spy = await isolatedGit();
    const delivery = await stored(root, MULTI, spy, { reviews: reviewedClean() });
    const id = delivery.deliveryId, digest = delivery.manifestSha256;
    const manifest = JSON.parse(await readFile(join(storeDir(root, id), "manifest.json"), "utf8")) as Record<string, any>;
    const storeBefore = await storeFiles(root, id), repoBefore = await snapshot(root);
    spy.calls.length = 0;
    const { registry, touched } = sealedRegistry();
    const ran = await cli(["inspect-delivery", id], root, { git: spy, registry });
    assert.equal(ran.code, 0, ran.stderr);
    const lines = ran.stdout.split("\n");
    assert.deepEqual(lines.slice(0, 3), [`Delivery: ${id}`, "State: prepared", `Manifest: sha256:${digest}`]);
    for (const expected of [`Bundle: sha256:${manifest.change.bundleSha256}`, `Target: repository sha256:${manifest.primary.repositoryIdentity}`,
      `  base ${baseOf(root)} (tree ${manifest.primary.baseTree}), clean tree required`, "Changes: 1 create, 1 update, 1 delete",
      "  M src/quote.ts", "  A src/lib/discount.ts", "  D docs/old.md",
      "Verification: PASS (docker-linux, osSandbox, 2 command(s), acceptance granted)",
      "Review: CLEAN (1 cycle(s), 1 finding(s) adjudicated, 0 outstanding)", "Approved: NO", "Events: prepared",
      `  before: sha256:${sha256(QUOTE_BUGGY)}`, `  after:  sha256:${sha256(QUOTE_FIXED)} (${Buffer.byteLength(QUOTE_FIXED)} bytes)`,
      "  before: none", `  after:  sha256:${sha256(DISCOUNT)} (${Buffer.byteLength(DISCOUNT)} bytes)`, `  before: sha256:${sha256(OLD_DOC)}`, "  after:  none",
      "  --- a/src/quote.ts", "  +++ b/src/quote.ts", "  --- /dev/null", "  +++ b/src/lib/discount.ts", "  @@ -0,0 +1,1 @@", `  +${DISCOUNT.trimEnd()}`,
      "  --- a/docs/old.md", "  +++ /dev/null", "  @@ -1,1 +0,0 @@", `  -${OLD_DOC.trimEnd()}`])
      assert.ok(lines.includes(expected), `inspect shows ${JSON.stringify(expected)}`);
    assert.match(ran.stdout, /^Safety: scope localWorkingTree, platform (win32|posix), links refuse, ignored paths refuse; caps 32 operation\(s\), \d+ bytes\/file, \d+ bytes total$/mu);
    assert.match(ran.stdout, /forbidden paths: \.claude, \.muse, CLAUDE\.local\.md; forbidden classes: absolutePath, pathTraversal/u);
    // The update's diff is rendered from the verified baseline blob and the bundle's post-image.
    const quoteDiff = unifiedDiff("src/quote.ts", QUOTE_BUGGY, QUOTE_FIXED);
    assert.equal(quoteDiff.status, "rendered");
    if (quoteDiff.status === "rendered") for (const line of quoteDiff.lines) assert.ok(lines.includes(`  ${line}`), line);
    for (const hidden of [PROVIDER_CANARY, ENV_CANARY, "rationale"]) assert.ok(!ran.stdout.includes(hidden), `no ${hidden}`);
    // Read-only: nothing in the store, the primary or a provider was touched; Git only read.
    assert.deepEqual(await storeFiles(root, id), storeBefore);
    assert.deepEqual(await snapshot(root), repoBefore);
    assert.deepEqual(touched, [], "no provider factory was reached");
    assert.ok(spy.calls.length > 0 && spy.calls.every(call => ["rev-parse", "rev-list", "cat-file"].includes(call[0]!)), JSON.stringify(spy.calls));
    // JSON form.
    const json = JSON.parse((await cli(["--json", "inspect-delivery", id], root, { git: spy })).stdout) as { exitCode: number; delivery: Record<string, any> };
    assert.deepEqual([json.exitCode, json.delivery.manifestSha256, json.delivery.state, json.delivery.files.map((f: any) => [f.kind, f.path, f.diffStatus])],
      [0, digest, "prepared", [["update", "src/quote.ts", "rendered"], ["create", "src/lib/discount.ts", "rendered"], ["delete", "docs/old.md", "rendered"]]]);
    // Usage.
    for (const argv of [["inspect-delivery"], ["inspect-delivery", id, "extra"]]) assert.equal((await cli(argv, root, { git: spy })).code, 2);
  }));

test("O5.5C2 diff: a bounded unified diff with exact hunks; oversized input is named, never partial", () => {
  const edit = unifiedDiff("f.txt", "a\nb\nc\n", "a\nB\nc\n");
  assert.deepEqual(edit, { status: "rendered", lines: ["--- a/f.txt", "+++ b/f.txt", "@@ -1,3 +1,3 @@", " a", "-b", "+B", " c"], truncated: false });
  assert.deepEqual(unifiedDiff("n", null, "x\n"), { status: "rendered", lines: ["--- /dev/null", "+++ b/n", "@@ -0,0 +1,1 @@", "+x"], truncated: false });
  assert.deepEqual(unifiedDiff("o", "y\n", null), { status: "rendered", lines: ["--- a/o", "+++ /dev/null", "@@ -1,1 +0,0 @@", "-y"], truncated: false });
  const long = Array.from({ length: 20 }, (_, i) => `line ${i}`);
  const changed = long.map((line, i) => i === 1 || i === 18 ? `${line} changed` : line);
  const twoHunks = unifiedDiff("l", `${long.join("\n")}\n`, `${changed.join("\n")}\n`);
  assert.equal(twoHunks.status, "rendered");
  if (twoHunks.status === "rendered") assert.deepEqual(twoHunks.lines.filter(line => line.startsWith("@@")), ["@@ -1,5 +1,5 @@", "@@ -16,5 +16,5 @@"]);
  assert.deepEqual(unifiedDiff("big", `${"x\n".repeat(MAX_DIFF_LINES + 1)}`, ""), { status: "tooLarge" });
  assert.deepEqual(unifiedDiff("same", "a\n", "a\n"), { status: "rendered", lines: ["--- a/same", "+++ b/same"], truncated: false });
});

// ---------------------------------------------------------------- approval

test("O5.5C2 approval (11-17): only the typed exact digest at an interactive terminal approves; it binds the exact artifacts and is used once", { skip }, async () =>
  withPrimary(async (root, dir) => {
    const spy = await isolatedGit();
    const delivery = await stored(root, UPDATE, spy);
    const id = delivery.deliveryId, digest = delivery.manifestSha256;
    const repoBefore = await snapshot(root);
    // 11. An unapproved delivery cannot be applied — not even into a registered disposable repository; nothing runs.
    spy.calls.length = 0;
    const unapproved = await cli(["apply", id], root, { git: spy, disposable: [root] });
    assert.equal(unapproved.code, 14);
    assert.match(unapproved.stdout, /^Result: approvalRequired$/mu);
    assert.ok(identityReadsOnly(spy.calls), `no precheck ran: ${JSON.stringify(spy.calls)}`);
    assert.deepEqual(await eventTypes(root, id), ["prepared"]);
    // 17. Non-interactive use refuses before asking; --json is not accepted.
    const storeBefore = await storeFiles(root, id);
    const batch = await cli(["approve-delivery", id], root, { git: spy, interactive: false, answer: digest });
    assert.deepEqual([batch.code, batch.questions], [14, []]);
    assert.match(batch.stderr, /needs a human at an interactive terminal; nothing was approved/u);
    assert.throws(() => parseArgs(["--json", "approve-delivery", id]), UsageError);
    assert.equal((await cli(["--json", "approve-delivery", id], root, { git: spy, interactive: true, answer: digest })).code, 2);
    assert.deepEqual(await storeFiles(root, id), storeBefore);
    // 13. Declined or mistyped: nothing changes.
    for (const answer of [null, "", "y", "yes", digest.slice(0, 63), `${digest}0`, digest.toUpperCase(), "0".repeat(64), `sha256:${digest.slice(0, 12)}`]) {
      const ran = await cli(["approve-delivery", id], root, { git: spy, interactive: true, answer });
      assert.deepEqual([ran.code, ran.questions], [13, [APPROVAL_QUESTION]], String(answer));
      assert.match(ran.stderr, /nothing was approved/u);
    }
    assert.deepEqual(await storeFiles(root, id), storeBefore, "no declined or mistyped answer wrote anything");
    // 12. The exact digest, typed after the summary, creates the durable approval.
    const approve = await cli(["approve-delivery", id], root, { git: spy, interactive: true, answer: `sha256:${digest}` });
    assert.equal(approve.code, 0, approve.stderr);
    assert.equal(approve.questions[0], "Type the exact manifest digest to approve: ");
    for (const expected of [`Approve delivery ${id}`, `Manifest SHA-256: ${digest}`, `Target HEAD: ${baseOf(root)} (must be unchanged, clean tree required)`,
      "Operations: 0 create, 1 update, 0 delete", "  M src/quote.ts"]) assert.ok(approve.stdout.split("\n").includes(expected), expected);
    assert.match(approve.stdout, /This approval covers only this exact manifest digest/u);
    assert.match(approve.stdout, new RegExp(`Approved delivery ${id} for manifest sha256:${digest} only\\.`, "u"));
    assert.deepEqual(await eventTypes(root, id), ["prepared", "approved"]);
    // 14, 15. It binds the delivery id, the manifest and bundle digests, the repository identity and the base commit.
    const approval = JSON.parse(await readFile(join(storeDir(root, id), "approval.json"), "utf8")) as Record<string, any>;
    const manifest = JSON.parse(await readFile(join(storeDir(root, id), "manifest.json"), "utf8")) as Record<string, any>;
    assert.deepEqual([approval.format, approval.deliveryId, approval.manifestSha256, approval.bundleSha256, approval.repositoryIdentity, approval.baseCommit,
      approval.confirmation], ["fusion.deliveryHumanApproval", id, digest, manifest.change.bundleSha256, manifest.primary.repositoryIdentity, baseOf(root),
      "typedManifestSha256"]);
    const inspect = await cli(["inspect-delivery", id], root, { git: spy });
    assert.match(inspect.stdout, new RegExp(`^Approved: YES \\(covers manifest sha256:${digest} and bundle sha256:${manifest.change.bundleSha256};`, "mu"));
    const loaded = await storeOf(root).load(id);
    assert.equal(approvalFromHumanRecord(loaded.approval, loaded.manifest).manifestSha256, digest);
    for (const [name, forged] of [["manifest digest", { manifestSha256: "0".repeat(64) }], ["bundle digest", { bundleSha256: "0".repeat(64) }],
      ["repository", { repositoryIdentity: "0".repeat(64) }], ["base commit", { baseCommit: "0".repeat(40) }], ["delivery", { deliveryId: "d-other" }]] as const)
      assert.throws(() => approvalFromHumanRecord({ ...loaded.approval, ...forged }, loaded.manifest), kind("SecurityViolation"), name);
    // 16. Artifacts that differ from what was approved invalidate it: the delivery is refused as corrupt, nothing runs.
    const bundlePath = join(storeDir(root, id), "bundle.json"), bundle = await readFile(bundlePath, "utf8");
    await writeFile(bundlePath, tamperedBundle(bundle));
    const tampered = await cli(["apply", id], root, { git: spy, disposable: [root] });
    assert.equal(tampered.code, 4);
    assert.match(tampered.stderr, /corrupt or tampered/u);
    await writeFile(bundlePath, bundle);
    assert.deepEqual(await snapshot(root), repoBefore);
    assert.deepEqual(await eventTypes(root, id), ["prepared", "approved"], "the refused apply recorded nothing and used nothing");
    // An approval is given once: approving again is refused.
    const twice = await cli(["approve-delivery", id], root, { git: spy, interactive: true, answer: digest });
    assert.deepEqual([twice.code, twice.questions], [2, []]);
    // A delivery that changes between the summary and the typed answer approves nothing.
    const second = await stored(root, MULTI, spy, { runId: "c2-run-2" });
    const manifestPath = join(storeDir(root, second.deliveryId), "manifest.json"), secondManifest = await readFile(manifestPath, "utf8");
    const raced = await cli(["approve-delivery", second.deliveryId], root, { git: spy, interactive: true, answer: async () => {
      await writeFile(manifestPath, JSON.stringify(JSON.parse(secondManifest), null, 2));
      return second.manifestSha256;
    } });
    assert.equal(raced.code, 4);
    assert.ok(!existsSync(join(storeDir(root, second.deliveryId), "approval.json")));
    await writeFile(manifestPath, secondManifest);
    // The typed text is compared with the digest of THIS delivery: another delivery's digest approves nothing.
    const crossed = await cli(["approve-delivery", second.deliveryId], root, { git: spy, interactive: true, answer: digest });
    assert.equal(crossed.code, 13);
    assert.deepEqual(await eventTypes(root, second.deliveryId), ["prepared"]);
    void dir;
  }));

// ---------------------------------------------------------------- disposable apply

test("O5.5C2 apply (18-21, 28, 29): create, update, delete and multi-file deliveries in disposable repositories; exact final hashes; nothing else changes", { skip }, async () => {
  for (const [name, changes] of [["create", CREATE], ["update", UPDATE], ["delete", DELETE], ["multi", MULTI]] as const) {
    await withPrimary(async root => {
      const spy = await isolatedGit();
      const delivery = await approvedDelivery(root, changes, spy);
      const manifest = JSON.parse(await readFile(join(storeDir(root, delivery.deliveryId), "manifest.json"), "utf8")) as Record<string, any>;
      const before = await snapshot(root);
      const ran = await cli(["apply", delivery.deliveryId], root, { git: spy, disposable: [root] });
      assert.equal(ran.code, 0, `${name}: ${ran.stdout}${ran.stderr}`);
      assert.match(ran.stdout, /^Result: applied \(phase done\)$/mu);
      assert.match(ran.stdout, new RegExp(`^Observed HEAD: ${baseOf(root)}$`, "mu"));
      const after = await snapshot(root);
      for (const op of manifest.operations as Array<{ path: string; afterSha256: string | null }>) {
        assert.equal(after[op.path], op.afterSha256 ?? undefined, `${name}: ${op.path} holds exactly the approved post-image`);
        delete after[op.path]; delete before[op.path];
      }
      assert.deepEqual(after, before, `${name}: no undeclared path changed`);
      assert.equal(await readFile(join(root, ".env"), "utf8"), `TOKEN=${ENV_CANARY}\n`);
      assert.deepEqual(await stagingEntries(root), []);
      const declared = new Set((manifest.operations as Array<{ path: string }>).map(op => op.path));
      const status = git(root, "status", "--porcelain=v1", "-uall").split("\n").filter(Boolean).map(line => line.slice(3));
      assert.ok(status.length > 0 && status.every(path => declared.has(path)), `${name}: git sees only declared paths: ${status.join(", ")}`);
      // F. The lifecycle events: metadata only.
      const events = await eventsOf(root, delivery.deliveryId);
      assert.deepEqual(events.map(e => e.type), ["prepared", "approved", "applyStarted", "precheckStarted", "precheckPassed", "applied"]);
      const last = events.at(-1)!;
      assert.deepEqual([last.observedHead, last.expectedHead, last.touchedPaths, last.phase, last.issues, last.rollback, last.manifestSha256],
        [baseOf(root), baseOf(root), declared.size, "done", [], null, delivery.manifestSha256]);
      assert.deepEqual(events.map(e => e.seq), [1, 2, 3, 4, 5, 6]);
      const eventText = await readFile(join(storeDir(root, delivery.deliveryId), "events.jsonl"), "utf8");
      for (const hidden of [QUOTE_FIXED.slice(0, 40), DISCOUNT.trim(), ENV_CANARY]) assert.ok(!eventText.includes(hidden));
      // 28. The approval is used once: the applied delivery cannot be applied or approved again.
      assert.match((await cli(["inspect-delivery", delivery.deliveryId], root, { git: spy })).stdout, /^State: applied$/mu);
      assert.equal((await cli(["apply", delivery.deliveryId], root, { git: spy, disposable: [root] })).code, 2);
      assert.equal((await cli(["approve-delivery", delivery.deliveryId], root, { git: spy, interactive: true, answer: delivery.manifestSha256 })).code, 2);
    });
  }
});

test("O5.5C2 apply (22-24): touched-file drift, HEAD drift and a dirty tree fail the precheck before any write; recorded as such", { skip }, async () => {
  const drifts: Array<[string, (root: string) => Promise<void>, string[]]> = [
    ["touched-file drift", async root => writeFile(join(root, "src", "quote.ts"), `${QUOTE_BUGGY}// the user's edit\n`), ["dirtyTree", "fileChanged:src/quote.ts"]],
    ["HEAD drift", async root => { await writeFile(join(root, "README.md"), "# moved\n"); git(root, "commit", "-qam", "moved"); }, ["headMoved", "baseTreeMismatch"]],
    ["dirty tree", async root => writeFile(join(root, "notes.txt"), "user notes\n"), ["dirtyTree"]],
  ];
  for (const [name, drift, expected] of drifts) {
    await withPrimary(async root => {
      const spy = await isolatedGit();
      const delivery = await approvedDelivery(root, UPDATE, spy);
      const base = baseOf(root);
      await drift(root);
      const before = await snapshot(root);
      const ran = await cli(["apply", delivery.deliveryId], root, { git: spy, disposable: [root] });
      assert.equal(ran.code, 8, `${name}: ${ran.stdout}`);
      assert.match(ran.stdout, /^Result: failed \(phase precheck\)$/mu);
      assert.deepEqual(await snapshot(root), before, `${name}: nothing was written`);
      assert.deepEqual(await stagingEntries(root), []);
      const events = await eventsOf(root, delivery.deliveryId);
      assert.deepEqual(events.map(e => e.type), ["prepared", "approved", "applyStarted", "precheckStarted", "precheckFailed", "failed"], name);
      assert.deepEqual([...events.at(-1)!.issues].sort(), [...expected].sort(), name);
      assert.equal(events.at(-2)!.observedHead, name === "HEAD drift" ? baseOf(root) : base, `${name}: the observed HEAD is recorded`);
      assert.equal(events.at(-2)!.expectedHead, base);
      // A failed delivery is not retried with the same approval.
      assert.equal((await cli(["apply", delivery.deliveryId], root, { git: spy, disposable: [root] })).code, 2);
    });
  }
});

test("O5.5C2 apply (25-27): an apply or postcheck failure rolls back; a failed rollback is reported distinctly", { skip }, async () => {
  await withPrimary(async root => {
    const spy = await isolatedGit();
    const delivery = await approvedDelivery(root, MULTI, spy);
    const before = await snapshot(root);
    const ran = await cli(["apply", delivery.deliveryId], root, { git: spy, disposable: [root],
      faults: { afterOperation: index => { if (index === 1) throw new Error("injected"); } } });
    assert.equal(ran.code, 8);
    assert.match(ran.stdout, /^Result: rolledBack \(phase rollback\)$/mu);
    assert.deepEqual(await snapshot(root), before, "every preimage restored exactly");
    const last = (await eventsOf(root, delivery.deliveryId)).at(-1)!;
    assert.deepEqual([last.type, last.rollback, last.issues], ["rolledBack", { restored: 2, failed: 0 }, ["applyFailed"]]);
  });
  await withPrimary(async root => {
    const spy = await isolatedGit();
    const delivery = await approvedDelivery(root, UPDATE, spy);
    const ran = await cli(["apply", delivery.deliveryId], root, { git: spy, disposable: [root],
      faults: { beforePostcheck: async primary => writeFile(join(primary, "stray.txt"), "x\n") } });
    assert.equal(ran.code, 8);
    const last = (await eventsOf(root, delivery.deliveryId)).at(-1)!;
    assert.equal(last.type, "rolledBack");
    assert.ok((last.issues as string[]).includes("undeclaredChange:stray.txt"));
    assert.equal(sha256(await readFile(join(root, "src", "quote.ts"))), sha256(QUOTE_BUGGY), "the touched path is back to its preimage");
  });
  await withPrimary(async root => {
    const spy = await isolatedGit();
    const delivery = await approvedDelivery(root, MULTI, spy);
    const ran = await cli(["apply", delivery.deliveryId], root, { git: spy, disposable: [root], faults: {
      afterOperation: index => { if (index === 2) throw new Error("injected"); },
      beforeRestore: index => { if (index === 0) throw new Error("injected restore failure"); } } });
    assert.equal(ran.code, 1, "a failed rollback is never reported as rolled back");
    assert.match(ran.stdout, /^Result: rollbackFailed \(phase rollback\)$/mu);
    assert.match(ran.stdout, /src\/quote\.ts: applied, NOT restored/u);
    assert.match(ran.stdout, /the staging area is kept for recovery/u);
    const last = (await eventsOf(root, delivery.deliveryId)).at(-1)!;
    assert.deepEqual([last.type, last.rollback], ["rollbackFailed", { restored: 2, failed: 1 }]);
    assert.ok((last.issues as string[]).includes("restoreFailed:src/quote.ts"));
    assert.match((await cli(["inspect-delivery", delivery.deliveryId], root, { git: spy })).stdout, /^State: rollbackFailed$/mu);
    assert.equal((await stagingEntries(root)).length, 1);
  });
});

test("O5.5C2 apply: one approval, one apply — concurrent and crashed claims are refused; an outcome whose evidence cannot be recorded is reported, not hidden", { skip }, async () => {
  // Two concurrent applies of one approval: exactly one runs.
  await withPrimary(async root => {
    const spy = await isolatedGit();
    const delivery = await approvedDelivery(root, UPDATE, spy);
    const runs = await Promise.all([cli(["apply", delivery.deliveryId], root, { git: spy, disposable: [root] }),
      cli(["apply", delivery.deliveryId], root, { git: spy, disposable: [root] })]);
    const codes = runs.map(run => run.code).sort((a, b) => a - b);
    assert.equal(codes[0], 0, JSON.stringify(runs));
    assert.ok(codes[1] === 2 || codes[1] === 8, `the second apply is refused: ${JSON.stringify(runs)}`);
    const events = await eventTypes(root, delivery.deliveryId);
    assert.deepEqual(events, ["prepared", "approved", "applyStarted", "precheckStarted", "precheckPassed", "applied"], "one apply, a valid log");
    assert.equal(sha256(await readFile(join(root, "src", "quote.ts"))), sha256(QUOTE_FIXED));
  });
  // A claim left behind (a crash before `applyStarted`) keeps the delivery unappliable: fail closed, nothing runs.
  await withPrimary(async root => {
    const spy = await isolatedGit();
    const delivery = await approvedDelivery(root, UPDATE, spy);
    await writeFile(join(storeDir(root, delivery.deliveryId), "apply.claim"), "");
    const before = await snapshot(root);
    const ran = await cli(["apply", delivery.deliveryId], root, { git: spy, disposable: [root] });
    assert.equal(ran.code, 8);
    assert.match(ran.stderr, /already claimed; an approval is used once/u);
    assert.deepEqual(await snapshot(root), before);
    assert.deepEqual(await eventTypes(root, delivery.deliveryId), ["prepared", "approved"]);
    await assert.rejects(storeOf(root).appendEvent(delivery.deliveryId, { type: "applyStarted", at: FIXED_NOW().toISOString(),
      observedHead: null, touchedPaths: 1, phase: null, issues: [], rollback: null }), kind("InvalidInput"), "applyStarted only through the claim");
  });
  // The outcome's event cannot be appended (the log was damaged during the apply): the applied result is still reported.
  await withPrimary(async root => {
    const spy = await isolatedGit();
    const delivery = await approvedDelivery(root, UPDATE, spy);
    const log = join(storeDir(root, delivery.deliveryId), "events.jsonl");
    const ran = await cli(["apply", delivery.deliveryId], root, { git: spy, disposable: [root],
      faults: { beforePostcheck: async () => writeFile(log, `${await readFile(log, "utf8")}{"torn":`) } });
    assert.equal(ran.code, 10, ran.stdout + ran.stderr);
    assert.match(ran.stdout, /^Result: applied \(phase done\)$/mu);
    assert.match(ran.stdout, /^Evidence: NOT recorded — the result above stands/mu);
    assert.equal(sha256(await readFile(join(root, "src", "quote.ts"))), sha256(QUOTE_FIXED));
  });
  // A precheck event that cannot be recorded stops the applier before any write.
  await withPrimary(async root => {
    const spy = await isolatedGit();
    const delivery = await approvedDelivery(root, UPDATE, spy);
    const loaded = await storeOf(root).load(delivery.deliveryId);
    const record = new DeliveryRecord(loaded.manifest, loaded.bundle);
    record.approve(approvalFromHumanRecord(loaded.approval, loaded.manifest));
    const before = await snapshot(root);
    const outcome = await new LocalFilesystemDeliveryApplier({ git: spy, requiredForbiddenPaths: providerWorkspaceStatePaths(),
      observer: () => { throw new Error("the log is unavailable"); } }).apply(record, root);
    assert.deepEqual([outcome.state, outcome.phase, outcome.issues], ["failed", "precheck", [{ reason: "evidenceUnrecorded" }]]);
    assert.deepEqual(await snapshot(root), before);
    assert.deepEqual(await stagingEntries(root), []);
  });
});

// ---------------------------------------------------------------- production gate

test("O5.5C2 gate (30-33): `fusion apply` into a real checkout stops before its precheck; no flag, variable or configuration opens it; no provider, no network", { skip }, async () =>
  withPrimary(async (root, dir) => {
    // A configuration that asks for delivery is committed into the baseline: it is never read.
    await writeFile(join(root, "fusion.config.json"), JSON.stringify({ schemaVersion: 1, delivery: { authorized: true, disposableTargets: [root] } }));
    git(root, "add", "fusion.config.json");
    git(root, "commit", "-qm", "config");
    const spy = await isolatedGit();
    const { registry, touched } = sealedRegistry();
    const connects: string[] = [];
    const originalConnect = Socket.prototype.connect, originalFetch = globalThis.fetch;
    Socket.prototype.connect = function (this: Socket, ...args: unknown[]) { connects.push(JSON.stringify(args[0] ?? null)); return originalConnect.apply(this, args as never); } as typeof originalConnect;
    globalThis.fetch = (async (...args: unknown[]) => { connects.push(`fetch ${String(args[0])}`); throw new Error("network is not allowed"); }) as typeof fetch;
    try {
      const delivery = await stored(root, UPDATE, spy);
      assert.equal((await cli(["approve-delivery", delivery.deliveryId], root, { git: spy, registry, interactive: true, answer: delivery.manifestSha256 })).code, 0);
      const before = await snapshot(root);
      const env = { FUSION_DELIVERY_AUTHORIZED: "1", FUSION_ALLOW_APPLY: "true", FUSION_REAL_PRIMARY_APPLY: "YES", REAL_WRITER_LIVE_GATE_AUTHORIZED: "YES",
        FUSION_DISPOSABLE_DELIVERY_TARGETS: root, FUSION_DELIVERY_TARGETS: root, CI: "true" };
      for (const [name, options] of [["no seam", {}], ["variables", { env }], ["another disposable repository", { disposable: [join(dir, "elsewhere")] }]] as const) {
        spy.calls.length = 0;
        const ran = await cli(["apply", delivery.deliveryId], root, { git: spy, registry, ...options });
        assert.equal(ran.code, 11, `${name}: ${ran.stdout}${ran.stderr}`);
        assert.match(ran.stdout, /^Result: blocked$/mu);
        assert.match(ran.stdout, /No live delivery authorization exists/u);
        assert.ok(identityReadsOnly(spy.calls), `${name}: no precheck, no write: ${JSON.stringify(spy.calls)}`);
        assert.deepEqual(await snapshot(root), before, name);
        assert.deepEqual(await eventTypes(root, delivery.deliveryId), ["prepared", "approved"], `${name}: nothing recorded, the approval is not used`);
      }
      // The JSON form reports the same.
      const json = JSON.parse((await cli(["--json", "apply", delivery.deliveryId], root, { git: spy, registry })).stdout) as { exitCode: number; delivery: { result: string } };
      assert.deepEqual([json.exitCode, json.delivery.result], [11, "blocked"]);
      // Only a registered repository strictly inside the temporary directory is disposable.
      assert.equal(await isDisposableDeliveryTarget(root, undefined), false);
      assert.equal(await isDisposableDeliveryTarget(root, []), false);
      assert.equal(await isDisposableDeliveryTarget(root, [root]), true);
      assert.equal(await isDisposableDeliveryTarget(await realpath(tmpdir()), [tmpdir()]), false, "never the temporary directory itself");
      assert.equal(await isDisposableDeliveryTarget(resolve("."), [resolve(".")]), false, "never a checkout outside the temporary directory");
      assert.equal(liveDeliveryAuthorization().authorized, false);
      await cli(["inspect-delivery", delivery.deliveryId], root, { git: spy, registry });
    } finally {
      Socket.prototype.connect = originalConnect;
      globalThis.fetch = originalFetch;
    }
    assert.deepEqual(touched, [], "no provider factory was reached");
    assert.deepEqual(connects, [], "no network connection was attempted");
    // Static: the delivery modules import no process, network or provider module and read no variable; the entry point sets no seam.
    for (const file of ["src/platform/delivery/store.js", "src/core/delivery/lifecycle.js", "src/core/delivery/diff.js", "src/app/delivery-service.js",
      "src/cli/render-delivery.js"]) {
      const text = await readFile(resolve("dist", file), "utf8");
      for (const banned of ["child_process", "node:net", "node:http", "node:https", "fetch(", "/providers/", "supervisor", "process.env", "FUSION_"])
        assert.ok(!text.includes(banned), `${file} must not use ${banned}`);
    }
    const main = await readFile(resolve("dist", "src", "cli", "main.js"), "utf8");
    for (const seam of ["disposableDeliveryTargets", "deliveryFaults", "writerRehearsal"]) assert.ok(!main.includes(seam), `the CLI entry point never sets ${seam}`);
  }));

// ---------------------------------------------------------------- readiness

test("O5.5C2 readiness (34-36): implementation rows only; the Writer workflow stays satisfied; Writer mode, the live gate and live primary apply stay closed", () => {
  const report = writerGateReport();
  const rows = Object.fromEntries(report.rows.map(row => [row.id, [row.state, row.evidenceKind]]));
  assert.deepEqual([rows.deliveryStoreImplementation, rows.deliveryInspectImplementation, rows.humanApprovalImplementation],
    [["satisfied", "mechanical"], ["satisfied", "mechanical"], ["satisfied", "mechanical"]]);
  assert.deepEqual(rows.humanApprovedDelivery, ["partial", "mechanical"], "no live primary apply: the delivery row stays partial");
  const delivery = report.rows.find(row => row.id === "humanApprovedDelivery")!;
  assert.match(delivery.remainingBlocker, /^No live delivery authorization exists: `fusion apply` into any real checkout stops before its precheck/u);
  assert.match(delivery.evidence, /O5\.5C2: a persistent delivery store/u);
  assert.deepEqual([rows.hostControlledWriterWorkflow, rows.liveGateAuthorization], [["satisfied", "recordedLiveProbe"], ["blocked", "none"]]);
  assert.deepEqual([report.realWriterModeReady, REAL_WRITER_LIVE_GATE_AUTHORIZED, liveDeliveryAuthorization().authorized], [false, false, false]);
  for (const row of report.rows.filter(r => /Implementation$/u.test(r.id) && r.id.startsWith("delivery") || r.id === "humanApprovalImplementation"))
    assert.match(row.remainingBlocker, /Implementation only/u, row.id);
  // The commands are documented in the usage text.
  for (const command of ["inspect-delivery <id>", "approve-delivery <id>", "apply <id>"]) assert.ok(USAGE.includes(`  ${command}`), command);
});
