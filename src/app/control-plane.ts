import type { AgentRole } from "../core/domain.js";
import { FusionFailure } from "../core/errors.js";
import { DiagnosticRedactor } from "../core/policy/redaction.js";
import type { VerificationEngine } from "../platform/verification/engine.js";
import type { GitClient } from "../platform/workspace/git.js";
import { loadConfig, type LoadedConfig } from "./config.js";
import { discoverRuntime, type RuntimeContext } from "./context.js";
import type { ProviderRegistry, ProviderRuntimeContext } from "./providers.js";
import type { WriterRehearsal } from "./writer-rehearsal.js";

/**
 * Everything the control plane needs from its host. The CLI supplies the real registry and process environment;
 * tests supply fake adapters. Nothing here names a provider or model.
 */
export interface ControlPlaneDeps {
  readonly registry: ProviderRegistry;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  /** Test seam; defaults to the native Git on PATH. */
  readonly git?: GitClient;
  /** Test seam; defaults to a VerificationEngine over the process supervisor. */
  readonly verification?: VerificationEngine;
  /**
   * Test seam for the O5.5B7 offline Writer rehearsal (see `writer-rehearsal.ts`). The CLI entry point never sets it;
   * without it a Writer task stops at REAL_WRITER_MODE_NOT_READY.
   */
  readonly writerRehearsal?: WriterRehearsal;
}
export interface CommandRequest {
  readonly configPath?: string;
  readonly signal?: AbortSignal;
}

export class ControlPlane {
  readonly redactor: DiagnosticRedactor;
  constructor(readonly deps: ControlPlaneDeps) {
    this.redactor = DiagnosticRedactor.fromEnvironment(deps.env);
  }
  runtime(): Promise<RuntimeContext> { return discoverRuntime(this.deps.cwd, this.deps.env, this.deps.git); }
  config(runtime: RuntimeContext, request: CommandRequest): Promise<LoadedConfig> {
    return loadConfig(runtime.repository.root, request.configPath, this.deps.cwd, this.deps.registry.defaults);
  }
  providerContext(root: string): ProviderRuntimeContext { return { workspace: root, env: this.deps.env }; }
}

/** Roles a read-only review needs, in routing order. */
export const REVIEW_ROLES: readonly AgentRole[] = ["Reviewer", "Lead"];
/** Roles a read-only build flow may need (Lead plans and reviews, Explorer answers, a fresh Reviewer at high risk). */
export const READ_ONLY_BUILD_ROLES: readonly AgentRole[] = ["Lead", "Explorer", "Reviewer"];

/** Typed failure helper for command preconditions. */
export function commandFailure(kind: "InvalidInput" | "CapabilityUnavailable" | "WorkspaceConflict", safeMessage: string): FusionFailure {
  return new FusionFailure({ kind, retryable: false, safeMessage });
}
