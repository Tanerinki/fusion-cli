import { lstat } from "node:fs/promises";
import { isAbsolute, join, resolve, win32 } from "node:path";
import { performance } from "node:perf_hooks";
import type { FusionError, VerificationCommand, VerificationPlan, VerificationResult } from "../../core/domain.js";
import { FusionFailure, safeCauseCode } from "../../core/errors.js";
import { DiagnosticRedactor } from "../../core/policy/redaction.js";
import type { ArtifactStore } from "../events/artifact-store.js";
import type { EventStore } from "../events/event-store.js";
import { processEvidenceFromOutcome } from "../events/evidence.js";
import { isContainedPath } from "../events/shared.js";
import type { VerificationEvidenceStatus } from "../events/types.js";
import { assertNativeExecutablePath, containsNul } from "../process/native-executable.js";
import { ProcessSupervisor, type ProcessOutcome } from "../process/supervisor.js";
import { comparablePath, type GitClient } from "../workspace/git.js";
import { captureSnapshot, compareSnapshots, type WorkspaceSnapshot } from "../workspace/snapshot.js";

export type VerificationStepStatus = VerificationEvidenceStatus;
/** A domain VerificationResult plus the Fusion-observed classification and mutation evidence. */
export type VerificationStepResult = VerificationResult & Readonly<{
  status: VerificationStepStatus;
  mutationPolicy: VerificationCommand["mutationPolicy"];
  /** Changed repository paths (and `<HEAD>`/`<HEAD-REF>`/`<INDEX>` markers) between the pre and post state. */
  mutations: readonly string[];
  /** False when the workspace fingerprint was incomplete; a read-only step then cannot pass. */
  mutationProven: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  failure?: FusionError;
}>;
export interface VerificationReport {
  /** True only when Fusion ran every step and each exited 0 under its mutation policy. */
  readonly passed: boolean;
  readonly status: "passed" | "failed" | "invalidConfiguration" | "cancelled";
  readonly steps: readonly VerificationStepResult[];
  /** Command IDs that were not executed because an earlier step did not pass. */
  readonly notRun: readonly string[];
  readonly failure?: FusionError;
}
export interface VerificationRunOptions {
  /** Absolute top level of the Git worktree under verification, typically a workspace lease. */
  readonly workspaceRoot: string;
  readonly git: GitClient;
  /** Explicit child environment. Fusion never infers one for verifiers. */
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly artifacts?: ArtifactStore;
  readonly events?: EventStore;
  readonly redactor?: DiagnosticRedactor;
  /** Bytes retained per stream; output beyond it is drained, not retained, and marked truncated. */
  readonly maxOutputBytes?: number;
}

export const VERIFICATION_LIMITS = Object.freeze({
  maxCommands: 64, maxArgs: 256, maxArgBytes: 32 * 1024, maxTimeoutMs: 60 * 60 * 1000,
  defaultOutputBytes: 1024 * 1024, maxOutputBytes: 4 * 1024 * 1024,
});
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

class InvalidPlan extends Error {
  constructor(readonly safeMessage: string) { super(safeMessage); }
}
const invalid = (message: string): never => { throw new InvalidPlan(message); };

interface ValidatedStep { readonly command: VerificationCommand; readonly executable: string; readonly cwd: string }

async function resolveCwd(root: string, relative: unknown): Promise<string> {
  if (typeof relative !== "string" || relative.length === 0 || relative.length > 512 || containsNul(relative) ||
      isAbsolute(relative) || win32.isAbsolute(relative) || /[\x00-\x1f]/u.test(relative))
    invalid("Verification cwd must be a relative path inside the workspace.");
  const parts = (relative as string).split(/[\\/]/u).filter(part => part !== "" && part !== ".");
  if (parts.some(part => part === "..")) invalid("Verification cwd must not contain '..'.");
  let current = root;
  // Every component must be a real directory, so a junction cannot redirect the verifier outside the workspace.
  for (const part of parts) {
    current = join(current, part);
    let info;
    try { info = await lstat(current); } catch { return invalid("Verification cwd does not exist."); }
    if (info.isSymbolicLink() || !info.isDirectory()) invalid("Verification cwd must be a real directory inside the workspace.");
  }
  if (!isContainedPath(root, current)) invalid("Verification cwd escapes the workspace.");
  return current;
}

async function validatePlan(plan: VerificationPlan, root: string): Promise<ValidatedStep[]> {
  if (plan === null || typeof plan !== "object" || !Array.isArray(plan.commands) || plan.commands.length === 0 ||
      plan.commands.length > VERIFICATION_LIMITS.maxCommands)
    invalid("A verification plan needs between 1 and 64 explicit commands.");
  const ids = new Set<string>();
  const steps: ValidatedStep[] = [];
  for (const command of plan.commands) {
    if (command === null || typeof command !== "object") invalid("A verification command must be an object.");
    if (typeof command.id !== "string" || !COMMAND_ID.test(command.id) || ids.has(command.id))
      invalid("Verification command IDs must be unique short identifiers.");
    ids.add(command.id);
    let executable = "";
    try { executable = assertNativeExecutablePath(command.executable); }
    catch { invalid("Verification executables must be absolute native binaries; shells and wrappers are refused."); }
    if (!Array.isArray(command.args) || command.args.length > VERIFICATION_LIMITS.maxArgs ||
        !command.args.every(arg => typeof arg === "string" && !containsNul(arg) &&
          Buffer.byteLength(arg, "utf8") <= VERIFICATION_LIMITS.maxArgBytes))
      invalid("Verification arguments must be an explicit bounded array of strings.");
    if (!Number.isSafeInteger(command.timeoutMs) || command.timeoutMs < 1 || command.timeoutMs > VERIFICATION_LIMITS.maxTimeoutMs)
      invalid("Verification timeouts must be between 1 ms and 1 hour.");
    if (command.mutationPolicy !== "readOnly" && command.mutationPolicy !== "allowMutation")
      invalid("Verification commands need an explicit mutation policy.");
    steps.push({ command, executable, cwd: await resolveCwd(root, command.cwd) });
  }
  return steps;
}

/** File paths are values, never JSON keys, so a file named like a forbidden evidence key cannot break storage. */
function stateEvidence(snapshot: WorkspaceSnapshot): Record<string, unknown> {
  return { head: snapshot.head, headRef: snapshot.headRef, indexDigest: snapshot.indexDigest, complete: snapshot.complete,
    files: snapshot.entries.map(entry => ({ path: entry.path, code: entry.code, digest: snapshot.digests[entry.path] ?? null })) };
}

function failureFor(status: VerificationStepStatus, id: string, exitCode: number | null): FusionError | undefined {
  switch (status) {
    case "passed": return undefined;
    case "failed": return { kind: "VerificationFailure", safeMessage: `Verification command ${id} exited with code ${exitCode}.`, retryable: false };
    case "timeout": return { kind: "Timeout", safeMessage: `Verification command ${id} exceeded its deadline.`, retryable: true };
    case "cancelled": return { kind: "Cancelled", safeMessage: `Verification command ${id} was cancelled.`, retryable: false };
    case "spawnFailure": return { kind: "SpawnFailure", safeMessage: `Verification command ${id} could not start.`, retryable: false };
    case "mutationViolation": return { kind: "SecurityViolation",
      safeMessage: `Read-only verification command ${id} changed the workspace or its state could not be proven unchanged.`, retryable: false };
    case "processError": return { kind: "ProcessFailure", safeMessage: `Verification command ${id} failed at the process level.`, retryable: false };
    case "evidenceFailure": return { kind: "InternalError", safeMessage: `Verification evidence for ${id} could not be recorded.`, retryable: false };
  }
}

function classify(outcome: ProcessOutcome, command: VerificationCommand, mutated: boolean, proven: boolean): VerificationStepStatus {
  if (outcome.issue?.kind === "SpawnFailure") return "spawnFailure";
  if (outcome.issue?.kind === "Timeout") return "timeout";
  if (outcome.issue?.kind === "Cancelled") return "cancelled";
  if (outcome.issue) return "processError";
  // A read-only verifier that changed the workspace fails on policy, whatever its exit code.
  if (command.mutationPolicy === "readOnly" && (mutated || !proven)) return "mutationViolation";
  return outcome.exitCode === 0 ? "passed" : "failed";
}

/**
 * Fusion owns verification authority: a step passes only when Fusion observed exit 0 and its mutation policy
 * held. Model-reported results are never an input here.
 */
export class VerificationEngine {
  constructor(private readonly supervisor = new ProcessSupervisor()) {}

  async run(plan: VerificationPlan, options: VerificationRunOptions): Promise<VerificationReport> {
    const redactor = options.redactor ?? DiagnosticRedactor.fromEnvironment(options.env);
    const maxOutput = options.maxOutputBytes ?? VERIFICATION_LIMITS.defaultOutputBytes;
    let steps: ValidatedStep[];
    try {
      if (!Number.isSafeInteger(maxOutput) || maxOutput < 1 || maxOutput > VERIFICATION_LIMITS.maxOutputBytes)
        invalid("Verification output limit is out of range.");
      if (typeof options.workspaceRoot !== "string" || !isAbsolute(options.workspaceRoot)) invalid("Workspace root must be absolute.");
      const root = resolve(options.workspaceRoot);
      const info = await lstat(root).catch(() => invalid("Workspace root does not exist."));
      if (info.isSymbolicLink() || !info.isDirectory()) invalid("Workspace root must be a real directory.");
      const top = await options.git.run(["rev-parse", "--show-toplevel"], { cwd: root });
      if (top.exitCode !== 0 || comparablePath(top.stdout.trim()) !== comparablePath(root))
        invalid("Workspace root must be the top level of a Git worktree so mutations can be proven.");
      steps = await validatePlan(plan, root);
    } catch (error) {
      const message = error instanceof InvalidPlan ? error.safeMessage : "The verification plan could not be validated.";
      return { passed: false, status: "invalidConfiguration", steps: [], notRun: [],
        failure: { kind: "InvalidInput", safeMessage: message, retryable: false,
          ...(error instanceof InvalidPlan ? {} : { causeCode: safeCauseCode(error) }) } };
    }
    const root = resolve(options.workspaceRoot);
    const results: VerificationStepResult[] = [];
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index]!;
      if (options.signal?.aborted) {
        return this.stop(results, steps.slice(index), "cancelled",
          { kind: "Cancelled", safeMessage: "Verification was cancelled.", retryable: false });
      }
      const result = await this.runStep(step, root, options, redactor, maxOutput);
      results.push(result);
      if (result.status !== "passed")
        return this.stop(results, steps.slice(index + 1), result.status === "cancelled" ? "cancelled" : "failed", result.failure!);
    }
    return { passed: true, status: "passed", steps: results, notRun: [] };
  }

  private stop(results: VerificationStepResult[], remaining: readonly ValidatedStep[],
    status: "failed" | "cancelled", failure: FusionError): VerificationReport {
    return { passed: false, status, steps: results, notRun: remaining.map(step => step.command.id), failure };
  }

  private async runStep(step: ValidatedStep, root: string, options: VerificationRunOptions, redactor: DiagnosticRedactor,
    maxOutput: number): Promise<VerificationStepResult> {
    const { command } = step;
    const startedAt = new Date().toISOString();
    const started = performance.now();
    let pre: WorkspaceSnapshot | undefined, post: WorkspaceSnapshot | undefined, outcome: ProcessOutcome | undefined;
    let status: VerificationStepStatus;
    let mutations: readonly string[] = [];
    let proven = false;
    let cwdIntact = true;
    try {
      pre = await captureSnapshot(options.git, root, options.signal);
      // Revalidated immediately before this step spawns: an earlier step may have replaced the directory with a link.
      try { cwdIntact = comparablePath(await resolveCwd(root, command.cwd)) === comparablePath(step.cwd); }
      catch { cwdIntact = false; }
      if (!cwdIntact) status = "mutationViolation";
      else {
        outcome = await this.supervisor.start({ executable: step.executable, args: [...command.args], cwd: step.cwd,
          env: options.env, timeoutMs: command.timeoutMs, maxStdoutBytes: maxOutput, maxStderrBytes: maxOutput,
          outputLimitAction: "truncate", stdoutDecoding: "replace", ...(options.signal ? { signal: options.signal } : {}) }).result;
        // The post-state is captured even after cancellation so mutation evidence is never lost.
        post = await captureSnapshot(options.git, root);
        const comparison = compareSnapshots(pre, post);
        mutations = comparison.changes;
        proven = comparison.complete;
        status = classify(outcome, command, comparison.mutated, comparison.complete);
      }
    } catch (error) {
      status = error instanceof FusionFailure && error.error.kind === "Cancelled" ? "cancelled" :
        outcome?.issue?.kind === "Cancelled" ? "cancelled" : "processError";
    }
    const exitCode = outcome?.exitCode ?? null;
    const refs: { stdout?: string; stderr?: string; pre?: string; post?: string } = {};
    try {
      if (options.artifacts && outcome) {
        refs.stdout = (await options.artifacts.storeText(outcome.stdout, `verification:${command.id}:stdout`)).artifactId;
        refs.stderr = (await options.artifacts.storeText(outcome.stderr, `verification:${command.id}:stderr`)).artifactId;
      }
      if (options.artifacts && pre) refs.pre = (await options.artifacts.storeJson(stateEvidence(pre), `verification:${command.id}:pre`)).artifactId;
      if (options.artifacts && post) refs.post = (await options.artifacts.storeJson(stateEvidence(post), `verification:${command.id}:post`)).artifactId;
      if (options.events) {
        if (outcome) await options.events.append({ type: "ProcessObserved", source: "verification", payload: {
          evidence: processEvidenceFromOutcome(outcome, redactor, { ...(refs.stdout ? { stdout: refs.stdout } : {}),
            ...(refs.stderr ? { stderr: refs.stderr } : {}) }) } });
        await options.events.append({ type: "VerificationObserved", source: "verification", payload: { evidence: {
          commandId: command.id, status, passed: status === "passed", exitCode: status === "passed" ? 0 : exitCode,
          mutationPolicy: command.mutationPolicy, mutated: mutations.length > 0, mutationProven: proven,
          changedPathCount: mutations.length, durationMs: performance.now() - started,
          ...(refs.stdout ? { stdoutArtifactRef: refs.stdout } : {}), ...(refs.stderr ? { stderrArtifactRef: refs.stderr } : {}),
          ...(refs.pre ? { preStateArtifactRef: refs.pre } : {}), ...(refs.post ? { postStateArtifactRef: refs.post } : {}) } } });
      }
    } catch {
      // Evidence that was requested but not recorded cannot support a pass; an earlier failure keeps its kind.
      if (status === "passed") status = "evidenceFailure";
    }
    const failure: FusionError | undefined = cwdIntact ? failureFor(status, command.id, exitCode) : { kind: "SecurityViolation",
      safeMessage: `Verification command ${command.id} did not run: its cwd is no longer a real directory inside the workspace.`,
      retryable: false };
    const base = {
      commandId: command.id, executable: step.executable, args: command.args.map(arg => redactor.redactText(arg)),
      cwd: command.cwd, startedAt, durationMs: performance.now() - started,
      stdoutArtifact: refs.stdout ?? "", stderrArtifact: refs.stderr ?? "",
      preDiffArtifact: refs.pre ?? "", postDiffArtifact: refs.post ?? "", mutatedRepository: mutations.length > 0,
      status, mutationPolicy: command.mutationPolicy, mutations, mutationProven: proven,
      stdoutTruncated: outcome?.stdoutTruncated ?? false, stderrTruncated: outcome?.stderrTruncated ?? false,
    };
    return status === "passed" ? { ...base, passed: true, exitCode: 0 } :
      { ...base, passed: false, exitCode, ...(failure ? { failure } : {}) };
  }
}
