import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writerReadiness } from "../src/app/writer-gate.js";
import { FusionFailure } from "../src/core/errors.js";
import type { VerificationPlan } from "../src/core/domain.js";
import { assertPlatformEligible, backendReadiness, executeVerification, VERIFICATION_ISOLATION_ACCEPTED,
  type VerificationExecutionRequest } from "../src/platform/verification/backend.js";
import { backendEvidence, checkFact, evaluateBackendEvidence, observedFact,
  unobservedFact } from "../src/platform/verification/backend-evidence.js";
import { platformEligibility } from "../src/platform/verification/platform-compat.js";
import { buildContainerVerifierEnvironment, CONTAINER_VERIFIER_ENV } from "../src/platform/verification/verifier-environment.js";
import { DockerLinuxVerificationBackend, DOCKER_REQUIRED_EVIDENCE_FACTS, guestFacts,
  validateDockerPlan } from "../src/platform/verification/docker/backend.js";
import { candidateSourcePart, createRunDirectories, removeRunDirectories } from "../src/platform/verification/docker/bundle.js";
import { CliDockerRunner, parseContainerInspect, parseDockerVersion } from "../src/platform/verification/docker/cli.js";
import { assertPinnedImage, assertSafeDockerArgs, buildCreateArgs, buildDockerClientEnvironment, DEFAULT_DOCKER_LIMITS,
  GUEST_BOOTSTRAP, isFusionOwned, ownershipLabels, resolveLimits, selectScavengeableContainers } from "../src/platform/verification/docker/config.js";
import { decodeCanaryResult, decodeVerifyResult, DOCKER_RESULT_LIMITS, parseTestCounts, type GuestCommand,
  type VerifyManifest } from "../src/platform/verification/docker/protocol.js";
import { FAKE_DOCKER_EXE, FAKE_IMAGE, FakeDocker, passingResult, type FakeDockerOptions } from "./fixtures/fake-docker.js";

const kind = (name: string) => (error: unknown): boolean => error instanceof FusionFailure && error.error.kind === name;
const NODE = "/usr/local/bin/node";
const RUN = "0123456789abcdef0123456789abcdef";
const NONCE = "fedcba9876543210fedcba9876543210";
const CREATED = "2026-09-24T12:00:00.000Z";
const SECRET = "fusion-canary-synthetic-secret-value";
const HOST_ENV = { PATH: "C:\\Windows", USERPROFILE: "C:\\Users\\someone", TEMP: "C:\\Temp", ANTHROPIC_API_KEY: SECRET,
  OPENAI_API_KEY: SECRET, CLAUDE_CODE_OAUTH_TOKEN: SECRET, MUSE_TOKEN: SECRET, SSH_AUTH_SOCK: SECRET, GITHUB_TOKEN: SECRET,
  GIT_ASKPASS: SECRET, GIT_CONFIG_GLOBAL: SECRET, DOCKER_HOST: "tcp://remote:2375", NODE_OPTIONS: "--require evil" };

const plan = (...commands: Partial<VerificationPlan["commands"][number]>[]): VerificationPlan => ({
  commands: (commands.length ? commands : [{}]).map((command, index) => ({ id: `step${index}`, executable: NODE, args: ["--test"],
    cwd: ".", timeoutMs: 5_000, mutationPolicy: "readOnly" as const, ...command })) });

async function withCandidate(work: (root: string, candidate: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "fusion-o55b5-"));
  try {
    const candidate = join(root, "candidate");
    await mkdir(join(candidate, "test"), { recursive: true });
    await writeFile(join(candidate, "package.json"), '{"name":"x","type":"module"}');
    await writeFile(join(candidate, "test", "a.test.mjs"), "export {};");
    await mkdir(join(root, "runs"));
    await work(root, candidate);
  } finally { await rm(root, { recursive: true, force: true }); }
}

function backendWith(fake: FakeDocker, root: string, extra: Partial<ConstructorParameters<typeof DockerLinuxVerificationBackend>[0]> = {}) {
  return new DockerLinuxVerificationBackend({ image: FAKE_IMAGE, runner: fake, resolveDocker: () => Promise.resolve(FAKE_DOCKER_EXE),
    baseDirectory: join(root, "runs"), ...extra });
}
const request = (candidate: string, overrides: Partial<VerificationExecutionRequest> = {}): VerificationExecutionRequest =>
  ({ plan: plan(), workspaceRoot: candidate, git: {} as never, env: {}, platformRequirement: "linux-compatible", ...overrides });

async function lifecycle(options: FakeDockerOptions, overrides: Partial<VerificationExecutionRequest> = {}) {
  let out: { fake: FakeDocker; result?: Awaited<ReturnType<typeof executeVerification>>; error?: unknown; runsLeft: string[] } | undefined;
  await withCandidate(async (root, candidate) => {
    const fake = new FakeDocker(options);
    const backend = backendWith(fake, root);
    let result, error;
    try { result = await executeVerification(backend, request(candidate, overrides)); } catch (caught) { error = caught; }
    out = { fake, ...(result ? { result } : {}), ...(error ? { error } : {}), runsLeft: await readdir(join(root, "runs")) };
  });
  return out!;
}

// ---------------------------------------------------------------- probe

test("O5.5B5 probe: Docker CLI missing is unavailable, never an error", async () => {
  const backend = new DockerLinuxVerificationBackend({ image: FAKE_IMAGE, resolveDocker: () => Promise.resolve(null) });
  assert.deepEqual(await backend.probe(), { backendId: "docker-linux", available: false, confinement: "osSandbox",
    reason: "docker-cli-missing" });
});

test("O5.5B5 probe: daemon unavailable, non-Linux engine, and malformed/duplicate-key responses fail closed", async () => {
  await withCandidate(async root => {
    const reasons: Record<string, string> = { noServer: "docker-daemon-unavailable", exitFailure: "docker-daemon-unavailable",
      windows: "docker-engine-not-linux", malformed: "docker-version-malformed", duplicateKey: "docker-version-malformed" };
    for (const [version, reason] of Object.entries(reasons)) {
      const probe = await backendWith(new FakeDocker({ version: version as never }), root).probe();
      assert.equal(probe.available, false, version);
      assert.equal(probe.reason, reason, version);
    }
    assert.equal(parseDockerVersion('{"Client":{},"Server":{"Os":"linux","Arch":"amd64","Version":"1","Os":"x"}}').kind, "malformed");
  });
});

test("O5.5B5 probe: an absent or mismatched image is unavailable and the backend never pulls", async () => {
  await withCandidate(async root => {
    for (const [image, reason] of [["absent", "docker-image-not-present"], ["wrongOs", "docker-image-platform-mismatch"],
      ["wrongArch", "docker-image-platform-mismatch"], ["wrongDigest", "docker-image-digest-mismatch"]] as const) {
      const fake = new FakeDocker({ image });
      assert.equal((await backendWith(fake, root).probe()).reason, reason);
      assert.equal(fake.calls.some(args => args.includes("pull")), false);
    }
    const idMismatch = backendWith(new FakeDocker(), root, { expectedImageId: `sha256:${"ef".repeat(32)}` });
    assert.equal((await idMismatch.probe()).reason, "docker-image-digest-mismatch");
    assert.equal((await backendWith(new FakeDocker(), root).probe()).available, true);
  });
});

test("O5.5B5 image policy: only digest-pinned references are accepted; floating tags are refused", () => {
  for (const bad of ["node", "node:latest", "node:22.20.0-bookworm-slim", "node:22@sha256:" + "a".repeat(64),
    "node@sha256:short", "Node@sha256:" + "a".repeat(64), "node@sha256:" + "a".repeat(64) + " --privileged"])
    assert.throws(() => assertPinnedImage(bad), kind("InvalidInput"), bad);
  assert.equal(assertPinnedImage(FAKE_IMAGE), FAKE_IMAGE);
  assert.throws(() => new DockerLinuxVerificationBackend({ image: "node:latest" }), kind("InvalidInput"));
});

// ---------------------------------------------------------------- command construction

const BUNDLE_SHA = "b".repeat(64), MANIFEST_SHA = "c".repeat(64);
const spec = (overrides: Record<string, unknown> = {}) => ({ runId: RUN, mode: "verify" as const, image: FAKE_IMAGE,
  limits: DEFAULT_DOCKER_LIMITS, env: CONTAINER_VERIFIER_ENV, createdAt: CREATED, bundleSha256: BUNDLE_SHA,
  manifestSha256: MANIFEST_SHA, ...overrides });
const pairs = (args: readonly string[], flag: string): string[] => args.flatMap((arg, index) => arg === flag ? [args[index + 1]!] : []);

test("O5.5B5 create argv carries every hardening control and nothing that weakens the container", () => {
  const args = buildCreateArgs(spec());
  assert.equal(args[0], "create");
  assert.deepEqual(pairs(args, "--pull"), ["never"]);
  assert.deepEqual(pairs(args, "--network"), ["none"]);
  assert.deepEqual(pairs(args, "--cap-drop"), ["ALL"]);
  assert.deepEqual(pairs(args, "--security-opt"), ["no-new-privileges=true"]);
  assert.ok(args.includes("--read-only") && args.includes("--init"));
  assert.deepEqual(pairs(args, "--user"), ["1000:1000"]);
  assert.deepEqual(pairs(args, "--memory"), [String(DEFAULT_DOCKER_LIMITS.memoryBytes)]);
  assert.deepEqual(pairs(args, "--memory-swap"), [String(DEFAULT_DOCKER_LIMITS.memoryBytes)]);
  assert.deepEqual(pairs(args, "--cpus"), ["2"]);
  assert.deepEqual(pairs(args, "--pids-limit"), ["256"]);
  assert.deepEqual(pairs(args, "--ipc"), ["private"]);
  assert.deepEqual(pairs(args, "--cgroupns"), ["private"]);
  assert.deepEqual(pairs(args, "--log-driver"), ["none"]);
  assert.deepEqual(pairs(args, "--entrypoint"), [NODE]);
  assert.ok(args.includes("--interactive"), "stdin is the only input channel");
  for (const mountFlag of ["--mount", "-v", "--volume", "--volumes-from"]) assert.equal(args.includes(mountFlag), false, mountFlag);
  assert.deepEqual(pairs(args, "--tmpfs").map(entry => entry.split(":")[0]), ["/fusion/work", "/tmp"]);
  assert.ok(pairs(args, "--tmpfs").every(entry => entry.includes("nosuid") && entry.includes("nodev") && /size=\d+m/u.test(entry)));
  assert.deepEqual(pairs(args, "--label").sort(), Object.entries(ownershipLabels(RUN, CREATED, "verify")).map(([k, v]) => `${k}=${v}`).sort());
  assert.deepEqual(args.slice(-6), [FAKE_IMAGE, "-e", GUEST_BOOTSTRAP, BUNDLE_SHA, "verify", MANIFEST_SHA]);
  for (const forbidden of ["--privileged", "--cap-add", "-v", "--volume", "--device", "--pid", "--userns", "--uts", "--publish",
    "--env-file", "--volumes-from", "--gpus"]) assert.equal(args.includes(forbidden), false, forbidden);
  assert.equal(args.some(arg => /docker\.sock|host/u.test(arg) && !arg.startsWith("--hostname") && arg !== "fusion-verifier"), false);
  assert.equal(args.some(arg => /type=bind|type=volume|:\/fusion/u.test(arg) && !arg.startsWith("/fusion")), false, "zero host mounts");
  assert.doesNotThrow(() => assertSafeDockerArgs(args));
});

test("O5.5B5 container env is fixed: zero provider credentials and no host value is forwarded", () => {
  const args = buildCreateArgs(spec());
  const env = pairs(args, "--env");
  assert.deepEqual(env.map(entry => entry.split("=")[0]).sort(), Object.keys(CONTAINER_VERIFIER_ENV).sort());
  assert.equal(env.every(entry => !entry.includes("C:\\") && !entry.includes(SECRET)), true);
  assert.deepEqual(buildContainerVerifierEnvironment().summary.forwarded, []);
  assert.throws(() => buildCreateArgs(spec({ env: { ...CONTAINER_VERIFIER_ENV, ANTHROPIC_API_KEY: "x" } })), kind("SecurityViolation"));
  assert.throws(() => buildCreateArgs(spec({ env: { GITHUB_TOKEN: "x" } })), kind("SecurityViolation"));
  assert.throws(() => buildCreateArgs(spec({ env: { PATH: "a\nb" } })), kind("InvalidInput"));
});

test("O5.5B5 docker client env is an allowlist: no credential, provider, SSH, or remote-daemon variable", () => {
  const env = buildDockerClientEnvironment(HOST_ENV);
  assert.deepEqual(Object.keys(env).sort(), ["DOCKER_CLI_HINTS", "PATH", "TEMP", "USERPROFILE"]);
  assert.equal(Object.values(env).includes(SECRET), false);
});

test("O5.5B5 bootstrap hashes, run ids, limits and modes are validated host values", () => {
  for (const hash of ["", "x", "B".repeat(64), "b".repeat(63), `${"b".repeat(64)} --privileged`])
    assert.throws(() => buildCreateArgs(spec({ bundleSha256: hash })), kind("InvalidInput"), hash);
  assert.throws(() => buildCreateArgs(spec({ runId: "../x" })), kind("InvalidInput"));
  assert.throws(() => buildCreateArgs(spec({ mode: "shell" })), kind("InvalidInput"));
  assert.throws(() => resolveLimits({ pids: 0 }), kind("InvalidInput"));
  assert.throws(() => resolveLimits({ memoryBytes: 64 * 1024 ** 4 }), kind("InvalidInput"));
  assert.throws(() => resolveLimits({ nanoCpus: 1.5 }), kind("InvalidInput"));
});

test("O5.5B5 the docker argv guard refuses weakening flags and destructive subcommands", () => {
  const refused = [["run", "--privileged", FAKE_IMAGE], ["create", "--network", "host"], ["create", "--network=bridge"],
    ["create", "-v", "C:\\:/host"], ["create", "--mount", "type=bind,source=/var/run/docker.sock,target=/s"],
    ["create", "--cap-add", "SYS_ADMIN"], ["create", "--security-opt", "seccomp=unconfined"], ["create", "--pid", "host"],
    ["create", "--ipc", "host"], ["create", "-e", "ANTHROPIC_API_KEY"], ["create", "--env", "GITHUB_TOKEN"],
    ["create", "--mount", "type=bind,source=C:\\repo,target=/fusion/input"], ["system", "prune", "-f"], ["volume", "prune"],
    ["image", "rm", FAKE_IMAGE], ["pull", "node:latest"], ["container", "prune"], ["exec", "x", "sh"], []];
  for (const args of refused) assert.throws(() => assertSafeDockerArgs(args), kind("SecurityViolation"), args.join(" "));
});

test("O5.5B5 the CLI runner refuses an unsafe argv before spawning anything (argv only, never a shell string)", async () => {
  let spawned = 0;
  const supervisor = { start: () => { spawned++; throw new Error("must not spawn"); } };
  const runner = new CliDockerRunner(FAKE_DOCKER_EXE, HOST_ENV, supervisor as never);
  await assert.rejects(runner.run({ args: ["run", "--privileged", "x"], timeoutMs: 1_000 }), kind("SecurityViolation"));
  await assert.rejects(runner.run({ args: ["system prune -af"], timeoutMs: 1_000 }), kind("SecurityViolation"));
  assert.equal(spawned, 0);
});

// ---------------------------------------------------------------- plan / platform

test("O5.5B5 plans may name only allowlisted in-image executables with bounded argv and a relative cwd", () => {
  assert.equal(validateDockerPlan(plan({ cwd: "sub\\dir" }), [NODE])[0]!.cwd, "sub/dir");
  for (const bad of [{ executable: "/bin/sh" }, { executable: "/usr/bin/bash" }, { executable: "node" },
    { executable: "C:\\node.exe" }, { cwd: "../x" }, { cwd: "/abs" }, { cwd: "C:\\abs" }, { args: ["a\0b"] },
    { timeoutMs: 0 }, { timeoutMs: 31 * 60_000 }, { id: "bad id" }, { mutationPolicy: "whatever" as never }])
    assert.throws(() => validateDockerPlan(plan(bad), [NODE]), kind("InvalidInput"), JSON.stringify(bad));
  assert.throws(() => validateDockerPlan(plan(...Array.from({ length: 9 }, () => ({}))), [NODE]), kind("InvalidInput"));
  assert.throws(() => new DockerLinuxVerificationBackend({ image: FAKE_IMAGE, allowedExecutables: ["/bin/bash"] }), kind("InvalidInput"));
});

test("O5.5B5 platform: Linux semantics accept linux-compatible/platform-neutral; windows-required and unknown fail closed", async () => {
  assert.equal(platformEligibility("linux", "linux-compatible").eligible, true);
  assert.equal(platformEligibility("linux", "platform-neutral").eligible, true);
  for (const requirement of ["windows-required", "unknown", undefined, "LINUX", 7])
    assert.equal(platformEligibility("linux", requirement).eligible, false, String(requirement));
  assert.equal(platformEligibility("windows", "linux-compatible").eligible, false);
  const linux = { id: "docker-linux", platformSemantics: "linux" as const };
  assert.throws(() => assertPlatformEligible(linux, {}), kind("CapabilityUnavailable"));
  assert.doesNotThrow(() => assertPlatformEligible({ id: "trusted-host" }, {}), "backends without semantics are unaffected");
  for (const platformRequirement of ["windows-required", "unknown", undefined] as const) {
    const { fake, error } = await lifecycle({}, { platformRequirement } as never);
    assert.equal(kind("CapabilityUnavailable")(error), true, String(platformRequirement));
    assert.equal(fake.calls.length, 0, "refused before touching Docker");
  }
});

// ---------------------------------------------------------------- lifecycle

test("O5.5B5 a passing run reports Fusion-owned results, removes its container, and cleans its run directory", async () => {
  const { fake, result, error, runsLeft } = await lifecycle({});
  assert.equal(error, undefined);
  assert.equal(result!.passed, true);
  assert.equal(result!.report.steps[0]!.status, "passed");
  assert.equal(result!.report.steps[0]!.mutationProven, true);
  assert.equal(fake.commands("create").length, 1);
  assert.ok(fake.commands("create")[0]!.includes("--pull"));
  assert.deepEqual([...fake.containers.values()].map(container => container.removed), [true]);
  assert.deepEqual(runsLeft, []);
  const docker = (result as { docker?: { resultAccepted: boolean } }).docker;
  assert.equal(docker?.resultAccepted, true);
});

test("O5.5B5 the input bundle excludes .git, and the bundle carries no credential in its manifest", async () => {
  await withCandidate(async (root, candidate) => {
    await mkdir(join(candidate, ".git"));
    await writeFile(join(candidate, ".git", "config"), "[credential]\nhelper = store");
    let manifestText = "", srcEntries: string[] = [];
    const fake = new FakeDocker({ attach: context => {
      manifestText = JSON.stringify(context.manifest);
      srcEntries = [...context.files.keys()];
      return { stdout: passingResult(context.manifest) };
    } });
    const backend = backendWith(fake, root, { clientEnvironment: HOST_ENV });
    assert.equal((await executeVerification(backend, request(candidate))).passed, true);
    assert.equal(srcEntries.some(entry => entry.startsWith(".git")), false);
    assert.ok(srcEntries.includes("package.json"));
    assert.equal(manifestText.includes(SECRET), false);
    assert.equal(/ANTHROPIC|OPENAI|GITHUB_TOKEN|SSH_AUTH_SOCK|GIT_ASKPASS/u.test(manifestText), false);
    assert.equal(fake.calls.flat().some(arg => arg.includes(SECRET)), false, "no host secret reaches any docker argv");
    assert.equal(fake.inputs.some(input => input.includes(Buffer.from(SECRET))), false, "no host secret reaches the stdin stream");
  });
});

test("O5.5B5 a symbolic link or junction in the candidate fails closed and is never followed", async (t) => {
  await withCandidate(async (root, candidate) => {
    try { await symlink(join(root, "runs"), join(candidate, "link"), "junction"); }
    catch { t.skip("symlink/junction creation is not permitted here"); return; }
    await assert.rejects(candidateSourcePart(candidate), kind("SecurityViolation"));
    const { fake, error, runsLeft } = await (async () => {
      const fake = new FakeDocker();
      const backend = backendWith(fake, root);
      let error: unknown;
      try { await executeVerification(backend, request(candidate)); } catch (caught) { error = caught; }
      return { fake, error, runsLeft: await readdir(join(root, "runs")) };
    })();
    assert.equal(kind("SecurityViolation")(error), true);
    assert.equal(fake.commands("create").length, 0);
    assert.deepEqual(runsLeft, [], "a failed prepare removes its run directory");
  });
});

test("O5.5B5 a failing command maps to a failed report with the observed exit code", async () => {
  const { result } = await lifecycle({ attach: ({ manifest }) => ({ containerExitCode: 1, stdout: passingResult(manifest, {
    commands: [{ id: "step0", status: "exited", exitCode: 1, signal: null, durationMs: 0, stdoutTail: "# fail 1\n",
      stderrTail: "", stdoutBytes: 9, stderrBytes: 0 }] }) }) });
  assert.equal(result!.passed, false);
  assert.equal(result!.report.steps[0]!.status, "failed");
  assert.equal(result!.report.steps[0]!.exitCode, 1);
  assert.equal(result!.report.failure?.kind, "VerificationFailure");
});

test("O5.5B5 untrusted results fail closed: missing, malformed, duplicate keys, wrong nonce, oversized, contradictory", async () => {
  const cases: Record<string, NonNullable<FakeDockerOptions["attach"]>> = {
    missing: () => ({ stdout: "" }),
    malformed: () => ({ stdout: "{\"protocolVersion\":1," }),
    duplicateKeys: ({ manifest }) => ({ stdout: passingResult(manifest).replace('"complete":true', '"complete":true,"complete":true') }),
    wrongNonce: ({ manifest }) => ({ stdout: passingResult(manifest, { nonce: "0".repeat(32) }) }),
    unknownField: ({ manifest }) => ({ stdout: passingResult(manifest, { env: { HOME: "/x" } }) }),
    oversized: ({ manifest }) => ({ stdout: passingResult(manifest).padEnd(DOCKER_RESULT_LIMITS.maxResultBytes + 10, " ") }),
    outputLimit: () => ({ status: "outputLimit" }),
    exitContradiction: ({ manifest }) => ({ stdout: passingResult(manifest), containerExitCode: 137 }),
    wrongCommand: ({ manifest }) => ({ stdout: passingResult(manifest).replace('"id":"step0"', '"id":"other"') }),
    wrongInputDigest: ({ manifest }) => ({ stdout: passingResult(manifest).replace(manifest.input.source.sha256, "e".repeat(64)) }),
    wrongRuntime: ({ manifest }) => ({ stdout: passingResult(manifest, { runtime: { node: "v22", platform: "linux", arch: "x64" } }) }),
  };
  for (const [name, attach] of Object.entries(cases)) {
    const { result, error, fake } = await lifecycle({ attach });
    assert.equal(error, undefined, name);
    assert.equal(result!.passed, false, name);
    assert.equal(result!.report.failure?.kind, "MalformedOutput", name);
    assert.deepEqual(result!.report.notRun, ["step0"], name);
    assert.equal([...fake.containers.values()].every(container => container.removed), true, name);
  }
});

test("O5.5B5 a guest runner failure surfaces only its stable code, never raw stderr", async () => {
  const { result } = await lifecycle({ attach: () => ({ stdout: "", containerExitCode: 2,
    stderr: `fusion-runner-error:bundle-too-large\n/secret/host/path ${SECRET}\n` }) });
  assert.equal(result!.passed, false);
  assert.match(result!.report.failure!.safeMessage, /\(bundle-too-large\)/u);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test("O5.5B5 a later failing probe cannot break an existing lease's run or cleanup", async () => {
  await withCandidate(async (root, candidate) => {
    const fake = new FakeDocker();
    const backend = backendWith(fake, root);
    assert.equal((await backend.probe()).available, true);
    const lease = await backend.prepare(request(candidate));
    fake.configure({ version: "noServer" });
    assert.equal((await backend.probe()).available, false);
    assert.equal((await backend.run(lease, request(candidate))).passed, true);
    assert.deepEqual(await backend.dispose(lease), { complete: true });
    assert.deepEqual(await readdir(join(root, "runs")), []);
  });
});

test("O5.5B5 a host deadline or wall-clock timeout stops and removes the container", async () => {
  const hostDeadline = await lifecycle({ attach: () => ({ status: "timeout" }) });
  assert.equal(hostDeadline.result!.report.failure?.kind, "Timeout");
  assert.equal(hostDeadline.fake.commands("kill").length, 1);
  assert.equal([...hostDeadline.fake.containers.values()].every(container => container.removed), true);

  const hang: NonNullable<FakeDockerOptions["attach"]> = ({ invocation }) => new Promise(resolve =>
    invocation.signal?.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true }));
  const wallClock = await lifecycle({ attach: hang }, { timeoutMs: 50 });
  assert.equal(kind("Timeout")(wallClock.error), true);
  assert.equal(wallClock.fake.commands("kill").length, 1, "the host stops the container explicitly");
  assert.equal([...wallClock.fake.containers.values()].every(container => container.removed), true);
  assert.deepEqual(wallClock.runsLeft, []);
});

test("O5.5B5/B6 a candidate that changes between digest and transfer is rejected, never verified", async () => {
  await withCandidate(async (root, candidate) => {
    const fake = new FakeDocker();
    const backend = backendWith(fake, root);
    const lease = await backend.prepare(request(candidate));
    writeFileSync(join(candidate, "package.json"), '{"name":"y","type":"module"}');
    const result = await backend.run(lease, request(candidate));
    assert.equal(result.passed, false);
    assert.match(result.report.failure!.safeMessage, /changed while it was streamed/u);
    assert.deepEqual(await backend.dispose(lease), { complete: true });
  });
});

test("O5.5B5 cleanup failure fails the operation closed even when verification passed", async () => {
  const { error } = await lifecycle({ rmFails: true });
  assert.equal(kind("SecurityViolation")(error), true);
});

test("O5.5B5 cleanup never removes a container without full Fusion ownership labels, whatever its name", async () => {
  const foreign = "f".repeat(64), nameOnly = "e".repeat(64);
  const { fake, error } = await lifecycle({ extraListed: [
    { id: foreign, labels: { "com.docker.compose.project": "editorial-os" }, alwaysListed: true },
    { id: nameOnly, labels: { "fusion.owner": "true", "fusion.backend": "docker-linux" }, alwaysListed: true },
  ] });
  assert.equal(fake.commands("rm").some(args => args.includes(foreign) || args.includes(nameOnly)), false);
  assert.equal(kind("SecurityViolation")(error), true, "an unexplained labelled container leaves cleanup incomplete");
  assert.equal(isFusionOwned({ "fusion.owner": "true", "fusion.backend": "docker-linux", "fusion.run": RUN }), false);
  assert.equal(isFusionOwned(ownershipLabels(RUN, CREATED), RUN), true);
  assert.equal(isFusionOwned(ownershipLabels(RUN, CREATED), NONCE), false, "another run's container is not this run's");
});

test("O5.5B5 the future scavenger selects only old, fully labelled Fusion containers", () => {
  const now = Date.parse(CREATED) + 3_600_000;
  const owned = { id: "a".repeat(64), labels: ownershipLabels(RUN, CREATED) };
  const young = { id: "b".repeat(64), labels: ownershipLabels(RUN, new Date(now - 1_000).toISOString()) };
  const foreign = { id: "c".repeat(64), labels: { "com.docker.compose.project": "x" } };
  const named = { id: "d".repeat(64), labels: { "fusion.owner": "true" } };
  const shortId = { id: "abc", labels: ownershipLabels(RUN, CREATED) };
  assert.deepEqual(selectScavengeableContainers([owned, young, foreign, named, shortId], now, 600_000), [owned.id]);
  assert.throws(() => selectScavengeableContainers([], now, 0), kind("InvalidInput"));
});

test("O5.5B5 run directories are removed only with the ownership marker, inside the base", async () => {
  await withCandidate(async root => {
    const base = join(root, "runs");
    const dirs = await createRunDirectories(RUN, base);
    assert.equal(await removeRunDirectories(dirs, NONCE, base), false, "wrong run id");
    assert.equal(await removeRunDirectories(dirs, RUN, join(root, "elsewhere")), false, "outside the base");
    assert.equal(existsSync(dirs.runRoot), true);
    assert.equal(await removeRunDirectories(dirs, RUN, base), true);
    assert.equal(existsSync(dirs.runRoot), false);
    const unmarked = join(base, "fusion-docker-unmarked");
    await mkdir(unmarked);
    assert.equal(await removeRunDirectories({ runRoot: unmarked }, RUN, base), false);
    assert.equal(existsSync(unmarked), true);
  });
});

// ---------------------------------------------------------------- evidence / readiness

test("O5.5B5 daemon facts reflect the real create argv; a weakened container fails its facts", async () => {
  await withCandidate(async (root, candidate) => {
    const run = async (patch?: FakeDockerOptions["patchInspect"]) => {
      const fake = new FakeDocker(patch ? { patchInspect: patch } : {});
      const backend = backendWith(fake, root);
      await backend.probe();
      const lease = await backend.prepare(request(candidate));
      await backend.run(lease, request(candidate));
      const evidence = await backend.collectEvidence(lease);
      assert.deepEqual(await backend.dispose(lease), { complete: true });
      return evidence;
    };
    const clean = evaluateBackendEvidence(await run(), DOCKER_REQUIRED_EVIDENCE_FACTS);
    for (const fact of ["privilegedDisabledObserved", "capDropAllObserved", "networkModeNoneObserved", "readOnlyRootfsObserved",
      "noHostMountsObserved", "noWritableHostMountObserved", "stdinInputChannelObserved", "resourceLimitsConfiguredObserved",
      "ownershipLabelsObserved", "containerEnvKeysAllowlistedObserved", "descendantRemovedWithContainerObserved",
      "hostDeadlineTerminationObserved", "ownedContainersRemovedObserved", "verifyInputDigestMatchedObserved"])
      assert.ok(clean.passed.includes(fact), fact);
    // The fake runs no guest, so guest facts are unobserved: fake evidence is partial and never complete.
    assert.equal(clean.complete, false);
    assert.ok(clean.notObserved.includes("guestNonRootObserved"));
    const weakened = evaluateBackendEvidence(await run(inspect => {
      const host = inspect.HostConfig as Record<string, unknown>;
      host.Privileged = true; host.NetworkMode = "host"; host.CapAdd = ["SYS_ADMIN"];
      (inspect.Mounts as Record<string, unknown>[]).push({ Type: "bind", Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock", RW: true });
      (inspect.Config as { Env: string[] }).Env.push("ANTHROPIC_API_KEY=x");
    }), DOCKER_REQUIRED_EVIDENCE_FACTS);
    for (const fact of ["privilegedDisabledObserved", "networkModeNoneObserved", "capDropAllObserved", "noDockerSocketMountObserved",
      "noWritableHostMountObserved", "noHostMountsObserved", "containerEnvKeysAllowlistedObserved"])
      assert.ok(weakened.failed.includes(fact), fact);
  });
});

test("O5.5B5 partial or contradictory evidence is never complete, and no universal claim names are used", () => {
  const all = DOCKER_REQUIRED_EVIDENCE_FACTS.map(fact => checkFact(fact, "host", true));
  assert.equal(evaluateBackendEvidence(backendEvidence("docker-linux", all), DOCKER_REQUIRED_EVIDENCE_FACTS).complete, true);
  const partial = backendEvidence("docker-linux", [...all.slice(1), unobservedFact(DOCKER_REQUIRED_EVIDENCE_FACTS[0], "daemon")]);
  assert.equal(evaluateBackendEvidence(partial, DOCKER_REQUIRED_EVIDENCE_FACTS).complete, false);
  const missing = backendEvidence("docker-linux", all.slice(1));
  assert.deepEqual(evaluateBackendEvidence(missing, DOCKER_REQUIRED_EVIDENCE_FACTS).missing, [DOCKER_REQUIRED_EVIDENCE_FACTS[0]]);
  const duplicated = backendEvidence("docker-linux", [...all, all[0]!]);
  assert.equal(evaluateBackendEvidence(duplicated, DOCKER_REQUIRED_EVIDENCE_FACTS).complete, false);
  assert.equal(evaluateBackendEvidence(backendEvidence("x", []), []).complete, false);
  assert.equal(observedFact("canaryConnectionsFailedObserved", "guest", 5, 1).state, "observedFail");
  assert.throws(() => observedFact("x", "guest", 1, 2), kind("InvalidInput"));
  assert.equal(guestFacts(undefined, DEFAULT_DOCKER_LIMITS).every(fact => fact.state === "notObserved"), true);
  for (const fact of DOCKER_REQUIRED_EVIDENCE_FACTS) assert.doesNotMatch(fact, /isolation|sandbox|secure|escape/iu);
});

test("O5.5B5 no Docker backend, evidence, or fake can make isolation or Writer readiness YES", async () => {
  await withCandidate(async root => {
    const backend = backendWith(new FakeDocker(), root);
    assert.equal(backend.productionEligible, false);
    assert.equal(backend.confinement, "osSandbox");
    assert.equal(backend.platformSemantics, "linux");
    assert.equal(await backend.collectProof(), undefined, "no Windows-shaped confinement proof is fabricated");
    const complete = backendEvidence("docker-linux", DOCKER_REQUIRED_EVIDENCE_FACTS.map(fact => checkFact(fact, "host", true)));
    assert.equal(complete.productionEligible, false);
    assert.equal(evaluateBackendEvidence(complete, DOCKER_REQUIRED_EVIDENCE_FACTS).productionEligible, false);
    const readiness = backendReadiness(backend);
    assert.equal(readiness.verificationIsolationEligible, false);
    assert.equal(readiness.productionEligible, false);
    assert.equal(VERIFICATION_ISOLATION_ACCEPTED, false);
    assert.equal(writerReadiness().ready, false);
  });
});

// ---------------------------------------------------------------- protocol

const commands: GuestCommand[] = [{ id: "a", executable: NODE, args: [], cwd: ".", timeoutMs: 1_000 },
  { id: "b", executable: NODE, args: [], cwd: ".", timeoutMs: 1_000 }];
const SOURCE_SHA = "d".repeat(64);
const manifest = { nonce: NONCE, commands, input: { source: { sha256: SOURCE_SHA }, dependencies: null } } as unknown as VerifyManifest;
const expectation = { nonce: NONCE, commands, hostElapsedMs: 5_000, input: { sourceSha256: SOURCE_SHA, dependencySha256: null } };
const entry = (id: string, extra: Record<string, unknown> = {}) => ({ id, status: "exited", exitCode: 0, signal: null, durationMs: 1,
  stdoutTail: "", stderrTail: "", stdoutBytes: 0, stderrBytes: 0, ...extra });
const result = (overrides: Record<string, unknown>) => JSON.stringify({ ...JSON.parse(passingResult(manifest)), ...overrides });

test("O5.5B5 verify results are closed-shape, bounded, identity-bound and internally consistent", () => {
  assert.equal(decodeVerifyResult(result({}), expectation).commands.length, 2);
  const failedFirst = result({ commands: [entry("a", { exitCode: 1 })], notRun: ["b"] });
  assert.deepEqual(decodeVerifyResult(failedFirst, expectation).notRun, ["b"]);
  const bad: Record<string, string> = {
    runAfterFailure: result({ commands: [entry("a", { exitCode: 1 }), entry("b")] }),
    skippedAfterPass: result({ commands: [entry("a")], notRun: ["b"] }),
    reordered: result({ commands: [entry("b"), entry("a")] }),
    impossibleDuration: result({ commands: [entry("a", { durationMs: 99_999 }), entry("b")] }),
    wallTime: result({ commands: [entry("a", { durationMs: 1_000 }), entry("b", { durationMs: 1_000 })] }),
    controlChars: result({ commands: [entry("a", { stdoutTail: "\u001b[31mred", stdoutBytes: 8 }), entry("b")] }),
    bigTail: result({ commands: [entry("a", { stdoutTail: "x".repeat(DOCKER_RESULT_LIMITS.stdoutTailBytes + 1), stdoutBytes: 1e6 }), entry("b")] }),
    exitAndSignal: result({ commands: [entry("a", { exitCode: 0, signal: "SIGKILL" }), entry("b")] }),
    badSignal: result({ commands: [entry("a", { exitCode: null, signal: "rm -rf" }), entry("b")] }),
    exit256: result({ commands: [entry("a", { exitCode: 256 }), entry("b")] }),
    noComplete: result({ complete: false }),
    extraCommandKey: result({ commands: [entry("a", { env: "x" }), entry("b")] }),
    deep: result({ runtime: { node: "v22.20.0", platform: "linux", arch: "x64", nested: { deeper: [[1]] } } }),
    otherInput: result({ input: { ...JSON.parse(passingResult(manifest)).input, sourceSha256: "e".repeat(64) } }),
    impossibleDependencyCounts: result({ input: { ...JSON.parse(passingResult(manifest)).input, dependencyEntries: 5 } }),
    empty: result({ commands: [], notRun: ["a", "b"] }),
  };
  for (const [name, text] of Object.entries(bad)) assert.throws(() => decodeVerifyResult(text, { ...expectation,
    hostElapsedMs: name === "wallTime" ? 500 : expectation.hostElapsedMs }), kind("MalformedOutput"), name);
  for (const protocolVersion of [1, 3]) // the O5.5B5 bind-mount protocol is no longer accepted either
    assert.throws(() => decodeVerifyResult(result({ protocolVersion }), expectation), kind("ProtocolError"));
});

test("O5.5B5 canary results are closed-shape and bounded", () => {
  const canary = { protocolVersion: 2, mode: "canary", nonce: NONCE, complete: true,
    runtime: { node: "v22.20.0", platform: "linux", arch: "x64" },
    identity: { uid: 1000, gid: 1000, noNewPrivs: true, seccompMode: 2, capabilitiesZero: true, ptraceScope: 1 },
    filesystem: { transferredReadable: true, transferDigestMatched: true, rootfsWriteDenied: true, workWritable: true,
      tmpWritable: true, homeWritable: true },
    mounts: { entries: 27, forbiddenFound: 0, hostShareFilesystems: 0, bindLikeFromOutsideVm: 0 },
    markers: { walkComplete: true, entriesVisited: 10, unreadableDirectories: 0, found: 0 },
    credentials: { forbiddenKeysPresent: 0, credentialShapedKeysPresent: 0, canaryValuesPresent: 0, environSourcesRead: 3,
      sshOrGitPathsPresent: 0 },
    dockerSocket: { knownPathsPresent: 0, socketsNamedDockerFound: 0 },
    network: { interfaces: ["lo"], ipv4Routes: 0, ipv6NonLoopbackRoutes: 0, dnsAttempts: 2, dnsFailures: 2, connectAttempts: 3,
      connectFailures: 3 },
    resources: { memoryMax: "1073741824", cpuMax: "200000 100000", pidsMax: "256", pidProbeSpawned: 240, pidProbeLimited: true },
    devices: { count: 15, unexpected: [] } };
  const decoded = decodeCanaryResult(JSON.stringify(canary), NONCE);
  const facts = guestFacts(decoded, DEFAULT_DOCKER_LIMITS);
  assert.equal(facts.filter(fact => fact.state !== "observedPass").length, 0);
  const variants: Record<string, unknown> = {
    envDump: { ...canary, credentials: { ...canary.credentials, env: { HOME: "/x" } } },
    interfaceName: { ...canary, network: { ...canary.network, interfaces: ["eth0; rm"] } },
    failuresExceedAttempts: { ...canary, network: { ...canary.network, dnsFailures: 3 } },
    hostPath: { ...canary, devices: { count: 1, unexpected: ["C:\\Users\\x"] } },
    mountDump: { ...canary, mounts: { ...canary.mounts, lines: ["/run/desktop/mnt/host/c"] } },
    wrongNonce: { ...canary, nonce: "1".repeat(32) },
  };
  for (const [name, value] of Object.entries(variants))
    assert.throws(() => decodeCanaryResult(JSON.stringify(value), NONCE), kind("MalformedOutput"), name);
  const reached = guestFacts(decodeCanaryResult(JSON.stringify({ ...canary, network: { ...canary.network, connectFailures: 2 } }), NONCE),
    DEFAULT_DOCKER_LIMITS).find(fact => fact.fact === "canaryConnectionsFailedObserved");
  assert.equal(reached?.state, "observedFail", "one successful connection fails the network canary");
  const hostShare = guestFacts(decodeCanaryResult(JSON.stringify({ ...canary, mounts: { ...canary.mounts, hostShareFilesystems: 1 } }), NONCE),
    DEFAULT_DOCKER_LIMITS).find(fact => fact.fact === "mountTableHostPathAbsentObserved");
  assert.equal(hostShare?.state, "observedFail", "a host-share mount inside the container fails the mount-table canary");
});

test("O5.5B5 node --test summary counts parse deterministically from TAP or spec output", () => {
  const tap = "1..3\n# tests 3\n# suites 0\n# pass 2\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 5\n";
  assert.deepEqual(parseTestCounts(tap), { tests: 3, pass: 2, fail: 1, cancelled: 0, skipped: 0, todo: 0 });
  assert.equal(parseTestCounts(tap.replace("# pass 2", "# pass 5")), null, "inconsistent totals are not reported");
  assert.equal(parseTestCounts("# tests 1\n"), null);
  assert.deepEqual(parseTestCounts("\u2139 tests 1\n\u2139 pass 1\n\u2139 fail 0\n\u2139 cancelled 0\n\u2139 skipped 0\n\u2139 todo 0\n"),
    { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
});

test("O5.5B5 container inspection parsing keeps key names only and rejects malformed output", () => {
  assert.equal(parseContainerInspect("not json"), undefined);
  assert.equal(parseContainerInspect('{"Id":"x","Id":"y"}'), undefined);
  const parsed = parseContainerInspect(JSON.stringify({ Id: "x", Image: "sha256:y", State: {}, Config: { Env: ["A=secret"] },
    HostConfig: {}, Mounts: [] }));
  assert.deepEqual(parsed?.envKeys, ["A"]);
  assert.equal(JSON.stringify(parsed).includes("secret"), false);
  assert.equal(parsed?.privileged, true, "an unreported Privileged field is treated as privileged (fail closed)");
});

// ---------------------------------------------------------------- guest / build hygiene

test("O5.5B5/B6 the compiled guest modules import only Node built-ins (and each other) and run nothing when imported", async () => {
  for (const [name, allowed] of [["guest-runner.js", ["./transfer-archive.js"]], ["transfer-archive.js", []]] as const) {
    const source = readFileSync(new URL(`../src/platform/verification/docker/${name}`, import.meta.url), "utf8");
    const specifiers = [...source.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gmu)].map(match => match[1]!);
    assert.ok(specifiers.length > 0, name);
    assert.deepEqual(specifiers.filter(specifier => !specifier.startsWith("node:") && !(allowed as readonly string[]).includes(specifier)), [], name);
    assert.equal(/import\(/u.test(source), false, name);
  }
  await import("../src/platform/verification/docker/guest-runner.js");
});

test("O5.5B5 the Docker live test is opt-in and outside the normal npm test glob", () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.match(pkg.scripts.test ?? "", /node --test dist\/test\/\*\.test\.js$/u);
  assert.match(pkg.scripts["test:docker-live"] ?? "", /FUSION_DOCKER_LIVE|docker\.live/u);
  const live = readFileSync(join(process.cwd(), "test", "live", "docker.live.test.ts"), "utf8");
  assert.match(live, /process\.env\.FUSION_DOCKER_LIVE !== "1"/u);
});
