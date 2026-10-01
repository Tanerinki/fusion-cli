# Fusion v0.6 Hyper-V PoC — THE SINGLE ELEVATED MAINTAINER RUN. Run this from an ADMIN PowerShell with Docker Desktop in
# WINDOWS-engine mode. It builds the worker image, provisions ONE Fusion-owned PoC network + listeners, starts the
# Hyper-V-isolated worker, discovers its endpoint, applies the endpoint-scoped broker-only ACL, runs the adversarial
# network canaries (with host positive controls) + the broker I/J route, checks process/forced-kill/stale cleanup, writes
# result-<RunId>.json, computes the verdict (verify.mjs), and ALWAYS cleans up its own resources in a finally block.
#
# It changes NO global firewall rule, NO existing network/switch/adapter, and installs nothing. Every created object
# carries the FusionV06Poc-<RunId> / fusion-hv-poc-img:<RunId> prefix. The only "network mutation" is an ACL on the
# worker's OWN ephemeral endpoint, which disappears with the container — there is no persistent host object to revert.
# UNTESTED on hardware. See docs/v0.6-hyperv-vfp-acl-plan.md for the exact objects, ACL JSON, rollback and Ctrl+C notes.
[CmdletBinding()] param(
  [ValidatePattern('^[A-Za-z0-9]{4,32}$')][string]$RunId = ("r" + [DateTime]::UtcNow.ToString('yyMMddHHmmss')),
  [string]$BrokerIp = '10.250.37.1',
  [string]$Subnet = '10.250.37.0/24',
  [switch]$KeepResources)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot

# --- Preflight (read-only): admin + Docker Windows engine + Hyper-V isolation. Fail closed with the exact fix. --------
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $admin) { throw "Run this in an ELEVATED (Administrator) PowerShell — endpoint ACL application needs it." }
$osType = (& docker info --format '{{.OSType}}' 2>$null)
if ("$osType".Trim() -ne 'windows') { throw "Docker is not in Windows-container mode (OSType=$osType). Switch: docker desktop engine use windows" }
$iso = (& docker info --format '{{.Isolation}}' 2>$null)
Write-Output "Preflight OK: admin=$admin, OSType=$osType, defaultIsolation=$iso, RunId=$RunId"

$token = ([guid]::NewGuid().ToString('N'))
$ok = $false
try {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'build-worker-image.ps1') -RunId $RunId
  if ($LASTEXITCODE -ne 0) { throw "image build failed" }
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'provision.ps1') -RunId $RunId -Subnet $Subnet -BrokerIp $BrokerIp -Token $token
  if ($LASTEXITCODE -ne 0) { throw "provision failed" }
  # Record the token into the provision file so run.ps1's canary can use it (provision wrote the rest).
  $provPath = Join-Path $here "provision-$RunId.json"
  $prov = Get-Content -Raw $provPath | ConvertFrom-Json
  $prov | Add-Member -NotePropertyName token -NotePropertyValue $token -Force
  [System.IO.File]::WriteAllText($provPath, ($prov | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'run.ps1') -RunId $RunId
  $ok = $true
} finally {
  if ($KeepResources) {
    Write-Output "KeepResources set — NOT cleaning up (inspect with ./inspect.ps1 -RunId $RunId, then ./cleanup.ps1 -RunId $RunId)."
  } else {
    Write-Output "== finally: cleanup (runs on success, failure, and after Ctrl+C-triggered termination) =="
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'cleanup.ps1') -RunId $RunId
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'inspect.ps1') -RunId $RunId
  }
}
if (-not $ok) { throw "PoC run did not complete; see output above. Evidence (if any) is in result-$RunId.json." }
Write-Output "Done. Evidence: result-$RunId.json. Verdict above is computed, never manual."
