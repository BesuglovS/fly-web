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
$srcPath = Join-Path $PSScriptRoot 'public'
if (-not (Test-Path $srcPath)) {
  Write-Host "ERROR: public/ not found." -ForegroundColor Red
  exit 1
}

$sshArgStr = ""
if ($sshPort -ne '22') { $sshArgStr += "-P $sshPort " }
if ($identityFile) { $sshArgStr += "-i `"$identityFile`" " }
# Путь очищается целиком, поэтому допускаем только webroot проекта (guard выше).
$remoteScript = "rm -rf `"$remotePath`"/* `"$remotePath`"/.[!.]* 2>/dev/null; " +
  "mkdir -p `"$remotePath`"; " +
  "tar -xzf - -C `"$remotePath`""
$sshArgStr += "$remote `"$remoteScript`""

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

    $bytes = [System.IO.File]::ReadAllBytes($targz)

    $psi = New-Object System.Diagnostics.ProcessStartInfo('ssh', $sshArgStr)
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
  } finally {
    Remove-Item $targz -ErrorAction SilentlyContinue
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
