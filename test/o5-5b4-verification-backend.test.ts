import assert from "node:assert/strict";
import { test } from "node:test";
import { FusionFailure } from "../src/core/errors.js";
import { backendReadiness, createVerificationBackend, executeVerification, requireVerificationBackend,
  TrustedHostBackend, VERIFICATION_ISOLATION_ACCEPTED, type VerificationBackend, type VerificationCleanupResult,
  type VerificationExecutionRequest, type VerificationExecutionResult, type VerificationLease } from "../src/platform/verification/backend.js";
import type { VerificationReport } from "../src/platform/verification/engine.js";
import type { ConfinementProof } from "../src/platform/verification/confinement-proof.js";

const kind = (name: string) => (error: unknown): boolean => error instanceof FusionFailure && error.error.kind === name;
const PASSED: VerificationReport = { passed: true, status: "passed", steps: [], notRun: [] };
const request: VerificationExecutionRequest = { plan: { commands: [] }, workspaceRoot: "/ws",
  git: {} as never, env: {} };

/** Test-only in-memory backend. It observes nothing; even a "complete" proof it returns cannot flip readiness. */
class FakeBackend implements VerificationBackend {
  readonly id = "fake";
  readonly productionEligible = false as const;
  disposed = 0;
  ran = 0;
  constructor(private readonly opts: { available?: boolean; confinement?: VerificationBackend["confinement"];
    cleanup?: VerificationCleanupResult; behavior?: "return" | "throw" | "hang"; proof?: ConfinementProof } = {}) {}
  get confinement(): VerificationBackend["confinement"] { return this.opts.confinement ?? "none"; }
  probe(): Promise<{ backendId: string; available: boolean; confinement: VerificationBackend["confinement"]; reason?: string }> {
    return Promise.resolve({ backendId: this.id, available: this.opts.available ?? true, confinement: this.confinement,
      ...(this.opts.available === false ? { reason: "test-unavailable" } : {}) });
  }
  prepare(): Promise<VerificationLease> {
    return Promise.resolve({ backendId: this.id, confinement: this.confinement, workspaceRoot: "/ws" });
  }
  run(): Promise<VerificationExecutionResult> {
    this.ran++;
    if (this.opts.behavior === "throw")
      return Promise.reject(new FusionFailure({ kind: "ProcessFailure", retryable: false, safeMessage: "run failed" }));
    if (this.opts.behavior === "hang") return new Promise(() => { /* never settles until aborted/timeout */ });
    return Promise.resolve({ backendId: this.id, confinement: this.confinement, report: PASSED, passed: true });
  }
  collectProof(): Promise<ConfinementProof | undefined> { return Promise.resolve(this.opts.proof); }
  dispose(): Promise<VerificationCleanupResult> { this.disposed++; return Promise.resolve(this.opts.cleanup ?? { complete: true }); }
}

test("O5.5B4 isolation acceptance is a hard-wired false in this milestone", () => {
  assert.equal(VERIFICATION_ISOLATION_ACCEPTED, false);
});

test("O5.5B4 an unavailable backend fails closed before any run", async () => {
  const backend = new FakeBackend({ available: false });
  await assert.rejects(executeVerification(backend, request), kind("CapabilityUnavailable"));
  assert.equal(backend.ran, 0);
});

test("O5.5B4 unknown/unsupported backend ids fail closed", () => {
  assert.equal(createVerificationBackend("does-not-exist"), undefined);
  assert.throws(() => requireVerificationBackend("does-not-exist"), kind("CapabilityUnavailable"));
  assert.equal(createVerificationBackend("trusted-host") instanceof TrustedHostBackend, true);
  assert.equal(requireVerificationBackend("trusted-host").id, "trusted-host");
});

test("O5.5B4 incomplete cleanup fails closed even when verification passed, and dispose always runs", async () => {
  const backend = new FakeBackend({ cleanup: { complete: false, reason: "temp not removed" } });
  await assert.rejects(executeVerification(backend, request), kind("SecurityViolation"));
  assert.equal(backend.disposed, 1);
});

test("O5.5B4 a run error propagates and cleanup still runs", async () => {
  const backend = new FakeBackend({ behavior: "throw" });
  await assert.rejects(executeVerification(backend, request), kind("ProcessFailure"));
  assert.equal(backend.disposed, 1);
});

test("O5.5B4 a wall-clock timeout fails closed and cleanup still runs", async () => {
  const backend = new FakeBackend({ behavior: "hang" });
  await assert.rejects(executeVerification(backend, { ...request, timeoutMs: 40 }), kind("Timeout"));
  assert.equal(backend.disposed, 1);
});

test("O5.5B4 an invalid timeout fails closed", async () => {
  await assert.rejects(executeVerification(new FakeBackend(), { ...request, timeoutMs: 0 }), kind("InvalidInput"));
  await assert.rejects(executeVerification(new FakeBackend(), { ...request, timeoutMs: -5 }), kind("InvalidInput"));
});

test("O5.5B4 a successful lifecycle returns the Fusion-owned report", async () => {
  const backend = new FakeBackend();
  const result = await executeVerification(backend, request);
  assert.equal(result.passed, true);
  assert.equal(result.report, PASSED);
  assert.equal(backend.disposed, 1);
});

test("O5.5B4 no backend, fake or confined, can set productionEligible or verification-isolation eligibility", () => {
  const host = new TrustedHostBackend();
  assert.equal(host.confinement, "none");
  assert.equal(host.productionEligible, false);
  assert.deepEqual(pick(backendReadiness(host)), { verificationIsolationEligible: false, productionEligible: false });
  // A fake backend claiming OS sandboxing and carrying a (fabricated) "complete" confinement proof still cannot flip it.
  const lying = new FakeBackend({ confinement: "osSandbox", proof: { complete: true } as unknown as ConfinementProof });
  assert.deepEqual(pick(backendReadiness(lying, { complete: true } as unknown as ConfinementProof)),
    { verificationIsolationEligible: false, productionEligible: false });
});

test("O5.5B4 the trusted host backend delegates to the engine and produces no confinement proof", async () => {
  const engine = { run: (): Promise<VerificationReport> => Promise.resolve(PASSED) };
  const host = new TrustedHostBackend(engine as never);
  const lease = await host.prepare(request);
  const result = await host.run(lease, request);
  assert.equal(result.passed, true);
  assert.equal(result.confinement, "none");
  assert.equal(await host.collectProof(), undefined);
  assert.deepEqual(await host.dispose(), { complete: true });
  assert.throws(() => host.prepare({ ...request, workspaceRoot: "" }), kind("InvalidInput"));
});

function pick(readiness: ReturnType<typeof backendReadiness>): Readonly<{ verificationIsolationEligible: boolean; productionEligible: boolean }> {
  return { verificationIsolationEligible: readiness.verificationIsolationEligible, productionEligible: readiness.productionEligible };
}
