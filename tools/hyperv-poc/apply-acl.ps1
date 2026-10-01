# Fusion v0.6 Hyper-V PoC — apply (or clear) the endpoint ACL via the HCN API (ELEVATED; maintainer-run).
#
# IMPORTANT SAFETY PROPERTY: the ACL is applied to the WORKER's OWN ephemeral HNS/HCN endpoint (the one discovered for
# this run). It is NOT a machine firewall rule and creates NO persistent host object: when the worker container is
# removed (cleanup, or any failure path), its endpoint — and this ACL with it — ceases to exist. There is nothing global
# to roll back. The ACL JSON is produced by the pure, CI-tested builder (acl-policy.mjs → toHcnModifyRequest), written to
# $SettingsPath by the orchestrator; this script only submits it to the endpoint the orchestrator discovered.
#
# This machine exposes the modern HCN API (computenetwork.dll present) but NOT the HostComputeNetwork PowerShell module,
# so the policy is submitted by P/Invoke to HcnModifyEndpointSettings. The legacy hns.1 COM path is the documented
# fallback (see docs/v0.6-hyperv-vfp-acl-plan.md). UNTESTED on hardware until the maintainer runs it elevated.
[CmdletBinding()] param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9]{4,32}$')][string]$RunId,
  [Parameter(Mandatory = $true)][string]$EndpointId,
  [Parameter(Mandatory = $true)][string]$SettingsPath)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $SettingsPath)) { throw "ACL settings JSON not found: $SettingsPath" }
$settings = Get-Content -Raw $SettingsPath
$guid = [Guid]$EndpointId   # throws if the discovered endpoint id is not a GUID — never guesses

if (-not ([System.Management.Automation.PSTypeName]'Fusion.Hcn').Type) {
  Add-Type -Namespace 'Fusion' -Name 'Hcn' -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("computenetwork.dll")]
public static extern int HcnOpenEndpoint(ref System.Guid Id, out System.IntPtr Endpoint, [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] out string ErrorRecord);
[System.Runtime.InteropServices.DllImport("computenetwork.dll")]
public static extern int HcnModifyEndpointSettings(System.IntPtr Endpoint, [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] string Settings, [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] out string ErrorRecord);
[System.Runtime.InteropServices.DllImport("computenetwork.dll")]
public static extern int HcnCloseEndpoint(System.IntPtr Endpoint);
'@
}

$ep = [IntPtr]::Zero; $err = $null
$hrOpen = [Fusion.Hcn]::HcnOpenEndpoint([ref]$guid, [ref]$ep, [ref]$err)
if ($hrOpen -ne 0) { Write-Output "ACL_APPLIED=NO (HcnOpenEndpoint hr=0x$($hrOpen.ToString('X8')) err=$err)"; exit 2 }
try {
  $err2 = $null
  $hrMod = [Fusion.Hcn]::HcnModifyEndpointSettings($ep, $settings, [ref]$err2)
  if ($hrMod -ne 0) { Write-Output "ACL_APPLIED=NO (HcnModifyEndpointSettings hr=0x$($hrMod.ToString('X8')) err=$err2)"; exit 2 }
  Write-Output "ACL_APPLIED=YES (endpoint $EndpointId)"
  exit 0
} finally {
  [void][Fusion.Hcn]::HcnCloseEndpoint($ep)
}
