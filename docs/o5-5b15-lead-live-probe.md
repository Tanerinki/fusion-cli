# O5.5B15 — One authorized Claude Lead-plan live probe

Labels: **LIVE-OBSERVED** (the one authorized real turn, validated independently), **PROTOCOL-SOURCED** (read from the pinned runtime's own code in its binary bytes; never launched), **MECHANICALLY ENFORCED**, **FAKE-PROCESS PROVEN**, **NOT RUN**, **NOT PROVEN**.

Outcome in one line: the human ran the one authorized Lead-plan turn once. It ended **`RESULT_ERROR_MAX_TURNS`**: the Claude CLI's own result was `error_max_turns` / `max_turns`, with `is_error: true`, **7** internal turns counted against the limit of **6**, 0 permission denials, 1 error entry, no reply text, and exit 1. The Lead's reply was therefore never parsed or schema-checked.
- **Status:** CLAUDE_LEAD_LIVE_PROBE is **FAIL**. The diagnosis is now exact.
- **Nothing after the Lead:** no Change Author, Reviewer, adjudication or correction ran, and the Worker never opened a session.
- **Integrity:** the primary, canaries and view are unchanged, and cleanup is complete.
- **Authorization:** `O5.5B15-LEAD` is consumed, and there was no retry.
- **Unchanged:** the O5.5B13 historical FAIL, the isolated Change Author live PASSes and every readiness row.

## 1. Starting state

- **Stage 1:** branch `o5-5b15-lead-live-probe`, HEAD `53b1def` (O5.5B14), clean tree, verified before any change.
- **Stage 2:** the same branch and HEAD. The working tree equalled the Stage-1 snapshot: the patch SHA-256 `4d8a9acd…9cc0` was recorded before the run and re-verified.

## 2. The exact human authorization

**Authorized:** exactly one real Claude Lead-plan model turn, run by the human from a new normal PowerShell window:
- Claude Code 2.1.280, `haiku` / `claude-haiku-4-5-20251001`, effort `low`;
- at most 1 model turn;
- the pinned O5.5B13 fixture;
- the subscription/OAuth lane;
- a read-only Lead with no write, shell or web tools.

**Forbidden:**
- any Change Author, Reviewer, adjudication or correction turn;
- a second Lead turn or a retry;
- any Muse call;
- a model or provider fallback, Claude 2.1.281, or an API-key/PAYG fallback;
- real projects, primary mutation, delivery, push or merge;
- opening the live Writer gate.

**Unchanged before the probe:** the Lead prompt, `--max-turns 6`, the model, the effort and the provider.

## 3. What Stage 1 added (offline)

- **`O5.5B15-LEAD`** (`src/providers/probe-profiles.ts`): a one-shot route authorization.
  - Budget `{ leadPlan: 1, changeAuthor: 0, freshReview: 0, leadAdjudication: 0 }`.
  - The same frozen role grants as O5.5B13, including model/effort/turn-limit identity per model process.
  - The same fixture pin (`59c19d1f…8326`) and its own namespace, `%TEMP%\fusion-o5-5b15-lead`.
- **No session for an unbudgeted role** (`RouteTurnGate.roleBudget`, `ROUTE_ROLE_OF`): a role whose turn classes all have budget 0 is refused **session creation**. So its processes never start, not even an auth readback. The Change Author, Reviewer and adjudication turns, and a second Lead turn, are refused before the provider.
- **Live entry:** it prints each turn's bounded terminal diagnostic (labels and counts only), so the console output can be cross-checked against the evidence.
- **Tests:** 8 deterministic tests.

## 4. Stage-1 validation and identity

- **Focused suites:** O5.5B15 (8), O5.5B14 (13), Claude (76), route (36) and readiness (29) all passed.
- **Full suite:** 662 tests, 661 passed, 1 pre-existing skip (symlink creation is unavailable on this Windows account). Build and `git diff --check` were clean.
- **Namespace:** `%TEMP%\fusion-o5-5b15-lead` did not exist.
- **Recorded harness identity:** `compiledSourceSha256 4289ee206900ef7c662787ebf1897e139b0a8c373a1669055c109b945d34420f`, `compiledFiles 104`, `liveEntrySha256 a18abc3fbb10d53b3b27c1b20931d0fe8af393889317626218bb26e5878b6ec0`.

## 5. The live command, consumed once

```powershell
node dist/test/live/route-rehearsal.js --authorization O5.5B15-LEAD
```

The human ran it from a normal PowerShell window after the documented checks, and did not re-run it. Their output:

```
O5.5B15 full-route rehearsal: PROVIDER_FAILED
detail: leadPlan #1 (Lead): providerFailure: Claude reported a failed turn.
stage: workflow; evidence kind: liveProvider; model turns started: 1
role turns used: leadPlan=1 changeAuthor=0 freshReview=0 leadAdjudication=0
provider processes started: providerAuthReadback=2 providerInventory=1 providerInitProbe=3 providerTurn=1 providerHost=0
turn O5.5B15-LEAD:leadPlan#1: failed; contract notReached:failed; terminal classification=RESULT_ERROR_MAX_TURNS resultSubtype=error_max_turns terminalReason=max_turns isError=true internalTurnCount=7 permissionDenialCount=0 resultTextPresent=false resultTextByteLength=0 structuredParsingReached=false schemaValidationReached=false processExitCode=1
```

After the run, `git status` showed exactly the Stage-1 set, and `docker ps` for Fusion-owned containers was empty.

## 6. The evidence namespace

`%TEMP%\fusion-o5-5b15-lead` holds exactly:
- `authorization.json`;
- `route.claim.json`;
- `route.turns.jsonl`;
- `route.evidence.json` (16 292 bytes, SHA-256 `301e78180f29a78b6a584a02b141b89f185c199bea8a29a59f920e74ed9273ea`);
- the fixture `route-fixture-0f6228c9ad0e/primary`.

There is no preflight file. The namespace was only read.

## 7. Independent validation

A separate validator reads the namespace and the compiled production data. It recomputes the fixture identity, the posture rules and the primary fingerprint (read-only, `git --no-optional-locks`), and re-validates the terminal diagnostic with the sanitizer. Result: **76 checks, 0 failed.** In summary:
- **Identity:**
  - the harness identity equals the Stage-1 snapshot;
  - the recorded budget and grants equal the compiled `O5.5B15-LEAD`;
  - the fixture digest equals the pin.
- **One run:**
  - one marker and one claim;
  - one ledger line, `leadPlan #1 (Lead)`, written after the claim;
  - no preflight file.
- **Outcome:** `PROVIDER_FAILED` at stage `workflow`, with the exact detail and transitions `…planning>failed:providerFailure`. There were no turn or launch refusals: the engine stopped at the failed plan, so it never tried the Worker.
- **The one turn:**
  - `O5.5B15-LEAD:leadPlan#1`, failed with `ProcessFailure`, contract `notReached:failed`;
  - one model process, in the baseline view only;
  - the terminal diagnostic is exactly as reported and re-validates unchanged;
  - its labels are real 2.1.280 protocol labels;
  - the human's console turn line re-derives exactly from the evidence.
- **Processes:**
  - 7 in all: auth readback 2, inventory 1, init probes 3, model turn 1, Muse host 0;
  - all `claude.exe` in the baseline view, with no forbidden variable and no primary argument;
  - the only process outside the turn is the Lead's own session readback;
  - the model launch's posture and identity pairs are exact (`--model haiku`, `--effort low`, `--max-turns 6`), and none of the forbidden flags (fallback, skip-permission, add-dir, MCP config) is present.
- **Init readback:** 2.1.280, `claude-haiku-4-5-20251001`, `apiKeySource none`, `dontAsk`, tools exactly `Glob, Grep, Read`, 0 MCP servers, authenticated through the subscription token. Worker and Reviewer readbacks are `null`.
- **Nothing after the Lead:** no proposal, candidate, verification or review.
- **Integrity:** the primary digest `24f4586b…33e6` is equal before and after, and so is the recomputation now. Git status shows only the ignored canaries, which are byte-identical. The view is unchanged and released, no temporaries are left, and containers went 0 → 0.
- **Redaction:** the evidence holds no prompt, delegation, task text, error text, fence, canary, token or env name, profile path, result text or stderr.

## 8. The terminal diagnostic (LIVE-OBSERVED)

| Field | Value |
| --- | --- |
| classification | **RESULT_ERROR_MAX_TURNS** |
| resultSubtype | `error_max_turns` |
| terminalReason | `max_turns` |
| isError | true |
| internalTurnCount | **7** |
| permissionDenialCount | 0 |
| errorEntryCount | 1 |
| resultTextPresent / resultTextByteLength | false / 0 |
| apiErrorStatusClass | none |
| structuredParsingReached | **false** |
| schemaValidationReached | **false** |
| processExitCode | 1 |
| processSignal / fusionTermination | null / null |
| timedOut / cancelled | false / false |

## 9. What it means

- **The CLI's own turn limit ended the Lead's turn.** Neither Fusion nor a timeout did, nor did auth, rate limits, the stream or the model identity. All of those checks passed, and the init frame was verified.
- **7 against a limit of 6 (PROTOCOL-SOURCED):** in 2.1.280's run loop, after each turn that used tools, the next turn count is `completed + 1`. When that exceeds `--max-turns`, the loop stops with `max_turns` and reports that count. So `num_turns: 7` means all **6 allowed turns completed and the model was still calling tools**; it needed a 7th turn and had not produced a final answer.
- **No reply:** the error variant carries no `result` text, so there was nothing to parse. The Lead's plan contract was never evaluated (neither parsing nor schema check).
- **One error entry:** its text was not retained, by design. Per the protocol, the `error_max_turns` variant's entry has the form "Reached maximum number of turns (N)".
- **0 permission denials:** no permission-mode denial occurred. Caveat, observed in earlier research: a hallucinated call to a tool that is not available does not appear in `permission_denials`. So 0 does not prove the model never tried to write.

## 10. Process facts

- **3 init-only startups (O5.5B13 had 2):**
  1. the plugin discovery startup (no settings);
  2. the first quarantine verification round (with the child-only settings), which found a newly loaded plugin; it was added to the disabled list, a designed and bounded path;
  3. the second round, which confirmed none was loaded.
- **Why this is the only explanation:** the quarantine code returns after the first round when nothing is loaded, so a third startup can only mean that path ran.
- **Quarantine held:** the model turn's own init readback was verified with zero loaded plugins; otherwise Fusion would have stopped the turn (`STOPPED_BY_FUSION`).
- **Everything else** matches O5.5B13: the model turn took 42.9 s including setup, and the whole run 57.1 s.

## 11. Relation to O5.5B13

- **Same conditions:** the same binding, runtime, prompt, fixture and 6-turn limit.
- **What is shown:** under these conditions the Lead's plan turn runs out of its turn budget before answering. O5.5B13's recorded facts (a failed result frame, exit 1, a 40.3 s turn) are consistent with that.
- **What is not shown:** O5.5B13 was a different run and kept no result fields, so **its exact cause is still not directly proven**.
- **Unchanged:** its record stays exactly what it was (FAIL, `PROVIDER_FAILED` at `leadPlan#1`), and it is not counted twice. The Lead probe is recorded separately (`leadPlanLiveRecords`), not as a full-route attempt.

## 12. The Lead prompt observation, now with live context

As documented in O5.5B14 (unchanged here), the Lead's plan turn receives the **generic delegated-task prompt** ("Complete this delegated task within its scope…"). The task is fix-and-add-a-test, and the reply shape reports changed files and tests run. The session is read-only (Read/Grep/Glob).

The live result shows the model spent all 6 agentic turns on tool use without answering. That is consistent with working at the implementation task rather than planning. **Which of these contributes, and how much, is NOT PROVEN:**
- the prompt;
- the limit of 6;
- the fixture's size.

## 13. Roles after the Lead

The engine stopped at `planning>failed:providerFailure`. It never delegated, so the Worker never opened a session, and it would have been refused if it had tried.

| Role / step | Status |
| --- | --- |
| Change Author | **NOT RUN** |
| Fresh Reviewer | **NOT RUN** |
| Lead adjudication | **NOT RUN** |
| Correction | **NOT RUN** |
| Candidate / confined verification | **NOT RUN** (no candidate) |

## 14. What was persisted

Only labels, counts, digests, redacted argv and the bounded terminal diagnostic. The environment appears as a key count only.

Never persisted: the prompt, reply, result text, error text, denied-tool inputs, stderr, transcript (`--no-session-persistence`), credentials and source content.

## 15. Why no retry

The authorization was one Lead turn and the slot is consumed; `O5.5B15-LEAD` is now `consumed`, and its claim refuses a second run. The failure is fully diagnosed, and a retry under the same conditions would test nothing new. Nothing in this session called any provider.

## 16. Stage-2 changes

- **`src/providers/probe-profiles.ts`:** `O5.5B15-LEAD` → `consumed`, with the result in its comment.
- **`src/runtime/provider-profiles.ts`:** `LeadPlanLiveRecord` and `leadPlanLiveRecords()`, holding one static history record: Claude 2.1.280 haiku/low, `maxTurns 6`, `FAIL`, route `PROVIDER_FAILED`, the terminal fields above, the evidence SHA-256 and this document.
- **`src/app/writer-gate.ts`:** the `writerPosture` prerequisite text gains one provider-neutral sentence about the probe. No gate row changes.
- **Tests:** `test/o5-5b15-lead-live-record.test.ts` (4 tests):
  - the record itself;
  - readiness unchanged and no authorization open;
  - the consumed identity refused;
  - an offline replay of the observed result-frame shape through the real adapter, which yields exactly the recorded diagnostic.

  In the Stage-1 tests, the authorization assertions were updated for the consumed state, and the open-path refusal checks now run on an in-memory open copy.
- **No implementation fix:** the Lead prompt and the turn limit are unchanged, as the authorization required.

## 17. Readiness

| Gate | State |
| --- | --- |
| providerChangeProposal | **satisfied (recordedLiveProbe)**: preserved (O5.5B9 Muse PASS, O5.5B11 Claude PASS) |
| fullRouteLive | blocked (recordedLiveProbe): 1 run (O5.5B13), 0 passed; unchanged |
| hostControlledWriterWorkflow | partial (fakeProviderRehearsal) |
| fullRouteRehearsalImplementation | satisfied (fakeProcess) |
| liveGateAuthorization | blocked |

HOST_CONTROLLED_WRITER_WORKFLOW_READINESS **NO**. REAL_WRITER_MODE_READINESS **NO**. O5_5B_READINESS **NO**. O6_READINESS **NO**. REAL_WRITER_LIVE_GATE_AUTHORIZED **NO**.

## 18. Recommended next milestone: O5.5B16, offline Lead plan contract and turn-limit fix

**Scope:** offline only, with no provider call and every authorization closed.

1. **Give the Lead's plan turn a planning contract** instead of the generic delegation prompt. It should say:
   - plan, do not implement;
   - read only what the plan needs;
   - answer within the turn budget in the existing ResultPacket shape.

   Keep the Worker's and Explorer's prompts unchanged.
2. **Decide the Lead's turn limit on evidence:** keep 6 if the planning contract alone fits it; raise it only with an explicit reason. The live data point is "6 turns of tool use and no answer".
3. **Tests with the fake binary:**
   - a plan turn that answers within the limit;
   - one that hits `error_max_turns`, with the diagnostic unchanged;
   - the prompt shape pinned.
4. **Then**, a new, explicit human authorization for one Lead-plan live turn under the fixed contract, before any new full-route run.

## Decision

CLAUDE_LEAD_LIVE_PROBE: **FAIL**, with a precise cause: `RESULT_ERROR_MAX_TURNS` (`error_max_turns`, 7 against a limit of 6, no reply, never parsed). Every downstream role is **NOT RUN**, the authorization is consumed, and nothing was retried.
