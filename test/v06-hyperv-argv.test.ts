import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const mod = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "hyperv-poc", "argv.mjs");
const { buildWorkerRunArgs, assertWorkerArgv, buildNetworkInspectArgs, buildContainerInspectArgs } = await import(pathToFileURL(mod).href);

const base = () => ({ name: "fusion-hv-poc-worker", image: "fusion-hv-poc-img:1", network: "fusion-hv-poc-net", cmd: ["C:\\fusion\\node.exe", "-e", "1"] });

test("v0.6 Hyper-V argv: the worker run is explicit --isolation=hyperv on the dedicated network, ephemeral", () => {
  const args = buildWorkerRunArgs(base());
  assert.ok(args.includes("--isolation=hyperv"), "isolation is explicit, never the host default");
  const ni = args.indexOf("--network");
  assert.equal(args[ni + 1], "fusion-hv-poc-net");
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
  assert.throws(() => buildWorkerRunArgs({ ...base(), name: "random-worker" }), /fusion-hv-poc/u);
});

test("v0.6 Hyper-V argv: inspect helpers request JSON", () => {
  assert.deepEqual(buildNetworkInspectArgs("fusion-hv-poc-net"), ["network", "inspect", "fusion-hv-poc-net", "--format", "{{json .}}"]);
  assert.deepEqual(buildContainerInspectArgs("fusion-hv-poc-worker"), ["inspect", "fusion-hv-poc-worker", "--format", "{{json .}}"]);
});
