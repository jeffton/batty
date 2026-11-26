import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { runCronCli } from "./cron-cli";
import { maintenanceDir, readMaintenance } from "./maintenance-state";

test.runIf(process.platform === "linux")(
  "maintenance fences the public gateway, guards exit and preserves the actual model",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-maintenance-cli-"));
    const run = (...args: string[]) => runCronCli(["--root", root, "maintenance", ...args]);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    let gated = false;
    let healthy = false;
    const model = { provider: "faux", modelId: "selected-main", thinkingLevel: "high" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "https://batty.fixture.test/api/maintenance/status")
          return Response.json({ active: false });
        if (url === "https://batty.fixture.test/api/bootstrap")
          return new Response(
            null,
            gated ? { status: 503, headers: { "X-Batty-Maintenance": "1" } } : {},
          );
        if (url.endsWith("/api/maintenance-model")) {
          expect(init?.headers).toEqual({ cookie: expect.stringMatching(/^batty2-auth=/) });
          return Response.json(model);
        }
        if (url.endsWith("/healthz"))
          return Response.json({ ok: healthy }, { status: healthy ? 200 : 503 });
        throw new Error(`Unexpected URL ${url}`);
      }),
    );
    try {
      await fs.mkdir(path.join(root, ".batty"));
      await fs.mkdir(maintenanceDir(root));
      await fs.writeFile(
        path.join(root, ".batty/options.json"),
        JSON.stringify({
          authSecret: "fixture-secret",
          defaultModel: "different-default",
          workspacesRoots: [root],
          webPushSubject: "mailto:test@example.invalid",
        }),
      );
      const enter = () =>
        run("enter", "--url", "https://batty.fixture.test", "--message", "Starting");
      await expect(enter()).rejects.toThrow("gateway is not routing");
      expect(await readMaintenance(root)).toBeUndefined();
      gated = true;
      await enter();
      const state = (await readMaintenance(root))!;
      expect(state).toMatchObject({ phase: "offline", model, progress: null });
      await run("update", "--progress", "41.5");
      expect(await readMaintenance(root)).toMatchObject({
        id: state.id,
        phase: "offline",
        progress: 41.5,
      });
      await expect(run("exit")).rejects.toThrow("allow-start");
      await run("allow-start", "--message", "Booting", "--progress", "indeterminate");
      await expect(run("exit")).rejects.toThrow("/healthz returned HTTP 503");
      expect(await readMaintenance(root)).toMatchObject({ phase: "starting", progress: null });
      await run("hold");
      expect(await readMaintenance(root)).toMatchObject({ phase: "offline" });
      await run("allow-start");
      healthy = true;
      await run("exit");
      expect(await readMaintenance(root)).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
      output.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
