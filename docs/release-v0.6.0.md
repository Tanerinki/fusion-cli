# Fusion CLI v0.6.0 — Hard Isolation and Resilience (release notes)

**Durable, recoverable runs and mechanically proven isolation building blocks. Models propose. Fusion verifies. Humans
approve.**

v0.6 makes Fusion's work survive a crash, and it builds and proves the isolation pieces that untrusted execution needs
on Windows. The attended Writer workflow keeps its shape and is hardened: a build you confirm, a private candidate,
confined verification, a fresh review, a delivery, your exact approval and a guarded apply. For the first time it is
backed by recorded live production evidence. Unattended Writer mode stays off.

GitHub release tag: `v0.6.0`. Not published to a package registry; install from source.

## Highlights

### Durable runs and apply recovery

- **Durable run journal.** `fusion build` and `fusion review` keep an append-only, hash-chained, fsync'd journal with
  single-writer ownership under `.fusion/durable/<runId>`. A killed run reads back as interrupted, never as completed,
  and a tampered or torn journal is detected.
- **`fusion apply` recovers an interrupted apply.** An apply is a journaled, per-file transaction. If the process dies
  while writing (after its single-use claim and its recorded start), running `fusion apply <id>` again recovers that
  same claimed apply exactly once:
  - it re-checks the approval and the checkout;
  - it finishes the remaining files and never writes a file twice;
  - a file someone else changed in the meantime is detected and never overwritten.

  An apply interrupted before it started writing stays fail-closed: the delivery is locked or its approval spent, and
  you build again.
- **No two writers.** A run lease refuses a second concurrent `fusion apply` of the same delivery
  ("already claimed by another writer; nothing was changed"). Only a dead owner's stale lease can be taken over.
- **Resume groundwork.** Tournament candidate results and pending human gates are persisted and re-presented exactly
  across a restart. No command resumes an interrupted build automatically yet.

### Windows hard-isolation groundwork

- **AppContainer sandbox backend.**
  - A native launcher (`native/fusion-sandbox`) runs a target in a no-capability AppContainer with explicit grants
    and a kill-on-close Job.
  - Its environment is minimized; credential-shaped variables are dropped, by name only.
  - Real-OS canaries proved denial of ungranted files, siblings, the registry and network; process-tree containment;
    isolation between two concurrent sandboxes; and that an ungranted credential sentinel never reaches the output.
- **`fusion sandbox doctor | install | uninstall`** (new command).
  - `doctor` reports the posture that canaries mechanically proved, separately for each property.
  - `install` / `uninstall` build an idempotent network-provisioning plan scoped to the sandbox's package SID. The
    single elevated step is shown for you to run; Fusion never elevates itself.
- **Provider execution plumbing.** These pieces exist and are tested, and all fail closed:
  - routing a process through the launcher;
  - a host-side, per-run provider network broker;
  - provider transports wired for HARD posture;
  - one authoritative HARD-run assembler.
- **Honest loopback limit.** To reach the broker, a sandbox needs a loopback exemption. On Windows that exemption is per
  package with no port granularity, and loopback traffic is not filtered by the firewall, so an exempted sandbox can
  reach any service on 127.0.0.1. Broker-only loopback is therefore **not proven**. `fusion sandbox doctor` now reports
  this per identity: a loopback-exempt identity is at most CONFINED and never reported HARD for its network. An
  identity without an exemption keeps exactly what its canary proved.
- **Not yet the normal execution path.** Builds, reviews and conversations still run providers as before: read-only,
  in Fusion-owned views, under your user account. No real provider turn has run inside the sandbox yet (Gate #2).
- **Source checkout only.** The launcher is not in the packaged CLI. Build it from a source checkout with
  `powershell -File native/fusion-sandbox/build.ps1` (the in-box .NET Framework compiler; no SDK, no network), then run
  `fusion sandbox` from that checkout, for example `node dist/src/cli/main.js sandbox doctor` after `npm run build`. A
  packed install reports the launcher NOT built and the posture UNAVAILABLE.

### Hyper-V isolation

- **Network direction chosen by evidence.** The AppContainer network gap led to a Hyper-V isolated worker with
  `--network none` and exactly one mapped named pipe to a host broker. A TCP + endpoint-ACL alternative was rejected
  after it failed on real hardware.
- **Proven live with maintainer-run harnesses, each with a committed audit record:**
  - the broker-only network boundary: the allowed route works and all 16 negative probes are denied;
  - writer filesystem/workspace isolation: no bind mount, the primary checkout unchanged, a validated result transfer;
  - verification isolation of untrusted output: a clean verifier passes, a timeout is told apart, a mutation is
    rejected.

  After a concurrency fix to the host pipe broker, all three were re-validated live on the fixed broker.
- **Production Windows Hyper-V verification backend.** It is registered and selected for windows-required
  verification, with a VM, `--network none`, no bind mount and pinned commands only. `fusion doctor --probe` reports
  its runtime readiness separately from its evidence.
- **No Windows acceptance authority yet.** Only the docker-linux backend can grant a verification-isolation acceptance,
  so a windows-required autonomous Writer build is still refused.

### The attended Writer workflow, hardened

- **Same route.** After you confirm a `fusion build`:
  1. a read-only Worker proposes a change;
  2. Fusion validates it and applies it into a private candidate;
  3. confined docker-linux verification runs;
  4. a fresh Reviewer reviews it, where the risk policy requires one;
  5. Fusion prepares a delivery, which you approve by typing its exact manifest digest;
  6. `fusion apply` checks everything, takes a single-use claim and applies, with rollback.

  Providers never write to your checkout.
- **Byte-stable checkouts.** A confirmed build is refused before its first model turn or candidate
  (`checkoutByteTransform`) when the checkout would change the bytes of a file the build may touch: `core.autocrlf`, an
  `eol` or `text` attribute, a filter or a
  `working-tree-encoding`. Fusion compares Git object IDs, never decoded text, and refuses whenever Git cannot answer.
  An apply refused only because of line endings now says so.
- **Worker readiness vs Writer gate.** The Worker's read-only proposal readiness is reported separately from the Writer
  gate. `fusion doctor --probe` checks the Worker with init-only startups and no model call. A write- or shell-capable
  Worker is never proposal-eligible, and the Writer itself stays `REAL_WRITER_MODE_NOT_READY`.

### Process and provider hardening

- **Owned process trees.** Cleanup after a cancelled or timed-out provider process is decided from the root's OS handle
  and its owned process tree:
  - ownership needs a valid creation identity, so a stale parent PID can never make an unrelated process "owned" or get
    it killed;
  - taskkill's exit code is never the verdict.
- **Fail closed on survivors.** If the started process, or one of its owned descendants, is known to survive, the
  startup is refused at once. Only a genuinely ambiguous cleanup is repeated, and only once.
- **Stricter Claude startup checks.**
  - Unsafe startup events are refused first.
  - Only an exactly-shaped, benign render notification is tolerated before init.
  - An installed plugin discovered at init is quarantined; an unidentified one is refused.
- **Exact Claude model identity** (a release fix).
  - **Why.** Claude Code 2.1.293 moved the `haiku` alias from Haiku 4.5 to Haiku 5.5. A Worker that launched `haiku`
    while authorizing `claude-haiku-4-5-20251001` was refused at its init on every turn (nothing applied or delivered),
    and `fusion doctor --probe` still called it eligible.
  - **Pinned defaults.** Fusion's default Claude bindings now request exactly the concrete models they authorize:
    `claude-opus-5-5` for the Lead and `claude-haiku-4-5-20251001` for the Worker. `fusion create` writes them.
    Existing configurations are left as they are.
  - **Checked before the task.** Every init-only preflight startup requires the binding's exact model, so a moved alias
    is refused with `model_identity` before any task prompt is sent. The turn checks its own init again.
  - **Truthful doctor.** `fusion doctor --probe` attests each Claude binding's model identity without a model call, and
    a mismatch makes the binding not eligible.
  - **Kept as evidence.** The sanitized requested, expected and observed models are kept in the run record.
  - Identity is compared exactly: no alias, family or version-suffix matching.
- **Truthful `fusion doctor`.** Its Writer-gate text now matches the recorded evidence: attended builds prepare and apply
  deliveries, while the unattended Writer stays off.

### Recorded attended production evidence

Each run was confirmed by a human, on disposable repositories only, and is recorded in
[the O6 closeout](v0.6-o6-phase2-closeout.md) and its [audit](v0.6-o6-phase2-audit.json).

- **LOW-risk build, applied.** A real Worker proposal went into a private candidate and passed docker-linux
  verification (VERIFIED). It was then approved by its exact digest, prechecked, claimed once and applied.
- **MEDIUM multi-model build, prepared.**
  - Real turns: 2 Lead, 2 Worker and 2 fresh Reviewer.
  - Two separate candidates; the baseline defect was reproduced and resolved.
  - Fusion selected one candidate and revalidated it freshly; the primary checkout stayed unchanged.
  - Both reviews were clean, so no adjudication or correction ran in that build.
- **Line-ending mismatch, then applied.** A `core.autocrlf` mismatch was refused twice with nothing changed; a
  byte-stable checkout then applied.

## Safety architecture

- **Unattended Writer mode is off.** `REAL_WRITER_LIVE_GATE_AUTHORIZED` is `false` in code; no configuration, variable
  or flag opens it. A Writer build runs only after you confirm exactly that build at an interactive terminal, once.
- **Providers stay read-only**, in Fusion-owned views. Fusion validates every change and applies it into a private
  candidate. Your checkout changes only through `fusion apply`, after your exact approval, a precheck and a single-use
  claim.
- **HARD is claimed only where a canary mechanically proved it**, for the same identity and configuration; unknown is
  never HARD.
- **A provider turn runs only on the exact model its binding authorizes**, as read back at init, before the task prompt
  and again on the turn itself.
- **No Windows verification-isolation acceptance authority exists.**

## Installation

From source (the only channel for v0.6.0):

```powershell
git clone https://github.com/Tanerinki/fusion-cli.git
cd fusion-cli
git checkout v0.6.0
npm ci
npm pack
npm install --global .\fusion-cli-0.6.0.tgz
fusion --version
```

The optional sandbox launcher is not part of the packed CLI; see "Windows hard-isolation groundwork" above.

## Validation

- **Offline suite:** deterministic, with no provider, network or Docker daemon: 1589 tests: 1585 pass, 0 fail, 0
  cancelled, and 4 expected environment skips (a symlink privilege and three Docker-live black boxes), which are not
  live evidence.
  - It includes the [v0.6 invariant matrix](v0.6-invariant-matrix.md); a test keeps every quoted test title real.
- **Packaging smoke test:** clean clone → pack → private install → run (`fusion 0.6.0`): PASS (`fusion-cli-0.6.0.tgz`,
  210 files, no `native/`).
- **Live evidence (maintainer, disposable targets):**
  - the Hyper-V isolation harness runs, including the fixed-broker re-validation;
  - the attended production builds above;
  - `fusion sandbox doctor` on a real exempted and a real un-exempted identity: CONFINED vs HARD.
- **Final release acceptance on the 0.6.0 code: PASS** on 2026-10-10, with Claude CLI 2.1.296
  ([record](v0.6.0-release-acceptance.md)).
  - The first attempt was refused at the Worker's init by the model-alias drift described above; nothing was delivered.
  - After the fix, `fusion doctor --probe` refused the old `haiku` binding as `model_identity` (observed
    `claude-haiku-5-5`). Twice, it verified the pinned Lead `claude-opus-5-5` and Worker `claude-haiku-4-5-20251001`.
    These results are maintainer-observed.
  - An attended LOW build on a fresh disposable repository was applied (from Fusion's persisted run and delivery
    records):
    - a real Worker turn on exactly `claude-haiku-4-5-20251001`;
    - a private candidate and docker-linux verification PASS, VERIFIED 3/3;
    - exact-digest approval, a precheck, one single-use claim and the apply.

    Post-apply tests passed 1/1 (maintainer-observed).

## Known limitations

- **Finding-driven route not proven end to end.** The finding → Lead adjudication → correction → re-review route has
  not been observed in one normal production build. Its parts are proven live separately, plus deterministic coverage.
- **No OS filesystem boundary for providers.** Provider CLIs run under your user account in Fusion-owned copies. Changes
  are detected, not prevented by the operating system.
- **Kill-window race.** On the direct (unsandboxed) spawn path, a process spawned and orphaned in the final kill window
  can escape. Only a Windows Job Object, as on the sandbox path, gives a hard guarantee.
- **No Windows verification acceptance authority**, so a windows-required autonomous build is refused.
- **Gate #2 not run.** No real provider turn has run inside the hard sandbox; it is not the normal execution path.
- **Disposable targets only.** No ordinary checkout has received a delivery live; live evidence is largely single
  samples on small disposable targets.
- **No automatic resume.** Nothing resumes an interrupted build automatically, and an apply interrupted before its claim
  stays locked.
- **Model identity is per runtime.**
  - The O6 runs recorded Haiku 4.5 and Opus 5.5 on a Claude Code release from before 2.1.293.
  - The final release acceptance verified the pinned IDs on 2.1.296 on 2026-10-10: the Worker in a real turn, the Lead
    by init readback only.
  - Whether a given Claude Code release and subscription still serve a pinned model is shown by `fusion doctor --probe`
    and by the run itself, not assumed.
  - A configuration that requests an alias fails closed with `model_identity` whenever the alias resolves elsewhere.
- **Unattended Writer mode** intentionally remains off.
- **Not yet supported:** no automatic commit, push or merge by Fusion, and no package-registry publication.
