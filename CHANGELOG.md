# Changelog

## [Unreleased] — v0.2 conversational shell

Not tagged or released; not yet live-validated.

### Added

- **`fusion` without a command** — a conversational shell over the current folder (interactive terminals only; scripts
  keep exit 2). Welcome and provider status, plain-language help, `exit`/`quit`/Ctrl+C; Ctrl+C during a step cancels just
  that step.
- **Host-side intent routing** (`core/intent.ts`) — deterministic English/German classification into conversation,
  analysis, investigation, plan, change, create, history, undo, bypass and clarify; a fixed grant table decides what each
  kind may do. Read-only kinds can never write; requests to skip safety steps are refused.
- **Team exploration with coverage** — broad analyses of large projects: a strictly parsed Lead packet plan (Fusion's own
  packets as fallback), isolated Explorer packets without transcript, Lead synthesis, a fresh Reviewer critique of the
  bounded synthesis only; a coverage summary of what was inventoried, shared, masked, withheld, examined and cited.
- **Folders without Git** — `fusion`, `fusion analyze` and `fusion chat` work read-only in plain folders (bounded walk,
  folder fingerprint around every turn). Changes stay blocked without a Git baseline.
- **Sensitive-input policy** — credentials, key material, authentication stores (Home Assistant `.storage/`), databases and
  binaries are withheld from conversation views; `secrets.yaml` and `.env` files keep key names only; secret values in
  other text files are masked. The inventory reports what was kept private.
- **Follow-ups and session metadata** — "explain the first finding", "fix it", "fix them" resolve against the bounded
  findings of the last analysis; only safe metadata (counts, last delivery id) is stored per project.
- **Simplified approval** — after a shell build prepares a delivery, one summary and an explicit `[y/N]` approve and apply
  exactly that delivery. The approval record (`confirmedVerifiedSummary`) binds the same manifest, bundle, repository,
  checkout and baseline as a typed-digest approval; single-use apply is unchanged. The shell's build confirmation
  (`confirmedBuildPlan`) binds the same task and scope as the typed `build`.

## [0.1.0] — 2026-09-26

First release of the Fusion CLI product surface. **Release-ready; not yet tagged or published** (v0.1 installs from
source). Code complete and [live-validated](docs/v0.1-live-acceptance.md) for the supported scope: Windows 11 host,
Docker/Linux-container verification, Node.js + TypeScript `create`.

### Added

- **`fusion chat`** — a read-only conversation about the repository (REPL or one message) in a Fusion-owned view; the
  repository is proven unchanged around every turn; `/ask` gets a second opinion from another role; `/build` starts a build
  only after confirmation. History is bounded and kept in memory only.
- **`fusion analyze`** — Fusion's own repository inventory, then one read-only model analysis (`--deep`, `--focus`,
  `--inventory-only`).
- **`fusion build`** — a plan (risk, roles, verification, exact files) confirmed by typing `build`; without `--path` the
  Lead proposes the file scope. Lead plan → Change Author proposal applied by Fusion to a private candidate → confined
  Docker verification (one retry) → fresh review by another model → Lead adjudication (one correction) → an immutable
  delivery. Refused before any model turn when Fusion cannot verify.
- **`fusion create`** — new Node.js + TypeScript projects (`library`, `cli`, `api`): a deterministic template with tests,
  a confined verification plan and a Git baseline, after a typed `create`, then the same confirmed build. Unsupported
  stacks are refused with the supported alternative.
- **Deliveries** — `fusion inspect-delivery` (digests, diff, evidence), `fusion approve-delivery` (type the full manifest
  digest), `fusion apply` (precheck, single-use claim, write, journaled rollback; never commits).
- **`fusion history`** and **`fusion show`** — recent runs, their deliveries and the next step; model turns per run;
  replay-free resume states.
- **Decision requests** — when the Lead asks for a decision, the run stops before any change and its questions are kept as
  a bounded, structured request, shown by build/create, `show` and `history`.
- **`fusion config`** — the effective roles and models, conversation partner, verifier profile and state locations;
  `conversation.partner` configuration key; grouped help and `fusion <command> --help`.

### Safety

- Models run read-only in Fusion-owned views and only propose; Fusion alone applies changes, only to private candidates.
- Verification runs in Docker with no host mounts and no network, from a pinned image; unverifiable builds are refused.
- Deliveries are immutable, stored outside the repository and bound to repository, checkout and baseline; approval is a
  typed digest; apply prechecks before writing and takes a single-use claim; no `--force` or `--yes`.
- Evidence records no provider transcripts, hidden reasoning or credentials. No automatic commit, push, merge or release.
- Unattended Writer mode is not enabled.

### Validation

- Deterministic offline suite (no provider, network or Docker daemon), including an end-to-end acceptance through the real
  CLI, workflow engine and provider adapters on scripted fake binaries.
- `npm run smoke:pack`: a clean clone is built, packed and installed into a private prefix, and the installed CLI runs.
- Live acceptance on 2026-09-26 (12 of 50 authorized model turns): chat, analyze, build and create passed on disposable
  targets, including typed approval and the production apply. The acceptance found one defect — a Lead decision request
  that was not shown — fixed before the final run (`7598fd9`).

### Known limitations

See the [README](README.md#limitations): Windows 11 is the validated host; verification needs Docker with Linux
containers; a build changes only files confirmed before it starts; `create` is Node.js + TypeScript without dependencies;
apply rollback is journaled per file, not a multi-file transaction; conversations are not saved.

---

## Engineering milestones

The entries below record how v0.1 was built. Each describes the state at that milestone; "blocked" there means blocked at
that time.

### O5.5C — Delivery store, human approval and production apply

- An immutable delivery (canonical manifest and exact bytes) prepared from a verified, review-clean result.
- A delivery store in Fusion's application state, outside every target repository, namespaced by repository identity and
  bound to the checkout; `inspect-delivery` with a verified diff.
- Human approval by typed manifest digest; `apply` with a read-only precheck, a single-use mutation claim, staged writes,
  a postcheck and a verified rollback; one live apply rehearsal on a disposable repository.

### O5.5B — Host-controlled Writer route

- The Change Author became a read-only proposal role; Fusion validates change sets and applies them to private
  candidates.
- A productionized Docker verification backend (zero host mounts, no network, pinned image, restricted npm dependency
  lane) with its own acceptance.
- Fusion-owned provider views for every session; the primary checkout fingerprinted around every turn.
- Authorized live probes of every provider turn kind, then a full-route live pass.

### O5.5A — Real read-only review activation

- Added structured review and adjudication turns to the real adapters. They are strict JSON, validated against the unchanged O4 contracts, and prose around the JSON is malformed.
- Added pre-session review isolation facts (approval escalation, personal context, extension quarantine). They are derived from the exact launch controls on validated runtime versions and required for Reviewer and Lead routing.
- Added structured-turn provenance events with requested and observed provider/model.
- Provider failures raised during session setup now keep their typed kind.
- A critical-risk repository review now stops at the human gate before any provider turn.
- `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`) is now recognized by default as the Claude subscription OAuth lane. Conflicting API-key, gateway, base-URL and alternate-provider sources still block before spawn, and the lane is read back before any turn. `fusion doctor` separates the static candidate lane from the observed one; a failed `--probe` now blocks its binding.
- Muse Exec structured turns now use a strict wire schema. Every property is required, optional ones are nullable and closed objects are kept. The same schema is shown in the prompt, and wire nulls are normalized back before canonical and O4 validation. This fixes the live HTTP 400 from the provider's strict decoding without changing the canonical contract or the Claude path.
- Real Writer mode stayed blocked.

### O5 — CLI and control plane

- Added the executable Fusion CLI entrypoint and provider-neutral control plane.
- Added `fusion doctor`, `fusion review`, `fusion audit`, `fusion build "<task>"`, and `fusion show <run-id>`.
- Added explicit user-visible states and stable exit-code mapping.
- Added strict `fusion.config.json` validation.
- Added persisted run outcomes before presentation.
- Added deterministic Writer-readiness blocking (later replaced by the human-confirmed route of v0.1).

### O4 — Fresh review and lead adjudication

- Added fresh Reviewer sessions.
- Added bounded structured Findings.
- Added Lead adjudication with `CONFIRMED`, `PARTIAL`, `REJECTED`, and `UNVERIFIABLE`.
- Added bounded corrective review/fix cycles.
- Preserved strict `answered` vs. `completed` semantics.
- Kept critical-risk tasks behind a human gate.

### O3.1 — Orchestration hardening

- Protected the primary workspace around verification.
- Added strict answered/completed semantics.
- Expanded repository/verification-control risk classification.
- Hardened capability routing.
- Canonicalized risk-text scanning.
- Tightened destructive Git intent detection.
- Revalidated verification working directories immediately before spawn.

### O3 — Policy routing and workflow engine

- Added provider-neutral role routing.
- Added low/medium/high/critical workflow states.
- Added bounded retries and escalation.
- Connected routing, workspace leases, verification, and events.

### O2 — Task inspection and risk gating

- Added deterministic task inspection.
- Added monotonic risk escalation.
- Added sensitive-path and capability-aware risk signals.

### O1 — Workspace leases and deterministic verification

- Added dedicated Git worktree leases (superseded for Writer work by private candidates in O5.5B).
- Added workspace fingerprints.
- Added deterministic `VerificationEngine`.
- Added mutation-policy enforcement.

### Foundation / M7 hardening

- Added hardened process supervision.
- Added billing/auth guards.
- Added Claude and Muse read-only adapters.
- Added structured event/artifact/metrics storage.
- Hardened cancellation, malformed output handling, redaction, path validation, and Claude plugin quarantine.
