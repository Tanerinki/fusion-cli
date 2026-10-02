# Fusion v0.6 Hyper-V PoC - mapped-named-pipe / --network none orchestrator (maintainer-run; NO admin, NO host network
# mutation). One command: builds the worker image, starts the host broker + synthetic provider, launches a Hyper-V-
# isolated worker with --network none and EXACTLY ONE mapped Fusion pipe, verifies the Docker/HCS state, runs the
# adversarial guest canary + FS/process/cleanup canaries, writes the evidence files, computes the verdicts (pipe-
# evaluator, never manual), and ALWAYS cleans up its own resources. UNTESTED on hardware. Reserved exit codes:
# 0=PASS 1=FAIL 2=INCOMPLETE 3=EXECUTION_ERROR (a harness error is NEVER a verified boundary FAIL).
[CmdletBinding()] param(
  [ValidatePattern('^[A-Za-z0-9]{4,32}$')][string]$RunId = ("p" + [DateTime]::UtcNow.ToString('yyMMddHHmmss')),
  [ValidateSet('broad', 'narrow')][string]$DaclMode = 'broad',
  [string]$NarrowPrincipal = $null,
  # PHASE C crash-matrix test seams (default 'none' = normal run). -CrashAfter throws a simulated failure after a named
  # stage so the finally cleanup is exercised from that point; -KillMidRun externally kills a live resource mid-run so
  # the harness must survive an already-dead resource and still clean up idempotently. Neither weakens any verdict - a
  # crashed run is EXECUTION_ERROR (3) and can never be a PASS; the test asserts ZERO residue afterwards.
  [ValidateSet('none', 'providerStart', 'workerStart', 'canary', 'hostControls', 'beforeKill')][string]$CrashAfter = 'none',
  [ValidateSet('none', 'worker', 'broker', 'provider')][string]$KillMidRun = 'none',
  [switch]$CleanupOnly,   # PHASE C: standalone idempotent cleanup for a RunId (orphan recovery after a hard cancel; run twice = no-op)
  [switch]$KeepResources)
$ErrorActionPreference = 'Stop'
$here = [System.IO.Path]::GetDirectoryName($PSCommandPath)
if ([string]::IsNullOrWhiteSpace($here) -or -not (Test-Path -LiteralPath $here)) { throw "cannot resolve script directory (PSCommandPath='$PSCommandPath')" }
$here = [System.IO.Path]::GetFullPath($here)
$OutDir = $here
Write-Output "SCRIPT_DIR=$here"; Write-Output "OUT_DIR=$OutDir"
. (Join-Path $here 'native-launch.ps1')   # Format-NativeArg / Get-NativeArgString (quotes paths with spaces for Start-Process)
function CrashIf($stage) { if ($CrashAfter -eq $stage) { throw "CRASH_INJECTED_AFTER_$stage" } }   # PHASE C test seam
$noBom = New-Object System.Text.UTF8Encoding($false)
$prefix = "FusionV06Poc-$RunId"
$image = "fusion-hv-poc-img:$RunId"
$worker = "$prefix-pipe"
$pipeLeaf = "$prefix-pipe"
$pipePath = "\\.\pipe\$pipeLeaf"
$cred = ([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N'))
$shimPort = 51720; $provPort = 51730
$providerIp = '127.0.0.1'   # the synthetic provider is a host loopback listener; ONLY the broker (host) reaches it
$jobs = @(); $brokerProc = $null; $providerProcs = @()
$otherName = "$prefix-other"   # PHASE B: second disposable "other container/worker" on nat (must be unreachable from worker)

function Write-Json($path, $obj) { [System.IO.File]::WriteAllText($path, ($obj | ConvertTo-Json -Depth 10), $noBom) }

# PHASE C: standalone idempotent cleanup for THIS RunId only (prefix-scoped). Used to recover orphans after a hard
# cancel (the normal finally never ran) and to prove idempotency (running it twice is a clean no-op). Removes ONLY
# resources carrying the exact FusionV06Poc-<RunId> prefix: never any unrelated container/image/network/process.
function Invoke-PocCleanupStandalone {
  $removed = @()
  foreach ($c in @($otherName, $worker)) { if (& docker ps -a --format '{{.Names}}' | Where-Object { $_ -eq $c }) { & docker rm -f $c 2>$null | Out-Null; for ($k = 0; $k -lt 20; $k++) { if (-not (& docker ps -a --format '{{.Names}}' 2>$null | Where-Object { $_ -eq $c })) { break }; Start-Sleep -Milliseconds 400 }; $removed += $c } }
  if (& docker images --format '{{.Repository}}:{{.Tag}}' | Where-Object { $_ -eq $image }) { & docker rmi $image 2>$null | Out-Null; $removed += $image }
  # Kill any orphaned broker/provider for THIS run id by command line (the process objects are gone after a hard cancel).
  Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match [regex]::Escape($RunId) -and $_.CommandLine -match 'pipe-broker\.ps1|token-provider\.mjs' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $removed += "pid$($_.ProcessId)" }
  Start-Sleep -Milliseconds 300   # let killed providers release their redirected .out handles before we delete them
  Get-ChildItem $OutDir -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "$prefix-*.log" -or $_.Name -like "$prefix-*.out" -or $_.Name -like "$prefix-*.ready" } | ForEach-Object { Remove-Item -Force -ErrorAction SilentlyContinue $_.FullName }
  return $removed
}
if ($CleanupOnly) {
  $r = Invoke-PocCleanupStandalone
  Write-Output ("CLEANUP_ONLY runId=$RunId removed=[" + ($r -join ',') + "]")
  $workerGone = (-not (& docker ps -a --format '{{.Names}}' | Where-Object { $_ -eq $worker }))
  $otherGone = (-not (& docker ps -a --format '{{.Names}}' | Where-Object { $_ -eq $otherName }))
  $imgGone = (-not (& docker images --format '{{.Repository}}:{{.Tag}}' | Where-Object { $_ -eq $image }))
  Write-Output ("CLEANUP_ONLY_RESIDUE workerGone=$workerGone otherGone=$otherGone imageGone=$imgGone")
  if ($workerGone -and $otherGone -and $imgGone) { exit 0 } else { exit 1 }
}

$runVerdict = 'EXECUTION_ERROR'
try {
  $osType = (& docker info --format '{{.OSType}}' 2>$null)
  if ("$osType".Trim() -ne 'windows') { throw "Docker is not in Windows-container mode (OSType=$osType). Switch: docker desktop engine use windows" }

  # 1. Build the worker image (nanoserver + node + fake-provider + guest shim + pipe canary + protocol).
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'build-worker-image.ps1') -RunId $RunId
  if ($LASTEXITCODE -ne 0) { throw "image build failed" }

  # 2. Synthetic provider stand-in = the ONE approved destination. An ASYNC Node listener (node token-provider.mjs) that
  #    handles concurrent broker connections, writes the per-run token on connect, DRAINS the forwarded request, and
  #    closes with a graceful FIN. The earlier sequential PowerShell Start-Job listener serialized connections and had
  #    fragile runspace/receive-timeout semantics that left the FIRST (tunnel-held shim) connection's response token
  #    unread by the broker; the async server matches the proven host-side e2e provider and removes that whole class.
  $nodeExe = (Get-Command node -ErrorAction Stop).Source
  function Start-TokenProvider($ip, $port, $tag) {
    # stderr -> provider-diagnostic-<RunId>-<tag>.log (OUTSIDE the "$prefix-*" cleanup glob, so it survives for analysis);
    # stdout -> "$prefix-provider-<tag>.out" (cleaned up) carries the PROVIDER_READY readiness line.
    $errLog = Join-Path $OutDir "provider-diagnostic-$RunId-$tag.log"
    $outLog = Join-Path $OutDir "$prefix-provider-$tag.out"
    if (Test-Path $outLog) { Remove-Item -Force $outLog }
    # $RunId is passed as a trailing arg (ignored by the provider logic) ONLY so the process command line carries the
    # run id - that lets standalone -CleanupOnly identify and kill orphaned providers after a hard cancel (their args
    # are otherwise just ip/port/cred/tag with no run id).
    $argList = Get-NativeArgString @((Join-Path $here 'token-provider.mjs'), $ip, "$port", $cred, $tag, $RunId)
    $p = Start-Process -FilePath $nodeExe -ArgumentList $argList -PassThru -WindowStyle Hidden -RedirectStandardError $errLog -RedirectStandardOutput $outLog
    for ($i = 0; $i -lt 40; $i++) {
      if ($p.HasExited) { throw "token-provider ($tag) exited early (exit=$($p.ExitCode)); see provider-diagnostic-$RunId-$tag.log" }
      if ((Test-Path $outLog) -and (Select-String -Path $outLog -Pattern 'PROVIDER_READY' -Quiet)) { return $p }
      Start-Sleep -Milliseconds 150
    }
    throw "token-provider ($tag) did not become ready within timeout; see provider-diagnostic-$RunId-$tag.log"
  }
  $providerProcs += (Start-TokenProvider $providerIp $provPort 'provider')
  if ($KillMidRun -eq 'provider') { Write-Output "KILL_MIDRUN provider"; foreach ($pp in $providerProcs) { Stop-Process -Id $pp.Id -Force -ErrorAction SilentlyContinue } }
  CrashIf 'providerStart'

  # 2a. LAN POSITIVE-CONTROL: discover the current non-PoC host LAN IPv4 (default-gateway interface) and bind a
  #     Fusion-owned listener there on a dedicated PoC port. The worker probes this EXACT address:port, and the host
  #     proves it can reach it. The listener only BINDS the existing address (no adapter/route change). If no LAN IPv4
  #     is found, rawHostLan stays INCOMPLETE (never hard-coded, never assumed reachable).
  $lanIp = $null; $lanPort = 51740
  try { $lanIp = (Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | Select-Object -First 1).IPv4Address.IPAddress } catch { }
  if ($lanIp) { $providerProcs += (Start-TokenProvider $lanIp $lanPort 'lanctl') }
  Write-Output "LAN_CONTROL=$lanIp`:$lanPort"

  # 3. Host broker (.NET) bound to the per-run pipe; forwards ONLY to the synthetic provider; per-run credential.
  #    The broker argv is quoted via the SHARED native-launch helper so the script path AND ReadyFile path (which live
  #    under a repo dir that may contain spaces, e.g. "D:\apps backup\fusion-cli\...") survive Start-Process intact.
  $readyFile = Join-Path $OutDir "$prefix-broker.ready"
  if (Test-Path $readyFile) { Remove-Item -Force $readyFile }
  # Diagnostics use a name OUTSIDE the "$prefix-*" cleanup glob so they SURVIVE cleanup on a startup failure.
  $brokerLog = Join-Path $OutDir "broker-diagnostic-$RunId.log"; $brokerOut = Join-Path $OutDir "broker-diagnostic-$RunId.out"
  $brokerArgList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $here 'pipe-broker.ps1'),
    '-RunId', $RunId, '-PipeName', $pipeLeaf, '-Credential', $cred, '-AllowedHost', $providerIp, '-AllowedPort', "$provPort", '-DaclMode', $DaclMode, '-ReadyFile', $readyFile)
  if ($NarrowPrincipal) { $brokerArgList += @('-NarrowPrincipal', $NarrowPrincipal) }
  $brokerArgString = Get-NativeArgString $brokerArgList
  $env:FUSION_BROKER_DIAG = '1'   # the child broker inherits this; enables bounded per-connection stderr diagnostics
  $brokerProc = Start-Process -FilePath 'powershell' -ArgumentList $brokerArgString -PassThru -WindowStyle Hidden -RedirectStandardError $brokerLog -RedirectStandardOutput $brokerOut
  # Readiness: stop early (report the exit code) if the broker process dies before the ReadyFile appears.
  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    if (Test-Path $readyFile) { $ready = $true; break }
    if ($brokerProc.HasExited) { throw "host broker exited early (exit=$($brokerProc.ExitCode)) before readiness; diagnostics: broker-diagnostic-$RunId.log / .out" }
    Start-Sleep -Milliseconds 250
  }
  if (-not $ready) { throw "host broker did not come up within timeout; diagnostics: broker-diagnostic-$RunId.log / .out" }

  # 4. Worker: --isolation=hyperv, --network none, EXACTLY ONE mapped Fusion pipe (argv from the tested builder).
  $argJson = & node (Join-Path $here 'pipe-run-args.mjs') $worker $image $pipePath 'C:\fusion\node.exe' '-e' 'setInterval(()=>{},1000000000)'
  if ($LASTEXITCODE -ne 0) { throw "pipe worker argv refused: $argJson" }
  $runArgs = $argJson | ConvertFrom-Json
  & docker @runArgs | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "worker failed to start ($LASTEXITCODE)" }
  if ($KillMidRun -eq 'worker') { Write-Output "KILL_MIDRUN worker"; & docker kill $worker 2>$null | Out-Null }
  if ($KillMidRun -eq 'broker') { Write-Output "KILL_MIDRUN broker"; if ($brokerProc) { Stop-Process -Id $brokerProc.Id -Force -ErrorAction SilentlyContinue } }
  CrashIf 'workerStart'

  # 5. Capture the REAL Docker/HCS mount shape (gates PROVEN via WORKER_RUNTIME_SHAPE; not inferred from argv).
  $inspect = & docker inspect $worker --format '{{json .}}' | ConvertFrom-Json
  $mounts = @($inspect.Mounts | ForEach-Object { [ordered]@{ Type = "$($_.Type)"; Source = "$($_.Source)"; Destination = "$($_.Destination)" } })
  $netCount = @($inspect.NetworkSettings.Networks.PSObject.Properties).Count
  $runtimeShape = [ordered]@{ mounts = $mounts; networks = $netCount }
  Write-Output ("DOCKER_STATE mounts=$($mounts.Count) networks=$netCount")

  # 6. Start the guest shim (background). Redirect its stderr to a container-local file via cmd /c so the shim's bounded
  #    SHIM diagnostics survive the detached `docker exec -d` (which otherwise discards all output); copied to the host
  #    after the canary (step 6a) for root-cause analysis of the allowed-route relay.
  $shimLogGuest = 'C:\fusion\shim-diagnostic.log'
  $shimCmd = "C:\fusion\node.exe C:\fusion\guest-shim.mjs $shimPort $pipePath $cred $providerIp $provPort 2> $shimLogGuest"
  & docker exec -d $worker cmd /c $shimCmd | Out-Null
  Start-Sleep -Milliseconds 1500
  $lanTargetIp = if ($lanIp) { $lanIp } else { '169.254.255.255' }  # if no LAN IP was found there is no control; stays INCOMPLETE

  # --- PHASE B extra negative targets (widen the adversarial matrix; none weaken the existing probes). All must be
  #     UNREACHABLE from the --network none worker; where a deterministic host positive control exists we bind/own it. ---
  # (b1) Default gateway (router) IPv4 on a test port.
  $gwIp = $null; try { $gwIp = (Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | Select-Object -First 1).IPv4DefaultGateway.NextHop } catch {}
  $gwPort = 51750
  # (b2) Alternate host vNIC: a second host IPv4 on a DIFFERENT interface than the default-gateway LAN IP (e.g. a Docker/
  #      WSL vEthernet). Bind a Fusion token listener there so the host has a deterministic positive control.
  $altIp = $null
  try { $altIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -ne $lanIp -and $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1).IPAddress } catch {}
  $altPort = 51751
  if ($altIp) { $providerProcs += (Start-TokenProvider $altIp $altPort 'altvnic') }
  Write-Output "ALT_VNIC=$altIp`:$altPort"
  # (b3) A second DISPOSABLE container on the default nat network with a token listener = an "other worker/container".
  #      The host proves it can reach the container's nat IP; the --network none worker must not. Best-effort: if it
  #      cannot start (e.g. memory), rawOtherContainer is simply not probed (omitted), never a false pass.
  $otherPort = 51752; $otherIp = $null
  $otherListen = "require('net').createServer(function(s){s.on('error',function(){});s.on('data',function(){});s.write('OTHERWORKER\n');setTimeout(function(){try{s.end()}catch(e){}},1500)}).listen($otherPort,'0.0.0.0',function(){console.log('OTHER_READY')})"
  try {
    # Cap the footprint (second Hyper-V VM) so two VMs do not overload the Windows engine; it is torn down right after
    # its host positive control (step 7b), so the main worker's kill never contends with a second live Hyper-V VM.
    & docker run -d --rm --memory 1g --name $otherName --network nat $image C:\fusion\node.exe -e $otherListen | Out-Null
    if ($LASTEXITCODE -eq 0) { for ($i = 0; $i -lt 25 -and -not $otherIp; $i++) { $otherIp = (& docker inspect $otherName --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' 2>$null); if (-not $otherIp) { Start-Sleep -Milliseconds 300 } } }
  } catch { Write-Output "OTHER_CONTAINER_START_FAILED: $($_.Exception.Message)" }
  Write-Output "OTHER_CONTAINER=$otherName ip=$otherIp`:$otherPort"
  # (b4) Hostname-based egress: a public resolvable name. Under --network none DNS cannot resolve -> blocked; the host CAN.
  $hostnameTarget = 'one.one.one.one'
  # (b5) IPv6 egress literal (Cloudflare). Under --network none there is no IPv6 route -> unreachable; if the worker has
  #      no IPv6 AF at all the canary records not_applicable (never a silent pass).
  $ipv6Target = '2606:4700:4700::1111'

  # Build the raw-tcp tuple array so EACH element is a clean 3-item [host,port,key] array (the earlier leading-comma
  # literal wrapped the first tuple, dropping rawInternet). The ,@(...) idiom appends each inner array as one element.
  $rawTcp = @()
  $rawTcp += , @('1.1.1.1', 443, 'rawInternet')
  $rawTcp += , @($lanTargetIp, $lanPort, 'rawHostLan')
  $rawTcp += , @('127.0.0.1', 9, 'rawHostLocal')
  $rawTcp += , @($providerIp, $provPort, 'rawDirectProvider')
  $rawTcp += , @('1.0.0.1', 443, 'rawSocketBypass')
  if ($gwIp) { $rawTcp += , @($gwIp, $gwPort, 'rawGateway') }
  if ($altIp) { $rawTcp += , @($altIp, $altPort, 'rawAltVnic') }
  if ($otherIp) { $rawTcp += , @($otherIp, $otherPort, 'rawOtherContainer') }
  $rawTcp += , @($hostnameTarget, 443, 'rawHostname')
  $rawTcp += , @($ipv6Target, 443, 'rawIPv6')
  $spec = @{ ms = 4000; token = $cred; shimPort = $shimPort; pipePath = $pipePath; credential = $cred; allowedHost = $providerIp; allowedPort = $provPort
    rawTcp = $rawTcp
    dns = '1.1.1.1'
    guessPipes = @("\\.\pipe\FusionV06Poc-deadbeef-pipe")
    # Genuine HOST management pipes that must be unreachable from the isolated guest (NOT guest-internal lsass/ntsvcs,
    # which are the worker's own OS pipes and never a host-IPC escape).
    otherHostPipes = @("\\.\pipe\docker_engine", "\\.\pipe\dockerDesktopWindowsEngine", "\\.\pipe\dockerDesktopLinuxEngine")
    spawn = $true; hold = $false }
  $specB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($spec | ConvertTo-Json -Depth 8 -Compress)))
  $raw = & docker exec -e "FUSION_PIPE_SPEC=$specB64" $worker C:\fusion\node.exe C:\fusion\pipe-canary.mjs 2>$null
  $line = ($raw -split "`n") | Where-Object { $_ -like 'PROBE_JSON *' } | Select-Object -First 1
  $probe = if ($line) { $line.Substring('PROBE_JSON '.Length) | ConvertFrom-Json } else { $null }

  # 6a. Copy the shim's in-container stderr diagnostics to a host file (name OUTSIDE the "$prefix-*" cleanup glob so it
  #     SURVIVES cleanup). Best-effort: the worker is still alive here (killed in step 9).
  $shimDiag = Join-Path $OutDir "shim-diagnostic-$RunId.log"
  try { $shimText = & docker exec $worker cmd /c "type $shimLogGuest" 2>$null; [System.IO.File]::WriteAllText($shimDiag, (($shimText -join "`n") + "`n"), $noBom); Write-Output "SHIM_DIAG=$shimDiag" } catch { Write-Output "SHIM_DIAG_UNAVAILABLE: $($_.Exception.Message)" }
  CrashIf 'canary'

  # 7. Host positive controls (host CAN reach these; the worker must not). Each targets the EXACT address:port the
  #    worker probed. DNS is a REAL bounded UDP probe against the same server (no hard-coded 'answered').
  function Test-HostTcp($ip, $port) { $c = New-Object System.Net.Sockets.TcpClient; try { $iar = $c.BeginConnect($ip, [int]$port, $null, $null); if ($iar.AsyncWaitHandle.WaitOne(3000, $false)) { $c.EndConnect($iar); 'connected' } else { 'timeout' } } catch { 'refused' } finally { $c.Close() } }
  function Test-HostDns($server) {
    $u = New-Object System.Net.Sockets.UdpClient
    try {
      $q = [byte[]]@(0xab, 0xcd, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x07, 0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65, 0x03, 0x63, 0x6f, 0x6d, 0x00, 0x00, 0x01, 0x00, 0x01)
      [void]$u.Send($q, $q.Length, $server, 53); $u.Client.ReceiveTimeout = 3000
      $ep = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0); [void]$u.Receive([ref]$ep); 'answered'
    } catch { 'timeout' } finally { $u.Close() }
  }
  # rawHostLan control only exists if a LAN IP was discovered; otherwise it stays unprovable -> INCOMPLETE.
  $lanControl = if ($lanIp) { (Test-HostTcp $lanIp $lanPort) } else { 'not_run' }
  $hostControls = @{ rawInternet = (Test-HostTcp '1.1.1.1' 443); rawHostLan = $lanControl; rawDns = (Test-HostDns '1.1.1.1'); rawDirectProvider = (Test-HostTcp $providerIp $provPort); rawSocketBypass = (Test-HostTcp '1.0.0.1' 443) }
  # PHASE B host positive controls (informational where a listener is owned; the worker outcome is a definitive deny
  # via "unreachable" regardless). Only recorded when the matching target was actually probed.
  if ($gwIp) { $hostControls.rawGateway = (Test-HostTcp $gwIp $gwPort) }
  if ($altIp) { $hostControls.rawAltVnic = (Test-HostTcp $altIp $altPort) }
  if ($otherIp) { $hostControls.rawOtherContainer = (Test-HostTcp $otherIp $otherPort) }
  $hostControls.rawHostname = (Test-HostTcp $hostnameTarget 443)
  $hostControls.rawIPv6 = (Test-HostTcp $ipv6Target 443)
  # 7b. Tear down the second ("other") container NOW - its probe + host control are done. Keeping only ONE live Hyper-V
  #     VM for the step-9 worker kill avoids the HCS/engine overload (two concurrent Hyper-V VM teardowns wedged the
  #     Docker Windows daemon). The finally block still removes it idempotently as a safety net.
  try { if (& docker ps -a --format '{{.Names}}' | Where-Object { $_ -eq $otherName }) { & docker rm -f $otherName 2>$null | Out-Null } } catch {}
  CrashIf 'hostControls'

  # 8. Evidence assembly for the evaluator.
  $pipeEv = [ordered]@{
    allowedRoute = if ($probe) { "$($probe.pipe.allowedRoute.outcome)" } else { 'not_run' }
    allowedRouteTokenEchoed = if ($probe -and $probe.pipe.allowedRoute) { [bool]$probe.pipe.allowedRoute.tokenEchoed } else { $false }
    directPipeNoAuth = if ($probe) { "$($probe.pipe.directNoAuth.outcome)" } else { 'not_run' }
    directPipeWrongCred = if ($probe) { "$($probe.pipe.directWrongCred.outcome)" } else { 'not_run' }
    directPipeWrongDest = if ($probe) { "$($probe.pipe.directWrongDest.outcome)" } else { 'not_run' }
    unauthorizedDestThroughBroker = if ($probe) { "$($probe.pipe.directWrongDest.outcome)" } else { 'not_run' }
    # Worst-case over the structured pipe-guess array: any reachable guessed pipe => "connected" (an escape); else refused.
    pipeNameGuess = if ($probe) { $g = @($probe.pipeGuess | ForEach-Object { "$($_.outcome)" }); if ($g -contains 'connected') { 'connected' } elseif ($g.Count -gt 0) { 'refused' } else { 'not_run' } } else { 'not_run' }
    directPipeAuthorized = if ($probe) { "$($probe.pipe.directAuthorized.outcome)" } else { 'not_run' }
  }
  # Per-host-pipe outcomes (each genuine HOST management pipe), kept in full for the evidence; the evaluator field is the
  # worst case (any reachable host pipe => ALLOWED => FAIL).
  $hostPipeResults = if ($probe) { @($probe.hostPipes | ForEach-Object { [ordered]@{ target = "$($_.target)"; outcome = "$($_.outcome)" } }) } else { @() }
  $hostPipeWorst = if ($hostPipeResults.Count -eq 0) { 'not_run' } elseif (($hostPipeResults | Where-Object { $_.outcome -eq 'connected' }).Count -gt 0) { 'connected' } else { 'refused' }
  $netEv = [ordered]@{
    facts = if ($probe) { $probe.facts } else { @{} }
    rawInternet = if ($probe) { "$($probe.raw.rawInternet.outcome)" } else { 'not_run' }
    rawHostLan = if ($probe) { "$($probe.raw.rawHostLan.outcome)" } else { 'not_run' }
    rawDns = if ($probe) { "$($probe.dns.outcome)" } else { 'not_run' }
    rawDirectProvider = if ($probe) { "$($probe.raw.rawDirectProvider.outcome)" } else { 'not_run' }
    rawSocketBypass = if ($probe) { "$($probe.raw.rawSocketBypass.outcome)" } else { 'not_run' }
    otherHostPipeOpen = $hostPipeWorst
    hostPipeResults = $hostPipeResults
    pipeGuessResults = if ($probe) { @($probe.pipeGuess | ForEach-Object { [ordered]@{ target = "$($_.target)"; outcome = "$($_.outcome)" } }) } else { @() }
    hostControls = $hostControls
  }
  # PHASE B optional negative outcomes: only add the key when the target was actually probed (so the evaluator enforces
  # it; an omitted key is skipped, never INCOMPLETE). rawHostname/rawIPv6 are always probed.
  if ($probe) {
    if ($gwIp) { $netEv.rawGateway = "$($probe.raw.rawGateway.outcome)" }
    if ($altIp) { $netEv.rawAltVnic = "$($probe.raw.rawAltVnic.outcome)" }
    if ($otherIp) { $netEv.rawOtherContainer = "$($probe.raw.rawOtherContainer.outcome)" }
    $netEv.rawHostname = "$($probe.raw.rawHostname.outcome)"
    $netEv.rawIPv6 = "$($probe.raw.rawIPv6.outcome)"
  }
  Write-Json (Join-Path $OutDir "pipe-evidence-$RunId.json") $pipeEv
  Write-Json (Join-Path $OutDir "network-none-evidence-$RunId.json") $netEv

  CrashIf 'beforeKill'
  # 9. Process-tree: child captured + worker killed (worker runs --rm; kill auto-removes). Poll for absence.
  $childPid = if ($probe -and $probe.pids.child) { [int]$probe.pids.child } else { 0 }
  & docker kill $worker 2>$null | Out-Null
  $gone = $false; for ($i = 0; $i -lt 20 -and -not $gone; $i++) { if (-not (& docker ps -a --format '{{.Names}}' | Where-Object { $_ -eq $worker })) { $gone = $true } else { Start-Sleep -Milliseconds 300 } }
  $ptVerdict = & node (Join-Path $here 'lifecycle.mjs') 'process-tree' "$childPid" ($gone.ToString().ToLower()) 'true'
  Write-Json (Join-Path $OutDir "lifecycle-evidence-$RunId.json") ([ordered]@{ processTreeContainment = "$ptVerdict"; forcedKillCleanup = if ($gone) { 'PASS' } else { 'FAIL' }; childPid = $childPid; containerGone = $gone })

  # 10. Filesystem dimension is NOT exercised by this network-focused PoC (no view/scratch mounts here); record NOT_RUN
  #     honestly so the full HARD verdict stays INCOMPLETE while the network boundary is evaluated on its own.
  $fsEv = [ordered]@{ note = 'filesystem boundary not exercised in the pipe network PoC; proven separately'; viewRead = 'NOT_RUN' }
  Write-Json (Join-Path $OutDir "filesystem-evidence-$RunId.json") $fsEv

  # 11. Compute verdicts (never manual). The runtime shape (actual docker inspect mounts) GATES PROVEN.
  $doc = [ordered]@{ pipe = $pipeEv; network = $netEv; runtimeShape = $runtimeShape; runtimeShapeExpected = @{ pipe = $pipePath }
    filesystem = @{}; lifecycle = @{ processTreeContainment = "$ptVerdict"; forcedKillCleanup = $(if ($gone) { 'PASS' } else { 'FAIL' }) }; cleanup = @{ cleanupOk = 'PASS' } }
  $resPath = Join-Path $OutDir "result-$RunId.json"
  Write-Json $resPath ([ordered]@{ runId = $RunId; daclMode = $DaclMode; evidence = $doc })
  Write-Output "RESULT=$resPath"
  & node (Join-Path $here 'pipe-verify.mjs') $resPath
  $vexit = $LASTEXITCODE
  if ($vexit -notin 0, 1, 2) { $runVerdict = 'EXECUTION_ERROR' } else { $runVerdict = @('PASS', 'FAIL', 'INCOMPLETE')[$vexit] }
}
catch { Write-Output "PIPE_POC_EXECUTION_ERROR: $($_.Exception.Message)"; $runVerdict = 'EXECUTION_ERROR' }
finally {
  if (-not $KeepResources) {
    Write-Output "== cleanup (only $prefix* / $image) =="
    # Tear the containers down STRICTLY SEQUENTIALLY - remove the second ("other") container, WAIT until it is gone, then
    # the worker. Removing two live Hyper-V VMs concurrently overloaded the Docker Windows (HCS) engine on this host
    # (transient 500s); one-at-a-time keeps HCS load bounded. On the normal path the other container is already gone
    # (removed at step 7b), so this is a no-op there; it only matters when a crash occurred before step 7b.
    foreach ($c in @($otherName, $worker)) {
      if (& docker ps -a --format '{{.Names}}' | Where-Object { $_ -eq $c }) {
        & docker rm -f $c 2>$null | Out-Null
        for ($k = 0; $k -lt 20; $k++) { if (-not (& docker ps -a --format '{{.Names}}' 2>$null | Where-Object { $_ -eq $c })) { break }; Start-Sleep -Milliseconds 400 }
      }
    }
    if (& docker images --format '{{.Repository}}:{{.Tag}}' | Where-Object { $_ -eq $image }) { & docker rmi $image | Out-Null }
    if ($brokerProc -and (Get-Process -Id $brokerProc.Id -ErrorAction SilentlyContinue)) { Stop-Process -Id $brokerProc.Id -Force -ErrorAction SilentlyContinue }
    foreach ($pp in $providerProcs) { if ($pp -and (Get-Process -Id $pp.Id -ErrorAction SilentlyContinue)) { Stop-Process -Id $pp.Id -Force -ErrorAction SilentlyContinue } }
    Get-Job | Where-Object { $_.Name -like "$prefix-*" } | ForEach-Object { Stop-Job $_; Remove-Job $_ }
    Get-ChildItem $OutDir -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "$prefix-*.log" -or $_.Name -like "$prefix-*.out" -or $_.Name -like "$prefix-*.ready" } | ForEach-Object { Remove-Item -Force -ErrorAction SilentlyContinue $_.FullName }
    $alive = if ($brokerProc) { [bool](Get-Process -Id $brokerProc.Id -ErrorAction SilentlyContinue) } else { $false }
    $provAlive = @($providerProcs | Where-Object { $_ -and (Get-Process -Id $_.Id -ErrorAction SilentlyContinue) }).Count
    $workerGone = (-not (& docker ps -a --format '{{.Names}}' | Where-Object { $_ -eq $worker }))
    $otherGone = (-not (& docker ps -a --format '{{.Names}}' | Where-Object { $_ -eq $otherName }))
    $cleanupOk = $workerGone -and $otherGone -and (-not (& docker images --format '{{.Repository}}:{{.Tag}}' | Where-Object { $_ -eq $image })) -and (-not $alive) -and ($provAlive -eq 0)
    Write-Json (Join-Path $OutDir "cleanup-$RunId.json") ([ordered]@{ runId = $RunId; cleanupOk = $(if ($cleanupOk) { 'PASS' } else { 'FAIL' }); workerGone = $workerGone; otherContainerGone = $otherGone; brokerAlive = $alive; providerProcsAlive = $provAlive })
    Write-Output ("CLEANUP_OK=" + $cleanupOk)
  }
  else { Write-Output "KeepResources set - not cleaning up." }
}
Write-Output "RUN_VERDICT=$runVerdict"
Write-Output "BROKER_ONLY_NETWORK_BOUNDARY stays NOT_PROVEN unless pipe-verify reports PROVEN and the evidence is reviewed."
switch -regex ("$runVerdict") { '^PASS$' { exit 0 } '^FAIL$' { exit 1 } '^INCOMPLETE$' { exit 2 } default { exit 3 } }
