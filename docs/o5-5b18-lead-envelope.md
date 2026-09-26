# O5.5B18 — Claude Lead envelope (offline)

Labels: **MECHANICALLY ENFORCED** (code plus deterministic tests), **FAKE-PROCESS PROVEN** (plumbing only), **LIVE-OBSERVED** (recorded earlier), **NOT PROVEN**.

Outcome in one line: the Lead's **plan** reply (its ResultPacket) is now read under the same narrow `rawOrSingleJsonFence` envelope the Change Author has used since O5.5B10:
- raw strict JSON; or
- exactly one outer json or bare fence, with only whitespace outside it, around one strict JSON object that is an exact ResultPacket.

**Everything else stays refused.** No other Claude role, no Muse path, and none of the prompt, `--max-turns`, model, version or effort changed.
- **Diagnostic fix:** `schemaValidationReached` was narrowed so it can no longer report a check that never ran.
- **Scope:** offline only; no provider call and no authorization. The live Lead contract has **not** passed; a new Lead-only live retest is required.

## 1. How the Lead got here

| Milestone | What happened |
| --- | --- |
| O5.5B15 (live) | The real Lead plan turn under the generic delegated-task prompt: `RESULT_ERROR_MAX_TURNS`. 7 turns against `--max-turns 6`, no reply, never parsed. |
| O5.5B16 (offline) | A planning-specific Lead prompt, and nothing else. |
| O5.5B17 (live) | The same binding, fixture and limit under the new prompt: the model turn **succeeded** (`RESULT_OK`, 6 turns, exit 0, a 637-byte reply). But `MALFORMED_OUTPUT`: "Claude structured output was refused: SINGLE_FENCED_VALID_JSON under the rawOnly envelope." |

## 2. Why O5.5B17 proves the prompt fix but not the Lead contract

- **The prompt fix worked for this sample.** Same binding, same limit: the turn went from 7 turns with no answer to 6 turns and an answer.
- **The reply format:** exactly one fence pair around one strict JSON object.
- **Why it was refused:** the Lead's packet reader was **raw-only**, and raw-only refuses any fence. The refusal happened at the envelope, before Fusion's ResultPacket check ran. That envelope has no schema predicate: `bodyMatchesExpectedSchema: notChecked`.
- **Not known:** whether that body was a valid ResultPacket.
- **The misleading flag:** O5.5B14's `schemaValidationReached: true` meant only "the body parsed as JSON". This milestone narrows it (§6).

## 3. The narrow policy (unchanged grammar, O5.5B10)

`platform/process/structured-envelope.ts`, policy `rawOrSingleJsonFence`:

```
ws* OPEN LF BODY LF CLOSE ws*      (each LF may be preceded by CR)
ws    := U+0020 | U+0009 | U+000A | U+000D
OPEN  := "```" [ \t]* ( "json" [ \t]* )?
CLOSE := [ \t]* "```"
```

- **BODY** must be one strict JSON **object** (no duplicate keys) that satisfies the caller's schema predicate. For the Lead that predicate is `isResultPacket`: six keys, a known status, and string lists.
- **The same check again:** the value then passes the same ResultPacket check (`packet()`) as a raw reply.
- **Nothing is ever extracted, stripped, repaired or chosen among candidates.** Prose, several fences, a nested fence, an unclosed fence, a tilde or other-language fence, malformed JSON, trailing commas, comments, JSON5 and concatenated documents are all refused.

## 4. What changed

- **`src/runtime/provider-profiles.ts`:** `ProviderTransportProfile.leadPlanEnvelope` (implementation data, beside `changeProposalEnvelope`): `claude-one-shot` is `rawOrSingleJsonFence`; `muse-exec` and `muse-msp` are `rawOnly` (data only).
- **`src/providers/claude/parsing/stream.ts`:** the ResultPacket shape check is extracted into `isResultPacket` (unchanged logic). `packet(envelope = rawOnly)` reads under the given envelope and then applies that same check.
- **`src/providers/claude/one-shot-transport.ts`:**
  - `packetEnvelope(purpose)`: for `plan`, the profile's `leadPlanEnvelope` with `isResultPacket` as the schema predicate; for every other purpose, the previous `{ policy: "rawOnly" }` exactly.
  - `run()` reads under it and records the reply's structure-only diagnostic for packet turns too.
- **`src/app/route-probe.ts`:** the route evidence records each turn's structure-only reply diagnostic for **every** turn kind, the Lead plan included. As with the terminal diagnostic, only one produced by that turn is recorded, never a stale one.
- **`schemaValidationReached`:** see §6.

## 5. Audit of Claude's structured roles

Evidence across all observed live Claude 2.1.280 (haiku/low) structured replies: every one was fenced, although each prompt asked for raw JSON:
- O5.5B9, proposal: fenced, refused under raw-only.
- O5.5B11, proposal: `SINGLE_FENCED_VALID_JSON`, accepted under O5.5B10.
- O5.5B17, Lead plan: `SINGLE_FENCED_VALID_JSON`, refused under raw-only.

| Role | Claude path | Envelope now | Structured contract | Live-tested? | Action |
| --- | --- | --- | --- | --- | --- |
| **Lead plan** | `runTurn` (purpose `plan`) → `packet()` | **rawOrSingleJsonFence** + `isResultPacket` (was rawOnly) | ResultPacket; the engine proceeds on `completed` | **Yes**: O5.5B15 (max turns), O5.5B17 (fence refused) | **Changed** |
| Change Author | `runChangeProposalTurn` → `json()` | rawOrSingleJsonFence (O5.5B10) + ChangeSet decoding schema | ChangeSet (core validator) | Yes: O5.5B9 FAIL, O5.5B11 PASS | Unchanged |
| Lead adjudication | `runStructuredTurn` (adjudication) → `json()` | rawOnly + decoding schema | Adjudication report (core contract) | **No**: never reached live | **Unchanged**: future risk (§7) |
| Lead review (`leadReview`) | `runTurn` (purpose `leadReview`) → `packet()` | rawOnly | ResultPacket (approval) | No | Unchanged: same risk class |
| Reviewer on Claude (by configuration) | `runStructuredTurn` (review) | rawOnly + decoding schema | Review report | No: the route's Reviewer is Muse | Unchanged: same risk class |
| Explorer / delegate packet turns | `runTurn` (`exploration`, `delegate`) | rawOnly | ResultPacket | No | Unchanged |
| Muse (Exec/MSP, every role) | own reader (`parsePacket`, strict decoding) | rawOnly | ResultPacket / reports | Yes: O5.5B9 PASS (raw) | Unchanged |

## 6. `schemaValidationReached`, corrected

Before, it meant "the reply body parsed as JSON". That counted a fence body refused by a raw-only envelope before any check ran, which is exactly O5.5B17's case.

It now means **a schema or contract check actually ran**:
- the envelope evaluated the expected schema (`bodyMatchesExpectedSchema` is a boolean), or
- the envelope handed one value on to the ResultPacket or core contract check.

The historical O5.5B17 record keeps its value as observed under the old definition; its record says so.

## 7. The adjudication decision

**Lead adjudication is unchanged (raw-only).** Its reply goes through the same Claude mechanism (result text, then the envelope reader), and every observed Claude structured reply was fenced. But the fence risk has never been **demonstrated for adjudication** itself: no live adjudication has run. Under the rule not to widen policies blanket-fashion, it stays raw-only, with a deterministic test pinning that.

It is the **highest known future risk**:
- In a full-route rehearsal where the Reviewer raises a finding, Lead adjudication is the next Claude structured reply. If Claude fences it, the route ends `MALFORMED_OUTPUT` at `leadAdjudication #1`.
- Recommendation: decide this explicitly before the next full-route run. Either apply the same narrow envelope to Lead adjudication in its own offline milestone, on the evidence above, or accept and document the risk. Lead review and a Claude-bound Reviewer are in the same class.

## 8. Deliberately not changed

- **Nothing loosened:** no fuzzy extraction, Markdown stripping, JSON repair, prose acceptance, multiple fences, unclosed fences or other fence languages.
- **The ResultPacket and ChangeSet validators** are unchanged.
- **The Lead prompt, `--max-turns 6`, model, version and effort** are unchanged.
- **Muse code** is unchanged.
- **Every other Claude structured role's envelope** is unchanged.
- **Every readiness row** is unchanged, and no authorization is open.

## 9. Tests

`test/o5-5b18-lead-envelope.test.ts` (9 tests):

| # | What it proves |
| --- | --- |
| 1 | Accepted: raw JSON (with or without whitespace), a json fence, a bare fence, CRLF and whitespace only outside. The same exact ResultPacket comes back. |
| 2 | Refused: prose before or after (fenced and raw), two fences, a nested fence, an unclosed fence, a `js` / `JSON5` / tilde fence. |
| 3 | Refused: malformed JSON, a duplicate key (`duplicateKey`), a trailing comma, a comment, JSON5 quotes, concatenated documents (fenced and raw), malformed raw JSON. |
| 4 | Refused as `INVALID_SCHEMA`: an array or string body, and missing key / extra key / unknown status / non-string file packets. A raw schema-invalid packet is still handed on and refused by the unchanged ResultPacket check. |
| 5 | Privacy: diagnostics hold no content. `schemaValidationReached` is true only when a check ran: the O5.5B17 case is now false; a schema-failing fence is true; an unparsable body is false. |
| 6 | Scope: every non-plan packet purpose → `{ policy: "rawOnly" }` and still refuses a fence; review and adjudication stay raw-only; the Change Author keeps `rawOrSingleJsonFence`; the Muse profiles stay raw-only and Muse's `parsePacket` still refuses a fence. |
| 7 | Transport (fake binary): a fenced plan completes for purpose `plan` (diagnostic `SINGLE_FENCED_VALID_JSON`, accepted); the same reply for purpose `delegate` is refused with the old message. |
| 8 | **Regression, the exact O5.5B17 shape:** a successful fake Lead turn (6 turns) replying with one fenced ResultPacket now passes the envelope and contract. `contract accepted`, reply diagnostic accepted under `rawOrSingleJsonFence`, `RESULT_OK`, `schemaValidationReached` true, argv still `--max-turns 6` / haiku / low; the Lead-only budget then stops the route before the Worker. Offline only (`offlineRehearsal`). |
| 9 | Readiness: the live Lead records stay O5.5B15 FAIL and O5.5B17 FAIL (model turn PASS); no row moves; nothing is open. |

The O5.5B17 replay test moved to a unit-level reproduction of its refusal under the raw-only envelope, because the route now accepts that reply. The O5.5B14 precedence tests follow the renamed fact (`schemaCheckReached`).

## 10. What remains

A **new, explicitly authorized Lead-only live retest** (the O5.5B17 shape: one Lead turn, Claude Code 2.1.280 haiku/low, `--max-turns 6`, the pinned fixture). A Lead live PASS may be recorded only if that turn passes **through the envelope and the ResultPacket contract** (`contract accepted`). The Lead adjudication decision (§7) should precede the next full-route run.

| Gate | State |
| --- | --- |
| providerChangeProposal | satisfied (recordedLiveProbe), preserved |
| fullRouteLive | blocked: 1 run, 0 passed |
| hostControlledWriterWorkflow | partial (fakeProviderRehearsal) |
| liveGateAuthorization | blocked |
