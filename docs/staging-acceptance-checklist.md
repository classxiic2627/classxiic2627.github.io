# Community Hub staging acceptance checklist

This checklist is for the first isolated, no-cost staging run of the existing Community Hub Worker. It does not authorize production changes, merging, deployment, or any resource that might incur a charge.

## Entry gates

- [ ] Confirm the Cloudflare account and every proposed resource are eligible for a no-cost/free tier. Stop and ask the owner if cost is uncertain.
- [ ] Create only the owner-approved brand-new, empty staging D1 after the cost check; record its name/ID and environment.
- [ ] Apply the initial migration only to that empty staging D1. Verify tables, indexes, and migration history.
- [ ] Configure a dedicated Google Drive test folder/account and approved OAuth credentials privately; never put secrets in Git, HTML, logs, or issue comments.
- [ ] Set the exact approved staging site origin in `ALLOWED_ORIGIN`; do not guess the Worker URL or point the public site at localhost.
- [ ] Confirm the frontend is still disconnected from any Worker until staging acceptance is complete.

## Configuration notes verified against the current Worker

- The deploy template is the repository-root `wrangler.example.toml` (not a `backend/wrangler.toml.example` file). Copy it to the ignored local `wrangler.toml`, fill only approved staging values, and keep that filled file out of Git.
- The template binds D1 as `DB`, points migrations at `backend/migrations`, sets `ALLOWED_ORIGIN`, `GOOGLE_CLIENT_ID`, and `GOOGLE_DRIVE_FOLDER_ID`, and declares the daily Cron Trigger. Store `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, and the temporary `SETUP_SECRET` as Worker secrets, never as committed vars.
- Apply `backend/migrations/0001_initial.sql` only to the newly created, verified-empty staging D1. Do not use it to modify an existing database; the migration is a baseline, not a reconciliation migration.
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

## Cross-store failure and recovery

- [ ] Inject: Drive upload succeeds, D1 metadata insert fails, and compensating Drive delete succeeds. Confirm an error is returned and no orphan remains.
- [ ] Inject: Drive upload succeeds, D1 insert fails, and compensating Drive delete also fails. Confirm the request fails safely, emits a structured cleanup signal without secrets, and the orphan is discoverable for reconciliation.

- Automated fault-injection coverage now exercises Drive upload success followed by D1 insert failure with both successful and failed Drive cleanup. It verifies the request fails safely, no orphan signal is emitted after successful cleanup, and failed cleanup emits a sanitized signal with the item and Drive file IDs. This is mocked CI evidence, not a live Drive reconciliation test. Latest exact-head Actions run `39571908665` passed both jobs with 81/81 Worker tests.
- [ ] Document and exercise a safe orphan-reconciliation procedure scoped only to the dedicated test folder. Compare Drive file IDs with staging D1 metadata; never delete files outside the test folder or based on guesses.
- [ ] Test interrupted resumable uploads, retry behavior, duplicate submissions, and cleanup after partial failure. Confirm retries do not silently publish duplicate media.
- [ ] Specifically test the case where Drive commits an upload but the Worker loses the final response before receiving its file ID. Current retries are not proven idempotent for this window; keep launch blocked until a stable idempotency/reservation design is tested or the owner explicitly accepts the documented risk. The current implementation contract and required deterministic tests are in [the upload idempotency design note](https://github.com/classxiic2627/classxiic2627.github.io/blob/feature/community-security-foundation/docs/upload-idempotency-design.md). That note is design-only; this gate remains open until implementation and real staging fault injection pass.
- [ ] Test Drive read/delete failures and verify metadata remains in a state that supports safe retry.
- [ ] Record request/response evidence and relevant sanitized logs for each injected failure.

## Upload memory and boundaries

- [ ] Exercise the real deployed request path with a near-50 MiB valid file and observe Worker memory/errors; the multipart parser still materializes the file, so the byte-count guard alone is not proof of memory safety.
- [ ] Verify a file above 50 MiB and a multipart request above 51 MiB are rejected, including a request without a trustworthy Content-Length.
- [ ] Record the deployed plan/limits and test outcome. If memory pressure or limits are unclear, stop and ask the owner before changing the approved upload cap.

## Evidence and exit gate

For each check, record: date/time, staging environment identifier (no secrets), test case, expected result, observed result, and a link to sanitized logs or test output.

- [ ] Attach exact-head CI evidence separately from live staging evidence; mocked tests do not prove provider behavior.
- [ ] Confirm real Drive upload/read/delete, CORS, D1 behavior, rate limits, and cleanup/reconciliation are verified.
- [ ] Review all failures with the team and resolve or explicitly document remaining blockers.
- [ ] Keep the public frontend API base unset until the owner reviews the evidence and explicitly authorizes the next step.
- [ ] Obtain separate explicit owner approval before merging, deploying beyond the approved staging setup, or touching production.

**Current state:** checklist prepared; no Cloudflare resource, remote D1, Drive credential, deployment, or production data has been created or changed by this document.
