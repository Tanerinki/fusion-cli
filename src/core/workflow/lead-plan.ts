import type { PacketTurnPurpose } from "../domain.js";

/**
 * O5.5B16 — the planning Lead's contract, provider-neutral. The Lead's plan turn used the generic delegated-task wording
 * ("Complete this delegated task…"), which asks a read-only session to do the implementation; live (O5.5B15) that turn
 * spent the CLI's whole agentic turn budget on tool use and never answered. The Lead plans; the Change Author proposes
 * the implementation; Fusion validates, applies and verifies it.
 *
 * Only the instruction changes. The reply stays the existing ResultPacket, and each provider keeps its own reply rules
 * (raw JSON, schema). The engine forwards `changes.summary` to the Change Author as the Lead plan and proceeds only on
 * `status: completed` with no `needsLeadDecision`, so the instruction maps the plan onto exactly those fields.
 */
export const LEAD_PLAN_INSTRUCTION = [
  "You are the planning Lead for this delegated task.",
  "Do not implement the task: do not modify, create or delete any file, and do not attempt to complete the delegated implementation yourself.",
  "A separate Change Author implements it from your plan; Fusion then validates, applies and verifies that change.",
  "Inspect only enough repository context to produce the plan: identify the relevant files and modules, the behaviour changes required," +
    " the architecture and security invariants to preserve, the acceptance criteria and how they will be verified, and the risks and constraints.",
  "Stop exploring as soon as you can produce the plan, and answer.",
  "Report the plan in the reply below: the concise plan in changes.summary, the files it expects to change in changes.files, risks and open" +
    " points in uncertainties, and anything a human must decide in needsLeadDecision; set result.status to completed when the plan is ready," +
    " or blocked if the task cannot be planned.",
  "Run no tests and report none: leave verification.testsRun and verification.results empty; only Fusion's own evidence counts.",
].join(" ");

/** The role-specific instruction of a packet turn, or `undefined` to keep the provider's generic delegated-task wording. */
export function packetTurnInstruction(purpose: PacketTurnPurpose | undefined): string | undefined {
  return purpose === "plan" ? LEAD_PLAN_INSTRUCTION : undefined;
}
