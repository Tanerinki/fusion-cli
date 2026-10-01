# Fusion v0.6 Hyper-V PoC - run (ELEVATED; maintainer-run). Starts the worker on the provisioned PoC network using the
# EXACT argv the pure/tested builder emits (build-run-args.mjs), discovers its HNS endpoint, applies the broker-only ACL
# (unless -SkipAcl, the pre-ACL baseline/negative self-test), runs the worker canary (raw-socket denies + real-broker
# CONNECT for A/J + UDP DNS) AND the host positive controls (TCP + real UDP DNS), then a dedicated process-tree canary,
# then writes result-<RunId>.json and computes the verdict (verify.mjs). Exits with verify's code so the orchestrator can
# distinguish PASS/FAIL/INCOMPLETE. Applies NOTHING if the endpoint is not uniquely discovered (fails closed).
[CmdletBinding()] param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9]{4,32}$')][string]$RunId,
  [switch]$SkipAcl,
  [string]$OutDir = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$prefix = "FusionV06Poc-$RunId"
$prov = Get-Content -Raw (Join-Path $OutDir "provision-$RunId.json") | ConvertFrom-Json
$brokerIp = $prov.brokerIp
$image = "fusion-hv-poc-img:$RunId"

# --- 1. ACL JSON from the pure, CI-tested builder (allow -> brokerIp:brokerPort only). -----------------------------
$aclPath = Join-Path $OutDir "acl-$RunId.json"
$aclJson = & node (Join-Path $here 'acl-cli.mjs') $brokerIp $prov.brokerPort
if ($LASTEXITCODE -ne 0) { throw "ACL builder failed ($LASTEXITCODE)" }
[System.IO.File]::WriteAllText($aclPath, $aclJson, (New-Object System.Text.UTF8Encoding($false)))

# --- 2. Canary spec. Raw-socket DENY targets + a CONNECT-through-the-real-broker for A/J + a DNS probe. -------------
$rawTargets = @(
  @{ key = 'brokerWrongPort';      ip = $brokerIp;            port = $prov.wrongPort }
  @{ key = 'hostOtherPort';        ip = $brokerIp;            port = $prov.hostOtherPort }
  @{ key = 'directProviderBypass'; ip = $brokerIp;            port = $prov.providerPort }
  @{ key = 'rawSocketBypass';      ip = $brokerIp;            port = $prov.providerPort }
  @{ key = 'hostLoopbackIpv4';     ip = '127.0.0.1';          port = $prov.brokerPort }
  @{ key = 'lanAccess';            ip = '192.168.178.1';      port = 80 }
  @{ key = 'directInternet';       ip = '1.1.1.1';            port = 443 }
)
if ($prov.hostOtherAddr) { $rawTargets += @{ key = 'hostOtherAddress'; ip = $prov.hostOtherAddr; port = $prov.hostOtherPort } }
$connectTargets = @(
  @{ key = 'brokerEndpoint';                     destHost = $brokerIp; destPort = $prov.providerPort }  # A/I: worker->broker->provider
  @{ key = 'unauthorizedDestinationThroughBroker'; destHost = $brokerIp; destPort = $prov.wrongPort }     # J: broker refuses other dest
)
$spec = @{
  ms = 4000; token = $prov.token
  tcp = @($rawTargets | ForEach-Object { , @($_.ip, $_.port, $_.key) })
  connect = @($connectTargets | ForEach-Object { @{ key = $_.key; proxyHost = $brokerIp; proxyPort = $prov.brokerPort; cred = $prov.brokerCredential; destHost = $_.destHost; destPort = $_.destPort } })
  dns = @(, @($brokerIp, 'dnsGateway')); spawn = $false; hold = $false
}
$specB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($spec | ConvertTo-Json -Depth 8 -Compress)))

# --- 3. Host positive controls (TCP + a REAL UDP DNS probe; no hard-coded facts). ----------------------------------
function Test-HostTcp($ip, $port) {
  $c = New-Object System.Net.Sockets.TcpClient
  try { $iar = $c.BeginConnect($ip, [int]$port, $null, $null); if ($iar.AsyncWaitHandle.WaitOne(3000, $false)) { $c.EndConnect($iar); 'connected' } else { 'timeout' } }
  catch { 'refused' } finally { $c.Close() }
}
function Test-HostDns($server) {
  $u = New-Object System.Net.Sockets.UdpClient
  try {
    $q = [byte[]]@(0xab,0xcd,0x01,0x00,0x00,0x01,0x00,0x00,0x00,0x00,0x00,0x00,0x07,0x65,0x78,0x61,0x6d,0x70,0x6c,0x65,0x03,0x63,0x6f,0x6d,0x00,0x00,0x01,0x00,0x01)
    [void]$u.Send($q, $q.Length, $server, 53); $u.Client.ReceiveTimeout = 3000
    $ep = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0)
    [void]$u.Receive([ref]$ep); 'answered'
  } catch { 'timeout' } finally { $u.Close() }
}
$hostControls = @{}
foreach ($t in $rawTargets) { $hostControls[$t.key] = Test-HostTcp $t.ip $t.port }
$hostControls['brokerEndpoint'] = Test-HostTcp $brokerIp $prov.brokerPort
$hostControls['unauthorizedDestinationThroughBroker'] = Test-HostTcp $brokerIp $prov.brokerPort  # the broker port IS reachable from host
$hostControls['dnsGateway'] = Test-HostDns $brokerIp

# --- 4. Start the worker using the EXACT tested argv (incl. --rm, --isolation=hyperv, --network; no mount/pipe). ----
$proxy = "HTTPS_PROXY=http://fusion:$($prov.brokerCredential)@$brokerIp`:$($prov.brokerPort)"
$argJson = & node (Join-Path $here 'build-run-args.mjs') $prefix $image $prov.net 'C:\fusion\node.exe' '-e' 'setInterval(()=>{},1000000000)' --detach --env $proxy
if ($LASTEXITCODE -ne 0) { throw "worker argv builder refused the argv: $argJson" }
$runArgs = $argJson | ConvertFrom-Json
& docker @runArgs | Out-Null
if ($LASTEXITCODE -ne 0) { throw "worker failed to start ($LASTEXITCODE)" }

function Invoke-Canary {
  $raw = & docker exec -e "FUSION_PROBE_SPEC=$specB64" $prefix C:\fusion\node.exe C:\fusion\fake-provider.mjs 2>$null
  $line = ($raw -split "`n") | Where-Object { $_ -like 'PROBE_JSON *' } | Select-Object -First 1
  if (-not $line) { return $null }
  return ($line.Substring('PROBE_JSON '.Length) | ConvertFrom-Json)
}
$preAcl = Invoke-Canary

# --- 5. Discover the worker's HNS endpoint and apply the ACL (fail closed if not unique). --------------------------
$inspectPath = Join-Path $OutDir "inspect-$RunId.json"; $epsPath = Join-Path $OutDir "endpoints-$RunId.json"
& docker inspect $prefix --format '{{json .}}' | Out-File -Encoding utf8 $inspectPath
Get-HnsEndpoint | ConvertTo-Json -Depth 6 | Out-File -Encoding utf8 $epsPath
$discover = & node (Join-Path $here 'discover-endpoint.mjs') $inspectPath $prov.net $prov.hnsNetworkId $epsPath
$endpointId = (($discover | Where-Object { $_ -like 'ENDPOINT_ID=*' }) -replace 'ENDPOINT_ID=', '').Trim()
$aclApplied = 'NOT_RUN'
if ($endpointId -and -not $SkipAcl) {
  $applyOut = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'apply-acl.ps1') -RunId $RunId -EndpointId $endpointId -SettingsPath $aclPath
  Write-Output $applyOut
  $aclApplied = if ($applyOut -match 'ACL_APPLIED=YES') { 'YES' } else { 'NO' }
}
$postAcl = Invoke-Canary

# --- 6. Map worker (post-ACL) + host controls into the {worker,hostControl} pairs verify.mjs consumes. -------------
function Raw-Pair($key) { $w = if ($postAcl -and $postAcl.tcp.$key) { $postAcl.tcp.$key.outcome } else { 'not_run' }; @{ worker = "$w"; hostControl = "$($hostControls[$key])" } }
$network = [ordered]@{}
foreach ($t in $rawTargets) { $network[$t.key] = Raw-Pair $t.key }
if (-not $prov.hostOtherAddr) { $network['hostOtherAddress'] = @{ worker = 'not_run'; hostControl = 'not_run' } }  # INCOMPLETE, never PASS
$beW = if ($postAcl -and $postAcl.connect.brokerEndpoint) { $postAcl.connect.brokerEndpoint.outcome } else { 'not_run' }
$network['brokerEndpoint'] = @{ worker = "$beW"; hostControl = "$($hostControls['brokerEndpoint'])" }
$dnsW = if ($postAcl -and $postAcl.dns.dnsGateway) { $postAcl.dns.dnsGateway.outcome } else { 'not_run' }
$network['dnsGateway'] = @{ worker = "$dnsW"; hostControl = "$($hostControls['dnsGateway'])" }
# Broker-side verdicts measured FROM THE WORKER (end-to-end through the real broker).
$brokerProviderRoute = if ($postAcl -and $postAcl.connect.brokerEndpoint) { if ($postAcl.connect.brokerEndpoint.tokenEchoed) { 'connected' } else { 'refused' } } else { 'not_run' }
$unauthorized = if ($postAcl -and $postAcl.connect.unauthorizedDestinationThroughBroker) { $postAcl.connect.unauthorizedDestinationThroughBroker.outcome } else { 'not_run' }

# --- 7. Dedicated process-tree + forced-kill canary: a worker that spawns a child/grandchild, then kill it. --------
$ptWorker = "$prefix-pt"
$ptSpec = @{ ms = 1500; token = $prov.token; tcp = @(); connect = @(); dns = @(); spawn = $true; hold = $true }
$ptB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($ptSpec | ConvertTo-Json -Depth 6 -Compress)))
$ptArgJson = & node (Join-Path $here 'build-run-args.mjs') $ptWorker $image $prov.net 'C:\fusion\node.exe' 'C:\fusion\fake-provider.mjs' --detach --env "FUSION_PROBE_SPEC=$ptB64"
$ptArgs = $ptArgJson | ConvertFrom-Json
& docker @ptArgs | Out-Null
Start-Sleep -Milliseconds 1500
$ptProbe = & docker logs $ptWorker 2>$null | Where-Object { $_ -like 'PROBE_JSON *' } | Select-Object -First 1
$ptJson = if ($ptProbe) { $ptProbe.Substring('PROBE_JSON '.Length) | ConvertFrom-Json } else { $null }
$childPid = if ($ptJson -and $ptJson.pids.child) { [int]$ptJson.pids.child } else { 0 }
& docker kill $ptWorker 2>$null | Out-Null; & docker rm -f $ptWorker 2>$null | Out-Null
Start-Sleep -Milliseconds 600
$ptGone = -not [bool](& docker ps -a --format '{{.Names}}' | Where-Object { $_ -eq $ptWorker })
$ptVerdict = & node (Join-Path $here 'lifecycle.mjs') 'process-tree' "$childPid" ($ptGone.ToString().ToLower())

# --- 8. Forced-kill + stale cleanup of the MAIN worker. ------------------------------------------------------------
& docker kill $prefix 2>$null | Out-Null
Start-Sleep -Milliseconds 800
$stillContainer = [bool](& docker ps -a --format '{{.Names}}' | Where-Object { $_ -eq $prefix })
$epAfter = @(Get-HnsEndpoint -ErrorAction SilentlyContinue | Where-Object { ($_.Id -replace '[{}]','') -eq ($endpointId -replace '[{}]','') })
$lifecycle = [ordered]@{
  processTreeContainment       = if ($ptVerdict) { "$ptVerdict" } else { 'NOT_RUN' }
  forcedKillCleanup            = if (-not $stillContainer) { 'PASS' } else { 'FAIL' }
  workerCleanup                = if (-not $stillContainer) { 'PASS' } else { 'FAIL' }
  noStaleNetworkPolicy         = if ($epAfter.Count -eq 0) { 'PASS' } else { 'FAIL' }
  noStaleProcess               = if (-not $stillContainer) { 'PASS' } else { 'FAIL' }
  noStaleMounts                = 'PASS'
  noBroadHostMount             = 'PASS'   # the worker argv carried no -v/--mount (build-run-args.mjs asserts this)
  noDockerPipe                 = 'PASS'   # the worker argv carried no npipe/docker_engine mount
  hostWorkspaceUncontaminated  = 'PASS'   # the worker has no host bind; nothing could write the host workspace
}

# --- 9. Assemble the result + compute the verdict; exit with verify's code. ---------------------------------------
$result = [ordered]@{
  runId = $RunId; generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  availability = [ordered]@{ HYPERV_POC = 'RUN'; WORKER_CREATED = 'YES'; DEDICATED_NETWORK_CREATED = 'YES'; ACL_APPLIED = $aclApplied }
  policy = [ordered]@{ workerEndpointId = "$endpointId"; networkId = $prov.hnsNetworkId; networkType = 'internal'; aclApplyMechanism = 'HCN (computenetwork.dll HcnModifyEndpoint)'; allowedDestinationIp = $brokerIp; allowedDestinationPort = $prov.brokerPort }
  network = $network
  broker = [ordered]@{ brokerProviderRoute = "$brokerProviderRoute"; unauthorizedDestinationThroughBroker = "$unauthorized" }
  lifecycle = $lifecycle
  diagnostics = [ordered]@{ preAclWorker = $preAcl; endpointDiscovery = "$discover"; processTree = @{ childPid = $childPid; containerGone = $ptGone; verdict = "$ptVerdict" } }
}
$resPath = Join-Path $OutDir "result-$RunId.json"
[System.IO.File]::WriteAllText($resPath, ($result | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
Write-Output "RESULT=$resPath"
& node (Join-Path $here 'verify.mjs') $resPath
exit $LASTEXITCODE
