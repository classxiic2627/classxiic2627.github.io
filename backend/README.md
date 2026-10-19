# Class XII C Community Archive API

This is the API for the static site. It is intentionally separate from the public frontend so secrets never go into browser JavaScript or Git.

## What is implemented

- D1 schema for admin/member accounts, expiring sessions, gallery metadata, announcements, push subscription records and hashed authentication-attempt keys; a daily scheduled cleanup for old attempts and expired sessions.
- Worker routes for one-time setup, separate member/admin login, logout, password change, content listing/upload/deletion, announcements, media delivery and a health check.
- PBKDF2-SHA-256 password hashing (210,000 iterations, per-password salt); random bearer tokens are stored only as SHA-256 hashes.
- R2 media storage; 15 MB upload limit and allowlisted MIME types; parameterized SQL; origin allowlisting; no-cache auth responses; IP-keyed throttling for failed login/setup attempts (10 failures per 15-minute window).
- Push key discovery endpoint only. Push delivery is intentionally not represented as working until VAPID signing and real delivery tests are implemented.

## Cloudflare setup

1. Create a D1 database and an R2 bucket in the Cloudflare dashboard.
2. Apply `schema.sql` to the D1 database using the D1 console or Wrangler.
3. Create a Worker named `class-archive-api`, deploy `worker.js` as its entrypoint, and bind:
   - D1 binding named `DB` to the database.
   - R2 bucket binding named `MEDIA` to the bucket.
4. Configure Worker variables:
   - `ALLOWED_ORIGIN`: exact production origin for the static site, including scheme and hostname, with no trailing slash.
   - Optional `SESSION_TTL_SECONDS`.
5. Add `SETUP_SECRET` as a **secret**, not a plain variable. Generate a long random value locally; do not commit it or send it in chat.
6. Deploy and verify `GET /api/health`.

Example Wrangler configuration (replace IDs locally; never commit real credentials):

```toml
name = "class-archive-api"
main = "worker.js"
compatibility_date = "2026-10-19"

[[d1_databases]]
binding = "DB"
database_name = "class-archive"
database_id = "REPLACE_WITH_YOUR_D1_DATABASE_ID"
migrations_dir = "migrations"

[[r2_buckets]]
binding = "MEDIA"
bucket_name = "class-archive-media"

[triggers]
crons = ["17 3 * * *"]
```

The daily scheduled trigger prunes authentication-attempt records older than 24 hours and expired sessions. If configuring the Worker in the dashboard instead of Wrangler, add the same daily cron trigger there.

Use a local `wrangler.toml` (or dashboard configuration) and real database IDs only in your own environment.

## One-time account initialization

After deploying and verifying storage bindings, send one POST request to `/api/setup` with header `X-Setup-Secret: <your secret>` and JSON body:

```json
{
  "adminUsername": "your-chosen-admin-username",
  "adminPassword": "a unique random password of at least 12 characters",
  "memberPassword": "a different random password of at least 12 characters"
}
```

Use a password manager. Do not reuse your email, school, or GitHub password. This endpoint refuses to run after any account exists. After successful initialization, rotate or remove `SETUP_SECRET` in Worker settings. Never put it in frontend code, Git, screenshots, or chat.

## Important integration notes

- Frontend `community.js` sends the member login body as `{password}` and admin login as `{username,password}`; both match the API. The admin form includes a username field.
- The frontend now provides password-change forms for both member and admin accounts. Accounts flagged with `must_change_password` must change their password before the upload/admin tools are shown. Password changes revoke that user's active sessions, so they must sign in again.
- Content is delivered through `/api/media/:id`; the frontend gallery must render these media URLs, not attempt to read private R2 objects directly.
- The current frontend's `/api/push/subscribe` flow is not ready for production. Push delivery is not implemented and the API deliberately returns 501 instead of pretending notifications work.
- This starter uses one shared class-member password for simplicity. If the class needs per-student access, implement individual account provisioning and reset/revocation workflows before launch.
- Do not upload photos or videos of classmates without appropriate consent. The frontend explains public visibility and a removal-request path, but before launch replace the generic class-communication instruction with the actual trusted admin contact/channel. Do not publish sensitive personal information.
- Keep Cloudflare edge rate limiting enabled as defense-in-depth, especially for login and setup, then run a security review and smoke tests on a staging Worker before sharing the portal. The Worker throttles failed login/setup attempts by IP, but distributed attempts and other abuse still require edge-level protection. The static site and API must both use HTTPS.
