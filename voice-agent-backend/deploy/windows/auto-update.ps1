$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repository = 'jphacks/tka_2601'
$RepositoryOwner = 'jphacks'
$DeploymentBranch = 'codex/voice-agent-backend'
$AppRoot = 'C:\Users\stu23-oba-shion\door-voice-backend'
$Python = 'C:\Users\stu23-oba-shion\door-prototype\livekit-poc\.venv\Scripts\python.exe'
$AgentTask = 'Door Voice Agent'
$ApiTask = 'Door Voice Backend API'
$UpdaterTask = 'Door Voice Backend Auto Update'
$UpdaterPath = 'C:\Users\stu23-oba-shion\door-voice-backend-auto-update.ps1'
$InstalledShaPath = 'C:\Users\stu23-oba-shion\door-voice-deployed.sha'
$LogPath = 'C:\Users\stu23-oba-shion\door-voice-deploy.log'
$ApiRoot = "https://api.github.com/repos/$Repository"

function Write-DeployLog([string] $Message) {
    Add-Content -LiteralPath $LogPath -Value "$(Get-Date -Format o) $Message" -Encoding UTF8
}

function Test-Listening([int[]] $Ports) {
    foreach ($Port in $Ports) {
        if (-not (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)) {
            return $false
        }
    }
    return $true
}

try {
    $headers = @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'door-voice-backend-updater' }
    $encodedHead = [Uri]::EscapeDataString("$RepositoryOwner`:$DeploymentBranch")
    $openPullRequests = Invoke-RestMethod -Uri "$ApiRoot/pulls?state=open&head=$encodedHead&base=main" -Headers $headers
    $openPullRequest = @($openPullRequests | Select-Object -First 1)
    if ($openPullRequest.Count -gt 0) {
        $branch = $openPullRequest[0].head.ref
    } else {
        $repositoryInfo = Invoke-RestMethod -Uri $ApiRoot -Headers $headers
        $branch = $repositoryInfo.default_branch
    }
    $encodedBranch = [Uri]::EscapeDataString($branch)
    $commit = Invoke-RestMethod -Uri "$ApiRoot/commits/$encodedBranch" -Headers $headers
    $sha = [string]$commit.sha
    $installedSha = if (Test-Path -LiteralPath $InstalledShaPath -PathType Leaf) {
        (Get-Content -LiteralPath $InstalledShaPath -Raw).Trim()
    } else {
        ''
    }
    if (-not $sha -or $installedSha -eq $sha) {
        exit 0
    }

    $checks = Invoke-RestMethod -Uri "$ApiRoot/commits/$sha/check-runs?per_page=100" -Headers $headers
    $backendCheck = @($checks.check_runs | Where-Object { $_.name -eq 'backend-tests' } | Sort-Object completed_at -Descending | Select-Object -First 1)
    if ($backendCheck.Count -eq 0 -or $backendCheck[0].status -ne 'completed' -or $backendCheck[0].conclusion -ne 'success') {
        Write-DeployLog "Skipped $sha`: backend CI has not succeeded."
        exit 0
    }
    if (-not (Test-Path -LiteralPath $Python -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $AppRoot '.env') -PathType Leaf)) {
        throw 'The configured Python environment or local .env file is missing.'
    }

    $work = Join-Path $env:TEMP ('door-voice-update-' + [Guid]::NewGuid().ToString('N'))
    $archive = Join-Path $work 'source.zip'
    $extract = Join-Path $work 'extract'
    $stage = "$AppRoot.next"
    $backup = "$AppRoot.previous"
    New-Item -ItemType Directory -Path $work -Force | Out-Null
    Invoke-WebRequest -Uri "$ApiRoot/zipball/$sha" -Headers $headers -OutFile $archive
    Expand-Archive -LiteralPath $archive -DestinationPath $extract -Force
    $repositoryRoot = Get-ChildItem -LiteralPath $extract -Directory | Select-Object -First 1
    $source = Join-Path $repositoryRoot.FullName 'voice-agent-backend'
    if (-not (Test-Path -LiteralPath (Join-Path $source 'door_backend\agent.py') -PathType Leaf)) {
        throw 'The downloaded revision does not contain the voice backend.'
    }

    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    Copy-Item -Path (Join-Path $source '*') -Destination $stage -Recurse -Force
    Copy-Item -LiteralPath (Join-Path $AppRoot '.env') -Destination (Join-Path $stage '.env') -Force
    $env:PYTHONPATH = $stage
    Push-Location $stage
    try {
        & $Python -c 'import door_backend.agent, door_backend.api'
        if ($LASTEXITCODE -ne 0) { throw 'The staged backend could not be imported.' }
    } finally {
        Pop-Location
    }

    Stop-ScheduledTask -TaskName $AgentTask -ErrorAction SilentlyContinue
    Stop-ScheduledTask -TaskName $ApiTask -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    foreach ($port in @(8081, 8093)) {
        Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique |
            ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
    }
    if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
    Move-Item -LiteralPath $AppRoot -Destination $backup
    Move-Item -LiteralPath $stage -Destination $AppRoot
    Copy-Item -LiteralPath (Join-Path $source 'deploy\windows\auto-update.ps1') -Destination $UpdaterPath -Force

    $agentAction = New-ScheduledTaskAction -Execute $Python -Argument '-m door_backend.agent start' -WorkingDirectory $AppRoot
    $apiAction = New-ScheduledTaskAction -Execute $Python -Argument '-m uvicorn door_backend.api:app --host 127.0.0.1 --port 8093' -WorkingDirectory $AppRoot
    Set-ScheduledTask -TaskName $AgentTask -Action $agentAction | Out-Null
    Set-ScheduledTask -TaskName $ApiTask -Action $apiAction | Out-Null
    Start-ScheduledTask -TaskName $ApiTask
    Start-ScheduledTask -TaskName $AgentTask

    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 2
        if (Test-Listening -Ports @(8081, 8093)) { $ready = $true; break }
    }
    if (-not $ready) { throw 'The API and Agent listeners did not both become ready.' }

    Set-Content -LiteralPath $InstalledShaPath -Value $sha -Encoding ASCII
    Remove-Item -LiteralPath $backup -Recurse -Force
    Remove-Item -LiteralPath $work -Recurse -Force
    Write-DeployLog "Deployed $sha from $branch; API and Agent listeners are ready."
} catch {
    Write-DeployLog "Deployment failed: $($_.Exception.Message)"
    if (Test-Path -LiteralPath $backup) {
        foreach ($task in @($AgentTask, $ApiTask)) { Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue }
        foreach ($port in @(8081, 8093)) {
            Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
                Select-Object -ExpandProperty OwningProcess -Unique |
                ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
        }
        if (Test-Path -LiteralPath $AppRoot) { Remove-Item -LiteralPath $AppRoot -Recurse -Force }
        Move-Item -LiteralPath $backup -Destination $AppRoot
        $agentAction = New-ScheduledTaskAction -Execute $Python -Argument '-m door_backend.agent start' -WorkingDirectory $AppRoot
        $apiAction = New-ScheduledTaskAction -Execute $Python -Argument '-m uvicorn door_backend.api:app --host 127.0.0.1 --port 8093' -WorkingDirectory $AppRoot
        Set-ScheduledTask -TaskName $AgentTask -Action $agentAction | Out-Null
        Set-ScheduledTask -TaskName $ApiTask -Action $apiAction | Out-Null
        Start-ScheduledTask -TaskName $ApiTask
        Start-ScheduledTask -TaskName $AgentTask
        Write-DeployLog 'Rolled back to the previous backend revision.'
    }
    exit 1
}
