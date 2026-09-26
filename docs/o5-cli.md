# O5 Fusion CLI and control plane

> Historical milestone note. For the v0.1 product (chat, analyze, build, create, deliveries, history, config) see the
> [README](../README.md); where they differ, the README describes current behavior.

O5 turns the provider-neutral core into a local command-line tool. It adds four commands (`doctor`, `review`, `audit`, `build`) plus `show`, a control plane between the CLI and the core, strict configuration, stable exit codes and run references. Real Writer mode stays blocked: see "Real Writer mode gate" in `docs/o3-workflow.md`, which remains authoritative.

## Architecture

```text
src/cli/main.ts        executable entry point: process wiring, Ctrl+C, real provider registry
src/cli/run.ts         runCli(argv, io, host) → exit code; errors through failure-presentation
src/cli/args.ts        deterministic argv parser (no framework, no shell)
src/cli/render.ts      redacted, terminal-safe text and JSON output
src/app/*              control plane (provider-neutral)
src/providers/registry.ts   the only place that maps adapter kinds to concrete provider adapters
src/core/*             policy, workflow, review (unchanged semantics)
```

The CLI parses arguments and renders results. The control plane (`src/app`) loads configuration, discovers the repository read-only, builds provider candidates through registered `AdapterFactory` objects, constructs workflow dependencies (read-only workspace port, Fusion verifier, EventStore sink), runs the core, maps its terminal state to a user-visible state, and persists run evidence before the command returns. Neither layer names a provider or model; tests scan `src/app`, `src/cli` and all of `src/core`. The composition root passes `defaultRegistry()` from `src/providers/registry.ts`, where provider-specific option validation, executable discovery and adapter construction live.

## Commands

| Command | What it does | Writes |
|---|---|---|
| `fusion doctor [--probe]` | Runtime, repository, configuration, storage, lease and verification checks; per-binding executable, billing guard, capability state, identity, structured-turn, review and Writer eligibility; readiness classes. Providers are inspected statically. `--probe` may start provider CLIs to read back auth (never inference). | nothing |
| `fusion review [--base <ref>] [--no-verify] [--timeout <s>]` | Read-only review of the Fusion-observed change: task inspection and risk, optional read-only verification of the primary, a fresh Reviewer and Lead adjudication (O4). No delegate, no Writer, no lease. | a run under `.fusion/runs` |
| `fusion audit` | Deterministic, read-only audit: repository state, storage and event-log consistency, leases and worktrees, tracked risk-sensitive files, verification configuration, provider readiness, and the Writer-gate prerequisites. No model is used. | nothing |
| `fusion build [--path <p>]... [--operation <op>] [--timeout <s>] [--] "<task>"` | Validates the task text, runs the task inspector and risk gate (including the canonical delegated-text scan), and states the intended workflow. A task that needs an autonomous Writer stops with `REAL_WRITER_MODE_NOT_READY`, or `HUMAN_GATE_REQUIRED` when critical. Read-only operations (`read`, `analyze`, `review`, `test`) run the read-only workflow. | a run under `.fusion/runs` |
| `fusion show <run-id>` | A bounded summary of a recorded run: status, user-visible state, pending stage, risk, final workflow state and findings with verdicts. Raw artifacts are never printed. | nothing |

**Review target.** Without `--base`, `fusion review` reviews the working tree (staged, unstaged and untracked, non-ignored files) against `HEAD`. With `--base <ref>`, it reviews the working tree against the merge base of the local `<ref>` and `HEAD`. Refs are resolved locally only: nothing is fetched and no remote branch is chosen implicitly. An empty change is reported as `ANSWERED` ("nothing to review") without starting a run. The review evidence is Fusion's own bounded diff; the primary workspace is proven unchanged around every Reviewer and Lead turn and around verification. The configured verification plan runs unless `--no-verify`; it must be read-only.

## User-visible states

| State | Meaning | Finished |
|---|---|---|
| `COMPLETED` | Fusion verification of the final attempt passed and every required review gate passed. | yes |
| `ANSWERED` | A read-only result without authoritative verification; nothing was verified or changed. | yes |
| `REVIEW_REQUIRED` | A required fresh review could not run (no eligible Reviewer after an escalation). | no |
| `DECISION_REQUIRED` | A Lead or human decision is required (e.g. unresolved findings). | no |
| `HUMAN_GATE_REQUIRED` | A human must approve before any autonomous work continues. | no |
| `BLOCKED` | A readiness gate refused the command before work: `REAL_WRITER_MODE_NOT_READY`, no eligible binding (`CapabilityUnavailable`), billing or auth refusal. | no |
| `FAILED` / `TIMED_OUT` / `CANCELLED` | Typed failure, deadline, or Ctrl+C. | no |

Unfinished runs are recorded with manifest status `pending` (never `completed`). Output never calls an unfinished run a success.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | `COMPLETED` or `ANSWERED`; doctor `REVIEW_READY`/`READ_ONLY_READY`; audit clean or attention; help/version/show |
| 1 | internal error |
| 2 | invalid input or usage error (unknown/duplicate/conflicting flags, bad task text, invalid configuration) |
| 3 | billing guard or subscription authentication |
| 4 | security policy violation (e.g. a workspace changed during a read-only turn) |
| 5 | capability unavailable (no eligible binding for a required role) |
| 6 | provider failure or malformed provider output |
| 7 | timeout |
| 8 | workspace conflict |
| 9 | Fusion verification failed |
| 10 | run storage failure |
| 11 | blocked by a readiness gate (`REAL_WRITER_MODE_NOT_READY`, doctor `BLOCKED`, audit blocked) |
| 12 | review required |
| 13 | decision required |
| 14 | human gate required |
| 15 | doctor `DEGRADED` |
| 130 | cancelled (Ctrl+C) |

For an O5.5A real-review live gate, exit codes 0 (`ANSWERED`), 13 (`DECISION_REQUIRED`) and 14 (`HUMAN_GATE_REQUIRED`) are valid review outcomes. Exit 14 means Fusion correctly stopped at a human gate; a live-gate harness must not report it as an infrastructure failure. There is no maintained O5.5A review-gate script in this repository, so no machine-specific Downloads script is introduced here.

Muse Exec terminal failures now expose only a bounded `providerDiagnostic` classification and a fixed safe message. A caller-owned evidence directory receives allowlisted event labels, identity-match booleans, the safe diagnostic, and stderr size/truncation metadata. It never receives the raw provider reason, prompt, model answer or stderr text. Without a caller-owned evidence directory, the diagnostic stays in memory and the temporary attempt directory is removed.

## Readiness model (`fusion doctor`)

Per binding, eligibility is one of `eligible`, `unknown`, `ineligible`, `unavailable` or `blocked`, evaluated against the same strict surface routing enforces: structured output, filesystem read, `filesystem.write: false`, `shell.available: false`, web tools disabled. Review roles additionally need a structured turn and routing's `REVIEW_ISOLATION` (below); readiness reads that constant, so the two cannot drift. **Unknown is never treated as eligible.** Readiness classes:

- `BLOCKED`: Git unavailable, no repository, unsafe Fusion storage, or invalid configuration.
- `REVIEW_READY`: an eligible fresh Reviewer and an eligible adjudicating Lead exist.
- `READ_ONLY_READY`: eligible read-only Lead and Explorer exist.
- `DEGRADED`: none of the above.
- `WRITER_NOT_READY`: always present. Worker bindings are reported `blocked` and are never constructed.

`doctor` also prints each binding's **posture evidence**: `launch-time` (established before any session and re-checked before each turn), `observed in a session`, or `none (posture unproven)`.

## Real read-only review (O5.5A)

`fusion review` runs with the real providers: the `muse-exec` Reviewer and the `claude-one-shot` Lead of the default bindings (any binding with the same proven posture works; routing never names a provider).

**Structured turns.** Both adapters implement `runStructuredTurn` for the O4 contracts; there is no second schema. `src/core/review/contract.ts` renders the O4 review and adjudication contracts, from the same constants as the validators, as role prompts and a JSON Schema used only as a decoding aid. The Reviewer prompt asks for independent, evidence-backed findings, states that the summary carries no authority, carries no implementer rationale, and forbids claiming execution. The Lead prompt requires exactly one verdict per finding, spells out the legal verdict/action pairs, and separates provider opinion from Fusion's evidence. Provider output is strict JSON (duplicate keys refused) and stays untrusted until `validateReviewReport`/`validateAdjudicationReport` accept it; Fusion evidence still overrides the Lead. **Prose around the JSON is malformed**: a fence, a preamble or trailing text fails with `MalformedOutput`; only JSON whitespace is allowed around the value. Nothing is ever extracted or repaired. (O5.5B10: review turns keep exactly this rule; a Claude change proposal — and since O5.5B22 a Claude Lead adjudication — may arrive inside one outer `json`/bare fence with nothing but whitespace outside it; see `docs/o5-5b10-claude-structured-output.md` and `docs/o5-5b22-adjudication-envelope.md`. The core validators are unchanged.) The one-shot transport cannot use a schema flag (it adds a tool), so its prompt carries the canonical schema.

**Exec wire schema.** The exec provider's structured decoding accepts only strict schemas. Every object must list every property in `required` and stay closed; the live provider rejects the canonical review schema with HTTP 400 (`… Missing 'facts'`). The exec transport therefore works as follows, without changing the canonical contract:

- It derives a strict **wire schema** (`toMuseStrictSchema`). Every property becomes required, and a canonically optional property becomes `anyOf: [<its schema>, {"type": "null"}]`. Objects stay closed, and every constraint is kept.
- Shapes the transform cannot represent faithfully fail closed:
  - an open object;
  - an array without items;
  - a canonical `null` or `anyOf`;
  - a `required` entry naming no property.
- It passes that schema to `--output-schema` and shows the same schema in the prompt, with a note that `null` marks an optional field that does not apply.
- It parses the output strictly and validates it against the wire schema.
- It removes `null` only from canonically optional properties (a `null` anywhere else stays and fails).
- It validates the result against the canonical schema, then the O4 validators.

The schema validator accepts `anyOf` only in that nullable form: exactly one schema plus `{"type": "null"}`, nothing beside it. The one-shot Lead never sees the wire form.

**Review isolation.** A Reviewer or adjudicating Lead routes only when its capability snapshot proves, before its first turn, the strict read-only surface plus `REVIEW_ISOLATION`:

| Fact | Meaning |
|---|---|
| `approvalEscalationDisabled` | No approval path (prompt, model-judged approval, approval mode) can widen the posture. |
| `personalContextDisabled` | User memory, personal instructions and other applications' context are excluded. |
| `extensionsQuarantined` | Plugins, hooks and MCP servers cannot add tools or network reach. |
| `modelIdentityReadback`, `subscriptionLaneReadback` | The serving model and the subscription lane are read back before the turn. |

A failing fact is rejected as `postureUnmet`; routing reads facts, never CLI flags.

**Static (launch-time) versus observed facts.** Adapters derive launch-time facts from the exact argv and child environment they launch with, and only on the runtime version those controls were validated on. A missing control, a widening flag or an unverified version leaves the fact `unknown`, never assumed. `postureEvidence.source` records `launchFlag` (launch-time) or `runtimeReadback` (observed in a session).

| Fact | `claude-one-shot` (validated 2.1.280) | `muse-exec` (verified 1.3.0-R3401.1) |
|---|---|---|
| read yes, write/shell no, web off | `--tools Read,Grep,Glob` with `--restricted`; tools read back at init | `--disable-write --disable-shell --disable-web-tools` |
| approval escalation off | `--permission-mode dontAsk --permission-prompts none`; mode read back | `--approval-judge off --approval-mode never` |
| personal context off | `--safe-mode` (no CLAUDE.md), `--restricted` (no user/project/local settings), `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` for the child only | `--no-foreign-personal-context` |
| extensions quarantined | `--safe-mode`, `--strict-mcp-config`, `--disable-slash-commands`; mandatory per-turn plugin quarantine; any hook event fails the turn | Exec takes no MCP configuration; the session-MCP, managed-hook and web-tool switches are stripped from the child environment by the billing guard (checked against the live rules) |
| identity and lane readback | auth status and init `apiKeySource`/model before every turn | `account/read` before and after every turn; `run.model.configured` readback |
| version source | installed package metadata beside `<package>/bin/claude.exe`, read without starting it | the native `muse-bin-<version>.exe` name selected by `.muse-version` |

The one-shot init readback stays authoritative. A runtime whose version, tools, permission mode, MCP servers, plugins, credential source or model differ from the launch-time facts fails the turn closed (`CapabilityUnavailable`, `SecurityViolation`, `AuthMismatch` or `ProviderIdentityMismatch`). The `muse-msp` transport has no structured channel and cannot disable web tools, so it is never a review binding.

**Credential lanes.** The billing guard classifies the environment before any process starts, by variable name only.

- **Claude:**
  - With no credential variable, the candidate lane is `subscription` (the interactive login).
  - With `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), it is `subscriptionToken`, the subscription OAuth token lane. The token is forwarded to the provider child only.
  - The `oauthTokenPolicy` option can instead `strip` the token or `block` it; the default is `subscriptionOAuth`. `forwardExplicitSubscriptionToken` is kept as a synonym.
- **Refused before spawn, with or without a token:**
  - `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`;
  - Bedrock/Vertex/Foundry routes;
  - unrecognized provider variables;
  - an API-key helper or credential override in settings.
- **After spawn,** the lane is read back before any turn is trusted:
  - the auth status must report a first-party OAuth-token login for the token lane (an interactive login for `subscription`);
  - the session must report no API-key source.

  A mismatch, an API-key or third-party source, or missing evidence is `AuthMismatch`.

`fusion doctor` keeps the stages apart. The static output shows `billing guard clear (candidate lane: …; unverified until probed)` and never claims authentication. `fusion doctor --probe` reads the lane back, and a failed, non-subscription or different-lane probe blocks that binding (readiness `DEGRADED`).

**Provenance.** Each structured turn records a `StructuredTurnObserved` event before its output is used: cycle, kind, role, Fusion session, bound provider and transport, the requested model and the model the provider reported. A completed turn that does not name its serving model is malformed.

**Failures.** Every expected failure is typed and fails closed:

| Situation | Outcome |
|---|---|
| no eligible Reviewer or Lead (unknown or missing capability) | `BLOCKED`, `CapabilityUnavailable`, exit 5, before any provider turn |
| billing or provider override | `BLOCKED`, `BillingBlocked`, exit 3, before any provider process starts |
| logged-out or non-subscription account | `BLOCKED`, `AuthMismatch`, exit 3, after the auth readback and before any inference |
| Reviewer blocked or failed | the Lead is never invoked |
| Reviewer succeeded, Lead unavailable | findings persisted; `BLOCKED` or `FAILED` by kind, never `ANSWERED`/`COMPLETED`. With no findings the Lead is not needed. |
| malformed output, nonzero exit, no result | `FAILED`, `MalformedOutput`/`ProcessFailure`/`ProtocolError`, exit 6 |
| identity mismatch | `FAILED`, `ProviderIdentityMismatch`, exit 4 |
| deadline, Ctrl+C | `TIMED_OUT` exit 7, `CANCELLED` exit 130; no output is kept |
| critical risk | `HUMAN_GATE_REQUIRED` before any provider turn |

A review builds only Reviewer and Lead adapters (never a Worker), acquires no lease, and proves the primary workspace unchanged around every turn. `--no-verify` can produce `ANSWERED` only; `COMPLETED` still requires a passing Fusion verification.

The same launch-time facts also let the one-shot Lead take part in read-only `fusion build` operations (`read`, `analyze`, `review`, `test`). That flow is unchanged and still read-only.

**Live validation.** The deterministic suite drives the real adapters against local fixture executables. It proves the wiring, not the providers. Validate once against the real CLIs from a normal PowerShell terminal (not from inside another agent session): `fusion doctor`, `fusion doctor --probe`, then one small `fusion review` and `fusion show <run-id>`. The events must show both `StructuredTurnObserved` records with the expected observed models, and the repository must be unchanged.

## Configuration

`fusion.config.json` at the repository root (or `--config <file>`). Without a file, the registry's default bindings apply. It is parsed as strict JSON (duplicate keys rejected), bounded to 256 KiB, and validated strictly: **unknown keys fail**.

```json
{
  "schemaVersion": 1,
  "bindings": [
    { "role": "Lead", "adapter": "<adapter kind>", "model": "<model>", "effort": "<effort>", "maxTurns": 8, "options": { } }
  ],
  "verification": { "commands": [
    { "id": "unit", "executable": "C:\\absolute\\path\\to\\node.exe", "args": ["--test"], "cwd": ".", "timeoutMs": 600000,
      "mutationPolicy": "readOnly" } ] },
  "limits": { "runTimeoutMs": 1800000 }
}
```

`options` are adapter-specific and validated by the adapter's factory (unknown options fail). Credential-like keys (`apiKey`, `token`, `secret`, `password`, …) are refused anywhere in options: secrets stay in the provider's own login and environment, which the billing guard continues to police. Role → provider/model mapping stays configuration; workflow semantics never depend on it.

## Safety properties

- Arguments are data: no shell evaluation, globbing or expansion. A task that starts with `-` must follow `--`. Arguments are bounded (256 arguments, 32 KiB each; task text 16 KiB, refused rather than truncated).
- Task text with control or bidirectional-override characters is refused. All output is redacted with the environment-aware `DiagnosticRedactor` and escapes C0/C1 control characters and bidi overrides, in text and JSON.
- Expected failures print a typed title, message and hint, never a stack trace; `--debug` adds only safe cause codes.
- Ctrl+C aborts the run through the workflow's signal (cancelling provider turns and verification processes); the outcome is recorded before exit. A second Ctrl+C forces exit.
- A result is printed only after its run's outcome artifact, closing event and manifest status are persisted. An event-store failure cannot become a success.
- `doctor` and `audit` never create `.fusion`, runs or leases, and never modify the repository.

## Known limitations

- Real review is activated for the validated runtime versions only; any other version reports its posture `unknown` and review stays `BLOCKED` until it is validated. The deterministic suites (`test/o5-cli.test.ts`, `test/o5-5-real-review.test.ts`) use fixture executables; real-provider behavior needs the live validation above.
- The one-shot Lead's auto-memory switch is a child-only environment control whose effect is not read back; managed policy hooks remain unverified beyond the absence of hook events (as in M5). The exec transport's extension quarantine covers the switches known for the verified release; Fusion does not read a plugin inventory for it.
- A malformed exec response is retried once, as for packet turns; a one-shot turn is not retried.
- Default per-turn deadlines are 120 s; an adjudication over a large change may need a larger `timeoutMs` binding option.
- `build` never writes in this release; its writing flows are described and stopped at the Writer gate.
- `fusion review` treats a failing verification plan as a failed run (exit 9) rather than a finding; `--no-verify` skips it.
- A second Ctrl+C may leave a partially written run record; `fusion audit` reports corrupt or truncated run evidence.
