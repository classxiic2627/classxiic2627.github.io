# Media upload idempotency: implementation contract

**Status: implementation added to the feature branch; CI and staging verification remain required. This is not launch approval.**

The feature branch reserves each upload in D1 using a user-scoped hash of the client retry key and a fingerprint of the normalized form plus SHA-256 of the actual binary file bytes. The stable content UUID is written to Drive `appProperties`; ambiguous retries search only the configured folder and fail closed when no unique matching file is found. The UI retains the key after failure and clears it after success. The byte-hash buffer is scoped to a helper so it is not retained throughout the Drive upload, but hashing still materializes the full file in memory; near-50 MiB peak memory must be verified in isolated staging. Exact-head run [39576803930](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39576803930) passed 82/82 tests on code commit `5728b76a3b75d63b474bb2c597ccc33868b9f19b`; a subsequent schema-state change and this documentation refresh are awaiting their own exact-head CI confirmation. Real isolated-staging fault injection remains required.

## Required design

1. The browser creates one cryptographically random idempotency key for a specific upload attempt and reuses that same key for retries of the same file/form. A changed file or changed submission must get a new key. Do not store file contents or credentials in browser storage.
2. The Worker validates the key's format and length and scopes it to the authenticated user. D1 must have a unique constraint on `(user_id, idempotency_key_hash)`; store a hash of the key, not the raw key.
3. Implemented in this branch: reserve the operation in D1 before calling Drive. Persist a stable content UUID, a server-computed request fingerprint (including file-byte SHA-256), and a state (`processing`, `reconciliation_required`, `retryable`, or `completed`). Same key + different fingerprint returns 409; completed retries return the original content ID.
4. Implemented in this branch: attach the stable content UUID to Drive `appProperties` during resumable-upload initiation. The adapter lookup scopes results to the configured folder and validates parent, MIME type, size, and app property before linking them.
5. Implemented in this branch: a unique D1 reservation elects one upload owner. An active `processing` reservation is never reconciled by a concurrent request. When an upload transport outcome is ambiguous, the completed request transitions it to `reconciliation_required`; one later retry must atomically claim that state before searching Drive. A confirmed cleanup returns the reservation to `retryable`. If D1 content insertion fails and Drive cleanup also fails, the Worker records the Drive file ID and transitions to `reconciliation_required`, allowing a same-key retry to link the existing file rather than blindly uploading again. Keep concurrency and real-provider behavior in the acceptance gate.
6. Make reconciliation observable but sanitized. Do not log OAuth tokens, request bodies, raw idempotency keys, provider response bodies, or user content. Keep the Drive file ID only in structured restricted operational logs where necessary.


## Stale reservation operator runbook

A Drive upload request can fail after the provider accepted bytes but before the Worker received the final response. The Worker transitions the completed request to `reconciliation_required`; while a reservation is still `processing`, same-key requests return 503 without searching Drive. If a D1 content insert fails and the compensating Drive delete also fails, it records the file ID and moves the reservation to `reconciliation_required` for a later safe retry. It must not automatically upload again based only on an empty Drive search result. The Worker marks an ambiguous Drive result as `reconciliation_required` and only one retry may claim that state for reconciliation. There is currently no automated stale-reservation reset. If the D1 state update itself fails, the row can remain `processing` and requires manual investigation. Use this runbook only against the isolated staging database and dedicated staging Drive folder until it has been exercised and reviewed.

1. **Inventory, read-only first.** Choose a stale-age threshold based on the configured Worker request/runtime limits and observed Drive resumable-session behavior; do not guess a threshold or apply it to production. Query only reservations older than that threshold and include any content row:

   ```sql
   SELECT r.user_id, r.key_hash, r.item_id, r.state, r.drive_file_id,
          r.created_at, r.updated_at,
          c.media_key, c.media_mime, c.media_size
   FROM upload_reservations AS r
   LEFT JOIN content AS c
     ON c.id = r.item_id AND c.user_id = r.user_id
   WHERE r.state IN ('processing', 'reconciliation_required') AND r.updated_at < ?
   ORDER BY r.updated_at;
   ```

   Bind the selected ISO-8601 UTC cutoff as the parameter. Never log or request the raw browser idempotency key, OAuth tokens, upload body, or user content.

2. **If the content row exists**, do not upload or delete anything. Verify the row's `media_key` identifies exactly one Drive file in the configured staging folder and that its `appProperties.archiveUploadId` equals `item_id`; confirm MIME type and size agree with the content metadata. If those checks pass, and the reservation is confirmed stale with no active request able to finish, repair only the reservation state and file ID in one conditional update scoped by `user_id`, `key_hash`, and the exact state observed during inventory (`processing` or `reconciliation_required`). Never take over a fresh active `processing` reservation. If any check fails, leave the reservation unchanged and escalate.

3. **If no content row exists but Drive returns exactly one matching file**, do not manually create content metadata or reset the reservation. Ask the uploader to retry the same form, same file, and same idempotency key. The Worker must validate the current request fingerprint and the Drive app property/folder/MIME/size before linking it. Confirm the retry returns the existing `item_id` and a second Drive file was not created.

4. **If Drive returns multiple matches, a lookup error, or no match**, return the claimed reservation to `reconciliation_required` with a conditional state update; if that transition fails, it may remain `processing` and requires manual investigation. A failed/empty Drive search is not proof that the upload never committed: listing may be eventually consistent and an upload session may still be in flight. Recheck after the provider's documented consistency/session window and inspect the dedicated folder's audit evidence. Never delete a candidate or reset to `retryable` without authoritative evidence that no matching committed file exists and that the original session cannot still commit. If that evidence is unavailable, keep the row for manual reconciliation rather than risking a duplicate or deleting user media.

5. **After any repair**, verify the reservation is `completed`, the content row points to the same verified Drive ID, a same-payload retry returns the same `item_id`, and a changed-payload retry returns 409. Record only the reservation `item_id`, timestamps, verified outcome, and operator/action reference in the incident note.

This procedure is manual and staging-only. The implementation still needs tests for stale reservation visibility, D1 outages, lookup delays/timeouts, worker restart, and a real lost-response fault injection in approved no-cost staging. Do not merge or deploy production without separate owner approval.

## Required tests before the gate can be closed

- Same key + same request, repeated after a successful commit returns the same content ID and results in exactly one Drive file.
- Same key submitted concurrently does not create two Drive files.
- Same key + different user is isolated; one user's key cannot reveal or reuse another user's upload.
- Same key + changed payload returns 409 without a second Drive write.
- Added deterministic regression test: simulate Drive committing a file while the final PUT response is lost; retry reconciles the existing Drive file and creates no duplicate. Exact-head CI run [39576803930](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39576803930) passes all 82 Worker tests, including a binary-distinct payload rejection case.
- Simulate a worker restart between Drive commit and D1 metadata commit; reconciliation still succeeds.
- Simulate Drive lookup timeout, eventual-consistency delay, malformed app properties, wrong parent folder, and D1 outage; fail closed and leave a visible reconciliation state rather than creating another file or deleting an unverified file.
- Existing successful upload, MIME/signature validation, 50 MiB file limit, request-size limit, authorization, admin-only removal, and orphan cleanup regressions remain green.
- Run the real lost-response fault injection only in the isolated no-cost staging environment, using an empty staging D1 and a dedicated test Drive folder. Never use production media for these tests.

## Exit criteria

This gate stays open until the implementation and all deterministic mocked tests pass, then the lost-response test passes against real staging Drive. A design note or green CI run alone does not close it; the real isolated-staging fault injection is still required. Do not merge or deploy production without separate owner approval.
