import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { attendedProductionBuildRecords } from "../src/app/delivery-live-records.js";
import { REAL_WRITER_LIVE_GATE_AUTHORIZED, liveWriterAuthorization, writerGateReport, writerReadiness } from "../src/app/writer-gate.js";

/**
 * v0.6 O6 Phase 2: the attended production builds `doctor` reports are RECORDED evidence, kept equal to the committed audit
 * (docs/v0.6-o6-phase2-audit.json, read back from Fusion's own run and delivery stores). They correct the readiness TEXT
 * only: no gate row changes state, the unattended Writer stays blocked and no Windows acceptance authority appears.
 */
interface AuditRun { runId: string; risk: string; turns: Array<{ role: string }>; candidateLifecycle: string[]; evidenceDecisions: string[];
  adjudicationOrCorrectionEvents: number }
interface AuditDelivery { deliveryId: string; runId: string; manifestSha256: string; verification: { backendId: string }; events: Array<{ type: string }> }
const audit = async () => JSON.parse(await readFile(join(process.cwd(), "docs", "v0.6-o6-phase2-audit.json"), "utf8")) as {
  lowRiskLifecycle: { run: AuditRun; delivery: AuditDelivery }; mediumRoute: { run: AuditRun; delivery: AuditDelivery } };

test("v0.6 O6 records: every attended production build record equals the committed audit (ids, digests, turns, lifecycle)", async () => {
  const recorded = await audit();
  const byRun = new Map([recorded.lowRiskLifecycle, recorded.mediumRoute].map(entry => [entry.run.runId, entry]));
  const records = attendedProductionBuildRecords();
  assert.equal(records.length, 2);
  for (const record of records) {
    const entry = byRun.get(record.runId);
    assert.ok(entry, `${record.runId} is in the audit`);
    const { run, delivery } = entry!;
    const roles = (role: string) => run.turns.filter(turn => turn.role === role).length;
    assert.deepEqual([record.risk, record.deliveryId, delivery.runId, record.manifestSha256, record.verificationBackend],
      [run.risk, delivery.deliveryId, record.runId, delivery.manifestSha256, delivery.verification.backendId]);
    assert.deepEqual(record.turns, { lead: roles("Lead"), worker: roles("Worker"), reviewer: roles("Reviewer"), adjudication: run.adjudicationOrCorrectionEvents });
    assert.equal(record.candidates, run.candidateLifecycle.filter(phase => phase === "created").length);
    assert.equal(record.evidenceDecision, run.evidenceDecisions.at(-1));
    assert.equal(record.lastDeliveryEvent, delivery.events.at(-1)!.type);
    assert.equal(record.primary, "disposable");
  }
});

test("v0.6 O6 records: doctor's Writer gate text no longer makes the stale claims; no gate row changes state", () => {
  const report = writerGateReport();
  const rows = Object.fromEntries(report.rows.map(row => [row.id, [row.state, row.evidenceKind]]));
  assert.deepEqual([rows.humanApprovedDelivery, rows.disposablePrimaryApplyLive, rows.productionBuildImplementation, rows.hostControlledWriterWorkflow,
    rows.productionWriterComposition, rows.deliveryStoreImplementation, rows.productionApplyPolicyImplementation, rows.providerWorkspaceBoundary,
    rows.fullRouteLive, rows.liveGateAuthorization],
  [["partial", "mechanical"], ["satisfied", "recordedLiveProbe"], ["satisfied", "mechanical"], ["satisfied", "recordedLiveProbe"],
    ["satisfied", "mechanical"], ["satisfied", "mechanical"], ["satisfied", "mechanical"], ["partial", "fakeProcess"],
    ["partial", "recordedLiveProbe"], ["blocked", "none"]]);
  const text = [...report.rows.flatMap(row => [row.evidence, row.remainingBlocker]), ...writerReadiness().prerequisites.map(p => p.text)].join("\n");
  for (const stale of [/no command prepares a delivery/u, /no live `fusion build` has run/u, /nothing is delivered to a primary checkout \(no command/u,
    /no live delivery used it/u, /no actual production Writer run is authorized/u, /nothing resumes an interrupted/u, /the v0\.1 live smoke is the human's/u])
    assert.doesNotMatch(text, stale);
  const row = (id: string) => report.rows.find(r => r.id === id)!;
  // The delivery row stays PARTIAL: its gate needs an ordinary (non-disposable) checkout, which no live apply has targeted.
  assert.match(row("humanApprovedDelivery").remainingBlocker,
    /^No ordinary or real checkout has received a delivery through the normal `fusion apply` live \(REAL_PRIMARY_APPLY_LIVE not run: every live apply so far targeted a disposable primary\)/u);
  for (const record of attendedProductionBuildRecords()) {
    assert.ok(row("humanApprovedDelivery").evidence.includes(record.deliveryId), record.deliveryId);
    assert.ok(row("productionBuildImplementation").evidence.includes(record.runId), record.runId);
  }
  assert.match(row("humanApprovedDelivery").evidence, /delivery d-94044f8a3efb2126b9def0e9 approved by its exact typed manifest digest, prechecked, claimed once and applied/u);
  assert.match(row("humanApprovedDelivery").evidence, /2 Lead, 2 Worker, 2 fresh Reviewer turn\(s\), no adjudication \(no review finding\).*delivery d-a866231c9d006fdda212f3fa prepared, not approved or applied/u);
  // The finding-driven branch is still unproven in a normal build; the Writer stays blocked.
  assert.match(row("productionBuildImplementation").remainingBlocker, /A finding-driven build \(Lead adjudication, correction, re-review\) has not yet run in a normal build/u);
  assert.match(row("hostControlledWriterWorkflow").remainingBlocker, /Never run live in a route: Lead adjudication of review findings/u);
  assert.deepEqual([report.realWriterModeReady, report.liveGateAuthorized, REAL_WRITER_LIVE_GATE_AUTHORIZED, liveWriterAuthorization().authorized, writerReadiness().ready],
    [false, false, false, false, false]);
});

test("v0.6 O6 records: a probed-unavailable Windows runtime is blocked, never runtime-ready, and no Windows acceptance authority exists", () => {
  const report = writerGateReport({ hostPlatform: "win32", windowsRuntime: "unavailable" });
  assert.deepEqual(report.verificationIsolation.windows,
    { evidenceState: "proven", registrationState: "registered", runtimeState: "unavailable", effectiveState: "blocked" });
  const windows = report.rows.find(row => row.id === "windowsVerificationIsolation")!;
  assert.equal(windows.state, "partial");
  assert.match(windows.remainingBlocker, /runtime is currently UNAVAILABLE/u);
  assert.match(writerReadiness().prerequisites.find(p => p.id === "verificationIsolation")!.text,
    /Fusion has no Windows verification-isolation ACCEPTANCE authority yet \(only docker-linux grants one\)/u);
  assert.equal(report.realWriterModeReady, false);
});
