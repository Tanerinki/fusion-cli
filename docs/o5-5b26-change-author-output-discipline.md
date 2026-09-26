# O5.5B26 — Change Author output discipline (offline)

Labels: **MECHANICALLY ENFORCED** (code plus deterministic tests), **FAKE-PROCESS PROVEN** (plumbing only), **NOT PROVEN** (live).

Outcome in one line: the Claude Change Author's reply rule is now an explicit **output discipline** — the role, the proposal only, the exact accepted wire forms, nothing outside the payload (also after inspecting files), no claims of application or verification, stop after the payload. **The parser, the envelope policies, the ChangeSet contract and every other prompt are unchanged.** Offline only; whether a live Change Author complies is not proven.

## 1. What O5.5B25 showed

The route Change Author's **model turn succeeded** (`RESULT_OK`, 4 internal turns, exit 0). Its 3069-byte reply held exactly one closed ```` ```json ```` fence whose body was one strict JSON object **matching the ChangeSet schema** — but **non-whitespace text stood before the fence** (`EXTRA_TEXT`, `extraTextLocation: beforeFence`, whitespace only after). The strict `rawOrSingleJsonFence` envelope refused it before the ChangeSet contract, as it must.

## 2. Root cause (prompt layer)

Both Change Author prompts were rendered offline with the compiled prompt code — the O5.5B11 proposal-probe prompt (whose live reply was a single accepted fence) and the O5.5B25 route prompt:

- **The instruction lines are byte-identical.** Both are `structuredTurnPrompt` (provider-neutral: role, read-only rules, SHA-256 rule, `Output: exactly one JSON object and nothing else: no Markdown fence, no commentary, no text before or after it`, the ChangeSet schema) followed by the data (`Delegation`, `Baseline`) and, last, the Claude reply rule. No suffix anywhere asks for an explanation, summary, changed-file list, test narrative or rationale.
- **Only the data differs:** the route delegation carries the Lead's **model-authored plan summary** (`architecture.decisions: "Lead plan: …"`) and a two-file task with a regression test (acceptance criteria), which the Change Author explored more (4 internal turns); the probe was a one-file task.
- **What the instructions did not do:**
  1. The Claude reply rule demanded *the raw object alone, no fence* — which **no live Claude structured reply ever did** (O5.5B9, O5.5B11, O5.5B17, O5.5B21 and O5.5B25 were all fenced); the instruction contradicted the mechanical contract (one fence is accepted) and did not single out the one thing that actually fails: text **outside** the payload.
  2. Nothing addressed the **final reply after tool use** — the point where an agentic turn tends to narrate ("I inspected … here is the proposal:") before answering.
  3. Nothing asked to **stop** right after the payload.

The smallest prompt-layer explanation: an instruction that is (1) contradicted by every live reply's form and (2) silent on the post-exploration final message, applied to a task that required more exploration and carried model-authored prose in its data. One live sample; the explanation is the most plausible one, not a proof.

## 3. The change

`src/providers/claude/one-shot-transport.ts`: `claudeProposalReplyRule(policy)` renders the rule for the transport profile's recorded `changeProposalEnvelope`; `CLAUDE_PROPOSAL_REPLY_RULE` is that rule for `rawOrSingleJsonFence`. It stays the **last** text of the change-proposal prompt, after all data:

```
Reply format (Fusion checks it mechanically; any other reply is refused and nothing is applied):
- You are the Change Author. Produce the requested implementation proposal only: exactly one JSON object matching the ChangeSet schema above.
- Your final reply is that payload and nothing else, also after you have inspected files. Do not explain the proposal before or after it. No commentary, rationale, summary, list of changed files, test narrative or Markdown prose outside the payload.
- Allowed forms, and only these (the raw object is preferred): (1) the raw JSON object alone; (2) exactly one ```json fenced block containing only that object; (3) exactly one ``` fenced block containing only that object. Only whitespace may appear outside the fence. No second fence, no other fence language.
- Do not claim that anything was applied, changed, run or verified: Fusion applies and verifies the change itself.
- Stop immediately after the payload.
```

For a `rawOnly` transport the forms line would name only the raw object (first character `{`, last `}`, no fence).

**Where it lives:** in the Claude transport layer, because the accepted fence forms are this transport's recorded envelope, and Claude has no constrained decoding for this reply (a schema flag adds a tool, O5.5B10) — the instruction is its only lever. The Exec family decodes against an output schema with a raw-only reader, so the provider-neutral contract (`structuredTurnPrompt`) — and with it every other family's Change Author prompt — is byte-identical.

## 4. Not weakened (proof)

- **The envelope parser** `src/platform/process/structured-envelope.ts` is byte-identical: its normalized source SHA-256 `96446513…8fab` equals the pre-change value (pinned in a test).
- **Policies:** Claude `changeProposalEnvelope`, `leadPlanEnvelope`, `adjudicationEnvelope` stay `rawOrSingleJsonFence`; the review stays `rawOnly`; every Muse policy stays `rawOnly`.
- **Behaviour, re-proven:** accepted — raw JSON (O5.5B11 style), one json fence, one bare fence, whitespace outside; refused — prose before (**the exact O5.5B25 shape**: one closed json fence, schema-matching body, whitespace after, `schemaValidationReached: false`), prose after, prose before and after, prose after raw JSON, two fences, a `javascript` or tilde fence, a fenced schema-invalid ChangeSet (`INVALID_SCHEMA`); a raw schema-invalid one is handed on and refused by the unchanged `validateChangeSet`.
- **The ChangeSet schema and validation**, `--max-turns 6`, Claude Code 2.1.280 / haiku / low, the retry policy and every role budget are unchanged.

## 5. Unchanged prompts (pinned)

| Prompt | SHA-256 (before = after) |
| --- | --- |
| Provider-neutral Change Author contract (every other family) | `2b063280…6f04` |
| Lead plan instruction (O5.5B16) | `59d3aed7…1387` |
| Claude Lead plan prompt / Muse Lead plan prompt | `74e6bfe0…9b05` / `1bcb8b40…070a` |
| Reviewer prompt (Claude adds nothing) | `400cf579…0609` |
| Adjudication prompt (Claude adds nothing) | `63e69cf6…64ef` |

The Claude change-proposal prompt changed only in its reply rule: the O5.5B16 pin moved from `230563d7…fc6a` to `6fcd94ab…625d`, with the provider-neutral part equal.

## 6. Tests

`test/o5-5b26-change-author-output.test.ts` (7):

| # | What it proves |
| --- | --- |
| 1 | The Change Author's prompt is the neutral contract, then the discipline last; every required statement present; the previous rule gone; a raw-only transport would be told the raw object only. |
| 2 | Every mention of explanation, summary, rationale, commentary, narrative or changed files in the instruction is a prohibition — nothing asks for prose. |
| 3 | Accepted as before: raw (O5.5B11 style), json fence, bare fence, whitespace outside — and the ChangeSet contract passes. |
| 4 | Refused as before: prose before (the O5.5B25 shape, with its recorded facts), after, both; prose after raw JSON; two fences; a `javascript` or tilde fence; a fenced invalid ChangeSet; a raw invalid one refused by `validateChangeSet`. |
| 5 | Unchanged: the parser's source bytes, every policy, the neutral Change Author contract, the Lead, Reviewer and adjudication prompts. |
| 6 | Route (fake): the O5.5B25 reply shape is still refused at `changeAuthor #1` (`beforeFence`, schema-matching body, no review); a compliant reply reaches the Reviewer and the route passes; every Change Author prompt ends with the discipline and never carries the previous rule; Lead and Reviewer never receive it. |
| 7 | Readiness: nothing advances; no live authorization is open. |

`test/o5-5b10-structured-output.test.ts` checks the new rule's phrases; `test/o5-5b16-lead-planning-prompt.test.ts` carries the new pin.

## 7. What remains

A new, separately authorized full-route run (O5.5B27): the O5.5B25 bindings, fixture and budgets exactly, with only this Change Author output discipline changed. Only a live run can show whether the Change Author complies.

| Gate | State |
| --- | --- |
| providerChangeProposal | satisfied (recordedLiveProbe), preserved |
| fullRouteLive | blocked: 2 runs, 0 passed |
| hostControlledWriterWorkflow | partial (fakeProviderRehearsal) |
| liveGateAuthorization | blocked |
