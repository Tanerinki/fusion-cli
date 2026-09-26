import type { VerificationPlan } from "../core/domain.js";
import type { RoleCandidate } from "../core/policy/routing.js";
import type { PrivateCandidateWorkspacePort } from "../platform/workflow/candidates.js";
import type { ProcessGitClient } from "../platform/workspace/git.js";

/**
 * The deterministic integration seam of `fusion build` for a Writer task (O5.5B7 offline rehearsal). It is NOT a
 * product mode and opens no gate:
 *  - the CLI entry point never constructs one, and no flag, environment variable or configuration file can;
 *  - production composition has no Worker candidate at all (`buildCandidates` refuses Worker bindings), so without this
 *    seam a Writer task still stops at REAL_WRITER_MODE_NOT_READY;
 *  - a rehearsal's result is labelled as such and never changes Writer readiness or any gate.
 * A test supplies the roles (deterministic, non-production fake providers) and a factory for the candidate port
 * (private candidates and confined verification). Everything else is the real `build` path: task text validation,
 * risk inspection, run recording, the workflow engine and outcome mapping.
 */
export interface WriterRehearsal {
  /** Every role the Writer flow may route, Worker included. They bypass the production provider registry. */
  readonly roles: readonly RoleCandidate[];
  /** Read-only commands naming executables inside the confined backend. */
  readonly plan: VerificationPlan;
  /**
   * The host-controlled candidate port for the repository the command runs in. `fusion build` builds the provider views
   * of the run over it (baseline and candidate copies), exactly as in production.
   */
  candidatePort(context: Readonly<{ primaryRoot: string; git: ProcessGitClient; declaredPlatform: unknown }>): PrivateCandidateWorkspacePort;
}
/** The label every rehearsal outcome carries. */
export const OFFLINE_REHEARSAL_LABEL = "offline rehearsal with deterministic fake providers; nothing was applied to the primary workspace";
