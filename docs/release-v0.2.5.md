# Fusion CLI v0.2.5 — release notes

**The conversational shell.** Run `fusion` in a project folder and say what you want in plain words. Fusion decides what
each line may do, keeps secrets out of every model's view, explores large projects as a team with an honest coverage
account, and turns "fix it" into the same verified, human-approved route as `fusion build`.

Released on GitHub as `v0.2.5`. Not published to a package registry; install from source.

## Highlights

- **`fusion` without a command** — a conversational shell over the current folder (interactive terminals): analyze,
  explain, plan, "fix the first one", "apply", history. English and German. Ctrl+C during a step cancels only that step.
- **Host-side intent routing** — every line is classified by Fusion itself, with no model involved, into a fixed grant.
  Talking, analysing and planning are read-only turns; only a change request can lead to a change, and only through the
  confirmed build route. Requests to skip safety steps are refused.
- **Team exploration of large projects** — the lead picks one to three areas as a strictly parsed plan (Fusion's own
  areas as the visible fallback), explorers investigate each area in isolation, the lead writes the synthesis and a fresh
  reviewer critiques it. A coverage block says what Fusion inventoried, shared, masked, withheld, assigned and cited — and
  that it cannot see which files a model opened.
- **Folders without Git** — `fusion`, `chat` and `analyze` work read-only in plain folders. Changes need a Git baseline.
- **Sensitive-input policy** — credentials, key material, authentication stores (Home Assistant `.storage/`), databases and
  binaries are withheld; `secrets.yaml` and `.env` keep key names only; secret values in other files are masked. The same
  policy covers every view of a build. A masked value inside an editable file is restored exactly by Fusion before the
  change is applied, verified and delivered; a build that would have to write a protected file stops before any model
  turn.
- **One-step approval in the shell** — after a build prepares a delivery, one summary and an explicit `[y/N]` approve and
  apply exactly that delivery, bound to the same manifest, bundle, repository, checkout and baseline as a typed-digest
  approval.
- **Claude patch updates** — a later 2.1.x patch is accepted once Fusion has attested its read-only posture with a
  mechanical canary (no model call); `fusion doctor --probe` reports it.
- **Safe failure detail** — a failed turn names its stage and a safe category with allowlisted fields only
  (`detail: …`), never provider text.

## Safety architecture

Unchanged at its core: models are untrusted proposal engines running read-only in Fusion-owned views; Fusion alone applies
change sets, only to private candidates and only within the confirmed scope; verification runs in a Docker container
without host mounts or network; deliveries are immutable and bound to the checkout; nothing is applied without your
explicit approval of that exact delivery. v0.2 adds the host-side grant table for conversational turns and the
sensitive-input policy for every provider view. Unattended Writer mode stays disabled. Details:
[security model](security-model.md).

## Installation

From source (the only channel for v0.2.5):

```powershell
git clone https://github.com/Tanerinki/fusion-cli.git
cd fusion-cli
git checkout v0.2.5
npm ci
npm pack
npm install --global .\fusion-cli-0.2.5.tgz
fusion --version
```

## Validation

- The deterministic offline suite (no provider, network or Docker daemon), including black-box acceptance of the shell
  through the built CLI on scripted fake provider binaries.
- A packaging smoke test: clean clone → pack → private install → run.
- A maintainer-run live validation on 2026-09-27 against the real provider CLIs on disposable targets — **Live A PASS**
  (folder without Git, sensitive input, bypass refusal), **Live B PASS** (team exploration of a large repository with a
  fresh critique and truthful coverage), **Live C PASS** (analyze → fix it → verified delivery → explicit approval →
  checkout-bound apply, with the inline secret preserved). Record: [v0.2 live validation](v0.2-live-validation.md).

## Known limitations

- The live evidence is real but bounded: a small number of runs per part on disposable targets. Live C's LOW-risk change
  ran no fresh review; the build's fresh-review path has separate live evidence from v0.1.
- Provider processes run under your user account. A provider view is a Fusion-owned read-only copy whose changes are
  detected, not an operating-system sandbox.
- Intent routing is deterministic keyword matching (English and German); an unrecognised line is treated as a question.
- On the current Muse runtime the dedicated explorer binding's read-only posture is not proven; the validated reviewer
  binding explores in separate contexts instead, and the terminal says so.
- Windows 11 is the only validated host; builds need Docker with Linux containers. Conversations are not saved between
  sessions (only safe per-project metadata is kept).
- Unattended Writer mode, network access for verification commands and automatic commits are out of scope.

See also: [README](../README.md) · [changelog](../CHANGELOG.md) · [roadmap](../ROADMAP.md).
