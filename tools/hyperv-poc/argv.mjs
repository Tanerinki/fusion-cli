// v0.6 Hyper-V PoC — WORKER COMMAND CONSTRUCTION (pure, unit-tested; builds argv, runs nothing).
//
// The synthetic worker must be launched with EXACTLY the isolation/network/mount shape the HARD boundary requires, and
// the harness must be able to PROVE that from the argv before anything runs: Hyper-V isolation is explicit (never the
// host default), the worker is on the dedicated PoC network (never the default bridge), NO host bind mount is exposed,
// and the Docker engine pipe is NOT handed in. `assertWorkerArgv` rejects an argv that violates any of these, so a
// future edit that (say) adds a `-v C:\:C:\host` mount fails a CI test instead of silently weakening the worker.

const FORBIDDEN_MOUNT_FLAGS = Object.freeze(["-v", "--volume", "--mount"]);

/**
 * Builds the `docker run` argv for the synthetic worker. `spec`:
 *   { name, image, network, isolation="hyperv", rm=true, env={}, cmd:[...], extra:[...] }
 * Env is passed as discrete `-e NAME=VALUE` pairs (host-constructed; the worker cannot choose them). No bind mount and
 * no npipe is ever emitted. Throws if the caller tries to smuggle a mount/pipe flag through `extra`.
 */
/**
 * The canonical PoC OWNERSHIP prefix for a worker container name: `FusionV06Poc-<runId>` with an optional role suffix
 * (e.g. the process-tree worker `FusionV06Poc-<runId>-pt`). This is the SAME prefix provision/run/cleanup/inspect/
 * evaluator use (the Docker image is the lowercase-mandated `fusion-hv-poc-img:<runId>`, a tag, not a container name).
 */
export const WORKER_NAME_RE = /^FusionV06Poc-[A-Za-z0-9]{4,40}(-[A-Za-z0-9]+)?$/u;

export function buildWorkerRunArgs(spec) {
  const s = spec ?? {};
  if (typeof s.name !== "string" || !WORKER_NAME_RE.test(s.name)) throw new Error(`worker name must match ${WORKER_NAME_RE} (canonical FusionV06Poc-<runId>[-role])`);
  if (typeof s.image !== "string" || s.image.length === 0) throw new Error("image is required");
  if (typeof s.network !== "string" || s.network.length === 0) throw new Error("network is required");
  const isolation = s.isolation ?? "hyperv";
  if (isolation !== "hyperv") throw new Error(`this PoC requires --isolation=hyperv, refusing '${isolation}'`);
  const extra = Array.isArray(s.extra) ? s.extra : [];
  for (const e of extra) {
    const flag = String(e).split("=")[0];
    if (FORBIDDEN_MOUNT_FLAGS.includes(flag)) throw new Error(`a host mount flag (${flag}) is forbidden for the untrusted worker`);
    if (/npipe|\\\\\.\\pipe\\/iu.test(String(e))) throw new Error("a named-pipe mount is forbidden for the untrusted worker");
    if (/docker_engine|dockerDesktopLinuxEngine/iu.test(String(e))) throw new Error("the Docker engine pipe must never be exposed to the worker");
  }
  const args = ["run"];
  if (s.rm !== false) args.push("--rm");
  if (s.detach === true) args.push("-d");
  args.push("--name", s.name, `--isolation=${isolation}`, "--network", s.network);
  for (const [k, v] of Object.entries(s.env ?? {})) args.push("-e", `${k}=${v}`);
  args.push(...extra, s.image, ...(Array.isArray(s.cmd) ? s.cmd : []));
  return args;
}

/**
 * Asserts an argv upholds every worker-confinement invariant. Returns `{ ok, reasons }`. Used by the harness before a
 * launch and by CI so the invariants are mechanically checked, not just conventionally followed.
 */
export function assertWorkerArgv(args) {
  const reasons = [];
  if (!Array.isArray(args)) return { ok: false, reasons: ["argv is not an array"] };
  const has = (f) => args.includes(f);
  if (!args.includes("--isolation=hyperv")) reasons.push("missing explicit --isolation=hyperv");
  const netIdx = args.indexOf("--network");
  if (netIdx < 0 || netIdx + 1 >= args.length) reasons.push("missing --network <pocNet>");
  else if (args[netIdx + 1] === "default") reasons.push("worker must not use the default network");
  for (const f of FORBIDDEN_MOUNT_FLAGS) if (has(f)) reasons.push(`forbidden host mount flag present: ${f}`);
  if (args.some(a => /npipe|\\\\\.\\pipe\\/iu.test(String(a)))) reasons.push("a named-pipe mount is present");
  if (args.some(a => /docker_engine|dockerDesktopLinuxEngine/iu.test(String(a)))) reasons.push("the Docker engine pipe is exposed");
  if (!has("--rm")) reasons.push("worker is not ephemeral (--rm missing) — stale-worker risk");
  return { ok: reasons.length === 0, reasons };
}

/**
 * Builds the `docker run` argv for the mapped-pipe / --network none worker: Hyper-V isolation, NO network endpoint, and
 * EXACTLY ONE npipe mount (the per-run Fusion pipe) - no bind mount, no Docker engine pipe, no other mount. `spec`:
 * { name, image, pipe (the \\.\pipe\... path, same source+target), env, cmd, rm=true, detach=true }.
 */
export function buildPipeWorkerRunArgs(spec) {
  const s = spec ?? {};
  if (typeof s.name !== "string" || !WORKER_NAME_RE.test(s.name)) throw new Error(`worker name must match ${WORKER_NAME_RE}`);
  if (typeof s.image !== "string" || s.image.length === 0) throw new Error("image is required");
  if (typeof s.pipe !== "string" || !/^\\\\\.\\pipe\\FusionV06Poc-[A-Za-z0-9-]+$/u.test(s.pipe)) throw new Error("pipe must be \\\\.\\pipe\\FusionV06Poc-<runId>...");
  if (/docker_engine|dockerDesktopLinuxEngine/iu.test(s.pipe)) throw new Error("refusing to map the Docker engine pipe");
  const args = ["run"];
  if (s.rm !== false) args.push("--rm");
  if (s.detach !== false) args.push("-d");
  args.push("--name", s.name, "--isolation=hyperv", "--network", "none", "--mount", `type=npipe,source=${s.pipe},target=${s.pipe}`);
  for (const [k, v] of Object.entries(s.env ?? {})) args.push("-e", `${k}=${v}`);
  args.push(s.image, ...(Array.isArray(s.cmd) ? s.cmd : []));
  return args;
}

/** Asserts the pipe-worker argv upholds the no-NIC / single-pipe invariants. Returns { ok, reasons }. */
export function assertPipeWorkerArgv(args) {
  const reasons = [];
  if (!Array.isArray(args)) return { ok: false, reasons: ["argv is not an array"] };
  if (!args.includes("--isolation=hyperv")) reasons.push("missing --isolation=hyperv");
  const ni = args.indexOf("--network");
  if (ni < 0 || args[ni + 1] !== "none") reasons.push("worker must be --network none (no NIC)");
  for (const f of ["-v", "--volume"]) if (args.includes(f)) reasons.push(`forbidden bind-mount flag: ${f}`); // --mount is allowed ONLY for the single npipe, checked below
  const mounts = args.reduce((acc, a, i) => (a === "--mount" ? [...acc, String(args[i + 1] ?? "")] : acc), []);
  if (mounts.length !== 1) reasons.push(`expected exactly one --mount (the Fusion pipe), got ${mounts.length}`);
  if (mounts.some(m => !/^type=npipe,source=\\\\\.\\pipe\\FusionV06Poc-/u.test(m))) reasons.push("the only mount must be the Fusion npipe");
  if (args.some(a => /docker_engine|dockerDesktopLinuxEngine/iu.test(String(a)))) reasons.push("the Docker engine pipe must never be mapped");
  if (mounts.some(m => /type=bind/iu.test(m))) reasons.push("no bind mount is allowed");
  if (!args.includes("--rm")) reasons.push("worker is not ephemeral (--rm missing)");
  return { ok: reasons.length === 0, reasons };
}

/** Builds `docker network inspect` argv to read the PoC network's HNS id deterministically. */
export function buildNetworkInspectArgs(networkName) {
  return ["network", "inspect", networkName, "--format", "{{json .}}"];
}

/** Builds `docker inspect` argv for the worker container (JSON). */
export function buildContainerInspectArgs(containerName) {
  return ["inspect", containerName, "--format", "{{json .}}"];
}
