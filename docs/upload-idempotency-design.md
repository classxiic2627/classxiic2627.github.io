# Media upload idempotency: implementation contract

**Status: design contract only — not implemented, not a launch approval.**

The current upload flow creates a new content UUID inside the Worker for each request, uploads to Drive, and then inserts metadata into D1. If Drive commits the file but the Worker loses the final response before receiving the Drive file ID, the Worker cannot delete the file or link it to D1. Retrying the same browser submission creates a second upload. The current orphan-cleanup test covers a *known Drive file ID followed by D1 failure*; it does not cover this lost-response window.

## Required design

1. The browser creates one cryptographically random idempotency key for a specific upload attempt and reuses that same key for retries of the same file/form. A changed file or changed submission must get a new key. Do not store file contents or credentials in browser storage.
2. The Worker validates the key's format and length and scopes it to the authenticated user. D1 must have a unique constraint on `(user_id, idempotency_key_hash)`; store a hash of the key, not the raw key.
3. Reserve the operation in D1 *before* calling Drive. Persist a stable content UUID, a request fingerprint (file size, normalized MIME/type, title/caption and a client-provided file digest if computed safely), and a state such as `reserved`, `uploaded`, `committed`, or `reconciliation_required`. Same key + different fingerprint must return 409; same key + committed operation must return the original content ID without uploading again.
4. Attach the stable content UUID to the Drive file's private `appProperties` (for example `communityContentId`) during resumable-upload initiation. Add a Drive adapter lookup that searches only within the configured dedicated folder for that exact app property. On an ambiguous upload outcome, reconcile by this stable property before attempting another create. Validate the returned file's parent, MIME type, size, and app property before linking it.
5. Use D1 conditional updates so concurrent requests with the same key cannot both start an upload. If the state is already in progress or ambiguous, return a retryable response and reconcile rather than blindly creating another Drive file. Never delete a candidate unless its folder, stable ID, and metadata have been verified.
6. Make reconciliation observable but sanitized. Do not log OAuth tokens, request bodies, raw idempotency keys, provider response bodies, or user content. Keep the Drive file ID only in structured restricted operational logs where necessary.

## Required tests before the gate can be closed

- Same key + same request, repeated after a successful commit returns the same content ID and results in exactly one Drive file.
- Same key submitted concurrently does not create two Drive files.
- Same key + different user is isolated; one user's key cannot reveal or reuse another user's upload.
- Same key + changed payload returns 409 without a second Drive write.
- Simulate Drive committing a file while the final PUT response is lost; retry reconciles the existing Drive file and creates no duplicate.
- Simulate a worker restart between Drive commit and D1 metadata commit; reconciliation still succeeds.
- Simulate Drive lookup timeout, eventual-consistency delay, malformed app properties, wrong parent folder, and D1 outage; fail closed and leave a visible reconciliation state rather than creating another file or deleting an unverified file.
- Existing successful upload, MIME/signature validation, 50 MiB file limit, request-size limit, authorization, admin-only removal, and orphan cleanup regressions remain green.
- Run the real lost-response fault injection only in the isolated no-cost staging environment, using an empty staging D1 and a dedicated test Drive folder. Never use production media for these tests.

## Exit criteria

This gate stays open until the implementation and all deterministic mocked tests pass, then the lost-response test passes against real staging Drive. A design note, local D1 smoke test, or green CI run alone does not close it. Do not merge or deploy production without separate owner approval.
