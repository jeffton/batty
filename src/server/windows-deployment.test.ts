// @vitest-environment node
import { readFile } from "node:fs/promises";
import { expect, test } from "vite-plus/test";

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
