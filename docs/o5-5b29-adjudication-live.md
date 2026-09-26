# O5.5B29 — Claude Lead adjudication, live: PASS

Labels: **LIVE-OBSERVED** (the one authorized run, validated independently), **NOT RUN IN A ROUTE**.

Outcome in one line: the **first real Claude Lead adjudication**.

`O5.5B29-ADJUDICATION` ran the O5.5B28 probe once:
- the route Lead's exact binding: Claude Code 2.1.280, `haiku` read back as `claude-haiku-4-5-20251001`, effort `low`, `--max-turns 6`;
- one adjudication of the three Fusion-authored findings over the Fusion-authored candidate.

Results:
- the model turn ended `RESULT_OK` after 1 internal turn;
- one ```` ```json ```` fence was accepted under `rawOrSingleJsonFence`;
- the production contract accepted 3 verdicts;
- the production review policy decided **correction (r1-F1)**;
- integrity and cleanup are complete; nothing else ran.

`O5.5B29-ADJUDICATION` is consumed. This is one sample, in isolation, not inside a route.

## 1. The run

- **Stage 1** (`o5-5b29-adjudication-live`, on `ab175bd` O5.5B28): the authorization was opened exactly as prepared.
  - Fingerprint: `compiledSourceSha256 b9b06a77…6e10` (110 files), `liveEntrySha256 3d08e363…a94c`.
  - Stage-1 patch: `95381266…f30a`, re-verified at Stage 2. The working tree was byte-identical to the Stage-1 patch before any Stage-2 edit.
- **The human** ran it once from a normal PowerShell window (2026-09-25T21:52:13.843Z, 63.4 s):
  - branch `o5-5b29-adjudication-live`;
  - only `CLAUDE_CODE_OAUTH_TOKEN` among the credential-prefixed variables (the subscription-token lane);
  - Claude Code `2.1.280`, Docker `linux`;
  - outcome `PASS`.

## 2. Independent validation (Stage 2)

**43 checks, 0 failed** (evidence SHA-256 `aa1a22d948bbadeb9278bc15de8cb5d801640b6b90bef9f94b21698d708fdc11`). No provider was called and nothing was re-run.

- **Identity and claim:**
  - the executed build equals the Stage-1 fingerprint;
  - the namespace holds exactly the marker, one claim (adjudication-only, budget `{0,0,0,1}`, written during the run), the evidence and the fixture — no preflight file;
  - the authorization, lead grant (the route Lead's grant object), binding and pins (fixture `59c19d1f…`, candidate `a8e6622d…`, finding set `905bd34b…`) equal the compiled ones.
- **Preflight:**
  - 2.1.280 is installed, validated and authorized;
  - billing is clear; the `subscriptionToken` lane is authorized; `FUSION_CLAUDE_EXE` is set;
  - the review surface is eligible; the expected envelope is `rawOrSingleJsonFence`;
  - confined acceptance was granted.
- **Candidate and verification (before the claim):**
  - exactly the Fusion-authored change was applied: baseline → the fixed `src/quote.ts` and the regression test, all four hashes recomputed;
  - Docker-confined verification passed, typecheck and unit both exit 0, `osSandbox`.
- **Request:**
  - the finding set and Fusion's facts (the unit claim of r1-F3 is contradicted) match;
  - **the contract prompt digest `07446ac7…e031` was recomputed offline**: the same fixture and candidate were applied through the production candidate port, the production review evidence and request were built, and `structuredTurnPrompt` was hashed;
  - the prompt carries no provenance session and no Reviewer summary.
- **The one turn:**
  - `completed`, Claude, observed `claude-haiku-4-5-20251001`, requested `haiku`, `low`, `maxTurns 6`;
  - `RESULT_OK` (`success` / `completed`), 1 internal turn, 0 permission denials, 1279 bytes of result text, parsed and schema-checked, exit 0;
  - envelope `SINGLE_FENCED_VALID_JSON`, accepted, one json fence, nothing outside it, body matches the schema.
- **Contract and decision:**
  - `accepted:3 verdict(s)`: r1-F1 MEDIUM CONFIRMED/fix, r1-F2 LOW CONFIRMED/fix, r1-F3 HIGH REJECTED/none, all from the Lead, no fact override;
  - the recorded labels pass the unchanged contract again;
  - `reviewOutcome` reproduces the decision **correction for r1-F1 only**. r1-F2 is LOW, so under the policy it is not outstanding (`isOutstanding`), even though it was confirmed with `fix`. r1-F3 was rejected.
- **Readback:** 2.1.280, `apiKeySource none`, `dontAsk`, tools Glob/Grep/Read, 0 MCP servers, `subscriptionToken` authenticated.
- **No other role:**
  - turn use `{0,0,0,1}`, no refusals;
  - all 7 processes are the authorized `claude.exe` in the checked candidate view (2 auth readbacks, 1 plugin inventory, 3 init probes stopped by Fusion after their readback as established, 1 model process);
  - the model process carried `--model haiku`, `--effort low` and `--max-turns 6` exactly once each, plus the read-only controls, with no widening flag.
- **Integrity and cleanup:**
  - the candidate view was unchanged and released;
  - the primary digest `1988facd…2427` was equal before and after and **recomputed read-only now**, with the same HEAD and canaries;
  - session closed, view and candidate released, no leftover temporaries (the plugin-settings directory is gone), containers 0 → 0.
- **Privacy:**
  - no rationale, summary, prompt, reply or free-text field;
  - no fence, user name, user path or key-like string;
  - paths redacted to `%TEMP%`.

## 3. What the result means

- **Proven live, once:** a real Claude Lead adjudication of production review findings. The production prompt and schema, the recorded single-fence envelope, the production contract and the deterministic policy decision work end to end on the route Lead's binding.
- **The decision sends back only r1-F1.** The policy corrects only outstanding findings (a material severity, verdict CONFIRMED or PARTIAL): r1-F1. A confirmed LOW finding (r1-F2) is recorded, not sent back. That is the unchanged production behaviour.
- **Not proven:**
  - an adjudication inside a route;
  - the review-driven correction and the re-review that the decision calls for;
  - reliability (one sample on one fixture).

## 4. Readiness

**No row state, aggregate or gate moves.** Only descriptive text now names the isolated live evidence:
- `hostControlledWriterWorkflow`: "Never run live **in a route**: Lead adjudication of review findings (live only as an isolated probe: O5.5B29); review-driven correction and re-review."
- `fullRouteLive`: the same list, for passing routes.
- `structuredOutputEnvelope`: Lead adjudications have run live only as an isolated probe (O5.5B29).
- `billingAndAuthPosture`: the readback of the adjudication probe is listed.

`HOST_CONTROLLED_WRITER_WORKFLOW_READINESS`, `REAL_WRITER_MODE_READINESS`, `O5_5B_READINESS` and `O6_READINESS` stay **NO**. `REAL_WRITER_LIVE_GATE_AUTHORIZED` stays false.

## 5. Recorded

- `adjudicationLiveRecords()` (`runtime/provider-profiles.ts`): the O5.5B29 record. It holds binding, labels, verdict and decision labels, envelope, terminal, candidate verification, prompt digest, finding identity and evidence SHA-256 — no text.
- `O5.5B29-ADJUDICATION` is consumed.
- `test/o5-5b29-adjudication-live.test.ts` checks:
  - the exact record, with its decision reproduced from the labels;
  - that the consumed authorization refuses;
  - the readiness texts;
  - that nothing is open.
