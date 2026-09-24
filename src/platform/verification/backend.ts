import type { GitClient } from "../workspace/git.js";
import { failWith, FusionFailure } from "../../core/errors.js";
import { VerificationEngine, type VerificationReport, type VerificationRunOptions } from "./engine.js";
import type { ConfinementProof } from "./confinement-proof.js";
import type { VerificationPlan } from "../../core/domain.js";

/**
 * Provider-independent, technology-independent verification backend contract. It is deliberately neutral: it names no
 * AppContainer, Windows Sandbox, Docker or specific OS mechanism, so future confined backends can implement it without
 * the core changing. The lifecycle is probe → prepare → run → collect proof → dispose.
 *
 * Two safety invariants are hard-wired here and cannot be flipped by a backend, a fake, or configuration in this
 * milestone:
 *  1. `VERIFICATION_ISOLATION_ACCEPTED` is a constant `false`: no backend, however complete its confinement proof,
 *     is accepted for production verification isolation yet. Missing or partial proof therefore also fails closed.
 *  2. Nothing here can make an autonomous Writer eligible. A trusted/unconfined host backend is explicitly marked
 *     `confinement: "none"` and can never be `productionEligible`. The confinement proof contract stays conservative.
 */
export const VERIFICATION_ISOLATION_ACCEPTED = false as const;

/** How strongly the backend confines a verifier. `none` is a trusted, unconfined host run. */
export type VerificationConfinement = "none" | "osSandbox" | "vm";

export interface VerificationBackendProbe {
  readonly backendId: string;
  readonly available: boolean;
  readonly confinement: VerificationConfinement;
  /** Stable reason when unavailable, for a fail-closed message. Never a raw host path or secret. */
  readonly reason?: string;
}
export interface VerificationExecutionRequest {
  readonly plan: VerificationPlan;
  readonly workspaceRoot: string;
  readonly git: GitClient;
  /** The verifier environment. Callers build this with `buildVerifierEnvironment`; it carries no provider credential. */
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  /** Optional wall-clock ceiling for the whole run, beyond the per-command timeouts the engine already enforces. */
  readonly timeoutMs?: number;
  readonly engineOptions?: Omit<VerificationRunOptions, "workspaceRoot" | "git" | "env" | "signal">;
}
export interface VerificationLease {
  readonly backendId: string;
  readonly confinement: VerificationConfinement;
  readonly workspaceRoot: string;
}
export interface VerificationExecutionResult {
  readonly backendId: string;
  readonly confinement: VerificationConfinement;
  /** Fusion-owned observation. A model's claim that tests passed is never authoritative; this report is. */
  readonly report: VerificationReport;
  readonly passed: boolean;
  /** A confinement proof if the backend produced one; a trusted host backend produces none. */
  readonly proof?: ConfinementProof;
}
export interface VerificationCleanupResult {
  readonly complete: boolean;
  /** Stable reason when cleanup did not complete; the operation then fails closed. */
  readonly reason?: string;
}

export interface VerificationBackend {
  readonly id: string;
  readonly confinement: VerificationConfinement;
  /** Constant `false` in this milestone; a backend can never advertise production eligibility. */
  readonly productionEligible: false;
  probe(signal?: AbortSignal): Promise<VerificationBackendProbe>;
  prepare(request: VerificationExecutionRequest): Promise<VerificationLease>;
  run(lease: VerificationLease, request: VerificationExecutionRequest): Promise<VerificationExecutionResult>;
  collectProof(lease: VerificationLease): Promise<ConfinementProof | undefined>;
  dispose(lease: VerificationLease): Promise<VerificationCleanupResult>;
}

/**
 * The trusted, unconfined host backend. It runs the existing O1 VerificationEngine directly against a caller-owned
 * workspace with a least-privilege verifier environment. It provides NO OS confinement, so it is `confinement: "none"`
 * and never `productionEligible`; it exists so read-only review/build flows have a backend today, and as the reference
 * shape for future confined backends. It must never be used to satisfy autonomous Writer readiness.
 */
export class TrustedHostBackend implements VerificationBackend {
  readonly id = "trusted-host";
  readonly confinement = "none" as const;
  readonly productionEligible = false as const;
  constructor(private readonly engine: VerificationEngine = new VerificationEngine()) {}

  probe(): Promise<VerificationBackendProbe> {
    return Promise.resolve({ backendId: this.id, available: true, confinement: this.confinement });
  }
  prepare(request: VerificationExecutionRequest): Promise<VerificationLease> {
    if (typeof request.workspaceRoot !== "string" || request.workspaceRoot.length === 0)
      failWith("InvalidInput", "Verification backend requires a workspace root.");
    return Promise.resolve({ backendId: this.id, confinement: this.confinement, workspaceRoot: request.workspaceRoot });
  }
  async run(lease: VerificationLease, request: VerificationExecutionRequest): Promise<VerificationExecutionResult> {
    const report = await this.engine.run(request.plan, { ...request.engineOptions, workspaceRoot: lease.workspaceRoot,
      git: request.git, env: request.env, ...(request.signal ? { signal: request.signal } : {}) });
    return { backendId: this.id, confinement: this.confinement, report, passed: report.passed };
  }
  /** A trusted host run observes no OS confinement, so it produces no confinement proof. */
  collectProof(): Promise<ConfinementProof | undefined> { return Promise.resolve(undefined); }
  /** The workspace is caller-owned; the host backend creates nothing to tear down. */
  dispose(): Promise<VerificationCleanupResult> { return Promise.resolve({ complete: true }); }
}

const BACKENDS = new Map<string, () => VerificationBackend>([["trusted-host", () => new TrustedHostBackend()]]);

/** Construct a registered backend by id, or `undefined` for an unknown id. */
export function createVerificationBackend(id: string): VerificationBackend | undefined {
  return BACKENDS.get(id)?.();
}
/** Construct a registered backend by id, failing closed for an unknown/unsupported id. */
export function requireVerificationBackend(id: string): VerificationBackend {
  const backend = createVerificationBackend(id);
  if (backend === undefined) failWith("CapabilityUnavailable", `No verification backend is registered as ${JSON.stringify(id)}.`);
  return backend;
}

/**
 * Runs the full lifecycle and fails closed on every unsafe path: an unavailable backend, a run error or wall-clock
 * timeout, and incomplete cleanup. Disposal is always attempted, and an incomplete cleanup fails the operation even
 * when the verification itself passed — an unverified teardown must never be reported as success.
 */
export async function executeVerification(backend: VerificationBackend,
  request: VerificationExecutionRequest): Promise<VerificationExecutionResult> {
  const probe = await backend.probe(request.signal);
  if (!probe.available)
    failWith("CapabilityUnavailable", `Verification backend ${JSON.stringify(backend.id)} is unavailable: ${probe.reason ?? "no reason given"}.`);
  const lease = await backend.prepare(request);
  let result: VerificationExecutionResult | undefined;
  let runError: unknown;
  try {
    result = await withOptionalTimeout(request, signal => backend.run(lease,
      signal === undefined ? request : { ...request, signal }));
  } catch (error) { runError = error; }
  const cleanup = await backend.dispose(lease).catch((error: unknown): VerificationCleanupResult =>
    ({ complete: false, reason: error instanceof FusionFailure ? error.error.safeMessage : "cleanup threw" }));
  if (runError !== undefined) throw runError;
  if (!cleanup.complete)
    failWith("SecurityViolation", `Verification backend cleanup did not complete: ${cleanup.reason ?? "unknown"}.`);
  return result!;
}

async function withOptionalTimeout(request: VerificationExecutionRequest,
  work: (signal: AbortSignal | undefined) => Promise<VerificationExecutionResult>): Promise<VerificationExecutionResult> {
  if (request.timeoutMs === undefined) return work(request.signal);
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1)
    failWith("InvalidInput", "Verification backend timeout must be a positive integer.");
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  request.signal?.addEventListener("abort", onAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new FusionFailure({ kind: "Timeout", retryable: false,
      safeMessage: "Verification backend exceeded its wall-clock limit." })); }, request.timeoutMs);
  });
  try { return await Promise.race([work(controller.signal), timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); request.signal?.removeEventListener("abort", onAbort); }
}

export interface BackendReadiness {
  readonly backendId: string;
  readonly confinement: VerificationConfinement;
  /** Whether this backend could satisfy the verification-isolation prerequisite. Always false in this milestone. */
  readonly verificationIsolationEligible: false;
  /** Whether this backend could open production Writer readiness. Always false in this milestone. */
  readonly productionEligible: false;
  readonly notes: readonly string[];
}
/**
 * Fixed readiness verdict for a backend. It is intentionally hard-wired to `false/false`: even a confined backend with
 * a complete confinement proof is not accepted for production in this milestone, and a trusted/unconfined backend
 * never could be. This keeps a fake or misconfigured backend from ever making isolation or Writer readiness YES.
 */
export function backendReadiness(backend: VerificationBackend, proof?: ConfinementProof): BackendReadiness {
  const notes: string[] = [];
  if (backend.confinement === "none") notes.push("Trusted/unconfined host backend: no OS confinement is observed.");
  if (proof === undefined) notes.push("No confinement proof is present.");
  if (!VERIFICATION_ISOLATION_ACCEPTED)
    notes.push("Verification isolation is not accepted for production in this milestone; readiness stays closed.");
  return Object.freeze({ backendId: backend.id, confinement: backend.confinement,
    verificationIsolationEligible: false, productionEligible: false, notes: Object.freeze(notes) });
}
