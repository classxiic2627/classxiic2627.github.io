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

  Write-Host "Checking role separation for administrator credentials..."
  $wrongAdminRole = Invoke-WebRequest -Method POST -Uri "$BaseUrl/api/member/login" -ContentType "application/json" -Body (@{ username = $AdminUsername; password = $AdminPassword } | ConvertTo-Json -Compress) -TimeoutSec 30 -SkipHttpErrorCheck
  if ($wrongAdminRole.StatusCode -ne 401) { throw "Administrator credentials were accepted by the member login route." }
  $wrongAdminRole = $null

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

  Write-Host "Checking role separation for member credentials and API access..."
  $wrongMemberRole = Invoke-WebRequest -Method POST -Uri "$BaseUrl/api/admin/login" -ContentType "application/json" -Body (@{ username = $MemberUsername; password = $MemberTempPassword } | ConvertTo-Json -Compress) -TimeoutSec 30 -SkipHttpErrorCheck
  if ($wrongMemberRole.StatusCode -ne 401) { throw "Member credentials were accepted by the administrator login route." }
  $wrongMemberRole = $null
  $memberAdminApi = Invoke-WebRequest -Method GET -Uri "$BaseUrl/api/admin/users" -Headers @{ Authorization = "Bearer $($memberSession.token)" } -TimeoutSec 30 -SkipHttpErrorCheck
  if ($memberAdminApi.StatusCode -ne 403) { throw "A member session was not rejected by the administrator-only API." }
  $memberAdminApi = $null

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

  Write-Host "Testing real staging Drive upload, public read, and admin-only delete..."
  $pngBytes = [Convert]::FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/jAAAAABJRU5ErkJggg==")
  $uploadKey = [guid]::NewGuid().ToString("N")
  $httpClient = [System.Net.Http.HttpClient]::new()
  $httpClient.Timeout = [TimeSpan]::FromSeconds(60)
  $uploadRequest = $null
  $uploadResponse = $null
  $mediaRequest = $null
  $mediaResponse = $null
  $deleteRequest = $null
  $deleteResponse = $null
  $verifyResponse = $null
  $multipart = $null
  try {
    $multipart = [System.Net.Http.MultipartFormDataContent]::new()
    $multipart.Add([System.Net.Http.StringContent]::new("image"), "type")
    $multipart.Add([System.Net.Http.StringContent]::new("Staging smoke test"), "title")
    $multipart.Add([System.Net.Http.StringContent]::new("Temporary item created by the staging smoke script"), "caption")
    $mediaContent = [System.Net.Http.ByteArrayContent]::new($pngBytes)
    $mediaContent.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse("image/png")
    $multipart.Add($mediaContent, "media", "staging-smoke.png")

    $uploadRequest = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, "$BaseUrl/api/content")
    $uploadRequest.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new("Bearer", $memberSession.token)
    $uploadRequest.Headers.Add("Idempotency-Key", $uploadKey)
    $uploadRequest.Content = $multipart
    $uploadResponse = $httpClient.SendAsync($uploadRequest).GetAwaiter().GetResult()
    if ([int]$uploadResponse.StatusCode -ne 201) {
      throw "Staging media upload failed (HTTP $([int]$uploadResponse.StatusCode))."
    }
    $uploadResult = $uploadResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
    if (-not $uploadResult.id) { throw "Staging media upload response did not include an item ID." }

    $mediaRequest = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, "$BaseUrl/api/media/$($uploadResult.id)")
    $mediaResponse = $httpClient.SendAsync($mediaRequest).GetAwaiter().GetResult()
    if ([int]$mediaResponse.StatusCode -ne 200) {
      throw "Public staging media read failed (HTTP $([int]$mediaResponse.StatusCode))."
    }
    $downloadedBytes = $mediaResponse.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
    if (-not [System.Linq.Enumerable]::SequenceEqual([byte[]]$pngBytes, [byte[]]$downloadedBytes)) {
      throw "Public staging media bytes did not match the uploaded test file."
    }

    $deleteRequest = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Delete, "$BaseUrl/api/admin/content/$($uploadResult.id)")
    $deleteRequest.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new("Bearer", $adminSession.token)
    $deleteResponse = $httpClient.SendAsync($deleteRequest).GetAwaiter().GetResult()
    if ([int]$deleteResponse.StatusCode -ne 200) {
      throw "Admin-only staging media delete failed (HTTP $([int]$deleteResponse.StatusCode))."
    }
    $verifyResponse = $httpClient.GetAsync("$BaseUrl/api/media/$($uploadResult.id)").GetAwaiter().GetResult()
    if ([int]$verifyResponse.StatusCode -ne 404) {
      throw "Deleted staging media remained publicly readable (HTTP $([int]$verifyResponse.StatusCode))."
    }
    Write-Host "PASS: staging Drive upload, public byte-for-byte read, and admin-only deletion."
  }
  finally {
    foreach ($resource in @($uploadRequest, $uploadResponse, $mediaRequest, $mediaResponse, $deleteRequest, $deleteResponse, $verifyResponse, $multipart)) {
      if ($null -ne $resource) { $resource.Dispose() }
    }
    $httpClient.Dispose()
    $pngBytes = $null
    $downloadedBytes = $null
    $uploadResult = $null
    $uploadKey = $null
    $mediaContent = $null
  }

  Write-Host "Checking public content and announcement reads..."
  $content = Invoke-RestMethod -Method GET -Uri "$BaseUrl/api/content" -TimeoutSec 30
  $announcements = Invoke-RestMethod -Method GET -Uri "$BaseUrl/api/announcements" -TimeoutSec 30
  Write-Host "PASS: health, first-admin setup/login, member provisioning, role separation, forced password change, session revocation, re-login, real Drive upload/read/delete, public reads."
  Write-Host "Public content count: $(@($content.items).Count); announcement count: $(@($announcements.items).Count)."
  Write-Host "NOT VERIFIED: Drive/D1 failure cleanup, disabled-session rejection, 50 MiB upload memory use, and push delivery."
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
  $oldMemberToken = $null
  $AdminPasswordSecure = $null
  $SetupSecretSecure = $null
  $MemberTempSecure = $null
  $MemberNewSecure = $null
}
