# O5.5B23 — Muse 1.4 Reviewer-only probe foundation (offline)

Labels: **MECHANICALLY ENFORCED** (code plus deterministic tests), **FAKE-PROCESS PROVEN** (plumbing only), **NOT RUN** (live).

Outcome in one line: Fusion can now validate the **actual installed Reviewer release** with exactly **one** real fresh-review turn. There is no Lead plan, no Change Author, no adjudication and no full route.
- **Muse 1.4.0-R4161.1 stays UNVALIDATED.** It is only ever the *release under validation*; the validated-version data is unchanged.
- **Nothing is authorized:** no Reviewer-only authorization exists in O5.5B23, and nothing ran live.
- **Scope:** offline only; no provider call and no readiness change.

## 1. Why

O5.5B22 §8 names the narrowest remaining blocker before any new full-route rehearsal: the **Reviewer**.
- **The mismatch:** the machine's Muse selector names `1.4.0-R4161.1`, while `muse-exec` is validated, and the route's Reviewer grant is bound, to `1.3.0-R3401.1` only.
- **The consequence:** every route with `freshReview > 0` is `VERSION_BLOCKED` in preflight.
- **What has never happened:** a Muse Reviewer has never produced a real review inside the route.
- **What else blocks 1.4:** for an unverified release, the production Exec adapter reports its read-only posture facts as `unknown`, so it refuses every structured turn before any process starts. A live validation therefore needs a narrowly scoped way to run exactly that release.

## 2. What the probe runs (`src/app/reviewer-probe.ts`)

Stages, in order. Everything before the claim consumes nothing and starts no model turn.

| # | Stage | Provider process? |
| --- | --- | --- |
| 1 | Authorization checks: `pending` / `retired` / `consumed` refuse before anything exists; the budget must be exactly `{ freshReview: 1, others 0 }`; exactly one release under validation; the pinned fixture (`routeFixtureIdentity`) and candidate (`reviewCandidateIdentity`); no nested agent session; own namespace; not attempted. | none |
| 2 | Static preflight: the exact binding, the release under validation (installed selector must name it; **no other release and no fallback**), the executable's exact location and SHA-256, billing, credential lane, and review eligibility under validation. | none |
| 3 | Production composition with the **Reviewer binding alone** (no Lead or Worker adapter even exists), the accepted confined backend, and the production fresh-review routing (`resolveRole` with structured turns, review isolation, workspace binding). | none |
| 4 | The Fusion-authored candidate: `REVIEW_CANDIDATE_CHANGE` (the correct fix and its regression test) is validated by the core and host-applied into a private candidate, then Fusion's confined verification runs. That includes its **declared dependency stage**: the restricted npm lane, networked unless the identity-keyed artifact is cached, recorded as `prepared` / `cacheHit`. | none |
| 5 | A checked Fusion-owned **candidate view**, a fresh Reviewer session bound to it, and a **runtime readback**: the account attestation (lane) and the running host's own version report. The report must be the release or its version core, e.g. `1.4.0` for `1.4.0-R4161.1`. | the attestation host only (empty Fusion-owned directory) |
| 6 | **The one-shot claim**, then exactly one `review` turn with production's own evidence (`reviewEvidence`: task, scope, architecture, Fusion's verification, the observed diff; never a Worker's or Lead's rationale or transcript). The reply is checked in three steps: Muse's own raw-only reader, the model readback, then the production contract (`validateReviewReport`). | one model process |
| 7 | Integrity (view, candidate, primary fingerprints; the primary's full walk), the executable re-hashed, then cleanup (session and host, view, candidate, temporaries, containers). | — |

Guards on every run:
- **Turn gate:** the Reviewer adapter may run one `review` (cycle 1). Any packet turn, change proposal, adjudication or second review is refused before it reaches the provider.
- **Pre-launch guard, over every provider process:**
  - only the pinned executable path;
  - nothing before the session exists;
  - a host only in an empty Fusion-owned directory, and a model process only in the checked candidate view;
  - no argument naming the primary, and no forbidden variable;
  - the family's read-only controls, with no widening flag;
  - exactly the grant's `--provider` / `--model` / `--reasoning-effort` / `--max-model-steps` pairs;
  - at most one model process.

## 3. The exact binding (`MUSE_1_4_REVIEWER`, `src/providers/probe-profiles.ts`)

| Fact | Value |
| --- | --- |
| Provider / transport | Muse Exec (`muse-exec`), Reviewer only |
| Executable | `muse-bin-1.4.0-R4161.1.exe` in `%LOCALAPPDATA%/Programs/muse` |
| SHA-256 | `b33b493069a2593e97cc63f9a4063feb64269bf7f07a233f5db2db681ad5d950` (434,452,728 bytes; read from the file, never launched) |
| Release under validation | `1.4.0-R4161.1` (not validated; `validatedVersions` stays `["1.3.0-R3401.1"]`) |
| Model / effort | `muse-spark-1.3` / `low` (readback must be `muse-spark-1.3`) |
| Steps / retries | `--max-model-steps 4`, `malformedOutputRetries: 0` (one attempt), timeout 180 s |
| Controls | `--approval-mode never --disable-write --disable-shell --disable-web-tools --approval-judge off --no-foreign-personal-context`, exactly the production Reviewer's `EXEC_CONTROL_FLAGS` |
| Lane | subscription (attested before and after the turn) |
| Reply policy | raw-only (Muse's own strict reader; unchanged) |

## 4. The release under validation: a scoped seam

- **The context field:** `ProviderRuntimeContext.runtimeUnderValidation = { transport, version }`, passed through `composeProductionWriter`. Only the Reviewer-only probe sets it. It is **not** a binding option: `versionUnderValidation` in a configuration is refused as an unknown option, and no command sets it.
- **What the Exec adapter does with it,** for exactly that transport and version:
  - launches the release with the verified release's controls, unchanged;
  - claims the launch-flag facts those controls stand for (web tools disabled, approval escalation disabled, personal context disabled, extensions quarantined);
  - reports them with `versionVerified: false`.

  Any other release, transport, or a context without the field: the facts stay `unknown`, exactly as before.
- **It never validates anything:** `isValidatedRuntimeVersion("muse", "muse-exec", "1.4.0-R4161.1")` stays false, and the route's grants and preflight are unchanged. Only a later milestone may validate the release, after an independent review of a live PASS.

## 5. Muse diagnostics (descriptive only)

The Exec transport now reports what Claude has reported since O5.5B14 and O5.5B18.
- **The structure-only reply diagnostic:** classes, flags and counts, read by the provider-neutral envelope reader under Muse's `rawOnly` policy.
- **The bounded terminal diagnostic:** O5.5B14's 18-key shape.
  - `RESULT_OK` for a completed terminal, `RESULT_IS_ERROR` for a failed one, `RESULT_TERMINAL_NOT_COMPLETED` for a cancelled one;
  - Fusion's process classes first;
  - `terminalReason` is Fusion's own failure classification as a label;
  - no turn counts (Exec reports none).
- **The attestation host's reported version,** as a bounded label (`invalid` otherwise).

Muse's acceptance is **unchanged**: `parsePacket` and `parseStructured` alone decide. A fenced review stays refused. It is now recorded exactly as `SINGLE_FENCED_VALID_JSON` under `rawOnly`, with `schemaValidationReached: false`.

Because the diagnostics are the adapter's, route and proposal-probe evidence now record them for Muse turns too. Three older tests were updated accordingly (O5.5B10 Muse regression, O5.5B14 route, O5.5B22 route). Historical evidence and records are unchanged.

## 6. PASS and the other outcomes

**PASS** requires all of:
- the claim was written;
- the Muse processes started under the exact 1.4 binding;
- exactly one model turn;
- a successful terminal;
- the reply reached, and passed, Muse's strict reader and the production review contract;
- the model readback is the authorized model;
- view, candidate and primary are unchanged, and the executable bytes are unchanged;
- cleanup is complete.

Findings (0..32) are valid output: only their counts by severity and confidence are recorded. No adjudication runs.

Other outcomes:

| Outcome | Meaning |
| --- | --- |
| `VERSION_BLOCKED` / `MODEL_BLOCKED` / `AUTH_BLOCKED` / `POSTURE_BLOCKED` | Preflight, readback or guard refusals |
| `TURN_REFUSED` | A refused turn or second model process |
| `MALFORMED_OUTPUT` | Muse's own reader refused the reply (a fence under raw-only included; **no auto-widening, no retry**) |
| `CONTRACT_REFUSED` | The production contract refused the reply |
| `PROVIDER_FAILED` / `TIMEOUT` / `CANCELLED` | The provider turn failed, timed out or was cancelled |
| `VERIFICATION_FAILED` / `APPLICATION_FAILED` | Pre-claim: nothing was consumed |
| `VIEW_MUTATED` / `PRIMARY_MUTATED` | An integrity check failed |
| `CLEANUP_FAILED` | Something was not removed |

## 7. What changed

- **`src/app/reviewer-probe.ts` (new):** the probe, `ReviewerTurnGate`, `classifyReviewerProbe`, and the helpers `grantDirectory`, `fileSha256`, `readbackMatches`.
- **`src/app/providers.ts`:** `ProviderRuntimeContext.runtimeUnderValidation`, and `BindingInspection.executablePath` (the resolved path, for pinning).
- **`src/app/writer-composition.ts`:** passes `runtimeUnderValidation` through.
- **`src/app/route-fixture.ts`:** `QUOTE_FIXED` and `QUOTE_TEST_WITH_REGRESSION` moved here from the test fixtures, plus `REVIEW_CANDIDATE_CHANGE` and `reviewCandidateIdentity()`. `routeFixtureIdentity()` is unchanged (`59c19d1f…`).
- **`src/providers/registry.ts`:**
  - `museVersionUnderValidation`;
  - the Exec config carries the release under validation from the context only;
  - inspection reports `executablePath` and states the "under validation" control and note.
- **`src/providers/muse/types.ts`:** `MuseLaunchConfig.versionUnderValidation`, honored by `capability()` as above.
- **`src/providers/muse/terminal.ts` (new):** `museTerminalDiagnostic`.
- **Diagnostics wiring:**
  - `src/providers/muse/exec-transport.ts`: `lastOutput`, `lastTerminal`, and a descriptive envelope reading before the unchanged strict reader;
  - `muse-adapter.ts`: the `structuredOutputDiagnostic`, `terminalDiagnostic` and `attestedRuntimeVersion` getters;
  - `msp-transport.ts`: the `runtimeVersion` getter.
- **`src/providers/probe-profiles.ts`:** `MUSE_1_4_REVIEWER`, and `REVIEWER_PROBE_PROFILES` with **no authorization**.
- **`test/live/reviewer-probe.ts` (new):** the live entry (not part of `npm test`). It prints bounded labels only.
- **Test support:**
  - `test/fixtures/reviewer-harness.ts` (new);
  - the fake Muse host reports the version core of its binary name, and a scripted turn may read back another model;
  - `routeCompose` passes the release under validation through.

## 8. Deliberately not changed

- **No release validated:** `validatedVersions`, `VERIFIED_EXEC_WEB_DISABLE_VERSION` (`1.3.0-R3401.1`), the route grants and their preflight are unchanged. The full route still blocks on Muse 1.4.
- **Muse and Claude reading:** Muse's raw-only acceptance and its prompts are unchanged, and so is every Claude envelope.
- **Contracts:** the review contract, the adjudication contract and the ChangeSet contract are unchanged.
- **No Muse downgrade or reinstall.** No authorization, no readiness row or gate moved, no live run.

## 9. Tests (`test/o5-5b23-muse14-reviewer-probe.test.ts`, 16)

| # | What it proves |
| --- | --- |
| 1 | PASS (fake), end to end:<br>- exactly one Reviewer model process and its attestation host, both the pinned binary; no Lead, Worker or adjudication process; turn use `{ freshReview: 1 }`;<br>- contract accepted; model readback `muse-spark-1.3`; `RAW_VALID_JSON` under `rawOnly`; `RESULT_OK` with parsing and schema reached;<br>- readback: lane subscription, host `1.4.0`;<br>- the candidate verified before the claim, with the dependency stage;<br>- the prompt is production's fresh review (task, verification, diff; no Lead or Worker text);<br>- integrity and cleanup complete; executable unchanged. |
| 2 | Exact binding (effort → `MODEL_BLOCKED`); budgets other than one review, two releases, and fixture or candidate pin mismatches are refused before anything exists. |
| 3 | Wrong version:<br>- the selector back at 1.3 (**no fallback**), or a newer release → `VERSION_BLOCKED` with no process;<br>- a host reporting `1.3.0` → `VERSION_BLOCKED` before the claim, host only, nothing consumed. |
| 4 | Wrong model: in the binding → `MODEL_BLOCKED` in preflight; in the readback → `MODEL_BLOCKED` after one turn. |
| 5 | Wrong executable: a SHA-256 mismatch or another location → `VERSION_BLOCKED`; a process of another binary is refused before it starts; `grantDirectory` resolution. |
| 6 | Limits: `maxModelSteps 5` or retries 1 → `MODEL_BLOCKED`; a malformed reply gets exactly one model turn; `--max-model-steps 4` exactly once. |
| 7 | Read-only posture: the production `EXEC_CONTROL_FLAGS` in order, and every grant flag pair. Facts under validation are claimed but `versionVerified: false`; without the seam they stay `unknown`. |
| 8 | The seam:<br>- the real registry's inspection and adapter claim the facts only with the probe's context and only for the exact release and transport;<br>- a `versionUnderValidation` binding option is refused;<br>- the executable path is reported. |
| 9 | Raw-only unchanged: a fenced review → `MALFORMED_OUTPUT`, recorded as `SINGLE_FENCED_VALID_JSON` under `rawOnly`; the claim is consumed with no retry; every Muse profile policy stays `rawOnly`. |
| 10 | Contract: a clean review passes; `{bad` → `RAW_INVALID_JSON`; a missing summary → `INVALID_SCHEMA` (schema stage reached; wire-schema refusal); duplicate finding IDs → `CONTRACT_REFUSED`. |
| 11 | Terminal: a failed turn → `RESULT_IS_ERROR`, `provider_failure`, never parsed; the full 18-key diagnostic, text-free. |
| 12 | Integrity: the primary is unchanged; a Reviewer writing into its view → `VIEW_MUTATED` (the candidate itself unchanged, cleanup complete). |
| 13 | Privacy: no finding text, diff, prompt or canary in the evidence. |
| 14 | Turn gate: out-of-order, adjudication, packet, proposal and second-review calls are all refused; only one review reaches the adapter. |
| 15 | The grant and the candidate change exactly; `readbackMatches`. |
| 16 | Readiness: Muse 1.4 unvalidated; no Reviewer-only authorization open; the route and proposal authorizations are unchanged; live records unchanged; no row or gate moves. |

## 10. What remains

**O5.5B24:**
- one **pending**, one-shot authorization `O5.5B24-REVIEWER` for this exact binding, with budget `{ freshReview: 1, others 0 }`;
- the human's explicit approval to open it;
- **one** human-run live Reviewer turn from a normal PowerShell window;
- an independent Stage-2 validation.

Only a live PASS validated in Stage 2 can support adding `1.4.0-R4161.1` to the Exec transport's validated versions, in its own milestone. Only after that may a new full-route authorization be considered.

| Gate | State |
| --- | --- |
| providerChangeProposal | satisfied (recordedLiveProbe), preserved |
| fullRouteLive | blocked: 1 run, 0 passed |
| hostControlledWriterWorkflow | partial (fakeProviderRehearsal) |
| liveGateAuthorization | blocked |
