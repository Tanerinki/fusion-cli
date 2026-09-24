# O5.5B5 hardened Docker/Linux verification backend (prototype)

Labels: **OBSERVED** (measured on this machine), **IMPLEMENTED** (added this milestone), **INFERRED** (concluded from observation plus documented platform semantics), **NOT_PROVEN** (not established by evidence), **FUTURE** (recommended later).

Outcome in one line: a real local spike on Docker Desktop's Linux engine ran stock Node 22.20.0, piped child stdio and standard process-isolated `node --test` inside a hardened, network-less, capability-less, read-only container, and every one of the 42 required narrow confinement facts was observed passing. **`DOCKER_CONFINEMENT_SPIKE: VIABLE`** — "worth productionizing for Linux-compatible verification", nothing more. No readiness flag changed.

## 1. Starting state (OBSERVED)

Branch `o5-5b5-docker-verifier`, HEAD `f9335b827a0e82250db355a0ae8bd281f132e030` ("feat: harden runtime and verification boundaries"), clean working tree, verified before any change. The AppContainer (`NOT_VIABLE`) and Windows Sandbox (`INCONCLUSIVE`) research branches are not merged here.

## 2. Docker inventory (OBSERVED, read-only)

| Item | Value |
| --- | --- |
| Windows | 11 Pro, `10.0.26200.8655` |
| Docker CLI | 28.5.1 (build e180ab8), `C:\Program Files\Docker\Docker\resources\bin\docker.exe` |
| Docker Desktop | 4.50.0 (209931) |
| Engine | 28.5.1, API 1.51, containerd 1.7.27, runc 1.2.5, docker-init 0.19.0 |
| Server OS / arch | `linux` / `amd64` (Linux container mode) |
| Kernel | `6.6.87.2-microsoft-standard-WSL2` (WSL2 backend; distro `docker-desktop`, running, v2) |
| Context | `desktop-linux` (`npipe:////./pipe/dockerDesktopLinuxEngine`) |
| cgroup / security | cgroup v2 (`cgroupfs`), `seccomp` builtin profile, `cgroupns`; storage `overlayfs` with the containerd image store |
| Resources | 16 CPUs, ~15.6 GiB |
| Node images present | `node:24-alpine`, `node:20-alpine` — not 22.20.x and musl-based, so not used |

Many unrelated user images and containers exist (compose projects, immich, n8n, …). None was touched: every Fusion query and removal is scoped by Fusion labels. No Docker setting, context, container mode, WSL or Windows feature was changed.

## 3. Threat model

Repository code and verification commands are malicious. They may try to read host files, modify the mounted source, read provider/Git/SSH credentials or environment, use the network, fork-bomb or exhaust memory/CPU, write outside scratch, leave processes behind, or forge the verification result. The backend removes these capabilities mechanically; nothing relies on prompt instructions. Container escape research, kernel exploits and host DoS were explicitly out of scope and not attempted.

Accepted inherent limit (INFERRED): untrusted tests decide their own pass/fail — a malicious test file can always make itself "pass". The result channel therefore protects *Fusion* (bounded, strict, identity-bound, cross-checked), while the semantic integrity of the tests remains the fresh Reviewer's and Lead's job.

## 4. Backend architecture (IMPLEMENTED)

`src/platform/verification/docker/` implements the O5.5B4 `VerificationBackend` contract (`probe → prepare → run → collectProof → dispose`, plus the new optional `collectEvidence`). No Docker logic entered the core workflow, provider adapters, risk policy, Writer model or review logic.

| File | Role |
| --- | --- |
| `config.ts` | Digest-pinned image policy, resource limits, hardened `docker create` argv builder, `assertSafeDockerArgs` guard, Docker client env allowlist, ownership labels, future scavenger selection |
| `cli.ts` | `DockerCommandRunner` seam; `CliDockerRunner` spawns the native `docker.exe` via `ProcessSupervisor` (argv, `shell:false`, deadlines, bounded output); strict parsers for `version`, image and container inspect |
| `bundle.ts` | Fusion-owned run directory with ownership marker; candidate snapshot copy (no links, no `.git`, bounded) |
| `protocol.ts` | Host→guest manifests; strict decoders for untrusted guest results; `node --test` count parser |
| `guest-runner.ts` | In-container runner (Node built-ins only): `verify`, `canary`, `descendant`, `hang` modes |
| `backend.ts` | `DockerLinuxVerificationBackend` |

Generic additions (provider- and technology-neutral):
- `platform-compat.ts` — `VerificationPlatformRequirement` (`platform-neutral | linux-compatible | windows-required | unknown`) and `platformEligibility`. `VerificationExecutionRequest.platformRequirement` and `VerificationBackend.platformSemantics` are optional; `executeVerification` refuses a semantics-limited backend for a missing/`unknown`/incompatible requirement before any Docker call. Backends without declared semantics (the trusted host backend) are unaffected.
- `backend-evidence.ts` — `BackendEvidence`: backend-named narrow facts with `source` (`daemon | guest | host`), states derived from attempt/failure counts, `productionEligible: false` constant.
- `verifier-environment.ts` — `buildContainerVerifierEnvironment()` and shared `assertNoCredentialKeys`.

The backend is `confinement: "osSandbox"`, `platformSemantics: "linux"`, `productionEligible: false`, and is **not registered** in the default backend registry: it is constructed explicitly with a pinned image. `collectProof()` returns `undefined`: the Windows-shaped O5.5B3 `ConfinementProof` (registry/profile facts) is deliberately not forced onto Docker.

## 5. Exact container controls (IMPLEMENTED; OBSERVED via `docker inspect`)

```
docker create --pull never --name fusion-<mode>-<runId>
  --label fusion.owner=true --label fusion.backend=docker-linux --label fusion.run=<runId>
  --label fusion.protocol=1 --label fusion.created=<ISO time>
  --network none
  --cap-drop ALL
  --security-opt no-new-privileges=true
  --read-only
  --user 1000:1000
  --memory 1073741824 --memory-swap 1073741824      (no extra swap)
  --cpus 2
  --pids-limit 256
  --ipc private --cgroupns private
  --init                                            (docker-init reaps descendants)
  --log-driver none                                 (untrusted output never fills daemon log storage)
  --ulimit core=0:0
  --hostname fusion-verifier
  --tmpfs /fusion/work:rw,nosuid,nodev,exec,size=512m,uid=1000,gid=1000,mode=0700
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=128m,uid=1000,gid=1000,mode=0700
  --mount type=bind,source=<run>\input,target=/fusion/input,readonly
  --workdir /fusion/work
  --entrypoint /usr/local/bin/node                  (no shell anywhere)
  --env <fixed container verifier env>
  node@sha256:<digest> /fusion/input/runner.mjs <mode>
```

Never present: `--privileged`, `--cap-add`, `--device`/`--gpus`, `-v/--volume`, `--volumes-from`, host `--pid/--ipc/--uts/--userns/--network`, `--publish`, `--env-file`, `-e KEY` (value-less forwarding), the Docker socket, `seccomp=unconfined`/`apparmor=unconfined`. Docker's default seccomp and AppArmor profiles stay in force (OBSERVED: `Seccomp: 2`, non-empty `MaskedPaths`). `assertSafeDockerArgs` independently refuses all of the above plus any subcommand outside `version, image inspect, container inspect, create, start, wait, kill, rm, top, ps` — so `system prune`, `volume prune`, `rmi`, `pull`, `exec` can never be issued. Limits are bounded host policy (`resolveLimits`), overridable only within fixed ranges.

No user namespace remapping (Docker Desktop default): container uid 1000 is uid 1000 inside the Docker Desktop VM (INFERRED; not a host Windows identity).

## 6. Mount / data-flow model (IMPLEMENTED; OBSERVED)

```
<tmp>\fusion-docker-XXXXXX\           Fusion-owned, marker file .fusion-docker-run = <runId>
  input\        → /fusion/input (READ-ONLY bind; the ONLY host path visible in the verify container)
    runner.mjs, manifest.json, src\ (candidate snapshot)
  canary-input\ → /fusion/input for evidence containers only (runner, canary.json, canary\readable.txt)
  private-sibling\fusion-canary-<hex>.txt   host-private marker, never mounted
```

- The private candidate and the primary repository are never mounted. The candidate is copied into `input\src`: regular files and directories only; `.git` excluded; a symlink or junction fails the run closed (never followed); bounded at 20 000 entries / 32 MiB per file / 256 MiB total.
- Inside the container the runner copies `/fusion/input/src` to tmpfs `/fusion/work/src` and runs there. Writable in the container: `/fusion/work` (tmpfs, 512 MiB: the working copy, `HOME=/fusion/work/home`, XDG config/cache) and `/tmp` (tmpfs, 128 MiB, `noexec`). Everything else is read-only; nothing writable persists to the host.
- **There is no writable host mount at all.** The result returns on the runner's attached stdout (`docker start --attach`, bounded at 256 KiB + 1; exceeding it is a rejection). This is strictly stronger than a writable OUTPUT directory: an untrusted test running as the same uid could otherwise fill the host disk or plant files there. Consequently canary 4 ("container can write dedicated OUTPUT") is **not applicable by design**; the stronger property "no writable host mount" is daemon-observed instead.
- The host fingerprints `input\` before and after the verify run; any change turns every step into `mutationViolation`.

## 7. Result protocol (IMPLEMENTED)

Guest output is untrusted. `decodeVerifyResult` requires: ≤ 256 KiB; strict JSON (duplicate keys and depth > 4 rejected); `protocolVersion` 1 (other versions are `ProtocolError`); closed shape at every level (unknown or missing keys rejected — so no environment or path dump can ride along); `mode: "verify"`; the run nonce; `complete: true`; commands exactly the planned ids in plan order; only the last executed command may have failed and a passing last command means nothing was skipped; `exitCode` 0–255 or null, signal `SIG[A-Z0-9]+`, exited-status exclusivity; per-command duration ≤ its timeout + 1 s; summed guest durations ≤ host-measured attach time + 1 s; output tails ≤ 8 KiB / 4 KiB with every control character except tab/newline replaced by the guest (ESC/C1 rejected by the host). Then the backend cross-checks a daemon-observed fact: the container exit code must be 0 exactly when every command passed (1 otherwise). A runner that fails before producing a result surfaces only a stable `fusion-runner-error:<code>`; no raw stderr is reported. The nonce binds a result to a run; it is **not** an authenticity proof against code inside the container (NOT_PROVEN and not claimed).

Canary results (`decodeCanaryResult`) are closed-shape booleans, bounded counts, validated interface/device names and cgroup values — no free text.

## 8. Runtime matrix (OBSERVED, real Docker)

Image `node@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e` (`node:22.20.0-bookworm-slim`, linux/amd64). One hardened container, zero-dependency disposable repository:

| Step | Command | Result |
| --- | --- | --- |
| A | `node --version` | passed, `v22.20.0` |
| B | `node scripts/hello.mjs` | passed, `hello from linux node v22.20.0` |
| C | `node scripts/spawn-pipe.mjs` (`child_process.spawn`, piped stdout+stderr) | passed, `{"code":0,"out":"child-out","err":"child-err"}` |
| D | `node --test` (stock process isolation; no `--experimental-test-isolation=none`) | passed, TAP `tests 3, pass 3, fail 0` |

A failing repository (one wrong assertion) reported `failed`, exit code 1, counts `pass 2 fail 1`, container exit 1 — the cross-check agreed. The AppContainer blocker (libuv named-pipe creation) does not exist here: Linux pipes are ordinary kernel pipes.

## 9. Canary results (OBSERVED; synthetic canaries only)

Canaries run in fresh Fusion-only containers with the identical configuration; no repository code runs in them.

| # | Canary | Evidence | Result |
| --- | --- | --- | --- |
| 1 | read mounted INPUT | guest read `canary/readable.txt` token | pass |
| 2 | cannot modify read-only INPUT | create and overwrite both refused; host fingerprint of the canary input unchanged | pass |
| 3 | write internal scratch | `/fusion/work`, `/tmp`, `$HOME` write+read | pass |
| 4 | write dedicated OUTPUT | not applicable: no writable host mount exists (daemon: `noWritableHostMountObserved`) | n/a by design |
| 5 | primary repository not mounted | daemon: exactly one bind, source = run input; guest: synthetic primary-repo marker not found | pass |
| 6 | host-private sibling unreachable | guest walk of the container filesystem (7 633 entries, complete) found 0 of the synthetic markers (sibling, primary repo, profile `.ssh`, Git credential, provider auth state) | pass |
| 7 | provider credential markers absent | host process had synthetic `fusion-canary-…` values in `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CLAUDE_CONFIG_DIR`, `MUSE_TOKEN`, …; guest saw 0 forbidden keys, 0 credential-shaped keys, 0 canary values across `process.env`, `/proc/self/environ`, `/proc/1/environ`; daemon env keys ⊆ allowlist ∪ image keys | pass |
| 8 | Git/SSH markers absent | `SSH_AUTH_SOCK`, `GITHUB_TOKEN`, `GIT_ASKPASS`, `GIT_CONFIG_GLOBAL` absent; 0 of `.ssh`, `.gitconfig`, `.git-credentials`, `.config/gh`, `.claude*`, `.npmrc`, `.docker/config.json`, `.aws`, `.azure` under three homes | pass |
| 9 | Docker socket absent | 0 known socket paths, 0 sockets named `*docker*` in the walk; daemon: no socket mount | pass |
| 10 | network fails | see §10 | pass |
| 11 | descendant contained and removed | see §11 | pass |
| 12 | resource limits effective | see §12 | pass |

Also observed: uid/gid 1000; `NoNewPrivs: 1`; `Seccomp: 2`; `CapInh/Prm/Eff/Bnd/Amb` all zero; writes to `/home/node` and `/` fail with `EROFS` (read-only rootfs, not merely permissions); `/dev` has exactly the 15 expected entries; Yama `ptrace_scope = 1` (informational fact). Three directories were unreadable to uid 1000 during the walk (e.g. `/root`); markers cannot be there because the daemon-observed mount set contains only `/fusion/input`.

## 10. Network evidence (OBSERVED — narrow claim)

- daemon: `NetworkMode: none`;
- guest: interfaces exactly `["lo"]`, 0 IPv4 routes, 0 non-loopback IPv6 routes;
- guest: 2/2 DNS lookups failed (`example.com`, `host.docker.internal`); 3/3 TCP connects failed (`1.1.1.1:443`, `8.8.8.8:53`, Docker Desktop's host gateway `192.168.65.254:80`).

Claim proven: *the container had no non-loopback interface or route, and the sampled DNS and TCP attempts failed.* Not claimed: a universal proof that no covert channel exists (e.g. timing channels to the host, or the shared VM kernel) — NOT_PROVEN.

## 11. Process containment (OBSERVED + INFERRED)

The `descendant` guest started a marked `node -e setInterval(…) fusion-descendant-<hex>` child in its own process group and waited. The daemon's `docker top` listed the marked child; the host then `docker kill`ed the container, the daemon reported it stopped, `docker top` refused (not running), ownership-checked `rm --force` removed it, and `docker top` answered "No such container". On the Windows host, 0 `node.exe` processes had a command line containing `/fusion/input/runner.mjs` or `fusion-descendant-` (container processes live in the Docker Desktop VM, never as Windows processes). INFERRED from Linux PID-namespace semantics: when the container's init exits, every process in the namespace is killed. Verify mode additionally kills each command's process group after it exits and at its deadline, so orphans cannot outlive their step. Killing the attached `docker` client does **not** stop a container (OBSERVED in the manual spike), so the host always stops containers explicitly.

## 12. Timeout and resource controls (OBSERVED)

- Guest per-command deadline: a `setInterval` command with a 1.5 s timeout ended `timeout` after 1 510 ms.
- Host deadline: a never-ending guest was not finished by its 2 s host deadline, the host `docker kill`ed it, the daemon reported it stopped, and it was removed (fact `hostDeadlineTerminationObserved`). Through `executeVerification({ timeoutMs: 4000 })` a hanging command was rejected as `Timeout` after 5.7–5.9 s (two runs) including probe, create and the awaited cleanup; no owned container or run directory remained.
- Memory: daemon `Memory = MemorySwap = 1073741824`; guest `memory.max = 1073741824` (metadata only; no memory DoS was attempted).
- CPU: daemon `NanoCpus = 2000000000`; guest `cpu.max = 200000 100000`.
- PIDs: daemon `PidsLimit = 256`; guest `pids.max = 256`; a harmless probe started 244 `sleep` children before the kernel refused (the runner's own threads count against the limit), then killed them all.
- The verify runner stops at the first failing command; `--log-driver none` prevents unbounded daemon log growth.

## 13. Environment / credential evidence (IMPLEMENTED; OBSERVED)

- Container env is fixed and forwards **no** host value — not even PATH: `PATH, HOME, TMPDIR, XDG_CONFIG_HOME, XDG_CACHE_HOME, LANG, NO_COLOR, CI, GIT_TERMINAL_PROMPT=0, GIT_OPTIONAL_LOCKS=0`. The image adds `NODE_VERSION`, `YARN_VERSION`; Docker adds `HOSTNAME`. Verification commands receive only the fixed manifest env.
- The docker **client** process itself gets an allowlist (`PATH, PATHEXT, SYSTEMROOT, WINDIR, SYSTEMDRIVE, TEMP, TMP, TMPDIR, USERPROFILE, HOME, APPDATA, LOCALAPPDATA, PROGRAMDATA, PROGRAMFILES, XDG_RUNTIME_DIR` + `DOCKER_CLI_HINTS=false`), so provider credentials, tokens, SSH agents and `DOCKER_HOST` never reach it (a remote daemon would otherwise receive the bundle).
- Diagnostics expose key names only; no value was enumerated or logged. Tests assert a synthetic secret never appears in any docker argv, manifest or report.

## 14. Cleanup (IMPLEMENTED; OBSERVED)

Per container: labels are read back from the daemon and must match **every** Fusion ownership label for this run before `rm --force`; removal is confirmed by "No such container". Per lease, `dispose` removes remaining owned containers, sweeps `ps --all --filter label=fusion.run=<runId>` (label-filtered, never name-based), and removes the run directory only if it is a direct child of the base, carries the prefix, is not a link and holds the marker with the run id. Anything unproven is left in place and cleanup reports incomplete, which `executeVerification` turns into a `SecurityViolation`. `dispose` first waits (bounded, 90 s, timer always cleared) for an aborted run to finish its own kill/remove. Before and after the live test, `docker ps -a --filter label=fusion.owner=true` was empty and no `fusion-docker-*` directory remained. No image, volume or network was removed; no prune was run.

## 15. Ownership labels (IMPLEMENTED)

`fusion.owner=true`, `fusion.backend=docker-linux`, `fusion.run=<32 hex>`, `fusion.protocol=1`, `fusion.created=<ISO>`. `isFusionOwned` requires all of them (the run id and creation time well-formed); a container merely named `fusion-*`, or carrying some Fusion labels, is foreign.

## 16. Crash-recovery limitations

IMPLEMENTED (pure, not wired): `selectScavengeableContainers(records, now, minAge)` selects only 64-hex ids with all ownership labels and a `fusion.created` older than `minAge` (≥ 1 minute). NOT_PROVEN: no scavenger runs; after a host crash, containers (usually already stopped) and `fusion-docker-*` directories may remain until a FUTURE startup scavenger removes them with the same label/marker proofs.

## 17. Dependency limitation (NOT_IMPLEMENTED, deliberate)

The proof uses a zero-dependency repository. Real projects need `node_modules`, `npm ci`, native addons and toolchains. The verifier never gets network, so it must never run `npm install`. FUTURE options: (A) host-prepared immutable dependency snapshot added to the read-only bundle; (B) a separate dependency-preparation phase with its own, different policy (network to a registry allowlist, no repository scripts or `--ignore-scripts`, output hashed); (C) a prebuilt, digest-pinned project/toolchain image; (D) a controlled cache/artifact service. A, B and C compose; D is the most operational weight. `/fusion/work` is mounted `exec` so a future snapshot with `.bin` shims and native binaries can run.

## 18. Platform limitation (IMPLEMENTED as a capability limit)

A DockerLinux PASS proves Linux behavior only. It does not prove Windows filesystem semantics, NTFS ACLs, Windows paths, PowerShell, Win32 APIs or Windows-specific native addons. `platformSemantics: "linux"` accepts `linux-compatible` and `platform-neutral` only; `windows-required`, `unknown`, a missing or an invalid requirement fail closed before any Docker call. No automatic repository platform detection was added (no reliable minimal signal exists yet); the requirement is host-declared.

## 19. Performance (OBSERVED, one machine, warm; range over two live runs)

| Phase | Time |
| --- | --- |
| One-time image pull (`node:22.20.0-bookworm-slim`) | 13.9 s — not steady state |
| Probe (`version` + image inspect) | 0.30–0.37 s |
| Host bundle build (prepare) | 22–23 ms |
| `docker create` | 0.19–0.20 s |
| Attach total (container start + guest copy + commands) | 0.76–0.77 s |
| — guest input copy | 29–38 ms |
| — commands A–D | 258–263 ms (`node --test` 151–154 ms) |
| Inspect | 0.09–0.11 s |
| Ownership-checked removal | 0.41–0.43 s |
| **Verify total** | **1.46–1.51 s** (≈ 1.2 s container overhead over the commands) |
| Evidence collection (canary 1.8–1.9 s, descendant 1.5 s, 2 s-deadline probe 3.8 s, sweep 0.1 s) | 7.2–7.3 s — spike/evidence only, not per verification |

## 20. OpenHands comparison (bounded; read-only snapshot `software-agent-sdk` v1.49.5 `5b36cacc`)

OpenHands `DockerWorkspace` runs `docker run -d --platform linux/amd64 --rm --ulimit nofile=65536:65536 --name agent-server-<uuid>` with forwarded env (default `DEBUG`, `SESSION_API_KEY`, `OH_SESSION_API_KEYS_0`), user `-v` volumes, a published port for its in-container agent server, optional `--network`/`--gpus all`, and cleans up with `docker stop` (+ `--rm`) and optionally `docker rmi -f` of the image.

- **BORROWED IDEA:** a uniform workspace lifecycle behind one abstraction (start → ready → use → cleanup in a finally/exit path); invoking the docker CLI with an argv list; checking `docker version` before starting; unique per-run container names; explicit platform.
- **DIFFERENT SECURITY REQUIREMENT:** OpenHands' container hosts an *agent* that needs the network, an API port and a writable workspace. Fusion's container hosts *untrusted verification* that needs none of these; its result returns on bounded stdout, so it can run with no network, no ports and no writable host mount.
- **INTENTIONALLY REJECTED DEFAULTS:** forwarding session/API keys into the container; writable host volume mounts of the workspace; published ports and default bridge networking; floating image tags (docs examples use `:latest`); no capability drop, read-only rootfs, no-new-privileges or memory/CPU/PID limits; cleanup by name/id without ownership proof; `docker rmi -f` (could delete a shared, pre-existing image); `--gpus all`.

## 21. Deterministic tests (IMPLEMENTED)

`test/o5-5b5-docker-backend.test.ts` (34 tests) uses `test/fixtures/fake-docker.ts`, an in-memory CLI+daemon that applies the production `assertSafeDockerArgs` to every argv and derives its `inspect` answers from the real `create` argv. Covered: CLI missing; daemon unavailable; non-Linux engine; malformed and duplicate-key server responses; absent / wrong-OS / wrong-digest / wrong-id image and "never pulls"; digest-only image policy; full argv construction (no privileged, no host network, cap drop, no-new-privileges, no socket, read-only single input mount, no writable host mount, limits, labels); zero provider credentials in container env, client env, manifest and every argv; guard refusals (privileged, host namespaces, cap-add, volumes, socket, unconfined, value-less `-e`, prune/rmi/pull/exec); the CLI runner refuses unsafe argv before spawning; plan validation (no shells, allowlisted executables, relative cwd, bounds); platform eligibility (linux-compatible/neutral allowed; windows-required/unknown/missing refused before any Docker call); passing lifecycle with cleanup; `.git` exclusion; junction refusal; failing command mapping; missing / malformed / duplicate-key / wrong-nonce / unknown-field / oversized / output-limit / exit-contradiction / wrong-command results; runner error codes without raw stderr; a later failing probe cannot break an existing lease; host deadline and wall-clock timeout with explicit kill + removal; changed read-only input → `SecurityViolation`; cleanup failure fails closed; foreign and name-only containers are never removed; scavenger selection; run-directory ownership; daemon facts reflect the argv and a weakened container fails them; partial/missing/duplicated evidence is never complete; no universal claim names; readiness stays false/false and the Writer gate closed; verify/canary protocol strictness; test-count parsing; inspect parsing keeps key names only; the compiled guest imports only `node:` built-ins and runs nothing when imported; the live test is opt-in and outside the `npm test` glob. Normal `npm test` never needs Docker.

## 22. Live tests (IMPLEMENTED; OBSERVED)

`test/live/docker.live.test.ts`, run with `FUSION_DOCKER_LIVE=1 npm run test:docker-live` (it self-skips otherwise and compiles to `dist/test/live/`, outside `dist/test/*.test.js`). It requires the pinned image locally and never pulls. Result: 1/1 passed in two separate runs (21.6–21.7 s; the second on the final code) — runtime matrix A–D, complete evidence (42/42 required facts `observedPass`, `productionEligible: false`), failing repository, guest timeout, host wall-clock timeout, Windows-required refusal, no owned container or run directory left, 0 stray Windows `node.exe` verifier processes. No provider call; the primary repository is never touched.

## 23. Known gaps

- **Host path disclosure (OBSERVED):** `/proc/self/mountinfo` inside the container shows the Windows source path of the input bind (including the Windows account name) and that Docker Desktop serves it over 9p/drvfs. Low sensitivity, but untrusted output could echo it into evidence. FUTURE: stream the bundle over stdin into tmpfs and remove the bind entirely.
- **Shared VM kernel:** all containers share the Docker Desktop WSL2 VM kernel; a kernel exploit is out of scope and NOT_PROVEN either way. No user-namespace remapping.
- **Same-uid tampering inside the container:** repository code runs as the runner's uid and could interfere with the runner's stdout (Yama `ptrace_scope=1` blocks attaching to the runner, but `/proc/<pid>/fd` writes are not excluded). Worst case is a rejected result or a forged "pass", equivalent to a malicious test passing itself; the exit-status cross-check narrows it.
- **Candidate copy TOCTOU:** the host copy uses `lstat` then `copyFile` (Windows has no `O_NOFOLLOW` in Node); acceptable only because the private candidate is Fusion-owned and quiescent during prepare.
- **Pinned image freshness:** digest pinning freezes the image including its CVEs; a FUTURE policy must rotate digests deliberately.
- Docker Desktop licensing/availability, rootless engines and remote daemons were not evaluated; `DOCKER_HOST` is deliberately not forwarded.
- Evidence collection costs ~7 s; it is a spike/audit step, not a per-verification step.
- The backend is not wired into any workflow, CLI command or registry.

## 24. Decision

```
DOCKER_ENGINE_RUNTIME: SUPPORTED
NODE_RUNTIME: SUPPORTED
PIPE_STDIO_RUNTIME: SUPPORTED
NODE_TEST_RUNTIME: SUPPORTED
DOCKER_CONFINEMENT_SPIKE: VIABLE
VERIFICATION_ISOLATION_READINESS: NO
REAL_WRITER_MODE_READINESS: NO
O5_5B_READINESS: NO
O6_READINESS: NO
REAL_WRITER_LIVE_GATE_AUTHORIZED: NO
```

`VERIFICATION_ISOLATION_ACCEPTED` remains the constant `false`; `backendReadiness` stays `false/false`; the Writer gate is unchanged.

## 25. Recommended next step

Productionize the Linux lane in small, separately reviewed steps: (1) replace the input bind with a stdin-streamed bundle (removes the mountinfo disclosure and the last host mount); (2) design the dependency lane (A + B, then C) under its own policy; (3) a label/marker-scoped startup scavenger; (4) wire `platformRequirement` declaration into task intake so `unknown` stays the fail-closed default; (5) only then a separate milestone to decide whether this evidence may satisfy the `verificationIsolation` prerequisite for Linux-compatible tasks. Windows-required verification still needs a Windows backend (Windows Sandbox remains blocked on a disabled feature).
