# Development and deployment

Pull changes before starting work. Preserve concurrent changes.

Before pushing, validate the source:

```sh
pnpm check
pnpm test:all
bash scripts/deploy.test.sh
pnpm build
node scripts/verify-startup.mjs
node scripts/verify-offline.mjs
```

Run Linux deployment regression checks on Linux. Get an independent review and address findings before pushing. During development, `pnpm test` runs the non-browser groups; it does not replace the full pre-push gate.

Installations deploy validated commits. Deployment installs locked dependencies, builds and verifies service health and the expected build ID; do not rerun source checks, test suites or fixture-based offline tests there. The offline browser gate belongs before push.

Native cloud-browser viewing (H.264 capture/streaming) is intentionally Linux-only. macOS and Windows deployments must not add support, port it, or introduce a fallback unless the user explicitly requests that work. This restriction does not apply to ordinary headless browser tools, which remain cross-platform.

# Browser dependency maintenance

Check current stable Patchright and Playwright releases together on every dependency review. Select Playwright Core using Patchright's upstream Playwright release and verify their installed `browsers.json` revisions agree; package version numbers need not match. Dated reviews in `docs/dependencies.md` record past decisions, not ongoing holds. Reassess any hold against current releases rather than carrying it forward.

Install the selected Chromium and test-only WebKit revisions before the full test suite; on Linux, run `bash scripts/setup-browser-isolation.sh` to prepare Chromium for the unprivileged test browser. Linux deployment installs and isolates Patchright's pinned Chromium unless `/etc/batty2/browser.env` explicitly selects a security-patched full Chrome. Verify the selected executable/version after deploy; never relabel bundled cache revisions. Explicit browser selections cover both persistent tools and shared headless work, not direct-launch test fixtures.

See [operations](docs/operations.md) for deployment commands and platform-specific verification.
