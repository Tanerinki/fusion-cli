# Contributing to Fusion CLI

Thanks for your interest. Fusion is security-sensitive: it runs model CLIs against people's repositories and writes
approved changes into their checkouts. Contributions are welcome when they keep that boundary intact.

## Before contributing

Read, in this order:

1. [README.md](README.md) — what Fusion does and its supported scope
2. [docs/architecture-overview.md](docs/architecture-overview.md) — components, the Writer route, trust boundaries
3. [docs/security-model.md](docs/security-model.md) and [SECURITY.md](SECURITY.md)
4. [docs/host-controlled-changes.md](docs/host-controlled-changes.md) — the change-set contract

The milestone notes in `docs/` explain why things are the way they are; read the ones for the area you touch.

## Invariants

Every change must preserve these:

- **Provider neutrality.** No workflow, policy or command code (`src/core`, `src/app`, `src/cli`) names a provider or model;
  guard tests enforce it. Role → provider/model mapping is configuration; provider-specific behavior lives in the adapter.
- **Host authority.** Models only propose. Only Fusion applies change sets, only to private candidates, only within the
  confirmed scope; only Fusion's confined verification counts as verification.
- **Read-only providers.** Provider sessions stay read-only in Fusion-owned views; unknown capability state fails closed.
- **Human boundaries.** A Writer build needs the human's typed confirmation; a delivery reaches a checkout only after the
  human types its exact manifest digest, a passing precheck and a single-use claim. Never add a `--force`, `--yes`,
  environment variable or configuration key that skips any of these, and never answer those prompts on the human's
  behalf.
- **Clean evidence.** No provider transcripts, hidden reasoning or credentials in run evidence, logs or errors; model text
  stays bounded and redacted.
- **Bounded autonomy.** Retries, corrections and model turns stay bounded; unverifiable work is refused before any model
  turn.
- **No destructive or outward Git.** No automatic commit, push, force-push, reset, clean, stash, merge, rebase, tag or
  release.

Unattended Writer mode is not enabled; a change that would enable it needs a separately reviewed design first.

## Development setup

```powershell
npm ci
npm run typecheck
npm test            # builds, then runs the deterministic suite
npm run smoke:pack  # optional: clean clone → pack → private install → run (never publishes)
```

The normal suite makes **no live provider calls**, no network calls and needs no Docker daemon: providers are exercised
through their real adapters against scripted fake binaries, and Docker through a fake daemon.

Live tests are explicit opt-in and never run in CI: `npm run test:live`, `npm run test:docker-live`,
`npm run test:writer-live`, and the human-run live acceptance (`scripts/v01-live-acceptance.mjs`). Run them yourself, from a
normal terminal, only with your own accounts.

## Tests

- Changes to the Writer route, change sets, candidates, verification, the delivery store, approval or apply need
  **adversarial tests**: malformed or hostile model output, hostile repository content, links and reparse points, races,
  interrupted processes, replays. Test failure paths as carefully as success paths.
- Prefer tests of externally observable behavior (through `runCli` or the public module functions) over mirrors of the
  implementation.
- Never weaken a safety check to make a test pass.

## Pull requests

Use focused branches (`feature/<name>`, `fix/<name>`, `docs/<name>`) and scoped commits. The pull request template asks
which invariants you touched, what provider or network activity you used, and how you verified the change. Changes to
process execution, workspaces, Git state, auth/billing, redaction, verification or delivery should get an independent
review before merge.

Commit subjects follow a concise conventional style:

```text
feat: add supported greenfield create
fix: show and record the decision a lead requests
docs: record v0.1 live validation
```
