# O5.5B13 — Authorized full-route live proof (FAILED at the Lead plan)

Labels: **LIVE-OBSERVED** (recorded from the one authorized real run, validated independently), **MECHANICALLY ENFORCED** (code plus deterministic tests), **FAKE-PROCESS PROVEN** (real adapter code against deterministic fake native binaries), **NOT RUN**, **NOT PROVEN**.

Outcome in one line: the one human-authorized full-route live rehearsal ran once, from a normal PowerShell window, and ended **PROVIDER_FAILED at its first turn, the Lead plan** (`leadPlan #1`), after exactly **one** real model turn. The Claude CLI returned a well-formed result frame marking the turn as not successful and exited 1. Which failure field was set was **not retained** (by design: no raw provider output is persisted).
- **Never ran:** no Change Author, Reviewer, adjudication, correction or confined verification.
- **Integrity:** the primary fixture, its ignored canaries and the provider view are unchanged, and cleanup is complete (0 → 0 Fusion containers).
- **Authorization:** `O5.5B13-LIVE` is **consumed**. There was no retry.
- **Unaffected evidence:** the isolated live Change Author PASSes of O5.5B9 (Muse) and O5.5B11 (Claude) stand unchanged.
- **Gates:** readiness moved only by a new, **blocked** `fullRouteLive` row. The live Writer gate stays closed.

## 1. Starting state

- **Branch and HEAD:** branch `o5-5b13-full-route-live-proof`, HEAD `7b7b26f` (O5.5B12), clean tree, verified before Stage 1.
- **Stage-2 start:** the same branch and HEAD. The working tree was exactly the Stage-1 set: the patch SHA-256 `c3a46058…8130` and per-file sums were recorded before the live run and re-verified.
- **Already in place (O5.5B12):**
  - the full-route harness: route authorization, turn gate, pre-launch guard, per-role preflight and evidence;
  - its pending plan `O5.5B12-LIVE`.

## 2. The exact human authorization

In their own words, the human authorized **one** bounded full-route live rehearsal on the O5.5B12 throw-away quotes fixture, with at most 7 real model turns:

| Turn class | Max | Provider / version | Model | Effort / condition |
| --- | --- | --- | --- | --- |
| Lead plan | 1 | Claude Code 2.1.280 | `haiku` (`claude-haiku-4-5-20251001`) | low |
| Change Author | 2 | Claude Code 2.1.280 | `haiku` | low; the 2nd only after a mechanical retry/correction |
| Fresh Reviewer | 2 | Muse 1.3.0-R3401.1 | `muse-spark-1.3` | low; internal retry off |
| Lead adjudication | 2 | Claude Code 2.1.280 | `haiku` | low; only when findings exist |

**Allowed:**
- one networked dependency preparation of the fixture's locked npm packages;
- confined Docker/Linux verification;
- host-controlled application into private candidates.

**Forbidden:**
- a second run; retries or extra calls;
- a model or provider fallback; Opus or high effort; Claude 2.1.281; another Muse version;
- API-key or pay-as-you-go (PAYG) fallback;
- real project access;
- provider write, shell or web tools;
- any change to the primary;
- delivery, merge or push;
- opening the live Writer gate.

A failed, malformed, timed-out or blocked turn consumes its slot.

## 3. What Stage 1 added (offline, no provider call)

- **`O5.5B13-LIVE`** (`src/providers/probe-profiles.ts`): a new, one-shot route authorization with exactly the O5.5B12 plan, the same frozen roles and turn budget, and its own namespace `%TEMP%\fusion-o5-5b13-route`. `O5.5B12-LIVE` stays pending forever.
- **Per-process model identity** (`turnArgs`, `turnIdentityGaps`): before any model process of a role starts, its argv must carry each authorized pair exactly once, in the separate form, with exactly the authorized value (Claude `--model haiku --effort low --max-turns 6`; Muse `--model muse-spark-1.3 --reasoning-effort low --max-model-steps 4`). Otherwise the turn stops `MODEL_BLOCKED` and its slot is consumed. A repeated flag or a `--flag=value` spelling is refused, because a later value could win.
- **Pinned fixture** (`fixtureSha256`, `routeFixtureIdentity()`): SHA-256 over every fixture file, the canaries, the confined plan, the task and the packet, which is `59c19d1f…8326`. A different fixture is refused before anything exists.
- **Claude `--fallback-model`** is a widening flag for every Claude model process, whether in a route or a probe.
- **Composition:** a route role served by another adapter kind than its authorized one is refused before the claim.
- **Evidence:** a `runId` and `unusedSlots`; per turn, its claim identity (`<authorization>:<turn>#<slot>`) and its contract outcome (what Fusion decided, labels only); per model launch, its `identityGaps`.
- **Live entry wording:** after a preflight block it now says "Do NOT re-run: return this output for review first".
- **Tests:** 9 deterministic tests (`test/o5-5b13-live-authorization.test.ts`, `test/o5-5b13-route-proof.test.ts`). In them, the production authorization only ever ran against a registry without adapters, and the live entry was never started with it.

## 4. Stage-1 validation and harness identity

- **Suite:** 637 tests, 636 passed, 1 pre-existing skip (symlink creation is unavailable on this Windows account). Build and `git diff --check` were clean.
- **Namespace:** `%TEMP%\fusion-o5-5b13-route` did not exist before the human's run.
- **Recorded harness identity (compiled `dist`):**
  - `compiledSourceSha256 c68d8dab55fac1a7fbfbb364c6767acbc913c99a07b5b37d346e0c90d3faeb53`;
  - `compiledFiles 102`;
  - `liveEntrySha256 bba8d65018de959c407d1c8258c7c68099002cd3822708d08e7aa8cb2e83a030`.

## 5. The live command, consumed once

Run by the human, once, from a new normal PowerShell window after the documented checks: branch; variable names only; `npm run build`; `FUSION_CLAUDE_EXE` set to the side-by-side 2.1.280; `DISABLE_AUTOUPDATER=1`; the Claude version check; the Muse `.muse-version` check; Docker server OS.

```powershell
node dist/test/live/route-rehearsal.js --authorization O5.5B13-LIVE
```

The human reported that no second run was attempted. Nothing in this session started a provider process.

## 6. Human-observed result

```
O5.5B13 full-route rehearsal: PROVIDER_FAILED
detail: leadPlan #1 (Lead): providerFailure: Claude reported a failed turn.
stage: workflow; evidence kind: liveProvider; model turns started: 1
role turns used: leadPlan=1 changeAuthor=0 freshReview=0 leadAdjudication=0
provider processes started: providerAuthReadback=2 providerInventory=1 providerInitProbe=2 providerTurn=1 providerHost=0
```

The human's preflight observations:
- the branch was correct;
- Claude Code was exactly 2.1.280 and Muse exactly 1.3.0-R3401.1;
- the Docker server OS was linux;
- the variable names showed `CLAUDE_CODE_OAUTH_TOKEN` and no `ANTHROPIC_API_KEY`;
- there were 0 Fusion-owned containers before and 0 after;
- `git status` after the run showed the same Stage-1 set.

## 7. The evidence namespace

`%TEMP%\fusion-o5-5b13-route` holds exactly:
- `authorization.json` (the marker);
- `route.claim.json`;
- `route.turns.jsonl`;
- `route.evidence.json` (14 627 bytes, SHA-256 `e035d457100ddb2a0aaa032a1efc21c88311966509c0deb50fb10027101a6313`);
- the fixture directory `route-fixture-fd49725b06fb/primary`.

There is no `route.preflight-*.json`, so the run passed preflight exactly once. The namespace was only read in Stage 2. It was not deleted or reset.

## 8. Independent evidence validation

The validator is a separate script (not the harness). It reads the namespace, imports the compiled production data (profiles, fixture identity, posture rules) and re-derives facts. It recomputes the primary fingerprint with `git --no-optional-locks`, so nothing is written. Result: **86 checks, 0 failed.** In summary:
- **Identity:**
  - the harness identity equals the Stage-1 snapshot;
  - the schema, kind, milestone and `liveProvider` label are correct;
  - the recorded turn budget and role grants equal the compiled `O5.5B13-LIVE`;
  - the fixture digest equals the pin and the recomputed digest.
- **One run:**
  - the marker is exact;
  - there is one claim, written after the start and before the end, with the exact fields;
  - the ledger holds exactly one line, `leadPlan #1 (Lead)`, written after the claim;
  - there is no preflight file.
- **Outcome and preflight:**
  - `PROVIDER_FAILED`, stage `workflow`, with the exact detail and the transitions `received>inspected>routed>planning>failed:providerFailure`;
  - every role's preflight shows the installed, validated and authorized versions, billing clear, an authorized lane, the binding equal to the grant, eligibility, and `FUSION_CLAUDE_EXE` set (by name only).
- **Turns and processes:**
  - one turn, with `modelProcesses 1`, the baseline view only, contract `notReached:failed` and structured output `null`;
  - turn use `{1,0,0,0}` and unused slots `{0,2,2,2}`;
  - no refusals;
  - 6 launches, all `claude.exe` in the baseline view: no Muse process, no forbidden variable, no primary argument;
  - the model launch's read-only posture, recomputed from the compiled rules, is complete and non-widening, and its identity pairs are present exactly once.
- **Integrity and redaction:**
  - the primary, canaries, view and cleanup checks of §23–§26 pass;
  - the evidence holds no prompt, delegation, task text, fence, canary value, token prefix, credential variable name, user-profile path, result text or stderr.
- **Code path:** the message "Claude reported a failed turn." has exactly one origin in the compiled harness (§16).

## 9. Authorization and claim

| Fact | Evidence |
| --- | --- |
| Authorization | `O5.5B13-LIVE`, milestone `O5.5B13` (marker, claim, ledger and evidence agree) |
| Claim | one; `claimedAt 2026-09-25T00:04:26.050Z` (run started `00:04:14.748Z`, ended ≈ `00:05:08.6Z`); `evidenceKind liveProvider` |
| Consumed | yes: the claim exists, and `O5.5B13-LIVE` is now `consumed` in code (a second run refuses with `authorizationConsumed`, or `alreadyAttempted` by its claim) |
| Replay / reuse | no earlier claim (O5.5B9, O5.5B11, O5.5B12) was used; each is refused as a foreign namespace (tests) |

## 10. Model turns consumed

Exactly **one** real model turn, `O5.5B13-LIVE:leadPlan#1`, by the Lead. Its slot was durably consumed (`route.turns.jsonl`, `00:04:27.932Z`) before the provider was reached. Unused slots are Change Author 2, fresh Reviewer 2 and Lead adjudication 2. Optional turns that did not run are not counted. The 7-turn budget was never approached.

## 11. Provider processes

| Purpose | Count | Settlement |
| --- | --- | --- |
| providerAuthReadback (`claude auth status`) | 2 (session setup + turn) | exit 0 |
| providerInventory (`claude plugin list --json`) | 1 | exit 0 |
| providerInitProbe (init-only startups of the plugin quarantine) | 2 | exit 1, `killReason protocolError`: Fusion cancels each probe after reading its init frame. The O5.5B11 **PASS** evidence shows exactly the same two settlements, so this is the normal path |
| providerTurn (the Lead plan) | 1 | **exit 1**, not killed (no timeout, cancel or protocol kill) |
| providerHost | 0 | — |

Every process was `claude.exe` in the Fusion-owned baseline view. No process of the Reviewer's family started.

## 12. Claude runtime, model, effort and auth

The runtime readback comes from the failed turn's own init frame (`source: initOfFailedTurn`):
- **Runtime version:** `2.1.280`.
- **Model:** requested `haiku`, effective `claude-haiku-4-5-20251001` (the canonical model was verified before any output was accepted).
- **Effort:** `low` (argv).
- **Credential source:** `apiKeySource: none`, so no API key or PAYG route.
- **Auth readback:** `authenticated`, lane `subscriptionToken`, evidence `auth-status:firstParty:explicitOAuthToken:sourceFieldAbsent`.
- **BillingGuard:** clear.

## 13. Lead workspace and posture

- **Workspace:**
  - The working directory was the Fusion-owned **baseline view** (`providerView:baseline`) for all 6 processes.
  - The view checks all hold: owned location, disjoint from the primary, no `.git`, no provider state.
  - No argument names the primary, and the primary was never a working directory.
- **Posture flags:** `--tools Read,Grep,Glob`, `--permission-mode dontAsk`, `--permission-prompts none`, `--restricted`, `--safe-mode`, `--strict-mcp-config`, `--disable-slash-commands`, `--no-session-persistence`, `--include-hook-events`.
- **Absent:** no widening flag and no `--fallback-model`.
- **Init readback:** `dontAsk`, tools exactly `Glob, Grep, Read`, 0 MCP servers. There was no write, shell or web tool.

## 14. What the failure is — evidence-supported classification

The transport's failure checks run in a fixed order (`src/providers/claude/one-shot-transport.ts`). Reaching "Claude reported a failed turn." proves that each earlier check passed:
- **Init frame:** it was present, first, and verified (version, model, posture, credential source). An init failure would have stopped the turn early with another message.
- **Stream conditions:** no early stop for a malformed stream, extension or hook activity, authentication rejection (`401`), overage or rate limit (`429`/rejected).
- **Process conditions:** no timeout, cancellation, spawn failure, output-limit or stream error, and no invalid or truncated stream.
- **Result frame:** it **existed** (otherwise the message would be "Claude ended without initialization and result evidence").
- **The flag that fired:** `ClaudeStream.semanticError` was **true**. It is defined as `result.is_error === true || result.terminal_reason !== "completed" || result.subtype !== "success"`.

**Narrowest supported class: C, "the result frame reported failure".** The CLI emitted a well-formed result frame marking the turn not successful, and the process exited 1. Exit 1 (A) is observed but is a consequence: the transport classifies on the result frame before the exit code.

## 15. Classes considered

| Class | Verdict | Why |
| --- | --- | --- |
| A. Non-zero exit | Observed (exit 1) | Consequence; not the classifying fact |
| B. Explicit provider error in the stream | Excluded for auth (401), rate limit (429/rejected) and overage; any other error would sit inside the result frame (C) | Those are checked before and would produce other messages |
| **C. Result frame reported failure** | **Supported** | The only origin of the message (§16) |
| D. No result frame | Excluded | That path has a different message |
| E. Malformed structured Lead output | Excluded | The reply was never parsed (`structuredOutput: null`; `stream.packet()` runs only after the success checks) |
| F. Lead plan schema failure | Excluded | Never reached |
| G. Effective model mismatch | Excluded | Init model verified equal to `claude-haiku-4-5-20251001`; an assistant-frame mismatch would be a malformed stream (early ProtocolError) |
| H. Auth failure | Excluded | Auth readback authenticated (subscriptionToken), `apiKeySource none`, no 401 |
| I. Version or posture guard | Excluded | No turn or launch refusal; posture recomputed complete; identity gaps empty |
| J. Timeout / cancellation | Excluded | No `killReason`; turn 40.3 s ≪ 180 s deadline; not cancelled |
| K. Max-turn exhaustion | **Possible, NOT PROVEN** | `subtype: error_max_turns` would set `semanticError`; the subtype was not retained |
| L. Unsupported tool / permission state | Posture at init excluded; denials inside the turn **unknown** | Permission denials of a turn were not retained |
| M. Other | Also possible within C | For example an execution error (`error_during_execution`) or another non-`completed` terminal reason |

## 16. The code path, verified

- **Single origin:** in the compiled harness the string occurs exactly once, in `dist/src/providers/claude/one-shot-transport.js`, as `if (stream.semanticError) fail("ProcessFailure", "Claude reported a failed turn.")`. No other file emits it.
- **Engine mapping:** the engine turns that `ProcessFailure` into `planning>failed:providerFailure`, which the route classifies as `PROVIDER_FAILED` at the failed turn.
- **Offline reproduction:** a deterministic test (`test/o5-5b13-live-record.test.ts`) runs a scripted Lead whose result frame reports failure. It ends exactly as the live run did: the same detail, turn use, unused slots, process counts per purpose, transitions, `initOfFailedTurn` readback, `notReached:failed` contract, released view, unchanged primary, no candidate, and no later role. The only difference is that the fake exits 0 where the real CLI exited 1. The transport checks the result frame first, so the classification is the same.

## 17. Was the Lead's output parsed or validated?

- **Structured parsing:** **not reached**. `packet()` → `json()` runs only after the success checks; `structuredOutput: null`, `observedModel: null`, no provenance.
- **Lead plan schema validation:** **not reached**.
- **Content:** no reply content exists anywhere in the evidence, by design.

## 18. Diagnostic limitations (exactly what is not known)

The evidence contract deliberately keeps no raw provider output. For the result frame it therefore does not retain:
- which of `is_error`, `subtype` and `terminal_reason` caused `semanticError`;
- the agentic turn count (`num_turns`);
- the permission denials;
- usage;
- whether result text existed, or its size.

It also keeps no stderr. The evidence **cannot** distinguish turn-budget exhaustion from an execution error or another failed terminal reason. **The only supported statement is that the CLI reported a failed turn in a well-formed result frame and exited 1.**

## 19. Hypotheses to test next (NOT PROVEN, not used for any decision)

1. **Agentic-turn budget:** the plan turn ran with `--max-turns 6` and read-only tools; exhausting it yields a failed result (`error_max_turns`). The evidence is consistent with this (exit 1, a 40.3 s turn including setup) but does not show it.
2. **Plan contract:**
   - **The Fusion fact (verified in the code):** the Lead's plan turn receives the generic delegation-packet prompt, which begins "Complete this delegated task within its scope" and asks for a ResultPacket. That is the same instruction a delegate gets, sent to a read-only session for a task that requires writing files.
   - **Unknown:** whether this contributed.
   - **Why the fakes never showed it:** they answer any prompt.
3. **Another CLI execution error** reported in the result frame.

## 20. Roles after the Lead

| Role / step | Status | Evidence |
| --- | --- | --- |
| Change Author (in the route) | **NOT RUN** | `changeAuthor` slots 0/2 used; no proposal; Worker readback `null` |
| Fresh Reviewer | **NOT RUN** | 0/2; no Muse process (`providerHost 0`, no `muse-bin` launch) |
| Lead adjudication | **NOT RUN** | 0/2; no findings |
| Bounded correction | **NOT RUN** | no retry transition |
| Confined verification (candidate) | **NOT RUN** | no candidate; `verification.events: []`, `runs: []` |
| Dependency preparation (npm) | **NOT RUN** | it runs only inside a candidate's verification (`VerificationService.verify`) |

The confined backend's acceptance was granted in-process at composition. That is an acceptance check, not a candidate verification.

## 21. Primary before and after

- **Digest:** `305de7355d7d…3536` both before and after (85 entries, fixture HEAD `c6e126fa3ef5…`). Recomputed independently in Stage 2, read-only, it is the same digest, HEAD and entry count.
- **Git status:** only the two ignored canaries (`!! .env`, `!! secrets.local`).

## 22. Ignored canaries

`canariesUnchanged: true`. In Stage 2 both canary files were compared byte for byte (by SHA-256) against the fixture's canary definitions, and both are identical.

## 23. Provider view before and after

- **Views:** one view, the baseline. All four checks hold, and 3 fingerprint observations are all equal (`unchanged: true`).
- **Release:** `released: complete` (`providerViews: created 1, released 1, complete`).
- **Candidate views:** none were created, because no candidate existed.

## 24. Cleanup

- **Temporaries:** `leftoverOwnedTemporaries: []` (2 attributed temporaries, both gone). Stage 2 found no Fusion-owned temporary from the run's time window left in `%TEMP%`; the plugin-settings directory is gone.
- **Containers:** Fusion-owned containers 0 → 0 (recorded, and observed by the human with `docker ps`).
- **Fixture:** the fixture primary stays inside the evidence namespace as evidence, as designed.

## 25. What was persisted

Only labels, counts, digests and redacted argv (`%TEMP%`-relative).
- **Environment:** a key count only (`envKeyCount`), no names or values.
- **Auth:** labels only.
- **Never persisted:** prompt, reply, result text, stderr, transcript, hidden reasoning, credentials, secret values or source content. The validator checked this against the file (§8).

## 26. Why no retry was performed

The authorization was one run, and a failed turn consumes its slot. The Lead plan slot was the only one of its class, the engine does not retry a plan, and the human was told never to re-run. A retry would be a second route run under a consumed identity: the claim refuses it (`alreadyAttempted`) and so does the state (`authorizationConsumed`). Nothing here called any provider.

## 27. Stage-2 changes

- **`src/providers/probe-profiles.ts`:** `O5.5B13-LIVE` → `consumed`, with the result in its comment.
- **`src/runtime/provider-profiles.ts`:** `FullRouteLiveRecord`, `fullRouteLiveRecords()` and `fullRouteLiveCoverage()`, holding one static record:
  - the O5.5B13 run: `PROVIDER_FAILED`, ended at `leadPlan#1`, 1 model turn;
  - Lead FAIL; Change Author, Reviewer, adjudication, correction and confined verification NOT_RUN;
  - integrity true;
  - the evidence SHA-256 and this document.

  This is history: the change-proposal records are untouched.
- **`src/app/writer-gate.ts`:**
  - new row `fullRouteLive`: **blocked** (`recordedLiveProbe`), reading only the coverage counts; its provider-neutral text reads "1 run, 0 passed … ended PROVIDER_FAILED at leadPlan#1 after 1 model turn(s), 1 of 3 roles run";
  - the `writerPosture` prerequisite text now states the failed live attempt;
  - `fullRouteRehearsalImplementation`'s blocker now points at `fullRouteLive`.
- **No implementation fix:** the evidence reveals no defect in the Lead invocation, only a failed result that is not retained (§18–§19).

## 28. Tests

13 O5.5B13 tests: 9 from Stage 1 (three had assertions updated for the consumed state: the authorization data, the refusals, which now run their open-path checks on an in-memory open copy, and the live entry's listing) and 4 new Stage-2 tests in `test/o5-5b13-live-record.test.ts`:
- the record itself;
- readiness: the new row blocked; `providerChangeProposal` still satisfied, with both families' live PASS history unchanged; `hostControlledWriterWorkflow` still partial; no forged input moves a row;
- the consumed production identity refused with no nested-session variable, and no open route or proposal authorization;
- the offline reproduction (§16).

Two O5.5B12 assertions changed: the authorization key list now includes `O5.5B13-LIVE` (Stage 1), and one assertion label now reads "no live full route has passed".

## 29. Final regression (offline, no provider call)

Suites run: the focused O5.5B13 (13), O5.5B12 (23), O5.5B11, O5.5B10 and O5.5B9 suites; the Claude, Muse, BillingGuard/auth, provider-view, ChangeSet, Writer workflow, verification/Docker (deterministic), review/adjudication and readiness suites; `npm test` twice; `npm run build`; `git diff --check`. Results are in the milestone report. Each `npm test` run: **641 tests, 640 pass, 1 skip** (symlink creation is unavailable on this Windows account).

## 30. Security self-review

- **Execution:**
  - no second route execution;
  - no provider, model or network call in Stage 2 (the validator reads files and runs local `git --no-optional-locks`);
  - no retry;
  - no authorization reopened: `O5.5B13-LIVE` is consumed, `O5.5B12-LIVE` pending, O5.5B9 and O5.5B11 consumed.
- **Data:**
  - no raw provider output or credential persisted;
  - no evidence namespace deleted or modified (hashes compared before and after the test runs).
- **Integrity:**
  - no primary mutation and no view mutation;
  - no lingering candidate, view or container.
- **Labels and gates:**
  - fake and live evidence stay separate: the reproduction is labelled `offlineRehearsal`, and the gate reads only the static record;
  - no readiness overclaim: `fullRouteLive` is blocked and `hostControlledWriterWorkflow` stays partial/fake;
  - no downgrade of the isolated Change Author PASS evidence;
  - the live gate is still the constant `false`.

## 31. Readiness table

| Gate | State (evidence) after O5.5B13 |
| --- | --- |
| primaryProtection | partial (mechanical); live: unchanged across one real Lead turn |
| providerWorkspaceBoundary | partial (fakeProcess); live: the real Lead CLI ran only in its baseline view |
| ignoredPathProtection | partial (mechanical); live: canaries unchanged |
| hostControlledApplication | satisfied (mechanical) |
| hostControlledWriterWorkflow | **partial (fakeProviderRehearsal)**: no live route has passed |
| fullRouteRehearsalImplementation | satisfied (fakeProcess) |
| **fullRouteLive (new)** | **blocked (recordedLiveProbe)**: 1 run, 0 passed |
| productionWriterComposition | satisfied (mechanical) |
| providerChangeProposalImplementation | satisfied (fakeProcess) |
| structuredOutputEnvelope | satisfied (fakeProcess) |
| providerChangeProposal | **satisfied (recordedLiveProbe)**: preserved |
| verificationIsolation | notEvaluated statically; satisfiedForLinuxScope per process |
| platformCompatibility | satisfied (mechanical) |
| dependencySupport | partial (mechanical) |
| cleanupAndRecovery | satisfied (mechanical) |
| reviewAndAdjudication | satisfied (mechanical) |
| billingAndAuthPosture | satisfied (mechanical) |
| sharedGitAndIgnoredPaths | partial (mechanical) |
| liveGateAuthorization | blocked |

PROVIDER_CHANGE_PROPOSAL_READINESS **YES**. HOST_CONTROLLED_WRITER_WORKFLOW_READINESS **NO**. REAL_WRITER_MODE_READINESS **NO**. O5_5B_READINESS **NO**. O6_READINESS **NO**. REAL_WRITER_LIVE_GATE_AUTHORIZED **NO**.

## 32. What remains proven, and the next milestone

- **Still proven (separately, unchanged):**
  - O5.5B9: Muse Exec 1.3.0-R3401.1, `muse-spark-1.3`/minimal, a live change proposal PASS (validated, host-applied, confined 3/3).
  - O5.5B11: Claude 2.1.280 haiku/low, a live change proposal PASS on the same kind of path.
  - These isolated Worker-only proposals are unaffected: the failed route never reached its Change Author.
- **Newly observed live (O5.5B13):** from the real Lead turn's init frame, in a real multi-role route composition:
  - the pinned runtime, canonical model, subscription token lane, `apiKeySource none`, and exact read-only tool posture;
  - view confinement of every process;
  - an unchanged primary and canaries;
  - complete cleanup.
- **Recommended next milestone: O5.5B14, Lead live-path diagnostics.** Offline, no provider call, live authorization closed.
  1. Add **metadata-safe** result diagnostics to the Claude stream and the route turn evidence:
     - the result `subtype` and `terminal_reason` as allowlisted labels (else `other`);
     - `is_error`;
     - the agentic turn count;
     - the permission-denial count;
     - whether result text existed, and its byte length;
     - the `api_error_status` class;
     - the process exit code.

     Never text, stderr or reasons.
  2. Reproduce deterministically with fake result frames (`error_max_turns`, `error_during_execution`, non-`completed` terminal reasons) and prove that the evidence now distinguishes them.
  3. Review the Lead plan contract (§19, hypothesis 2) and document it. Change the plan prompt or turn budget only as a separate, explicitly approved decision, because the cause is unknown.
  4. Keep every live authorization closed.

  Only after that, a **new** explicit human authorization, preferably for a single Lead-plan live turn first (the smallest live step), before any new full-route run.

## Decision

FULL_ROUTE_LIVE_REHEARSAL: **FAIL** (PROVIDER_FAILED at `leadPlan #1`, 1 model turn). REAL_LEAD_LIVE: **FAIL**. Every later role: **NOT RUN**. The primary and provider views are unchanged. The authorization is consumed, and nothing was retried.
