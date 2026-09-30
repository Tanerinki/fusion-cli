// v0.6 Hyper-V PoC — host-probe EVALUATOR (pure, unit-tested in CI). Given the READ-ONLY capability data host-probe.ps1
// collects, it computes HYPERV_HOST_PROBE=PASS/INCOMPLETE, the exact missing prerequisites, and a recommended PoC stack —
// so the verdict is not a human guess. PASS means "this host can ATTEMPT the Option-C PoC", NOT that the PoC passes.
//
// Bounded data only: the evaluator reads a fixed set of capability fields (booleans / short version+state strings / short
// name+type lists). It never reads secrets, credentials, file contents, environment values, or user/browser/SSH state, and
// `assertBounded` rejects any report that carries a field outside the allow-list.

/** The only top-level keys a host-probe report may contain (bounded output schema). */
export const ALLOWED_KEYS = Object.freeze([
  "schema", "generatedAt", "os", "hypervisorPresent", "firmwareVirtualization",
  "hyperVFeature", "containersFeature", "hcs", "hns", "hnsNetworks", "vfpAclSupport",
  "containerd", "ctr", "docker", "windowsContainerRuntime", "baseImages",
  "adapters", "vSwitches", "dedicatedWorkerFacingAddressPossible", "hyperVIsolationRequestable", "canRunCandidateImage",
]);

/** Parses a report, tolerating a single leading UTF-8 BOM (Windows PowerShell 5.1 writers can emit one). */
export function parseReport(text) {
  return JSON.parse(String(text).replace(/^﻿/u, ""));
}

/** Asserts a report carries only allow-listed keys (no accidental secret/unrelated field leaked into the artifact). */
export function assertBounded(report) {
  if (report === null || typeof report !== "object") throw new Error("report must be an object");
  for (const k of Object.keys(report)) if (!ALLOWED_KEYS.includes(k)) throw new Error(`host-probe report has a non-bounded field: ${k}`);
  return true;
}

const truthy = v => v === true;
const enabled = v => v === "Enabled" || v === true;
/** The bounded reasons the probe records when a Windows feature STATE could not be read (never a blank value). */
export const FEATURE_UNREAD_REASONS = Object.freeze(["accessDenied", "cmdletUnavailable", "featureUnknown"]);

/** A reason-aware message for a Windows-feature requirement: distinguishes "could not read state" from "not Enabled". */
function featureMiss(name, cmd, value) {
  if (FEATURE_UNREAD_REASONS.includes(value))
    return `${name} feature state could not be read (${value}) — re-run the probe in an ELEVATED PowerShell (still read-only, no changes).`;
  return `${name} feature not Enabled — ${cmd} (reboot yourself).`;
}

/** Requirements that must ALL hold for the host to be able to ATTEMPT the PoC. Each unmet one is reported with its reason. */
const REQUIREMENTS = Object.freeze([
  { key: "hypervisorPresent", ok: d => truthy(d.hypervisorPresent), miss: () => "Hypervisor not present — enable Hyper-V + hardware virtualization (SLAT + VT-x/AMD-V)." },
  { key: "hyperVFeature", ok: d => enabled(d.hyperVFeature), miss: d => featureMiss("Hyper-V", "Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -All", d.hyperVFeature) },
  { key: "containersFeature", ok: d => enabled(d.containersFeature), miss: d => featureMiss("Containers", "Enable-WindowsOptionalFeature -Online -FeatureName Containers -All", d.containersFeature) },
  { key: "hns", ok: d => truthy(d.hns?.available), miss: () => "Host Network Service (HNS) not available — required for the worker network + VFP ACL." },
  { key: "runtime", ok: d => truthy(d.ctr?.available) || truthy(d.containerd?.available) || truthy(d.docker?.available), miss: () => "No Windows container runtime (containerd/ctr or Docker) available to launch the isolated worker." },
  { key: "hyperVIsolationRequestable", ok: d => truthy(d.hyperVIsolationRequestable), miss: d => d.hyperVIsolationRequestable === null || d.hyperVIsolationRequestable === undefined
      ? "Whether the runtime can request Windows Hyper-V isolation could not be determined (unknown) — INCOMPLETE, not assumed."
      : "The available runtime cannot request Hyper-V isolation on this host (e.g. Docker not in Windows-container mode / Hyper-V isolation not exposed)." },
]);

/** Chooses the recommended PoC stack, preferring native HCS/HNS + containerd/ctr over Docker (not a trust dependency). */
export function recommendStack(d) {
  const hyperv = truthy(d.hyperVIsolationRequestable);
  if (!hyperv) return "none (Hyper-V isolation not requestable)";
  if (truthy(d.ctr?.available) || truthy(d.containerd?.available)) return "native HCS/HNS + containerd/ctr (Hyper-V isolation) — preferred";
  if (truthy(d.docker?.available)) return "Docker Engine (Hyper-V isolation) — PoC plumbing only, not a production trust dependency";
  return "none (no runtime)";
}

/** Computes the probe verdict + the exact missing prerequisites + the recommended stack from a collected report. */
export function evaluateHostProbe(report) {
  assertBounded(report);
  const missing = [];
  for (const r of REQUIREMENTS) { try { if (!r.ok(report)) missing.push(r.miss(report)); } catch { missing.push(`${r.key}: not determinable (data missing)`); } }
  const verdict = missing.length === 0 ? "PASS" : "INCOMPLETE";
  return Object.freeze({ verdict, missing: Object.freeze(missing), recommendedStack: recommendStack(report) });
}
