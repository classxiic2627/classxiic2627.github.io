# Class XII C Community Archive API

This Worker backs the static community site. Secrets stay in Worker configuration and must never be placed in browser JavaScript or committed to Git.

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

Request bodies are bounded independently of the `Content-Length` header: JSON requests are limited to 1 MiB, and complete multipart upload requests are limited to 16 MiB (15 MiB media plus up to 1 MiB multipart overhead). The Worker counts streamed bytes before JSON or multipart parsing; `Content-Length` is only an early-rejection hint. Tests cover oversized JSON and multipart requests when that header is absent. This application-level guard does not replace checking Cloudflare's deployed request limits and staging behavior. The upload handler also checks basic file signatures for the allowed JPEG, PNG, WebP, GIF, MP4, WebM, and Ogg types instead of trusting the multipart MIME label alone. Signature checks reduce simple MIME spoofing but are not full media decoding, malware scanning, or a substitute for safe public-media/consent decisions. Authentication throttling reserves each attempt in one conditional D1 `INSERT ... SELECT` statement before verification, making the count-and-reserve step atomic under concurrent requests. Login uses a 100-attempt-per-15-minute IP-and-role ceiling plus a 10-attempt-per-15-minute account bucket keyed by a digest of the normalized username; malformed payloads count against the IP ceiling, and successful verification removes only that request's own reservations. Tests cover concurrent attempts against one account, different accounts behind one shared IP, and one account across multiple source IPs. These application-level controls remain defense-in-depth and must be paired with approved edge-level rate limiting before public launch; live D1 concurrency has not been verified.

## Run local checks

From the repository root with Node.js 22 or newer:

```sh
npm run check
npm test
```

The dependency-free `package.json` defines the same checks used by CI. GitHub Actions also checks DOM references and validates that `backend/migrations/0001_initial.sql` produces the same schema objects as `backend/schema.sql`. Mock tests do not replace staging tests against a real Worker and database.

## Bindings and configuration

The Worker currently expects:

- `DB`: a Cloudflare D1 binding for account, session, announcement, and content metadata operations.
- `GOOGLE_CLIENT_ID`: OAuth client ID used for the server-side Google OAuth refresh-token flow.
- `GOOGLE_CLIENT_SECRET` and `GOOGLE_REFRESH_TOKEN`: Worker secrets. They must never be placed in browser code, `wrangler.toml`, or Git. The OAuth grant must include the Google Drive scope needed for the dedicated folder.
- `GOOGLE_DRIVE_FOLDER_ID`: ID of the dedicated folder the authorized Google account can access. Keep the folder private; the Worker proxies media through its API.
- `SETUP_SECRET`: a long random Worker secret, used only for one-time setup.
- `ALLOWED_ORIGIN`: the exact HTTPS origin of the deployed static site, with no trailing slash.
- Optional `SESSION_TTL_SECONDS`: session lifetime, bounded by the Worker.

**Resource and migration caution:** Do not create paid resources or change a live database without explicit approval and a verified cost/schema review. Google Drive integration still requires an owner-authorized OAuth client, refresh token, and dedicated folder; do not create credentials or grant access without approval. Do not apply `schema.sql` to an existing D1 as if it were a forward migration. Export/inspect the live schema first and prepare a reviewed, forward-only migration.

### Wrangler template and D1 migrations

- `wrangler.example.toml` is a placeholder-only staging template. Copy it to `wrangler.toml` locally and replace placeholders only with verified, approved values. Keep the filled file uncommitted. `.gitignore` excludes `wrangler.toml`, `.dev.vars`, and local Wrangler state. Store `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, and `SETUP_SECRET` as Worker secrets, never as TOML vars.
- The template declares a daily Cron Trigger for the Worker's `scheduled()` cleanup handler. This is configuration intent, not proof that a deployed trigger exists or fires; verify it in staging.
- `backend/migrations/0001_initial.sql` is the versioned **initial schema for a new, empty database**. CI checks it against `backend/schema.sql`. It is not a safe migration for an existing D1 database. Inspect the actual schema and migration history and prepare a separate, reviewed forward migration if data or tables already exist.
- No database ID, bucket, secret, deployed Worker URL, or production environment is supplied by this template. Do not deploy or run migrations until the resource identity, schema, cost, and recovery plan are verified and the repository owner explicitly approves.

The health endpoint checks D1 and verifies access to the configured Google Drive folder; it returns `503` if either check fails. Mocked Google API tests do not prove that a real OAuth refresh token or folder permission works. The frontend reads the Worker URL from the `community-api-base` meta element in `community.html`; it is intentionally blank until a Worker origin has been approved and verified. Do not invent or commit a live Worker URL.

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

- **Member uploads are published immediately; there is no pre-publication moderation queue.** The public content and media endpoints make these posts accessible to visitors. Before launch, establish a class-photo consent and removal policy, make the administrator contact path clear, and decide whether immediate public posting is appropriate for the class. Do not upload photos/videos without permission or publish sensitive personal information. If the class needs approval before publication, add and test a moderation workflow before deployment.
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
- [ ] Confirm consent, public visibility, and removal-request handling.
- [ ] Treat push notifications as unavailable until delivery and failure cases have real tests.
