# Deployment and D1 Migration Readiness

**Status:** Review-only; not deployment approval  
**Reviewed branch:** `feature/community-security-foundation`  
**Reviewed code/test head:** `8294db509e2de5f46e8a81a0ab7078081f85bd94`  
**Workflow cleanup commit:** `68c7caaaf72f189c319178570f3c675c3f066b76`  
**Pull request:** [#1 — Build the Community Hub API and secure upload foundation](https://github.com/classxiic2627/classxiic2627.github.io/pull/1)

## Executive decision

**Do not launch or modify a production D1 database yet.** The setup-throttling change at `14b63ccb9068efdf6678d343440360f8c64bd2ec` was tested and its Actions runs failed because the first-admin setup test fixture lacked the top-level `.first()` method required by the new preflight query (61 passed, one failed; expected 201, received 500). The fixture was corrected in code/test head `8294db509e2de5f46e8a81a0ab7078081f85bd94`; exact-head PR run [39282867277](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39282867277) is queued. The workflow-only cleanup at `68c7caa` avoids duplicate push-triggered checks on the feature branch. Previous code/test head `409d8afed020e31f2387325ce3094c0807cdbd28` passed 61/61 tests, but does not verify the setup fix. Live database compatibility, production bindings, API configuration, storage readiness, and recovery evidence have not been established.

This document is an evidence checklist and proposed plan only. It does not authorize provisioning, deployment, migration, account initialization, or changes to live data.

## 1. What is verified in the repository

At current code/test head `8294db509e2de5f46e8a81a0ab7078081f85bd94` (setup-throttle implementation at `14b63ccb9068efdf6678d343440360f8c64bd2ec`; workflow cleanup at `68c7caa`):

- `backend/worker.js` implements the Cloudflare Worker API.
- `backend/schema.sql` defines `users`, `sessions`, `content`, `announcements`, `push_subscriptions`, and `auth_attempts`.
- `backend/README.md` documents the account model, setup, bindings, and explicit deployment/migration limitations.
- `community.js` has an intentionally empty `API_BASE`; the static frontend is not connected to a deployed API.
- The reviewed feature-branch tree now contains `backend/migrations/0001_initial.sql`, `wrangler.example.toml`, and `package.json`. The Wrangler file is only a staging template with placeholder D1/R2 identifiers, not a runnable deployment config; no actual resource IDs or live environment were verified. The template includes a daily Cron Trigger, but this does not configure any deployed Worker until an approved, filled config is applied. The feature branch's `.gitignore` excludes local `wrangler.toml`, `.dev.vars`, `.env*`, `node_modules/`, and `.wrangler/` from ordinary commits.
- **Deployment-template origin setting:** commit `b2adaeb` adds a clearly marked `ALLOWED_ORIGIN` placeholder under `[vars]`, which is required for browser requests. Replace it with the exact approved HTTPS staging origin before use. Keep `SETUP_SECRET` as a secret, not a plaintext config value.
- The Worker requires `DB` (D1) for API routes. `MEDIA` (R2) is required for the health endpoint and media operations; account and announcement routes can run without it, while media/health checks fail closed. `SETUP_SECRET` and `ALLOWED_ORIGIN` are configuration inputs; `SESSION_TTL_SECONDS` is optional.
- The Worker deliberately reports push subscription as unavailable (HTTP 501); push delivery is not implemented.
- Content, announcements, and media reads are public in the current API. Confirm this is intentional and obtain appropriate consent before publishing class media.
- The delete flow attempts R2 object deletion before deleting the D1 metadata row. If R2 deletion fails, the metadata remains available for an admin retry. If R2 succeeds and the D1 delete fails, the metadata remains while the object is gone; a retry can repeat the idempotent R2 deletion and then remove the row. D1 and R2 still cannot participate in one atomic transaction, so reconciliation remains an operational concern.

### CI evidence

The previous feature head `409d8afed020e31f2387325ce3094c0807cdbd28` passed Actions run [39277913558](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39277913558) with **61/61 automated tests**, syntax checks, 50 DOM-reference checks, schema/initial-migration parity, and Wrangler template/TOML checks, including cross-IP throttling. The setup-throttle implementation at `14b63ccb9068efdf6678d343440360f8c64bd2ec` failed both runs [39278956384](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39278956384) and [39278963620](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39278963620): **61 passed, 1 failed**. Root cause was a test mock missing a top-level `.first()` implementation for the new `SELECT 1 AS present FROM users LIMIT 1` preflight query, causing the first-admin setup test to receive 500 instead of 201; the Worker preflight was not shown to be the failure. Commit `8294db509e2de5f46e8a81a0ab7078081f85bd94` adds the missing mock method. Its exact-head PR run [39282867277](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39282867277) is queued, so the correction is not yet CI-verified. Workflow-only head `68c7caaaf72f189c319178570f3c675c3f066b76` removes feature-branch `push` runs while retaining PR checks and `main` push checks; this reduces future duplicate runs but does not clear existing queued runs.

The previous head `4048b578` had two failed runs because a legacy login-throttle test omitted `username` and therefore exercised malformed-input handling (expected `429`, received `400`). The handler was adjusted to reserve the IP slot before parsing malformed payloads; head `5e8dc240` passed 60/60, the next head added cross-IP coverage and passed 61/61, and the setup-throttle implementation head `14b63ccb` failed because of a test-fixture mock gap, corrected in `8294db509e2de5f46e8a81a0ab7078081f85bd94`; exact-head PR run [39282867277](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39282867277) is queued. Treat only the run attached to the exact release SHA as release evidence.

The feature includes streamed request-size enforcement, basic media-signature checks, R2/D1 upload compensation handling, CLI-only setup CORS, atomic auth-attempt reservations, layered IP/account throttling, and service-worker notification-click origin validation. Repository-level tests are not a live D1 or deployed Worker/R2 integration test. They also do not verify a real Cloudflare edge-rate-limit rule or the production behavior of D1 concurrency.

This is evidence of repository-level checks only. It is **not** proof of compatibility with the actual D1 database or a deployed Worker/R2 environment.

PR #1 remains open and unmerged. The latest inspected feature head is `8294db509e2de5f46e8a81a0ab7078081f85bd94` (test-fixture correction on top of workflow cleanup and the setup-throttle implementation); exact-head CI is queued, so always retest the exact release commit. No live Cloudflare environment has been tested by this review.

## 2. D1 inventory required before migration design

No live D1 database was inspected by this review. The following are launch blockers until evidence is supplied.

1. Identify the intended environment and exact D1 database name/ID. Confirm explicitly whether it is staging or production.
2. Obtain a read-only schema inventory, including all tables, columns, indexes, unique constraints, foreign keys, and check constraints. Useful SQLite inspection includes `sqlite_master` and `PRAGMA table_info(...)`, `PRAGMA index_list(...)`, and `PRAGMA foreign_key_list(...)`.
3. Establish the existing migration history and any manually applied schema changes.
4. Capture row counts and validate data relationships without exporting unnecessary personal data into review comments.
5. Confirm whether any existing `members`, `posts`, `announcements`, `push_subscriptions`, or `sessions` tables contain data. Earlier review notes mentioned these table names, but this review has **not** verified them against the live database.
6. Check whether existing rows can satisfy the new schema's requirements, particularly unique normalized usernames/emails, required email, role values, foreign keys, and session token representation.

### Why applying `backend/schema.sql` blindly is unsafe

The schema uses `CREATE TABLE IF NOT EXISTS`. If a table already exists, SQLite does not reconcile its existing columns or constraints with the new definition. The script can finish without making the existing table compatible with the Worker. For example, the Worker expects columns such as `users.password_hash`, `users.must_change_password`, and `users.disabled`.

Do not run the baseline schema against a live database as a migration, and do not drop, rename, or recreate existing tables as a shortcut.

## 3. Proposed forward-only migration procedure

1. **Inventory first.** Record the database identity, current schema, migration history, data counts, dependencies, and intended target version.
2. **Back up and verify.** Export D1 schema and data to an access-controlled location. Verify the export is usable, and determine whether the account's D1 Time Travel/backup options provide an additional recovery point. Protect exports as sensitive data.
3. **Choose the migration path based on evidence.**
   - If the intended database is confirmed empty and new, review and test the existing `backend/migrations/0001_initial.sql` as the initial migration.
   - If it contains tables or data, design a separate forward migration from the observed state. Preserve existing rows and relationships; define duplicate resolution and invalid-data handling before running anything.
4. **Use versioned migrations.** Keep immutable, ordered SQL files in Wrangler's migrations directory and use Wrangler's D1 migration workflow. Do not rely on repeatedly running `schema.sql` or manual bookkeeping.
5. **Test against an isolated staging database.** Apply the same migration sequence, verify schema and constraints, validate row counts and foreign-key integrity, and exercise the Worker against that migrated database.
6. **Review and authorize.** Present the migration diff, expected row/data effects, backup evidence, and recovery procedure for approval before any production action.
7. **Apply once and verify.** After explicit approval, apply the migration to the identified target, verify the resulting schema and migration history, then perform application smoke tests.

### Validation examples

Adapt these to the actual schema; do not run modifying SQL during inventory.

- Compare table/column definitions against the intended schema.
- Check for duplicate canonical usernames and emails before adding unique constraints.
- Check for rows with missing required values and for orphaned foreign-key references.
- Verify row counts before/after migration and explain any expected differences.
- Confirm sessions remain valid only where intended and that disabled/reset accounts cannot keep using existing sessions.

## 4. Recovery plan

- Keep the last known-good schema/data export protected and record who can access it.
- Verify a restore procedure against a non-production copy before relying on it.
- Document the point-in-time recovery available for the actual D1 plan and environment; retention and restore behavior depend on the service/account configuration.
- Treat a restore as a destructive operation that can overwrite later writes. Require explicit authorization, identify the recovery point, and plan for data written after that point.
- Back up or inventory R2 media separately. A D1 export does not back up R2 objects.
- Because D1 and R2 are not transactional together, include reconciliation for missing objects and orphaned metadata. Preserve a retry path for failed media deletion.
- Do not describe a migration as reversible unless a tested rollback/restore procedure exists. Forward-only schema changes may require a restore or a compensating migration to recover.

## 5. Deployment configuration checklist

- [ ] Copy `wrangler.example.toml` to a local `wrangler.toml`, replace placeholders only with verified, approved staging resources, validate it, and keep the filled config out of Git. Review distinct staging/production settings before any deployment.
- [ ] Bind `DB` to the approved D1 database and verify its ID/environment.
- [ ] Resolve the media-storage choice and cost first. The current Worker needs an R2 binding named `MEDIA` for health checks and media routes; no bucket or billing choice is assumed approved. Without it, database-backed account/announcement routes may work but health/media checks return `503`.
- [ ] Configure `ALLOWED_ORIGIN` to the exact HTTPS origin of the deployed static site, without a trailing slash.
- [ ] Configure `SETUP_SECRET` as a Worker secret, never in frontend JavaScript, committed files, screenshots, or chat. Use it only for one-time setup, then rotate or remove it.
- [ ] Set the frontend `API_BASE` to the verified deployed Worker HTTPS origin only after an approved deployment and staging test. Do not guess the URL.
- [ ] Decide the session TTL; if set, verify it falls within the Worker-enforced bounds.
- [ ] Confirm HTTPS, CORS preflight, API routes, health behavior, upload limits, public-media behavior, and browser connectivity in staging.
- [x] **Service-worker notification navigation is constrained to the archive origin.** Malformed/off-origin notification destinations fall back to `/`; existing tabs are selected by parsed `URL.origin` equality rather than string-prefix matching. A regression test places a lookalike hostname before the real archive tab and verifies only the real tab is selected. This is repository-level test evidence; push delivery remains unimplemented and this feature does not register the service worker.
- [ ] **Keep first-admin setup CLI/trusted-admin-tool only.** The setup-throttle implementation at `14b63ccb9068efdf6678d343440360f8c64bd2ec` documents this contract, keeps `X-Setup-Secret` out of browser CORS, and adds regression coverage; the current test-fixture correction is `8294db509e2de5f46e8a81a0ab7078081f85bd94`. Do not add the secret to frontend code. Verify the documented trusted-tool setup flow in an approved staging environment and rotate/remove the secret immediately after initialization.
- [x] **Setup retry-throttling implementation and regression tests added; exact-head CI pending.** `/api/setup` checks for an existing user after validating the CLI-only setup secret and returns `409` before JSON parsing or PBKDF2 when initialization is complete. Reservations remain on invalid/failed setup and clear only after the conditional first-admin insert succeeds; that insert remains the race guard. A regression test checks 10 repeated valid-secret attempts after initialization return `409` and the 11th returns `429` without attempting an insert. Initial exact-head runs for implementation commit `14b63ccb9068efdf6678d343440360f8c64bd2ec` failed because the successful-setup test mock lacked the new top-level `.first()` method; the fixture was corrected at `8294db509e2de5f46e8a81a0ab7078081f85bd94`. Exact-head PR run [39282867277](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39282867277) is queued. Rotate/remove the secret immediately after initialization and verify behavior in staging.
- [ ] Decide how scheduled cleanup is configured and verify expired sessions and old authentication-attempt records are cleaned up.
- [ ] Verify deployment permissions, review requirements, monitoring, and a clear owner for incidents and account administration.
- [x] **Application-level concurrent-auth-throttling race addressed in the reviewed feature head.** The Worker now reserves a slot with one conditional D1 `INSERT ... SELECT` before login/setup/password verification and deletes only that request's reservation after successful verification. A concurrency regression test launches 20 same-IP login failures and verifies 10 reach credential verification while 10 receive `429`; CI also exercises the SQL threshold in SQLite. This is repository/mock evidence, not proof of real D1 concurrency behavior. Keep edge-level rate limiting as defense in depth and verify both controls in staging before public launch.
- [x] **Layered login throttling reduces shared-IP lockout risk.** Login applies a 100-attempt/15-minute IP-and-role ceiling plus a 10-attempt/15-minute per-account bucket keyed by a digest of the normalized username. Tests cover 20 distinct usernames behind one shared IP, 20 concurrent failures for one account, and 20 attempts for one account across 20 different source IPs. Malformed payloads also count against the IP ceiling. The previous reviewed feature head `409d8afed020e31f2387325ce3094c0807cdbd28` passed 61/61 tests in Actions runs [39277905076](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39277905076) and [39277913558](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39277913558); the setup-throttle implementation failed due to a test-fixture mock gap, now corrected in `8294db509e2de5f46e8a81a0ab7078081f85bd94`; exact-head run [39282867277](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39282867277) is queued. This is repository/mock evidence, not live D1 concurrency or a deployed edge-rate-limit test; configure and verify edge-level rate limiting in staging.
- [ ] **Decide whether targeted temporary account lockout is acceptable.** Because failed attempts are counted in a per-username bucket across IPs, someone who knows a student's username can intentionally consume its 10-attempt allowance and cause `429` responses for up to 15 minutes. The shared-IP regression test covers collateral lockout but not deliberate targeted lockout. Confirm this trade-off with the class; consider progressive delay/monitoring alongside IP and edge limits, and test whichever policy is selected.
- [ ] Confirm current Cloudflare pricing/limits and avoid creating paid resources without explicit approval.

## 6. Staging acceptance tests

Before launch, provide evidence that the exact release commit passes CI and that a real staging Worker works with the intended D1 and media binding.

At minimum test:

- Health endpoint with correctly configured D1 and media storage, plus failure behavior when a dependency is unavailable.
- One-time admin initialization, refusal on repeat setup, and secret rotation/removal.
- Individual member creation, duplicate normalized username/email rejection, login, temporary-password gate, password change, logout, and session revocation.
- Disabled-account requests with an already-issued session; password reset and account changes must revoke sessions as intended.
- Admin/member role boundaries, invalid input, rate limiting, and cross-origin request rejection.
- Upload size/type validation, public visibility, media retrieval, and deletion failure/retry behavior.
- Data integrity and expected row counts after the migration.
- Frontend API connectivity and useful user-facing errors for unavailable API/storage.
- Confirmation that notifications are not advertised as available until actual push delivery and failure cases are implemented and tested.

## 7. Privacy and operational readiness

- Confirm consent and expectations for publishing student photos/videos, including whether the archive is public.
- **Member uploads are published immediately; there is no pre-publication moderation queue.** Decide whether this is appropriate for the class. If posts need approval before going public, add and test a moderation workflow before deployment.
- Establish a clear removal-request contact path and a process to remove both D1 metadata and R2 objects.
- Avoid publishing sensitive personal information.
- Ensure temporary passwords are shared privately and are never returned again by the API after account creation/reset.
- Decide who administers accounts, responds to abuse/removal requests, and handles outages.
- Consider edge-level rate limiting as defense in depth; application-level auth throttling alone is not the entire operational security plan.
- **Authentication throttling policy trade-off:** the layered design has a 100-attempt/15-minute IP-and-role ceiling plus a 10-attempt/15-minute per-account bucket keyed by a digest of the normalized username. This reduces collateral lockout for classmates sharing school Wi-Fi, but a person who knows a username can consume that account's allowance across multiple IPs and temporarily block that account. Confirm this 15-minute targeted-lockout behavior is acceptable, or revise the policy and add regression tests before launch.
- **Request-size and upload-type checks are covered by repository tests.** The Worker counts streamed bytes before parsing JSON/multipart, so the byte counter—not `Content-Length`—is authoritative when the header is absent or untrusted. It also checks basic signatures for allowed JPEG/PNG/WebP/GIF/MP4/WebM/Ogg types instead of trusting the MIME label alone. These signature checks are not full media decoding or malware scanning. Code/test commit `0e4c340bbd7f8e70cf8c3a1dc857a76475f70ea3` passed Actions run [39277637535](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39277637535) with 61/61 automated tests. The previous feature head `409d8afed020e31f2387325ce3094c0807cdbd28` passed exact-head Actions runs [39277913558](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39277913558) and [39277905076](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39277905076); the setup-throttle implementation at `14b63ccb9068efdf6678d343440360f8c64bd2ec` failed because the first-admin test fixture lacked a top-level `.first()` mock; the fixture was corrected at `8294db509e2de5f46e8a81a0ab7078081f85bd94`, whose exact-head run [39282867277](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39282867277) is queued. Cloudflare's platform request-body ceiling is not a substitute for the app's stricter limit; verify current plan limits and behavior in staging. See [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/).
- **R2/D1 upload compensation remains non-transactional.** If D1 metadata insertion fails after an R2 upload, the Worker attempts to delete the object; if that cleanup also fails, it logs the object key/error for later reconciliation. The compensation path has mock regression coverage only, not a live R2/D1 integration test.
- **Setup throttling code change is implemented; test-fixture correction awaits exact-head CI and staging verification.** The Worker returns `409` before parsing or PBKDF2 when users already exist, retains setup reservations on failed attempts, and clears only after a successful conditional insert. The regression test checks repeated valid-secret attempts after initialization are throttled. The first CI run failed because the test fixture did not implement the new top-level `.first()` query; this was corrected in `8294db509e2de5f46e8a81a0ab7078081f85bd94`, whose exact-head run is queued. Keep `SETUP_SECRET` CLI-only and rotate/remove it immediately after initialization; verify this behavior in staging.
- **Scheduled cleanup is not configured by source code alone.** The Worker has a `scheduled()` handler for expired sessions and auth-attempt cleanup, and `wrangler.example.toml` proposes a daily Cron Trigger. It will not run until the approved configuration is applied to the deployed Worker. Confirm the trigger exists and verify a cleanup run in staging. Auth still checks session expiry on each request. See [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

## 8. Launch decision record

**Current decision: BLOCKED pending evidence.**

The following must be reviewed before reconsideration:

- [ ] Exact target D1 identity and read-only schema/data inventory.
- [ ] Verified backup/export and tested recovery approach.
- [ ] Reviewed migration sequence matched to the observed database, tested in staging.
- [ ] Reviewed Wrangler configuration, binding IDs, origin, and secret setup without disclosing secret values.
- [ ] Approved media storage and cost decision.
- [ ] Passing CI on the exact release commit and staging integration evidence.
- [ ] Privacy/consent and removal procedures.
- [ ] Explicit owner approval for production migration and deployment.

**No live database changes, deployment, account initialization, or resource provisioning are authorized by this document.**

## References

- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare D1 import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
- [Cloudflare D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)