import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/pi-agent-core";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createPiAgentSession } from "./pi-agent-session";
import { HarnessSessionStore } from "./harness-session-store";
import type { HarnessController } from "./harness-controller";
import { environmentFilePath, type AppConfig } from "./config";
import { getSessionMessagePage } from "./pi-service-message-page";
import { battyAgentDir } from "./pi-paths";

const roots: string[] = [];
const sessions: HarnessController[] = [];
const key = `BATTY_HARNESS_ENV_${process.pid}`;
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.dispose();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  delete process.env[key];
  vi.restoreAllMocks();
});

async function setup(
  customTools: Parameters<typeof createPiAgentSession>[0]["customTools"] = [],
  prepare?: (root: string, config: AppConfig) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-harness-tools-"));
  roots.push(root);
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const workspace = {
    id: "test",
    path: root,
    label: "Test",
    kind: "workspace" as const,
    isPinned: false,
    isAssistant: false,
  };
  const config = {
    battyDir: path.join(root, "data"),
    selfPath: root,
    defaultProvider: "faux",
    defaultModel: faux.getModel().id,
    defaultThinkingLevel: "off",
    cronDailySessionStartTime: "00:00",
  } as AppConfig;
  await prepare?.(root, config);
  const options = {
    config,
    workspace,
    sessionManager: await HarnessSessionStore.create(root, path.join(root, "sessions")),
    modelRuntime: models as unknown as ModelRuntime,
    customTools,
  };
  const { session } = await createPiAgentSession(options);
  sessions.push(session);
  return {
    root,
    faux,
    session,
    config,
    async reopen() {
      await session.dispose();
      const { session: restored } = await createPiAgentSession({
        ...options,
        sessionManager: await HarnessSessionStore.open(session.sessionFile),
      });
      sessions.push(restored);
      return restored;
    },
  };
}

function toolCall(name: string, args: Record<string, unknown>) {
  return fauxAssistantMessage([{ type: "toolCall", id: "call", name, arguments: args }]);
}

describe("Batty native harness tools", () => {
  it("reloads environment and supplies current session metadata to every shell invocation", async () => {
    const { config, faux, session } = await setup();
    await fs.mkdir(path.dirname(environmentFilePath(config.battyDir)), { recursive: true });
    for (const value of ["first", "second"]) {
      await fs.writeFile(environmentFilePath(config.battyDir), JSON.stringify({ [key]: value }));
      faux.setResponses([
        toolCall("bash", { command: `printf '%s:%s' "$${key}" "$PI_SESSION_ID"` }),
        fauxAssistantMessage("done"),
      ]);
      await session.prompt("check environment");
      expect(
        session.messages.filter((message) => message.role === "toolResult").at(-1),
      ).toMatchObject({ content: [{ type: "text", text: `${value}:${session.sessionId}` }] });
    }
  });

  it("uses native read/write/edit and preserves durable file diffs", async () => {
    const { root, faux, session } = await setup();
    faux.setResponses([
      toolCall("write", { path: "example.txt", content: "before\n" }),
      toolCall("edit", { path: "example.txt", edits: [{ oldText: "before", newText: "after" }] }),
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("write and edit");
    expect(await fs.readFile(path.join(root, "example.txt"), "utf8")).toBe("after\n");
    const page = getSessionMessagePage(session);
    expect(page.messages.at(-1)).toMatchObject({
      battyFileChanges: expect.arrayContaining([
        expect.objectContaining({
          path: path.join(root, "example.txt"),
          patch: expect.stringContaining("+after"),
        }),
      ]),
    });
  });

  it("retains mutations before consumed steering and resets after the durable reply", async () => {
    const fixture = await setup();
    const { root, faux, session } = fixture;
    await fs.writeFile(path.join(root, "example.txt"), "before\n");
    let steered = false;
    session.subscribe(async (event) => {
      if (event.type === "message_end" && event.message.role === "toolResult" && !steered) {
        steered = true;
        await session.prompt("Continue with the second edit", { streamingBehavior: "steer" });
      }
    });
    faux.setResponses([
      toolCall("edit", { path: "example.txt", edits: [{ oldText: "before", newText: "middle" }] }),
      (request) => {
        expect(JSON.stringify(request.messages)).toContain("Continue with the second edit");
        return toolCall("edit", {
          path: "example.txt",
          edits: [{ oldText: "middle", newText: "after" }],
        });
      },
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("edit the file");
    expect(steered).toBe(true);
    expect(session.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    const expected = {
      battyFileChanges: [
        { path: path.join(root, "example.txt"), patch: expect.stringContaining("-before") },
      ],
    };
    expect(getSessionMessagePage(session).messages.at(-1)).toMatchObject(expected);
    const restored = await fixture.reopen();
    expect(getSessionMessagePage(restored).messages.at(-1)).toMatchObject(expected);
    const reply = getSessionMessagePage(restored).messages.at(-1);
    expect(JSON.stringify(reply)).toContain("+after");
    expect(JSON.stringify(reply)).not.toContain("middle");
    faux.setResponses([fauxAssistantMessage("nothing changed")]);
    await restored.prompt("just answer");
    expect(getSessionMessagePage(restored).messages.at(-1)).not.toHaveProperty("battyFileChanges");
  });

  it.each(["shared", "Invalid-Name"])(
    "reports resource warnings and keeps Pi's first same-named skill: %s",
    async (name) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      let globalSkill!: string;
      let workspaceSkill!: string;
      const { session, faux } = await setup([], async (root, config) => {
        globalSkill = path.join(battyAgentDir(config), "skills", "shared", "SKILL.md");
        workspaceSkill = path.join(root, ".batty", "skills", "shared", "SKILL.md");
        for (const [file, body] of [
          [globalSkill, "Global instructions"],
          [workspaceSkill, "Workspace instructions"],
        ]) {
          await fs.mkdir(path.dirname(file!), { recursive: true });
          await fs.writeFile(
            file!,
            `---\nname: ${name}\ndescription: Shared skill\n---\n${body}\n`,
          );
        }
      });
      expect(warn).toHaveBeenCalledWith(
        "Pi resource diagnostic",
        expect.objectContaining({
          type: "collision",
          path: workspaceSkill,
          collision: expect.objectContaining({
            winnerPath: globalSkill,
            loserPath: workspaceSkill,
          }),
        }),
      );
      if (name === "Invalid-Name")
        expect(warn).toHaveBeenCalledWith(
          "Pi resource diagnostic",
          expect.objectContaining({ type: "warning" }),
        );
      expect((await session.harness.getResources(context)).skills).toEqual([
        expect.objectContaining({
          name,
          filePath: globalSkill,
          content: expect.stringContaining("Global instructions"),
        }),
      ]);
      faux.setResponses([
        (request) => {
          expect(JSON.stringify(request.messages)).toContain("Global instructions");
          expect(JSON.stringify(request.messages)).not.toContain("Workspace instructions");
          return fauxAssistantMessage("done");
        },
      ]);
      await session.prompt(`/skill:${name}`);
    },
  );

  it("preserves custom tool errors through Pi's native result hook", async () => {
    const { faux, session } = await setup([
      {
        name: "custom-error",
        label: "custom-error",
        description: "error",
        parameters: Type.Object({}),
        async execute() {
          return { content: [{ type: "text", text: "child failed" }], details: {}, isError: true };
        },
      },
    ]);
    faux.setResponses([toolCall("custom-error", {}), fauxAssistantMessage("handled")]);
    await session.prompt("work");
    expect(session.messages.find((message) => message.role === "toolResult")).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "child failed" }],
    });
  });

  it("blocks image transmission without removing durable prompt images", async () => {
    const { faux, session } = await setup();
    session.settingsManager.setBlockImages(true);
    faux.setResponses([
      (request) => {
        expect(JSON.stringify(request.messages)).toContain("Image reading is disabled.");
        expect(JSON.stringify(request.messages)).not.toContain('"type":"image"');
        return fauxAssistantMessage("done");
      },
    ]);
    await session.prompt("image", {
      images: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
    });
    expect(JSON.stringify(session.messages)).toContain('"type":"image"');
  });

  it("advertises explicit replay policy and Batty's complete tool set", async () => {
    const { session } = await setup();
    const tools = await session.harness.getTools(context);
    expect(session.getActiveToolNames()).toEqual(
      expect.arrayContaining(["read", "write", "edit", "bash", "find", "grep"]),
    );
    expect(tools.find((tool) => tool.name === "read")?.replay).toBe("safe");
    expect(tools.find((tool) => tool.name === "find")?.replay).toBe("safe");
  });
});
