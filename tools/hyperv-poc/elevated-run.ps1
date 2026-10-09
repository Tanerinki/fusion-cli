# Fusion v0.6 Hyper-V PoC - THE SINGLE ELEVATED MAINTAINER RUN. Run this from an ADMIN PowerShell with Docker Desktop in
# WINDOWS-engine mode. It builds the worker image, provisions ONE Fusion-owned PoC network + listeners, starts the
# Hyper-V-isolated worker, discovers its endpoint, applies the endpoint-scoped broker-only ACL, runs the adversarial
# network canaries (with host positive controls) + the broker I/J route, checks process/forced-kill/stale cleanup, writes
# result-<RunId>.json, computes the verdict (verify.mjs), and ALWAYS cleans up its own resources in a finally block.
#
# It changes NO global firewall rule, NO existing network/switch/adapter, and installs nothing. Every created object
# carries the FusionV06Poc-<RunId> / fusion-hv-poc-img:<RunId> prefix. The only "network mutation" is an ACL on the
# worker's OWN ephemeral endpoint, which disappears with the container - there is no persistent host object to revert.
# UNTESTED on hardware. See docs/v0.6-hyperv-vfp-acl-plan.md for the exact objects, ACL JSON, rollback and Ctrl+C notes.
[CmdletBinding()] param(
  [ValidatePattern('^[A-Za-z0-9]{4,32}$')][string]$RunId = ("r" + [DateTime]::UtcNow.ToString('yyMMddHHmmss')),
  [string]$BrokerIp = '10.250.37.1',
  [string]$Subnet = '10.250.37.0/24',
  [switch]$KeepResources)
$ErrorActionPreference = 'Stop'
# Resolve our own directory from $PSCommandPath (reliable under -File), fail closed, and use it as the explicit evidence
# directory for every child. Never rely on a child's implicit $PSScriptRoot default.
$here = [System.IO.Path]::GetDirectoryName($PSCommandPath)
if ([string]::IsNullOrWhiteSpace($here) -or -not (Test-Path -LiteralPath $here)) { throw "cannot resolve script directory (PSCommandPath='$PSCommandPath')" }
$here = [System.IO.Path]::GetFullPath($here)
Write-Output "SCRIPT_DIR=$here"
Write-Output "OUT_DIR=$here"

# --- Preflight (read-only): admin + Docker Windows engine + Hyper-V isolation. Fail closed with the exact fix. --------
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $admin) { throw "Run this in an ELEVATED (Administrator) PowerShell - endpoint ACL application needs it." }
$osType = (& docker info --format '{{.OSType}}' 2>$null)
if ("$osType".Trim() -ne 'windows') { throw "Docker is not in Windows-container mode (OSType=$osType). Switch: docker desktop engine use windows" }
$iso = (& docker info --format '{{.Isolation}}' 2>$null)
Write-Output "Preflight OK: admin=$admin, OSType=$osType, defaultIsolation=$iso, RunId=$RunId"

$token = ([guid]::NewGuid().ToString('N'))
$runVerdict = 'EXECUTION_ERROR'       # until run.ps1 completes and verify.mjs returns a code
$cleanupVerdict = 'INCOMPLETE'         # until cleanup.ps1 completes and cleanup-check.mjs returns a code
try {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'build-worker-image.ps1') -RunId $RunId
  if ($LASTEXITCODE -ne 0) { throw "image build failed" }
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'provision.ps1') -RunId $RunId -Subnet $Subnet -BrokerIp $BrokerIp -Token $token -OutDir $here
  if ($LASTEXITCODE -ne 0) { throw "provision failed" }
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'run.ps1') -RunId $RunId -OutDir $here
  # run.ps1 reserves: 0=PASS, 1=verified FAIL, 2=INCOMPLETE, 3=EXECUTION_ERROR (harness/infra, never a network FAIL).
  switch ($LASTEXITCODE) { 0 { $runVerdict = 'PASS' } 1 { $runVerdict = 'FAIL' } 2 { $runVerdict = 'INCOMPLETE' } 3 { $runVerdict = 'EXECUTION_ERROR' } default { $runVerdict = "EXECUTION_ERROR(exit=$LASTEXITCODE)" } }
} catch {
  $runVerdict = "EXECUTION_ERROR($($_.Exception.Message))"
} finally {
  if ($KeepResources) {
    Write-Output "KeepResources set - NOT cleaning up (cleanup proof NOT taken -> CLEANUP_VERDICT=INCOMPLETE). Inspect, then ./cleanup.ps1 -RunId $RunId."
  } else {
    Write-Output "== finally: cleanup + post-cleanup proof (runs on success, failure, and after Ctrl+C) =="
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'cleanup.ps1') -RunId $RunId -OutDir $here
    # cleanup.ps1 exits with cleanup-check's code: 0=clean, 2=not clean. Capture it INDEPENDENTLY of the run proof.
    switch ($LASTEXITCODE) { 0 { $cleanupVerdict = 'PASS' } 2 { $cleanupVerdict = 'FAIL' } default { $cleanupVerdict = "EXECUTION_ERROR(exit=$LASTEXITCODE)" } }
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'inspect.ps1') -RunId $RunId
  }
}
# The FINAL verdict requires BOTH proofs to PASS (owner.mjs pocFinalVerdict). A cleanup failure can NEVER be reported as
# a successful live result. Evidence is preserved in all cases.
$pocVerdict = & node (Join-Path $here 'owner.mjs') final "$runVerdict" "$cleanupVerdict"
Write-Output "RUN_VERDICT=$runVerdict"
Write-Output "CLEANUP_VERDICT=$cleanupVerdict"
Write-Output "POC_VERDICT=$pocVerdict (evidence: result-$RunId.json, cleanup-$RunId.json, owner-$RunId.json)"
Write-Output "BROKER_ONLY_NETWORK_BOUNDARY stays NOT_PROVEN unless POC_VERDICT=PASS and the evidence is reviewed; a real-provider Gate #2 is a separate authorization."
switch -regex ("$pocVerdict") { '^PASS$' { exit 0 } '^FAIL$' { exit 1 } '^INCOMPLETE$' { exit 2 } default { exit 3 } }
