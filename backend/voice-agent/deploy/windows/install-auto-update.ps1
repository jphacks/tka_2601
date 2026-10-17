$ErrorActionPreference = 'Stop'

$deploymentRoot = 'C:\Users\stu23-oba-shion\door-voice-backend'
$updater = 'C:\Users\stu23-oba-shion\door-voice-backend-auto-update.ps1'
$installedSha = 'C:\Users\stu23-oba-shion\door-voice-deployed.sha'
$sourceUpdater = Join-Path $PSScriptRoot 'auto-update.ps1'

if (-not (Test-Path -LiteralPath $sourceUpdater -PathType Leaf)) {
    throw "Updater script not found: $sourceUpdater"
}
if (-not (Test-Path -LiteralPath (Join-Path $deploymentRoot '.env') -PathType Leaf)) {
    throw 'The local .env file is missing; deployment setup was not changed.'
}
Copy-Item -LiteralPath $sourceUpdater -Destination $updater -Force
if (-not (Test-Path -LiteralPath $installedSha -PathType Leaf)) {
    Set-Content -LiteralPath $installedSha -Value '2b18f5c5279711ffdd49a0fe6ec87167e622e97c' -Encoding ASCII
}

$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$updater`""
$startupTrigger = New-ScheduledTaskTrigger -AtStartup
$repeatTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$principal = New-ScheduledTaskPrincipal -UserId $userSid -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName 'Door Voice Backend Auto Update' -Action $action -Trigger @($startupTrigger, $repeatTrigger) -Principal $principal -Settings $settings -Description 'Deploy the latest CI-passing voice backend revision from GitHub.' -Force | Out-Null
Start-ScheduledTask -TaskName 'Door Voice Backend Auto Update'
