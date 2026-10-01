# Fusion v0.6 Hyper-V PoC — provision (maintainer-run). Creates ONLY FusionV06Poc-<RunId>-* resources: one dedicated
# Docker/HNS worker network (the `internal` driver → an Internal vSwitch with NO external route, so LAN/Internet are
# denied structurally and the ACL's job is to additionally deny the same-subnet host ports + gateway DNS), the REAL
# Fusion broker (production provider-broker, bound to the dedicated worker-facing IP), and host-side canary listeners —
# all as EXPLICITLY-OWNED native processes whose PIDs are persisted (not PowerShell jobs, which are session-scoped and
# cannot be cleaned across processes). Listener/broker readiness is positively checked before the worker is started.
# Records pre-state first. Creating the network + processes does not require elevation; applying the endpoint ACL does.
[CmdletBinding()] param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9]{4,32}$')][string]$RunId,
  [string]$Subnet = '10.250.37.0/24',
  [string]$BrokerIp = '10.250.37.1',
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$OutDir = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$prefix = "FusionV06Poc-$RunId"
$net = "$prefix-net"
$brokerPort = 47610; $wrongPort = 47611; $hostOtherPort = 47620; $providerPort = 47630

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

# 3. Dedicated worker network (internal: no external route).
Write-Output "Creating network $net ($Subnet, gateway $BrokerIp) ..."
& docker network create -d internal --subnet $Subnet --gateway $BrokerIp --label org.fusion.poc=fusion-hv-poc --label "org.fusion.poc.runid=$RunId" $net | Out-Null
if ($LASTEXITCODE -ne 0) { throw "docker network create failed ($LASTEXITCODE)" }
$hnsId = (& docker network inspect $net --format '{{json .}}' | ConvertFrom-Json).Options.'com.docker.network.windowsshim.hnsid'
Write-Output "NETWORK_HNS_ID=$hnsId"

# 4. Host-side canary listeners as explicitly-owned native node processes (PIDs persisted).
function Start-Listener($name, $ip, $port) {
  $log = Join-Path $OutDir "$prefix-$name.log"
  $p = Start-Process -FilePath 'node' -ArgumentList @((Join-Path $here 'listener.mjs'), $ip, "$port", $Token) -PassThru -WindowStyle Hidden -RedirectStandardError $log
  return $p.Id
}
$listenerPids = [ordered]@{}
$listenerPids['wrongport'] = Start-Listener 'wrongport' $BrokerIp $wrongPort
$listenerPids['hostother'] = Start-Listener 'hostother' $BrokerIp $hostOtherPort
$listenerPids['provider']  = Start-Listener 'provider'  $BrokerIp $providerPort
if ($hostOtherAddr) { $listenerPids['hostotheraddr'] = Start-Listener 'hostotheraddr' $hostOtherAddr $hostOtherPort }

# 5. The REAL Fusion broker bound to the dedicated worker-facing IP, forwarding only to the synthetic provider stand-in.
$credFile = Join-Path $OutDir "broker-$RunId.cred.json"
if (Test-Path $credFile) { Remove-Item -Force $credFile }
$brokerProc = Start-Process -FilePath 'node' -ArgumentList @((Join-Path $here 'broker-serve.mjs'), $BrokerIp, "$brokerPort", $BrokerIp, "$providerPort", $credFile) -PassThru -WindowStyle Hidden -RedirectStandardError (Join-Path $OutDir "$prefix-broker.log")
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
  listenerPids = $listenerPids; brokerPid = $brokerProc.Id; readiness = $ready
}
$provPath = Join-Path $OutDir "provision-$RunId.json"
[System.IO.File]::WriteAllText($provPath, ($provOut | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
Write-Output "PROVISION=$provPath"
Write-Output "Provision complete. Next: ./run.ps1 -RunId $RunId (ELEVATED)"
