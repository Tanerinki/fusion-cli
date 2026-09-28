import { canonicalJson, deepFreeze, sha256Hex } from "../delivery/canonical.js";
import type { VerificationCommand } from "../domain.js";
import type { ObligationRequirement } from "../evidence/obligations.js";
import { TOURNAMENT_LIMITS, type CandidateId } from "./contracts.js";

/**
 * v0.5 — THE VERIFICATION PROFILE, FROZEN BEFORE ANY RESULT. Every candidate of a tournament faces the same common profile:
 * the configured confined checks, the baseline reproduction's expectation, the proof obligations of the reliability policy,
 * the falsification requirement and the repository's configured experiments. Fusion freezes it — and records its SHA-256 —
 * before the first candidate exists, so no candidate can be given easier checks after its result is known.
 *
 * A candidate-specific addition (for example Fusion's mutations of that candidate's own change) may only ADD checks: it can
 * never remove, rename or replace a common one.
 */

/**
 * An experiment the repository owner configured (fusion.config.json), run by Fusion in confinement. Its expectation is
 * host-owned data — never a model's.
 * - `baseline`: a preservation condition — the candidate's exit code and output must equal the unchanged baseline's.
 * - `output`: an explicit oracle — the candidate must exit with `exitCode` and, when given, print exactly `stdout`.
 * - `compare`: no oracle — Fusion compares the candidates' outputs; a difference discriminates but eliminates no one.
 */
export type ProbeExpectation = Readonly<{ kind: "baseline" }> | Readonly<{ kind: "output"; exitCode: number; stdout?: string }> |
  Readonly<{ kind: "compare" }>;
export interface ProbeSpec { readonly id: string; readonly command: VerificationCommand; readonly expect: ProbeExpectation }
/**
 * A bounded property or fuzz run of the repository's own harness: Fusion appends `[seedArg, <seed>, casesArg, <cases>]` to its
 * argv, with a deterministic seed, so a failure can be replayed exactly. Exit 0: no counterexample in `cases` cases.
 */
export interface GeneratedSpec {
  readonly id: string;
  readonly command: VerificationCommand;
  readonly seedArg: string;
  readonly casesArg: string;
  readonly cases: number;
}
export interface ExperimentSpecs {
  readonly probes: readonly ProbeSpec[];
  readonly property: readonly GeneratedSpec[];
  readonly fuzz: readonly GeneratedSpec[];
  /** Fusion-owned mutations of each candidate's own change (partial reverts); `maxPerCandidate` within the hard limit. */
  readonly mutation: Readonly<{ enabled: boolean; maxPerCandidate: number }>;
}
export const NO_EXPERIMENTS: ExperimentSpecs = Object.freeze({ probes: Object.freeze([]), property: Object.freeze([]), fuzz: Object.freeze([]),
  mutation: Object.freeze({ enabled: false, maxPerCandidate: 0 }) });

export const PROFILE_FORMAT = "fusion.verificationProfile" as const;
export interface VerificationProfile {
  readonly format: typeof PROFILE_FORMAT;
  readonly version: 1;
  readonly policyVersion: string;
  /** The configured confined checks every candidate must pass (id and a digest of the exact command). */
  readonly commands: readonly Readonly<{ id: string; sha256: string }>[];
  /** What the unchanged baseline showed: the checks that failed there must pass after a fix. */
  readonly baseline: Readonly<{ reproduced: boolean; failing: readonly string[] }>;
  readonly obligations: readonly ObligationRequirement[];
  readonly falsification: "required" | "optional";
  readonly experiments: Readonly<{
    probes: readonly Readonly<{ id: string; expect: ProbeExpectation["kind"]; sha256: string }>[];
    property: readonly Readonly<{ id: string; cases: number; sha256: string }>[];
    fuzz: readonly Readonly<{ id: string; cases: number; sha256: string }>[];
    mutation: Readonly<{ enabled: boolean; maxPerCandidate: number }>;
  }>;
}
export interface FrozenProfile { readonly profile: VerificationProfile; readonly sha256: string }

const commandDigest = (command: VerificationCommand): string => sha256Hex(canonicalJson({ id: command.id, executable: command.executable,
  args: command.args, cwd: command.cwd, timeoutMs: command.timeoutMs, mutationPolicy: command.mutationPolicy }));
const ID = /^[a-z][a-z0-9-]{0,31}$/u;

export interface ProfileInput {
  readonly policyVersion: string;
  readonly commands: readonly VerificationCommand[];
  readonly baseline: Readonly<{ reproduced: boolean; failing: readonly string[] }>;
  readonly obligations: readonly ObligationRequirement[];
  readonly falsification: "required" | "optional";
  readonly experiments: ExperimentSpecs;
}
/** Freezes the common profile: bounded, validated, and hashed canonically. */
export function freezeProfile(input: ProfileInput): FrozenProfile {
  const e = input.experiments;
  if (e.probes.length > TOURNAMENT_LIMITS.maxProbes || e.property.length > TOURNAMENT_LIMITS.maxPropertyRuns ||
      e.fuzz.length > TOURNAMENT_LIMITS.maxFuzzRuns)
    throw new RangeError("The configured experiments exceed the tournament's bounds.");
  if (e.property.some(p => p.cases < 1 || p.cases > TOURNAMENT_LIMITS.maxPropertyCases) ||
      e.fuzz.some(f => f.cases < 1 || f.cases > TOURNAMENT_LIMITS.maxFuzzCases))
    throw new RangeError("A property or fuzz run exceeds its case bound.");
  if (e.mutation.maxPerCandidate < 0 || e.mutation.maxPerCandidate > TOURNAMENT_LIMITS.maxMutationsPerCandidate)
    throw new RangeError("The mutation budget exceeds its bound.");
  const ids = [...input.commands.map(c => c.id), ...e.probes.map(p => `probe:${p.id}`), ...e.property.map(p => `property:${p.id}`),
    ...e.fuzz.map(f => `fuzz:${f.id}`)];
  if (new Set(ids).size !== ids.length) throw new RangeError("Two checks of the profile share an id.");
  if ([...e.probes, ...e.property, ...e.fuzz].some(x => !ID.test(x.id))) throw new RangeError("An experiment id is invalid.");
  const profile: VerificationProfile = deepFreeze({
    format: PROFILE_FORMAT, version: 1, policyVersion: input.policyVersion,
    commands: input.commands.map(c => ({ id: c.id, sha256: commandDigest(c) })),
    baseline: { reproduced: input.baseline.reproduced, failing: [...input.baseline.failing].sort() },
    obligations: input.obligations.map(o => ({ kind: o.kind, tier: o.tier })),
    falsification: input.falsification,
    experiments: {
      probes: e.probes.map(p => ({ id: p.id, expect: p.expect.kind, sha256: sha256Hex(canonicalJson({ command: commandDigest(p.command), expect: p.expect })) })),
      property: e.property.map(p => ({ id: p.id, cases: p.cases, sha256: sha256Hex(canonicalJson({ command: commandDigest(p.command), seedArg: p.seedArg, casesArg: p.casesArg })) })),
      fuzz: e.fuzz.map(f => ({ id: f.id, cases: f.cases, sha256: sha256Hex(canonicalJson({ command: commandDigest(f.command), seedArg: f.seedArg, casesArg: f.casesArg })) })),
      mutation: { enabled: e.mutation.enabled, maxPerCandidate: e.mutation.maxPerCandidate },
    },
  });
  return Object.freeze({ profile, sha256: sha256Hex(canonicalJson(profile)) });
}

/** Every common check a candidate must have a host-observed result for, in a stable order. */
export function requiredChecks(profile: VerificationProfile): readonly string[] {
  return Object.freeze([...profile.commands.map(c => c.id), ...profile.experiments.probes.filter(p => p.expect !== "compare").map(p => `probe:${p.id}`),
    ...profile.experiments.property.map(p => `property:${p.id}`), ...profile.experiments.fuzz.map(f => `fuzz:${f.id}`)]);
}

/** A check Fusion adds for one candidate (derived from that candidate's own change). */
export interface ProfileAddition { readonly id: string; readonly kind: "mutation"; readonly sha256: string }
export interface CandidateProfile {
  readonly common: string;
  readonly candidate: CandidateId;
  readonly additions: readonly ProfileAddition[];
  readonly sha256: string;
}
export class ProfileWeakened extends Error {}
/**
 * The profile one candidate faces: the common profile, unchanged, plus additions. An addition that collides with a common
 * check (it would replace it) is refused; there is no way to express a removal.
 */
export function candidateProfile(common: FrozenProfile, candidate: CandidateId, additions: readonly ProfileAddition[]): CandidateProfile {
  const taken = new Set(requiredChecks(common.profile));
  const seen = new Set<string>();
  for (const a of additions) {
    if (taken.has(a.id) || seen.has(a.id)) throw new ProfileWeakened(`The addition ${a.id} would replace a check of the profile.`);
    seen.add(a.id);
  }
  const frozen = deepFreeze(additions.map(a => ({ id: a.id, kind: a.kind, sha256: a.sha256 })));
  return Object.freeze({ common: common.sha256, candidate, additions: frozen,
    sha256: sha256Hex(canonicalJson({ common: common.sha256, candidate, additions: frozen })) });
}
