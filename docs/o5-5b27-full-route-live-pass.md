# O5.5B27 — Full-route live rehearsal: PASS

Labels: **LIVE-OBSERVED** (the one authorized run, validated independently), **MECHANICALLY ENFORCED**, **NOT RUN**.

Outcome in one line: the **first successful real full-route rehearsal**. Every role ran with real providers on the throw-away fixture:
- **Claude Lead plan** accepted;
- **two Claude Change Author turns**, the second **state-required after the first ChangeSet failed confined verification**;
- **host application into private candidates**;
- **Docker-confined verification** (failed, then passed);
- **fresh Muse 1.4 Reviewer**: 0 findings.

Four model turns in total. No adjudication (no findings), no review-driven correction. Primary, views and the Reviewer binary were unchanged, and cleanup was complete. Nothing was delivered to any real project. **One sample on one fixture.** `O5.5B27-LIVE` is consumed.

## 1. The run

- **Stage 1** (`o5-5b27-full-route-live-rehearsal`, on `8509a5e` O5.5B26): `O5.5B27-LIVE`, exactly the O5.5B25 plan (the same role grant objects, budgets 1/2/2/2, fixture `59c19d1f…`).
  - Fingerprint: `compiledSourceSha256 3b7f9080…49e5` (109 files), `liveEntrySha256 b3e586c8…e46c`.
  - Stage-1 patch: `cf279aea…b69d` (recorded at Stage 1).
  - The executed build is identified by the compiled fingerprint the evidence carries, which equals the Stage-1 snapshot.
- **The human** ran it once from a normal PowerShell window (2026-09-25T20:25:59.591Z, 196.7 s): `PASS`; role turns `leadPlan=1 changeAuthor=2 freshReview=1 leadAdjudication=0`.

| Turn | Model turn | Reply | Contract |
| --- | --- | --- | --- |
| leadPlan #1 (Claude 2.1.280 haiku/low) | `RESULT_OK`, 6 internal turns, exit 0 | `SINGLE_FENCED_VALID_JSON`, accepted, schema matched, 825 B | accepted |
| changeAuthor #1 (same binding) | `RESULT_OK`, 3 internal turns, exit 0 | `SINGLE_FENCED_VALID_JSON`, accepted, **no text outside**, 2765 B | ChangeSet **validated** (2 operations) |
| changeAuthor #2 (same binding) | `RESULT_OK`, 3 internal turns, exit 0 | `SINGLE_FENCED_VALID_JSON`, accepted, no text outside, 2889 B | ChangeSet **validated** (2 operations) |
| freshReview #1 (Muse 1.4.0-R4161.1, muse-spark-1.3, low, 4 steps, 0 retries) | `RESULT_OK`, exit 0 | `RAW_VALID_JSON` under `rawOnly`, 214 B | accepted, **0 findings** |

**Processes:**
- `providerTurn 4`, `providerAuthReadback 6`, `providerInventory 3`, `providerInitProbe 6`: the init probes were stopped by Fusion after their readback, the established pattern.
- `providerHost 1`: the Reviewer's account-attestation host.
- None refused.

## 2. Independent validation (Stage 2)

**66 checks, 0 failed.** No provider was called and nothing was re-run. The evidence SHA-256 is `4b93df3b315b7ede9fdc6147443bcaf27913efda20586fc9048c33b91010f242`.

1. **Identity:** the harness equals the Stage-1 fingerprint, and roles, budget, milestone and fixture pin equal the compiled `O5.5B27-LIVE` (whose roles equal O5.5B25's).
2. **Consumed exactly once:**
   - one marker and one claim, written during the run;
   - no preflight file;
   - the ledger holds exactly `leadPlan#1`, `changeAuthor#1`, `changeAuthor#2`, `freshReview#1`, in order.
3. **Lead and Change Author:**
   - binding: Claude one-shot `haiku` → `claude-haiku-4-5-20251001`, `low`, `--max-turns 6`;
   - preflight: 2.1.280 validated and authorized, subscription token, `FUSION_CLAUDE_EXE` set;
   - every model process carried `--model haiku`, `--effort low` and `--max-turns 6` exactly once, plus the read-only controls, with no widening flag;
   - readbacks: 2.1.280, canonical model, no API key, `dontAsk`, Read/Grep/Glob.
4. **Reviewer:**
   - binding: Muse Exec `muse-spark-1.3`, `low`, 4 model steps, 0 retries;
   - validated for exactly this binding (O5.5B24), with the pinned binary (location and SHA-256);
   - its model process carried exactly `--provider meta`, `--model muse-spark-1.3`, `--reasoning-effort low` and `--max-model-steps 4`, plus the production Exec controls in order;
   - attested subscription lane.
5. **Lead plan contract:** accepted.
6. **Both Change Author contracts:** validated; each reply was one json fence with **no text outside** (O5.5B26's discipline held in both turns).
7. **Application:**
   - two private candidates were created and released, one per attempt; the final changed paths are exactly `src/quote.ts` and `test/quote.test.ts`;
   - the primary is unchanged.
8. **Confined verification:** Docker Linux (`osSandbox`), result accepted, acceptance granted, both attempts.
   - Attempt 1: `passed: false`, both commands run, unit **11 tests, 10 pass, 1 fail**.
   - Attempt 2: `passed: true`, unit **12 of 12**.
9. **Fresh review:**
   - requested only after attempt 2 verified;
   - it ran in the candidate view of that verified candidate (the only candidate view; checked, fingerprinted 3 times, unchanged, released);
   - one cycle, `clean`, 0 findings.
10. **No adjudication:** no findings. Turn use is `{1, 2, 1, 0}`; unused slots `{0, 0, 1, 2}`.
11. **Primary:** digest `5aae1134…97c2` equal before and after, recomputed read-only now, with the same HEAD; the canaries are unchanged.
12. **Views:**
    - one baseline view (7 fingerprints) and one candidate view (3 fingerprints), both checked, unchanged and released;
    - provider views: 2 created, 2 released.
13. **Reviewer binary:** its SHA-256 matched after the run and still matches now.
14. **Cleanup:** no leftover temporaries, containers 0 → 0, both candidates released.
15. **Redaction:** no fence, prompt, reply, task or diff text, canary, user name or path, and no free-text field.
16. **No delivery:** the gates were closed before and after, and the primary was the throw-away fixture under `%TEMP%\fusion-o5-5b27-route`. No delivery, application, push or merge exists in the harness, and the repository working tree was unchanged by the run.

## 3. Why `changeAuthor` ran twice

The engine's own transitions show a **state-required mechanical retry after a failed confined verification**, not a workflow bug:

```
planning>leased:leaseAcquired
leased>delegating:delegated                  changeAuthor #1 — ChangeSet validated, host-applied
delegating>verifying:verificationStarted
verifying>retrying:verificationFailed        attempt 1: unit 11 tests, 1 failed
retrying>leased:leaseAcquired                a fresh private candidate
leased>delegating:delegated                  changeAuthor #2 — ChangeSet validated, host-applied
delegating>verifying:verificationStarted
verifying>reviewing:freshReviewRequested     attempt 2: 12/12
reviewing>completed:succeeded
```

- **The engine rule** (`src/core/workflow/engine.ts`): a failed candidate verification with `attempt < limit` moves to `retrying` with reason `verificationFailed`, and delegates again to a **fresh candidate**, telling the Change Author only "Fusion verification command … did not pass."
- **The route gate** admits Change Author slot 2 only after such a mechanical retry (`SECOND_ATTEMPT_REASONS`).
- **Counts:** `route.retries = ["verificationFailed"]`, `corrections = 0` (not a review correction), `delegateAttempts = 2`. The `verificationFailed` risk signal was raised.
- **Which command failed:** unit. Both commands ran in attempt 1, and the accepted guest protocol stops at the first command that does not pass ("only the last executed command may have failed"). So typecheck passed and unit failed (1 of 11 tests).
- **Not known:** which test failed, and why (no test output is persisted). Attempt 2 had one more test (12), all passing.

## 4. Relation to the earlier runs

| Run | Ended | Cause | Fixed by |
| --- | --- | --- | --- |
| O5.5B13 | `PROVIDER_FAILED` at leadPlan #1 | Lead turn failure (later: turn limit under a generic prompt) | O5.5B14 diagnostics, O5.5B16 planning prompt, O5.5B18 Lead envelope (Lead PASS O5.5B21) |
| O5.5B25 | `MALFORMED_OUTPUT` at changeAuthor #1 | text before one schema-matching fence (`EXTRA_TEXT`) | O5.5B26 Change Author output discipline (parser unchanged) |
| **O5.5B27** | **PASS** | — | — |

The Muse 1.4 Reviewer blocker was cleared by O5.5B23 and O5.5B24, which validated exactly the Reviewer binding and binary. The adjudication fence risk was hardened offline in O5.5B22, but never exercised live, because there were no findings.

## 5. Readiness, before → after

| Row | Before | After |
| --- | --- | --- |
| fullRouteLive | blocked: 2 runs, 0 passed | **partial** (recordedLiveProbe): 3 runs, 1 passed. By design, one pass on one fixture is partial. The branches never taken live are named. |
| hostControlledWriterWorkflow | partial (fakeProviderRehearsal) | **partial (recordedLiveProbe)**: live evidence for Lead → Change Author → validation → host application → mechanical retry → confined verification → fresh Reviewer |
| structuredOutputEnvelope, billingAndAuthPosture | — | state unchanged; remaining-blocker text updated to the live observations |
| every other row | — | unchanged |

**HOST_CONTROLLED_WRITER_WORKFLOW_READINESS stays NO.** The route's own conditional branches never ran live:
- Lead **adjudication** of review findings (the O5.5B22 envelope is implementation-only);
- **review-driven correction** and **re-review**.

Beyond that, this is one sample on one throw-away fixture, and the workflow ends in a private candidate: nothing delivers to a primary checkout.

**Unchanged by design:** REAL_WRITER_MODE_READINESS NO, O5_5B_READINESS NO, O6_READINESS NO, REAL_WRITER_LIVE_GATE_AUTHORIZED NO (a constant). A private-candidate pass is **not** authorization to mutate or deliver to a primary checkout.

## 6. Remaining blockers (priority order)

1. **Adjudication and correction never ran live.** Lead adjudication of findings, the review-driven correction and the re-review are the unexercised branches of this route.
2. **No OS-level filesystem isolation for provider CLIs.** They run on the host under the user's token; Fusion *detects* changes (primary, views, candidate fingerprints) but cannot prevent reads or a transient mutate-and-restore of unhashed content (primaryProtection, providerWorkspaceBoundary, sharedGitAndIgnoredPaths: partial).
3. **No human-approved delivery.** There is no delivery or applier to the primary checkout (`app/delivery.ts` is a manifest plus read-only preflight only), and the live Writer gate is a constant `false`.
4. **Bounded monitoring of ignored and sensitive paths.** Sensitive and protected files are covered by content, others by metadata, and managed directories by a directory-level signal only (ignoredPathProtection: partial).
5. **Dependencies.** Only the deliberately restricted npm lane (no other package managers, workspaces, git/file dependencies or install scripts).
6. **Windows-native verification.** No confined backend; the acceptance is Linux-scoped.
7. **Evidence breadth.**
   - one live sample on one throw-away fixture and one binding set (haiku/low; Muse 1.4 only for its exact Reviewer binding);
   - the default production bindings (an opus/high Lead; the no-config Reviewer binding) never ran live;
   - no reliability statistics.
8. **Minor evidence gap.** The route evidence carries no per-step status or exit code for verification: the Docker step observation has no such fields, so they were derived above from the protocol rule. The route harness could record them from the verification report.

## 7. Smallest next milestone

**O5.5B28 (offline): a Lead-adjudication-only live-probe foundation**, analogous to O5.5B23. It is exactly one Claude Lead adjudication turn:
- under the O5.5B22 single-fence envelope;
- on a fixed, Fusion-authored finding set over the Fusion-authored candidate, with Fusion's own verification facts;
- checked by the production adjudication contract (`validateAdjudicationReport`);
- with no Lead plan, Change Author or Reviewer turn.

Optionally, it can also record per-step verification status in the route evidence (item 8). A separately authorized live run of that probe follows, and only then a full route whose review has findings.

## 8. Tests

- **`test/o5-5b27-full-route.test.ts`:**
  - the authorization is consumed, and never run by a test;
  - the one behavioural difference from O5.5B25;
  - the fake happy path and the unchanged parser;
  - **the exact O5.5B27 record**: roles, turn diagnostics, retry reason, verification attempts, SHA-256, history, coverage;
  - **readiness**: the new row states and texts; every other row, the Writer aggregate and the live gate unchanged; no success wording.
- **Older tests:** readiness snapshots now read the growing history (the full-route rows carry the recorded pass; "nothing had passed" holds for the history before O5.5B27). The O5.5B25 and O5.5B26 tests keep their exact records.
