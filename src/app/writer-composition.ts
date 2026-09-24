import type { AgentRole, VerificationPlan } from "../core/domain.js";
import type { RoleCandidate } from "../core/policy/routing.js";
import { isGrantedAcceptance } from "../platform/verification/acceptance.js";
import { createProductionDockerBackend } from "../platform/verification/docker/backend.js";
import { acquireVerificationIsolationAcceptance } from "../platform/verification/production.js";
import type { LaunchObserver } from "../platform/process/supervisor.js";
import { PrivateCandidateWorkspacePort, type CandidateVerificationObservation } from "../platform/workflow/candidates.js";
import { ProviderViewWorkspacePort } from "../platform/workflow/ports.js";
import { ProcessGitClient } from "../platform/workspace/git.js";
import { ProviderViewStore } from "../platform/workspace/provider-views.js";
import type { FusionConfig } from "./config.js";
import { buildWriterCandidates, type ProviderRegistry, type UnavailableBinding } from "./providers.js";

/** Roles the Writer workflow may route, in routing order. */
export const WRITER_ROLES: readonly AgentRole[] = Object.freeze(["Lead", "Explorer", "Worker", "Reviewer"]);

/** Everything the workflow engine needs for a host-controlled Writer run. */
export interface WriterRuntime {
  readonly roles: readonly RoleCandidate[];
  readonly workspace: PrivateCandidateWorkspacePort;
  readonly views: ProviderViewWorkspacePort;
  /** Read-only commands naming executables inside the confined backend. */
  readonly plan: VerificationPlan;
}
export interface WriterComposition extends WriterRuntime {
  readonly unavailable: readonly UnavailableBinding[];
  /** Whether confined verification can run: `granted` only for an acceptance the authority granted in this process. */
  readonly verification: Readonly<{ acceptance: "granted" | "refused"; reasons: readonly string[] }>;
}
export interface ProductionWriterOptions {
  readonly root: string;
  readonly config: FusionConfig;
  readonly registry: ProviderRegistry;
  readonly env: NodeJS.ProcessEnv;
  /**
   * How the verification-isolation acceptance is obtained. Production: the production Docker backend's own fresh
   * evidence (`acquireVerificationIsolationAcceptance`). Whatever this returns, only an acceptance GRANTED by the
   * authority opens confined verification; anything else makes the port refuse it (`confinementNotAccepted`).
   */
  readonly acceptance?: (signal?: AbortSignal) => Promise<unknown>;
  readonly signal?: AbortSignal;
  /** Evidence hooks: every provider process the adapters start, and every confined verification of a candidate. */
  readonly launchObserver?: LaunchObserver;
  readonly onVerification?: (observation: CandidateVerificationObservation) => void;
}

/** The provider-view port over the primary: views of the committed baseline or of the primary's work, and of candidates. */
export function providerViewPort(root: string, git: ProcessGitClient, registry: ProviderRegistry,
  candidates?: PrivateCandidateWorkspacePort): ProviderViewWorkspacePort {
  return new ProviderViewWorkspacePort(new ProviderViewStore({ primaryRoot: root, git,
    excludedPaths: registry.workspaceStatePaths ?? [] }), candidates);
}

/**
 * PRODUCTION Writer composition: real Lead, Explorer, read-only Change Author and fresh Reviewer bindings from the
 * provider registry (every session only in a Fusion-owned view), the private candidate port bound to the acceptance
 * authority's grant (no trusted-host backend exists in it, and without a grant it refuses verification), the provider
 * view port and the confined plan from configuration.
 *
 * Composing grants nothing. `fusion build` calls this only after `liveWriterAuthorization()` authorized the run —
 * which it never does in this release — so today this is reached by deterministic composition tests only.
 */
export async function composeProductionWriter(options: ProductionWriterOptions): Promise<WriterComposition> {
  const git = await ProcessGitClient.fromPath(options.env, true);
  const { candidates, unavailable } = await buildWriterCandidates(options.config, options.registry,
    { workspace: options.root, env: options.env, ...(options.launchObserver ? { launchObserver: options.launchObserver } : {}) }, WRITER_ROLES);
  const obtain = options.acceptance ?? (signal => acquireVerificationIsolationAcceptance(createProductionDockerBackend(),
    signal ? { signal } : {}));
  const acceptance = await obtain(options.signal);
  const granted = isGrantedAcceptance(acceptance);
  const verification = options.config.verification;
  const workspace = new PrivateCandidateWorkspacePort({ primaryRoot: options.root, git, confinement: acceptance,
    declaredPlatform: verification.platformRequirement, dependencies: verification.dependencies ?? "none",
    prepareDependencies: true, ...(options.config.protection ? { protectedPaths: options.config.protection.ignoredPaths } : {}),
    ...(options.onVerification ? { onVerification: options.onVerification } : {}) });
  const reasons = granted ? [] : acceptance !== null && typeof acceptance === "object" && Array.isArray((acceptance as { reasons?: unknown }).reasons)
    ? ((acceptance as { reasons: unknown[] }).reasons).filter((reason): reason is string => typeof reason === "string").slice(0, 16)
    : ["no-acceptance"];
  return Object.freeze({ roles: Object.freeze([...candidates]), unavailable: Object.freeze([...unavailable]), workspace,
    views: providerViewPort(options.root, git, options.registry, workspace),
    plan: Object.freeze({ commands: Object.freeze([...(verification.confinedCommands ?? [])]) }),
    verification: Object.freeze({ acceptance: granted ? "granted" as const : "refused" as const, reasons: Object.freeze(reasons) }) });
}
