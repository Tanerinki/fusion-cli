import { createHash } from "node:crypto";
import { CONFINEMENT_FACTS, CONFINEMENT_PROTOCOL_VERSION, type ConfinementFact, type ConfinementFactState,
  type ConfinementProofExpectation } from "../../src/platform/verification/confinement-proof.js";

/**
 * Test-only stand-in for a future confinement helper. It observes nothing: it emits whatever result its scenario asks
 * for, so even an all-pass fake proof demonstrates the contract, never confinement. It lives under test/, and no file
 * under src/ may import it.
 */
export const FAKE_BACKEND = "test-fake";
export const FAKE_HELPER_SHA256 = createHash("sha256").update("fusion test-only fake confinement helper").digest("hex");
export const FAKE_PLATFORM = "win32-x64";
export const FAKE_OBSERVED_AT = "2026-09-23T12:00:00.000Z";
const observedAtMs = Date.parse(FAKE_OBSERVED_AT);

export interface FakeScenario {
  /** Per-fact states; unlisted facts are `observedPass`. Attempt counts follow the state consistently. */
  readonly states?: Readonly<Partial<Record<ConfinementFact, ConfinementFactState>>>;
  /** Top-level properties merged over the result, used to build malformed or foreign payloads. */
  readonly patch?: Readonly<Record<string, unknown>>;
}

/** The result object a helper would serialize. */
export function fakeProofResult(scenario: FakeScenario = {}): Record<string, unknown> {
  const observations = CONFINEMENT_FACTS.map(fact => {
    const state = scenario.states?.[fact] ?? "observedPass";
    return { fact, state, attempts: state === "notObserved" ? 0 : 2, failures: state === "observedFail" ? 1 : 0 };
  });
  return { protocolVersion: CONFINEMENT_PROTOCOL_VERSION, backend: FAKE_BACKEND, helperSha256: FAKE_HELPER_SHA256,
    platform: FAKE_PLATFORM, observedAt: FAKE_OBSERVED_AT, observations, ...scenario.patch };
}

/** One fake helper run: its stdout, exactly as a future helper would hand it to Fusion. */
export function runFakeConfinementBackend(scenario: FakeScenario = {}): string {
  return JSON.stringify(fakeProofResult(scenario));
}

/** The host-side pin for the fake helper, with a run window around its fixed observation time. */
export function fakeExpectation(overrides: Partial<ConfinementProofExpectation> = {}): ConfinementProofExpectation {
  return { backend: FAKE_BACKEND, helperSha256: FAKE_HELPER_SHA256, platform: FAKE_PLATFORM,
    observedWindow: { notBeforeMs: observedAtMs - 1_000, notAfterMs: observedAtMs + 1_000 }, ...overrides };
}
