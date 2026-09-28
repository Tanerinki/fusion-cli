# Fusion CLI Roadmap

No dates are promised. Items below "Next" are candidates, not commitments.

## v0.1 — completed

v0.1.0 is code complete and [live-validated](docs/v0.1-live-acceptance.md) for its supported scope (Windows 11 host,
Docker/Linux-container verification, Node.js + TypeScript `create`).

**What v0.1 proves**

- Several model CLIs can do real engineering work on a repository **without writing to it**: a Lead plans, a Change
  Author proposes, a different model reviews — all read-only, in Fusion-owned views.
- Fusion can own the whole mutation path: validated change sets, private candidates, confined Docker verification, fresh
  review, adjudication and bounded correction, ending in an immutable delivery.
- A human approval boundary that is exact and single-use — typed manifest digest, checkout binding, precheck, one claim,
  verified rollback — is practical in everyday use.
- The same route builds new projects (`fusion create`) and changes existing ones (`fusion build`), and refuses honestly
  whenever it cannot verify.

**What shipped:** `chat`, `analyze`, `build`, `create`, `inspect-delivery`, `approve-delivery`, `apply`, `history`, `show`,
`config`, `doctor`, `review`, `audit`; an offline acceptance suite; a packaging smoke test. See the
[changelog](CHANGELOG.md) and the [release notes](docs/release-v0.1.0.md).

## v0.2 — completed

v0.2.5 is [live-validated](docs/v0.2-live-validation.md) (Live A, B and C passed on 2026-09-27) and released on GitHub.

**What v0.2 proves**

- A conversational shell can take plain-language requests while the **host**, not a model, decides what each line may
  do: read-only turns stay read-only, and only a confirmed change request reaches the verified build route.
- Secrets can stay out of every model's view — conversations and builds alike — while a build still preserves an inline
  secret it never showed to a model.
- A broad analysis of a large project can be split into a lead plan, isolated explorer investigations, a synthesis and a
  fresh critique, with a coverage account that claims only what Fusion assigned and what the answer cited.
- Folders without Git can be analysed safely and are never changed.

**What shipped:** `fusion` (the shell), host-side intent routing, team exploration with coverage, folders without Git,
the sensitive-input policy for conversations and builds, one-step approval in the shell, capability-based Claude patch
compatibility, safe failure detail. See the [changelog](CHANGELOG.md) and the [release notes](docs/release-v0.2.5.md).

## v0.3 — completed: adaptive multi-agent orchestration

v0.3.0 passed its live acceptance (L1–L4 on 2026-09-28) and is released on GitHub.

**What v0.3 proves**

- **One fixed pipeline is not needed.** During a read-only task Fusion gathers evidence from independent, bounded
  investigations (in parallel, each in its own view copy and fresh session), compares it, and escalates or stops under
  host-enforced budgets. Control returns to the lead without giving any model more authority.
- **A model can propose the route while the host authorizes every step.** A refused decision falls back to Fusion's own
  bounded choice, and a transient failure is repeated once, visibly.
- **A finding keeps its identity across a conversation.** "is it really a problem?" → "fix it" changes exactly the
  verified finding, with its evidence, in an exact narrow scope, through the unchanged verified and human-approved route.

**What shipped:**
- adaptive routing: lead decisions, parallel investigations, bounded repeats, synthesis and a fresh review;
- route observability and safe provider failure detail;
- finding selection and the verified-finding handoff;
- the live acceptance runner;
- Muse 1.4.0-R4302.1 validated for the Reviewer binding.

See the [changelog](CHANGELOG.md), the [release notes](docs/release-v0.3.0.md) and
[v0.3 adaptive orchestration](docs/v0.3-adaptive-orchestration.md).

Not done: a validated dedicated Muse Explorer binding. The validated Reviewer binding explores meanwhile.

## v0.4 — completed: the reliability engine

v0.4.0 passed its live acceptance (L1–L5 on 2026-09-28, the fourth run that day) and is released on GitHub. The goal was
not more agents: it was making
**silently-wrong success much harder**. Fusion separates what a model claimed from what Fusion observed, derives every
claim's status from its own deterministic evidence, requires typed proof obligations before it calls a change verified or
prepares it for delivery, isolates independent hypotheses before comparing them, runs discriminating checks itself, and asks a
fresh falsifier to break the conclusion. It prefers an honest UNVERIFIED to a confident, unsupported success.

**What shipped** (PRs #20–#30):
- the evidence graph and proof obligations;
- baseline reproduction and the evidence decision before any delivery;
- claim checks with isolated hypotheses and Fusion-run checks;
- the falsifier, with its report schema as a native decoding constraint;
- the diagnosis → fix handoff and reliability metrics;
- causal fatal-failure precedence;
- black-box acceptance and the live runner.

See the [changelog](CHANGELOG.md), the [release notes](docs/release-v0.4.0.md) and
[v0.4 reliability engine](docs/v0.4-reliability-engine.md) (design, acceptance, invariant matrix, limits).

Not done: a validated dedicated Muse Explorer binding; the validated Reviewer binding explores and falsifies meanwhile.

## v0.5 — in development: evidence-driven candidate selection

Not released; the package stays at 0.4.0 until the v0.5 live acceptance passes. Models may propose competing solutions, but
no model picks the winner. Fusion materializes each candidate in its own workspace and holds them all to one verification
profile, frozen before any result. It runs its own experiments to tell them apart, selects by host-observed evidence or
reports a tie, and revalidates the winner fresh before the unchanged v0.4 delivery and your approval.

Design and progress: [v0.5 evidence-driven candidate selection](docs/v0.5-autonomous-engineering.md).

## Next — candidates after v0.4

- **Recovery.** Resume a delivery whose apply attempt was interrupted before its claim (today it stays locked), and guided
  recovery from a process crash mid-apply using the kept journal and backups.
- **Setup.** `fusion config --init` for existing repositories (bindings plus a confined verification plan), and clearer
  first-run guidance.
- **Reach.** Validate other host platforms; broaden `create` families; more dependency lanes (for example pnpm) under the
  same restrictions.
- **Verification.** A confined backend for projects that must be verified on Windows.
- **Distribution.** Decide on a package registry release (v0.1 installs from source).
- **Providers.** More adapters behind the same provider-neutral contracts and posture checks.
- **Insight.** Richer run inspection, local metrics, optional saved conversations with explicit consent.

## Deferred — unattended Writer mode (O6)

Running Writer builds without the human approval boundary is a separate capability, not an extension of v0.1. It stays
disabled (`REAL_WRITER_MODE_READINESS` NO, `REAL_WRITER_LIVE_GATE_AUTHORIZED` NO) until, at least:

- primary-checkout and ignored-path protection are complete rather than bounded;
- shared Git state and dependency handling no longer rely on human review;
- verification isolation holds for every supported platform;
- a separately reviewed safety model defines who approves what, and live evidence supports it.

## Engineering history

v0.1 was built in milestones, recorded in [docs/](docs/): the foundation and runtime hardening (M1–M7); workspaces and
deterministic verification (O1); task inspection and risk (O2); the provider-neutral workflow engine (O3, O3.1); fresh
review and adjudication (O4); the CLI and control plane (O5); real read-only review (O5.5A); the host-controlled Writer
route with confined Docker verification and its live proofs (O5.5B); the delivery store, human approval and production
apply policy (O5.5C); and the v0.1 product surface.
