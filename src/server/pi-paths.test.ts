import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  battyResourcePaths,
  battySessionRootDir,
  loadBattyPromptFile,
  loadBattySettings,
  workspaceSessionDir,
} from "@/server/pi-paths";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createLayout() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-pi-paths-"));
  tempDirs.push(root);
  const workspace = path.join(root, "workspace");
  await fs.mkdir(path.join(root, ".batty"), { recursive: true });
  await fs.mkdir(path.join(workspace, ".batty"), { recursive: true });
  return { root, workspace };
}

describe("pi-paths", () => {
  it("loads and merges settings from <batty-root>/.batty and <workspace>/.batty", async () => {
    const { root, workspace } = await createLayout();
    await fs.writeFile(
      path.join(root, ".batty", "settings.json"),
      JSON.stringify(
        {
          theme: "dark",
          extensions: ["./extensions"],
          skills: ["./global-skills"],
          compaction: { enabled: true, reserveTokens: 16384 },
        },
        null,
        2,
      ),
    );
    await fs.writeFile(
      path.join(workspace, ".batty", "settings.json"),
      JSON.stringify(
        {
          theme: "light",
          skills: ["../skills"],
          prompts: ["./prompts"],
          compaction: { reserveTokens: 8192 },
        },
        null,
        2,
      ),
    );

    const settings = await loadBattySettings({ battyDir: root }, workspace);

    expect(settings).toEqual(
      expect.objectContaining({
        theme: "light",
        extensions: [path.join(root, ".batty", "extensions")],
        skills: [path.join(workspace, "skills")],
        prompts: [path.join(workspace, ".batty", "prompts")],
        compaction: { enabled: true, reserveTokens: 8192 },
      }),
    );
  });

  it("uses options for global model defaults and lets workspace settings override them", async () => {
    const { root, workspace } = await createLayout();
    await fs.writeFile(
      path.join(root, ".batty", "settings.json"),
      JSON.stringify({
        defaultProvider: "stale-provider",
        defaultModel: "stale-model",
        defaultThinkingLevel: "off",
      }),
    );

    const optionsDefaults = {
      battyDir: root,
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.6-sol",
      defaultThinkingLevel: "medium",
    } as const;
    await expect(loadBattySettings(optionsDefaults, workspace)).resolves.toEqual(
      expect.objectContaining({
        defaultProvider: "openai-codex",
        defaultModel: "gpt-5.6-sol",
        defaultThinkingLevel: "medium",
      }),
    );

    await fs.writeFile(
      path.join(workspace, ".batty", "settings.json"),
      JSON.stringify({
        defaultProvider: "anthropic",
        defaultModel: "claude-opus-5",
        defaultThinkingLevel: "high",
      }),
    );

    await expect(loadBattySettings(optionsDefaults, workspace)).resolves.toEqual(
      expect.objectContaining({
        defaultProvider: "anthropic",
        defaultModel: "claude-opus-5",
        defaultThinkingLevel: "high",
      }),
    );
  });

  it("rejects invalid workspace default thinking levels", async () => {
    const { root, workspace } = await createLayout();
    const settingsPath = path.join(workspace, ".batty", "settings.json");
    await fs.writeFile(settingsPath, JSON.stringify({ defaultThinkingLevel: "extreme" }));

    await expect(loadBattySettings({ battyDir: root }, workspace)).rejects.toThrow(
      `Invalid defaultThinkingLevel in ${settingsPath}: extreme. Expected off, minimal, low, medium, high, xhigh, or max.`,
    );
  });

  it("includes settings-defined resource paths alongside default .batty resource directories", async () => {
    const { root, workspace } = await createLayout();
    await fs.writeFile(
      path.join(workspace, ".batty", "settings.json"),
      JSON.stringify(
        {
          skills: ["../skills"],
          prompts: ["./prompts"],
        },
        null,
        2,
      ),
    );

    const settings = await loadBattySettings({ battyDir: root }, workspace);
    const resources = battyResourcePaths({ battyDir: root }, workspace, settings);

    expect(resources).toEqual({
      extensions: [
        path.join(root, ".batty", "extensions"),
        path.join(workspace, ".batty", "extensions"),
      ],
      skills: [
        path.join(workspace, "skills"),
        path.join(root, ".batty", "skills"),
        path.join(workspace, ".batty", "skills"),
      ],
      prompts: [path.join(workspace, ".batty", "prompts"), path.join(root, ".batty", "prompts")],
      themes: [path.join(root, ".batty", "themes"), path.join(workspace, ".batty", "themes")],
    });
  });

  it("prefers workspace .batty prompt files over batty-root .batty prompt files", async () => {
    const { root, workspace } = await createLayout();
    await fs.writeFile(path.join(root, ".batty", "SYSTEM.md"), "global prompt\n");
    await fs.writeFile(path.join(workspace, ".batty", "SYSTEM.md"), "workspace prompt\n");

    await expect(
      loadBattyPromptFile(workspace, path.join(root, ".batty"), "SYSTEM.md"),
    ).resolves.toBe("workspace prompt\n");
  });

  it("stores sessions under <batty-root>/.batty/sessions/<workspace>", () => {
    expect(battySessionRootDir({ battyDir: "/tmp/root" })).toBe("/tmp/root/.batty/sessions");
    expect(workspaceSessionDir({ battyDir: "/tmp/root" }, "demo")).toBe(
      "/tmp/root/.batty/sessions/demo",
    );
  });
});
