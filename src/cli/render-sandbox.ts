import type { SandboxDoctorReport, SandboxProvisionResult } from "../app/sandbox.js";

/** `fusion sandbox doctor` — the seven mechanically-distinguished posture facts, plus the overall posture. */
export function renderSandboxDoctor(r: SandboxDoctorReport): string {
  const p = r.posture;
  const lines: string[] = ["Fusion sandbox posture", ""];
  if (!r.launcherBuilt)
    lines.push("backend: the AppContainer launcher is NOT built — nothing is enforced.",
      "  build it: powershell -File native/fusion-sandbox/build.ps1", "");
  lines.push(
    `overall posture:            ${p.posture}`,
    `filesystem isolation:       ${label(p.filesystem)}`,
    `process-tree containment:   ${label(p.processTree)}`,
    `environment minimization:   ${label(p.environmentMinimization)}`,
    `network (deny-all):         ${p.denyAllNetwork === "enforced" ? "HARD (OS-enforced)" : "not proven"}`,
    `network (provider allowlist): ${allowlist(p.allowlistNetwork)}`,
    `loopback / broker:          ${p.loopbackBroker}`,
    `sandbox identity:           ${r.identity}`,
    `package SID:                ${r.packageSid ?? "(unavailable)"}`,
  );
  if (p.allowlistNetwork === "NOT_PROVISIONED")
    lines.push("", "note: a provider ALLOWLIST is not provisioned. Run `fusion sandbox install --allow <host:port> ...`",
      "      (a one-time elevated step). Deny-all remains OS-enforced meanwhile; there is no unrestricted fallback.");
  if (p.allowlistNetwork === "BROKEN")
    lines.push("", "warning: a loopback exemption exists but the host broker is not verified — the allowlist is NOT enforceable (fail closed).");
  lines.push("", "Posture is HARD only where a canary mechanically proved OS denial; nothing is HARD merely because rules exist.");
  return lines.join("\n");
}
const label = (v: "HARD" | "unavailable" | "unknown"): string => v === "HARD" ? "HARD (canary-proven)" : v === "unavailable" ? "NOT enforced" : "unknown (not probed)";
const allowlist = (s: SandboxDoctorReport["posture"]["allowlistNetwork"]): string => ({
  DENY_ALL_ENFORCED: "n/a (deny-all; no allowlist requested)", ALLOWLIST_READY: "READY (loopback + verified broker)",
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
