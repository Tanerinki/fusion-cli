# Fusion v0.6 Hyper-V PoC — cleanup + post-cleanup proof (maintainer-run). Consumes the DURABLE ownership record
# (owner-<RunId>.json, written by provision as resources were acquired) so it works even if provision threw before the
# final provision-<RunId>.json existed. Removes ONLY this run's resources (strict prefix + the persisted owned PIDs,
# each verified against its recorded start time to resist PID reuse), then MECHANICALLY compares post-state to the
# pre-state (cleanup-check.mjs) and EXITS NON-ZERO if the cleanup proof is not clean. Durable evidence JSON is kept. The
# worker's HNS endpoint is owned by Docker and dies with the container; this script never Remove-HnsEndpoint's one.
[CmdletBinding()] param([Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9]{4,32}$')][string]$RunId, [string]$OutDir = $PSScriptRoot)
$ErrorActionPreference = 'SilentlyContinue'
$prefix = "FusionV06Poc-$RunId"; $img = "fusion-hv-poc-img:$RunId"
$ownerPath = Join-Path $OutDir "owner-$RunId.json"; $resPath = Join-Path $OutDir "result-$RunId.json"; $prePath = Join-Path $OutDir "prestate-$RunId.json"
$owner = if (Test-Path $ownerPath) { Get-Content -Raw $ownerPath | ConvertFrom-Json } else { $null }
$res = if (Test-Path $resPath) { Get-Content -Raw $resPath | ConvertFrom-Json } else { $null }
$endpointId = if ($res) { "$($res.policy.workerEndpointId)" } else { '' }
Write-Output "== Cleanup (only '$prefix*' / '$img' / durably-owned PIDs) =="

# 1. Worker containers (main + process-tree), then network, then image.
foreach ($c in @($prefix, "$prefix-pt")) { if (& docker ps -a --format '{{.Names}}' | Where-Object { $_ -eq $c }) { Write-Output "  remove container $c"; & docker rm -f $c | Out-Null } }
$netName = if ($owner -and $owner.network) { $owner.network } else { "$prefix-net" }
if (& docker network ls --format '{{.Name}}' | Where-Object { $_ -eq $netName }) { Write-Output "  remove network $netName"; & docker network rm $netName | Out-Null }
if (& docker images --format '{{.Repository}}:{{.Tag}}' | Where-Object { $_ -eq $img }) { Write-Output "  remove image $img"; & docker rmi $img | Out-Null }

# 2. Durably-owned native processes (listeners + broker). Verify identity (recorded start time) before killing, so a
#    reused PID belonging to another process is never killed.
$ownedProcs = @()
if ($owner -and $owner.processes) { $ownedProcs = @($owner.processes) }
elseif (Test-Path (Join-Path $OutDir "provision-$RunId.json")) { # fallback for records predating owner-state
  $prov = Get-Content -Raw (Join-Path $OutDir "provision-$RunId.json") | ConvertFrom-Json
  if ($prov.listenerPids) { $prov.listenerPids.PSObject.Properties | ForEach-Object { $ownedProcs += ,([pscustomobject]@{ role = $_.Name; pid = [int]$_.Value; startTime = $null }) } }
  if ($prov.brokerPid) { $ownedProcs += ,([pscustomobject]@{ role = 'broker'; pid = [int]$prov.brokerPid; startTime = $null }) }
}
$pids = @()
foreach ($op in $ownedProcs) {
  $procId = [int]$op.pid; if ($procId -le 0) { continue }
  $pids += $procId
  $live = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if (-not $live) { continue }
  $identityOk = $true
  if ($op.startTime) {
    try { $recorded = [datetime]::Parse($op.startTime).ToUniversalTime(); $actual = $live.StartTime.ToUniversalTime(); if ([math]::Abs(($actual - $recorded).TotalSeconds) -gt 5) { $identityOk = $false } } catch { $identityOk = $false }
  }
  if ($identityOk) { Write-Output "  stop $($op.role) pid=$procId"; Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue }
  else { Write-Output "  SKIP pid=$procId (start time mismatch — likely reused, not ours)" }
}
Get-Job | Where-Object { $_.Name -like "$prefix-*" } | ForEach-Object { Stop-Job $_; Remove-Job $_ }

# 3. Temp build dirs + logs + cred file (only ours). Keep durable evidence (prestate/provision/acl/result/cleanup/owner).
Get-ChildItem $env:TEMP -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "$prefix-*" } | ForEach-Object { Remove-Item -Recurse -Force $_.FullName }
Get-ChildItem $OutDir -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "$prefix-*.log" -or $_.Name -eq "broker-$RunId.cred.json" } | ForEach-Object { Remove-Item -Force $_.FullName }

# 4. MECHANICAL post-cleanup proof.
Start-Sleep -Milliseconds 500
$subnetPrefix = $null
if ($owner -and $owner.network) { $subnetPrefix = '10.250.37.' }
try { $provForSubnet = Get-Content -Raw (Join-Path $OutDir "provision-$RunId.json") -ErrorAction SilentlyContinue | ConvertFrom-Json; if ($provForSubnet.brokerIp) { $subnetPrefix = ($provForSubnet.brokerIp -replace '\.\d+$', '.') } } catch { }
$pocAddrs = @(); if ($subnetPrefix) { $pocAddrs = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -like "$subnetPrefix*" } | ForEach-Object { $_.IPAddress }) }
$alive = @(); foreach ($procId in $pids) { if (Get-Process -Id $procId -ErrorAction SilentlyContinue) { $alive += $procId } }
$pre = if (Test-Path $prePath) { Get-Content -Raw $prePath | ConvertFrom-Json } else { [pscustomobject]@{ dockerNetworks = @() } }
$chkInput = [ordered]@{
  prefix = $prefix; runId = $RunId; endpointId = $endpointId; listenerPids = $pids
  prestate  = [ordered]@{ dockerNetworks = @($pre.dockerNetworks) }
  poststate = [ordered]@{
    dockerNetworks = @(& docker network ls --format '{{.Name}}')
    containers     = @(& docker ps -a --format '{{.Names}}')
    images         = @(& docker images --format '{{.Repository}}:{{.Tag}}')
    hnsEndpointIds = @(Get-HnsEndpoint -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id)" })
    alivePids      = $alive
    pocAddresses   = $pocAddrs
  }
}
$chkPath = Join-Path $OutDir "cleanup-$RunId.json"
[System.IO.File]::WriteAllText($chkPath, ($chkInput | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
& node (Join-Path $PSScriptRoot 'cleanup-check.mjs') $chkPath
$code = $LASTEXITCODE
Write-Output "Cleanup complete for $prefix (evidence: cleanup-$RunId.json). CLEANUP exit=$code"
exit $code   # non-zero when CLEANUP_OK=false, so the orchestrator can gate the final verdict
