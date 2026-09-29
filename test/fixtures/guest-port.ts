import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BaselineFileHash, ChangeScope, ChangeSet, VerificationCommand, VerificationPlan } from "../../src/core/domain.js";
import type { AppliedOperation, ApplicationOutcome, CleanupReport, VerificationObservation, VerificationRefusal, VerificationVerdict,
  WorkspaceHandle, WorkspacePort } from "../../src/core/workflow/types.js";

/**
 * v0.5 TEST FIXTURE — a confined guest in memory. It runs commands in order against a candidate's tree and stops at the
 * first failure, exactly like the real guest runner, and serves the real WorkflowEngine as a candidate port (baseline hashes,
 * host application, changed paths, fingerprints). No Git, no Docker: the real port and backend are exercised elsewhere.
 */
export type Tree = ReadonlyMap<string, string>;
export interface Behaviour { readonly exit: number | null; readonly stdout?: string; readonly status?: string; readonly truncated?: boolean }
export type Program = (command: VerificationCommand, tree: Tree, context?: Readonly<{ baseline: boolean; lease: string }>) => Behaviour;
export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
let leases = 0;

export class GuestPort implements WorkspacePort {
  readonly primaryRoot = join(tmpdir(), "fusion-v05-guest", "primary");
  readonly leaseRoot = join(tmpdir(), "fusion-v05-guest", "candidates");
  readonly runs: Array<{ lease: string; baseline: boolean; commands: string[]; args: string[][] }> = [];
  readonly acquired: string[] = [];
  readonly released: string[] = [];
  readonly applied: string[] = [];
  refuse?: VerificationRefusal;
  handlePath?: (lease: string) => string;
  tamperLedger = false;
  throwOnVerify = false;
  /** The primary checkout's fingerprint input: a test changes it to simulate a change of the user's checkout. */
  primaryVersion = 0;
  /** What the guest's verdicts claim; `granted` only to feed the REAL delivery preparation in a test (never a real backend). */
  acceptance: "granted" | "offlineRehearsal" = "offlineRehearsal";
  readonly #trees = new Map<string, Map<string, string>>();
  readonly #changed = new Map<string, string[]>();
  constructor(private readonly baseline: Readonly<Record<string, string>>, private readonly program: Program) {}
  async acquire(ownerId: string): Promise<WorkspaceHandle> {
    const leaseId = `guest-${++leases}`;
    this.acquired.push(ownerId);
    this.#trees.set(leaseId, new Map(Object.entries(this.baseline)));
    return { leaseId, ownerId, path: this.handlePath?.(leaseId) ?? join(this.leaseRoot, leaseId, "workspace") };
  }
  async baselineHashes(handle: WorkspaceHandle, paths: readonly string[]): Promise<readonly BaselineFileHash[]> {
    const tree = this.#trees.get(handle.leaseId)!;
    return paths.map(path => ({ path, sha256: tree.has(path) ? sha256(tree.get(path)!) : null }));
  }
  async apply(handle: WorkspaceHandle, changes: ChangeSet, _scope: ChangeScope): Promise<ApplicationOutcome> {
    const tree = this.#trees.get(handle.leaseId)!;
    const failed = changes.operations.filter(op => (tree.has(op.path) ? sha256(tree.get(op.path)!) : null) !== op.expectedSha256).map(op => op.path);
    if (failed.length > 0) return { preconditionFailed: failed };
    this.#changed.set(handle.leaseId, changes.operations.map(op => op.path).sort());
    this.applied.push(handle.leaseId);
    const applied: AppliedOperation[] = changes.operations.map(op => {
      if (op.kind === "delete") { tree.delete(op.path); return { kind: op.kind, path: op.path, beforeSha256: op.expectedSha256, afterSha256: null, bytes: 0 }; }
      tree.set(op.path, op.content);
      return { kind: op.kind, path: op.path, beforeSha256: op.expectedSha256, afterSha256: sha256(this.tamperLedger ? `${op.content}!` : op.content),
        bytes: Buffer.byteLength(op.content) };
    });
    return { applied };
  }
  async changedPaths(handle: WorkspaceHandle): Promise<readonly string[]> { return this.#changed.get(handle.leaseId) ?? []; }
  async fingerprint(handle: WorkspaceHandle | undefined): Promise<string> {
    if (handle === undefined) return `primary-${this.primaryVersion}`;
    const tree = this.#trees.get(handle.leaseId);
    return sha256(JSON.stringify([...(tree ?? new Map()).entries()].sort()));
  }
  async diff(handle: WorkspaceHandle): Promise<{ text: string; truncated: boolean }> {
    return { text: (this.#changed.get(handle.leaseId) ?? []).map(p => `+++ b/${p}\n+changed\n`).join(""), truncated: false };
  }
  async verify(handle: WorkspaceHandle, plan: VerificationPlan): Promise<VerificationVerdict> { return this.#run(handle, plan, false); }
  async verifyBaseline(handle: WorkspaceHandle, plan: VerificationPlan): Promise<VerificationVerdict> {
    if (this.#changed.has(handle.leaseId)) throw new Error("not pristine");
    return this.#run(handle, plan, true);
  }
  async baselineTexts(handle: WorkspaceHandle, paths: readonly string[]): Promise<ReadonlyMap<string, string | null | "tooLarge">> {
    if (this.#changed.has(handle.leaseId)) throw new Error("not pristine");
    return new Map(paths.map(path => [path, path.includes("huge") ? "tooLarge" : this.#trees.get(handle.leaseId)!.get(path) ?? null]));
  }
  async release(handle: WorkspaceHandle): Promise<CleanupReport> {
    this.released.push(handle.leaseId);
    this.#trees.delete(handle.leaseId);
    return { complete: true };
  }
  #run(handle: WorkspaceHandle, plan: VerificationPlan, baseline: boolean): VerificationVerdict {
    if (this.throwOnVerify) throw new Error("backend exploded");
    this.runs.push({ lease: handle.leaseId, baseline, commands: plan.commands.map(c => c.id), args: plan.commands.map(c => [...c.args]) });
    if (this.refuse !== undefined) return { passed: false, commandsRun: 0, refusal: this.refuse,
      failure: { kind: "CapabilityUnavailable", retryable: false, safeMessage: "refused" } };
    const tree = this.#trees.get(handle.leaseId)!;
    const commands: Array<{ id: string; status: string; exitCode: number | null }> = [];
    const observations: VerificationObservation[] = [];
    for (const command of plan.commands) {
      const b = this.program(command, tree, { baseline, lease: handle.leaseId });
      const status = b.status ?? (b.exit === 0 ? "passed" : "failed");
      commands.push({ id: command.id, status, exitCode: b.exit });
      if (b.stdout !== undefined) observations.push({ id: command.id, exitCode: b.exit, stdoutSha256: sha256(b.stdout), complete: b.truncated !== true,
        excerpt: b.stdout.slice(-2_000) });
      if (status !== "passed") break;
    }
    const passed = commands.length === plan.commands.length && commands.every(c => c.status === "passed");
    const failed = commands.find(c => c.status !== "passed");
    return { passed, commandsRun: commands.length, ...(failed ? { failedCommand: failed.id } : {}),
      ...(passed ? {} : { failure: { kind: "VerificationFailure", retryable: false, safeMessage: "did not pass" } }),
      evidence: { backendId: "guest", confinement: "memory", platformRequirement: "linux-compatible", acceptance: this.acceptance, commands },
      observations };
  }
}
