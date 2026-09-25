# O5.5B24 — Muse 1.4 fresh Reviewer live: PASS

Labels: **LIVE-OBSERVED** (the one authorized real turn, validated independently), **MECHANICALLY ENFORCED**, **FAKE-PROCESS PROVEN**.

Outcome in one line: the installed **Muse Exec 1.4.0-R4161.1** passed **one real fresh-review turn** as the Reviewer. The O5.5B23 Reviewer-only probe ran once under `O5.5B24-REVIEWER`.
- **The turn:** it ran in a checked candidate view, and the model readback was `muse-spark-1.3`.
- **The reply:** `RAW_VALID_JSON` under `rawOnly`, and the production review contract **accepted** it (0 findings).
- **Integrity and cleanup** are complete, and the executable's bytes were unchanged.
- **Validated scope:** 1.4.0-R4161.1 is now validated for **exactly this Reviewer binding on exactly this binary**, and nothing wider.
- **Authorization:** `O5.5B24-REVIEWER` is consumed.

## 1. Stages

- **Stage 1 (O5.5B23 `41f218c` plus the uncommitted Stage 1):** the authorization was prepared `pending`. The human explicitly authorized opening it exactly as prepared.
- **Harness identity at the run:** `compiledSourceSha256 43a8426c…7100` (107 files), `liveEntrySha256 adba68c6…062d`. The Stage-1 patch was `fa097421…8786`, re-verified at Stage 2.
- **The run:** the human ran it once from a normal PowerShell window (2026-09-25T15:41:37Z, 78.9 s):
  - `PASS`, stage `review`, `liveProvider`, one model turn;
  - processes: `providerTurn=1 providerHost=1`, nothing else;
  - candidate verification: `passed=true commandsRun=2 acceptance=granted`, dependency stage npm-lockfile `prepared=true cacheHit=false`;
  - readback: `authenticated/subscription`, `reportedRuntimeVersion=1.4.0`, `matchesInstalled=true`;
  - review: contract accepted, 0 findings, `observedModel=muse-spark-1.3`;
  - terminal: `RESULT_OK completed/completed isError=false resultTextByteLength=247 structuredParsingReached=true schemaValidationReached=true processExitCode=0`;
  - envelope: `RAW_VALID_JSON accepted=true policy=rawOnly bodyMatchesExpectedSchema=true`.

## 2. Independent validation (Stage 2)

**74 checks, 0 failed.** No provider was called and nothing was re-run. The evidence SHA-256 is `a6ead8a22418996be9571677cf11a406f482b3db324efdc20559b3e88cea5c45`.

- **Namespace:** exactly the marker, one claim (reviewer-only, live, written during the run), one evidence file and the fixture. There is no preflight file.
- **Identity:**
  - the harness identity equals the Stage-1 snapshot;
  - the authorization, grant, budget and pins equal the compiled `O5.5B24-REVIEWER`;
  - fixture `59c19d1f…` and candidate `a8e6622d…`;
  - the binding is exact (`muse-spark-1.3`, low, `maxModelSteps 4`, `malformedOutputRetries 0`, timeout 180 s).
- **The executable:**
  - installed release `1.4.0-R4161.1`, not validated before the run;
  - `muse-bin-1.4.0-R4161.1.exe` at `%LOCALAPPDATA%\Programs\muse`, with the pinned SHA-256 `b33b4930…d950` before and after the turn;
  - re-read now, still the same bytes, and the selector still names it.
- **Readback:** the account was attested as authenticated/subscription before and after, and the host reported `1.4.0`.
- **Processes:** exactly two, both the authorized 1.4 binary, none refused, both exit 0. There was no Claude process and no Lead, Worker or adjudication process.
  - **The host:** `serve --disable-write --disable-shell`, in an empty Fusion-owned directory, before the claim.
  - **The model turn:** in the candidate view. It carried the production `EXEC_CONTROL_FLAGS` in order:
    - `--provider meta`, `--model muse-spark-1.3`, `--reasoning-effort low` and `--max-model-steps 4`, each exactly once;
    - no widening flag, a strict `--output-schema`, no primary path, no forbidden variable.
- **Budget:** turn use `{ freshReview: 1 }` equals the budget, with no refusals.
- **Fresh-review isolation:**
  - the Reviewer saw only production's review evidence: the task, scope, Fusion's passing verification and the diff of the Fusion-authored candidate (exactly the pinned change: `src/quote.ts`, `test/quote.test.ts`);
  - no Worker or Lead text existed in the run.
  - Verification: Docker Linux (`osSandbox`), typecheck and unit, both exit 0, acceptance granted, the declared npm dependency stage prepared.
- **The review:**
  - completed by the bound provider and model, and the contract accepted it with 0 findings;
  - the structure-only and terminal diagnostics re-validate;
  - `RAW_VALID_JSON` under `rawOnly`: no fence and no extra text; 247 bytes in both diagnostics.
- **Integrity:**
  - view, candidate and primary unchanged;
  - the one view was checked, fingerprinted twice and released;
  - the primary digest `5e85eaeb…fddc` is equal before and after, recomputed read-only at Stage 2, and the canaries are unchanged.
- **Cleanup:** session closed, view and candidate released, no leftover temporaries (the attempt and view directories are gone), containers 0 → 0.
- **Redaction:** no reply, prompt, diff, task text, canary, user name or path, and no free-text field.

## 3. What is validated, exactly

A new, **binding-scoped** validation (`ProviderTransportProfile.bindingValidations`, `BindingValidation`) records that Muse Exec `1.4.0-R4161.1` is validated only for:
- the **Reviewer** role, `muse-spark-1.3`, effort `low`;
- `provider meta`, `maxModelSteps 4`, `malformedOutputRetries 0`;
- the binary `muse-bin-1.4.0-R4161.1.exe` with SHA-256 `b33b4930…d950`.

**How it is enforced:**
- **Data:** `bindingValidation` / `isValidatedForBinding` (runtime profiles) match role, model, effort and each listed option exactly. Locations and timeouts are not part of the scope.
- **Registry:** the Exec config of an exactly matching binding carries the release and its SHA-256 (`validatedBindings`). Any other binding carries nothing.
- **Adapter:** the launch-flag facts are claimed for that release only when the executable about to run has exactly that SHA-256 (`validatedBindingIdentity`, a cached content hash). This is checked by `inspect`, by `capabilities()` (routing) and before every Exec turn. They are then reported `versionVerified: true`.
- **Route preflight:** `isValidatedForBinding` replaces the transport-wide check. A grant may pin its binary (`executableDirectory`, `executableSha256`); preflight checks the pin, the launch guard enforces it on every process of that executable, and the bytes are re-read after the run.

**Not generalized:**
- `isValidatedRuntimeVersion("muse", "muse-exec", "1.4.0-R4161.1")` stays **false**, and the transport-wide validated releases stay `["1.3.0-R3401.1"]`. The Muse 1.3 history is preserved, including its O5.5B9 Change Author PASS.
- Every other case stays unverified:
  - another role (Explorer, the Muse Change Author);
  - another model or effort;
  - another step budget or retry policy (including the **default no-config Reviewer binding**, which has no step limit and one retry);
  - the MSP transport;
  - another binary under the same name;
  - any other or future release.

What the validation rests on:
- the release accepted exactly the production read-only controls;
- it completed one read-only structured review, recorded above, with every integrity check intact.

Web-tool disabling was not separately exercised, as in any review turn.

## 4. What changed

- **Stage 1** (`src/providers/probe-profiles.ts`, `test/live/reviewer-probe.ts`, `test/o5-5b24-reviewer-live.test.ts`): `O5.5B24-REVIEWER` itself, whose state is now `consumed`, and its tests.
- **`src/runtime/provider-profiles.ts`:**
  - `BindingValidation`, `bindingValidations` on every transport profile (Muse Exec: the one entry above; others: none);
  - `bindingValidationsFor`, `bindingValidation`, `isValidatedForBinding`;
  - `ReviewerLiveRecord` and `reviewerLiveRecords()` (the O5.5B24 PASS).
- **Muse provider code:**
  - `src/providers/muse/identity.ts` (new): `validatedBindingIdentity`;
  - `types.ts`: `MuseLaunchConfig.validatedBindings`, and `capability(…, bindingIdentity)`;
  - `exec-transport.ts` and `muse-adapter.ts`: the identity check before claiming.
- **`src/providers/registry.ts`:**
  - `museValidatedBindings`;
  - the Exec config and inspection (control state, a note on the exact scope);
  - `defaultRegistry({ museBindingValidations })` as a test seam; production never passes it.
- **`src/app/executable-identity.ts` (new):** `grantDirectory` and `fileSha256`, shared by the Reviewer probe and the route harness.
- **`src/app/route-probe.ts`:** the binding-scoped validation check, pinned-binary preflight, the launch guard, the after-run re-hash (`executableIdentityAfter`), and `VERSION_BLOCKED` when the bytes change.
- **Older tests updated:** O5.5B19 and O5.5B20. With 1.4 now validated for the exact Reviewer binding, a grant that authorizes 1.3 only still blocks it, now as *not the authorized release*. An unvalidated release still blocks as *not a validated release*, and the recorded O5.5B19 block is unchanged.

## 5. Tests

- **`test/o5-5b24-reviewer-validation.test.ts` (4):**
  - the exact record and scope;
  - the scope matrix: role, model, effort, steps, retries, the default binding, the Change Author, MSP, other releases;
  - the real registry and adapter on fake installs: the exact binding is eligible and routed; every other binding, a swapped binary and another release are not;
  - the Exec turn on a binary other than the validated one is refused before any process starts.
- **`test/o5-5b24-reviewer-live.test.ts` (4):** consumed, and refused before anything exists; the open test copy's one-turn shape; exact binding with no fallback; readiness.

## 6. Readiness

No writer-gate row moved, and no authorization is open.

| Gate | State |
| --- | --- |
| providerChangeProposal | satisfied (recordedLiveProbe), preserved |
| fullRouteLive | blocked: 1 run (O5.5B13), 0 passed |
| hostControlledWriterWorkflow | partial (fakeProviderRehearsal) |
| liveGateAuthorization | blocked |

Next: a new full-route live rehearsal (O5.5B25) whose Reviewer is exactly this validated binding and binary.
