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

## Next — candidates for v0.2

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
