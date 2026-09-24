# O5.5B10 — Claude structured-output hardening

Outcome in one line: Claude change proposals are now read under a **mechanically defined envelope** — raw JSON, or exactly one outer `json`/bare Markdown fence with nothing but whitespace outside it and a schema-conforming object body — and every structured reply gets a **structure-only diagnostic** that future probe evidence records. No provider was called. The O5.5B9 Claude result stays **FAIL / MALFORMED_PROPOSAL**; nothing about ChangeSet validation, application, posture, the version pin or any readiness gate changed.

## 1. The O5.5B9 failure

One authorized Claude proposal turn (Claude Code 2.1.280, `haiku`, effort `low`, subscription-token lane, Fusion-owned view, read-only posture, one turn) returned a result text that began with a Markdown code fence. The strict parser required the whole text to be one JSON value and refused it: `MALFORMED_PROPOSAL`, transition `delegating>failed:malformedResult`. Primary and view were unchanged; nothing was applied or retried. Muse in the same milestone passed (validated, host-applied, verified 3/3).

## 2. Why O5.5B9 cannot be re-judged

The probe deliberately never persisted a refused reply, and the diagnostic in force during the live run recorded only "starts with three backticks". So nothing shows whether the fence closed, whether text followed it, whether the body was JSON, or whether it was a valid ChangeSet. A parser change cannot turn a reply nobody kept into a pass. The recorded live evidence (`runtime/provider-profiles.ts`, `claude-one-shot 2.1.280: MALFORMED_PROPOSAL`) is unchanged, and a test asserts it.

## 3. Accepted grammar (Claude change proposals only)

Line = text up to an LF (a CR before the LF stays part of the line). Whitespace = JSON whitespace only: U+0020, U+0009, U+000A, U+000D.

```
reply  :=  RAW  |  ws* OPEN LF BODY LF CLOSE ws*
RAW    :=  ws* <one strict JSON value> ws*            (the pre-O5.5B10 contract, unchanged)
OPEN   :=  "```" [ \t]* ( "json" [ \t]* )? CR?         (tag exactly "json" or empty; lower case)
CLOSE  :=  [ \t]* "```" [ \t]* CR?
BODY   :=  the exact text between OPEN and CLOSE
```

and all of:

1. The text's first non-whitespace characters are the opening ```` ``` ````.
2. OPEN and CLOSE are the **only two** lines of the whole text whose first non-blank characters are a fence marker (```` ``` ```` or `~~~`).
3. Only whitespace after CLOSE.
4. BODY passes `parseStrictJson` (JSON.parse plus duplicate-key and depth-64 rejection).
5. The value is a JSON **object** and satisfies the turn's decoding schema (`changeSetSchema()`), via the bounded JSON-Schema subset.
6. It then goes to the engine exactly like a raw value: `validateChangeSet` (unchanged) and host application (unchanged).

Why line-based reading is exact: a strict JSON document can never contain a line that starts with a backtick or a tilde (a JSON string cannot span a line), so a third fence line is always a second fence, never data. Fence text *inside* a JSON string (for example a Markdown file's content, all on one physical line) is data and does not count — the one legitimate case a regex extractor would cut wrongly.

## 4. Rejected (non-exhaustive, each tested)

Prose before the fence (`Here is the JSON:`, a heading, a bullet, a BOM, a vertical tab) · text after the fence · two fences · nested fences · four-backtick or tilde fences · a tag other than `json`/empty (`javascript`, `JSON`, `jsonc`, `json` + control or bidi character) · unterminated fence · closing marker on the body line or carrying words · malformed JSON · JSON5, comments, trailing commas · duplicate keys · nesting deeper than 64 · two concatenated documents (raw or inside a fence) · commentary inside the fence after the JSON · an array or any non-object · a valid object that fails the schema (extra key, `__proto__`, `constructor`) · lone-CR line endings · empty or whitespace-only output · an empty fence · a reply over 1 MiB. Raw JSON that fails the schema is handed on exactly as before O5.5B10, and the core validator refuses it.

Review and adjudication turns, packet turns and every other provider family stay **raw-only**: even one clean fence around a valid report is refused.

## 5. Parser architecture

```
provider stdout (JSONL, ≤ 1 MiB per frame, strict: duplicate keys refused)
  → ClaudeStream (frame order, init posture readback, one `result` frame)
  → ClaudeStream.json(envelope)            src/providers/claude/parsing/stream.ts
      structured_output field present?     unchanged pre-existing path (never requested: --json-schema is a widening flag)
      else readStructuredEnvelope(text, { policy, conforms })
                                           src/platform/process/structured-envelope.ts  (provider-neutral mechanism)
          raw strict JSON → handed on (unchanged)
          exact single fence → strict parse → object + decoding schema → handed on
          anything else → MalformedOutput "Claude structured output was refused: <CLASS> under the <policy> envelope."
  → engine: validateChangeSet(output, scope)   src/core/change/contract.ts (unchanged, authoritative)
  → host application into the private candidate → confined verification
```

- **Policy selection** lives in the provider layer: `ProviderTransportProfile.changeProposalEnvelope` (`rawOrSingleJsonFence` for `claude-one-shot`, `rawOnly` for `muse-exec`/`muse-msp`), read by `structuredEnvelope()` in the Claude transport for change proposals only; everything else is `rawOnly`. Core, app and CLI contain no provider-specific parsing.
- **Schema check**: the bounded JSON-Schema subset moved verbatim from the Muse module to `src/platform/process/json-schema.ts` as `jsonSchemaSubset(fail)`. Muse binds it to `MuseFailure` (its error class and verdicts are unchanged and tested), Claude to `ClaudeFailure`. No second parser or validator was written.
- `malformedResultShape` (O5.5B9) is removed; the diagnostic below replaces it.

## 6. Structure-only diagnostic

`StructuredOutputDiagnostic` (27 fixed keys): `schemaVersion`, `channel` (`resultText`/`structuredOutputField`), `policy`, `classification`, `accepted`, `outputBytes`, `lines`, `lineEndings` (`none|lf|crlf|cr|mixed`), `leadingByteOrderMark`, `rawControlCharacters`, `beginsWithFence`, `fenceMarker` (`backticks|tildes|none`), `fenceLanguage` (`json|none|other` — never the tag), `fenceLines`, `exactlyOneFencePair`, `fenceClosed`, `whitespaceOnlyBeforeFence`, `whitespaceOnlyAfterFence`, `multipleFencesDetected`, `extraTextPresent`, `extraTextLocation` (`beforeFence|afterFence|insideFence|afterValue|notDeterminable|none`), `body` (`rawText|fenceBody|none`), `bodyParsesAsJson`, `bodyJsonFailure` (`invalidJson|tooDeep|duplicateKey`), `bodyTopLevelType`, `bodyMatchesExpectedSchema`, `multipleTopLevelValuesDetected`.

Classifications: `RAW_VALID_JSON`, `SINGLE_FENCED_VALID_JSON`, `RAW_INVALID_JSON`, `SINGLE_FENCED_INVALID_JSON`, `EXTRA_TEXT`, `MULTIPLE_FENCES`, `MULTIPLE_VALUES`, `UNCLOSED_FENCE`, `UNSUPPORTED_FENCE`, `INVALID_SCHEMA`, `EMPTY`, `OVERSIZED`, `OTHER_MALFORMED`. The classification describes the text; the policy decides `accepted` (under `rawOnly` a clean fence is `SINGLE_FENCED_VALID_JSON`, `accepted: false`).

When the text is refused but contains a first fence pair, that pair's body is still described (parses? object? schema?) — for the diagnostic only, never accepted. So a future `EXTRA_TEXT` with `bodyMatchesExpectedSchema: true` says "a valid ChangeSet plus chatter". `multipleTopLevelValuesDetected` comes from a lexical scan (strings, escapes, bracket depth) after the first complete container; it extracts nothing.

The transport keeps the diagnostic of the latest structured turn whether it was accepted or refused (`ClaudeOneShotTransport/ClaudeAdapter.structuredOutputDiagnostic`), next to the O5.5B9 `initReadback`.

## 7. Privacy guarantees

- The diagnostic contains only enumerations, booleans and non-negative integers — no content, no key, no path, no fence tag, no prose. Tested with canary content, paths, tags and prose over every matrix case and both policies.
- Evidence records it only through `structureOnlyDiagnostic()`: rebuilt from the fixed key set with every value checked against its enumeration or as a bounded integer; an extra key, a foreign string, a getter or a proxy makes the whole record `"invalid"`.
- The refusal message carries only the classification and policy names.
- Raw replies are never persisted, logged or placed in events or evidence. (Pre-existing and unchanged: a PASS probe's evidence contains the *validated* ChangeSet's content for the synthetic fixture target, ≤ 4 KiB — Fusion-validated data for a throw-away fixture, not the reply.)

## 8. Prompt contract

The provider-neutral output rule (`core/review/contract.ts`) is unchanged, so Muse's live-validated prompt is unchanged. The Claude transport appends one line as the **last** line of a change-proposal prompt (`CLAUDE_PROPOSAL_REPLY_RULE`): reply with the raw JSON object alone; first character `{`, last `}`; no Markdown code fence; no heading, explanation or other text. Review prompts are unchanged. The instruction is not the boundary; the envelope reader is, and it stays safe when the instruction is ignored.

## 9. Claude version pin

`CLAUDE_VALIDATED_EXTENSION_VERSION` and the transport's validated versions stay exactly `["2.1.280"]`; the probe profile stays `haiku`/`low`/`maxTurns 3`. Read-only inspection of the pinned 2.1.280 binary (file contents only; no process started) confirms `--json-schema <schema>` ("JSON Schema for structured output validation") and an optional `structured_output` in the result frame — but enabling it appends a synthetic `StructuredOutput` tool to the tool list and runs its own in-session retry/nudge loop. That is the M5.3 finding ("`--json-schema` was rejected because it added a fourth effective tool"): it breaks the exact three-tool init readback. It remains a widening flag in the launch posture and the probe profile; adopting it needs its own posture-validation milestone with a live call.

## 10. Why not 2.1.281

2.1.281 (the regular install) has no validated launch posture: every init-only probe and turn fails closed on any version other than 2.1.280, and its plugin-quarantine and tool readback have never been exercised. Changing the version and the parser at once would make the next probe's result ambiguous. A version move is a separate validation milestone.

## 11. Test matrix

`test/o5-5b10-structured-output.test.ts` (14 tests, all offline):

- **Accept**: A raw (compact, pretty with whitespace, CRLF); B ```` ```json ```` (compact, pretty with blank lines and indentation outside, CRLF, blanks around the tag and the closing marker, mixed endings); C bare fence (compact, CRLF); fence text inside a JSON string. Each accepted value is a plain `JSON.parse` object and `validateChangeSet` returns exactly the proposal.
- **Reject**: prompt items 1–20 plus JSON5/comments/trailing commas/bullets/headings (55 cases; 10 accept cases), each with its expected stage (envelope or core validator) and classification, and selected diagnostic facts.
- **Raw-only policy**: every fenced form refused; raw unchanged.
- **Later stages**: a proxy is refused by `validateChangeSet`; a shifting getter is read once (snapshot).
- **Privacy**: canary sweep; evidence-filter refusals.
- **Transport** (real Claude transport, fake native binary): a fenced CRLF proposal completes with one model turn and the reply rule reaches the process; four refused shapes fail `MalformedOutput`, non-retryable, no output, one model turn each, diagnostic and init readback kept; the raw path unchanged.
- **Probe** (offline rehearsal, real engine, candidate port, views, Docker backend over the in-memory daemon): a fenced CRLF Claude proposal → `PASS` labelled `offlineRehearsal`, evidence `schemaVersion 2` with `structuredOutput: SINGLE_FENCED_VALID_JSON`, no reply text or prompt persisted, recorded live Claude evidence still `MALFORMED_PROPOSAL`. A fenced Muse proposal → `MALFORMED_PROPOSAL` after exactly one Exec turn, `structuredOutput: null`.
- **Posture/pin/readiness/shared schema** as described in 9 and 12.

Updated: the O5.5B9 Stage 2 end-to-end test now uses fence + trailing prose (still `MALFORMED_PROPOSAL`, reply shape recorded); its unit test maps the old shapes to the new classes under `rawOnly`; the O5.5A review test checks the new refusal message; probe-test helpers moved to `test/fixtures/probe-harness.ts`.

## 12. Readiness impact

| Row | Before | After |
| --- | --- | --- |
| `structuredOutputEnvelope` (new, implementation) | — | `satisfied` / `fakeProcess` |
| `providerChangeProposalImplementation` | `satisfied` / `fakeProcess` | unchanged |
| `providerChangeProposal` (live) | `partial` / `recordedLiveProbe` | unchanged |
| Claude recorded live evidence | `MALFORMED_PROPOSAL` | unchanged |
| Muse recorded live evidence | `PASS` | unchanged |
| `realWriterModeReady`, `REAL_WRITER_LIVE_GATE_AUTHORIZED` | false | false |

`CLAUDE_STRUCTURED_OUTPUT_IMPLEMENTATION: READY` means only the row above: implemented and proven against fake processes.

## 13. Prerequisites for the next Claude live probe

1. A new, explicit human authorization naming the milestone. The O5.5B9 claims in `%TEMP%\fusion-o5-5b9-probe` are consumed and must not be deleted; the live entry refuses both providers.
2. That milestone adds its own authorization token and evidence directory to the probe entry (the harness is otherwise ready: evidence `schemaVersion 2` records the structure-only diagnostic).
3. Pinned Claude Code 2.1.280 via `FUSION_CLAUDE_EXE` (the side-by-side install), subscription-token lane, same binding (`haiku`, `low`, `maxTurns 3`) so the only variable is the envelope.
4. `npm run build`, then one run from a normal PowerShell window (never from inside Claude Code), Docker Desktop's Linux engine running.
5. One proposal turn, no retry; Muse is not re-probed.
6. Recording a result means updating `changeProposalLiveEvidence` from the validated evidence file in that milestone — never from this one.

## 14. What a future PASS will and will not prove

**Will:** that Claude 2.1.280 (`haiku`, `low`) produced, in one read-only turn, a reply that is raw JSON or exactly one clean fence, whose object passed the schema and the unchanged ChangeSet validator, was host-applied into a private candidate and passed confined verification, with primary and view unchanged. The evidence will say which envelope was used.

**Will not:** that Claude always conforms (single sample, trivial fixture); anything about 2.1.281, other models or efforts; the full Writer route (Lead plan, Reviewer, adjudication, correction); OS-level isolation of provider processes; readiness of the real Writer mode. The aggregate readiness would move only when every Change Author family has a recorded live PASS, and the live gate stays closed regardless.

## Decision

```
CLAUDE_SINGLE_FENCE_NORMALIZATION: YES
CLAUDE_STRUCTURE_ONLY_DIAGNOSTIC: YES
CLAUDE_RAW_OUTPUT_PERSISTED: NO
CLAUDE_AUTOMATIC_RETRY: NO
CLAUDE_STRUCTURED_OUTPUT_IMPLEMENTATION: READY
CLAUDE_REAL_CHANGE_PROPOSAL: FAIL
MUSE_REAL_CHANGE_PROPOSAL: PASS
PROVIDER_CHANGE_PROPOSAL_READINESS: NO
REAL_WRITER_MODE_READINESS: NO
O5_5B_READINESS: NO
O6_READINESS: NO
REAL_WRITER_LIVE_GATE_AUTHORIZED: NO
```
