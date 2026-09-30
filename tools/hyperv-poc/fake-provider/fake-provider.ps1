# Fusion v0.6 Hyper-V PoC — FAKE provider (runs INSIDE the worker). UNTESTED maintainer-run. NO secrets, NO real model.
# Emits ONE machine-readable JSON object with per-target socket outcomes + filesystem outcomes + process-tree markers.
# It attempts DIRECT sockets (ignoring any HTTPS_PROXY) so the run proves the NETWORK-LAYER policy, not the proxy config.
[CmdletBinding()] param(
  [Parameter(Mandatory = $true)][string]$SpecPath,   # JSON: { targets:[{key,ip,port}], reads:[{key,path}], writes:[{key,path}], spawn:bool, sleep:bool, exitCode:int }
  [Parameter(Mandatory = $true)][string]$OutPath)
$ErrorActionPreference = 'Continue'
$spec = Get-Content -Raw $SpecPath | ConvertFrom-Json
$result = [ordered]@{ marker = 'FUSION_POC_FAKE_PROVIDER'; envNames = @($env:HTTPS_PROXY, $env:HTTP_PROXY | ForEach-Object { if ($_){'PROXY_SET'} } ); sockets = @{}; fs = @{}; pids = @{} }

function Try-Tcp($ip, $port) {
  # Direct TCP connect with a bounded timeout. Distinguish connected / refused / timeout / no-route.
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $c.BeginConnect($ip, [int]$port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(3000, $false)) { $c.Close(); return 'timeout' }
    $c.EndConnect($iar); $c.Close(); return 'connected'
  } catch [System.Net.Sockets.SocketException] {
    switch ($_.Exception.SocketErrorCode) {
      'ConnectionRefused' { return 'refused' }
      'HostUnreachable'   { return 'no-route' }
      'NetworkUnreachable'{ return 'no-route' }
      'TimedOut'          { return 'timeout' }
      default             { return 'blocked' }   # AccessDenied / other = actively blocked by policy
    }
  } catch { return 'blocked' } finally { $c.Dispose() }
}

foreach ($t in $spec.targets) { $result.sockets[$t.key] = Try-Tcp $t.ip $t.port }

foreach ($r in $spec.reads)  { try { [void](Get-Content -Raw -ErrorAction Stop $r.path); $result.fs["read_$($r.key)"] = 'ok' } catch { $result.fs["read_$($r.key)"] = 'blocked' } }
foreach ($w in $spec.writes) { try { Set-Content -ErrorAction Stop -Path $w.path -Value 'FUSION_POC_WRITE'; $result.fs["write_$($w.key)"] = 'ok' } catch { $result.fs["write_$($w.key)"] = 'blocked' } }

if ($spec.spawn) {
  # child -> grandchild that sleep, so the host can verify the whole tree is terminated with the worker.
  $child = Start-Process -PassThru powershell -ArgumentList '-NoProfile', '-Command', 'Start-Process -PassThru powershell -ArgumentList "-NoProfile","-Command","Start-Sleep 600" | Out-Null; Start-Sleep 600'
  $result.pids['self'] = $PID; $result.pids['child'] = $child.Id
}
$result | ConvertTo-Json -Depth 6 | Set-Content -Path $OutPath
if ($spec.sleep) { Start-Sleep 600 }   # stay alive until the worker is cancelled/terminated (lifecycle test)
exit ([int]$spec.exitCode)
