# Fusion v0.6 Hyper-V PoC — provision (maintainer-run). Creates ONLY FusionV06Poc-<RunId>-* resources: one dedicated
# Docker/HNS worker network (`internal` driver → Internal vSwitch, no external route), the REAL Fusion broker (production
# provider-broker, bound to the dedicated worker-facing IP), and host-side canary listeners — all as EXPLICITLY-OWNED
# NATIVE processes (PIDs persisted) launched via native-launch.ps1 so paths with spaces survive. Ownership is persisted
# DURABLY to owner-<RunId>.json BEFORE each subsequent mutation, so cleanup can reclaim exactly what was created even if
# provision throws mid-way (and before the final provision-<RunId>.json exists). Creating the network + processes does
# not require elevation; applying the endpoint ACL (run.ps1) does.
[CmdletBinding()] param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9]{4,32}$')][string]$RunId,
  [string]$Subnet = '10.250.37.0/24',
  [string]$BrokerIp = '10.250.37.1',
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$OutDir = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
. (Join-Path $here 'native-launch.ps1')
$prefix = "FusionV06Poc-$RunId"
$net = "$prefix-net"
$brokerPort = 47610; $wrongPort = 47611; $hostOtherPort = 47620; $providerPort = 47630
$ownerPath = Join-Path $OutDir "owner-$RunId.json"

# Durable ownership record, written atomically (tmp + Move) after every acquisition. cleanup.ps1 consumes THIS file.
$script:owner = [ordered]@{ schema = 'fusion.hyperv.owner/1'; runId = $RunId; prefix = $prefix; createdAt = (Get-Date).ToUniversalTime().ToString('o'); network = $null; image = "fusion-hv-poc-img:$RunId"; processes = @() }
function Save-Owner {
  $tmp = "$ownerPath.tmp"
  [System.IO.File]::WriteAllText($tmp, ($script:owner | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -Force $tmp $ownerPath
}
function Add-OwnedProcess($role, $proc) {
  $st = $null; try { $st = $proc.StartTime.ToUniversalTime().ToString('o') } catch { }
  $script:owner.processes += ,([ordered]@{ role = $role; pid = [int]$proc.Id; startTime = $st })
  Save-Owner
}
Save-Owner   # exists BEFORE the first mutation, so a failure at any point leaves a consumable ownership record

function Test-Ready($ip, $port, $tries = 40) {
  for ($i = 0; $i -lt $tries; $i++) {
    $c = New-Object System.Net.Sockets.TcpClient
    try { $iar = $c.BeginConnect($ip, [int]$port, $null, $null); if ($iar.AsyncWaitHandle.WaitOne(500, $false)) { $c.EndConnect($iar); $c.Close(); return $true } } catch { } finally { $c.Close() }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

# 1. Pre-state snapshot (read-only).
$pre = [ordered]@{ generatedAt = (Get-Date).ToUniversalTime().ToString('o'); dockerNetworks = @(& docker network ls --format '{{.Name}}'); pocCollisions = @(& docker network ls --format '{{.Name}}' | Where-Object { $_ -like "$prefix*" }) }
$prePath = Join-Path $OutDir "prestate-$RunId.json"
[System.IO.File]::WriteAllText($prePath, ($pre | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
Write-Output "PRESTATE=$prePath"
if ($pre.pocCollisions.Count -gt 0) { throw "a FusionV06Poc-$RunId network already exists; run cleanup.ps1 -RunId $RunId first" }

# 2. Discover the current non-PoC host IPv4 (the interface that owns the default gateway) for HOST_OTHER_ADDRESS.
$hostOtherAddr = $null
try { $hostOtherAddr = (Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | Select-Object -First 1).IPv4Address.IPAddress } catch { }
Write-Output "HOST_OTHER_ADDRESS=$hostOtherAddr"

# 3. Dedicated worker network (internal: no external route). Record ownership immediately.
Write-Output "Creating network $net ($Subnet, gateway $BrokerIp) ..."
& docker network create -d internal --subnet $Subnet --gateway $BrokerIp --label org.fusion.poc=fusion-hv-poc --label "org.fusion.poc.runid=$RunId" $net | Out-Null
if ($LASTEXITCODE -ne 0) { throw "docker network create failed ($LASTEXITCODE)" }
$script:owner.network = $net; Save-Owner
$hnsId = (& docker network inspect $net --format '{{json .}}' | ConvertFrom-Json).Options.'com.docker.network.windowsshim.hnsid'
Write-Output "NETWORK_HNS_ID=$hnsId"

# 4. Host-side canary listeners as explicitly-owned native node processes (PID persisted the instant each is created).
function Start-Listener($name, $ip, $port) {
  $log = Join-Path $OutDir "$prefix-$name.log"
  $p = Start-NativeNode -ScriptPath (Join-Path $here 'listener.mjs') -ScriptArgs @($ip, "$port", $Token) -StderrLog $log
  Add-OwnedProcess "listener-$name" $p
  return $p.Id
}
$listenerPids = [ordered]@{}
$listenerPids['wrongport'] = Start-Listener 'wrongport' $BrokerIp $wrongPort
$listenerPids['hostother'] = Start-Listener 'hostother' $BrokerIp $hostOtherPort
$listenerPids['provider']  = Start-Listener 'provider'  $BrokerIp $providerPort
if ($hostOtherAddr) { $listenerPids['hostotheraddr'] = Start-Listener 'hostotheraddr' $hostOtherAddr $hostOtherPort }

# 5. The REAL Fusion broker bound to the dedicated worker-facing IP; PID persisted the instant it is created.
$credFile = Join-Path $OutDir "broker-$RunId.cred.json"
if (Test-Path $credFile) { Remove-Item -Force $credFile }
$brokerProc = Start-NativeNode -ScriptPath (Join-Path $here 'broker-serve.mjs') -ScriptArgs @($BrokerIp, "$brokerPort", $BrokerIp, "$providerPort", $credFile) -StderrLog (Join-Path $OutDir "$prefix-broker.log")
Add-OwnedProcess 'broker' $brokerProc
for ($i = 0; $i -lt 40 -and -not (Test-Path $credFile); $i++) { Start-Sleep -Milliseconds 250 }
if (-not (Test-Path $credFile)) { throw "the real broker did not come up (see $prefix-broker.log)" }
$brokerInfo = Get-Content -Raw $credFile | ConvertFrom-Json

# 6. Positive readiness checks BEFORE the worker starts.
$ready = @{}
$ready['broker'] = Test-Ready $BrokerIp $brokerPort
$ready['wrongport'] = Test-Ready $BrokerIp $wrongPort
$ready['hostother'] = Test-Ready $BrokerIp $hostOtherPort
$ready['provider'] = Test-Ready $BrokerIp $providerPort
if ($hostOtherAddr) { $ready['hostotheraddr'] = Test-Ready $hostOtherAddr $hostOtherPort }
Write-Output ("READINESS=" + (($ready.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ' '))
if (-not ($ready['broker'] -and $ready['wrongport'] -and $ready['hostother'] -and $ready['provider'])) { throw "a required listener/broker was not ready; aborting before worker start" }

$provOut = [ordered]@{
  net = $net; hnsNetworkId = $hnsId; brokerIp = $BrokerIp; subnet = $Subnet
  brokerPort = $brokerPort; wrongPort = $wrongPort; hostOtherPort = $hostOtherPort; providerPort = $providerPort
  hostOtherAddr = $hostOtherAddr; token = $Token
  brokerCredential = $brokerInfo.credential; brokerActualPort = $brokerInfo.port
  listenerPids = $listenerPids; brokerPid = $brokerProc.Id; readiness = $ready; ownerFile = $ownerPath
}
$provPath = Join-Path $OutDir "provision-$RunId.json"
[System.IO.File]::WriteAllText($provPath, ($provOut | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
Write-Output "PROVISION=$provPath"
Write-Output "Provision complete. Next: ./run.ps1 -RunId $RunId (ELEVATED)"
