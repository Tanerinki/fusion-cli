import assert from "node:assert/strict";
import { test } from "node:test";
import { liveWriterAuthorization, REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport, writerReadiness } from "../src/app/writer-gate.js";
import { WINDOWS_VERIFICATION_BACKEND_ID, WINDOWS_VERIFICATION_CONTRACT, WINDOWS_VERIFICATION_EVIDENCE_SCHEMA,
  windowsConfinedBackendState, windowsVerificationIsolationState, type ConfinedBackendDescriptor,
  type WindowsVerificationIsolationEvidence } from "../src/platform/verification/windows-isolation.js";
import { recordedWindowsVerificationIsolation } from "../src/runtime/windows-verification-records.js";

// A hypothetical registered, confined backend that DOES prove windows-required semantics (none exists in production).
const fakeWindowsBackend: ConfinedBackendDescriptor = { id: "fake-hyperv", confinement: "osSandbox", platformSemantics: "windows" };

// A structurally-valid recorded Windows proof (the shape the gate derives "proven" from). Each test deviates one field.
const validEvidence = (): WindowsVerificationIsolationEvidence => ({
  contract: WINDOWS_VERIFICATION_CONTRACT,
  evidenceSchemaVersion: WINDOWS_VERIFICATION_EVIDENCE_SCHEMA,
  semantics: "windows",
  backendId: WINDOWS_VERIFICATION_BACKEND_ID,
  isolationMode: "hyperv",
  networkMode: "none",
  bindMountCount: 0,
  verdict: "PASS",
  outcome: "verified",
  primaryMutationDetected: false,
  gateProofs: { cleanVerifiedPass: true, timeoutClassifiedDistinctly: true, mutationDetectedAndRejected: true, cleanExitCannotMaskMutation: true },
  runId: "viTEST",
  evidencePath: "docs/v0.6-verification-isolation-audit.json",
  observedAt: "2026-10-03",
});
const windowsRow = (inputs?: Parameters<typeof writerGateReport>[0]) => writerGateReport(inputs).rows.find(r => r.id === "windowsVerificationIsolation")!;

// 1. valid Windows isolation evidence -> supported/proven
test("v0.6 win-iso 1: valid recorded Windows evidence derives proven/supported (not hardcoded)", () => {
  const v = windowsVerificationIsolationState(validEvidence());
  assert.equal(v.state, "proven");
  assert.equal(v.supported, true);
  assert.deepEqual(v.reasons, []);
  // and the real recorded proof validates the same way
  assert.equal(windowsVerificationIsolationState(recordedWindowsVerificationIsolation()).state, "proven");
  // the gate's top-level field reflects proven EVIDENCE, but with no confined backend the dimension is not effective
  const win = writerGateReport().verificationIsolation.windows;
  assert.equal(win.evidenceState, "proven");
  assert.equal(win.backendState, "unavailable");
  assert.equal(win.effectiveState, "blocked");
  assert.deepEqual([windowsRow().state, windowsRow().evidenceKind], ["partial", "recordedLiveProbe"]);
});

// 2. missing evidence -> blocked (fail closed)
test("v0.6 win-iso 2: missing evidence fails closed to blocked", () => {
  for (const missing of [undefined, null]) {
    const v = windowsVerificationIsolationState(missing);
    assert.equal(v.state, "blocked");
    assert.equal(v.supported, false);
  }
  // passing the key explicitly as undefined means "use this (none)" -> the gate reports blocked evidence
  assert.equal(writerGateReport({ windowsVerification: undefined }).verificationIsolation.windows.evidenceState, "blocked");
  assert.equal(writerGateReport({ windowsVerification: undefined }).verificationIsolation.windows.effectiveState, "blocked");
  assert.deepEqual([windowsRow({ windowsVerification: null }).state, windowsRow({ windowsVerification: null }).evidenceKind], ["blocked", "none"]);
});

// 3. malformed evidence -> blocked
test("v0.6 win-iso 3: malformed evidence fails closed to blocked", () => {
  assert.equal(windowsVerificationIsolationState("not-an-object").state, "blocked");
  assert.equal(windowsVerificationIsolationState(42).state, "blocked");
  assert.equal(windowsVerificationIsolationState({ ...validEvidence(), gateProofs: "nope" }).state, "blocked");
  assert.equal(windowsVerificationIsolationState({ ...validEvidence(), gateProofs: { cleanVerifiedPass: true } }).state, "blocked", "partial gateProofs");
  assert.equal(windowsVerificationIsolationState({ ...validEvidence(), bindMountCount: "0" }).state, "blocked", "wrong type");
  const noRun = validEvidence() as unknown as Record<string, unknown>; delete noRun.runId;
  assert.equal(windowsVerificationIsolationState(noRun).state, "blocked", "missing runId");
});

// 4. stale / incompatible evidence -> blocked
test("v0.6 win-iso 4: stale or incompatible contract/schema fails closed to blocked", () => {
  const staleContract = windowsVerificationIsolationState({ ...validEvidence(), contract: "fusion-verification-confinement-v0.0-windows-hyperv" });
  assert.equal(staleContract.state, "blocked");
  assert.ok(staleContract.reasons.some(r => /stale or incompatible/u.test(r)));
  assert.equal(windowsVerificationIsolationState({ ...validEvidence(), evidenceSchemaVersion: "v0.5-old-schema" }).state, "blocked");
});

// 5. wrong backend / platform -> blocked
test("v0.6 win-iso 5: wrong platform or backend fails closed to blocked", () => {
  assert.equal(windowsVerificationIsolationState({ ...validEvidence(), semantics: "linux" }).state, "blocked", "wrong platform");
  assert.equal(windowsVerificationIsolationState({ ...validEvidence(), backendId: "docker-linux" }).state, "blocked", "wrong backend id");
  assert.equal(windowsVerificationIsolationState({ ...validEvidence(), isolationMode: "process" }).state, "blocked", "wrong isolation");
  assert.equal(windowsVerificationIsolationState({ ...validEvidence(), networkMode: "nat" }).state, "blocked", "network not none");
  assert.equal(windowsVerificationIsolationState({ ...validEvidence(), bindMountCount: 1 }).state, "blocked", "a host bind mount");
});

// 5b. a non-PASS / mutated proof is never proven (the state is derived, never hardcoded)
test("v0.6 win-iso 5b: a non-PASS, non-verified or mutated proof is never proven", () => {
  assert.equal(windowsVerificationIsolationState({ ...validEvidence(), verdict: "FAIL" }).state, "blocked");
  assert.equal(windowsVerificationIsolationState({ ...validEvidence(), outcome: "rejected-mutation" }).state, "blocked");
  assert.equal(windowsVerificationIsolationState({ ...validEvidence(), primaryMutationDetected: true }).state, "blocked");
  assert.equal(windowsVerificationIsolationState({ ...validEvidence(), gateProofs: { cleanVerifiedPass: true, timeoutClassifiedDistinctly: true, mutationDetectedAndRejected: false, cleanExitCannotMaskMutation: true } }).state, "blocked");
});

// 5c. backend state is derived from the registry: no confined windows backend -> unavailable; a compatible one -> available
test("v0.6 win-iso 5c: backendState is derived from the backend registry (not hardcoded)", () => {
  // the real production registry (docker-linux + unconfined host) has no confined Windows backend
  assert.equal(windowsConfinedBackendState([{ id: "docker-linux", confinement: "osSandbox", platformSemantics: "linux" }]).state, "unavailable");
  assert.equal(windowsConfinedBackendState([{ id: "trusted-host", confinement: "none" }]).state, "unavailable", "unconfined never counts");
  assert.equal(windowsConfinedBackendState([]).state, "unavailable");
  // a confined backend proving windows-required semantics IS available
  assert.equal(windowsConfinedBackendState([fakeWindowsBackend]).state, "available");
});

// 3 + 4. production readiness requires BOTH proven evidence AND a registered compatible backend
test("v0.6 win-iso 3+4: effectiveState is ready ONLY with proven evidence AND a registered confined backend", () => {
  // proven evidence + missing backend => effective BLOCKED (the key regression)
  const noBackend = writerGateReport({ windowsVerification: validEvidence() }).verificationIsolation.windows;
  assert.deepEqual([noBackend.evidenceState, noBackend.backendState, noBackend.effectiveState], ["proven", "unavailable", "blocked"]);
  // blocked evidence + present backend => effective BLOCKED
  const noEvidence = writerGateReport({ windowsVerification: { ...validEvidence(), verdict: "FAIL" }, windowsBackends: [fakeWindowsBackend] }).verificationIsolation.windows;
  assert.deepEqual([noEvidence.evidenceState, noEvidence.backendState, noEvidence.effectiveState], ["blocked", "available", "blocked"]);
  // proven evidence + present backend => effective READY (both required) -- but still NOT a Writer authorization
  const both = writerGateReport({ windowsVerification: validEvidence(), windowsBackends: [fakeWindowsBackend] });
  assert.deepEqual([both.verificationIsolation.windows.evidenceState, both.verificationIsolation.windows.backendState, both.verificationIsolation.windows.effectiveState],
    ["proven", "available", "ready"]);
  assert.equal(both.realWriterModeReady, false, "effectiveState=ready is a dimension gate, never Writer readiness");
  assert.equal(both.liveGateAuthorized, false);
  assert.equal(both.rows.find(r => r.id === "liveGateAuthorization")!.state, "blocked");
});

// 6. production doctor (writerGateReport, what `fusion doctor` serializes) reports the exact resulting state
test("v0.6 win-iso 6: the production gate report reflects the derived Windows state exactly", () => {
  const report = writerGateReport();
  assert.deepEqual([report.verificationIsolation.windows.evidenceState, report.verificationIsolation.windows.backendState,
    report.verificationIsolation.windows.effectiveState], ["proven", "unavailable", "blocked"]);
  const row = report.rows.find(r => r.id === "windowsVerificationIsolation")!;
  assert.equal(row.state, "partial");
  assert.equal(row.evidenceKind, "recordedLiveProbe");
  assert.match(row.evidence, /isolated Hyper-V worker/u);
  assert.match(row.remainingBlocker, /cannot EXECUTE confined verification/u);
  // the Linux row is untouched (no acceptance granted in a plain report)
  const linux = report.rows.find(r => r.id === "verificationIsolation")!;
  assert.deepEqual([linux.state, linux.evidenceKind], ["notEvaluated", "none"]);
  // injected evidence that fails validation flips ONLY this field/row to blocked evidence
  assert.equal(writerGateReport({ windowsVerification: { ...validEvidence(), verdict: "FAIL" } }).verificationIsolation.windows.evidenceState, "blocked");
});

// 7. the unattended Writer gate remains closed regardless of the Windows state (proven+backend included)
test("v0.6 win-iso 7: no Windows state (even effective=ready) ever opens the unattended Writer gate", () => {
  assert.equal(REAL_WRITER_LIVE_GATE_AUTHORIZED, false);
  const cases: Parameters<typeof writerGateReport>[0][] = [
    { windowsVerification: undefined },
    {},
    { windowsVerification: { ...validEvidence(), verdict: "FAIL" } },
    { windowsVerification: validEvidence(), windowsBackends: [fakeWindowsBackend] }, // effective=ready
  ];
  for (const inputs of cases) {
    const report = writerGateReport(inputs);
    assert.equal(report.realWriterModeReady, false);
    assert.equal(report.liveGateAuthorized, false);
    assert.equal(report.rows.find(r => r.id === "liveGateAuthorization")!.state, "blocked");
  }
  assert.equal(writerReadiness().ready, false);
  assert.equal(liveWriterAuthorization().authorized, false);
});

// invariant: Windows evidence never moves any OTHER row (only its own field + row), and the default matches the record
test("v0.6 win-iso invariant: Windows evidence touches only its own field/row and defaults to the record", () => {
  const base = writerGateReport();
  const other = writerGateReport({ windowsVerification: { ...validEvidence(), verdict: "FAIL" } });
  const ids = new Set(base.rows.map(r => r.id));
  for (const id of ids) {
    if (id === "windowsVerificationIsolation") continue;
    assert.deepEqual(base.rows.find(r => r.id === id), other.rows.find(r => r.id === id), `row ${id} must not move`);
  }
  // key absent == recorded proof (proven evidence; no backend; effective blocked)
  assert.deepEqual([base.verificationIsolation.windows.evidenceState, base.verificationIsolation.windows.effectiveState], ["proven", "blocked"]);
});
