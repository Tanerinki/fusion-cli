# O5.5B22 — Claude adjudication envelope (offline)

Labels: **MECHANICALLY ENFORCED** (code plus deterministic tests), **FAKE-PROCESS PROVEN** (plumbing only), **LIVE-OBSERVED** (recorded earlier), **NOT PROVEN**.

Outcome in one line: the Claude Lead's **adjudication** reply is now read under the same narrow `rawOrSingleJsonFence` envelope as the Change Author (O5.5B10) and the Lead plan (O5.5B18):
- raw strict JSON; or
- exactly one outer json or bare fence, with only whitespace outside it, around one strict JSON object that satisfies the adjudication decoding schema.

**The core adjudication validator stays authoritative, and everything else stays refused.**
- **Unchanged:** the Reviewer role, the other packet turns, every Muse path, the adjudication prompt, schema and contract, `--max-turns`, model, version and effort.
- **Diagnostic fix:** `schemaValidationReached` is now exact. It is true only when the schema/contract stage was actually reached.
- **Scope:** offline only; no provider call, no authorization, no readiness row moved.
- **Not proven:** no live adjudication has ever run. This is implementation readiness, not a live result.

## 1. Why now

- **O5.5B21:** the real Claude Lead contract passed. Its reply was one json-fenced object, accepted by the O5.5B18 Lead envelope, and the ResultPacket contract was accepted.
- **The risk it left:** in a full route where the Reviewer raises a finding, Lead adjudication is the next Claude structured reply. It was still read **raw-only**.
- **The evidence:** every live Claude 2.1.280 (haiku/low) structured reply observed so far was fenced, although every prompt asked for raw JSON:

| Milestone | Reply | Envelope result |
| --- | --- | --- |
| O5.5B9, proposal | fenced | refused under raw-only |
| O5.5B11, proposal | `SINGLE_FENCED_VALID_JSON` | accepted under O5.5B10 |
| O5.5B17, Lead plan | `SINGLE_FENCED_VALID_JSON` | refused under raw-only |
| O5.5B21, Lead plan | `SINGLE_FENCED_VALID_JSON` | accepted under O5.5B18 |

- **What was expected:** a fenced adjudication would have ended a full route `MALFORMED_OUTPUT` at `leadAdjudication #1`. O5.5B18 §7 and O5.5B21 §7 named this the highest known risk before a full-route run.

## 2. The narrow policy (unchanged grammar, O5.5B10)

`platform/process/structured-envelope.ts`, policy `rawOrSingleJsonFence`:

```
ws* OPEN LF BODY LF CLOSE ws*      (each LF may be preceded by CR)
ws    := U+0020 | U+0009 | U+000A | U+000D
OPEN  := "```" [ \t]* ( "json" [ \t]* )?
CLOSE := [ \t]* "```"
```

- **The body** must be one strict JSON **object** with no duplicate keys that satisfies the adjudication **decoding schema**. That schema is the one `structuredTurnSchema` already renders from the O4 contract constants.
- **Then the core validator,** exactly as for a raw reply: the value is handed to the unchanged `validateAdjudicationReport` (exactly one legal verdict per known finding, the legal verdict/action pairs, then Fusion evidence over the Lead).
- **Accepted:** raw JSON with or without surrounding whitespace, one ```` ```json ```` fence, one bare ```` ``` ```` fence, and CRLF line ends with whitespace only outside.
- **Refused:**

| Reply | Classification |
| --- | --- |
| prose before or after, fenced or raw | `EXTRA_TEXT` |
| two fences, or a nested fence | `MULTIPLE_FENCES` |
| an unclosed fence | `UNCLOSED_FENCE` |
| a `jsonc` / tilde / other-language fence | `UNSUPPORTED_FENCE` |
| malformed JSON, a comment, JSON5 quotes, a double or trailing comma, a duplicate key (`duplicateKey`) | `SINGLE_FENCED_INVALID_JSON` |
| concatenated documents, fenced or raw | `MULTIPLE_VALUES` |
| a fenced body that fails the schema (unknown finding id, unknown verdict, missing verdict, extra key, an array) | `INVALID_SCHEMA` |

- **Nothing is ever extracted, stripped, repaired or chosen among candidates.**
- **A raw schema-invalid reply** is handed on exactly as before (classification `INVALID_SCHEMA`, accepted by the envelope), and the core validator refuses it.

## 3. What changed

- **`src/runtime/provider-profiles.ts`:** `ProviderTransportProfile.adjudicationEnvelope`, implementation data beside `changeProposalEnvelope` and `leadPlanEnvelope`. `claude-one-shot` is `rawOrSingleJsonFence`; `muse-exec` and `muse-msp` are `rawOnly` (data only; Muse has its own strict reader).
- **`src/providers/claude/one-shot-transport.ts`:** `structuredEnvelope(request)` has three cases:
  - `changeProposal` → `changeProposalEnvelope` (unchanged);
  - `adjudication` → `adjudicationEnvelope` (**new**);
  - everything else (review) → `rawOnly` (unchanged).

  The fence body's predicate is the turn's decoding schema, as before. `claudeStructuredPrompt` is unchanged: the adjudication prompt is still exactly the core `structuredTurnPrompt` (Claude's extra reply rule is proposal-only).
- **`src/providers/claude/parsing/stream.ts`:** the exact `schemaCheckReached` rule (§4).
- **`src/providers/claude/parsing/terminal.ts`, `src/platform/process/terminal-diagnostic.ts`:** comments only, to the exact definition.
- **Evidence (no code change needed):** the route harness already records each turn's structure-only reply diagnostic for every turn kind, only when that turn produced it (O5.5B18). A Lead adjudication turn therefore records its envelope classification, `accepted`, `policy` and `bodyMatchesExpectedSchema`, and never its text. The live entry prints it as a `reply envelope` line.
- **Docs:** `docs/o5-cli.md` "Real read-only review" names the O5.5B22 exception.

## 4. The stage flags, exact

| Flag (diagnostic / stream fact) | True exactly when |
| --- | --- |
| `structuredParsingReached` (`parsingReached`) | The provider reported success (`subtype success`, `is_error false`, `terminal_reason completed`) **and** Fusion's structured reader (`json()` / `packet()`) ran on that result. Any failed, missing, malformed, timed-out or cancelled turn: false. |
| `schemaValidationReached` (`schemaCheckReached`) | The schema/contract stage was reached. Either the reply passed every structural rule and was handed on to the caller's contract check (ResultPacket check or core validator; also a provider `structured_output` field), or the schema check itself refused it (`INVALID_SCHEMA`). |

- **When `schemaValidationReached` is false:** a reply refused for its **structure** never reached that stage: `EXTRA_TEXT`, `MULTIPLE_FENCES`, `UNCLOSED_FENCE`, `UNSUPPORTED_FENCE`, `SINGLE_FENCED_INVALID_JSON`, `MULTIPLE_VALUES`, invalid raw JSON, and a clean fence under a raw-only policy (the O5.5B17 case).
- **What changed from O5.5B18:** O5.5B18 also counted a structural refusal whose fence body the reader had evaluated for the diagnostic (`bodyMatchesExpectedSchema` a boolean). That covered prose after a valid fenced object, and a valid fence under raw-only with a schema predicate, as review turns have. Neither handed anything on, so both are now false.
- **Historical records keep the values they observed.** O5.5B21's `schemaValidationReached: true` is also true under this definition, because its reply was accepted.

## 5. Audit of Claude's structured roles (updated)

| Role | Claude path | Envelope now | Structured contract | Live-tested? | Action |
| --- | --- | --- | --- | --- | --- |
| Lead plan | `runTurn` (purpose `plan`) → `packet()` | rawOrSingleJsonFence + `isResultPacket` (O5.5B18) | ResultPacket | **Yes**: O5.5B21 PASS | Unchanged |
| Change Author | `runChangeProposalTurn` → `json()` | rawOrSingleJsonFence + ChangeSet decoding schema (O5.5B10) | ChangeSet (core validator) | Yes: O5.5B9 FAIL, O5.5B11 PASS | Unchanged |
| **Lead adjudication** | `runStructuredTurn` (adjudication) → `json()` | **rawOrSingleJsonFence** + adjudication decoding schema (was rawOnly) | Adjudication report (core validator) | **No**: never reached live | **Changed** |
| Lead review (`leadReview`) | `runTurn` (purpose `leadReview`) → `packet()` | rawOnly | ResultPacket (approval) | No | Unchanged: same risk class, not on the rehearsal route |
| Reviewer on Claude (by configuration) | `runStructuredTurn` (review) | rawOnly + decoding schema | Review report | No: the route's Reviewer is Muse | Unchanged: same risk class |
| Explorer / delegate packet turns | `runTurn` (`exploration`, `delegate`) | rawOnly | ResultPacket | No | Unchanged |
| Muse (Exec/MSP, every role) | own reader (`parsePacket`, strict decoding under `--output-schema`) | rawOnly | ResultPacket / reports | Yes: O5.5B9 PASS (raw) | Unchanged |

## 6. Deliberately not changed

- **Nothing loosened:** no fuzzy extraction, Markdown stripping, JSON repair, prose acceptance, multiple fences, unclosed fences or other fence languages.
- **Validators:** `validateAdjudicationReport`, `validateReviewReport`, the ResultPacket and the ChangeSet validators are unchanged.
- **Prompts, schemas and route:** the adjudication prompt and decoding schema, the Lead-plan prompt, `--max-turns 6`, model, version, effort, and the route budgets, grants and fixture are unchanged.
- **Other roles:** the Reviewer role's envelope and Muse code are unchanged.
- **Readiness:** every row and gate is unchanged, and no authorization is open.

## 7. Tests

`test/o5-5b22-adjudication-envelope.test.ts` (8 tests):

| # | What it proves |
| --- | --- |
| 1 | Accepted: raw JSON (with or without whitespace), a json fence, a bare fence, and CRLF with whitespace only outside. The exact report comes back, the core `validateAdjudicationReport` passes, and both stage flags are true. |
| 2 | Refused, with `schemaValidationReached` false: prose before or after (fenced and raw), two fences, a nested fence, an unclosed fence, a `jsonc` fence, a tilde fence. |
| 3 | Refused (never repaired): malformed JSON, a comment, JSON5 quotes, a double comma, a trailing comma, two documents (fenced and raw), a duplicate key (`duplicateKey`). |
| 4 | A schema-invalid fenced reply is refused as `INVALID_SCHEMA` with `schemaValidationReached` true. Cases: unknown finding id, unknown verdict, missing verdict, extra key, an array. A raw schema-invalid reply is handed on and refused by the unchanged core validator. |
| 5 | Privacy: the structure-only diagnostic re-validates, and neither it nor the terminal diagnostic holds the rationale canary. |
| 6 | Scope: the review stays raw-only. The Change Author (O5.5B10) and Lead plan (O5.5B18) are unchanged, and the non-plan packet purposes stay raw-only. The profile has all three Claude fields; both Muse profiles are raw-only. `claudeStructuredPrompt(adjudication) === structuredTurnPrompt(adjudication)`. Under the previous raw-only policy the same fenced reply is refused, with `schemaValidationReached` false. |
| 7 | Route (fake binaries, `offlineRehearsal`): a fenced Lead adjudication (`REJECTED`) is accepted. Contract `accepted:1 verdict(s)`; the recorded `structuredOutput` is `SINGLE_FENCED_VALID_JSON`, accepted under `rawOrSingleJsonFence`, schema matched; both stage flags are true; the route passes; no adjudication text is in the evidence. |
| 8 | Readiness: the live Lead records stay O5.5B15 FAIL, O5.5B17 FAIL, O5.5B21 PASS. Full-route live coverage stays 1 attempt, 0 passed. No row or gate moves, whatever the input, and nothing is open. |

`test/o5-5b18-lead-envelope.test.ts`, the scope test: it now pins only the review as raw-only, since adjudication moved here.

## 8. What remains before a full-route live rehearsal

- **The Claude side of the route is not the narrowest blocker.** The Lead plan contract passed live (O5.5B21), the Change Author passed live (O5.5B11), and the adjudication envelope is now implemented. The first live adjudication will be observed in a full route; it is not proven.
- **The narrowest blocker is the Reviewer.**
  - Every route authorization with `freshReview > 0` is `VERSION_BLOCKED` in preflight, before any claim. The machine's Muse selector (`.muse-version`) names `1.4.0-R4161.1`, while `muse-exec` is validated, and the route's Reviewer grant is bound, to `1.3.0-R3401.1` only (O5.5B19, O5.5B20).
  - A Muse Reviewer has **never** produced a real review inside the route.
- **Offline observations (read-only, never executed; not validation):**
  - Both binaries are installed side by side: `muse-bin-1.3.0-R3401.1.exe` (validated) and `muse-bin-1.4.0-R4161.1.exe`.
  - The auto-update ran on 2026-09-25, channel `muse-stable`, `min_version` null.
  - Both binaries' bytes contain every flag and event name Fusion's read-only exec launch uses, and the `muse-spark-1.3` model id.
  - String presence proves nothing about behaviour: **Muse 1.4 stays unvalidated.**
- **The smallest safe next step** is to validate the actual Reviewer binding before any full-route rehearsal. That means one offline preparation milestone, then one separately authorized, human-run Muse Reviewer-only live turn on the installed release, with nothing else in the route. The status report names it.

| Gate | State |
| --- | --- |
| providerChangeProposal | satisfied (recordedLiveProbe), preserved |
| fullRouteLive | blocked: 1 run, 0 passed |
| hostControlledWriterWorkflow | partial (fakeProviderRehearsal) |
| liveGateAuthorization | blocked |
