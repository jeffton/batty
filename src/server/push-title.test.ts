import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vite-plus/test";
import { loadConfig } from "./config";
import { loadAppOptions, setPushTitle, stateDirPath } from "./options";

it("persists a global push title without changing other settings", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "batty-push-title-"));
  try {
    await fs.mkdir(stateDirPath(directory), { recursive: true });
    await fs.writeFile(
      path.join(stateDirPath(directory), "options.json"),
      JSON.stringify({
        workspacesRoots: [directory],
        webPushSubject: "mailto:test@example.com",
        memoryModel: "faux/memory",
        appTitle: "App title",
      }),
    );
    expect((await loadAppOptions(directory)).pushTitle).toBe("Batty");
    await setPushTitle(directory, "Custom title");
    const config = await loadConfig(directory);
    expect(config.pushTitle).toBe("Custom title");
    expect(config.appTitle).toBe("App title");
    expect(config.memoryModel).toBe("faux/memory");
    const stored = JSON.parse(
      await fs.readFile(path.join(stateDirPath(directory), "options.json"), "utf8"),
    );
    expect(stored.pushTitle).toBe("Custom title");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
