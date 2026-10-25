import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { expect, it, vi } from "vite-plus/test";
import { registerAssistantAgentsRoutes } from "./assistant-agents";
import { listWorkspaces } from "../workspaces";
import type { AppConfig } from "../config";

vi.mock("../workspaces", () => ({ listWorkspaces: vi.fn() }));

it("edits only the selected assistant instructions and can create an absent file", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "batty-instructions-"));
  const app = Fastify();
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
  registerAssistantAgentsRoutes(app, {} as AppConfig);
  try {
    expect((await app.inject("/api/settings/assistant-agents/assistant")).json()).toEqual({
      content: "",
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/settings/assistant-agents/assistant",
      payload: { content: "Local instructions" },
    });
    expect(response.statusCode).toBe(200);
    expect(await fs.readFile(path.join(directory, "AGENTS.md"), "utf8")).toBe("Local instructions");
    expect((await app.inject("/api/settings/assistant-agents/assistant")).json()).toEqual({
      content: "Local instructions",
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/settings/assistant-agents/project",
          payload: { content: "Wrong workspace" },
        })
      ).statusCode,
    ).toBe(404);
    expect((await app.inject("/api/settings/assistant-agents/unknown")).statusCode).toBe(404);
    expect(await fs.readFile(path.join(directory, "AGENTS.md"), "utf8")).toBe("Local instructions");
  } finally {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
