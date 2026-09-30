# Fusion v0.6 — Hyper-V isolated-worker PoC harness (UNTESTED, maintainer-run)

> **UNTESTED UNTIL MAINTAINER REAL-OS EXECUTION.** This harness is *evidence-generation infrastructure only*. Its existence
> is **NOT** evidence that Hyper-V / HNS / VFP satisfies the v0.6 HARD boundary. Only a real run on a Windows host with
> administrator rights produces evidence, and only the computed verdict (`verify.ps1` → `evaluator.mjs`) counts. The PowerShell
> scripts here were authored without a Hyper-V host to run them on; **expect to adapt them to your host.** The provider is a
> **fake**; no real model call, credentials, or quota are involved.

This harness implements the bounded Option-C PoC from `docs/v0.6-hyperv-poc-plan.md` (and the spike
`docs/v0.6-network-isolation-spike.md`). It is completely separate from the production HARD backend; no production routing
depends on it.

## What it tests (mechanically, on your host)

Whether a Hyper-V-isolated Windows worker can satisfy **every** existing v0.6 HARD invariant:
- **Network:** the worker reaches ONLY the dedicated Fusion broker endpoint (a host/vSwitch IP:port, **not** 127.0.0.1);
  wrong port, host loopback, LAN, Internet, and a direct provider-endpoint bypass are all DENIED — proven with **real
  sockets** (timeouts are never counted as a deny; positive controls distinguish blocked vs. unreachable).
- **Filesystem:** view read-only, scratch read/write, and primary/sibling/journal/delivery/host-profile/unrelated all denied
  — proven with real opens/writes against disposable secret canaries, not mount metadata.
- **Process tree:** fake provider → child → grandchild all die on completion/cancel/timeout/forced-termination; worker
  disposed; no orphan process/VM.
- **Ephemerality:** a second run inherits no filesystem/network/mount/process state from the first.
- **Cleanup/idempotency/safety:** only `FusionV06Poc-<runId>-*` resources are ever created or removed.

## Safety (read before running)

- `preflight.ps1` changes **nothing**; it only detects Windows edition/version, admin context, Hyper-V + Containers feature
  state, virtualization support, existing HNS networks, name collisions, and base-image availability, and prints the exact
  resources the run intends to create.
- Every created resource carries the unique prefix `FusionV06Poc-<runId>` (HNS networks, endpoints, workers, VFP/firewall
  objects, temp dirs, mounts, broker listeners, logs). `cleanup.ps1`/`inspect.ps1` touch **only** names carrying that exact
  prefix — never an unrelated HNS network, Hyper-V switch, container, or firewall rule. (The match logic is unit-tested in
  `test/v06-hyperv-poc-evaluator.test.ts` via `evaluator.mjs` `isPocResource`/`selectForCleanup`.)
- The harness **never** enables Windows features, reboots, or changes boot configuration automatically. If a required feature
  is off, `preflight.ps1` STOPS and prints the exact one-time elevated command for you to run yourself.
- It **never** uses `127.0.0.1` as the intended allowed destination (that is the loopback problem I14 documented).
- Prefer native HCS/HNS mechanisms. Docker Desktop must not become an architectural trust dependency; if a runtime is used
  only as temporary PoC plumbing, that is labelled explicitly.

## Verdict is computed, never manual

`verify.ps1` invokes `evaluator.mjs` (`evaluate`), which returns **PASS** only if every positive control succeeded AND every
required negative boundary was mechanically demonstrated DENIED AND every lifecycle check PASSed. Any UNKNOWN/missing field →
**INCOMPLETE** (UNKNOWN is never promoted to PASS). Any broken boundary → **FAIL**. A human does not decide the verdict.

## Maintainer procedure

1. **Prerequisites** — Windows 11 Pro/Enterprise (or Server) with Hyper-V isolation support; administrator shell. Run
   `./preflight.ps1` first — it changes nothing and tells you exactly what is missing and the exact elevated command to
   enable it (a **separate, explicit first gate** — the harness never does this for you). If a reboot is needed, do it
   yourself and re-run preflight.
2. **Inspect** — `./inspect.ps1` lists any stale `FusionV06Poc-*` resources (deletes nothing).
3. **Provision** — `./provision.ps1 -RunId <id>` (elevated) creates the PoC HNS network + VFP egress ACL + worker + the
   host-side broker/wrong-port/unrelated/LAN canary listeners, all `FusionV06Poc-<id>-*`. Idempotent where practical.
4. **Run** — `./run.ps1 -RunId <id>` launches the fake provider inside the worker and executes the network/FS/process matrix,
   twice (for ephemerality), collecting a machine-readable `result-<id>.json`.
5. **Verify** — `./verify.ps1 -RunId <id>` computes the verdict (`PASS`/`FAIL`/`INCOMPLETE`) and writes the human report.
6. **Negative self-test** — `./run.ps1 -RunId <id> -BreakRule wrongPortDeny` intentionally removes one boundary in a
   disposable run; the verdict MUST become FAIL (proving the harness can catch an escape). The run restores the clean state.
7. **Cleanup** — `./cleanup.ps1 -RunId <id>` removes exactly this run's PoC resources; works after a partially failed run.

Expected duration/resources are reported by `preflight.ps1` (base-image pull dominates the first run).

## Interpreting the result

- **PASS** → the Hyper-V worker mechanically satisfied every boundary. Proceed ONLY through a focused production-backend
  architecture proposal (no integration before this).
- **FAIL** → a boundary was breached. **STOP. Do not weaken HARD.**
- **INCOMPLETE** → something was not proven. Not a PASS. Resolve and re-run.

No production Hyper-V backend integration happens before a clear mechanical PASS. No real provider call; no v0.6 release; no
v0.7.
