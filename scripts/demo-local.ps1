$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $root

if ($PSVersionTable.PSVersion.Major -lt 5) { throw "PowerShell 5 or newer is required." }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Install Node.js 22+ first." }
if (-not (Get-Command python -ErrorAction SilentlyContinue)) { throw "Python is required to serve the existing static site." }

$configPath = Join-Path $root "wrangler.local.toml"
if (-not (Test-Path $configPath)) {
  Copy-Item (Join-Path $root "wrangler.local.example.toml") $configPath
}
$devVarsPath = Join-Path $root ".dev.vars"
$credentialsPath = Join-Path $root ".local-demo-credentials.txt"
if (Test-Path $credentialsPath) {
  $credentials = Get-Content $credentialsPath -Raw | ConvertFrom-Json
} else {
  $bytes = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
  $secret = [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+","-").Replace("/","_")
  $adminBytes = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(24)
  $adminPassword = "Local-" + [Convert]::ToBase64String($adminBytes).TrimEnd("=").Replace("+","-").Replace("/","_") + "!"
  $credentials = [pscustomobject]@{
    setupSecret = $secret
    username = "local-admin"
    email = "local-admin@example.test"
    password = $adminPassword
  }
  $credentials | ConvertTo-Json | Set-Content -Encoding utf8 $credentialsPath
}
$existingVars = if (Test-Path $devVarsPath) { Get-Content $devVarsPath -Raw } else { "" }
$setupLine = 'SETUP_SECRET="' + $credentials.setupSecret + '"'
if ($existingVars -match '(?m)^SETUP_SECRET=.*$') {
  $existingVars = [regex]::Replace($existingVars, '(?m)^SETUP_SECRET=.*$', [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $setupLine })
} else {
  $existingVars = $existingVars.TrimEnd() + [Environment]::NewLine + $setupLine + [Environment]::NewLine
}
Set-Content -Path $devVarsPath -Value $existingVars -Encoding utf8

Write-Host "Applying migrations to Wrangler's LOCAL D1 only..."
& npx --yes wrangler@4 d1 migrations apply community-hub-local --local --config wrangler.local.toml
if ($LASTEXITCODE -ne 0) { throw "Local D1 migration failed. No remote database was targeted." }

$workerLog = Join-Path $root ".wrangler\local-demo-worker.log"
$staticLog = Join-Path $root ".wrangler\local-demo-static.log"
New-Item -ItemType Directory -Force (Join-Path $root ".wrangler") | Out-Null
$workerCommand = 'npx --yes wrangler@4 dev --local --config wrangler.local.toml --ip 127.0.0.1 --port 8787 > "' + $workerLog + '" 2>&1'
$worker = Start-Process -FilePath $env:ComSpec -ArgumentList @("/c", $workerCommand) -WorkingDirectory $root -PassThru -WindowStyle Hidden
$static = $null
try {
  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    try {
      $null = Invoke-WebRequest -Uri "http://127.0.0.1:8787/api/announcements" -TimeoutSec 2 -UseBasicParsing
      $ready = $true
      break
    } catch {
      if ($worker.HasExited) { break }
    }
  }
  if (-not $ready) {
    if (Test-Path $workerLog) { Get-Content $workerLog -Tail 60 }
    throw "Local Worker did not start. Check .wrangler/local-demo-worker.log."
  }

  $headers = @{ "X-Setup-Secret" = $credentials.setupSecret }
  $body = @{
    adminUsername = $credentials.username
    adminEmail = $credentials.email
    adminDisplayName = "Local Demo Admin"
    adminPassword = $credentials.password
  } | ConvertTo-Json
  try {
    $null = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8787/api/setup" -Headers $headers -ContentType "application/json" -Body $body
    Write-Host "Created the first admin in local D1."
  } catch {
    try {
      $login = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8787/api/admin/login" -ContentType "application/json" -Body (@{ username = $credentials.username; password = $credentials.password } | ConvertTo-Json)
      if (-not $login.token) { throw "Existing local admin login did not return a session." }
      Write-Host "Reusing the existing local D1 admin."
    } catch {
      throw "Local setup was already completed but the saved demo admin could not sign in. Preserve the local database; do not reset it automatically."
    }
  }

  $static = Start-Process -FilePath "python" -ArgumentList @("-m","http.server","8000","--bind","127.0.0.1") -WorkingDirectory $root -PassThru -WindowStyle Hidden -RedirectStandardOutput $staticLog -RedirectStandardError $staticLog
  Start-Sleep -Seconds 1
  Write-Host ""
  Write-Host "LOCAL DEMO IS RUNNING — no Cloudflare account or Google credentials are used for login."
  Write-Host "Open: http://127.0.0.1:8000/community.html"
  Write-Host ("Admin username: " + $credentials.username)
  Write-Host ("Admin password: " + $credentials.password)
  Write-Host "Use the admin desk to create a student with a temporary password, then test the student login/password-change flow."
  Write-Host "Google Drive uploads remain unavailable until you configure real local OAuth credentials and a dedicated test folder."
  Write-Host "Press Ctrl+C here to stop both local servers. Local D1 data is preserved."
  Start-Process "http://127.0.0.1:8000/community.html"
  while (-not $worker.HasExited -and -not $static.HasExited) { Start-Sleep -Seconds 2 }
} finally {
  if ($static -and -not $static.HasExited) { Stop-Process -Id $static.Id -Force -ErrorAction SilentlyContinue }
  if ($worker -and -not $worker.HasExited) { Stop-Process -Id $worker.Id -Force -ErrorAction SilentlyContinue }
}
