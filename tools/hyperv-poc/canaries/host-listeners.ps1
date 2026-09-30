# Fusion v0.6 Hyper-V PoC — host-side canary listeners. UNTESTED maintainer-run.
# Starts, as FusionV06Poc-<RunId>-prefixed background jobs, the destinations the worker will probe. The BROKER endpoint is
# on a dedicated host/vSwitch IP (NOT 127.0.0.1). Wrong-port + unrelated listeners on the SAME host IP let the run
# distinguish destination-IP enforcement from destination-PORT enforcement. Returns the chosen IPs/ports as JSON.
[CmdletBinding()] param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9]{4,32}$')][string]$RunId,
  [Parameter(Mandatory=$true)][string]$BrokerIp,      # the dedicated worker-facing host/vSwitch address (NOT 127.0.0.1)
  [int]$BrokerPort = 47610, [int]$WrongPort = 47611, [int]$UnrelatedPort = 47612)
$prefix = "FusionV06Poc-$RunId"
function Start-Listener($name,$ip,$port){
  Start-Job -Name "$prefix-$name" -ScriptBlock {
    param($ip,$port)
    $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse($ip), [int]$port); $l.Start()
    while($true){ try { $c=$l.AcceptTcpClient(); $c.Close() } catch { break } }
  } -ArgumentList $ip,$port | Out-Null
}
Start-Listener 'broker'    $BrokerIp $BrokerPort
Start-Listener 'wrongport' $BrokerIp $WrongPort
Start-Listener 'unrelated' $BrokerIp $UnrelatedPort
# A LAN canary is optional and only where safe (a second host on the LAN); omitted by default.
@{ brokerIp=$BrokerIp; brokerPort=$BrokerPort; wrongPort=$WrongPort; unrelatedPort=$UnrelatedPort } | ConvertTo-Json
