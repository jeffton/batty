# Assistant responses

Avoid ritual defensive hedging and irrelevant caveats. Investigate uncertainty when it could materially change the answer, decision, or action; otherwise omit it. State supported conclusions directly and stand by them. Mention uncertainty only when it is concrete and material—never imply certainty beyond the evidence.

# Development and deployment

Pull changes before starting work. Preserve concurrent changes.

Before pushing, validate the source:

```sh
pnpm check
pnpm test:all
bash scripts/deploy.test.sh
pnpm build
node scripts/verify-offline.mjs
```

Run Linux deployment regression checks on Linux. Get an independent review and address findings before pushing. During development, `pnpm test` runs the non-browser groups; it does not replace the full pre-push gate.

Installations deploy validated commits. Deployment installs locked dependencies, builds and verifies service health and the expected build ID; do not rerun source checks, test suites or fixture-based offline tests there. The offline browser gate belongs before push.

See [operations](docs/operations.md) for deployment commands and platform-specific verification.
