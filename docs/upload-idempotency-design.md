# Media upload idempotency: implementation contract

**Status: implementation added to the feature branch; CI and staging verification remain required. This is not launch approval.**

The feature branch now reserves each upload in D1 using a user-scoped hash of the client retry key and a fingerprint of the normalized form plus SHA-256 of the file bytes. The stable content UUID is written to Drive `appProperties`; ambiguous retries search only the configured folder and fail closed when no unique matching file is found. The UI retains the key after failure and clears it after success. A deterministic lost-final-response regression test has been added; this branch must still pass CI and the real isolated-staging fault injection before the gate can close.

## Required design

1. The browser creates one cryptographically random idempotency key for a specific upload attempt and reuses that same key for retries of the same file/form. A changed file or changed submission must get a new key. Do not store file contents or credentials in browser storage.
2. The Worker validates the key's format and length and scopes it to the authenticated user. D1 must have a unique constraint on `(user_id, idempotency_key_hash)`; store a hash of the key, not the raw key.
3. Implemented in this branch: reserve the operation in D1 before calling Drive. Persist a stable content UUID, a server-computed request fingerprint (including file-byte SHA-256), and a state (`processing`, `retryable`, or `completed`). Same key + different fingerprint returns 409; completed retries return the original content ID.
4. Implemented in this branch: attach the stable content UUID to Drive `appProperties` during resumable-upload initiation. The adapter lookup scopes results to the configured folder and validates parent, MIME type, size, and app property before linking them.
5. Implemented in this branch: a unique D1 reservation elects one upload owner. An in-progress or ambiguous reservation is reconciled and never blindly re-uploaded; a confirmed cleanup returns the reservation to `retryable`. Keep concurrency and real-provider behavior in the acceptance gate.
6. Make reconciliation observable but sanitized. Do not log OAuth tokens, request bodies, raw idempotency keys, provider response bodies, or user content. Keep the Drive file ID only in structured restricted operational logs where necessary.

## Required tests before the gate can be closed

- Same key + same request, repeated after a successful commit returns the same content ID and results in exactly one Drive file.
- Same key submitted concurrently does not create two Drive files.
- Same key + different user is isolated; one user's key cannot reveal or reuse another user's upload.
- Same key + changed payload returns 409 without a second Drive write.
- Added deterministic regression test: simulate Drive committing a file while the final PUT response is lost; retry reconciles the existing Drive file and creates no duplicate. This test still needs a green CI run.
- Simulate a worker restart between Drive commit and D1 metadata commit; reconciliation still succeeds.
- Simulate Drive lookup timeout, eventual-consistency delay, malformed app properties, wrong parent folder, and D1 outage; fail closed and leave a visible reconciliation state rather than creating another file or deleting an unverified file.
- Existing successful upload, MIME/signature validation, 50 MiB file limit, request-size limit, authorization, admin-only removal, and orphan cleanup regressions remain green.
- Run the real lost-response fault injection only in the isolated no-cost staging environment, using an empty staging D1 and a dedicated test Drive folder. Never use production media for these tests.

## Exit criteria

This gate stays open until the implementation and all deterministic mocked tests pass, then the lost-response test passes against real staging Drive. A design note or green CI run alone does not close it; the real isolated-staging fault injection is still required. Do not merge or deploy production without separate owner approval.
