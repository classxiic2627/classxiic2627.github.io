# Community Hub Release Gates — Upload and Push

**Status: BLOCKED pending code review and owner-managed staging.** This checklist supplements `deployment-migration-readiness.md`; it does not authorize merge, deployment, D1 migration, or paid resources.

## Evidence snapshot — 2026-10-21

- Foundation PR #1 head `f5f011d0c7b8cb15586b449689b0b551136ec56a`: [Actions run 39586853858](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39586853858) passed both jobs and 84/84 Worker tests. Upload idempotency covers concurrent same-key requests and fail-closed recovery for ambiguous Drive results in mocked tests.
- Browser push PR #14 head `75059fa36563c30883d79d9b0390d5ceecb7f366`: [Actions run 39595766564](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39595766564) passed both jobs and 98/98 tests. The current head includes redirect blocking, a 40-device announcement cap, eight-way bounded concurrency, five-second provider abort timeout, batched expired-endpoint cleanup, explicit partial-delivery accounting, and an atomic 10-device-per-account subscription cap.
- These are CI/mock results only. No live Drive fault injection, near-limit upload memory measurement, or real browser/provider push delivery has been verified.

## Push delivery: remaining acceptance gates

- [x] **Bound announcement fan-out.** Each announcement attempts at most 40 randomly selected active subscriptions, with at most eight concurrent sends. The admin response and UI report total, provider-accepted, failed, expired, skipped, and cleanup-failed outcomes; skipped recipients are never silently reported as delivered.
- [x] **Bound each provider request.** Web Push requests use a five-second `AbortSignal.timeout`, and redirects are disabled so an allowlisted endpoint cannot redirect the Worker to another host. A never-resolving fetch mock verifies timeout abort.
- [x] **Bound subscription abuse.** Each account can register up to 10 devices; an already-owned endpoint can be refreshed. The cap is enforced atomically in the insert statement and has a concurrent last-slot regression.
- [x] **Make outcome semantics explicit.** `sent` means the provider returned a successful HTTP status, not that a device displayed a notification. Partial delivery and skipped recipients are reported to the admin.
- [x] Exact-head CI passed on `75059fa36563c30883d79d9b0390d5ceecb7f366`: [run 39595766564](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39595766564), both jobs green and 98/98 tests. PR #14 still requires reviewer sign-off and merge-context review before integration.

## Upload cap policy mismatch — owner decision required

The latest recorded owner decision specifies **50 MiB per file plus 1 MiB multipart overhead**. However, foundation head `f1070c8c0e770465deef41686b5d583bc5864c8b` currently sets a **15 MiB** file cap across Worker/UI/tests as a conservative memory mitigation. Exact-head CI [39596850600](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39596850600) is green for that 15 MiB contract, but passing tests do not authorize changing the owner's product limit.

- [ ] Before merge, Commander Krishna must explicitly choose: restore the approved 50 MiB contract and retain a hard near-limit memory gate, or approve 15 MiB as a deliberate product change.
- [ ] After the decision, align Worker, browser validation, HTML copy, README, error responses, tests, and staging checklist to the same limit. Do not simply weaken boundary assertions.
- [ ] The current digest still uses `file.arrayBuffer()`; a 15 MiB cap reduces but does not prove peak-memory safety. Verify peak memory in the actual Worker runtime or implement reviewed bounded-memory hashing before claiming that gate is closed.

## Upload: remaining acceptance gates

- [ ] **Near-limit memory:** `digestFile(file)` uses `file.arrayBuffer()` plus WebCrypto digest, which materializes a full-file buffer for a 50 MiB upload. The multipart parser also holds the parsed File. Measure peak memory in an actual isolated Worker near the approved 50 MiB limit under the 128 MB isolate ceiling, or replace full-buffer hashing with a reviewed incremental SHA-256 implementation and known-vector/parity tests.
- [ ] **Real Drive ambiguity test:** In isolated staging, inject a lost final upload response after Drive accepts the file; prove the same-key retry links exactly one object, changed payload returns 409, and temporary listing inconsistency does not create a second upload.
- [ ] Exercise D1 outage/restart and compensating-delete failure paths against isolated staging. Preserve fail-closed reconciliation; an empty/unavailable search is not proof that the upload never committed.

## Owner-controlled staging and release gates

- [ ] Confirm Cloudflare and Google Drive resources are genuinely no-cost/free-tier before creating or changing anything. Stop and ask if a charge is possible.
- [ ] Use a brand-new empty staging D1 and a dedicated staging Drive folder. Configure secrets only through owner-managed secret storage; never place them in Git, browser code, chat, or GitHub comments.
- [ ] Run the guarded staging smoke, then separately verify real Drive upload/read/delete and push delivery with a test browser/subscription.
- [ ] Keep the public site's `community-api-base` blank until staging evidence is reviewed and the owner explicitly approves connecting it.
- [ ] No production deployment, production migration/data changes, or merge without separate explicit owner approval.

A passing unit test suite is necessary but does not close provider, infrastructure, memory, or operational acceptance gates.
