# Fusion CLI v0.3.0 — release notes

**Adaptive multi-agent orchestration.** Fusion no longer runs one fixed pipeline for a read-only task. The lead proposes
each next step, and Fusion authorizes it within host-enforced budgets. Bounded investigations run in parallel, in
independent contexts. The lead reclaims the task, and a different model reviews it fresh. A finding keeps its identity
across the conversation, so "is it really a problem?" → "fix it" changes exactly that verified finding, through the same
verified, human-approved route as before.

Released on GitHub as `v0.3.0`. Not published to a package registry; install from source.

## Highlights

- **Adaptive routing** — each line is classified by Fusion (a single answer, a team route, or the verification of one
  finding). The lead's routing decision (answer, delegate, synthesize, stop) is one strict JSON object that Fusion
  authorizes or refuses, with its own bounded fallback.
- **Bounded parallel investigation** — up to three at once, each in its own read-only view copy and fresh session, with
  only its packet. Budgets cap concurrency, batches, repeats, turns and time.
- **Bounded recovery** — a transient investigation failure is repeated once. One that still fails is reported with its
  category, and the evidence is marked incomplete.
- **Lead synthesis and a fresh cross-model review** of every delegated analysis.
- **Reviewer-as-explorer** — while the dedicated Muse Explorer binding is unvalidated, the validated Reviewer binding
  explores, and the terminal says so.
- **Observability** — `Route:` and `Turns:` lines, planning, each investigation's state and every failed attempt. Muse
  failures carry safe detail: reason class, reason length, protocol event counts, step limit, prompt size and exit code,
  never provider text.
- **Finding identity** — findings are the answer's own `Findings:` list. A finding is selected by position, pronoun or
  its distinctive terms, and an ambiguous or unknown reference is asked about, never guessed.
- **Verified-finding handoff** — "fix it" is the active verified finding. The task carries the files its verification
  cited, and the lead proposes an exact, narrow scope that you confirm.
- **Muse 1.4.0-R4302.1** is validated for the Reviewer binding only, on its exact binary.

## Safety architecture

Unchanged at its core:
- models are untrusted proposal engines running read-only in Fusion-owned views;
- Fusion alone applies change sets, only to private candidates and only within the confirmed scope;
- verification runs in a Docker container without host mounts or network;
- deliveries are immutable and bound to the checkout;
- nothing is applied without your explicit approval of that exact delivery.

v0.3 adds no authority for any model: a routing decision cannot widen a view, add a partner, raise a budget or start a
change. Fusion never commits, pushes or merges, and unattended Writer mode stays disabled. Details:
[security model](security-model.md).

## Installation

From source (the only channel for v0.3.0):

```powershell
git clone https://github.com/Tanerinki/fusion-cli.git
cd fusion-cli
git checkout v0.3.0
npm ci
npm pack
npm install --global .\fusion-cli-0.3.0.tgz
fusion --version
```

## Validation

- **Offline suite:** deterministic (no provider, network or Docker daemon), including black-box acceptance through the
  built CLI on scripted fake provider binaries. Its parallel processes are proven concurrent.
- **Packaging smoke test:** clean clone → pack → private install → run.
- **Live acceptance:** run by the maintainer on 2026-09-28 against the real provider CLIs on disposable targets, with
  **L1–L4 PASS**:
  - a simple task stayed one lead turn;
  - a broad analysis ran three parallel investigations, one of which recovered after its bounded repeat, then a
    synthesis and a fresh review;
  - one finding was verified;
  - analysis → verification → "fix it" went through Docker verification, your approval and the checkout-bound apply,
    changing only `configuration.yaml`, with no sentinel seen.

  Record: [v0.3 adaptive orchestration](v0.3-adaptive-orchestration.md#live-acceptance-maintainer-real-providers).

## Known limitations

- The dedicated Muse Explorer binding is not validated. The validated Reviewer binding is the exploration transport.
- Provider turns can fail. Fusion handles them only within its bounded policy (one repeat, then incomplete evidence) and
  makes no claim of error-free autonomy.
- The live evidence is real but bounded: one passing run per part, on disposable targets.
- Intent routing and finding selection are deterministic matching (English and German).
- Provider processes run under your user account. A provider view is a Fusion-owned read-only copy whose changes are
  detected, not an operating-system sandbox.
- Windows 11 is the only validated host; builds need Docker with Linux containers.
- Unattended Writer mode, network access for verification commands and automatic Git operations are out of scope. Not
  published to npm.

See also: [README](../README.md) · [changelog](../CHANGELOG.md) · [roadmap](../ROADMAP.md).
