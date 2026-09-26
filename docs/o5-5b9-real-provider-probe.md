# O5.5B9 Authorized real-provider change-proposal probe

Labels: **LIVE-OBSERVED** (a value the probe recorded from a real provider run, in the validated evidence file), **DEDUCED** (not recorded as a value, but implied by the fail-closed code path of the hash-verified harness: the recorded outcome is reachable only if the check passed), **MECHANICALLY ENFORCED** (code plus deterministic tests), **NOT PROVEN** (no evidence either way).

Outcome in one line: the authorized probes ran once per provider family from a normal terminal through the production Writer composition. **Muse** produced a ChangeSet that Fusion validated, host-applied into a private candidate and verified 3/3 in the accepted confined Docker backend (**PASS**). **Claude** answered with a result text that began with a Markdown code fence, which Fusion refused (**MALFORMED_PROPOSAL**). Nothing was applied from the Claude run, nothing was retried, the fixture primaries and provider views stayed unchanged, and no gate opened.

## 1. Authorization scope

Human authorization for this milestone: exactly one Claude and exactly one Muse change-proposal model turn, on a Fusion-created throw-away fixture, at the lowest practical effort, in the read-only proposal posture (no provider filesystem write, shell or web tools, no primary mutation, no delivery, no push), with Fusion-side ChangeSet validation, private-candidate application and confined Docker verification. No automatic retry. `REAL_WRITER_LIVE_GATE_AUTHORIZED` stays false.

Execution: Stage 1 (this repository, no provider call) built and validated the harness. The two probes were then run **by the human in a new, normal PowerShell window** (outside the Claude Code process tree, where Muse model calls fail on this machine), one invocation per provider:

```
npm run build
node dist/test/live/proposal-probe.js --provider claude --authorization O5.5B9
node dist/test/live/proposal-probe.js --provider muse --authorization O5.5B9
```

Both claims were consumed (`%TEMP%\fusion-o5-5b9-probe\claude.claim.json` 2026-09-24T13:36:16Z, `muse.claim.json` 13:37:16Z). Stage 2 made no provider call.

## 2. Starting state

Branch `o5-5b9-real-provider-probe`, HEAD `401ebd9b2cb3c12fba28786d2e8dff718b427cb2` (`feat: isolate provider workspaces and compose writer path`), clean tree. Baseline suite: 567 tests, 566 pass, 1 skip, 0 fail.

## 3. Probe architecture (Stage 1)

`src/app/proposal-probe.ts` (provider-neutral orchestration) with `src/providers/probe-profiles.ts` (the provider-specific facts) and the live entry `test/live/proposal-probe.ts` (not part of `npm test`):

1. **Refusals before anything exists:** inside a nested agent session (Claude Code session variables present), for an unknown provider, or when the provider's claim file exists.
2. **Static preflight, no provider process:** the binding's own registry factory `inspect()` (installed version, BillingGuard lane, change-proposal eligibility). An unvalidated version, a blocked/ambiguous billing lane or an ineligible posture ends as `VERSION_BLOCKED` / `AUTH_BLOCKED` / `POSTURE_BLOCKED` without consuming the authorization.
3. **Production composition:** `composeProductionWriter` with a probe configuration validated like `fusion.config.json`: exactly one Worker binding built by the registry as a read-only Change Author, Fusion-owned provider views, the private candidate port bound to a verification-isolation acceptance granted in the probe's own process by the production Docker backend (a refused acceptance stops before any provider process), the confined plan `/usr/local/bin/node --test test/name.test.js` (read-only), dependency lane `none`, platform `platform-neutral`, `secrets.local` as a protected ignored path.
4. **One-shot claim**, written only after the preflight and the composition succeeded and the primary was fingerprinted: from then on the authorization is consumed whatever happens; a second invocation refuses.
5. **The real `WorkflowEngine`** on a single-file edit task: the low-risk Writer flow routes the Worker alone with an attempt limit of one — no Lead, Explorer or Reviewer turn exists and no retry can happen. The Worker adapter is additionally wrapped so a second `runChangeProposalTurn` throws before reaching the provider.
6. **Observation:** every provider process is reported by an `ObservedProcessSupervisor` before it starts (argv, working directory, environment KEY names, purpose label `providerAuthReadback` / `providerInventory` / `providerInitProbe` / `providerTurn` / `providerHost`) and when it settles; a throwing observer refuses the start. The view port is wrapped to record each view's location checks and every fingerprint the engine takes; the primary is walked in full (tracked, untracked, ignored and `.git` files by content, `git status --ignored`, HEAD) before and after.
7. **Classification** (`classifyProbe`) from Fusion's observations only: `PASS`, `AUTH_BLOCKED`, `VERSION_BLOCKED`, `POSTURE_BLOCKED`, `PROVIDER_FAILED`, `TIMEOUT`, `MALFORMED_PROPOSAL`, `INVALID_CHANGESET`, `VIEW_MUTATED`, `PRIMARY_MUTATED`, `APPLICATION_FAILED`, `VERIFICATION_FAILED`, `CLEANUP_FAILED`. `PASS` requires a completed run, a passing verification covered by a granted acceptance, exactly one provider turn and one proposal call, unchanged primary and views, every process in a checked view (a protocol host only in an empty Fusion-owned directory), no forbidden variable, the full turn posture, and complete cleanup of every attributed temporary directory and Fusion container.
8. **Evidence:** one bounded JSON file per provider, with no prompt, credential, environment value, account data or unvalidated provider output. The only provider text persisted is the content of a validated ChangeSet operation on the fixture file (at most 4 KiB). The harness identity is a digest over every compiled source module plus the live entry.

Production changes made for the probe to be meaningful (all deterministic, all tested):

- **Fusion-supplied baseline preconditions.** The change-proposal prompt required the Change Author to state each file's current SHA-256, but a read-only model without a shell cannot compute one, so every real proposal to an existing file would have failed its precondition. `WorkspacePort.baselineHashes` (implemented on the private candidate through the same link-refusing reads as the applier, before any application) now gives the Change Author the fresh candidate's hash of every file in scope as data (`ChangeProposalRequest.baseline`). The host applier still checks every precondition against the candidate itself.
- **Muse malformed-output retry is configurable.** The Exec adapter retried a malformed structured output once. The new binding option `malformedOutputRetries` (0 or 1, validated; default 1 unchanged) is 0 in the probe profile.
- **Launch observation:** `ProcessSpec.purpose`, `ObservedProcessSupervisor`, `ProviderRuntimeContext.launchObserver`, `composeProductionWriter({ launchObserver, onVerification })`.
- **Adapter evidence accessors:** `ClaudeAdapter.runtimeEvidence`, `MuseAdapter.attestedAuth` (labels only).

## 4. Fixture

A plain Node ESM project created by the probe under `%TEMP%\fusion-o5-5b9-probe\<provider>-fixture-<random>\primary`, committed once: `package.json` (no dependencies), `README.md`, `.gitignore`, `src/name.js` (`normalizeName` returns `name.toLowerCase()` — it does not trim), `test/name.test.js` (3 `node:test` tests; 2 fail on the baseline). Ignored synthetic canaries `.env` and `secrets.local` (protected path). Task: "Fix normalizeName in src/name.js so it trims surrounding whitespace and lowercases the result." Allowed: `src/name.js` only; forbidden: `test/name.test.js`, `package.json`. Expected mechanically verifiable outcome: only `src/name.js` changes and the confined run passes 3/3. Baseline SHA-256 of `src/name.js`: `86016c9b…8316`.

## 5. Evidence validation (Stage 2, no provider call)

| Check | Result |
| --- | --- |
| Harness identity | Both files: `compiledSourceSha256 305af819…6398`, 98 modules, live entry `279bff88…2ebb`. An independent compile of the Stage 1 source (the uncommitted tree the human built and ran) into a scratch directory reproduces all three values: the evidence came from exactly that harness. The Stage 2 changes in the same commit (recorded live evidence and readiness, the Claude init-readback retention and structural malformed diagnostic, the probe's `runtimeReadback.source`) change the digest; they are evidence-quality and reporting changes and alter no step the probes executed. |
| Evidence kind | Both `liveProvider` (a fake or rehearsal run is labelled `offlineRehearsal` and can never be live). |
| Primary fingerprints | Recomputed now for both fixtures: Claude `692f25f5…6140`, Muse `508a112b…0e54` — equal to the recorded before and after values; `git status` shows only the two ignored canaries; HEADs unchanged. |
| Attributed temporaries | The five directories named by the evidence (two views, the plugin-settings directory, the Exec attempt directory, the attestation directory) no longer exist; candidates were released (`complete: true`). |
| Containers | 0 Fusion-labelled containers before and after each run (recorded) and now. |
| Secrets | Neither file contains a credential, email, prompt text, canary value, user path or unvalidated provider output (searched). |
| Claims | Both present; the entry refuses a second run of either provider. |

## 6. Claude (one-shot adapter)

| Item | Evidence |
| --- | --- |
| Real provider call | Yes: one `providerTurn` process (`claude.exe -p …`, exit 0) — LIVE-OBSERVED. |
| Proposal turns | Exactly 1 (`launchCounts.providerTurn = 1`, `proposalCalls = 1`); workflow `delegateAttempts = 1`. No second live turn was attempted. |
| Other processes | 2 `auth status` readbacks, 1 `plugin list --json`, 2 init-only startups of the production plugin quarantine, each cancelled by Fusion at the initialization report (`killReason: protocolError`) before any assistant output. They are not proposal turns; whether the CLI had begun an API request before the cancellation is NOT PROVEN either way. |
| CLI version | Installed package 2.1.280 (static preflight; validated list `["2.1.280"]`) — LIVE-OBSERVED. The human used a side-by-side 2.1.280 install (`FUSION_CLAUDE_EXE`); the regular install (2.1.281) is unvalidated and was not used. Init version 2.1.280: DEDUCED (the init-only probes and the turn fail closed on any other version). |
| Configured / effective model | Configured `haiku`, canonical `claude-haiku-4-5-20251001`, effort `low`, max 3 agentic turns — LIVE-OBSERVED in argv. Effective model `claude-haiku-4-5-20251001`: DEDUCED (a different init model fails the turn as `ProviderIdentityMismatch` before the result is read). |
| Auth / billing lane | BillingGuard clear; candidate lane `subscriptionToken` (a `CLAUDE_CODE_OAUTH_TOKEN` was present in the human's terminal and is forwarded by the default `subscriptionOAuth` policy) — LIVE-OBSERVED. First-party OAuth-token login, no API-key source (auth readback) and `apiKeySource: none` at init: DEDUCED (each fails closed as `AuthMismatch` otherwise). No PAYG fallback exists. |
| Workspace / cwd | Every one of the 6 processes ran in the Fusion-owned baseline view `%TEMP%\fusion-provider-view-3JSGtO\workspace`; no argument named the primary; view checks: owned location, disjoint from the primary, no `.git`, no provider state paths — LIVE-OBSERVED. |
| Tool / posture | Turn argv carried `--tools Read,Grep,Glob --permission-mode dontAsk --permission-prompts none --restricted --safe-mode --strict-mcp-config --disable-slash-commands --no-session-persistence --include-hook-events` plus the child-only plugin settings, and no widening flag; no forbidden variable reached any process — LIVE-OBSERVED. Init readback of exactly Glob/Grep/Read, `dontAsk`, no MCP server, no loaded plugin, no hook or extension activity: DEDUCED. |
| Proposal outcome | **MALFORMED_PROPOSAL**: `Claude returned invalid structured JSON (fenced).`; transition `delegating>failed:malformedResult`. |
| ChangeSet validation | Not reached: the result text was refused by the strict JSON parser before any ChangeSet validation. |
| Private candidate | Acquired for the attempt, never applied, released complete. |
| Docker verification | Acceptance granted in the probe process; no verification ran (nothing to verify). |
| Primary | `692f25f5…6140` before = after; canaries unchanged. |
| Provider view | 3 fingerprint observations, all equal; released complete. |
| Cleanup | 3 attributed temporary directories, none left; 0 containers before/after. |

**What "fenced" means.** The diagnostic was `trimmed text starts with three backticks` — nothing more. The harness deliberately never persists provider output that failed validation, so the evidence does NOT show whether the fence was closed, whether any text followed it, whether its body was valid JSON, or whether that body was a valid ChangeSet. The prompt required "exactly one JSON object and nothing else: no Markdown fence".

**Decision: no fence normalization.** The authorization allowed a narrow fence-stripping compatibility fix only if the evidence showed an otherwise exact valid packet inside a single conventional fence. It does not, so none was implemented. Acceptance is unchanged: the whole result text must be strict JSON.

*Later (O5.5B10, `docs/o5-5b10-claude-structured-output.md`):* a mechanically defined single-outer-fence envelope was added for Claude change proposals only, and `malformedResultShape` was replaced by a structure-only diagnostic recorded in probe evidence. That does not re-judge this probe: its reply was never persisted, so this record stays `MALFORMED_PROPOSAL`.

*Later (O5.5B11, `docs/o5-5b11-claude-live-reprobe.md`):* one new, separately authorized Claude turn with the same binding PASSED (one clean json fence, validated, host-applied, verified 3/3). It was appended as a new record; this O5.5B9 record is unchanged history. The O5.5B9 authorization is now marked consumed in code.

**Evidence-quality fixes for any future authorized probe** (deterministic; they change no acceptance rule and do not alter this result):
- `malformedResultShape` (Claude stream parser): a malformed result is now described by its structure only — e.g. `fenced; fences=2, tag=json, closed=yes, after=none, body=strict-json-object` — number of fence lines, the class of the opening tag (`json`/`none`/`other`, never the tag), whether a closing fence exists, whether text follows it, and whether the enclosed body alone would be strict JSON. No content leaves the parser; nothing is ever accepted from it (tested adversarially: exact fence, generic fence, trailing text, multiple fences, unclosed, malformed body, prose before the fence).
- The Claude adapter now keeps the verified init readback of a turn that got past initialization even when the turn then fails (`initReadback`), and the probe records it (`runtimeReadback.source: initOfFailedTurn`). In this probe those values are DEDUCED, not recorded, because this retention did not exist yet.

**What the Claude result proves:** the production Claude Change Author path runs end to end on a real subscription session in a Fusion-owned view with the read-only posture, a single guarded turn, and fail-closed handling of non-conforming output (no application, no verification, no retry, no mutation). **What it does not prove:** that Claude (haiku, effort low) produces a conforming ChangeSet through this prompt; any Claude change-proposal capability. A parser change could not retroactively make this probe pass.

## 7. Muse (Exec adapter)

| Item | Evidence |
| --- | --- |
| Real provider call | Yes: one `providerTurn` process (`muse-bin-1.3.0-R3401.1.exe exec --json …`, exit 0) — LIVE-OBSERVED. |
| Proposal turns | Exactly 1 (`providerTurn = 1`, `proposalCalls = 1`, `malformedOutputRetries: 0`); `delegateAttempts = 1`. |
| Other processes | 1 `providerHost` (`serve --disable-write --disable-shell`, the account-attestation host) in an empty Fusion-owned directory `%TEMP%\fusion-muse-attest-d9LXcl`, exit 0 and removed. |
| Version | Installed and executable `1.3.0-R3401.1` = validated — LIVE-OBSERVED. |
| Configured / effective model | Configured provider `meta`, model `muse-spark-1.3`, effort `minimal`, `--max-model-steps 4`; effective (`run.model.configured`) provider `meta`, model `muse-spark-1.3` — LIVE-OBSERVED. |
| Auth / billing lane | BillingGuard clear, lane `subscription`; account attestation before and after the turn `authenticated / subscription / msp:account/read:accountLogin` — LIVE-OBSERVED. No `MODEL_API_KEY`/`META_API_KEY`; no PAYG fallback. |
| Workspace / cwd | The Exec turn ran with cwd and `--workspace` = the baseline view `%TEMP%\fusion-provider-view-LyQmjY\workspace`; view checks all true; no argument named the primary — LIVE-OBSERVED. |
| Tool / posture | `--approval-mode never --disable-write --disable-shell --disable-web-tools --approval-judge off --no-foreign-personal-context`, strict `--output-schema`, no widening flag, no forbidden variable — LIVE-OBSERVED. |
| Proposal outcome | Structured output decoded and validated: 1 operation, `writeText src/name.js`, `expectedSha256 86016c9b…8316` (the Fusion-supplied baseline), content `name.trim().toLowerCase()` (134 bytes, `9b45d4c5…464f`) — LIVE-OBSERVED. |
| ChangeSet validation | Schema, exact scope, canonical path, no duplicates, preconditions, no forbidden/dependency/test path: validated (`proposal: validated`). |
| Private candidate | Fusion host-applied the ChangeSet into a fresh private candidate: ledger `before 86016c9b… → after 9b45d4c5…`, changed paths exactly `["src/name.js"]`; released complete. |
| Docker verification | **PASS**: backend `docker-linux`, confinement `osSandbox`, acceptance `granted` in the probe's process, platform `platform-neutral`, guest Node `v22.20.0` linux/x64, result accepted, `unit` 3 tests / 3 pass / 0 fail (2.7 s) — observed by Fusion, not claimed by the model. The acceptance authority grants only with the complete B6 evidence set (zero host mounts, network none during verification, no provider credentials in the verifier environment); those facts are not itemized in this evidence file. |
| Primary | `508a112b…0e54` before = after; canaries unchanged. |
| Provider view | 3 fingerprint observations, all equal; released complete. |
| Cleanup | 4 attributed temporary directories (view, candidate, Exec attempt, attestation), none left; 0 containers before/after. |

**What the Muse result proves:** one real Muse Exec change proposal, produced read-only in a Fusion-owned view under the subscription lane at the lowest exercised effort, was validated by Fusion, host-applied into a private candidate and verified by the accepted confined backend, with the primary and view unchanged and complete cleanup. **What it does not prove:** autonomous primary delivery, OS-level provider filesystem isolation, Windows verification, other dependency shapes, arbitrary projects or tasks, repeatability (single sample on a trivial fixture), the full Writer route with a real Lead, Reviewer and adjudication, or any Claude capability.

## 8. Readiness impact

Recorded live evidence is static data in the provider profiles (`ProviderTransportProfile.changeProposalLiveEvidence`), bound to the exact runtime version probed: `muse-exec 1.3.0-R3401.1: PASS`, `claude-one-shot 2.1.280: MALFORMED_PROPOSAL`. Another version is not covered. `fusion doctor` shows it per Worker binding (`live evidence recordedPass|recordedFailure|absent`; `ready no`).

| Gate | Before | After | Evidence kind |
| --- | --- | --- | --- |
| providerChangeProposal | blocked | **partial** (1 of 2 Change Author families passed; `satisfied` requires a recorded PASS for every family) | recordedLiveProbe |
| providerChangeProposalImplementation | satisfied | satisfied | fakeProcess |
| hostControlledWriterWorkflow | partial | partial (full route still fake-provider only) | fakeProviderRehearsal |
| billingAndAuthPosture | satisfied | satisfied (live readback now observed once per family) | mechanical |
| verificationIsolation | per-process grant | unchanged | liveProcess |
| liveGateAuthorization | blocked | blocked | none |

All other rows are unchanged. `writerReadiness()` stays `REAL_WRITER_MODE_NOT_READY`; `REAL_WRITER_LIVE_GATE_AUTHORIZED` stays `false`; no input (provider text, forged acceptance, rehearsal) changes any row.

## 9. Security review (Stage 2)

Provider call count: exactly one proposal turn per provider, no retry, no rerun (claims present; Stage 2 made no provider call). Retry: the probe profile keeps `malformedOutputRetries: 0`; the production default is unchanged. Fence parsing: none added; acceptance unchanged. False PASS: Claude is recorded as a failure everywhere. Fake/live mixing: rehearsal evidence is labelled `offlineRehearsal`; recorded live evidence is version-bound static data from validated files. Readiness: only the provider change-proposal row moved, to `partial`. Primary and view: unchanged (recomputed). Secrets: none persisted; the new diagnostic is structural only. Cleanup: complete.

## 10. Validation

No provider call during any of it (fake native binaries, fake Docker daemon; `npm test` is offline).

| Run | Result |
| --- | --- |
| Focused O5.5B9 (`test/o5-5b9-proposal-probe.test.ts`) | 15/15 |
| Provider adapters (Claude, Muse, M7 providers, B8 adapter cwd, quarantine drift, provider profiles) | 134/134 |
| BillingGuard/auth | 11/11 |
| Provider views (views, primary monitor, B8 red team) | 23/23 |
| ChangeSet (host change, private writer) | 16/16 |
| Writer workflow (B7 suites, O3 workflow/integration/hardening) | 72/72 |
| Verification/Docker (B5, B6, B4 backend/environment, O1, B3 proof contract) | 102/102 |
| Review/adjudication (O4, O5.5A) | 64/64 |
| Readiness (B6 selection, B8 composition, O5 CLI, B8 delivery) | 38/38 |
| `npm test` #1 | 582 tests, 581 pass, 1 skip (symlink privilege), 0 fail |
| `npm test` #2 | 582 tests, 581 pass, 1 skip, 0 fail |

The opt-in live suites (`test:live`, `test:docker-live`, `test:writer-live`, the probe entry) were not run in Stage 2.

## 11. Remaining blockers

1. Claude has no passing live change proposal (the only probe was refused as fenced output).
2. Aggregate provider change-proposal readiness needs a passing probe for every Change Author family.
3. The full Writer route (real Lead plan, fresh Reviewer, adjudication, correction) has never run live.
4. Provider CLIs run on the host without an OS filesystem boundary (views are working directories).
5. Single-sample evidence on a trivial fixture; no Windows-required verification; restricted dependency lane only.
6. The live gate has no authorization mechanism (by design).

## 12. Recommendation

**O5.5B10 — Claude structured-output conformance, then one separately authorized Claude re-probe.** Without a provider call: decide between (a) a narrowly bounded single-outer-fence normalization and (b) a validated structured-output channel. Decide from the new content-free diagnostic, the Claude CLI's documented options and fixture tests — not from guesses about this run. Validate the Claude 2.1.281 launch posture, or keep pinning 2.1.280. Then run one new, separately authorized Claude proposal turn with the improved evidence (init readback kept on failure, structural diagnostic). Keep aggregate readiness and the live gate closed until both families pass.

## Decision

```
CLAUDE_REAL_CHANGE_PROPOSAL: FAIL
MUSE_REAL_CHANGE_PROPOSAL: PASS
CLAUDE_PRIMARY_UNCHANGED: YES
MUSE_PRIMARY_UNCHANGED: YES
CLAUDE_PROVIDER_VIEW_UNCHANGED: YES
MUSE_PROVIDER_VIEW_UNCHANGED: YES
CLAUDE_PRIVATE_CANDIDATE_VERIFIED: NO
MUSE_PRIVATE_CANDIDATE_VERIFIED: YES
PROVIDER_CHANGE_PROPOSAL_READINESS: NO
REAL_WRITER_MODE_READINESS: NO
O5_5B_READINESS: NO
O6_READINESS: NO
REAL_WRITER_LIVE_GATE_AUTHORIZED: NO
```
