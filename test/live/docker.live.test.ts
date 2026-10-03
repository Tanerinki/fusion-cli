import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { writerGateReport } from "../../src/app/writer-gate.js";
import { FusionFailure } from "../../src/core/errors.js";
import type { VerificationPlan } from "../../src/core/domain.js";
import { executeVerification, type VerificationExecutionRequest } from "../../src/platform/verification/backend.js";
import { evaluateBackendEvidence } from "../../src/platform/verification/backend-evidence.js";
import type { DependencyRequirement } from "../../src/platform/verification/dependency-policy.js";
import { createProductionDockerBackend, DOCKER_REQUIRED_EVIDENCE_FACTS,
  type DockerVerificationExecutionResult } from "../../src/platform/verification/docker/backend.js";
import { CliDockerRunner, resolveDockerCli } from "../../src/platform/verification/docker/cli.js";
import { PRODUCTION_DOCKER_IMAGE, PRODUCTION_NODE_VERSION } from "../../src/platform/verification/docker/config.js";
import { sweepStaleContainers } from "../../src/platform/verification/docker/sweeper.js";
import { acceptVerificationIsolation, isGrantedAcceptance } from "../../src/platform/verification/production.js";
import { VerificationService } from "../../src/platform/verification/selection.js";
import { FIXTURE_DEPENDENCY_TEST, FIXTURE_LOCKFILE, FIXTURE_PACKAGE_JSON } from "../fixtures/npm-fixture.js";

/**
 * OPT-IN real Docker proof of the productionized backend (`FUSION_DOCKER_LIVE=1 npm run test:docker-live`). It needs a
 * running Linux Docker engine and the pinned production image already present locally; it never pulls. It creates only
 * Fusion-labelled containers and disposable directories, uses synthetic canaries only, and makes no provider call. The
 * dependency part contacts the public npm registry from the separate preparation container only.
 */
const LIVE = process.env.FUSION_DOCKER_LIVE === "1";
const NODE = "/usr/local/bin/node";
const hex = (bytes = 16): string => randomBytes(bytes).toString("hex");
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const SYNTHETIC_ENV = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CONFIG_DIR", "MUSE_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK",
  "GIT_ASKPASS", "GIT_CONFIG_GLOBAL", "DOCKER_HOST"];

const step = (id: string, args: string[], timeoutMs = 60_000): VerificationPlan["commands"][number] =>
  ({ id, executable: NODE, args, cwd: ".", timeoutMs, mutationPolicy: "readOnly" });

async function writeRepo(root: string, failing = false): Promise<void> {
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "test"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"name":"fusion-docker-live","version":"0.0.0","private":true,"type":"module"}\n');
  await writeFile(join(root, "scripts", "hello.mjs"), "console.log(`hello from ${process.platform} node ${process.version}`);\n");
  await writeFile(join(root, "scripts", "spawn-pipe.mjs"), [
    'import { spawn } from "node:child_process";',
    'const child = spawn(process.execPath, ["-e", "process.stdout.write(\'child-out\'); process.stderr.write(\'child-err\')"], { stdio: ["ignore", "pipe", "pipe"] });',
    'let out = "", err = "";',
    'child.stdout.on("data", d => out += d); child.stderr.on("data", d => err += d);',
    'child.on("close", code => { console.log(JSON.stringify({ code, out, err })); process.exitCode = code === 0 && out === "child-out" && err === "child-err" ? 0 : 1; });',
  ].join("\n"));
  // Repository code probing its own confinement: forbidden targets, socket, network, credentials, host mounts.
  await writeFile(join(root, "scripts", "probe.mjs"), [
    'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
    'import { connect } from "node:net";',
    'const mountinfo = readFileSync("/proc/self/mountinfo", "utf8");',
    'const rootfs = (() => { try { writeFileSync("/etc/fusion-probe", "x"); return "writable"; } catch (e) { return e.code; } })();',
    'const net = await new Promise(r => { const s = connect({ host: "1.1.1.1", port: 443, timeout: 2000 }); s.once("connect", () => { s.destroy(); r("connected"); }); s.once("error", e => r(e.code)); s.once("timeout", () => { s.destroy(); r("timeout"); }); });',
    'const env = Object.keys(process.env).filter(k => /TOKEN|KEY|SECRET|SSH|ANTHROPIC|CLAUDE|MUSE|DOCKER|GIT_A/i.test(k));',
    'const hostPath = / - (?:9p|drvfs|virtiofs|fuse\\.grpcfuse|grpcfuse) |\\/run\\/desktop\\/mnt\\/host|\\/host_mnt|[A-Za-z]:\\\\/.test(mountinfo);',
    'const report = { rootfs, net, env, hostPath, socket: existsSync("/var/run/docker.sock") || existsSync("/run/docker.sock"),',
    '  manifestOnDisk: existsSync("/fusion/input") || existsSync("/fusion/work/.fusion/manifest.json"), uid: process.getuid() };',
    'console.log(JSON.stringify(report));',
    'process.exitCode = rootfs !== "writable" && net !== "connected" && env.length === 0 && !hostPath && !report.socket && !report.manifestOnDisk && report.uid !== 0 ? 0 : 1;',
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

test("O5.5B6 LIVE productionized Docker/Linux verification", { skip: !LIVE && "set FUSION_DOCKER_LIVE=1 to run" }, async (t) => {
  if (process.env.FUSION_DOCKER_LIVE !== "1") return;
  const root = await mkdtemp(join(tmpdir(), "fusion-docker-live-"));
  const saved = new Map(SYNTHETIC_ENV.map(key => [key, process.env[key]]));
  try {
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
    const canaryValue = `fusion-canary-${hex()}`;
    for (const key of SYNTHETIC_ENV) process.env[key] = key === "DOCKER_HOST" ? "tcp://fusion-canary.invalid:2375" : canaryValue;
    assert.deepEqual(await ownedContainerIds(), [], "no Fusion-owned container exists before the run");

    const backend = createProductionDockerBackend({ baseDirectory: root, dependencyStoreDirectory: join(root, "dependency-store") });
    const probe = await backend.probe();
    assert.equal(probe.available, true, probe.reason);
    const engine = backend.observedEngine!;
    t.diagnostic(`engine ${JSON.stringify(engine.server)} image ${engine.image.id} ${engine.image.os}/${engine.image.architecture} probeMs=${backend.probeMs}`);
    assert.equal(engine.image.id, PRODUCTION_DOCKER_IMAGE.slice(PRODUCTION_DOCKER_IMAGE.indexOf("@") + 1), "exact image digest");

    const request: VerificationExecutionRequest = { plan: { commands: [step("A-node-version", ["--version"]),
      step("B-script", ["scripts/hello.mjs"]), step("C-piped-child", ["scripts/spawn-pipe.mjs"]),
      step("D-node-test", ["--test"], 120_000), step("E-self-probe", ["scripts/probe.mjs"])] },
      workspaceRoot: join(root, "candidate"), git: {} as never, env: {}, platformRequirement: "linux-compatible" };
    const lease = await backend.prepare(request);
    const run = await backend.run(lease, request) as DockerVerificationExecutionResult;
    t.diagnostic(`matrix ${JSON.stringify(run.report.steps.map(entry => [entry.commandId, entry.status, entry.exitCode, entry.durationMs]))}`);
    t.diagnostic(`outputs ${JSON.stringify(run.docker.steps.map(entry => [entry.id, entry.stdoutTail.slice(-400), entry.testCounts]))}`);
    t.diagnostic(`timings ${JSON.stringify(run.docker.timings)} source ${JSON.stringify(run.docker.source)} runtime ${JSON.stringify(run.docker.runtime)}`);
    assert.equal(run.passed, true, JSON.stringify(run.report.failure));
    assert.equal(run.docker.runtime?.node, PRODUCTION_NODE_VERSION, "exact Node version, observed in the guest");
    const outputs = new Map(run.docker.steps.map(entry => [entry.id, entry]));
    assert.equal(outputs.get("A-node-version")!.stdoutTail.trim(), PRODUCTION_NODE_VERSION);
    assert.match(outputs.get("B-script")!.stdoutTail, /^hello from linux node v22\.20\.0/u);
    assert.deepEqual(JSON.parse(outputs.get("C-piped-child")!.stdoutTail), { code: 0, out: "child-out", err: "child-err" });
    assert.deepEqual(outputs.get("D-node-test")!.testCounts, { tests: 3, pass: 3, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
    t.diagnostic(`repoSelfProbe ${outputs.get("E-self-probe")!.stdoutTail.trim()}`);

    const evidence = await backend.collectEvidence(lease, { absentMarkerNames: [primaryMarker, sshMarker, gitMarker, providerMarker] });
    const detail = backend.evidenceDetail(lease);
    t.diagnostic(`canary ${JSON.stringify(detail?.canary)}`);
    t.diagnostic(`evidenceTimings ${JSON.stringify(detail?.timings)}`);
    const evaluation = evaluateBackendEvidence(evidence, DOCKER_REQUIRED_EVIDENCE_FACTS);
    t.diagnostic(`evidence ${JSON.stringify({ complete: evaluation.complete, passed: evaluation.passed.length, required: DOCKER_REQUIRED_EVIDENCE_FACTS.length,
      failed: evaluation.failed, notObserved: evaluation.notObserved, missing: evaluation.missing })}`);
    assert.equal(evaluation.complete, true);
    assert.deepEqual(await backend.dispose(lease), { complete: true });

    // The acceptance authority grants a SCOPED acceptance from this instance's own evidence — and nothing more.
    const acceptance = acceptVerificationIsolation(backend, evidence);
    t.diagnostic(`acceptance ${JSON.stringify(acceptance)}`);
    assert.equal(acceptance.accepted, true, JSON.stringify(acceptance));
    assert.equal(isGrantedAcceptance(acceptance), true);
    assert.equal((acceptance as { windowsAccepted: boolean }).windowsAccepted, false);
    const gates = writerGateReport({ linuxVerification: acceptance });
    t.diagnostic(`writerGates ${JSON.stringify(gates.rows.map(row => [row.id, row.state]))}`);
    assert.equal(gates.verificationIsolation.linux, "accepted");
    // Windows evidence is derived from the recorded, version-bound live Hyper-V proof (fail-closed); a granted Linux
    // acceptance never implies it, no confined Windows backend is registered, and it never opens the Writer gate.
    assert.equal(gates.verificationIsolation.windows.evidenceState, "proven");
    assert.equal(gates.verificationIsolation.windows.backendState, "unavailable");
    assert.equal(gates.verificationIsolation.windows.effectiveState, "blocked");
    assert.equal(gates.realWriterModeReady, false);
    assert.equal(gates.liveGateAuthorized, false);

    // A failing repository: counts and the daemon exit-status cross-check agree.
    const failing = await executeVerification(backend, { ...request, workspaceRoot: join(root, "candidate-failing"),
      plan: { commands: [step("D-node-test", ["--test"], 120_000)] } }) as DockerVerificationExecutionResult;
    assert.equal(failing.passed, false);
    assert.equal(failing.docker.steps[0]!.testCounts?.fail, 1);
    assert.equal(failing.docker.containerExitCode, 1);

    // Guest per-command deadline, and the host wall-clock deadline (container stopped and removed by the host).
    const guestTimeout = await executeVerification(backend, { ...request,
      plan: { commands: [step("hang", ["-e", "setInterval(() => {}, 1 << 30)"], 1_500)] } }) as DockerVerificationExecutionResult;
    assert.equal(guestTimeout.report.steps[0]!.status, "timeout");
    const hostStarted = performance.now();
    await assert.rejects(executeVerification(backend, { ...request, timeoutMs: 4_000,
      plan: { commands: [step("hang", ["-e", "setInterval(() => {}, 1 << 30)"], 60_000)] } }),
    (error: unknown) => error instanceof FusionFailure && error.error.kind === "Timeout");
    t.diagnostic(`hostTimeout rejectedAfterMs=${Math.round(performance.now() - hostStarted)}`);
    await assert.rejects(executeVerification(backend, { ...request, platformRequirement: "windows-required" }),
      (error: unknown) => error instanceof FusionFailure && error.error.kind === "CapabilityUnavailable");

    // Dependency lane: explicit networked preparation (manifests only), then network-less verification from the artifact.
    const project = join(root, "deps-project");
    await mkdir(join(project, "test"), { recursive: true });
    await writeFile(join(project, "package.json"), FIXTURE_PACKAGE_JSON);
    await writeFile(join(project, "package-lock.json"), FIXTURE_LOCKFILE);
    await writeFile(join(project, "test", "deps.test.mjs"), FIXTURE_DEPENDENCY_TEST);
    const dependencies: DependencyRequirement = { kind: "npm-lockfile",
      approved: { packageJsonSha256: sha(FIXTURE_PACKAGE_JSON), lockfileSha256: sha(FIXTURE_LOCKFILE) } };
    const prepared = await backend.prepareDependencies({ workspaceRoot: project, dependencies });
    t.diagnostic(`depsPrepared ${JSON.stringify({ key: prepared.key, cacheHit: prepared.cacheHit, artifact: prepared.record.artifact,
      observed: prepared.record.observed, preparation: prepared.preparation })}`);
    assert.equal(prepared.cacheHit, false);
    assert.equal(prepared.record.observed.lifecycleScriptsExecuted, false);
    assert.equal(prepared.record.artifact.files >= 6, true);
    const cacheStarted = performance.now();
    assert.equal((await backend.prepareDependencies({ workspaceRoot: project, dependencies })).cacheHit, true);
    t.diagnostic(`depsCacheHitMs=${Math.round(performance.now() - cacheStarted)}`);
    const service = new VerificationService([backend]);
    const withDeps = await service.verify({ purpose: "autonomousWriter", plan: { commands: [step("deps-test", ["--test"], 120_000)] },
      workspaceRoot: project, git: {} as never, env: {}, platformRequirement: "linux-compatible", dependencies });
    const depsRun = withDeps.result as DockerVerificationExecutionResult;
    t.diagnostic(`depsVerify ${JSON.stringify({ passed: depsRun.passed, deps: depsRun.docker.dependencies, limits: depsRun.docker.limits,
      timings: depsRun.docker.timings, counts: depsRun.docker.steps[0]?.testCounts, recovery: withDeps.recovery })}`);
    assert.equal(depsRun.passed, true, JSON.stringify(depsRun.report.failure));
    assert.equal(depsRun.docker.steps[0]!.testCounts?.pass, 1);

    // Crash-recovery sweep: nothing stale remains; a dry run finds nothing to remove and touches nothing.
    const docker = await resolveDockerCli();
    const sweep = await sweepStaleContainers(new CliDockerRunner(docker!), { dryRun: true });
    t.diagnostic(`sweepDryRun ${JSON.stringify({ listed: sweep.listed, selections: sweep.selections.length, complete: sweep.complete })}`);
    assert.equal(sweep.complete, true);

    assert.deepEqual(await ownedContainerIds(), [], "no Fusion-owned container remains");
    assert.deepEqual((await readdir(root)).filter(name => name.startsWith("fusion-docker-")), [], "no evidence directory remains");
    const strays = await windowsNodeProcessesMatching("fusion-descendant-") + await windowsNodeProcessesMatching("/fusion/work/.fusion");
    t.diagnostic(`windowsHostStrayVerifierNodeProcesses=${strays}`);
    assert.equal(strays, 0);
  } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
});
