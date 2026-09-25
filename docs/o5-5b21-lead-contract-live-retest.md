# O5.5B21 — Lead contract live retest: PASS

Labels: **LIVE-OBSERVED** (the one authorized real turn, validated independently), **MECHANICALLY ENFORCED**, **FAKE-PROCESS PROVEN**, **NOT RUN**.

Outcome in one line: the real Claude Lead contract **passed end to end**. The model turn succeeded (`RESULT_OK`, 6 turns within `--max-turns 6`, exit 0). Its reply, exactly one json-fenced object, was **accepted** by the O5.5B18 Lead envelope, and the **ResultPacket contract was accepted**. The route then stopped, as designed, when the Lead-only budget refused the Worker's session (`TURN_REFUSED`).
- **Nothing after the Lead:** no Change Author, Reviewer or adjudication model turn ran.
- **Integrity:** primary and view unchanged, cleanup complete.
- **Authorization:** `O5.5B21-LEAD` is consumed.
- **Scope of the proof:** the exact tested binding only. Claude Code 2.1.280, haiku / `claude-haiku-4-5-20251001`, effort `low`, `--max-turns 6`, the O5.5B16 planning prompt, and the O5.5B18 `rawOrSingleJsonFence` Lead envelope.

## 1. Starting state and authorization

- **Stage 1:** branch `o5-5b21-lead-contract-live-retest`, HEAD `891ef40` (O5.5B20); patch SHA-256 `9cfa324f…fcc2`, re-verified at Stage 2.
- **Authorization:** one real Claude Lead-plan turn under `O5.5B21-LEAD`. That is the O5.5B19 shape exactly (budget `{ leadPlan: 1, others 0 }`, the same grants, fixture, prompt and envelope), and it is the retest O5.5B19 could not start.
- **Harness identity:** `compiledSourceSha256 d74be2dd…aff5` (105 files), `liveEntrySha256 6633db0e…310a`.
- **Muse:** the machine's Muse was 1.4.0-R4161.1. With O5.5B20, the zero-budget Reviewer was neither inspected nor routed.

## 2. The run (human, once, normal PowerShell)

```
O5.5B21 full-route rehearsal: TURN_REFUSED
detail: a role turn was refused before it reached the provider: the Worker role has no authorized turn in this authorization
model turns started: 1; role turns used: leadPlan=1 changeAuthor=0 freshReview=0 leadAdjudication=0
turn O5.5B21-LEAD:leadPlan#1: completed; contract accepted; terminal classification=RESULT_OK resultSubtype=success terminalReason=completed isError=false internalTurnCount=6 permissionDenialCount=0 resultTextPresent=true resultTextByteLength=784 structuredParsingReached=true schemaValidationReached=true processExitCode=0
reply envelope O5.5B21-LEAD:leadPlan#1: classification=SINGLE_FENCED_VALID_JSON accepted=true policy=rawOrSingleJsonFence bodyMatchesExpectedSchema=true
```

## 3. Independent validation

**78 checks, 0 failed.** The evidence SHA-256 is `c37ae087438580830f782ea47173e6922d03191c957fe2f75605307174a2054c`.
- **Identity:** the harness identity equals the Stage-1 snapshot; the budget and grants equal the compiled `O5.5B21-LEAD`; the fixture digest equals the pin.
- **One run:** one marker, one claim, one ledger line (`leadPlan #1`), and no preflight file.
- **Preflight (O5.5B20):**
  - the Lead is active, on 2.1.280 validated and authorized, billing clear, `subscriptionToken`, binding equal to the grant, eligible on the `readOnly` surface;
  - the Worker and the Muse Reviewer are `notRequired` (budget 0, never inspected);
  - review routing was deferred.
- **The turn:**
  - `completed`, no error, **contract `accepted`**;
  - one model process in the baseline view;
  - provenance `claude` / `claude-one-shot`, requested `haiku`, observed `claude-haiku-4-5-20251001`, effort `low`.
- **Reply envelope:** the structure-only diagnostic re-validates.
  - `SINGLE_FENCED_VALID_JSON`, a json fence, whitespace only outside, no extra text, one fence pair;
  - the body is a strict JSON object and **matches the expected schema**;
  - `accepted` under `rawOrSingleJsonFence`; 784 bytes, equal to the terminal diagnostic's byte length.
- **Terminal diagnostic:** exactly as reported, and it re-validates. The 2.1.280 protocol labels, 6 internal turns within `--max-turns 6`, exit 0 in both the diagnostic and the launch settlement.
- **Processes:** 6, all `claude.exe` in the baseline view.
  - Counts: auth 2, inventory 1, init probes 2, turn 1.
  - The model launch's posture and identity pairs are exact; no forbidden flag.
  - No Worker or Reviewer process, and no launch refused.
- **The designed stop:**
  - the engine planned, acquired the attempt's candidate, delegated, and then the Worker's `createSession` was refused (the only refusal);
  - the one host-side candidate was created and released (proven gone);
  - no proposal, verification or review happened.
- **Integrity:**
  - primary `36e70675…29ad` equal before and after, and recomputed now, read-only;
  - canaries byte-identical;
  - the view unchanged over every observation and released;
  - no temporaries; containers 0 → 0.
- **Redaction:** no prompt, delegation, task text, fence, canary, token or env name, profile path, result text or stderr is in the evidence.

## 4. What is proven, exactly

**The real Claude Lead contract passes for this exact binding, prompt and envelope:** Claude Code 2.1.280, `haiku` → `claude-haiku-4-5-20251001`, effort `low`, `--max-turns 6`, the O5.5B16 planning prompt, and the O5.5B18 Lead envelope.

The live history of that binding:

| Run | What changed | Result |
| --- | --- | --- |
| O5.5B15 | generic prompt | `RESULT_ERROR_MAX_TURNS`, no reply |
| O5.5B17 | planning prompt | reply present, fence refused by the raw-only envelope |
| O5.5B21 | planning prompt + single-fence envelope | **PASS** |

**Not proven:**
- a full-route result;
- a Change Author inside the route, a real fresh Reviewer, real adjudication or a correction;
- any other model, effort, version or turn limit;
- more than a single sample on one fixture.

## 5. Stage-2 changes

- **`src/providers/probe-profiles.ts`:** `O5.5B21-LEAD` → `consumed`.
- **`src/runtime/provider-profiles.ts`:**
  - `LeadPlanLiveRecord` gains an optional `replyEnvelope`, holding the policy, class and whether it was accepted.
  - O5.5B21 is recorded as `outcome PASS`, `modelTurn PASS`, `planningLead`, route `TURN_REFUSED`, envelope `rawOrSingleJsonFence` / `SINGLE_FENCED_VALID_JSON` / accepted, with the terminal fields and the evidence SHA-256.
  - The O5.5B15 and O5.5B17 records are unchanged.
- **`src/app/writer-gate.ts`:** one provider-neutral `writerPosture` sentence. No row changes.
- **Tests:** `test/o5-5b21-lead-live-record.test.ts` (3):
  - the full Lead history, the O5.5B17-vs-O5.5B21 envelope A/B, and the unchanged O5.5B19 block and full-route coverage;
  - readiness unchanged;
  - the consumed identity refused.

  Earlier milestones' history assertions now check their own prefix of the history, and the Stage-1 tests were updated for the consumed state.

## 6. Readiness

Unchanged:

| Gate | State |
| --- | --- |
| providerChangeProposal | satisfied (recordedLiveProbe) |
| fullRouteLive | blocked: 1 run (O5.5B13), 0 passed |
| hostControlledWriterWorkflow | partial |
| liveGateAuthorization | blocked |

## 7. Next

- **O5.5B22 (offline):** Claude Lead **adjudication** is still raw-only, while every observed live Claude structured reply has been fenced. Harden it to the same narrow envelope before any full-route run.
- **After that:** the full route needs a validated Muse Reviewer, and the installed 1.4.0-R4161.1 is not validated (see the O5.5B22 report).
