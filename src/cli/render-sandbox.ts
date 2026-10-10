import type { SandboxDoctorReport, SandboxProvisionResult } from "../app/sandbox.js";

/** `fusion sandbox doctor` — the seven mechanically-distinguished posture facts, plus the overall posture. */
export function renderSandboxDoctor(r: SandboxDoctorReport): string {
  const p = r.posture;
  const lines: string[] = ["Fusion sandbox posture", ""];
  if (!r.launcherBuilt)
    lines.push("backend: the AppContainer launcher is NOT built — nothing is enforced.",
      "  build it: powershell -File native/fusion-sandbox/build.ps1", "");
  lines.push(
    `overall posture:            ${p.posture} (for identity ${r.identity})`,
    `filesystem isolation:       ${label(p.filesystem)}`,
    `process-tree containment:   ${label(p.processTree)}`,
    `environment minimization:   ${label(p.environmentMinimization)}`,
    `network canary:             ${p.canaryNetworkDenial === "proven" ? "a fresh, un-exempted identity is OS-denied all network" : "not proven"}`,
    `network (deny-all):         ${denyAll(p.denyAllNetwork)}`,
    `network (provider allowlist): ${allowlist(p.allowlistNetwork)}`,
    `loopback exemption:         ${p.loopbackBroker}`,
    `broker-only loopback:       ${p.brokerOnlyLoopback === "NOT_PROVEN" ? "NOT PROVEN" : "n/a (no loopback exemption)"}`,
    `sandbox identity:           ${r.identity}`,
    `package SID:                ${r.packageSid ?? "(unavailable)"}`,
  );
  if (p.loopbackBroker === "present")
    lines.push("", "warning: this identity has a loopback exemption, so it can reach ANY service on 127.0.0.1, not only the",
      "         Fusion broker. LoopbackExempt is per package with no port granularity, and loopback traffic is not filtered",
      "         by the firewall. Deny-all network is therefore NOT enforced for it, broker-only loopback is NOT PROVEN, and",
      "         its posture is at most CONFINED. The network canary's proof applies only to identities without an exemption.");
  if (p.loopbackBroker === "unknown" && r.launcherBuilt)
    lines.push("", "warning: this identity's loopback-exemption state could not be read, so deny-all network is not established for it.");
  if (p.allowlistNetwork === "NOT_PROVISIONED")
    lines.push("", "note: a provider ALLOWLIST is not provisioned. Run `fusion sandbox install --allow <host:port> ...`",
      "      (a one-time elevated step). There is no unrestricted fallback.");
  if (p.allowlistNetwork === "BROKEN")
    lines.push("", "warning: a loopback exemption exists but the host broker is not verified — the allowlist is NOT enforceable (fail closed).");
  lines.push("", "Posture is HARD only where a canary mechanically proved OS denial for this identity; nothing is HARD merely because rules exist.");
  return lines.join("\n");
}
const label = (v: "HARD" | "unavailable" | "unknown"): string => v === "HARD" ? "HARD (canary-proven)" : v === "unavailable" ? "NOT enforced" : "unknown (not probed)";
const denyAll = (v: SandboxDoctorReport["posture"]["denyAllNetwork"]): string => v === "enforced" ? "HARD (OS-enforced for this identity)"
  : v === "notEnforced" ? "NOT enforced for this identity (loopback-exempt: unrelated localhost services are reachable)"
  : "not proven for this identity";
const allowlist = (s: SandboxDoctorReport["posture"]["allowlistNetwork"]): string => ({
  DENY_ALL_ENFORCED: "n/a (deny-all enforced; no allowlist requested)", NOT_REQUESTED: "n/a (no allowlist requested)",
  ALLOWLIST_READY: "READY at the broker (loopback + verified broker; broker-only loopback NOT PROVEN)",
  NOT_PROVISIONED: "not provisioned", BROKEN: "BROKEN (loopback present, broker unverified)", STALE: "STALE",
}[s]);

/** `fusion sandbox install` / `uninstall` — the plan, the exact elevated command (the gate), or the applied result. */
export function renderSandboxProvision(r: SandboxProvisionResult): string {
  const lines: string[] = [`Fusion sandbox ${r.action}`, ""];
  if (r.plan === null) return `${lines.join("\n")}${r.message}`;
  lines.push(`package SID: ${r.packageSid}`, `firewall group: ${r.plan.group}`, "", "planned operations (scoped ONLY to this sandbox package SID):");
  for (const op of r.plan.ops) lines.push(`  - ${op.describes}`);
  lines.push("");
  if (r.applied) lines.push(`✓ ${r.message}`);
  else if (r.needsElevation) lines.push("This step needs one-time administrator elevation. Fusion does NOT elevate itself.", "", r.message);
  else lines.push(r.message);
  return lines.join("\n");
}
