# O5.5B11 — Authorized Claude live re-probe

Labels: **LIVE-OBSERVED** (recorded by the probe from the real run, in the validated evidence file), **RECOMPUTED** (re-derived in Stage 2 from the artifacts on disk, without any provider call), **DEDUCED** (not recorded as a value, but the recorded outcome is reachable only if the fail-closed check passed), **NOT PROVEN**.

Outcome in one line: the one authorized Claude change-proposal turn (Claude Code 2.1.280, `haiku` → `claude-haiku-4-5-20251001`, effort `low`, OAuth-token subscription lane, Fusion-owned view, read-only posture) answered with **exactly one ```` ```json ```` fence around a valid ChangeSet**. The O5.5B10 envelope accepted it (`SINGLE_FENCED_VALID_JSON`); Fusion validated the ChangeSet, host-applied it into a private candidate (only `src/name.js` changed) and verified it **3/3** in the accepted confined Docker/Linux backend. Primary and view were unchanged, cleanup was complete, there was one model turn and no retry: **CLAUDE_REAL_CHANGE_PROPOSAL = PASS**. With Muse's O5.5B9 PASS, every Change Author family now has a recorded live PASS, so the provider change-proposal gate reads **satisfied**. The real Writer mode, O5.5B and O6 stay **not ready**, and the live gate stays closed.

## 1. Human authorization scope

The human authorized exactly ONE real Claude change-proposal model turn:
- Claude only, Claude Code 2.1.280, the O5.5B9 binding (`haiku`, effort `low`, at most 3 agentic turns), one proposal turn;
- no automatic retry, no second turn, no Muse or other provider call;
- a throw-away fixture only; no real project, no primary mutation;
- no provider write, shell or web tools; no delivery, no push;
- Fusion validates the ChangeSet and host-applies it only into a private candidate, and verification runs in the accepted confined Docker/Linux backend;
- `REAL_WRITER_LIVE_GATE_AUTHORIZED` stays false.

The live turn ran from a normal PowerShell window, by the human, outside the Claude Code process tree. Stage 1 and Stage 2 made no provider call.

## 2. Why a new probe was required

The O5.5B9 Claude result was a failure that no later code can re-judge: the refused reply was never persisted. Showing that Claude can deliver an acceptable ChangeSet through the hardened path took a new, separately authorized model turn. Its only intended variable was the O5.5B10 envelope: same CLI version, binding, fixture, task and composition.

## 3. The O5.5B9 Claude failure

One turn, 2026-09-24T13:36Z: the reply began with a Markdown fence and the strict whole-text parser refused it as `MALFORMED_PROPOSAL`. Nothing was applied or retried. That record is **kept unchanged** as history: `changeProposalLiveRecords("claude", "claude-one-shot")` lists it first.

## 4. The O5.5B10 hardening

For Claude change proposals, the reply is read under a mechanical envelope: raw strict JSON, or exactly one outer ```` ```json ```` or bare fence with only whitespace outside it. The body must be a strict JSON object that satisfies the decoding schema, and it then goes through the unchanged `validateChangeSet`. The envelope never extracts from prose, never repairs, and refuses a second fence or a second value. A 27-key structure-only diagnostic (never content) is recorded, and `--json-schema` stays a widening flag. See `docs/o5-5b10-claude-structured-output.md`.

## 5. The new O5.5B11 authorization and evidence namespace (Stage 1)

- **Authorizations are data** (`PROPOSAL_PROBE_PROFILES.authorizations`, provider layer). For each provider family, a grant lists:
  - the exact installed runtime versions;
  - the credential lanes allowed;
  - the binding facts, compared exactly: adapter, model, effort, turn limit and listed options;
  - the environment keys that must be set.
  - `O5.5B9` is `consumed`.
  - `O5.5B11` granted Claude only: version `2.1.280`; lanes `subscription`/`subscriptionToken`; binding `claude-one-shot`/`haiku`/`low`/3/`claude-haiku-4-5-20251001`; `FUSION_CLAUDE_EXE` required.
  - **Stage 2 set `O5.5B11` to `consumed`.** The live entry now has no open authorization, and a lost claim file cannot reopen either one.
- **Refusals before anything exists:** an unknown or consumed token (exact match), a provider the authorization does not name, a nested Claude Code session, an evidence directory that is not this authorization's namespace, and a provider already attempted.
- **Namespace:** `%TEMP%\fusion-o5-5b11-probe`, marked on first use with `authorization.json`. A non-empty directory without the marker, with another authorization's marker, or holding another authorization's claim is refused. The O5.5B9 directory is never read or written.
- **Static preflight (no provider process):**
  - binding ≠ grant → `MODEL_BLOCKED` (new outcome);
  - required variable missing, version unvalidated or not granted → `VERSION_BLOCKED`;
  - billing guard blocked or lane not granted → `AUTH_BLOCKED`;
  - posture ineligible → `POSTURE_BLOCKED`.
- **Pre-launch guard (new):** every provider process is checked *before* it starts, and a refused start never runs. It refuses a process that would:
  - start outside a checked Fusion-owned view (a protocol host may use an empty Fusion-owned temp directory);
  - carry an argument naming the primary;
  - receive a forbidden variable;
  - be a second model turn;
  - be a model turn missing a read-only control or carrying a widening flag.
- The supervisor now settles a refused launch as `refused` instead of leaving it pending. A wrong effective model is `MODEL_BLOCKED`.
- **Evidence schema 3:** adds `authorization` (id, milestone, grant) and `launchGuard`. Process counts are of started processes only.

## 6. Fixture

The O5.5B9 fixture, unchanged: a Node ESM project created under `%TEMP%\fusion-o5-5b11-probe\claude-fixture-63ee8a9af0d0\primary` and committed once (HEAD `9593a31a…3c768`). It contains:
- `package.json` (no dependencies), `README.md`, `.gitignore`;
- `src/name.js`: `normalizeName` lowercases but does not trim;
- `test/name.test.js`: 3 `node:test` tests;
- ignored synthetic canaries `.env` and `secrets.local` (a protected path).

Only `src/name.js` is allowed; the test file and `package.json` are forbidden. A deterministic test proves the baseline fails exactly 2 of 3 tests and the intended fix passes 3 of 3 (host Node, synthetic code only).

## 7. Claude CLI version

Installed package 2.1.280, which is both validated and granted (preflight) — LIVE-OBSERVED. The human used the side-by-side install through `FUSION_CLAUDE_EXE` (`set`; the value is never recorded) and confirmed `2.1.280 (Claude Code)`. The **init readback of the completed turn reported 2.1.280** — LIVE-OBSERVED (`runtimeReadback.runtimeVersion`, source `completedTurn`).

## 8. Configured and effective model

Configured `haiku`, canonical `claude-haiku-4-5-20251001`, effort `low`, `--max-turns 3` — LIVE-OBSERVED in the preflight binding check (`bindingMatchesAuthorization: true`) and in the turn's argv. The effective model `claude-haiku-4-5-20251001` was read back at init — LIVE-OBSERVED (`runtimeReadback.effectiveModel`, `identity[0].observedModel`).

## 9. Auth and billing lane

- BillingGuard clear, candidate lane `subscriptionToken` (a `CLAUDE_CODE_OAUTH_TOKEN` was present; no `ANTHROPIC_*` variable) — LIVE-OBSERVED.
- Auth readback `authenticated`, lane `subscriptionToken`, `auth-status:firstParty:explicitOAuthToken:sourceFieldAbsent` — LIVE-OBSERVED.
- Init credential source `apiKeySource: none` — LIVE-OBSERVED.
- No PAYG fallback exists.

## 10. Provider workspace and cwd

All 6 provider processes ran with working directory `%TEMP%\fusion-provider-view-Q8Q3F4\workspace` (class `providerView`). No argument named the primary, and no forbidden variable reached any process. The view checks — owned location, disjoint from the primary, no `.git`, no provider state paths — were all true — LIVE-OBSERVED. The pre-launch guard refused nothing.

## 11. Tool and posture

- **Turn argv** — LIVE-OBSERVED; `posture: { missing: [], widening: [] }`:
  - `--tools Read,Grep,Glob`, `--permission-mode dontAsk`, `--permission-prompts none`;
  - `--restricted`, `--safe-mode`, `--strict-mcp-config`, `--disable-slash-commands`, `--no-session-persistence`, `--include-hook-events`;
  - child-only `--settings` (plugin quarantine).
- **Init readback** — LIVE-OBSERVED:
  - tools exactly `Glob`, `Grep`, `Read`; `permissionMode: dontAsk`;
  - 0 MCP servers; 0 loaded plugins (2 built-ins disabled, 1 verification round);
  - no write, edit, shell or web tool.

## 12. Provider process counts

| Purpose | Count | Note |
| --- | --- | --- |
| `providerAuthReadback` (`auth status`) | 2 | exit 0 |
| `providerInventory` (`plugin list --json`) | 1 | exit 0 |
| `providerInitProbe` (init-only startups of the plugin quarantine) | 2 | cancelled by Fusion at the init report (`killReason: protocolError`) |
| `providerTurn` (the proposal turn) | **1** | exit 0 |
| `providerHost` | 0 | |

`proposalCalls: 1`, `delegateAttempts: 1`, no launch refused. The init-only startups are not proposal turns; **whether the CLI had begun an upstream request before Fusion cancelled them remains NOT PROVEN either way** (unchanged since O5.5B9).

## 13. Structured-output classification

**`SINGLE_FENCED_VALID_JSON`**, accepted under `rawOrSingleJsonFence` — LIVE-OBSERVED. Claude again wrapped its reply in a fence, even with the O5.5B10 closing instruction. This time the reply was exactly one clean fence.

## 14. Structure-only diagnostic

- `channel: resultText`, 323 bytes, 3 lines, `lf`, no BOM, no raw control characters;
- `beginsWithFence`, backticks, language `json`, `exactlyOneFencePair`, `fenceClosed`, 2 fence lines;
- whitespace only before and after the fence; no extra text; no second fence; no second value;
- body: a strict JSON object, schema-conforming, no parse failure.

27 keys, all enumerations, booleans or counts. The reply itself was not persisted.

## 15. Proposal parsing

The envelope read the fence body with `parseStrictJson` (duplicate keys and nesting deeper than 64 refused). The body was an object matching `changeSetSchema()` and was handed on as a raw value would be. No extraction, no repair.

## 16. ChangeSet validation

The unchanged `validateChangeSet` accepted exactly one operation (`proposal.events: validated, 1 operation`) — LIVE-OBSERVED:
- `writeText src/name.js`;
- `expectedSha256 86016c9b…8316`, equal to the fixture baseline (RECOMPUTED from the file);
- content `9b45d4c5…464f`, 134 bytes: the trim-then-lowercase fix. This is the pre-existing, documented bounded field for the synthetic fixture target; the hash and size were RECOMPUTED.

## 17. Private candidate

Fusion host-applied exactly that write into a fresh private candidate (before `86016c9b…`, after `9b45d4c5…`). Changed paths: `["src/name.js"]`. The candidate was released (`1/1`, complete). Claude never received the candidate: its only workspace was the baseline view.

## 18. Docker verification

- Acceptance granted in the probe's own process by the production backend.
- One confined run: `docker-linux`, `osSandbox`, platform-neutral; runtime `node v22.20.0 linux x64`; result accepted.
- `/usr/local/bin/node --test test/name.test.js` (read-only): **3 tests, 3 pass, 0 fail** — LIVE-OBSERVED.
- The backend's contract (unchanged since O5.5B6) gives the verifier zero host mounts and zero provider credentials, and runs the verification step with no network.
- The model's own claims played no part.

## 19. Fixture and primary integrity

- Primary digest `6c9c8c9c…9741`, before = after; 62 files; canaries unchanged — LIVE-OBSERVED.
- **Stage 2 recomputed the digest from disk with the harness's walker: equal** (same HEAD, same 62 files). The canaries equal the synthetic values, and `git status --ignored` shows only the two ignored canaries.

## 20. Provider-view integrity

One baseline view; 3 fingerprint observations, all equal; released complete; `providerViews: created 1, released 1, complete` — LIVE-OBSERVED.

## 21. Cleanup

- 3 attributed temporary directories (view, candidate, plugin settings), none left — LIVE-OBSERVED.
- The view and plugin-settings directories named in the evidence no longer exist (RECOMPUTED). No other `%TEMP%\fusion-*` directory from the run window exists besides the evidence namespace itself.
- 0 Fusion-labelled containers before and after (recorded) and now (checked with the local Docker CLI).

## Evidence validation (Stage 2, no provider call)

- **Harness identity:** the evidence records compiled-source digest `c94906e8…df3f` (100 modules) and live entry `4163b893…803c`. Both equal the identity recorded from the Stage-1 build *before* the human ran it, and the working tree was byte-identical to the Stage-1 snapshot patch.
- **Validation script:** a separate script (not the classifier) checked 53 conditions over the evidence, the marker, the claim, the fixture and the temporary directory — all passed. It covered: schema, milestone, authorization and claim identity; preflight; counts; cwd; environment; posture; readback; diagnostic; ChangeSet; candidate; verification; view; primary; cleanup; the recomputations above; and the absence of canary values, prompt text, credential shapes, account data, fence text and user paths.

## 22. What the result proves

For this binding (Claude Code 2.1.280, `haiku`/`low`, OAuth-token subscription lane), in one read-only turn in a Fusion-owned view, Claude produced a reply that Fusion's envelope, schema check and unchanged ChangeSet validator accepted. The ChangeSet, host-applied into a private candidate, made the fixture's confined tests pass 3/3, with primary, view and canaries unchanged and cleanup complete. It also shows that the O5.5B10 envelope works on a real reply, and that the production Claude Change Author path runs end to end under the pre-launch guard.

## 23. What it does not prove

- **Consistency:** a single sample on a trivial one-file fixture; not that Claude always conforms. It also shows that Claude (haiku, low) still fences its JSON despite two explicit instructions.
- **Other bindings:** anything about another version (2.1.281), model or effort. The record is bound to version, model and effort.
- **The full Writer route:** real Lead planning, real Reviewer independence, real Lead adjudication, correction cycles.
- **Isolation:** OS-level filesystem isolation of provider processes (views are working directories; provider CLIs run on the host under the user's token).
- **Delivery and platforms:** human-approved delivery to a primary; Windows-required verification; unrestricted npm, dependency or project support; arbitrary project safety.
- **Init-only startups:** whether they sent upstream requests.

## 24. Readiness impact

- **Recorded live evidence** (`runtime/provider-profiles.ts`; records now carry `model` and `effort`):
  - Claude `claude-one-shot` 2.1.280: [O5.5B9 `haiku`/`low` MALFORMED_PROPOSAL, **O5.5B11 `haiku`/`low` PASS**].
  - Muse `muse-exec` 1.3.0-R3401.1: [O5.5B9 `muse-spark-1.3`/`minimal` PASS], preserved.
- **Doctor:** `changeProposalLiveEvidence` now matches on version, model and effort. A Worker binding on another model shows `absent`, never a borrowed PASS, and per-binding `ready` stays `false`.
- **Gate:** computed by the existing policy (`satisfied` iff every registered Change Author family has a recorded PASS on a validated version); coverage 2 of 2.

| Gate row | Before | After |
| --- | --- | --- |
| `providerChangeProposal` | partial / recordedLiveProbe | **satisfied** / recordedLiveProbe |
| `structuredOutputEnvelope` | satisfied / fakeProcess | unchanged (text notes one real reply passed) |
| `providerChangeProposalImplementation`, `productionWriterComposition`, `hostControlledApplication`, `platformCompatibility`, `cleanupAndRecovery`, `reviewAndAdjudication`, `billingAndAuthPosture` | satisfied | unchanged |
| `primaryProtection`, `providerWorkspaceBoundary`, `ignoredPathProtection`, `hostControlledWriterWorkflow`, `dependencySupport`, `sharedGitAndIgnoredPaths` | partial | unchanged |
| `verificationIsolation` | notEvaluated (granted only per process) | unchanged |
| `liveGateAuthorization` | blocked | unchanged |
| `realWriterModeReady` / `REAL_WRITER_LIVE_GATE_AUTHORIZED` | false / false | false / false |

PROVIDER_CHANGE_PROPOSAL_READINESS: **YES**. REAL_WRITER_MODE_READINESS: **NO** (six rows partial, the live gate blocked). O5_5B_READINESS: **NO**. O6_READINESS: **NO**.

## 25. Remaining blockers

1. The full Writer route (real Lead plan, fresh Reviewer, adjudication, correction) has never run live.
2. Provider CLIs run on the host without an OS filesystem boundary; views are working directories (`providerWorkspaceBoundary`, `sharedGitAndIgnoredPaths`, `primaryProtection` partial).
3. Ignored-path monitoring is bounded (managed directories by a directory-level signal only).
4. Dependency support is the restricted npm lane only; Windows-required verification has no confined backend.
5. Live evidence is a single sample per family on a trivial fixture, bound to one version, model and effort each.
6. The live gate has no authorization mechanism, by design.

## 26. Recommendation

**O5.5B12 — full-route live rehearsal design, provider-free first.** Specify and harden, without a provider call, what a separately authorized end-to-end Writer run on a throw-away fixture would need: a real Lead plan, the Claude/Muse Change Author, a fresh real Reviewer and Lead adjudication, the bounded correction cycle, per-role turn budgets and authorizations (one grant per role turn), and the evidence each gate row would need to move from `partial`. Then ask for explicit authorization of that run. Keep `REAL_WRITER_LIVE_GATE_AUTHORIZED` false. Separately worth considering: a repeat-sample policy (several authorized turns across fixtures) before treating single-sample proposal evidence as stable.

## Decision

```
CLAUDE_REAL_CHANGE_PROPOSAL: PASS
MUSE_REAL_CHANGE_PROPOSAL: PASS
CLAUDE_PRIMARY_UNCHANGED: YES
CLAUDE_PROVIDER_VIEW_UNCHANGED: YES
CLAUDE_PRIVATE_CANDIDATE_VERIFIED: YES
CLAUDE_STRUCTURED_OUTPUT_CLASS: SINGLE_FENCED_VALID_JSON
PROVIDER_CHANGE_PROPOSAL_READINESS: YES
REAL_WRITER_MODE_READINESS: NO
O5_5B_READINESS: NO
O6_READINESS: NO
REAL_WRITER_LIVE_GATE_AUTHORIZED: NO
```
