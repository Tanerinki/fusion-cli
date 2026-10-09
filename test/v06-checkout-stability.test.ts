import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { deliveryApplier, prepareRunDelivery } from "../src/app/delivery-composition.js";
import { QUOTE_BUGGY, QUOTE_FIXED, QUOTE_TEST } from "../src/app/route-fixture.js";
import { assessCheckoutByteStability, classifyPathTransform, describeCheckoutTransform,
  type CheckoutConfig, type PathAttributes } from "../src/platform/workspace/checkout-stability.js";
import { DeliveryRecord, issueTestOnlyApproval } from "../src/core/delivery/approval.js";
import type { ChangeSet } from "../src/core/domain.js";
import type { WorkflowResult } from "../src/core/workflow/types.js";
import { ProcessGitClient, type GitClient } from "../src/platform/workspace/git.js";
import { changeSet } from "./fixtures/fake-writer.js";
import { gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

const skip = gitAvailable ? false : "git is not available";

// ------------------------------------------------------------------ pure classifier (no git)
const attrs = (over: Partial<PathAttributes> = {}): PathAttributes =>
  ({ text: "unspecified", eol: "unspecified", filter: "unspecified", workingTreeEncoding: "unspecified", ...over });
const cfg = (over: Partial<CheckoutConfig> = {}): CheckoutConfig => ({ autocrlf: "false", coreEol: "native", platform: "win32", ...over });
const cause = (a: PathAttributes, c: CheckoutConfig) => classifyPathTransform(a, c)?.cause ?? "stable";

test("v0.6 classify: core.autocrlf=true transforms an unmarked text path; input/false do not", () => {
  assert.equal(cause(attrs(), cfg({ autocrlf: "true" })), "autocrlf");
  assert.equal(cause(attrs(), cfg({ autocrlf: "input" })), "stable");
  assert.equal(cause(attrs(), cfg({ autocrlf: "false" })), "stable");
});

test("v0.6 classify: eol=lf and -text (binary) are stable even under core.autocrlf=true (the override case)", () => {
  assert.equal(cause(attrs({ eol: "lf" }), cfg({ autocrlf: "true" })), "stable");
  assert.equal(cause(attrs({ text: "unset" }), cfg({ autocrlf: "true" })), "stable");                // `-text`/binary
  assert.equal(cause(attrs({ text: "auto", eol: "lf" }), cfg({ autocrlf: "true" })), "stable");       // the real repo's rule
});

test("v0.6 classify: explicit transforming directives are refused", () => {
  assert.equal(cause(attrs({ eol: "crlf" }), cfg()), "eolAttribute");
  assert.equal(cause(attrs({ filter: "lfs" }), cfg()), "filter");
  assert.equal(cause(attrs({ filter: "lfs", eol: "lf" }), cfg()), "filter");                          // a filter overrides a benign eol
  assert.equal(cause(attrs({ workingTreeEncoding: "UTF-16" }), cfg()), "workingTreeEncoding");
});

test("v0.6 classify: core.eol decides a text path only when autocrlf is off, and is platform-specific", () => {
  assert.equal(cause(attrs({ text: "auto" }), cfg({ autocrlf: "false", coreEol: "crlf" })), "coreEol");
  assert.equal(cause(attrs({ text: "set" }), cfg({ autocrlf: "false", coreEol: "native", platform: "win32" })), "coreEol");
  assert.equal(cause(attrs({ text: "set" }), cfg({ autocrlf: "false", coreEol: "native", platform: "posix" })), "stable");
  assert.equal(cause(attrs({ text: "set" }), cfg({ autocrlf: "false", coreEol: "lf", platform: "win32" })), "stable");
});

// ------------------------------------------------------------------ integration (real throw-away repos)
const g = (cwd: string, ...args: string[]): string => execFileSync("git",
  ["-c", "user.name=T", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args],
  { cwd, encoding: "utf8", windowsHide: true });
async function withRepo(run: (root: string) => Promise<void>, setup: (root: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "fusion-v06-stab-"));
  try { const root = join(dir, "r"); await mkdir(root, { recursive: true }); await setup(root); await run(root); }
  finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}
/** Commits `files` as LF blobs (autocrlf off), then optionally re-checks-out under a given autocrlf so Git itself smudges. */
async function committedRepo(root: string, files: Record<string, string | Uint8Array>, opts: { autocrlf?: string; attributes?: string } = {}): Promise<void> {
  g(root, "init", "-q"); g(root, "config", "core.autocrlf", "false");
  if (opts.attributes !== undefined) await writeFile(join(root, ".gitattributes"), opts.attributes);
  for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); }
  g(root, "add", "."); g(root, "commit", "-qm", "baseline");
  if (opts.autocrlf !== undefined) {
    g(root, "config", "core.autocrlf", opts.autocrlf);
    for (const path of Object.keys(files)) { rmSync(join(root, path)); g(root, "checkout", "--", path); } // Git re-smudges; tree stays clean
  }
}
const nonIsolatedGit = () => ProcessGitClient.fromPath(process.env, false);

test("v0.6 assess: a clean CRLF checkout of an LF blob is refused (the production apply failure)", { skip }, async () => {
  await withRepo(async root => {
    assert.equal(g(root, "status", "--porcelain").trim(), "", "Git itself considers the smudged tree clean");
    const s = await assessCheckoutByteStability(root, ["src/a.ts"], await nonIsolatedGit(), "win32");
    assert.equal(s.stable, false);
    assert.equal(s.transforms[0]?.cause, "autocrlf");
    assert.equal(s.transforms[0]?.path, "src/a.ts");
    assert.match(describeCheckoutTransform(s), /byte-stable checkout semantics/u);
  }, root => committedRepo(root, { "src/a.ts": "export const a = 1;\nexport const b = 2;\n" }, { autocrlf: "true" }));
});

test("v0.6 assess: LF bytes under autocrlf=true are stable (no false positive — the rig/fixture case)", { skip }, async () => {
  await withRepo(async root => {
    // Files written and committed as LF, then autocrlf flipped true but the working bytes left LF.
    g(root, "config", "core.autocrlf", "true");
    const s = await assessCheckoutByteStability(root, ["src/a.ts"], await nonIsolatedGit(), "win32");
    assert.equal(s.stable, true, JSON.stringify(s.transforms));
    assert.equal(s.autocrlf, "true");
  }, root => committedRepo(root, { "src/a.ts": "export const a = 1;\n" }));
});

test("v0.6 assess: core.autocrlf=false is stable; a .gitattributes eol=lf override is stable under autocrlf=true", { skip }, async () => {
  await withRepo(async root => {
    assert.equal((await assessCheckoutByteStability(root, ["src/a.ts"], await nonIsolatedGit(), "win32")).stable, true);
  }, root => committedRepo(root, { "src/a.ts": "export const a = 1;\n" }));
  await withRepo(async root => {
    assert.equal(g(root, "status", "--porcelain").trim(), "");
    const s = await assessCheckoutByteStability(root, ["src/a.ts"], await nonIsolatedGit(), "win32");
    assert.equal(s.stable, true, JSON.stringify(s.transforms));           // eol=lf forces LF, so the checkout did not smudge
  }, root => committedRepo(root, { "src/a.ts": "export const a = 1;\n" }, { autocrlf: "true", attributes: "* text=auto eol=lf\n" }));
});

test("v0.6 assess: a non-UTF-8 file is compared byte-exactly, never as decoded text — a smudged one is refused, an equal one is stable", { skip }, async () => {
  // "café\nx\n" in Latin-1: invalid UTF-8. The old comparison decoded `git cat-file` output as UTF-8; the decode failed,
  // the failure was read as "not in HEAD", and a genuinely CRLF-smudged file passed as byte-stable (fail-open).
  const latin1 = Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x78, 0x0a]);
  await withRepo(async root => {
    assert.equal(g(root, "status", "--porcelain").trim(), "", "Git calls the smudged tree clean");
    const s = await assessCheckoutByteStability(root, ["legacy.txt"], await nonIsolatedGit(), "win32");
    assert.equal(s.stable, false, "a real CRLF smudge of a non-UTF-8 blob must never pass as byte-stable");
    assert.equal(s.transforms[0]?.cause, "autocrlf");
  }, root => committedRepo(root, { "legacy.txt": latin1 }, { autocrlf: "true" }));
  await withRepo(async root => {
    g(root, "config", "core.autocrlf", "true");
    const s = await assessCheckoutByteStability(root, ["legacy.txt"], await nonIsolatedGit(), "win32");
    assert.equal(s.stable, true, JSON.stringify(s.transforms));          // the working bytes still equal the blob
  }, root => committedRepo(root, { "legacy.txt": latin1 }));
});

test("v0.6 assess: a Git failure while comparing the bytes is undetermined (fail closed), never assumed stable", async () => {
  // Config, attributes and status answer like a clean autocrlf=true checkout; the byte comparison itself cannot run.
  const failing: GitClient = { run: async args => {
    if (args[0] === "config") return { exitCode: 0, stdout: args[2] === "core.autocrlf" ? "true\n" : "", stderr: "" };
    if (args[0] === "check-attr" || args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" };
    throw new Error("git could not run");
  } };
  const s = await assessCheckoutByteStability(tmpdir(), ["src/a.ts"], failing, "win32");
  assert.equal(s.stable, false);
  assert.deepEqual(s.transforms.map(t => [t.path, t.cause]), [["src/a.ts", "undetermined"]]);
});

test("v0.6 assess: a binary path is exact-byte safe under autocrlf=true; an eol=crlf attribute is refused", { skip }, async () => {
  await withRepo(async root => {
    const s = await assessCheckoutByteStability(root, ["data.bin"], await nonIsolatedGit(), "win32");
    assert.equal(s.stable, true, JSON.stringify(s.transforms));           // `*.bin binary` -> -text -> never converted
  }, root => committedRepo(root, { "data.bin": "a\r\nb\r\nc\n" }, { autocrlf: "true", attributes: "*.bin binary\n" }));
  await withRepo(async root => {
    const s = await assessCheckoutByteStability(root, ["win.txt"], await nonIsolatedGit(), "win32");
    assert.equal(s.stable, false);
    assert.equal(s.transforms[0]?.cause, "eolAttribute");
  }, root => committedRepo(root, { "win.txt": "a\nb\n" }, { autocrlf: "false", attributes: "win.txt text eol=crlf\n" }));
});

test("v0.6 assess: a custom filter driver is refused; a genuine user edit is NOT a checkout transform", { skip }, async () => {
  await withRepo(async root => {
    const s = await assessCheckoutByteStability(root, ["src/a.ts"], await nonIsolatedGit(), "win32");
    assert.equal(s.stable, false);
    assert.equal(s.transforms[0]?.cause, "filter");
  }, root => committedRepo(root, { "src/a.ts": "x\n" }, { attributes: "*.ts filter=evil\n" }));
  await withRepo(async root => {
    await writeFile(join(root, "src/a.ts"), "export const a = 999;\n"); // an uncommitted user edit (git reports it modified)
    assert.notEqual(g(root, "status", "--porcelain").trim(), "");
    const s = await assessCheckoutByteStability(root, ["src/a.ts"], await nonIsolatedGit(), "win32");
    assert.equal(s.stable, true, "a dirty working file is a user edit, not a checkout transform");
  }, root => committedRepo(root, { "src/a.ts": "export const a = 1;\n" }, { autocrlf: "true" }));
});

test("v0.6 assess: policy is path-specific and a create (not in HEAD) is byte-safe", { skip }, async () => {
  await withRepo(async root => {
    // One path smudged to CRLF (refused), a sibling forced eol=lf (stable), and a brand-new path (create, byte-safe).
    const s = await assessCheckoutByteStability(root, ["crlf.txt", "keep.md", "src/new.ts"], await nonIsolatedGit(), "win32");
    assert.equal(s.stable, false);
    assert.deepEqual(s.transforms.map(t => t.path), ["crlf.txt"]);
  }, async root => {
    await committedRepo(root, { "crlf.txt": "a\nb\n", "keep.md": "# keep\n" }, { autocrlf: "true", attributes: "keep.md eol=lf\n" });
  });
});

// ------------------------------------------------------------------ build-level gate (via the delivery applier's byte check is tested below;
// the production `build()` gate is exercised by test/v01-build.test.ts through the rig, which uses byte-stable fixtures).

// ------------------------------------------------------------------ apply diagnostics (requirement 5)
const sha256 = (content: string): string => createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
const acceptedResult = (changes: ChangeSet): WorkflowResult => ({ state: "completed", transitions: [], delegateAttempts: 1, reviews: [], changeSet: changes,
  applied: changes.operations.map(op => ({ kind: op.kind, path: op.path, beforeSha256: op.expectedSha256,
    afterSha256: op.kind === "delete" ? null : sha256(op.content), bytes: op.kind === "delete" ? 0 : Buffer.byteLength(op.content) })),
  verification: { passed: true, commandsRun: 1, evidence: { backendId: "docker-linux", confinement: "osSandbox", platformRequirement: "linux-compatible",
    acceptance: "granted", commands: [{ id: "unit", status: "passed", exitCode: 0 }] } } });

async function applyDelivery(root: string, changes: ChangeSet) {
  const git = await ProcessGitClient.fromPath(process.env, true);
  const prepared = await prepareRunDelivery({ deliveryId: "v06-delivery", runId: "v06-run", taskSha256: "a".repeat(64), workflowEvidenceSha256: "b".repeat(64),
    result: acceptedResult(changes), scope: { allowedPaths: changes.operations.map(op => op.path), forbiddenPaths: [] },
    baseCommit: g(root, "rev-parse", "HEAD").trim(), primaryRoot: root, git });
  const record = new DeliveryRecord(prepared.manifest, prepared.bundle);
  record.approve(issueTestOnlyApproval({ deliveryId: prepared.manifest.deliveryId, manifestSha256: prepared.manifestSha256, approver: "test" }));
  return deliveryApplier(git).apply(record, root);
}

test("v0.6 apply: a CRLF working file vs an LF preimage reports fileChanged with eol-only + sanitized digests/sizes", { skip }, async () => {
  await withRepo(async root => {
    const outcome = await applyDelivery(root, changeSet([["src/quote.ts", QUOTE_BUGGY, QUOTE_FIXED]]));
    assert.equal(outcome.state, "failed");
    const fc = outcome.issues.find(i => i.reason === "fileChanged");
    assert.ok(fc, "fileChanged is reported");
    assert.equal(fc!.path, "src/quote.ts");
    assert.equal(fc!.eolOnlyMismatch, true, "the only difference is CRLF/LF");
    assert.equal(typeof fc!.expectedSha256, "string");
    assert.equal(typeof fc!.observedSha256, "string");
    assert.notEqual(fc!.expectedSha256, fc!.observedSha256);
    assert.ok((fc!.observedBytes ?? 0) > (fc!.expectedBytes ?? 0), "CRLF is larger than LF");
    // No file content leaks into the diagnostic.
    assert.ok(!JSON.stringify(outcome.issues).includes("basisPoints"));
  }, root => committedRepo(root, { "src/quote.ts": QUOTE_BUGGY, "test/quote.test.ts": QUOTE_TEST }, { autocrlf: "true" }));
});

test("v0.6 apply: a genuine (non-EOL) content edit is fileChanged WITHOUT eol-only, and dirtyTree stays a distinct issue", { skip }, async () => {
  await withRepo(async root => {
    // An uncommitted content edit of the touched path: the working bytes differ by real content, not only CRLF/LF.
    await writeFile(join(root, "src/quote.ts"), `${QUOTE_BUGGY}// genuine unrelated edit\n`);
    const outcome = await applyDelivery(root, changeSet([["src/quote.ts", QUOTE_BUGGY, QUOTE_FIXED]]));
    assert.equal(outcome.state, "failed");
    const fc = outcome.issues.find(i => i.reason === "fileChanged");
    assert.ok(fc, "the content edit is reported as fileChanged");
    assert.notEqual(fc!.eolOnlyMismatch, true, "a content edit is not an EOL-only mismatch");
    assert.ok(outcome.issues.some(i => i.reason === "dirtyTree"), "dirtyTree remains a distinct issue from fileChanged");
  }, root => committedRepo(root, { "src/quote.ts": QUOTE_BUGGY, "test/quote.test.ts": QUOTE_TEST }));
});
