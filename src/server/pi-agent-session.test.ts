import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type JsonObject,
} from "@earendil-works/pi-ai";
import {
  BACKGROUND_CONTEXT as context,
  type AgentHarnessToolInvocation,
} from "@earendil-works/pi-agent-core";
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
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "batty-harness-tools-")));
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
    async fork(entryId: string) {
      const { session: forked } = await createPiAgentSession({
        ...options,
        sessionManager: await session.sessionManager.fork(path.join(root, "sessions"), entryId),
      });
      sessions.push(forked);
      return forked;
    },
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

function toolCall(name: string, args: JsonObject) {
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

  it("stores tool images as files while preserving provider image input", async () => {
    const imageData =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XZRqWQAAAABJRU5ErkJggg==";
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
    expect(stored).toContain("batty-file:");
    expect(stored).not.toContain(imageData);
    expect(JSON.stringify(session.messages)).toContain('"type":"image"');
    const restored = await reopen();
    expect(JSON.stringify(restored.messages)).toContain('"type":"image"');
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
    const stored = await fs.readFile(session.sessionFile, "utf8");
    expect(stored).toContain("batty-file:");
    expect(stored).not.toContain("aGVsbG8=");
  });

  it("advertises explicit replay policy and Batty's complete tool set", async () => {
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
    const tools = await session.harness.getTools(context);
    expect(session.getActiveToolNames()).toEqual(
      expect.arrayContaining(["read", "write", "edit", "bash", "find", "grep", "browser"]),
    );
    expect(tools.find((tool) => tool.name === "read")?.replay).toBe("safe");
    expect(tools.find((tool) => tool.name === "find")?.replay).toBe("safe");
    expect(tools.find((tool) => tool.name === "browser")?.replay).toBe("never");
    expect(tools.find((tool) => tool.name === "codemode")?.replay).toBe("never");
    expect(session.getActiveToolNames()).toContain("codemode");
  });
});

describe("Codemode", () => {
  it("chains native tools, batches reads, and preserves file changes without exposing nested output", async () => {
    const { root, faux, session } = await setup();
    const calls: string[] = [];
    session.harness.hooks.on("before_tool", (event) => {
      calls.push(event.toolName);
      return undefined;
    });
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
        codemode: {
          calls: expect.arrayContaining([expect.objectContaining({ name: "read", status: "ok" })]),
        },
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

  it("applies argument validation, hook argument replacement, blocking, and structured results", async () => {
    const execute = vi.fn(async (_id, { value }) => ({
      content: [{ type: "text" as const, text: "text view" }],
      structuredContent: { value },
      details: {},
    }));
    const { faux, session } = await setup([
      {
        name: "probe",
        label: "probe",
        description: "probe",
        parameters: Type.Object({ value: Type.String() }),
        outputSchema: Type.Object({ value: Type.String() }),
        execute,
      },
    ]);
    session.harness.hooks.on("before_tool", (event) => {
      if (event.toolName !== "probe") return;
      if (event.args.value === "blocked") return { block: { reason: "blocked by hook" } };
      return { args: { value: "replaced" } };
    });
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

  it("isolates invocation identities and durable memos for concurrent nested calls", async () => {
    const ids: string[] = [];
    const { faux, session } = await setup([
      {
        name: "memo",
        label: "memo",
        description: "memo",
        parameters: Type.Object({ value: Type.String() }),
        async execute(_id, { value }, _signal, _update, ctx) {
          const invocation = (ctx as unknown as { invocation: AgentHarnessToolInvocation })
            .invocation;
          ids.push(invocation.invocationId);
          await invocation.setMemo("key", value);
          return {
            content: [{ type: "text" as const, text: String(await invocation.getMemo("key")) }],
            details: {},
          };
        },
      },
    ]);
    faux.setResponses([
      toolCall("codemode", {
        code: 'return await Promise.all([tools.memo({value:"one"}), tools.memo({value:"two"})]);',
      }),
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("memos");
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
      expect.arrayContaining([{ type: "text", text: '"first"' }]),
    );
    const restored = await fixture.reopen();
    fixture.faux.setResponses([
      toolCall("codemode", { code: 'store("value", "failed"); throw new Error("do not commit");' }),
      toolCall("codemode", { code: 'return load("value");' }),
      fauxAssistantMessage("read"),
    ]);
    await restored.prompt("read store");
    expect(restored.messages.findLast((message) => message.role === "toolResult")?.content).toEqual(
      expect.arrayContaining([{ type: "text", text: '"second"' }]),
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
    expect(text).toContain("480 chars truncated");
    const outputPath = text.split("Full output: ")[1]!;
    try {
      expect(await fs.readFile(outputPath, "utf8")).toBe("a".repeat(500));
    } finally {
      await fs.rm(path.dirname(outputPath), { recursive: true, force: true });
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

  it.each(["deadline", "failure", "unawaited"])(
    "settles admitted effects and preserves their artifacts after %s",
    async (mode) => {
      let started!: () => void;
      const start = new Promise<void>((resolve) => {
        started = resolve;
      });
      let cancelled!: () => void;
      const cancellation = new Promise<void>((resolve) => {
        cancelled = resolve;
      });
      let finish!: () => void;
      const completion = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let settled = false;
      const fixture = await setup([
        {
          name: "slow-write",
          label: "slow-write",
          description: "write that has already started its external effect",
          parameters: Type.Object({}),
          async execute(_id, _args, signal, _update, ctx) {
            started();
            signal!.addEventListener("abort", cancelled, { once: true });
            await completion;
            const file = path.join(ctx.cwd, "late.txt");
            await fs.writeFile(file, "late effect");
            settled = true;
            return {
              content: [{ type: "text" as const, text: "written" }],
              details: {
                battyFileChanges: [
                  { path: file, before: null, after: "late effect", patch: "+late effect" },
                ],
              },
            };
          },
        },
        {
          name: "started",
          label: "started",
          description: "wait for the external effect to start",
          parameters: Type.Object({}),
          async execute() {
            await start;
            return { content: [], details: {} };
          },
        },
      ]);
      const code =
        mode === "deadline"
          ? '// @options: {"timeout_ms": 250}\nawait tools.slow_write({});'
          : `tools.slow_write({}); await tools.started({}); ${mode === "failure" ? 'throw new Error("stop");' : 'return "early";'}`;
      fixture.faux.setResponses([toolCall("codemode", { code }), fauxAssistantMessage("handled")]);
      const run = fixture.session.prompt("settle effects");
      try {
        await cancellation;
        expect(settled).toBe(false);
        expect(fixture.session.isStreaming).toBe(true);
      } finally {
        finish();
        await run;
      }
      expect(settled).toBe(true);
      const file = path.join(fixture.root, "late.txt");
      expect(getSessionMessagePage(fixture.session).messages.at(-1)).toMatchObject({
        battyFileChanges: [expect.objectContaining({ path: file })],
      });
      expect(
        (await fixture.reopen()).messages.findLast((message) => message.role === "toolResult"),
      ).toMatchObject({
        details: { battyFileChanges: [expect.objectContaining({ path: file })] },
      });
    },
  );

  it("rejects queued memo writes after their child scope expires while the parent stays active", async () => {
    let expired!: () => void;
    const expiry = new Promise<void>((resolve) => {
      expired = resolve;
    });
    let memoCompleted!: (outcome: string) => void;
    const memoOutcome = new Promise<string>((resolve) => {
      memoCompleted = resolve;
    });
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let barrier: Awaited<ReturnType<HarnessSessionStore["native"]["beginMutation"]>>;
    const fixture = await setup([
      {
        name: "enqueue-memo",
        label: "enqueue-memo",
        description: "enqueue an unawaited memo write",
        parameters: Type.Object({}),
        async execute(_id, _args, signal, _update, ctx) {
          const { invocation, sessionManager } = ctx as unknown as {
            invocation: AgentHarnessToolInvocation;
            sessionManager: HarnessSessionStore;
          };
          barrier = await sessionManager.native.beginMutation(context);
          signal!.addEventListener("abort", expired, { once: true });
          void invocation.setMemo("key", "late").then(
            () => memoCompleted("committed"),
            (error) => memoCompleted(error.message),
          );
          return { content: [], details: {} };
        },
      },
      {
        name: "hold",
        label: "hold",
        description: "keep the parent script active",
        parameters: Type.Object({}),
        async execute() {
          await completion;
          return { content: [], details: {} };
        },
      },
    ]);
    fixture.faux.setResponses([
      toolCall("codemode", { code: "await tools.enqueue_memo({}); await tools.hold({});" }),
      fauxAssistantMessage("done"),
    ]);
    const run = fixture.session.prompt("memo expiry");
    await expiry;
    try {
      await barrier!.end(context);
      expect(fixture.session.isStreaming).toBe(true);
      expect(await memoOutcome).toContain("Tool invocation no longer owns");
    } finally {
      finish();
      await run;
    }
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
