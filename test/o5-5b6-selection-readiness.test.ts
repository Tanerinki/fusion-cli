import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport, writerReadiness } from "../src/app/writer-gate.js";
import type { VerificationPlan } from "../src/core/domain.js";
import { FusionFailure } from "../src/core/errors.js";
import { backendReadiness, TrustedHostBackend, VERIFICATION_ISOLATION_ACCEPTED, type VerificationBackend,
  type VerificationExecutionRequest, type VerificationExecutionResult,
  type VerificationLease } from "../src/platform/verification/backend.js";
import { backendEvidence, checkFact } from "../src/platform/verification/backend-evidence.js";
import { createProductionDockerBackend, DOCKER_REQUIRED_EVIDENCE_FACTS, DockerLinuxVerificationBackend,
  isProductionDockerBackend } from "../src/platform/verification/docker/backend.js";
import { CliDockerRunner } from "../src/platform/verification/docker/cli.js";
import { assertSafeDockerArgs } from "../src/platform/verification/docker/config.js";
import type { VerifyManifest } from "../src/platform/verification/docker/protocol.js";
import type { VerificationReport } from "../src/platform/verification/engine.js";
import { acceptVerificationIsolation, createProductionVerificationBackends,
  isGrantedAcceptance } from "../src/platform/verification/production.js";
import { VerificationService } from "../src/platform/verification/selection.js";
import { CONTAINER_VERIFIER_ENV } from "../src/platform/verification/verifier-environment.js";
import { ProcessGitClient } from "../src/platform/workspace/git.js";
import { PrivateWriterWorkspace } from "../src/platform/workspace/private-writer.js";
import { FAKE_DOCKER_EXE, FAKE_IMAGE, FakeDocker, passingResult, type FakeDockerOptions } from "./fixtures/fake-docker.js";

const kind = (name: string, pattern?: RegExp) => (error: unknown): boolean => error instanceof FusionFailure &&
  error.error.kind === name && (pattern === undefined || pattern.test(error.error.safeMessage));
const NODE = "/usr/local/bin/node";
const SECRET = "fusion-canary-selection-secret";
const plan = (args: string[] = ["--test"]): VerificationPlan => ({ commands: [{ id: "t", executable: NODE, args, cwd: ".",
  timeoutMs: 5_000, mutationPolicy: "readOnly" }] });
const docker = (fake: FakeDocker, extra: Partial<ConstructorParameters<typeof DockerLinuxVerificationBackend>[0]> = {}) =>
  new DockerLinuxVerificationBackend({ image: FAKE_IMAGE, runner: fake, resolveDocker: () => Promise.resolve(FAKE_DOCKER_EXE), ...extra });

async function withCandidate<T>(work: (candidate: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "fusion-o55b6-sel-"));
  try {
    const candidate = join(root, "candidate");
    await mkdir(candidate);
    await writeFile(join(candidate, "package.json"), '{"type":"module"}');
    return await work(candidate);
  } finally { await rm(root, { recursive: true, force: true }); }
}
const serviceRequest = (candidate: string, overrides: Record<string, unknown> = {}) => ({ purpose: "autonomousWriter" as const,
  plan: plan(), workspaceRoot: candidate, git: {} as never, env: {}, platformRequirement: "linux-compatible", ...overrides });

/** A test double that never runs anything; it records whether it was asked to. */
class RecordingHost extends TrustedHostBackend {
  runs = 0;
  constructor() { super({ run: () => Promise.resolve({ passed: true, status: "passed", steps: [], notRun: [] }) } as never); }
  override run(lease: VerificationLease, request: VerificationExecutionRequest): Promise<VerificationExecutionResult> {
    this.runs++;
    return super.run(lease, request);
  }
}

// ---------------------------------------------------------------- selection

test("O5.5B6 selection: every unavailable-backend condition is a classified, stable refusal — never a fallback", async () => {
  const cases: [string, FakeDockerOptions | "missing", RegExp][] = [
    ["cli missing", "missing", /docker-cli-missing/u], ["cli spawn failure", { cli: "spawnFailure" }, /docker-cli-missing/u],
    ["daemon absent", { version: "noServer" }, /docker-daemon-unavailable/u],
    ["daemon unreachable", { version: "exitFailure" }, /docker-daemon-unavailable/u],
    ["windows containers", { version: "windows" }, /docker-engine-not-linux/u],
    ["malformed version", { version: "malformed" }, /docker-version-malformed/u],
    ["image missing", { image: "absent" }, /docker-image-not-present/u],
    ["digest mismatch", { image: "wrongDigest" }, /docker-image-digest-mismatch/u],
    ["wrong architecture", { image: "wrongArch" }, /docker-image-platform-mismatch/u],
    ["wrong image os", { image: "wrongOs" }, /docker-image-platform-mismatch/u],
  ];
  await withCandidate(async candidate => {
    for (const [name, options, reason] of cases) {
      const host = new RecordingHost();
      const backend = options === "missing" ? new DockerLinuxVerificationBackend({ image: FAKE_IMAGE, resolveDocker: () => Promise.resolve(null) })
        : docker(new FakeDocker(options));
      await assert.rejects(new VerificationService([backend, host]).verify(serviceRequest(candidate)),
        kind("CapabilityUnavailable", reason), name);
      assert.equal(host.runs, 0, `${name}: the trusted host is never a fallback`);
    }
    const service = new VerificationService([docker(new FakeDocker())]);
    await assert.rejects(service.verify(serviceRequest(candidate, { platformRequirement: "windows-required" })),
      kind("CapabilityUnavailable", /platform-ineligible/u));
    await assert.rejects(service.verify(serviceRequest(candidate, { platformRequirement: undefined })),
      kind("CapabilityUnavailable", /platform-requirement-unknown/u));
    await assert.rejects(new VerificationService([]).verify(serviceRequest(candidate)), kind("CapabilityUnavailable", /no verification backend/u));
    await assert.rejects(new VerificationService([new TrustedHostBackend()]).verify(serviceRequest(candidate, { purpose: "humanApprovedHost",
      dependencies: { kind: "npm-lockfile", approved: { packageJsonSha256: "0".repeat(64), lockfileSha256: "0".repeat(64) } } })),
    kind("CapabilityUnavailable", /dependency-lane-unavailable/u));
    await assert.rejects(service.verify(serviceRequest(candidate, { purpose: "anything" })), kind("InvalidInput"));
  });
});

test("O5.5B6 selection: the trusted host is refused for autonomous Writers and allowed only for explicit human-approved flows", async () => {
  await withCandidate(async candidate => {
    const host = new RecordingHost();
    await assert.rejects(new VerificationService([host]).verify(serviceRequest(candidate)), kind("CapabilityUnavailable", /trusted-host-refused/u));
    assert.equal(host.runs, 0);
    const approved = await new VerificationService([host]).verify(serviceRequest(candidate, { purpose: "humanApprovedHost" }));
    assert.equal(approved.selection.backendId, "trusted-host");
    assert.equal(host.runs, 1);
    // With both registered, the autonomous purpose selects the confined backend.
    const both = await new VerificationService([host, docker(new FakeDocker())]).verify(serviceRequest(candidate));
    assert.equal(both.selection.backendId, "docker-linux");
    assert.equal(both.selection.confinement, "osSandbox");
    assert.deepEqual(both.selection.considered.map(entry => [entry.backendId, entry.reason]),
      [["trusted-host", "trusted-host-refused"], ["docker-linux", "eligible"]]);
    assert.equal(host.runs, 1);
    assert.equal(createProductionVerificationBackends().some(backend => backend.confinement === "none"), false);
  });
});

test("O5.5B6 selection: malformed results fail, incomplete cleanup fails closed, and the wall clock is enforced", async () => {
  await withCandidate(async candidate => {
    const malformed = await new VerificationService([docker(new FakeDocker({ attach: () => ({ stdout: "{\"protocolVersion\":2" }) }))])
      .verify(serviceRequest(candidate));
    assert.equal(malformed.result.passed, false);
    assert.equal(malformed.result.report.failure?.kind, "MalformedOutput");
    await assert.rejects(new VerificationService([docker(new FakeDocker({ rmFails: true }))]).verify(serviceRequest(candidate)),
      kind("SecurityViolation", /cleanup did not complete/u));
    const hang: NonNullable<FakeDockerOptions["attach"]> = ({ invocation }) => new Promise(resolve =>
      invocation.signal?.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true }));
    await assert.rejects(new VerificationService([docker(new FakeDocker({ attach: hang }))]).verify(serviceRequest(candidate, { timeoutMs: 50 })),
      kind("Timeout"));
  });
});

// ---------------------------------------------------------------- acceptance / readiness

test("O5.5B6 acceptance: a fake backend, hand-built evidence or another instance's evidence can never be accepted", async () => {
  await withCandidate(async candidate => {
    const fakeBackend = docker(new FakeDocker());
    await fakeBackend.probe();
    const request = { plan: plan(), workspaceRoot: candidate, git: {} as never, env: {}, platformRequirement: "linux-compatible" as const };
    const lease = await fakeBackend.prepare(request);
    await fakeBackend.run(lease, request);
    const observed = await fakeBackend.collectEvidence(lease);
    await fakeBackend.dispose(lease);
    const refusal = acceptVerificationIsolation(fakeBackend, observed);
    assert.equal(refusal.accepted, false);
    assert.ok((refusal as { readonly reasons: readonly string[] }).reasons.includes("backend-not-a-production-instance"));
    // A fixture claiming every required fact passed is still unknown to the authority.
    const handBuilt = backendEvidence("docker-linux", DOCKER_REQUIRED_EVIDENCE_FACTS.map(fact => checkFact(fact, "host", true)));
    const production = createProductionDockerBackend();
    assert.equal(isProductionDockerBackend(production), true);
    assert.equal(isProductionDockerBackend(fakeBackend), false);
    assert.deepEqual((acceptVerificationIsolation(production, handBuilt) as { readonly reasons: readonly string[] }).reasons, ["evidence-not-observed-by-a-backend"]);
    assert.deepEqual((acceptVerificationIsolation(production, observed) as { readonly reasons: readonly string[] }).reasons, ["evidence-observed-by-another-backend"]);
    assert.equal(acceptVerificationIsolation(production, JSON.parse(JSON.stringify(observed))).accepted, false, "a copy is not the observation");
    assert.equal(production.productionEligible, false, "a backend never self-declares eligibility");
  });
});

test("O5.5B6 readiness: nothing but a granted acceptance changes the gate; Linux never implies Windows; the live gate stays closed", () => {
  const forged = { accepted: true, contract: "fusion-verification-confinement-v0.1-linux", backendId: "docker-linux", semantics: "linux",
    satisfies: ["platform-neutral", "linux-compatible"], windowsAccepted: true, evidence: { required: 45, passed: 45 } };
  for (const candidate of [undefined, forged, "VERIFICATION_ISOLATION_READINESS: YES", { accepted: true }, true]) {
    assert.equal(isGrantedAcceptance(candidate), false);
    const report = writerGateReport({ linuxVerification: candidate });
    assert.equal(report.verificationIsolation.linux, "notEvaluated");
    assert.equal(report.verificationIsolation.windows, "unsupported");
    assert.equal(report.realWriterModeReady, false);
    assert.equal(report.liveGateAuthorized, false);
    assert.equal(report.rows.find(row => row.id === "verificationIsolation")?.state, "notEvaluated");
  }
  assert.equal(REAL_WRITER_LIVE_GATE_AUTHORIZED, false);
  assert.equal(writerReadiness().ready, false);
  assert.equal(VERIFICATION_ISOLATION_ACCEPTED, false, "no backend is accepted statically");
  assert.deepEqual([backendReadiness(docker(new FakeDocker())).verificationIsolationEligible,
    backendReadiness(docker(new FakeDocker())).productionEligible], [false, false]);
  const ids = writerGateReport().rows.map(row => row.id);
  for (const id of ["primaryProtection", "hostControlledApplication", "providerChangeProposal", "verificationIsolation",
    "platformCompatibility", "dependencySupport", "cleanupAndRecovery", "reviewAndAdjudication", "billingAndAuthPosture",
    "liveGateAuthorization"]) assert.ok(ids.includes(id), id);
  assert.equal(writerGateReport().rows.find(row => row.id === "liveGateAuthorization")?.state, "blocked");
});

// ---------------------------------------------------------------- security

test("O5.5B6 security: plan, task and model text never become docker flags; secrets never reach argv, stdin or the container env", async () => {
  await withCandidate(async candidate => {
    const hostile = ["--privileged", "--network=host", "-v", "C:\\:/host", "--mount=type=bind,source=/,target=/h", "$(id)"];
    let manifest: VerifyManifest | undefined;
    const fake = new FakeDocker({ attach: context => { manifest = context.manifest; return { stdout: passingResult(context.manifest) }; } });
    const backend = docker(fake, { clientEnvironment: { PATH: "C:\\Windows", ANTHROPIC_API_KEY: SECRET, DOCKER_HOST: "tcp://evil:2375" } });
    const outcome = await new VerificationService([backend]).verify(serviceRequest(candidate, { plan: plan(hostile),
      env: { ANTHROPIC_API_KEY: SECRET, GITHUB_TOKEN: SECRET, SSH_AUTH_SOCK: SECRET } }));
    assert.equal(outcome.result.passed, true);
    const argv = fake.calls.flat();
    for (const flag of ["--privileged", "--network=host", "-v", "C:\\:/host", "$(id)", SECRET]) assert.equal(argv.includes(flag), false, flag);
    assert.equal(argv.some(arg => arg.includes(SECRET) || /docker\.sock|type=bind/u.test(arg)), false);
    assert.deepEqual(manifest!.commands[0]!.args, hostile, "hostile text stays inert data inside the manifest");
    assert.deepEqual(Object.keys(manifest!.env).sort(), Object.keys(CONTAINER_VERIFIER_ENV).sort());
    assert.equal(fake.inputs.some(input => input.includes(Buffer.from(SECRET))), false);
    const create = fake.commands("create")[0]!;
    const envs = create.flatMap((arg, index) => arg === "--env" ? [create[index + 1]!.split("=")[0]!] : []);
    assert.deepEqual(envs.sort(), Object.keys(CONTAINER_VERIFIER_ENV).sort(), "the container env is fixed, never copied from the host");
  });
});

test("O5.5B6 security: the CLI runner spawns the native docker binary with an argv array; socket and network escapes are refused", async () => {
  const seen: { executable?: string; args?: readonly string[] }[] = [];
  const supervisor = { start: (spec: { executable: string; args: readonly string[] }) => { seen.push(spec);
    return { result: Promise.resolve({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 }), writeStdin: () => Promise.resolve(),
      closeStdin: () => {} }; } };
  const runner = new CliDockerRunner(FAKE_DOCKER_EXE, { PATH: "C:\\Windows" }, supervisor as never);
  await runner.run({ args: ["version", "--format", "{{json .}}"], timeoutMs: 1_000 });
  assert.deepEqual(seen.map(spec => [spec.executable, spec.args]), [[FAKE_DOCKER_EXE, ["version", "--format", "{{json .}}"]]]);
  for (const args of [["ps", "--filter", "label=x", "-H", "unix:///var/run/docker.sock"], ["run", "--network", "host", FAKE_IMAGE],
    ["container", "prune"], ["volume", "rm", "x"], ["network", "create", "x"], ["exec", "x", "sh"], ["cp", "x:/", "C:\\"]])
    assert.throws(() => assertSafeDockerArgs(args), kind("SecurityViolation"), args.join(" "));
});

// ---------------------------------------------------------------- PrivateWriterWorkspace integration

const gitAvailable = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;
function sh(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", ["-c", "user.name=Fusion Test", "-c", "user.email=fusion@example.invalid", "-c", "commit.gpgsign=false",
    "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
}

/** Confined-backend double: records the reconstructed workspace it was given and runs nothing. */
class RecordingConfined implements VerificationBackend {
  readonly id = "recording-confined";
  readonly confinement = "osSandbox" as const;
  readonly productionEligible = false as const;
  readonly platformSemantics = "linux" as const;
  readonly dependencyKinds = ["npm-lockfile"] as const;
  requests: VerificationExecutionRequest[] = [];
  seen: { aTxt?: string; gitDirPresent?: boolean } = {};
  probe() { return Promise.resolve({ backendId: this.id, available: true, confinement: this.confinement }); }
  async prepare(request: VerificationExecutionRequest): Promise<VerificationLease> {
    this.requests.push(request);
    this.seen = { aTxt: await readFile(join(request.workspaceRoot, "a.txt"), "utf8"), gitDirPresent: existsSync(join(request.workspaceRoot, ".git")) };
    return { backendId: this.id, confinement: this.confinement, workspaceRoot: request.workspaceRoot };
  }
  run(): Promise<VerificationExecutionResult> {
    const report: VerificationReport = { passed: true, status: "passed", steps: [], notRun: [] };
    return Promise.resolve({ backendId: this.id, confinement: this.confinement, report, passed: true });
  }
  collectProof() { return Promise.resolve(undefined); }
  dispose() { return Promise.resolve({ complete: true }); }
}

test("O5.5B6 Writer workspace: confined verification never runs on the host and fails closed on platform or dependency doubt",
  { skip: gitAvailable ? false : "git unavailable" }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "fusion o55b6 writer "));
    try {
      const root = join(dir, "primary");
      await mkdir(root);
      sh(root, "init", "-q");
      await writeFile(join(root, "a.txt"), "base\n");
      await writeFile(join(root, "package.json"), '{"name":"p","version":"1.0.0"}\n');
      await writeFile(join(root, "package-lock.json"), '{"lockfileVersion":3,"packages":{"":{}}}\n');
      sh(root, "add", "."); sh(root, "commit", "-qm", "base");
      const primaryBefore = readFileSync(join(root, "a.txt"), "utf8");
      const git = await ProcessGitClient.fromPath(process.env, true);
      const hostPlan: VerificationPlan = { commands: [{ id: "c", executable: process.execPath, args: ["-e", ""], cwd: ".",
        timeoutMs: 5_000, mutationPolicy: "readOnly" }] };
      const writer = await PrivateWriterWorkspace.open(root, "owner-1", git, hostPlan);
      try {
        await writeFile(join(writer.path, "a.txt"), "writer change\n");
        const host = new RecordingHost();
        await assert.rejects(writer.verifyConfined("owner-1", ["a.txt"], new VerificationService([host]),
          { plan: plan(), declaredPlatform: "linux-compatible" }), kind("CapabilityUnavailable", /trusted-host-refused/u));
        assert.equal(host.runs, 0, "autonomous Writer verification never executes on the host");

        const confined = new RecordingConfined();
        const service = new VerificationService([confined]);
        await assert.rejects(writer.verifyConfined("owner-1", ["a.txt"], service, { plan: plan() }),
          kind("CapabilityUnavailable", /platform-requirement-unknown/u), "a missing declaration fails closed");
        const outcome = await writer.verifyConfined("owner-1", ["a.txt"], service, { plan: plan(), declaredPlatform: "linux-compatible",
          modelPlatformSuggestion: "platform-neutral", dependencies: "npm-lockfile" });
        assert.equal(outcome.verification.result.passed, true);
        assert.equal(outcome.platform.effective, "linux-compatible");
        assert.equal(outcome.platform.modelSuggestion?.applied, false, "a model cannot lower the requirement");
        assert.equal(confined.seen.aTxt, "writer change\n", "the backend verifies the reconstructed candidate");
        const last = confined.requests.at(-1)!;
        assert.deepEqual(last.env, {}, "no host environment crosses into verification");
        const committed = (name: string): string => createHash("sha256").update(readFileSync(join(root, name))).digest("hex");
        assert.deepEqual(last.dependencies, { kind: "npm-lockfile", approved: { packageJsonSha256: committed("package.json"),
          lockfileSha256: committed("package-lock.json") } }, "the approved identity is the committed baseline");
        assert.equal(readFileSync(join(root, "a.txt"), "utf8"), primaryBefore, "the primary checkout is never modified");
      } finally { await writer.close("owner-1", { discardChanges: true }); }

      const escalated = await PrivateWriterWorkspace.open(root, "owner-2", git, hostPlan);
      try {
        await writeFile(join(escalated.path, "setup.ps1"), "Get-Acl C:\\\n");
        const confined = new RecordingConfined();
        await assert.rejects(escalated.verifyConfined("owner-2", ["setup.ps1"], new VerificationService([confined]),
          { plan: plan(), declaredPlatform: "platform-neutral", modelPlatformSuggestion: "platform-neutral" }),
        kind("CapabilityUnavailable", /platform-ineligible/u), "a deterministic Windows signal escalates past the declaration");
        assert.equal(confined.requests.length, 0);
      } finally { await escalated.close("owner-2", { discardChanges: true }); }

      const dependencyChange = await PrivateWriterWorkspace.open(root, "owner-3", git, hostPlan);
      try {
        await writeFile(join(dependencyChange.path, "package.json"), '{"name":"p","version":"1.0.0","dependencies":{"evil":"1"}}\n');
        const confined = new RecordingConfined();
        await assert.rejects(dependencyChange.verifyConfined("owner-3", ["package.json"], new VerificationService([confined]),
          { plan: plan(), declaredPlatform: "linux-compatible", dependencies: "npm-lockfile" }),
        kind("SecurityViolation", /explicit host approval/u), "a Writer cannot self-approve its dependency environment");
        assert.equal(confined.requests.length, 0);
        await assert.rejects(dependencyChange.verifyConfined("owner-3", ["package.json"], new VerificationService([confined]),
          { plan: { commands: [{ ...plan().commands[0]!, mutationPolicy: "allowMutation" }] }, declaredPlatform: "linux-compatible" }),
        kind("InvalidInput"));
      } finally { await dependencyChange.close("owner-3", { discardChanges: true }); }
      assert.equal(readFileSync(join(root, "a.txt"), "utf8"), primaryBefore);
    } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  });

test("O5.5B6 readiness: only the acceptance authority can mint a grant (source guard over src and test)", async () => {
  const { readdir } = await import("node:fs/promises");
  const allowed = new Set(["src/platform/verification/acceptance.ts", "src/platform/verification/production.ts"]);
  for (const dir of ["src", "test"]) {
    const files = (await readdir(join(process.cwd(), dir), { recursive: true })).filter(file => file.endsWith(".ts"));
    for (const file of files) {
      const rel = `${dir}/${file.split("\\").join("/")}`;
      if (rel === "test/o5-5b6-selection-readiness.test.ts" || allowed.has(rel)) continue;
      assert.doesNotMatch(readFileSync(join(process.cwd(), rel), "utf8"), /brandGrantedAcceptance/u, rel);
    }
  }
});
