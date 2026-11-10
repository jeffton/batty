import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { assistantAgentsRead, assistantAgentsWrite } from "./assistant-agents";
import { listWorkspaces } from "../workspaces";
import type { AppConfig } from "../config";

vi.mock("../workspaces", () => ({ listWorkspaces: vi.fn() }));

it("edits only the selected assistant instructions and can create an absent file", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "batty-instructions-"));
  vi.mocked(listWorkspaces).mockResolvedValue([
    {
      id: "assistant",
      label: "Assistant",
      path: directory,
      kind: "workspace",
      isPinned: false,
      isAssistant: true,
    },
    {
      id: "project",
      label: "Project",
      path: directory,
      kind: "workspace",
      isPinned: false,
      isAssistant: false,
    },
  ]);
  try {
    expect(await assistantAgentsRead({} as AppConfig, "assistant")).toEqual({ content: "" });
    await assistantAgentsWrite({} as AppConfig, "assistant", "Local instructions");
    expect(await fs.readFile(path.join(directory, "AGENTS.md"), "utf8")).toBe("Local instructions");
    expect(await assistantAgentsWrite({} as AppConfig, "assistant", "Native instructions")).toEqual(
      { content: "Native instructions" },
    );
    expect(await assistantAgentsRead({} as AppConfig, "assistant")).toEqual({
      content: "Native instructions",
    });
    await expect(
      assistantAgentsWrite({} as AppConfig, "project", "Wrong workspace"),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(assistantAgentsRead({} as AppConfig, "unknown")).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(await fs.readFile(path.join(directory, "AGENTS.md"), "utf8")).toBe(
      "Native instructions",
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
