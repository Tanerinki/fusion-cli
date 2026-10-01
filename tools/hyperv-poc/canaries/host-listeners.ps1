# Fusion v0.6 Hyper-V PoC - host-side canary listeners (maintainer-run). Starts, as FusionV06Poc-<RunId>-* background
# jobs, the destinations the worker will probe AND the synthetic provider stand-in the broker forwards to. Every listener
# binds the dedicated worker-facing host/vSwitch IP ($BrokerIp, NOT 127.0.0.1) and echoes the per-run token, so (a) the
# worker's ALLOWED-broker canary can confirm a real round-trip, and (b) the host positive-control probe can confirm each
# target is genuinely reachable from the host (the control that turns a worker timeout into a PROVEN deny). Returns the
# chosen IPs/ports + token as JSON. Creates no network policy; applies no ACL.
[CmdletBinding()] param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9]{4,32}$')][string]$RunId,
  [Parameter(Mandatory = $true)][string]$BrokerIp,
  [Parameter(Mandatory = $true)][string]$Token,
  [int]$BrokerPort = 47610, [int]$WrongPort = 47611, [int]$HostOtherPort = 47620, [int]$ProviderPort = 47630)
$prefix = "FusionV06Poc-$RunId"
function Start-Listener($name, $ip, $port, $token) {
  Start-Job -Name "$prefix-$name" -ScriptBlock {
    param($ip, $port, $token)
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse($ip), [int]$port)
    $listener.Start()
    try {
      while ($true) {
        $client = $listener.AcceptTcpClient()
        try {
          $stream = $client.GetStream()
          $bytes = [Text.Encoding]::ASCII.GetBytes("$token`n")
          $stream.Write($bytes, 0, $bytes.Length); $stream.Flush()
        } catch { }
        finally { $client.Close() }
      }
    } finally { $listener.Stop() }
  } -ArgumentList $ip, $port, $token | Out-Null
}
Start-Listener 'broker'    $BrokerIp $BrokerPort    $Token
Start-Listener 'wrongport' $BrokerIp $WrongPort     $Token
Start-Listener 'hostother' $BrokerIp $HostOtherPort $Token
Start-Listener 'provider'  $BrokerIp $ProviderPort  $Token
[pscustomobject]@{ brokerIp = $BrokerIp; brokerPort = $BrokerPort; wrongPort = $WrongPort; hostOtherPort = $HostOtherPort; providerPort = $ProviderPort } | ConvertTo-Json -Compress
