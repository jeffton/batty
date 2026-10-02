import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fauxAssistantMessage, type JsonObject } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createAgentSessionFixture } from "./agent-session-test-fixture";
import { Type } from "typebox";
import { createPiAgentSession } from "./pi-agent-session";
import { environmentFilePath, type AppConfig } from "./config";
import { getSessionMessagePage } from "./pi-service-message-page";
import { battyAgentDir } from "./pi-paths";
import { SessionStore } from "./session-store";

const fixtures: Awaited<ReturnType<typeof createAgentSessionFixture>>[] = [];
const key = `BATTY_AGENT_SESSION_ENV_${process.pid}`;
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
  delete process.env[key];
  vi.restoreAllMocks();
});

async function setup(
  customTools: Parameters<typeof createPiAgentSession>[0]["customTools"] = [],
  prepare?: (root: string, config: AppConfig) => Promise<void>,
  extensionFactories?: ExtensionFactory[],
) {
  const fixture = await createAgentSessionFixture({
    tools: customTools,
    prepare,
    extensionFactories,
  });
  fixtures.push(fixture);
  return fixture;
}

function toolCall(name: string, args: JsonObject) {
  return fauxAssistantMessage([{ type: "toolCall", id: "call", name, arguments: args }], {
    stopReason: "toolUse",
  });
}

describe("Batty native AgentSession tools", () => {
  it.each(["empty", "tools-only", "model-only"])(
    "uses configured thinking for %s native history without an explicit preference",
    async (history) => {
      const fixture = await setup();
      const model = fixture.modelRuntime.getModel(
        fixture.session.model!.provider,
        fixture.session.model!.id,
      )!;
      model.reasoning = true;
      fixture.config.defaultThinkingLevel = "high";
      const store = await SessionStore.create(fixture.root, path.join(fixture.root, "sessions"));
      if (history === "tools-only")
        await store.appendCustomEntry("batty-session-tools", { activeToolNames: ["read"] });
      if (history === "model-only") store.native.appendModelChange(model.provider, model.id);
      expect((await store.configuration()).thinkingLevel).toBeUndefined();
      const { session } = await createPiAgentSession({
        config: fixture.config,
        workspace: fixture.workspace,
        sessionManager: store,
        modelRuntime: fixture.modelRuntime,
        customTools: [],
      });
      try {
        expect(session.thinkingLevel).toBe("high");
      } finally {
        await session.dispose();
      }
    },
  );

  it.each(["high", "off"] as const)(
    "restores canonical tools and explicit native %s thinking without a persisted model",
    async (thinkingLevel) => {
      const customTools = ["selected-tool", "inactive-tool"].map((name) => ({
        name,
        label: name,
        description: name,
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text" as const, text: "done" }], details: {} }),
      }));
      const fixture = await setup(customTools);
      fixture.modelRuntime.getModel(
        fixture.session.model!.provider,
        fixture.session.model!.id,
      )!.reasoning = true;
      fixture.config.defaultThinkingLevel = "high";
      const store = await SessionStore.create(fixture.root, path.join(fixture.root, "sessions"));
      store.native.appendThinkingLevelChange(thinkingLevel);
      await store.appendCustomEntry("batty-session-tools", { activeToolNames: ["selected-tool"] });
      expect(await store.configuration()).toEqual({
        model: undefined,
        thinkingLevel,
        activeToolNames: ["selected-tool"],
      });
      const { session } = await createPiAgentSession({
        config: fixture.config,
        workspace: fixture.workspace,
        sessionManager: store,
        modelRuntime: fixture.modelRuntime,
        customTools,
        extensionFactories: [
          (pi) => {
            pi.registerTool({
              name: "extension-tool",
              label: "Extension",
              description: "Extension",
              parameters: Type.Object({}),
              execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
            });
          },
        ],
      });
      try {
        expect(session.model?.id).toBe("faux-1");
        expect(session.thinkingLevel).toBe(thinkingLevel);
        expect(session.getActiveToolNames()).toContain("selected-tool");
        expect(session.getActiveToolNames()).not.toContain("inactive-tool");
        expect(session.getActiveToolNames()).toContain("extension-tool");
        expect(session.getActiveToolNames()).toContain("codemode");
        expect(await store.configuration()).toMatchObject({ activeToolNames: ["selected-tool"] });
        expect(
          store
            .getEntries()
            .filter(
              (entry) => entry.type === "custom" && entry.customType === "batty-session-tools",
            ),
        ).toHaveLength(1);
      } finally {
        await session.dispose();
      }
    },
  );

  it("restores canonical active tool selection on reopen", async () => {
    const fixture = await setup(
      ["selected-tool", "unselected-tool"].map((name) => ({
        name,
        label: name,
        description: name,
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text" as const, text: "done" }], details: {} }),
      })),
      undefined,
      [
        (pi) => {
          pi.registerTool({
            name: "extension-tool",
            label: "Extension",
            description: "Extension",
            parameters: Type.Object({}),
            execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
          });
        },
      ],
    );
    await fixture.session.sessionManager.appendCustomEntry("batty-session-tools", {
      activeToolNames: ["read", "selected-tool"],
    });
    const session = await fixture.reopen();
    expect(session.sdk.getActiveToolNames()).toContain("read");
    expect(session.sdk.getActiveToolNames()).toContain("codemode");
    expect(session.sdk.getActiveToolNames()).toContain("selected-tool");
    expect(session.sdk.getActiveToolNames()).not.toContain("unselected-tool");
    expect(session.sdk.getActiveToolNames()).toContain("extension-tool");
  });
  it("persists public tool selection as regular canonical preferences", async () => {
    const fixture = await setup();
    expect(await fixture.session.sessionManager.configuration()).toMatchObject({
      activeToolNames: expect.arrayContaining(["read", "write"]),
    });
    await fixture.session.setActiveToolsByName(["read", "codemode"]);
    expect(await fixture.session.sessionManager.configuration()).toMatchObject({
      activeToolNames: ["read"],
    });
    const reopened = await fixture.reopen();
    expect(reopened.getActiveToolNames()).toContain("read");
    expect(reopened.getActiveToolNames()).toContain("codemode");
    expect(await reopened.sessionManager.configuration()).toMatchObject({
      activeToolNames: ["read"],
    });
  });

  it.each(["write", "codemode"])(
    "persists completed writes when %s is cancelled during filesystem execution",
    async (name) => {
      const { root, faux, session } = await setup();
      const file = path.join(root, "cancelled-write.txt");
      const write = fs.writeFile.bind(fs);
      let stopped!: Promise<void>;
      vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        await write(...args);
        if (args[0] === file) stopped = session.abort();
      });
      faux.setResponses([
        toolCall(
          name,
          name === "write"
            ? { path: file, content: "completed mutation\n" }
            : {
                code: `await tools.write(${JSON.stringify({ path: file, content: "completed mutation\n" })});`,
              },
        ),
      ]);
      await session.prompt("write then cancel");
      await stopped;
      expect(await fs.readFile(file, "utf8")).toBe("completed mutation\n");
      const result = session.sessionManager
        .getBranch()
        .findLast(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "toolResult" &&
            entry.message.toolName === name,
        );
      expect(result).toMatchObject({
        message: {
          isError: true,
          details: {
            battyFileChanges: [{ path: file, before: null, after: "completed mutation\n" }],
          },
        },
      });
    },
  );
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
    expect(
      session.messages
        .filter((message) => message.role !== "system")
        .map((message) => message.role),
    ).toEqual(["user", "assistant", "toolResult", "user", "assistant", "toolResult", "assistant"]);
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

  it("expands home-relative configured extension paths before checking and loading them", async () => {
    const homeKey = process.platform === "win32" ? "USERPROFILE" : "HOME";
    const home = process.env[homeKey];
    try {
      const { root, session } = await setup([], async (root) => {
        process.env[homeKey] = root;
        await fs.mkdir(path.join(root, ".batty"), { recursive: true });
        await fs.writeFile(
          path.join(root, ".batty", "settings.json"),
          JSON.stringify({ extensions: ["~/home-probe.js"] }),
        );
        await fs.writeFile(path.join(root, "home-probe.js"), "export default function () {}\n");
      });
      expect(
        session.resourceLoader
          .getExtensions()
          .extensions.map((extension) => extension.resolvedPath),
      ).toContain(path.join(root, "home-probe.js"));
    } finally {
      if (home === undefined) delete process.env[homeKey];
      else process.env[homeKey] = home;
    }
  });

  it("runs a configured coding-agent extension through native SDK hooks and tools", async () => {
    const { faux, session } = await setup([], async (root) => {
      const extensions = path.join(root, ".batty", "extensions");
      await fs.mkdir(extensions, { recursive: true });
      await fs.writeFile(
        path.join(extensions, "probe.js"),
        `export default function (pi) {
  pi.registerTool({
    name: "configured-probe",
    label: "Configured probe",
    description: "A configured extension tool",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "configured extension" }], details: { native: true } };
    },
  });
  pi.on("tool_result", (event) => event.toolName === "configured-probe"
    ? { details: { ...event.details, hook: true } }
    : undefined);
}`,
      );
    });
    expect(session.getActiveToolNames()).toContain("configured-probe");
    faux.setResponses([toolCall("configured-probe", {}), fauxAssistantMessage("done")]);
    await session.prompt("extension work");
    expect(session.messages.findLast((message) => message.role === "toolResult")).toMatchObject({
      content: [{ type: "text", text: "configured extension" }],
      details: { native: true, hook: true },
    });
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
      expect(session.sdk.resourceLoader.getSkills().skills).toEqual([
        expect.objectContaining({
          name,
          filePath: globalSkill,
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

  it("preserves native tool image input across reopening", async () => {
    const imageData =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=";
    const { faux, session, reopen } = await setup([
      {
        name: "custom-image",
        label: "custom-image",
        description: "image",
        parameters: Type.Object({}),
        async execute() {
          return {
            content: [
              { type: "text" as const, text: "image result" },
              { type: "image" as const, mimeType: "image/png", data: imageData },
            ],
            details: {},
          };
        },
      },
    ]);
    session.settingsManager.setImageAutoResize(false);
    faux.setResponses([toolCall("custom-image", {}), fauxAssistantMessage("done")]);
    await session.prompt("work");
    const stored = await fs.readFile(session.sessionFile, "utf8");
    expect(stored).toContain(imageData);
    expect(JSON.stringify(session.messages)).toContain('"type":"image"');
    const restored = await reopen();
    expect(JSON.stringify(restored.messages)).toContain('"type":"image"');
  });

  it("blocks image transmission without removing durable prompt images", async () => {
    const imageData =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=";
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
      images: [{ type: "image", mimeType: "image/png", data: imageData }],
    });
    expect(JSON.stringify(session.messages)).toContain('"type":"image"');
    const stored = await fs.readFile(session.sessionFile, "utf8");
    expect(stored).toContain(imageData);
  });

  it("advertises Batty's complete native tool set", async () => {
    const { session } = await setup([
      {
        name: "browser",
        label: "Browser",
        description: "Browser",
        parameters: Type.Object({}),
        execute: async () => ({
          content: [{ type: "text" as const, text: "ok" }],
          details: {},
        }),
      },
    ]);
    expect(session.getActiveToolNames()).toEqual(
      expect.arrayContaining(["read", "write", "edit", "bash", "find", "grep", "browser"]),
    );
    expect(session.getActiveToolNames()).toContain("codemode");
  });
});

describe("Codemode", () => {
  it.each([false, true])(
    "preserves nested subagent destinations across reopen (script error=%s)",
    async (fails) => {
      const fixture = await setup([
        {
          name: "subagent",
          label: "subagent",
          description: "subagent",
          parameters: Type.Object({ sessionId: Type.String() }),
          execute: async (_id, args: { sessionId: string }) => ({
            content: [{ type: "text" as const, text: "private nested reply" }],
            details: {
              subagent: {
                workspaceId: "workspace",
                sessionId: args.sessionId,
                sessionPath: `/sessions/${args.sessionId}.jsonl`,
              },
            },
          }),
        },
      ]);
      fixture.faux.setResponses([
        toolCall("codemode", {
          code: `await Promise.all([tools.subagent({ sessionId: "one" }), tools.subagent({ sessionId: "two" })]);
            ${fails ? 'throw new Error("script failed");' : 'text("done");'}`,
        }),
        fauxAssistantMessage("done"),
      ]);
      await fixture.session.prompt("run subagents");
      for (const session of [fixture.session, await fixture.reopen()]) {
        const result = session.messages.findLast((message) => message.role === "toolResult");
        expect(result).toMatchObject({
          toolName: "codemode",
          isError: fails,
          details: {
            calls: ["one", "two"].map((sessionId) =>
              expect.objectContaining({
                name: "subagent",
                subagent: {
                  workspaceId: "workspace",
                  sessionId,
                  sessionPath: `/sessions/${sessionId}.jsonl`,
                },
              }),
            ),
          },
        });
        expect(JSON.stringify(result?.content)).not.toContain("private nested reply");
      }
    },
  );

  it("chains native tools, batches reads, and preserves file changes without exposing nested output", async () => {
    const calls: string[] = [];
    const { root, faux, session } = await setup([], undefined, [
      (pi) => {
        pi.on("tool_call", (event) => {
          calls.push(event.toolName);
        });
      },
    ]);
    faux.setResponses([
      toolCall("codemode", {
        code: `
          await tools.write({ path: "one.txt", content: "private intermediate one" });
          await tools.write({ path: "two.txt", content: "private intermediate two" });
          const values = await Promise.all([
            tools.read({ path: "one.txt" }), tools.read({ path: "two.txt" })
          ]);
          return values.map(value => value.length);
        `,
      }),
      (request) => {
        expect(JSON.stringify(request.messages)).not.toContain('text":"private intermediate');
        return fauxAssistantMessage("done");
      },
    ]);
    await session.prompt("batch calls");
    const results = session.messages.filter((message) => message.role === "toolResult");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      toolName: "codemode",
      isError: false,
      content: expect.arrayContaining([{ type: "text", text: "[24,24]" }]),
      details: {
        calls: expect.arrayContaining([expect.objectContaining({ name: "read", status: "ok" })]),
      },
    });
    expect(calls).toEqual(["codemode", "write", "write", "read", "read"]);
    expect(getSessionMessagePage(session).messages.at(-1)).toMatchObject({
      battyFileChanges: expect.arrayContaining([
        expect.objectContaining({ path: path.join(root, "one.txt") }),
        expect.objectContaining({ path: path.join(root, "two.txt") }),
      ]),
    });
  });

  it.each([false, true])(
    "promotes nested codemode files, sites, and diffs across reopen (script error=%s)",
    async (fails) => {
      const sentFiles = [
        {
          id: "file-1",
          name: "photo.jpg",
          size: 42,
          mimeType: "image/jpeg",
          kind: "image",
          downloadUrl: "/photo.jpg",
        },
      ];
      const sites = [{ id: "site-1", name: "Report", url: "/sites/site-1", public: true }];
      const fixture = await setup(
        [
          { name: "attach-files", details: { sentFiles } },
          { name: "sites", details: { sites } },
        ].map(({ name, details }) => ({
          name,
          label: name,
          description: name,
          parameters: Type.Object({}),
          execute: async () => ({
            content: [{ type: "text" as const, text: "Attached" }],
            details,
          }),
        })),
      );
      fixture.faux.setResponses([
        toolCall("codemode", {
          code: `await tools.write({ path: "report.txt", content: "report" });
            await Promise.all([tools.attach_files({}), tools.sites({})]);
            ${fails ? 'throw new Error("failed after attachments");' : 'text("done");'}`,
        }),
        fauxAssistantMessage("Here you go."),
      ]);
      await fixture.session.prompt("Build and attach report");
      expect(
        fixture.session.messages.findLast((message) => message.role === "toolResult"),
      ).toMatchObject({
        toolName: "codemode",
        isError: fails,
        details: { sentFiles, sites },
      });
      for (const session of [fixture.session, await fixture.reopen()]) {
        expect(getSessionMessagePage(session).messages.at(-1)).toMatchObject({
          battySentFiles: sentFiles,
          battySites: sites,
          battyFileChanges: [
            {
              path: path.join(fixture.root, "report.txt"),
              patch: expect.stringContaining("+report"),
            },
          ],
        });
      }
    },
  );

  it("applies argument validation, hook argument replacement, blocking, and structured results", async () => {
    const execute = vi.fn(async (_id, { value }) => ({
      content: [{ type: "text" as const, text: "text view" }],
      structuredContent: { value },
      details: {},
    }));
    const { faux, session } = await setup(
      [
        {
          name: "probe",
          label: "probe",
          description: "probe",
          parameters: Type.Object({ value: Type.String() }),
          outputSchema: Type.Object({ value: Type.String() }),
          execute,
        },
      ],
      undefined,
      [
        (pi) => {
          pi.on("tool_call", (event) => {
            if (event.toolName !== "probe") return;
            if (event.input.value === "blocked") return { block: true, reason: "blocked by hook" };
            event.input.value = "replaced";
          });
        },
      ],
    );

    faux.setResponses([
      toolCall("codemode", {
        code: `return await Promise.allSettled([
          tools.probe({}),
          tools.probe({ value: "blocked" }),
          tools.probe({ value: "original" })
        ]).then(results => results.map(result => result.status === "fulfilled" ? result.value : result.reason.message));`,
      }),
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("check hooks");
    expect(execute).toHaveBeenCalledTimes(1);
    const result = session.messages.findLast((message) => message.role === "toolResult");
    expect(result?.content).toEqual(
      expect.arrayContaining([
        { type: "text", text: expect.stringContaining('"blocked by hook",{"value":"replaced"}') },
      ]),
    );
  });

  it("preserves partial output and file changes when a script fails", async () => {
    const { root, faux, session } = await setup();
    faux.setResponses([
      toolCall("codemode", {
        code: 'await tools.write({ path: "written.txt", content: "kept" }); text("partial"); throw new Error("script broke");',
      }),
      fauxAssistantMessage("handled"),
    ]);
    await session.prompt("failure");
    expect(await fs.readFile(path.join(root, "written.txt"), "utf8")).toBe("kept");
    expect(session.messages.findLast((message) => message.role === "toolResult")).toMatchObject({
      isError: true,
      content: expect.arrayContaining([
        { type: "text", text: "partial" },
        { type: "text", text: expect.stringContaining("script broke") },
      ]),
    });
    expect(getSessionMessagePage(session).messages.at(-1)).toMatchObject({
      battyFileChanges: [expect.objectContaining({ path: path.join(root, "written.txt") })],
    });
  });

  it("reports nested tool errors and keeps direct tools enabled", async () => {
    const { faux, session } = await setup([
      {
        name: "failed",
        label: "failed",
        description: "failed",
        parameters: Type.Object({}),
        execute: async () => ({
          content: [{ type: "text" as const, text: "nested failure" }],
          details: {},
          isError: true,
        }),
      },
    ]);
    faux.setResponses([
      toolCall("codemode", { code: "await tools.failed({});" }),
      fauxAssistantMessage("handled"),
    ]);
    await session.prompt("failure");
    expect(session.messages.findLast((message) => message.role === "toolResult")).toMatchObject({
      isError: true,
      content: expect.arrayContaining([
        { type: "text", text: expect.stringContaining("nested failure") },
      ]),
    });
    expect(session.getActiveToolNames()).toEqual(
      expect.arrayContaining(["codemode", "read", "write", "bash"]),
    );
  });

  it("assigns distinct native tool call IDs to concurrent nested calls", async () => {
    const ids: string[] = [];
    const { faux, session } = await setup([
      {
        name: "identity",
        label: "identity",
        description: "identity",
        parameters: Type.Object({ value: Type.String() }),
        async execute(id, { value }) {
          ids.push(id);
          return { content: [{ type: "text", text: value }], details: {} };
        },
      },
    ]);
    faux.setResponses([
      toolCall("codemode", {
        code: 'return await Promise.all([tools.identity({value:"one"}), tools.identity({value:"two"})]);',
      }),
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("identities");
    expect(new Set(ids).size).toBe(2);
    expect(session.messages.findLast((message) => message.role === "toolResult")?.content).toEqual(
      expect.arrayContaining([{ type: "text", text: '["one","two"]' }]),
    );
  });

  it("persists successful stores across reopen and follows the forked branch", async () => {
    const fixture = await setup();
    fixture.faux.setResponses([
      toolCall("codemode", { code: 'store("value", "first");' }),
      fauxAssistantMessage("first stored"),
    ]);
    await fixture.session.prompt("first");
    const firstTip = fixture.session.sessionManager.getLeafId()!;
    fixture.faux.setResponses([
      toolCall("codemode", { code: 'store("value", "second");' }),
      fauxAssistantMessage("second stored"),
    ]);
    await fixture.session.prompt("second");
    const fork = await fixture.fork(firstTip);
    fixture.faux.setResponses([
      toolCall("codemode", { code: 'return load("value");' }),
      fauxAssistantMessage("fork read"),
    ]);
    await fork.prompt("read fork");
    expect(fork.messages.findLast((message) => message.role === "toolResult")?.content).toEqual(
      expect.arrayContaining([{ type: "text", text: "first" }]),
    );
    const restored = await fixture.reopen();
    fixture.faux.setResponses([
      toolCall("codemode", { code: 'store("value", "failed"); throw new Error("do not commit");' }),
      toolCall("codemode", { code: 'return load("value");' }),
      fauxAssistantMessage("read"),
    ]);
    await restored.prompt("read store");
    expect(restored.messages.findLast((message) => message.role === "toolResult")?.content).toEqual(
      expect.arrayContaining([{ type: "text", text: "second" }]),
    );
  });

  it("uses Pi's source parser and spills output exceeding the requested budget", async () => {
    const { faux, session } = await setup();
    faux.setResponses([
      toolCall("codemode", { code: '// @options: {"unknown": 1}\ntext("never");' }),
      toolCall("codemode", {
        code: '// @options: {"max_output_tokens": 5}\ntext("a".repeat(500));',
      }),
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("options");
    const results = session.messages.filter((message) => message.role === "toolResult");
    expect(results[0]).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringContaining("only supports") }],
    });
    const text = results[1]!.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    expect(text).toContain("120 tokens truncated");
    const outputPath = text.match(/\[Full output: (.+) \(read with offset\/limit\)\]/)![1]!;
    try {
      expect(await fs.readFile(outputPath, "utf8")).toBe("a".repeat(500));
    } finally {
      await fs.rm(outputPath);
    }
  });

  it("cancels nested calls when the script deadline expires", async () => {
    let cancelled = false;
    const { faux, session } = await setup([
      {
        name: "wait",
        label: "wait",
        description: "wait",
        parameters: Type.Object({}),
        async execute(_id, _args, signal) {
          await new Promise<void>((resolve) => {
            signal!.addEventListener(
              "abort",
              () => {
                cancelled = true;
                resolve();
              },
              { once: true },
            );
          });
          signal!.throwIfAborted();
          return { content: [], details: {} };
        },
      },
    ]);
    faux.setResponses([
      toolCall("codemode", { code: '// @options: {"timeout_ms": 250}\nawait tools.wait({});' }),
      fauxAssistantMessage("handled"),
    ]);
    await session.prompt("deadline");
    expect(cancelled).toBe(true);
    expect(session.messages.findLast((message) => message.role === "toolResult")).toMatchObject({
      isError: true,
    });
  });

  it("aborts a spinning sandbox and activates codemode in existing sessions", async () => {
    const fixture = await setup();
    await fixture.session.setActiveToolsByName(["read"]);
    const session = await fixture.reopen();
    expect(session.getActiveToolNames()).toContain("codemode");
    const started = new Promise<void>((resolve) =>
      session.subscribe((event) => {
        if (event.type === "tool_execution_start" && event.toolName === "codemode") resolve();
      }),
    );
    fixture.faux.setResponses([toolCall("codemode", { code: "while (true) {}" })]);
    const run = session.prompt("spin");
    await started;
    await session.abort();
    await run;
    expect(session.isStreaming).toBe(false);
  });
});
