# Fusion CLI

**Local multi-model AI engineering orchestration with deterministic verification, capability-driven routing, and fresh independent review.**

> **Status:** Active development. The provider-neutral orchestration and review core is implemented. Autonomous real-provider Writer mode remains intentionally blocked until the remaining isolation gates are closed.

## What Fusion CLI is

Fusion CLI is a local TypeScript orchestration system for AI-assisted software engineering.

Instead of treating one model as planner, implementer, reviewer, and source of truth, Fusion separates those responsibilities into explicit roles and makes deterministic tooling authoritative for verification.

```text
USER
  ↓
TASK INSPECTOR
  ↓
RISK GATE
  ↓
POLICY / CAPABILITY ROUTING
  ↓
WORKFLOW ENGINE
  ├─ Lead
  ├─ Worker
  ├─ Explorer
  ├─ Reviewer
  └─ Auditor
  ↓
WORKSPACE LEASE + VERIFICATION
  ↓
FRESH REVIEW
  ↓
LEAD ADJUDICATION
  ↓
RESULT / HUMAN GATE
```

Provider and model selection is configuration. Workflow semantics do not depend on concrete provider names.

## Design goals

- **Provider-neutral orchestration** — roles are separate from providers and models.
- **Deterministic verification** — model claims such as “tests pass” are never authoritative.
- **Capability-driven routing** — unknown or insufficient capability state fails closed.
- **Isolated writer workspaces** — autonomous writes are designed around dedicated Git worktrees, never the primary workspace.
- **Fresh review** — reviewer sessions are separated from worker sessions and receive bounded review evidence instead of worker transcripts.
- **Lead adjudication** — structured findings are adjudicated as `CONFIRMED`, `PARTIAL`, `REJECTED`, or `UNVERIFIABLE`.
- **Bounded autonomy** — retries and review/fix cycles have explicit limits.
- **Subscription-aware provider use** — billing/provider overrides are guarded and provider auth state is checked.
- **Evidence-first runs** — events, artifacts, verification results, findings, and decisions are stored as bounded structured evidence.
- **Fail-closed security posture** — ambiguous capabilities, malformed structured output, or unsafe runtime state stop the workflow.

## Current status

| Area | Status |
| --- | --- |
| TypeScript/domain foundation | ✅ Implemented |
| Windows process supervision | ✅ Implemented |
| Billing/auth guards | ✅ Implemented |
| Claude read-only adapter | ✅ Implemented and live-gated |
| Muse read-only adapter | ✅ Implemented and live-gated |
| Event/artifact/metrics layer | ✅ Implemented |
| Runtime hardening | ✅ Implemented |
| Workspace leases | ✅ Implemented |
| Deterministic verification | ✅ Implemented |
| Task inspection / risk gate | ✅ Implemented |
| Provider-neutral workflow engine | ✅ Implemented |
| Fresh review / adjudication | ✅ Implemented |
| CLI / control plane | ✅ Implemented |
| Real read-only review | ⚠ Adapter activation pending |
| Real-provider Writer mode | ⛔ Intentionally blocked |
| True end-to-end autonomous build | ⏳ Pending review activation + Writer hardening |

## Why Writer mode is still blocked

A linked Git worktree is useful workspace isolation, but it is **not a security sandbox**.

Before real autonomous Writer mode can be enabled, Fusion must close the remaining isolation gaps around:

- ignored-path influence on build and verification;
- shared Git/common-directory state;
- index/shared-state fingerprint coverage;
- verification in a sufficiently isolated or reconstructed environment;
- capability-proven real Writer adapters.

Fusion deliberately reports Writer readiness as blocked until those gates are satisfied.

## Workflow model

### Low-risk

```text
Task inspection
→ risk gate
→ eligible read-only role/tool
→ deterministic checks where required
→ answer/result
```

### Medium-risk

```text
Task inspection
→ risk gate
→ Lead planning
→ bounded Worker delegation
→ isolated workspace lease
→ deterministic verification
→ Lead review
→ result
```

### High-risk

```text
Lead architecture
→ optional Explorer
→ bounded Worker
→ deterministic verification
→ fresh Reviewer
→ structured Findings
→ Lead adjudication
→ optional single corrective cycle
→ result / decision gate
```

### Critical-risk

```text
Task inspection
→ critical risk
→ human gate
```

Critical tasks do not autonomously enter Writer mode.

## Verification authority

Fusion does not trust model prose as proof.

A verification step is represented as explicit executable/argument data and is run by Fusion itself. A successful engineering result requires the required deterministic checks to have actually passed.

Distinct failure classes are preserved, including:

- cancellation;
- timeout;
- spawn failure;
- non-zero exit;
- mutation-policy violation;
- malformed structured output;
- capability/policy refusal.

## Fresh review and findings

Reviewers return bounded structured findings rather than unrestricted prose.

Findings include severity, confidence, evidence, realistic failure scenario, and optional fix guidance. Fusion assigns provenance and cycle identity.

Material findings are adjudicated by a Lead role. Deterministic Fusion evidence outranks an agent assertion when the two conflict.

Autonomous correction is bounded: Fusion never enters an unlimited fix/review loop.

## Provider neutrality

The core role model is:

```text
Lead
Worker
Explorer
Reviewer
Auditor
```

Provider/model binding belongs to policy/configuration.

> No workflow, role, or core module depends on a concrete model or provider name.

Provider-specific behavior belongs in provider adapters and transports.

## Repository structure

```text
src/
  cli/
  core/
    policy/
    review/
    workflow/
  platform/
    events/
    fs/
    process/
    verification/
    workspace/
  providers/
    claude/
    muse/

docs/
  m7-hardening.md
  o1-workspace-verification.md
  o2-task-risk.md
  o3-workflow.md
  o4-review.md
  v0.1-build-spec.md
```

## Development

Requirements:

- Windows 11 is the primary validated platform.
- Node.js 22+
- Git
- npm

Install:

```powershell
npm ci
```

Validate:

```powershell
npm run typecheck
npm run build
npm test
```

Live provider tests are opt-in and are not part of the normal deterministic suite.

## CLI surface

O5 implements the user-facing control plane:

```text
fusion doctor
fusion review
fusion audit
fusion build "<task>"
fusion show <run-id>
```

### Current command readiness

`fusion doctor` is implemented and reports runtime, repository, storage, provider capability state, and readiness.

`fusion audit` is deterministic and read-only.

`fusion show <run-id>` displays a bounded persisted run summary.

`fusion review` has a complete control-plane path, but real Claude/Muse review activation is still pending because the current real adapters do not yet provide the required structured review turn and pre-session read-only capability proof.

`fusion build "<task>"` is implemented at the control-plane level. Writer-required tasks fail closed with `REAL_WRITER_MODE_NOT_READY`; critical tasks stop at the human gate.

Fusion does not weaken capability policy merely to make an unavailable real-provider workflow appear ready.

## Documentation

- [Runtime hardening](docs/m7-hardening.md)
- [Workspace leases and deterministic verification](docs/o1-workspace-verification.md)
- [Task inspection and risk gating](docs/o2-task-risk.md)
- [Workflow engine](docs/o3-workflow.md)
- [Fresh review and adjudication](docs/o4-review.md)
- [CLI and control plane](docs/o5-cli.md)
- [v0.1 build specification](docs/v0.1-build-spec.md)
- [Architecture overview](docs/architecture-overview.md)
- [Security model](docs/security-model.md)
- [Roadmap](ROADMAP.md)

## Security

Do not report security issues in public issues. See [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

No open-source license has been granted at this stage. All rights are reserved unless stated otherwise.

---

Fusion CLI is an independent engineering project. Provider integrations do not imply affiliation with or endorsement by any model or platform vendor.
