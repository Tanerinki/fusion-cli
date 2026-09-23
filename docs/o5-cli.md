# O5 Fusion CLI and control plane

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

The CLI parses arguments and renders results. The control plane (`src/app`) loads configuration, discovers the repository read-only, builds provider candidates through registered `AdapterFactory` objects, constructs workflow dependencies (read-only workspace port, Fusion verifier, EventStore sink), runs the core, maps its terminal state to a user-visible state, and persists run evidence before the command returns. Neither layer names a provider or model; a test scans `src/app`, `src/cli`, `src/core/workflow`, `src/core/policy` and `src/core/review`. The composition root passes `defaultRegistry()` from `src/providers/registry.ts`, where provider-specific option validation, executable discovery and adapter construction live.

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

## Readiness model (`fusion doctor`)

Per binding, eligibility is one of `eligible`, `unknown`, `ineligible`, `unavailable` or `blocked`, evaluated against the same strict surface routing enforces: structured output, filesystem read, `filesystem.write: false`, `shell.available: false`, web tools disabled; plus a structured turn for review roles. **Unknown is never treated as eligible.** Readiness classes:

- `BLOCKED`: Git unavailable, no repository, unsafe Fusion storage, or invalid configuration.
- `REVIEW_READY`: an eligible fresh Reviewer and an eligible adjudicating Lead exist.
- `READ_ONLY_READY`: eligible read-only Lead and Explorer exist.
- `DEGRADED`: none of the above.
- `WRITER_NOT_READY`: always present. Worker bindings are reported `blocked` and are never constructed.

**Activation limits (current providers).** The one-shot Lead adapter proves its read-only posture (read access, structured output, disabled web tools) only through a session's init readback, so statically these are `unknown`. The persistent host transport reports web-tool state `unknown` and needs `--probe` for capabilities; the exec transport proves its launch-flag posture statically, and web-tool disabling only on the verified release. Neither real adapter implements structured review/adjudication turns yet. Consequently, with the default bindings, `fusion review` fails closed (`BLOCKED`, exit 5) with an actionable diagnostic until an adapter is activated. Routing is not weakened to change this.

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

- Real review and adjudication require adapter activation (above); the pipeline is exercised with fake adapters in `test/o5-cli.test.ts`.
- `build` never writes in this release; its writing flows are described and stopped at the Writer gate.
- `fusion review` treats a failing verification plan as a failed run (exit 9) rather than a finding; `--no-verify` skips it.
- A second Ctrl+C may leave a partially written run record; `fusion audit` reports corrupt or truncated run evidence.
