# Development and deployment

Pull changes before starting work. Preserve concurrent changes.

During development, run tests relevant to the change (`pnpm test:unit` for non-browser groups, or pass file paths to `pnpm test`). Integrate concurrent work and address independent review findings before the final gate.

Run the complete parallel gate once on the finished integrated source:

```sh
pnpm check
pnpm test
bash scripts/deploy.test.sh
bash scripts/deploy-privileges.test.sh
pnpm build
node scripts/verify-startup.mjs
node scripts/verify-offline.mjs
```

Record the source revision, commands, results and wall time. Reuse that validation for the same source at commit/push/deploy; do not rerun it as a confirmation ritual. After a test failure, diagnose the failing file or case rather than rerunning the whole suite serially. After fixing source or test behavior, run the final parallel gate on the integrated result. Documentation-only follow-ups need formatting/link checks, not another full suite. Do not add retries or skips to obtain a green run.

Run Linux deployment regression checks on Linux. Browser integration uses Chromium only; mobile viewport/touch coverage is retained without a second engine matrix. See `docs/operations.md`.

Installations deploy validated commits. Deployment installs locked dependencies, builds and verifies service health and the expected build ID; do not rerun source checks, test suites or fixture-based offline tests there. The offline browser gate belongs before push.

Native cloud-browser viewing (H.264 capture/streaming) is intentionally Linux-only. macOS and Windows deployments must not add support, port it, or introduce a fallback unless the user explicitly requests that work. This restriction does not apply to ordinary headless browser tools, which remain cross-platform.

# Browser dependency maintenance

Check current stable Patchright and Playwright releases together on every dependency review. Select Playwright Core using Patchright's upstream Playwright release and verify their installed `browsers.json` revisions agree; package version numbers need not match. Missing release notes or a GitHub release page alone do not justify a hold: inspect upstream commits/PRs, registry publication provenance and published package diffs, and document the actual changes and compatibility. Keep release-age and explicit migration holds. Dated reviews in `docs/dependencies.md` record past decisions, not ongoing holds. Reassess any hold against current releases rather than carrying it forward.

Production uses standalone installed Google Chrome Stable with the Patchright driver on Linux, macOS and Windows. Include Chrome in every dependency review: read official Stable/security release notes, compare installed and running versions, update through the system package manager/Google Updater, and verify browser compatibility. Security fixes do not wait for npm release-age holds. Linux Chrome is updated by the existing distro-specific nightly workflow; do not add a second updater. After a Chrome package change, restart all Batty browser processes with the documented offline maintenance flow, retaining profiles; a service restart alone leaves detached browsers running.

Install the selected test-only Chromium revision before the full test suite; on Linux run `sudo -n bash scripts/setup-browser-isolation.sh --test` for pinned Chromium and `sudo -n bash scripts/setup-browser-isolation.sh` for system Chrome. Deployment installs missing Chrome Stable and prepares its isolation. Verify the selected executable/version after deploy; never relabel bundled cache revisions. Overrides cover persistent tools and shared headless work, not direct-launch test fixtures. macOS/Windows desktop extensions may use the same Chrome installation but not Batty's separate CDP profile.

See [operations](docs/operations.md) for deployment commands and platform-specific verification.
