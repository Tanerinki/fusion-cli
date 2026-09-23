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
- real Writer mode must not be enabled until its explicit isolation gates are closed;
- the primary user workspace is not an autonomous Writer workspace;
- deterministic verification outranks model claims;
- unknown capability state is not treated as safe;
- shell execution uses executable/argument arrays rather than arbitrary shell strings;
- provider output is bounded and structurally validated;
- secrets and provider/account information must not be persisted in normal run evidence;
- billing/provider override variables are guarded.

## Real Writer mode

Real autonomous Writer mode is intentionally blocked.

A linked Git worktree is workspace isolation, not a security sandbox.

The remaining Writer-mode prerequisites include protection against:

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
