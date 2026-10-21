# Community Hub staging smoke test (PowerShell 7+)
# This script DOES NOT provision infrastructure, deploy code, change frontend configuration,
# or touch production. Use only an isolated, explicitly approved staging Worker and a fresh D1 DB.
# It creates the first admin and a test member; do not run against an existing or production DB.

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
$MemberUsername = Read-Host "Test member username (unique)"
$MemberEmail = Read-Host "Test member email (unique)"
$MemberDisplayName = Read-Host "Test member display name"
$MemberTempSecure = Read-Host "Test member temporary password (min 12 characters)" -AsSecureString
$MemberNewSecure = Read-Host "Test member new password (min 12 characters)" -AsSecureString

$AdminPassword = [System.Net.NetworkCredential]::new("", $AdminPasswordSecure).Password
$SetupSecret = [System.Net.NetworkCredential]::new("", $SetupSecretSecure).Password
$MemberTempPassword = [System.Net.NetworkCredential]::new("", $MemberTempSecure).Password
$MemberNewPassword = [System.Net.NetworkCredential]::new("", $MemberNewSecure).Password
if ($AdminPassword.Length -lt 12) { throw "Admin password must be at least 12 characters." }
if ($SetupSecret.Length -lt 16) { throw "SETUP_SECRET must be at least 16 characters." }
if ($MemberTempPassword.Length -lt 12 -or $MemberNewPassword.Length -lt 12) {
  throw "Member temporary and new passwords must each be at least 12 characters."
}
if ($MemberTempPassword -eq $MemberNewPassword) { throw "Use different temporary and new member passwords." }

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
  $adminSession = Invoke-RestMethod -Method POST -Uri "$BaseUrl/api/admin/login" -ContentType "application/json" -Body $loginBody -TimeoutSec 30
  $loginBody = $null
  if (-not $adminSession.token -or $adminSession.user.role -ne "admin") {
    throw "Administrator login or role check failed."
  }

  Write-Host "Creating a test member..."
  $memberBody = @{
    username = $MemberUsername
    email = $MemberEmail
    displayName = $MemberDisplayName
    temporaryPassword = $MemberTempPassword
  } | ConvertTo-Json -Compress
  Invoke-RestMethod -Method POST -Uri "$BaseUrl/api/admin/users" -Headers @{ Authorization = "Bearer $($adminSession.token)" } -ContentType "application/json" -Body $memberBody -TimeoutSec 30 | Out-Null
  $memberBody = $null

  Write-Host "Checking member temporary-password enforcement..."
  $memberLoginBody = @{ username = $MemberUsername; password = $MemberTempPassword } | ConvertTo-Json -Compress
  $memberSession = Invoke-RestMethod -Method POST -Uri "$BaseUrl/api/member/login" -ContentType "application/json" -Body $memberLoginBody -TimeoutSec 30
  $memberLoginBody = $null
  if (-not $memberSession.token -or $memberSession.user.role -ne "member" -or $memberSession.mustChangePassword -ne $true) {
    throw "Member login did not enforce the expected temporary-password change."
  }

  Write-Host "Changing the test member password and verifying session revocation..."
  $oldMemberToken = $memberSession.token
  $passwordBody = @{ currentPassword = $MemberTempPassword; newPassword = $MemberNewPassword } | ConvertTo-Json -Compress
  Invoke-RestMethod -Method POST -Uri "$BaseUrl/api/account/password" -Headers @{ Authorization = "Bearer $oldMemberToken" } -ContentType "application/json" -Body $passwordBody -TimeoutSec 30 | Out-Null
  $passwordBody = $null

  $oldSessionResponse = Invoke-WebRequest -Method POST -Uri "$BaseUrl/api/account/password" -Headers @{ Authorization = "Bearer $oldMemberToken" } -ContentType "application/json" -Body (@{ currentPassword = $MemberTempPassword; newPassword = $MemberNewPassword } | ConvertTo-Json -Compress) -TimeoutSec 30 -SkipHttpErrorCheck
  if ($oldSessionResponse.StatusCode -ne 401) { throw "Password change did not revoke the old member session." }
  $oldPasswordResponse = Invoke-WebRequest -Method POST -Uri "$BaseUrl/api/member/login" -ContentType "application/json" -Body (@{ username = $MemberUsername; password = $MemberTempPassword } | ConvertTo-Json -Compress) -TimeoutSec 30 -SkipHttpErrorCheck
  if ($oldPasswordResponse.StatusCode -ne 401) { throw "The old temporary password remained valid after password change." }
  $memberSession = $null
  $oldMemberToken = $null

  $memberLoginBody = @{ username = $MemberUsername; password = $MemberNewPassword } | ConvertTo-Json -Compress
  $memberSession = Invoke-RestMethod -Method POST -Uri "$BaseUrl/api/member/login" -ContentType "application/json" -Body $memberLoginBody -TimeoutSec 30
  $memberLoginBody = $null
  if (-not $memberSession.token -or $memberSession.mustChangePassword -ne $false) {
    throw "Member could not sign in with the changed password."
  }

  Write-Host "Checking public content and announcement reads..."
  $content = Invoke-RestMethod -Method GET -Uri "$BaseUrl/api/content" -TimeoutSec 30
  $announcements = Invoke-RestMethod -Method GET -Uri "$BaseUrl/api/announcements" -TimeoutSec 30
  Write-Host "PASS: health, first-admin setup/login, member provisioning, forced password change, new member login, public reads."
  Write-Host "Public content count: $(@($content.items).Count); announcement count: $(@($announcements.items).Count)."
  Write-Host "NOT VERIFIED: real Drive upload/read/delete, Drive/D1 failure cleanup, disabled-session rejection, 50 MiB upload memory use, and push delivery."
  Write-Host "Immediately rotate/remove SETUP_SECRET in staging settings. Never paste tokens, passwords, or secret values into GitHub."
}
catch {
  Write-Error ("Staging smoke test failed: " + $_.Exception.Message)
  throw
}
finally {
  $AdminPassword = $null
  $SetupSecret = $null
  $MemberTempPassword = $null
  $MemberNewPassword = $null
  $setupBody = $null
  $loginBody = $null
  $memberBody = $null
  $memberLoginBody = $null
  $passwordBody = $null
  $adminSession = $null
  $memberSession = $null
  $AdminPasswordSecure = $null
  $SetupSecretSecure = $null
  $MemberTempSecure = $null
  $MemberNewSecure = $null
}
