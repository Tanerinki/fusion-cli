# O2 task inspection and deterministic risk gating

O2 turns a structured task request into explained, deterministic risk. It uses no LLM classifier, no provider or model names, no clock and no randomness: identical input yields a deep-equal result.

## Risk algebra (`src/core/policy/risk.ts`)

- Levels are `low < medium < high < critical`, the existing vocabulary. `unknown` remains a storage-only value.
- A `RiskSignal` is one fact: a stable `code`, the minimum `level` it implies, its `source` (`task`, `scope`, `capability`, `verification`, `diff`, `policy`), and a non-secret `evidence` sentence.
- `assessRisk(signals)` takes the highest implied level (`low` with no signals). `decisive` lists the codes that set it, which is the explanation of *why*.
- `escalateRisk(previous, signals)` is monotonic. It never returns a lower level and never drops earlier signals, whatever the new facts say. Routing or later logic therefore cannot de-escalate a task.

## Task inspector (`src/core/policy/task-inspector.ts`)

`inspectTask(request)` validates a `TaskRequest` (operation, summary, repository-relative paths, whether scope is known, expected mutation, requested capabilities, verification requirements, explicit indicators). It returns normalized, sorted paths, path classes, destructive phrases and the initial `RiskAssessment`. Malformed requests are `InvalidInput`.

| Signal | Level |
|---|---|
| read-only operation | low |
| one known file written | low |
| several known files written | medium |
| configuration change, shell requested | medium |
| writer without a verification plan | medium (high if verification was *required*) |
| more than 20 files, unknown or undeclared write scope | high |
| delete, migrate | high |
| network requested | high |
| dependency manifests, migrations/schema, CI/release files | high |
| auth/billing/permission/security code | high |
| Fusion storage | high |
| architecture change or ambiguity, ambiguous capability enforcement | high |
| credential material (`.env*`, keys, certificates, `.npmrc`, …) or Git internals | critical when written (credential material is high even when only read) |
| release, external side effects, irreversible operation, destructive Git | critical |
| path outside the repository | critical |
| request text mentioning force-push, `reset --hard`, `git clean -f`, history rewrite, recursive delete, data destruction, production publish | critical |

Path classes match whole path segments, not substrings: `tokenizer-notes.md` is not token material. Phrase matching only ever raises risk.

Runtime facts escalate through the same algebra:
- `verificationFailureSignal` (high): a Fusion verifier did not pass.
- `unexpectedScopeSignals` (high, or critical if any unexpected path is sensitive): the writer changed paths outside its delegated scope.

## Limitations

The inspector evaluates what the caller declares. A task that under-declares its paths is caught later by the unexpected-scope signal against the lease's observed diff, not up front. Keyword patterns are English-only and deliberately conservative: they may over-escalate, and they never de-escalate.
