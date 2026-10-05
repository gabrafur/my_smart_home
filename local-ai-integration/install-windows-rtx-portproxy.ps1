[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ListenAddress,
    [Parameter(Mandatory = $true)][string]$ClientAddress,
    [Parameter(Mandatory = $true)][string]$FirewallRuleName
)

$ErrorActionPreference = 'Stop'
$taskName = 'LocalAiRtxStartupPortproxy'
$directory = Join-Path $env:ProgramData 'LocalAiRtx'
$source = Join-Path $PSScriptRoot 'windows-rtx-portproxy.ps1'
$destination = Join-Path $directory 'windows-rtx-portproxy.ps1'
# Validate existing scope before installing anything; dot sourcing has no effects.
. $source -ListenAddress $ListenAddress -ClientAddress $ClientAddress -FirewallRuleName $FirewallRuleName
if (-not (Test-PrivateAddress $ListenAddress) -or -not (Test-PrivateAddress $ClientAddress) -or
    $ListenAddress -eq $ClientAddress) { throw 'private_addresses_required' }
Assert-RestrictedFirewall
if ($FirewallRuleName -notmatch '^[a-zA-Z0-9 {}_.-]+$') { throw 'unsafe_firewall_rule_name' }

New-Item -ItemType Directory -Path $directory -Force | Out-Null
if ((Get-Item $directory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'directory_is_reparse_point' }
& icacls.exe $directory /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'directory_acl_failed' }
$backup = Join-Path $directory ('backup-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $backup | Out-Null
$oldTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($oldTask) { Export-ScheduledTask -TaskName $taskName | Set-Content (Join-Path $backup 'task.xml') -Encoding Unicode }
$hadScript = Test-Path $destination
if ($hadScript) { Copy-Item $destination (Join-Path $backup 'windows-rtx-portproxy.ps1') }

try {
    Copy-Item $source $destination -Force
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    $task = $scheduler.NewTask(0)
    $task.RegistrationInfo.Description = 'Restore only the restricted RTX proxy at startup, logon and resume; never restart shared services.'
    $task.Principal.UserId = 'SYSTEM'
    $task.Principal.LogonType = 5
    $task.Principal.RunLevel = 1
    $task.Settings.Enabled = $true
    $task.Settings.StartWhenAvailable = $true
    $task.Settings.DisallowStartIfOnBatteries = $false
    $task.Settings.StopIfGoingOnBatteries = $false
    $task.Settings.WakeToRun = $false
    $task.Settings.ExecutionTimeLimit = 'PT4M'
    $task.Settings.MultipleInstances = 2
    $boot = $task.Triggers.Create(8)
    $boot.Delay = 'PT30S'
    $logon = $task.Triggers.Create(9)
    $logon.Delay = 'PT20S'
    $resume = $task.Triggers.Create(0)
    $resume.Delay = 'PT20S'
    $resume.Subscription = '<QueryList><Query Id="0" Path="System"><Select Path="System">*[System[Provider[@Name="Microsoft-Windows-Power-Troubleshooter"] and EventID=1]]</Select></Query></QueryList>'
    $action = $task.Actions.Create(0)
    $action.Path = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $action.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "' + $destination + '" -ListenAddress "' +
        $ListenAddress + '" -ClientAddress "' + $ClientAddress + '" -FirewallRuleName "' + $FirewallRuleName + '"'
    $scheduler.GetFolder('\').RegisterTaskDefinition($taskName, $task, 6, 'SYSTEM', $null, 5) | Out-Null
    'RTX_STARTUP_TASK_INSTALLED'
} catch {
    if ($hadScript) { Copy-Item (Join-Path $backup 'windows-rtx-portproxy.ps1') $destination -Force }
    else { Remove-Item $destination -ErrorAction SilentlyContinue }
    if ($oldTask) { Register-ScheduledTask -TaskName $taskName -Xml (Get-Content (Join-Path $backup 'task.xml') -Raw) -Force | Out-Null }
    throw
}
