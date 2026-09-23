# Contributing to Fusion CLI

Fusion CLI is currently an architecture-heavy pre-release project. Contributions should preserve its safety and provider-neutral design.

## Before contributing

Read:

1. `README.md`
2. `docs/v0.1-build-spec.md`
3. `docs/m7-hardening.md`
4. `docs/o1-workspace-verification.md`
5. `docs/o2-task-risk.md`
6. `docs/o3-workflow.md`
7. `docs/o4-review.md`
8. `SECURITY.md`

## Core invariants

Contributions must preserve these rules:

- No workflow/core behavior may depend on a concrete provider or model name.
- Role → provider/model mapping belongs to policy/configuration.
- Provider-specific behavior belongs in adapters/transports.
- Unknown capability state fails closed.
- The primary workspace must not become an autonomous Writer workspace.
- Model claims do not replace deterministic verification.
- Retries and fix cycles are bounded.
- Real Writer mode remains blocked until its documented isolation prerequisites are closed.
- No automatic push, force-push, reset-hard, clean, stash, merge, or rebase as part of autonomous execution.

## Development setup

```powershell
npm ci
npm run typecheck
npm run build
npm test
```

The normal test suite must not make live provider calls.

Live tests must remain explicit opt-in tests.

## Branches

Use focused feature branches:

```text
feature/<short-name>
fix/<short-name>
docs/<short-name>
```

Keep commits scoped and reviewable.

Do not push directly to `main` for non-trivial changes.

## Pull requests

A pull request should include:

- what changed;
- why it changed;
- affected invariants;
- tests added or changed;
- deterministic verification results;
- unresolved risks;
- whether provider/network/account actions were used.

## Tests

Security or workflow changes should include adversarial regression tests.

Prefer tests that prove externally observable behavior rather than mirroring implementation details.

For process/workspace/security code, test failure paths as carefully as success paths.

## Provider integrations

A provider integration must expose capabilities through the provider-neutral adapter model.

Provider-specific handling belongs inside that provider's adapter/transport.

## Security-sensitive changes

Changes involving process execution, workspace isolation, Git state, auth/billing, redaction, Writer mode, or verification should receive independent review before merge.

## Commit style

Current repository history uses concise conventional-style subjects, for example:

```text
feat: add fresh review and lead adjudication
fix: harden orchestration policy and verification boundaries
```
