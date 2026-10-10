import { join } from "node:path";
import { ProcessSupervisor } from "../platform/process/supervisor.js";
import { locateLauncher, probeAppContainerBackend, type LauncherIdentity } from "../platform/isolation/appcontainer-backend.js";
import {
  allowlistEnforceable, assertScopedPlan, buildInstallPlan, buildUninstallPlan, derivePosture, elevatedCommandLine,
  loopbackExemptFromListing, PROVISION_GROUP, type LoopbackExemptState, type ProvisionPlan, type SandboxPostureReport,
} from "../platform/isolation/network-provisioning.js";
import { networkPolicy, type NetworkDestination } from "../core/isolation/network-policy.js";

/**
 * v0.6 — `fusion sandbox` host logic (doctor / install / uninstall). The NON-ELEVATED side is complete here: it derives
 * the sandbox package SID, probes real posture with canaries, reads the loopback-exemption state, and BUILDS the
 * idempotent, SID-scoped provisioning plan. Applying the plan needs one-time administrator elevation; this module
 * NEVER elevates itself — when not elevated it returns the plan and the exact one command for the maintainer (the gate).
 */
export const DEFAULT_SANDBOX_IDENTITY = "fusion.sandbox.default" as const;
const system32 = (exe: string): string => join(process.env.SystemRoot ?? "C:\\Windows", "System32", exe);

async function runNative(executable: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string }> {
  const running = new ProcessSupervisor().start({ executable, args: [...args], cwd: process.env.SystemRoot ?? "C:\\Windows",
    env: { SystemRoot: env.SystemRoot ?? "C:\\Windows", PATH: env.PATH ?? "", windir: env.windir ?? "C:\\Windows" },
    timeoutMs: 20_000, stdoutDecoding: "replace" });
  const outcome = await running.result;
  return { code: outcome.exitCode, stdout: outcome.stdout };
}

/** Derives the AppContainer package SID for an identity via the native launcher (deterministic, non-elevated). */
export async function deriveSandboxSid(identity: string, launcher: LauncherIdentity, env = process.env): Promise<string | null> {
  const { code, stdout } = await runNative(launcher.path, ["--derive-sid", identity], env);
  const sid = stdout.trim();
  return code === 0 && /^S-1-15-2(?:-\d{1,10}){1,8}$/u.test(sid) ? sid : null;
}

/**
 * Whether a loopback exemption for `sid` currently exists: a non-elevated READ of `CheckNetIsolation LoopbackExempt -s`
 * with an exact SID match. A failed read is `unknown`, never "absent": absence is what would let deny-all be HARD.
 */
export async function readLoopbackExempt(sid: string, env = process.env): Promise<LoopbackExemptState> {
  const { code, stdout } = await runNative(system32("CheckNetIsolation.exe"), ["LoopbackExempt", "-s"], env);
  return loopbackExemptFromListing(code, stdout, sid);
}

/** Whether this process is elevated (administrator). `net session` succeeds only for an elevated token. */
export async function isElevated(env = process.env): Promise<boolean> {
  const { code } = await runNative(system32("net.exe"), ["session"], env);
  return code === 0;
}

export interface SandboxDoctorReport {
  readonly launcherBuilt: boolean;
  readonly packageSid: string | null;
  readonly identity: string;
  readonly posture: SandboxPostureReport;
  /** The confinement facts that failed, if any (for a precise diagnosis). */
  readonly canaryComplete: boolean;
}

/**
 * `fusion sandbox doctor` — the real posture. Non-elevated. It:
 * - runs the launcher's confinement canary (filesystem / process / network, mechanically), under a FRESH, un-exempted
 *   identity;
 * - derives the REPORTED identity's package SID and reads ITS loopback-exemption state;
 * - reports both separately.
 * It NEVER calls a dimension HARD without a passing canary. It never lets the canary's network proof stand for an
 * identity that is loopback-exempt, or whose exemption state is unknown. Needs the launcher built
 * (`native/fusion-sandbox/build.ps1`); without it everything is UNAVAILABLE / not proven.
 */
export async function sandboxDoctor(options: Readonly<{ identity?: string; allowlist?: readonly NetworkDestination[]; root?: string; env?: NodeJS.ProcessEnv }> = {}): Promise<SandboxDoctorReport> {
  const identity = options.identity ?? DEFAULT_SANDBOX_IDENTITY;
  const env = options.env ?? process.env;
  const launcher = await locateLauncher(options.root);
  if (launcher === null) {
    return Object.freeze({ launcherBuilt: false, packageSid: null, identity, canaryComplete: false,
      posture: derivePosture({ canary: null, environmentMinimized: true, loopbackExempt: "unknown", allowlistRequested: (options.allowlist?.length ?? 0) > 0, brokerVerified: false }) });
  }
  const probe = await probeAppContainerBackend(options.root === undefined ? {} : { root: options.root });
  const sid = await deriveSandboxSid(identity, launcher, env);
  // Without the SID the identity's exemption state cannot be read: unknown, never "absent".
  const loopbackExempt: LoopbackExemptState = sid === null ? "unknown" : await readLoopbackExempt(sid, env);
  const complete = probe.available;
  const posture = derivePosture({
    canary: { filesystem: probe.dimensions.filesystem === "enforced", processTree: probe.dimensions.processTree === "enforced",
      denyAllNetwork: probe.dimensions.network === "enforced", complete },
    environmentMinimized: true, loopbackExempt, allowlistRequested: (options.allowlist?.length ?? 0) > 0,
    // The broker is a separate host-side component; until it is verified reachable, the allowlist is not READY.
    brokerVerified: false,
  });
  return Object.freeze({ launcherBuilt: true, packageSid: sid, identity, posture, canaryComplete: complete });
}

export interface SandboxProvisionResult {
  readonly action: "install" | "uninstall";
  readonly packageSid: string | null;
  readonly plan: ProvisionPlan | null;
  readonly applied: boolean;
  readonly needsElevation: boolean;
  /** The exact single elevated command the maintainer runs (present when not elevated). */
  readonly elevatedCommand: string | null;
  readonly message: string;
}

async function resolvePlan(action: "install" | "uninstall", identity: string, allowlist: readonly NetworkDestination[], root: string | undefined, env: NodeJS.ProcessEnv):
  Promise<Readonly<{ sid: string; plan: ProvisionPlan }> | Readonly<{ error: string }>> {
  const launcher = await locateLauncher(root);
  if (launcher === null) return { error: "The sandbox launcher is not built. Build it first: powershell -File native/fusion-sandbox/build.ps1" };
  const sid = await deriveSandboxSid(identity, launcher, env);
  if (sid === null) return { error: "Could not derive the sandbox package SID." };
  // The allowlist is validated (fail closed on a malformed endpoint) but enforced by the host broker, not these rules.
  if (allowlist.length > 0) networkPolicy({ mode: "ALLOWLIST", loopback: "allow", allowed: allowlist });
  const plan = action === "install" ? buildInstallPlan(sid, PROVISION_GROUP) : buildUninstallPlan(sid, PROVISION_GROUP);
  assertScopedPlan(plan); // refuses any op not scoped to this SID / group
  return { sid, plan };
}

/**
 * `fusion sandbox install` — builds the idempotent, SID-scoped provisioning plan. If NOT elevated, it returns the plan
 * and the exact one command, and does not elevate (the maintainer gate). If elevated, it applies each op and verifies.
 */
export async function sandboxInstall(options: Readonly<{ identity?: string; allowlist?: readonly NetworkDestination[]; root?: string; env?: NodeJS.ProcessEnv }> = {}): Promise<SandboxProvisionResult> {
  return provision("install", options);
}
export async function sandboxUninstall(options: Readonly<{ identity?: string; root?: string; env?: NodeJS.ProcessEnv }> = {}): Promise<SandboxProvisionResult> {
  return provision("uninstall", options);
}

async function provision(action: "install" | "uninstall", options: Readonly<{ identity?: string; allowlist?: readonly NetworkDestination[]; root?: string; env?: NodeJS.ProcessEnv }>): Promise<SandboxProvisionResult> {
  const identity = options.identity ?? DEFAULT_SANDBOX_IDENTITY;
  const env = options.env ?? process.env;
  const resolved = await resolvePlan(action, identity, options.allowlist ?? [], options.root, env);
  if ("error" in resolved) return Object.freeze({ action, packageSid: null, plan: null, applied: false, needsElevation: false, elevatedCommand: null, message: resolved.error });
  const { sid, plan } = resolved;
  const command = elevatedCommandLine(plan);
  if (!await isElevated(env)) {
    return Object.freeze({ action, packageSid: sid, plan, applied: false, needsElevation: true, elevatedCommand: command,
      message: `Run this ONCE from an elevated PowerShell (it is scoped only to Fusion's sandbox package SID ${sid}; other applications' firewall policy is untouched):\n  ${command}` });
  }
  // Elevated: apply each op, then verify. (Exercised on the maintainer's elevated run; the non-elevated path above is
  // what CI and the deterministic tests cover.)
  for (const op of plan.ops) {
    const exe = op.executable === "netsh" ? system32("netsh.exe") : system32("CheckNetIsolation.exe");
    await runNative(exe, op.args, env);
  }
  const ok = provisionVerified(action, await readLoopbackExempt(sid, env));
  return Object.freeze({ action, packageSid: sid, plan, applied: ok, needsElevation: false, elevatedCommand: command,
    message: ok ? `Sandbox network ${action} applied and verified for package SID ${sid}.` : `The ${action} did not verify; posture is unchanged.` });
}

/**
 * Pure: whether a provisioning step verified, from a definite read only. Install needs the exemption PRESENT;
 * uninstall needs it ABSENT; an unknown read verifies neither.
 */
export function provisionVerified(action: "install" | "uninstall", exemptNow: LoopbackExemptState): boolean {
  return action === "install" ? exemptNow === true : exemptNow === false;
}

export { allowlistEnforceable };
