# O5.5B Writer isolation substrate

## Invariant and threat model

A future autonomous Writer must own exactly one isolated workspace lease, never gain write access to the primary checkout, and never silently change Git state used by that checkout. Verification must use only a pinned baseline and an explicitly approved candidate set. Its commands must be bounded, and their results must be independent of uncontrolled ignored files and mutable shared Git metadata. Eligibility comes from observed capabilities, never a provider or model name. An uncertain condition closes the Writer route.

The O1 linked worktree remains useful for read-only and fake-workflow tests, but its common Git directory is shared. `PrivateWriterWorkspace` is a separate offline substrate: it clones the primary committed baseline into a Fusion-owned temporary repository with its own `.git`, disables ambient Git configuration and attributes for Fusion Git calls, removes the clone's push remote, and rejects a common-dir or workspace readback mismatch. This class does not launch a provider. The production Writer route remains closed.

## Candidate and verification flow

1. Pin primary `HEAD` and fingerprint primary worktree plus Git control state before cloning. No stash, reset, clean, checkout, merge or force deletion touches the primary.
2. Create a private candidate repository. One owner ID controls its API; overlapping verification calls and other owners are refused. A change to private Git metadata, refs, config, hooks or index fails candidate extraction.
3. Require the caller's approved paths to match the complete Git-visible candidate change list. Reject traversal, drive paths, alternate data streams, device names, `.git`, `.fusion`, symlinks, junctions and unbounded content. Ignored candidate files do not cross this boundary.
4. Clone the same pinned baseline into a second private repository. Copy only approved regular files or approved deletions. The verification process runs there, with an allowlisted environment and the host's read-only plan fixed when the candidate opens; each command uses explicit native executable/argv fields. `controlledTree` scans ignored and untracked files as well as tracked files before and after each command. Any mutation or incomplete scan is a policy violation.
5. Compare the primary state again. Remove only the exact Fusion-owned verification directory, with reparse points unlinked before recursive removal. A cleanup failure fails the operation. Candidate removal requires explicit discard when changes exist. A stale-directory scan reports orphaned private leases without deleting them.

The fingerprint hashes raw index bytes, `ls-files -v` flags, HEAD, the common-dir identity, refs and packed refs, local config, worktree config, hooks, `info/`, alternates, and the effective Git configuration including includes. Only hashes and paths enter evidence; config values and hook contents do not. Oversized or unreadable state is incomplete and cannot prove a read-only step. The controlled tree has explicit entry and byte bounds. Git operations use argv arrays, disabled hooks/fsmonitor, no inherited `GIT_*` variables, and no ambient user/system Git config for the private workflow.

## Open proof obligations

This substrate is deliberately not a real Writer posture. Neither Muse nor Claude currently proves that its process can write only inside the private candidate and cannot access the primary, external paths, credentials, Git push or uncontrolled shell. A verifier executable can also address absolute paths outside its reconstructed tree; the current API detects persistent primary changes after the fact, but it cannot prevent or observe a write that is reverted. The private workflow is not wired into production routing or the fresh Reviewer stage. External Git hook/config paths and concurrent primary mutations need further prevention or fail-closed proof under the actual launch posture.

Therefore all five original production blockers remain open: ignored-path influence, shared Git state, state fingerprints, verification isolation, and real Writer provider posture. The new code narrows each technical gap and has deterministic adversarial coverage; it does not establish end-to-end runtime containment. `REAL_WRITER_MODE_READINESS` and `O5_5B_READINESS` remain **NO**. The first real autonomous Writer live gate is **not authorized**.

The independent LOW follow-ups O5-L2 (unbounded `show` outcome read) and O5-L3 (audit underreporting after 100,000 files) are unchanged.
