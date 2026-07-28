import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  ensureOptionsFile,
  optionsFilePath,
  readStoredOptions,
  setAssistantWorkspace,
  setBraveSearchKey,
} from "@/server/options";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createBattyDir(): Promise<string> {
  const battyDir = await fs.mkdtemp(path.join(os.tmpdir(), "batty-root-"));
  tempDirs.push(battyDir);
  return battyDir;
}

describe("ensureOptionsFile", () => {
  it("creates options.json inside <batty-dir>/.batty and rejects missing required options", async () => {
    const battyDir = await createBattyDir();

    await expect(ensureOptionsFile(battyDir)).rejects.toThrow(
      `Missing required options in ${optionsFilePath(battyDir)}: workspacesRoots, webPushSubject.`,
    );

    const persisted = JSON.parse(await fs.readFile(optionsFilePath(battyDir), "utf8")) as {
      authSecret: string;
      workspacesRoots: string[];
      webPushSubject: string;
      cronDailySessionStartTime: string;
      braveSearchKey?: string;
      pinnedWorkspaceIds?: string[];
      assistantWorkspaceId?: string;
      defaultProvider?: string;
      defaultModel?: string;
      defaultThinkingLevel?: string;
      baseUrl?: string;
    };

    expect(persisted.authSecret.length).toBeGreaterThan(0);
    expect(persisted.workspacesRoots).toEqual([]);
    expect(persisted.webPushSubject).toBe("");
    expect(persisted.cronDailySessionStartTime).toBe("04:00");
    expect(persisted.braveSearchKey).toBeUndefined();
    expect(persisted.pinnedWorkspaceIds).toEqual([]);
    expect(persisted.assistantWorkspaceId).toBeUndefined();
    expect(persisted.defaultProvider).toBeUndefined();
    expect(persisted.defaultModel).toBeUndefined();
    expect(persisted.defaultThinkingLevel).toBeUndefined();
    expect(persisted.baseUrl).toBe("/");
  });

  it("normalizes and persists configured options", async () => {
    const battyDir = await createBattyDir();

    await fs.mkdir(path.dirname(optionsFilePath(battyDir)), { recursive: true });
    await fs.writeFile(
      optionsFilePath(battyDir),
      `${JSON.stringify(
        {
          authSecret: "existing-secret",
          workspacesRoots: ["/root/github"],
          webPushSubject: "https://batty.roybot.se",
          cronDailySessionStartTime: "4:00",
          braveSearchKey: "  brave-key  ",
          pinnedWorkspaceIds: ["batty", "", 123, "kladde"],
          assistantWorkspaceId: "  batty  ",
          defaultProvider: "  openai-codex  ",
          defaultModel: "  gpt-5.6-sol  ",
          defaultThinkingLevel: "medium",
          baseUrl: "batty/",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const options = await ensureOptionsFile(battyDir);
    const persisted = JSON.parse(await fs.readFile(optionsFilePath(battyDir), "utf8")) as Record<
      string,
      unknown
    >;

    expect(options.authSecret).toBe("existing-secret");
    expect(options.workspacesRoots).toEqual(["/root/github"]);
    expect(options.webPushSubject).toBe("https://batty.roybot.se");
    expect(options.cronDailySessionStartTime).toBe("04:00");
    expect(options.braveSearchKey).toBe("brave-key");
    expect(options.pinnedWorkspaceIds).toEqual(["batty", "kladde"]);
    expect(options.assistantWorkspaceId).toBe("batty");
    expect(options.defaultProvider).toBe("openai-codex");
    expect(options.defaultModel).toBe("gpt-5.6-sol");
    expect(options.defaultThinkingLevel).toBe("medium");
    expect(options.baseUrl).toBe("/batty");
    expect(persisted).toEqual(options);
  });

  it("persists the selected assistant workspace", async () => {
    const battyDir = await createBattyDir();

    await fs.mkdir(path.dirname(optionsFilePath(battyDir)), { recursive: true });
    await fs.writeFile(
      optionsFilePath(battyDir),
      `${JSON.stringify(
        {
          authSecret: "existing-secret",
          workspacesRoots: ["/root/github"],
          webPushSubject: "https://batty.roybot.se",
          cronDailySessionStartTime: "04:00",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await setAssistantWorkspace(battyDir, "assistant-ws");
    expect((await readStoredOptions(battyDir))?.assistantWorkspaceId).toBe("assistant-ws");

    await setAssistantWorkspace(battyDir, undefined);
    expect((await readStoredOptions(battyDir))?.assistantWorkspaceId).toBeUndefined();
  });

  it("persists the Brave Search API key", async () => {
    const battyDir = await createBattyDir();

    await fs.mkdir(path.dirname(optionsFilePath(battyDir)), { recursive: true });
    await fs.writeFile(
      optionsFilePath(battyDir),
      `${JSON.stringify(
        {
          authSecret: "existing-secret",
          workspacesRoots: ["/root/github"],
          webPushSubject: "https://batty.roybot.se",
          cronDailySessionStartTime: "04:00",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await setBraveSearchKey(battyDir, "  brave-key  ");
    expect((await readStoredOptions(battyDir))?.braveSearchKey).toBe("brave-key");

    await setBraveSearchKey(battyDir, "   ");
    expect((await readStoredOptions(battyDir))?.braveSearchKey).toBeUndefined();
  });

  it("rejects invalid baseUrl values", async () => {
    const battyDir = await createBattyDir();

    await fs.mkdir(path.dirname(optionsFilePath(battyDir)), { recursive: true });
    await fs.writeFile(
      optionsFilePath(battyDir),
      `${JSON.stringify(
        {
          authSecret: "existing-secret",
          workspacesRoots: ["/root/github"],
          webPushSubject: "https://batty.roybot.se",
          cronDailySessionStartTime: "04:00",
          baseUrl: "/batty?bad=1",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(ensureOptionsFile(battyDir)).rejects.toThrow(
      "Invalid baseUrl in options.json: /batty?bad=1. Expected a URL path.",
    );
  });

  it("rejects invalid defaultThinkingLevel values", async () => {
    const battyDir = await createBattyDir();

    await fs.mkdir(path.dirname(optionsFilePath(battyDir)), { recursive: true });
    await fs.writeFile(
      optionsFilePath(battyDir),
      `${JSON.stringify(
        {
          authSecret: "existing-secret",
          workspacesRoots: ["/root/github"],
          webPushSubject: "https://batty.roybot.se",
          defaultThinkingLevel: "extreme",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(ensureOptionsFile(battyDir)).rejects.toThrow(
      "Invalid defaultThinkingLevel in options.json: extreme. Expected off, minimal, low, medium, high, xhigh, or max.",
    );
  });

  it("rejects non-string defaultThinkingLevel values", async () => {
    const battyDir = await createBattyDir();

    await fs.mkdir(path.dirname(optionsFilePath(battyDir)), { recursive: true });
    await fs.writeFile(
      optionsFilePath(battyDir),
      `${JSON.stringify({
        authSecret: "existing-secret",
        workspacesRoots: ["/root/github"],
        webPushSubject: "https://batty.roybot.se",
        defaultThinkingLevel: 123,
      })}\n`,
      "utf8",
    );

    await expect(ensureOptionsFile(battyDir)).rejects.toThrow(
      "Invalid defaultThinkingLevel in options.json: 123. Expected off, minimal, low, medium, high, xhigh, or max.",
    );
  });

  it("rejects invalid cronDailySessionStartTime values", async () => {
    const battyDir = await createBattyDir();

    await fs.mkdir(path.dirname(optionsFilePath(battyDir)), { recursive: true });
    await fs.writeFile(
      optionsFilePath(battyDir),
      `${JSON.stringify(
        {
          authSecret: "existing-secret",
          workspacesRoots: ["/root/github"],
          webPushSubject: "https://batty.roybot.se",
          cronDailySessionStartTime: "25:00",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(ensureOptionsFile(battyDir)).rejects.toThrow(
      "Invalid cronDailySessionStartTime in options.json: 25:00. Expected HH:MM.",
    );
  });
});
