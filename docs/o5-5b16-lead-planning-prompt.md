# O5.5B16 — Lead planning prompt (offline)

Labels: **MECHANICALLY ENFORCED** (code plus deterministic tests), **FAKE-PROCESS PROVEN** (real adapters against the fake binaries: plumbing only), **LIVE-OBSERVED** (recorded earlier), **NOT PROVEN**.

Outcome in one line: the Lead's plan turn now opens with a **planning-specific, provider-neutral contract** instead of the generic delegated-task wording. Only that instruction changed. Unchanged:
- the reply contract (raw JSON, ResultPacket shape, delegation);
- every other packet turn;
- the Change Author, Reviewer and adjudication prompts;
- `--max-turns 6`, the runtime, model, effort and routing.

There were no provider calls and no authorization. The live Lead result stays **FAIL** until a new, authorized Lead-only probe.

## 1. Starting state

- **Branch and HEAD:** branch `o5-5b16-lead-planning-prompt`, HEAD `55697d5` (O5.5B15), clean tree, verified before any change.

## 2. The O5.5B15 evidence

The one authorized real Lead-plan turn (Claude Code 2.1.280, haiku/low, `--max-turns 6`) ended:
- **Terminal diagnostic:** `RESULT_ERROR_MAX_TURNS` (`error_max_turns` / `max_turns`), `isError: true`, `internalTurnCount: 7`, 0 permission denials.
- **Reply:** no result text; parsing and schema validation never reached; exit 1.
- **What 7 means:** in 2.1.280, 7 against a limit of 6 means all six agentic turns were spent on tool use and the model still needed another turn. It never answered (docs/o5-5b15-lead-live-probe.md).

## 3. The old Lead wording

- **The call:** `WorkflowEngine` ran the Lead's plan as a packet turn, `runTurn(session, packet)`. The purpose (`plan`) existed only as a provenance label.
- **The prompt:** each provider's packet prompt began with the **generic delegated-task wording**:
  - Claude: "Complete this delegated task within its scope."
  - Muse: "Complete the delegated task within its scope."

  The delegation then described the write task (fix and add a regression test), and the reply shape asked for changed files and tests run.
- **The mismatch:** a read-only planning session (Read/Grep/Glob) was asked to *complete an implementation*.

## 4. The new role-specific Lead intent

`src/core/workflow/lead-plan.ts` holds `LEAD_PLAN_INSTRUCTION` and `packetTurnInstruction(purpose)`. It is provider-neutral, beside the other role contracts in `core` (the structured review, adjudication and change-proposal prompts live in `core/review/contract.ts`). The instruction says:
- **Role:** you are the planning Lead for this delegated task.
- **Do not implement:** do not modify, create or delete any file, and do not attempt to complete the delegated implementation. A separate Change Author implements it from your plan; Fusion then validates, applies and verifies it.
- **Inspect only enough context:** find the relevant files and modules, the behaviour changes required, the architecture and security invariants to preserve, the acceptance criteria and how they will be verified, and the risks and constraints.
- **Stop exploring as soon as the plan can be produced, and answer.**
- **Report the plan in the existing reply:**
  - the concise plan in `changes.summary` (the engine forwards it to the Change Author as "Lead plan: …");
  - the expected files in `changes.files`;
  - risks in `uncertainties`;
  - human decisions in `needsLeadDecision`;
  - `result.status` `completed` when ready, or `blocked`.
- **Run no tests and report none:** only Fusion's own evidence counts.

**How the purpose reaches the provider:**
- `ProviderAdapter.runTurn` gained an optional `purpose` (`PacketTurnPurpose`: `plan | exploration | delegate | leadReview`, the engine's own provenance kinds).
- The engine passes its turn kind.
- Each adapter uses the core instruction **only for `plan`** and keeps its exact previous wording for every other purpose.
- Both families' Lead plans take the same contract, since a Lead may be bound to either.
- **The output schema is unchanged:** the plan maps onto the existing ResultPacket fields the engine already reads.

## 5. Why `--max-turns` stays 6

- **The evidence says only that 6 turns of tool use produced no answer under an implementation-oriented prompt.** It does not say that planning needs more than 6 turns.
- **Raising the limit now** would change two variables at once and hide whether the prompt fixes it.
- **The limit is unchanged** in the authorized grants (`--max-turns 6` for Lead and Worker) and in every model argv; a test pins it.
- **Later:** only a new live Lead-only probe under the new prompt can show whether 6 suffices.

## 6. Why the Change Author wording stays separate

- **The Change Author is meant to implement:** as a read-only proposer, it returns final file text that Fusion validates and applies.
- **It is not a packet turn:** its prompt is the structured change-proposal contract (`structuredTurnPrompt` plus Claude's reply rule), never `runTurn`, so it never sees the planning contract.
- **Proof that it is unchanged:**
  - `core/review/contract.ts` has no diff;
  - a test pins the prompt's bytes (SHA-256) for a fixed packet, and asserts it still equals the structured contract plus the reply rule and says "Propose complete final text for each file; Fusion validates and applies it."

## 7. Tests

8 new deterministic tests in `test/o5-5b16-lead-planning-prompt.test.ts`:
1. **The planning wording is present:** role, do not implement, do not modify files, inspect only enough, stop exploring, report in the existing fields, claim no tests. The prompt starts with the instruction; there is no generic wording (Claude and Muse); no provider name appears.
2. **Only the first sentence changes:** the plan prompt equals the old prompt with only its first sentence replaced (both families). `undefined`, `delegate`, `exploration` and `leadReview` keep their exact old prompts.
3. **The Change Author prompt is unchanged:** structured contract plus reply rule, implementation-oriented, pinned SHA-256, and no planning text.
4. **Bindings are unchanged:** the Lead's `--max-turns 6`, 2.1.280, haiku / `claude-haiku-4-5-20251001`, `low`; 2.1.281 is still not validated.
5. **Fake Lead `RESULT_OK` within the same 6-turn limit:** `num_turns` 4. The fake received the planning contract, the plan parsed and was accepted, the argv says `--max-turns 6`, and the delegation is unchanged. This proves plumbing only.
6. **Fake `RESULT_ERROR_MAX_TURNS` is still classified exactly** (`internalTurnCount` 7), and nothing runs after the Lead.
7. **Full fake route:** only the Lead's plan takes the planning contract. Lead adjudication, Change Author and Reviewer prompts keep their own openings, and the accepted plan still reaches the Change Author as "Lead plan: …".
8. **Readiness:** the O5.5B15 live Lead record stays FAIL, no row or gate moves, and nothing is open.

Updated fixtures and tests:
- the route harness's and the O5.5B8 test's Lead prompt prefix;
- the O5.5B14 observation test, which pinned the old generic wording and now asserts the planning contract and its absence.

## 8. What remains unproven until a new Lead-only live probe

- **Whether the real model plans within 6 agentic turns** under the new contract, or still exhausts them.
- **Whether its plan parses and is accepted** (`RESULT_OK`, contract accepted).
- **Whether the plan is useful** to the Change Author.
- **Whether any later role works inside the route.**

The fake process proves only that Fusion sends the new contract and parses a well-formed plan. The recorded live Lead result stays **FAIL** (O5.5B15), and the O5.5B13 route record stays FAIL.

## 9. Readiness

| Gate | State |
| --- | --- |
| providerChangeProposal | satisfied (recordedLiveProbe), preserved |
| fullRouteLive | blocked (recordedLiveProbe): 1 run, 0 passed |
| hostControlledWriterWorkflow | partial (fakeProviderRehearsal) |
| liveGateAuthorization | blocked |

HOST_CONTROLLED_WRITER_WORKFLOW_READINESS **NO**. REAL_WRITER_MODE_READINESS **NO**. O5_5B_READINESS **NO**. O6_READINESS **NO**. REAL_WRITER_LIVE_GATE_AUTHORIZED **NO**.

## 10. Smallest next step

A new, explicit human authorization for **one** Lead-plan-only live turn under the new contract (for example `O5.5B17-LEAD`). It keeps the O5.5B15 shape:
- budget `{ leadPlan: 1, others 0 }`;
- Claude Code 2.1.280 haiku/low;
- `--max-turns 6`;
- the pinned fixture;
- the normal terminal only.

Its terminal diagnostic will show `RESULT_OK` or the exact failure.
