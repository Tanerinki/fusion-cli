import { failWith } from "../../core/errors.js";
import { parseStrictJson, StrictJsonError } from "../process/strict-json.js";

/**
 * The Fusion-side contract for a future verification confinement helper. The helper reports observed facts only, in a
 * closed, versioned and bounded result with no free-text field, so it cannot carry an environment dump, source text or
 * credentials. A fact holds only when it was observed to hold: `notObserved` is never a pass. The contract names no
 * provider or backend. No confinement backend exists yet, and no proof can open production readiness in this release.
 */
export const CONFINEMENT_PROTOCOL_VERSION = 1;
/** Every fact of protocol version 1 is required for a complete proof. */
export const CONFINEMENT_FACTS = Object.freeze([
  "grantedReadWorks", "grantedWriteWorks", "ungrantedReadDenied", "ungrantedWriteDenied", "profileIsolation",
  "registryIsolation", "networkIsolation", "descendantContainment", "timeoutEnforced", "cleanupComplete",
] as const);
export type ConfinementFact = typeof CONFINEMENT_FACTS[number];
export const CONFINEMENT_FACT_STATES = Object.freeze(["observedPass", "observedFail", "notObserved"] as const);
export type ConfinementFactState = typeof CONFINEMENT_FACT_STATES[number];
export const CONFINEMENT_PLATFORMS = Object.freeze(["win32-x64", "win32-arm64", "linux-x64", "linux-arm64",
  "darwin-x64", "darwin-arm64"] as const);
export type ConfinementPlatform = typeof CONFINEMENT_PLATFORMS[number];
/** Larger input is malformed, never truncated into validity. Depth 3 is result object, observations, observation. */
export const CONFINEMENT_LIMITS = Object.freeze({ maxResultBytes: 4096, maxDepth: 3, maxBackendChars: 32, maxAttempts: 64 });

/**
 * `attempts` counts the helper's probes of a fact and `failures` those where confinement did not hold. The state must
 * agree with them: `notObserved` has no attempt, `observedPass` has attempts and no failure, `observedFail` a failure.
 */
export interface ConfinementObservation {
  readonly fact: ConfinementFact;
  readonly state: ConfinementFactState;
  readonly attempts: number;
  readonly failures: number;
}
export interface ConfinementProof {
  readonly protocolVersion: typeof CONFINEMENT_PROTOCOL_VERSION;
  /** Backend identifier chosen by the helper, e.g. `example-backend`; it is compared, never interpreted. */
  readonly backend: string;
  /** Lowercase SHA-256 of the helper executable, as the helper reports it. */
  readonly helperSha256: string;
  readonly platform: ConfinementPlatform;
  /** UTC time the observation finished, in `Date.prototype.toISOString` form. */
  readonly observedAt: string;
  /** Exactly one observation per fact, in `CONFINEMENT_FACTS` order after validation. */
  readonly observations: readonly ConfinementObservation[];
}

const RESULT_KEYS = ["protocolVersion", "backend", "helperSha256", "platform", "observedAt", "observations"] as const;
const OBSERVATION_KEYS = ["fact", "state", "attempts", "failures"] as const;
const BACKEND = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const HASH = /^[0-9a-f]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const facts = new Set<unknown>(CONFINEMENT_FACTS), states = new Set<unknown>(CONFINEMENT_FACT_STATES);
const platforms = new Set<unknown>(CONFINEMENT_PLATFORMS);

const malformed = (what: string): never => failWith("MalformedOutput", `Confinement proof ${what}.`);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean =>
  Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const isBackend = (value: unknown): value is string =>
  typeof value === "string" && value.length <= CONFINEMENT_LIMITS.maxBackendChars && BACKEND.test(value);
const isHash = (value: unknown): value is string => typeof value === "string" && HASH.test(value);
const isPlatform = (value: unknown): value is ConfinementPlatform => platforms.has(value);
const isTimestamp = (value: unknown): value is string => typeof value === "string" && TIMESTAMP.test(value) &&
  !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const isCount = (value: unknown, max: number): value is number => Number.isSafeInteger(value) &&
  (value as number) >= 0 && (value as number) <= max;
/** Detaches untrusted input from its producer: no getters, proxies or later mutation reach the validator. */
function detach(value: unknown): unknown {
  try { return structuredClone(value); } catch { return malformed("is not plain data"); }
}

function validateObservation(raw: unknown): ConfinementObservation {
  if (!isRecord(raw) || !exactKeys(raw, OBSERVATION_KEYS) || !facts.has(raw.fact) || !states.has(raw.state) ||
      !isCount(raw.attempts, CONFINEMENT_LIMITS.maxAttempts) || !isCount(raw.failures, raw.attempts))
    return malformed("observation has invalid or extra properties");
  const { fact, state, attempts, failures } = raw as unknown as ConfinementObservation;
  const consistent = state === "notObserved" ? attempts === 0
    : state === "observedPass" ? attempts > 0 && failures === 0 : failures > 0;
  if (!consistent) malformed("observation state contradicts its attempt counts");
  return Object.freeze({ fact, state, attempts, failures });
}

/**
 * Validates an already-parsed helper result. The protocol version is checked first, so a result of another version is
 * refused as unsupported (`ProtocolError`) before its shape is judged. Every other defect is `MalformedOutput`.
 */
export function validateConfinementProof(raw: unknown): ConfinementProof {
  const value = detach(raw);
  if (!isRecord(value) || !Object.hasOwn(value, "protocolVersion")) return malformed("has no protocol version");
  if (Number.isSafeInteger(value.protocolVersion) && value.protocolVersion !== CONFINEMENT_PROTOCOL_VERSION)
    failWith("ProtocolError", "Confinement proof protocol version is not supported.");
  if (value.protocolVersion !== CONFINEMENT_PROTOCOL_VERSION || !exactKeys(value, RESULT_KEYS))
    return malformed("has an invalid shape or extra properties");
  if (!isBackend(value.backend) || !isHash(value.helperSha256) || !isPlatform(value.platform) ||
      !isTimestamp(value.observedAt))
    return malformed("identity metadata is invalid");
  if (!Array.isArray(value.observations) || value.observations.length !== CONFINEMENT_FACTS.length)
    return malformed("must report each fact exactly once");
  const byFact = new Map<ConfinementFact, ConfinementObservation>();
  for (const entry of value.observations) {
    const observation = validateObservation(entry);
    if (byFact.has(observation.fact)) malformed("reports a fact more than once");
    byFact.set(observation.fact, observation);
  }
  return Object.freeze({ protocolVersion: CONFINEMENT_PROTOCOL_VERSION, backend: value.backend,
    helperSha256: value.helperSha256, platform: value.platform, observedAt: value.observedAt,
    observations: Object.freeze(CONFINEMENT_FACTS.map(fact => byFact.get(fact)!)) });
}

/** Helper output is untrusted text: bounded bytes, strict JSON. A duplicate key is a contradiction, never last-wins. */
export function decodeConfinementProof(text: unknown): ConfinementProof {
  if (typeof text !== "string" || text.length > CONFINEMENT_LIMITS.maxResultBytes ||
      Buffer.byteLength(text, "utf8") > CONFINEMENT_LIMITS.maxResultBytes)
    return malformed("output exceeds the size limit");
  let value: unknown;
  try { value = parseStrictJson(text, CONFINEMENT_LIMITS.maxDepth); }
  catch (error) {
    if (error instanceof StrictJsonError) return malformed(`JSON was rejected (${error.reason})`);
    throw error;
  }
  return validateConfinementProof(value);
}

/** What the host pinned before launching the helper. A proof about any other helper, platform or run proves nothing. */
export interface ConfinementProofExpectation {
  readonly backend: string;
  readonly helperSha256: string;
  readonly platform: ConfinementPlatform;
  /** Host-clock bounds of this helper run; an `observedAt` outside them is stale, replayed or from the future. */
  readonly observedWindow: Readonly<{ notBeforeMs: number; notAfterMs: number }>;
}
export type ConfinementIdentityField = "backend" | "helperSha256" | "platform" | "observedAt";
export interface ConfinementProofEvaluation {
  /** Every required fact is `observedPass` and the identity metadata matches the expectation. */
  readonly complete: boolean;
  readonly passed: readonly ConfinementFact[];
  readonly failed: readonly ConfinementFact[];
  readonly notObserved: readonly ConfinementFact[];
  readonly identityMismatches: readonly ConfinementIdentityField[];
  /**
   * A constant, not a setting: no confinement backend is accepted for production verification isolation in this
   * release, so a complete proof, fake or otherwise, cannot open verification isolation or the real Writer gate.
   */
  readonly productionEligible: false;
}

function validateExpectation(expected: ConfinementProofExpectation): ConfinementProofExpectation {
  const window = isRecord(expected) ? expected.observedWindow : undefined;
  if (!isRecord(expected) || !isBackend(expected.backend) || !isHash(expected.helperSha256) ||
      !isPlatform(expected.platform) || !isRecord(window) || !isCount(window.notBeforeMs, Number.MAX_SAFE_INTEGER) ||
      !isCount(window.notAfterMs, Number.MAX_SAFE_INTEGER) || window.notBeforeMs > window.notAfterMs)
    failWith("InvalidInput", "Confinement proof expectation is invalid.");
  return expected;
}

/**
 * Answers whether a proof is complete. It validates the proof itself, so nothing unvalidated is ever evaluated, and it
 * never reads the clock: the caller supplies the run window. Completeness is not production readiness.
 */
export function evaluateConfinementProof(raw: unknown, expected: ConfinementProofExpectation): ConfinementProofEvaluation {
  const proof = validateConfinementProof(raw), pin = validateExpectation(expected);
  const withState = (state: ConfinementFactState): readonly ConfinementFact[] =>
    Object.freeze(proof.observations.filter(observation => observation.state === state).map(observation => observation.fact));
  const observedAtMs = Date.parse(proof.observedAt);
  const identityMismatches = Object.freeze([
    ...(proof.backend === pin.backend ? [] : ["backend" as const]),
    ...(proof.helperSha256 === pin.helperSha256 ? [] : ["helperSha256" as const]),
    ...(proof.platform === pin.platform ? [] : ["platform" as const]),
    ...(observedAtMs >= pin.observedWindow.notBeforeMs && observedAtMs <= pin.observedWindow.notAfterMs ? []
      : ["observedAt" as const]),
  ]);
  const passed = withState("observedPass");
  return Object.freeze({ complete: passed.length === CONFINEMENT_FACTS.length && identityMismatches.length === 0,
    passed, failed: withState("observedFail"), notObserved: withState("notObserved"), identityMismatches,
    productionEligible: false });
}
