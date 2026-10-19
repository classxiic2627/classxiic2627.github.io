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

## Run local checks

From the repository root with Node.js 22 or newer:

```sh
node --check community.js
node --check backend/worker.js
node --test tests/community-worker.test.mjs
```

GitHub Actions also checks DOM references and validates the D1 schema with SQLite. Mock tests do not replace staging tests against a real Worker and database.

## Bindings and configuration

The Worker currently expects:

- `DB`: a Cloudflare D1 binding.
- `MEDIA`: a Cloudflare R2 bucket binding.
- `SETUP_SECRET`: a long random Worker secret, used only for one-time setup.
- `ALLOWED_ORIGIN`: the exact HTTPS origin of the deployed static site, with no trailing slash.
- Optional `SESSION_TTL_SECONDS`: session lifetime, bounded by the Worker.

**Resource and migration caution:** Do not create paid resources or change a live database without explicit approval and a verified cost/schema review. Confirm current Cloudflare pricing and account limits before choosing R2. Do not apply `schema.sql` to an existing D1 as if it were a forward migration. Export/inspect the live schema first and prepare a reviewed, forward-only migration.

The health endpoint checks configured storage. A successful local mock test is not evidence that deployed bindings, secrets, migrations, or origin settings are correct. The frontend's `API_BASE` in `community.js` is intentionally empty right now, so the site is not connected to a deployed Worker. Set it only after an approved deployment and staging test; do not invent a Worker URL.

## One-time administrator setup

After the Worker and its storage are configured in an approved environment, send a single POST request to `/api/setup` with header `X-Setup-Secret: <your secret>` and a JSON body like:

```json
{
  "adminUsername": "choose-a-unique-admin-username",
  "adminEmail": "admin@example.com",
  "adminDisplayName": "Class Archive Admin",
  "adminPassword": "a unique random password of at least 12 characters"
}
```

Use a password manager and do not reuse a school, email, GitHub, or other account password. The Worker uses one conditional `INSERT ... SELECT ... WHERE NOT EXISTS (SELECT 1 FROM users)` statement for initialization, and CI tests assert this single-statement guard and the refusal path. Verify behavior against an approved D1 staging database before relying on it in production. After successful initialization, rotate or remove `SETUP_SECRET`.

## Privacy, media, and notifications

- Content and media endpoints may make published posts publicly accessible. Before launch, establish a class-photo consent and removal policy and make the actual administrator contact path clear. Do not upload photos/videos without permission or publish sensitive personal information.
- `MEDIA` is a required R2 binding in the current Worker; do not assume Google Drive or another storage provider is integrated.
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
