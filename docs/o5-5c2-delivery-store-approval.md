# O5.5C2 — Persistent delivery store, inspect and human approval (offline)

Labels: **IMPLEMENTED + TESTED OFFLINE** on throw-away Git repositories under the system temporary directory. **No live primary apply**: `fusion apply` into any real checkout stops before its precheck.

O5.5C1 built the delivery foundation: a canonical manifest, an exact bundle, an approval boundary and a local applier with precheck, staging, journaled apply, postcheck and rollback. Its only approval authority was test-only.

O5.5C2 adds the product layer:
- deliveries are persisted;
- a human can read one before deciding;
- a human approves it durably, by typing its digest;
- `fusion apply` requires that approval and then runs the C1 applier;
- for any real checkout, `fusion apply` stays behind the (closed) live delivery gate.

```
verified private candidate (completed, verified under a granted acceptance, last review clean)
  -> prepareStoredDelivery: manifest + bundle written once, `prepared` event        [app/delivery-service.ts]
  -> fusion inspect-delivery <id>        (read-only; digests, target, changes, evidence, policy, verified diff)
  -> fusion approve-delivery <id>        (interactive: type the exact manifest digest) -> approval.json + `approved`
  -> fusion apply <id>
       1. load + revalidate every stored artifact
       2. require the durable human approval of exactly these artifacts (re-derived and re-checked)
       3. resolve the target repository -> live delivery gate: closed (only a registered disposable test repository passes)
       4. PRECHECK (C1, unchanged)   -> precheckStarted / precheckPassed | precheckFailed
       5. STAGE -> APPLY -> POSTCHECK | ROLLBACK (C1, unchanged)
  -> applied | failed | rolledBack | rollbackFailed, appended to the delivery's event log
```

No step starts a provider, a model, a shell, or any repository code. Git runs isolated: hooks and fsmonitor are off, global configuration is not read, and optional locks are off. None of the O5.5C1 manifest, bundle, drift or rollback rules changed. `REAL_WRITER_LIVE_GATE_AUTHORIZED` stays false.

## 1. Store architecture

`DeliveryStore` (in `platform/delivery/store.ts`) is provider-neutral: `put`, `load`, `list`, `writeApproval` and `appendEvent`. `FilesystemDeliveryStore(root)` implements it. The root is injectable for tests and must be an absolute path.

By default the root is `<repository>/.fusion/deliveries`. It is part of Fusion's own state directory:
- self-ignored: `.fusion/.gitignore` contains `*`, so Git never tracks it and a clean-tree check never sees it;
- excluded from every provider view (`.git`, `.fusion`);
- a forbidden delivery path (the `fusionState` class).

It is never the target working tree Git tracks.

Each delivery gets one directory:

| File | Mutability | Content |
|---|---|---|
| `manifest.json` | immutable | The manifest's canonical bytes. Their SHA-256 *is* the manifest digest. |
| `bundle.json` | immutable | The serialized bundle: the exact post-image bytes, base64. |
| `record.json` | immutable | Delivery id, manifest digest, bundle digest, SHA-256 of `bundle.json`, and the run reference (run id, workflow evidence digest). |
| `approval.json` | write-once | The durable human approval. Absent until a human approves. |
| `events.jsonl` | append-only | Lifecycle events, one canonical JSON line each. The state is derived from them. |
| `apply.claim` | create-once | Empty exclusive marker for the one apply an approval allows. Never removed. |

Immutable artifacts and mutable state are kept in separate files. The state is never a mutable field: it is derived from the append-only log, whose strict order is enforced (§6).

The delivery id is deterministic: `d-` followed by the first 24 hex characters of SHA-256(run id, base commit, ChangeSet digest). Preparing the same run twice is idempotent.

## 2. Persistence and crash guarantees

**Write-once.** An immutable file is written in four steps:
1. write a temporary file (exclusive create, then fsync);
2. create an **exclusive hard link** to the final name, which never replaces an existing file;
3. remove the temporary file;
4. on a filesystem without hard links, rename the temporary file after re-checking that the name is still free (a narrow, documented race).

Identical bytes under an existing name are accepted, which makes the write idempotent. **Different bytes under the same id are refused** (SecurityViolation) and nothing is replaced.

**Append-only log.**
- Each event is appended in one write and fsynced.
- The whole log is re-derived with the new event before it is written, so an event the lifecycle does not allow is never appended.
- A torn last line (no final newline) fails closed.

**Revalidated on every read.** A read never trusts the filename or id alone. It checks:
- bounded sizes: manifest 256 KiB, bundle 8 MiB, record 16 KiB, approval 16 KiB, events 256 KiB;
- the manifest's canonical bytes, and its digest against the record;
- the bundle against the manifest, with every content digest recomputed;
- the record's exact shape and bindings;
- the approval's exact shape, canonical form and binding to these artifacts;
- each event's shape, canonical form, sequence number and bindings (delivery id, manifest digest, bundle digest, repository identity, expected HEAD);
- that the approval and the log agree.

Artifacts copied under another id are refused. Corruption fails closed: "The stored delivery is corrupt or tampered (...)", exit 4. A missing delivery gives exit 2.

**Links.** The store root and each delivery directory must be real directories: the path is compared with its `realpath`, and a symbolic link, junction or reparse point is refused. Each stored file must be a regular file and not a link.

**Crash windows.**

| Crash point | Result |
|---|---|
| During `put` | Either nothing exists, or immutable files exist without events. The latter is the `incomplete` state: refused on read, completed by preparing the same delivery again (idempotent). |
| Between `approval.json` and its `approved` event | A *pending* approval. It already binds these exact artifacts, so it is completed by the next approval, never replaced. It is not usable until its event exists. |
| Between `apply.claim` and `applyStarted` | The delivery stays `approved` but can no longer be applied ("already claimed"): fail closed. |
| During an apply | The log ends in `applying` (applyStarted, or precheckStarted/Passed): shown by inspect, and neither re-approvable nor re-appliable. The C1 applier leaves its journal and backups in `<gitdir>/fusion-delivery/`. Nothing resumes them automatically (unchanged from C1). |

**Nothing secret or raw is persisted.** The manifest, record and events carry identities, digests, counts, labels and repository-relative paths only. Provider text (findings, rationales, replies) never enters: the review evidence is reduced to counts and a digest of labels. The bundle carries only the exact validated post-images of declared files. No environment value or credential is ever written.

## 3. Preparation

`prepareStoredDelivery` (in `app/delivery-service.ts`) takes a verified Writer result. It:
- reads the primary's identity through the C1 `prepareRunDelivery` (HEAD must equal the run's baseline);
- builds the manifest and bundle;
- persists both;
- appends `prepared`;
- returns the id, the manifest digest and the state.

It refuses, **storing nothing**, any result that is:
- failed or not completed;
- not passed;
- unverified or an offline rehearsal (no granted acceptance);
- review-blocked (last cycle not clean);
- prepared against a baseline that is not the current HEAD.

The primary's tracked tree is never touched: only `.fusion/` is written. No CLI command prepares a delivery from a real run, because real Writer mode is not ready.

## 4. `fusion inspect-delivery <id>`

This command is read-only. It loads and revalidates the delivery (corrupt data is refused with exit 4 and nothing printed on stdout) and shows:

```
Delivery: d-…
State: prepared
Manifest: sha256:<full digest>
Bundle: sha256:<full digest>
Target: repository sha256:<identity>
  base <commit> (tree <tree>), clean tree required
Changes: 1 create, 1 update, 1 delete
  M src/quote.ts
  A src/lib/discount.ts
  D docs/old.md
Verification: PASS (docker-linux, osSandbox, 2 command(s), acceptance granted)
Review: CLEAN (1 cycle(s), 1 finding(s) adjudicated, 0 outstanding)
Correction: 0 correction(s) in 1 attempt(s)
Safety: scope localWorkingTree, platform win32, links refuse, ignored paths refuse; caps …
  allowed paths: 3; forbidden paths: .claude, .muse, CLAUDE.local.md; forbidden classes: …
Approved: NO
Events: prepared

M src/quote.ts
  before: sha256:…
  after:  sha256:… (123 bytes)
  --- a/src/quote.ts
  +++ b/src/quote.ts
  @@ … @@
  …
```

The diff is rendered only from trusted inputs:
- the post-image comes from the validated bundle;
- the preimage comes from the base commit's blob (`git cat-file blob <base>:<path>`, which runs no filters), accepted only when its SHA-256 equals the manifest's `beforeSha256`.

When no diff can be shown, the reason is named instead: `binary`, `tooLarge`, or `preimageUnavailable` (the preimage could not be read or verified).

The Myers diff (`core/delivery/diff.ts`) is bounded: at most 5000 lines per side and 2000 edits, otherwise `tooLarge`. Output stops at 400 lines and is marked as truncated.

The command:
- appends no event and writes no file;
- runs only `git rev-parse` and `git cat-file`;
- reaches no provider;
- passes every line through the redacting, terminal-safe renderer.

`--json` prints the same view as one document.

## 5. `fusion approve-delivery <id>`: durable human approval

This command replaces the O5.5C1 test-only authority for real use. `issueTestOnlyApproval` remains for the C1 tests.

It shows:

```
Approve delivery d-…
Manifest SHA-256: <full digest>
Bundle SHA-256: <full digest>
Target: repository sha256:<identity>
Target HEAD: <base commit> (must be unchanged, clean tree required)
Operations: 1 create, 1 update, 1 delete
  M …
Verification: PASS; Review: CLEAN
This approval covers only this exact manifest digest (and the bundle it names). Any change to the delivery invalidates it;
it is used once, and it does not skip the precheck. Run `fusion inspect-delivery` first to read the diff.
Type the exact manifest digest to approve:
```

The rules:
- **Only the exact digest approves.** The typed text (trimmed) must equal the full 64-hex manifest digest, with or without a `sha256:` prefix. There is no default and no "y" or "yes"; a prefix, a different case, another delivery's digest or an empty answer approves nothing. A declined (EOF or Ctrl+C) or mistyped answer changes nothing and exits 13.
- **Only a human at a terminal.** A non-interactive call refuses before asking (stdin and stdout must both be TTYs) and exits 14; `--json` is a usage error (exit 2).
- **The shown digest is the approved digest.** The delivery is re-loaded and revalidated after the answer. If its artifacts changed after the summary was shown, nothing is approved (exit 4).
- **Binding.** `approval.json` (`fusion.deliveryHumanApproval` v1) binds the delivery id, manifest SHA-256, bundle SHA-256, repository identity and base commit, with confirmation `typedManifestSha256` and a timestamp. The schema is exact: any other key is refused.
- **Not reusable.** Only a `prepared` delivery can be approved. An approval is consumed by the one apply that follows:
  - that apply starts only through an exclusive `apply.claim` (created with `wx`), so two concurrent `fusion apply` runs can never both use it;
  - after that apply (applied, failed, rolled back), the delivery can be neither applied nor approved again.
- **No bypass.** `apply` re-derives the in-process approval (`approvalFromHumanRecord`), re-checking all five bindings against the revalidated manifest, and still runs the full C1 precheck (drift, HEAD, clean tree, filters, links, ignored paths). It opens no gate.

For tests, the prompt and the TTY flag are injectable through `CliIO` (`interactive`, `prompt`). The entry point (`cli/main.ts`) reads one line with `readline`.

## 6. `fusion apply <id>`: gating and evidence

The required order is implemented as:

1. **Load and revalidate** the store (corrupt data: exit 4, nothing runs).
2. **Require the durable approval.**
   - A `prepared` delivery reports `approvalRequired` (exit 14) without running anything.
   - Any other non-approved state is refused with exit 2 (an approval is used once).
3. **Resolve the target.** The repository is the one containing the working directory, found with the isolated Git client and resolved with `realpath`. The store lives inside it; its identity is checked by the precheck. The **live delivery gate** then applies:
   - no live delivery authorization exists (`liveDeliveryAuthorization()` is constantly unauthorized);
   - the only execution path is a **disposable test repository**: registered by a test harness through `ControlPlaneDeps.disposableDeliveryTargets` **and** strictly inside the system temporary directory (compared by `realpath`);
   - every other target reports `blocked` (exit 11) before any precheck, with no event appended and the approval unused;
   - the CLI entry point never sets that seam, and no environment variable, flag or configuration key is read by the delivery code (test 31 sets several and commits a `delivery` configuration: still blocked).
4. **PRECHECK**, the C1 applier unchanged.
5. **Only then APPLY**: STAGE, the journaled APPLY, POSTCHECK and ROLLBACK, the C1 applier unchanged.

Exit codes:

| Result | Exit |
|---|---|
| applied | 0 |
| approvalRequired | 14 |
| blocked | 11 |
| failed (precheck or stage) | 8 |
| rolledBack | 8 |
| rollbackFailed | 1, with "NOT restored" per path; the staging is kept |
| an outcome whose event could not be appended | 10; the outcome is still printed, with "Evidence: NOT recorded" (a rollbackFailed keeps exit 1) |

**Events (metadata only).** Each event records: `format`, `version`, `seq`, `type`, `at`, `deliveryId`, `manifestSha256`, `bundleSha256`, `repositoryIdentity`, `expectedHead` (the base), `observedHead` (as the applier read it), `touchedPaths` (count), `phase`, `issues` (reason labels with repository-relative paths, at most 16) and `rollback` (`{restored, failed}` counts). They never carry content, provider text, absolute paths or environment values.

The lifecycle accepts only these orders:

```
prepared -> approved -> applyStarted -> precheckStarted -> precheckPassed -> applied | failed | rolledBack | rollbackFailed
                                                        -> precheckFailed -> failed
(applyStarted | precheckStarted) -> failed    only when a precheck outcome could not be recorded (the applier stops before any write)
```

The applier gained a precheck `observer`, which emits started, passed and failed events and supplies `observedHead`. If an event cannot be recorded, the applier stops **before any write** with the issue `evidenceUnrecorded`.

## 7. Test coverage (offline; `test/o5-5c2-delivery-store-approval.test.ts`)

Every scenario runs on throw-away Git repositories under the temporary directory, asserted before cleanup.

| # | Covered |
|---|---|
| 1–3 | Exact canonical artifacts; ignored by Git, tracked tree untouched; idempotent re-prepare; same id with different bytes refused, nothing replaced; no provider text or credential stored. |
| 4–5 | 14 tamper and corruption variants: manifest non-canonical, changed, missing or oversized; bundle bytes; record binding or shape; torn, empty, out-of-order, foreign or non-canonical events; forged or orphaned approval. Each is refused by `load` and by `inspect-delivery` (exit 4). Renamed id refused; invalid ids and unknown ids are exit 2. |
| 6 | A junctioned delivery directory and a junctioned store root are refused; a relative root is refused. |
| B | A failed, unpassed, unverified, review-blocked or stale-baseline result stores nothing; the primary is untouched. |
| 7–10 | Inspect shape and every field; exact hashes and sizes; a diff for M/A/D; no provider text or `.env` canary; store, primary and provider untouched; Git read-only (`rev-parse`, `cat-file`); `--json`; usage errors. |
| diff | Exact hunks, create/delete, two separate hunks, tooLarge, identical input. |
| 11–17 | Unapproved apply (14; no precheck even for a disposable repository); non-interactive refusal (14, never asked); `--json` refused; nine declined or mistyped answers (13, nothing written); exact approval with its summary; bindings (id, manifest, bundle, repository, base) with each forgery refused; tampered artifacts after approval refused (4, nothing recorded); approving twice refused; a delivery changed between summary and answer approves nothing; another delivery's digest approves nothing. |
| 18–21, 28, 29 | create, update, delete and multi, each in its own disposable repository: exit 0; exact post-image hashes; every undeclared path and the `.env` canary unchanged; Git sees only declared paths; event order and metadata; re-apply and re-approve refused. |
| 22–24 | Touched-file drift, HEAD drift and a dirty tree: exit 8, `failed` at precheck, nothing written or staged; issues recorded; `observedHead` against `expectedHead`. |
| 25–27 | Apply-failure rollback (exit 8, exact preimages, `{restored: 2, failed: 0}`); postcheck-failure rollback; rollbackFailed (exit 1, "NOT restored", staging kept, `{restored: 2, failed: 1}`, state `rollbackFailed`). |
| once | Two concurrent applies of one approval: exactly one runs, and the log stays valid. A leftover claim refuses the apply (exit 8, nothing runs). `applyStarted` can be written only through the claim. An unrecordable outcome event gives `applied` plus "Evidence: NOT recorded" (exit 10). An unrecordable precheck event stops the applier before any write (`evidenceUnrecorded`). |
| 30–33 | The real-CLI path blocks before any precheck: no seam, seven environment variables, a committed `delivery` configuration, or another registered disposable repository all give exit 11, only `rev-parse --show-toplevel` runs, nothing is recorded, the approval is unused. `isDisposableDeliveryTarget` rejects the temporary directory itself and the checkout. A sealed provider registry is never touched. No socket connect or fetch is attempted. The delivery modules contain no process, network, provider, `process.env` or `FUSION_` reference; `main.js` sets no seam. |
| 34–36 | The C1 suite stays green (its one readiness text assertion was updated to the new blocker). Three new implementation rows are satisfied/mechanical; `humanApprovedDelivery` stays partial; `hostControlledWriterWorkflow` stays satisfied; Writer mode, the live gate and live delivery stay closed. |

## 8. Readiness

New implementation-only rows are all `satisfied`/`mechanical`, each blocked on "Implementation only…":
- `deliveryStoreImplementation`;
- `deliveryInspectImplementation`;
- `humanApprovalImplementation`.

`humanApprovedDelivery` stays **partial**. Its blocker is now: no live delivery authorization exists; `fusion apply` into any real checkout stops before its precheck; no command prepares a delivery from a real Writer run; nothing was ever delivered into a real user project.

The following are all unchanged:
- `REAL_WRITER_MODE_READINESS: NO`;
- `REAL_WRITER_LIVE_GATE_AUTHORIZED: NO`;
- `O5_5B_READINESS: NO`;
- `O6_READINESS: NO`;
- `hostControlledWriterWorkflow` satisfied.

## 9. Next milestone

**One explicitly authorized apply rehearsal against a throw-away repository.** It must not be the fusion-cli primary. A human names the throw-away repository and authorizes exactly one delivery into it. That delivery is prepared, inspected and approved by the human through the real CLI, then applied through a named, single-use live delivery authorization (the gate stays closed for everything else). The evidence recorded is the event log, the final hashes and the untouched undeclared paths.
