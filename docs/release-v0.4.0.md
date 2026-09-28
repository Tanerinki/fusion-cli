# Fusion CLI v0.4.0 — release notes

**The reliability engine. Models propose. Fusion verifies. Humans approve.** v0.4 adds no agents and no authority. It
makes silently-wrong success much harder. Fusion separates what a model *claimed* from what Fusion *observed*. A claim's
status comes from Fusion's own deterministic evidence, and typed proof obligations stand between a change and its
delivery. Independent hypotheses are isolated before they are compared, Fusion runs the discriminating checks itself, and a
fresh falsifier tries to break the conclusion. Fusion prefers an honest UNVERIFIED to a confident, unsupported success.

Released on GitHub as `v0.4.0`. Not published to a package registry; install from source.

## Highlights

- **Evidence Graph** — claims and evidence, each piece with a source and an authority. The status rule:
  - one fresh deterministic contradiction makes a claim CONTRADICTED;
  - otherwise deterministic support makes it SUPPORTED;
  - evidence from an older checkout is STALE;
  - everything else is UNVERIFIED.

  Models, citations and approvals are counted but never decide. A claim with many agreeing models and no Fusion evidence
  stays UNVERIFIED.
- **Proof Obligations** — typed and evaluated from host facts only: verification, scope, protected files, fresh
  review/falsification, reproduced defect, defect resolved, root cause, alternatives, behaviour preserved.
  - The decision is VERIFIED, UNVERIFIED or BLOCKED; UNKNOWN never becomes PASS.
  - A model saying "tests pass" is not evidence.
- **Baseline reproduction** — fix and refactor builds first run Fusion's confined checks on the unchanged baseline. A
  defect is "reproduced" only when a check fails before the change, and "resolved" only when the same check passes after
  it.
- **Fail-closed delivery gating** — the evidence decision is recorded in the run evidence before any delivery exists. A
  delivery is prepared only when the decision permits one, and its manifest binds that evidence, so your approval covers
  exactly it.
- **Isolated hypotheses** — checking a claim or diagnosing a failure starts from one immutable evidence snapshot (its
  SHA-256 shown). Two independent investigators get it in parallel, each in its own view copy and session, and neither sees
  the other's conclusion. They are compared only afterwards.
- **Fusion-owned discriminating checks** — "file X contains / lacks this exact text", proposed by the investigators or
  derived from the claim's own words. Fusion runs them itself, on the masked shared copy, never as a secret oracle.
- **Fresh falsification** — a read-only reviewer in a fresh context, given only Fusion's facts. It tries to break the
  conclusion; its checks run under Fusion, and its counterexamples and missing-evidence objections stay open, untrusted
  challenges. A build requires one only where the policy says so: a sensitive task, or a fix at medium risk or above. A
  required falsification that fails is never VERIFIED or delivered.
- **Evidence-derived decisions and false-consensus resistance** — model agreement cannot outvote Fusion's evidence. Two
  investigators who agree on a false claim are overruled by Fusion's own check. A passing build never promotes a
  conversational claim it did not itself establish.
- **Improved structured-output enforcement** — the falsifier's report schema is sent as a native decoding constraint
  (Muse Exec's strict `--output-schema`, the mechanism of its validated structured turns). Fusion still reads every reply
  strictly: prose around the JSON, malformed or schema-violating JSON is refused and becomes no evidence.
- **Causal fatal-error precedence** — when parallel work stops, a security violation outranks any other fatal failure,
  which outranks a cancellation. A sibling's cancellation never hides the security violation that caused it, and a
  security violation is never re-labelled as a time-out.
- **Observability** — the terminal shows each route and claim check (snapshot, hypotheses, Fusion's checks,
  falsification) and each build's evidence block and decision. A failed Muse turn gets a safe, bounded detail (reason
  class, Muse's own code, step limit, sizes, exit code, protocol labels), never provider text.

## Safety architecture

Unchanged at its core:
- models are untrusted proposal engines, running read-only in Fusion-owned views;
- Fusion alone applies change sets, only to private candidates and only within the confirmed scope;
- verification runs in a Docker container without host mounts or network;
- deliveries are immutable and bound to the checkout, the base commit and their evidence;
- nothing is applied without your explicit approval of that exact delivery;
- Fusion never commits, pushes or merges.

v0.4 gives no model more authority, a wider view, a write, a network path or a larger budget. The falsifier is read-only.
Provider posture is validated exactly at runtime; there is no API-key or pay-as-you-go fallback. Details:
[security model](security-model.md) and [v0.4 reliability engine](v0.4-reliability-engine.md#security-invariants-unchanged-and-re-tested).

## Installation

From source (the only channel for v0.4.0):

```powershell
git clone https://github.com/Tanerinki/fusion-cli.git
cd fusion-cli
git checkout v0.4.0
npm ci
npm pack
npm install --global .\fusion-cli-0.4.0.tgz
fusion --version
```

## Validation

- **Offline suite:** deterministic, with no provider, network or Docker daemon. It includes:
  - invariant tests for the specification's reliability invariants 1–20 (the matrix is in
    [v0.4 reliability engine](v0.4-reliability-engine.md#invariant-matrix-the-specifications-tests-120));
  - black-box scenarios A–H through the built CLI on scripted fake provider binaries (simple success, hard debug, false
    consensus, falsifier catch, unverifiable, verified mutation, the live runner's own lines, the live failure shapes);
  - races forced by event-loop order, never wall-clock timing.
- **Packaging smoke test:** clean clone → pack → private install → run.
- **Live acceptance:** run by the maintainer on 2026-09-28 against the real provider CLIs on disposable targets.
  - Three earlier runs that day failed a part (L2, then L4, then L4 and L5). Each was diagnosed and fixed before the next
    run.
  - The fourth run passed **L1–L5**:
    - a simple question stayed one lead turn;
    - a diagnosis ran one snapshot through two isolated hypotheses and Fusion's checks, and a fresh falsification whose
      structured report arrived through the native schema, with its missing-evidence objection kept open;
    - the user's false claim ended CONTRADICTED by two Fusion checks after two real investigator turns;
    - analysis → claim check → *fix it* built, verified in Docker, and passed 5 of 5 obligations. Your approval and the
      checkout-bound apply followed, changing only `configuration.yaml`, with protected files byte-identical, no commit and
      no sentinel seen.

  Record: [v0.4 reliability engine → acceptance](v0.4-reliability-engine.md#acceptance).

## Known limitations

- The dedicated Muse Explorer binding is still **not validated**. The validated Reviewer binding explores and falsifies,
  in separate contexts.
- Independence is of context, not of model: both investigators and the falsifier may be the same validated Reviewer
  binding and model. Correlated model errors are possible; they cannot decide a status, because only Fusion's checks do.
- Fusion's own file experiments are intentionally narrow: literal text in one shared file, derived only from unambiguous
  claims (one named file, quoted literals, no negation).
- Not every task is reproducible. The reproduction reuses the configured confined checks, and a defect they cannot see
  stays *not reproduced* (UNKNOWN), honestly.
- Provider turns can fail, including replies outside Fusion's structure. Fusion handles them within its bounded policy
  (one repeat for a hypothesis, one falsification) and makes **no claim of zero-error autonomy**.
- No automatic commit, push or merge by Fusion. No npm publication.
- Provider processes run under your user account. A provider view is a Fusion-owned read-only copy whose changes are
  detected, **not an operating-system sandbox**.
- No parallel autonomous writers and no candidate tournaments: one Change Author proposes, and Fusion applies.
- Windows 11 is the only validated host; builds need Docker with Linux containers.
- The live evidence is real but bounded: one passing run per part, on disposable targets.

See also: [README](../README.md) · [changelog](../CHANGELOG.md) · [roadmap](../ROADMAP.md) ·
[v0.4 reliability engine](v0.4-reliability-engine.md).
