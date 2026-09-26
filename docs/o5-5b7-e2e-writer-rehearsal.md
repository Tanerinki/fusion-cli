# O5.5B7 Offline end-to-end Writer rehearsal

Labels: **OBSERVED** (measured on this machine in this milestone), **MECHANICALLY ENFORCED** (code plus deterministic tests), **FAKE-PROVIDER PROVEN** (the real engine and ports ran end to end with deterministic fake providers), **LIVE-DOCKER PROVEN** (the same, on the accepted production Docker backend), **NOT YET PROVIDER-LIVE PROVEN** (no real provider has done it), **UNSUPPORTED** (refused, fail closed).

Outcome in one line: the workflow engine's Writer is now host-controlled end to end — a read-only Change Author proposes, Fusion validates, applies into a fresh private candidate, verifies it in the confined backend, and a fresh Reviewer plus Lead adjudication decide, with one bounded correction from the baseline. It is proven with deterministic fake providers (offline and on the accepted real Docker backend). No provider was called and no gate was opened.

## 1. Starting architecture

Branch `o5-5b7-e2e-writer-rehearsal`, HEAD `0292ee44c56fa37567f6116c7f93cbe5473a9fd6`, clean tree (verified before any change).

What existed: the O3/O4 engine (risk, routing, review, adjudication, bounded retries), `PrivateWriterWorkspace` (private clones, host `applyChangeSet`, `verifyConfined`), the Docker backend with zero host mounts and the npm lane (O5.5B6), `runChangeProposalTurn` on the real adapters, and an offline helper `app/change-author.ts`.

What was still direct-writer (OBSERVED in the code):
- the engine's Writer step was `writerTurn`: a provider session with **writer posture** editing a Git-worktree lease (`LeaseWorkspacePort`, shared common `.git`);
- the lease was verified by `EngineVerifierPort` — **host processes**;
- the Worker was routed with `ROLE_POSTURE.Worker = "writer"` plus `WRITER_ISOLATION` facts no real adapter has;
- the only host-controlled helper, `proposeApplyAndVerify`, verified with the **trusted-host** `PrivateWriterWorkspace.verify`;
- `fusion build` rejected Writer tasks in `app/commands.ts` before any adapter or engine (`REAL_WRITER_MODE_NOT_READY`); `buildCandidates` never builds a Worker.

## 2. Production Writer path, before and after

Before: `Lead → Worker(writer posture) edits a worktree lease → host verification of the lease → review on the lease → retry in the same lease`.

After (MECHANICALLY ENFORCED; FAKE-PROVIDER PROVEN; LIVE-DOCKER PROVEN for verification):

```
task ─▶ inspect + risk (monotonic) ─▶ writerChangeScope(packet)   exact canonical file scope, before any role runs
     ─▶ route: Lead, Worker(changeProposal ⇒ read-only), Reviewer/Lead(review isolation) when needed
     ─▶ Lead plan (packet turn)
     ─▶ per attempt ── release previous candidate ── acquire FRESH private candidate (baseline clone)
                    ── Change Author turn (read-only; candidate + primary fingerprinted around it)
                    ── validateChangeSet (structured clone, scope, SHA shape, limits, no-op) ─▶ proposalMalformed | proposalRejected
                    ── port.apply: SHA preflight (no mutation) ─▶ applicationRejected (retry) | host application + ledger
                    ── ledger == ChangeSet; observed changed paths == applied paths (else securityViolation)
                    ── port.verify ⇒ verifyConfined ⇒ VerificationService(autonomousWriter) ⇒ accepted confined backend
                          refusals: dependencyApprovalRequired | platformIncompatible | verifierUnavailable |
                                    dependencyLaneFailure | confinementNotAccepted   (classified, no retry, no review)
                    ── fail ⇒ risk↑, one retry in a fresh candidate
     ─▶ Lead review (medium) | fresh Reviewer + Lead adjudication (high, or medium touching verification inputs)
     ─▶ correction (≤1, fresh candidate, complete ChangeSet) | completed | decision | human gate
     ─▶ release candidate (proven gone, or never a success)
```

`LeaseWorkspacePort`, `writerTurn` and `app/change-author.ts` were deleted. `WorkspacePort` now describes private candidates (`acquire`, `apply`, `changedPaths`, `fingerprint`, `diff`, `verify`, `release`). `VerifierPort` verifies only the primary workspace (read-only tasks, repository review).

## 3. Writer delegate

The delegate is split along the core/platform boundary:
- **engine** (`core/workflow/engine.ts`, `writerAttempt`, `proposalTurn`, `applyToCandidate`, `verifyCandidate`, `releaseCandidate`): sessions, cancellation, provenance, risk, validation, classification, and every "unchanged" proof;
- **port** (`platform/workflow/candidates.ts`, `PrivateCandidateWorkspacePort`): candidate creation (`PrivateWriterWorkspace.open`), precondition preflight, host application, observation, diff, confined verification behind the acceptance gate, bounded release.

The provider never receives a writable posture, a candidate path, a shell or a network surface: the Worker is routed with `changeProposal: true` (read-only posture plus `CHANGE_PROPOSAL_REQUIREMENT`), and routing refuses the Change Author outright when the task asks for shell or network.

## 4. Change proposal contract

Unchanged wire contract (`ChangeSet` v1). Hardened: the engine derives the scope (`writerChangeScope`: canonical allowed files, forbidden entries unified and applied as exact or prefix denials; an ambiguous or empty write scope is `InvalidInput` before any role runs); `validateChangeSet` now structured-clones untrusted output first (a getter or proxy can never show one value to the checks and another to the applier) and refuses a rewrite with identical content as malformed. A refused proposal escalates risk (`unexpectedScope`, critical for sensitive paths; `proposalPathViolation`, critical, for non-canonical targets). A provider's envelope extras (rationale, transcript, usage, artifact refs) are ignored; the Worker has no status or decision channel — a delegate result is written by Fusion from what it applied.

## 5. Candidate lifecycle

Every attempt: fresh candidate (private remote-less clone of the committed HEAD in its own `fusion-writer-private-*` root) → exactly one ChangeSet → verification reconstructs yet another baseline clone plus the approved files → release (`close` with discard, then the root must be absent). One live candidate per run; the previous one is released before the next exists; an unproven release of a superseded candidate stops the run (`cleanupIncomplete`), and an unproven final release turns a success into `failed/cleanupIncomplete`. The engine refuses any handle that is not strictly inside the port's root, is the primary, lies inside it or contains it, belongs to another owner, or is claimed by another active run; a refused handle is never released through the port. MECHANICALLY ENFORCED; FAKE-PROVIDER PROVEN (reconstruction test: a deleted file returns, a failed attempt's content never survives); crash detection: a candidate whose owner process is gone is reported by `PrivateWriterWorkspace.findStale` (detection only).

## 6. Verification integration

`port.verify` → `PrivateWriterWorkspace.verifyConfined` → `VerificationService` (purpose `autonomousWriter`, trusted host refused, no fallback) → confined backend. Selection, platform and dependency failures are now typed `ClassifiedVerificationFailure`s (`backendUnavailable`, `platformIncompatible`, `dependencyLaneFailure`), mapped to classified workflow outcomes without message parsing. The acceptance gate: outside an explicit offline rehearsal, only a verification-isolation acceptance granted in this process opens verification, and the port verifies through **exactly the backend instance the acceptance was granted for** (the acceptance brand now records the instance; a separately supplied service is refused). A forged, copied, parsed or absent acceptance is `confinementNotAccepted` before any container exists. The offline rehearsal marker (`OFFLINE_REHEARSAL`, a module-private symbol) labels every verdict `acceptance: "offlineRehearsal"`, which no gate consumes. A host wall-clock timeout is a failed check (retried within the budget); an untrustworthy guest result (wrong nonce, contradictions) is `verifierFailure`.

## 7. Fresh review guarantee (MECHANICALLY ENFORCED; FAKE-PROVIDER PROVEN)

The Reviewer is a different adapter instance and a new session per cycle (session-ID reuse is refused), routed read-only with review isolation; its input is exactly `{kind, cycle, evidence, priorFindings, limits}` where evidence is the caller's task/acceptance criteria/invariants/scope, Fusion's verification result per command, and the **candidate's real diff**. Tests plant a Worker secret in every envelope side channel and a Lead-plan secret; neither appears in any review or adjudication request. A Reviewer cannot write: its output is only ever validated as a review report (a ChangeSet-shaped report is malformed and nothing is applied); a Reviewer that edits the real candidate on disk or the primary voids the run as `securityViolation` (critical).

## 8. Lead adjudication

Existing O4 semantics, unchanged: `CONFIRMED | PARTIAL | REJECTED | UNVERIFIABLE`, one verdict per finding, Fusion facts override a REJECTED/UNVERIFIABLE verdict where supported, contradicted facts are shown to the Lead. The Lead cannot redefine mechanical facts because none of them reaches it: failed verification, invalid ChangeSets, platform and dependency refusals and missing acceptance all end before review; risk is monotonic (a plan saying "risk: low" changes nothing).

## 9. Correction loop

One shared attempt budget (`1 + delegateRetries = 2` above low risk; 1 at low) and `REVIEW_CYCLE_LIMIT = 2`. A confirmed fixable finding yields exactly one correction: a complete ChangeSet against the baseline (`FRESH_CANDIDATE_CONSTRAINT`) in a fresh candidate, verified again and freshly re-reviewed with the prior findings. Proven bounds: a finding that never goes away costs exactly 2 proposals, 2 verifications, 2 reviews, 2 adjudications; a correction that fails verification is never reviewed.

## 10. Event and artifact trace

New closed EventStore types: `AgentTurnObserved` (plan/exploration/delegate/Lead review provenance), `ChangeProposalRecorded` (attempt, validated|malformed|rejected, operation count), `CandidateObserved` (created|applied|preconditionFailed|released, changed-path count, cleanup completeness), `CandidateVerificationObserved` (attempt, pass, commands run, refusal, backend id, confinement, platform, acceptance, dependency key/prepared/cache hit, per-command status and exit code). `StructuredTurnObserved` now also covers change proposals. Plus the existing transitions (with the new classified reasons), risk revisions, findings and adjudications. Never persisted: ChangeSet content, verifier output, paths of candidates, prompts, transcripts or credentials (asserted with canaries and a planted `sk-ant-…`-shaped secret in file content). `fusion build` records a content-free rehearsal summary in the outcome artifact.

## 11. Primary protection

| Class | Status |
| --- | --- |
| Writes by Fusion itself | PREVENTED: the applier accepts only its own `fusion-writer-private-*/candidate`; handles inside/around the primary are refused |
| Tracked and untracked primary changes during any turn, application or verification | DETECTED (Git fingerprint before/after, `securityViolation`, risk critical) |
| Git metadata, index, refs, config | DETECTED |
| Ignored files in the primary (e.g. `.env`) | NOT DETECTED by the product — a test pins this documented gap; the test-side full-walk evidence catches it |
| A provider process briefly mutating and restoring | NOT PREVENTED (no OS boundary for provider CLIs) |

Every full rehearsal compares a full-walk evidence (all files incl. ignored and `.git`, `git status --ignored`, HEAD) before and after: byte-identical in every deterministic and live run. Malicious targets (`.git/…`, absolute, drive, UNC, traversal, stream, device, `.fusion`, ignored and out-of-scope paths) never reach host application.

## 12. Failure semantics

| Stage | Outcome (state / reason) |
| --- | --- |
| Lead or Worker provider failure / timeout / cancel | failed `providerFailure` / failed `timedOut` / cancelled |
| Malformed proposal | failed `proposalMalformed` |
| Invalid ChangeSet (scope, path, limits) | failed `proposalRejected`, risk escalated |
| SHA precondition stale | retry `applicationRejected` in a fresh candidate; exhausted ⇒ decisionRequired `retryExhausted` |
| Host application / candidate integrity | failed `workspaceFailure` / `securityViolation` |
| Dependency change without approval | humanGateRequired `dependencyApprovalRequired` |
| Dependency lane (unsupported, refused, unprepared, invalid, npm failure) | failed `dependencyLaneFailure` |
| No confined backend | failed `verifierUnavailable` |
| Platform unknown / Windows-required / escalated | failed `platformIncompatible` |
| No acceptance (outside a rehearsal) | failed `confinementNotAccepted` |
| Verifier timeout / test failure | failed check, one retry; exhausted ⇒ decisionRequired `retryExhausted` |
| Untrustworthy verifier result | failed `verifierFailure` |
| Candidate cleanup incomplete | failed `cleanupIncomplete` (never success) |
| Reviewer failure / malformed finding / adjudication | failed `providerFailure` / `malformedResult` |
| Correction exhausted | decisionRequired or humanGateRequired `unresolvedFindings` |
| Critical risk | humanGateRequired `humanGateRequiredForRisk` |
| Verifier backend teardown incomplete | failed `securityViolation` (O5.5B6 contract) |

## 13. Dependency-heavy fixture

`test/fixtures/rehearsal-project.ts`: a TypeScript/Node "quotes" project — zod, semver, ms; typescript 5.9.3, @types/node, @types/semver, @types/ms (8 registry packages, no install scripts); four source files, four test files; plan `tsc -p tsconfig.json` (noEmit) then `node --test` over the TypeScript tests (type stripping in the pinned Node 22.20). The lockfile was generated once with npm 10.9.3 (`--package-lock-only --ignore-scripts`, registry-only, no npmrc) and is byte-identical to a fresh generation. Validated on a real install: baseline 10 tests / 1 real failure (tax on the undiscounted subtotal), the Worker's fix plus regression test 11/11, a plausible wrong fix 2 failures, type check clean throughout. The deterministic suites use an oracle validated against those real results; the live run executes the real tools. (`invoice` paths classify as billing-sensitive ⇒ HIGH, so the fixture domain is "quotes" to keep the representative task MEDIUM.)

## 14. Live Docker E2E (LIVE-DOCKER PROVEN; `FUSION_DOCKER_LIVE=1 npm run test:writer-live`)

Docker Desktop 4.50.0, engine 28.5.1 linux/amd64, kernel 6.6.87.2-microsoft-standard-WSL2, image `node@sha256:b21fe589…848e`. Executed twice (each execution runs the whole workflow twice): acceptance 45/45 facts (incl. `noHostMountsObserved`, `mountTableHostPathAbsentObserved`) from the production instance's own evidence; every verification by that instance (`acceptance: "granted"`); guest `v22.20.0` in every run; real `tsc` clean; real `node --test` 2 of 11 failing for the wrong fix, then 11 of 11; one dependency identity (`59f926c2…ab7c7`) prepared once per store then reused; fresh review; `completed`; 0 Fusion containers afterwards; primary evidence byte-identical; gates unchanged except `verificationIsolation: satisfiedForLinuxScope`.

## 15. Performance (OBSERVED, this Windows machine)

| Phase | Measured |
| --- | --- |
| Acceptance evidence (once per process) | 8.6–9.3 s |
| Candidate acquire (private clone + fingerprints) | 1.32–1.43 s |
| Host application | 1.42–2.07 s |
| Verify, dependency cache hit | 5.8–5.9 s total; Docker 3.30–3.47 s (create 0.19–0.20, attach 2.62–2.79 incl. input 0.45–0.48 and commands 1.71–1.80, inspect 0.09, remove 0.38–0.43); host reconstruction/fingerprints ≈ 2.5 s |
| Verify with fresh dependency preparation | 9.3–9.6 s (preparation ≈ 3.5–3.8 s: networked `npm ci` of 8 packages in its own container) |
| Release | 17–22 ms |
| Transfer | source 13 files / 8.6 KB; dependency artifact 449 entries, 6.26 MB gzip (≈ 27 MB installed); tmpfs 512→545 MiB |
| Fake review / adjudication | milliseconds (in-process), plus ≈ 0.3 s of fingerprints per turn |
| Two-attempt run with fresh review | 26.6–31.5 s live; single-attempt offline run ≈ 10.4 s |
| Correction cycle | ≈ one full attempt (≈ 13 s live) |
| Host Git work per offline attempt | 236 `git` process spawns ≈ 9.8 s of 10.4 s |
| Deterministic suite wall time | 103 s → ≈ 150 s (16 cores) |

Assessment: at this size dependency transfer is **not** the bottleneck (≈ 0.45 s for 6.3 MB gzip; at the observed ≈ 22 MiB/s attach rate a 300 MB compressed tree would add ≈ 14 s plus tmpfs memory). The dominant cost today is host-side Git fingerprinting and cloning (≈ 236 short `git` processes per attempt on Windows). Not optimized here (no premature optimization); it is the first thing to batch or cache.

## 16. Readiness impact

| Gate | State | Evidence kind | Remaining blocker |
| --- | --- | --- | --- |
| primaryProtection | partial | mechanical | detection only for provider processes; ignored primary files unfingerprinted |
| hostControlledApplication | satisfied | mechanical | route exercised with fake providers only |
| hostControlledWriterWorkflow (new) | partial | fakeProviderRehearsal | no real provider has produced a ChangeSet or review on this route |
| providerChangeProposal | blocked | none | no authorized real-provider proposal run; adapters bind cwd to the primary |
| verificationIsolation | satisfiedForLinuxScope with a granted acceptance, else notEvaluated | liveProcess | no Windows backend |
| platformCompatibility | satisfied | mechanical | undeclared tasks stay unknown |
| dependencySupport | partial | mechanical | restricted npm lane only |
| cleanupAndRecovery | satisfied | mechanical | sweep not scheduled |
| reviewAndAdjudication | satisfied | mechanical | — |
| billingAndAuthPosture | partial | mechanical | not evaluated for Worker bindings |
| sharedGitAndIgnoredPaths | partial | mechanical | provider processes without OS filesystem boundary |
| liveGateAuthorization | blocked | none | constant `false` |

`writerReadiness()` is still `REAL_WRITER_MODE_NOT_READY`; no input to `writerGateReport` can change the provider, Writer or live-gate rows. The `fusion build` rehearsal seam (`ControlPlaneDeps.writerRehearsal`) is test-only: the CLI entry point never sets it, and without it a Writer task still stops at `REAL_WRITER_MODE_NOT_READY`.

## 17. Remaining provider-live blockers (NOT YET PROVIDER-LIVE PROVEN)

1. Real adapters take their working directory from construction (the primary), so a real Change Author and Reviewer read the primary checkout, not the candidate: uncommitted primary edits make SHA preconditions stale, and ignored primary files are readable. Needs candidate-bound read-only sessions (or a clean-primary precondition).
2. No authorized real-provider change-proposal run: the read-only Change Author posture is proven only by capability facts and fakes.
3. Provider CLIs still run on the host without an OS filesystem boundary (primary protection is detection, with the ignored-file gap).
4. No production composition wires Worker candidates, the candidate port and an in-process acceptance into `fusion build`.
5. No human-approved integration step applies an approved ChangeSet to the primary (the result is kept in memory; the candidate is discarded).
6. Billing/auth posture is not evaluated for Worker bindings; Windows-required tasks are unsupported.

## 18. Recommendation

Next milestone (still no live Writer gate): **O5.5B8 — candidate-bound read-only provider sessions and production composition.** Bind every read-only real adapter session (Change Author, Reviewer, adjudicating Lead) to the candidate it serves instead of the primary; wire `fusion build` to a production composition (Worker candidates from the registry behind a still-closed live gate, the candidate port with an in-process acceptance obtained at start-up); batch or cache host-side Git fingerprinting (the measured bottleneck); design the human-approved integration of an approved ChangeSet. Only after that, and with explicit authorization, run one bounded real-provider change-proposal probe on the rehearsal fixture to produce the first provider-live evidence.

## Decision

```
OFFLINE_E2E_WRITER_REHEARSAL: PASS
HOST_CONTROLLED_WRITER_WORKFLOW: YES
CONFINED_VERIFICATION_INTEGRATED: YES
FRESH_REVIEW_INTEGRATED: YES
LEAD_ADJUDICATION_INTEGRATED: YES
BOUNDED_CORRECTION_LOOP: YES
PRIMARY_WORKSPACE_UNCHANGED: YES
PROVIDER_CHANGE_PROPOSAL_READINESS: NO
REAL_WRITER_MODE_READINESS: NO
O5_5B_READINESS: NO
O6_READINESS: NO
REAL_WRITER_LIVE_GATE_AUTHORIZED: NO
```
