# Community Hub Release Gates — Upload and Push

**Status: BLOCKED pending code review and owner-managed staging.** This checklist supplements `deployment-migration-readiness.md`; it does not authorize merge, deployment, D1 migration, or paid resources.

## Evidence snapshot — 2026-10-21

- Foundation PR #1 head `473dab023918bc94ab006fe26b5f4d7ab99cacc0`: [Actions run 39598223344](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39598223344) passed both jobs and 86/86 Worker tests. Upload idempotency covers concurrent same-key requests and fail-closed recovery for ambiguous Drive results in mocked tests. The owner-approved 50 MiB file + 1 MiB multipart cap is restored; payload fingerprinting now processes 1 MiB slices and hashes their digests instead of materializing a full-file ArrayBuffer.
- Browser push PR #14 head `75059fa36563c30883d79d9b0390d5ceecb7f366`: [Actions run 39595766564](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39595766564) passed both jobs and 98/98 tests. The current head includes redirect blocking, a 40-device announcement cap, eight-way bounded concurrency, five-second provider abort timeout, batched expired-endpoint cleanup, explicit partial-delivery accounting, and an atomic 10-device-per-account subscription cap.
- These are CI/mock results only. No live Drive fault injection, near-limit upload memory measurement, or real browser/provider push delivery has been verified.

## Push delivery: remaining acceptance gates

- [x] **Bound announcement fan-out.** Each announcement attempts at most 40 randomly selected active subscriptions, with at most eight concurrent sends. The admin response and UI report total, provider-accepted, failed, expired, skipped, and cleanup-failed outcomes; skipped recipients are never silently reported as delivered.
- [x] **Bound each provider request.** Web Push requests use a five-second `AbortSignal.timeout`, and redirects are disabled so an allowlisted endpoint cannot redirect the Worker to another host. A never-resolving fetch mock verifies timeout abort.
- [x] **Bound subscription abuse.** Each account can register up to 10 devices; an already-owned endpoint can be refreshed. The cap is enforced atomically in the insert statement and has a concurrent last-slot regression.
- [x] **Make outcome semantics explicit.** `sent` means the provider returned a successful HTTP status, not that a device displayed a notification. Partial delivery and skipped recipients are reported to the admin.
- [x] Exact-head CI passed on `75059fa36563c30883d79d9b0390d5ceecb7f366`: [run 39595766564](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39595766564), both jobs green and 98/98 tests. PR #14 still requires reviewer sign-off and merge-context review before integration.

## Upload cap policy — owner decision applied

The recorded owner decision is **50 MiB per file plus 1 MiB multipart overhead**, and the current foundation code, browser validation, HTML copy, README, error responses, and boundary tests now consistently enforce that limit. The brief 15 MiB experiment was reverted; no owner policy change is pending.

The new `backend/upload-fingerprint.js` hashes fixed 1 MiB slices and then hashes a versioned header plus the chunk digests. This is a bounded-chunk fingerprint construction, not the standard SHA-256 digest of the entire file. Current tests cover bounded chunk size, repeatability, and changed-byte sensitivity; review still requests a pinned known vector plus empty-file and malformed-slice tests.

- [ ] **Near-limit memory remains open.** Chunked fingerprinting removes the extra full-file hash buffer, but multipart parsing still materializes the file. Measure peak memory in an actual isolated Worker near the approved 50 MiB limit under the 128 MB isolate ceiling before calling that limit safe.
- [ ] Do not change the 50 MiB product cap again without explicit owner approval. If staging measurements show it is unsafe, pause and present the measured evidence/options to the owner instead of silently lowering the limit.

## Upload: remaining acceptance gates

- [ ] **Near-limit memory:** the extra whole-file hashing buffer has been removed: `fingerprintFile(file)` processes 1 MiB slices and hashes their digests. The multipart parser still materializes the parsed File, and this custom versioned chunk-digest construction is not the standard SHA-256(file). Measure peak memory in an actual isolated Worker near the approved 50 MiB limit under the 128 MB isolate ceiling. Add a pinned known-vector test plus empty-file and malformed-slice tests before considering the fingerprint implementation fully reviewed.
- [ ] **Real Drive ambiguity test:** In isolated staging, inject a lost final upload response after Drive accepts the file; prove the same-key retry links exactly one object, changed payload returns 409, and temporary listing inconsistency does not create a second upload.
- [ ] Exercise D1 outage/restart and compensating-delete failure paths against isolated staging. Preserve fail-closed reconciliation; an empty/unavailable search is not proof that the upload never committed.

## Owner-controlled staging and release gates

- [ ] Confirm Cloudflare and Google Drive resources are genuinely no-cost/free-tier before creating or changing anything. Stop and ask if a charge is possible.
- [ ] Use a brand-new empty staging D1 and a dedicated staging Drive folder. Configure secrets only through owner-managed secret storage; never place them in Git, browser code, chat, or GitHub comments.
- [ ] Run the guarded staging smoke, then separately verify real Drive upload/read/delete and push delivery with a test browser/subscription.
- [ ] Keep the public site's `community-api-base` blank until staging evidence is reviewed and the owner explicitly approves connecting it.
- [ ] No production deployment, production migration/data changes, or merge without separate explicit owner approval.

A passing unit test suite is necessary but does not close provider, infrastructure, memory, or operational acceptance gates.
