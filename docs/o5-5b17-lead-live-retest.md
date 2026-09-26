# O5.5B17 — One authorized Claude Lead retest (planning prompt)

Labels: **LIVE-OBSERVED** (the one authorized real turn, validated independently), **MECHANICALLY ENFORCED**, **FAKE-PROCESS PROVEN**, **NOT PROVEN**.

Outcome in one line: under the O5.5B16 planning prompt, and otherwise identical to O5.5B15, the real Lead's **model turn succeeded**:
- `RESULT_OK` (`success` / `completed`), 6 internal turns within the same `--max-turns 6`, exit 0, a 637-byte reply.

But the **Lead contract failed**:
- the reply was exactly **one fenced JSON object** (`SINGLE_FENCED_VALID_JSON`);
- the Lead's packet envelope is **raw-only**, so Fusion refused it (`MALFORMED_OUTPUT`) before its ResultPacket check ran.

Everything else:
- **Nothing after the Lead** ran.
- **Integrity:** primary and view unchanged, cleanup complete.
- **Authorization:** `O5.5B17-LEAD` is consumed.
- **Unchanged:** the O5.5B13 and O5.5B15 FAIL records and every readiness row.

## 1. Starting state

- **Stage 1:** branch `o5-5b17-lead-live-retest`, HEAD `f8dbf7c` (O5.5B16), clean tree.
- **Stage 2:** the same branch and HEAD. The working tree equalled the Stage-1 snapshot (patch SHA-256 `0f6bf470…035b`).

## 2. The authorization and the A/B design

- **Authorized:** exactly one real Claude Lead-plan turn, run by the human from a normal PowerShell window: Claude Code 2.1.280, haiku / `claude-haiku-4-5-20251001`, effort `low`, `--max-turns 6`, the O5.5B15 fixture, the subscription/OAuth lane, read-only, with no write, shell or web tools.
- **Forbidden:** every other role, retries, Muse, fallbacks, Claude 2.1.281, API-key/PAYG, real projects, mutation, delivery, and the live gate.
- **`O5.5B17-LEAD`:** identical to `O5.5B15-LEAD` except for milestone, namespace and state (a test asserts this): budget `{ leadPlan: 1, others 0 }`, the same grants, fixture pin and diagnostics.
- **The only variable:** the Lead plan instruction.
  - O5.5B15: the generic delegated-task wording.
  - O5.5B17: the O5.5B16 planning contract (`LEAD_PLAN_INSTRUCTION`, SHA-256 `59d3aed7…1387`). It was compiled into the Stage-1 harness whose identity the evidence carries.

## 3. Stage 1 (offline)

- **Changes:** `O5.5B17-LEAD` added (sharing `LEAD_ONLY_TURNS` with O5.5B15), and the live entry header updated.
- **Tests:** 7 deterministic tests, and the O5.5B12–B16 tests made tolerant of the new identity.
- **Validation:** focused suites passed; full suite 681 tests, 680 passed, 1 skip (symlink creation is unavailable on this Windows account); build and `git diff --check` clean.
- **Harness identity:** `compiledSourceSha256 7d380c6d…bb6b` (105 files), `liveEntrySha256 e2f72472…ba50`.

## 4. The live run

- **The command, run once by the human:** `node dist/test/live/route-rehearsal.js --authorization O5.5B17-LEAD`.
- **Reported:** `MALFORMED_OUTPUT`, with detail "leadPlan #1 (Lead): Claude structured output was refused: SINGLE_FENCED_VALID_JSON under the rawOnly envelope."
- **Turn use:** leadPlan 1, others 0.
- **Processes:** auth readback 2, inventory 1, init probes 2, model turn 1, Muse host 0.
- **Integrity:** no Fusion-owned container remained, and the repository still held only the Stage-1 set.

## 5. Independent validation

**78 checks, 0 failed.** The evidence SHA-256 is `86ad482dcfacfb0eec56eab82cecbccfe82a1be1254357bb5943ec7ef18b9c85`.
- **Identity:** the harness identity equals the Stage-1 snapshot; the budget and grants equal the compiled `O5.5B17-LEAD`; the fixture digest equals the pin.
- **One run:** one marker, one claim, one ledger line (`leadPlan #1`), and no preflight file.
- **Outcome:** `MALFORMED_OUTPUT` at stage `workflow`, with the exact detail and transitions `…planning>failed:malformedResult`. The error kind is `MalformedOutput`; there were no turn or launch refusals.
- **The one turn:** `O5.5B17-LEAD:leadPlan#1`, failed with `MalformedOutput`, contract `notReached:failed`; one model process in the baseline view.
- **Terminal diagnostic:** exactly as reported, and it re-validates unchanged.
- **Processes:** 6, all `claude.exe` in the baseline view: 1 discovery startup plus 1 quarantine round (it converged at once). The posture and identity pairs are exact (`--model haiku`, `--effort low`, `--max-turns 6`), and no forbidden flag is present.
- **Init readback:** 2.1.280, `claude-haiku-4-5-20251001`, `apiKeySource none`, `dontAsk`, tools `Glob, Grep, Read`, 0 MCP, the subscription token. The Worker and Reviewer never started.
- **Integrity:**
  - primary `abc25298…977b` equal before and after, and recomputed now, read-only;
  - canaries byte-identical; git status shows only the ignored canaries;
  - view unchanged and released; no temporaries; containers 0 → 0.
- **Redaction:** the evidence holds no prompt, delegation, task text, fence, canary, token or env name, profile path, result text or stderr.

**Environmental finding (after the validation above):** a later re-check found each kept evidence fixture (O5.5B13, O5.5B15, O5.5B17) with 82 instead of 85 entries.
- **What changed:** three **empty** git directories were gone: `.git/objects/info`, `.git/objects/pack` and `.git/refs/tags`.
- **What did not change:** every one of the 15 fixture files and canaries is byte-identical to the fixture definition in all three, and the evidence files hash exactly as recorded.
- **When:** the directories' modification times are 07:04:26 (O5.5B13) and 13:14:24 (O5.5B15 and O5.5B17, the same second). That is hours after the runs, and outside anything Fusion does. No Fusion code removes directories in another namespace; its only `%TEMP%` scan is detection-only.
- **Likely cause:** an outside process sweeping empty directories under `%TEMP%`, with drive C: at 100 %.
- **Effect on the tests:** the same sweep hit an `npm test` run in progress (10 transient "primary fixture changed" failures); an immediate rerun was clean.
- **Effect on the evidence:** the recorded before/after digests were computed during the runs and remain equal. A post-hoc recomputation of the primary digest can no longer match, and should be read with this in mind.

## 6. The terminal diagnostic (LIVE-OBSERVED)

| Field | Value |
| --- | --- |
| classification | **RESULT_OK** |
| resultSubtype / terminalReason | `success` / `completed` |
| isError | false |
| internalTurnCount | **6** (O5.5B15: 7) |
| permissionDenialCount | 0 |
| resultTextPresent / resultTextByteLength | true / 637 |
| structuredParsingReached | true |
| schemaValidationReached | true (see §7) |
| processExitCode | 0 |

## 7. The exact interpretation

- **The Claude model turn itself succeeded.** It answered within the same 6-turn limit instead of exhausting it (O5.5B15: 7 against 6, no reply). Under identical binding, fixture and limit, the O5.5B16 planning prompt **resolved the max-turn failure** for this sample.
- **The Lead contract still failed.** The reply was **exactly one fence pair** (a json or bare fence), with only whitespace outside it, around one strict JSON **object** (`SINGLE_FENCED_VALID_JSON`).
  - The Lead's packet envelope was `rawOnly`, and it refuses any fence.
  - The refusal happened **at the envelope policy boundary only**: the reader classified the text, the policy refused it, and the turn became `MalformedOutput`.
- **What was and was not reached:**
  - **Structured parsing was reached:** the reply was handed to the reader.
  - **The ResultPacket schema check was NOT executed.** The raw-only packet envelope carries no schema predicate (`bodyMatchesExpectedSchema: notChecked`), and `packet()` stops at the envelope before its shape check.
  - `schemaValidationReached: true` reflects its **O5.5B14 definition**, "the reply body parsed as JSON". O5.5B18 narrows that definition, because it overstated this case.
  - **Whether the body was a valid ResultPacket is therefore not known**, and the claim that "schema validation passed" is not supported by the evidence.
- **Not a Lead contract PASS, and not a route attempt.**

## 8. Roles after the Lead

The engine stopped at `planning>failed:malformedResult`: no Change Author, Reviewer, adjudication, correction, candidate or confined verification ran, and the Worker never opened a session.

## 9. Stage-2 changes

- **`src/providers/probe-profiles.ts`:** `O5.5B17-LEAD` → `consumed`, with the result in its comment.
- **`src/runtime/provider-profiles.ts`:**
  - `LeadPlanLiveRecord` gains `modelTurn` (the provider's model turn, contract aside), `leadPrompt` (`genericDelegation` or `planningLead`) and an optional `contractRefusal` (envelope, policy and class).
  - The O5.5B15 record gains `modelTurn: FAIL, leadPrompt: genericDelegation`; its values are otherwise unchanged.
  - The O5.5B17 record: `outcome FAIL`, `modelTurn PASS`, `planningLead`, route `MALFORMED_OUTPUT`, refusal `envelope / rawOnly / SINGLE_FENCED_VALID_JSON`, the terminal fields as recorded, and the evidence SHA-256.
- **`src/app/writer-gate.ts`:** the `writerPosture` text gains one provider-neutral sentence. No row changes.
- **Tests:** `test/o5-5b17-lead-live-record.test.ts` (4):
  - the record, and the A/B facts: same binding and limit, prompt changed, 7 → 6 turns;
  - readiness unchanged and nothing open;
  - the consumed identity refused;
  - an offline replay at this commit: a successful fake Lead turn replying with one fenced ResultPacket ends `MALFORMED_OUTPUT` with the live detail. This is the regression baseline for O5.5B18.

  The Stage-1 tests were updated for the consumed state.

## 10. Readiness

| Gate | State |
| --- | --- |
| providerChangeProposal | satisfied (recordedLiveProbe), preserved |
| fullRouteLive | blocked: 1 run (O5.5B13), 0 passed |
| hostControlledWriterWorkflow | partial (fakeProviderRehearsal) |
| liveGateAuthorization | blocked |

## 11. Next

**O5.5B18 (offline):** read the Lead plan's ResultPacket under the same narrow `rawOrSingleJsonFence` envelope the Change Author already uses (O5.5B10), with the ResultPacket shape as its schema predicate. Then a new authorized Lead-only live retest must pass through the envelope **and** the contract before any Lead live PASS is recorded.
