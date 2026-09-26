# Changelog

All notable project milestones are tracked here.

Fusion CLI is currently pre-release. Entries below summarize architectural milestones rather than public package releases.

## Unreleased

### Pending

- Live acceptance of the v0.1 commands (human-run: `scripts/v01-live-acceptance.mjs`, authorization FUSION-V0.1-FINISH-LIVE)
- Unattended Writer mode stays off (`REAL_WRITER_LIVE_GATE_AUTHORIZED` is not open)

## v0.1 — the product surface (code complete, offline-validated)

- `fusion chat` and `fusion analyze`: read-only conversations and analysis in Fusion-owned views, the repository proven
  unchanged around every turn; bounded, in-memory history; never recorded as evidence.
- `fusion build`: a plan (risk, roles, verification, exact files) the human confirms by typing `build`; without `--path` the
  Lead proposes the file list in one read-only turn, checked strictly. The real Writer route runs — plan, Change Author
  proposal host-applied to a private candidate, confined verification with one retry, fresh review, adjudication, one
  correction — and a passing build prepares a delivery. A verification preflight refuses before any model turn when Fusion
  cannot verify.
- `fusion create`: supported greenfield Node.js + TypeScript projects (`library`, `cli`, `api`), scaffolded after a typed
  `create`, then built through the same confirmed route; unsupported stacks are refused.
- `fusion history`, and `fusion show` with the next step and the model turns a run used: read-only, replay-free resume states
  for runs and deliveries.
- `fusion config`, `conversation.partner`, grouped and per-command help, doctor wording for v0.1.
- Packaging: a files whitelist (compiled CLI only), `prepack` build, `npm run smoke:pack` (clean clone → pack → install into
  a private prefix → run the installed CLI; never publishes).
- One offline acceptance suite (A–Q) through the real CLI, engine and adapters on scripted fake binaries.

## O5.5A — Real read-only review activation

- Added structured review and adjudication turns to the real adapters. They are strict JSON, validated against the unchanged O4 contracts, and prose around the JSON is malformed.
- Added pre-session review isolation facts (approval escalation, personal context, extension quarantine). They are derived from the exact launch controls on validated runtime versions and required for Reviewer and Lead routing.
- Added structured-turn provenance events with requested and observed provider/model.
- Provider failures raised during session setup now keep their typed kind.
- A critical-risk repository review now stops at the human gate before any provider turn.
- `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`) is now recognized by default as the Claude subscription OAuth lane. Conflicting API-key, gateway, base-URL and alternate-provider sources still block before spawn, and the lane is read back before any turn. `fusion doctor` separates the static candidate lane from the observed one; a failed `--probe` now blocks its binding.
- Muse Exec structured turns now use a strict wire schema. Every property is required, optional ones are nullable and closed objects are kept. The same schema is shown in the prompt, and wire nulls are normalized back before canonical and O4 validation. This fixes the live HTTP 400 from the provider's strict decoding without changing the canonical contract or the Claude path.
- Real Writer mode stays blocked.

## O5 — CLI and control plane

- Added the executable Fusion CLI entrypoint and provider-neutral control plane.
- Added `fusion doctor`, `fusion review`, `fusion audit`, `fusion build "<task>"`, and `fusion show <run-id>`.
- Added explicit user-visible states and stable exit-code mapping.
- Added strict `fusion.config.json` validation.
- Added persisted run outcomes before presentation.
- Added deterministic Writer-readiness blocking.
- Kept real review fail-closed until real adapters provide structured turns and provable read-only capability posture.
- Kept real Writer mode blocked.

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
