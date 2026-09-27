# Changelog

## [Unreleased] — v0.3 adaptive multi-agent orchestration

In development: not tagged, not released, not live-validated.

### Added

- **v0.3 — routing contracts, route budgets and the adaptive route (core, not yet wired into the shell).**
  `core/orchestration/` holds the provider-neutral, pure contracts of adaptive orchestration:
  - **Routing decision** — the lead proposes the next step as one closed JSON object: `answer`, `delegate` (1 to N
    `{area, question}` investigations over the host's closed list of areas, optionally a `claim` to judge),
    `synthesize` or `stop`. It is read strictly against the actions, areas and investigation count the host allows at
    that moment. Anything else is refused with a structural category (unknown action, action not allowed now, too many
    investigations, unknown/withheld/duplicate area, schema mismatch, …). No field can widen access, raise a budget, add
    a partner or grant a write.
  - **Investigation packet and report** — a bounded packet per explorer (area, question, claim, prior validated
    findings, file budget; no transcript). A closed report comes back: status, verdict, summary, findings with the paths
    they rest on, open questions, contradictions. Paths must be relative and clean.
  - **Evidence assessment** — the host's own judgement: sufficient only when every investigation reported with cited
    evidence and verdicts agree. Otherwise it names why the evidence is weak (failed, inconclusive, conflicting,
    uncited, none). Only transient failures are repeatable.
  - **Route budgets** — host-enforced: concurrency, batches, investigations, retries, lead, reviewer and total model
    turns, per-investigation and route time. Conservative defaults under hard caps; overrides are validated, never
    clamped. Every turn is reserved before it starts, and turns for the synthesis and the fresh review are kept back.
  - **Adaptive route** — the host's state machine: answer, decide, investigate (repeat once), synthesize (the lead
    reclaims the task), review. It escalates a single answer that ran out of steps and asks the lead about weak evidence
    only when the budget allows another batch. It stops cleanly and honestly when a budget is exhausted. Its trace is
    safe (roles, categories, counts, durations) and renders as `Route: lead decision → 3 parallel investigations → lead
    synthesis → fresh review`, with local metrics.
- **v0.3 — parallel investigation (not yet wired into the shell).**
  - **Isolated investigation turns.** `RepositoryConversation.investigate` runs one turn in its own **view copy**
    (`ProviderViewStore.replica`: the already filtered view, copied into a fresh owned root with its own identity; the
    source must be intact before and after, and the copy must match it file for file) and a **fresh provider session**,
    with no history. It is torn down when the turn settles: session first, then copy.
  - **The same proofs as `ask`.** After the turn the copy must equal its identity and the primary must be unchanged;
    otherwise the conversation closes with a security stop. `close()` aborts and awaits every investigation still
    running. Building and copying the shared view is serialized.
  - **A bounded scheduler** (`app/orchestration/scheduler.ts`). At most three at once, started in order, each with its
    own time budget. A timed-out item becomes a retryable `timeout`; its siblings continue. A fatal failure aborts every
    sibling, waits for all of them and rethrows. The user's cancellation does the same. An item that does not settle
    after its abort is fatal. The batch never returns before every started item has settled.
  - **Result packets** (`app/orchestration/investigations.ts`). A packet per planned investigation holds the area, key
    inventory files, the question, the claim, validated earlier findings about that area and a four-file budget — never
    a transcript. The reply is read strictly as one JSON report, and its cited paths count only when the view shared
    them. A reply that is not a report is kept as a bounded, marked, unstructured report. A failed turn becomes a safe
    category (`timeout`, `authentication`, `posture`, `provider failure`, …); security stops and cancellations end the
    route.
  - **Other additions.** An `investigation` conversation purpose (read, then reply with one JSON object). A
    provider-neutral `failureCategory` on failed turns (Claude's turn limit, rate limit, …). The fake provider binaries
    claim scripted turns atomically, and a `barrier` proves concurrency mechanically.
- **v0.3 — adaptive orchestration in the shell.** Every analysis runs the adaptive route (`app/orchestration/adaptive.ts`)
  instead of the fixed v0.2 pipeline. The host classifies each line:
  - **single**: a question, an explanation, a narrow analysis, or a small project. One lead turn; `ask` turns print
    `Route: lead only`.
  - **team**: a broad analysis of a large project. The lead decides to answer or to delegate, and may still answer
    directly.
  - **verify**: *is the first finding really a problem?*, *is that really a bug?*, *is the trusted_proxies finding
    really a problem?* — the verification of ONE earlier finding, which becomes the host's claim.

  The route then:
  - runs the lead's strict routing decisions, or Fusion's own bounded areas when a decision is refused (never a withheld
    area such as `.storage/`);
  - runs parallel investigations in isolated copies and sessions, repeats transient failures once, and asks the lead
    about weak evidence when the budget allows another batch;
  - lets the lead reclaim the task (the synthesis gets a `CONFLICT:` instruction when verdicts disagree) or stop without
    a conclusion;
  - gets a fresh critique in its own copy and session;
  - escalates a single answer that ran out of steps.

  The terminal shows `Route:` and `Turns:` lines, the planning line, each investigation's state, `Claim checked: …`,
  `Conflict: …` and `Evidence: incomplete (…)` where they apply. A stopped route shows what the investigations reported,
  marked unconfirmed.

  The session keeps the host's evidence about a verified finding (cited files, verdict counts), and *fix it* carries it
  into the existing build route: `(Fusion's investigation of this finding cited: …)`. Session metadata v2 adds safe
  orchestration counts (v1 files are still read), and `history` prints them. The v0.2 plan contract
  (`{"areas":[…]}`) is replaced by the routing decision.
- **v0.3 — Muse explorer posture (investigated, unchanged).** The installed Muse 1.4.0-R4161.1 is validated only for the
  Reviewer binding. The Explorer binding's web-tool, approval, personal-context and extension controls stay `unknown`,
  and Muse has no model-free canary to prove them. The Explorer binding stays unvalidated. The validated Reviewer binding
  keeps serving as the exploration transport, and the terminal says so.

## [0.2.5] — 2026-09-27 — v0.2 conversational shell

The v0.2 line below — the conversational shell and its follow-ups v0.2.1 to v0.2.5 — released as **0.2.5**: tagged
`v0.2.5` and released on GitHub; not published to a package registry (install from source).
[Live-validated](docs/v0.2-live-validation.md#result-2026-09-27) by the maintainer against the real provider CLIs on
disposable targets: **Live A PASS, Live B PASS, Live C PASS**; the Claude Code 2.1.283 runtime attestation passed after the
v0.2.5 fix. The evidence is real but bounded: a small number of live runs per part, on disposable targets (a synthetic
Home Assistant configuration for A and C, a clone of this repository for B). Live C's one-file change was LOW risk and ran
no fresh review (the build's fresh-review path has separate live evidence from the v0.1 acceptance).
Unattended Writer mode stays blocked. Provider processes run under the host user's account; a provider view is not an OS
filesystem sandbox.

### Added

- **v0.2.5 — Live C follow-ups: init-only startup cleanup, safe probe details, the fixture verifier.** Every Claude turn
  first runs init-only startups (plugin discovery, quarantine verification; the canary for `doctor --probe`) that Fusion
  cancels at `system/init` and ends with a process-tree kill. On Windows `taskkill /T /F` reports failure (exit 128) when a
  short-lived helper of the runtime exits while the tree is walked, although nothing survives, and Fusion refused the turn
  ("Claude built-in plugin discovery could not be confirmed." — the first Live C analysis). Such a startup is now repeated
  ONCE when the tree cleanup is its only doubt (init seen and verified, no stream, protocol or observer issue, the started
  process exited); the repeat must be clean, and a process that did not exit is never repeated. Every refusal of an
  init-only startup carries a safe `detail:` (init seen, issue, observer issues, termination method, cleanup label, whether
  the process exited, exit code, attempts), shown by the shell's analysis fallback and by `doctor --probe`; a process error
  names its platform code (`error_code=ENOENT`) and whether the process had started. `verify-git` of the v0.2 live fixture
  now matches Fusion's marker syntax instead of the bare text `<redacted` (which its own confined check contains).
- **v0.2.4 — structured lead planning and truthful coverage.** The lead's planning turn has its own `plan` purpose: its
  rules ask for one JSON object and nothing else. Before, the generic conversation rules ("answer in natural language",
  "end with a Proposed build task line") contradicted the JSON-only instruction, and the real lead's plan was refused. The
  plan is a closed, minimal object `{"areas":[{"id","reason"}]}` over the explicit list of area ids Fusion puts in the
  context (1–3 areas, no other key, no unknown or duplicate area, a reason of at most 200 characters; a trailing `/` or
  leading `./` and one outer JSON fence are tolerated, nothing else is repaired). A refused plan names a safe category
  only, and Fusion's deterministic fallback stays, now visible:
  `Planning: Claude selected 2 investigation areas (…)` or `Planning: Claude's structured plan was invalid (unknown
  area); Fusion selected 3 bounded areas instead (…)`. The coverage block claims only what Fusion controls or observes:
  `Assigned to explorer investigations` (with areas whose report did not come back), `Cited in the final answer`,
  `Neither assigned nor cited`, and the caveat that Fusion cannot see which files a model opened. It no longer says
  "examined in depth", to the user or to the critique model.
- **v0.2.3 — the broad analysis of large repositories, and safe failure diagnostics.** A failed Claude turn now carries a
  safe `failureDetail`: its category (turn limit, input too large, rate limit, authentication, provider API error, model
  error, …) and allowlisted fields only (`subtype`, `terminal_reason`, `stop_reason`, `is_error`, `num_turns` against
  `max_turns`, `api_error_status`, `duration_ms`, `exit_code`), shown as a `detail:` line; never provider text. Every stage
  of an exploration is named when it fails (lead plan, explorer, synthesis, critique, single analysis). The lead plans from
  the bounded inventory alone (one outer JSON fence accepted, as for the Writer route's plan), explorers and the synthesis
  work within stated step budgets, and exploration only uses a partner whose read-only posture is PROVEN — on Muse 1.4
  the default explorer binding is not validated, so the validated reviewer binding explores in separate contexts. The
  shell no longer prints the expert approval commands right before its own one-step approval offer.
- **v0.2.2 — capability-based Claude runtime compatibility.** A Claude Code patch update no longer disables Fusion until a
  source change: 2.1.280 stays the recorded validated release, and a later 2.1.x patch is accepted once this Fusion process
  has attested its read-only posture with a mechanical canary (init-only startups in a Fusion-owned workspace with project
  and local settings, hooks, an MCP file, agents, skills and commands that must not load; no model call). Every turn still
  proves tools, permission mode, MCP, plugins, hooks, model identity, subscription lane and one runtime version, and a turn
  whose runtime differs from the attested one is refused. Other release lines and failed canaries are refused in plain
  language pointing to `fusion doctor --probe`, which now runs the same check and reports `runtime posture`.
- **v0.2.1 — the sensitive-input policy on the build path.** Every provider view of a build (Lead, Explorer, Change Author,
  Reviewer; baseline, candidate and working tree) passes the same policy as a conversation, and every review diff masks
  secret values (`redactUnifiedDiff`). Protected files (credentials, key material, `secrets.yaml`, `.env`, `.storage/`,
  private-key blocks, binaries, oversized files) are never in a build scope: `fusion build`, the shell and `create` stop
  before any model turn with a human-facing decision (`DECISION_REQUIRED`, code `protectedMaterial`). Masked values are
  numbered (`<redacted:password:1>`); the Change Author is handed file digests as it saw them, and the candidate port turns
  a proposal into the host ChangeSet (`WorkspacePort.hostChangeSet`) with each value restored exactly — or refuses it for
  a human decision when a marker does not belong to the file. Verification, review, delivery and approval are unchanged.

- **`fusion` without a command** — a conversational shell over the current folder (interactive terminals only; scripts
  keep exit 2). Welcome and provider status, plain-language help, `exit`/`quit`/Ctrl+C; Ctrl+C during a step cancels just
  that step.
- **Host-side intent routing** (`core/intent.ts`) — deterministic English/German classification into conversation,
  analysis, investigation, plan, change, create, history, undo, bypass and clarify; a fixed grant table decides what each
  kind may do. Read-only kinds can never write; requests to skip safety steps are refused.
- **Team exploration with coverage** — broad analyses of large projects: a strictly parsed Lead packet plan (Fusion's own
  packets as fallback), isolated Explorer packets without transcript, Lead synthesis, a fresh Reviewer critique of the
  bounded synthesis only; a coverage summary of what was inventoried, shared, masked, withheld, assigned and cited.
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

First release of the Fusion CLI product surface: tagged `v0.1.0` and released on GitHub; not published to a package
registry (v0.1 installs from source). Code complete and [live-validated](docs/v0.1-live-acceptance.md) for the supported
scope: Windows 11 host, Docker/Linux-container verification, Node.js + TypeScript `create`.

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
