import { isAbsolute, relative, resolve } from "node:path";
import { sha256Hex } from "../../core/delivery/canonical.js";
import type { ChangeOperation, ChangeScope, ChangeSet, VerificationCommand, VerificationPlan } from "../../core/domain.js";
import type { CandidateId } from "../../core/tournament/contracts.js";
import { patchSha256 } from "../../core/tournament/manifest.js";
import type { MeshNode } from "../../core/tournament/mesh.js";
import { isTestPath, lineHunks, planMutations, type Mutation, type MutationPlan } from "../../core/tournament/mutation.js";
import type { ExperimentSpecs, GeneratedSpec } from "../../core/tournament/profile.js";
import type { CleanupReport, VerificationObservation, VerificationVerdict, WorkspaceHandle, WorkspacePort } from "../../core/workflow/types.js";

/**
 * v0.5 — FUSION'S EXPERIMENTS, EXECUTED. Every experiment runs in confinement through the workspace port — the same backend,
 * the same refusals, never on the host — on a candidate Fusion materializes itself: a fresh private candidate from the
 * committed baseline, with the candidate's exact host ChangeSet applied. The re-materialization must reproduce the tree
 * state the candidate was judged on (its application ledger's digest); anything else is a security violation, never a
 * silently different candidate.
 *
 * A confined run stops at its first failing command, so every experiment runs: after a failure, the commands that did not
 * run go to a new run on a new materialization (at most one run per experiment).
 *
 * Results are nodes of the verification mesh, bound to the candidate's revision. Outputs are compared by digest only, and
 * only when completely retained. A failing property or fuzz case yields a replay recipe (the experiment, its seed and case
 * count) plus a bounded excerpt the caller persists only through the redactor.
 */
export interface MaterializedTarget {
  readonly candidate: CandidateId;
  /** The candidate manifest's SHA-256. */
  readonly revision: string;
  /** The candidate's HOST ChangeSet, exactly as it was applied when the candidate was judged. */
  readonly changes: ChangeSet;
  readonly scope: ChangeScope;
  /** The digest of the application ledger it was judged on. */
  readonly patchSha256: string;
}
export interface Reproducer {
  readonly candidate: CandidateId;
  readonly experiment: string;
  readonly seed: number;
  readonly cases: number;
  /** In memory only; persisted through the redactor, bounded. */
  readonly excerpt: string;
}
export interface ExperimentBatch {
  readonly nodes: readonly MeshNode[];
  readonly reproducers: readonly Reproducer[];
  readonly cleanup: readonly CleanupReport[];
  /** Set when Fusion's own materialization was not what it must be: the tournament stops (CANDIDATE_SECURITY_VIOLATION). */
  readonly violation?: string;
}
/** What one confined command did, as Fusion observed it. */
interface Step {
  readonly status: string;
  readonly exitCode: number | null;
  readonly observation?: VerificationObservation;
}

/** The same deterministic seed for the baseline and every candidate: results are comparable and replayable. */
export function experimentSeed(profileSha256: string, id: string): number {
  return Number.parseInt(sha256Hex(`${profileSha256}:${id}`).slice(0, 8), 16) % 2_147_483_647;
}
/** The confined commands of the experiments, with Fusion's seed and case arguments appended to generated runs. */
export function experimentCommands(specs: ExperimentSpecs, profileSha256: string): readonly VerificationCommand[] {
  const generated = (spec: GeneratedSpec): VerificationCommand => Object.freeze({ ...spec.command,
    args: Object.freeze([...spec.command.args, spec.seedArg, String(experimentSeed(profileSha256, spec.command.id)), spec.casesArg, String(spec.cases)]) });
  return Object.freeze([...specs.probes.map(p => p.command), ...specs.property.map(generated), ...specs.fuzz.map(generated)]);
}

const within = (parent: string, child: string): boolean => {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
type Materialized<T> = Readonly<{ state: "ready"; value: T } | { state: "unavailable" | "violation"; detail: string }>;
type Target = Readonly<{ changes: ChangeSet; scope: ChangeScope; patchSha256?: string }>;

/**
 * A fresh candidate for Fusion's own work: acquired from the baseline (`target` absent: left pristine), refused unless it lies
 * strictly inside the port's candidate root and apart from the primary, used, and released whatever happens — its cleanup
 * report is always pushed to `cleanup`, even when the work throws.
 */
async function withCandidate<T>(port: WorkspacePort, ownerId: string, target: Target | undefined, work: (handle: WorkspaceHandle) => Promise<T>,
  cleanup: CleanupReport[], signal: AbortSignal | undefined): Promise<Materialized<T>> {
  const handle = await port.acquire(ownerId, signal);
  try {
    if (typeof handle?.path !== "string" || !isAbsolute(handle.path) || !within(port.leaseRoot, handle.path) ||
        resolve(port.leaseRoot) === resolve(handle.path) || within(port.primaryRoot, handle.path) || within(handle.path, port.primaryRoot))
      return Object.freeze({ state: "violation", detail: "the workspace port returned a candidate outside its private root" });
    if (target !== undefined) {
      const outcome = await port.apply(handle, target.changes, target.scope, signal);
      if (!("applied" in outcome)) return Object.freeze({ state: "unavailable", detail: "the change no longer applies to the baseline" });
      if (target.patchSha256 !== undefined && patchSha256(outcome.applied) !== target.patchSha256)
        return Object.freeze({ state: "violation", detail: "re-materializing the candidate produced a different tree than the one it was judged on" });
    }
    return Object.freeze({ state: "ready", value: await work(handle) });
  } finally {
    cleanup.push(await port.release(handle).catch(() => Object.freeze({ complete: false, reason: "releaseFailed" })));
  }
}

/**
 * Runs every command in confinement (`target` absent: on the unchanged baseline), each at most once: a run that stopped at a
 * failure is continued from the next command on a new materialization. A refusal, or a run that made no progress, leaves the
 * remaining commands without a step; a step whose input the backend could not prove is a violation.
 */
async function runAll(port: WorkspacePort, ownerId: string, target: Target | undefined, commands: readonly VerificationCommand[],
  cleanup: CleanupReport[], signal: AbortSignal | undefined):
  Promise<Readonly<{ steps: ReadonlyMap<string, Step>; unavailable?: string; violation?: string }>> {
  const steps = new Map<string, Step>();
  let rest = commands;
  for (let round = 0; rest.length > 0; round++) {
    const plan: VerificationPlan = Object.freeze({ commands: rest });
    const verifyBaseline = port.verifyBaseline;
    if (target === undefined && typeof verifyBaseline !== "function") return Object.freeze({ steps, unavailable: "the port cannot verify the baseline" });
    const run = await withCandidate<VerificationVerdict>(port, `${ownerId}.r${round + 1}`, target,
      handle => target === undefined ? verifyBaseline!.call(port, handle, plan, signal) : port.verify(handle, plan, signal), cleanup, signal);
    if (run.state !== "ready") return Object.freeze({ steps, ...(run.state === "violation" ? { violation: run.detail } : { unavailable: run.detail }) });
    const verdict = run.value;
    if (verdict.refusal !== undefined) return Object.freeze({ steps, unavailable: `confined verification refused (${verdict.refusal})` });
    const ran = verdict.evidence?.commands ?? [];
    let progressed = 0;
    for (const [index, command] of rest.entries()) {
      const step = ran[index];
      if (step === undefined || step.id !== command.id) break;
      if (step.status === "mutationViolation") return Object.freeze({ steps, violation: "the confined backend could not prove the input it verified" });
      const observation = verdict.observations?.find(o => o.id === command.id);
      steps.set(command.id, Object.freeze({ status: step.status, exitCode: step.exitCode, ...(observation === undefined ? {} : { observation }) }));
      progressed++;
    }
    if (progressed === 0) return Object.freeze({ steps, unavailable: "the confined run made no progress" });
    rest = rest.slice(progressed);
  }
  return Object.freeze({ steps });
}

const exited = (step: Step | undefined): step is Step & { exitCode: number } =>
  step !== undefined && (step.status === "passed" || step.status === "failed") && typeof step.exitCode === "number";

/** The unchanged baseline's observation of every `baseline` probe (the preservation conditions' reference). */
export async function runBaselineProbes(port: WorkspacePort, ownerId: string, specs: ExperimentSpecs, signal?: AbortSignal):
  Promise<Readonly<{ observations: ReadonlyMap<string, VerificationObservation | undefined>; cleanup: readonly CleanupReport[]; violation?: string }>> {
  const probes = specs.probes.filter(p => p.expect.kind === "baseline");
  const cleanup: CleanupReport[] = [];
  if (probes.length === 0) return Object.freeze({ observations: new Map(), cleanup });
  const run = await runAll(port, ownerId, undefined, probes.map(p => p.command), cleanup, signal);
  const observations = new Map(probes.map(p => {
    const step = run.steps.get(p.command.id);
    return [p.id, exited(step) ? step.observation : undefined] as const;
  }));
  return Object.freeze({ observations, cleanup, ...(run.violation === undefined ? {} : { violation: run.violation }) });
}

/** One candidate's experiments: probes, property and fuzz runs. */
export async function runCandidateExperiments(port: WorkspacePort, ownerId: string, target: MaterializedTarget, specs: ExperimentSpecs,
  profileSha256: string, baseline: ReadonlyMap<string, VerificationObservation | undefined>, signal?: AbortSignal): Promise<ExperimentBatch> {
  const commands = experimentCommands(specs, profileSha256);
  const cleanup: CleanupReport[] = [];
  if (commands.length === 0) return Object.freeze({ nodes: Object.freeze([]), reproducers: Object.freeze([]), cleanup });
  const run = await runAll(port, ownerId, target, commands, cleanup, signal);
  const base = { candidate: target.candidate, revision: target.revision, source: "configured" as const, authority: "deterministic" as const };
  const notRun = (id: string, kind: MeshNode["kind"], detail: string, step?: Step): MeshNode => Object.freeze({ ...base, id, kind,
    result: "notRun" as const, ...(step === undefined ? {} : { exitCode: step.exitCode }), detail });
  const missing = (step: Step | undefined): string => step !== undefined ? `did not complete (${step.status})`
    : run.violation ?? run.unavailable ?? "did not run";
  const nodes: MeshNode[] = [];
  const reproducers: Reproducer[] = [];
  for (const probe of specs.probes) {
    const id = `probe:${probe.id}`, step = run.steps.get(probe.command.id);
    if (!exited(step)) { nodes.push(notRun(id, "probe", missing(step), step)); continue; }
    const seen = step.observation, exit = step.exitCode;
    const observed = { ...(seen === undefined ? {} : { outputSha256: seen.stdoutSha256, complete: seen.complete }), exitCode: exit };
    const expect = probe.expect;
    if (expect.kind === "compare") {
      nodes.push(Object.freeze({ ...base, id, kind: "probe", result: seen?.complete === true ? "observed" : "notRun", ...observed,
        detail: seen?.complete === true ? `exit ${exit}; output recorded for comparison` : "the output was not retained completely: not comparable" }));
    } else if (expect.kind === "baseline") {
      const reference = baseline.get(probe.id);
      if (seen?.complete !== true || reference?.complete !== true) {
        nodes.push(Object.freeze({ ...base, id, kind: "probe", result: "notRun", ...observed,
          detail: "the output of the candidate or of the baseline was not retained completely: not comparable" }));
        continue;
      }
      const same = exit === reference.exitCode && seen.stdoutSha256 === reference.stdoutSha256;
      nodes.push(Object.freeze({ ...base, id, kind: "probe", result: same ? "pass" : "fail", ...observed, obligation: "behaviorPreserved",
        detail: same ? "behaves exactly like the unchanged baseline" : `differs from the unchanged baseline (exit ${exit} vs ${reference.exitCode})` }));
    } else {
      if (expect.stdout !== undefined && seen?.complete !== true) {
        nodes.push(Object.freeze({ ...base, id, kind: "probe", result: "notRun", ...observed,
          detail: "the output was not retained completely: the expected output cannot be checked" }));
        continue;
      }
      const exitOk = exit === expect.exitCode, outputOk = expect.stdout === undefined || seen!.stdoutSha256 === sha256Hex(expect.stdout);
      nodes.push(Object.freeze({ ...base, id, kind: "probe", result: exitOk && outputOk ? "pass" : "fail", ...observed,
        detail: exitOk && outputOk ? "matches the configured expectation"
          : `does not match the configured expectation (${!exitOk ? `exit ${exit}, expected ${expect.exitCode}` : "different output"})` }));
    }
  }
  for (const [kind, list] of [["property", specs.property], ["fuzz", specs.fuzz]] as const) for (const spec of list) {
    const id = `${kind}:${spec.id}`, step = run.steps.get(spec.command.id);
    if (!exited(step)) { nodes.push(notRun(id, kind, missing(step), step)); continue; }
    const seed = experimentSeed(profileSha256, spec.command.id), seen = step.observation, passed = step.exitCode === 0;
    nodes.push(Object.freeze({ ...base, id, kind, result: passed ? "pass" : "fail", exitCode: step.exitCode,
      ...(seen === undefined ? {} : { outputSha256: seen.stdoutSha256, complete: seen.complete }),
      detail: passed ? `no counterexample in ${spec.cases} case(s) (seed ${seed})` : `a counterexample within ${spec.cases} case(s): replay with seed ${seed}` }));
    if (!passed) reproducers.push(Object.freeze({ candidate: target.candidate, experiment: id, seed, cases: spec.cases, excerpt: seen?.excerpt ?? "" }));
  }
  return Object.freeze({ nodes: Object.freeze(nodes), reproducers: Object.freeze(reproducers), cleanup: Object.freeze(cleanup),
    ...(run.violation === undefined ? {} : { violation: run.violation }) });
}

type BaselineTexts = ReadonlyMap<string, string | null | "tooLarge">;
type Confined<T> = Readonly<{ value?: T; cleanup: readonly CleanupReport[]; violation?: string; unavailable?: string }>;
const confined = <T>(run: Materialized<T>, cleanup: readonly CleanupReport[]): Confined<T> => Object.freeze(run.state === "ready"
  ? { value: run.value, cleanup } : run.state === "violation" ? { cleanup, violation: run.detail } : { cleanup, unavailable: run.detail });

/** The unchanged text of files, read by Fusion itself from one pristine candidate (never shown to a provider). */
export async function readBaselineTexts(port: WorkspacePort, ownerId: string, paths: readonly string[], signal?: AbortSignal): Promise<Confined<BaselineTexts>> {
  const cleanup: CleanupReport[] = [];
  const read = port.baselineTexts;
  if (paths.length === 0) return Object.freeze({ value: new Map(), cleanup });
  if (typeof read !== "function") return Object.freeze({ cleanup, unavailable: "the workspace port cannot show the baseline" });
  return confined(await withCandidate(port, ownerId, undefined, handle => read.call(port, handle, [...new Set(paths)].sort(), signal), cleanup, signal), cleanup);
}
/** The baseline text of an operation's file, only when it hashes exactly to the operation's precondition. */
function exactBaseline(op: ChangeOperation, texts: BaselineTexts | undefined): string | "tooLarge" | undefined {
  const text = op.expectedSha256 === null ? undefined : texts?.get(op.path);
  return text === "tooLarge" ? text : typeof text === "string" && sha256Hex(text) === op.expectedSha256 ? text : undefined;
}
/** The paths whose baseline Fusion reads for a change: every file the change modifies or deletes. */
export const baselinePaths = (changes: ChangeSet): readonly string[] => changes.operations.flatMap(op => op.expectedSha256 === null ? [] : [op.path]);

/**
 * Fusion's mutations of one candidate's change, from the exact baseline texts. A file whose text is above the sharing bound, or
 * does not hash to the change's precondition, is not mutated — and said so.
 */
export function mutationsFrom(candidate: CandidateId, changes: ChangeSet, texts: BaselineTexts | undefined, max: number): MutationPlan {
  const skipped = new Map<string, string>(), baseline = new Map<string, string | null>();
  for (const op of changes.operations) {
    if (op.kind !== "writeText" || op.expectedSha256 === null || isTestPath(op.path)) continue;
    const text = exactBaseline(op, texts);
    if (text === "tooLarge") skipped.set(op.path, "larger than the sharing bound");
    else if (text === undefined) skipped.set(op.path, texts === undefined ? "the baseline could not be read" : "its baseline could not be read exactly");
    else baseline.set(op.path, text);
  }
  const planned = planMutations(candidate, changes, baseline, max);
  const notMutated = planned.notMutated.map(entry => skipped.has(entry.path) ? Object.freeze({ path: entry.path, reason: skipped.get(entry.path)! }) : entry);
  return Object.freeze({ mutations: planned.mutations, notMutated: Object.freeze(notMutated) });
}
/**
 * Lines added and removed by a change, diffed by Fusion against the exact baseline; `null` when any file could not be read
 * exactly or is too large to diff — an unknown size is never guessed.
 */
export function changedLinesOf(changes: ChangeSet, texts: BaselineTexts | undefined): number | null {
  let total = 0;
  for (const op of changes.operations) {
    const lines = (text: string): number => text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    if (op.kind === "writeText" && op.expectedSha256 === null) { total += lines(op.content); continue; }
    const before = exactBaseline(op, texts);
    if (typeof before !== "string" || before === "tooLarge") return null;
    if (op.kind === "delete") { total += lines(before); continue; }
    const hunks = lineHunks(before, op.content);
    if (hunks === undefined) return null;
    total += hunks.reduce((sum, h) => sum + h.beforeLines.length + h.afterLines.length, 0);
  }
  return total;
}
/** Kept for a single candidate: reads its baseline and plans its mutations. */
export async function planCandidateMutations(port: WorkspacePort, ownerId: string, candidate: CandidateId, changes: ChangeSet, max: number,
  signal?: AbortSignal): Promise<Readonly<{ plan: MutationPlan; cleanup: readonly CleanupReport[]; violation?: string }>> {
  const paths = changes.operations.flatMap(op => op.kind === "writeText" && op.expectedSha256 !== null && !isTestPath(op.path) ? [op.path] : []);
  if (max <= 0 || paths.length === 0) return Object.freeze({ plan: mutationsFrom(candidate, changes, new Map(), 0), cleanup: Object.freeze([]) });
  const read = await readBaselineTexts(port, ownerId, paths, signal);
  if (read.violation !== undefined) return Object.freeze({ plan: mutationsFrom(candidate, changes, undefined, 0), cleanup: read.cleanup, violation: read.violation });
  const plan = read.value === undefined
    ? Object.freeze({ mutations: Object.freeze([]), notMutated: Object.freeze(paths.map(path => Object.freeze({ path, reason: read.unavailable ?? "the baseline could not be read" }))) })
    : mutationsFrom(candidate, changes, read.value, max);
  return Object.freeze({ plan, cleanup: read.cleanup });
}

/** Fusion's confined checks on the unchanged baseline, on a fresh pristine candidate: the frozen profile's reference. */
export async function baselineVerdict(port: WorkspacePort, ownerId: string, plan: VerificationPlan, signal?: AbortSignal): Promise<Confined<VerificationVerdict>> {
  const cleanup: CleanupReport[] = [];
  const verify = port.verifyBaseline;
  if (typeof verify !== "function") return Object.freeze({ cleanup, unavailable: "the workspace port cannot verify the baseline" });
  return confined(await withCandidate(port, ownerId, undefined, handle => verify.call(port, handle, plan, signal), cleanup, signal), cleanup);
}
/**
 * THE FRESH REVALIDATION of the selected candidate — exactly once: a new private candidate from the baseline, the selected
 * host ChangeSet applied by Fusion, the tree proven identical to the judged one (else a violation), the common checks run.
 */
export async function revalidateCandidate(port: WorkspacePort, ownerId: string, target: MaterializedTarget, plan: VerificationPlan,
  signal?: AbortSignal): Promise<Confined<VerificationVerdict>> {
  const cleanup: CleanupReport[] = [];
  return confined(await withCandidate(port, ownerId, target, handle => port.verify(handle, plan, signal), cleanup, signal), cleanup);
}

/**
 * Fusion's mutations of one candidate's own change, each in a fresh candidate against the common checks: KILLED (a check
 * failed: the verification notices the change being undone) is `pass`; SURVIVED (every check still passed) is `fail`; a
 * mutation that could not be materialized or verified is `notRun`. Never part of `verificationPassed`: a survivor is an
 * evidence weakness, not a failure.
 */
export async function runMutations(port: WorkspacePort, ownerId: string, target: MaterializedTarget, mutations: readonly Mutation[],
  commonPlan: VerificationPlan, signal?: AbortSignal): Promise<ExperimentBatch> {
  const nodes: MeshNode[] = [];
  const cleanup: CleanupReport[] = [];
  for (const mutation of mutations) {
    const base = { id: `mutation:${mutation.id}`, candidate: target.candidate, revision: target.revision, kind: "mutation" as const,
      source: "fusion" as const, authority: "deterministic" as const };
    const run = await withCandidate(port, `${ownerId}.${mutation.id}`, { changes: mutation.changes, scope: target.scope },
      handle => port.verify(handle, commonPlan, signal), cleanup, signal);
    if (run.state === "violation")
      return Object.freeze({ nodes: Object.freeze(nodes), reproducers: Object.freeze([]), cleanup: Object.freeze(cleanup), violation: run.detail });
    const verdict = run.state === "ready" ? run.value : undefined;
    const failed = verdict?.evidence?.commands.find(c => c.status !== "passed");
    if (failed?.status === "mutationViolation") return Object.freeze({ nodes: Object.freeze(nodes), reproducers: Object.freeze([]),
      cleanup: Object.freeze(cleanup), violation: "the confined backend could not prove the input it verified" });
    // Killed only by a check that ran and failed: a timeout or a spawn failure detects nothing.
    if (verdict === undefined || verdict.refusal !== undefined || (!verdict.passed && failed?.status !== "failed"))
      nodes.push(Object.freeze({ ...base, result: "notRun", detail: `${mutation.description}: could not be verified` }));
    else nodes.push(Object.freeze({ ...base, result: verdict.passed ? "fail" : "pass",
      detail: verdict.passed ? `${mutation.description}: every check still passed — the verification does not notice (survived)`
        : `${mutation.description}: check ${failed!.id} failed — detected (killed)` }));
  }
  return Object.freeze({ nodes: Object.freeze(nodes), reproducers: Object.freeze([]), cleanup: Object.freeze(cleanup) });
}
