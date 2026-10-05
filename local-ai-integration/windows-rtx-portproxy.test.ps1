$ErrorActionPreference = 'Stop'
$syntheticServer = '10.0.0.10' # PRIVACY_TEST_FIXTURE
$syntheticClient = '10.0.0.11' # PRIVACY_TEST_FIXTURE
. "$PSScriptRoot/windows-rtx-portproxy.ps1" -ListenAddress $syntheticServer -ClientAddress $syntheticClient -FirewallRuleName 'test-rule'

function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Reset-Fixture {
    $script:Attempts = 4
    $script:target = '127.0.0.1/11434'
    $script:listener = $true
    $script:backend = $true
    $script:network = $true
    $script:repairWorks = $true
    $script:repairs = 0
    $script:waits = 0
    $script:remote = $ClientAddress
}
function Get-NetFirewallRule { [pscustomobject]@{ Enabled = 'True'; Direction = 'Inbound'; Action = 'Allow' } }
function Get-NetFirewallAddressFilter { [pscustomobject]@{ LocalAddress = $ListenAddress; RemoteAddress = $script:remote } }
function Get-NetFirewallPortFilter { [pscustomobject]@{ Protocol = 'TCP'; LocalPort = '11435' } }
function Get-NetIPAddress {
    if ($script:network) { [pscustomobject]@{ IPAddress = $ListenAddress; AddressState = 'Preferred' } }
}
function Get-ProxyTarget { return $script:target }
function Test-ProxyListener { return $script:listener }
function Test-LoopbackApi { return $script:backend }
function Repair-ExactProxy {
    $script:repairs++
    if ($script:repairWorks) { $script:listener = $true; $script:target = '127.0.0.1/11434' }
}
function Start-Sleep { $script:waits++ }
function Expect-Failure([string]$Reason) {
    $actual = ''
    try { Invoke-StartupProxy | Out-Null } catch { $actual = $_.Exception.Message }
    Assert ($actual -eq $Reason) "Expected $Reason, got $actual"
}

Reset-Fixture
Assert ((Invoke-StartupProxy) -eq 'RTX_PROXY_READY repairs=0') 'Healthy endpoint must be untouched'
Assert ($script:repairs -eq 0) 'Healthy endpoint mutated'

Reset-Fixture; $script:listener = $false
Assert ((Invoke-StartupProxy) -eq 'RTX_PROXY_READY repairs=1') 'Stale listener was not repaired'

Reset-Fixture; $script:target = $null; $script:listener = $false
Assert ((Invoke-StartupProxy) -eq 'RTX_PROXY_READY repairs=1') 'Missing exact rule was not repaired'

Reset-Fixture; $script:backend = $false
Expect-Failure 'loopback_not_ready'
Assert ($script:repairs -eq 0 -and $script:waits -eq 3) 'Backend wait mutated configuration or exceeded bounds'

Reset-Fixture; $script:network = $false
Expect-Failure 'network_not_ready'
Assert ($script:repairs -eq 0) 'Missing address must not publish a wildcard listener'

Reset-Fixture; $script:listener = $false; $script:repairWorks = $false
Expect-Failure 'listener_absent'
Assert ($script:repairs -eq 2) 'Repair must stop after two attempts'

Reset-Fixture; $script:remote = 'Any'
Expect-Failure 'firewall_scope_invalid'
Assert ($script:repairs -eq 0) 'Broad firewall must fail closed'

Reset-Fixture; $script:target = '127.0.0.1/9999'
Expect-Failure 'proxy_target_conflict'
Assert ($script:repairs -eq 0) 'Foreign target overwritten'

$syntheticInjection = '10.0.0.1;whoami' # PRIVACY_TEST_FIXTURE
foreach ($value in @('0.0.0.0', '127.0.0.1', '8.8.8.8', '::1', '10.1', $syntheticInjection)) {
    Assert (-not (Test-PrivateAddress $value)) 'Noncanonical/private address validation failed'
}
$syntheticPrivateAddresses = @('10.0.0.10', '172.16.0.10', '192.168.1.10') # PRIVACY_TEST_FIXTURE
foreach ($value in $syntheticPrivateAddresses) {
    Assert (Test-PrivateAddress $value) 'Private address rejected'
}

$source = Get-Content "$PSScriptRoot/windows-rtx-portproxy.ps1" -Raw
Assert ($source -notmatch '(?im)^\s*(Restart-Service|Stop-Service|Start-Service|Set-NetFirewall|New-NetFirewall|Remove-NetFirewall|.*wsl\.exe)\b') 'Startup must not affect shared services or firewall'
'PASS: RTX startup regression cases'
