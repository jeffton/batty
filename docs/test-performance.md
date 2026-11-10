# Test performance

Measured on the maintained eight-vCPU VPS, 10 November 2026. Commands run sequentially; no concurrent test jobs.

## Results

- Previous complete suite: 133–150 seconds with four workers; 436–505 seconds serially.
- Streamlined complete suite: **84.53 seconds**, 219 files, **1,096 passing tests**, two existing platform skips. Time includes the Node runner and CLI startup.
- Intermediate cleanup runs: six workers 102.23 seconds; eight workers 96.07 seconds; twelve workers 93.09 seconds. Twelve triggered integration timeouts and browser failures for little gain.
- Final source at twelve workers: **85.03 seconds**, with a durable shell/reopen test failure. Eight workers passed in **84.53 seconds** on the same test source, so twelve offers no speed advantage and is less reliable. Eight is the default; remote fixtures have concurrency two within their worker.
- The one-minute target is not met. The suite retains durable recovery, auth/peer boundaries, binary streams, cancellation, browser persistence, PWA privacy/offline recovery and native video/input coverage.

## Removed redundancy

The suite has 33 fewer test executions. Chromium replaces the WebKit matrix and its container runner. Mobile viewport/touch coverage remains. Browser-only emoji, artifact-display and warning-layout suites are removed. Shared-site sandbox/function-call and stale-document protection remain in one nested-prefix browser case. Long native-browser walkthroughs, repeated desktop/mobile credential geometry, a real-time suspended-renderer wait and repeated clipboard viewports are reduced; credential privacy, native touch/DPR and real clipboard assertions remain.

The cron discovery case checks representative caller depths against target scopes instead of 100 worker-pair inspections through model/durable history. Independent remote fixtures overlap without running global-fetch-spy cases concurrently.

## Fixture reliability

- Service-worker fetch completion does not imply its background cache writes completed; assertions await the cache state.
- SSH child startup publishes an atomic receipt; the fixture observes that rename rather than polling with a one-second deadline.
- Credential geometry was sampled across an asynchronous viewport/revision remount, yielding a null bounding box. The functional credential test uses a stable mobile viewport and retains fill, step changes, no-submit/no-secret-control assertions and newsletter dismissal. The original WebKit dismissal failure was intermittent; no production defect was established.
- Linux test commands share `/var/tmp` for browser profile moves. Generated `.tmp` scratch files are outside source formatting/lint checks.

## Validation workflow

Use focused tests while implementing. Review and integrate changes before one complete parallel gate on the final source. Record revision, commands, results and wall time; reuse that result through commit/push/deploy. Diagnose failures with their file/case, not repeated serial full-suite runs. Behavior fixes require a final integrated gate; documentation-only edits require formatting/link checks. No retries or new skips are used.
