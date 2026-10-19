# Deployment and D1 Migration Readiness

**Status:** Review-only; not deployment approval  
**Reviewed branch:** `feature/community-security-foundation`  
**Reviewed commit:** `b2adaeb2f364027230823d4bc4ce6e12446b0d59`  
**Pull request:** [#1 — Build the Community Hub API and secure upload foundation](https://github.com/classxiic2627/classxiic2627.github.io/pull/1)

## Executive decision

**Do not launch or modify a production D1 database yet.** The feature branch has a useful baseline and its latest reviewed commit has a successful GitHub Actions run, but live database compatibility, production bindings, API configuration, storage readiness, and recovery evidence have not been established.

This document is an evidence checklist and proposed plan only. It does not authorize provisioning, deployment, migration, account initialization, or changes to live data.

## 1. What is verified in the repository

At reviewed commit `b2adaeb2f364027230823d4bc4ce6e12446b0d59`:

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

GitHub Actions run [39270488504](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39270488504) completed successfully for reviewed commit `b2adaeb2f364027230823d4bc4ce6e12446b0d59`. This exact commit includes the `ALLOWED_ORIGIN` staging placeholder in `wrangler.example.toml`. The run's successful conclusion confirms the repository workflow passed; the preceding `72fbfdd` checkpoint had 52/52 Worker tests plus frontend/Worker syntax, DOM-reference, and migration/schema checks. Treat only the run attached to the exact release SHA as release evidence. Repository-level checks are not a live D1 or deployed Worker/R2 integration test.

This is evidence of repository-level checks only. It is **not** proof of compatibility with the actual D1 database or a deployed Worker/R2 environment.

PR #1 remains open and unmerged. The reviewed feature branch has continued moving since the earlier review; always retest the exact release commit. CI here validates repository-level checks only, not a real Cloudflare environment.

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
- [ ] Decide how scheduled cleanup is configured and verify expired sessions and old authentication-attempt records are cleaned up.
- [ ] Verify deployment permissions, review requirements, monitoring, and a clear owner for incidents and account administration.
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
- Establish a clear removal-request contact path and a process to remove both D1 metadata and R2 objects.
- Avoid publishing sensitive personal information.
- Ensure temporary passwords are shared privately and are never returned again by the API after account creation/reset.
- Decide who administers accounts, responds to abuse/removal requests, and handles outages.
- Consider edge-level rate limiting as defense in depth; application-level auth throttling alone is not the entire operational security plan.
- **Request-size enforcement and numeric-header fast rejection are now covered by the current feature-branch code and CI.** The Worker counts streamed bytes before parsing JSON/multipart, so the byte counter—not `Content-Length`—is authoritative when the header is absent or untrusted. Commit `e2366381f58ec74d00f88374113f5cc558577a6a` corrected the declared-length regex to `/^\d+$/`, and the dedicated oversized numeric-`Content-Length` regression test passed in Actions run [39270182676](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39270182676) on commit `72fbfdd47e11bd84b7ec20c39d88be86c8540d11` (52/52 Worker tests plus syntax, DOM-reference, and schema/migration checks). The later current head `b2adaeb2f364027230823d4bc4ce6e12446b0d59` also has a successful repository workflow, run [39270488504](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39270488504). Cloudflare's platform request-body ceiling is not a substitute for the app's stricter limit; verify current plan limits and behavior in staging. See [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/).
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