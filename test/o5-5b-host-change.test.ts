import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { test } from "node:test";
import { changeSetSchema, validateChangeSet } from "../src/core/change/contract.js";
import type { CapabilitySnapshot, ChangeScope, DelegationPacket, ProviderAdapter, Session, VerificationPlan } from "../src/core/domain.js";
import { FusionFailure } from "../src/core/errors.js";
import { resolveRole } from "../src/core/policy/routing.js";
import { structuredTurnPrompt } from "../src/core/review/contract.js";
import { proposeApplyAndVerify } from "../src/app/change-author.js";
import { applyCandidateChanges } from "../src/platform/workspace/change-applier.js";
import { ProcessGitClient } from "../src/platform/workspace/git.js";
import { PrivateWriterWorkspace } from "../src/platform/workspace/private-writer.js";
import { parseStructured, toMuseStrictSchema } from "../src/providers/muse/structured-output.js";

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const scope: ChangeScope = { allowedPaths: ["a.txt", "b.txt", "new.txt", "safe/file.txt"], forbiddenPaths: [] };
const replacement = { schemaVersion: 1, operations: [{ kind: "writeText", path: "a.txt", expectedSha256: sha("base\n"), content: "new\n" }] };
const kind = (name: string) => (error: unknown): boolean => error instanceof FusionFailure && error.error.kind === name;
const valid = (operations: unknown[]) => ({ schemaVersion: 1, operations });
const gitAvailable = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;
function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", ["-c", "user.name=Fusion Test", "-c", "user.email=fusion@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
}
const plan: VerificationPlan = { commands: [{ id: "check", executable: process.execPath,
  args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 10_000, mutationPolicy: "readOnly" }] };
async function fixture(work: (root: string, writer: PrivateWriterWorkspace) => Promise<void>): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), "fusion-host-change-"));
  try {
    const root = join(temp, "primary");
    await mkdir(root);
    git(root, "init", "-q");
    await writeFile(join(root, "a.txt"), "base\n");
    await writeFile(join(root, "b.txt"), "delete\n");
    await writeFile(join(root, ".gitignore"), "ignored.env\n");
    git(root, "add", "."); git(root, "commit", "-qm", "base");
    const writer = await PrivateWriterWorkspace.open(root, "owner", await ProcessGitClient.fromPath(process.env, true), plan);
    try { await work(root, writer); }
    finally { await writer.close("owner", { discardChanges: true }); }
  } finally {
    assert.ok(resolve(temp).toLowerCase().startsWith(`${resolve(tmpdir()).toLowerCase()}${sep}`));
    await rm(temp, { recursive: true, force: true });
  }
}

test("ChangeSet v0.1 accepts only bounded exact file operations and strict JSON properties", () => {
  assert.deepEqual(validateChangeSet(replacement, scope), replacement);
  assert.deepEqual(validateChangeSet(valid([{ kind: "writeText", path: "new.txt", expectedSha256: null, content: "" }]), scope).operations.length, 1);
  assert.deepEqual(validateChangeSet(valid([{ kind: "delete", path: "b.txt", expectedSha256: sha("delete\n") }]), scope).operations.length, 1);
  const badPaths = ["../a.txt", "safe/../a.txt", "D:\\a.txt", "C:a.txt", "\\\\server\\share\\a.txt",
    "\\\\?\\C:\\a.txt", "\\\\.\\C:\\a.txt", ".git/config", ".GIT/hooks/x", "a.txt:stream",
    "a.txt.", "a.txt ", "CON", "COM¹", "PROGRA~1", "safe//file.txt", "safe/./file.txt", "/a.txt", "safe\\file.txt"];
  for (const path of badPaths)
    assert.throws(() => validateChangeSet(valid([{ kind: "writeText", path, expectedSha256: null, content: "x" }]),
      { allowedPaths: [path], forbiddenPaths: [] }), kind("SecurityViolation"), path);
  assert.throws(() => validateChangeSet({ ...replacement, extra: true }, scope), kind("MalformedOutput"));
  assert.throws(() => validateChangeSet(valid([{ ...replacement.operations[0], extra: "x" }]), scope), kind("MalformedOutput"));
  assert.throws(() => validateChangeSet(valid([replacement.operations[0], replacement.operations[0]]), scope), kind("SecurityViolation"));
  assert.throws(() => validateChangeSet(valid([replacement.operations[0], { ...replacement.operations[0], path: "A.txt" }]),
    { allowedPaths: ["a.txt"], forbiddenPaths: [] }), kind("SecurityViolation"));
  assert.throws(() => validateChangeSet(replacement, { allowedPaths: ["a.txt"], forbiddenPaths: ["a.txt"] }), kind("SecurityViolation"));
  assert.throws(() => validateChangeSet(valid([{ kind: "writeText", path: "safe/file.txt", expectedSha256: null,
    content: "x" }]), { allowedPaths: ["safe/file.txt"], forbiddenPaths: ["safe"] }), kind("SecurityViolation"));
  assert.throws(() => validateChangeSet(replacement, { allowedPaths: [], forbiddenPaths: [] }), kind("InvalidInput"));
  assert.throws(() => validateChangeSet(replacement, { allowedPaths: ["b.txt"], forbiddenPaths: [] }), kind("SecurityViolation"));
  assert.throws(() => validateChangeSet(valid([{ ...replacement.operations[0], content: "x".repeat(1024 * 1024 + 1) }]), scope),
    kind("SecurityViolation"));
  assert.throws(() => validateChangeSet(valid(Array.from({ length: 33 }, () => replacement.operations[0])), scope), kind("MalformedOutput"));
  assert.throws(() => validateChangeSet(valid([{ kind: "delete", path: "a.txt", expectedSha256: null }]), scope), kind("MalformedOutput"));
  assert.throws(() => validateChangeSet(valid([{ ...replacement.operations[0], expectedSha256: "bad" }]), scope), kind("MalformedOutput"));
});

test("ChangeSet decoder shares the canonical schema with Muse strict-wire adaptation", () => {
  const schema = changeSetSchema(), wire = toMuseStrictSchema(schema);
  const encoded = { schemaVersion: 1, operations: [{ kind: "delete", path: "b.txt", expectedSha256: sha("delete\n"), content: null }] };
  assert.deepEqual(parseStructured(JSON.stringify(encoded), schema, wire), valid([{ kind: "delete", path: "b.txt", expectedSha256: sha("delete\n") }]));
  assert.match(structuredTurnPrompt({ kind: "changeProposal", packet: packet() }), /read-only Change Author/);
  assert.throws(() => validateChangeSet({ ...encoded, operations: [{ ...encoded.operations[0], content: "intrusion" }] }, scope), kind("MalformedOutput"));
});

test("host applies replace, create and delete in one private candidate; ledger contains no content", { skip: !gitAvailable },
  async () => fixture(async (root, writer) => {
    const changes = valid([replacement.operations[0], { kind: "writeText", path: "new.txt", expectedSha256: null,
      content: "LEDGER_SECRET_7cd9\n" }, { kind: "delete", path: "b.txt", expectedSha256: sha("delete\n") }]);
    const ledger = await writer.applyChangeSet("owner", changes, scope);
    assert.equal(ledger.length, 3);
    assert.equal(JSON.stringify(ledger).includes("LEDGER_SECRET_7cd9"), false);
    assert.equal(await readFile(join(writer.path, "a.txt"), "utf8"), "new\n");
    assert.equal(await readFile(join(writer.path, "new.txt"), "utf8"), "LEDGER_SECRET_7cd9\n");
    await assert.rejects(readFile(join(writer.path, "b.txt")), { code: "ENOENT" });
    assert.equal(await readFile(join(root, "a.txt"), "utf8"), "base\n");
    assert.equal(await readFile(join(root, "b.txt"), "utf8"), "delete\n");
    assert.equal((await writer.verify("owner", ledger.map(item => item.path))).passed, true);
    await writeFile(join(writer.path, "ignored.env"), "late influence\n");
    await assert.rejects(writer.verify("owner", ledger.map(item => item.path)), kind("SecurityViolation"));
    await assert.rejects(writer.applyChangeSet("owner", replacement, scope), kind("WorkspaceConflict"));
  }));

test("stale hashes, existing-create and missing-delete fail without changing primary", { skip: !gitAvailable },
  async () => fixture(async (root, writer) => {
    for (const operation of [{ ...replacement.operations[0], expectedSha256: sha("stale") },
      { kind: "writeText", path: "a.txt", expectedSha256: null, content: "x" },
      { kind: "delete", path: "new.txt", expectedSha256: sha("missing") }]) {
      await assert.rejects(applyCandidateChanges(writer.path, dirname(writer.path),
        validateChangeSet(valid([operation]), scope)), kind("WorkspaceConflict"));
    }
    await assert.rejects(writer.applyChangeSet("owner", valid([{ ...replacement.operations[0], expectedSha256: sha("stale") }]), scope),
      kind("WorkspaceConflict"));
    assert.equal(await readFile(join(root, "a.txt"), "utf8"), "base\n");
    await assert.rejects(writer.verify("owner", ["a.txt"]), kind("WorkspaceConflict"));
  }));

test("host rejects symlink parent, primary root and direct Git metadata target", { skip: !gitAvailable },
  async () => fixture(async (root, writer) => {
    const validated = validateChangeSet(valid([{ kind: "writeText", path: "safe/file.txt",
      expectedSha256: null, content: "x" }]), scope);
    await mkdir(join(writer.path, "safe"));
    await rm(join(writer.path, "safe"), { recursive: true });
    await symlink(root, join(writer.path, "safe"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(applyCandidateChanges(writer.path, dirname(writer.path), validated), kind("SecurityViolation"));
    await assert.rejects(writer.applyChangeSet("owner", valid([{ kind: "writeText", path: "safe/file.txt",
      expectedSha256: null, content: "x" }]), scope), kind("SecurityViolation"));
    await assert.rejects(applyCandidateChanges(root, resolve(root, ".."), validateChangeSet(replacement, scope)), kind("SecurityViolation"));
    assert.throws(() => validateChangeSet(valid([{ kind: "writeText", path: ".git/config", expectedSha256: null,
      content: "x" }]), scope), kind("SecurityViolation"));
  }));

test("ignored candidate influence is refused before host application", { skip: !gitAvailable },
  async () => fixture(async (_root, writer) => {
    await writeFile(join(writer.path, "ignored.env"), "hidden\n");
    await assert.rejects(writer.applyChangeSet("owner", replacement, scope), kind("SecurityViolation"));
  }));

function packet(): DelegationPacket { return { task: { goal: "change a", constraints: [], acceptanceCriteria: [] },
  scope: { relevantFiles: ["a.txt"], allowedFiles: ["a.txt"], forbiddenFiles: [] },
  architecture: { decisions: [], invariants: [] }, verification: { requiredTests: [] }, openQuestions: [] }; }
const caps: CapabilitySnapshot = { provider: "fixture", transport: "fixture", observedAt: "2026-01-01T00:00:00Z",
  runtimeVersion: "fixture", persistentSessions: false, structuredOutput: true, webToolsDisabled: true,
  filesystem: { read: true, write: false }, shell: { available: false, sandboxed: false }, approvalCallback: false,
  protocolCancellation: true, usageReporting: false, modelIdentityReadback: true, subscriptionLaneReadback: true,
  approvalEscalationDisabled: true, personalContextDisabled: true, extensionsQuarantined: true };
test("read-only Worker proposal routes without filesystem write and host alone mutates candidate", { skip: !gitAvailable },
  async () => fixture(async (root, writer) => {
    const sessions: Session[] = [];
    const adapter: ProviderAdapter = { capabilities: async () => caps,
      authStatus: async () => ({ state: "authenticated", lane: "subscription", observedAt: "", evidence: [] }),
      createSession: async request => { const session: Session = { id: "s", runId: request.runId, role: request.role,
        provider: "fixture", transport: "fixture", workspaceLeaseId: request.workspaceLeaseId,
        posture: request.posture, providerSessionRef: "s" }; sessions.push(session); return session; },
      resumeSession: async session => session,
      runTurn: async () => { throw new Error("packet turn not allowed"); },
      runChangeProposalTurn: async (session, request) => {
        assert.equal(session.posture, "readOnly"); assert.equal(request.kind, "changeProposal");
        assert.equal(await readFile(join(root, "a.txt"), "utf8"), "base\n");
        assert.equal(await readFile(join(writer.path, "a.txt"), "utf8"), "base\n");
        return { status: "completed", output: replacement, effectiveProvider: "fixture", effectiveModel: "fixture", artifactRefs: [] };
      }, cancel: async () => {}, usage: async () => null, close: async () => {} };
    const binding = { role: "Worker" as const, provider: "fixture", transport: "fixture", model: { id: "fixture", effort: "low" }, requires: {} };
    const role = await resolveRole("Worker", [{ binding, adapter }], undefined, { changeProposal: true });
    assert.equal(role.posture, "readOnly"); assert.equal(role.capabilities.filesystem.write, false);
    for (const unsafe of [{ filesystem: { read: true, write: true } }, { shell: { available: true, sandboxed: true } }])
      await assert.rejects(resolveRole("Worker", [{ binding, adapter: { ...adapter,
        capabilities: async () => ({ ...caps, ...unsafe }) } }], undefined, { changeProposal: true }),
      kind("CapabilityUnavailable"));
    const result = await proposeApplyAndVerify({ candidates: [{ binding, adapter }], workspace: writer,
      packet: packet(), runId: "run", leaseId: "lease" });
    assert.equal(sessions.length, 1); assert.equal(result.verification.passed, true);
    assert.equal(await readFile(join(root, "a.txt"), "utf8"), "base\n");
    assert.equal(await readFile(join(writer.path, "a.txt"), "utf8"), "new\n");
  }));
