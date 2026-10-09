import { failWith } from "../../../core/errors.js";

/**
 * Host-controlled configuration of the Windows Hyper-V verification worker, and a hardened allowlist for the `docker`
 * argv it may run. It is a SEPARATE seam from the Docker/Linux backend's (whose `assertSafeDockerArgs` forbids
 * `--isolation`, `exec` and `build` on purpose, because that backend streams input over stdin into a Linux container).
 * The Hyper-V backend uses the architecture proven live in tools/hyperv-poc: a disposable Hyper-V worker VM
 * (`--isolation=hyperv`), `--network none` (no NIC), NO host bind mount of any kind, the candidate snapshot TRANSFERRED
 * by being baked into a per-run image at build time, the approved VerificationPlan executed inside the worker, and the
 * result returned on the worker's own stdout (there is no host mount and `docker cp` is unsupported for a running
 * Hyper-V container). Every value that reaches the argv is produced here from validated host data, never from a model,
 * a task or repository content, and is always spawned directly (no shell).
 */
export const HYPERV_BACKEND_ID = "hyperv-windows";
export const HYPERV_PROTOCOL_VERSION = 1;

export const HYPERV_GUEST_PATHS = Object.freeze({
  root: "C:\\fusion",
  node: "C:\\fusion\\node.exe",
  candidate: "C:\\fusion\\candidate",
  runner: "C:\\fusion\\guest-runner.mjs",
});

export const HYPERV_OWNER_LABELS = Object.freeze({ owner: "fusion.owner", backend: "fusion.backend", run: "fusion.run",
  protocol: "fusion.protocol", created: "fusion.created" });

export const HYPERV_RUN_ID = /^[0-9a-f]{32}$/u;
export const HYPERV_CONTAINER_ID = /^[0-9a-f]{64}$/u;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/**
 * The validated Windows base image. nanoserver ltsc2025 (build 26100) is the image the live proof ran on; it is
 * referenced by tag because Windows base images are distributed by tag, and its identity is re-observed and recorded by
 * the probe (`expectedImageId` pins it when a digest is known). The backend NEVER pulls: an absent image is an operator
 * prerequisite, surfaced as unavailable, never fetched on demand.
 */
export const PRODUCTION_WINDOWS_BASE_IMAGE = "mcr.microsoft.com/windows/nanoserver:ltsc2025";
const BASE_IMAGE_REF = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9][A-Za-z0-9._-]{0,127}|@sha256:[0-9a-f]{64})$/u;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/u;

export const imageTagFor = (runId: string): string => `fusion-hv-verify:${runId}`;
export const workerNameFor = (runId: string): string => `fusion-hvverify-${runId}`;

export function assertBaseImage(reference: unknown): string {
  if (typeof reference !== "string" || reference.length > 256 || !BASE_IMAGE_REF.test(reference))
    failWith("InvalidInput", "The Hyper-V base image reference is invalid.");
  return reference;
}
export function assertImageId(id: unknown): string {
  if (typeof id !== "string" || !IMAGE_ID.test(id)) failWith("InvalidInput", "Image id must be sha256:<64 hex>.");
  return id;
}

export function hyperVOwnershipLabels(runId: string, createdAt: string): Readonly<Record<string, string>> {
  return Object.freeze({ [HYPERV_OWNER_LABELS.owner]: "true", [HYPERV_OWNER_LABELS.backend]: HYPERV_BACKEND_ID,
    [HYPERV_OWNER_LABELS.run]: runId, [HYPERV_OWNER_LABELS.protocol]: String(HYPERV_PROTOCOL_VERSION),
    [HYPERV_OWNER_LABELS.created]: createdAt });
}

/** Fusion ownership proven ONLY by all labels (never a name prefix), so a foreign or live object is never swept. */
export function isHyperVOwned(labels: unknown, runId?: string): boolean {
  if (labels === null || typeof labels !== "object" || Array.isArray(labels)) return false;
  const record = labels as Record<string, unknown>;
  const run = record[HYPERV_OWNER_LABELS.run], created = record[HYPERV_OWNER_LABELS.created];
  return record[HYPERV_OWNER_LABELS.owner] === "true" && record[HYPERV_OWNER_LABELS.backend] === HYPERV_BACKEND_ID &&
    typeof run === "string" && HYPERV_RUN_ID.test(run) && (runId === undefined || run === runId) &&
    record[HYPERV_OWNER_LABELS.protocol] === String(HYPERV_PROTOCOL_VERSION) &&
    typeof created === "string" && ISO_TIME.test(created) && !Number.isNaN(Date.parse(created));
}

const ALLOWED_SUBCOMMANDS = new Set(["version", "image", "container", "build", "create", "run", "start", "exec",
  "inspect", "kill", "rm", "rmi", "ps"]);
/** Flags that would weaken the Hyper-V worker; any of them, anywhere, is refused. */
const FORBIDDEN_FLAGS = new Set(["--privileged", "-v", "--volume", "--volumes-from", "--mount", "--device",
  "--device-cgroup-rule", "--gpus", "--cap-add", "--publish", "-p", "--publish-all", "-P", "--add-host", "--link",
  "--pid", "--userns", "--uts", "--ipc", "--dns", "--mac-address", "--sysctl", "--cgroup-parent", "--privileged-without-host-devices"]);

/**
 * Defense in depth for every Hyper-V docker invocation, independent of the builders. Refuses: any subcommand outside
 * the allowlist; any Docker-socket reference; any forbidden (container-weakening) flag — above all ANY mount/volume, so
 * the host filesystem can never be attached; and a `--network` value other than `none`. For a `create`/`start`-style
 * run it REQUIRES `--isolation=hyperv` and `--network none` to be present. `exec` is permitted only to run the pinned
 * in-image node on the guest runner (no host path can be introduced by exec). `build` is permitted with
 * `--isolation=hyperv`.
 */
export function assertSafeHyperVArgs(args: readonly string[]): void {
  const refuse = (): never => failWith("SecurityViolation", "A docker invocation outside the Hyper-V backend's hardened allowlist was refused.");
  if (!Array.isArray(args) || args.length === 0 || args.length > 256 ||
      !args.every(arg => typeof arg === "string" && !arg.includes("\0") && arg.length <= 8192)) refuse();
  const [command, sub] = args;
  if (!ALLOWED_SUBCOMMANDS.has(command!)) refuse();
  if ((command === "image" || command === "container") && sub !== "inspect") refuse();
  if (args.some(arg => /docker\.sock|docker_engine|dockerDesktop/iu.test(arg))) refuse();
  const valueOf = (index: number): string => {
    const arg = args[index]!, equals = arg.indexOf("=");
    return arg.startsWith("--") && equals > 0 ? arg.slice(equals + 1) : args[index + 1] ?? "";
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("-")) continue;
    const flag = arg.split("=", 1)[0]!;
    if (FORBIDDEN_FLAGS.has(flag)) refuse();
    if (flag === "--network" && valueOf(index) !== "none") refuse();
    if (flag === "--isolation" && valueOf(index) !== "hyperv") refuse();
  }
  // A worker create/run must be VM-isolated with no network (the two structural isolation invariants, enforced here
  // independently of the builder).
  if (command === "create" || command === "run") {
    if (!args.some((arg, index) => arg.split("=", 1)[0] === "--isolation" && valueOf(index) === "hyperv")) refuse();
    if (!args.some((arg, index) => arg.split("=", 1)[0] === "--network" && valueOf(index) === "none")) refuse();
  }
  if (command === "build" && !args.some((arg, index) => arg.split("=", 1)[0] === "--isolation" && valueOf(index) === "hyperv")) refuse();
}
