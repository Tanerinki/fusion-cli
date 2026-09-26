# Fusion CLI v0.1.0 — release notes

**Status: release-ready.** Not yet tagged, published to a package registry or released on GitHub.

Fusion CLI lets several AI coding models work on a Git repository while Fusion — not the models — applies, verifies and
delivers every change. Models plan, propose and review from read-only copies of the repository; Fusion validates their
proposals, applies them to private candidates, verifies them in a Docker container and packages the result as an immutable
delivery. Nothing reaches your checkout until you approve that delivery's exact bytes.

## Highlights

- **`fusion chat` / `fusion analyze`** — talk about and analyze a repository; strictly read-only.
- **`fusion build`** — plan, confirm, then Lead plan → Change Author proposal → confined verification → fresh review by a
  different model → Lead adjudication → delivery, with one retry and one correction at most.
- **`fusion create`** — new Node.js + TypeScript projects (`library`, `cli`, `api`) built through the same route.
- **Human-approved delivery** — `inspect-delivery`, `approve-delivery` (type the manifest digest), `apply` (precheck,
  single-use claim, rollback on failure; never commits).
- **`fusion history` / `fusion show`** — what ran, what it left behind, and the next step; decision requests shown with
  their questions.
- **`fusion config` / `fusion doctor`** — the effective setup and read-only diagnostics.

## Supported environment

| | |
| --- | --- |
| Host | Windows 11 (validated) |
| Runtime | Node.js ≥ 22, Git, npm |
| Verifier | Docker with Linux containers; pinned image `node@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e` (pull it once; Fusion never pulls) |
| Providers | Default bindings: Claude Code CLI (Lead, Change Author) and Muse CLI (Reviewer), logged in with subscriptions; configurable per role |
| `create` | Node.js 22.18+ with TypeScript type stripping and `node:test`; no dependencies |

## Safety architecture

Models are untrusted proposal engines running read-only in Fusion-owned views. Fusion alone applies change sets, only to
private candidates and only within the file scope you confirmed. Verification runs in a container without host mounts or
network. A different model reviews the verified result without seeing the author's reasoning. Deliveries are immutable,
stored outside the repository and bound to the repository, checkout and baseline; approval is a typed digest; `apply`
prechecks your checkout before writing and takes a single-use claim. No `--force`, no `--yes`, no automatic commit, push,
merge or release. Unattended Writer mode is not enabled. Details: [security model](security-model.md).

## Installation

From source (the only channel for v0.1.0):

```powershell
git clone https://github.com/Tanerinki/fusion-cli.git
cd fusion-cli
npm ci
npm pack
npm install --global .\fusion-cli-0.1.0.tgz
fusion --version
```

## Validation

- A deterministic offline suite, including an end-to-end acceptance through the real CLI, engine and provider adapters on
  scripted fake binaries.
- A packaging smoke test: clean clone → pack → private install → run.
- A human-run live acceptance on 2026-09-26 against the real provider CLIs on disposable targets: chat, analyze, build and
  create passed, including typed approval and the production apply (12 of 50 authorized model turns). Record:
  [v0.1 live acceptance](v0.1-live-acceptance.md).

## Known limitations

- Windows 11 is the only validated host; builds need Docker with Linux containers.
- A build changes only the files confirmed before it starts; `create` makes Node.js + TypeScript projects without
  dependencies.
- Apply rollback is journaled and verified per file, not a multi-file transaction; a process crash mid-apply needs manual
  recovery from the kept journal and backups.
- Conversations are not saved between sessions.
- Unattended Writer mode, network access for verification commands and automatic commits are out of scope.

See also: [README](../README.md) · [changelog](../CHANGELOG.md) · [roadmap](../ROADMAP.md).
