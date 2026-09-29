import { failWith } from "../../core/errors.js";
import type { NetworkPolicy } from "../../core/isolation/network-policy.js";

/**
 * v0.6 network provisioning (§17, §22, §31) — PURE plan construction. The deterministic, non-elevated half of the
 * network boundary. It never runs anything; it builds the exact, idempotent, package-SID-scoped operations a later
 * elevated step applies, and it is what `fusion sandbox doctor` reasons about.
 *
 * Network architecture (honest): the sandbox AppContainer has NO network capability, so DIRECT internet is OS-DENIED
 * (proven by the `networkIsolation` canary). To let a provider reach ONLY its endpoint, the OS grants a single narrow
 * exception — a LOOPBACK exemption for the sandbox's package SID — so the sandboxed process can reach a HOST-SIDE BROKER
 * on 127.0.0.1, and the broker (trusted, outside the sandbox) enforces the FQDN ALLOWLIST at the application layer.
 * Thus the OS enforces "only loopback is reachable" (a package-SID-scoped rule) and the broker enforces "which host".
 * Classic Windows Firewall matches by IP/port, not FQDN, so an FQDN allowlist is NOT claimed as pure-OS enforcement;
 * the split is documented, not hidden. Every operation is scoped to Fusion's sandbox package SID and a named group, so
 * it never weakens or replaces firewall policy for other applications, and uninstall removes exactly what install added.
 */
export const PROVISION_GROUP = "FusionSandbox" as const;
const PACKAGE_SID = /^S-1-15-2(?:-\d{1,10}){1,8}$/u;

export type ProvisionOpKind = "loopbackExemptAdd" | "loopbackExemptRemove" | "firewallDenyEgress" | "firewallRemoveGroup";
export interface ProvisionOp {
  readonly kind: ProvisionOpKind;
  /** Whether this operation requires administrator elevation to APPLY. */
  readonly elevated: boolean;
  /** The exact executable + argv the elevated step runs (data, never a shell string). */
  readonly executable: "CheckNetIsolation" | "netsh";
  readonly args: readonly string[];
  /** A bounded, human-readable description of exactly what it changes (for the maintainer gate and audit). */
  readonly describes: string;
}
export interface ProvisionPlan {
  readonly packageSid: string;
  readonly group: typeof PROVISION_GROUP;
  readonly ops: readonly ProvisionOp[];
  /** True when every op is scoped to this package SID / group (never machine-wide). Asserted; a false plan is refused. */
  readonly scopedToSandboxOnly: true;
}

function assertSid(sid: string): void {
  if (typeof sid !== "string" || !PACKAGE_SID.test(sid)) failWith("InvalidInput", "The sandbox package SID is malformed.");
}

/**
 * The INSTALL plan: a package-SID-scoped loopback exemption (so the sandbox can reach the host broker) plus a
 * package-scoped default-deny outbound firewall rule (belt-and-braces: the AppContainer already has no network
 * capability; this makes the deny explicit and auditable, scoped to the SID). Idempotent by the named group + the SID.
 * The FQDN allowlist itself is enforced by the host broker, not here (see the module header).
 */
export function buildInstallPlan(packageSid: string, group: typeof PROVISION_GROUP = PROVISION_GROUP): ProvisionPlan {
  assertSid(packageSid);
  const ops: ProvisionOp[] = [
    { kind: "loopbackExemptAdd", elevated: true, executable: "CheckNetIsolation", args: ["LoopbackExempt", "-a", `-p=${packageSid}`],
      describes: `Add a loopback exemption for the sandbox package SID ${packageSid}, so the sandboxed provider can reach the host-side broker on 127.0.0.1 (and only there).` },
    { kind: "firewallDenyEgress", elevated: true, executable: "netsh", args: ["advfirewall", "firewall", "add", "rule",
      `name=${group} deny egress`, "dir=out", "action=block", `package=${packageSid}`, "remoteip=any", "enable=yes"],
      describes: `Add a default-deny OUTBOUND firewall rule scoped ONLY to the sandbox package SID ${packageSid} (group "${group}"). Other applications' rules are untouched.` },
  ];
  return Object.freeze({ packageSid, group, ops: Object.freeze(ops), scopedToSandboxOnly: true });
}

/** The UNINSTALL / reconciliation plan: removes exactly this SID's loopback exemption and the named firewall group. */
export function buildUninstallPlan(packageSid: string, group: typeof PROVISION_GROUP = PROVISION_GROUP): ProvisionPlan {
  assertSid(packageSid);
  const ops: ProvisionOp[] = [
    { kind: "loopbackExemptRemove", elevated: true, executable: "CheckNetIsolation", args: ["LoopbackExempt", "-d", `-p=${packageSid}`],
      describes: `Remove the loopback exemption for the sandbox package SID ${packageSid}.` },
    { kind: "firewallRemoveGroup", elevated: true, executable: "netsh", args: ["advfirewall", "firewall", "delete", "rule", `name=${group} deny egress`],
      describes: `Remove the "${group}" firewall rule for this sandbox. No other application's rules are affected.` },
  ];
  return Object.freeze({ packageSid, group, ops: Object.freeze(ops), scopedToSandboxOnly: true });
}

/**
 * Validates that a plan is safe to apply: every op is scoped to THIS package SID or the named group, and never machine-
 * wide (no `-p` without the exact SID, no rule without the group/package). A plan that would touch broader policy is
 * refused — Fusion never weakens another application's firewall (requirement #4).
 */
export function assertScopedPlan(plan: ProvisionPlan): void {
  assertSid(plan.packageSid);
  for (const op of plan.ops) {
    const joined = op.args.join(" ");
    if (op.executable === "CheckNetIsolation") {
      if (!op.args.includes(`-p=${plan.packageSid}`)) failWith("SecurityViolation", "A loopback operation is not scoped to the sandbox package SID.");
    } else {
      if (!joined.includes(`package=${plan.packageSid}`) && !joined.includes(plan.group)) failWith("SecurityViolation", "A firewall operation is not scoped to the sandbox package SID or group.");
      if (joined.includes("dir=in") && joined.includes("action=allow")) failWith("SecurityViolation", "A provisioning op must not add an inbound allow rule.");
    }
  }
}

/** The exact elevated PowerShell command line for an install plan — the ONE command the maintainer runs (the gate). */
export function elevatedCommandLine(plan: ProvisionPlan): string {
  return plan.ops.filter(op => op.elevated).map(op => `${op.executable} ${op.args.map(a => (/\s/u.test(a) ? `"${a}"` : a)).join(" ")}`).join("; ");
}

// ---------------------------------------------------------------- posture model (§5 of the network requirements)

/** The seven distinctions `fusion sandbox doctor` must mechanically report. */
export type NetworkProvisionState = "DENY_ALL_ENFORCED" | "ALLOWLIST_READY" | "NOT_PROVISIONED" | "BROKEN" | "STALE";
export interface SandboxPostureReport {
  readonly filesystem: "HARD" | "unavailable" | "unknown";
  readonly processTree: "HARD" | "unavailable" | "unknown";
  readonly environmentMinimization: "HARD" | "unknown";
  readonly denyAllNetwork: "enforced" | "unknown";
  readonly allowlistNetwork: NetworkProvisionState;
  readonly loopbackBroker: "present" | "absent" | "unknown";
  /** The overall posture a caller may act on. HARD requires FS+process+deny-all enforced. */
  readonly posture: "HARD" | "CONFINED" | "UNAVAILABLE";
}

export interface PostureInputs {
  /** From the AppContainer canary: filesystem + process-tree + deny-all-network all mechanically proven. */
  readonly canary: Readonly<{ filesystem: boolean; processTree: boolean; denyAllNetwork: boolean; complete: boolean }> | null;
  /** Whether the environment-minimization contract holds (deterministic; always true — it is pure host logic). */
  readonly environmentMinimized: boolean;
  /** Whether a loopback exemption for the sandbox package SID currently exists (read non-elevated). */
  readonly loopbackExempt: boolean;
  /** Whether the requested ALLOWLIST policy could be REPRESENTED (a valid endpoint set). */
  readonly allowlistRequested: boolean;
  /** Whether the host broker enforcing the FQDN allowlist is verified reachable/working (a safe local canary). */
  readonly brokerVerified: boolean;
}

/**
 * Derives the doctor posture from mechanically-observed facts. It NEVER calls posture HARD merely because rules exist:
 * filesystem/process/deny-all come only from the canary; the allowlist is `ALLOWLIST_READY` only when the loopback
 * exemption exists AND the broker was verified. Missing/partial provisioning is reported explicitly, never as success.
 */
export function derivePosture(inputs: PostureInputs): SandboxPostureReport {
  const fs = inputs.canary === null ? "unknown" : inputs.canary.filesystem ? "HARD" : "unavailable";
  const pt = inputs.canary === null ? "unknown" : inputs.canary.processTree ? "HARD" : "unavailable";
  const deny = inputs.canary?.denyAllNetwork === true ? "enforced" : "unknown";
  const allowlist: NetworkProvisionState = !inputs.allowlistRequested ? "DENY_ALL_ENFORCED"
    : inputs.loopbackExempt && inputs.brokerVerified ? "ALLOWLIST_READY"
    : inputs.loopbackExempt && !inputs.brokerVerified ? "BROKEN"
    : "NOT_PROVISIONED";
  const posture = fs === "HARD" && pt === "HARD" && deny === "enforced" ? "HARD"
    : fs === "HARD" && pt === "HARD" ? "CONFINED" : "UNAVAILABLE";
  return Object.freeze({ filesystem: fs, processTree: pt, environmentMinimization: inputs.environmentMinimized ? "HARD" : "unknown",
    denyAllNetwork: deny, allowlistNetwork: allowlist, loopbackBroker: inputs.loopbackExempt ? "present" : inputs.canary === null ? "unknown" : "absent", posture });
}

/**
 * Fail-closed decision for a provider execution that REQUIRES a network ALLOWLIST (§7): if the allowlist cannot be
 * enforced (not provisioned, broken, or stale), the execution must be refused with NETWORK_POLICY_UNAVAILABLE —
 * NEVER an unrestricted-network fallback.
 */
export type NetworkEnforcementFailure = "NETWORK_POLICY_UNAVAILABLE" | "HARD_ISOLATION_UNAVAILABLE";
export function allowlistEnforceable(report: SandboxPostureReport, policy: NetworkPolicy):
  Readonly<{ ok: true } | { ok: false; failure: NetworkEnforcementFailure }> {
  if (policy.mode === "DENY_ALL") return report.denyAllNetwork === "enforced" ? { ok: true } : { ok: false, failure: "HARD_ISOLATION_UNAVAILABLE" };
  return report.allowlistNetwork === "ALLOWLIST_READY" ? { ok: true } : { ok: false, failure: "NETWORK_POLICY_UNAVAILABLE" };
}
