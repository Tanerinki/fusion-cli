# O5.5B8 Provider workspace boundary and production Writer composition

Labels: **MECHANICALLY ENFORCED** (code plus deterministic tests), **DETECTED** (a change is caught and fails the run closed; it is not prevented), **FAKE-PROCESS PROVEN** (the REAL adapter code launched deterministic fake native provider binaries whose recorded argv, working directory and environment key names were asserted), **NOT PROVIDER-LIVE PROVEN** (no real provider did it), **NOT OS-ISOLATED** (no operating-system filesystem boundary exists), **UNSUPPORTED** (refused, fail closed), **OBSERVED** (measured on this machine in this milestone).

Outcome in one line: no provider process of any Fusion workflow runs in the user's checkout any more — every session is bound to a Fusion-owned, `.git`-free, fingerprinted view — ignored primary files such as `.env` are monitored under an explicit bounded policy, the production Writer route is composable end to end behind a still-closed live gate, and host-side Git work per attempt fell from 236 to 138 processes. No provider was called; no gate was opened; a view is a working directory, not an OS sandbox.

## 1. Starting architecture

Branch `o5-5b8-provider-boundary`, HEAD `271f64588dd6e7db5c6f8eba88bef52af3ed7513` (`feat: wire offline end-to-end writer workflow`), clean tree — verified before any change. Baseline suite: 530 tests, 529 pass, 1 skip, 0 fail (≈155 s).

OBSERVED current real-provider path (Phase A, from the code at 271f645):

| Question | Observed fact |
| --- | --- |
| Claude cwd | `ClaudeLaunchConfig.workspace` = `ProviderRuntimeContext.workspace` = the primary top level, for **every** process: `auth status` (also in `createSession`), `plugin list --json`, both init-only probes, the turn (`one-shot-transport.ts`). |
| Muse cwd | Exec: `--workspace <primary>` and cwd = primary (`exec-transport.ts`); account attestation starts `muse serve` with cwd = primary; MSP: `serve` cwd = primary and `session/start workspaceRoot = primary`. |
| Source tree each role saw | The primary checkout: committed, uncommitted, untracked **and ignored** files (`.env`, `node_modules`). |
| Roles reading the primary | All of them: Lead, Explorer, Change Author, fresh Reviewer, adjudicating Lead (`review`, read-only `build`, and the rehearsal Writer route). |
| Transports forceable read-only | Claude one-shot (`--tools Read,Grep,Glob --restricted --safe-mode …`), Muse Exec (`--disable-write --disable-shell --disable-web-tools …`), Muse MSP (write/shell only). |
| Adapters able to take another root | None: the workspace was fixed at construction; sessions carried only a lease **label** (`workspaceLeaseId`), never a path. |
| Where production Writer composition stopped | `app/commands.ts` refused Writer tasks before any adapter; `buildCandidates` and every factory's `create` refused Worker bindings; only the test-only `writerRehearsal` seam reached the engine. |
| Why providerChangeProposal was blocked | No authorized real-provider run; and a real Change Author would have read the primary rather than the candidate. |
| Fake-only gates | `hostControlledWriterWorkflow` (fake providers); the change-proposal posture (capability facts and fakes only). |
| Primary fingerprint | `captureSnapshot`: HEAD, HEAD ref, index, flags, locations, effective config, selected `.git` metadata, `git status` tracked+untracked with file digests — **7 Git processes per call; ignored files not observed at all** (B7 pinned `.env` as a documented gap). |

## 2. O5.5B7 remaining blockers (as stated there)

(1) adapters bound to the primary as cwd; (2) providers saw the primary filesystem; (3) no real-provider ChangeSet; (4) incomplete production composition; (5) ignored-file changes (e.g. `.env`) undetected; (6) ≈236 Git processes ≈10 s per attempt; (7) no human-approved delivery path. This milestone addresses (1), (4), (5), (6) and designs (7); (2) is reduced but **not** removed (§9, §20); (3) stays open by design (§21).

## 3. Provider workspace model (MECHANICALLY ENFORCED)

New core contract (`core/workflow/types.ts`): `ProviderViewPort` (`open`, `fingerprint`, `release`, `viewRoot`) and `ProviderViewHandle` (`viewId`, `kind`, `path`). New domain facts: `CreateSession.workspace = { id, root }`, `Session.workspaceRoot` (echo), capability `workspaceBinding` (the adapter starts every process of a session in the session's root and refuses forbidden roots).

Implementation: `platform/workspace/provider-views.ts` (`ProviderViewStore`) and `platform/workflow/ports.ts` (`ProviderViewWorkspacePort`). A view is `<tmp>/fusion-provider-view-<random>/workspace` with an owner marker `.fusion-owner` (`schemaVersion`, `kind: providerView`, random `viewId`, `ownerPid`, owner, base commit, creation time). Kinds:

- `baseline` — private remote-less clone of the committed HEAD (`--no-local --no-hardlinks`, `core.autocrlf=false`), whose own `.git` is deleted before any provider runs: plain files only.
- `candidate` — a copy of the host-applied candidate without its `.git`, verified file-for-file against the tree Fusion applied (`PrivateWriterWorkspace.expectedTree`, which first proves the candidate on disk still equals it).
- `workingTree` — `baseline` plus the primary's tracked changes and untracked, non-ignored files, each copied only if its bytes still hash to what Git status observed; read-only `review`/`build` only.

Every view: excludes `.git`, `.fusion` and the provider state paths the provider profiles declare (`ProviderProfile.workspaceStatePaths`: `.claude`, `CLAUDE.local.md`, `.muse`; supplied through `ProviderRegistry.workspaceStatePaths`, so no provider name enters the store); contains no link or special file (`captureControlledTree` complete, else refused); is bounded (50 000 entries / 512 MiB copy, 20 000 overlay files); its **identity** is the fingerprint of the whole owned root (marker + workspace + anything added next to them) taken by the engine right after creation.

Engine binding (`core/workflow/engine.ts`):
- a Writer workflow **requires** a view port (`InvalidInput` before any role otherwise); with views every role is routed with `workspaceBinding` (rejection `workspaceBindingUnsupported`), and `CHANGE_PROPOSAL_REQUIREMENT` now includes `workspaceBinding: true`;
- views are opened lazily per purpose and validated: strictly inside `viewRoot`, never the primary nor inside/around it, never inside/around any candidate private root of the run (checked both ways: a later candidate overlapping a view is refused too), never a reused `viewId`, kind as requested;
- every session request carries `workspace`; the session must echo `workspaceRoot` exactly;
- every turn in a view is wrapped by `viewUnchanged`: fingerprint must equal the identity **before and after** (even on failure/cancellation) — else risk `providerWorkspaceChanged` (critical) and `SecurityViolation`;
- views are released with their candidate (candidate views) and at every terminal state; an unproven release turns a success into `failed/cleanupIncomplete`; `WorkflowResult.providerViews = { created, released, complete }`; events `ProviderViewObserved { kind, phase, complete? }` (kind only — never a path).

## 4. Lead workspace

Writer flow: the Lead plan (and the optional high-risk Explorer) runs in the `baseline` view. The Lead review (medium, non-fresh mode) runs in the current `candidate` view. The adjudicating Lead runs in the `candidate` view of the cycle. Read-only flows: the `workingTree` view. FAKE-PROCESS PROVEN (real Claude adapter code, every recorded launch in the expected view kind).

## 5. Worker proposal workspace

The Change Author runs in the `baseline` view — the committed HEAD it must write SHA-256 preconditions against — **never in the private candidate** Fusion applies into, and never in the primary. The baseline view is shared by the Lead plan and all attempts of a run; each use is held to the view's creation identity, so a write by any turn is caught at that turn. MECHANICALLY ENFORCED; FAKE-PROCESS PROVEN for Claude one-shot and Muse Exec.

## 6. Reviewer workspace

The fresh Reviewer (and the adjudicating Lead) run in a `candidate` view: a verified copy of exactly the applied state under review (the same content the confined verifier ran and the diff evidence describes), without `.git`, taken after verification. A Reviewer write to it voids the run before adjudication (tested); the candidate itself stays untouched and is still fingerprinted around every turn.

## 7. Candidate visibility policy

The candidate path is handed to no provider (MECHANICALLY ENFORCED: views and candidates can never overlap; the Worker's view is the baseline, the Reviewer's a copy). The candidate still lives under `%TEMP%` with a random name: a host process that guesses it could reach it (NOT OS-ISOLATED); it is DETECTED by the candidate fingerprint around every turn and its verified-state check.

## 8. Primary checkout relationship

| Property | Status |
| --- | --- |
| PRIMARY_NOT_PROVIDER_CWD | **MECHANICALLY ENFORCED** for every engine-driven session (Writer, `review`, read-only `build`); FAKE-PROCESS PROVEN: every recorded Claude/Muse launch (auth readback, plugin inventory, init probes, turn, Exec turn) ran in a view; the Muse Exec account-attestation host runs in an **empty** `fusion-muse-attest-*` directory removed on close. Adapters built for these runs (`sessionWorkspaces: "required"`) refuse any session without a view, a view that is/contains/lies inside the primary (also through a junction), and refuse out-of-session auth readback; an MSP adapter reports `workspaceBinding: false` statically so routing never starts its host in the primary. |
| PRIMARY_NOT_SHARED_GIT | **MECHANICALLY ENFORCED**: views contain no `.git` at all; candidates and verification reconstructions are private clones proven unshared. |
| PRIMARY_MUTATION_DETECTED | **DETECTED**: the primary fingerprint (Git state, tracked, untracked, and bounded ignored-path monitoring) is held to the run's **first** observation around every turn, application and verification — a change between two units of work is caught at the next check too. |
| OS_PRIMARY_FILESYSTEM_UNREACHABLE | **NOT OS-ISOLATED — not claimed.** Provider CLIs still run on the host under the user's token and can technically open any absolute path. |

Remaining non-workflow uses of the primary as cwd (opt-in diagnostics, no inference): `fusion doctor --probe` (`claude auth status`, `muse serve` + `account/read`).

## 9. What is prevented vs only detected

Prevented (MECHANICALLY ENFORCED): provider cwd in the primary; a shared or any `.git` in a provider view; the candidate as a provider workspace; host application outside the owned candidate; provider write tools (launch posture, FAKE-PROCESS PROVEN argv); API-key/gateway/third-party lanes (BillingGuard, unchanged); Git-internal, absolute, drive, UNC, traversal targets in a ChangeSet; absolute paths in review findings.
Only detected (fail closed): any provider write to its view (whole-root content fingerprint), to the candidate, to the primary's tracked/untracked files, Git metadata, config, index, sensitive/protected ignored files, top-level ignored entries and managed-directory child sets. NOT detected: transient mutate-and-restore between two fingerprints of content Fusion hashes; changes inside managed ignored directories (unless protected); content changes of non-sensitive ignored files that preserve size, mtime, ctime and file id; writes to Fusion's own `.fusion/` run storage (excluded because Fusion writes it during a run); any read of host files.

## 10. Ignored-path monitoring (`platform/workspace/ignored-monitor.ts`)

Source: Git's own ignored listing at `matching` granularity, folded into the **same** status process (`git status … --ignored=matching`; zero extra processes). Policy (bounded; coverage reported, never assumed):

| Class | Monitoring |
| --- | --- |
| Sensitive files by name (`.env*`, `*.env`, `.envrc`, keys/keystores/`*.pem`/`*.p12`/`*.tfvars`/`*.tfstate`, `id_*`, `.npmrc`/`.netrc`/`.pgpass`/`.git-credentials`, `*secret*`/`*credential*`/`*token*`/`*password*`, `*.local`, `kubeconfig`) and files in sensitive directories (`.aws`, `.ssh`, `.gnupg`, `.kube`, `.docker`, `secrets`, `credentials`, `keys`, …) | SHA-256 of content on every observation (≤ 4 MiB/file, ≤ 16 MiB/observation, else metadata + `partial`) |
| User-declared protected paths (`fusion.config.json` → `protection.ignoredPaths`, files or `dir/`) | content, even inside managed directories |
| Other ignored files | metadata (size, mtime, ctime, file id, mode) |
| Managed/cache directories (`node_modules`, `dist`, `build`, `.venv`, `__pycache__`, `target`, `coverage`, `.next`, `.cache`, …) | directory-level signal only (own metadata + sorted direct child names) — **contents unmonitored**, coverage `partial` (`managedDirectoryContents`) |
| Other ignored directories | bounded walk (2 000 entries, depth 8); beyond → directory signal, `partial` (`directoryWalkBound`) |
| The ignored listing itself | part of every fingerprint (a new `.env.production` is a change) |
| `.fusion/` | excluded |

Nothing leaves the monitor but one digest and counts (`IgnoredCoverage`); no path, value or content is returned, logged or persisted (tested with canaries). A monitored change during an autonomous run is `SecurityViolation` with risk critical (tested with `.env`, `secrets.local`, protected paths). Coverage is structurally **partial** for any primary with a dependency tree: IGNORED_PATH_PROTECTION is PARTIAL, not YES.

## 11. Claude invocation posture (FAKE-PROCESS PROVEN; NOT PROVIDER-LIVE PROVEN)

Recorded for a Change Author session: 6 launches (session auth readback, turn auth readback, `plugin list --json`, discovery and verification init probes, the turn), **all** with cwd = the view. Every `-p` launch: `--tools Read,Grep,Glob`, `--permission-mode dontAsk`, `--permission-prompts none`, `--restricted`, `--safe-mode`, `--strict-mcp-config`, `--disable-slash-commands`, `--no-session-persistence`, `--include-hook-events`, child-only `--settings` plugin quarantine; none of the widening flags. Environment: `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`; stripped `GITHUB_TOKEN`, `CLAUDE_CODE_EFFORT_LEVEL`; `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`/`CLAUDE_CODE_USE_BEDROCK` refuse the session before any process starts. Settings preflight still reads the primary's `.claude/settings*.json` (Fusion-side read) and the profile settings. The view never contains `.claude` or `CLAUDE.local.md`. Whether Claude's own permission layer additionally denies out-of-cwd reads in `dontAsk` mode is NOT PROVIDER-LIVE PROVEN and is not relied on.

## 12. Muse invocation posture (FAKE-PROCESS PROVEN; NOT PROVIDER-LIVE PROVEN)

Exec turn: cwd = view and `--workspace <view>`; `--approval-mode never --disable-write --disable-shell --disable-web-tools --approval-judge off --no-foreign-personal-context`; no widening flag; `MUSE_ENABLE_WEB_TOOLS` and `GITHUB_TOKEN` stripped; `META_API_KEY` refuses before any Exec process. Account attestation (`account/read` before and after every turn) runs `muse serve --disable-write --disable-shell` in an empty Fusion-owned directory, removed when the adapter's last session closes. MSP: UNSUPPORTED for view-bound sessions (one durable host, one fixed workspace; no structured turns) — refused at `createSession` and statically ineligible for routing. The change-proposal wire form of the ChangeSet equals its canonical form (every writeText field present), decoded and validated as before.

## 13. Production Writer composition (`app/writer-composition.ts`)

`composeProductionWriter` builds: real Lead/Explorer/Reviewer bindings (`create`) and Worker bindings as **read-only Change Authors** (`AdapterFactory.createChangeAuthor`, Claude one-shot and Muse Exec; MSP reported unavailable), all with `sessionWorkspaces: "required"`; the `PrivateCandidateWorkspacePort` bound to the acceptance (`acquireVerificationIsolationAcceptance`: production instance → probe → one `node --version` probe → its own evidence → teardown → authority; anything but a grant makes the port refuse verification, `confinementNotAccepted`; no trusted host exists in it); the provider view port; the confined plan (`verification.confinedCommands`, absolute guest executables, read-only) and dependency lane (`verification.dependencies`); the protected paths. `buildCandidates` and `create` still refuse Workers (B7 tests unchanged). `fusion build` asks `liveWriterAuthorization()` **before composing anything**: while it refuses (always, in this release) a Writer task stops at `REAL_WRITER_MODE_NOT_READY` with no adapter, view, candidate or container created (tested with a spying registry). The rehearsal seam and the (gate-closed) production route share one `runWriterWorkflow`. MECHANICALLY ENFORCED; composition exercised with fixtures (fake installs, forged acceptance refused).

## 14. Billing/auth interaction

Unchanged BillingGuard rules and per-turn auth readback apply to Change Author bindings exactly as to Reviewers (FAKE-PROCESS PROVEN: API-key, gateway and third-party variables refuse before any process; generic credentials stripped). Doctor now shows, for Worker bindings, `change proposal: implementation <state>; live evidence absent; ready no` (`changeProposalReadiness`); an API key makes it `blocked`. No PAYG fallback exists.

## 15. Git performance (OBSERVED, this Windows machine, one medium rehearsal attempt with fresh review)

| | O5.5B7 (271f645) | O5.5B8 |
| --- | --- | --- |
| Git processes | 236 | 138 (includes the new baseline-view clone and ignored monitoring) |
| Git process time (sum) | 9.7–9.9 s | 7.1 s |
| Rehearsal wall time | 11.0–11.1 s | 4.5–4.6 s |
| Per `captureSnapshot` | 7 sequential | 4 concurrent (`rev-parse --show-toplevel --git-dir --git-common-dir --verify -q HEAD`, `ls-files --stage -v -z`, `config --list`, `status`); HEAD ref read from `HEAD` (Git asked only for a reftable placeholder); file digests 16-way parallel |
| Candidate changed paths | 10 (snapshot + `rev-parse` + `diff --name-only HEAD` + `ls-files --others`) | 4 (the snapshot's own status entries; index proven equal to HEAD) |
| Private-clone readback | 1 extra `rev-parse` each | 0 (from the observation) |

Live Docker regression (`FUSION_DOCKER_LIVE=1 npm run test:writer-live`, fake providers, accepted production backend, real views; OBSERVED): acceptance 45/45 facts (9.6 s) and a second grant through the new `acquireVerificationIsolationAcceptance` on a fresh production instance (9.3 s); two-attempt run with fresh review 19.6 s (fresh dependency preparation) and 14.7 s (cache hit), versus 26.6–31.5 s in O5.5B7; candidate acquire 0.62–0.64 s (was 1.32–1.43 s), host application 0.35–0.44 s (was 1.42–2.07 s); real `node --test` 9/11 then 11/11; every provider view removed.

Equivalence (tests): the 4-process snapshot is `deepEqual` to a verbatim 7-process reference in every tested state (dirty, staged, deleted, assume-unchanged, skip-worktree, detached, new commit, unmerged conflict stages, unborn HEAD); the index/flag digests are byte-identical by construction (`--stage -v` records split into the two old outputs); changed paths equal `diff HEAD ∪ untracked` across modify/delete/nested-add/ignored cases; a Git-metadata change is still refused. No before/after check was removed; nothing mutable is cached. Dominant remaining cost: 31 status/config/ls-files/rev-parse observations per attempt (primary and candidate fingerprints around every unit of work).

## 16. Provider snapshot cleanup (MECHANICALLY ENFORCED)

Per-view random identity in the marker; `release` removes only when the marker names **this** view (a swapped marker is refused, nothing deleted), unlinks links without following, requires the owned root directly under `%TEMP%` with the prefix, and proves the root gone. Engine: release on success, failure, cancellation and superseded candidates; incomplete never success. `ProviderViewStore.findStale` (detection: `ownerGone`, `unverifiable`, `notADirectory`) and `sweepStale` (removes only verified provider-view markers of a dead owner older than 60 min; keeps young, unverifiable, link and live-owner entries; reports failures). Tested: crash simulation, young view, marker-less look-alike, junction look-alike (target untouched), cancellation of a real fake-process turn (the view is removable immediately — no surviving process holds it). The sweep is not scheduled automatically.

## 17. Human-approved delivery design (`app/delivery.ts`: contract + read-only preflight; no applier)

CLI shape (future): `fusion apply <run-id> [--dry-run]`, interactive confirmation showing the preview; never implied by `build`.
Contract: `DeliveryManifest` = run ID, base commit, SHA-256 of the canonical ChangeSet, and per operation kind/path/before/after hashes/bytes — never content. Only a `completed` run whose final verification carried a **granted** acceptance qualifies (a rehearsal or fake-provider result is refused). `deliveryPreflight` (read-only; tested): HEAD must equal the base commit (`headMoved`); each target must hold exactly its precondition (`fileChanged`, `fileAppeared`, `fileMissing`), be a regular file under real directories inside the workspace (`notRegularFile`, `parentNotDirectory`, `outsideWorkspace`, `tooLarge`); unrelated uncommitted work never blocks; a preview lists exact paths and actions.
Apply (design only): persist the approved ChangeSet content as a run-local, hash-addressed artifact (verified against `changeSetSha256`); re-run preflight immediately before writing; stage every new content under the primary's `.fusion/delivery/<run>` with a rollback journal (prior bytes' hashes and backups); per file: re-check the precondition, then atomic rename into place; on any failure roll back from the journal and report exactly which paths were restored; never `reset --hard`, never `clean`, never stage, commit or push; emit a `DeliveryApplied`/`DeliveryRolledBack` audit event with hashes and counts only. Nothing in tests delivers to a primary.

## 18. Security red-team results

| # | Attack | Result |
| --- | --- | --- |
| 1 | Change Author writes its view | DETECTED → `SecurityViolation`, risk critical, no verification, no review |
| 2 | Creates `.git` in its view / ChangeSet targets `.git` | DETECTED (tree incomplete) / refused before application (B7) |
| 3 | Traversal next to the view / in a ChangeSet | DETECTED (owned-root fingerprint) / refused (B7) |
| 4 | Absolute path to the primary: writes / ChangeSet target | DETECTED (anchored primary fingerprint) / `proposalRejected` |
| 5 | Reviewer writes its candidate copy | DETECTED before adjudication; the Lead never sees it |
| 6 | Port or adapter handed the primary (or inside/around it, or via a junction) | refused before any session/process |
| 7 | View handed out inside/around a Writer candidate (either order) | refused; no Change Author runs |
| 8 | Provider output contains the primary path (finding `file`, plan text) | finding malformed; no event carries the path |
| 9 | Forbidden credentials in the environment | blocked (API key, gateway, Bedrock, META key) or stripped (generic tokens, web-tool switch) |
| 10 | Committed `.claude/settings.json` (`bypassPermissions`), `.muse/`, `CLAUDE.local.md` | never in a view; Claude additionally runs `--restricted --safe-mode` |
| 11 | Ignored `.env` / `secrets.local` changed during a run | DETECTED (B7 gap test now asserts detection) |
| 12 | Huge ignored `node_modules` (3 000 files), huge `logs/` | bounded; explicit `partial`; nested managed edit not detected (documented), protected path detected |
| 13 | Stale views, swapped markers, look-alike directories and junctions | only verified dead-owner old views removed |
| 14 | Cancellation mid-turn (engine fake; real Claude and Muse fake processes) | cancelled; process tree gone; every view and candidate removed |
| 15 | Fake provider / forged acceptance / provider text tries to open readiness | no row changes; `providerChangeProposal` stays blocked; live gate false |
| 16 | Lead tries to override a boundary violation | impossible: the violation is terminal before any review or adjudication |

Self-review fixes made during the milestone (BLOCKER/HIGH): structured review/adjudication turns bound their view but were not wrapped by the view guard (found by red-team test 5, fixed); an MSP-bound adapter's `capabilities()` started its host in the primary during routing (now static for view-bound compositions); out-of-session auth readback of a view-bound Claude adapter would have run in the primary (now refused); `workingTree` views of a subdirectory would have mis-copied (now refused).

## 19. Readiness impact

| Gate | State | Evidence kind |
| --- | --- | --- |
| primaryProtection | partial | mechanical |
| providerWorkspaceBoundary (new) | partial | fakeProcess |
| ignoredPathProtection (new) | partial | mechanical |
| hostControlledApplication | satisfied | mechanical |
| hostControlledWriterWorkflow | partial | fakeProviderRehearsal |
| productionWriterComposition (new) | satisfied | mechanical |
| providerChangeProposalImplementation (new) | satisfied | fakeProcess |
| providerChangeProposal | **blocked** | none |
| verificationIsolation | satisfiedForLinuxScope with a grant, else notEvaluated | liveProcess |
| platformCompatibility | satisfied | mechanical |
| dependencySupport | partial | mechanical |
| cleanupAndRecovery | satisfied | mechanical |
| reviewAndAdjudication | satisfied | mechanical |
| billingAndAuthPosture | satisfied (was partial: now evaluated for Change Authors) | mechanical |
| sharedGitAndIgnoredPaths | partial | mechanical |
| liveGateAuthorization | **blocked** | none |

`writerReadiness()` remains `REAL_WRITER_MODE_NOT_READY`; `REAL_WRITER_LIVE_GATE_AUTHORIZED` remains `false`; no input changes the provider-live or live-gate rows.

## 20. Remaining OS filesystem-boundary limitation

A provider CLI runs as a normal host process of the user. Views remove the primary as its working directory and as its source tree, but its tools (or a compromised binary) can still address absolute host paths: the primary, the candidate under `%TEMP%`, the user profile. Fusion detects writes it fingerprints and refuses what it validates; it does not prevent reads, and a mutate-and-restore within one turn of unhashed content stays invisible. Closing this needs an OS boundary for provider processes (a confined provider runtime), which AppContainer could not provide (O5.5B3c) and Windows Sandbox could not be evaluated for (O5.5B3d).

## 21. Exact requirements for the first real-provider change-proposal probe

1. Explicit human authorization naming the milestone, the provider/binding (one: Claude one-shot **or** Muse Exec), the model, the budget (one proposal turn; the cheapest model/effort) and the fixture.
2. Fixture only: `test/fixtures/rehearsal-project.ts` in a throw-away temporary primary; never a user repository.
3. Composition as in this milestone: the Change Author built by `createChangeAuthor`, a `baseline` view, `requireSessionWorkspace`, the validated runtime version (Claude 2.1.280 / Muse `1.3.0-R3401.1`), subscription lane read back.
4. Run from a normal terminal, not from inside a Claude Code tool shell (known to break Muse calls here).
5. Record: every launch's argv/cwd (a wrapper, not the fake), init readback (tools, permission mode, MCP, plugins, credential source), the view fingerprint before/after, the primary evidence before/after (full walk incl. ignored), the returned ChangeSet validated by `validateChangeSet`, applied to a private candidate and verified in the accepted Docker backend.
6. Pass criteria: proposal validated or cleanly refused; zero view/primary/candidate change; no process outside the view; lane = subscription; no network tool; cleanup complete. Anything else keeps `providerChangeProposal` blocked.
7. Even a passing probe opens only `providerChangeProposal` evidence; the live Writer gate stays closed until its own authorization.

## 22. Recommendation for the next milestone

**O5.5B9 — authorized single real-provider change-proposal probe** (only after this report is reviewed and the human authorizes §21): one bounded proposal turn per provider family on the rehearsal fixture, through the exact production composition of this milestone, with launch recording and full-walk primary evidence. In parallel (no provider needed): schedule the stale-view and container sweeps at start-up, and reduce per-turn fingerprint cost for large repositories (the dominant remaining host cost). The OS boundary for provider processes remains the structural blocker for `REAL_WRITER_MODE`.

## Decision

```
PROVIDER_PRIMARY_CWD_REMOVED: YES
PROVIDER_SHARED_GIT_REMOVED: YES
PROVIDER_WORKSPACE_BOUNDARY: PARTIAL
IGNORED_PATH_PROTECTION: PARTIAL
PRODUCTION_WRITER_COMPOSITION: YES
HOST_GIT_FINGERPRINT_OPTIMIZED: YES
HUMAN_APPROVED_DELIVERY_DESIGN: YES
PROVIDER_CHANGE_PROPOSAL_IMPLEMENTATION: YES
PROVIDER_CHANGE_PROPOSAL_READINESS: NO
REAL_WRITER_MODE_READINESS: NO
O5_5B_READINESS: NO
O6_READINESS: NO
REAL_WRITER_LIVE_GATE_AUTHORIZED: NO
```
