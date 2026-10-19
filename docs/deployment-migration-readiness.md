# Deployment and D1 Migration Readiness

**Status: BLOCKED — review only; not deployment approval.**  
**Reviewed feature head:** `895f77bffaef3f937dd09eca62b41daa5c38eb56`  
**Exact-head Actions run:** [39288733338](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39288733338) — successful  
**Code PR:** [#1 — Build the Community Hub API and secure upload foundation](https://github.com/classxiic2627/classxiic2627.github.io/pull/1)  
**Readiness PR:** [#2 — Add deployment and D1 migration readiness review](https://github.com/classxiic2627/classxiic2627.github.io/pull/2)

This document is an evidence checklist. It does not authorize merging, deployment, account initialization, live D1 migration, changing Google credentials, or provisioning paid resources.

## 1. Scope and current evidence

The owner narrowed the deliverable to **add a login/account system to the existing site and use Google Drive for new uploaded media**, without rebuilding the existing website or changing unrelated features.

At reviewed feature head `895f77bffaef3f937dd09eca62b41daa5c38eb56`:

- GitHub Actions run [39288733338](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39288733338) passed **71/71 automated tests**, JavaScript syntax checks, DOM-reference validation, SQLite schema/initial-migration parity, and local/staging Wrangler TOML validation.
- The Worker implements individual admin/member accounts, one-time CLI-only admin setup, password hashing, session expiry/revocation, temporary-password change, admin member management, announcements, and upload/read/delete routes.
- `backend/google-drive.js` is the canonical Google Drive adapter. It uses server-side OAuth refresh-token credentials, keeps Drive files private, proxies file content through the Worker, stores Drive file IDs in D1 metadata, and supports health/upload/read/delete operations.
- `tests/google-drive-adapter.test.mjs` and `tests/google-drive-delete.test.mjs` exercise the Worker routes with fake Google API responses and mock D1 objects. These are automated contract/regression tests, **not** real Google Drive or live D1 verification.
- `scripts/local-smoke-test.mjs` and `wrangler.local.example.toml` provide a repeatable local D1 account-flow test. The script exercises setup, admin login, member creation, temporary-password login, password change, relogin, rejection of the old password, and cleanup by disabling the test member. The smoke script has **not been run as part of this review**, so local D1 is not yet marked verified.
- `community.html` keeps the `community-api-base` meta value blank. The published frontend is therefore **not connected to a deployed Worker**.
- No approved Google OAuth client/refresh token/folder, deployed staging Worker, or verified staging D1 was supplied or tested in this review. No real Drive upload/read/delete has been demonstrated.

**Evidence labels:** automated CI = verified at the exact head above; local D1 demo = not verified here; real Google Drive = not verified; Cloudflare staging = not verified; production = not approved.

## 2. Required decisions and launch blockers

### Google Drive and media privacy

- [ ] The owner must provide/securely configure an approved Google OAuth client ID, client secret, refresh token with the required Drive scope, and a dedicated Drive folder accessible to the authorized account. Never put secrets in browser code, HTML, Git, comments, screenshots, or committed TOML.
- [ ] Verify the real account can access the chosen folder and perform upload, read, and delete using a dedicated test folder/account. Mocked tests do not prove OAuth consent configuration, refresh-token durability, folder permissions, quota, or provider behavior.
- [ ] **Decide whether class photos/videos are meant to be public.** `GET /api/content`, `GET /api/announcements`, and `GET /api/media/:id` are currently unauthenticated. The Drive objects remain private, but the Worker proxy makes published media publicly retrievable. The owner must confirm this visibility or require member authentication before staging.
- [ ] Member uploads are published immediately; there is no moderation queue. Confirm consent, removal procedures, and whether immediate publication is appropriate for the class.
- [ ] **Choose and implement an aggregate per-member upload quota before public launch.** The 15 MiB media / 16 MiB multipart caps are per request only. There is no aggregate per-member count/total-byte quota or upload-frequency ceiling. The owner must approve the policy; enforce it atomically against D1 usage/metadata and test concurrent, over-limit, and cleanup-failure cases. Do not silently choose a quota.
- [ ] Keep the cross-store failure path observable. If Drive upload succeeds but D1 insertion fails, the Worker attempts Drive deletion; failed cleanup requires orphan reconciliation. Deletion removes the Drive object before the D1 row so a Drive failure leaves retryable metadata. D1 and Drive are not transactional together; current failure-injection tests use mocks.

### Local demo and staging

- [ ] Run the documented local D1 demo using `wrangler.local.example.toml`, local-only `.dev.vars`, and `npm run smoke:local`. Verify the Worker is started with the local config and the script's URL guard points only at `http://127.0.0.1:8787`. Do not run it against a remote database.
- [ ] Record the local D1 result separately from Google Drive verification. The auth-only demo can run without Google credentials; health and media operations should fail closed until authorized Drive credentials/folder access are configured.
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
- Request bodies are bounded by streamed byte counts, and allowed media types have basic signature checks. These checks are not full media decoding or malware scanning.
- Push delivery is not implemented; the API deliberately reports it unavailable.
- The service-worker navigation tests constrain notification-click navigation to the archive origin, but that does not implement push delivery or prove deployment configuration.

## 5. Release checklist

- [x] Exact-head automated CI passed at `895f77bffaef3f937dd09eca62b41daa5c38eb56`: run [39288733338](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39288733338), 71/71 automated tests plus syntax, DOM, schema/migration, and Wrangler template checks.
- [ ] Run and record the local D1 smoke script.
- [ ] Verify real Google OAuth and Drive folder access using a dedicated test account/folder.
- [ ] Resolve public-media visibility and class-photo consent/removal policy.
- [ ] Select and implement an owner-approved aggregate upload quota.
- [ ] Inventory the target D1, verify backup/restore, and review a migration matched to the observed schema.
- [ ] Verify staging end-to-end with isolated D1 and Drive resources, exact CORS/API origin, Cron Trigger, and edge rate limits.
- [ ] Obtain explicit owner approval before merge/deployment or any production action.

**Current decision: BLOCKED pending the unchecked evidence and owner decisions above.** A green automated suite is useful progress, but it is not proof of a real local D1 run, real Google Drive access, staging readiness, or permission to launch.
