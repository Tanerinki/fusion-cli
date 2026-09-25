# O5.5B30 — Review-driven correction branch (offline foundation)

Labels: **IMPLEMENTED + FAKE-TESTED** (offline), **NOT RUN LIVE**.

After O5.5B27 (full route, clean review) and O5.5B29 (isolated live Lead adjudication, decision `correction`), exactly one Writer branch has never run live:

> review findings → Lead adjudication = correction → corrective Change Author → host application → confined verification → fresh re-review.

O5.5B30 builds the smallest production-faithful probe for it: `src/app/correction-probe.ts`. The probe **enters at the post-adjudication boundary** and spends at most **two model turns**: one corrective Change Author turn and one fresh re-review.

This milestone called no provider and created no authorization (`CORRECTION_PROBE_PROFILES.authorizations` is empty). No readiness row, aggregate or gate moves, and no prompt, schema, envelope, contract or policy changed.

## 1. Architecture

```
[Fusion-owned] starting candidate = REVIEW_CANDIDATE_CHANGE (attempt 1): host-applied, confined-verified
[Fusion-owned] review cycle 1     = ADJUDICATION_REVIEW_REPORT -> validateReviewReport -> r1-F1, r1-F2, r1-F3
[Fusion-owned] adjudication 1     = CORRECTION_ADJUDICATION_REPORT (the O5.5B29 live verdict LABELS)
                                    -> validateAdjudicationReport -> adjudicate (Fusion facts) -> reviewOutcome
                                    => decision: correction [r1-F1]
── boundary: the engine's retrying:reviewFindingsConfirmed (attempt 2 of 2, fresh candidate) ──
   starting candidate released (one candidate at a time)
[model turn 1] corrective Change Author: fresh session in a BASELINE view
               request = { kind: changeProposal, packet: delegatePacket(ROUTE_PACKET, {}, retry), baseline: Fusion's hashes }
[Fusion]       validateChangeSet(writerChangeScope) -> host apply into a FRESH private candidate (attempt 2)
               candidate == applied ChangeSet; scope check
[Fusion]       confined verification — a failure ENDS the branch (attempts exhausted): no re-review
[model turn 2] fresh re-review, cycle 2: NEW session in a NEW candidate view of the corrected candidate
               request = { kind: review, cycle: 2, evidence: reviewEvidence(ROUTE_PACKET, verification, diff),
                           priorFindings: outstanding cycle-1 findings [r1-F1] }
[Fusion]       validateReviewReport; 0 findings -> reviewOutcome = clean -> branch complete (PASS)
               findings -> REREVIEW_FINDINGS (the policy's next step, a cycle-2 Lead adjudication, is never run)
```

Every step after the boundary is the engine's own step for attempt 2, built from the production functions the engine uses:
- `delegatePacket` and `FRESH_CANDIDATE_CONSTRAINT`;
- `writerChangeScope` and `validateChangeSet`;
- the candidate port's `baselineHashes`, `apply`, `changedPaths`, `verify` and `diff`;
- `unexpectedScopeSignals` and `reviewEvidence`;
- `validateReviewReport`, `isOutstanding` and `reviewOutcome`;
- the view port, with a baseline view for the author and a candidate view for review;
- `resolveRole` with the engine's needs (Worker `changeProposal` + `workspaceBinding`; Reviewer `structuredTurns` + `reviewIsolation` + `workspaceBinding`).

**The one packet difference from the route:** no Lead plan exists at this entry point, so the correction packet has no `Lead plan: …` decision line. Every other field is `delegatePacket`'s own.

## 2. What is forwarded as a correction: only r1-F1

The O5.5B29 live labels were r1-F1 MEDIUM CONFIRMED/fix, r1-F2 LOW CONFIRMED/fix and r1-F3 HIGH REJECTED/none. Through the **unchanged** policy:

| Finding | Verdict / action | `isOutstanding` | Sent back as a correction? |
| --- | --- | --- | --- |
| r1-F1 (MEDIUM) | CONFIRMED / fix | yes (material) | **yes** |
| r1-F2 (LOW) | CONFIRMED / fix | no (LOW is not material) | no: recorded, not a correction |
| r1-F3 (HIGH) | REJECTED / none | no | **no** |

This is the production behaviour, and the O5.5B29 live decision already recorded it (`correction [r1-F1]`). The milestone text assumed that both confirmed findings require fixes. Under the existing policy, only the material one does.

The corrective Change Author sees exactly three added constraints:
- `Attempt 2 of 2: Fusion review confirmed 1 finding(s) to fix.`
- the fresh-candidate constraint;
- `Fix r1-F1 [MEDIUM] No test covers a partial discount (test/quote.test.ts). Suggested fix: Add a test with a partial discount.`

It does not see:
- r1-F2 or r1-F3, or their titles;
- any rationale (the adjudication rationales are Fusion placeholders, and production forwards none);
- the Reviewer summary, the provenance session, or a Lead or review prompt.

**Fusion facts:** production forwards no Fusion facts to a Change Author, only the finding constraints. None are added here.

## 3. Verification gates the re-review

- The re-review may start only after the corrected candidate's confined verification passed. The turn gate refuses a review before `verified`, and the launch guard refuses any Reviewer process outside the `rereview` stage.
- A failed verification ends the branch as `VERIFICATION_FAILED` ("attempts are exhausted and no re-review runs"), because attempt 2 is the engine's last. The Reviewer never starts: 0 processes.
- A refused ChangeSet (`MALFORMED_OUTPUT`, `INVALID_CHANGESET`) or a failed application also ends the branch before any re-review.

## 4. Bounds

**Authorization** (`CorrectionProbeAuthorization`):
- states `pending`, `open`, `consumed` and `retired`;
- the budget must be **exactly** `{ leadPlan: 0, changeAuthor: 1, freshReview: 1, leadAdjudication: 0 }`;
- pinned: fixture `59c19d1f…`, starting candidate `a8e6622d…`, finding set `905bd34b…`, adjudication labels `cf8a0402…0aa7`;
- refused inside an agent session; its own namespace; a second attempt is refused.

**Roles** (`ROUTE_CORRECTION_ROLES`): the route's own grant objects.
- Change Author: Claude Code 2.1.280, `haiku` → `claude-haiku-4-5-20251001`, `low`, `--max-turns 6`, subscription lanes, `rawOrSingleJsonFence` with the O5.5B26 reply rule.
- Reviewer: exactly the O5.5B24-validated Muse Exec 1.4.0-R4161.1 binding, binary pinned by location and SHA-256 `b33b4930…d950`: `muse-spark-1.3`, `low`, 4 steps, 0 retries, raw-only.
- The Lead is **not composed**.

**Static preflight per role:**
- the exact binding;
- a release validated for that binding and authorized;
- the required environment and the lane;
- the surface (`changeProposal` or `review`);
- the pinned binary's location and bytes;
- the recorded envelope.

**Claim:** written right after the Change Author's session opened in its baseline view (that session's account readback is pre-claim), and right before the first model turn.

**Turn gate (`CorrectionTurnGate`):**
- Worker: one `runChangeProposalTurn`, nothing else;
- Reviewer: one `runStructuredTurn`, kind `review`, cycle 2, only after verification;
- everything else is refused before the adapter.

**Pre-launch guard:**
- no provider process before the boundary, between the turns, or after the re-review;
- Change Author processes only in the baseline view; Reviewer processes only in the corrected candidate's view, or its attestation host in an empty Fusion-owned directory;
- the pinned Reviewer binary only;
- one model process per role, with read-only controls and the exact identity flags;
- no primary path in arguments, no forbidden variable.

**After the run:** the Reviewer binary is re-hashed.

**Outcome.** The classification is deterministic, and every failure detail names the stage it happened in (`correctionAuthor`, `application`, `verification`, `rereview`).

**PASS** requires all of:
- both model turns;
- a validated and applied ChangeSet;
- a passed verification;
- the re-review contract accepted with **0 findings** (the policy's `clean`);
- integrity: primary, both views and the corrected candidate;
- complete cleanup.

**`REREVIEW_FINDINGS`**: the re-review's contract accepted findings. The bounded policy's next step would be a cycle-2 Lead adjudication, which is outside the budget. No further correction is available (2 of 2 attempts, cycle limit 2), and nothing more runs.

## 5. Evidence (bounded)

Recorded:
- **boundary:** cycle-1 finding ids and severities, adjudication labels with `outstanding`, the decision, the retry context, prior findings, and the correction packet's constraint count and SHA-256;
- **starting-candidate** application and verification;
- **correction author:**
  - turn: requested and observed model, effort, `maxTurns`;
  - the structure-only envelope and terminal diagnostics;
  - the ChangeSet outcome, operation count and paths;
- **application** hashes and **correction verification**;
- **re-review:**
  - request: cycle, prior findings, changed paths, diff bytes, verification, contract prompt SHA-256;
  - turn, contract, finding counts, decision, envelope and terminal diagnostics;
- **readbacks** per role;
- per-role **launch counts** and launches;
- **sessions** with the kind of their view;
- the **views**, **integrity**, **primary** digests, **cleanup**, **gates** and the pinned binary after the run.

Never recorded: a ChangeSet's content, a diff, a prompt, a reply, a rationale, a summary or a credential.

## 6. Tests (`test/o5-5b30-review-correction-branch.test.ts`, offline)

**Happy path (fake):** correction author → host apply → verify → re-review clean → `PASS`.
- It enters at the boundary: the decision `correction [r1-F1]` is recorded; no process runs before the author session.
- Exactly two model turns: Worker 2 readbacks, 1 inventory, 2 init probes, 1 turn; Reviewer 1 host, 1 turn.
- The Change Author's prompt equals `claudeStructuredPrompt` of the production correction request: only `Fix r1-F1`, and none of r1-F2, r1-F3, placeholders, the summary, provenance or a plan.
- The ChangeSet was validated and host-applied (hashes recomputed).
- The re-review ran in a new candidate view with a new session. Its evidence equals `reviewEvidence` of the corrected diff, with prior finding r1-F1 and no Change Author transcript.
- Clean decision; integrity, cleanup, and no text in the evidence.

**Failure (fake):** a wrong fix → `VERIFICATION_FAILED`, 1 model turn, **0 Reviewer processes**, no review request.

**Other tests:**
- Refused ChangeSets: prose around the fence → `MALFORMED_OUTPUT` (`EXTRA_TEXT`); an out-of-scope file → `INVALID_CHANGESET`. No re-review and nothing applied.
- Re-review findings → `REREVIEW_FINDINGS`: decision `adjudicationRequired` (cycle 2, not authorized), turn use `{0,1,1,0}`.
- Turn gate: one proposal; the review only cycle 2, only after verification, once; adjudication, cycle 1 and packet turns are refused before the adapter.
- Bounds:
  - binding mismatches (Worker effort and max-turns, Reviewer steps) → `MODEL_BLOCKED`;
  - a wrong Reviewer SHA → `VERSION_BLOCKED`, in preflight with nothing consumed;
  - every other budget → `budgetNotCorrectionOnly`;
  - all four pins, the three states, and nested sessions are refused, creating nothing.
- Boundary: the O5.5B29 labels go through the production contract and policy to `correction [r1-F1]`. The labels equal the recorded live verdicts, and the packet's constraints are exact.
- Readiness and authorization:
  - no authorization exists, and nothing is open anywhere;
  - the roles are the route's grant objects;
  - no row, aggregate or gate moves;
  - the live entry lists none.

## 7. Not done here

- No live run. The live entry `test/live/correction-probe.ts` is for a later, separately authorized human run.
- No cycle-2 adjudication; no correction inside a full route.
- No delivery; no readiness change.
