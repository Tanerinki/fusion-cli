import type { AgentRole, CapabilitySnapshot } from "../core/domain.js";
import { REVIEW_ISOLATION, ROLE_POSTURE } from "../core/policy/routing.js";
import type { BindingConfig } from "./config.js";
import type { BindingInspection, BindingProbe } from "./providers.js";
import { REAL_WRITER_MODE_NOT_READY } from "./writer-gate.js";

/**
 * - `eligible`: every required capability was observed to hold.
 * - `unknown`: nothing required is known to be wrong, but at least one required capability is unobserved.
 * - `ineligible`: a required capability is known not to hold.
 * - `unavailable`: the adapter or its executable cannot be used.
 * - `blocked`: a guard refuses it (billing/provider override, or the Writer gate).
 * Unknown is never treated as eligible.
 */
export type EligibilityState = "eligible" | "unknown" | "ineligible" | "unavailable" | "blocked";
export interface Eligibility {
  readonly state: EligibilityState;
  readonly reasons: readonly string[];
}
export type ReadinessClass = "READ_ONLY_READY" | "REVIEW_READY" | "WRITER_NOT_READY" | "DEGRADED" | "BLOCKED";

type Need = Readonly<{ key: string; holds: (snapshot: CapabilitySnapshot) => boolean | "unknown" }>;
const known = (value: unknown, expected: unknown): boolean | "unknown" =>
  value === expected ? true : value === "unknown" || value === undefined ? "unknown" : false;
/** The strict read-only surface the O3.1/O4 routing enforces for review roles: no shell, no network, no writes. */
const READ_ONLY_NEEDS: readonly Need[] = [
  { key: "structuredOutput", holds: s => known(s.structuredOutput, true) },
  { key: "filesystem.read", holds: s => known(s.filesystem?.read, true) },
  { key: "filesystem.write=false", holds: s => known(s.filesystem?.write, false) },
  { key: "shell.available=false", holds: s => known(s.shell?.available, false) },
  { key: "webToolsDisabled", holds: s => known(s.webToolsDisabled, true) },
];
/** Review roles additionally need routing's `REVIEW_ISOLATION`, read from the same constant so the two cannot drift. */
const REVIEW_NEEDS: readonly Need[] = [...READ_ONLY_NEEDS, ...Object.entries(REVIEW_ISOLATION).map(([key, expected]): Need =>
  ({ key: expected === true ? key : `${key}=${String(expected)}`,
    holds: s => known((s as unknown as Record<string, unknown>)[key], expected) }))];

export interface BindingEligibility {
  readonly readOnly: Eligibility;
  readonly review: Eligibility;
  readonly writer: Eligibility;
}
/** Lanes a probe may observe for a read-only binding; any other observed lane is a billing refusal. */
const SUBSCRIPTION_LANES = new Set(["subscription", "subscriptionToken"]);
/**
 * Per-binding eligibility from static inspection, mirroring the routing rules without weakening them. An opt-in
 * probe can only lower it: a failed, non-subscription or unexpected-lane auth readback blocks the binding, and a
 * successful one never raises an unknown capability.
 */
export function bindingEligibility(binding: BindingConfig, inspection: BindingInspection | undefined,
  inspectionError?: string, probe?: BindingProbe | Readonly<{ error: string }>): BindingEligibility {
  const writer: Eligibility = { state: "blocked", reasons: [REAL_WRITER_MODE_NOT_READY] };
  if (inspection === undefined) {
    const unavailable: Eligibility = { state: "unavailable", reasons: [inspectionError ?? "the adapter could not be inspected"] };
    return { readOnly: unavailable, review: unavailable, writer };
  }
  if (inspection.executable === "unavailable") {
    const unavailable: Eligibility = { state: "unavailable", reasons: ["the provider executable was not found"] };
    return { readOnly: unavailable, review: unavailable, writer };
  }
  if (inspection.billing.state === "blocked") {
    const blocked: Eligibility = { state: "blocked", reasons: inspection.billing.reasons.map(reason => `billing guard: ${reason}`) };
    return { readOnly: blocked, review: blocked, writer };
  }
  /** An unknown fact can only lower eligible to unknown; a missing capability always makes it ineligible. */
  const withUnknown = (base: Eligibility, reasons: readonly string[]): Eligibility => reasons.length === 0 ? base
    : { state: base.state === "eligible" ? "unknown" : base.state, reasons: [...base.reasons, ...reasons] };
  const withIneligible = (base: Eligibility, reasons: readonly string[]): Eligibility => reasons.length === 0 ? base
    : { state: "ineligible", reasons: [...base.reasons, ...reasons] };
  const billingUnknown = inspection.billing.state === "unknown" ? ["billing guard state unknown"] : [];
  const readOnlyEligibility = withUnknown(surfaceEligibility(inspection.capabilities, READ_ONLY_NEEDS), billingUnknown);
  const reviewSurface = withUnknown(surfaceEligibility(inspection.capabilities, REVIEW_NEEDS), billingUnknown);
  const reviewStatic = inspection.structuredTurns ? reviewSurface
    : withIneligible(reviewSurface, ["the adapter has no structured review/adjudication turn"]);
  const refusal = probeRefusal(probe, inspection.billing.candidateLane);
  const probed = (base: Eligibility): Eligibility => refusal === undefined || (base.state !== "eligible" && base.state !== "unknown")
    ? base : { state: "blocked", reasons: [...base.reasons, refusal] };
  const readOnlyEligibilityProbed = probed(readOnlyEligibility), review = probed(reviewStatic);
  // A binding configured for the Worker role is never eligible while the Writer gate is closed.
  return { readOnly: ROLE_POSTURE[binding.role] === "writer" ? writer : readOnlyEligibilityProbed,
    review: ROLE_POSTURE[binding.role] === "writer" ? writer : review, writer };
}

/** Why an auth probe refuses the binding, or undefined when it observed the expected subscription lane. */
function probeRefusal(probe: BindingProbe | Readonly<{ error: string }> | undefined, candidateLane: string | undefined): string | undefined {
  if (probe === undefined) return undefined;
  if ("error" in probe) return `auth probe failed: ${probe.error}`;
  const { state, lane, detail } = probe.auth;
  if (state !== "authenticated") return `auth probe: ${state}${detail ? ` (${detail})` : ""}`;
  if (!SUBSCRIPTION_LANES.has(lane)) return `auth probe observed a non-subscription lane (${lane})`;
  if (candidateLane !== undefined && lane !== candidateLane)
    return `auth probe observed lane ${lane}, but the environment selects ${candidateLane}`;
  return undefined;
}

function surfaceEligibility(snapshot: CapabilitySnapshot | undefined, needs: readonly Need[]): Eligibility {
  if (snapshot === undefined) return { state: "unknown", reasons: ["capabilities are only known after a probe or session"] };
  const unknown: string[] = [], failing: string[] = [];
  for (const need of needs) {
    const holds = need.holds(snapshot);
    if (holds === "unknown") unknown.push(`${need.key} unknown`);
    else if (!holds) failing.push(`${need.key} not satisfied`);
  }
  if (failing.length > 0) return { state: "ineligible", reasons: [...failing, ...unknown] };
  if (unknown.length > 0) return { state: "unknown", reasons: unknown };
  return { state: "eligible", reasons: [] };
}

/** Best state across a role's bindings: one eligible binding makes the role eligible. */
export function roleEligibility(entries: readonly Eligibility[]): EligibilityState {
  const order: EligibilityState[] = ["eligible", "unknown", "ineligible", "blocked", "unavailable"];
  if (entries.length === 0) return "unavailable";
  return order.find(state => entries.some(entry => entry.state === state)) ?? "unavailable";
}

export interface ReadinessVerdict {
  readonly overall: Exclude<ReadinessClass, "WRITER_NOT_READY">;
  readonly classes: readonly ReadinessClass[];
}
/**
 * - BLOCKED: infrastructure makes even a read-only run impossible (no Git, no repository, unsafe storage).
 * - REVIEW_READY: an eligible fresh Reviewer and an eligible adjudicating Lead exist.
 * - READ_ONLY_READY: eligible read-only Lead and Explorer exist.
 * - DEGRADED: none of the above; something is unknown, unavailable or ineligible.
 * WRITER_NOT_READY is always present.
 */
export function readinessVerdict(infrastructureBlocked: boolean, roles: Readonly<Partial<Record<AgentRole,
  Readonly<{ readOnly: EligibilityState; review: EligibilityState }>>>>): ReadinessVerdict {
  const overall = infrastructureBlocked ? "BLOCKED"
    : roles.Reviewer?.review === "eligible" && roles.Lead?.review === "eligible" ? "REVIEW_READY"
    : roles.Lead?.readOnly === "eligible" && roles.Explorer?.readOnly === "eligible" ? "READ_ONLY_READY"
    : "DEGRADED";
  return { overall, classes: [overall, "WRITER_NOT_READY"] };
}
