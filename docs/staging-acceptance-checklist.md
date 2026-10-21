# Community Hub staging acceptance checklist

This checklist is for the first isolated, no-cost staging run of the existing Community Hub Worker. It does not authorize production changes, merging, deployment, or any resource that might incur a charge.

## Entry gates

- [ ] Confirm the Cloudflare account and every proposed resource are eligible for a no-cost/free tier. Stop and ask the owner if cost is uncertain.
- [ ] Create only the owner-approved brand-new, empty staging D1 after the cost check; record its name/ID and environment.
- [ ] Apply the initial migration only to that empty staging D1. Verify tables, indexes, and migration history.
- [ ] Configure a dedicated Google Drive test folder/account and approved OAuth credentials privately; never put secrets in Git, HTML, logs, or issue comments.
- [ ] Set the exact approved staging site origin in `ALLOWED_ORIGIN`; do not guess the Worker URL or point the public site at localhost.
- [ ] Confirm the frontend is still disconnected from any Worker until staging acceptance is complete.

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
- [ ] Document and exercise a safe orphan-reconciliation procedure scoped only to the dedicated test folder. Compare Drive file IDs with staging D1 metadata; never delete files outside the test folder or based on guesses.
- [ ] Test interrupted resumable uploads, retry behavior, duplicate submissions, and cleanup after partial failure. Confirm retries do not silently publish duplicate media.
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
