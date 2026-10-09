# Fusion v0.6 Hyper-V PoC - preflight (CHANGES NOTHING). UNTESTED maintainer-run infrastructure.
# Detects prerequisites, prints exactly what a run would create, and STOPS with the exact elevated command if a feature is
# missing. It never enables features, reboots, or changes boot config. Run this FIRST.
[CmdletBinding()]
param([Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9]{4,32}$')][string]$RunId)
$ErrorActionPreference = 'Stop'
$prefix = "FusionV06Poc-$RunId"
function Line($k, $v) { "{0,-42} {1}" -f $k, $v }

Write-Output "== Fusion v0.6 Hyper-V PoC preflight (read-only) =="
$os = Get-CimInstance Win32_OperatingSystem
Write-Output (Line 'Windows' "$($os.Caption) $($os.Version)")
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
Write-Output (Line 'Administrator context' $admin)
$virt = (Get-CimInstance Win32_ComputerSystem).HypervisorPresent
Write-Output (Line 'Virtualization / hypervisor present' $virt)

# Feature states (do NOT enable them here).
$features = @{}
foreach ($f in 'Microsoft-Hyper-V', 'Microsoft-Hyper-V-All', 'Containers') {
  try { $features[$f] = (Get-WindowsOptionalFeature -Online -FeatureName $f -ErrorAction Stop).State } catch { $features[$f] = 'Unknown' }
  Write-Output (Line "Feature: $f" $features[$f])
}
# Existing HNS networks + collisions (read-only).
$hns = @(); try { $hns = Get-HnsNetwork -ErrorAction Stop | Select-Object -ExpandProperty Name } catch { Write-Output (Line 'HNS module' 'unavailable (HostNetworkingService)') }
Write-Output (Line 'Existing HNS networks' ($hns -join ', '))
$collision = $hns | Where-Object { $_ -like "$prefix*" }
Write-Output (Line 'PoC-name collisions' ($(if ($collision) { $collision -join ', ' } else { 'none' })))

Write-Output ""
Write-Output "== This run WOULD create (all prefixed '$prefix-') =="
foreach ($r in 'net (HNS network, L2Bridge/Overlay)', 'endpoint (worker vNIC)', 'acl (VFP egress: ALLOW broker IP:port; DENY all else)',
  'worker (Hyper-V isolated Windows container)', 'broker/wrongport/unrelated/lan (host listeners)', 'scratch/canary (temp dirs)', 'log') {
  Write-Output "  - $prefix-$r"
}
Write-Output "  Base image: (determined by provision.ps1 - reported before any pull; Docker Desktop is NOT an architectural dependency)"

# STOP conditions - report exact commands; never act.
$missing = @()
if (-not $admin) { $missing += 'Run this in an ELEVATED (Administrator) PowerShell.' }
if ($features['Microsoft-Hyper-V-All'] -ne 'Enabled') { $missing += 'Enable Hyper-V:  Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -All   (a reboot may be required; do it yourself)' }
if ($features['Containers'] -ne 'Enabled') { $missing += 'Enable Containers:  Enable-WindowsOptionalFeature -Online -FeatureName Containers -All   (a reboot may be required; do it yourself)' }
if (-not $virt) { $missing += 'Enable hardware virtualization in firmware/BIOS (SLAT + VT-x/AMD-V).' }
if ($missing.Count -gt 0) {
  Write-Output ""
  Write-Output "== PREREQUISITE GATE - do these ONCE yourself, then re-run preflight (the harness will not) =="
  $missing | ForEach-Object { Write-Output "  * $_" }
  exit 2
}
Write-Output ""
Write-Output "Preflight OK. Next: ./inspect.ps1 -RunId $RunId ; then (elevated) ./provision.ps1 -RunId $RunId"
exit 0
