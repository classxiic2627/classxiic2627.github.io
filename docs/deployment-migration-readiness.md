# Deployment and D1 Migration Readiness

**Status: BLOCKED — review only; not deployment approval.**  
**Reviewed feature head:** `2c423d93e546ed6adea9a99a161cc9fc56c019f4`  
**Exact-head Actions run:** [39303294476](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39303294476) — passed: 74/74 Worker tests, JavaScript syntax, isolated local D1 account-flow smoke, DOM-reference checks, SQLite schema/migration parity, Wrangler template validation, and Windows PowerShell syntax parsing. The latest code uses Cloudflare `FixedLengthStream` where available to preserve content length for streamed resumable Drive uploads. Authenticated accounts can upload through the API; the visible upload form remains in the member UI. CI passed; real Drive/staging verification is still required. This verifies automated CI/local D1 only, not real Drive or staging.  
**Code PR:** [#1 — Build the Community Hub API and secure upload foundation](https://github.com/classxiic2627/classxiic2627.github.io/pull/1)  
**Readiness PR:** [#2 — Add deployment and D1 migration readiness review](https://github.com/classxiic2627/classxiic2627.github.io/pull/2)

This document is an evidence checklist. It does not authorize merging, deployment, account initialization, live D1 migration, changing Google credentials, or provisioning paid resources.

## 1. Scope and current evidence

The owner narrowed the deliverable to **add a login/account system to the existing site and use Google Drive for new uploaded media**, without rebuilding the existing website or changing unrelated features.

At latest reviewed feature head `2c423d93e546ed6adea9a99a161cc9fc56c019f4`:

- Earlier heads exposed regressions while separating liveness from dependency readiness; the fix aligns the OAuth rejection regression test with authenticated `GET /api/admin/health`. Current exact-head run [39303294476](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39303294476) passed **74/74 tests** and all configured CI checks, including the isolated local D1 account-flow smoke and Windows PowerShell syntax validation. The local demo checks its fixed loopback ports before migration and confirms the Worker process remains alive during readiness polling. The Drive adapter now uses `FixedLengthStream` in deployed Workers to preserve the known length of streamed resumable uploads. The API permits any authenticated role to upload, although the current visible upload form is in the member UI. This still does not verify real Google Drive or deployed staging.
- The Worker implements individual admin/member accounts, one-time CLI-only admin setup, password hashing, session expiry/revocation, temporary-password change, admin member management, announcements, and upload/read/delete routes.
- `backend/google-drive.js` is the canonical Google Drive adapter. It uses server-side OAuth refresh-token credentials, keeps Drive files private, proxies file content through the Worker, stores Drive file IDs in D1 metadata, and supports health/upload/read/delete operations.
- `tests/google-drive-adapter.test.mjs` and `tests/google-drive-delete.test.mjs` exercise the Worker routes with fake Google API responses and mock D1 objects. These are automated contract/regression tests, **not** real Google Drive or live D1 verification.
- `scripts/local-smoke-test.mjs` and `wrangler.local.example.toml` provide a repeatable local D1 account-flow test. In the earlier passing run [39291106369](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39291106369), CI applied migrations to Wrangler's isolated local D1, started a local Worker, and passed setup, admin login, member creation, temporary-password login, password change, relogin, rejection of the old password, and test-member disablement. **Local D1 account flow is verified in CI.** The optional real Drive upload/read/delete test was skipped because no real credentials/folder were supplied.
- `community.html` keeps the `community-api-base` meta value blank. The published frontend is therefore **not connected to a deployed Worker**. For easier local demonstration, `community.js` falls back to `http://127.0.0.1:8787` only when served over plain HTTP from `127.0.0.1`, matching the local CORS origin; the published hostname does not match this fallback.
- `scripts/demo-local.ps1` automates the Windows local-demo setup: it creates/uses ignored local-only credentials, applies migrations only to Wrangler local D1, starts the Worker on loopback, and serves the Community page from a temporary allowlisted directory containing only `community.html`, `community.js`, and `styles.css`. The temporary directory is removed on exit, so `.dev.vars`, generated credentials, and local Wrangler config are not served by the static server. The script's syntax is parsed on `windows-latest` in the exact-head workflow; this validates syntax, not a full Windows end-to-end run of the interactive launcher. The smoke script also attempts to disable its generated test member after a mid-flow assertion failure; exact-head CI verifies the normal success path, not every possible cleanup failure.
- No approved Google OAuth client/refresh token/folder, deployed staging Worker, or verified staging D1 was supplied or tested in this review. No real Drive upload/read/delete has been demonstrated.

**Evidence labels:** automated CI = verified at the exact head above; isolated local D1 account-flow smoke = verified in CI; real Google Drive upload/read/delete = not verified (the opt-in real-Drive test was skipped); Cloudflare staging = not verified; production = not approved.

## 2. Required decisions and launch blockers

### Google Drive and media privacy

- [ ] The owner must provide/securely configure an approved Google OAuth client ID, client secret, refresh token with the required Drive scope, and a dedicated Drive folder accessible to the authorized account. Never put secrets in browser code, HTML, Git, comments, screenshots, or committed TOML.
- [ ] Verify the real account can access the chosen folder and perform upload, read, and delete using a dedicated test folder/account. Mocked tests do not prove OAuth consent configuration, refresh-token durability, folder permissions, quota, or provider behavior.
- [x] **Media visibility decision recorded by the owner in Issue #3:** everyone may view class posts/media, with or without an account. The current public `GET /api/content`, `GET /api/announcements`, and `GET /api/media/:id` routes match that decision; Drive objects remain private and are proxied through the Worker. This records the policy choice, not staging verification.
- [ ] Uploads are published immediately; there is no moderation queue. Confirm consent, removal procedures, and whether immediate publication is appropriate for the class.
- [x] **Upload-size policy and implementation aligned:** the owner approved 50 MiB per media upload (51 MiB maximum total multipart request including overhead). The Worker limit, browser-side validation, visible UI text, API documentation, and declared-length boundary test now use that limit. Exact-head CI passed 74/74 tests after the resumable-upload changes; real Drive/staging remains unverified.
- [ ] **Choose and implement an aggregate per-member upload quota before public launch.** The per-file cap does not impose an aggregate quota: there is still no per-member total-byte, file-count, or upload-frequency limit. The owner must approve those values; enforce them atomically against D1 usage/metadata and test concurrent, over-limit, and cleanup-failure cases. Do not silently choose a quota.
- [ ] **Verify near-limit upload memory on staging before launch.** The Worker isolate memory ceiling is 128 MB, and the current multipart path buffers the bounded request before parsing it; a 50 MiB media file can require additional in-memory representations. Exercise a near-50 MiB upload on the approved staging plan and inspect Worker errors/metrics. If memory pressure appears, replace full-body buffering with streaming size enforcement and confirm the multipart parser and Drive stream remain bounded.
- [ ] Keep the cross-store failure path observable. If Drive upload succeeds but D1 insertion fails, the Worker attempts Drive deletion; failed cleanup requires orphan reconciliation. Deletion removes the Drive object before the D1 row so a Drive failure leaves retryable metadata. D1 and Drive are not transactional together; current failure-injection tests use mocks.

### Local demo and staging

#### Run the login + real local D1 demo on Windows

This is a local-only demo of the existing site UI and Worker backed by Wrangler's isolated local D1 database. It does not require a Cloudflare account, remote database, Google credentials, or paid resources. Use disposable demo credentials only.

**Fastest Windows option:** run `npm run demo:local` from the repository root in PowerShell. It creates/reuses ignored local demo credentials, applies migrations to Wrangler's local D1, starts the Worker and static server on loopback, and opens the site. It does not deploy or contact a remote Cloudflare database. Use the manual commands below only if you want to inspect each step.

**Terminal 1 — prepare and start the local API** (from the repository root, on Node.js 22 or newer):

```powershell
if (-not (Test-Path wrangler.local.toml)) {
  Copy-Item wrangler.local.example.toml wrangler.local.toml
}

# Preserve existing Google/local values in .dev.vars; replace only SETUP_SECRET.
$varsPath = ".dev.vars"
$existingVars = if (Test-Path $varsPath) { Get-Content $varsPath -Raw } else { "" }
$setupLine = 'SETUP_SECRET="Local-Demo-Setup-Secret-2026-Change-Me"'
if ($existingVars -match '(?m)^SETUP_SECRET=.*$') {
  $existingVars = [regex]::Replace($existingVars, '(?m)^SETUP_SECRET=.*$', [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $setupLine })
} else {
  $existingVars = $existingVars.TrimEnd() + [Environment]::NewLine + $setupLine + [Environment]::NewLine
}
Set-Content -Path $varsPath -Value $existingVars -Encoding ascii

# Migrate only Wrangler's isolated LOCAL D1 database, then start the local Worker.
npx --yes wrangler@4 d1 migrations apply community-hub-local --local --config wrangler.local.toml
if ($LASTEXITCODE -ne 0) { throw "Local D1 migration failed; do not continue." }
npx --yes wrangler@4 dev --local --config wrangler.local.toml --ip 127.0.0.1 --port 8787
```

Leave that terminal running. The local config uses a separate local D1 database and has no remote database ID. Keep `wrangler.local.toml` and `.dev.vars` uncommitted.


**Terminal 2 — initialize the disposable demo admin and verify the account flow**:

```powershell
$env:LOCAL_API_URL = "http://127.0.0.1:8787"
$env:LOCAL_SETUP_SECRET = "Local-Demo-Setup-Secret-2026-Change-Me"
$env:LOCAL_ADMIN_USERNAME = "demo-admin"
$env:LOCAL_ADMIN_EMAIL = "demo-admin@example.test"
$env:LOCAL_ADMIN_PASSWORD = "Local-Demo-Admin-Password-123!"
npm run smoke:local
```

The smoke script prints each successful step. It verifies first-admin setup (or checks the existing demo admin on a repeat run), admin login, student creation, temporary-password login, forced password change, successful re-login, rejection of the old temporary password, and disabling the generated test student.

**Terminal 3 — serve only public website files (never serve the repository root)**:

```powershell
$demoSite = Join-Path $env:TEMP "class-xii-c-community-static"
New-Item -ItemType Directory -Force $demoSite | Out-Null
Copy-Item community.html,community.js,styles.css,index.html,gallery.html,script.js,sw.js -Destination $demoSite
foreach ($dir in @("images","gallery","games","vimages")) {
  if (Test-Path $dir) { Copy-Item $dir -Destination $demoSite -Recurse -Force }
}
python -m http.server 8000 --bind 127.0.0.1 --directory $demoSite
```

Open [http://127.0.0.1:8000/community.html](http://127.0.0.1:8000/community.html). Sign in to the admin desk with the disposable demo-admin credentials above. Create a separate demo student from the admin desk, then test the student login and required temporary-password change. You can also publish an announcement and confirm it appears in the public list; both use the local D1 database. Stop the local Worker and static server with Ctrl+C when finished. The temporary static directory contains only the selected public site files; it does not contain `.dev.vars`, local credentials, backend code, or repository configuration.

**One-command launcher:** the feature branch includes `npm run demo:local`. It creates/reuses ignored disposable admin credentials, migrates only Wrangler's local D1, starts the Worker, copies only `community.html`, `community.js`, and `styles.css` into a unique temporary directory, and serves that directory on loopback. It does not serve repository-root secrets/config. The launcher has not been executed end-to-end on a Windows workstation as part of this review. Earlier CI run [39291106369](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39291106369) parsed the PowerShell script on a Windows runner; the separate main job verifies the Worker/account flow against local D1. These checks do not claim the launcher itself was executed end-to-end.

**Known local-demo limits:** the real Google Drive upload/read/delete check is opt-in and will fail closed without owner-configured Google OAuth credentials and a dedicated test folder. Do not treat a successful account-flow smoke test as proof of Drive access or Cloudflare staging. The published site remains disconnected until a verified, approved Worker URL is configured.

- [x] The documented local D1 account-flow smoke passed in Actions run [39291106369](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39291106369) using Wrangler's isolated local D1 and `npm run smoke:local`. The run verified setup/admin login/member creation/temporary-password gate/password change/relogin/old-password rejection and test-account disabling. This is not a deployed staging test and does not verify the owner's workstation.
- [ ] Record real Google Drive verification separately. The CI smoke test deliberately skipped external Drive access; health and media operations remain fail-closed until authorized OAuth credentials and folder access are configured.
- [ ] Only after explicit owner approval, prepare isolated staging D1 and a dedicated Drive folder/account. Configure the Worker secrets server-side and set the exact approved static-site origin in `ALLOWED_ORIGIN`.
- [ ] Set the frontend `community-api-base` meta value only to a verified Worker HTTPS origin after staging checks. Do not guess the URL or publish localhost.
- [ ] Verify staging health, setup, admin login, member creation, temporary-password gate, password change, invalid credentials, disable/re-enable, session revocation, upload/read/delete, CORS, request limits, rate limiting, and dependency-failure behavior.
- [ ] Verify the Cron Trigger is actually configured and runs the cleanup handler; a TOML declaration alone is not deployment evidence.
- [ ] Configure and verify edge-level rate limiting in staging. The app's tests do not prove real D1 concurrency or deployed edge controls.
- [ ] Do not deploy, merge, initialize accounts, create/rotate credentials, run remote migrations, or provision paid resources without the owner's explicit approval.

## 3. D1 inventory and migration safety

No live D1 database was inspected. Before planning a migration, identify the exact database and environment, obtain a read-only schema/migration-history inventory, and confirm whether the target is empty or contains existing data.

`backend/migrations/0001_initial.sql` is the initial schema for a **new empty D1 database**. It is not a migration for an existing database. `CREATE TABLE IF NOT EXISTS` does not reconcile existing table columns or constraints with the Worker’s expectations. Do not apply `backend/schema.sql` blindly to a live database.

Before any approved migration:

1. Confirm the exact target D1 name/ID and whether it is staging or production.
2. Inspect `sqlite_master`, table columns, indexes, unique constraints, foreign keys, migration history, and row counts without exporting unnecessary personal data into review comments.
3. Create an access-controlled backup/export and verify it can be restored; rehearse recovery against a non-production copy.
4. Design an ordered, forward-only migration from the observed schema, preserving existing rows and relationships. Resolve duplicate usernames/emails and invalid required fields before applying uniqueness/foreign-key constraints.
5. Apply the reviewed migration to isolated staging, verify schema and row counts, and test the Worker against it.
6. Obtain explicit owner approval for any production migration. A D1 backup does not back up Drive files; media reconciliation and removal procedures must be documented separately.

## 4. Security and operational notes

- Admin setup is intentionally CLI/trusted-tool only. `X-Setup-Secret` must remain out of browser CORS and frontend state. Rotate/remove `SETUP_SECRET` immediately after successful initialization.
- Passwords are hashed with PBKDF2-SHA-256 and per-password salts; session bearer tokens are stored as hashes. Account lifecycle and forced-password-change paths have mock regression tests.
- Layered application throttling uses a 100-attempt/15-minute IP-and-role ceiling and a 10-attempt/15-minute per-account bucket. This reduces collateral lockout behind shared school Wi-Fi but means someone who knows a username can intentionally trigger temporary account lockout. Confirm the trade-off and add monitoring/edge limits before launch.
- **Health contract implemented and covered by passing CI:** public `GET /api/health` is a cheap liveness response and does not query D1, refresh OAuth, or call Google Drive. Admin-authenticated `GET /api/admin/health` checks D1 + Drive readiness after authentication and the forced-password-change gate; unexpected D1 errors during session lookup map to service-unavailable responses while intentional authentication failures retain their 401/403 status. Exact-head run [39303294476](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39303294476) passed 74/74 Worker tests and the configured local checks. Real Google OAuth/Drive and deployed staging remain unverified.
- Request bodies are bounded by streamed byte counts, and allowed media types have basic signature checks. These checks are not full media decoding or malware scanning.
- Push delivery is not implemented; the API deliberately reports it unavailable.
- The service-worker navigation tests constrain notification-click navigation to the archive origin, but that does not implement push delivery or prove deployment configuration.

## 5. Release checklist

- [x] Prior code head `446c68b3e335bd8384b3fdcfd3430148ad8e7763` passed run [39291106369](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39291106369), including 71/71 automated tests and syntax/DOM/schema checks.
- [x] Health-route split regressions fixed and verified on exact head `db27007f501ffdaf86937243ef44b28d3dce02dc`; run [39295875991](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39295875991) passed 73/73 tests and all configured CI checks.
- [x] Local D1 smoke script passed in CI run [39291106369](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39291106369); real Google Drive remains unverified.
- [ ] Verify real Google OAuth and Drive folder access using a dedicated test account/folder.
- [x] Public-media visibility decision recorded: everyone can view class posts/media, with or without an account.
- [ ] Confirm class-photo consent and removal-request policy before launch.
- [ ] Select and implement an owner-approved aggregate upload quota.
- [ ] Inventory the target D1, verify backup/restore, and review a migration matched to the observed schema.
- [ ] Verify staging end-to-end with isolated D1 and Drive resources, exact CORS/API origin, Cron Trigger, and edge rate limits.
- [ ] Obtain explicit owner approval before merge/deployment or any production action.

**Current decision: BLOCKED pending the unchecked evidence and owner decisions above.** The current code head is CI-green. Automated CI and isolated local D1 smoke still do not prove real Google Drive access, Cloudflare staging readiness, or permission to launch.
