# Fusion CLI v0.5.0 — Autonomous Engineering Engine (release notes)

**Evidence-driven candidate selection. Models propose. Fusion verifies. Humans approve.**

When a change has something to compare, v0.5 can let several independent candidates propose it. No model picks the winner.
Fusion materializes every candidate in its own private workspace and holds all of them to one verification profile, frozen
before any result exists. It runs its own experiments to tell them apart, and selects only when its own evidence justifies
it; otherwise it says so. The selected change is revalidated freshly and goes through the unchanged v0.4 delivery and your
approval.

Released on GitHub as `v0.5.0`. Not published to a package registry; install from source.

## Highlights

- **Candidate tournaments.** For a fix, configuration fix or refactor with something to compare, `fusion build` runs 2
  independent candidates by default, at most 3. Something to compare means medium risk or above, security-sensitive work,
  competing explanations of a checked finding, or an earlier failed attempt at the same task.
  - Simple work, and a plain feature change, stays a single candidate unless you ask.
  - The plan shows the count, and your confirmation binds it.
  - `--candidates 1|2|3` sets the count yourself. `limits.maxCandidates` caps it for the repository; `1` keeps every
    build on the v0.4 route.
  - A model's advice can never raise the count.
- **Isolated candidates.** Each candidate is a run of the unchanged v0.4 engine, with:
  - its own strategy brief over one frozen task contract;
  - its own provider sessions, views and private candidate.

  Candidates never see each other's proposal, reasoning or result. At most 2 run at once. Independence is stated
  honestly: separate contexts of the configured Worker binding, never claimed as model diversity.
- **Frozen verification profile.** Before any candidate exists, Fusion records the profile's SHA-256 with the task contract
  and the evidence snapshot. The profile covers:
  - the configured confined checks;
  - what the unchanged baseline showed;
  - the reliability policy's proof obligations;
  - whether falsification is required;
  - the configured experiments.

  A candidate-specific addition can only add checks.
- **Verification mesh.** Every proof channel is a node bound to the candidate's exact revision, the SHA-256 of its manifest.
  Fusion's deterministic results enter the v0.4 evidence decision as more checks. A model's claim is no evidence. Evidence
  observed on one revision can never prove another.
- **Discriminating experiments, run by Fusion in confinement:**
  - **Preservation probes** (`verification.experiments`): a candidate must behave like the unchanged baseline, by exit code
    and output digest.
  - **Output probes:** an explicit exit code and output.
  - **Compare probes:** differences are shown, and eliminate no one.
  - **Property and bounded fuzz runs** of the repository's own harness, with deterministic seeds. A counterexample becomes
    a replayable reproducer, bounded and redacted.
  - **Fusion-owned mutations:** reverts of a candidate's own change. A mutation its checks do not detect is a recorded
    weakness.
  - Every experiment runs exactly once, in the same confined backend. A truncated output is never compared, and a timeout
    detects nothing.
- **Evidence-based selection, with no score.**
  - Candidates are eliminated for:
    - a failed obligation;
    - a contradiction by Fusion's experiments;
    - an incomplete profile;
    - a failed required falsification.
  - Among the verified candidates, one dominates another over host-observed dimensions only: undetected mutations, a new
    dependency, changed files, changed lines.
  - No vote, no model preference and no confidence percentage enters the selection.
- **Convergence and tie semantics.**
  - Candidates that made the identical change are one result, recorded as **CONVERGED**. The lowest candidate id
    represents that change; no candidate "beat" an identical one.
  - Materially different verified candidates that neither dominates are a **tie** (`MULTIPLE_VERIFIED_CANDIDATES`), a
    decision for you. At an interactive terminal you choose by exact candidate id; with `--json` the tie is the outcome.
- **Fresh winner revalidation.** The selected candidate is reconstructed in a fresh candidate, exactly once. Its tree must
  be identical to the judged one, and the common checks must pass again. A mismatch is `REVALIDATION_MISMATCH`: nothing is
  delivered, and it is not retried.
- **Exact delivery binding.** Only the selected, revalidated change reaches the unchanged v0.4 delivery, whose manifest's
  ChangeSet is exactly the one the selected candidate's manifest binds. Your approval and the checkout-bound apply are
  unchanged.
- **Explicit, auditable records.**
  - Every tournament event is bound to its tournament, candidate and revision by a strictly validated scope.
  - The decision binds the selected candidate, its revision and its revalidation's evidence decision.
  - `fusion show` resolves a tournament only through that binding, never through event order.
- **Fail-closed outcomes.** Each outcome has its own state and exit code:
  - `NO_VERIFIED_CANDIDATE`
  - `MULTIPLE_VERIFIED_CANDIDATES`
  - `DISCRIMINATOR_INCONCLUSIVE`
  - `TOURNAMENT_BUDGET_EXHAUSTED`
  - `CANDIDATE_SECURITY_VIOLATION`
  - `VERIFICATION_PROFILE_FAILED`
  - `FALSIFICATION_REQUIRED_FAILED`
  - `REVALIDATION_MISMATCH`
  - `PROVIDER_FAILURE`
  - `CANDIDATE_MATERIALIZATION_FAILED`
  - `DECISION_REQUESTED`
  - `HUMAN_GATE_REQUIRED`
  - `CANCELLED`

  A candidate that asks you a question stops the whole tournament.
- **Privacy-safe offline routing calibration.**
  - Every Writer build records its route decision as labels and counts only.
  - `scripts/v05-routing-calibration.mjs` compares versioned routing policies against past runs, read-only. It gives
    estimates only where enough tournaments were observed.
  - Nothing learns online, and the routing never changes itself.

## Safety architecture

Unchanged at its core:
- models are untrusted proposal engines, running read-only in Fusion-owned views;
- Fusion alone applies change sets, only to private candidates and only within the confirmed scope;
- verification runs in a Docker container without host mounts or network;
- deliveries are immutable and bound to the checkout, the base commit and their evidence;
- nothing is applied without your explicit approval of that exact delivery;
- Fusion never commits, pushes or merges.

A candidate gains no authority by being a candidate. It cannot:
- modify the primary checkout;
- change its count;
- weaken the profile;
- waive an obligation;
- select itself;
- judge another candidate;
- approve a delivery.

Security tests 1–15 cover these; see the [v0.5 invariant matrix](v0.5-invariant-matrix.md).

## Installation

From source (the only channel for v0.5.0):

```powershell
git clone https://github.com/Tanerinki/fusion-cli.git
cd fusion-cli
git checkout v0.5.0
npm ci
npm pack
npm install --global .\fusion-cli-0.5.0.tgz
fusion --version
```

## Validation

- **Offline suite:** deterministic, with no provider, network or Docker daemon. It includes:
  - black-box scenarios A–L plus convergence, through `fusion build` on a real Git repository with scripted providers.
    None of them needs a real model to make a mistake.
  - security tests 1–15;
  - the verification-mesh tests, including deterministic results whatever order concurrent candidates finish in;
  - the [invariant matrix](v0.5-invariant-matrix.md), which a test keeps true: every quoted test title exists, and nothing
    is MISSING or PARTIAL.
- **Packaging smoke test:** clean clone → pack → private install → run.
- **Live acceptance:** run by the maintainer on 2026-09-29 against the real provider CLIs on disposable targets.
  - The first run failed L2, L3 and L5 by the runner's design. Its scenario relied on the routing policy, which correctly
    kept that fixture's low-risk single-file fix single. The runner was corrected to ask for 2 candidates explicitly.
  - The second run passed **L1–L6**:
    - a simple change stayed single-path;
    - an explicitly authorized tournament ran exactly 2 candidates, with one frozen profile and snapshot, separate
      contexts and the primary checkout unchanged;
    - both candidates were materialized and faced the same checks and experiments;
    - Fusion's preservation probe separated two known fixture candidates in the real confined backend, with no model
      involved;
    - c1 and c2 independently converged on the identical change. It was verified, its representative was revalidated
      freshly, and the outcome was `DELIVERY_ELIGIBLE`;
    - the delivered tree was exactly the selected candidate's. Your approval and the apply followed; only
      `configuration.yaml` changed, the protected files stayed byte-identical, and no commit, redaction marker or
      sentinel appeared.

## Known limitations

- **Independence.** It means separate contexts of the configured Worker binding. Fusion does not claim model diversity, and
  correlated model errors are possible; they cannot decide a selection, because only Fusion's evidence does.
- **Protected paths.** A file under `protection.ignoredPaths` is not refused when the build is planned. A candidate that
  changes it is BLOCKED by its evidence and is never delivered.
- **Engine reuse.** Each candidate reuses the v0.4 engine, including its own baseline reproduction. A reproduction that
  disagrees with the frozen baseline is treated as a non-deterministic baseline.
- **Cost control.** It happens when the route is chosen; there is no early stop mid-tournament yet.
- **Cleanup.** An unproven cleanup is reported but does not block a delivery, as in v0.4.
- **Experiments.** Only repository-configured experiments and Fusion's own mutations run. Mutations are bounded (at most 3
  per candidate), and test files, created files, deletions and large files are not mutated.
- **Log compatibility.** The v0.4 CLI refuses a v0.5 tournament log, which carries a new strict scope field, rather than
  misreading it.
- **Providers and processes.**
  - Provider turns can fail. Fusion handles them within bounded policies and makes **no claim of zero-error autonomy**.
  - Provider processes run under your user account. A provider view is a Fusion-owned copy whose changes are detected,
    **not an operating-system sandbox**.
- **Not yet supported:**
  - no durable crash/resume transactions;
  - no online or self-modifying routing;
  - no automatic commit, push or merge by Fusion;
  - no npm publication (the package is private).
- **Muse Explorer.** The dedicated Muse Explorer binding is still not validated; the validated Reviewer binding explores
  meanwhile.
- **Host.** Windows 11 is the only validated host, and builds need Docker with Linux containers.
- **Live evidence.** It is real but bounded: one passing run per part, on disposable targets.

See also: [README](../README.md) · [changelog](../CHANGELOG.md) · [roadmap](../ROADMAP.md) ·
[v0.5 design](v0.5-autonomous-engineering.md) · [v0.5 invariant matrix](v0.5-invariant-matrix.md).
