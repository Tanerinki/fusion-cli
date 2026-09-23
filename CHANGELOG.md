# Changelog

All notable project milestones are tracked here.

Fusion CLI is currently pre-release. Entries below summarize architectural milestones rather than public package releases.

## Unreleased

### In progress

- O5 — CLI and control plane
- Real Writer isolation hardening
- O6 — true end-to-end Fusion orchestration

### Known gates

Real autonomous Writer mode remains blocked until ignored-path influence, shared Git/common-directory state, verification isolation/reconstruction, and real adapter Writer capability are addressed.

## O4 — Fresh review and lead adjudication

- Added fresh Reviewer sessions.
- Added bounded structured Findings.
- Added Lead adjudication with `CONFIRMED`, `PARTIAL`, `REJECTED`, and `UNVERIFIABLE`.
- Added bounded corrective review/fix cycles.
- Preserved strict `answered` vs. `completed` semantics.
- Kept critical-risk tasks behind a human gate.

## O3.1 — Orchestration hardening

- Protected the primary workspace around verification.
- Added strict answered/completed semantics.
- Expanded repository/verification-control risk classification.
- Hardened capability routing.
- Canonicalized risk-text scanning.
- Tightened destructive Git intent detection.
- Revalidated verification working directories immediately before spawn.

## O3 — Policy routing and workflow engine

- Added provider-neutral role routing.
- Added low/medium/high/critical workflow states.
- Added bounded retries and escalation.
- Connected routing, workspace leases, verification, and events.

## O2 — Task inspection and risk gating

- Added deterministic task inspection.
- Added monotonic risk escalation.
- Added sensitive-path and capability-aware risk signals.

## O1 — Workspace leases and deterministic verification

- Added dedicated Git worktree leases.
- Added workspace fingerprints.
- Added deterministic `VerificationEngine`.
- Added mutation-policy enforcement.

## Foundation / M7 hardening

- Added hardened process supervision.
- Added billing/auth guards.
- Added Claude and Muse read-only adapters.
- Added structured event/artifact/metrics storage.
- Hardened cancellation, malformed output handling, redaction, path validation, and Claude plugin quarantine.
