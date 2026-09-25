# O5.5B25 — Full-route live rehearsal: Change Author format failure

Labels: **LIVE-OBSERVED** (the one authorized run, validated independently), **MECHANICALLY ENFORCED**, **FAKE-PROCESS PROVEN**, **NOT RUN**.

Outcome in one line: the second live full-route rehearsal ended **`MALFORMED_OUTPUT` at `changeAuthor #1`**. **Not a full-route pass.**
- **Lead plan:** it **passed again**: `RESULT_OK`, one json fence, contract accepted.
- **Change Author:** its **model turn succeeded**: `RESULT_OK`, 4 internal turns, exit 0.
  - Its reply held exactly **one json-fenced object whose body matched the Change Author schema**.
  - But non-whitespace text stood **before** the fence, so the envelope refused the reply as `EXTRA_TEXT` before the ChangeSet contract.
- **What never ran:** the Reviewer, adjudication, correction and confined verification.
- **Integrity:** primary and views unchanged, cleanup complete.
- **Authorization:** `O5.5B25-LIVE` is consumed.

## 1. Stage 1 and the run

- **Stage 1** (on `bb1707a`): `O5.5B25-LIVE`, open, with these roles and budget:
  - Lead and Change Author: Claude Code 2.1.280, haiku, low, `--max-turns 6`;
  - fresh Reviewer: the O5.5B24-validated Muse 1.4.0-R4161.1 binding, with its binary pinned;
  - budget 1/2/2/2.
- **Fingerprint:** `compiledSourceSha256 5eac78a3…ebb9` (109 files), `liveEntrySha256 2407b4ca…05e9`. The patch was `0e89a4d3…df81`, re-verified at Stage 2.
- **The run** (human, once, normal PowerShell, 2026-09-25T18:47:00Z, 100.9 s): two model turns started; role turns `leadPlan=1 changeAuthor=1 freshReview=0 leadAdjudication=0`.

## 2. Independent validation (Stage 2)

**59 checks, 0 failed.** No provider was called and nothing was re-run. The evidence SHA-256 is `89ff988d53a353e7370c2da91c1cb834308f6fb8f0baf3bb77ba2d1bc0605b44`.

- **Namespace:** marker, one claim (written during the run), the ledger with exactly `leadPlan#1` then `changeAuthor#1`, one evidence file and the fixture. There is no preflight file.
- **Identity:** the harness equals the Stage-1 fingerprint; roles, budget, milestone and fixture pin equal the compiled `O5.5B25-LIVE`; every binding is exact.
- **Preflight:** every role could start, so every role was checked.
  - **Lead and Worker:** 2.1.280 validated and authorized, billing clear, subscription token, binding exact, `FUSION_CLAUDE_EXE` set, eligible (the Lead on the review surface, the Worker on the change-proposal surface).
  - **Reviewer:** Muse 1.4.0-R4161.1 validated for exactly this binding (O5.5B24), the pinned binary (location and SHA-256), subscription, eligible. Its bytes were unchanged after the run and still are.
- **Processes:** 12, all `claude.exe` in the baseline view, none refused. No argument named the primary and no forbidden variable reached a process. There was **no Muse process**.
  - The two model processes (`leadPlan#1`, `changeAuthor#1`) each carried `--model haiku`, `--effort low` and `--max-turns 6` exactly once, plus the read-only controls, with no widening flag, and exited 0.
  - The init probes were stopped by Fusion after their init readback: the established pattern.
- **Lead plan:** completed and contract **accepted**, canonical model `claude-haiku-4-5-20251001`.
  - `RESULT_OK`, 6 internal turns, exit 0;
  - `SINGLE_FENCED_VALID_JSON` accepted, schema matched, 1116 bytes.
- **Change Author:**
  - failed with `MalformedOutput`; contract `notReached:failed`.
  - **The model turn:** `RESULT_OK`, success/completed, `isError false`, 4 internal turns, 0 permission denials, exit 0.
  - **The reply:** read (`structuredParsingReached: true`), 3069 bytes, but it never reached the schema/contract stage (`schemaValidationReached: false`).
    - `EXTRA_TEXT` with `extraTextLocation: beforeFence`: not whitespace-only before the fence, whitespace-only after it.
    - Exactly one closed `json` fence (2 fence lines), holding one strict JSON object that **matches the expected schema** (`bodyMatchesExpectedSchema: true`, no multiple values).
  - **Init readback:** 2.1.280, canonical model, no API key, `dontAsk`, Read/Grep/Glob, subscription token.
  - Both diagnostics re-validate.
- **What never happened:**
  - no Reviewer (no Muse process, no readback), no review, no adjudication;
  - no ChangeSet accepted, nothing applied or verified;
  - no correction or retry.

  The workflow ended `delegating>failed:malformedResult`, and turn use is `{1, 1, 0, 0}`.
- **Integrity and cleanup:**
  - the one host-side candidate was created and released;
  - the one baseline view was checked, fingerprinted 5 times, unchanged and released;
  - the primary digest `8c52b9cd…39e0` is equal before and after and recomputed read-only now, and the canaries are unchanged;
  - no leftovers, containers 0 → 0.
- **Redaction:** no fence, prompt, task or diff text, canary, user name or path, and no free-text field.

## 3. Interpretation, exactly

| Role | Model turn | Contract |
| --- | --- | --- |
| Lead plan | PASS (`RESULT_OK`, 6 turns) | **accepted** (live PASS again, after O5.5B21) |
| Change Author | **PASS** (`RESULT_OK`, 4 turns, exit 0) | **FAIL**: `EXTRA_TEXT` before one schema-matching json-fenced ChangeSet body; the ChangeSet contract was never reached |
| Fresh Reviewer | NOT RUN | — |
| Adjudication, correction, confined verification | NOT RUN | — |

- **What it shows:** the strict envelope did its job. A reply with prose outside its payload is refused, however valid the payload.
- **Not proven:** that the fenced ChangeSet would have passed the core ChangeSet validation, its SHA-256 preconditions, or verification. Nothing past the envelope ran.
- **The next fix** is on the prompt side (O5.5B26), never the parser.

## 4. Recorded

- **`fullRouteLiveRecords()`:** the O5.5B25 record, with per-turn `turnDiagnostics` (model turn, contract, reply shape; labels only). The O5.5B13 record is unchanged. `fullRouteLiveCoverage()`: 2 runs, 0 passed. The writer-gate row `fullRouteLive` stays **blocked**.
- **`writerPosture`:** the O5.5B24 Reviewer-only probe and the O5.5B25 run are now described, with no success wording.
- **`O5.5B25-LIVE`:** consumed.
- **Older tests:** they now read the growing history by prefix; the O5.5B25 tests pin the exact record.

## 5. Readiness

| Gate | State |
| --- | --- |
| providerChangeProposal | satisfied (recordedLiveProbe), preserved |
| fullRouteLive | blocked: 2 runs, 0 passed |
| hostControlledWriterWorkflow | partial (fakeProviderRehearsal) |
| liveGateAuthorization | blocked |

Next: O5.5B26 (offline) makes the route Change Author's output discipline explicit. Only then does a new, separately authorized full-route run (O5.5B27) follow.
