# Fusion v0.6 Hyper-V PoC — cleanup + post-cleanup proof (maintainer-run). Removes ONLY this run's resources (strict
# FusionV06Poc-<RunId> / fusion-hv-poc-img:<RunId> prefix + the explicitly-persisted listener/broker PIDs), then
# MECHANICALLY compares post-state to the pre-state for the objects this PoC owns/affects (networks, worker container,
# image, listener processes, the worker HNS endpoint by its EXACT recorded id, the PoC vEthernet address) and confirms
# the non-PoC Docker-network set is unchanged. Safe after a partial run and safe to call from a finally block. Durable
# evidence JSON is kept. The worker's HNS endpoint is owned by Docker and dies with the container; this script never
# Remove-HnsEndpoint's an endpoint it did not create.
[CmdletBinding()] param([Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9]{4,32}$')][string]$RunId, [string]$OutDir = $PSScriptRoot)
$ErrorActionPreference = 'SilentlyContinue'
$prefix = "FusionV06Poc-$RunId"; $img = "fusion-hv-poc-img:$RunId"
$provPath = Join-Path $OutDir "provision-$RunId.json"; $resPath = Join-Path $OutDir "result-$RunId.json"; $prePath = Join-Path $OutDir "prestate-$RunId.json"
$prov = if (Test-Path $provPath) { Get-Content -Raw $provPath | ConvertFrom-Json } else { $null }
$res = if (Test-Path $resPath) { Get-Content -Raw $resPath | ConvertFrom-Json } else { $null }
$endpointId = if ($res) { "$($res.policy.workerEndpointId)" } else { '' }
Write-Output "== Cleanup (only '$prefix*' / '$img' / persisted PIDs) =="

# 1. Worker containers (main + process-tree), then network, then image.
foreach ($c in @($prefix, "$prefix-pt")) { if (& docker ps -a --format '{{.Names}}' | Where-Object { $_ -eq $c }) { Write-Output "  remove container $c"; & docker rm -f $c | Out-Null } }
if (& docker network ls --format '{{.Name}}' | Where-Object { $_ -eq "$prefix-net" }) { Write-Output "  remove network $prefix-net"; & docker network rm "$prefix-net" | Out-Null }
if (& docker images --format '{{.Repository}}:{{.Tag}}' | Where-Object { $_ -eq $img }) { Write-Output "  remove image $img"; & docker rmi $img | Out-Null }

# 2. Explicitly-owned listener + broker processes (persisted PIDs) — the correct cross-process ownership model.
$pids = @()
if ($prov) { if ($prov.listenerPids) { $prov.listenerPids.PSObject.Properties | ForEach-Object { $pids += [int]$_.Value } }; if ($prov.brokerPid) { $pids += [int]$prov.brokerPid } }
foreach ($procId in $pids) { if (Get-Process -Id $procId -ErrorAction SilentlyContinue) { Write-Output "  stop process pid=$procId"; Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue } }
# Any leftover session jobs with our prefix (belt and braces; the model is PIDs, not jobs).
Get-Job | Where-Object { $_.Name -like "$prefix-*" } | ForEach-Object { Stop-Job $_; Remove-Job $_ }

# 3. Temp build dirs + logs + cred file (only ours).
Get-ChildItem $env:TEMP -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "$prefix-*" } | ForEach-Object { Remove-Item -Recurse -Force $_.FullName }
Get-ChildItem $OutDir -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "$prefix-*.log" -or $_.Name -eq "broker-$RunId.cred.json" } | ForEach-Object { Remove-Item -Force $_.FullName }

# 4. MECHANICAL post-cleanup proof: gather post-state and compare to prestate for the objects we own/affect.
Start-Sleep -Milliseconds 500
$subnetPrefix = if ($prov -and $prov.brokerIp) { ($prov.brokerIp -replace '\.\d+$', '.') } else { $null }
$pocAddrs = @(); if ($subnetPrefix) { $pocAddrs = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -like "$subnetPrefix*" } | ForEach-Object { $_.IPAddress }) }
$alive = @(); foreach ($procId in $pids) { if (Get-Process -Id $procId -ErrorAction SilentlyContinue) { $alive += $procId } }
$pre = if (Test-Path $prePath) { Get-Content -Raw $prePath | ConvertFrom-Json } else { [pscustomobject]@{ dockerNetworks = @() } }
$input = [ordered]@{
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
[System.IO.File]::WriteAllText($chkPath, ($input | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
& node (Join-Path $PSScriptRoot 'cleanup-check.mjs') $chkPath
$code = $LASTEXITCODE
Write-Output "Cleanup complete for $prefix (evidence: cleanup-$RunId.json; CLEANUP_OK exit=$code)."
