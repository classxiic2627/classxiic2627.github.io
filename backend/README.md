# Class XII C Community Archive API

This Worker backs the static community site. Secrets stay in Worker configuration and must never be placed in browser JavaScript or committed to Git.

## Browser push notifications

The push flow uses Web Push (VAPID) without a third-party runtime package. The Worker stores each authenticated user's endpoint and encryption keys in the existing `push_subscriptions` D1 table, and sends an encrypted push when an administrator publishes an announcement. Provider requests have a 5-second abort timeout, redirects are disabled to preserve the provider-host allowlist, and announcement fan-out is limited to eight concurrent sends. Expired endpoints returning HTTP 404/410 are removed in a batched D1 delete. Browser subscription requires HTTPS, notification permission, a supported browser, and a signed-in account that has completed any forced password change.

Before enabling this in staging, generate a dedicated VAPID key pair locally with `node scripts/generate-vapid-keys.mjs`. Set `VAPID_PUBLIC_KEY` and `VAPID_SUBJECT` in the staging Worker variables, and store only `VAPID_PRIVATE_KEY` as a Worker secret using `wrangler secret put VAPID_PRIVATE_KEY`. Use a monitored `mailto:` address for the subject. Never commit the private key or send it to the browser. The notification control remains visible but asks visitors to sign in; the API requires authentication and a completed forced-password change.

Push delivery has automated cryptographic/transport unit coverage, but real browser subscription and delivery through Chrome/Firefox/Safari push services must still be verified on approved no-cost staging. This code change does not configure credentials, deploy a Worker, or activate production push.

## Current API contract

The account model is **individual accounts**, not one shared class password:

- One-time `POST /api/setup` initializes the first administrator. The JSON body requires `adminUsername`, `adminEmail`, and `adminPassword`; `adminDisplayName` is optional.
- `POST /api/admin/login` and `POST /api/member/login` accept `{ "username": "...", "password": "..." }`.
- Public registration is not provided. An authenticated administrator provisions each member with a unique username, required unique email, display name, and temporary password. Email addresses are admin-entered identifiers; this prototype does not verify email ownership, send email, or provide email-based password recovery.
- Newly provisioned or password-reset member accounts must change their temporary password before using protected features.
- Members may change their own password through `POST /api/account/password`, providing `currentPassword` and `newPassword`. Password changes revoke the account's sessions; the user must sign in again.
- The administrator can list members, update their profile fields, disable/re-enable accounts, reset temporary passwords, and revoke sessions through the `/api/admin/users` routes. Disabling an account must prevent its existing sessions from being used.
- Passwords are hashed with PBKDF2-SHA-256 (210,000 iterations and a per-password salt); random bearer tokens are stored only as SHA-256 hashes.
- The setup secret is for initial provisioning only. After setup, rotate or remove `SETUP_SECRET` in Worker settings. Never include the secret in frontend code, Git, screenshots, or chat.

The account lifecycle and migration are not considered production-ready merely because routes exist. Verify the current branch's tests and CI, review account/session atomicity and first-admin initialization race safety, and inspect the actual target D1 schema before planning any migration. `schema.sql` is a baseline schema, **not proof of a safe migration for an existing database**.

Request bodies are bounded independently of the `Content-Length` header: JSON requests are limited to 1 MiB, and complete multipart upload requests are limited to 51 MiB (50 MiB media plus up to 1 MiB multipart overhead). The Worker counts streamed bytes before JSON or multipart parsing; `Content-Length` is only an early-rejection hint. Tests cover oversized JSON and multipart requests when that header is absent. This application-level guard does not replace checking Cloudflare's deployed request limits and staging behavior. The Worker now counts multipart request bytes as the parser consumes the stream, avoiding an additional full-request buffer. The multipart parser still materializes uploaded file data, so Cloudflare Workers' 128 MB per-isolate memory ceiling makes near-50 MiB upload verification on the approved staging plan a launch gate; inspect memory errors before launch. If memory pressure appears, seek owner approval to lower the cap or use a parser that can stream file parts directly to Drive. Google Drive uploads use the resumable upload protocol (including for small files) rather than multipart upload, because Drive documents multipart upload for files up to 5 MB and recommends resumable upload for larger files. The Worker validates the returned upload-session URL against the exact HTTPS Google API origin and `/upload/drive/v3/files` path before forwarding the server-side OAuth bearer token; regression tests reject both cross-origin URLs and unexpected same-origin paths. On Cloudflare Workers, the resumable PUT uses `FixedLengthStream` when available so the outgoing body has a known length; mocked Node tests do not prove wire-level provider compatibility, so a credential-backed staging upload is still required. The upload handler also checks basic file signatures for the allowed JPEG, PNG, WebP, GIF, MP4, WebM, and Ogg types instead of trusting the multipart MIME label alone. Signature checks reduce simple MIME spoofing but are not full media decoding or malware scanning, and do not replace the owner's approved public-publication and admin-removal policy. Authentication throttling reserves each attempt in one conditional D1 `INSERT ... SELECT` statement before verification, making the count-and-reserve step atomic under concurrent requests. Login uses a 100-attempt-per-15-minute IP-and-role ceiling plus a 10-attempt-per-15-minute account bucket keyed by a digest of the normalized username; malformed payloads count against the IP ceiling, and successful verification removes only that request's own reservations. Tests cover concurrent attempts against one account, different accounts behind one shared IP, and one account across multiple source IPs. These application-level controls remain defense-in-depth and must be paired with approved edge-level rate limiting before public launch; live D1 concurrency has not been verified.

## Run local checks

From the repository root with Node.js 22 or newer:

```sh
npm run check
npm test
```

The dependency-free `package.json` defines the same checks used by CI. GitHub Actions also checks DOM references and validates that `backend/migrations/0001_initial.sql` produces the same schema objects as `backend/schema.sql`. The local D1 smoke verifies member denial on admin-only account management, password-change session revocation, issuance of a fresh token on relogin, and session revocation when an account is disabled. Setting `LOCAL_VERIFY_DRIVE=1` adds an authenticated D1/Drive health check before the dedicated-folder upload/read/delete smoke; it is skipped unless real test credentials and a dedicated folder are deliberately configured. Mock tests do not replace staging tests against a real Worker and database.

## Bindings and configuration

The Worker currently expects:

- `DB`: a Cloudflare D1 binding for account, session, announcement, and content metadata operations.
- `GOOGLE_CLIENT_ID`: OAuth client ID used by the Worker to refresh access tokens.
- `GOOGLE_CLIENT_SECRET` and `GOOGLE_REFRESH_TOKEN`: server-side secrets. Never put them in browser code, HTML, Git, or client-visible API responses.
- `GOOGLE_DRIVE_FOLDER_ID`: a dedicated folder accessible to the Google account that authorized the refresh token. The Worker stores uploaded files privately in this folder and proxies retrieval through `/api/media/:id`; it does not make Drive files public.
- `SETUP_SECRET`: a long random Worker secret, used only for one-time setup.
- `ALLOWED_ORIGIN`: the exact origin of the static site, with no trailing slash.
- Optional `SESSION_TTL_SECONDS`: session lifetime, bounded by the Worker.

**Google setup prerequisite:** enable the Google Drive API in a Google Cloud project and configure an OAuth client/consent screen. Use the least-privilege `drive.file` scope and obtain a refresh token with that scope. Because `drive.file` only grants access to files/folders created by or explicitly opened with the app, do not assume a manually created Drive folder will pass the Worker health check. The helper `scripts/create-google-drive-folder.mjs` creates a dedicated app-owned folder using those credentials and prints only its folder ID. Run it locally with `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REFRESH_TOKEN` environment variables set; copy the returned ID into the uncommitted local Wrangler config or the approved Worker variable. The helper creates a real Drive folder, so run it only when you intend to create that resource. Keep the OAuth client secret and refresh token server-side. Ensure the consent configuration permits a durable refresh token; test-mode OAuth grants can expire. Do not paste credentials into GitHub comments or commit them. The owner must supply/securely configure credentials before real Drive uploads can be verified.

**Resource and migration caution:** do not deploy to production or change a live database without explicit approval and a verified schema/recovery plan. Do not apply `schema.sql` to an existing D1 as if it were a forward migration. Export/inspect the live schema first and prepare a reviewed, forward-only migration.

### Wrangler templates and D1 migrations

- `wrangler.example.toml` is a placeholder-only staging template. Copy it to `wrangler.toml` locally and replace the D1 database ID, site origin, OAuth client ID, and Drive folder ID only after staging resources are approved and verified. Keep the filled file uncommitted.
- `wrangler.local.example.toml` describes an isolated local D1 database for local Worker testing. Copy it to `wrangler.local.toml`; this local database is separate from any remote D1 database.
- Put `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, and `SETUP_SECRET` in `.dev.vars` for local testing or use Wrangler secrets in a deployed environment. Both `.dev.vars` and filled Wrangler configs are ignored by Git.
- The staging template declares a daily Cron Trigger for the Worker's `scheduled()` cleanup handler. This is configuration intent, not proof that a deployed trigger exists or fires; verify it in staging.
- `backend/migrations/0001_initial.sql` is the versioned **initial schema for a new, empty database**. CI checks it against `backend/schema.sql`. It is not a safe migration for an existing D1 database. Inspect the actual schema and migration history and prepare a separate, reviewed forward migration if data or tables already exist.
- No database ID, OAuth secret, refresh token, deployed Worker URL, or production environment is supplied by these templates. Do not deploy or run migrations against a remote database until resource identity, schema, and recovery plan are verified and the repository owner explicitly approves.

Health endpoints have separate contracts: public `GET /api/health` is a cheap liveness response and must not query D1, refresh OAuth, or call Google Drive. Admin-authenticated `GET /api/admin/health` checks D1 and access to the configured Google Drive folder, returning a dependency error if either is unavailable. This detailed route requires a valid admin session and completion of the forced-password-change flow. The frontend reads its Worker origin from the `community-api-base` meta value in `community.html`. It intentionally remains blank until a verified Worker origin is configured; do not invent a URL or point the published site at localhost.

## Reproducible local demo

**Fastest Windows demo:** from the repository root in PowerShell, run:

```powershell
npm run demo:local
```

This creates/uses only the isolated Wrangler local D1 configuration, preserves any existing Google values in `.dev.vars`, generates a local-only admin/setup secret on first run, initializes the admin, starts the Worker and static site on loopback, and opens `http://127.0.0.1:8000/community.html`. The saved demo credentials are kept in the Git-ignored `.local-demo-credentials.txt`; keep that file private. Press Ctrl+C in the PowerShell window to stop the servers. It does not deploy or contact a remote Cloudflare database. Login/account flows work without Google credentials; uploads remain unavailable until real local Drive OAuth credentials and a dedicated test folder are configured.

Prerequisites: Node.js 22+, npm, and Wrangler 4. Start from a clean checkout of this feature branch.

1. Copy `wrangler.local.example.toml` to `wrangler.local.toml`. The local D1 ID/name is deliberately separate from staging.
2. Create a root `.dev.vars` file (ignored by Git) with:
   ```dotenv
   SETUP_SECRET="replace-with-a-long-random-local-only-secret"
   GOOGLE_CLIENT_SECRET="your-oauth-client-secret"
   GOOGLE_REFRESH_TOKEN="your-refresh-token"
   ```
   The OAuth client ID and Drive folder ID go in `wrangler.local.toml`. For auth-only work you can leave the Google secrets unset; account/login routes use D1, while health and media routes fail closed until Drive is configured.
3. Apply the initial migration to **local D1 only**, then start the Worker:
   ```sh
   npx wrangler@4 d1 migrations apply community-hub-local --local --config wrangler.local.toml
   npx wrangler@4 dev --local --config wrangler.local.toml --ip 127.0.0.1 --port 8787
   ```
4. In a second terminal, serve only an allowlisted temporary copy of public site assets. Do **not** serve the repository root: local `.dev.vars`, demo credentials, and Wrangler configuration may be present there.
   ```powershell
   $demoSite = Join-Path $env:TEMP "class-xii-c-community-static"
   New-Item -ItemType Directory -Force $demoSite | Out-Null
   Copy-Item community.html,community.js,styles.css,index.html,gallery.html,script.js,sw.js -Destination $demoSite
   foreach ($dir in @("images","gallery","games","vimages")) {
     if (Test-Path $dir) { Copy-Item $dir -Destination $demoSite -Recurse -Force }
   }
   python -m http.server 8000 --bind 127.0.0.1 --directory $demoSite
   ```
   After stopping the server with Ctrl+C, remove the temporary copy:
   ```powershell
   Remove-Item -Recurse -Force $demoSite
   ```
   For a managed one-command flow, prefer `npm run demo:local`, which uses an allowlisted temporary document root and cleans it up on exit.
5. Open the static site at `http://127.0.0.1:8000/community.html`. On plain-HTTP `127.0.0.1` only, the existing frontend automatically defaults to the local Worker at `http://127.0.0.1:8787` (matching the local CORS origin). The committed `community-api-base` meta value remains blank, and the published site does not use the localhost fallback.
6. Initialize the first admin from a trusted terminal, not the browser. For example, use PowerShell and keep the secret/password in local environment variables:
   ```powershell
   $env:SETUP_SECRET = Read-Host "Local setup secret"
   $env:LOCAL_ADMIN_PASSWORD = Read-Host "Local admin password"
   $headers = @{ "X-Setup-Secret" = $env:SETUP_SECRET }
   $body = @{
     adminUsername = "local-admin"
     adminEmail = "admin@example.test"
     adminDisplayName = "Local Admin"
     adminPassword = $env:LOCAL_ADMIN_PASSWORD
   } | ConvertTo-Json
   Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8787/api/setup" -Headers $headers -ContentType "application/json" -Body $body
   ```
7. Open `http://127.0.0.1:8000/community.html`, sign in as the admin, create a member, sign in as that member, and test an upload. A real upload requires valid Google OAuth refresh credentials and an accessible Drive folder; mocked CI tests do not prove that external account configuration works.

For the real local-D1 account-flow smoke test, start the local Worker and set these PowerShell variables to match the values in `.dev.vars`/your local admin credentials, then run `npm run smoke:local`:

```powershell
$env:LOCAL_API_URL = "http://127.0.0.1:8787"
$env:LOCAL_SETUP_SECRET = Read-Host "Local setup secret (same value as .dev.vars)"
$env:LOCAL_ADMIN_USERNAME = Read-Host "Local admin username"
$env:LOCAL_ADMIN_EMAIL = Read-Host "Local admin email"
$env:LOCAL_ADMIN_PASSWORD = Read-Host "Local admin password"
npm run smoke:local
```

The script refuses non-local URLs, exercises setup/admin login/member creation/temporary-password change/relogin/old-password rejection, and disables its generated test account. It may be rerun after setup has already completed. To also verify a **real** Drive upload, byte-for-byte read-back, and deletion, configure valid OAuth credentials and a dedicated test folder in the local Worker, then set `$env:LOCAL_VERIFY_DRIVE = "1"` before running `npm run smoke:local`. The opt-in test uploads one tiny PNG and deletes it afterward. Without that flag, the script tests account flow only. Never point it at a remote API or a folder containing real class media.

Use `npm run check` and `npm test` for fast unit/regression checks. Route tests use a fake Google API and mock D1 objects; CI also runs `npm run smoke:local` against an isolated Wrangler local D1 and verifies the account lifecycle. That local-D1 smoke does **not** verify real Google Drive access. To test actual Drive upload/read/delete, configure valid OAuth credentials and a dedicated test folder locally and opt in with `LOCAL_VERIFY_DRIVE=1`; the smoke script uploads one tiny PNG, checks byte-for-byte read-back, and attempts cleanup. Never point these commands at a remote database or a Drive folder containing real class media unless the owner has approved that exact test.

## One-time administrator setup

After the Worker and its storage are configured in an approved environment, use a trusted CLI or administrative tool to send a single POST request to `/api/setup` with header `X-Setup-Secret: <your secret>` and a JSON body like this: This endpoint is intentionally CLI-only: `X-Setup-Secret` is not in the browser CORS allowlist, and the secret must never be sent from frontend JavaScript or stored in page state.

```json
{
  "adminUsername": "choose-a-unique-admin-username",
  "adminEmail": "admin@example.com",
  "adminDisplayName": "Class Archive Admin",
  "adminPassword": "a unique random password of at least 12 characters"
}
```

Use a password manager and do not reuse a school, email, GitHub, or other account password. The Worker first checks whether any user already exists and, if so, returns `409` before parsing the request or performing PBKDF2 password hashing. For the first setup, it still uses one conditional `INSERT ... SELECT ... WHERE NOT EXISTS (SELECT 1 FROM users)` statement as the final race guard if two initialization requests overlap. Setup-attempt reservations remain on invalid/failed attempts and are cleared only after the conditional insert succeeds. CI tests cover repeat attempts after initialization and successful reservation cleanup; verify the flow against an approved D1 staging database before relying on it in production. After successful initialization, rotate or remove `SETUP_SECRET`.

## Privacy, media, and notifications

- **Owner-approved publication/removal policy:** uploads publish immediately and are public; there is no pre-publication moderation queue or prior-consent requirement. Uploaders cannot delete their own posts; the designated class archive administrator can remove posts. The Community page tells users how to request removal through the usual class communication channel. This records the owner's policy decision, not a general privacy recommendation. Do not upload sensitive personal information; visitors can access published media through the site.
- The Worker uses Google Drive for new media objects and stores the Drive file ID in D1 metadata. Drive files must remain private; public website access, if approved, is proxied through the Worker rather than granted directly to Drive files.
- Drive and D1 do not share a transaction. Upload creation attempts compensating Drive deletion if the D1 metadata insert fails; if cleanup fails, the unreferenced object must be reconciled. Deletion removes the Drive object before deleting the D1 row so a Drive failure leaves a retryable metadata row. These paths require failure-injection tests and a real staging verification before launch.
- Push delivery is not implemented. The push API deliberately reports that it is unavailable rather than claiming notifications were sent.
- Keep HTTPS enabled for the site and API. Use edge-level rate limiting as defense-in-depth and test a staging deployment before public launch.

## Pre-launch checklist

- [ ] Confirm all CI checks pass on the exact commit being reviewed.
- [ ] Test member login with username and password from the frontend.
- [ ] Test account creation, duplicate normalized username/email rejection, temporary-password gating, password change, disable/re-enable, reset, and session revocation.
- [ ] Verify atomic state/session changes and protect one-time administrator initialization against concurrent requests.
- [ ] Verify member lifecycle routes cannot mutate admin accounts; if multi-admin account management is added later, implement and test last-enabled-admin protection.
- [ ] Inspect the target D1 schema and review a forward-only migration; do not apply the baseline schema blindly.
- [ ] Confirm the media storage plan and cost before provisioning anything.
- [x] Record the owner's publication/removal decision: no prior-consent requirement; uploads publish immediately and are public; uploaders cannot delete their own posts; only the administrator can remove posts. Public visibility is owner-approved: the content, announcement, and media-read routes are intentionally public.
- [ ] Treat push notifications as unavailable until delivery and failure cases have real tests.


## Google Drive media access model

Uploads use the configured Google OAuth refresh-token credentials and are stored in the dedicated Drive folder. Drive files are **not** granted public permissions. The existing gallery's content listing and `GET /api/media/:id` endpoint are intentionally public, however, so a published gallery item's bytes can be fetched through the Worker URL without signing in. Treat that as public-to-anyone-who-has-the-site/URL media, not private class storage. Do not upload sensitive documents or images. The current owner decision is public visibility. Only if the owner changes that policy should member-only access be introduced; in that case, gate both the content listing and media route behind a valid session, and never solve this by making Drive files public.

The Worker delegates OAuth token refresh and Drive file operations to `backend/google-drive.js`; `backend/worker.js` enforces account authorization, upload validation, and D1 metadata consistency. CI mocks the OAuth/Drive API and verifies the request contract, but only an owner-approved staging run can validate the real refresh token, Drive folder permissions, and published Worker behavior.
