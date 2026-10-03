import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HyperVWindowsVerificationBackend, validateHyperVPlan } from "../src/platform/verification/hyperv/backend.js";
import { assertSafeHyperVArgs, PRODUCTION_WINDOWS_BASE_IMAGE } from "../src/platform/verification/hyperv/config.js";
import { selectVerificationBackend } from "../src/platform/verification/selection.js";
import type { DockerCommandRunner, DockerInvocation, DockerOutcome } from "../src/platform/verification/docker/cli.js";
import type { VerificationBackend, VerificationExecutionRequest } from "../src/platform/verification/backend.js";
import type { VerificationPlan } from "../src/core/domain.js";

const exited = (stdout: string, exitCode = 0): DockerOutcome => ({ status: "exited", exitCode, stdout, stderr: "", durationMs: 1 });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// A scripted fake docker CLI for the Hyper-V flow. It echoes the plan's nonce + commands back in a faithful
// HV_RESULT_JSON (as the real guest would), and lets each test shape the per-command outcome and the worker exit code.
type Scenario = (cmd: { id: string }) => { exitCode: number | null; timedOut?: boolean; spawnError?: string | null;
  violatesReadOnly?: boolean; mutatedCandidate?: boolean; passed: boolean };
function fakeRunner(opts: { runStatus?: DockerOutcome["status"]; scenario?: Scenario; networkMode?: string;
  bindMounts?: { type: string }[]; engineOs?: string; baseImageOs?: string } = {}): { runner: DockerCommandRunner; calls: string[] } {
  const calls: string[] = [];
  const scenario: Scenario = opts.scenario ?? (() => ({ exitCode: 0, passed: true }));
  let lastRunAllPassed = true; // the daemon-observed worker exit mirrors the guest's own pass/fail (cross-checked by the backend)
  const runner: DockerCommandRunner = {
    async run(inv: DockerInvocation): Promise<DockerOutcome> {
      assertSafeHyperVArgs(inv.args); // the fake still proves every argv passes the hardened allowlist
      const a = inv.args, cmd = a[0], sub = a[1];
      calls.push(a.slice(0, 2).join(" "));
      if (cmd === "version") return exited(JSON.stringify({ Client: {}, Server: { Os: opts.engineOs ?? "windows", Arch: "amd64", Version: "29.8.1", KernelVersion: "10.0.26200", Platform: { Name: "Docker Desktop" } } }));
      if (cmd === "image" && sub === "inspect") return exited(JSON.stringify({ Id: "sha256:" + "a".repeat(64), RepoDigests: [], Os: opts.baseImageOs ?? "windows", Architecture: "amd64", Config: { Env: [] } }));
      if (cmd === "build") return exited("built");
      if (cmd === "run") {
        if (opts.runStatus && opts.runStatus !== "exited") return { status: opts.runStatus, exitCode: null, stdout: "", stderr: "", durationMs: 1 };
        const envArg = a.find(x => x.startsWith("FUSION_HV_PLAN=")) ?? "";
        const plan = JSON.parse(Buffer.from(envArg.slice("FUSION_HV_PLAN=".length), "base64").toString("utf8")) as { nonce: string; commands: { id: string; executable: string; args: string[]; cwd: string; mutationPolicy: string }[]; candidateRoot: string };
        const results = plan.commands.map(c => { const s = scenario(c); return { id: c.id, executable: c.executable, args: c.args, cwd: c.cwd, mutationPolicy: c.mutationPolicy, exitCode: s.exitCode, signal: null, timedOut: s.timedOut === true, cancelled: false, spawnError: s.spawnError ?? null, durationMs: 5, violatesReadOnly: s.violatesReadOnly === true, mutatedCandidate: s.mutatedCandidate === true, stdoutBytes: 10, stderrBytes: 0, passed: s.passed }; });
        lastRunAllPassed = results.every(r => r.passed);
        const doc = { schema: "v0.6-hv-verify-result-1", nonce: plan.nonce, runtime: { node: "v22.20.0", platform: "win32", arch: "x64" }, candidateRoot: plan.candidateRoot, candidateFingerprintBefore: { "a.txt": sha("a") }, candidateFingerprintAfter: { "a.txt": sha(results.some(r => r.mutatedCandidate) ? "b" : "a") }, sourceMutated: results.some(r => r.mutatedCandidate), results, notRun: [], host: { workerOsRelease: "10" } };
        return exited(`some preamble\nHV_RESULT_JSON ${JSON.stringify(doc)}\n`);
      }
      if (cmd === "container" && sub === "inspect")
        return exited(JSON.stringify({ Id: "f".repeat(64), Image: "img", Created: new Date().toISOString(), State: { Running: false, ExitCode: lastRunAllPassed ? 0 : 1, OOMKilled: false }, Config: { Labels: {}, Env: [] }, HostConfig: { NetworkMode: opts.networkMode ?? "none", Binds: [], Privileged: false }, Mounts: opts.bindMounts ? opts.bindMounts.map(m => ({ Type: m.type, Source: "x", Destination: "y", RW: false })) : [] }));
      if (cmd === "kill" || cmd === "rm" || cmd === "rmi" || cmd === "ps") return exited("");
      return exited("", 0);
    },
  };
  return { runner, calls };
}

function backendWith(parts: Parameters<typeof fakeRunner>[0], nodeExe: string): HyperVWindowsVerificationBackend {
  const { runner } = fakeRunner(parts);
  return new HyperVWindowsVerificationBackend({ baseImage: PRODUCTION_WINDOWS_BASE_IMAGE, nodeExePath: nodeExe,
    runner, resolveDocker: async () => "docker" });
}

const req = (plan: VerificationPlan, workspaceRoot: string, signal?: AbortSignal): VerificationExecutionRequest =>
  ({ plan, workspaceRoot, git: {} as never, env: {}, platformRequirement: "windows-required", ...(signal ? { signal } : {}) });
const onePlan: VerificationPlan = { commands: [{ id: "t", executable: "C:\\fusion\\node.exe", args: ["-e", "0"], cwd: ".", timeoutMs: 60_000, mutationPolicy: "readOnly" }] };

async function withWorkspace(fn: (root: string, nodeExe: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "fusion-hvws-"));
  await writeFile(join(root, "a.txt"), "hello");
  const nodeExe = join(root, "fake-node.exe");
  await writeFile(nodeExe, "binary");
  try { await fn(root, nodeExe); } finally { await rm(root, { recursive: true, force: true }); }
}

// A minimal backend stub for pure selection tests (probe only; lifecycle methods are never reached).
const stub = (id: string, confinement: "none" | "osSandbox" | "vm", platformSemantics: "linux" | "windows" | undefined, available: boolean): VerificationBackend =>
  ({ id, confinement, productionEligible: false, ...(platformSemantics ? { platformSemantics } : {}),
    probe: async () => ({ backendId: id, available, confinement, ...(available ? {} : { reason: `${id}-unavailable` }) }),
    prepare: async () => { throw new Error("unused"); }, run: async () => { throw new Error("unused"); },
    collectProof: async () => undefined, dispose: async () => ({ complete: true }) } as unknown as VerificationBackend);

// ---- selection (requirements 1-4) --------------------------------------------------------------------------------
test("v0.6 hyperv backend 1: a windows-required autonomous task selects the Hyper-V backend", async () => {
  const sel = await selectVerificationBackend([stub("docker-linux", "osSandbox", "linux", true), stub("hyperv-windows", "vm", "windows", true)],
    { purpose: "autonomousWriter", platformRequirement: "windows-required" });
  assert.equal(sel.backend.id, "hyperv-windows");
});
test("v0.6 hyperv backend 2: a windows-required task blocks when the Hyper-V backend is unavailable (no fallback)", async () => {
  await assert.rejects(selectVerificationBackend([stub("docker-linux", "osSandbox", "linux", true), stub("hyperv-windows", "vm", "windows", false)],
    { purpose: "autonomousWriter", platformRequirement: "windows-required" }), /No verification backend/u);
});
test("v0.6 hyperv backend 3: a linux-compatible task still selects docker-linux (never the Hyper-V backend)", async () => {
  const sel = await selectVerificationBackend([stub("docker-linux", "osSandbox", "linux", true), stub("hyperv-windows", "vm", "windows", true)],
    { purpose: "autonomousWriter", platformRequirement: "linux-compatible" });
  assert.equal(sel.backend.id, "docker-linux");
});
test("v0.6 hyperv backend 4: the unconfined trusted host is refused for an autonomous confined Writer", async () => {
  await assert.rejects(selectVerificationBackend([stub("trusted-host", "none", undefined, true)],
    { purpose: "autonomousWriter", platformRequirement: "windows-required" }), /No verification backend/u);
});

// ---- plan validation + malformed/missing capability (requirement 5) ----------------------------------------------
test("v0.6 hyperv backend 5: a malformed plan or non-pinned executable is refused; unknown platform fails closed", async () => {
  assert.throws(() => validateHyperVPlan({ commands: [] }, ["C:\\fusion\\node.exe"]), /between 1 and/u);
  assert.throws(() => validateHyperVPlan({ commands: [{ id: "t", executable: "node", args: [], cwd: ".", timeoutMs: 1, mutationPolicy: "readOnly" }] }, ["C:\\fusion\\node.exe"]), /allowlisted/u);
  assert.throws(() => validateHyperVPlan({ commands: [{ id: "t", executable: "C:\\fusion\\node.exe", args: [], cwd: "C:\\abs", timeoutMs: 1, mutationPolicy: "readOnly" }] }, ["C:\\fusion\\node.exe"]), /relative path/u);
  assert.throws(() => validateHyperVPlan({ commands: [{ id: "t", executable: "C:\\fusion\\node.exe", args: [], cwd: "..\\escape", timeoutMs: 1, mutationPolicy: "readOnly" }] }, ["C:\\fusion\\node.exe"]), /'\.\.'/u);
  // a non-windows docker engine makes the backend unavailable (fail closed)
  await withWorkspace(async (_root, nodeExe) => {
    const b = backendWith({ engineOs: "linux" }, nodeExe);
    const probe = await b.probe();
    assert.equal(probe.available, false);
    assert.equal(probe.reason, "docker-engine-not-windows");
  });
});

// ---- lifecycle: mutation / timeout / cancellation / primary unchanged / cleanup (requirements 6-10) ---------------
test("v0.6 hyperv backend 6: a read-only command that mutates the candidate FAILS (mutation detected)", async () => {
  await withWorkspace(async (root, nodeExe) => {
    const b = backendWith({ scenario: () => ({ exitCode: 0, violatesReadOnly: true, mutatedCandidate: true, passed: false }) }, nodeExe);
    const lease = await b.prepare(req(onePlan, root));
    const result = await b.run(lease, req(onePlan, root));
    assert.equal(result.passed, false);
    assert.equal(result.report.steps[0]!.status, "mutationViolation");
    assert.equal(result.hyperv.sourceMutated, true);
    await b.dispose(lease);
  });
});
test("v0.6 hyperv backend 7: a host-deadline timeout is classified distinctly (not a generic failure)", async () => {
  await withWorkspace(async (root, nodeExe) => {
    const b = backendWith({ runStatus: "timeout" }, nodeExe);
    const lease = await b.prepare(req(onePlan, root));
    const result = await b.run(lease, req(onePlan, root));
    assert.equal(result.passed, false);
    assert.equal(result.report.failure?.kind, "Timeout");
    await b.dispose(lease);
  });
});
test("v0.6 hyperv backend 8: a cancellation is classified distinctly from timeout and failure", async () => {
  await withWorkspace(async (root, nodeExe) => {
    const b = backendWith({ runStatus: "cancelled" }, nodeExe);
    const controller = new AbortController(); controller.abort();
    const lease = await b.prepare(req(onePlan, root));
    const result = await b.run(lease, req(onePlan, root, controller.signal));
    assert.equal(result.report.status, "cancelled");
    assert.equal(result.report.failure?.kind, "Cancelled");
    await b.dispose(lease);
  });
});
test("v0.6 hyperv backend 9: the primary workspace is only ever read (unchanged across prepare/run/dispose); network none + zero bind mounts", async () => {
  await withWorkspace(async (root, nodeExe) => {
    const before = await readFile(join(root, "a.txt"), "utf8");
    const b = backendWith({}, nodeExe);
    const lease = await b.prepare(req(onePlan, root));
    const result = await b.run(lease, req(onePlan, root));
    assert.equal(result.passed, true);
    assert.equal(result.hyperv.networkMode, "none");
    assert.equal(result.hyperv.bindMountCount, 0);
    await b.dispose(lease);
    assert.equal(await readFile(join(root, "a.txt"), "utf8"), before, "the primary workspace file is unchanged");
  });
});
test("v0.6 hyperv backend 10: dispose removes the worker + image + staging (no residue)", async () => {
  await withWorkspace(async (root, nodeExe) => {
    const { runner, calls } = fakeRunner({});
    const b = new HyperVWindowsVerificationBackend({ baseImage: PRODUCTION_WINDOWS_BASE_IMAGE, nodeExePath: nodeExe, runner, resolveDocker: async () => "docker" });
    const lease = await b.prepare(req(onePlan, root));
    await b.run(lease, req(onePlan, root));
    const cleanup = await b.dispose(lease);
    assert.equal(cleanup.complete, true);
    assert.ok(calls.some(c => c.startsWith("kill")), "worker killed");
    assert.ok(calls.some(c => c === "rm fusion-hvverify-" || c.startsWith("rm ")), "worker removed");
    assert.ok(calls.some(c => c.startsWith("rmi")), "image removed");
  });
});
// a smuggled bind mount in a worker-run argv is refused by the hardened allowlist
test("v0.6 hyperv backend 11: the hardened allowlist refuses a smuggled mount or non-none network or missing isolation", () => {
  assert.throws(() => assertSafeHyperVArgs(["run", "--isolation=hyperv", "--network", "none", "--mount", "type=bind,source=C:\\,target=C:\\h", "img"]), /refused/u);
  assert.throws(() => assertSafeHyperVArgs(["run", "--isolation=hyperv", "--network", "bridge", "img"]), /refused/u);
  assert.throws(() => assertSafeHyperVArgs(["run", "--network", "none", "img"]), /refused/u, "missing --isolation=hyperv");
  assert.throws(() => assertSafeHyperVArgs(["run", "--isolation=process", "--network", "none", "img"]), /refused/u);
  // the clean worker-run argv passes
  assert.doesNotThrow(() => assertSafeHyperVArgs(["run", "--name", "w", "--isolation=hyperv", "--network", "none", "img", "C:\\fusion\\node.exe"]));
});
