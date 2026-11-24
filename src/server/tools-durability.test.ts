// @vitest-environment node
import { describe, expect, it } from "vite-plus/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT, awaitWithContext } from "@earendil-works/chord/context";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxToolCall, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createOrchestration, OrchestrationDoc } from "./orchestration";
import { CodemodeCalls } from "./codemode";
import { enableCodemodeAdapters } from "./codemode-native";
import { persistentBashOperations } from "./durable-bash";
import { stateDirPath } from "./options";
import { piShellToolNameForPlatform } from "../shared/pi-tools";
import { createToolsTestFixture } from "./tools-test-fixture";

const shellName = piShellToolNameForPlatform(process.platform);
const { fixture, cleanups } = createToolsTestFixture();

describe("durable tool bridge", () => {
  it("enables native codemode when resuming a persisted worker with an old tool allowlist", async () => {
    const { directory, tools, harness, faux, reopen } = await fixture(true);
    await fs.writeFile(path.join(directory, "old-worker.txt"), "old worker resumed");
    const worker = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: { provider: "faux", modelId: "faux-1" },
          cwd: directory,
          tools: tools.extension.tools!.filter((tool) => !tool.name.startsWith("batty_codemode_")),
        },
      },
      BACKGROUND_CONTEXT,
    );
    expect(
      (await worker.agent(BACKGROUND_CONTEXT)).callable.some(
        (tool) => tool.name === "batty_codemode_safe",
      ),
    ).toBe(false);
    const restarted = await reopen();
    await enableCodemodeAdapters(restarted.harness, BACKGROUND_CONTEXT);
    await enableCodemodeAdapters(restarted.harness, BACKGROUND_CONTEXT);
    const resumed = (await restarted.harness.conversation(worker.id, BACKGROUND_CONTEXT))!;
    expect(
      (await resumed.agent(BACKGROUND_CONTEXT)).tools.some((tool) =>
        tool.name.startsWith("batty_codemode_"),
      ),
    ).toBe(false);
    expect(
      (await resumed.agent(BACKGROUND_CONTEXT)).callable.filter((tool) =>
        tool.name.startsWith("batty_codemode_"),
      ),
    ).toHaveLength(2);
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("codemode", { code: 'text(await tools.read({path:"old-worker.txt"}));' })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("done")]),
    ]);
    expect(
      (
        await (
          await resumed.submit({ type: "input", content: "resume smoke test" }, BACKGROUND_CONTEXT)
        ).wait(BACKGROUND_CONTEXT)
      ).status,
    ).toBe("done");
    const view = await resumed.watch(BACKGROUND_CONTEXT);
    expect(JSON.stringify(view.value.entries)).toContain("old worker resumed");
    expect(
      view.value.entries
        .filter((entry) => entry.kind === "pi.tool-result")
        .every((entry) => !(entry.model?.[0] as any)?.isError),
    ).toBe(true);
    view.stop();
  });

  it.skipIf(process.platform === "win32")(
    "cancels a native nested persistent shell on a sandbox deadline",
    async () => {
      const { directory, config, run } = await fixture();
      const result = await run(
        '// @options: {"timeout_ms": 400}\nawait tools.bash({command:"echo running > started; sleep 10; echo leaked > leaked"});',
      );
      expect(result.isError).toBe(true);
      const jobs = path.join(stateDirPath(config.battyDir), "jobs");
      let receipts: any[] = [];
      for (let attempt = 0; attempt < 100; attempt++) {
        receipts = [];
        for (const entry of await fs.readdir(jobs, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          try {
            receipts.push(
              JSON.parse(await fs.readFile(path.join(jobs, entry.name, "receipt.json"), "utf8")),
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        if (receipts.length && receipts.every((receipt) => receipt.status === "done")) break;
        await delay(20);
      }
      expect(receipts).toHaveLength(1);
      expect(receipts[0].status).toBe("done");
      expect([130, 143, 137]).toContain(receipts[0].exitCode);
      await expect(fs.access(path.join(directory, "leaked"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("consumes existing legacy journal receipts without repeating the effect", async () => {
    const { tools, main, faux } = await fixture();
    let effects = 0;
    tools.registerTools([
      {
        name: "effect",
        description: "side effect",
        parameters: Type.Object({}),
        execute: async () => {
          effects++;
          return { output: [{ type: "text", text: "legacy value" }] };
        },
      },
    ]);
    const codemode = tools.extension.tools!.find((tool) => tool.name === "codemode")!;
    const legacyTask = tools.extension.tasks!.find(
      (task) => task.definition.name === "batty.codemode-tool",
    )! as ReturnType<typeof import("./codemode-tasks").createCodemodeTasks>;
    const original = codemode.execute;
    // Seed the exact journal/receipt left by the previous adapter in this live caller.
    codemode.execute = async (_args, api, ctx) => {
      const id = await api.commit(async (tx) => {
        const id = await tx.createTask(
          legacyTask,
          { name: "effect", args: {}, callId: `${api.callId}-0` },
          { ownership: { kind: "task", taskId: api.taskId } },
        );
        (await tx.doc(CodemodeCalls, api.taskId)).calls["0"] = {
          taskId: id,
          name: "effect",
          args: {},
        };
        return id;
      }, ctx);
      await api.waitForTask(id, ctx);
      return original({ code: "return await tools.effect({});" }, api, ctx);
    };
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("codemode", { code: "legacy" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxText("done")]),
    ]);
    expect(
      (
        await (
          await main.submit({ type: "input", content: "run legacy" }, BACKGROUND_CONTEXT)
        ).wait(BACKGROUND_CONTEXT)
      ).status,
    ).toBe("done");
    expect(effects).toBe(1);
    const view = await main.watch(BACKGROUND_CONTEXT);
    expect(JSON.stringify(view.value.entries)).toContain("legacy value");
    view.stop();
  });

  it("retires native nested payloads while retaining small task receipts and transcript results", async () => {
    const { directory, tools, run } = await fixture(true);
    const secret = "unique-nested-payload-".repeat(4096);
    tools.registerTools([
      {
        name: "payload",
        description: "large nested output",
        parameters: Type.Object({}),
        replay: "safe",
        execute: async () => ({
          output: [{ type: "text", text: secret }],
          details: { retained: true },
        }),
      },
    ]);
    const result = await run("const value=await tools.payload({}); text(value.length);");
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe(String(secret.length));
    expect(result.details.calls[0].details).toEqual({ retained: true });
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(directory, "session.sqlite"), { readOnly: true });
    try {
      const tasks = db.prepare("SELECT kind, record FROM tasks").all();
      expect(tasks.some((row) => row.kind === JSON.stringify("batty.codemode-tool"))).toBe(false);
      expect(tasks.filter((row) => row.kind === JSON.stringify("pi.tool"))).toHaveLength(2);
      expect(tasks.every((row) => !String(row.record).includes("unique-nested-payload-"))).toBe(
        true,
      );
      const docs = db.prepare("SELECT record FROM documents").all();
      expect(docs.every((row) => !String(row.record).includes("unique-nested-payload-"))).toBe(
        true,
      );
      expect(
        db
          .prepare("SELECT COUNT(*) AS n FROM entries WHERE json_extract(record, '$.kind')=?")
          .get("pi.tool-result")!.n,
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  it("cancels a tool-to-tool call left running when its caller settles", async () => {
    const { tools, run } = await fixture();
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    let cancelled = false;
    tools.registerTools([
      {
        name: "effect",
        description: "waiting effect",
        parameters: Type.Object({}),
        replay: "safe",
        execute: async (_, _api, ctx) => {
          started();
          try {
            await awaitWithContext(new Promise(() => {}), ctx);
          } finally {
            cancelled = true;
          }
          return {};
        },
      },
      {
        name: "delegate",
        description: "starts unawaited call",
        parameters: Type.Object({}),
        execute: async (_, api, ctx) => {
          void api.executeTool("effect", {}, ctx).catch(() => {});
          await running;
          return { output: [{ type: "text", text: "settled" }] };
        },
      },
    ]);
    const result = await run("return await tools.delegate({});");
    expect(result.isError).toBe(false);
    expect(cancelled).toBe(true);
  });

  it("abandons nested work when an unsafe caller is interrupted by restart", async () => {
    const { tools, harness, main, faux, reopen } = await fixture(true);
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    let effects = 0;
    tools.registerTools([
      {
        name: "effect",
        description: "waiting effect",
        parameters: Type.Object({}),
        replay: "safe",
        execute: async (_, _api, ctx) => {
          effects++;
          started();
          await awaitWithContext(new Promise(() => {}), ctx);
          return {};
        },
      },
      {
        name: "delegate",
        description: "unsafe caller",
        parameters: Type.Object({}),
        execute: async (_, api, ctx) => {
          await api.executeTool("effect", {}, ctx);
          return {};
        },
      },
    ]);
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("codemode", { code: "return await tools.delegate({});" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("done")]),
    ]);
    const submitted = await main.submit({ type: "input", content: "start" }, BACKGROUND_CONTEXT);
    harness.resume();
    await running;
    const restarted = await reopen();
    const recovered = await restarted.harness.submission(submitted.id, BACKGROUND_CONTEXT);
    expect((await recovered!.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    expect(effects).toBe(1);
    const view = await restarted.main.watch(BACKGROUND_CONTEXT);
    expect(JSON.stringify(view.value.entries)).toContain(
      "Tool delegate was interrupted and may have partially run",
    );
    view.stop();
  });

  it("stops a worker's native shell after an explicit subagent stop", async () => {
    const { directory, tools, harness, main, registry, faux } = await fixture();
    const orchestration = createOrchestration({
      workspaces: [
        {
          id: "test",
          path: directory,
          label: "test",
          kind: "workspace",
          isPinned: false,
          isAssistant: false,
        },
      ],
    });
    registry.install(orchestration.extension);
    tools.registerTools(orchestration.extension.tools!);
    await orchestration.bind(harness, main);
    cleanups.push(async () => {
      orchestration.close();
    });
    let workerId = "";
    faux.setResponses(
      Array.from({ length: 20 }, () => (request) => {
        const last = request.messages.findLast((message) => message.role !== "system");
        if (last?.role === "user" && last.content === "launch worker")
          return fauxAssistantMessage(
            [fauxToolCall("subagent", { action: "run", prompt: "worker shell" })],
            { stopReason: "toolUse" },
          );
        if (
          last?.role === "user" &&
          typeof last.content === "string" &&
          last.content.endsWith("Assigned task:\n\nworker shell")
        )
          return fauxAssistantMessage(
            [
              fauxToolCall(shellName, {
                command:
                  process.platform === "win32"
                    ? "Set-Content worker-started started; Start-Sleep 2; Set-Content worker-marker survived"
                    : "echo started > worker-started; sleep 2; echo survived > worker-marker",
              }),
            ],
            { stopReason: "toolUse" },
          );
        if (last?.role === "user" && last.content === "stop worker")
          return fauxAssistantMessage(
            [fauxToolCall("subagent", { action: "stop", sessionId: workerId })],
            { stopReason: "toolUse" },
          );
        return fauxAssistantMessage([fauxText("done")]);
      }),
    );
    await (
      await main.submit({ type: "input", content: "launch worker" }, BACKGROUND_CONTEXT)
    ).wait(BACKGROUND_CONTEXT);
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        await fs.access(path.join(directory, "worker-started"));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await delay(10);
    }
    await fs.access(path.join(directory, "worker-started"));
    workerId = Object.keys(
      (await harness.snapshot(OrchestrationDoc, BACKGROUND_CONTEXT))!.workers,
    )[0]!;
    await (
      await main.submit({ type: "input", content: "stop worker" }, BACKGROUND_CONTEXT)
    ).wait(BACKGROUND_CONTEXT);
    await delay(2200);
    await expect(fs.access(path.join(directory, "worker-marker"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 15_000);

  it("gives two subagent calls distinct durable identities and exposes their details", async () => {
    const { directory, tools, harness, main, registry, faux } = await fixture();
    const orchestration = createOrchestration({
      workspaces: [
        {
          id: "test",
          path: directory,
          label: "test",
          kind: "workspace",
          isPinned: false,
          isAssistant: false,
        },
      ],
    });
    registry.install(orchestration.extension);
    tools.registerTools(orchestration.extension.tools!);
    await orchestration.bind(harness, main);
    cleanups.push(async () => {
      orchestration.close();
    });
    const code =
      'return await Promise.all([tools.subagent({action:"run",prompt:"first worker"}), tools.subagent({action:"run",prompt:"second worker"})])';
    faux.setResponses(
      Array.from({ length: 15 }, () => (request) => {
        const last = request.messages.findLast((message) => message.role !== "system");
        return last?.role === "user" && last.content === "launch"
          ? fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" })
          : fauxAssistantMessage([fauxText("done")]);
      }),
    );
    await (
      await main.submit({ type: "input", content: "launch" }, BACKGROUND_CONTEXT)
    ).wait(BACKGROUND_CONTEXT);
    const state = await (
      await import("./orchestration-test-history")
    ).orchestrationHistory(harness);
    expect(Object.keys(state.workers)).toHaveLength(2);
    expect(Object.keys(state.calls)).toHaveLength(2);
    const view = await main.watch(BACKGROUND_CONTEXT);
    const result = view.value.entries.find(
      (entry) =>
        entry.kind === "pi.tool-result" &&
        entry.model?.[0]?.role === "toolResult" &&
        entry.model[0].toolName === "codemode",
    )!.model![0] as any;
    expect(result.isError).toBe(false);
    expect(result.details.calls.map((call: any) => call.subagent.prompt).sort()).toEqual([
      "first worker",
      "second worker",
    ]);
    view.stop();
  });

  it.skipIf(process.platform === "win32")(
    "replays a script's read->bash journal after SQLite reopen without repeating the shell effect",
    async () => {
      const { directory, tools, harness, main, faux, reopen } = await fixture(true);
      await fs.writeFile(path.join(directory, "seed"), "original");
      const code =
        'const source=await tools.read({path:"seed"}); const bash=await tools.bash({command:"echo run >> count; sleep 1; echo finished"}); return source+":"+bash.output;';
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxText("done")]),
      ]);
      const submission = await main.submit(
        { type: "input", content: "run script" },
        BACKGROUND_CONTEXT,
      );
      harness.resume();
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          await fs.access(path.join(directory, "count"));
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await delay(10);
      }
      expect(await fs.readFile(path.join(directory, "count"), "utf8")).toBe("run\n");
      await fs.writeFile(path.join(directory, "seed"), "changed");
      const restarted = await reopen();
      const recovered = await restarted.harness.submission(submission.id, BACKGROUND_CONTEXT);
      expect((await recovered!.wait(BACKGROUND_CONTEXT)).status).toBe("done");
      expect(await fs.readFile(path.join(directory, "count"), "utf8")).toBe("run\n");
      const view = await restarted.main.watch(BACKGROUND_CONTEXT);
      const result = view.value.entries.findLast(
        (entry) =>
          entry.kind === "pi.tool-result" &&
          entry.model?.[0]?.role === "toolResult" &&
          entry.model[0].toolName === "codemode",
      )!.model![0] as any;
      expect(result.isError, JSON.stringify(result)).toBe(false);
      expect(result.content[0].text).toContain("original:finished");
      view.stop();
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "reconnects a running bash job after its service process is killed without executing it twice",
    async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "batty-bash-test-"));
      cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
      const waiter = path.join(directory, "waiter.mjs");
      const module = pathToFileURL(path.join(process.cwd(), "src/server/durable-bash.ts")).href;
      await fs.writeFile(
        waiter,
        `import {persistentBashOperations} from ${JSON.stringify(module)}; await persistentBashOperations(${JSON.stringify(directory)},'job').exec('echo run >> count; sleep 1; echo finished',${JSON.stringify(directory)},{onData:()=>{}});`,
      );
      const child = spawn(
        process.execPath,
        [
          "--import",
          pathToFileURL(createRequire(path.join(process.cwd(), "package.json")).resolve("tsx"))
            .href,
          waiter,
        ],
        { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      const exited = once(child, "exit");
      for (let attempts = 0; attempts < 100; attempts++) {
        try {
          if ((await fs.readFile(path.join(directory, "count"), "utf8")).includes("run")) break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await delay(20);
      }
      expect(stderr).toBe("");
      expect(await fs.readFile(path.join(directory, "count"), "utf8")).toBe("run\n");
      child.kill("SIGKILL");
      await exited;
      let output = "";
      const result = await persistentBashOperations(directory, "job").exec(
        "echo duplicated >> count",
        directory,
        {
          onData: (data) => {
            output += data.toString();
          },
        },
      );
      expect(result.exitCode, output).toBe(0);
      expect(output).toContain("finished");
      expect(await fs.readFile(path.join(directory, "count"), "utf8")).toBe("run\n");
    },
    15_000,
  );
});
