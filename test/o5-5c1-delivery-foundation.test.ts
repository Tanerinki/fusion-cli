import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { deliveryApplier, prepareRunDelivery } from "../src/app/delivery-composition.js";
import { REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport } from "../src/app/writer-gate.js";
import { QUOTE_BUGGY, QUOTE_FIXED, QUOTE_TEST } from "../src/app/route-fixture.js";
import { DeliveryRecord, issueTestOnlyApproval, isIssuedApproval } from "../src/core/delivery/approval.js";
import { deliveryBundleSha256, parseDeliveryBundle, serializeDeliveryBundle, validateDeliveryBundle } from "../src/core/delivery/bundle.js";
import { canonicalJson } from "../src/core/delivery/canonical.js";
import { deliveryManifestSha256, deliveryPathViolation, deliveryPreview, validateDeliveryManifest } from "../src/core/delivery/manifest.js";
import { prepareDelivery, type PreparedDelivery } from "../src/core/delivery/prepare.js";
import type { ChangeSet } from "../src/core/domain.js";
import { FusionFailure } from "../src/core/errors.js";
import type { WorkflowResult } from "../src/core/workflow/types.js";
import { readPrimaryIdentity, type DeliveryFaults } from "../src/platform/delivery/applier.js";
import { ProcessGitClient, type GitClient, type GitResult, type GitRunOptions } from "../src/platform/workspace/git.js";
import { providerWorkspaceStatePaths } from "../src/runtime/provider-profiles.js";
import { changeSet } from "./fixtures/fake-writer.js";
import { git, gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5C1 — the human-approved delivery foundation, offline: canonical manifest and bundle, the approval boundary, and the
 * local applier on throw-away Git repositories. No provider, no model, no network; no real user project is ever touched.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const kind = (expected: string) => (error: unknown) => error instanceof FusionFailure && error.error.kind === expected;
const MONEY = "export const cents = (value: number): number => Math.round(value);\n";
const OLD_DOC = "# Old notes\n";
const ENV_CANARY = "FUSION-DELIVERY-ENV-CANARY-5e1a";
const UPDATE = changeSet([["src/quote.ts", QUOTE_BUGGY, QUOTE_FIXED]]);
const CREATE = changeSet([["src/lib/discount.ts", null, "export const FULL = 10_000;\n"]]);
const DELETE = changeSet([["docs/old.md", OLD_DOC, null]]);
const MULTI = changeSet([["src/quote.ts", QUOTE_BUGGY, QUOTE_FIXED], ["src/lib/discount.ts", null, "export const FULL = 10_000;\n"],
  ["docs/old.md", OLD_DOC, null]]);

/** A clean throw-away primary: committed files, an ignored `.env` canary, nothing staged, unstaged or untracked. */
async function withPrimary<T>(work: (root: string, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "fusion-c1-"));
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
  } finally { await rm(dir, { recursive: true, force: true }); }
}
/** Every file of the primary (outside `.git`) by content digest. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name), rel = relative(root, path).split(sep).join("/");
    if (!entry.isFile() || rel === ".git" || rel.startsWith(".git/")) continue;
    files[rel] = sha256(await readFile(path));
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : 1));
}
/** A completed run verified under a GRANTED acceptance (only a real accepted backend produces one). */
function acceptedResult(changes: ChangeSet, reviews: WorkflowResult["reviews"] = []): WorkflowResult {
  return { state: "completed", transitions: [], delegateAttempts: 1, reviews, changeSet: changes,
    applied: changes.operations.map(op => op.kind === "delete"
      ? { kind: op.kind, path: op.path, beforeSha256: op.expectedSha256, afterSha256: null, bytes: 0 }
      : { kind: op.kind, path: op.path, beforeSha256: op.expectedSha256, afterSha256: sha256(op.content), bytes: Buffer.byteLength(op.content) }),
    verification: { passed: true, commandsRun: 2, evidence: { backendId: "docker-linux", confinement: "osSandbox", platformRequirement: "linux-compatible",
      acceptance: "granted", commands: [{ id: "typecheck", status: "passed", exitCode: 0 }, { id: "unit", status: "passed", exitCode: 0 }] } } };
}
/** Records every Git invocation (argv) and forwards it to the isolated-config client. */
class SpyGit implements GitClient {
  readonly calls: string[][] = [];
  constructor(private readonly inner: GitClient) {}
  run(args: readonly string[], options: GitRunOptions): Promise<GitResult> { this.calls.push([...args]); return this.inner.run(args, options); }
}
const isolatedGit = async () => new SpyGit(await ProcessGitClient.fromPath(process.env, true));
const scopeOf = (changes: ChangeSet) => ({ allowedPaths: changes.operations.map(op => op.path), forbiddenPaths: [] });
async function prepare(root: string, changes: ChangeSet, gitClient: GitClient, reviews: WorkflowResult["reviews"] = []): Promise<PreparedDelivery> {
  return prepareRunDelivery({ deliveryId: "c1-delivery", runId: "c1-run", taskSha256: "a".repeat(64), workflowEvidenceSha256: "b".repeat(64),
    result: acceptedResult(changes, reviews), scope: scopeOf(changes), baseCommit: git(root, "rev-parse", "HEAD").trim(), primaryRoot: root, git: gitClient });
}
function approved(prepared: PreparedDelivery): DeliveryRecord {
  const record = new DeliveryRecord(prepared.manifest, prepared.bundle);
  record.approve(issueTestOnlyApproval({ deliveryId: prepared.manifest.deliveryId, manifestSha256: prepared.manifestSha256, approver: "test human" }));
  return record;
}
async function deliver(root: string, changes: ChangeSet, faults?: DeliveryFaults) {
  const gitClient = await isolatedGit();
  const prepared = await prepare(root, changes, gitClient);
  const record = approved(prepared);
  const before = await snapshot(root);
  const outcome = await deliveryApplier(gitClient, faults).apply(record, root);
  return { prepared, record, before, after: await snapshot(root), outcome, gitClient };
}
const stagingEntries = async (root: string) => {
  const parent = join(root, ".git", "fusion-delivery");
  return existsSync(parent) ? await readdir(parent) : [];
};

// ---------------------------------------------------------------- manifest

test("O5.5C1 manifest (1, 3, 4): canonical and stable; exact before/after digests; no content or provider text", { skip }, async () => withPrimary(async root => {
  const gitClient = await isolatedGit();
  const secret = "PROVIDER-RATIONALE-CANARY-3b7c";
  const finding = { id: "r1-F1", severity: "LOW" as const, confidence: "HIGH" as const, category: "tests", title: `title ${secret}`,
    evidence: [`evidence ${secret}`], failureScenario: secret, facts: [], source: { role: "Reviewer" as const, runId: "c1-run", sessionId: "s", cycle: 1 } };
  const reviews: WorkflowResult["reviews"] = [{ cycle: 1, outcome: "clean", findings: [finding], adjudications: [{ finding, verdict: "REJECTED",
    rationale: `rationale ${secret}`, requiredAction: "none", verdictSource: "lead", supportedFacts: [] }] }];
  const a = await prepare(root, MULTI, gitClient, reviews), b = await prepare(root, MULTI, gitClient, reviews);
  assert.equal(a.manifestSha256, b.manifestSha256, "the same run prepares the same manifest digest");
  assert.equal(a.manifestSha256, deliveryManifestSha256(validateDeliveryManifest(JSON.parse(JSON.stringify(a.manifest)))), "a JSON round trip keeps the digest");
  assert.equal(canonicalJson({ b: 1, a: [true, null, "x"] }), canonicalJson({ a: [true, null, "x"], b: 1 }));
  assert.throws(() => canonicalJson({ a: 1.5 }), kind("InvalidInput"));
  assert.throws(() => canonicalJson({ a: undefined }), kind("InvalidInput"));
  const m = a.manifest;
  assert.deepEqual([m.format, m.version, m.deliveryId, m.request, m.source.workflowEvidenceSha256], ["fusion.deliveryManifest", 2, "c1-delivery",
    { runId: "c1-run", taskSha256: "a".repeat(64) }, "b".repeat(64)]);
  assert.deepEqual(m.operations.map(op => [op.kind, op.path, op.beforeSha256, op.afterSha256, op.afterBytes]), [
    ["update", "src/quote.ts", sha256(QUOTE_BUGGY), sha256(QUOTE_FIXED), Buffer.byteLength(QUOTE_FIXED)],
    ["create", "src/lib/discount.ts", null, sha256("export const FULL = 10_000;\n"), 28], ["delete", "docs/old.md", sha256(OLD_DOC), null, null]]);
  assert.deepEqual(m.primary.touched, [{ path: "src/quote.ts", exists: true, sha256: sha256(QUOTE_BUGGY) },
    { path: "src/lib/discount.ts", exists: false, sha256: null }, { path: "docs/old.md", exists: true, sha256: sha256(OLD_DOC) }]);
  const identity = await readPrimaryIdentity(root, gitClient);
  assert.deepEqual([m.primary.repositoryIdentity, m.primary.baseCommit, m.primary.baseTree, m.primary.cleanTree],
    [identity.repositoryIdentity, identity.headCommit, identity.headTree, "required"]);
  assert.deepEqual([m.quality.verification.acceptance, m.quality.review.state, m.quality.review.findings, m.quality.providerText],
    ["granted", "clean", 1, "excluded"]);
  assert.deepEqual(m.safety.forbiddenPaths, [...providerWorkspaceStatePaths()].sort(), "the providers' state paths are forbidden");
  const text = JSON.stringify(m);
  for (const hidden of [secret, QUOTE_FIXED.slice(0, 60), "rationale"]) assert.ok(!text.includes(hidden), `the manifest carries no ${hidden}`);
  assert.deepEqual(deliveryPreview(m).map(p => [p.path, p.action]), [["src/quote.ts", "update"], ["src/lib/discount.ts", "create"], ["docs/old.md", "delete"]]);
  // Only a completed run verified under a granted acceptance qualifies; an offline rehearsal never does.
  const rehearsal = acceptedResult(UPDATE);
  const offline = { ...rehearsal, verification: { ...rehearsal.verification!, evidence: { ...rehearsal.verification!.evidence!, acceptance: "offlineRehearsal" as const } } };
  const base = { deliveryId: "d", runId: "r", taskSha256: "a".repeat(64), workflowEvidenceSha256: "b".repeat(64), scope: scopeOf(UPDATE),
    primary: { repositoryIdentity: identity.repositoryIdentity, baseCommit: identity.headCommit, baseTree: identity.headTree }, forbiddenPaths: [] };
  assert.throws(() => prepareDelivery({ ...base, result: offline }), kind("SecurityViolation"));
  assert.throws(() => prepareDelivery({ ...base, result: { ...rehearsal, state: "decisionRequired" } }), kind("InvalidInput"));
  assert.throws(() => prepareDelivery({ ...base, result: { ...rehearsal, applied: [{ ...rehearsal.applied![0]!, afterSha256: "0".repeat(64) }] } }),
    kind("SecurityViolation"), "the ledger must match the ChangeSet's bytes");
}));

test("O5.5C1 manifest (2): a tampered manifest is refused — shape, policy, digest binding", { skip }, async () => withPrimary(async root => {
  const prepared = await prepare(root, UPDATE, await isolatedGit());
  const m = JSON.parse(JSON.stringify(prepared.manifest)) as Record<string, any>;
  const variants: Array<[string, (v: any) => void]> = [
    ["extra field", v => { v.note = "x"; }], ["provider text trusted", v => { v.quality.providerText = "included"; }],
    ["rehearsal acceptance", v => { v.quality.verification.acceptance = "offlineRehearsal"; }], ["traversal", v => { v.operations[0].path = "../x.ts"; }],
    ["outstanding finding", v => { v.quality.review.outstanding = 1; }], ["dirty allowed", v => { v.primary.cleanTree = "ignored"; }],
    ["touched mismatch", v => { v.primary.touched[0].sha256 = "0".repeat(64); }], ["kind mismatch", v => { v.operations[0].kind = "create"; }],
    ["links allowed", v => { v.safety.links = "follow"; }], ["forbidden classes dropped", v => { v.safety.forbiddenClasses = []; }]];
  for (const [name, change] of variants) {
    const copy = JSON.parse(JSON.stringify(m));
    change(copy);
    assert.throws(() => validateDeliveryManifest(copy), (error: unknown) => error instanceof FusionFailure, name);
  }
  // A self-consistent but different manifest: the approval of the original digest cannot approve it.
  const other = JSON.parse(JSON.stringify(m));
  other.request.taskSha256 = "c".repeat(64);
  const record = new DeliveryRecord(other, prepared.bundle);
  assert.notEqual(record.manifestSha256, prepared.manifestSha256);
  assert.throws(() => record.approve(issueTestOnlyApproval({ deliveryId: "c1-delivery", manifestSha256: prepared.manifestSha256, approver: "test human" })),
    kind("SecurityViolation"));
  // Changing a digest the bundle is bound to breaks the bundle binding.
  const digest = JSON.parse(JSON.stringify(m));
  digest.operations[0].afterSha256 = "0".repeat(64);
  assert.throws(() => new DeliveryRecord(digest, prepared.bundle), (error: unknown) => error instanceof FusionFailure);
}));

// ---------------------------------------------------------------- bundle

test("O5.5C1 bundle (5, 6): exact bytes round-trip; tampered content or encoding refused", { skip }, async () => withPrimary(async root => {
  const prepared = await prepare(root, MULTI, await isolatedGit());
  const text = serializeDeliveryBundle(prepared.bundle);
  const parsed = validateDeliveryBundle(parseDeliveryBundle(text), prepared.manifest);
  assert.deepEqual(parsed.entries.map(e => [e.path, e.content.toString("utf8")]), [["src/quote.ts", QUOTE_FIXED], ["src/lib/discount.ts", "export const FULL = 10_000;\n"]]);
  assert.equal(deliveryBundleSha256(parsed), prepared.manifest.change.bundleSha256);
  assert.ok(!text.includes(QUOTE_FIXED.slice(0, 40)), "at rest the content is base64, bound by its digest");
  const flipped = JSON.parse(text);
  flipped.entries[0].contentBase64 = Buffer.from(`${QUOTE_FIXED}// tampered\n`).toString("base64");
  assert.throws(() => validateDeliveryBundle(parseDeliveryBundle(JSON.stringify(flipped)), prepared.manifest), kind("SecurityViolation"));
  const renamed = JSON.parse(text);
  renamed.entries[0].path = "src/other.ts";
  assert.throws(() => validateDeliveryBundle(parseDeliveryBundle(JSON.stringify(renamed)), prepared.manifest), kind("SecurityViolation"));
  const linked = JSON.parse(text);
  linked.entries[0].type = "symlink";
  assert.throws(() => parseDeliveryBundle(JSON.stringify(linked)), kind("SecurityViolation"), "a link entry cannot even be expressed");
  assert.throws(() => validateDeliveryBundle({ ...prepared.bundle, entries: prepared.bundle.entries.slice(1) }, prepared.manifest), kind("SecurityViolation"));
  // Bytes changed after approval: the precheck recomputes every digest and refuses before any write.
  const record = approved(prepared);
  record.bundle.entries[0]!.content[0] = 0x21;
  const before = await snapshot(root);
  const outcome = await deliveryApplier(await isolatedGit()).apply(record, root);
  assert.deepEqual([outcome.state, outcome.phase, outcome.issues], ["failed", "precheck", [{ reason: "bundleInvalid" }]]);
  assert.deepEqual(await snapshot(root), before);
}));

test("O5.5C1 paths (7, 8, 10): traversal, absolute, device, .git, credential and provider-state paths refused; caps enforced", () => {
  const forbidden = providerWorkspaceStatePaths();
  for (const [path, reason] of [["../x.ts", "pathTraversal"], ["src/../../x", "pathTraversal"], ["/etc/passwd", "absolutePath"], ["C:/x.ts", "absolutePath"],
    ["\\\\server\\share\\x", "absolutePath"], [".git/config", "gitInternals"], ["src/.GIT/hooks/x", "gitInternals"], [".fusion/state", "fusionState"],
    ["src/con.ts", "deviceName"], [".env", "credentialFile"], ["config/.env.production", "credentialFile"], ["keys/server.pem", "credentialFile"],
    ["home/.ssh/config", "credentialDirectory"], [".npmrc", "credentialFile"], [`${forbidden[0]}/settings.json`, "providerState"]] as const)
    assert.equal(deliveryPathViolation(path, forbidden), reason, path);
  for (const path of ["src/quote.ts", "src/auth/token.ts", "docs/secret-sauce.md", "test/quote.test.ts"]) assert.equal(deliveryPathViolation(path, forbidden), undefined, path);
});

test("O5.5C1 caps (10): a manifest beyond its caps or the hard caps is refused", { skip }, async () => withPrimary(async root => {
  const prepared = await prepare(root, UPDATE, await isolatedGit());
  const m = JSON.parse(JSON.stringify(prepared.manifest)) as Record<string, any>;
  const over = (change: (v: any) => void) => { const copy = JSON.parse(JSON.stringify(m)); change(copy); return copy; };
  assert.throws(() => validateDeliveryManifest(over(v => { v.safety.caps.maxFileBytes = 10; })), kind("InvalidInput"), "the file exceeds its own cap");
  assert.throws(() => validateDeliveryManifest(over(v => { v.safety.caps.maxOperations = 10_000; })), kind("InvalidInput"), "above the hard cap");
  assert.throws(() => validateDeliveryManifest(over(v => { v.safety.caps.maxTotalBytes = 1; })), kind("InvalidInput"));
  const many = changeSet(Array.from({ length: 33 }, (_, i) => [`src/n${i}.ts`, null, "x\n"] as [string, null, string]));
  assert.throws(() => prepareDelivery({ deliveryId: "d", runId: "r", taskSha256: "a".repeat(64), workflowEvidenceSha256: "b".repeat(64),
    result: acceptedResult(many), scope: scopeOf(many), primary: { repositoryIdentity: "a".repeat(64), baseCommit: "a".repeat(40), baseTree: "b".repeat(40) },
    forbiddenPaths: [] }), kind("InvalidInput"), "33 operations exceed the 32-operation cap");
}));

// ---------------------------------------------------------------- precheck and drift

test("O5.5C1 precheck (11-16): a clean matching primary passes; every kind of drift is refused before any write", { skip }, async () => {
  const refused = async (name: string, changes: ChangeSet, drift: (root: string) => Promise<void>, expected: string[]) => withPrimary(async root => {
    const gitClient = await isolatedGit();
    const record = approved(await prepare(root, changes, gitClient));
    await drift(root);
    const before = await snapshot(root);
    const outcome = await deliveryApplier(gitClient).apply(record, root);
    assert.deepEqual([outcome.state, outcome.phase, record.state], ["failed", "precheck", "failed"], name);
    assert.deepEqual(outcome.issues.map(i => i.path === undefined ? i.reason : `${i.reason}:${i.path}`).sort(), [...expected].sort(), name);
    assert.deepEqual(await snapshot(root), before, `${name}: nothing was written`);
    assert.deepEqual(await stagingEntries(root), [], `${name}: nothing was staged`);
    assert.ok(outcome.evidence.operations.every(op => !op.applied));
  });
  await refused("HEAD drift", UPDATE, async root => { await writeFile(join(root, "README.md"), "# moved\n"); git(root, "commit", "-qam", "moved"); },
    ["headMoved", "baseTreeMismatch"]);
  await refused("touched-file drift", UPDATE, async root => writeFile(join(root, "src", "quote.ts"), `${QUOTE_BUGGY}// the user's edit\n`),
    ["dirtyTree", "fileChanged:src/quote.ts"]);
  await refused("unexpected create target", CREATE, async root => { await mkdir(join(root, "src", "lib")); await writeFile(join(root, "src", "lib", "discount.ts"), "mine\n"); },
    ["dirtyTree", "fileAppeared:src/lib/discount.ts"]);
  await refused("missing update target", UPDATE, async root => unlink(join(root, "src", "quote.ts")), ["dirtyTree", "fileMissing:src/quote.ts"]);
  await refused("missing delete target", DELETE, async root => unlink(join(root, "docs", "old.md")), ["dirtyTree", "fileMissing:docs/old.md"]);
  await refused("unrelated dirty state", UPDATE, async root => writeFile(join(root, "notes.txt"), "user notes\n"), ["dirtyTree"]);
  await refused("staged change", UPDATE, async root => { await writeFile(join(root, "README.md"), "# staged\n"); git(root, "add", "README.md"); }, ["dirtyTree"]);
  // A clean matching primary passes the precheck (and is applied: see the apply tests).
  await withPrimary(async root => {
    const { outcome } = await deliver(root, UPDATE);
    assert.deepEqual([outcome.state, outcome.issues], ["applied", []]);
    assert.deepEqual(outcome.evidence.phases.map(p => [p.phase, p.ok]), [["precheck", true], ["stage", true], ["apply", true], ["postcheck", true]]);
  });
});

test("O5.5C1 links (9): a linked or junctioned parent and a linked target are refused (where the platform lets a test create them)", { skip }, async () =>
  withPrimary(async (root, dir) => {
    const gitClient = await isolatedGit();
    const outside = join(dir, "outside");
    await mkdir(outside);
    let made = false;
    try { await symlink(outside, join(root, "src", "lib"), "junction"); made = true; } catch { /* links unavailable */ }
    if (made) {
      // The link points at an empty directory: Git may or may not list it; the parent check refuses it either way.
      const record = approved(await prepare(root, CREATE, gitClient));
      const outcome = await deliveryApplier(gitClient).apply(record, root);
      assert.equal(outcome.state, "failed");
      assert.ok(outcome.issues.some(i => i.reason === "parentNotDirectory" && i.path === "src/lib/discount.ts"), JSON.stringify(outcome.issues));
      assert.deepEqual(await readdir(outside), [], "nothing was written through the link");
    }
    let fileLink = false;
    await writeFile(join(dir, "elsewhere.ts"), QUOTE_BUGGY);
    try { await rm(join(root, "src", "money.ts")); await symlink(join(dir, "elsewhere.ts"), join(root, "src", "money.ts"), "file"); fileLink = true; }
    catch { /* file links need a privilege on Windows */ }
    if (fileLink) {
      git(root, "add", "-A");
      git(root, "commit", "-qm", "a linked file");
      const moneyUpdate = changeSet([["src/money.ts", QUOTE_BUGGY, "export {};\n"]]);
      const record = approved(await prepare(root, moneyUpdate, gitClient));
      const outcome = await deliveryApplier(gitClient).apply(record, root);
      assert.equal(outcome.state, "failed");
      assert.ok(outcome.issues.some(i => i.reason === "notRegularFile" && i.path === "src/money.ts"), JSON.stringify(outcome.issues));
      assert.equal(await readFile(join(dir, "elsewhere.ts"), "utf8"), QUOTE_BUGGY, "the link's target is untouched");
    }
  }));

// ---------------------------------------------------------------- apply

test("O5.5C1 apply (17-22): create, update, delete and a multi-file delivery write exactly the approved post-images, nothing else", { skip }, async () => {
  for (const [name, changes] of [["create", CREATE], ["update", UPDATE], ["delete", DELETE], ["multi", MULTI]] as const) await withPrimary(async root => {
    const { outcome, record, before, after, prepared } = await deliver(root, changes);
    assert.deepEqual([outcome.state, outcome.phase, outcome.issues, record.state], ["applied", "done", [], "applied"], name);
    assert.deepEqual(record.history, ["prepared", "approved", "applying", "applied"]);
    // 21. Every touched path is exactly its post-image; 22. no other path changed (the ignored .env canary included).
    const expected = { ...before };
    for (const op of prepared.manifest.operations) {
      if (op.afterSha256 === null) delete expected[op.path]; else expected[op.path] = op.afterSha256;
    }
    assert.deepEqual(after, Object.fromEntries(Object.entries(expected).sort(([a], [b]) => a < b ? -1 : 1)), name);
    assert.equal(await readFile(join(root, ".env"), "utf8"), `TOKEN=${ENV_CANARY}\n`);
    const status = git(root, "status", "--porcelain=v1", "-uall").split("\n").filter(Boolean).map(line => line.slice(3)).sort();
    assert.deepEqual(status, prepared.manifest.operations.map(op => op.path).sort(), `${name}: Git sees exactly the declared paths`);
    assert.equal(git(root, "rev-parse", "HEAD").trim(), prepared.manifest.primary.baseCommit, "no commit, no reset");
    assert.deepEqual(await stagingEntries(root), [], `${name}: staging removed`);
    assert.ok(outcome.evidence.operations.every(op => op.applied && op.restored === null));
    assert.ok(!JSON.stringify(outcome.evidence).includes(JSON.stringify(root).slice(1, -1)) && !JSON.stringify(outcome.evidence).includes(QUOTE_FIXED.slice(0, 40)),
      "evidence: no absolute path, no content");
  });
});

// ---------------------------------------------------------------- rollback

test("O5.5C1 rollback (23-26): an injected failure after the first write restores every preimage exactly; never a false APPLIED", { skip }, async () => {
  await withPrimary(async root => {
    const { outcome, record, before, after } = await deliver(root, MULTI, { afterOperation: index => { if (index === 1) throw new Error("injected"); } });
    assert.deepEqual([outcome.state, outcome.phase, record.state], ["rolledBack", "rollback", "rolledBack"]);
    assert.deepEqual(after, before, "every preimage restored exactly");
    assert.ok(!existsSync(join(root, "src", "lib")), "the created directory was removed");
    assert.deepEqual(outcome.evidence.operations.map(op => [op.path, op.applied, op.restored]),
      [["src/quote.ts", true, true], ["src/lib/discount.ts", true, true], ["docs/old.md", false, null]]);
    assert.deepEqual(outcome.issues, [{ reason: "applyFailed" }]);
    assert.deepEqual(await stagingEntries(root), []);
    assert.equal(git(root, "status", "--porcelain=v1", "-uall").trim(), "", "the primary is clean again");
  });
  // An undeclared change seen by the postcheck also rolls the delivery back: never APPLIED.
  await withPrimary(async root => {
    const { outcome, record, after } = await deliver(root, UPDATE, { beforePostcheck: async primary => writeFile(join(primary, "stray.txt"), "x\n") });
    assert.deepEqual([outcome.state, record.state], ["rolledBack", "rolledBack"]);
    assert.ok(outcome.issues.some(i => i.reason === "undeclaredChange" && i.path === "stray.txt"));
    assert.equal(after["src/quote.ts"], sha256(QUOTE_BUGGY), "the touched path is back to its preimage");
  });
  // A rollback that cannot restore a path is reported as such, and the staging with its backups is kept for recovery.
  await withPrimary(async root => {
    const { outcome, record, after, prepared } = await deliver(root, MULTI, {
      afterOperation: index => { if (index === 2) throw new Error("injected"); },
      beforeRestore: index => { if (index === 0) throw new Error("injected restore failure"); } });
    assert.deepEqual([outcome.state, record.state], ["rollbackFailed", "rollbackFailed"]);
    assert.ok(outcome.issues.some(i => i.reason === "restoreFailed" && i.path === "src/quote.ts"));
    assert.deepEqual(outcome.evidence.operations.map(op => [op.path, op.restored]), [["src/quote.ts", false], ["src/lib/discount.ts", true], ["docs/old.md", true]]);
    assert.equal(outcome.evidence.staging.retained, true);
    assert.equal((await stagingEntries(root)).length, 1, "the journal and backups are kept");
    assert.equal(after["src/quote.ts"], prepared.manifest.operations[0]!.afterSha256, "the unrestored path still holds the post-image (reported, not hidden)");
    assert.notEqual(record.state, "applied");
  });
});

// ---------------------------------------------------------------- approval

test("O5.5C1 approval (27-29): unapproved refused before anything runs; one approval, one manifest digest, one record", { skip }, async () =>
  withPrimary(async root => {
    const gitClient = await isolatedGit();
    const prepared = await prepare(root, UPDATE, gitClient);
    const calls = gitClient.calls.length;
    // 27. A prepared (unapproved) delivery is refused; nothing runs, the record stays prepared.
    const unapproved = new DeliveryRecord(prepared.manifest, prepared.bundle);
    await assert.rejects(deliveryApplier(gitClient).apply(unapproved, root), kind("SecurityViolation"));
    assert.deepEqual([unapproved.state, gitClient.calls.length], ["prepared", calls], "no Git command, no write");
    // Look-alikes are never approvals: a JSON copy, a provider-shaped record, a manifest's mere existence.
    const approval = issueTestOnlyApproval({ deliveryId: "c1-delivery", manifestSha256: prepared.manifestSha256, approver: "test human" });
    assert.ok(isIssuedApproval(approval));
    for (const fake of [JSON.parse(JSON.stringify(approval)), { ...approval }, prepared.manifest, { approved: true }])
      assert.throws(() => new DeliveryRecord(prepared.manifest, prepared.bundle).approve(fake), kind("SecurityViolation"));
    // 28. The exact manifest's approval approves it; the record then applies once.
    const record = new DeliveryRecord(prepared.manifest, prepared.bundle);
    record.approve(approval);
    assert.equal(record.state, "approved");
    assert.equal((await deliveryApplier(gitClient).apply(record, root)).state, "applied");
    await assert.rejects(deliveryApplier(gitClient).apply(record, root), kind("SecurityViolation"), "an applied delivery never applies again");
    // 29. The same approval cannot approve another record, nor another manifest's.
    assert.throws(() => new DeliveryRecord(prepared.manifest, prepared.bundle).approve(approval), kind("SecurityViolation"));
    const other = await withPrimary(async second => prepare(second, CREATE, await isolatedGit()));
    assert.throws(() => new DeliveryRecord(other.manifest, other.bundle).approve(issueTestOnlyApproval({ deliveryId: "c1-delivery",
      manifestSha256: prepared.manifestSha256, approver: "test human" })), kind("SecurityViolation"));
  }));

// ---------------------------------------------------------------- security

test("O5.5C1 security (30-32): only read-only local Git runs; hooks, fsmonitor and filter drivers never execute; no provider, model or network", { skip }, async () => {
  await withPrimary(async (root, dir) => {
    const marker = join(dir, "EXECUTED");
    const script = join(dir, "evil.js").split(sep).join("/");
    await writeFile(script, `require("fs").writeFileSync(${JSON.stringify(marker.split(sep).join("/"))}, "x");\n`);
    // A repository that would run a command on status (fsmonitor) and on every hook.
    git(root, "config", "core.fsmonitor", `node "${script}"`);
    await mkdir(join(root, ".git", "hooks"), { recursive: true });
    for (const hook of ["post-checkout", "pre-commit", "post-index-change"]) await writeFile(join(root, ".git", "hooks", hook), `#!/bin/sh\nnode "${script}"\n`);
    const { outcome, gitClient } = await deliver(root, MULTI);
    assert.equal(outcome.state, "applied");
    assert.equal(existsSync(marker), false, "no repository-controlled command ran");
    const subcommands = [...new Set(gitClient.calls.map(args => args[0]))].sort();
    assert.deepEqual(subcommands, ["check-ignore", "config", "rev-list", "rev-parse", "status"], "read-only local Git only (no fetch, push, commit, reset)");
    assert.ok(gitClient.calls.every(args => !args.some(arg => /^(?:fetch|pull|push|clone|ls-remote|remote|commit|reset|checkout|clean|stash)$/u.test(arg))));
  });
  // A configured filter driver could run on status: refused before any write, and nothing ran.
  await withPrimary(async (root, dir) => {
    const marker = join(dir, "FILTERED");
    const script = join(dir, "filter.js").split(sep).join("/");
    await writeFile(script, `require("fs").writeFileSync(${JSON.stringify(marker.split(sep).join("/"))}, "x"); process.stdin.pipe(process.stdout);\n`);
    await writeFile(join(root, ".gitattributes"), "*.ts filter=evil\n");
    git(root, "add", ".gitattributes");
    git(root, "commit", "-qm", "attributes");
    git(root, "config", "filter.evil.clean", `node "${script}"`);
    await rm(marker, { force: true });
    const gitClient = await isolatedGit();
    const record = approved(await prepare(root, UPDATE, gitClient));
    await rm(marker, { force: true });
    const outcome = await deliveryApplier(gitClient).apply(record, root);
    assert.deepEqual([outcome.state, outcome.issues], ["failed", [{ reason: "filterDriverConfigured" }]]);
    assert.ok(!gitClient.calls.slice(-6).some(args => args[0] === "status"), "status never ran with a filter driver configured");
    assert.equal(existsSync(marker), false);
  });
  // Static: the delivery code imports no process, network or provider module.
  for (const file of ["src/platform/delivery/applier.js", "src/core/delivery/manifest.js", "src/core/delivery/bundle.js", "src/core/delivery/approval.js",
    "src/core/delivery/prepare.js", "src/core/delivery/canonical.js", "src/app/delivery-composition.js"]) {
    const text = await readFile(resolve("dist", file), "utf8");
    for (const banned of ["child_process", "node:net", "node:http", "node:https", "fetch(", "/providers/", "supervisor"])
      assert.ok(!text.includes(banned), `${file} must not use ${banned}`);
  }
});

test("O5.5C1 readiness (33): the offline foundation moves only its own row; Writer mode, O5.5B, O6 and the live gate do not; no command exposes delivery", async () => {
  const report = writerGateReport();
  const rows = Object.fromEntries(report.rows.map(row => [row.id, [row.state, row.evidenceKind]]));
  assert.deepEqual(rows.humanApprovedDelivery, ["partial", "mechanical"]);
  const row = report.rows.find(r => r.id === "humanApprovedDelivery")!;
  // O5.5C2 added the human approval authority and the delivery commands, O5.5C4 the production apply policy; no ordinary
  // or real checkout has received a delivery live.
  assert.match(row.remainingBlocker, /^No ordinary or real checkout has received a delivery through the normal `fusion apply` live \(REAL_PRIMARY_APPLY_LIVE not run/u);
  assert.deepEqual([rows.hostControlledWriterWorkflow, rows.liveGateAuthorization], [["satisfied", "recordedLiveProbe"], ["blocked", "none"]]);
  assert.deepEqual([report.realWriterModeReady, REAL_WRITER_LIVE_GATE_AUTHORIZED], [false, false]);
  // No CLI module reaches the applier, the approval authority or the composition.
  const cli = await readdir(resolve("dist", "src", "cli"), { recursive: true });
  for (const file of cli.filter(name => name.endsWith(".js"))) {
    const text = await readFile(resolve("dist", "src", "cli", file), "utf8");
    for (const banned of ["delivery-composition", "delivery/applier", "delivery/approval", "issueTestOnlyApproval"])
      assert.ok(!text.includes(banned), `src/cli/${file} must not reach ${banned}`);
  }
});
