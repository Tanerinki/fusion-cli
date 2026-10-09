import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { liveWriterAuthorization, REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport, writerReadiness } from "../src/app/writer-gate.js";
import { WINDOWS_VERIFICATION_BACKEND_ID, WINDOWS_VERIFICATION_CONTRACT, WINDOWS_VERIFICATION_EVIDENCE_SCHEMA,
  windowsConfinedBackendState, windowsVerificationIsolationState, type ConfinedBackendDescriptor,
  type WindowsVerificationIsolationEvidence } from "../src/platform/verification/windows-isolation.js";
import { recordedWindowsVerificationIsolation } from "../src/runtime/windows-verification-records.js";
import { createProductionVerificationBackends } from "../src/platform/verification/production.js";
import { selectVerificationBackend } from "../src/platform/verification/selection.js";

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
// The gate row on a Windows host (where the confined Hyper-V backend can run). Override via inputs where needed.
const windowsRow = (inputs?: Parameters<typeof writerGateReport>[0]) =>
  writerGateReport({ hostPlatform: "win32", ...inputs }).rows.find(r => r.id === "windowsVerificationIsolation")!;

// 1. valid Windows isolation evidence -> supported/proven; four independent states; registered-but-not-probed is UNKNOWN
test("v0.6 win-iso 1: valid recorded Windows evidence derives proven/supported (not hardcoded)", () => {
  const v = windowsVerificationIsolationState(validEvidence());
  assert.equal(v.state, "proven");
  assert.equal(v.supported, true);
  assert.deepEqual(v.reasons, []);
  assert.equal(windowsVerificationIsolationState(recordedWindowsVerificationIsolation()).state, "proven");
  // registered on a Windows host but NOT probed => runtime notProbed, effective UNKNOWN (never assumed ready), row partial
  const win = writerGateReport({ hostPlatform: "win32" }).verificationIsolation.windows;
  assert.deepEqual([win.evidenceState, win.registrationState, win.runtimeState, win.effectiveState], ["proven", "registered", "notProbed", "unknown"]);
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

// 5c. backend state is derived from the registry AND a real host prerequisite (Windows host); fail-closed otherwise
test("v0.6 win-iso 5c: backendState is derived from the backend registry + host (not hardcoded)", () => {
  // no confined Windows backend (docker-linux is linux-semantics; the trusted host is unconfined) -> unavailable
  assert.equal(windowsConfinedBackendState([{ id: "docker-linux", confinement: "osSandbox", platformSemantics: "linux" }], "win32").state, "unavailable");
  assert.equal(windowsConfinedBackendState([{ id: "trusted-host", confinement: "none" }], "win32").state, "unavailable", "unconfined never counts");
  assert.equal(windowsConfinedBackendState([], "win32").state, "unavailable");
  // a confined backend proving windows-required semantics IS available on a Windows host
  assert.equal(windowsConfinedBackendState([fakeWindowsBackend], "win32").state, "available");
  // but off a Windows host it fails closed regardless of what is registered
  assert.equal(windowsConfinedBackendState([fakeWindowsBackend], "linux").state, "unavailable");
});

// 3 + 4. effectiveState=ready requires evidence proven AND registered AND runtime PROBED-proven (all three)
test("v0.6 win-iso 3+4: effectiveState is ready ONLY with proven evidence AND registration AND a probed runtime", () => {
  const S = (inputs: Parameters<typeof writerGateReport>[0]) => { const w = writerGateReport(inputs).verificationIsolation.windows; return [w.evidenceState, w.registrationState, w.runtimeState, w.effectiveState]; };
  // registered backend + no probe => runtime notProbed, UNKNOWN (never ready)
  assert.deepEqual(S({ windowsVerification: validEvidence(), windowsBackends: [fakeWindowsBackend], hostPlatform: "win32" }), ["proven", "registered", "notProbed", "unknown"]);
  // registered backend + successful probe => READY
  assert.deepEqual(S({ windowsVerification: validEvidence(), windowsBackends: [fakeWindowsBackend], hostPlatform: "win32", windowsRuntime: "proven" }), ["proven", "registered", "proven", "ready"]);
  // registered backend + FAILED probe => BLOCKED (not ready, not unknown)
  assert.deepEqual(S({ windowsVerification: validEvidence(), windowsBackends: [fakeWindowsBackend], hostPlatform: "win32", windowsRuntime: "unavailable" }), ["proven", "registered", "unavailable", "blocked"]);
  // missing backend => registration unavailable => blocked, even with a (spurious) proven runtime
  assert.deepEqual(S({ windowsVerification: validEvidence(), windowsBackends: [], hostPlatform: "win32", windowsRuntime: "proven" }), ["proven", "unavailable", "proven", "blocked"]);
  // off-Windows host => registration unavailable => blocked
  assert.deepEqual(S({ windowsVerification: validEvidence(), windowsBackends: [fakeWindowsBackend], hostPlatform: "linux", windowsRuntime: "proven" }), ["proven", "unavailable", "proven", "blocked"]);
  // blocked evidence + everything else present => blocked
  assert.deepEqual(S({ windowsVerification: { ...validEvidence(), verdict: "FAIL" }, windowsBackends: [fakeWindowsBackend], hostPlatform: "win32", windowsRuntime: "proven" }), ["blocked", "registered", "proven", "blocked"]);
  // even effectiveState=ready is NEVER a Writer authorization
  const both = writerGateReport({ windowsVerification: validEvidence(), windowsBackends: [fakeWindowsBackend], hostPlatform: "win32", windowsRuntime: "proven" });
  assert.equal(both.realWriterModeReady, false, "effectiveState=ready is a dimension gate, never Writer readiness");
  assert.equal(both.liveGateAuthorized, false);
  assert.equal(both.rows.find(r => r.id === "liveGateAuthorization")!.state, "blocked");
});

// 6. doctor (no probe) vs doctor --probe reporting: no probe must NOT claim stronger runtime readiness than established
test("v0.6 win-iso 6: doctor without a probe reports notProbed/unknown; a probe establishes ready or blocked", () => {
  // doctor (no probe): runtime notProbed, effective UNKNOWN, row partial (never satisfied)
  const noProbe = writerGateReport({ hostPlatform: "win32" });
  assert.deepEqual([noProbe.verificationIsolation.windows.runtimeState, noProbe.verificationIsolation.windows.effectiveState], ["notProbed", "unknown"]);
  assert.equal(noProbe.rows.find(r => r.id === "windowsVerificationIsolation")!.state, "partial");
  // doctor --probe, runtime proven: effective ready, row satisfied
  const probed = writerGateReport({ hostPlatform: "win32", windowsRuntime: "proven" });
  assert.deepEqual([probed.verificationIsolation.windows.runtimeState, probed.verificationIsolation.windows.effectiveState], ["proven", "ready"]);
  assert.equal(probed.rows.find(r => r.id === "windowsVerificationIsolation")!.state, "satisfied");
  assert.match(probed.rows.find(r => r.id === "windowsVerificationIsolation")!.evidence, /isolated Hyper-V worker/u);
  // doctor --probe, runtime unavailable (broken/absent Windows engine): effective blocked
  assert.equal(writerGateReport({ hostPlatform: "win32", windowsRuntime: "unavailable" }).verificationIsolation.windows.effectiveState, "blocked");
  // the Linux row is untouched (no acceptance granted in a plain report)
  assert.deepEqual([noProbe.rows.find(r => r.id === "verificationIsolation")!.state, noProbe.rows.find(r => r.id === "verificationIsolation")!.evidenceKind], ["notEvaluated", "none"]);
  // the diagnostics layer wires the real backend probe only under --probe (source guard)
  const diag = readFileSync(new URL("../../src/app/diagnostics.ts", import.meta.url), "utf8");
  assert.match(diag, /createProductionHyperVBackend\(\)\.probe/u);
  assert.match(diag, /request\.probe === true/u);
  assert.match(diag, /windowsRuntime/u);
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
  // including a fully probed-ready Windows dimension, and a runtime-unavailable one
  cases.push({ windowsVerification: validEvidence(), windowsBackends: [fakeWindowsBackend], hostPlatform: "win32", windowsRuntime: "proven" });
  cases.push({ windowsVerification: validEvidence(), windowsBackends: [fakeWindowsBackend], hostPlatform: "win32", windowsRuntime: "unavailable" });
  for (const inputs of cases) {
    const report = writerGateReport(inputs);
    assert.equal(report.realWriterModeReady, false);
    assert.equal(report.liveGateAuthorized, false);
    assert.equal(report.rows.find(r => r.id === "liveGateAuthorization")!.state, "blocked");
  }
  assert.equal(writerReadiness().ready, false);
  assert.equal(liveWriterAuthorization().authorized, false);
});

// productionEligible semantics: it is a self-declaration constant (always false), NEVER the selection/execution gate
test("v0.6 win-iso productionEligible: a backend never self-declares eligibility; the field gates nothing", async () => {
  const backends = createProductionVerificationBackends();
  // every production backend (incl. the Hyper-V one) self-declares productionEligible=false, yet is in the production set
  assert.ok(backends.length >= 2);
  for (const b of backends) assert.equal(b.productionEligible, false, `${b.id} must not self-declare eligibility`);
  assert.ok(backends.some(b => b.id === "hyperv-windows"));
  // selection must NOT consult productionEligible: a productionEligible=false backend is selected for its platform
  // (it may be unavailable without a Windows docker engine, but the refusal is from the PROBE, never from productionEligible)
  const sel = await selectVerificationBackend(backends, { purpose: "autonomousWriter", platformRequirement: "windows-required" }).catch(() => undefined);
  if (sel !== undefined) assert.equal(sel.backend.id, "hyperv-windows");
  // the source enforces it as a type-level literal `false`, not a runtime branch
  const backendSrc = readFileSync(new URL("../../src/platform/verification/backend.ts", import.meta.url), "utf8");
  assert.match(backendSrc, /readonly productionEligible: false/u);
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
  // the default report derives from the recorded proof; on a Windows host without a probe it is effective unknown
  const win = writerGateReport({ hostPlatform: "win32" }).verificationIsolation.windows;
  assert.deepEqual([win.evidenceState, win.runtimeState, win.effectiveState], ["proven", "notProbed", "unknown"]);
});
