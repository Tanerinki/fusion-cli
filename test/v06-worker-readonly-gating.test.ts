import assert from "node:assert/strict";
import { test } from "node:test";
import type { CapabilitySnapshot } from "../src/core/domain.js";
import { resolveRole, PolicyRoutingFailure, type RoleCandidate } from "../src/core/policy/routing.js";
import { bindingEligibility, changeProposalReadiness } from "../src/app/readiness.js";
import type { BindingConfig } from "../src/app/config.js";
import type { BindingInspection, BindingProbe } from "../src/app/providers.js";
import { liveWriterAuthorization, REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport } from "../src/app/writer-gate.js";

// A SAFE, VERIFIED read-only Change-Author posture: structured output, read but not write, no shell, web disabled,
// approval/personal-context off, extensions quarantined, model/subscription readback, view-bound.
const safeCaps = (over: Partial<Record<string, unknown>> = {}): CapabilitySnapshot => ({
  provider: "claude", transport: "claude-one-shot", observedAt: "2026-10-04T00:00:00.000Z", runtimeVersion: "2.1.289",
  persistentSessions: false, structuredOutput: true, webToolsDisabled: true,
  filesystem: { read: true, write: false }, shell: { available: false, sandboxed: "unknown" },
  approvalEscalationDisabled: true, personalContextDisabled: true, extensionsQuarantined: true,
  workspaceBinding: true, approvalCallback: false, protocolCancellation: false, usageReporting: "unknown",
  modelIdentityReadback: true, subscriptionLaneReadback: true, ...over,
} as CapabilitySnapshot);

const workerBinding = { role: "Worker", adapter: "claude-one-shot", model: "haiku", effort: "low" } as BindingConfig;
const inspection = (caps: CapabilitySnapshot): BindingInspection => ({ provider: "claude", transport: "claude-one-shot",
  executable: "available", runtimeVersion: "2.1.289", billing: { state: "clear", reasons: [], candidateLane: "subscription" },
  capabilities: caps, structuredTurns: true, controls: [], notes: [] } as unknown as BindingInspection);
const okProbe: BindingProbe = { auth: { state: "authenticated", lane: "subscription", detail: "ok" }, capabilities: safeCaps() } as BindingProbe;

// 1 + 2. safe Worker posture + unattended gate closed -> read-only PROPOSAL eligible; WRITER stays blocked
test("v0.6 worker-gate 1/2: a safe verified Worker is read-only/change-proposal eligible while the Writer stays blocked", () => {
  const e = bindingEligibility(workerBinding, inspection(safeCaps()), undefined, okProbe);
  assert.equal(e.readOnly.state, "eligible", e.readOnly.reasons.join("; "));
  assert.equal(e.changeProposal.state, "eligible", e.changeProposal.reasons.join("; "));
  // the WRITER (autonomous/write-capable) remains blocked by REAL_WRITER_MODE_NOT_READY - never weakened
  assert.equal(e.writer.state, "blocked");
  assert.deepEqual([...e.writer.reasons], ["REAL_WRITER_MODE_NOT_READY"]);
  assert.equal(e.review.state, "blocked", "a Worker is never a review role");
  assert.equal(changeProposalReadiness(e, inspection(safeCaps())).implementation, "eligible");
  assert.equal(changeProposalReadiness(e, inspection(safeCaps())).ready, false, "live Writer gate stays closed: ready is always false");
});

// 3. unsafe or unknown Worker posture -> proposal blocked (ineligible/unknown), never eligible
test("v0.6 worker-gate 3: an unsafe or unknown Worker posture is not read-only eligible", () => {
  const write = bindingEligibility(workerBinding, inspection(safeCaps({ filesystem: { read: true, write: true } })), undefined, okProbe);
  assert.equal(write.changeProposal.state, "ineligible", "filesystem.write=true must not be eligible");
  assert.equal(write.readOnly.state, "ineligible");
  const shell = bindingEligibility(workerBinding, inspection(safeCaps({ shell: { available: true, sandboxed: "unknown" } })), undefined, okProbe);
  assert.equal(shell.changeProposal.state, "ineligible", "an available shell must not be eligible");
  const unknown = bindingEligibility(workerBinding, inspection(safeCaps({ structuredOutput: "unknown" })), undefined, okProbe);
  assert.notEqual(unknown.changeProposal.state, "eligible", "an unknown capability is never eligible");
});

// 4. failed auth / non-subscription readback -> proposal blocked
test("v0.6 worker-gate 4: a failed or non-subscription auth readback blocks the Worker proposal", () => {
  const failed = bindingEligibility(workerBinding, inspection(safeCaps()), undefined, { auth: { state: "failed", lane: "unknown", detail: "x" } } as BindingProbe);
  assert.equal(failed.changeProposal.state, "blocked");
  assert.equal(failed.readOnly.state, "blocked");
  const payg = bindingEligibility(workerBinding, inspection(safeCaps()), undefined, { auth: { state: "authenticated", lane: "apiKey", detail: "x" } } as BindingProbe);
  assert.equal(payg.changeProposal.state, "blocked", "a non-subscription lane is refused");
});

// ---- routing: the attended build SELECTS the Worker proposal at read-only posture, never a write posture ----------
const fakeAdapter = (caps: CapabilitySnapshot, withProposal = true): RoleCandidate["adapter"] => ({
  capabilities: async () => caps,
  ...(withProposal ? { runChangeProposalTurn: async () => ({}) } : {}),
  runStructuredTurn: async () => ({}),
} as unknown as RoleCandidate["adapter"]);
const candidate = (caps: CapabilitySnapshot, withProposal = true): RoleCandidate => ({
  binding: { role: "Worker", provider: "claude", transport: "claude-one-shot", model: "haiku", requires: {} } as unknown as RoleCandidate["binding"],
  adapter: fakeAdapter(caps, withProposal) });

test("v0.6 worker-gate 5/6: an attended build selects the Worker proposal at READ-ONLY posture (never write)", async () => {
  const resolved = await resolveRole("Worker", [candidate(safeCaps())], { shell: false, network: false }, { changeProposal: true });
  assert.equal(resolved.role, "Worker");
  assert.equal(resolved.posture, "readOnly", "the provider is routed read-only; Fusion owns any mutation");
  // the resolved read-only capabilities carry NO write and NO shell - the provider never gains write/shell here
  assert.equal(resolved.capabilities.filesystem?.write, false);
  assert.equal(resolved.capabilities.shell?.available, false);
});

test("v0.6 worker-gate 6b: a Worker advertising write or shell, or lacking the proposal turn, is refused", async () => {
  await assert.rejects(resolveRole("Worker", [candidate(safeCaps({ filesystem: { read: true, write: true } }))], { shell: false, network: false }, { changeProposal: true }), PolicyRoutingFailure);
  await assert.rejects(resolveRole("Worker", [candidate(safeCaps({ shell: { available: true, sandboxed: "unknown" } }))], { shell: false, network: false }, { changeProposal: true }), PolicyRoutingFailure);
  await assert.rejects(resolveRole("Worker", [candidate(safeCaps(), false)], { shell: false, network: false }, { changeProposal: true }), PolicyRoutingFailure);
  // a change proposal is never routed to a non-Worker role, nor with a shell/network surface
  await assert.rejects(resolveRole("Lead", [candidate(safeCaps())], { shell: false, network: false }, { changeProposal: true }), PolicyRoutingFailure);
  await assert.rejects(resolveRole("Worker", [candidate(safeCaps())], { shell: true, network: false }, { changeProposal: true }), PolicyRoutingFailure);
});

// 7/8/9. the unattended Writer gate stays closed regardless of the read-only proposal being eligible
test("v0.6 worker-gate 7: a safe read-only proposal never opens the unattended Writer gate", () => {
  assert.equal(REAL_WRITER_LIVE_GATE_AUTHORIZED, false);
  const report = writerGateReport();
  assert.equal(report.realWriterModeReady, false);
  assert.equal(report.liveGateAuthorized, false);
  assert.equal(report.rows.find(r => r.id === "liveGateAuthorization")!.state, "blocked");
  // with no run authorization, a Writer run is refused even though the read-only proposal posture is eligible
  assert.equal(liveWriterAuthorization().authorized, false);
});
