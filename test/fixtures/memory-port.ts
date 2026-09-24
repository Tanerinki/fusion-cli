import { join } from "node:path";
import type { ChangeScope, ChangeSet, VerificationPlan } from "../../src/core/domain.js";
import type { TaskRequest } from "../../src/core/policy/task-inspector.js";
import { WorkflowEngine } from "../../src/core/workflow/engine.js";
import type { ApplicationOutcome, CleanupReport, VerificationVerdict, WorkflowRequest, WorkspaceHandle,
  WorkspacePort } from "../../src/core/workflow/types.js";
import { scriptedRoles, sha256, type Script } from "./fake-writer.js";
import { MEDIUM_TASK, RecordingSink, rehearsalRequest } from "./writer-rehearsal-harness.js";

/**
 * A fast in-memory candidate port for scenarios whose property is an engine decision (review, adjudication, bounds,
 * provider failures): the real WorkflowEngine and the same scripted fake providers, without Git or Docker. The real
 * port, Git and the Docker backend are exercised by the rehearsal suites.
 */
export class MemoryPort implements WorkspacePort {
  readonly primaryRoot = join(process.cwd(), ".b7-memory", "primary");
  readonly leaseRoot = join(process.cwd(), ".b7-memory", "candidates");
  readonly applied: ChangeSet[] = [];
  readonly verified: string[] = [];
  readonly released: string[] = [];
  primaryVersion = 0;
  candidateVersion = 0;
  #count = 0;
  readonly #changes = new Map<string, string[]>();
  constructor(private readonly verdict: (attempt: number) => VerificationVerdict = () => ({ passed: true, commandsRun: 2 })) {}
  async acquire(ownerId: string): Promise<WorkspaceHandle> {
    this.#count++;
    return { leaseId: `candidate-${this.#count}`, ownerId, path: join(this.leaseRoot, `candidate-${this.#count}`) };
  }
  async apply(handle: WorkspaceHandle, changes: ChangeSet, _scope: ChangeScope): Promise<ApplicationOutcome> {
    this.applied.push(changes);
    this.#changes.set(handle.leaseId, changes.operations.map(op => op.path));
    return { applied: changes.operations.map(op => op.kind === "delete"
      ? { kind: op.kind, path: op.path, beforeSha256: op.expectedSha256, afterSha256: null, bytes: 0 }
      : { kind: op.kind, path: op.path, beforeSha256: op.expectedSha256, afterSha256: sha256(op.content), bytes: Buffer.byteLength(op.content) }) };
  }
  async changedPaths(handle: WorkspaceHandle): Promise<readonly string[]> { return [...(this.#changes.get(handle.leaseId) ?? [])].sort(); }
  async fingerprint(handle: WorkspaceHandle | undefined): Promise<string> {
    return handle === undefined ? `primary-${this.primaryVersion}` : `${handle.leaseId}-${this.candidateVersion}`;
  }
  async diff(handle: WorkspaceHandle): Promise<{ text: string; truncated: boolean }> {
    return { text: (this.#changes.get(handle.leaseId) ?? []).map(p => `+++ b/${p}\n+changed\n`).join(""), truncated: false };
  }
  async verify(handle: WorkspaceHandle, plan: VerificationPlan): Promise<VerificationVerdict> {
    this.verified.push(handle.leaseId);
    const verdict = this.verdict(this.verified.length);
    return verdict.passed ? { ...verdict, commandsRun: plan.commands.length } : verdict;
  }
  async release(handle: WorkspaceHandle): Promise<CleanupReport> { this.released.push(handle.leaseId); return { complete: true }; }
}

export async function memoryRun(script: Script, port = new MemoryPort(), task: TaskRequest = MEDIUM_TASK,
  request: Partial<WorkflowRequest> = {}) {
  const { roles, spy } = scriptedRoles(script);
  const sink = new RecordingSink();
  const engine = new WorkflowEngine({ roles, workspace: port, events: sink, verifier: { verify: () => { throw new Error("host verifier"); } } });
  const result = await engine.run(rehearsalRequest(task, request));
  return { result, spy, port, events: sink.events };
}
export const failedVerdict = (): VerificationVerdict => ({ passed: false, commandsRun: 2, failedCommand: "unit",
  failure: { kind: "VerificationFailure", retryable: false, safeMessage: "unit did not pass" } });
