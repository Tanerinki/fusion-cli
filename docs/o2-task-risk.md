# O2 task inspection and deterministic risk gating

O2 turns a structured task request into explained, deterministic risk. It uses no LLM classifier, no provider or model names, no clock and no randomness: identical input yields a deep-equal result.

## Risk algebra (`src/core/policy/risk.ts`)

- Levels are `low < medium < high < critical`, the existing vocabulary. `unknown` remains a storage-only value.
- A `RiskSignal` is one fact: a stable `code`, the minimum `level` it implies, its `source` (`task`, `scope`, `capability`, `verification`, `diff`, `policy`), and a non-secret `evidence` sentence.
- `assessRisk(signals)` takes the highest implied level (`low` with no signals). `decisive` lists the codes that set it, which is the explanation of *why*.
- `escalateRisk(previous, signals)` is monotonic. It never returns a lower level and never drops earlier signals, whatever the new facts say. Routing or later logic therefore cannot de-escalate a task.

## Task inspector (`src/core/policy/task-inspector.ts`)

`inspectTask(request)` validates a `TaskRequest` (operation, summary, repository-relative paths, whether scope is known, expected mutation, requested capabilities, verification requirements, explicit indicators). It returns normalized, sorted paths, path classes, destructive phrases and the initial `RiskAssessment`. Malformed requests are `InvalidInput`.

Validation fails closed (O3.1):
- capability and indicator flags must be exactly booleans; any other value (`"true"`, `1`) or an unknown key is `InvalidInput`, never silently read as "not requested";
- unknown top-level or verification fields are refused;
- a summary longer than 16,384 characters is refused rather than truncated, so no instruction can hide beyond a scanned prefix.

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
| dependency manifests (including `package.json` scripts), migrations/schema, CI/release files | high |
| repository-control files: `.gitignore`, `.gitattributes`, `.gitmodules` at any depth, `.husky/**`, `.githooks/**`, `lefthook.*`, `.pre-commit-config.yaml` | high when written (low when only read) |
| verification/build-control files: `jest.*`/`vitest.*`/`playwright.*`/`cypress.*`/`karma.*`/`ava.*`/`wdio.*` config, setup and workspace files, `.mocharc*`, `.nycrc*`, `.c8rc*`, `.babelrc*`, `babel.config.*`, `tsconfig*.json`, `jsconfig.json`, `Makefile`, `justfile`, `Taskfile.yml`, `pytest.ini`, `conftest.py`, `tox.ini`, `noxfile.py`, `.coveragerc`, `.nvmrc`, `.node-version` | medium when written (low when only read) |
| a written task path the verification plan names explicitly (argument or `--flag=value`, resolved against the step's cwd; a glob names its directory) | medium (`verificationReferencedPath`, applied by the workflow engine) |
| auth/billing/permission/security code | high |
| Fusion storage | high |
| architecture change or ambiguity, ambiguous capability enforcement | high |
| credential material (`.env*`, keys, certificates, `.npmrc`, …) or Git internals | critical when written (credential material is high even when only read) |
| release, external side effects, irreversible operation, destructive Git | critical |
| path outside the repository | critical |
| request or delegated text mentioning push (any), force-push, remote branch deletion, forced branch deletion or overwrite, discarding working-tree changes, `stash drop`/`clear`, `reset --hard`, `git clean -f`, history rewrite, reflog expiry or pruning, recursive delete, data destruction, production publish | critical |
| text mentioning `branch -d`, a plain `rebase`, tag or ref deletion, worktree removal; credential handling | high |

Path classes match whole path segments or exact file names, not substrings: `tokenizer-notes.md` is not token material and `docs/jest-notes.md` is not test configuration. Phrase matching only ever raises risk.

## Risk text (`src/core/policy/risk-text.ts`, O3.1)

`scanRiskText(texts, origin)` is the only scan for text that can steer a role. `inspectTask` uses it for the summary, and the workflow engine uses it for every delegation packet field and for each packet Fusion forwards. It is bounded: at most 16,384 characters per text, 2,000 texts and 1 MiB in total. Anything larger is `InvalidInput`, never partially scanned. Detection combines:
- natural-language patterns (for example "force-push", "delete the release branch on origin", "discard all local changes");
- token-aware reading of Git invocations. Command text is split at shell separators and sentence ends, Git global options are skipped, and flags are read as tokens, so flag order, clustered short flags (`-fu`), `+refspec` force pushes and `:branch` deletions are all recognized. Without a literal `git`, a subcommand counts only when its arguments look like Git syntax (a flag, `+`/`:` refspec, `.`, or `stash drop|clear`), so prose such as "push the button" or "clean up the code" is not escalated.

Runtime facts escalate through the same algebra:
- `verificationFailureSignal` (high): a Fusion verifier did not pass.
- `unexpectedScopeSignals` (high, or critical if any unexpected path is sensitive): the writer changed paths outside its delegated scope.

## Limitations

The inspector evaluates what the caller declares. A task that under-declares its paths is caught later by the unexpected-scope signal against the lease's observed diff, not up front. Keyword patterns are English-only and deliberately conservative: they may over-escalate, and they never de-escalate. Token detection covers Git; other tools' destructive commands rely on the natural-language patterns and on the declared capabilities.
