import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FusionFailure } from "../src/core/errors.js";
import type { VerificationPlan } from "../src/core/domain.js";
import { executeVerification, TrustedHostBackend, type VerificationExecutionRequest } from "../src/platform/verification/backend.js";
import { assertApprovedManifests, DependencyPolicyError, dependencyIdentity, dependencyIdentityKey, NPM_CI_ARGS,
  readNpmManifests, validateNpmManifests, type DependencyRequirement } from "../src/platform/verification/dependency-policy.js";
import { DockerLinuxVerificationBackend, limitsForDependencies,
  type DockerVerificationExecutionResult } from "../src/platform/verification/docker/backend.js";
import { DEFAULT_DOCKER_LIMITS, GUEST_BOOTSTRAP } from "../src/platform/verification/docker/config.js";
import { DependencyArtifactStore, validateArtifactStructure } from "../src/platform/verification/docker/dependency-artifacts.js";
import { FAKE_DOCKER_EXE, FAKE_IMAGE, FakeDocker, gzipTree, passingResult, readArchive, type FakeDockerOptions } from "./fixtures/fake-docker.js";
import { FIXTURE_LOCKFILE, FIXTURE_PACKAGE_JSON } from "./fixtures/npm-fixture.js";

const kind = (name: string) => (error: unknown): boolean => error instanceof FusionFailure && error.error.kind === name;
const policy = (code: string) => (error: unknown): boolean => error instanceof DependencyPolicyError && error.code === code;
const sha = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");
const PKG = Buffer.from(FIXTURE_PACKAGE_JSON), LOCK = Buffer.from(FIXTURE_LOCKFILE);
const APPROVED: DependencyRequirement = { kind: "npm-lockfile", approved: { packageJsonSha256: sha(PKG), lockfileSha256: sha(LOCK) } };
const RUNTIME = { image: FAKE_IMAGE, os: "linux", arch: "amd64" };
const NODE = "/usr/local/bin/node";
const lock = (mutate: (value: Record<string, any>) => void): Buffer => {
  const value = JSON.parse(FIXTURE_LOCKFILE) as Record<string, any>;
  mutate(value);
  return Buffer.from(JSON.stringify(value));
};
const pkg = (mutate: (value: Record<string, any>) => void): Buffer => {
  const value = JSON.parse(FIXTURE_PACKAGE_JSON) as Record<string, any>;
  mutate(value);
  return Buffer.from(JSON.stringify(value));
};
const plan: VerificationPlan = { commands: [{ id: "test", executable: NODE, args: ["--test"], cwd: ".", timeoutMs: 5_000,
  mutationPolicy: "readOnly" }] };

async function withProject(work: (root: string, project: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "fusion-o55b6-deps-"));
  try {
    const project = join(root, "project");
    await mkdir(join(project, "test"), { recursive: true });
    await writeFile(join(project, "package.json"), PKG);
    await writeFile(join(project, "package-lock.json"), LOCK);
    await writeFile(join(project, "test", "a.test.mjs"), "SOURCE-ONLY-MARKER");
    await work(root, project);
  } finally { await rm(root, { recursive: true, force: true }); }
}
const backendWith = (fake: FakeDocker, root: string): DockerLinuxVerificationBackend => new DockerLinuxVerificationBackend({
  image: FAKE_IMAGE, runner: fake, resolveDocker: () => Promise.resolve(FAKE_DOCKER_EXE), baseDirectory: root,
  dependencyStoreDirectory: join(root, "store") });
const request = (project: string, overrides: Partial<VerificationExecutionRequest> = {}): VerificationExecutionRequest =>
  ({ plan, workspaceRoot: project, git: {} as never, env: {}, platformRequirement: "linux-compatible", dependencies: APPROVED, ...overrides });

// ---------------------------------------------------------------- policy

test("O5.5B6 deps: a real registry-only lockfile is eligible and yields an exact identity", () => {
  const report = validateNpmManifests(PKG, LOCK);
  assert.deepEqual([report.packages, report.lockfileVersion, report.installScriptPackages, report.skippedRootScripts], [3, 3, [], []]);
  assert.equal(report.packageJsonSha256, sha(PKG));
  assert.equal(report.lockfileSha256, sha(LOCK));
  const identity = dependencyIdentity(report, RUNTIME);
  const key = dependencyIdentityKey(identity);
  assert.match(key, /^[0-9a-f]{64}$/u);
  assert.equal(dependencyIdentityKey(dependencyIdentity(report, RUNTIME)), key, "deterministic");
  assert.deepEqual(identity.npmArgs, NPM_CI_ARGS);
  assert.ok(NPM_CI_ARGS.includes("--ignore-scripts") && NPM_CI_ARGS.includes("--no-bin-links"), "lifecycle scripts never run");
  // Every identity component changes the cache key.
  const variants = [dependencyIdentity({ ...report, lockfileSha256: "0".repeat(64) }, RUNTIME),
    dependencyIdentity({ ...report, packageJsonSha256: "0".repeat(64) }, RUNTIME),
    dependencyIdentity(report, { ...RUNTIME, image: `node@sha256:${"cd".repeat(32)}` }),
    dependencyIdentity(report, { ...RUNTIME, arch: "arm64" }), dependencyIdentity(report, RUNTIME, ["esbuild"])];
  assert.equal(new Set([key, ...variants.map(dependencyIdentityKey)]).size, 6);
});

test("O5.5B6 deps: unsupported or unsafe dependency configurations fail closed with stable codes", () => {
  const cases: Record<string, [Buffer, Buffer]> = {
    "lockfile-version-unsupported": [PKG, lock(v => { v.lockfileVersion = 1; })],
    "lockfile-packages-missing": [PKG, lock(v => { delete v.packages; })],
    "workspaces-unsupported": [pkg(v => { v.workspaces = ["packages/*"]; }), LOCK],
    "linked-package-unsupported": [PKG, lock(v => { v.packages["node_modules/is-odd"].link = true; })],
    "non-registry-resolved": [PKG, lock(v => { v.packages["node_modules/is-odd"].resolved = "git+ssh://git@github.com/x/y.git"; })],
    "integrity-missing-or-weak": [PKG, lock(v => { v.packages["node_modules/is-odd"].integrity = "sha1-deadbeef"; })],
    "lockfile-entry-invalid": [PKG, lock(v => { v.packages["../../etc/passwd"] = { version: "1.0.0" }; })],
    "non-registry-dependency": [pkg(v => { v.dependencies = { x: "github:user/repo" }; }), LOCK],
    "install-scripts-unacknowledged": [PKG, lock(v => { v.packages["node_modules/is-odd"].hasInstallScript = true; })],
    "package-json-invalid-json": [Buffer.from("{"), LOCK],
    "lockfile-invalid-json": [PKG, Buffer.from('{"a":1,"a":2}')],
  };
  for (const [expected, [p, l]] of Object.entries(cases)) assert.throws(() => validateNpmManifests(p, l), policy(expected), expected);
  for (const resolved of ["http://registry.npmjs.org/is-odd/-/is-odd-3.0.1.tgz", "https://evil.example/is-odd-3.0.1.tgz",
    "https://registry.npmjs.org/is-odd/-/is-odd-3.0.1.tgz?x=1", "https://registry.npmjs.org/is-odd/../../x.tgz",
    "https://user:pw@registry.npmjs.org/is-odd/-/is-odd-3.0.1.tgz", "file:../x.tgz"])
    assert.throws(() => validateNpmManifests(PKG, lock(v => { v.packages["node_modules/is-odd"].resolved = resolved; })),
      policy("non-registry-resolved"), resolved);
  for (const spec of ["file:../x", "link:../x", "git+https://github.com/a/b", "https://x/y.tgz", "user/repo", "workspace:*"])
    assert.throws(() => validateNpmManifests(pkg(v => { v.dependencies = { x: spec }; }), LOCK), policy("non-registry-dependency"), spec);
});

test("O5.5B6 deps: install scripts never run; an explicit acknowledgement only records running WITHOUT them", () => {
  const scripted = lock(v => { v.packages["node_modules/is-odd"].hasInstallScript = true; });
  let refusal: unknown;
  try { validateNpmManifests(PKG, scripted); } catch (error) { refusal = error; }
  assert.deepEqual((refusal as DependencyPolicyError).detail, ["is-odd"]);
  const report = validateNpmManifests(pkg(v => { v.scripts = { postinstall: "node evil.js", prepare: "husky" }; }), scripted, ["is-odd"]);
  assert.deepEqual(report.installScriptPackages, ["is-odd"]);
  assert.deepEqual(report.skippedRootScripts, ["postinstall", "prepare"]);
  assert.notEqual(dependencyIdentityKey(dependencyIdentity(report, RUNTIME, ["is-odd"])),
    dependencyIdentityKey(dependencyIdentity(report, RUNTIME)), "acknowledgement is part of the identity");
});

test("O5.5B6 deps: only the host-approved manifests are accepted; a shrinkwrap is unsupported", async () => {
  await withProject(async (_root, project) => {
    const manifests = await readNpmManifests(project);
    assert.doesNotThrow(() => assertApprovedManifests(manifests, APPROVED as Extract<DependencyRequirement, { kind: "npm-lockfile" }>));
    const other = { kind: "npm-lockfile" as const, approved: { packageJsonSha256: sha(PKG), lockfileSha256: "0".repeat(64) } };
    assert.throws(() => assertApprovedManifests(manifests, other), policy("manifests-not-approved"));
    assert.throws(() => assertApprovedManifests(manifests, { kind: "npm-lockfile", approved: { packageJsonSha256: "x", lockfileSha256: "y" } }),
      policy("approved-identity-invalid"));
    await writeFile(join(project, "npm-shrinkwrap.json"), "{}");
    await assert.rejects(readNpmManifests(project), policy("shrinkwrap-unsupported"));
  });
});

// ---------------------------------------------------------------- stage 1 + stage 2 through the fake engine

test("O5.5B6 deps: preparation is a separate networked stage that receives ONLY the two manifests; verification stays network-less", async () => {
  await withProject(async (root, project) => {
    const fake = new FakeDocker();
    const backend = backendWith(fake, root);
    const prepared = await backend.prepareDependencies({ workspaceRoot: project, dependencies: APPROVED });
    assert.equal(prepared.cacheHit, false);
    assert.equal(prepared.preparation?.network, "bridge");
    assert.equal(prepared.record.observed.lifecycleScriptsExecuted, false);
    const depsCreate = fake.commands("create")[0]!;
    assert.deepEqual(depsCreate.slice(depsCreate.indexOf("--network"), depsCreate.indexOf("--network") + 2), ["--network", "bridge"]);
    assert.ok(depsCreate.includes("fusion.mode=deps"));
    assert.equal(depsCreate[depsCreate.indexOf(GUEST_BOOTSTRAP) + 2], "deps");
    // The dependency container's stdin carried the two manifests and nothing from the repository.
    const depsInput = fake.inputs[0]!;
    assert.equal(depsInput.includes(Buffer.from("SOURCE-ONLY-MARKER")), false);
    assert.ok(depsInput.includes(PKG) && depsInput.includes(LOCK));
    assert.equal((await backend.prepareDependencies({ workspaceRoot: project, dependencies: APPROVED })).cacheHit, true);
    assert.equal(fake.commands("create").length, 1, "a cache hit starts no container");

    let seen: ReadonlyMap<string, Buffer> | null = null;
    fake.configure({ attach: context => { seen = context.dependencyFiles; return { stdout: passingResult(context.manifest) }; } });
    const result = await executeVerification(backend, request(project)) as DockerVerificationExecutionResult;
    assert.equal(result.passed, true, JSON.stringify(result.report.failure));
    const verifyCreate = fake.commands("create").at(-1)!;
    assert.deepEqual(verifyCreate.slice(verifyCreate.indexOf("--network"), verifyCreate.indexOf("--network") + 2), ["--network", "none"]);
    assert.equal(verifyCreate.some(arg => arg.startsWith("--mount") || arg === "-v"), false);
    assert.deepEqual([...seen!.keys()].sort(), ["is-number/index.js", "is-number/package.json"], "the verified copy is the artifact");
    assert.equal(result.docker.dependencies?.key, prepared.key);
    assert.ok(result.docker.limits.workTmpfsMiB > DEFAULT_DOCKER_LIMITS.workTmpfsMiB, "tmpfs sized for the extracted tree");
  });
});
test("O5.5B6 deps: verification never prepares on its own; a missing artifact or unapproved manifest fails closed", async () => {
  await withProject(async (root, project) => {
    const fake = new FakeDocker();
    const backend = backendWith(fake, root);
    await assert.rejects(executeVerification(backend, request(project)), kind("CapabilityUnavailable"));
    assert.equal(fake.commands("create").length, 0, "no network stage ran implicitly");
    const unapproved: DependencyRequirement = { kind: "npm-lockfile", approved: { packageJsonSha256: sha(PKG), lockfileSha256: "1".repeat(64) } };
    await assert.rejects(backend.prepareDependencies({ workspaceRoot: project, dependencies: unapproved }), kind("SecurityViolation"));
    await assert.rejects(executeVerification(backend, request(project, { dependencies: unapproved })), kind("SecurityViolation"));
    // A Writer-changed lockfile cannot self-approve: the candidate no longer matches the approved identity.
    await backend.prepareDependencies({ workspaceRoot: project, dependencies: APPROVED });
    writeFileSync(join(project, "package-lock.json"), lock(v => { v.packages["node_modules/is-number"].version = "7.0.1"; }));
    await assert.rejects(executeVerification(backend, request(project)), kind("SecurityViolation"));
  });
});

test("O5.5B6 deps: a primary/candidate node_modules is never trusted or shipped", async () => {
  await withProject(async (root, project) => {
    await mkdir(join(project, "node_modules", "is-odd"), { recursive: true });
    await writeFile(join(project, "node_modules", "is-odd", "index.js"), "module.exports = () => true; // POISON");
    const fake = new FakeDocker();
    const backend = backendWith(fake, root);
    const prepared = await backend.prepareDependencies({ workspaceRoot: project, dependencies: APPROVED });
    assert.equal(fake.inputs[0]!.includes(Buffer.from("POISON")), false, "preparation never reads the checkout's node_modules");
    assert.equal(prepared.cacheHit, false);
    await assert.rejects(executeVerification(backend, request(project)), kind("SecurityViolation"));
    assert.equal(fake.inputs.some(input => input.includes(Buffer.from("POISON"))), false, "nothing of it reached any container");
  });
});

test("O5.5B6 deps: a malformed, contradictory or failed preparation is refused and nothing is cached", async () => {
  const bad: Record<string, NonNullable<FakeDockerOptions["depsReply"]>> = {
    badBase64: () => ({ lines: ["D !!!notbase64!!!"], exitCode: 0 }),
    outputAfterResult: () => ({ lines: ["R {}", "D AAAA"], exitCode: 0 }),
    unexpectedLine: () => ({ lines: ["npm WARN something"], exitCode: 0 }),
    npmFailed: ({ manifest }) => ({ lines: [`R ${JSON.stringify({ protocolVersion: 2, mode: "deps", nonce: manifest.nonce,
      inputSha256: manifest.input.sha256, runtime: { node: "v22.20.0", platform: "linux", arch: "x64" },
      npm: { version: "10.9.3", exitCode: 1, signal: null, durationMs: 1, timedOut: false, stdoutTail: "", stderrTail: "E404" },
      artifact: null, complete: true })}`], exitCode: 1 }),
    digestLie: ({ manifest }) => ({ lines: ["D AAAA", `R ${JSON.stringify({ protocolVersion: 2, mode: "deps", nonce: manifest.nonce,
      inputSha256: manifest.input.sha256, runtime: { node: "v22.20.0", platform: "linux", arch: "x64" },
      npm: { version: "10.9.3", exitCode: 0, signal: null, durationMs: 1, timedOut: false, stdoutTail: "", stderrTail: "" },
      artifact: { sha256: "0".repeat(64), compressedBytes: 3, entries: 0, files: 0, directories: 0, bytes: 0, symlinksRefused: 0 },
      complete: true })}`], exitCode: 0 }),
    wrongNonce: ({ manifest }) => ({ lines: [`R ${JSON.stringify({ protocolVersion: 2, mode: "deps", nonce: "0".repeat(32),
      inputSha256: manifest.input.sha256, runtime: { node: "v22.20.0", platform: "linux", arch: "x64" },
      npm: { version: "10.9.3", exitCode: 1, signal: null, durationMs: 1, timedOut: false, stdoutTail: "", stderrTail: "" },
      artifact: null, complete: true })}`], exitCode: 1 }),
  };
  for (const [name, depsReply] of Object.entries(bad)) {
    await withProject(async (root, project) => {
      const fake = new FakeDocker({ depsReply });
      const backend = backendWith(fake, root);
      await assert.rejects(backend.prepareDependencies({ workspaceRoot: project, dependencies: APPROVED }),
        (error: unknown) => error instanceof FusionFailure, name);
      assert.deepEqual(readdirSync(join(root, "store")).filter(entry => entry !== ".fusion-dependency-store"), [], `${name}: nothing cached`);
      assert.equal([...fake.containers.values()].every(container => container.removed), true, `${name}: container removed`);
    });
  }
});

test("O5.5B6 deps: a tampered cache entry is evicted and refused (artifact bytes, record identity, renamed entry)", async () => {
  await withProject(async (root, project) => {
    const fake = new FakeDocker();
    const backend = backendWith(fake, root);
    const prepared = await backend.prepareDependencies({ workspaceRoot: project, dependencies: APPROVED });
    const store = new DependencyArtifactStore(join(root, "store"));
    const entry = join(root, "store", prepared.key);
    // 1. Artifact bytes changed after commit.
    const artifact = join(entry, "artifact.fta.gz");
    const original = readFileSync(artifact);
    writeFileSync(artifact, Buffer.concat([original.subarray(0, original.length - 1), Buffer.from([original.at(-1)! ^ 1])]));
    const tampered = await store.lookup(prepared.identity);
    assert.deepEqual([tampered.state, (tampered as { reason?: string }).reason, (tampered as { evicted?: boolean }).evicted],
      ["invalid", "artifact-digest-mismatch", true]);
    await assert.rejects(executeVerification(backend, request(project)), kind("CapabilityUnavailable"), "evicted → missing, never used");
    // 2. Record rewritten to claim another identity.
    const again = await backend.prepareDependencies({ workspaceRoot: project, dependencies: APPROVED });
    const recordPath = join(root, "store", again.key, "record.json");
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    record.identity.lockfileSha256 = "0".repeat(64);
    writeFileSync(recordPath, JSON.stringify(record));
    assert.equal((await store.lookup(again.identity)).state, "invalid");
    // 3. A valid entry moved under another key is not accepted for that key.
    const third = await backend.prepareDependencies({ workspaceRoot: project, dependencies: APPROVED });
    const otherIdentity = dependencyIdentity({ packageJsonSha256: sha(PKG), lockfileSha256: "2".repeat(64) }, third.identity.runtime);
    const { renameSync } = await import("node:fs");
    renameSync(join(root, "store", third.key), join(root, "store", dependencyIdentityKey(otherIdentity)));
    assert.equal((await store.lookup(otherIdentity)).state, "invalid");
  });
});

test("O5.5B6 deps: committed artifacts are structurally validated (traversal inside a prepared tree is refused)", async () => {
  const root = await mkdtemp(join(tmpdir(), "fusion-o55b6-art-"));
  try {
    const good = join(root, "good.gz");
    writeFileSync(good, await gzipTree({ "a/index.js": Buffer.from("x") }));
    assert.deepEqual(await validateArtifactStructure(good), { entries: 2, files: 1, directories: 1, bytes: 1 });
    const evil = join(root, "evil.gz");
    const header = Buffer.from("FTA1F");
    const path = Buffer.from("../../evil.js");
    const length = Buffer.alloc(2); length.writeUInt16BE(path.length, 0);
    const size = Buffer.alloc(4); size.writeUInt32BE(1, 0);
    const end = Buffer.from([0x45, 0, 0, 0, 1]);
    const { gzipSync } = await import("node:zlib");
    writeFileSync(evil, gzipSync(Buffer.concat([header, length, path, Buffer.from([0]), size, Buffer.from("x"), end])));
    await assert.rejects(validateArtifactStructure(evil));
    assert.equal((await readArchive(await (async () => { const { gunzipSync } = await import("node:zlib");
      return gunzipSync(readFileSync(good)); })(), { maxEntries: 10, maxFileBytes: 10, maxTotalBytes: 10 })).size, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("O5.5B6 deps: a backend without the lane (trusted host) refuses dependency requests instead of ignoring them", async () => {
  await assert.rejects(executeVerification(new TrustedHostBackend(), { plan, workspaceRoot: "/x", git: {} as never, env: {},
    dependencies: APPROVED }), kind("CapabilityUnavailable"));
});

test("O5.5B6 deps: extracted dependency trees raise tmpfs and memory together, within fixed bounds", () => {
  assert.equal(limitsForDependencies(DEFAULT_DOCKER_LIMITS, 0), DEFAULT_DOCKER_LIMITS);
  const small = limitsForDependencies(DEFAULT_DOCKER_LIMITS, 100 * 1024 * 1024);
  assert.equal(small.workTmpfsMiB, 512 + 125);
  assert.equal(small.memoryBytes, DEFAULT_DOCKER_LIMITS.memoryBytes + 125 * 1024 * 1024);
  const huge = limitsForDependencies(DEFAULT_DOCKER_LIMITS, 20 * 1024 * 1024 * 1024);
  assert.equal(huge.workTmpfsMiB, 4096);
  assert.ok(huge.memoryBytes <= 8 * 1024 * 1024 * 1024);
});

test("O5.5B6 deps: streamed artifact lines are bounded; an overlong line is reported once and never buffered", async () => {
  const { LineSplitter, OVERLONG_LINE } = await import("../src/platform/verification/docker/cli.js");
  const lines: string[] = [];
  const splitter = new LineSplitter(line => lines.push(line), 8);
  splitter.push("D abc\nD de");
  splitter.push("f\nR ");
  splitter.push("x".repeat(20));
  splitter.push("yyy\nD ok\n");
  splitter.push("tail");
  splitter.finish();
  assert.deepEqual(lines, ["D abc", "D def", OVERLONG_LINE, "D ok", "tail"]);
  // The preparation stage treats that marker like any unexpected line: nothing is cached.
  await withProject(async (root, project) => {
    const fake = new FakeDocker({ depsReply: () => ({ lines: [OVERLONG_LINE], exitCode: 0 }) });
    await assert.rejects(backendWith(fake, root).prepareDependencies({ workspaceRoot: project, dependencies: APPROVED }),
      kind("MalformedOutput"));
  });
});
