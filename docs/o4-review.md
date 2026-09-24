# O4 fresh review, structured findings and Lead adjudication

O4 turns deterministically verified work into reviewed work. A fresh Reviewer reports structured findings on bounded evidence, the Lead adjudicates each finding, Fusion's own facts outrank the Lead where they apply, and a deterministic policy decides between success, one corrective attempt, and a decision or human gate. It makes no provider call and has no CLI: it runs only with fake adapters (`test/o4-review.test.ts`). Real Writer mode stays blocked; see "Real Writer mode gate" in `docs/o3-workflow.md`.

## Modules

| Module | Owns |
|---|---|
| `src/core/domain.ts` | `Finding`, `ReviewerFinding`, `FindingFact`, `AdjudicationReport`, `AdjudicatedFinding`, `ReviewEvidence`, `ReviewRequest`, `AdjudicationRequest`, `StructuredTurnResult`, and the optional `ProviderAdapter.runStructuredTurn` |
| `src/core/review/findings.ts` | Strict, bounded validation of review and adjudication output; canonical finding IDs; Fusion fact evaluation; evidence-over-assertion adjudication |
| `src/core/review/policy.ts` | When a fresh review is required, the outcome of an adjudicated review, and the review evidence builder |
| `src/core/workflow/engine.ts` | The review cycle inside the workflow state machine (`reviewing` → `adjudicating`) and the shared attempt budget |
| `src/platform/workflow/ports.ts` | Event/artifact persistence (the O4 `LeaseWorkspacePort.diff` is now `PrivateCandidateWorkspacePort.diff` in `candidates.ts`, O5.5B7) |
| `src/platform/events/*` | `ReviewCycleStarted/Completed`, `ReviewStarted/Completed`, `FindingRecorded`, `AdjudicationRecorded` |

All core modules stay provider-neutral: a test scans `src/core/review`, `src/core/workflow` and `src/core/policy` for provider or model names, and swapping every identity leaves transitions and events identical.

## When a fresh review runs

| Final risk | Review |
|---|---|
| low | none; Fusion verification only |
| medium | the Lead reviews (O3). A writer whose task changes verification-control files or files the verification plan names gets a fresh review instead |
| high | fresh Reviewer and Lead adjudication, for writers and for read-only tasks |
| critical | human gate before any writer (unchanged) |

A flow whose initial risk already requires a fresh review routes the Reviewer and an adjudicating Lead before any turn runs; if either is missing, it fails closed as `failed`/`CapabilityUnavailable`. If the risk only escalates mid-flow (for example a medium task whose first verification failed), roles are routed at review time, and a missing role ends the workflow as `reviewRequired` with `CapabilityUnavailable` and `pendingStage: freshReviewAndAdjudication`. The Worker is never used as a Reviewer.

## Reviewer eligibility and freshness

- The Reviewer and the adjudicating Lead are routed by capability, never by name: read-only posture, `filesystem.write: false`, no shell, web tools disabled, and a `runStructuredTurn` implementation. They always use the strict surface (no shell, no network), even when the task itself requested shell or network. `unknown` never satisfies.
- Every review and adjudication is a new session, closed after its single turn, attached read-only to the lease (or the primary for read-only tasks). The engine refuses any session ID an adapter has already issued in the run. Review and adjudication turns prove both the lease and the primary unchanged.

## Review evidence

Built only from the caller's delegation packet and Fusion's observations (`ReviewEvidence`):
- task goal, constraints and acceptance criteria; architecture decisions and invariants; allowed, relevant and forbidden files;
- Fusion's verification result per command;
- the observed change: for a writer, a bounded diff of the lease against its base (tracked changes plus untracked files, links not followed, binary files elided, at most 256 KiB and 1,000 paths, flagged `truncated`); for a read-only task, its answer.

It never contains transcripts, the implementer's own summary or claimed test results, the Lead's plan, or reviewer prose. A re-review additionally receives only the findings accepted in the previous cycle (`priorFindings`).

## Finding schema

A Reviewer returns exactly `{ findings, summary }`. `summary` is informational: prose such as "looks good" has no authority, and zero findings is valid only as a structured report. Each finding has exactly:

| Field | Rule |
|---|---|
| `id` | the Reviewer's key, `[A-Za-z0-9][A-Za-z0-9._-]{0,31}`, unique case-insensitively within the report |
| `severity` | `BLOCKER`, `HIGH`, `MEDIUM`, `LOW` or `INFO` |
| `confidence` | `HIGH`, `MEDIUM` or `LOW` |
| `category` | single-line label, ≤ 64 characters |
| `title` | single-line claim, ≤ 200 characters |
| `evidence` | 1–8 items, ≤ 1,000 characters each |
| `failureScenario` | reproduction or realistic failure scenario, ≤ 2,000 characters |
| `file`, `lines` | optional repository-relative path (no absolute or `..` paths) and `{start, end}` with `1 ≤ start ≤ end` (requires `file`) |
| `suggestedFix` | optional, ≤ 2,000 characters |
| `facts` | optional, ≤ 8 checkable claims: `verificationCommand {commandId}`, `outOfScopeChange {path}`, `unrunClaim {test}` |

At most 32 findings per review. Output is structured-cloned before validation, so getters, proxies or later mutation by the adapter cannot change what was validated. Any unknown key, wrong type or bound violation fails the workflow closed as `MalformedOutput`. Fusion assigns the canonical ID `r<cycle>-<key>` (deterministic, and distinct across cycles) and the provenance `{ role, runId, sessionId, cycle }`; the Reviewer can set neither.

## Adjudication schema

The Lead receives the review evidence, the canonical findings and Fusion's evaluation of each finding's facts (`fusionFacts`), never the Reviewer's summary or transcript. It returns `{ adjudications, summary }` with exactly one entry per finding: `{ findingId, verdict, rationale (≤ 1,000 characters), requiredAction }`. Missing, unknown or repeated finding IDs are `MalformedOutput`. Verdicts are `CONFIRMED`, `PARTIAL`, `REJECTED` or `UNVERIFIABLE`; the required action must fit:

| Verdict | Allowed `requiredAction` |
|---|---|
| `REJECTED` | `none` |
| `UNVERIFIABLE` | `none` or `humanDecision` |
| `CONFIRMED`/`PARTIAL`, material severity (BLOCKER, HIGH, MEDIUM) | `fix` or `humanDecision` |
| `CONFIRMED`/`PARTIAL`, LOW or INFO | any |

**Evidence over assertion.** Fusion evaluates each fact against what it observed: a verification command that did not pass, a changed path outside the delegated scope, or a check the implementer claims to have run that Fusion never ran. When a fact holds, a `REJECTED` or `UNVERIFIABLE` verdict is overridden to `CONFIRMED` (`verdictSource: fusionEvidence`, action `fix` for material findings). Each adjudicated finding is persisted as `{ finding, verdict, rationale, requiredAction, verdictSource, supportedFacts }`.

## Outcome and the bounded fix cycle

A finding is outstanding when it is `CONFIRMED`/`PARTIAL` with a material severity, or `UNVERIFIABLE` with severity BLOCKER or HIGH.

1. No outstanding finding: success. `completed` if Fusion verification of the final attempt passed, otherwise `answered` (a read-only task with nothing to verify). A review can never upgrade `answered`.
2. Every outstanding finding is fixable (`fix`, not unverifiable), this is the first review, and the implementer budget allows another attempt: one corrective Worker attempt in the same lease. It receives the confirmed findings as bounded constraints (scanned for destructive intent like any forwarded text), then goes through scope checks, Fusion verification, a fresh Reviewer and Lead adjudication again.
3. Otherwise a gate: `humanGateRequired` (`pendingStage: humanGate`) if any outstanding finding is a BLOCKER, else `decisionRequired` (reason `unresolvedFindings`).

The implementer budget is shared: an O3 verification or status retry and the O4 corrective attempt draw on the same two attempts, so there is never a third Worker attempt. At most two review cycles run. A corrective attempt that fails verification stops as `decisionRequired` (`retryExhausted`) without a second review; unverified work is never reviewed.

## Events and storage

In order, before any terminal state: `ReviewCycleStarted {cycle}`, `ReviewStarted {cycle}`, `FindingRecorded` per finding, `ReviewCompleted {cycle, findingCount}`, `AdjudicationRecorded` per finding, `ReviewCycleCompleted {cycle, outcome: clean | correction | gate}`. Payloads are closed vocabularies and bounded, redacted labels: `FindingRecorded {cycle, findingId, severity, confidence, category, title, file?, lineStart?, lineEnd?, artifactRef?}`, `AdjudicationRecorded {cycle, findingId, verdict, requiredAction, verdictSource, artifactRef?}`. With an `ArtifactStore`, the full finding and the adjudication rationale are stored as redacted JSON artifacts; rationale text never enters the event log. A failed append ends the workflow as `failed`/`InternalError`, never success, and never masks a security failure. Local metrics count confirmed and rejected findings.

## Limitations

- Fresh review relies on adapters implementing `runStructuredTurn` and proving a read-only surface plus review isolation before their first turn. Since O5.5A, the Claude one-shot and Muse exec adapters do both on their validated runtime versions (see "Real read-only review" in `docs/o5-cli.md`); any other version stays ineligible. Capability routing was not weakened to admit them.
- Review evidence contains the lease diff, which can include whatever the implementer wrote; the Reviewer is read-only and sees it only as data.
- Adapter-side memory across sessions cannot be observed; freshness is enforced per session ID and per request content.
- Real Writer mode remains blocked (F-02/F-03): see `docs/o3-workflow.md`.
