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

See [operations](docs/operations.md) for deployment commands and platform-specific verification.
