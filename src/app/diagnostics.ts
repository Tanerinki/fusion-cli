import { existsSync } from "node:fs";
import { AGENT_ROLES, type AgentRole, type CapabilitySnapshot } from "../core/domain.js";
import { FusionFailure } from "../core/errors.js";
import { classifyPath, type PathClass } from "../core/policy/task-inspector.js";
import { EXIT_CODES } from "../cli/failure-presentation.js";
import type { CommandRequest, ControlPlane } from "./control-plane.js";
import type { LoadedConfig } from "./config.js";
import { inspectLeases, inspectStorage, type LeaseHealth, type RuntimeContext, type StorageHealth } from "./context.js";
import type { BindingInspection, BindingProbe } from "./providers.js";
import { bindingEligibility, readinessVerdict, roleEligibility, type BindingEligibility, type EligibilityState,
  type ReadinessVerdict } from "./readiness.js";
import { writerReadiness, type WriterReadiness } from "./writer-gate.js";

export interface ProviderDiagnostic {
  readonly index: number;
  readonly role: AgentRole;
  readonly adapter: string;
  readonly requestedModel: string;
  readonly effort: string;
  readonly inspection?: BindingInspection;
  readonly inspectionError?: string;
  readonly probe?: BindingProbe | Readonly<{ error: string }>;
  readonly capabilities: Readonly<Record<string, boolean | "unknown">>;
  /** How the posture facts were established: before any session, from a running session, or not at all. */
  readonly postureEvidence: "launchTime" | "observedSession" | "none";
  readonly identity: Readonly<{ requested: string; observed: string }>;
  readonly eligibility: BindingEligibility;
}
export interface Diagnostics {
  readonly runtime: Readonly<{ platform: string; nodeVersion: string; git: "available" | "unavailable" }>;
  readonly repository: RuntimeContext["repository"];
  readonly config: Readonly<{ state: "valid" | "invalid"; source?: string; bindings: number; verificationCommands: number; error?: string }>;
  readonly storage: StorageHealth | Readonly<{ state: "unknown" }>;
  readonly leases: LeaseHealth | Readonly<{ state: "unknown" }>;
  readonly workspaceLease: Readonly<{ state: "available" | "unavailable"; reasons: readonly string[] }>;
  readonly verification: Readonly<{ state: "configured" | "notConfigured" | "invalid"; commands: number; notes: readonly string[] }>;
  readonly providers: readonly ProviderDiagnostic[];
  readonly roles: Readonly<Record<AgentRole, Readonly<{ readOnly: EligibilityState; review: EligibilityState; writer: EligibilityState }>>>;
  readonly writer: WriterReadiness;
  readonly readiness: ReadinessVerdict;
  readonly probed: boolean;
}

const summarize = (snapshot: CapabilitySnapshot | undefined): Record<string, boolean | "unknown"> => ({
  structuredOutput: snapshot?.structuredOutput ?? "unknown", filesystemRead: snapshot?.filesystem.read ?? "unknown",
  filesystemWrite: snapshot?.filesystem.write ?? "unknown", shell: snapshot?.shell.available ?? "unknown",
  webToolsDisabled: snapshot?.webToolsDisabled ?? "unknown", approvalEscalationDisabled: snapshot?.approvalEscalationDisabled ?? "unknown",
  personalContextDisabled: snapshot?.personalContextDisabled ?? "unknown", extensionsQuarantined: snapshot?.extensionsQuarantined ?? "unknown",
  subscriptionLaneReadback: snapshot?.subscriptionLaneReadback ?? "unknown", modelIdentityReadback: snapshot?.modelIdentityReadback ?? "unknown" });
const postureEvidence = (snapshot: CapabilitySnapshot | undefined): ProviderDiagnostic["postureEvidence"] =>
  snapshot?.postureEvidence === undefined || !snapshot.postureEvidence.versionVerified ? "none"
    : snapshot.postureEvidence.source === "launchFlag" ? "launchTime" : "observedSession";

/**
 * Collects doctor/audit diagnostics without mutating anything. Providers are inspected statically; only `probe`
 * may start provider CLIs (for auth readback, never inference). Unknown is reported as unknown, never as safe.
 */
export async function collectDiagnostics(plane: ControlPlane, request: CommandRequest & { probe?: boolean }): Promise<Diagnostics> {
  return (await gather(plane, request)).diagnostics;
}
async function gather(plane: ControlPlane, request: CommandRequest & { probe?: boolean }):
  Promise<Readonly<{ diagnostics: Diagnostics; runtime: RuntimeContext }>> {
  const runtime = await plane.runtime();
  const root = runtime.repository.root;
  let loaded: LoadedConfig | undefined, configError: string | undefined;
  try { loaded = await plane.config(runtime, request); }
  catch (error) { configError = error instanceof FusionFailure ? error.error.safeMessage : "The configuration could not be loaded."; }
  const storage = root === undefined ? { state: "unknown" as const } : await inspectStorage(root);
  const leases = root === undefined || runtime.git.client === undefined ? { state: "unknown" as const }
    : await inspectLeases(root, runtime.git.client);
  const leaseReasons: string[] = [];
  if (!runtime.git.available) leaseReasons.push("Git is unavailable.");
  if (!runtime.repository.detected) leaseReasons.push("No repository was detected.");
  if (runtime.repository.unborn) leaseReasons.push("The repository has no commit to base a lease on.");
  if (storage.state === "unsafe") leaseReasons.push("Fusion storage is not a real directory.");
  const commands = loaded?.config.verification.commands ?? [];
  const verificationNotes: string[] = [];
  for (const command of commands) {
    if (!existsSync(command.executable)) verificationNotes.push(`${command.id}: executable not found`);
    if (command.mutationPolicy === "allowMutation") verificationNotes.push(`${command.id}: allowMutation cannot verify the primary workspace`);
  }
  const providers: ProviderDiagnostic[] = [];
  for (const [index, binding] of (loaded?.config.bindings ?? []).entries()) {
    const factory = plane.deps.registry.factories.get(binding.adapter);
    let inspection: BindingInspection | undefined, inspectionError: string | undefined, probe: ProviderDiagnostic["probe"];
    if (factory === undefined) inspectionError = "unknown adapter kind";
    else if (root !== undefined) {
      try { inspection = await factory.inspect(binding, plane.providerContext(root)); }
      catch (error) { inspectionError = error instanceof FusionFailure ? error.error.safeMessage : "inspection failed"; }
      if (request.probe === true && inspection !== undefined && binding.role !== "Worker") {
        try { probe = await factory.probe(binding, plane.providerContext(root), request.signal); }
        catch (error) { probe = { error: error instanceof FusionFailure ? error.error.safeMessage : "probe failed" }; }
      }
    } else inspectionError = "no repository";
    const probed = probe !== undefined && "auth" in probe ? probe.capabilities : undefined;
    const effective = inspection === undefined ? undefined : { ...inspection, ...(probed ? { capabilities: probed } : {}) };
    providers.push({ index, role: binding.role, adapter: binding.adapter, requestedModel: binding.model, effort: binding.effort,
      ...(inspection ? { inspection } : {}), ...(inspectionError ? { inspectionError } : {}), ...(probe ? { probe } : {}),
      capabilities: summarize(effective?.capabilities), postureEvidence: postureEvidence(effective?.capabilities),
      identity: { requested: `${inspection?.provider ?? "?"}/${binding.model}`,
        observed: "unobserved (identity is read back during a run)" },
      eligibility: bindingEligibility(binding, effective, inspectionError, probe) });
  }
  const roles = Object.fromEntries(AGENT_ROLES.map(role => {
    const mine = providers.filter(p => p.role === role);
    return [role, { readOnly: roleEligibility(mine.map(p => p.eligibility.readOnly)),
      review: roleEligibility(mine.map(p => p.eligibility.review)), writer: "blocked" as EligibilityState }];
  })) as Diagnostics["roles"];
  const infrastructureBlocked = !runtime.git.available || !runtime.repository.detected || storage.state === "unsafe" ||
    configError !== undefined;
  return { runtime, diagnostics: {
    runtime: { platform: runtime.platform, nodeVersion: runtime.nodeVersion, git: runtime.git.available ? "available" : "unavailable" },
    repository: runtime.repository,
    config: configError !== undefined ? { state: "invalid", bindings: 0, verificationCommands: 0, error: configError }
      : { state: "valid", source: loaded!.source, bindings: loaded!.config.bindings.length, verificationCommands: commands.length },
    storage, leases, workspaceLease: { state: leaseReasons.length === 0 ? "available" : "unavailable", reasons: leaseReasons },
    verification: { state: configError !== undefined ? "invalid" : commands.length === 0 ? "notConfigured" : "configured",
      commands: commands.length, notes: verificationNotes },
    providers, roles, writer: writerReadiness(), readiness: readinessVerdict(infrastructureBlocked, roles), probed: request.probe === true,
  } };
}

export function doctorExitCode(diagnostics: Diagnostics): number {
  switch (diagnostics.readiness.overall) {
    case "BLOCKED": return EXIT_CODES.blocked;
    case "DEGRADED": return EXIT_CODES.degraded;
    default: return EXIT_CODES.success;
  }
}

export type AuditSeverity = "BLOCKER" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
export interface AuditItem {
  readonly id: string;
  readonly severity: AuditSeverity;
  readonly area: string;
  readonly title: string;
  readonly detail: string;
}
export interface AuditReport {
  readonly status: "clean" | "attention" | "blocked";
  readonly items: readonly AuditItem[];
  readonly sensitiveFiles: Readonly<Partial<Record<PathClass, number>>>;
  readonly diagnostics: Diagnostics;
}
const MAX_AUDITED_FILES = 100_000;

/**
 * A deterministic, read-only audit of Fusion-relevant engineering state. It runs no model and creates no run; it is
 * never an implementation run.
 */
export async function audit(plane: ControlPlane, request: CommandRequest): Promise<AuditReport> {
  const { diagnostics: d, runtime } = await gather(plane, request);
  const items: AuditItem[] = [];
  const add = (id: string, severity: AuditSeverity, area: string, title: string, detail: string): void => {
    items.push({ id, severity, area, title, detail });
  };
  if (d.runtime.git === "unavailable") add("git-unavailable", "BLOCKER", "runtime", "Git is unavailable", "Fusion needs native Git on PATH.");
  if (!d.repository.detected) add("no-repository", "BLOCKER", "repository", "No repository", "Run the audit inside a Git working tree.");
  if (d.config.state === "invalid") add("config-invalid", "BLOCKER", "configuration", "Invalid configuration", d.config.error ?? "");
  if (d.repository.changes.conflicted > 0)
    add("merge-conflicts", "HIGH", "repository", "Unresolved conflicts", `${d.repository.changes.conflicted} path(s) are conflicted.`);
  if (d.repository.unborn) add("unborn-head", "MEDIUM", "repository", "No commit yet", "Leases and reviews need at least one commit.");
  if (d.repository.detached) add("detached-head", "LOW", "repository", "Detached HEAD", "Reviews default to HEAD; pass --base explicitly.");
  if (d.storage.state === "unsafe") add("storage-unsafe", "BLOCKER", "storage", "Unsafe Fusion storage", ".fusion is a link or not a directory.");
  if (d.storage.state === "degraded")
    add("storage-degraded", "HIGH", "storage", "Run evidence needs inspection", (d.storage as StorageHealth).notes.join(" "));
  if (d.leases.state === "unsafe") add("leases-unsafe", "BLOCKER", "leases", "Unsafe lease registry", ".fusion/leases is not a real directory.");
  if (d.leases.state === "attention") {
    const l = d.leases as LeaseHealth;
    if (l.deadOwners > 0) add("stale-leases", "MEDIUM", "leases", "Stale leases", `${l.deadOwners} lease(s) belong to exited processes.`);
    if (l.corrupt > 0) add("corrupt-leases", "HIGH", "leases", "Unreadable lease records", `${l.corrupt} record(s) could not be read.`);
    if (l.prunableWorktrees > 0) add("prunable-worktrees", "LOW", "leases", "Prunable worktrees",
      `${l.prunableWorktrees} worktree(s) are prunable; Fusion never prunes automatically.`);
  }
  if (d.verification.state === "notConfigured")
    add("no-verification", "MEDIUM", "verification", "No verification plan", "Reviews are answered, not completed, without Fusion verification.");
  for (const note of d.verification.notes) add(`verification-${items.length}`, "HIGH", "verification", "Verification configuration", note);
  for (const p of d.providers) {
    if (p.eligibility.readOnly.state === "blocked")
      add(`provider-${p.index}-blocked`, "HIGH", "providers", `Binding ${p.index} (${p.role}) blocked`, p.eligibility.readOnly.reasons.join("; "));
  }
  if (d.roles.Reviewer.review !== "eligible" || d.roles.Lead.review !== "eligible")
    add("review-not-ready", "MEDIUM", "providers", "Fresh review is not available",
      `Reviewer: ${d.roles.Reviewer.review}; adjudicating Lead: ${d.roles.Lead.review}. fusion review will fail closed.`);
  for (const prerequisite of d.writer.prerequisites)
    add(`writer-${prerequisite.id}`, "INFO", "writer gate", "Real Writer mode blocked (by design)", prerequisite.text);
  const sensitiveFiles: Partial<Record<PathClass, number>> = {};
  const git = runtime.git.client;
  if (git !== undefined && runtime.repository.root !== undefined) {
    let files: string[] = [];
    try {
      const listed = await git.run(["ls-files", "-z"], { cwd: runtime.repository.root });
      files = listed.exitCode === 0 ? listed.stdout.split("\0").filter(Boolean).slice(0, MAX_AUDITED_FILES) : [];
    } catch {
      add("sensitive-scan-skipped", "LOW", "repository", "Risk-sensitive file scan skipped", "The tracked-file list exceeded Fusion's read bound.");
    }
    for (const file of files) for (const cls of classifyPath(file)) sensitiveFiles[cls] = (sensitiveFiles[cls] ?? 0) + 1;
    if ((sensitiveFiles.credentialMaterial ?? 0) > 0)
      add("tracked-credentials", "HIGH", "repository", "Credential-like files are tracked",
        `${sensitiveFiles.credentialMaterial} tracked file(s) look like credential material; review before sharing.`);
  }
  const status = items.some(i => i.severity === "BLOCKER") ? "blocked"
    : items.some(i => i.severity === "HIGH" || i.severity === "MEDIUM") ? "attention" : "clean";
  return { status, items, sensitiveFiles, diagnostics: d };
}
export const auditExitCode = (report: AuditReport): number => report.status === "blocked" ? EXIT_CODES.blocked : EXIT_CODES.success;
