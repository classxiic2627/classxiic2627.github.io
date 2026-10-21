# Community Hub Release Gates — Upload and Push

**Status: BLOCKED pending code review and owner-managed staging.** This checklist supplements `deployment-migration-readiness.md`; it does not authorize merge, deployment, D1 migration, or paid resources.

## Evidence snapshot — 2026-10-21

- Foundation PR #1 head `76ebcc57f2e9f81aeb6c4c809b77ce0749a695cf`: [Actions run 39586560585](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39586560585) passed both jobs and 84/84 Worker tests. Upload idempotency covers concurrent same-key requests and fail-closed recovery for ambiguous Drive results in mocked tests.
- Browser push PR #14 head `c27e399904788f7d9b4d575ea0ccdd4decbf2462`: [Actions run 39586181284](https://github.com/classxiic2627/classxiic2627.github.io/actions/runs/39586181284) passed both jobs and 92/92 tests. Provider fetch uses `redirect: "manual"`, with a regression assertion.
- These are CI/mock results only. No live Drive fault injection, near-limit upload memory measurement, or real browser/provider push delivery has been verified.

## Push delivery: remaining code-review gates

- [ ] **Bound announcement fan-out.** Current reviewed route loads every active subscription and maps all results into `Promise.allSettled`. Add a defined per-announcement cap or durable queue, bounded concurrency, and tests for the cap and partial failures. One announcement must not trigger unbounded crypto work or outbound requests.
- [ ] **Bound each provider request.** Current reviewed sender has no explicit request timeout/abort signal. Add a short, documented per-endpoint timeout; classify timeout as a failed attempt. Test with a fetch mock that never resolves.
- [ ] **Bound subscription abuse.** Establish an account-level registration rate/count guard so authenticated users cannot grow the fan-out without limit. Test the limit and its failure response.
- [ ] **Make outcome semantics explicit.** `sent` means the provider accepted the HTTP request, not that a device displayed a notification. Report partial failures and timeouts accurately; never imply all subscribers were reached if the configured cap excludes some.
- [ ] Re-run exact-head CI after the above changes and review the final combined head before merge. The current 92/92 run does not cover these missing resource controls or real provider delivery.

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
