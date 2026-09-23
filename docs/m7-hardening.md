# M7 hardening and release readiness

M7 hardens the existing M1–M6.1 foundation. It adds no product features, no provider calls, and no new workflow. It fixes defects found by a failure-mode audit of cancellation, timeouts, process cleanup, hostile provider output, resource bounds, repository safety, secrets, paths, and failure presentation. Every behavior below is covered by deterministic local tests (`test/m7-*.test.ts`) using fixture executables, temporary directories and real `git` repositories. No test discovers or invokes Claude or Muse.

## 1. Findings and fixes

| ID | Severity | Finding | Fix |
|---|---|---|---|
| F1 | HIGH | `ProcessOutcome` settled only on the child's `close` event. A **detached** descendant that inherits stdout (e.g. a background daemon) holds the pipe after the child exits. The result then never settled, *even with `timeoutMs`*, because the timeout path also waited for `close`. Demonstrated against the baseline: still pending after 6 s with a 1 s timeout. | After `exit`, a bounded stdio drain (`stdioDrainMs`, default 2 s). If EOF does not arrive, Fusion destroys its pipe ends, records `StreamError`, and settles. |
| F2 | HIGH | Cancelling after the child had exited, but before `close`, ran `taskkill /PID <pid> /T /F` on a PID that Windows may already have **reused for an unrelated process**. | No PID-based signal is ever sent after `exit`; Fusion stops reading instead. Tree termination only runs while the root child is alive. |
| F3 | HIGH | A forced termination that did not stop the child left the result pending forever. | After forced termination, wait at most `killWaitMs` (default 5 s), then settle with `exitCode: null` and `termination.cleanupError`. A terminator that throws or hangs is itself bounded and recorded. |
| F4 | MEDIUM | An already-aborted `AbortSignal` still **spawned** the child, then killed it. | Pre-launch cancellation returns a typed `Cancelled` outcome without spawning (`pid: null`, `termination.method: "none"`). |
| F5 | HIGH | MSP reported a **timeout as `Cancelled`**, and an approval veto as a user cancellation. | Stop reasons are attributed: deadline → `Timeout` (retryable); negative approval / security stop → `SecurityViolation`; user/shutdown → `Cancelled`. A host-reported cancellation with no Fusion reason stays `Cancelled`. |
| F6 | HIGH | Muse Exec wrote evidence *before* classifying the outcome, so an I/O error masked `Timeout`/`Cancelled` as `InternalError`. Prompt-file deletion used `.catch(() => {})`, silently leaving delegated task text in `%TEMP%`. | The outcome is classified first and evidence I/O cannot mask it. Evidence is written only to a caller-owned directory. Cleanup retries transient Windows locks. A cleanup failure turns a success into a typed failure and is appended to an existing failure's message; it is never silent. |
| F7 | MEDIUM | Claude's auth probe ignored cancellation for up to 15 s. Plugin-preflight `Timeout`/`SpawnFailure` were reported as `CapabilityUnavailable`. A temp-settings cleanup error could mask the primary outcome. | The signal reaches every preflight child. Lifecycle issues keep their kinds. Preflight deadlines are capped by the turn deadline. Cleanup never masks the primary outcome. |
| F8 | HIGH | Provider JSON was parsed last-key-wins, so `{"result":{"status":"failed"},"result":{"status":"completed"}}` became **success**. Nesting depth was unbounded. JSONL framing rescanned the pending line on every chunk, which is O(n²) for byte-trickled output. | `parseStrictJson` rejects duplicate keys (including escaped spellings) and nesting beyond 64. It applies to every provider JSONL record, both result packets, Claude auth status, the plugin inventory, and settings. JSONL framing is linear. |
| F9 | MEDIUM | Invalid UTF-8 on **stderr** cancelled a healthy provider as a protocol error. Windows tools on non-UTF-8 code pages (e.g. German OEM output) make this realistic. | stderr is diagnostic only: malformed bytes become U+FFFD. Invalid UTF-8 on stdout (the protocol channel) remains a `ProtocolError`. |
| F10 | HIGH | Redaction missed `Authorization: Basic/Token/…` values, URL userinfo when the host had no TLD, `Cookie`/`Set-Cookie` headers, JSON-quoted `"apiKey": "…"`, and common credential formats. `redact()` could recurse infinitely on cycles. | The canonical `DiagnosticRedactor` was extended in place: header schemes, cookies, URL userinfo, quoted assignments, private keys, `sk-…`, GitHub/Slack/AWS/Google keys, JWTs. A depth bound (64) and cycle guard were added. No second redactor exists. |
| F11 | MEDIUM | `RunStore` created an untracked `.fusion/` in the user's repository, making `git status` dirty. A missing repository root threw a raw `ENOENT`. Settings, manifest and metrics used a stat-then-read with an unbounded read. Containment used a lowercased string-prefix check. | `.fusion/.gitignore` (`*`) is written with exclusive create, never replacing an existing file. The missing root is a typed `StorageError` with its cause retained. `readBoundedFile` enforces the limit on bytes actually read. Containment uses `path.relative` semantics per platform. |
| F12 | MEDIUM | MSP `cancel()` threw after host death, so it was not idempotent. `MuseAdapter.close()` left an Exec turn running. The long-lived MSP host buffered up to 64 MiB of stdout that is never read. | `cancel()` on an idle, dead or unknown session is a no-op. `close()` aborts the in-flight turn. The host's stdout is consumed as JSON-RPC and not retained (`retainStdout: false`); the byte ceiling still applies. |
| F13 | MEDIUM | No mapping existed from typed failures to user-facing text and exit status. | `src/cli/failure-presentation.ts` (§9). |
| F14 | LOW | Unexpected exceptions became `InternalError` with the cause discarded. | `FusionError.causeCode`: the error class plus errno/storage code only (e.g. `Error:EACCES`). Never a message. |

## 2. Failure taxonomy

| Kind | Meaning | Exit | Typically retryable |
|---|---|---|---|
| `InvalidInput` | Invalid cwd/argv/executable/environment or configuration | 2 | no |
| `BillingBlocked` | BillingGuard refused an API-key, gateway or provider override | 3 | no |
| `AuthMismatch` | Subscription authentication not confirmed | 3 | no |
| `ProviderIdentityMismatch` | Effective provider/model differs from the binding | 4 | no |
| `SecurityViolation` | Posture not confirmed, forbidden action vetoed, overage billing | 4 | no |
| `CapabilityUnavailable` | A required capability is not observed on this version | 5 | no |
| `SpawnFailure` | The native executable could not start | 5 | yes |
| `Timeout` | A Fusion-owned deadline stopped the work | 7 | yes |
| `Cancelled` | Stopped on request (user/shutdown/pre-launch) | 130 | no |
| `ProcessFailure` | The provider reported failure or exited non-zero | 6 | per provider |
| `ProtocolError` | Output violated its protocol, exceeded limits, or streams failed | 6 | no |
| `MalformedOutput` | The result packet was invalid, duplicated keys, or too deep | 6 | bounded Exec retry |
| `VerificationFailure` | Reserved for Fusion-run verification (later milestone) | 9 | no |
| `WorkspaceConflict` | Reserved for workspace leases (later milestone) | 8 | no |
| `InternalError` | Unexpected failure; `causeCode` identifies the class | 1 | no |

Storage failures map separately: `InvalidArtifactPath` is *path safety*, and every other storage kind is *storage*, exit 10.

A result is never contradictory. `completed` requires `output` and no error. `failed`/`cancelled` require an error. A late-cancelled result may carry its finished `output` as evidence but is still `cancelled`. Classification never infers cancellation or billing from an exit code alone.

## 3. Cancellation semantics

Cancellation uses the existing `AbortSignal` / `RunningProcess.cancel(reason)` primitives. No parallel framework was added; `raceAbort` only lets a caller stop *waiting* for work that cannot itself be cancelled.

| Case | Behavior |
|---|---|
| A. before spawn | The supervisor does not spawn. Transports check the signal before and between preflight steps. |
| B. child running | Graceful hook or stdin close, then grace, then tree termination. The first accepted reason wins. |
| C. stdin blocked | The pending write rejects when the pipe breaks. `stdinWriteStatus` records it. No unhandled rejection. |
| D. output streaming | Collected output stays within its limits. The outcome is `Cancelled`, not a truncation. |
| E. artifacts being written | Classification precedes evidence I/O. An evidence failure never replaces `Cancelled`/`Timeout`. |
| F. child exited, orchestration not finished | A cancellation observed before the result is returned wins (`cancelled`). For Muse Exec it lands in the post-run account attestation. |
| G. repeated/concurrent | `cancel()` returns the in-flight cancellation. Calls after settle, after exit, or on dead MSP hosts are no-ops. |

The `Cancelled` kind means only a request to stop. Timeouts, policy vetoes and output limits have their own kinds.

## 4. Timeouts and defaults

All deadlines use monotonic timers (`setTimeout`, `performance.now`). Wall-clock timestamps are for records only.

| Boundary | Default | Rationale |
|---|---|---|
| Supervisor `timeoutMs` | none; every caller passes one | long-lived hosts (MSP) have no deadline by design |
| Supervisor `graceMs` | 300 ms | time for a protocol stop or stdin EOF before force |
| Supervisor `stdioDrainMs` | 2 s | EOF normally follows exit within milliseconds; longer means a descendant holds the pipe |
| Supervisor `killWaitMs` | 5 s | bound on waiting for exit after tree termination |
| `taskkill` / terminator | 5 s (+1 s outer bound) | prevents a hung terminator from blocking settle |
| Claude turn | 120 s (`timeoutMs`) | one guarded one-shot turn |
| Claude auth / plugin list / init probe | 15 s / 15 s / 30 s, each capped by the turn deadline | preflight never outlives the turn it serves |
| Muse Exec attempt | 120 s | one-shot attempt, at most one malformed-output retry |
| MSP request / turn | 8 s / 120 s | request acknowledgement vs. whole turn |
| MSP stop / cancel wait / veto grace | 800 ms / 8×100 ms / 300 ms | orderly stop before a forced host kill |

If cleanup fails after a timeout, the timeout remains the reported kind and the cleanup failure is recorded in `termination.cleanupError`.

## 5. Windows process cleanup

- Children are native executables spawned with `shell:false`. `.cmd`/`.bat`/`.ps1` are rejected.
- While the root child is alive, cancellation uses `taskkill /PID <pid> /T /F`, falling back to a direct kill. `cleanupError` records any fallback.
- **After the root exits, no PID-based kill is sent**, because Windows reuses PIDs. Surviving descendants are handled by the stdio drain (§1 F1), never by guessing at PIDs.
- **Verified locally:** libuv places each Node process's *non-detached* children in its own kill-on-close Job Object. So if Fusion itself dies, its direct provider children are terminated by the OS, and a non-detached grandchild dies with its parent. That job permits silent breakaway and is a libuv implementation detail, not a Node API guarantee. Fusion does not rely on it for security.
- CTRL events are not used. stdin is destroyed when the outcome settles.
- **Limitations:** a *detached* descendant of a provider can outlive both the provider and Fusion. Fusion detects it (`StreamError` after the drain) but cannot terminate it safely without its own Job Object backend, which Node's built-ins do not expose. `taskkill` may be refused on restricted accounts or for processes owned by another user (e.g. sandbox users); the fallback reports a direct kill only. No unrelated process is ever targeted by name or by a possibly reused PID.

## 6. Provider-output limits

| Stream | Limit | Exceeded |
|---|---|---|
| stdout / stderr per provider child | 8 MiB / 2 MiB (MSP host: 64 MiB cumulative, not retained / 4 MiB) | child cancelled, `OutputLimit` → `ProtocolError` |
| JSONL record | 1 MiB, depth 64, no duplicate keys | `ProtocolError` (`lineTooLong`/`tooDeep`/`duplicateKey`) |
| Result packet (Claude result text, Muse terminal text) | strict JSON, depth 64, exact shape | `MalformedOutput` |
| Claude auth status / plugin list / init probe | 64 KiB / 1 MiB / 512 KiB | typed failure |
| Settings, manifest, metrics, version selector | 1 MiB / 1 MiB / 1 MiB / 256 B | typed failure, bounded read |

Hostile-output rules (tested per provider):
- Empty, whitespace-only, truncated, trailing-garbage, concatenated, primitive, deep, oversized and duplicate-key output **never becomes success**.
- Protocol data on stderr is ignored, so a missing protocol fails.
- Exit 0 with invalid protocol → `ProtocolError`.
- Non-zero exit with valid protocol → `ProcessFailure`.
- A "success" claim with missing fields → `MalformedOutput`.
- A contradictory result (`is_error` with `success`) → `ProcessFailure`.
- Error messages are static and never echo payload fragments.

## 7. Artifact and memory bounds

In-memory artifacts are capped at 4 MiB and streamed copies at 100 MiB, enforced during transfer. JSON artifacts are limited to nesting 20, event and index records to 1 MiB, and redaction depth to 64. Provider streams are decoded incrementally and truncated safely at byte ceilings. Truncation is always visible (`stdoutTruncated`/`stderrTruncated`), and the ceiling cancels the child rather than silently continuing. The default path persists no provider stream. Muse Exec evidence (a hash-only JSONL summary plus redacted stderr) is written only to a caller-owned directory.

## 8. Dirty-repository policy

Fusion M7 contains **no git operation**: no stash, reset, clean, checkout, commit, push, merge or rebase. Its only writes into a repository are under `.fusion/`, which ignores itself, and provider temporary files live in the OS temp directory.

Tests prove that `git status --porcelain` and every user file's content are unchanged by run creation, events, artifacts, a rejected write, metrics, and a failed-run manifest update. The states covered are:
- clean
- tracked-modified + staged + untracked
- conflicted index
- detached HEAD
- unborn branch
- linked worktree

A missing repository root, or a `.fusion` *file*, fails as a typed error and leaves the user file intact. Fusion does not invoke git, so "git unavailable" cannot change behavior. Submodule-specific behavior is untested (unsupported). Operations that will require a clean tree belong to the later `WorkspaceLease` milestone, which must fail with `WorkspaceConflict` rather than modify user work.

## 9. User-visible failure behavior

No CLI entrypoint exists yet (M8). `presentFailure(error, { debug })` is the contract the CLI will use. It returns a category, a stable exit code (§2), and at most three lines:
```
fusion: Timed out: Claude exceeded its deadline.
hint: The provider exceeded its deadline and was stopped; retry or raise the configured timeout.
retryable: yes
```
All text passes through the canonical redactor. Stack traces are never printed. `debug` adds only the safe cause code and the redacted underlying message. Unknown shapes are never trusted as typed failures and present as `InternalError`. `exitCodeForTurn` returns 0 only for `completed`.

## 10. Path-safety policy

Artifact destinations are Fusion-generated. Relative paths reject:
- absolute, drive-qualified (`C:x`), UNC and `//` forms
- `\` separators
- `.`/`..`/empty segments
- trailing dots or spaces
- control characters and Windows-reserved characters `<>:"|?*`
- device names with or without extensions: `CON`, `NUL`, `COM1–9`, `COM¹²³`, `LPT…`, `CONIN$`, `CONOUT$`, `CLOCK$`
- more than 512 characters

Containment is checked with `path.relative` per platform: case-insensitive on Windows, never a string prefix. Real-directory checks refuse symlinks and **junctions** (verified on Windows without privilege). A file where a directory is expected, a directory where a file is expected, a vanished file and a read-only index each fail as typed `StorageError`s, with the original filesystem cause available as `error.cause`. Node cannot open with a no-follow flag on Windows, so a concurrent actor replacing a checked path remains a documented TOCTOU window.

## 11. Secret and privacy guarantees

- Redaction is applied **before** persistence and presentation. `DiagnosticRedactor` remains the only redactor.
- Tests place the same synthetic secret in many forms and scan every persisted byte of a run directory for it: standalone, repeated, nested JSON, JSONL, URL userinfo, `Authorization` (Bearer/Basic/Token), `Cookie`, `token=`, quoted `apiKey`, a manifest label, provider evidence, an error cause, and presented text. No occurrence remains.
- Delegated task text is removed from Muse stderr evidence, and prompt files never survive an attempt.
- Account identity (e-mail, organization, account labels) is still never persisted. Normalized subscription quota remains allowed provider evidence.
- `causeCode` never includes messages or paths.

## 12. Explicitly unsupported

- Killing detached descendants of a provider (no Job Object backend)
- Git submodule edge cases
- Automatic repository cleanup of any kind
- Stack traces in user output
- Parsing JSON with duplicate keys
- JSON nesting deeper than 64 in provider output
- Non-UTF-8 provider stdout

## 12a. Post-M7 live-gate fix: Claude plugin quarantine convergence

The Claude CLI can load a plugin that none of Fusion's earlier startups reported. Several mechanisms change its effective plugin set *between consecutive startups*:
- remote feature flags cached for the next startup
- claude.ai account plugin sync
- marketplace auto-install

The disable set was computed from startups that run before the reviewer's startup: the plugin inventory and the discovery probe. A plugin materializing in between reached the reviewer's init, and the final assertion correctly refused it (`loaded-plugins:1`).

Quarantine now **converges on the reviewer's exact configuration**. After discovery, reviewer-shaped init-only startups (same argv plus the child-only `--settings`, cancelled at `system/init`, no turn) repeat until one reports no loaded plugin, at most 3 times. A newly loaded plugin is added to the child-only disable set only when its provenance is established:
- a built-in, by its runtime `@builtin` source
- an installed or account-synced plugin, which a refreshed `plugin list` must list

An unidentified plugin fails closed as `SecurityViolation`, as does a plugin that stays loaded after being disabled, or a set that keeps changing. The reviewer's own `system/init.plugins == []` remains the decisive assertion. Verification rounds are recorded in `pluginIsolation.verificationRounds`, and failures report plugin provenance classes (`builtin=`, `marketplace=`, `other=`), never names or paths. User and global Claude configuration are never modified.

## 13. Remaining known limitations

| Severity | Limitation |
|---|---|
| MEDIUM | No Windows Job Object backend: detached provider descendants can survive and are detected, not killed. |
| MEDIUM | `MuseAdapter` turn paths cannot be exercised with fixtures, because the web-tool capability is version-gated to the verified Muse release. Its `close()`-aborts-turn change is covered by review, not a test. |
| LOW | After a *failed* Claude turn, a failed removal of its temporary plugin-settings directory (plugin IDs only) is not reported separately. The primary failure wins. |
| LOW | Fusion's own storage files (manifest, events, metrics) use exact-shape validation but not the strict duplicate-key parser. |
| LOW | Process-outcome → failure-kind mapping exists in both provider transports, with provider-specific messages. |
| INFO | Process evidence stores unsalted hashes of local paths (pre-existing M6 design). |
| INFO | M7 behavior was verified only against fixtures. No live provider run was authorized, so whether real CLIs start detached daemons that hold stdio is unobserved. `npm run test:live` was not run. |
