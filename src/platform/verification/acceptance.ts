/**
 * The shape and brand of a verification-isolation acceptance. Technology-neutral: it names no backend mechanism, so
 * readiness consumers (the Writer gate) depend on this module only. Grants are minted exclusively by the acceptance
 * authority (`production.ts`) and branded here; a copy, a parsed object or a fixture is never a granted acceptance.
 */
export const LINUX_VERIFICATION_CONTRACT = "fusion-verification-confinement-v0.1-linux";

export interface VerificationIsolationAcceptance {
  readonly accepted: true;
  readonly contract: typeof LINUX_VERIFICATION_CONTRACT;
  readonly backendId: string;
  readonly semantics: "linux";
  readonly satisfies: readonly ("platform-neutral" | "linux-compatible")[];
  readonly windowsAccepted: false;
  readonly scope: string;
  readonly runtime: Readonly<{ engineOs: string; engineArch: string; engineVersion: string; kernel: string; platformName: string;
    image: string; imageId: string; node: string }>;
  readonly evidence: Readonly<{ required: number; passed: number }>;
  readonly observedAt: string;
}
export interface AcceptanceRefusal {
  readonly accepted: false;
  readonly reasons: readonly string[];
}

const GRANTED = new WeakSet<object>();
/** Brands a frozen acceptance. Only the acceptance authority calls this, after every mechanical check passed. */
export function brandGrantedAcceptance(acceptance: VerificationIsolationAcceptance): VerificationIsolationAcceptance {
  GRANTED.add(Object.isFrozen(acceptance) ? acceptance : Object.freeze(acceptance));
  return acceptance;
}
/** True only for an acceptance granted in this process. */
export const isGrantedAcceptance = (value: unknown): value is VerificationIsolationAcceptance =>
  typeof value === "object" && value !== null && GRANTED.has(value);
