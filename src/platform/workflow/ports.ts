import { createHash } from "node:crypto";
import { join } from "node:path";
import type { VerificationPlan } from "../../core/domain.js";
import { failWith } from "../../core/errors.js";
import type { EventSink, VerificationVerdict, VerifierPort, WorkflowEvent, WorkspaceHandle,
  WorkspacePort } from "../../core/workflow/types.js";
import type { ArtifactStore } from "../events/artifact-store.js";
import type { EventStore } from "../events/event-store.js";
import type { VerificationEngine, VerificationRunOptions } from "../verification/engine.js";
import { observeChange } from "../workspace/change.js";
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

  /** Tracked changes against the base plus untracked files, as bounded review evidence. Never writes the lease. */
  async diff(handle: WorkspaceHandle, signal?: AbortSignal): Promise<Readonly<{ text: string; truncated: boolean }>> {
    const lease = await this.leases.assertOwner(handle.leaseId, handle.ownerId);
    const change = await observeChange(this.git, lease.path, lease.baseCommit, signal);
    return { text: change.text, truncated: change.truncated };
  }

  /** HEAD, HEAD ref, index and the content of every changed or untracked file; incomplete proof fails closed. */
  async fingerprint(handle: WorkspaceHandle | undefined, signal?: AbortSignal): Promise<string> {
    const root = handle === undefined ? this.primaryRoot : (await this.leases.assertOwner(handle.leaseId, handle.ownerId)).path;
    const snapshot = await captureSnapshot(this.git, root, signal);
    if (!snapshot.complete) failWith("SecurityViolation", "The workspace has too many changes to be proven unchanged.");
    return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  }
}

/**
 * Workspace port for read-only runs (repository review, read-only builds): the primary can be fingerprinted, but no
 * lease can ever be acquired, so no writer can run, whatever the workflow asks.
 */
export class ReadOnlyWorkspacePort implements WorkspacePort {
  readonly leaseRoot: string;
  constructor(readonly primaryRoot: string, private readonly git: GitClient) {
    this.leaseRoot = join(primaryRoot, ".fusion", "worktrees");
  }
  async acquire(): Promise<WorkspaceHandle> { return failWith("SecurityViolation", "This run is read-only; no writer workspace exists."); }
  async changedPaths(): Promise<readonly string[]> { return failWith("SecurityViolation", "This run is read-only; there is no lease."); }
  async diff(): Promise<Readonly<{ text: string; truncated: boolean }>> {
    return failWith("SecurityViolation", "This run is read-only; there is no lease.");
  }
  async fingerprint(handle: WorkspaceHandle | undefined, signal?: AbortSignal): Promise<string> {
    if (handle !== undefined) failWith("SecurityViolation", "This run is read-only; there is no lease.");
    const snapshot = await captureSnapshot(this.git, this.primaryRoot, signal);
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

/**
 * Persists workflow events through the existing EventStore projection boundary. Review findings and adjudications
 * are recorded as bounded labels; with an ArtifactStore, the full record is stored as a redacted JSON artifact.
 */
export class EventStoreWorkflowSink implements EventSink {
  constructor(private readonly store: EventStore, private readonly artifacts?: ArtifactStore) {}

  async append(event: WorkflowEvent): Promise<void> {
    switch (event.type) {
      case "transition":
        await this.store.append({ type: "WorkflowTransition", source: "runtime", payload: event.transition }); return;
      case "risk":
        await this.store.append({ type: "RiskAssessed", source: "policy",
          payload: { level: event.level, decisive: event.decisive, revision: event.revision } }); return;
      case "reviewCycle":
        if (event.phase === "started") await this.store.append({ type: "ReviewCycleStarted", source: "review", payload: { cycle: event.cycle } });
        else await this.store.append({ type: "ReviewCycleCompleted", source: "review",
          payload: { cycle: event.cycle, outcome: event.outcome ?? "gate" } });
        return;
      case "review":
        if (event.phase === "started") await this.store.append({ type: "ReviewStarted", source: "review", payload: { cycle: event.cycle } });
        else await this.store.append({ type: "ReviewCompleted", source: "review",
          payload: { cycle: event.cycle, findingCount: event.findingCount ?? 0 } });
        return;
      case "finding": {
        const f = event.finding;
        const artifactRef = this.artifacts ? (await this.artifacts.storeJson({ finding: f }, `review:finding:${f.id}`)).artifactId : undefined;
        await this.store.append({ type: "FindingRecorded", source: "review", payload: {
          cycle: event.cycle, findingId: f.id, severity: f.severity, confidence: f.confidence, category: f.category, title: f.title,
          ...(f.file === undefined ? {} : { file: f.file }), ...(f.lines ? { lineStart: f.lines.start, lineEnd: f.lines.end } : {}),
          ...(artifactRef === undefined ? {} : { artifactRef }) } });
        return;
      }
      case "adjudication": {
        const a = event.record;
        const artifactRef = this.artifacts ? (await this.artifacts.storeJson({ findingId: a.finding.id, verdict: a.verdict,
          rationale: a.rationale, requiredAction: a.requiredAction, verdictSource: a.verdictSource, supportedFacts: a.supportedFacts },
          `review:adjudication:${a.finding.id}`)).artifactId : undefined;
        await this.store.append({ type: "AdjudicationRecorded", source: "review", payload: {
          cycle: event.cycle, findingId: a.finding.id, verdict: a.verdict, requiredAction: a.requiredAction,
          verdictSource: a.verdictSource, ...(artifactRef === undefined ? {} : { artifactRef }) } });
        return;
      }
    }
  }
}
