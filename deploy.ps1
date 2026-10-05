<#
.SYNOPSIS
  Deploy static site (flight simulator) to remote server via SSH.
.DESCRIPTION
  Reads config from .env, packs public/ via tar and syncs
  to remote server over SSH. Then deploys nginx config
  through the sudo helper (with nginx -t rollback).
.PARAMETER DryRun
  Show commands without executing.
.EXAMPLE
  .\deploy.ps1
  .\deploy.ps1 -DryRun
#>

param(
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# ─── 1. Load .env ───
$envFile = Join-Path $PSScriptRoot '.env'
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([^#=]+?)\s*=\s*(.+?)\s*$') {
      [Environment]::SetEnvironmentVariable($matches[1], $matches[2])
    }
  }
}

$sshHost    = [Environment]::GetEnvironmentVariable('DEPLOY_SSH_HOST')
$sshPort    = [Environment]::GetEnvironmentVariable('DEPLOY_SSH_PORT')
if (-not $sshPort) { $sshPort = '22' }
$sshUser    = [Environment]::GetEnvironmentVariable('DEPLOY_SSH_USER')
$remotePath = [Environment]::GetEnvironmentVariable('DEPLOY_REMOTE_PATH')
if ($remotePath) { $remotePath = $remotePath.TrimEnd('/') }

if (-not $sshHost -or -not $sshUser -or -not $remotePath) {
  Write-Host "ERROR: Set DEPLOY_SSH_HOST, DEPLOY_SSH_USER and DEPLOY_REMOTE_PATH in .env" -ForegroundColor Red
  exit 1
}

# Guard: the deploy wipes remotePath (rm -rf), allow only this project webroot.
$expectedPath = '/var/www/fly.nayanovaacademy.ru/public'
if ($remotePath -ne $expectedPath) {
  Write-Host ("ERROR: wrong DEPLOY_REMOTE_PATH=$remotePath, expected=$expectedPath. Deploy aborted.") -ForegroundColor Red
  exit 1
}

$identityFile = [Environment]::GetEnvironmentVariable('DEPLOY_SSH_KEY')
if ($identityFile -and (Test-Path $identityFile)) {
  $identityFile = (Resolve-Path $identityFile).Path
}
$identityArg = if ($identityFile) { "-i `"$identityFile`"" } else { '' }

$remote  = "${sshUser}@${sshHost}"
$portArg = if ($sshPort -ne '22') { "-P $sshPort" } else { '' }

# ─── Fix SSH key permissions (Windows OpenSSH requires restrictive ACLs) ───
if ($identityFile -and (Test-Path $identityFile)) {
  $identityFullPath = (Resolve-Path $identityFile).Path
  icacls $identityFullPath /reset          2>$null
  icacls $identityFullPath /inheritance:r  2>$null
  icacls $identityFullPath /grant "${env:USERNAME}:(R)" 2>$null
}

# ─── 2. Deploy files via tar + ssh ───
# Отправляет локальный tar в stdin ssh-команды (безопасно для бинарных данных).
function Send-TarToRemote {
  param([string]$Targz, [string]$SshArgs)
  $bytes = [System.IO.File]::ReadAllBytes($Targz)
  $psi = New-Object System.Diagnostics.ProcessStartInfo('ssh', $SshArgs)
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $proc = [System.Diagnostics.Process]::Start($psi)

  try {
    $proc.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $proc.StandardInput.Close()
  } catch [System.IO.IOException] {
    $stderr = $proc.StandardError.ReadToEnd()
    $proc.WaitForExit()
    Write-Host "  Deploy failed: $($_.Exception.Message)" -ForegroundColor Red
    if ($stderr) { Write-Host "  SSH: $stderr" -ForegroundColor Red }
    exit 1
  }

  $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
  $stderrTask = $proc.StandardError.ReadToEndAsync()
  $proc.WaitForExit()
  $stdout = $stdoutTask.Result
  $stderr = $stderrTask.Result

  if ($proc.ExitCode -ne 0) {
    Write-Host "  Deploy failed (exit code: $($proc.ExitCode))" -ForegroundColor Red
    if ($stdout) { Write-Host "  SSH stdout: $stdout" -ForegroundColor Red }
    if ($stderr) { Write-Host "  SSH stderr: $stderr" -ForegroundColor Red }
    exit 1
  }
}

function Build-SshArgs {
  param([string]$RemoteScript)
  $s = ""
  if ($sshPort -ne '22') { $s += "-P $sshPort " }
  if ($identityFile) { $s += "-i `"$identityFile`" " }
  $s += "$remote `"$RemoteScript`""
  return $s
}

$srcPath = Join-Path $PSScriptRoot 'public'
if (-not (Test-Path $srcPath)) {
  Write-Host "ERROR: public/ not found." -ForegroundColor Red
  exit 1
}

# Путь очищается целиком, поэтому допускаем только webroot проекта (guard выше).
$remoteScript = "rm -rf `"$remotePath`"/* `"$remotePath`"/.[!.]* 2>/dev/null; " +
  "mkdir -p `"$remotePath`"; " +
  "tar -xzf - -C `"$remotePath`""
$sshArgStr = Build-SshArgs $remoteScript

Write-Host "`n==> Deploying files to ${remote}:${remotePath} ..." -ForegroundColor Cyan

if ($DryRun) {
  Write-Host "  [DryRun] tar -czf - -C `"$srcPath`" . | ssh $sshArgStr" -ForegroundColor Yellow
} else {
  Write-Host "  Archiving and transferring..." -ForegroundColor Gray

  $targz = Join-Path $env:TEMP "deploy-fly-$(Get-Random).tar.gz"
  try {
    & tar -czf $targz -C $srcPath .
    if ($LASTEXITCODE -ne 0) {
      Write-Host "  Archive creation failed" -ForegroundColor Red
      exit 1
    }

    Send-TarToRemote -Targz $targz -SshArgs $sshArgStr
  } finally {
    Remove-Item $targz -ErrorAction SilentlyContinue
  }

  Write-Host "  Done." -ForegroundColor Green
}

# ─── 2b. Deploy signaling backend (server/ -> ../app) ───
# Код сигналинга лежит ВНЕ webroot (../app), БД — в ../data (её переживает
# деплой, как сохранённая БД auth-web). Каталоги на проде создаются один раз
# root'ом и принадлежат deploy/www-data — у пользователя deploy нет прав
# создавать каталоги в /var/www.
$serverPath = Join-Path $PSScriptRoot 'server'
$projectRoot = $remotePath -replace '/public$',''
$appPath  = "$projectRoot/app"
$dataPath = "$projectRoot/data"

if (-not $appPath.EndsWith('/app')) {
  Write-Host "ERROR: cannot derive app path from $remotePath" -ForegroundColor Red
  exit 1
}

if (-not (Test-Path $serverPath)) {
  Write-Host "`n==> No server/ directory, skipping backend deploy." -ForegroundColor Yellow
} elseif ($DryRun) {
  Write-Host "  [DryRun] tar server/ | ssh -> $appPath (ensure $dataPath)" -ForegroundColor Yellow
} else {
  Write-Host "`n==> Deploying signaling backend to ${remote}:${appPath} ..." -ForegroundColor Cyan

  # data/ доступен PHP-FPM (www-data): владелец/права чинятся best-effort
  # (сработает при root или разрешённом `sudo -n`, иначе — разовая настройка).
  $serverScript = "rm -rf `"$appPath`"/* 2>/dev/null; " +
    "mkdir -p `"$appPath`" `"$dataPath`" 2>/dev/null; " +
    "tar -xzf - -C `"$appPath`"; " +
    "(chown -R www-data:www-data `"$dataPath`" 2>/dev/null || sudo -n chown -R www-data:www-data `"$dataPath`" 2>/dev/null || true); " +
    "(chmod 775 `"$dataPath`" 2>/dev/null || sudo -n chmod 775 `"$dataPath`" 2>/dev/null || true)"
  $sshArgStr2 = Build-SshArgs $serverScript

  $targz2 = Join-Path $env:TEMP "deploy-fly-server-$(Get-Random).tar.gz"
  try {
    & tar -czf $targz2 -C $serverPath .
    if ($LASTEXITCODE -ne 0) {
      Write-Host "  Archive creation failed" -ForegroundColor Red
      exit 1
    }

    Send-TarToRemote -Targz $targz2 -SshArgs $sshArgStr2
  } finally {
    Remove-Item $targz2 -ErrorAction SilentlyContinue
  }

  Write-Host "  Done." -ForegroundColor Green
}

# ─── 3. Deploy nginx config ───
# Порядок критичен: конфиг устанавливается ТОЛЬКО после успешного nginx -t;
# хелпер сам откатывает конфиг при ошибке.
$nginxSite = 'fly.nayanovaacademy.ru'
$nginxLocal = Join-Path $PSScriptRoot $nginxSite

if ($DryRun) {
  Write-Host "  [DryRun] Deploy nginx config: $nginxSite" -ForegroundColor Yellow
} elseif (Test-Path $nginxLocal) {
  Write-Host "`n==> Deploying nginx config ($nginxSite) ..." -ForegroundColor Cyan
  $scpCmd = "scp $portArg $identityArg `"$nginxLocal`" ${remote}:/tmp/nginx-$nginxSite"
  cmd /c $scpCmd
  if ($LASTEXITCODE -ne 0) { Write-Host "  Nginx config scp failed" -ForegroundColor Red; exit 1 }

  $sshNginxCmd = 'ssh ' + $portArg + ' ' + $identityArg + ' ' + $remote + ' "sudo -n /usr/local/sbin/deploy-nginx.sh ' + $nginxSite + '"'
  cmd /c $sshNginxCmd
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  nginx deploy failed (config not applied). Deploy aborted." -ForegroundColor Red
    exit 1
  }
  Write-Host "  Done." -ForegroundColor Green
}

# ─── 4. Smoke check ───
if (-not $DryRun) {
  Write-Host "`n==> Smoke check..." -ForegroundColor Cyan
  try {
    $resp = Invoke-WebRequest -Uri "https://$nginxSite/" -Method Head -TimeoutSec 30 -UseBasicParsing
    if ($resp.StatusCode -eq 200) {
      Write-Host "  Site responds with HTTP 200." -ForegroundColor Green
    } else {
      Write-Host "  WARNING: site responded with HTTP $($resp.StatusCode)" -ForegroundColor Yellow
    }
  } catch {
    Write-Host "  WARNING: smoke check failed: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

Write-Host "`n==> Deploy complete" -ForegroundColor Green
