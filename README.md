# Fusion CLI

**Several AI coding models on one repository — with host-controlled changes, confined verification, fresh review and human-approved delivery.**

> **Status: v0.1, pre-release.** The v0.1 commands are implemented and covered by a deterministic offline acceptance suite
> (real CLI, real workflow engine, real provider adapters on scripted fake binaries). The live validation of the v0.1
> commands against the real provider CLIs is **pending** (it is run by a human; see [Live acceptance](#live-acceptance)).
> Earlier milestones proved the Writer route live (plan, change proposal, confined verification, review, adjudication,
> correction) and one apply into a disposable repository. Unattended Writer mode stays off.

## What Fusion is

Fusion is a local Node.js command-line tool. It lets you talk with AI models about a repository, analyze it, and build
changes with them — without letting any model write to your working tree. Models run **read-only** in Fusion-owned copies
of your repository; a model's change is a *proposal* that Fusion validates and applies to a private candidate, verifies in a
Docker container, has reviewed by a different model, and turns into a **delivery**: the exact bytes, which you inspect,
approve by typing its digest, and apply. Fusion never commits, pushes or merges.

Roles are configuration, not code: a **Lead** (plans, adjudicates, chats), a **Change Author** (proposes changes; the
`Worker` role), a **Reviewer** (fresh review) and an **Explorer**. The defaults bind the Lead and the Change Author to the
Claude Code CLI and the Reviewer and Explorer to the Muse CLI; `fusion config` shows what is in effect.

## Architecture overview

```text
you ── fusion chat / analyze ──► Lead (read-only view of the repository) ──► answer (never recorded as evidence)

you ── fusion build "<task>" ──► plan: risk, roles, verification, exact files (proposed by the Lead) ──► you type "build"
        │
        ▼
   Lead plan ─► Change Author proposal (read-only view) ─► Fusion validates it and applies it to a PRIVATE candidate
        ─► confined verification (Docker, no network, read-only commands) ─► on failure: one fresh retry
        ─► fresh Reviewer (another model) ─► Lead adjudication ─► at most one correction, re-verified and re-reviewed
        ─► DELIVERY (manifest + exact bytes, stored outside the repository)

you ── fusion inspect-delivery / approve-delivery (type the digest) / apply ──► precheck ─► single-use claim ─► files written
                                                                               (rollback on failure; no commit)
```

More: [architecture overview](docs/architecture-overview.md), [security model](docs/security-model.md),
[host-controlled changes](docs/host-controlled-changes.md).

## v0.1 support matrix

| Area | v0.1 |
| --- | --- |
| Host OS | Windows 11 (primary, validated); the code is platform-aware, other hosts are untested |
| Fusion runtime | Node.js 22+ (created projects need Node.js 22.18+), Git |
| Chat, analyze | Any repository; read-only; default partner: the Lead (`conversation.partner` changes it) |
| Build | Repositories with a confined verification plan whose platform is `linux-compatible` or `platform-neutral` |
| Dependency lanes | `none`, `npm-lockfile` (dependencies installed from `package-lock.json` in a separate preparation container) |
| Verification | Docker, Linux containers, the pinned `node:22.20.0-bookworm-slim` image (see below) |
| Create | New Node.js + TypeScript projects: `library`, `cli`, `api`; no dependencies; `node:test` |
| Not supported | `windows-required` verification, other stacks for `create` (refused with the supported alternative), unattended Writer mode |

## Quickstart

```powershell
git clone <this repository> fusion-cli; cd fusion-cli
npm ci
npm run build
npm install --global .          # or: node dist/src/cli/main.js <command>
fusion --help
fusion doctor                   # runtime, repository, provider CLIs, readiness
fusion config                   # the effective roles, models, verifier profile and state locations
```

Then, in a repository:

```powershell
fusion chat                                  # talk about the repository (REPL; /help)
fusion analyze                               # Fusion's inventory + one model analysis
fusion build -- "Fix the rounding in src/price.ts and add a test."
fusion history                               # what ran, what it left behind, the next step
```

Or start a new project: `fusion create --template api -- "a REST API for todo lists"`.

## Commands

`fusion --help` lists everything; `fusion <command> --help` shows one command.

### chat

`fusion chat` opens a conversation about the repository (REPL); `fusion chat -- "<message>"` asks once. The partner runs
read-only in a Fusion-owned view of the repository: Fusion checks the repository is unchanged before and after every turn
and that the view is intact. `/ask <partner> <question>` gets a second opinion from another role; `/build` shows the plan of
a proposed task and starts it only when you confirm. The conversation is bounded (message, history and reply sizes), kept
in memory only, and never written to disk or into run evidence.

### analyze

`fusion analyze [<path>]` builds Fusion's own inventory of the repository (languages, manifests, scripts, tests, CI,
entry points; no provider), then asks one model for an analysis in a read-only view. `--deep` raises the bounds, never the
rights; `--focus <topic>` narrows it; `--inventory-only` runs no provider at all.

### build

`fusion build [--path <file>]... -- "<task>"` shows the plan — risk, roles, verification, and the **exact files** the build
may write — and starts only when you type `build` at an interactive terminal. Without `--path`, the Lead proposes the file
list in one read-only turn; Fusion checks it strictly (repository-relative files only, never `.git`, `.fusion`, lock files or
`.env`) and shows it to you. Before that turn, Fusion checks it can verify at all: without a confined plan, with an
unsupported platform or without a working verifier, the build is refused **before any model turn**.

The run: Lead plan → Change Author proposal → validated, host-applied to a private candidate → confined verification (one
fresh retry after a failure) → fresh review by another model → Lead adjudication → at most one correction (re-verified and
re-reviewed). A run that needs more stops at `DECISION_REQUIRED`. Your working tree is never touched. A passing build
prepares a **delivery**. Critical tasks (force-push, history rewrites, data destruction, production releases, …) stop at the
human gate. `--json` never asks, so a Writer build under `--json` stops at its gate.

A repository needs a confined verification plan in `fusion.config.json` to build, for example:

```json
{
  "schemaVersion": 1,
  "verification": {
    "commands": [],
    "platformRequirement": "linux-compatible",
    "dependencies": "none",
    "confinedCommands": [
      { "id": "unit", "executable": "/usr/local/bin/node", "args": ["--test", "test/**/*.test.ts"], "cwd": ".",
        "timeoutMs": 180000, "mutationPolicy": "readOnly" }
    ]
  }
}
```

The file must never hold secrets (credential-like keys are refused). With a configuration file, its `bindings` replace the
defaults: copy them from a project `fusion create` made, or leave the file out to use the defaults for chat and analyze.

### create

`fusion create [--template library|cli|api] [--name <dir>] -- "<description>"` plans a new Node.js + TypeScript project (the
family comes from `--template` or the description; services it names, such as PostgreSQL or Stripe, become configuration
placeholders — never credentials). After you type `create`, Fusion writes a deterministic template with its own tests and
confined verification plan and a Git baseline into a new directory (never inside an existing repository, never into a
non-empty directory), then runs the normal confirmed build there. Other stacks (Next.js, React, Python, Go, …) are refused
with the supported alternative; nothing is created.

### inspect, approve, apply

- `fusion inspect-delivery <id>` — read-only: digests, target checkout and baseline, every file with its diff, the
  verification and review evidence, the approval state.
- `fusion approve-delivery <id>` — you type the delivery's full manifest digest at an interactive terminal; nothing else
  approves (`--json` is refused). An approval covers exactly that manifest and that checkout.
- `fusion apply <id>` — a read-only precheck (clean tree, expected HEAD, every file as expected) runs first; a failed
  precheck changes nothing and keeps the approval. Then a **single-use claim** is taken and the files are written; a failure
  rolls every file back. The claim is never replayed: a retry needs a new delivery and a new approval. Fusion does not
  commit — review the change and commit it yourself.

Deliveries are stored outside the repository (`%LOCALAPPDATA%\Fusion\deliveries`, or `$XDG_STATE_HOME/fusion/deliveries`),
per repository and bound to the checkout they were prepared in; another checkout can neither inspect nor apply them.

### history, show, config, doctor, review, audit

- `fusion history [--limit <n>]` — recent runs (newest first) with your task, the outcome, the delivery and its state, and
  the next step. Read-only: an unfinished run is never resumed and no model turn is replayed.
- `fusion show <run-id>` — one run, including how many model turns its evidence records.
- `fusion config` — roles and models, the conversation partner, the verifier profile (and why Writer builds are
  unsupported when they are), and where run evidence and delivery state live.
- `fusion doctor [--probe]`, `fusion audit`, `fusion review` — diagnostics, a deterministic audit, a fresh read-only review
  of your working tree.

## Safety model

- **Models never write your files.** They run read-only in Fusion-owned views; Fusion validates each proposed change set
  (bounded, canonical paths inside the confirmed scope) and applies it only to private candidates.
- **Fusion verifies, not the model.** Only Fusion's confined verification counts; a model's "tests pass" is not evidence.
- **You confirm every Writer build** (typed `build`) and **approve every delivery** (typed manifest digest). There is no
  `--force`, `--yes`, variable or configuration that skips a confirmation, an approval, the checkout binding, the precheck
  or the single-use claim; the tests pin that.
- **Evidence holds no provider text.** Runs (`.fusion/runs`) record bounded, redacted metadata, your task (redacted), counts
  and digests — never model reasoning, rationales or credentials. Conversations are not recorded at all.
- **Nothing leaves your machine through Fusion's own actions:** no commit, push, merge, publish or release.

## Provider prerequisites

- **Claude Code CLI**, logged in with a subscription (or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`). API-key,
  gateway and alternate-provider sources are refused before any turn.
- **Muse CLI**, logged in.
- `fusion doctor` reports each CLI's version and which posture controls are validated for it; unvalidated or unknown
  posture fails closed. `fusion doctor --probe` may start the CLIs to read back authentication (never a model turn).

## Docker and the verifier

Writer builds need Docker with Linux containers and the pinned verification image. Fusion **never pulls**; pull it once:

```powershell
docker pull node@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e
```

Verification containers run without network (`--network none`), as an unprivileged user, with all capabilities dropped,
`no-new-privileges` and a read-only root filesystem, under Fusion-owned labels; only Fusion's read-only commands run in them.
With the `npm-lockfile` lane, a separate dependency-preparation container installs the locked packages first; that one has
network access (to reach the npm registry) and its result is handed to the verification container.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `Build not started: Confined verification is not available …` | Start Docker (Linux containers) and pull the image above; `fusion doctor` shows the verifier. No model turn was spent. |
| `No confined verification plan is configured` | Add `verification.confinedCommands` and `platformRequirement` (see [build](#build)); `fusion config` shows the plan. |
| `Not inside a Git working tree` | Run Fusion in a repository or pass `--cwd <dir>`. |
| `No configured provider can hold a conversation` | `fusion doctor`: log in to the provider CLIs; check `fusion config`. |
| `The proposed scope …` refused | The Lead proposed a path Fusion does not allow; rerun with `--path` for each file. |
| `DECISION_REQUIRED` | The run reached its bounds (one retry, one correction); refine the task and build again. |
| Apply: `precheck failed` | Your checkout changed (HEAD moved, files differ, untracked files); fix it — the approval is kept — then apply again. |
| Apply: `approval was spent` | That delivery was applied, rolled back or interrupted after its claim; build again for a new delivery. |
| `fusion history` says an attempt was interrupted before its claim | Nothing changed; that delivery stays locked — build again. |
| `WRITER_NOT_READY` in doctor | It concerns unattended Writer mode, which stays off; confirmed builds do not need it. |

Exit codes: 0 completed/answered/ready, 1 internal, 2 invalid input, 3 billing/auth, 4 security policy, 5 capability
unavailable, 6 provider failure, 7 timeout, 8 workspace conflict (including precheck failures and rollbacks), 9 verification
failed, 10 storage, 11 blocked, 12 review required, 13 decision required, 14 human gate required, 15 degraded (doctor), 130
cancelled.

## Known limitations

- The v0.1 commands have not yet been validated live against the real provider CLIs (see below); everything above is
  proven offline with scripted fakes and, for the Writer route and apply, by earlier live milestones.
- Verification needs Docker with Linux containers; `windows-required` projects cannot be built.
- A build writes only the exact files confirmed before it starts (at most 24 proposed by the Lead); it cannot discover new
  files mid-run.
- One verification retry and one correction per run; beyond that the run stops for a decision.
- `create` makes Node.js + TypeScript projects only, without dependencies (nothing is installed).
- Conversations are not saved; `fusion chat` starts fresh each time.
- An apply interrupted before its claim leaves that delivery locked; build again.
- Unattended Writer mode, network access for the verification commands themselves and automatic commits are out of scope.

## Live acceptance

The live check of v0.1 is run by a human from a normal terminal (never from inside an agent session), against disposable
targets only, with a turn ledger enforcing the budget:

```powershell
npm run build
node scripts/v01-live-acceptance.mjs --authorization FUSION-V0.1-FINISH-LIVE --scenario check   # no model turn
node scripts/v01-live-acceptance.mjs --authorization FUSION-V0.1-FINISH-LIVE --scenario chat
node scripts/v01-live-acceptance.mjs --authorization FUSION-V0.1-FINISH-LIVE --scenario analyze
node scripts/v01-live-acceptance.mjs --authorization FUSION-V0.1-FINISH-LIVE --scenario build
node scripts/v01-live-acceptance.mjs --authorization FUSION-V0.1-FINISH-LIVE --scenario create
node scripts/v01-live-acceptance.mjs --authorization FUSION-V0.1-FINISH-LIVE --scenario status
```

## Development

```powershell
npm ci
npm run typecheck
npm test                 # build + the deterministic suite (no provider, network or Docker)
npm run smoke:pack       # clean clone → pack → install into a private prefix → run the installed CLI (never publishes)
```

Source layout: `src/core` (provider-neutral domain, policy, workflow), `src/app` (commands and composition), `src/cli`
(argument parsing, rendering), `src/platform` (processes, workspaces, verification, delivery, evidence), `src/providers`
(the Claude and Muse adapters). Milestone design notes live in [docs/](docs/).

## Security

Do not report security issues in public issues. See [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

No open-source license has been granted at this stage. All rights are reserved unless stated otherwise.

---

Fusion CLI is an independent engineering project. Provider integrations do not imply affiliation with or endorsement by any
model or platform vendor.
