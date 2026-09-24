# O5.5B4 runtime and verification boundary hardening

Labels: **OBSERVED** (measured / already true in the tree), **IMPLEMENTED** (added this milestone), **INFERRED** (concluded from inspection), **NOT_IMPLEMENTED** (deliberately deferred), **FUTURE** (recommended later).

## 1. Starting state (OBSERVED)

Branch `o5-5b4-runtime-hardening` at HEAD `9753bbd291ad08c21d0754f0bc6fd6f867725cc1` ("feat: add verification confinement proof contract"), working tree clean. Verified before any change. This branch forks from the proof-contract commit and does **not** contain the AppContainer or Windows Sandbox research branches; none were merged or cherry-picked.

## 2. OpenHands snapshot inspected (OBSERVED)

Read-only, via a research snapshot outside the repository. Verified HEADs match `SNAPSHOT.txt`:
`software-agent-sdk` `5b36cacccc2bbe6f8fbce9e1d3ff4b0a3dcddadb` (v1.49.5), `OpenHands` `b0906809b3e8777491519c386d55ce32d7f4daa4` (1.23.0), `docs` `70eaba29…`. Nothing was modified, installed, or executed; no source text was copied. Independent Fusion-native implementations only.

## 3. Ideas borrowed (INFERRED → IMPLEMENTED)

- **One typed provider profile as a single source of truth**, with an explicit auth-lane enum and capability facts resolved rather than hardcoded (OpenHands `LLM` pydantic model + `ModelFeatures`). Fusion equivalent: `src/runtime/provider-profiles.ts`.
- **Least-privilege subprocess environment.** OpenHands scopes secrets by name-scanning the command; Fusion goes further with a strict **allowlist** for verifiers.
- **Uniform workspace/execution abstraction with a shared lifecycle** across Local/Docker/Remote backends (OpenHands `BaseWorkspace`, factory selecting the concrete type). Fusion equivalent: `src/platform/verification/backend.ts`.
- **Deterministic security rails as the authority, model risk advisory, fail-closed on analyzer error** (OpenHands `EnsembleSecurityAnalyzer` = deterministic rails ∪ LLM, worst-case). Fusion already matches this (`risk.ts` deterministic + authoritative).
- **Bounded output, startup/idle/total timeouts, graceful→hard kill of the whole process group** (OpenHands PTY backend). Fusion already matches this (`ProcessSupervisor`).

## 4. Ideas explicitly rejected (OBSERVED in OpenHands → NOT adopted)

- **Denylist environment (`sanitized_env`).** A new secret leaks unless someone remembers to add it to the denylist. Fusion uses allowlists for both provider children (BillingGuard) and verifiers (this milestone).
- **`get_all_secrets_as_env_vars()` — dumping the whole secret registry into a subprocess.** Their own docstring flags it as deferred debt. Fusion never gives a verifier any secret and never gives a provider a generic "all secrets" environment.
- **`NeverConfirm` / yolo auto-approve as a first-class selectable policy.** Fusion has no auto-approve mode; the risk gate is deterministic and authoritative.
- **Shared-workspace / broad-forward fallback** (e.g. `DockerWorkspace.forward_env` forwarding session keys by default). Fusion maps nothing by default and forwards zero provider credentials to verifiers.
- **Prompt-only read-only guarantees / provider-owned filesystem mutation.** Unchanged Fusion invariant: read-only provider → structured ChangeSet → Fusion validates → Fusion applies to a private candidate.

## 5. ProviderProfile architecture (IMPLEMENTED)

`src/runtime/provider-profiles.ts` declares frozen, provider-neutral descriptors (`ProviderProfile`) for `claude` and `muse`: id, display name, adapter kinds, per-transport `structuredTurns` and compatibility, auth lanes, executable basename, state-directory strategy, and an environment-rules factory. Lookups: `providerProfile(id)` (undefined for unknown, never a fabricated default), `profileForAdapterKind`, `transportProfile`, `isValidatedRuntimeVersion`.

- **Provider-neutral core preserved (OBSERVED):** the module lives in the provider/runtime layer; `src/core/**` does not import it, so no provider name reaches routing or policy. Existing adapters and the registry are unchanged, so current Claude/Muse behavior is preserved.
- **Honest compatibility (IMPLEMENTED):** `validatedRuntimeVersions` lists only releases actually verified (`2.1.280` for Claude one-shot, `1.3.0-R3401.1` for Muse Exec); the Muse MSP transport is `unconstrained` — no version claim invented. A consistency test binds these to the authoritative adapter constants so drift is caught.
- **Reduces duplication where safe:** it centralizes the static provider facts as one source of truth guarded by a test, rather than rewriting the working adapters to read from it (which would risk regressions for no functional gain).

## 6. Auth / secret scope (IMPLEMENTED)

Two boundaries, both allowlist-based and fail-closed:

- **Provider children (OBSERVED, pre-existing):** `BillingGuard` + `EnvironmentRuleSet` (`src/core/policy/billing-guard.ts`, rules in `src/runtime/provider-environment-rules.ts`) classify every env key ALLOW/STRIP/BLOCK, block conflicting API/gateway/base-URL/third-party sources, strip unrelated credentials, and never turn subscription auth into API-key auth. A provider receives only its own lane's variables; a BLOCK fails the whole environment. Values are never logged (`SafeChildEnvironment.forSpawn()` is the only value path; `toJSON()` exposes key names only).
- **Verifiers (IMPLEMENTED):** `src/platform/verification/verifier-environment.ts` `buildVerifierEnvironment(source, runtimeRoot)` returns a strict allowlist — `PATH/Path/PATHEXT/SystemRoot/WINDIR` forwarded, `TEMP/TMP/HOME/USERPROFILE/APPDATA/XDG_CONFIG_HOME` redirected into the disposable Fusion-owned runtime root, `GIT_TERMINAL_PROMPT=0`/`GIT_OPTIONAL_LOCKS=0` injected — and **zero** provider credentials, API keys, or SSH/Git credentials. A credential/provider marker surviving into the result fails closed as defense in depth. The returned `summary` names keys only, never values. `PrivateWriterWorkspace.verify` now uses this shared boundary in place of an inline object, so any future verifier caller inherits the same guarantee.

## 7. Process lifecycle findings (OBSERVED, audited against the research)

`ProcessSupervisor` (`src/platform/process/supervisor.ts`) already satisfies the lessons; per the milestone these are recorded and covered by existing tests (`process.test.ts`, `m7-process.test.ts`) rather than rewritten:

| Lesson | State |
| --- | --- |
| `shell:false`, direct executable spawn | OBSERVED |
| Bounded stdout / stderr (8 MiB / 2 MiB defaults) | OBSERVED |
| Startup / total / idle-drain / kill-wait timeouts | OBSERVED |
| Cancellation, incl. before launch and during a partial JSONL frame | OBSERVED |
| Graceful (stdin/hook) → taskkill `/T` (tree) → direct SIGKILL fallback | OBSERVED |
| Descendant cleanup (Windows tree kill; POSIX process group) | OBSERVED |
| cwd validated absolute + real directory at start | OBSERVED |
| cwd **revalidated immediately before each verifier step spawns** | OBSERVED (`engine.ts`) |
| env keys/values rejected for NUL; malformed UTF-8 stdout is a protocol error | OBSERVED |
| Redaction before durable logging (`DiagnosticRedactor`, artifact/event stores) | OBSERVED |
| Provider identity/version readback before trusting a turn | OBSERVED (`assertRuntimeEvidence`) |

**Provider ephemeral-state isolation (NOT_IMPLEMENTED, deliberate):** relocating Claude/Muse state/cache per run would risk turning working subscription auth into a broken or API-key lane, and no live provider call is in scope to prove it safe. Auth state stays provider-managed. The **verifier** side already gets per-run isolation (HOME/TEMP/config redirected to the disposable root). Provider per-run cache isolation is FUTURE, gated on a provider that documents a safe cache-vs-auth split.

## 8. VerificationBackend architecture (IMPLEMENTED)

`src/platform/verification/backend.ts` defines a provider-independent, technology-independent contract — it names no AppContainer/Sandbox/Docker mechanism. Lifecycle: `probe → prepare → run → collectProof → dispose`, with `VerificationBackend`, `VerificationBackendProbe`, `VerificationLease`, `VerificationExecutionRequest`, `VerificationExecutionResult`, `VerificationCleanupResult`. `executeVerification` runs the lifecycle and **fails closed** on an unavailable backend, a run error or wall-clock timeout, and incomplete cleanup (disposal is always attempted; an unverified teardown is never reported as success).

Safety invariants hard-wired here:
- `VERIFICATION_ISOLATION_ACCEPTED = false` — no backend, however complete its confinement proof, is accepted for production isolation this milestone, so missing/partial proof also fails closed.
- `TrustedHostBackend` (the only registered implementation) is `confinement: "none"` and `productionEligible: false`; it runs the existing engine against a caller-owned workspace with a least-privilege verifier environment and produces **no** confinement proof. `backendReadiness()` returns `verificationIsolationEligible:false, productionEligible:false` for every backend, including a fake one that lies about OS sandboxing and carries a fabricated "complete" proof. It reuses the confinement proof *type* conservatively and makes no proof authoritative. Nothing here touches the Writer gate.

## 9. Build hygiene fix (IMPLEMENTED)

`scripts/clean-dist.mjs` removes exactly `<repoRoot>/dist` before every build; `package.json` `build` is now `node scripts/clean-dist.mjs && tsc`, and `test` depends on `build`. Deterministic across branch switches: `tsc` never prunes orphaned emit, so a compiled test from another branch previously ran under `npm test`; now the output tree is rebuilt from scratch every time. The cleaner is repository-scoped and explicit — it refuses a directory without `package.json`, refuses a symlinked/non-directory `dist`, and touches nothing else. A test plants a stale compiled test and asserts the clean step removes it.

## 10. Supply-chain findings (OBSERVED)

- `package-lock.json` present and used; `npm ci`-compatible.
- Dependencies are dev-only and exact-pinned: `typescript 5.9.3`, `@types/node 22.20.1`. No `^`/`~`, no `latest`, no runtime deps.
- No `npx`/unpinned package execution in scripts. No network in build or test.
- Provider launcher/runtime versions are treated as data: validated releases are explicit constants surfaced through `ProviderProfile`; unknown bounds are `unconstrained`, not guessed. No automatic upgrades, no speculative dependencies, no invented version ceilings were added.

## 11. Security implications (INFERRED)

Attack surface narrows: verifiers (untrusted repository code) now provably receive no provider or user credential through a single tested boundary; the verification backend abstraction fails closed on every unsafe path and cannot be tricked into production/Writer eligibility; stale compiled code can no longer execute under test. No readiness flag becomes more permissive. No new network path, provider call, or broad environment inheritance was introduced.

## 12. Migration / backward compatibility (OBSERVED)

Additive. No public behavior changed: existing adapters, registry, config, risk, review, workspace and verification semantics are untouched; the only wiring change (`PrivateWriterWorkspace.verify` using `buildVerifierEnvironment`) preserves the exact prior key set (private-writer and host-change suites pass unchanged). Build/test commands are the same names.

## 13. Tests (IMPLEMENTED)

`test/o5-5b4-provider-profiles.test.ts`, `test/o5-5b4-verifier-environment.test.ts`, `test/o5-5b4-verification-backend.test.ts`, `test/o5-5b4-build-hygiene.test.ts` cover: known/unknown provider, capability & auth-lane lookup, frozen profiles, profile↔adapter consistency; verifier gets only allowed synthetic vars, provider/secret markers removed by key and value, redirection, diagnostic-safe summary, invalid root; backend unavailable/unknown/incomplete-cleanup/run-error/timeout/invalid-timeout fail closed, fake cannot set productionEligible, host backend delegates and produces no proof; and a stale dist artifact removed by the clean step. Mutation checks confirmed the verifier-redirect and every backend fail-closed path are actually enforced (a disabled check fails a test).

## 14. Remaining blockers (OBSERVED)

No confinement backend exists; verification isolation is unproven and `VERIFICATION_ISOLATION_ACCEPTED` stays false. Real Writer mode, O5.5B, O6 and the live Writer gate remain closed. Provider per-run cache isolation and cross-platform provider-credential file permissions (a Windows gap OpenHands leaves open) are unaddressed.

## 15. Next milestone recommendation (FUTURE)

Implement one confined `VerificationBackend` on a viable substrate and have it emit the confinement proof, then decide deliberately whether a reviewed complete proof may flip `VERIFICATION_ISOLATION_ACCEPTED`. Separately, evaluate name-scoped task-secret injection (only if a task-secret concept is introduced) and event parent/child identifiers.

### Event / resource-lock scope (FUTURE, no code this milestone)

OpenHands attaches a `parent_id` to every event (an event tree) and serializes parallel tool use with per-resource FIFO locks acquired in sorted order. Fusion's `RunId`/`StepId` already identify runs and steps and could carry a parent step id later to support branch/replay reasoning without an EventStore rewrite. Concrete future value: parent/child event links for review-cycle replay; per-lease resource locks only if a real concurrency correctness bug appears (none observed — one writer per isolated lease already serializes writes).

## OpenHands lesson → Fusion decision

| OpenHands lesson | Fusion decision | Implemented now? | Reason |
| --- | --- | --- | --- |
| One typed LLM/provider profile as source of truth | `ProviderProfile` registry (data, provider-neutral core) | Yes | Centralizes static facts; test-guarded against drift |
| Capabilities resolved (override→discovered→fallback), never null an explicit false | Kept adapter capability logic; profile records validated versions honestly | Partial | Adapters already resolve capabilities; profile adds honest compat data without a risky rewrite |
| Denylist subprocess env (`sanitized_env`) | Allowlist for provider children and verifiers | Yes (verifier boundary added) | Allowlist can't leak a newly-added secret |
| Name-scan secrets into a command; else dump all | Verifiers get zero secrets; no "all secrets" path exists | Yes | Least privilege by construction |
| Uniform workspace ABC + Local/Docker/Remote lifecycle | `VerificationBackend` probe/prepare/run/collect/dispose | Yes | Prepares future confined backends without core change |
| Deterministic rails ∪ LLM, worst-case, fail-closed | Deterministic risk gate authoritative; model risk advisory | Yes (already true) | Matched; no rewrite needed |
| Bounded output + graceful→hard process-group kill | `ProcessSupervisor` already provides it | Yes (already true) | Audited and recorded, not rewritten |
| `NeverConfirm` / yolo policy | Not adopted | No | Auto-approve is an anti-pattern for Fusion |
| Forward session keys into sandbox by default | Map nothing; zero provider creds to verifiers | Yes | Avoids credential exposure |
| Windows credential-file perms left as a warning | Noted as a gap; Fusion stores no provider creds itself | No | Providers own their auth store; revisit if Fusion ever persists one |
| Event `parent_id` tree + per-resource FIFO locks | Documented for later; identifiers already exist | No (FUTURE) | Priority is Writer safety, not history/UI; no concurrency bug observed |
| Provider state dir isolation per session | Verifier state isolated per run; provider state left provider-managed | Partial | Relocating provider auth risks breaking subscription lane; deferred until safe |
