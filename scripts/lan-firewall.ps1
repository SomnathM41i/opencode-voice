# Opens the LAN gateway's port to this subnet only. Run once, as administrator.
# Windows marks phone hotspots as Public, so that profile has to be included;
# LocalSubnet is what keeps this from opening the port to wider networks.
$name = "OpenCode Voice LAN gateway"

Remove-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue

New-NetFirewallRule -DisplayName $name `
  -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3443 `
  -RemoteAddress LocalSubnet -Profile Private, Public | Out-Null

Write-Output "Allowed port 3443 from the local subnet."
