import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { FusionFailure } from "../../src/core/errors.js";
import type { VerificationPlan } from "../../src/core/domain.js";
import { executeVerification, type VerificationExecutionRequest } from "../../src/platform/verification/backend.js";
import { evaluateBackendEvidence } from "../../src/platform/verification/backend-evidence.js";
import { DockerLinuxVerificationBackend, DOCKER_REQUIRED_EVIDENCE_FACTS,
  type DockerVerificationExecutionResult } from "../../src/platform/verification/docker/backend.js";
import { CliDockerRunner, resolveDockerCli } from "../../src/platform/verification/docker/cli.js";

/**
 * OPT-IN real Docker spike (`FUSION_DOCKER_LIVE=1 npm run test:docker-live`). It needs a running Linux Docker engine
 * and the pinned image already present locally; it never pulls. It creates only Fusion-labelled containers and
 * disposable directories, uses synthetic canaries only, makes no provider call and never touches the repository.
 */
const LIVE = process.env.FUSION_DOCKER_LIVE === "1";
const IMAGE = process.env.FUSION_DOCKER_IMAGE ?? "node@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e";
const NODE = "/usr/local/bin/node";
const hex = (bytes = 16): string => randomBytes(bytes).toString("hex");
const SYNTHETIC_ENV = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CONFIG_DIR", "MUSE_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK",
  "GIT_ASKPASS", "GIT_CONFIG_GLOBAL"];

const step = (id: string, args: string[], timeoutMs = 60_000): VerificationPlan["commands"][number] =>
  ({ id, executable: NODE, args, cwd: ".", timeoutMs, mutationPolicy: "readOnly" });

async function writeRepo(root: string, failing = false): Promise<void> {
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "test"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"name":"fusion-docker-spike","version":"0.0.0","private":true,"type":"module"}\n');
  await writeFile(join(root, "scripts", "hello.mjs"), "console.log(`hello from ${process.platform} node ${process.version}`);\n");
  await writeFile(join(root, "scripts", "spawn-pipe.mjs"), [
    'import { spawn } from "node:child_process";',
    'const child = spawn(process.execPath, ["-e", "process.stdout.write(\'child-out\'); process.stderr.write(\'child-err\')"], { stdio: ["ignore", "pipe", "pipe"] });',
    'let out = "", err = "";',
    'child.stdout.on("data", d => out += d); child.stderr.on("data", d => err += d);',
    'child.on("close", code => { console.log(JSON.stringify({ code, out, err })); process.exitCode = code === 0 && out === "child-out" && err === "child-err" ? 0 : 1; });',
  ].join("\n"));
  await writeFile(join(root, "test", "math.test.mjs"), [
    'import { test } from "node:test"; import assert from "node:assert/strict";',
    'test("adds", () => assert.equal(1 + 1, 2));',
    `test("multiplies", () => assert.equal(2 * 3, ${failing ? 7 : 6}));`,
  ].join("\n"));
  await writeFile(join(root, "test", "strings.test.mjs"),
    'import { test } from "node:test"; import assert from "node:assert/strict";\ntest("upper", () => assert.equal("a".toUpperCase(), "A"));\n');
}

function windowsNodeProcessesMatching(pattern: string): Promise<number> {
  if (process.platform !== "win32") return Promise.resolve(0);
  const script = `(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${pattern}*' } | Measure-Object).Count`;
  return new Promise((resolve, reject) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { shell: false, windowsHide: true, timeout: 60_000 }, (error, stdout) => error ? reject(error) : resolve(Number(stdout.trim()))));
}

async function ownedContainerIds(): Promise<string[]> {
  const docker = await resolveDockerCli();
  const outcome = await new CliDockerRunner(docker!).run({ args: ["ps", "--all", "--no-trunc", "--filter", "label=fusion.owner=true",
    "--format", "{{.ID}}"], timeoutMs: 30_000 });
  assert.equal(outcome.exitCode, 0);
  return outcome.stdout.split(/\r?\n/u).filter(line => line.trim() !== "");
}

test("O5.5B5 LIVE hardened Docker/Linux verification spike", { skip: !LIVE && "set FUSION_DOCKER_LIVE=1 to run" }, async (t) => {
  if (process.env.FUSION_DOCKER_LIVE !== "1") return;
  const root = await mkdtemp(join(tmpdir(), "fusion-docker-live-"));
  const saved = new Map(SYNTHETIC_ENV.map(key => [key, process.env[key]]));
  try {
    // Synthetic, harmless markers only: a primary repository, a user profile with SSH/Git state, provider auth state.
    const primaryMarker = `fusion-canary-${hex()}.txt`, sshMarker = `fusion-canary-${hex()}.key`;
    const gitMarker = `fusion-canary-${hex()}.cfg`, providerMarker = `fusion-canary-${hex()}.json`;
    await writeRepo(join(root, "primary"));
    await writeFile(join(root, "primary", primaryMarker), "synthetic primary-repository marker");
    await mkdir(join(root, "profile", ".ssh"), { recursive: true });
    await writeFile(join(root, "profile", ".ssh", sshMarker), "synthetic ssh marker");
    await writeFile(join(root, "profile", gitMarker), "synthetic git credential marker");
    await mkdir(join(root, "provider-state"));
    await writeFile(join(root, "provider-state", providerMarker), "synthetic provider auth marker");
    await writeRepo(join(root, "candidate"));
    await writeRepo(join(root, "candidate-failing"), true);
    await mkdir(join(root, "runs"));
    const canaryValue = `fusion-canary-${hex()}`;
    for (const key of SYNTHETIC_ENV) process.env[key] = canaryValue;
    const before = await ownedContainerIds();
    assert.deepEqual(before, [], "no Fusion-owned container exists before the spike");

    const backend = new DockerLinuxVerificationBackend({ image: IMAGE, baseDirectory: join(root, "runs") });
    const probeStarted = performance.now();
    const probe = await backend.probe();
    const probeMs = Math.round(performance.now() - probeStarted);
    assert.equal(probe.available, true, probe.reason);
    t.diagnostic(`engine ${JSON.stringify(backend.observedEngine?.server)} image ${backend.observedEngine?.image.id} probeMs=${probeMs}`);

    // Runtime matrix A–D in one container, then the confinement canaries in fresh Fusion-only containers.
    const request: VerificationExecutionRequest = { plan: { commands: [step("A-node-version", ["--version"]),
      step("B-script", ["scripts/hello.mjs"]), step("C-piped-child", ["scripts/spawn-pipe.mjs"]), step("D-node-test", ["--test"], 120_000)] },
      workspaceRoot: join(root, "candidate"), git: {} as never, env: {}, platformRequirement: "linux-compatible" };
    const lease = await backend.prepare(request);
    const run = await backend.run(lease, request) as DockerVerificationExecutionResult;
    t.diagnostic(`matrix ${JSON.stringify(run.report.steps.map(entry => [entry.commandId, entry.status, entry.exitCode, entry.durationMs]))}`);
    t.diagnostic(`outputs ${JSON.stringify(run.docker.steps.map(entry => [entry.id, entry.stdoutTail.slice(-400), entry.testCounts]))}`);
    t.diagnostic(`timings ${JSON.stringify(run.docker.timings)} bundle ${JSON.stringify(run.docker.bundle)} runner ${run.docker.runnerSha256}`);
    assert.equal(run.passed, true, JSON.stringify(run.report.failure));
    const outputs = new Map(run.docker.steps.map(entry => [entry.id, entry]));
    assert.equal(outputs.get("A-node-version")!.stdoutTail.trim(), "v22.20.0");
    assert.match(outputs.get("B-script")!.stdoutTail, /^hello from linux node v22\.20\.0/u);
    assert.deepEqual(JSON.parse(outputs.get("C-piped-child")!.stdoutTail), { code: 0, out: "child-out", err: "child-err" });
    assert.deepEqual(outputs.get("D-node-test")!.testCounts, { tests: 3, pass: 3, fail: 0, cancelled: 0, skipped: 0, todo: 0 });

    const evidence = await backend.collectEvidence(lease, { absentMarkerNames: [primaryMarker, sshMarker, gitMarker, providerMarker] });
    const detail = backend.evidenceDetail(lease);
    t.diagnostic(`canary ${JSON.stringify(detail?.canary)}`);
    t.diagnostic(`evidenceTimings ${JSON.stringify(detail?.timings)}`);
    const evaluation = evaluateBackendEvidence(evidence, DOCKER_REQUIRED_EVIDENCE_FACTS);
    t.diagnostic(`evidence ${JSON.stringify({ complete: evaluation.complete, failed: evaluation.failed,
      notObserved: evaluation.notObserved, missing: evaluation.missing, productionEligible: evaluation.productionEligible })}`);
    t.diagnostic(`informational ${JSON.stringify(evidence.facts.filter(fact => !(DOCKER_REQUIRED_EVIDENCE_FACTS as readonly string[]).includes(fact.fact)))}`);
    assert.equal(evaluation.complete, true);
    assert.equal(evaluation.productionEligible, false);
    const disposed = await backend.dispose(lease);
    assert.deepEqual(disposed, { complete: true });

    // A failing repository: counts and the daemon exit-status cross-check agree.
    const failing = await executeVerification(backend, { ...request, workspaceRoot: join(root, "candidate-failing"),
      plan: { commands: [step("D-node-test", ["--test"], 120_000)] } }) as DockerVerificationExecutionResult;
    t.diagnostic(`failingRepo ${JSON.stringify({ passed: failing.passed, status: failing.report.steps[0]?.status,
      exitCode: failing.report.steps[0]?.exitCode, counts: failing.docker.steps[0]?.testCounts, exit: failing.docker.containerExitCode })}`);
    assert.equal(failing.passed, false);
    assert.equal(failing.report.steps[0]!.exitCode, 1);
    assert.equal(failing.docker.steps[0]!.testCounts?.fail, 1);
    assert.equal(failing.docker.containerExitCode, 1);

    // Guest-enforced per-command deadline.
    const guestTimeout = await executeVerification(backend, { ...request,
      plan: { commands: [step("hang", ["-e", "setInterval(() => {}, 1 << 30)"], 1_500)] } }) as DockerVerificationExecutionResult;
    t.diagnostic(`guestTimeout ${JSON.stringify({ status: guestTimeout.report.steps[0]?.status, ms: guestTimeout.report.steps[0]?.durationMs })}`);
    assert.equal(guestTimeout.report.steps[0]!.status, "timeout");

    // Host wall-clock deadline: the container must be stopped and removed by the host.
    const hostStarted = performance.now();
    await assert.rejects(executeVerification(backend, { ...request, timeoutMs: 4_000,
      plan: { commands: [step("hang", ["-e", "setInterval(() => {}, 1 << 30)"], 60_000)] } }),
    (error: unknown) => error instanceof FusionFailure && error.error.kind === "Timeout");
    t.diagnostic(`hostTimeout rejectedAfterMs=${Math.round(performance.now() - hostStarted)}`);

    // Platform semantics: a Windows-required task never reaches Docker.
    await assert.rejects(executeVerification(backend, { ...request, platformRequirement: "windows-required" }),
      (error: unknown) => error instanceof FusionFailure && error.error.kind === "CapabilityUnavailable");

    assert.deepEqual(await ownedContainerIds(), [], "no Fusion-owned container remains");
    assert.deepEqual(await readdir(join(root, "runs")), [], "no run directory remains");
    const strays = await windowsNodeProcessesMatching("/fusion/input/runner.mjs") + await windowsNodeProcessesMatching("fusion-descendant-");
    t.diagnostic(`windowsHostStrayVerifierNodeProcesses=${strays}`);
    assert.equal(strays, 0);
  } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
});
