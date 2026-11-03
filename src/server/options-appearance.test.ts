import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vite-plus/test";
import { loadAppOptions, optionsFilePath } from "./options";

it("migrates the removed experimental Neon preference to Neutral without changing other options", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "batty-appearance-migration-"));
  try {
    const original = {
      ...(await loadAppOptions(directory)),
      workspacesRoots: ["/projects"],
      pushTitle: "Fixture notifications",
      webPushSubject: "mailto:fixture@example.com",
      braveSearchKey: "fixture-key",
      browserTailscaleSshDestination: "fixture-host",
      browserMaxTabs: 9,
      pinnedWorkspaceIds: ["fixture"],
      assistantWorkspaceId: "fixture",
      defaultProvider: "faux",
      defaultModel: "fixture-model",
      memoryModel: "faux/memory",
      memoryLanguage: "Danish",
      defaultThinkingLevel: "high" as const,
      baseUrl: "/batty",
      appTitle: "Fixture title",
    };
    await fs.writeFile(
      optionsFilePath(directory),
      JSON.stringify({ ...original, appColor: "neon" }),
    );
    const migrated = await loadAppOptions(directory);
    expect(migrated).toEqual({ ...original, appColor: "neutral" });
    expect(JSON.parse(await fs.readFile(optionsFilePath(directory), "utf8"))).toEqual(migrated);
    expect(await loadAppOptions(directory)).toEqual(migrated);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it("continues rejecting unknown appearance colors rather than hiding configuration errors", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "batty-appearance-invalid-"));
  try {
    const original = await loadAppOptions(directory);
    await fs.writeFile(
      optionsFilePath(directory),
      JSON.stringify({ ...original, appColor: "unknown" }),
    );
    await expect(loadAppOptions(directory)).rejects.toThrow("Invalid appColor");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
