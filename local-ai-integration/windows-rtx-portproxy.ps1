[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ListenAddress,
    [Parameter(Mandatory = $true)][string]$ClientAddress,
    [Parameter(Mandatory = $true)][string]$FirewallRuleName,
    [ValidateRange(1, 24)][int]$Attempts = 18,
    [ValidateRange(1, 10)][int]$RetrySeconds = 5
)

# Native Windows startup/resume hook. Never start WSL, restart shared services,
# change firewall rules, or run this from a passive health probe.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Test-PrivateAddress([string]$Value) {
    $ip = $null
    if (-not [Net.IPAddress]::TryParse($Value, [ref]$ip)) { return $false }
    if ($ip.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { return $false }
    if ($ip.ToString() -ne $Value) { return $false }
    $b = $ip.GetAddressBytes()
    return ($b[0] -eq 10 -or ($b[0] -eq 172 -and $b[1] -ge 16 -and $b[1] -le 31) -or
        ($b[0] -eq 192 -and $b[1] -eq 168))
}

function Assert-RestrictedFirewall {
    $rule = @(Get-NetFirewallRule -Name $FirewallRuleName)
    if ($rule.Count -ne 1 -or $rule[0].Enabled -ne 'True' -or
        $rule[0].Direction -ne 'Inbound' -or $rule[0].Action -ne 'Allow') { throw 'firewall_rule_invalid' }
    $address = $rule[0] | Get-NetFirewallAddressFilter
    $port = $rule[0] | Get-NetFirewallPortFilter
    if (@($address.LocalAddress).Count -ne 1 -or $address.LocalAddress -ne $ListenAddress -or
        @($address.RemoteAddress).Count -ne 1 -or $address.RemoteAddress -ne $ClientAddress -or
        $port.Protocol -ne 'TCP' -or @($port.LocalPort).Count -ne 1 -or $port.LocalPort -ne '11435') {
        throw 'firewall_scope_invalid'
    }
}

function Test-LoopbackApi {
    try {
        $response = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/version' -TimeoutSec 2
        return -not [string]::IsNullOrEmpty($response.version)
    } catch { return $false }
}

function Test-ProxyListener {
    return @((Get-NetTCPConnection -State Listen -LocalPort 11435 -ErrorAction SilentlyContinue) |
        Where-Object { $_.LocalAddress -eq $ListenAddress }).Count -gt 0
}

function Get-ProxyTarget {
    $key = 'HKLM:\SYSTEM\CurrentControlSet\Services\PortProxy\v4tov4\tcp'
    $value = Get-ItemProperty -LiteralPath $key -Name "$ListenAddress/11435" -ErrorAction SilentlyContinue
    if ($null -eq $value) { return $null }
    return $value.PSObject.Properties["$ListenAddress/11435"].Value
}

function Repair-ExactProxy {
    # Re-publish only this endpoint; leave IP Helper and its VPN dependents alone.
    & "$env:SystemRoot\System32\netsh.exe" interface portproxy add v4tov4 `
        "listenaddress=$ListenAddress" listenport=11435 connectaddress=127.0.0.1 connectport=11434 protocol=tcp | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'portproxy_add_failed' }
}

function Invoke-StartupProxy {
    if (-not (Test-PrivateAddress $ListenAddress) -or -not (Test-PrivateAddress $ClientAddress) -or
        $ListenAddress -eq $ClientAddress) { throw 'private_addresses_required' }
    $repairs = 0
    $reason = 'network_not_ready'
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        Assert-RestrictedFirewall
        $target = Get-ProxyTarget
        if ($null -ne $target -and $target -ne '127.0.0.1/11434') { throw 'proxy_target_conflict' }
        $local = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
            $_.IPAddress -eq $ListenAddress -and $_.AddressState -eq 'Preferred'
        })
        if ($local.Count -gt 0) {
            $reason = 'loopback_not_ready'
            if (Test-LoopbackApi) {
                if ($target -eq '127.0.0.1/11434' -and (Test-ProxyListener)) {
                    return "RTX_PROXY_READY repairs=$repairs"
                }
                $reason = 'listener_absent'
                if ($repairs -lt 2) { Repair-ExactProxy; $repairs++ }
            }
        }
        if ($attempt -lt $Attempts) { Start-Sleep -Seconds $RetrySeconds }
    }
    throw $reason
}

# Dot sourcing exposes functions for deterministic regression tests without effects.
if ($MyInvocation.InvocationName -ne '.') {
    $statusPath = Join-Path $PSScriptRoot 'windows-rtx-portproxy-status.json'
    try {
        $result = Invoke-StartupProxy
        @{ state = 'ready'; result = $result; timestamp = [DateTime]::UtcNow.ToString('o') } |
            ConvertTo-Json -Compress | Set-Content $statusPath -Encoding UTF8
        $result
        exit 0
    } catch {
        $known = @('private_addresses_required', 'firewall_rule_invalid', 'firewall_scope_invalid',
            'proxy_target_conflict', 'network_not_ready', 'loopback_not_ready', 'listener_absent', 'portproxy_add_failed')
        $reason = if ($known -contains $_.Exception.Message) { $_.Exception.Message } else { 'unexpected_error' }
        @{ state = 'failed'; reason = $reason; timestamp = [DateTime]::UtcNow.ToString('o') } |
            ConvertTo-Json -Compress | Set-Content $statusPath -Encoding UTF8
        [Console]::Error.WriteLine('RTX_PROXY_FAILED:' + $reason)
        exit 1
    }
}
