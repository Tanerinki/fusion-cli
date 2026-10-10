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

## v0.5 — completed: evidence-driven candidate selection

v0.5.0 passed its live acceptance (L1–L6 on 2026-09-29) and is released on GitHub. Models may propose competing solutions, but
no model picks the winner. Fusion materializes each candidate in its own workspace and holds them all to one verification
profile, frozen before any result. It runs its own experiments to tell them apart, selects by host-observed evidence or
reports a tie, and revalidates the winner fresh before the unchanged v0.4 delivery and your approval.

**What shipped** (PRs #32–#40): candidate tournaments with a host-owned routing policy and budget, isolated candidates, a
frozen verification profile, the verification mesh, Fusion-owned experiments (probes, property, bounded fuzz, mutations),
evidence-based selection with explicit convergence and tie semantics, fresh winner revalidation, exact delivery binding,
explicit candidate binding in the run records, privacy-safe offline routing calibration, the deterministic acceptance
(A–L), the security tests (1–15), the [invariant matrix](docs/v0.5-invariant-matrix.md) and the live runner.

See the [changelog](CHANGELOG.md), the [release notes](docs/release-v0.5.0.md) and
[v0.5 evidence-driven candidate selection](docs/v0.5-autonomous-engineering.md).

## v0.6 — completed: hard isolation and resilience

v0.6.0 is the release prepared from this work (GitHub tag `v0.6.0`; install from source). Evidence:
[O6 closeout](docs/v0.6-o6-phase2-closeout.md) and the [release notes](docs/release-v0.6.0.md).

**What v0.6 proves**
- **Fusion's work survives a crash.**
  - Runs keep a durable, hash-chained journal.
  - An apply interrupted while writing is recovered exactly once, and a foreign edit is never overwritten (proven across
    real process boundaries).
- **Isolation is claimed only where it is mechanically proven,** for the same identity:
  - An AppContainer sandbox: canary-proven filesystem, process-tree, environment and network denial.
  - A Hyper-V isolated worker, proven live with committed audits: a broker-only network boundary, writer filesystem
    isolation, and isolated verification of untrusted output.
- **The attended Writer workflow holds on real providers.**
  - A LOW build reached an applied delivery on a disposable repository.
  - A MEDIUM multi-model build reached a prepared delivery with real Lead, Worker and fresh Reviewer turns.
  - Every step was host-controlled and human-approved.

**What shipped** (PRs #42–#70):
- durable run journal, checkpoints and replay; apply recovery; run lease;
- persisted candidate results and human gates;
- the AppContainer sandbox backend with its native launcher, and `fusion sandbox doctor|install|uninstall`;
- provider-sandbox plumbing and the provider network broker (not yet the execution path);
- the Hyper-V worker harness and its live proofs;
- a production Windows Hyper-V verification backend;
- byte-stable checkouts; owned process-tree cleanup; stricter Claude startup checks;
- Worker proposal readiness separated from the Writer gate.

Not done:
- a Windows verification-isolation acceptance authority;
- the finding → adjudication → correction → re-review route observed end to end in one production build;
- a real provider turn inside the hard sandbox (Gate #2): broker-only loopback is not proven on Windows;
- unattended Writer mode, below.

## Next — candidates after v0.6

- **Recovery.** Resume a delivery whose apply attempt was interrupted before its claim (today it stays locked), and a
  command that resumes an interrupted build from its durable journal.
- **Hard isolation.** A real provider turn inside isolation (Gate #2), on a network model that can prove broker-only
  egress.
- **Setup.** `fusion config --init` for existing repositories (bindings plus a confined verification plan), and clearer
  first-run guidance.
- **Reach.** Validate other host platforms; broaden `create` families; more dependency lanes (for example pnpm) under the
  same restrictions.
- **Verification.** Windows-required verification: the confined Hyper-V backend exists and is registered (v0.6). What
  is still missing is an acceptance authority that would let a windows-required autonomous build use it.
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

Status at v0.6.0: still **BLOCKED**. `REAL_WRITER_LIVE_GATE_AUTHORIZED` is `false` in code and no configuration or
environment can open it. Windows verification isolation is proven as a capability, but Fusion has no Windows acceptance
authority yet. The v0.6 live evidence is all **attended**: a human confirmed each build and exactly approved each apply.
Attended evidence does not authorize unattended Writer mode.

## Engineering history

v0.1 was built in milestones, recorded in [docs/](docs/): the foundation and runtime hardening (M1–M7); workspaces and
deterministic verification (O1); task inspection and risk (O2); the provider-neutral workflow engine (O3, O3.1); fresh
review and adjudication (O4); the CLI and control plane (O5); real read-only review (O5.5A); the host-controlled Writer
route with confined Docker verification and its live proofs (O5.5B); the delivery store, human approval and production
apply policy (O5.5C); and the v0.1 product surface.
