# O5.5B12 — Full-route live rehearsal hardening

Labels: **MECHANICALLY ENFORCED** (code plus deterministic tests), **FAKE-PROCESS PROVEN** (the real adapter code of every role ran against deterministic fake native binaries, with the real engine, candidate port, views and Docker backend over the in-memory daemon), **LIVE-OBSERVED** (recorded from a real provider in an earlier milestone), **NOT RUN**, **NOT PROVEN**.

Outcome in one line: the complete production Writer route can now be rehearsed with real providers under a mechanically bounded plan. That plan is a **pending** route authorization, `O5.5B12-LIVE`. It freezes, per role, the provider family, executable, runtime version, lane and exact binding, and per turn class a maximum count equal to the engine's own bounds.
- A **turn gate** admits a model turn only in the engine state that requires it.
- A **pre-launch guard** checks every process of every role before it starts.
- **Bounded evidence** is kept per role turn.

It is proven offline against fake processes (23 new deterministic tests). **No provider was called.** The plan cannot run until a later milestone opens it after explicit human approval. No readiness gate moved except a new implementation row, and the live Writer gate stays closed.

## 1. Starting architecture

Branch `o5-5b12-full-route-live-rehearsal`, HEAD `6baa936` (O5.5B11), clean tree, verified before any change. Already in place:
- **Engine:** the host-controlled Writer route (O5.5B7), Fusion-owned provider views and the production composition (O5.5B8).
- **Live proposals:** passing live change proposals for both Change Author families (O5.5B9 Muse, O5.5B11 Claude).
- **Refusals and guards:** the single-turn proposal probe's authorizations, namespaces and pre-launch guard (O5.5B11).
- **Not yet run live:** real Lead planning, a real fresh Reviewer, real adjudication and the bounded correction.

## 2. The exact production route (discovered in the code, not invented)

`WorkflowEngine.flow` for a Writer task:

```
inspect + risk (monotonic)  ─▶  writerChangeScope(packet)
route: Lead (read-only), Worker (changeProposal ⇒ read-only), and — when reviewMode(level, writes, signals) = "fresh" —
       Reviewer + adjudicating Lead (structured turns, review isolation, view binding), all before any turn runs
planning      Lead packet turn (runTurn) in the BASELINE view
per attempt   release previous candidate ▸ acquire FRESH private candidate ▸ Change Author (runChangeProposalTurn) in the
              BASELINE view with Fusion's SHA-256 baseline ▸ validateChangeSet ▸ host application ▸ observed == applied ▸
              confined verification (VerificationService, accepted backend) ▸ fail ⇒ risk↑ and retry in a fresh candidate
review        "none" (low) | "lead" (MEDIUM: Lead packet review) | "fresh" (HIGH, or MEDIUM touching files the plan runs):
              fresh Reviewer (runStructuredTurn "review") in a CANDIDATE COPY view ▸ if findings: Lead adjudication
              (runStructuredTurn "adjudication") in the same candidate-copy view ▸ Fusion facts override ▸ reviewOutcome
correction    only for outstanding, fixable, CONFIRMED/PARTIAL material findings, with an attempt left: one complete
              ChangeSet against the baseline in a fresh candidate, verified again, freshly re-reviewed with the prior findings
bounds        attempts: 1 + WORKFLOW_LIMITS.delegateRetries = 2 (shared by retries and the correction; 1 at LOW);
              review cycles: REVIEW_CYCLE_LIMIT = 2; adjudication only when a review reported findings
terminal      completed only with a passing verification of the final attempt; else classified failure / decision / human gate
```

- **Events:** transitions, risk revisions, `turn` and `structuredTurn` provenance (with session IDs), proposal outcomes, candidate and view lifecycle, verification summaries, findings and adjudications.
- **Never persisted:** ChangeSet content, prompts or transcripts.
- **What blocked a live run until now:** no bounded authorization for more than one model turn, no guard covering every role, and no route-level evidence. The production composition itself already composes every role.

## 3. Role bindings (frozen)

The route needs the **fresh** review mode, which the existing policy applies at HIGH risk, or at MEDIUM when a Writer changes files its own verification plan runs. The fixture task (§13) is MEDIUM and edits `test/quote.test.ts`, which the plan runs, so `reviewMode` returns `fresh`. This is tested, and the policy was not forced.

The role → adapter-kind mapping is the production policy's (`DEFAULT_CONFIG`: Lead = one-shot CLI, Reviewer = exec CLI). The Change Author is the live-proven one-shot profile, so the author's work is reviewed by the other family. Every role uses a runtime version validated and live-observed on this machine.

## 4. Per-role provider, profile, version and model

| Role (turn classes) | Family / transport | Runtime | Model (identity readback) | Effort / turns | View | Tools / posture | Lane | Max live turns |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Lead (plan, adjudication) | Claude / `claude-one-shot`, `claude.exe` | 2.1.280 (pinned via `FUSION_CLAUDE_EXE`) | `haiku` → `claude-haiku-4-5-20251001` | low / `--max-turns 6` | baseline (plan), candidate copy (adjudication) | Read, Grep, Glob; `--restricted --safe-mode --strict-mcp-config --disable-slash-commands`, `dontAsk`, prompts none, plugin quarantine | subscription / subscriptionToken | plan 1 + adjudication 2 |
| Worker (Change Author) | Claude / `claude-one-shot`, `claude.exe` | 2.1.280 | `haiku` → `claude-haiku-4-5-20251001` (live PASS O5.5B11) | low / `--max-turns 6` | baseline | same | same | 2 |
| Reviewer (fresh review) | Muse / `muse-exec`, `muse-bin-1.3.0-R3401.1.exe` | 1.3.0-R3401.1 | `muse-spark-1.3` (`run.model.configured` readback) | low / 4 model steps, `malformedOutputRetries 0` | candidate copy | `--disable-write --disable-shell --disable-web-tools`, approvals off, no foreign personal context, strict `--output-schema` | subscription (account attested before/after) | 2 |

Why haiku/low for the Lead rather than the production default (opus/high):
- `claude-haiku-4-5-20251001` is the only Claude identity live-observed on 2.1.280.
- It keeps the paid budget smallest.

The human may choose opus/high in the authorization (§27); that choice would be the first observation of the opus identity. Claude 2.1.281 is not used.

## 5. Full-route authorization model

`RouteAuthorization` (provider-layer data in `providers/probe-profiles.ts`; types and logic in `app/route-probe.ts`, provider-neutral):
- **`state`:** `pending | open | consumed`.
  - `pending` refuses before anything exists: it is a plan for review, not a grant.
  - `consumed` refuses the same way, so a lost claim can never reopen it.
- **`roles[Lead|Worker|Reviewer]`:** family, executable basename, exact runtime versions, lanes, exact binding (adapter, model, effort, turn limit, listed options including timeouts and the retry option) and required environment keys. No wildcards (tested).
- **`turns`:** `{ leadPlan: 1, changeAuthor: 2, freshReview: 2, leadAdjudication: 2 }`, exactly the engine's bounds (tested against `WORKFLOW_LIMITS` and `REVIEW_CYCLE_LIMIT`). Explorer and Lead-review turns have no budget.
- **Refusals before anything exists:** an unknown, pending or consumed token (exact match), a family without a probe profile, a nested agent session, a foreign evidence namespace (the O5.5B9/B11 shapes included), or a replay (the route claim exists).
- **One-shot claim:** `route.claim.json` is written after preflight and composition, before the engine runs; from then on the authorization is consumed.
- **Per-turn ledger:** `route.turns.jsonl` gets one line per consumed slot, appended durably **before** the provider is reached.
- **Turn gate** (`RouteTurnGate`), wrapping each role's adapter:

| Turn | Admitted only when the engine's last transition is | Slot |
| --- | --- | --- |
| `leadPlan` | `→ planning : planRequested`, role Lead, `runTurn` | used + 1 |
| `changeAuthor` | `→ delegating : delegated` with `attempt` = slot, role Worker, `runChangeProposalTurn`; slot 2 additionally needs the latest `→ retrying` to be `reviewFindingsConfirmed`, `verificationFailed` or `applicationRejected` | used + 1 |
| `freshReview` | `→ reviewing : freshReviewRequested` with `attempt` = request cycle, role Reviewer, `runStructuredTurn(kind review)` | cycle |
| `leadAdjudication` | `→ adjudicating : adjudicationRequested` with `attempt` = request cycle, role Lead, `runStructuredTurn(kind adjudication)` | cycle |

  - Slots must be in order and within budget.
  - Any other role/method/state combination is refused, for example a Lead review, an Explorer, or a Reviewer adjudicating.
  - A refused call never reaches the adapter.
  - A failed or malformed turn has consumed its slot.
  - The gate reads only the engine's own transitions, which are recorded before each turn; it never reads provider output.
- **Not the live gate:** `REAL_WRITER_LIVE_GATE_AUTHORIZED` is untouched and stays `false`.

## 6. Model-turn budget

| Path | Model turns | Roles/providers | Non-model processes | Docker verifications |
| --- | --- | --- | --- | --- |
| Straight-through, clean review | **3** | Lead plan (Claude), Change Author (Claude), Reviewer (Muse) | 11 (Claude turn: 2 auth readbacks, 1 plugin inventory, 2 init-only startups; Muse turn: 1 account-attestation host) | 1 (+ one networked dependency preparation) |
| Straight-through, findings rejected | 4 | + Lead adjudication | 16 | 1 |
| One correction that succeeds | 6 | plan, author ×2, review ×2, adjudication ×1 | 22 | 2 |
| Maximum (finding persists) | **7** | plan, author ×2, review ×2, adjudication ×2 | 27 | 2 |

The counts are asserted in the tests for the straight-through path (`providerAuthReadback 4, providerInventory 2, providerInitProbe 4, providerTurn 3, providerHost 1`).
- **Init-only startups:** these `claude -p` processes are cancelled at initialization. Whether they began an upstream request is **NOT PROVEN** either way (unchanged since O5.5B9).
- **Wall time (estimate, not authorized):** each live single-turn probe took 38.6–46.9 s end to end, including ≈ 9 s of acceptance evidence and ≈ 3 s of Docker per verification (O5.5B9/B11). O5.5B7 measured the quotes fixture's first verification at 9.3–9.6 s including dependency preparation. Expect ≈ 2–4 min straight-through and ≈ 5–8 min on the maximum path.
- **Upper bound:** per-turn timeout 180 s × 7 turns, well inside the 45-min run deadline.
- **Offline equivalents:** 8.3 s, 10.9 s, 16.6 s and 17.9 s.

## 7. Lead contract

- **Planning:** a read-only packet turn in the baseline view (the committed HEAD as plain files: no `.git`, no ignored or provider state files). The primary is never the working directory (refused by the adapter and by the guard). It gets no write, shell or web tool and no MCP, plugins, hooks or personal context.
- **Plan input:** the delegation packet — task, acceptance criteria, scope, architecture decisions and invariants. The route's MEDIUM risk and verification-referenced signal are Fusion's. The Lead's output is a `ResultPacket` that the engine forwards to the Change Author only.
- **Plan authority:** none over routing, models, budgets, risk (monotonic), platform or dependencies. Tested: a plan that names another provider, `opus`, maximum effort, five Change Author calls, "skip review" and "risk: low" changes nothing. The run passes with 3 turns at MEDIUM risk, and the turn argv comes only from the frozen binding.
- **Failures:** a malformed plan (`MALFORMED_OUTPUT` at `leadPlan #1`), a failed plan (`PROVIDER_FAILED`) and a timed-out plan (`TIMEOUT`) each consume the slot and end the run. There is no retry and no fallback provider or model; a wrong effective model is `MODEL_BLOCKED`.

## 8. Change Author contract

Unchanged from the live-proven path:
- Read-only `changeProposal` posture in the baseline view, with Fusion's SHA-256 baseline in the prompt.
- One ChangeSet (the O5.5B10 envelope; raw or one clean fence).
- Unchanged `validateChangeSet` and host application into a fresh private candidate; observed paths must equal applied paths.
- Confined verification in the accepted backend.
- The provider never receives the candidate.

The second slot opens only in the engine's retry or correction state (§5). The model has no retry channel of its own: the Claude transport has none, and a second model process in one turn is refused by the guard.

## 9. Fresh Reviewer freshness

- **Session:** a separate adapter instance (the Exec family) and a new session per cycle; session-ID reuse is refused by the engine. The re-review after a correction is a new session (tested: IDs differ).
- **Workspace:** the candidate-copy view, never the candidate or the primary.
- **Capabilities:** no write, shell or web tool (argv controls read back and checked by the guard per model process). The strict output schema is the only output channel, and a malformed report consumes the slot (`malformedOutputRetries 0`; a plan that allowed the exec's internal retry is refused at its second process — tested).
- **Isolation from the rest of the run:** the Reviewer cannot change deterministic facts (verification and ChangeSet validity end before review). Any write into its view is `VIEW_MUTATED` before adjudication (tested with a Reviewer that writes into its view).

## 10. Reviewer context

Exactly the engine's `reviewEvidence`:
- the task goal, constraints and acceptance criteria;
- architecture decisions and invariants;
- scope;
- Fusion's verification result per command;
- the candidate's real diff (bounded).

For a correction re-review, the prior outstanding findings are added. The following never reach the Reviewer: the Worker's transcript and any envelope side channel, the Lead's plan reasoning, and prompts of other roles.

Tested with real prompts logged by the fake binaries: a planted `LEAD-PLAN-HIDDEN-REASONING` marker (in the plan) and a `WORKER-HIDDEN-RATIONALE` marker (in the Change Author's transcript) never appear in any Reviewer or adjudication prompt. The fake fails the turn if they do, and the logged prompts are searched as well. The Change Author does receive the Lead's plan, by design.

## 11. Lead adjudication contract

- **Setting:** a fresh Lead session in the candidate-copy view.
- **Input:** the same review evidence, the findings (claims only) and Fusion's facts.
- **No plan context:** it does not see its own plan's reasoning (tested).
- **Contract:** the existing O4 one (`CONFIRMED | PARTIAL | REJECTED | UNVERIFIABLE` with legal actions), one slot per review cycle, and no retry.
- **Mechanical facts it can never change:**
  - verifier failure, invalid ChangeSet, platform, dependency and confinement refusals, and cleanup failure all end the run before review;
  - primary and view mutation end it immediately, and the Lead is never asked (tested);
  - risk only rises.

## 12. Correction policy

- **Trigger:** the existing `reviewOutcome` requires the correction (outstanding, fixable, confirmed/partial material findings, attempt left).
- **Slot:** it consumes `changeAuthor #2`, which the gate opens only from `retrying:reviewFindingsConfirmed`, or the engine's mechanical retries.
- **Context:** the correction receives only the approved finding (tested) and proposes a complete ChangeSet against the baseline.
- **Fresh candidate:** the failed candidate is released first and never reused. The correction applies against baseline SHA-256 preconditions, so a contaminated candidate would be refused.
- **After the correction:** confined verification runs again, then a fresh review.
- **Exhaustion:** the budget (2 attempts, 2 review cycles) ends the run as `VERIFICATION_FAILED` or `FINDINGS_UNRESOLVED`. There is never a human-unapproved extra turn.

Scenarios A–H are tested (§21).

## 13. Fixture

The O5.5B7 "quotes" project, moved to `src/app/route-fixture.ts` so the harness digest covers it; it is byte-identical to the committed test fixture (verified).
- **Project:** TypeScript/Node with zod, semver and ms; TypeScript 5.9.3 and three `@types` packages; a committed lockfile of 8 registry packages without install scripts (restricted npm lane).
- **Files:** four source and four test files.
- **Bug:** the committed baseline taxes the undiscounted subtotal.
- **Task:** fix it and add a full-discount regression test. Allowed: `src/quote.ts`, `test/quote.test.ts`; forbidden: `package.json`, `package-lock.json`.
- **Plan:** `tsc -p tsconfig.json` then `node --test` over the four test files, in the pinned Linux image.
- **Canaries:** ignored synthetic `.env` and `secrets.local` in the primary.
- **Throw-away location:** it lives under `%TEMP%\fusion-o5-5b12-route`, never this repository or a user project.
- **Expected outcome:** the baseline fails 1 of 10 tests; the correct fix with the regression test passes 11 of 11; a plausible wrong fix fails 2 of 11. These are validated against a real install (O5.5B7).
- **Honesty rule:** the live run is not rigged to need a correction. If the first ChangeSet is correct, no correction happens.

Network: the dependency preparation stage runs `npm ci` from the registry in its own container. Verification itself has network `none`, zero host mounts and no provider credentials.

## 14. Provider workspaces per role

| Role | View | Checked before each model process |
| --- | --- | --- |
| Lead (plan) | baseline | view kind `baseline`, owned location, disjoint from the primary, no `.git`, no provider state |
| Change Author | baseline | same |
| Reviewer | candidate copy | view kind `candidate`, same checks |
| Lead (adjudication) | candidate copy | same |

Non-model processes (auth, inventory, init-only) must run in some checked view. The exec attestation host is the exception: it runs in an empty Fusion-owned temporary directory.

## 15. Process guard (all roles)

Every provider process is checked **before** it starts; a refused one never runs, and its launch settles as `refused`. It must:
- be started from an executable named by a role grant (no provider substitution);
- run in a checked Fusion-owned view (the host exception above);
- have no argument naming the primary;
- carry no forbidden variable (API keys, gateway and override variables, by name);
- for a model turn:
  - start inside an authorized, active role turn;
  - be at most one model process per turn (no hidden retry);
  - use the role's own executable;
  - run in the turn class's view kind;
  - carry the family's read-only controls and no widening flag.

Static per-role preflight, with no process, comes first:
- the binding equals the grant (`MODEL_BLOCKED`);
- the pinned-runtime variable is present (`VERSION_BLOCKED`);
- the executable exists;
- BillingGuard is clear and the lane is granted (`AUTH_BLOCKED`);
- the version is validated and granted (`VERSION_BLOCKED`);
- review or change-proposal eligibility holds (`POSTURE_BLOCKED`).

A preflight block consumes nothing. The runtime readbacks (version, effective model, credential source, tools) stay authoritative inside each turn.

## 16. Primary and view integrity

The engine holds the primary to its first fingerprint around every provider turn, application and verification. That fingerprint covers Git state, tracked and untracked files, and bounded ignored-path monitoring including `.env` and protected paths.
- **Views:** every view is fingerprinted before and after every turn in it.
- **Candidate:** it is fingerprinted around application, verification and review.
- **Harness walk:** the harness additionally walks the whole primary (including `.git` and ignored files) before and after.

On any change the run stops at once as a security violation (`PRIMARY_MUTATED` or `VIEW_MUTATED`), and no later role runs. Tested: a Lead turn that appends to the primary's ignored `.env` stops after `leadPlan #1`; a Reviewer that writes into its view stops before adjudication.

## 17. Evidence format (`route.evidence.json`, schema 1, `kind: fullRouteRehearsal`)

- **Header:**
  - milestone, `evidenceKind` (`liveProvider` | `offlineRehearsal`), `startedAt`;
  - the authorization (id, turn budget, role grants);
  - public bindings (executable paths filtered);
  - harness identity (compiled-source digest plus `route-rehearsal.js`), node and platform, gate constants.
- **Per role turn:**
  - turn class, slot, role, family;
  - bound provider/transport, requested model, observed model, effort;
  - session ID and view kinds;
  - process counts by purpose, model process count;
  - outcome and error kind;
  - structure-only output diagnostic (one-shot family), duration;
  - `claimConsumed`.
- **Route:**
  - `preflight` per role and `acceptance`;
  - risk level and signal codes, whether fresh review ran, correction count, retry reasons, delegate attempts;
  - turn budget and use;
  - gate and launch refusals;
  - launches (purpose, turn, executable basename, redacted argv, cwd class, env-key count, forbidden keys, posture, settlement);
  - launch counts, per-role runtime readbacks (labels only).
- **Work:**
  - proposal outcomes, candidate counts and changed paths;
  - verification per attempt (backend, confinement, platform, runtime, per-step test counts, acceptance label);
  - review cycles, findings (ID, severity, category), adjudications (finding ID, verdict, action).
- **Integrity and end state:** views, primary before/after (digest, canaries, HEAD), workflow state and transitions, cleanup, gates after.

Never persisted: replies, prompts, transcripts, hidden reasoning, credentials, environment values, canary values, candidate or view paths (only redacted temporary prefixes), or file content. Tested with secret markers, canaries, fence text and prompt prefixes.

## 18. Failure semantics

| Where | Classification |
| --- | --- |
| Preflight (any role): binding / pin / executable / lane / version / posture | `MODEL_BLOCKED` / `VERSION_BLOCKED` / `PROVIDER_FAILED` / `AUTH_BLOCKED` / `VERSION_BLOCKED` / `POSTURE_BLOCKED` (nothing consumed) |
| A turn outside its state, order or budget | `TURN_REFUSED` (never reaches the provider) |
| A process refused by the guard | its outcome (`POSTURE_BLOCKED`, `AUTH_BLOCKED`, `TURN_REFUSED`) |
| Lead / Change Author / Reviewer / adjudicator malformed | `MALFORMED_OUTPUT`, naming the turn |
| Provider failure / timeout at any role | `PROVIDER_FAILED` / `TIMEOUT`, naming the turn |
| Wrong effective model or provider | `MODEL_BLOCKED` |
| Invalid ChangeSet / stale preconditions | `INVALID_CHANGESET` |
| Host application failure | `APPLICATION_FAILED` |
| Verifier unavailable, platform, dependency, confinement refusal, failed tests (budget exhausted) | `VERIFICATION_FAILED` |
| Outstanding findings after the bounded cycles, or unverifiable HIGH findings | `FINDINGS_UNRESOLVED` |
| Lead asks for a decision / risk exceeds the flow / critical risk | `DECISION_REQUIRED` |
| Completed without the Lead plan and a fresh review | `ROUTE_MISMATCH` |
| Primary or view mutation | `PRIMARY_MUTATED` / `VIEW_MUTATED` (checked first) |
| Candidate, view, container or temp cleanup incomplete | `CLEANUP_FAILED` (never `PASS`) |
| Cancellation | `CANCELLED` |

There is no generic success fallback and no automatic provider substitution. `PASS` requires all of:
- completed with a passing verification of the final attempt;
- every verification covered by a granted acceptance (or labelled rehearsal);
- a completed Lead plan and fresh review;
- no refusal;
- unchanged primary and views;
- complete cleanup.

## 19. Cancellation

The live entry wires Ctrl+C to the run's signal. A cancelled turn is killed at the adapter within a bound. Tested at the fresh review: `CANCELLED`, the candidate and both views released, no later turn. Earlier milestones prove the same at the Change Author turn and inside verification (O5.5B7/B8).

## 20. Cleanup

Candidates are released before the next exists and at the end, and every view is released. The harness proves every attributed temporary directory is gone and counts Fusion containers before and after. An unproven release is never a success. Tested: an injected failed release of the superseded candidate stops the route (`CLEANUP_FAILED`) before any correction turn.

## 21. Deterministic test matrix (all offline; no provider)

New: 23 tests in 6 files (split so the route runs execute in parallel). No existing test was modified. The fixtures were refactored: the quotes project moved into `src/app/route-fixture.ts` (byte-identical, re-exported) and both fake binaries gained a scripted multi-turn mode. The engine, view and probe tests pass unchanged.

| File | Tests | Covers |
| --- | --- | --- |
| `o5-5b12-route-authorization.test.ts` | 9 | Frozen plan data (pending, exact grants, cross-family, budget = engine bounds, no wildcards); fixture takes the fresh route under the existing policy; refusals (pending, unknown, proposal token, consumed, unknown family, nested session, foreign/O5.5B9/B11 namespaces, replay); live entry refuses the pending plan; gate: state/role/method/order/budget, second-attempt reasons (3 allowed, others refused, never a third), a failed turn consumes a durable slot and no retry reaches the provider; per-role preflight (model, effort, turns, canonical model, retry option, API keys, lane, pin, version); readiness |
| `o5-5b12-route-rehearsal.test.ts` | 3 | A straight-through (3 turns, per-turn views and sessions, posture per model process, process counts, freshness canaries, diff to Reviewer, ledger, redaction, not live evidence); B finding rejected (1 adjudication, fresh session, no plan reasoning); C one correction (fresh candidate, re-review in a new session, correction sees only the finding) |
| `o5-5b12-route-failures.test.ts` | 2 | D correction fails verification; E finding persists (full 7-turn budget, then a decision) |
| `o5-5b12-route-budget.test.ts` | 3 | F malformed correction; G correction timeout; H correction or re-review beyond the budget refused before the provider; cleanup failure between attempts |
| `o5-5b12-route-role-failures.test.ts` | 2 | Malformed output at every role; provider failure or timeout at every role |
| `o5-5b12-route-red-team.test.ts` | 4 | Cancellation during review; wrong effective model; Reviewer self-retry refused; Reviewer writes its view; Lead touches the primary's `.env`; a steering Lead plan; an UNVERIFIABLE HIGH finding is never auto-fixed |

Engine-level properties already covered (O5.5B7/B8, unchanged, still passing):
- Lead cannot waive failed verification or lower risk;
- a Reviewer cannot write;
- candidate reconstruction never leaks a failed attempt;
- dependency, platform and confinement refusals;
- fake providers cannot fabricate acceptance;
- cancellation inside verification;
- every view released after failures.

## 22. Security red-team findings

| # | Attack | Result |
| --- | --- | --- |
| 1 | Lead requests another provider/model | No effect: bindings come only from the frozen grants; argv checked (tested) |
| 2 | Lead adds extra Worker calls | No effect: the engine decides; the gate caps `changeAuthor` at 2 (tested) |
| 3 | Worker triggers its own retry | No channel (no transport retry); a second model process per turn is refused (tested via the exec family) |
| 4 | Reviewer requests shell/write/web | Not grantable: argv controls checked per model process; no tool of that kind in the readback |
| 5 | Reviewer writes its view | `VIEW_MUTATED`, stops before adjudication (tested) |
| 6 | Adjudicator overrides failed verification | Unreachable: failures end before review (O5.5B7 test; route D) |
| 7 | Adjudicator lowers risk | Risk is monotonic (tested) |
| 8 | Correction without a confirmed actionable finding | Refused by the gate unless the engine's retry state requires it (tested) |
| 9 | Correction after budget exhaustion | Refused (tested; the engine never asks) |
| 10 | Provider uses the primary path | Refused by adapter and guard; evidence records none (O5.5B8 plus guard) |
| 11 | Shared `.git` | A view holding `.git` is refused before any process (O5.5B11 guard, reused) |
| 12 | Hidden environment widens auth/routing | BillingGuard blocks API/gateway variables at preflight; forbidden names refused per process; bindings are not read from the environment beyond the pinned executable, whose version is checked |
| 13 | Fake live evidence injected | Rehearsals are labelled `offlineRehearsal`; no gate reads route evidence; `writerGateReport` ignores inputs (tested) |
| 14 | O5.5B9/B11 claims reused | Different token kinds and namespaces; refused (tested) |
| 15 | Route token replayed | `alreadyAttempted`; consumed state refuses before anything (tested) |
| 16 | Cancellation between turns | `CANCELLED`, full cleanup (tested) |
| 17 | Cleanup failure between turns | `CLEANUP_FAILED`, no further turn (tested) |
| 18 | Primary's ignored sensitive canary changed | `PRIMARY_MUTATED` at once (tested) |
| 19 | Candidate contamination between attempts | Fresh baseline candidate per attempt; baseline preconditions (route C; O5.5B7 reconstruction) |
| 20 | Reviewer receives Worker hidden marker | Never (tested with real prompts) |

No BLOCKER/HIGH finding remains open. Residual (documented, not new): provider CLIs have no OS filesystem boundary; init-only startups may reach the network.

## 23. Readiness gate table

| Gate | Current state (evidence) | O5.5B12 implementation proves | A future live run could prove | Still unproven after it |
| --- | --- | --- | --- | --- |
| primaryProtection | partial (mechanical) | Integrity checked around every turn of every role; guard refuses primary paths per process | That real Lead/Reviewer turns leave the primary unchanged on one fixture | Prevention (no OS boundary); transient mutate-and-restore of unhashed content |
| providerWorkspaceBoundary | partial (fakeProcess) | Every process of every role in its checked view kind; view mutation stops the run | That real CLIs of all roles honour the views in one run | OS isolation |
| ignoredPathProtection | partial (mechanical) | `.env` canary mutation detected mid-route | Unchanged canaries across a real multi-turn run | Managed-directory contents; non-sensitive ignored files by metadata only |
| hostControlledWriterWorkflow | partial (fakeProviderRehearsal) | The full route with the real adapter code of every role (fake processes) | **The full route with real providers, once** | Stability across samples and fixtures; HIGH-risk and Windows tasks |
| fullRouteRehearsalImplementation (new) | **satisfied (fakeProcess)** | This harness | — | Says nothing about real behaviour |
| providerChangeProposal | satisfied (recordedLiveProbe) | — | A second sample per family (in a multi-file task) | Other versions, models, efforts |
| verificationIsolation | notEvaluated statically; satisfiedForLinuxScope per process | — | Another granted acceptance plus two confined runs with the npm lane | Windows-required verification |
| dependencySupport | partial (mechanical) | — | A live restricted-lane preparation within a provider route | Other package managers, install scripts |
| cleanupAndRecovery | satisfied (mechanical) | Cleanup failures between turns never succeed | Complete cleanup after a real multi-role run | Scheduled sweeps |
| reviewAndAdjudication | satisfied (mechanical) | Fresh sessions, context isolation, bounded cycles through real adapter code | Real Reviewer findings and real adjudication, once | Review quality; independence beyond session freshness |
| billingAndAuthPosture | satisfied (mechanical) | Per-role lane grants and preflight | Live auth readback for the Lead and Reviewer roles | Other lanes |
| sharedGitAndIgnoredPaths | partial (mechanical) | Views without `.git` for every role (guarded) | — | OS boundary |
| liveGateAuthorization | blocked | Unchanged; the rehearsal is not the live gate | — | Everything the live gate would require |

REAL_WRITER_MODE_READINESS: **NO** (six partial rows, the live gate blocked). O5_5B_READINESS: **NO**. O6_READINESS: **NO**. REAL_WRITER_LIVE_GATE_AUTHORIZED: **NO**.

## 24. Repeat-sample policy (recommendation; not implemented, not executed)

- **One PASS = capability observed**, for exactly (family, transport, runtime version, model, effort). This is what exists today, and it is bound to version, model and effort (O5.5B11). It is not "stable".
- **Operationally stable** (proportional): at least 3 passing samples, on at least 2 fixture classes (single-file; multi-file with dependencies), with no unexplained fail-closed refusal of the provider's own output in the most recent 3. Refusals keep safety intact either way; they affect usability, so they gate "stable", never safety.
- **Runtime version change, including patch level:** the existing version gate already blocks an unvalidated version entirely. After a new version's posture is validated (its own milestone), prior evidence may carry over only as "observed on predecessor" until one new sample passes on it.
- **Model or effort change:** invalidates (already enforced for the doctor view).
- **Auth-lane change** between subscription lanes: does not invalidate capability evidence (the lane governs billing, not output). The lane is read back every turn anyway, and an API lane is always blocked.
- **Full route:** the first live PASS proves "route observed once". Treat the route as rehearsal-stable only after 2 passes including one with a correction, which is impossible to force honestly, so it accrues over time.

## 25. OS filesystem-boundary limitation

Provider CLIs of every role still run as normal host-user processes. A view is a working directory and a set of checks, not an OS sandbox: a provider process could open absolute host paths. Fusion **detects** changes to the primary (including monitored ignored paths) and to views, and refuses any process started outside the plan. It does not **prevent** reads, or a transient mutate-and-restore of content it does not hash. Nothing in O5.5B12 claims otherwise.

## 26. Proposed live command — **DO NOT RUN — HUMAN AUTHORIZATION REQUIRED**

Refused today (`authorizationPending`). Proposed for the milestone that opens it, from a new, normal PowerShell window:

```powershell
# DO NOT RUN — HUMAN AUTHORIZATION REQUIRED (O5.5B12-LIVE is pending; this is refused until a later milestone opens it)
Set-Location "D:\apps backup\fusion-cli"
git branch --show-current; git status --short
Get-ChildItem Env: | Where-Object { $_.Name -match '^(ANTHROPIC_|CLAUDE|FUSION_|MUSE_|META_|MODEL_API)' } | Select-Object -ExpandProperty Name
npm run build
$env:FUSION_CLAUDE_EXE = Join-Path $env:TEMP 'fusion-o5-5b9-claude-2.1.280\node_modules\@anthropic-ai\claude-code\bin\claude.exe'
$env:DISABLE_AUTOUPDATER = '1'
& $env:FUSION_CLAUDE_EXE --version          # must print exactly: 2.1.280 (Claude Code)
Get-Content (Join-Path $env:LOCALAPPDATA 'Programs\muse\.muse-version')   # must print exactly: 1.3.0-R3401.1
docker version --format '{{.Server.Os}}'      # must print: linux
node dist/test/live/route-rehearsal.js --authorization O5.5B12-LIVE     # ONE run; never re-run
Get-ChildItem (Join-Path $env:TEMP 'fusion-o5-5b12-route') | Select-Object Name, Length, LastWriteTime
git status --short
docker ps --all --filter "label=fusion.owner=true" --format "{{.ID}} {{.Image}} {{.Status}}"
```

## 27. Human authorization required next

A new milestone (for example O5.5B13) may open `O5.5B12-LIVE` only after the human explicitly authorizes, in their own words:
- **Scope:** one full-route rehearsal run on the throw-away quotes fixture.
- **Maximum model turns:** 7 — Lead plan 1, Change Author 2 (the second only after a mechanical retry or correction), fresh Reviewer 2, Lead adjudication 2. No retry beyond that and no second run.
- **Lead:** Claude Code 2.1.280, `haiku` (`claude-haiku-4-5-20251001`), effort `low`, `--max-turns 6`. Alternatively opus/high, to be named explicitly if wanted.
- **Change Author:** Claude Code 2.1.280, `haiku`, effort `low`, `--max-turns 6`.
- **Reviewer:** Muse 1.3.0-R3401.1, `muse-spark-1.3`, effort `low`, 4 model steps, no internal retry.
- **Lanes:** subscription lanes only.
- **Network:** one networked `npm ci` of the 8 locked registry packages in the dependency-preparation container.
- **Verification:** in the accepted confined Docker/Linux backend.
- **Never:** no delivery to any primary, no push, and `REAL_WRITER_LIVE_GATE_AUTHORIZED` stays false.

## 28. What a future full-route PASS would prove

For those exact bindings, on one fixture and in one run:
- real Lead planning, a real Change Author, host application, confined verification, a real fresh Reviewer and (if findings) real adjudication completed within the authorized budget;
- every process of every role ran in its checked view with its read-only controls;
- the primary and every view stayed unchanged, and cleanup was complete;
- the evidence stayed bounded.

## 29. What it would NOT prove

- Stability, which needs repeat samples (§24).
- Review quality or independence beyond fresh sessions and context isolation.
- HIGH-risk or critical-risk behaviour.
- Correction behaviour, unless one honestly occurs.
- Other versions, models or efforts, including the production default Lead (opus/high) unless chosen.
- OS-level provider filesystem isolation, Windows-required verification, and package managers other than the restricted npm lane.
- Human-approved delivery to a primary, or arbitrary project safety.
- Readiness of the real Writer mode; the live gate stays closed.

## Decision

```
FULL_ROUTE_LIVE_REHEARSAL_IMPLEMENTATION: READY
FULL_ROUTE_AUTHORIZATION_MODEL: READY
REAL_LEAD_IMPLEMENTATION: READY
REAL_CHANGE_AUTHOR_IMPLEMENTATION: READY
REAL_FRESH_REVIEWER_IMPLEMENTATION: READY
REAL_LEAD_ADJUDICATION_IMPLEMENTATION: READY
BOUNDED_LIVE_CORRECTION_IMPLEMENTATION: READY
FULL_ROUTE_LIVE_EVIDENCE: NOT_RUN
PROVIDER_CHANGE_PROPOSAL_READINESS: YES
REAL_WRITER_MODE_READINESS: NO
O5_5B_READINESS: NO
O6_READINESS: NO
REAL_WRITER_LIVE_GATE_AUTHORIZED: NO
```
