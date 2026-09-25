# O5.5B28 — Lead-adjudication probe (offline foundation)

Labels: **IMPLEMENTED + FAKE-TESTED** (offline), **NOT RUN LIVE**.

O5.5B28 builds a probe that runs **exactly one real Lead adjudication turn**, with the production Lead binding, over a **fixed, Fusion-authored finding set**. It runs no Lead plan, no Change Author, no fresh Reviewer and no full route.

The adjudication branch is the first of the three route branches no live run has reached: Lead adjudication after review findings, then review-driven correction, then re-review. O5.5B27 passed the full route with a clean review, so its adjudication never ran.

Constraints of this milestone:
- no provider was called;
- no authorization exists (`ADJUDICATION_PROBE_PROFILES.authorizations` is empty);
- no readiness row, aggregate or gate moves;
- no production prompt, schema, envelope or contract changed.

## 1. What the Lead sees: production pieces only

The probe builds exactly the request the engine sends the Lead in review cycle 1 (`engine.freshReview`), from the production functions:

| Part | Source | Pinned by |
| --- | --- | --- |
| Primary | the route fixture (the "quotes" project plus ignored canaries), created fresh | `routeFixtureIdentity()` `59c19d1f…8326` |
| Candidate | `REVIEW_CANDIDATE_CHANGE`: the correct fix plus a regression test, validated by the core and host-applied by the production candidate port into a private candidate | `reviewCandidateIdentity()` `a8e6622d…4952` |
| Verification | Fusion's own confined verification of that candidate (typecheck, unit), **before** the claim and before any provider process | — |
| Evidence | `reviewEvidence(ROUTE_PACKET, verification, observed diff)`: task, scope, architecture, Fusion's verification and the diff | — |
| Findings | `ADJUDICATION_REVIEW_REPORT` (below), turned into production findings by `validateReviewReport` (cycle 1 → `r1-F1`…) | `adjudicationFindingsIdentity()` `905bd34b…eec0` |
| Fusion facts | `evaluateFacts(finding, observed)`: verification map, changed paths, allowed scope, no claimed tests (a Writer attempt claims none) | — |

The Lead never sees:
- the Reviewer's summary (production drops it);
- the finding provenance (production's prompt strips `source`), whose session is the Fusion-owned label `fusion-authored-review` because no Reviewer session produced these findings;
- a Lead plan, a Change Author's or Worker's text, or any transcript. The probe has none, and the tests prove none of their markers is in the prompt.

### The deterministic finding packet

`ADJUDICATION_REVIEW_REPORT` is written in the Reviewer's own wire form (`{findings, summary}`):

| Id | Severity / confidence | Category, file | Claim | Facts | Fusion facts |
| --- | --- | --- | --- | --- | --- |
| `r1-F1` | MEDIUM (material) / MEDIUM | tests, `test/quote.test.ts` | "No test covers a partial discount" | — | — |
| `r1-F2` | LOW / HIGH | documentation, `src/quote.ts` lines 14–19 | "The doc comment does not state the rounding order" | — | — |
| `r1-F3` | HIGH (material) / LOW | correctness, `src/quote.ts` | "The unit tests fail after the change" | `verificationCommand: unit` | **contradicted** (Fusion's verification passed) |

Each claim is grounded in the fixture, and the tests assert it:
- F1 can be answered from the repository: the committed suite already has "applies the discount before tax", a 10 % discount.
- F2's lines are the fixed `totals` function.
- F3 is contradicted by Fusion's own verification result.

No verdict is expected or required: any verdict the production contract accepts is valid.

The request is `{ kind: "adjudication", cycle: 1, evidence, findings, fusionFacts }`, exactly the engine's shape. Its core prompt digest is recorded as `contractPromptSha256`, and the text is never stored.

## 2. The binding: the route Lead, exactly

`ROUTE_LEAD_ADJUDICATOR` is the route Lead's grant **object itself**, the Lead that plans (and would adjudicate) in O5.5B25 and O5.5B27:

| Setting | Value |
| --- | --- |
| Runtime | Claude Code **2.1.280** (the side-by-side install named by `FUSION_CLAUDE_EXE`), transport `claude-one-shot` |
| Model | `haiku`, read back as `claude-haiku-4-5-20251001` |
| Effort | `low` |
| Turn limit | **`--max-turns 6`** |
| Lanes | subscription, subscriptionToken (OAuth) |
| Controls | read-only: `--tools Read,Grep,Glob`, `--permission-mode dontAsk`, … and no widening flag |

Every model process must carry exactly `--model haiku`, `--effort low` and `--max-turns 6`.

**Turn limit.** "The max-turns production adjudication uses" is the route Lead binding's `--max-turns 6`. The engine runs the Lead's plan and its adjudication under one binding. Without a configured limit, the one-shot adapter would use 1.

The rest of the path is production's, unchanged:
- **Prompt:** the core `structuredTurnPrompt` adjudication prompt. The Claude transport appends nothing to it; its reply rule is for change proposals only.
- **Decoding schema:** `adjudicationReportSchema(["r1-F1", "r1-F2", "r1-F3"])`.
- **Envelope:** the transport profile's recorded `adjudicationEnvelope`, **`rawOrSingleJsonFence`** (O5.5B22). Preflight records it as `expectedEnvelope`, and PASS requires the reply to be reported accepted under exactly that policy.
- **Contract and decision:** `validateAdjudicationReport`, then Fusion's fact override `adjudicate`, then `reviewOutcome` for cycle 1 of the route's 2. Its decision class is one of `clean`, `correction` or `gate` (`decisionRequired` or `humanGateRequired`).

No schema was invented, eased or widened.

## 3. Bounds

**Authorization** (`AdjudicationProbeAuthorization`):
- states `pending`, `open`, `consumed` and `retired`; only `open` runs, and only once;
- the budget must be **exactly** `{ leadPlan: 0, changeAuthor: 0, freshReview: 0, leadAdjudication: 1 }` (`budgetNotAdjudicationOnly`);
- fixture, candidate and finding set are pinned (`fixtureMismatch`, `candidateMismatch`, `findingsMismatch`);
- it is refused inside an agent session (`nestedAgentSession`);
- it gets its own marked `%TEMP%` namespace, and a second attempt is refused (`alreadyAttempted`).

**Static preflight** starts no process and checks:
- the exact binding, and a release validated for that binding and authorized by the grant;
- the required environment and the credential lane;
- the structured review surface an adjudicating Lead needs;
- a pinned binary's location and bytes, when the grant pins them (the route Lead's grant does not);
- the recorded adjudication envelope.

**Composition:** the Lead binding alone, with the production adjudicator routing (`resolveRole`: structured turns, review isolation, workspace binding).

**Before the claim:**
1. the candidate is applied and verified;
2. the candidate view is opened and checked;
3. the session opens in it; the adapter's own account readback there must confirm an authorized lane.

A block at any of these steps writes a preflight file and consumes nothing.

**Claim:** `adjudication.claim.json` is written right before the only model turn.

**Turn gate (`AdjudicationTurnGate`):**
- allowed: `runStructuredTurn` of kind `adjudication`, cycle 1, once;
- refused before the adapter: `runTurn` (plan), `runChangeProposalTurn`, a review, or a second adjudication.

**Pre-launch guard:**
- only the Lead's executable runs, in the checked candidate view, with no primary path in its arguments and no forbidden variable;
- only the session readback runs before the claim;
- exactly one model process runs, carrying the read-only controls and the exact identity flags;
- nothing runs after the turn.

## 4. Outcome and PASS

The classification (`classifyAdjudicationProbe`) is deterministic and never reads provider text. It checks, in this order:
1. integrity (primary, view, candidate);
2. refused launches and turns, confinement, the executable;
3. Fusion's own stops, and a crash;
4. more than one model turn;
5. the turn's error (`MALFORMED_OUTPUT` for an envelope refusal, `PROVIDER_FAILED`, …);
6. an envelope that is not confirmed;
7. the contract (`CONTRACT_REFUSED`);
8. cleanup.

**PASS requires all of these:**
- exactly one claimed model turn that succeeded;
- the reply reported accepted under the recorded `rawOrSingleJsonFence` envelope;
- the production adjudication contract accepted it;
- the production review policy returned a decision;
- the primary, view and candidate are unchanged, and cleanup is complete.

A `gate` or `correction` decision is a valid PASS. It is the policy's decision, not a probe failure.

## 5. Evidence: bounded metadata only

The evidence records:
- **binding:** adapter, model, effort, `maxTurns`, and options without paths;
- **preflight:** installed and validated versions, validated-for-binding, lane, eligibility, `expectedEnvelope`;
- **verification** of the candidate;
- **request:** finding ids, severities, confidences, categories and fact kinds; per-finding counts of supported and contradicted Fusion facts; changed paths, diff byte count and verification; `contractPromptSha256`;
- **adjudication:**
  - turn status, requested and observed model, effort, `maxTurns`;
  - the **terminal diagnostic**: classification, subtype, reason, internal turn count, `structuredParsingReached`, `schemaValidationReached`, exit code;
  - the **structure-only envelope diagnostic**: classification, accepted, policy, body matches schema;
  - the contract outcome;
  - per finding: `findingId`, severity, `verdict`, `requiredAction`, `verdictSource` and the supported-fact count;
  - counts by verdict and by action;
  - the **decision class**;
- **runtime readback:** version, requested and effective model, key source, permission mode, tools, MCP count, auth lane;
- **process evidence:** launches and counts, turn use and refusals;
- **integrity:** primary digest before and after, canaries, views; cleanup; gates.

**Never recorded:** the reply, its rationale or summary, the prompt, the diff text, or a credential. The tests check the evidence file for rationale and summary canaries.

## 6. Tests (`test/o5-5b28-adjudication-probe.test.ts`, offline)

These tests use the real one-shot adapter code on the scripted fake binary, and the real candidate port, view store and Docker backend on the in-memory daemon. Mapping to the milestone's list:

1. **Exactly one adjudication turn:**
   - PASS run: `turnUse {0,0,0,1}`;
   - processes: auth readback 2 (session and turn), inventory 1, init probes 2, model turn 1, host 0;
   - every process is the Lead's executable, in the candidate view;
   - a second attempt is refused.
2. **No plan, Change Author or Reviewer turn:**
   - the turn gate refuses `runTurn`, `runChangeProposalTurn`, a review, cycle 2, and a second adjudication, without reaching the adapter;
   - budgets with any other class, or with 0 or 2 adjudications, are refused.
3. **Exact production prompt, schema and envelope:**
   - the prompt the fake received equals `structuredTurnPrompt(request)` and `claudeStructuredPrompt(request)` for the request rebuilt from production pieces;
   - it contains the adjudication schema of exactly `r1-F1..F3`;
   - the envelope is `rawOrSingleJsonFence`;
   - `contractPromptSha256` is the prompt's digest.
4. **The fixed findings are visible:** the prompt carries exactly the production finding claims, Fusion's facts (the contradicted `unit` fact) and the candidate diff.
5. **Hidden content is not visible:** the prompt does not contain the Reviewer summary, the provenance session, the run id, `"source"`, the Lead-plan or Change Author prompt markers, or the route harness's Lead and Worker secrets.
6. **Raw JSON passes** (`RAW_VALID_JSON`).
7. **One json fence passes** (`SINGLE_FENCED_VALID_JSON`).
8. **One bare fence passes.**
9. **Refused shapes fail as `MALFORMED_OUTPUT`,** with the authorization consumed and no reply text persisted:
   - prose (`EXTRA_TEXT`);
   - two fences (`MULTIPLE_FENCES`);
   - an unclosed fence (`UNCLOSED_FENCE`);
   - a `jsonc` fence (`UNSUPPORTED_FENCE`).
10. **Schema-invalid replies fail:**
    - a fenced unknown finding id fails at the envelope (`INVALID_SCHEMA`, schema stage reached);
    - raw JSON with a missing verdict, and a fenced REJECTED+fix, fail at the production contract (`CONTRACT_REFUSED`).
11. **Fake evidence moves no readiness row:** the rows stay where O5.5B27 left them; "Lead adjudication of review findings" is still the first never-live branch; the input to `writerGateReport` changes nothing.
12. **No live authorization is opened:** `ADJUDICATION_PROBE_PROFILES.authorizations` is `{}`, and nothing is open anywhere. The live entry's usage lists "none" and creates nothing.

Further tests cover:
- the `gate` and `correction` decision classes;
- a failed model turn (`RESULT_ERROR_MAX_TURNS` → `PROVIDER_FAILED`, text-free);
- preflight binding mismatches (effort, max-turns, model → `MODEL_BLOCKED`, nothing consumed);
- all authorization-state and pin refusals;
- that the fixed report's claims are grounded in the fixture.

## 7. What this does not do

- No live run. The live entry `test/live/adjudication-probe.ts` exists for a later, separately authorized human run.
- No authorization; no readiness, aggregate or gate change.
- No change to the adjudication prompt, schema, envelope, contract, the review policy or any other role.
- The probe does not exercise review-driven correction or re-review; they remain never-live after any adjudication probe.
