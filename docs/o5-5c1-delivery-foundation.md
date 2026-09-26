# O5.5C1 — Human-approved delivery foundation (offline)

Labels: **IMPLEMENTED + TESTED OFFLINE** on throw-away local Git repositories. **Never run against a real user project.**

O5.5B ends with a verified private candidate: the host-controlled Writer workflow is ready for the private candidate (`hostControlledWriterWorkflow` satisfied). O5.5C1 builds the offline foundation for moving such a candidate's change into a primary checkout, with a human's approval:

```
verified private candidate (WorkflowResult: completed, verified under a granted acceptance, review clean)
  -> prepareDelivery: immutable DeliveryManifest (v2) + DeliveryBundle      [core/delivery/prepare.ts]
  -> DeliveryRecord `prepared`                                               [core/delivery/approval.ts]
  -> human approval of the exact manifest digest -> `approved`   (O5.5C1: test-only authority)
  -> LocalFilesystemDeliveryApplier.apply                                   [platform/delivery/applier.ts]
       PRECHECK -> STAGE -> APPLY (journal) -> POSTCHECK   | any failure after a write -> ROLLBACK
  -> `applied` | `failed` | `rolledBack` | `rollbackFailed`, with bounded evidence
```

No provider, model, shell or network is involved, and no delivery can be approved outside tests. No CLI command exists, and `REAL_WRITER_LIVE_GATE_AUTHORIZED` stays false.

## 1. Threat model

What delivery must never do:
- write anything a human did not approve (another path, other bytes, a regenerated file);
- write into a primary that changed since the change was verified (another commit, edited or new files, dirty state);
- follow a link or reparse point out of the checkout, or write git internals, Fusion state, provider state or credentials;
- let the repository run code during delivery (hooks, fsmonitor, filter drivers);
- report `applied` for a partial or wrong result, or hide a failed restore;
- trust provider text.

**Adversaries considered:**
- a provider's output (only its validated ChangeSet bytes reach the bundle);
- a tampered manifest, bundle or approval at rest;
- a user or process changing the primary between preparation and delivery;
- a repository configured to execute commands;
- filesystem failures in the middle of a multi-file write.

**Out of scope:**
- a malicious local user with the same OS rights: they can edit the checkout anyway;
- a concurrent writer inside the few milliseconds between each operation's re-check and its rename;
- crash recovery after the process is killed mid-delivery. The journal and backups are left in staging, but nothing resumes them yet.

## 2. Manifest and bundle: the trust boundary

**`DeliveryManifest` (`fusion.deliveryManifest`, version 2)** is canonical JSON: keys sorted, safe integers only, no undefined. `deliveryManifestSha256` is the SHA-256 of that serialization, and approvals bind to it.

| Section | Content |
| --- | --- |
| Identity | format, version, `deliveryId`, `request {runId, taskSha256}`, `source {workflowEvidenceSha256}` |
| Primary preconditions | `repositoryIdentity`: SHA-256 of the sorted root commit ids. `baseCommit`, `baseTree` (HEAD and its tree). `cleanTree: "required"`. `touched[]`: each path with `exists` and its preimage `sha256` (or null) |
| Approved change | `operations[]`: index, kind `create`/`update`/`delete`, path, `beforeSha256`, `afterSha256`, `afterBytes`. `change {changeSetSha256, bundleSha256, operationCount, totalBytes}` |
| Quality | verification (passed, `acceptance: "granted"`, backend, confinement, per-command `passed`, evidence digest); review (`clean` or `notRequired`, cycles, finding count, `outstanding: 0`, digest of the verdict labels only); correction (attempts, corrections); `providerText: "excluded"` |
| Safety | `allowedPaths` (the run's scope), `forbiddenPaths` (the providers' workspace state paths), `forbiddenClasses`, `links: "refuse"`, `ignoredPaths: "refuse"`, caps (32 operations, 1 MiB per file, 4 MiB total), `platform` (`win32`/`posix`), `scope: "localWorkingTree"` |

**Validation (`validateDeliveryManifest`)** checks:
- the exact shape at every level (no missing, extra or mistyped field);
- identities and digests;
- every path against the forbidden classes and the manifest's forbidden paths;
- kind consistency and case-insensitive uniqueness of paths;
- touched preconditions equal to the operations, totals and caps, the scope;
- the quality rules: only a passed verification under a granted acceptance, with no outstanding finding, is deliverable.

**Forbidden path classes:**
- absolute paths, traversal, `.git`, `.fusion`, device names (the ChangeSet path rule);
- credential files: `.env*`, keys and certificates, credential stores such as `.npmrc` and `.netrc`, `*.local`;
- credential directories: `.ssh`, `.aws`, `.gnupg`, …;
- provider state (the composition supplies it).

The generic word patterns of the ignored-path monitor (`token`, `secret`, …) are deliberately **not** used: they would refuse ordinary source files such as `src/auth/token.ts`.

**`DeliveryBundle` (`fusion.deliveryBundle`, version 1)** holds one entry per create/update operation, in order: `{index, path, sha256, bytes, content}`. The bytes are the **validated ChangeSet's own content**, cross-checked against Fusion's host application ledger (path, kind, before digest, after digest, size). That is exactly what was applied into the verified candidate; a model never regenerates it.
- An entry has no field for a link, a mode, a directory or an absolute path, so link and reparse entries cannot be expressed. Extra fields are refused.
- `deliveryBundleSha256` **recomputes every entry's digest from its bytes**, so it covers the content and the metadata. The manifest pins it.
- At rest the bundle is canonical JSON with base64 content. Parsing checks the encoding round-trips, and validation re-derives everything.
- **Trust:** nothing in a manifest or bundle is believed until validated. The applier re-validates both, and recomputes every content digest, immediately before any write.

**Preparation (`prepareDelivery` / `prepareRunDelivery`):**
- It refuses anything but a completed run verified under a **granted** acceptance, with passed commands and a clean last review. An offline rehearsal never qualifies.
- It refuses a ledger that differs from the ChangeSet, and any forbidden path.
- `prepareRunDelivery` also reads the primary's identity (read-only Git) and requires HEAD to still be the run's baseline.

## 3. The approval boundary

States:

```
prepared -> approved -> applying -> applied | failed | rolledBack | rollbackFailed
```

- Every other transition is refused.
- An approval is an object **issued in this process** by an approval authority (a private WeakSet). A JSON copy, a spread copy, a deserialized or provider-produced record, or a manifest's existence is never an approval.
- An approval binds to one `manifestSha256` and one `deliveryId`, approves one record once, and is consumed when applying starts. An applied or refused record never applies again.
- **O5.5C1 has only the test-only authority** (`issueTestOnlyApproval`, origin `testOnly`, deterministic). No human approval authority exists, so no real delivery can be approved.

## 4. Precheck and drift policy (fail closed, v0.1)

Before anything is written, every one of these must hold:

| Check | Refusal |
| --- | --- |
| manifest valid; digest = the record's = the approval's | `manifestInvalid`, `manifestDigestMismatch` |
| bundle valid against the manifest (every digest recomputed) | `bundleInvalid` |
| the providers' state paths are in the manifest's forbidden paths | `forbiddenPathsMissing` |
| same platform family | `platformMismatch` |
| the root is the Git work-tree top level | `notRepositoryRoot` |
| no filter driver configured (Git could run it on status) | `filterDriverConfigured` |
| repository identity, HEAD and HEAD tree unchanged | `repositoryMismatch`, `headMoved`, `baseTreeMismatch` |
| clean tree: no staged, unstaged or untracked change anywhere (unrelated dirty state refused too) | `dirtyTree` |
| no touched path is git-ignored | `ignoredPath` |
| each path contained and reached through real directories (no link or junction) | `outsideWorkspace`, `parentNotDirectory` |
| each target a regular file (never a link or reparse point) or absent as expected | `notRegularFile`, `fileAppeared`, `fileMissing` |
| each preimage: exact digest, within the cap | `fileChanged`, `tooLarge` |

- No merge, rebase or conflict resolution happens. A drifted primary needs a new run against its current HEAD.
- Primary bytes that differ from the baseline's, including line endings converted by `core.autocrlf` or eol attributes, are refused as `fileChanged`.

## 5. Apply and its guarantee

1. **STAGE:** post-images are written into Fusion-owned staging, `<git-dir>/fusion-delivery/<id>.<random>/`, and read back against their digests. It sits inside the repository's Git directory: the same volume as the work tree, and outside it.
2. **APPLY:** only the manifest's operations, in order. Each is re-checked against its precondition right before it runs.
   - **create:** exclusive hard link from staging, which never replaces. Fallback: exclusive copy. Missing parents are created and recorded.
   - **update:** backup copy (digest-verified), then one rename over the target.
   - **delete:** one rename of the target into the backup (digest-verified).
   - A journal (`journal.json`: paths, kinds, progress, no content) is rewritten after each step.
3. **POSTCHECK:** every touched path holds exactly its post-image (digest and size) or is absent; `git status` lists no path but the touched ones; HEAD is unchanged.
4. **Success:** staging and backups are removed; `applied`.

**The actual guarantee:** full prevalidation of every operation, plus per-file atomic replacement where the filesystem provides it (a rename within one volume), plus a journaled, verified rollback. **It is not a multi-file transaction.** Between two operations another process could observe a partially delivered state. If staging is on another volume (`EXDEV`), a file moves by an exclusive copy into the target's directory followed by a rename.

**Git hygiene:**
- Git runs only read-only local commands (`rev-parse`, `rev-list`, `config`, `status`, `check-ignore`), never fetch, push, commit, reset, checkout, clean or stash.
- It uses the isolated-config client: hooks point nowhere, `core.fsmonitor=false`, no global or system config, `GIT_OPTIONAL_LOCKS=0`, so status never rewrites the index.
- A configured filter driver refuses the delivery before `status` runs.

## 6. Rollback

On any failure after the first write (an apply error, drift inside the window, or a postcheck failure such as an undeclared change or a wrong post-image), the rollback runs in reverse order:
- a created file is removed, together with the directories created for it;
- an updated file is restored from its backup;
- a deleted file is renamed back.

Each touched path is then **verified against its preimage**.
- **`rolledBack`:** every touched path restored and verified; staging removed.
- **`rollbackFailed`:** at least one path could not be restored. It is reported (`restoreFailed` with the path, `restored: false` in the evidence), and **staging with the journal and backups is kept** for recovery.
- **`failed`:** refused before any write (precheck or staging).

`applied` is reported only after a passing postcheck.

## 7. Windows and Linux caveats

- **Windows:**
  - `rename` over an existing file replaces it (MoveFileEx) but fails when another process holds the file open (an editor, an antivirus scan). That is an apply failure, which rolls back.
  - Junctions are detected as links (Node reports them via `lstat`; the parent check also compares real paths).
  - Creating file symlinks needs a privilege, so that test case runs only where the platform allows it.
  - Paths compare case-insensitively everywhere.
- **Linux/macOS:** rename is atomic within a filesystem. Case-insensitive uniqueness is still enforced, so a manifest stays portable.
- **All:** hard links need a filesystem that supports them; otherwise the exclusive copy is used. The staging directory lives in the Git directory, and a linked worktree whose Git directory is on another volume uses the copy-then-rename fallback.

## 8. Mechanically enforced vs test-only

**Mechanically enforced in code:**
- canonical digests;
- strict manifest and bundle validation;
- the forbidden classes;
- the approval brand and single use;
- the state machine;
- every precheck;
- the per-operation re-check;
- the postcheck and the verified rollback;
- read-only Git with hooks and fsmonitor off;
- the filter-driver refusal;
- no process, network or provider module in the delivery code (checked by a test);
- no CLI module reaching the applier, the approval authority or the composition (checked by a test).

**Test-only:**
- the approval authority (`issueTestOnlyApproval`);
- the fault-injection seam (`DeliveryFaults`);
- every delivery ever executed (throw-away local repositories);
- the composition (`app/delivery-composition.ts`) is internal and wired to no command.

## 9. Readiness

A new writer-gate row, `humanApprovedDelivery`, is **partial** with **mechanical** evidence (the offline implementation). Its blocker names what is missing:
- a human approval authority, `fusion inspect-delivery` and `fusion apply`;
- any real delivery into a user project (**no live primary apply**);
- a transaction or crash recovery;
- dirty, filter-driver and converted-line-ending primaries are refused.

| Flag | Value |
| --- | --- |
| HOST_CONTROLLED_WRITER_WORKFLOW_READINESS | YES (unchanged) |
| DELIVERY_FOUNDATION_IMPLEMENTATION | READY (offline) |
| REAL_PRIMARY_APPLY_LIVE | NOT_RUN |
| REAL_WRITER_MODE_READINESS | NO |
| O5_5B_READINESS | NO |
| O6_READINESS | NO |
| REAL_WRITER_LIVE_GATE_AUTHORIZED | NO |

**Why REAL_WRITER_MODE stays NO:**
- no human can approve a delivery (no authority, no command);
- no delivery ever ran against a real project;
- the provider CLIs are still not OS-isolated;
- the live gate is a constant false.

## 10. Future integration shape (defined, not exposed)

```
fusion build "..."            -> a private verified result -> prepareRunDelivery -> DeliveryRecord `prepared` (persisted)
fusion inspect-delivery <id>  -> deliveryPreview + evidence digests (+ the exact diff, rendered from the primary and the bundle)
fusion apply <id>             -> the human approves the shown manifest digest -> deliveryApplier().apply -> outcome + audit event
```

## 11. Tests (`test/o5-5c1-delivery-foundation.test.ts`)

**Manifest (1–4):**
- stable digest, stable across a JSON round trip, with key-order-independent canonical JSON;
- floats and undefined refused;
- ten kinds of tampering refused;
- a self-consistent other manifest cannot use the approval, and a changed post-image digest breaks the bundle binding;
- no content or provider text (a canary in review titles, evidence and rationales never appears);
- exact before and after digests;
- a rehearsal, a non-completed run or a ledger mismatch cannot be prepared.

**Bundle (5–10):**
- exact bytes round-trip;
- tampered content, a renamed entry, a `symlink` entry or a missing entry refused;
- bytes changed after approval are refused by the precheck before any write;
- traversal, absolute, UNC, `.git`, `.fusion`, device, credential and provider-state paths refused, ordinary source paths accepted;
- caps: own caps, hard caps, 33 operations.

**Precheck (11–16):**
- a clean matching primary passes;
- refused before any write, with nothing staged: HEAD drift, touched-file drift, an unexpected create target, a missing update or delete target, unrelated untracked state, a staged change;
- links: a junctioned parent refused; a symlinked target refused where the platform permits a file symlink (skipped on this Windows machine: `EPERM`).

**Apply (17–22):**
- create, update, delete and multi-file each end `applied`, with history `prepared → approved → applying → applied`;
- every post-image exact; no other path changed, the ignored `.env` canary included;
- `git status` lists exactly the declared paths; HEAD unchanged; staging removed;
- evidence without absolute paths or content.

**Rollback (23–26):**
- a failure after the second write is rolled back: every preimage exact and the created directory removed;
- an undeclared change caught by the postcheck is rolled back;
- a restore failure is reported as `rollbackFailed`, staging kept, the unrestored path reported;
- never `applied` in any of these.

**Approval (27–29):**
- an unapproved record is refused before any Git command;
- look-alike approvals are refused;
- the exact manifest's approval applies once;
- the same approval cannot approve another record or another manifest.

**Security (30–33):**
- only read-only local Git subcommands run;
- a repository with fsmonitor and hooks executes nothing;
- a filter driver is refused before `status`;
- no process, network or provider module in the delivery code;
- only the new row moves; Writer mode, O5.5B, O6 and the gate do not;
- no CLI module reaches delivery.

## 12. Next milestone

**O5.5C2 (offline): the delivery store and a human approval authority behind an explicit, non-default local command**:
- persist `prepared` records (manifest, bundle, evidence) under the run's store;
- `fusion inspect-delivery <id>` rendering the exact diff from the primary and the bundle;
- a human approval authority that issues an approval only from an interactive confirmation of the displayed manifest digest.

The command should still be refused unless an explicit authorization names a throw-away repository. A first live primary apply follows only on a separate human authorization.
