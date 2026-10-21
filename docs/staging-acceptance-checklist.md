# Community Hub staging acceptance checklist

This checklist is for the first isolated, no-cost staging run of the existing Community Hub Worker. It does not authorize production changes, merging, deployment, or any resource that might incur a charge.

## Entry gates

- [ ] Confirm the Cloudflare account and every proposed resource are eligible for a no-cost/free tier. Stop and ask the owner if cost is uncertain.
- [ ] Create only the owner-approved brand-new, empty staging D1 after the cost check; record its name/ID and environment.
- [ ] Apply the ordered migrations `0001_initial.sql` and `0002_upload_reservations.sql` only to that empty staging D1. Verify tables, indexes, and migration history.
- [ ] Configure a dedicated Google Drive test folder/account and approved OAuth credentials privately; never put secrets in Git, HTML, logs, or issue comments.
- [ ] Set the exact approved staging site origin in `ALLOWED_ORIGIN`; do not guess the Worker URL or point the public site at localhost.
- [ ] Confirm the frontend is still disconnected from any Worker until staging acceptance is complete.

## Configuration notes verified against the current Worker

- The deploy template is the repository-root `wrangler.example.toml` (not a `backend/wrangler.toml.example` file). Copy it to the ignored local `wrangler.toml`, fill only approved staging values, and keep that filled file out of Git.
- The template binds D1 as `DB`, points migrations at `backend/migrations`, sets `ALLOWED_ORIGIN`, `GOOGLE_CLIENT_ID`, and `GOOGLE_DRIVE_FOLDER_ID`, and declares the daily Cron Trigger. Store `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, and the temporary `SETUP_SECRET` as Worker secrets, never as committed vars.
- Apply the ordered files in `backend/migrations/` (`0001_initial.sql`, then `0002_upload_reservations.sql`) only to the newly created, verified-empty staging D1. Do not replay the baseline against an existing database; Wrangler migration history must be respected.
- First-admin initialization is a trusted local/CLI operation requiring `X-Setup-Secret`. Never call it from browser code or expose the secret through frontend state or CORS. Rotate/remove `SETUP_SECRET` immediately after successful initialization.
- The Worker's `scheduled()` handler currently deletes expired sessions and old authentication-attempt records only. **Cron execution does not discover or reconcile orphaned Drive files.** Keep Drive/D1 orphan reconciliation as a separate, test-folder-scoped procedure until an actual reconciliation job is implemented and verified.

## Functional acceptance (record evidence, not just a checkbox)

- [ ] Public liveness health check succeeds; authenticated admin dependency health verifies D1 and Drive readiness.
- [ ] Initialize the first admin through the trusted setup path, then remove/rotate the setup secret.
- [ ] Verify admin login, member creation, temporary-password gate, password change, invalid credentials, disable/re-enable, and session revocation.
- [ ] Verify CORS permits only the approved origin and rejects an unapproved origin.
- [ ] Verify public media read, authenticated admin/member upload, and admin-only removal match the owner's recorded policy.
- [ ] Verify unsupported media types, malformed requests, over-limit files, and missing/invalid authentication fail safely.
- [ ] Verify application throttling and configured edge-level rate limits in the deployed environment.
- [ ] Verify the Cron Trigger is configured and the cleanup handler actually runs.

## Browser push acceptance (PR #14; not merged)

The current push integration PR #14 has green mocked CI at head `75059fa36563c30883d79d9b0390d5ceecb7f366` ([run 39595766564](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39595766564), 98/98 tests). It enforces a 40-device per-announcement cap, eight concurrent sends, a five-second provider timeout, manual redirect handling, and a 10-device-per-account cap. This is code/test evidence only.

- [ ] Before staging, generate/configure VAPID public/private keys and a valid `mailto:` subject through owner-managed Worker settings; never commit the private key or put it in frontend code.
- [ ] On the approved staging origin, verify `GET /api/push/public-key` returns the public key only when the server-side VAPID configuration is valid.
- [ ] Sign in as a test member, complete any forced password change, grant browser notification permission, subscribe, reload, and confirm the UI reflects the existing browser subscription.
- [ ] Verify a second account cannot claim the same endpoint, and that an account cannot register an 11th device. Include a concurrent last-slot registration test if staging tooling allows it.
- [ ] Publish a harmless test announcement and verify the actual target browser receives and decrypts a notification, and that clicking it opens only a same-origin page. Record provider response status separately from proof of device display.
- [ ] With more than 40 disposable test subscriptions, verify the admin UI explicitly reports skipped recipients; do not claim all devices were notified. Confirm a provider timeout is counted as failed and a 404/410 endpoint is cleaned up.
- [ ] Disable notifications on a test device, confirm the server-side endpoint row is removed for the owning account, and verify that device receives no later announcements.
- [ ] Record the browser/OS, provider, UTC test time, counts, and sanitized result. No real provider delivery has yet been verified; do not mark these checks complete from mock tests alone.

## Cross-store failure and recovery

- [ ] Inject: Drive upload succeeds, D1 metadata insert fails, and compensating Drive delete succeeds. Confirm an error is returned and no orphan remains.
- [ ] Inject: Drive upload succeeds, D1 insert fails, and compensating Drive delete also fails. Confirm the request fails safely, emits a structured cleanup signal without secrets, and the orphan is discoverable for reconciliation.

- Automated fault-injection coverage now exercises Drive upload success followed by D1 insert failure with both successful and failed Drive cleanup. It verifies the request fails safely, no orphan signal is emitted after successful cleanup, and failed cleanup emits a sanitized signal with the item and Drive file IDs. This is mocked CI evidence, not a live Drive reconciliation test. Latest exact-head Actions run [`39586853858`](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39586853858) passed both jobs on code commit `f5f011d0c7b8cb15586b449689b0b551136ec56a` with 84/84 Worker tests, including lost-response recovery, rejection of different bytes with identical metadata, and fail-closed behavior when Drive listing temporarily returns no match.
- [ ] Document and exercise a safe orphan-reconciliation procedure scoped only to the dedicated test folder. Compare Drive file IDs with staging D1 metadata; never delete files outside the test folder or based on guesses.
- [ ] Test interrupted resumable uploads, same-key duplicate submissions, concurrent requests, changed-payload 409 and binary-distinct payload rejection and concurrent same-key race coverage, and cleanup after partial failure. Confirm retries do not silently publish duplicate media.
- [ ] Specifically test the case where Drive commits an upload but the Worker loses the final response before receiving its file ID. The feature branch now has D1 reservations, stable Drive `appProperties`, fail-closed reconciliation, and a deterministic mocked regression test. Exact-head CI passed on code commit `f5f011d0c7b8cb15586b449689b0b551136ec56a` in run [39586853858](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39586853858); keep launch blocked until the same failure is injected against isolated staging Drive. See the [upload idempotency implementation contract](https://github.com/classxiic2627/classxiic2627.github.io/blob/feature/community-security-foundation/docs/upload-idempotency-design.md).
- [ ] Test Drive read/delete failures and verify metadata remains in a state that supports safe retry.
- [ ] Record request/response evidence and relevant sanitized logs for each injected failure.

## Upload memory and boundaries

- [ ] Exercise the real deployed request path with a near-50 MiB valid file and observe Worker memory/errors. The multipart parser materializes the `File`, and the current upload route additionally calls `file.arrayBuffer()` to hash the entire file before streaming it to Drive; this can allocate another ~50 MiB buffer on top of parser/request overhead under the Worker's 128 MB memory ceiling. Remove the extra full-file copy with bounded incremental hashing, or demonstrate safe peak memory in isolated staging before accepting the current approach. The byte-count guard alone is not proof of memory safety.
- [ ] Verify a file above 50 MiB and a multipart request above 51 MiB are rejected, including a request without a trustworthy Content-Length.
- [ ] Record the deployed plan/limits and test outcome. If memory pressure or limits are unclear, stop and ask the owner before changing the approved upload cap.

## Evidence and exit gate

For each check, record: date/time, staging environment identifier (no secrets), test case, expected result, observed result, and a link to sanitized logs or test output.

- [ ] Attach exact-head CI evidence separately from live staging evidence; mocked tests do not prove provider behavior.
- [ ] Confirm real Drive upload/read/delete, CORS, D1 behavior, rate limits, cleanup/reconciliation, and the lost-response eventual-consistency scenario are verified.
- [ ] Review all failures with the team and resolve or explicitly document remaining blockers.
- [ ] Keep the public frontend API base unset until the owner reviews the evidence and explicitly authorizes the next step.
- [ ] Obtain separate explicit owner approval before merging, deploying beyond the approved staging setup, or touching production.

**Current state:** checklist prepared; no Cloudflare resource, remote D1, Drive credential, deployment, or production data has been created or changed by this document.
