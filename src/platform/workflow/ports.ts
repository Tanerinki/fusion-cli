import { createHash } from "node:crypto";
import type { VerificationPlan } from "../../core/domain.js";
import { failWith } from "../../core/errors.js";
import type { EventSink, VerificationVerdict, VerifierPort, WorkflowEvent, WorkspaceHandle,
  WorkspacePort } from "../../core/workflow/types.js";
import type { EventStore } from "../events/event-store.js";
import type { VerificationEngine, VerificationRunOptions } from "../verification/engine.js";
import { gitOk, type GitClient } from "../workspace/git.js";
import type { WorkspaceLeaseManager } from "../workspace/lease.js";
import { captureSnapshot } from "../workspace/snapshot.js";

const split = (stdout: string): string[] => stdout.split("\0").filter(Boolean);

/** Workflow workspace port over O1 leases: one detached, locked worktree per writer, never the primary. */
export class LeaseWorkspacePort implements WorkspacePort {
  constructor(private readonly leases: WorkspaceLeaseManager, private readonly git: GitClient) {}
  get primaryRoot(): string { return this.leases.primaryRoot; }
  get leaseRoot(): string { return this.leases.worktreesRoot; }

  async acquire(ownerId: string, signal?: AbortSignal): Promise<WorkspaceHandle> {
    const lease = await this.leases.acquire({ ownerId, ...(signal ? { signal } : {}) });
    return { leaseId: lease.leaseId, ownerId: lease.ownerId, path: lease.path };
  }

  /** Tracked changes against the lease's base commit (including commits made in the lease) plus untracked files. */
  async changedPaths(handle: WorkspaceHandle, signal?: AbortSignal): Promise<readonly string[]> {
    const lease = await this.leases.assertOwner(handle.leaseId, handle.ownerId);
    const options = { cwd: lease.path, ...(signal ? { signal } : {}) };
    const tracked = await gitOk(this.git, ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv",
      "--ignore-submodules=none", lease.baseCommit, "--"], options, "Git could not list the lease's changes.");
    const untracked = await gitOk(this.git, ["ls-files", "--others", "--exclude-standard", "-z"], options,
      "Git could not list the lease's untracked files.");
    return [...new Set([...split(tracked), ...split(untracked)])].sort();
  }

  /** HEAD, HEAD ref, index and the content of every changed or untracked file; incomplete proof fails closed. */
  async fingerprint(handle: WorkspaceHandle | undefined, signal?: AbortSignal): Promise<string> {
    const root = handle === undefined ? this.primaryRoot : (await this.leases.assertOwner(handle.leaseId, handle.ownerId)).path;
    const snapshot = await captureSnapshot(this.git, root, signal);
    if (!snapshot.complete) failWith("SecurityViolation", "The workspace has too many changes to be proven unchanged.");
    return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  }
}

/** Workflow verifier port over the O1 VerificationEngine; only Fusion-observed results cross it. */
export class EngineVerifierPort implements VerifierPort {
  constructor(private readonly engine: VerificationEngine,
    private readonly options: Omit<VerificationRunOptions, "workspaceRoot" | "signal">) {}

  async verify(plan: VerificationPlan, workspaceRoot: string, signal?: AbortSignal): Promise<VerificationVerdict> {
    const report = await this.engine.run(plan, { ...this.options, workspaceRoot, ...(signal ? { signal } : {}) });
    const failed = report.steps.find(step => step.status !== "passed");
    return { passed: report.passed, commandsRun: report.steps.length,
      ...(failed ? { failedCommand: failed.commandId } : {}), ...(report.failure ? { failure: report.failure } : {}) };
  }
}

/** Persists workflow events through the existing EventStore projection boundary. */
export class EventStoreWorkflowSink implements EventSink {
  constructor(private readonly store: EventStore) {}

  async append(event: WorkflowEvent): Promise<void> {
    if (event.type === "transition") await this.store.append({ type: "WorkflowTransition", source: "runtime", payload: event.transition });
    else await this.store.append({ type: "RiskAssessed", source: "policy",
      payload: { level: event.level, decisive: event.decisive, revision: event.revision } });
  }
}
