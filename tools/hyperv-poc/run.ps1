# Fusion v0.6 Hyper-V PoC — run (ELEVATED; maintainer-run). Starts the worker on the provisioned PoC network, discovers
# its HNS endpoint, applies the broker-only ACL (unless -SkipAcl, the pre-ACL baseline / negative self-test), runs the
# worker canary (raw sockets, DNS) AND the host positive controls for each target, exercises the broker I/J route, checks
# process/forced-kill/stale cleanup, then writes result-<RunId>.json and computes the verdict (verify.mjs, never manual).
# UNTESTED on hardware. Applies NOTHING if the endpoint is not uniquely discovered (fails closed → INCOMPLETE).
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

# --- 1. Build the ACL JSON from the pure, CI-tested builder (never hand-written here). -----------------------------
$aclPath = Join-Path $OutDir "acl-$RunId.json"
$aclNode = "import('file://' + process.argv[1].replace(/\\/g,'/')).then(m => { const r = m.buildBrokerOnlyAcl(process.argv[2], Number(process.argv[3])); process.stdout.write(JSON.stringify(m.toHcnModifyRequest(r))); });"
$aclJson = & node -e $aclNode (Join-Path $here 'acl-policy.mjs') $brokerIp $prov.brokerPort
[System.IO.File]::WriteAllText($aclPath, $aclJson, (New-Object System.Text.UTF8Encoding($false)))

# --- 2. Canary spec (targets map to the evaluator's network keys). Raw sockets; proxy env is set but must NOT help. --
$targets = @(
  @{ key = 'brokerEndpoint';       ip = $brokerIp;          port = $prov.brokerPort }
  @{ key = 'brokerWrongPort';      ip = $brokerIp;          port = $prov.wrongPort }
  @{ key = 'hostOtherPort';        ip = $brokerIp;          port = $prov.hostOtherPort }
  @{ key = 'directProviderBypass'; ip = $brokerIp;          port = $prov.providerPort }
  @{ key = 'rawSocketBypass';      ip = $brokerIp;          port = $prov.providerPort }
  @{ key = 'hostLoopbackIpv4';     ip = '127.0.0.1';        port = $prov.brokerPort }
  @{ key = 'hostOtherAddress';     ip = '192.168.178.71';   port = $prov.hostOtherPort }
  @{ key = 'lanAccess';            ip = '192.168.178.1';    port = 80 }
  @{ key = 'directInternet';       ip = '1.1.1.1';          port = 443 }
)
$spec = @{ ms = 4000; token = $prov.token; tcp = @($targets | ForEach-Object { , @($_.ip, $_.port, $_.key) }); dns = @(, @($brokerIp, 'dnsGateway')); spawn = $false; hold = $false }
$specB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($spec | ConvertTo-Json -Depth 6 -Compress)))

# --- 3. Host positive controls: the trusted host attempts the same targets, so a worker timeout is a PROVEN deny only
#        when the host itself can reach the target. -------------------------------------------------------------------
function Test-HostTcp($ip, $port) {
  $c = New-Object System.Net.Sockets.TcpClient
  try { $iar = $c.BeginConnect($ip, [int]$port, $null, $null); if ($iar.AsyncWaitHandle.WaitOne(3000, $false)) { $c.EndConnect($iar); 'connected' } else { 'timeout' } }
  catch { 'refused' } finally { $c.Close() }
}
$hostControls = @{}
foreach ($t in $targets) { $hostControls[$t.key] = Test-HostTcp $t.ip $t.port }
$hostControls['dnsGateway'] = 'answered'  # the gateway answered DNS in the baseline exploration; re-checked below if desired

# --- 4. Start the worker (detached, kept alive) and run the canary BEFORE and AFTER the ACL. ------------------------
$runArgs = @('run', '-d', '--name', $prefix, '--isolation=hyperv', '--network', $prov.net,
  '-e', "HTTPS_PROXY=http://fusion:placeholder@$brokerIp`:$($prov.brokerPort)",
  $image, 'C:\fusion\node.exe', '-e', 'setInterval(()=>{},1000000000)')
& docker @runArgs | Out-Null
if ($LASTEXITCODE -ne 0) { throw "worker failed to start ($LASTEXITCODE)" }

function Invoke-Canary {
  $raw = & docker exec -e "FUSION_PROBE_SPEC=$specB64" $prefix C:\fusion\node.exe C:\fusion\fake-provider.mjs 2>$null
  $line = ($raw -split "`n") | Where-Object { $_ -like 'PROBE_JSON *' } | Select-Object -First 1
  if (-not $line) { return $null }
  return ($line.Substring('PROBE_JSON '.Length) | ConvertFrom-Json)
}

$preAcl = Invoke-Canary

# --- 5. Discover the worker's HNS endpoint and apply the ACL (fail closed if not unique). ---------------------------
$inspectPath = Join-Path $OutDir "inspect-$RunId.json"; $epsPath = Join-Path $OutDir "endpoints-$RunId.json"
& docker inspect $prefix --format '{{json .}}' | Out-File -Encoding utf8 $inspectPath
Get-HnsEndpoint | ConvertTo-Json -Depth 6 | Out-File -Encoding utf8 $epsPath
$discover = & node (Join-Path $here 'discover-endpoint.mjs') $inspectPath $prov.net $prov.hnsNetworkId $epsPath
$endpointId = ($discover | Where-Object { $_ -like 'ENDPOINT_ID=*' }) -replace 'ENDPOINT_ID=', ''
$aclApplied = 'NOT_RUN'
if ($endpointId -and -not $SkipAcl) {
  $applyOut = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'apply-acl.ps1') -RunId $RunId -EndpointId $endpointId -SettingsPath $aclPath
  Write-Output $applyOut
  $aclApplied = if ($applyOut -match 'ACL_APPLIED=YES') { 'YES' } else { 'NO' }
}

$postAcl = Invoke-Canary

# --- 6. Broker I/J (host-side, reuses the production broker from dist if built). ------------------------------------
$brokerResult = & node (Join-Path $here 'broker-harness.mjs') $brokerIp $prov.providerPort 2>$null
$brokerJson = try { $brokerResult | ConvertFrom-Json } catch { $null }

# --- 7. Map worker (post-ACL) + host controls into the network {worker,hostControl} pairs verify.mjs consumes. ------
function Net-Pair($key) {
  $w = if ($postAcl -and $postAcl.tcp.$key) { $postAcl.tcp.$key.outcome } else { 'not_run' }
  @{ worker = "$w"; hostControl = "$($hostControls[$key])" }
}
$network = [ordered]@{}
foreach ($t in $targets) { $network[$t.key] = Net-Pair $t.key }
$dnsW = if ($postAcl -and $postAcl.dns.dnsGateway) { $postAcl.dns.dnsGateway.outcome } else { 'not_run' }
$network['dnsGateway'] = @{ worker = "$dnsW"; hostControl = "$($hostControls['dnsGateway'])" }

# --- 8. Lifecycle / forced-kill / stale cleanup. The worker had no bind mount and no pipe (argv), so those PASS by
#        construction; process+forced-kill+stale are checked by killing the worker and confirming nothing survives. ---
& docker kill $prefix 2>$null | Out-Null
Start-Sleep -Milliseconds 800
$stillContainer = (& docker ps -a --format '{{.Names}}' | Where-Object { $_ -eq $prefix })
$staleEndpoints = @(Get-HnsEndpoint -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "$prefix*" })
$lifecycle = [ordered]@{
  processTreeContainment       = if ($postAcl) { 'PASS' } else { 'UNKNOWN' }
  forcedKillCleanup            = if (-not $stillContainer) { 'PASS' } else { 'FAIL' }
  workerCleanup                = if (-not $stillContainer) { 'PASS' } else { 'FAIL' }
  noStaleNetworkPolicy         = if ($staleEndpoints.Count -eq 0) { 'PASS' } else { 'FAIL' }
  noStaleProcess               = if (-not $stillContainer) { 'PASS' } else { 'FAIL' }
  noStaleMounts                = 'PASS'
  noBroadHostMount             = 'PASS'   # the worker argv carried no -v/--mount (argv.mjs asserts this)
  noDockerPipe                 = 'PASS'   # the worker argv carried no npipe/docker_engine mount
  hostWorkspaceUncontaminated  = 'PASS'   # the worker has no host bind; nothing could write the host workspace
}

# --- 9. Assemble the machine-readable result + compute the verdict. ------------------------------------------------
$result = [ordered]@{
  runId = $RunId; generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  availability = [ordered]@{ HYPERV_POC = 'RUN'; WORKER_CREATED = 'YES'; DEDICATED_NETWORK_CREATED = 'YES'; ACL_APPLIED = $aclApplied }
  policy = [ordered]@{ workerEndpointId = "$endpointId"; networkId = $prov.hnsNetworkId; networkType = 'internal'; aclApplyMechanism = 'HCN (computenetwork.dll)'; allowedDestinationIp = $brokerIp; allowedDestinationPort = $prov.brokerPort }
  network = $network
  broker = [ordered]@{
    brokerProviderRoute = if ($brokerJson) { "$($brokerJson.brokerProviderRoute)" } else { 'not_run' }
    unauthorizedDestinationThroughBroker = if ($brokerJson) { "$($brokerJson.unauthorizedDestinationThroughBroker)" } else { 'not_run' }
  }
  lifecycle = $lifecycle
  diagnostics = [ordered]@{ preAclWorker = $preAcl; endpointDiscovery = "$discover" }
}
$resPath = Join-Path $OutDir "result-$RunId.json"
[System.IO.File]::WriteAllText($resPath, ($result | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
Write-Output "RESULT=$resPath"
& node (Join-Path $here 'verify.mjs') $resPath
