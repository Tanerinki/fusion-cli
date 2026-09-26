# O5.5B6 Docker/Linux verification productionization

Labels: **OBSERVED** (measured on this machine in this milestone), **ENFORCED** (mechanically enforced by code and covered by deterministic tests), **INFERRED** (concluded from observation plus documented platform semantics), **UNSUPPORTED** (refused, fail closed), **FUTURE** (not done).

Outcome in one line: the O5.5B5 spike became a production-shaped verification component. Input reaches the container with **zero host mounts** (stdin stream), dependencies come from a separate, explicit, networked preparation stage as an immutable identity-bound artifact, verification itself stays network-less, platform semantics are real product data with fail-closed defaults, crash recovery is wired, backend selection refuses the trusted host for autonomous Writers, and a narrow acceptance authority can grant a **Linux-scoped** verification-isolation acceptance from mechanically observed evidence. The real Writer stays blocked; no provider was called.

## 0. Starting state and scope

Branch `o5-5b6-docker-productionization`, HEAD `e57e86a00c5562d951b1b6aaf716d5cabf1a1ac6`, clean tree (verified before any change). No AppContainer, Windows Sandbox, provider, UI or greenfield work; no Docker Desktop setting, WSL, Windows feature or privilege was changed; the validated image was kept; only Fusion-labelled containers were ever created or removed.

## 1. Architecture before / after

Before (O5.5B5): `DockerLinuxVerificationBackend` existed but was unregistered; the candidate was copied to a host run directory and **bind-mounted read-only**; the runner lived on that mount; no dependencies; the scavenger was a pure function; the platform requirement was an optional request field; readiness constants hard-wired `false`; `PrivateWriterWorkspace.verify` ran the reconstructed candidate as **host processes** (the only Writer verification path).

After (ENFORCED unless noted):

```
PrivateWriterWorkspace.verifyConfined            (autonomous Writer path; host verify() stays for human-approved flows only)
  reconstruct: fresh baseline clone + approved files only; committed dependency manifests read BEFORE candidate files land
  platform assessment: host declaration ⊕ deterministic signals (changed paths, their text, package.json) ⊕ model (escalate-only)
      │
VerificationService (selection.ts, technology-neutral)
  purpose autonomousWriter → only confined backends with declared platform semantics + needed dependency lane
  crash recovery once per backend per service (reported)
  optional explicit dependency stage (prepareDependencies)
  executeVerification (fail-closed lifecycle: probe → prepare → run → dispose)
      │
DockerLinuxVerificationBackend (docker/backend.ts)
  stdin: FUSIONB1 guest bundle (hash in argv) → FUSIONM1 manifest (hash in argv) → FTA1 source → gzip FTA1 deps
  container: no mount, no network, no caps, read-only root, uid 1000, limits, tmpfs only
  stdout: one strict result line, nonce- and input-digest-bound, cross-checked with the daemon exit status
      │
Acceptance authority (production.ts) — scoped, in-memory, never persisted
      │
writerGateReport (app/writer-gate.ts) — component-derived gate table; live gate constant false
```

No Docker conditional exists in the core workflow, provider adapters, risk engine, review logic or the ChangeSet contract. `app/diagnostics.ts` and `app/writer-gate.ts` consume the production composition (`production.ts`) as the application layer's composition root.

## 2. Threat model

Repository code, verification commands and their output are malicious; model output is untrusted; the Writer may try to change dependency manifests or claim a platform to reach a weaker environment. The attacker may try to: read host files or host paths, read or modify the candidate/primary on the host, reach the network, read credentials, forge the verification result, exhaust resources, leave processes or containers behind, poison the dependency cache, inject docker flags, or get a trusted-host fallback. Out of scope (NOT claimed): kernel or VM escapes, covert/timing channels to the shared Docker VM kernel, a compromised pinned image or npm itself, an attacker who already has write access to the user's profile/temp directory or Docker configuration.

## 3. Input transfer (zero host mounts)

- **Bootstrap** (ENFORCED): the container's command is fixed: `node -e <GUEST_BOOTSTRAP> <bundleSha256> <mode> <manifestSha256>`. The bootstrap (contains no backslash, so Windows argv quoting round-trips it) reads one `FUSIONB1` frame from stdin, refuses it unless SHA-256 equals the argv hash, writes `package.json {"type":"module"}`, `guest-runner.js` and `transfer-archive.js` into `/fusion/work/.fusion` (tmpfs, mode 0400) and calls `runGuest`. `assertSafeDockerArgs` requires that exact entry command after the image.
- **Manifest**: `FUSIONM1` frame, SHA-256 pinned in argv, parsed only in the runner's memory — never written to any filesystem. The run nonce therefore exists only in the runner's memory (INFERRED protection: Yama `ptrace_scope=1`, observed, blocks descendants from reading the runner's memory; `/proc/<pid>/fd/1` writes can still corrupt — not forge — the result).
- **FTA1 archive** (`transfer-archive.ts`, shared by host and guest): directories and regular files only; canonical relative POSIX paths (no absolute, drive, UNC, device, backslash, colon/ADS, control character, `.`/`..`/empty segment); parent declared before child; exact and case-insensitive duplicates refused; caps on entries, per-file and total bytes; raw-byte ceiling on the reader (expansion bombs stop at the bound); explicit end marker with count. Extraction creates one directory level at a time and opens files with exclusive create — nothing is overwritten and no link is ever created or followed.
- **Source**: planned from the Fusion-owned reconstructed candidate (root `.git` skipped; any `node_modules` segment refused; links and special files refused), digested, then streamed; the host re-hashes while sending and aborts on mismatch; the guest verifies each part's SHA-256 and byte count before any command runs; the result must echo the exact input digests.
- **Normal verification creates no host directory at all**; evidence collection alone creates one for a host-private synthetic marker that is never sent.

Remaining host mounts: **none**. OBSERVED: daemon `Mounts: []`, `HostConfig.Binds: null` for every container (fact `noHostMountsObserved`); the guest mount table has 27 entries, none from a host share (no `9p/drvfs/virtiofs/grpcfuse`, no `/run/desktop/mnt/host`, no Windows path; fact `mountTableHostPathAbsentObserved`); repository code probing `/proc/self/mountinfo` found no host path.

## 4. Dependency lane (two-stage trust model)

**Stage 1 — preparation** (`prepareDependencies`, explicit, never implicit in verification):
- Input: exactly `package.json` + `package-lock.json` bytes, read once, approved, validated, then streamed — no repository code is present in the container.
- Container: identical hardening (cap-drop ALL, no-new-privileges, read-only root, uid 1000, init, limits 4 GiB / 3 GiB tmpfs / 512 PIDs, no mount) **except** `--network bridge`, allowed by the argv guard only for a container labelled `fusion.mode=deps` whose fixed entry command is in `deps` mode.
- Command: the pinned image's npm (10.9.3) with the fixed argv `ci --ignore-scripts --no-bin-links --no-audit --no-fund --include=dev --registry=https://registry.npmjs.org/ --cache=/fusion/work/npm-cache --userconfig=<absent> --globalconfig=<absent> --update-notifier=false --install-links=false --strict-ssl=true --loglevel=warn --no-progress`, a fixed env (no host value, no token).
- Output: `node_modules` (no links allowed — `--no-bin-links`; a link fails the stage) as gzip FTA1, streamed back as bounded base64 lines, re-hashed by the host, structurally validated (full decode against caps), counts matched against the guest's declaration, then committed atomically.

**Stage 2 — verification** (network `none`): consumes a validated artifact copy-on-use (streamed after the source; the guest extracts its own private copy into `/fusion/work/src/node_modules`; tmpfs and memory grow by the same amount within fixed bounds). A missing artifact fails closed (`CapabilityUnavailable`); verification never triggers stage 1 by itself.

**Identity / cache** (ENFORCED): key = SHA-256 of the canonical `DependencyIdentity` = { policy version, `package.json` SHA-256, lockfile SHA-256, digest-pinned image (fixes Node 22.20.0 and npm 10.9.3), engine OS/arch, npm argv, acknowledged install-script packages }. On every use the store checks: entry name = record key = key recomputed from the record's identity = requested identity; artifact size and SHA-256 = record. Any mismatch evicts the entry (ownership-checked) and fails closed. The store is a marked Fusion-owned directory (default `<tmp>/fusion-dependency-store`); abandoned staging directories are removed by crash recovery.

**Eligibility — restricted V0.1 lane** (UNSUPPORTED otherwise, with stable codes): lockfile v2/v3 only; no `npm-shrinkwrap.json`; no npm workspaces; every package `resolved` must be a canonical `https://registry.npmjs.org/….tgz` URL (raw text must equal its parsed form — a deterministic test found that URL parsing would otherwise launder `..`) with a single `sha512` integrity; `inBundle` entries are covered by their parent; no `link: true`; no `file:`/`link:`/git/GitHub/http(s)/workspace specs in `package.json`; other package managers unsupported.

**Approval / self-authorization** (ENFORCED): the candidate's manifests must hash to the host-approved identity. `verifyConfined` derives it from the **committed baseline** (read before any candidate file lands); a ChangeSet touching any dependency control file (`package.json`, lockfiles, `.npmrc`, yarn/pnpm/bun files) is refused unless the host supplies an explicit approved identity. The primary checkout's `node_modules` is never read, copied or trusted.

**Native modules** (INFERRED + documented): the artifact is a Linux (glibc, x64) tree; prebuilt platform packages (e.g. `@esbuild/linux-x64`) install normally; Windows-native packages are not exercised and a Linux PASS says nothing about them.

## 5. Lifecycle-script policy

npm lifecycle scripts are **never** executed in V0.1 — not for dependencies, not for the root package. A package declaring install scripts (`hasInstallScript`, which includes implicit `binding.gyp` builds) makes the project ineligible unless the host explicitly acknowledges running it **without** its script; acknowledgement is part of the identity and never makes a script run. Root lifecycle scripts are reported as skipped. Rationale: install scripts are arbitrary code executed during a networked stage; running them would give untrusted code network access.

## 6. Platform-semantics policy

`core/policy/platform.ts`: `platform-neutral < linux-compatible < windows-required < unknown` (strictest wins). The host declares (`fusion.config.json` → `verification.platformRequirement`, or the caller); missing/invalid = `unknown`. Deterministic signals only escalate to `windows-required`: PowerShell/batch/WSH/registry/MSBuild-native/Windows binaries by path; `package.json` `os: ["win32"]` without Linux; Windows-only packages (`winreg`, `node-windows`, `winax`, `edge-js`, `node-powershell`, …); bounded file text for registry access, PowerShell invocation, NTFS ACL tools, Windows services, COM, Windows-only binaries, Win32 DLL names. A model suggestion is recorded and can only escalate. Docker/Linux accepts `platform-neutral` and `linux-compatible` only; `windows-required`, `unknown` and missing fail closed before any Docker call. `fusion doctor` shows declaration, effective requirement, signals and the backend's static eligibility. This is not universal platform classification; false positives only make verification refuse.

## 7. Crash recovery

`docker/sweeper.ts`, wired into `VerificationService` (once per backend per service, before first use; result in `recovery`). Only containers listed by the daemon's owner-label filter AND re-inspected individually AND carrying the complete ownership label set (owner, backend, 32-hex run id, known protocol 1/2, valid creation time) AND not a live run of this process AND older than the longest possible run (2 h default; a threshold below the 90-minute longest run is refused) by BOTH the daemon's creation time and Fusion's label are removed — with labels re-read immediately before `rm --force <64-hex id>` and removal confirmed by "no such container". Bounded (64 per sweep), idempotent, dry-run capable, ids-only reporting; unproven removal or unreadable listing ⇒ `complete: false`. Never prune, never images/volumes/networks. Abandoned dependency staging directories (> 2 h) are removed too.

## 8. Backend selection

`selection.ts` refuses with classified, stable codes and never falls back: `trusted-host-refused`, `platform-semantics-undeclared`, `platform-ineligible`, `platform-requirement-unknown`, `dependency-lane-unavailable`, and the probe's own reasons: `docker-cli-missing`, `docker-cli-failed`, `docker-daemon-unavailable`, `docker-engine-not-linux` (Windows-container mode), `docker-version-malformed`, `docker-image-not-present`, `docker-image-inspect-failed/-malformed`, `docker-image-digest-mismatch`, `docker-image-platform-mismatch`. Run-time failures stay typed: malformed/contradictory result → `MalformedOutput` report; host deadline → `Timeout`; incomplete cleanup → `SecurityViolation`; dependency artifact missing → `CapabilityUnavailable`; invalid artifact → `SecurityViolation`. The production backend set (`createProductionVerificationBackends`) does not contain the trusted host.

## 9. Runtime / image identity

`PRODUCTION_DOCKER_IMAGE = node@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e` (`node:22.20.0-bookworm-slim`, linux/amd64), `PRODUCTION_NODE_VERSION = v22.20.0`. Digest-only references; `--pull never`; the probe requires the local image id/RepoDigest to match, OS linux and architecture equal to the engine's; the guest reports `process.version`/platform/arch in every result and a different Node version is rejected. No other image is ever substituted. The image was not deleted.

## 10. Secret / environment policy

Container env is a fixed allowlist (`CONTAINER_VERIFIER_ENV`), nothing copied from the host. The docker CLI gets an allowlisted client env (no provider keys, tokens, SSH agent, `DOCKER_HOST`). The npm stage gets a fixed env and explicit config flags (user/global npmrc point at absent files; no `.npmrc` is ever sent). Canary probes (OBSERVED): 0 forbidden keys (incl. `ANTHROPIC_*`, `CLAUDE*`, `MUSE_*`, `OPENAI_*`, `SSH_*`, `GIT_CONFIG*`, `GIT_CREDENTIAL*`, `DOCKER_*`, `NPM_CONFIG_*`, proxies), 0 credential-shaped keys, 0 synthetic canary values across `process.env`, `/proc/self/environ`, `/proc/1/environ`; 0 `.ssh`/`.gitconfig`/`.git-credentials`/`.claude*`/`.npmrc`/`.docker/config.json` paths. Diagnostics name keys only.

## 11. Proof model

- `DOCKER_REQUIRED_EVIDENCE_FACTS` (45 narrow facts; 21 daemon, 20 guest, 4 host). Five O5.5B5 facts were superseded by strictly stronger ones because the input mount no longer exists (`SUPERSEDED_EVIDENCE_FACTS`); `yamaPtraceRestrictedObserved` (nonce secrecy relies on it) and `guestRuntimeIdentityObserved` became required. No required fact was weakened; no universal name (`isolation`, `secure`, `sandbox`) is used.
- `VerificationBackend.productionEligible` stays the constant `false`; `VERIFICATION_ISOLATION_ACCEPTED` (static acceptance) and `backendReadiness` stay `false`; the Windows-shaped `ConfinementProof` contract is unchanged.
- **Acceptance authority** (`production.ts`): grants `VerificationIsolationAcceptance` only if (1) the backend is an instance from `createProductionDockerBackend` (pinned image, real CLI, no test seam), (2) the evidence object was produced by that instance's own `collectEvidence` in this process (WeakMap brand), (3) all 45 facts passed, (4) image digest, engine OS/arch, guest Node version match, (5) the engine is the validated Docker Desktop Linux/WSL2 runtime, (6) evidence is ≤ 1 h old. The grant is a WeakSet-branded in-memory object (a copy or parsed JSON is not one); scope: "On this validated Docker Desktop Linux runtime, the docker-linux verification backend satisfies Fusion's V0.1 confinement contract for eligible platform-neutral and linux-compatible tasks"; `windowsAccepted: false`.

## 12. Live evidence (OBSERVED; `FUSION_DOCKER_LIVE=1 npm run test:docker-live`)

Docker Desktop 4.50.0, engine 28.5.1 linux/amd64, kernel 6.6.87.2-microsoft-standard-WSL2; image id `sha256:b21fe589…848e`.

| Check | Result |
| --- | --- |
| exact digest / Node | image id = pinned digest; guest `v22.20.0` (A: `node --version`) |
| source transferred | 6 files / 2 dirs / 2 179 B, archive digest echoed by the guest |
| `node --test` / piped child | `tests 3 pass 3`; `{"code":0,"out":"child-out","err":"child-err"}` |
| repository self-probe | `rootfs: EROFS`, `net: ENETUNREACH`, credential-like env keys `[]`, host path in mountinfo `false`, docker socket `false`, manifest on disk `false`, uid 1000 |
| evidence | 45/45 required facts `observedPass` (canary: 7 635 entries walked, 0 markers; 2/2 DNS and 3/3 TCP failed; `lo` only; seccomp 2; caps 0; cgroup 1 GiB / 2 CPU / 256 PIDs; PID probe limited at 244; 15 expected devices; `ptrace_scope 1`) |
| acceptance | granted, Linux scope, `windowsAccepted: false` |
| failing repo | `fail 1`, container exit 1, cross-check agreed |
| guest timeout / host timeout | `timeout` at 1.5 s; host wall clock rejected as `Timeout` after 5.9 s (4 s limit + awaited cleanup) |
| Windows-required | refused before any Docker call |
| dependency lane | real npm fixture (`is-number@7`, `is-odd@3` → nested `is-number@6`): 17 entries / 26 299 B / 6 239 B gz, npm 10.9.3, lifecycle scripts executed `false`; cache hit; network-less verification importing both passed; the artifact SHA-256 (`f9e7298d…328e`) was byte-identical across three independent preparations |
| cleanup | 0 Fusion containers, 0 evidence dirs, 0 stray Windows `node.exe` verifier processes; dry-run sweep found nothing |

## 13. Performance (OBSERVED, warm, one machine)

| Phase | O5.5B6 | O5.5B5 |
| --- | --- | --- |
| probe | 0.28–0.29 s | 0.30–0.37 s |
| host prepare (archive plan + digest, bundle) | 6–13 ms | 22–23 ms (copy to run dir) |
| `docker create` | 0.18–0.31 s | 0.19–0.20 s |
| attach (start + stdin transfer + extraction + commands) | 0.51–0.75 s | 0.76–0.77 s |
| — guest input extraction | 4–17 ms | 29–38 ms (copy) |
| inspect / ownership-checked removal | 0.09 s / 0.38–0.42 s | 0.09–0.11 / 0.41–0.43 s |
| verify total | 1.18–1.42 s | 1.46–1.51 s |
| dependency preparation (fresh, tiny fixture) | 2.1–2.7 s (npm 0.8–1.2 s) | — |
| dependency cache hit | 7–9 ms (re-hash of the artifact) | — |
| evidence collection | 7.2–7.4 s | 7.2–7.3 s |

Scratch probes: attach stdin ~22 MiB/s, stdout ~55 MiB/s; host deadlines assume ≥ 4 MiB/s. Large dependency trees (e.g. Next.js, hundreds of MB) will add transfer time per verification (FUTURE: measure, consider a pre-extracted per-identity snapshot).

## 14. Unsupported cases (fail closed)

Windows-required tasks; unknown/missing platform declarations; engines other than the validated Docker Desktop Linux/WSL2 runtime for acceptance (native Linux, rootless, remote daemons — `DOCKER_HOST` is never forwarded; a user-configured remote docker *context* is operator configuration and is not detected: FUTURE); npm workspaces, shrinkwrap, git/file/link/http dependencies, non-registry tarballs, packages that need install scripts (unless acknowledged to run without them), yarn/pnpm/bun; symlinked or special files in the candidate; a candidate `node_modules`; plans naming executables other than the image's node (no shells); tools that must write into a shared cache outside the tmpfs (they get their private copy only).

## 15. Remaining Windows limitation

A Linux PASS proves Linux behavior only. Windows paths, NTFS ACLs, PowerShell, registry, services, COM, Win32 APIs and Windows-native addons are unverified. There is still no confined Windows backend (AppContainer NOT_VIABLE; Windows Sandbox blocked on a disabled feature). Docker Desktop containers share the Docker VM kernel — no VM-grade or kernel-isolation claim is made.

## 16. Writer / readiness gates

`writerGateReport()` derives the table from components (live run with the acceptance):

| Gate | State | Remaining blocker |
| --- | --- | --- |
| primaryProtection | partial | fingerprints detect but cannot prevent transient host-side mutation by provider CLIs |
| hostControlledApplication | satisfied | offline only; no production Worker route calls it |
| providerChangeProposal | blocked | no production Worker route, no authorized real-provider proposal run |
| verificationIsolation | satisfiedForLinuxScope (with a granted acceptance; otherwise notEvaluated) | no Windows backend; Linux never implies Windows |
| platformCompatibility | satisfied | undeclared tasks stay unknown |
| dependencySupport | partial | restricted npm lane only |
| cleanupAndRecovery | satisfied | sweep runs at first service use, not on a schedule |
| reviewAndAdjudication | satisfied | — |
| billingAndAuthPosture | partial | not evaluated for Writer bindings (refused) |
| sharedGitAndIgnoredPaths | partial | change-author processes run on the host without an OS filesystem boundary |
| liveGateAuthorization | blocked | `REAL_WRITER_LIVE_GATE_AUTHORIZED` is a constant `false` |

`writerReadiness()` stays `ready: false` (`REAL_WRITER_MODE_NOT_READY`); `REAL_WRITER_MODE_BLOCKED_UNTIL` in `docs/o3-workflow.md` still holds.

## 17. Next milestone

Run 4 (recommended): wire `verifyConfined` into an offline, fake-provider **end-to-end Writer rehearsal** (proposal → host application → confined verification → fresh review → Lead adjudication) with the production composition, measured on a realistic dependency-heavy fixture (e.g. a TypeScript + test-framework project within the restricted lane), plus a decision on a persisted, re-verifiable dependency snapshot for large trees. Keep `REAL_WRITER_LIVE_GATE_AUTHORIZED` false until a separately authorized milestone.

## Decision

```
DOCKER_PRODUCTION_BACKEND: SUPPORTED
ZERO_HOST_MOUNT_INPUT: YES
DEPENDENCY_LANE_READINESS: YES   (restricted npm lane, §4–5)
LINUX_PLATFORM_VERIFICATION: YES
VERIFICATION_ISOLATION_READINESS: YES   (Linux scope only, from a per-process acceptance, §11)
PROVIDER_CHANGE_PROPOSAL_READINESS: NO
REAL_WRITER_MODE_READINESS: NO
O5_5B_READINESS: NO
O6_READINESS: NO
REAL_WRITER_LIVE_GATE_AUTHORIZED: NO
```
