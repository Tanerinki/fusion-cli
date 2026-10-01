import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const pocDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "hyperv-poc");
const mod = join(pocDir, "argv.mjs");
const { buildWorkerRunArgs, assertWorkerArgv, buildNetworkInspectArgs, buildContainerInspectArgs } = await import(pathToFileURL(mod).href);

// The EXACT names the live path uses (run.ps1 / elevated-run.ps1): FusionV06Poc-<runId> and the -pt process-tree worker.
const RUN_ID = "r251001120000";
const base = () => ({ name: `FusionV06Poc-${RUN_ID}`, image: `fusion-hv-poc-img:${RUN_ID}`, network: `FusionV06Poc-${RUN_ID}-net`, cmd: ["C:\\fusion\\node.exe", "-e", "1"] });

test("v0.6 Hyper-V argv: the worker run is explicit --isolation=hyperv on the dedicated network, ephemeral", () => {
  const args = buildWorkerRunArgs(base());
  assert.ok(args.includes("--isolation=hyperv"), "isolation is explicit, never the host default");
  const ni = args.indexOf("--network");
  assert.equal(args[ni + 1], `FusionV06Poc-${RUN_ID}-net`);
  assert.ok(args.includes("--rm"));
  assert.equal(assertWorkerArgv(args).ok, true);
});

test("v0.6 Hyper-V argv: a non-hyperv isolation is refused at build time", () => {
  assert.throws(() => buildWorkerRunArgs({ ...base(), isolation: "process" }), /hyperv/u);
});

test("v0.6 Hyper-V argv: detach adds -d while keeping --rm, isolation, network, and still passing the invariant check", () => {
  const args = buildWorkerRunArgs({ ...base(), detach: true });
  assert.ok(args.includes("-d") && args.includes("--rm") && args.includes("--isolation=hyperv"), "detached worker is still ephemeral and hyperv-isolated");
  assert.equal(assertWorkerArgv(args).ok, true, "the detached argv still upholds every worker-confinement invariant");
});

test("v0.6 Hyper-V argv: a host bind mount or named pipe can never be smuggled into the worker", () => {
  assert.throws(() => buildWorkerRunArgs({ ...base(), extra: ["-v", "C:\\:C:\\host"] }), /mount/u);
  assert.throws(() => buildWorkerRunArgs({ ...base(), extra: ["--mount", "type=bind,src=C:\\,dst=C:\\host"] }), /mount/u);
  assert.throws(() => buildWorkerRunArgs({ ...base(), extra: ["--mount", "type=npipe,source=\\\\.\\pipe\\docker_engine,target=\\\\.\\pipe\\docker_engine"] }), /pipe|mount/u);
});

test("v0.6 Hyper-V argv: assertWorkerArgv rejects an argv that drops isolation, the network, or adds a mount/pipe", () => {
  assert.equal(assertWorkerArgv(["run", "--rm", "--network", "fusion-hv-poc-net", "img"]).ok, false, "no isolation");
  assert.equal(assertWorkerArgv(["run", "--rm", "--isolation=hyperv", "img"]).ok, false, "no network");
  assert.equal(assertWorkerArgv(["run", "--isolation=hyperv", "--network", "fusion-hv-poc-net", "img"]).ok, false, "not ephemeral");
  assert.equal(assertWorkerArgv(["run", "--rm", "--isolation=hyperv", "--network", "fusion-hv-poc-net", "-v", "C:\\:C:\\h", "img"]).ok, false, "mount");
  assert.equal(assertWorkerArgv(["run", "--rm", "--isolation=hyperv", "--network", "default", "img"]).ok, false, "default network");
});

test("v0.6 Hyper-V argv: host-constructed env is passed as discrete -e pairs (the worker cannot choose them)", () => {
  const args: string[] = buildWorkerRunArgs({ ...base(), env: { FUSION_PROBE_SPEC: "e30=", HTTPS_PROXY: "http://fusion:tok@10.250.37.1:47610" } });
  const es: string[] = [];
  args.forEach((a: string, i: number) => { const next = args[i + 1]; if (a === "-e" && typeof next === "string") es.push(next); });
  assert.ok(es.includes("FUSION_PROBE_SPEC=e30="));
  assert.ok(es.some((e: string) => e.startsWith("HTTPS_PROXY=")));
});

test("v0.6 Hyper-V argv: a bad worker name is refused (prefix ownership)", () => {
  assert.throws(() => buildWorkerRunArgs({ ...base(), name: "random-worker" }), /FusionV06Poc|canonical/u);
});

test("v0.6 Hyper-V argv: inspect helpers request JSON", () => {
  assert.deepEqual(buildNetworkInspectArgs("fusion-hv-poc-net"), ["network", "inspect", "fusion-hv-poc-net", "--format", "{{json .}}"]);
  assert.deepEqual(buildContainerInspectArgs("fusion-hv-poc-worker"), ["inspect", "fusion-hv-poc-worker", "--format", "{{json .}}"]);
});

test("v0.6 Hyper-V argv: the REAL build-run-args.mjs accepts the exact live worker names (FusionV06Poc-<runId> and -pt)", () => {
  const cli = join(pocDir, "build-run-args.mjs");
  for (const name of [`FusionV06Poc-${RUN_ID}`, `FusionV06Poc-${RUN_ID}-pt`]) {
    const out = execFileSync(process.execPath, [cli, name, `fusion-hv-poc-img:${RUN_ID}`, `FusionV06Poc-${RUN_ID}-net`, "C:\fusion\node.exe", "-e", "1", "--detach", "--env", "HTTPS_PROXY=http://fusion:tok@10.250.37.1:47610"], { encoding: "utf8" });
    const args = JSON.parse(out);
    assert.ok(args.includes("--isolation=hyperv") && args.includes("-d") && args.includes("--rm"), `argv ok for ${name}`);
    const ni = args.indexOf("--network");
    assert.equal(args[ni + 1], `FusionV06Poc-${RUN_ID}-net`);
    assert.equal(assertWorkerArgv(args).ok, true, `assertWorkerArgv passes for ${name}`);
  }
});

test("v0.6 Hyper-V argv: build-run-args.mjs exits non-zero (fails closed) on a non-canonical worker name", () => {
  const cli = join(pocDir, "build-run-args.mjs");
  assert.throws(() => execFileSync(process.execPath, [cli, "fusion-hv-poc-worker", "img:1", "net", "C:\node.exe", "-e", "1"], { encoding: "utf8", stdio: "pipe" }), /./u,
    "the old fusion-hv-poc-* name no longer builds an argv");
});
