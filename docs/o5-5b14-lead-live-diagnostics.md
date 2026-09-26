# O5.5B14 — Lead live-path diagnostics (bounded Claude terminal diagnostic)

Labels: **MECHANICALLY ENFORCED** (code plus deterministic tests), **FAKE-PROCESS PROVEN** (the real one-shot transport and adapters against the deterministic fake binary), **PROTOCOL-SOURCED** (read from the pinned runtime's own result schema in its binary bytes; never launched), **LIVE-OBSERVED** (recorded in an earlier milestone), **NOT PROVEN**.

Outcome in one line: every Claude model turn now reports a **bounded terminal diagnostic** that says why its process ended, without any text. It is recorded per turn in future route evidence, so the question O5.5B13 could not answer can now be answered: did the Lead end `error_max_turns`, `error_during_execution`, `is_error`, or a non-`completed` terminal reason? It holds only labels from protocol allowlists, booleans, counts, a byte length and the process settlement.
- **Not recorded:** the result text, error strings, stderr, prompt, denied-tool inputs and identifiers.
- **Unchanged:** outcomes, failure messages, the Lead prompt, `--max-turns`, providers, models, versions, Muse behaviour and readiness.
- **Not reinterpreted:** the historical O5.5B13 FAIL.
- **Scope of this milestone:** no provider was called and no authorization was opened.

## 1. Starting state

- **Branch and HEAD:** branch `o5-5b14-lead-live-diagnostics`, HEAD `67040ee` ("feat: record failed full-route live proof"), clean tree, verified before any change.
- **Evidence from O5.5B13:** the only live full-route run ended `PROVIDER_FAILED` at `leadPlan #1` after one model turn. The detail was "Claude reported a failed turn.", the process exited 1, and no later role ran (docs/o5-5b13-full-route-live-proof.md).

## 2. Where "Claude reported a failed turn." is created

The message has exactly one origin:
- **Origin:** `src/providers/claude/one-shot-transport.ts`, inside `execute()`, after the model process settles:

  ```ts
  if (stream.semanticError) fail("ProcessFailure", "Claude reported a failed turn.");
  ```

- **The flag:** `ClaudeStream.semanticError` (`src/providers/claude/parsing/stream.ts`) is `result.is_error === true || result.terminal_reason !== "completed" || result.subtype !== "success"`.
- **Checks that run before it:** `earlyFailure` (malformed stream, extension activity, init verification, 401, overage, rate limit), then timeout, cancel, spawn, output limit, stream error, invalid stream, "failed before initialization", and "no init and result".
- **Upward path:** the failure is returned as `{ status: "failed", error: { kind: "ProcessFailure" } }` → `ClaudeAdapter.runTurn` → `WorkflowEngine` (`role.adapter.runTurn(session, packet)` in the `planning` state) → `StageFailure` → transition `planning>failed:providerFailure` → `classifyRoute` → `PROVIDER_FAILED` at the failed turn.

## 3. The exact observability gap

The transport holds the whole result frame in memory (`ClaudeStream.result`), but only a boolean derived from it (`semanticError`) ever left the parser. The route evidence's per-turn record held:
- `outcome`;
- `errorKind`;
- a structure-only diagnostic of the reply, recorded only when a reply was read, which never happens for a failed result;
- the process settlement: exit code and Fusion's kill reason.

It held nothing from the result frame. So three different conditions all produced the identical record:
- an `error_max_turns` result;
- an `error_during_execution` result;
- a success-subtype frame with `is_error: true` or a non-`completed` terminal reason.

## 4. Why O5.5B13's cause cannot be recovered after the fact

There is no copy of the frame anywhere:
- **Fusion's parser:** it discards raw frames by design.
- **The evidence contract:** it persists no provider output.
- **Claude transcripts:** the turn ran with `--no-session-persistence`, so Claude wrote none.
- **stderr:** Fusion keeps none.
- **The evidence namespace:** it holds labels, counts and digests only.

The O5.5B13 evidence stays exactly as it is (the static record in `src/runtime/provider-profiles.ts` is unchanged and has no diagnostic fields). Only a new, separately authorized live turn can show the cause.

## 5. The result protocol the diagnostic reads (Claude Code 2.1.280)

**PROTOCOL-SOURCED:** read from the result-message schema in the pinned binary's own bytes (`%TEMP%\fusion-o5-5b9-claude-2.1.280\…\claude.exe`), by searching the file offline; the binary was not launched. This agrees with the fields observed live earlier (docs/research/local-runtime-capabilities.md §3.2).

| Field | Schema (2.1.280) | Notes |
| --- | --- | --- |
| `subtype` | `success` \| `error_during_execution` \| `error_max_turns` \| `error_max_budget_usd` \| `error_max_structured_output_retries` | The error variants always carry `is_error: true` |
| `is_error` | boolean | Observed live: `subtype: success` **with** `is_error: true` on an auth failure |
| `terminal_reason` | optional; 19 values: `blocking_limit`, `rapid_refill_breaker`, `prompt_too_long`, `image_error`, `model_error`, `api_error`, `malformed_tool_use_exhausted`, `aborted_streaming`, `aborted_tools`, `stop_hook_prevented`, `hook_stopped`, `tool_deferred`, `max_turns`, `background_requested`, `completed`, `budget_exhausted`, `structured_output_retry_exhausted`, `tool_deferred_unavailable`, `turn_setup_failed` | `completed` is the only normal one |
| `num_turns` | integer | The CLI's own agentic turn count |
| `permission_denials` | array of objects (tool name, id, input) | Counted only |
| `errors` | array of **strings** (error variants) | Counted only; text never read out |
| `result` | string (success variant only) | Measured only (byte length) |
| `api_error_status` | nullable number (success variant) | Reduced to a status class |
| `stop_reason` | nullable string | Exists; **not recorded** (not needed to classify; a free string) |

## 6. The new diagnostic (`TurnTerminalDiagnostic`, schema 1)

Provider-neutral type and re-validation: `src/platform/process/terminal-diagnostic.ts`. Claude mapping: `src/providers/claude/parsing/terminal.ts`.

| Field | Values | Source |
| --- | --- | --- |
| `classification` | see §8 | derived |
| `resultSubtype` | the 5 protocol subtypes, `other`, `missing` | `subtype` (allowlisted) |
| `terminalReason` | the 19 protocol reasons, `other`, `missing` | `terminal_reason` (allowlisted) |
| `isError` | boolean \| null | `is_error` |
| `internalTurnCount` | integer 0…1 000 000 \| null | `num_turns` |
| `permissionDenialCount` | integer \| null | `permission_denials.length` |
| `errorEntryCount` | integer \| null | `errors.length` |
| `resultTextPresent` | boolean | `result` is a non-empty string |
| `resultTextByteLength` | integer (UTF-8 bytes) | `result` measured, never kept |
| `apiErrorStatusClass` | `none` \| `4xx` \| `5xx` \| `other` \| `unknown` | `api_error_status`; `unknown` without a result frame |
| `structuredParsingReached` | boolean | the result was a success, so its text reached Fusion's reader |
| `schemaValidationReached` | boolean | the reply (or its single fence body) parsed as one JSON value, so the schema or contract check that follows was reached (the envelope's decoding schema, the ResultPacket shape, or the core contract) |
| `processExitCode` | integer \| null | process settlement |
| `processSignal` | `SIGTERM` \| `SIGKILL` \| `SIGINT` \| `SIGHUP` \| `other` \| null | process settlement |
| `fusionTermination` | `user` \| `timeout` \| `outputLimit` \| `protocolError` \| `shutdown` \| null | Fusion's own kill reason |
| `timedOut`, `cancelled` | boolean | process settlement |

## 7. Fields unavailable or deliberately not recorded

- **`terminalReason` for execution errors:** the requested `execution_error` reason does **not exist** in the 2.1.280 protocol. An execution error is the subtype `error_during_execution`, with whatever terminal reason the run loop reached (for example `model_error` or `api_error`). The diagnostic keeps the protocol's own labels; nothing is invented.
- **`api_error_status`:** it is defined only on the success variant. On an error-subtype frame it is absent, so the class reads `none`.
- **`processSignal`:** Windows has no POSIX signals, so it is `null` on this machine; the exit code carries the settlement.
- **`stop_reason`:** available but not recorded, because it is a free provider string not needed to classify.
- **Never recorded:** timing, cost, usage, session ids, UUIDs, `modelUsage`, `subagent_stats`, error texts, denied-tool names and inputs, and the result text.

## 8. Classification and precedence

The first rule that holds wins, and each turn gets exactly one class:

1. `CANCELLED` (the caller's cancellation)
2. `TIMEOUT` (Fusion's deadline)
3. `NOT_STARTED` (no model process spawned)
4. `MALFORMED_STREAM` (malformed events, invalid or truncated JSONL, failed pipes: the existing ProtocolError paths)
5. `STOPPED_BY_FUSION` (Fusion ended the process: a refused init, auth rejection, overage, output limit)
6. `MISSING_RESULT`
7. `RESULT_ERROR_MAX_TURNS` (`subtype: error_max_turns`)
8. `RESULT_ERROR_DURING_EXECUTION` (`subtype: error_during_execution`)
9. `RESULT_OTHER_SEMANTIC_ERROR` (any other non-`success` subtype, known or unknown)
10. `RESULT_IS_ERROR` (success subtype, `is_error: true`)
11. `RESULT_TERMINAL_NOT_COMPLETED` (success, `is_error: false`, `terminal_reason` ≠ `completed` or absent)
12. `RESULT_OTHER_SEMANTIC_ERROR` (success, `completed`, but `is_error` not explicitly `false`)
13. `RESULT_OK`

Why this order:
- **Fusion's observations first.** A provider field can only explain a turn that reached its result.
- **The subtype outranks `is_error`.** Error variants always set `is_error`, and the subtype is more specific.
- **`is_error` outranks `terminal_reason`.**

A non-zero exit code is recorded but does not change the class, because the transport already refuses it. The workflow outcome stays `PROVIDER_FAILED` and every failure message is unchanged: the diagnostic explains the failure; it decides nothing.

## 9. Privacy properties

- **Nothing can hold text.** Labels come only from allowlists (`other` otherwise) and must also match `^[a-z][a-z0-9_]{0,47}$`. Everything else is a boolean, an enum or a bounded integer.
- **Re-validation before evidence.** `terminalOnlyDiagnostic` re-validates what an adapter reports before it enters evidence. The object must have exactly the 18 known keys, each passing its own check; anything else makes the whole diagnostic `invalid`, and nothing is copied through.
- **The frame stays in memory.** The frame reference never leaves the transport. `ClaudeStream.terminalFacts()` hands it only to the mapper, which reads 9 fields.
- **Existing guarantees unchanged.** Raw-output privacy is untouched: no raw frame, reply or stderr is persisted anywhere.
- **Tested.** Canary strings placed in `result`, `errors`, `permission_denials` inputs and ids, and in a prose `terminal_reason`, never appear in a diagnostic or in the route evidence.

## 10. Route evidence integration

`RouteTurnRecord.terminal`, and `route.evidence.json` `turns[].terminal`, now holds the re-validated diagnostic for every role turn whose adapter reports one: the Lead plan, the Change Author and Lead adjudication on Claude.
- **Only this turn's diagnostic.** The gate reads it only if the adapter produced a new one during this turn (identity comparison), so a turn refused before its model process shows `null`, never the previous turn's.
- **Reset per turn.** The transport also resets the diagnostic at the start of every turn.
- **Muse unchanged.** The Muse adapter reports none, so its turns show `null`.
- **Questions a future live Lead turn's evidence can answer:** `error_max_turns`? (`resultSubtype`), `error_during_execution`? (`resultSubtype`), `is_error`? (`isError`), `terminal_reason` completed? (`terminalReason`), result text present? (`resultTextPresent`), parsing reached? (`structuredParsingReached`), schema reached? (`schemaValidationReached`), exit code? (`processExitCode`).

## 11. Lead prompt observation (analysis only — not changed)

- **Code path:** `WorkflowEngine.flow` → `readOnlyTurn(bound("Lead"), packet, undefined, "plan", 1)` (the `"plan"` argument is only a provenance label) → `role.adapter.runTurn(session, packet)` → `ClaudeAdapter.runTurn` → `ClaudeOneShotTransport.run` → `packetPrompt(packet)`.
- **The prompt:** "Complete this delegated task within its scope. Your entire response must be one raw JSON object … `{"result":{"status":"completed"},"changes":{"files":[],"summary":""},"verification":{"testsRun":[],"results":[]},…}` … Delegation: `<packet JSON>`". This is the **generic delegated-task wording**; the Lead's plan turn receives no planning-specific instruction.
- **The route packet:** its goal is "Fix quote totals: tax applies to the discounted subtotal. Add a regression test." with `allowedFiles` `src/quote.ts` and `test/quote.test.ts`, acceptance criteria that tests and typecheck pass, and required tests `typecheck` and `unit`.
- **Implementation-like work?** Yes. It asks a **read-only** session (Read/Grep/Glob, `dontAsk`) to *complete* a write task and report changed files and tests run.
- **Could it consume turns?** Plausibly: every tool use is an agentic turn. The earlier research also observed a read-only Haiku emitting a hallucinated `Write` tool use (not executed, and not listed in `permission_denials`).
- **Pinned by a test** (`o5-5b14-route-terminal`), so any later change is deliberate.
- **Not claimed to have caused O5.5B13.**

## 12. `--max-turns 6` observation (analysis only — not changed)

- **Configuration:** the Lead binding runs `--max-turns 6` (live argv, O5.5B13). In 2.1.280, reaching it ends the run with `subtype: error_max_turns`, `terminal_reason: max_turns`, `is_error: true` and `num_turns`, with an error entry of the form "Reached maximum number of turns (N)"; the CLI exits non-zero.
- **Consistency with O5.5B13:** an exit of 1, a result frame present, and a turn of 40.3 s including setup are all consistent with this.
- **Also consistent:** `error_during_execution` or other terminal reasons.
- **Status:** **NOT PROVEN**. The new diagnostic would show it directly (`RESULT_ERROR_MAX_TURNS`, `internalTurnCount`). The turn limit is unchanged.

## 13. What did not change

- Failure messages and error kinds, the `PROVIDER_FAILED` outcome contract, and the parsers' acceptance rules (no weakening).
- The Lead prompt, `--max-turns`, and the providers, models and runtime versions.
- Muse code; no retries; no authorization (`O5.5B13-LIVE` consumed, `O5.5B12-LIVE` pending, O5.5B9/O5.5B11 consumed).
- The historical O5.5B13 record and evidence, and every readiness row.

## 14. Tests

13 new deterministic tests.

`test/o5-5b14-claude-terminal-diagnostic.test.ts` (10): the real transport against the fake binary, plus the pure mapper and the sanitizer. Cases covered:
- success;
- `error_max_turns`, `error_during_execution`, `is_error`, another subtype, a non-completed terminal reason, and a missing error flag;
- unknown labels mapped to `other`, and bad counts to `null`;
- permission denials and error entries counted;
- result text presence and its exact UTF-8 byte length;
- no result frame, a malformed stream, a timeout, and a cancellation after the model process started;
- precedence;
- forged diagnostics refused;
- no stale diagnostic when no model process starts.

`test/o5-5b14-route-terminal.test.ts` (3):
- a Lead `error_max_turns` in a route: `PROVIDER_FAILED` unchanged, `turns[0].terminal` names it, and there is no text in the evidence;
- every Claude turn of a passing route carries a diagnostic and the Muse turn none, with the Lead-prompt observation pinned;
- readiness: the O5.5B13 record is unchanged (no new keys), no row moves, nothing is open, and fake diagnostics never become live evidence.

The fake binary gained two test-only overrides: `FUSION_FAKE_RESULT` / `resultFrame` (a result-frame patch in the protocol's shape) and `FUSION_FAKE_EXIT` / `exitCode`.

## 15. Readiness

| Gate | State |
| --- | --- |
| providerChangeProposal | satisfied (recordedLiveProbe), preserved |
| fullRouteLive | blocked (recordedLiveProbe): 1 run (O5.5B13), 0 passed |
| hostControlledWriterWorkflow | partial (fakeProviderRehearsal) |
| liveGateAuthorization | blocked |

Implementation-only diagnostics add no live evidence and move no row.

## 16. What remains unknown, and the smallest next step

- **Unknown:** why the O5.5B13 Lead turn failed (max turns, an execution error, or another terminal reason), and whether the generic delegation prompt or the 6-turn limit contributes. Answering it needs one **new, explicitly human-authorized** live turn.
- **The smallest step:** a **Lead-plan-only** route authorization, for example turns `{ leadPlan: 1, changeAuthor: 0, freshReview: 0, leadAdjudication: 0 }`, with the same bindings, pinned fixture and normal-terminal rule.
  - The existing turn gate already refuses a Change Author turn whose budget is 0 before its model process starts.
  - The engine may still set up the Worker's session first, which can run a non-model auth readback. The milestone that prepares this should confirm that, and decide whether to end the run right after the Lead.
  - So the run makes exactly one real model call, and its evidence carries the Lead's terminal diagnostic.
- **Decisions to take only after that evidence:** changing the Lead's plan contract, and changing `--max-turns`.
