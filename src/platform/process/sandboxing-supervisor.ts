import { DENY_ALL_NETWORK, type NetworkPolicy } from "../../core/isolation/network-policy.js";
import type { LauncherIdentity, SandboxRunSpec } from "../isolation/appcontainer-backend.js";
import { ProcessSupervisor, type ProcessSpec, type RunningProcess } from "./supervisor.js";
import { prepareSandboxLaunchSync } from "./sandboxed-spawn.js";

/**
 * v0.6 I11 — the SANDBOXING SUPERVISOR. Under HARD posture, EVERY provider-executable invocation of a turn (auth
 * readback, plugin/runtime discovery, posture attestation, quarantine verification, and the model turn) must run inside
 * the AppContainer — no `claude.exe`/provider process ever executes on the host. This wrapper enforces that structurally:
 * it attaches a `SandboxLaunch` to every `start()`, so the wrapped supervisor spawns the launcher (not the raw provider),
 * and the fail-closed refusal in `ProcessSupervisor.start` guarantees a raw provider is never spawned when the backend is
 * unavailable. Trusted host-side INSPECTION (config/settings/metadata/policy construction) stays outside — it never runs
 * the provider binary — so this changes only executions, not Fusion's own reasoning.
 *
 * The child's environment is the caller's minimized env PLUS the host-owned additions (the broker proxy env, the
 * subscription-token lane) — the provider cannot choose them. The workspace grants come from the profile: the provider
 * VIEW is read-only, its SCRATCH and the disposable CANARY workspace are writable, and the host profile / primary /
 * siblings / Fusion state are denied (by not granting them).
 */
export interface HardLaunchProfile {
  /** The located launcher, or `null` ⇒ HARD unavailable ⇒ every start fails closed (never a raw provider spawn). */
  readonly launcher: LauncherIdentity | null;
  readonly identity: string;
  /** Read-only grants (the provider view, the runtime, etc.). */
  readonly readPaths: readonly string[];
  /** Writable grants: the provider scratch and the disposable canary workspace (so canary side effects can reveal themselves). */
  readonly writePaths: readonly string[];
  /** The network policy (the broker ALLOWLIST). DENY_ALL by default. */
  readonly network?: NetworkPolicy;
  /** Host-owned env added to every child: the broker proxy env and any explicit credential lane. The provider cannot set these. */
  readonly childEnvAdditions?: Readonly<Record<string, string>>;
  readonly maxProcesses?: number;
  readonly tempBase?: string;
  /** Internal test seam: argv prepended to the launcher command (e.g. a node script standing in for the native launcher). Empty in production. */
  readonly launcherArgvPrefix?: readonly string[];
}

const stringEnv = (env: NodeJS.ProcessEnv): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") out[k] = v;
  return out;
};

export class SandboxingSupervisor extends ProcessSupervisor {
  constructor(private readonly inner: ProcessSupervisor, private readonly profile: HardLaunchProfile) { super(); }

  /** Every provider execution is wrapped in a sandbox launch; the wrapped supervisor's fail-closed path does the rest. */
  override start(spec: ProcessSpec): RunningProcess {
    const runSpec: SandboxRunSpec = {
      identity: this.profile.identity, workingDirectory: spec.cwd,
      readPaths: this.profile.readPaths, writePaths: this.profile.writePaths,
      executable: spec.executable, args: [...spec.args],
      timeoutMs: spec.timeoutMs ?? 120_000,
      ...(this.profile.maxProcesses === undefined ? {} : { maxProcesses: this.profile.maxProcesses }),
      env: { ...stringEnv(spec.env), ...(this.profile.childEnvAdditions ?? {}) },
      network: this.profile.network ?? DENY_ALL_NETWORK,
    };
    const base = prepareSandboxLaunchSync(this.profile.launcher, runSpec, this.profile.tempBase === undefined ? {} : { tempBase: this.profile.tempBase });
    const prefix = this.profile.launcherArgvPrefix ?? [];
    const sandbox = prefix.length === 0 || !base.available ? base : Object.freeze({ ...base, args: Object.freeze([...prefix, ...base.args]) });
    return this.inner.start({ ...spec, sandbox });
  }
}
