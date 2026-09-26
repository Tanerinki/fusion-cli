# Security Policy

Fusion CLI is security-sensitive software because it orchestrates local processes, repository state, model-provider adapters, and verification tooling.

## Supported versions

Fusion CLI is currently in active pre-release development.

Only the latest commit on `main` should be considered supported for security review.

## Security posture

Fusion follows a fail-closed design where practical.

Important invariants include:

- workflow/core logic is provider-neutral;
- provider/model selection is configuration-driven;
- unattended Writer mode must not be enabled; a Writer build needs the human's confirmation and its delivery the human's
  approval of the exact manifest digest;
- the primary user workspace is not a Writer workspace: providers never write to it, only `fusion apply` does;
- deterministic verification outranks model claims;
- unknown capability state is not treated as safe;
- shell execution uses executable/argument arrays rather than arbitrary shell strings;
- provider output is bounded and structurally validated;
- secrets and provider/account information must not be persisted in normal run evidence;
- billing/provider override variables are guarded.

## Real Writer mode

Since v0.1, `fusion build` and `fusion create` run **human-confirmed, host-controlled** Writer builds: models stay
read-only in Fusion-owned views and only propose change sets; Fusion validates them, applies them to private candidates,
verifies them in confined Docker containers and prepares a delivery that the human approves (typed manifest digest) and
applies. No model writes to the user's working tree, and nothing is committed or pushed.

**Unattended** (autonomous, unconfirmed) Writer mode remains intentionally off.

A linked Git worktree is workspace isolation, not a security sandbox.

The host-controlled route was built to close these Writer-mode risks, and they remain in scope for reports:

- ignored-path influence on verification;
- shared Git/common-directory mutation;
- incomplete index/shared-state observation;
- unsafe verification execution;
- unproven real-provider Writer posture.

A contribution must not bypass these gates merely to make an end-to-end demo work.

## Reporting a vulnerability

Do not open a public GitHub issue for vulnerabilities that could expose:

- credentials;
- provider/account data;
- local command execution;
- repository escape;
- arbitrary file writes;
- unsafe Git operations;
- billing/auth bypass;
- secret leakage.

For a private repository, contact the repository owner directly.

If GitHub private vulnerability reporting is enabled later, that should become the preferred reporting path.

## Scope for security review

High-value areas include:

- `src/platform/process/`
- `src/platform/workspace/`
- `src/platform/verification/`
- `src/core/policy/`
- `src/core/workflow/`
- `src/core/review/`
- `src/providers/`
- event/artifact redaction and persistence

## Disclosure

Please include:

- affected commit/version;
- reproduction steps;
- expected vs. actual behavior;
- impact;
- whether the issue is reachable through current production paths or only future Writer mode.

Please avoid including live secrets, tokens, or account identifiers in reports.
