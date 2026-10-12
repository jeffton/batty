// @vitest-environment node
import { readFile } from "node:fs/promises";
import { expect, test } from "vite-plus/test";

test("Deployment builds releases and leaves source validation to pre-push", async () => {
  const windows = await readFile("scripts/deploy-windows.ps1", "utf8");
  const linux = await readFile("scripts/deploy.sh", "utf8");
  expect(windows).not.toMatch(/Invoke-Native pnpm @\('test'/);
  expect(linux).not.toMatch(/^\s*(?:pnpm test|bash scripts\/deploy\.test\.sh)/m);
  expect(windows).not.toContain("@('check')");
  expect(windows).toContain("@('build')");
  expect(windows).not.toContain("scripts/verify-offline.mjs");
  expect(windows).toContain(
    "@('install', '--prod', '--frozen-lockfile', '--config.package-import-method=hardlink')",
  );
  expect(linux).not.toContain("pnpm check");
  expect(linux).toContain("pnpm build");
  expect(linux).not.toContain("node scripts/verify-offline.mjs");
});

test("Windows update and rollback reload IIS configuration after switching releases", async () => {
  const script = await readFile("scripts/deploy-windows.ps1", "utf8");
  expect(script).toContain("[string]$AppPoolName = 'BattyProxy'");
  expect(script).not.toMatch(
    /MigrateBatty1|PreviousDataRoot|import-roy|import-batty1|Sync-Batty1State/,
  );
  expect(script).not.toMatch(/\$service\.Save|Copy-Tree \$.*DataRoot|cron.*update/);
  expect(script).toContain("@('main', 'cron-cli', 'stop-service')");
  expect(script).toMatch(
    /Set-Current \$ReleasePath\s*#.*\s*Restart-WebAppPool -Name \$AppPoolName\s*Start-Service \$ServiceName/,
  );
  expect(script).toMatch(
    /Set-Current \$previousRelease\s*Restart-WebAppPool -Name \$AppPoolName\s*Start-Service \$ServiceName/,
  );
});
