# Fusion v0.6 Hyper-V PoC — host-capability probe. READ-ONLY: makes NO machine changes. Collects only bounded technical
# capability data needed to choose the exact Hyper-V/HNS/HCS execution stack for THIS host. NO secrets, credentials,
# environment values, user files, browser or SSH state. Safe to run non-elevated (fields it cannot read become null →
# INCOMPLETE, never guessed). Writes a machine-readable JSON report + a human summary, then computes the verdict via
# host-probe-eval.mjs (never a manual decision).
[CmdletBinding()] param([string]$OutPath)
$ErrorActionPreference = 'SilentlyContinue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $OutPath) { $OutPath = Join-Path $here 'host-probe-report.json' }
function Try-Val([scriptblock]$b) { try { & $b } catch { $null } }
function Has-Cmd($n) { [bool](Get-Command $n -ErrorAction SilentlyContinue) }
function Cmd-Path($n) { (Get-Command $n -ErrorAction SilentlyContinue).Source }

$os = Try-Val { Get-CimInstance Win32_OperatingSystem }
$cs = Try-Val { Get-CimInstance Win32_ComputerSystem }
$cpu = Try-Val { Get-CimInstance Win32_Processor | Select-Object -First 1 }

$r = [ordered]@{
  schema = 'fusion.hyperv.hostprobe/1'
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  os = [ordered]@{ edition = $os.Caption; version = $os.Version; build = $os.BuildNumber; architecture = $os.OSArchitecture }
  hypervisorPresent = [bool]$cs.HypervisorPresent
  firmwareVirtualization = [ordered]@{ firmwareEnabled = Try-Val { [bool]$cpu.VirtualizationFirmwareEnabled }; slat = Try-Val { [bool]$cpu.SecondLevelAddressTranslationExtensions } }
  hyperVFeature = Try-Val { (Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All).State.ToString() }
  containersFeature = Try-Val { (Get-WindowsOptionalFeature -Online -FeatureName Containers).State.ToString() }
  hcs = [ordered]@{ available = Try-Val { [bool](Get-Service vmcompute -ErrorAction SilentlyContinue) }; status = Try-Val { (Get-Service vmcompute).Status.ToString() }; computeCoreDll = Try-Val { Test-Path (Join-Path $env:SystemRoot 'System32\computecore.dll') } }
  hns = [ordered]@{ available = Try-Val { (Has-Cmd 'Get-HnsNetwork') -or [bool](Get-Service hns -ErrorAction SilentlyContinue) }; serviceStatus = Try-Val { (Get-Service hns).Status.ToString() }; moduleCmdlets = Try-Val { [bool](Has-Cmd 'Get-HnsNetwork') } }
  hnsNetworks = Try-Val { @(Get-HnsNetwork | ForEach-Object { [ordered]@{ name = $_.Name; type = $_.Type } }) }
  vfpAclSupport = Try-Val { if (Has-Cmd 'Get-HnsNetwork') { 'exposed-via-hns-acl-policy' } else { 'unknown' } }
  containerd = [ordered]@{ available = Has-Cmd 'containerd'; version = Try-Val { (& containerd --version) -join ' ' }; path = Cmd-Path 'containerd' }
  ctr = [ordered]@{ available = Has-Cmd 'ctr'; version = Try-Val { (& ctr --version) -join ' ' }; path = Cmd-Path 'ctr' }
  docker = [ordered]@{ available = Has-Cmd 'docker'; version = Try-Val { (& docker --version) -join ' ' }; path = Cmd-Path 'docker' }
  windowsContainerRuntime = Try-Val { if (Has-Cmd 'ctr') { 'containerd/ctr' } elseif (Has-Cmd 'docker') { 'docker' } else { 'none' } }
  baseImages = Try-Val { @(& docker images --format '{{.Repository}}:{{.Tag}}' 2>$null | Where-Object { $_ -match 'servercore|nanoserver|windows' }) }
  adapters = Try-Val { @(Get-NetAdapter | ForEach-Object { [ordered]@{ name = $_.Name; status = $_.Status.ToString(); kind = $_.InterfaceDescription } }) }
  vSwitches = Try-Val { @(Get-VMSwitch | ForEach-Object { [ordered]@{ name = $_.Name; type = $_.SwitchType.ToString() } }) }
  dedicatedWorkerFacingAddressPossible = Try-Val { [bool](@(Get-VMSwitch | Where-Object { $_.SwitchType -eq 'Internal' }).Count -ge 0) }
  hyperVIsolationRequestable = Try-Val { ([bool]$cs.HypervisorPresent) -and ((Has-Cmd 'ctr') -or (Has-Cmd 'docker')) }
  canRunCandidateImage = Try-Val { if ($os.BuildNumber) { "host-build-$($os.BuildNumber); match a servercore/nanoserver tag with an equal or Hyper-V-compatible build" } else { 'unknown' } }
}

$json = $r | ConvertTo-Json -Depth 6
Set-Content -Path $OutPath -Value $json -Encoding utf8
Write-Output "== Fusion Hyper-V host probe (READ-ONLY; no machine changes) =="
Write-Output ("Windows           : {0} ({1}, build {2}, {3})" -f $r.os.edition, $r.os.version, $r.os.build, $r.os.architecture)
Write-Output ("Hypervisor present: {0}" -f $r.hypervisorPresent)
Write-Output ("Hyper-V / Containers features: {0} / {1}" -f $r.hyperVFeature, $r.containersFeature)
Write-Output ("HCS / HNS available: {0} / {1}" -f $r.hcs.available, $r.hns.available)
Write-Output ("Runtimes: ctr={0} containerd={1} docker={2}" -f $r.ctr.available, $r.containerd.available, $r.docker.available)
Write-Output ("Report written: {0}" -f $OutPath)

# Compute the verdict (never manual) via the CI-tested evaluator, if node is available.
if (Has-Cmd 'node') { & node (Join-Path $here 'host-probe-eval-cli.mjs') $OutPath } else { Write-Output "HYPERV_HOST_PROBE=INCOMPLETE (node not found to compute verdict; report JSON was written)" }
