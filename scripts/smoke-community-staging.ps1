# Community Hub staging smoke test (PowerShell 7+)
# This script DOES NOT provision infrastructure, deploy code, change frontend configuration,
# or touch production. Use only an isolated, explicitly approved staging Worker and a fresh D1 DB.
# It creates the first admin, so do not run it against an existing or production database.

$ErrorActionPreference = "Stop"

$BaseUrl = (Read-Host "Isolated staging Worker URL (HTTPS only)").Trim().TrimEnd("/")
if (-not ($BaseUrl -match '^https://[^/]+$')) {
  throw "Enter only the HTTPS Worker origin, with no path or trailing slash."
}
$confirmation = Read-Host "Confirm this is an isolated, verified-empty staging D1 database by typing STAGING-EMPTY"
if ($confirmation -cne "STAGING-EMPTY") { throw "Confirmation did not match; no request sent." }

$health = Invoke-RestMethod -Method GET -Uri "$BaseUrl/api/health" -TimeoutSec 20
if ($health.ok -ne $true -or $health.service -ne "class-archive-api") {
  throw "Health endpoint did not identify the expected Community Hub API."
}

$AdminUsername = Read-Host "Temporary staging admin username"
$AdminEmail = Read-Host "Temporary staging admin email"
$AdminDisplayName = Read-Host "Admin display name (optional)"
$AdminPasswordSecure = Read-Host "Temporary staging admin password (min 12 characters)" -AsSecureString
$SetupSecretSecure = Read-Host "Staging SETUP_SECRET (sent only in request header)" -AsSecureString
$AdminPassword = [System.Net.NetworkCredential]::new("", $AdminPasswordSecure).Password
$SetupSecret = [System.Net.NetworkCredential]::new("", $SetupSecretSecure).Password
if ($AdminPassword.Length -lt 12) { throw "Admin password must be at least 12 characters." }
if ($SetupSecret.Length -lt 16) { throw "SETUP_SECRET must be at least 16 characters." }

try {
  Write-Host "Initializing the first administrator on the confirmed staging database..."
  $setupBody = @{
    adminUsername = $AdminUsername
    adminEmail = $AdminEmail
    adminDisplayName = $AdminDisplayName
    adminPassword = $AdminPassword
  } | ConvertTo-Json -Compress
  Invoke-RestMethod -Method POST -Uri "$BaseUrl/api/setup" -Headers @{ "X-Setup-Secret" = $SetupSecret } -ContentType "application/json" -Body $setupBody -TimeoutSec 30 | Out-Null
  $setupBody = $null

  Write-Host "Checking administrator login..."
  $loginBody = @{ username = $AdminUsername; password = $AdminPassword } | ConvertTo-Json -Compress
  $session = Invoke-RestMethod -Method POST -Uri "$BaseUrl/api/admin/login" -ContentType "application/json" -Body $loginBody -TimeoutSec 30
  $loginBody = $null
  if (-not $session.token) { throw "Login returned no session token." }
  if ($session.user.role -ne "admin") { throw "Authenticated account did not have the admin role." }

  Write-Host "Checking public content and announcement reads..."
  $content = Invoke-RestMethod -Method GET -Uri "$BaseUrl/api/content" -TimeoutSec 30
  $announcements = Invoke-RestMethod -Method GET -Uri "$BaseUrl/api/announcements" -TimeoutSec 30
  Write-Host "PASS: health, one-time setup, admin login/role, content read, announcement read."
  Write-Host "Public content count: $(@($content.items).Count); announcement count: $(@($announcements.items).Count)."
  Write-Host "NOT VERIFIED: real Drive upload/read/delete, member lifecycle, forced-password-change behavior, failure cleanup, 50 MiB upload memory use, and push delivery."
  Write-Host "Immediately rotate/remove SETUP_SECRET in staging settings. Never paste tokens, passwords, or secret values into GitHub."
}
catch {
  Write-Error ("Staging smoke test failed: " + $_.Exception.Message)
  throw
}
finally {
  $AdminPassword = $null
  $SetupSecret = $null
  $setupBody = $null
  $loginBody = $null
  $session = $null
  $AdminPasswordSecure = $null
  $SetupSecretSecure = $null
}
