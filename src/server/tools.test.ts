// @vitest-environment node
import { afterEach, describe, expect, it } from "vite-plus/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import http from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT, awaitWithContext } from "@earendil-works/chord/context";
import { Type } from "typebox";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createOrchestration, OrchestrationDoc } from "./orchestration";
import { createTools } from "./tools";
import { persistentBashOperations } from "./durable-bash";
import { stateDirPath } from "./options";
import { withoutMainMemory } from "./main-memory-policy";
import { piShellToolNameForPlatform } from "../shared/pi-tools";

const shellName = piShellToolNameForPlatform(process.platform);
const shellPrint = process.platform === "win32" ? "Write-Output" : "printf";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(persistent = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "batty-tools-test-"));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const config = { battyDir: directory, browserMaxTabs: 4, workspacesRoots: [directory] } as any;
  const tools = await createTools(config);
  cleanups.push(() => tools.close());
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(tools.extension);
  const settings = {
    get extensions() {
      return registry
        .snapshot()
        .installed()
        .filter((extension) => !extension.name.startsWith("batty-mcp-workspace-"));
    },
  };
  let harness = await Harness.open(
    persistent
      ? await openNodeSqliteStorage(path.join(directory, "session.sqlite"))
      : new MemoryStorage(),
    { models, registry, settings, env: () => new NodeExecutionEnv({ cwd: directory }) },
    BACKGROUND_CONTEXT,
  );
  tools.bindHarness(harness);
  cleanups.push(() => harness.close(BACKGROUND_CONTEXT));
  let main = await harness.root(BACKGROUND_CONTEXT, {
    agent: { cwd: directory, model: { provider: "faux", modelId: "faux-1" } },
  });
  const reopen = async () => {
    await harness.close(BACKGROUND_CONTEXT);
    harness = await Harness.open(
      await openNodeSqliteStorage(path.join(directory, "session.sqlite")),
      { models, registry, settings, env: () => new NodeExecutionEnv({ cwd: directory }) },
      BACKGROUND_CONTEXT,
    );
    tools.bindHarness(harness);
    main = await harness.root(BACKGROUND_CONTEXT);
    harness.resume();
    return { harness, main };
  };
  const run = async (code: string) => {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("done")]),
    ]);
    const settled = await (
      await main.submit({ type: "input", content: "run script" }, BACKGROUND_CONTEXT)
    ).wait(BACKGROUND_CONTEXT);
    expect(settled.status).toBe("done");
    const view = await main.viewState(BACKGROUND_CONTEXT);
    const result = view.value.entries.findLast(
      (entry) =>
        entry.kind === "pi.tool-result" &&
        entry.model?.[0]?.role === "toolResult" &&
        entry.model[0].toolName === "codemode",
    )!.model![0] as any;
    view.dispose();
    return result;
  };
  const api = {
    callId: "call",
    taskId: 1,
    conversationId: 1,
    env: { cwd: directory },
    agent: async () => ({ cwd: directory, tools: tools.extension.tools }),
    output: () => {},
    details: async () => {},
    snapshot: async () => undefined,
    commit: async (fn: any) => main.commit(fn, BACKGROUND_CONTEXT),
  } as any;
  return { directory, config, tools, api, run, harness, main, registry, faux, reopen };
}

describe("durable tool bridge", () => {
  it("exposes only the platform's shell", async () => {
    const { tools } = await fixture();
    const names = tools.extension.tools!.map((tool) => tool.name);
    expect(names).toContain(shellName);
    expect(names).not.toContain(process.platform === "win32" ? "bash" : "powershell");
  });

  it("discovers exact snake_case names and invokes renamed tools through codemode", async () => {
    const { tools, run } = await fixture();
    const names = tools.extension.tools!.map((tool) => tool.name);
    expect(names.every((name) => /^[a-z][a-z0-9_]*$/.test(name))).toBe(true);
    const discovered = await run(
      'return { names: (await searchTools("attach", {namespace: "attach_"})).map(tool => tool.name).sort(), declaration: await describeTool("web_search") }',
    );
    expect(discovered.isError).toBe(false);
    expect(JSON.parse(discovered.content[0].text)).toMatchObject({
      names: ["attach_artifacts", "attach_files"],
      declaration: expect.stringContaining("web_search"),
    });
    const invoked = await run('return await tools.web_search({action: "content"})');
    expect(invoked.isError).toBe(true);
    expect(invoked.details.calls[0]).toMatchObject({
      name: "web_search",
      error: expect.stringContaining("Missing Brave Search API key"),
    });
    const obsolete = await run('return await describeTool("web-search")');
    expect(obsolete.isError).toBe(true);
    expect(obsolete.content[0].text).toContain("Unknown tool: web-search");
    const obsoleteInvocation = await run('return await tools["attach-files"]({paths: []})');
    expect(obsoleteInvocation.isError).toBe(true);
    expect(obsoleteInvocation.details.calls).toEqual([]);
  });

  it.skipIf(process.platform !== "win32")(
    "uses PowerShell Core 7 with Unicode output and the conversation cwd",
    async () => {
      const { directory, tools, api, run } = await fixture();
      const powershell = tools.extension.tools!.find((tool) => tool.name === "powershell")!;
      expect(powershell.replay).toBe("unsafe");
      const result = await powershell.execute(
        {
          command:
            "$PSVersionTable.PSEdition; $PSVersionTable.PSVersion.Major; (Get-Location).Path; Write-Output 'æøå 日本語'",
        },
        api,
        BACKGROUND_CONTEXT,
      );
      const text = result.output!.map((block: any) => block.text).join("\n");
      expect(text).toMatch(/Core\r?\n7\r?\n/);
      expect(text).toContain(directory);
      expect(text).toContain("æøå 日本語");
      const nested = await run(
        "return await tools.powershell({command: \"Write-Output 'nested æøå'\"})",
      );
      expect(nested.isError).toBe(false);
      expect(JSON.parse(nested.content[0].text)).toMatchObject({
        output: "nested æøå\r\n",
        exit_code: 0,
        truncated: false,
      });
      const declaration = await run('return await describeTool("powershell")');
      expect(declaration.content[0].text).toContain("exit_code");
      const failed = await run(
        "return await tools.powershell({command: \"Write-Output 'failure output'; exit 17\"})",
      );
      expect(failed.isError).toBe(true);
      expect(failed.content[0].text).toContain("failure output");
      expect(failed.content[0].text).toContain("17");
      const timeout = await run(
        'return await tools.powershell({command: "Start-Sleep 10", timeout: 0.2})',
      );
      expect(timeout.isError).toBe(true);
      expect(timeout.content[0].text).toContain("timed out");
    },
  );

  it.skipIf(process.platform !== "win32")(
    "rejects Windows PowerShell 5.1 when pwsh is unavailable",
    async () => {
      const oldPath = process.env.PATH;
      process.env.PATH =
        path.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0") +
        path.delimiter +
        path.join(process.env.SystemRoot!, "System32");
      try {
        await expect(fixture()).rejects.toThrow("Batty requires PowerShell 7 (pwsh.exe) on PATH");
      } finally {
        process.env.PATH = oldPath;
      }
    },
  );
  it("gives nested tools the harness model catalog without dropping shell output", async () => {
    const { tools, run } = await fixture();
    tools.registerTools([
      {
        name: "modelCatalog",
        description: "resolves the active model",
        parameters: Type.Object({}),
        execute: async (_args, api) => {
          const model = api.models.getModel("faux", "faux-1")!;
          return { output: [{ type: "text", text: `${model.provider}/${model.id}` }] };
        },
      },
    ]);
    const result = await run(`const model = await tools.modelCatalog({});
      const shell = await tools.${shellName}({command: "${shellPrint} 'nested shell output'"});
      text(model); text(shell);`);
    expect(result.isError).toBe(false);
    const text = result.content.map((block: { text: string }) => block.text).join("\n");
    expect(text).toContain("faux/faux-1");
    expect(text).toContain("nested shell output");
  });
  it("retains streamed durable output and supports tool-to-tool calls from codemode", async () => {
    const { directory, tools, run } = await fixture();
    await fs.writeFile(path.join(directory, "nested.txt"), "local nested result");
    tools.registerTools([
      {
        name: "streamed",
        description: "streamed output",
        parameters: Type.Object({}),
        execute: async (_, api) => {
          api.output("first ");
          api.output("second");
          expect(api.retainedOutput()).toEqual({ text: "first second", truncated: false });
          return {};
        },
      },
      {
        name: "delegate",
        description: "calls another tool",
        parameters: Type.Object({}),
        execute: async (_, api, ctx) => {
          const result = await api.executeTool("read", { path: "nested.txt" }, ctx);
          expect(result.isError).toBe(false);
          return { output: [{ type: "text", text: String(result.structuredOutput) }] };
        },
      },
    ]);
    const result = await run("text(await tools.streamed({})); return await tools.delegate({});");
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.content)).toContain("first second");
    expect(JSON.stringify(result.content)).toContain("local nested result");
  });

  it("preserves structured program output independently of model-facing text", async () => {
    const { tools, run } = await fixture();
    tools.registerTools([
      {
        name: "structured",
        description: "structured result",
        parameters: Type.Object({}),
        structuredOutputSchema: Type.Object({ value: Type.Integer() }),
        execute: async () => ({
          output: [{ type: "text", text: "model summary" }],
          structuredOutput: { value: 42 },
        }),
      },
      {
        name: "delegate",
        description: "delegation",
        parameters: Type.Object({}),
        execute: async (_, api, ctx) => {
          const result = await api.executeTool("structured", {}, ctx);
          return { output: [{ type: "text", text: JSON.stringify(result.structuredOutput) }] };
        },
      },
    ]);
    const direct = await run("return await tools.structured({});");
    expect(direct.content[0].text).toBe('{"value":42}');
    const delegated = await run("return await tools.delegate({});");
    expect(delegated.content[0].text).toBe('{"value":42}');
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
    const view = await restarted.main.viewState(BACKGROUND_CONTEXT);
    expect(JSON.stringify(view.value.entries)).toContain("Nested tool interrupted by restart");
    view.dispose();
  });

  it("isolates dynamically invoked main-memory output while retaining ordinary mixed-batch results", async () => {
    const { directory, tools, run } = await fixture();
    await fs.writeFile(path.join(directory, "task.txt"), "ordinary task result");
    tools.registerTools([
      {
        name: "memory_zoom",
        description: "main memory",
        parameters: Type.Object({}),
        replay: "safe",
        execute: async () => ({ output: [{ type: "text", text: "private decision" }] }),
      },
    ]);
    const result = await run(
      'const key = "memory_" + "zoom"; const results = await Promise.all([tools.read({path: "task.txt"}), tools[key]({})]); for (const result of results) text(result);',
    );
    const isolated = withoutMainMemory([result]);
    expect(JSON.stringify(isolated)).not.toContain("private decision");
    expect(JSON.stringify(isolated)).toContain("ordinary task result");
    const derived = await run(
      `const secret = await tools.memory_zoom({}); text(await tools.${shellName}({command: "${shellPrint} '" + secret + "'"}));`,
    );
    expect(withoutMainMemory([derived])).toEqual([]);
    await fs.writeFile(path.join(directory, "task.txt"), "ordinary".repeat(100));
    const truncated = await run(
      '// @options: {"max_output_tokens": 10}\nconst results = await Promise.all([tools.read({path: "task.txt"}), tools.memory_zoom({})]); for (const result of results) text(result);',
    );
    const copied = withoutMainMemory([truncated]);
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatchObject({ content: [{ type: "text", text: "ordinary".repeat(5) }] });
  });
  it("preserves nested faults and returned errors alongside successful batched calls", async () => {
    const { directory, tools, run } = await fixture();
    await fs.writeFile(path.join(directory, "present.txt"), "hello");
    tools.registerTools([
      {
        name: "returnedError",
        description: "returns an error result",
        parameters: Type.Object({}),
        execute: async () => ({
          isError: true,
          output: [{ type: "text", text: "permission denied" }],
        }),
      },
    ]);
    const result = await run(`const results = await Promise.allSettled([
      tools.read({path: "present.txt"}),
      tools.read({path: "missing.txt"}),
      tools.returnedError({})
    ]); return results.map(r => r.status === "fulfilled" ? r.value : String(r.reason));`);
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("hello");
    expect(result.content[0].text).toContain("ENOENT");
    expect(result.content[0].text).toContain("permission denied");
    expect(result.details.calls).toHaveLength(3);
    expect(result.details.calls[0]).toMatchObject({
      name: "read",
      args: '{"path":"present.txt"}',
      status: "ok",
    });
    expect(result.details.calls[1]).toMatchObject({
      name: "read",
      status: "error",
      error: expect.stringContaining("ENOENT"),
    });
    expect(result.details.calls[2]).toMatchObject({
      name: "returnedError",
      status: "error",
      error: "permission denied",
    });
    for (const call of result.details.calls) {
      expect(call.id).toEqual(expect.any(String));
      expect(call.durationMs).toBeGreaterThanOrEqual(0);
    }
    const invalid = await run("return await Promise.allSettled([tools.read()])");
    expect(invalid.details.calls[0]).toMatchObject({
      args: "undefined",
      status: "error",
      error: expect.stringContaining("Invalid arguments for read"),
    });
    const uncaught = await run('return await tools.read({path: "missing.txt"})');
    expect(uncaught.isError).toBe(true);
    expect(uncaught.content[0].text).toContain("ENOENT");
    expect(uncaught.details.calls[0].error).toContain("ENOENT");
  });

  it("retains explicit read limits and executes registered tools in QuickJS with persistent store", async () => {
    const { directory, tools, api, run } = await fixture();
    await fs.writeFile(path.join(directory, "large.txt"), "x".repeat(60_000));
    const read = tools.extension.tools!.find((tool) => tool.name === "read")!;
    const result = await read.execute({ path: "large.txt", limit: 1 }, api, BACKGROUND_CONTEXT);
    expect(result.output?.[0]).toEqual({ type: "text", text: "x".repeat(60_000) });
    tools.registerTools([
      {
        name: "multiply",
        description: "multiply numbers",
        parameters: Type.Object({ value: Type.Number() }),
        execute: async ({ value }: any) => ({
          output: [{ type: "text", text: String(value * 2) }],
        }),
      },
    ]);
    const codemode = tools.extension.tools!.find((tool) => tool.name === "codemode")!;
    const script = await run('store("count", 3); return await tools.multiply({value: 4})');
    expect(script.isError).toBe(false);
    expect(script.content?.[0]).toEqual({ type: "text", text: "8" });
    const stored = await run('return load("count")');
    expect(stored.content?.[0]).toEqual({ type: "text", text: "3" });
  });

  it("calls stdio MCP tools through codemode and returns structured MCP results", async () => {
    const { directory, config, tools, main, run } = await fixture();
    const server = path.join(directory, "mcp.cjs");
    await fs.writeFile(
      server,
      `const readline=require('node:readline'); readline.createInterface({input:process.stdin}).on('line', line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};if(m.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}};if(m.method==='tools/list')result={tools:[{name:'echo',description:'Echo input',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']}}]};if(m.method==='tools/call')result={content:[{type:'text',text:m.params.arguments.value}],structuredContent:{value:m.params.arguments.value,pid:process.pid,cwd:process.cwd()}};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')})`,
    );
    await fs.mkdir(stateDirPath(config.battyDir), { recursive: true });
    await fs.writeFile(
      path.join(stateDirPath(config.battyDir), "mcp.json"),
      JSON.stringify({ mcpServers: { test: { command: process.execPath, args: [server] } } }),
    );
    const codemode = tools.extension.tools!.find((tool) => tool.name === "codemode")!;
    const result = await run(
      'return (await tools.mcp__test__echo({value:"hello"})).structuredContent.value',
    );
    expect(result.isError).toBe(false);
    expect(result.content?.[0]).toEqual({ type: "text", text: "hello" });
    const inspect = () =>
      run(
        'return { catalog: (await searchTools("mcp__")).map(tool => tool.name), result: (await tools.mcp__test__echo({value:"shared"})).structuredContent }',
      );
    const first = JSON.parse((await inspect()).content[0].text);
    const other = path.join(directory, "other-workspace");
    await fs.mkdir(path.join(other, ".batty"), { recursive: true });
    await fs.writeFile(
      path.join(other, ".batty", "mcp.json"),
      JSON.stringify({
        mcpServers: { test: { enabled: false }, local: { command: "does-not-exist" } },
      }),
    );
    await main.configure({ cwd: other }, BACKGROUND_CONTEXT);
    const second = JSON.parse((await inspect()).content[0].text);
    expect(first.catalog).toEqual(["mcp__test__echo"]);
    expect(second).toEqual(first);
    expect(second.result.cwd).toBe(directory);
    const status = await tools.mcp.getStatus();
    expect(status.servers.map((server) => server.name)).toEqual(["test"]);
    expect(status.servers[0]!.state).toBe("connected");
    await tools.mcp.removeServer("test");
    expect((await tools.mcp.catalog()).map((entry) => entry.tool.name)).toEqual([]);
  });

  it("keeps all non-hidden MCP tools inside codemode across reopen", async () => {
    const { directory, tools, main, faux, run, reopen } = await fixture(true);
    const server = path.join(directory, "modes.cjs");
    await fs.writeFile(
      server,
      `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};if(m.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}};if(m.method==='tools/list')result={tools:['direct','deferred','script','hidden'].map(name=>({name,description:name,inputSchema:{type:'object',properties:{}}}))};if(m.method==='tools/call')result={content:[{type:'text',text:m.params.name}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')})`,
    );
    await tools.mcp.setServer("modes", {
      command: process.execPath,
      args: [server],
      exposure: "codemode",
      toolExposure: { direct: "direct", deferred: "deferred", hidden: "hidden" },
    });
    const names = () =>
      main.agent(BACKGROUND_CONTEXT).then((agent) => agent.tools.map((tool) => tool.name));
    expect(await names()).not.toContain("tool_search");
    expect((await names()).filter((name) => name.startsWith("mcp__"))).toEqual([]);
    expect(await names()).not.toContain("mcp__modes__deferred");
    expect(await names()).not.toContain("mcp__modes__script");
    expect(await names()).not.toContain("mcp__modes__hidden");
    const declared = (request: any) => {
      const names = new Set<string>();
      for (const message of request.messages)
        if (message.role === "system") {
          for (const tool of message.toolsAdded ?? []) names.add(tool.name);
          for (const name of message.toolsRemoved ?? []) names.delete(name);
        }
      return [...names];
    };
    faux.setResponses([
      (request) => {
        expect(declared(request)).not.toContain("tool_search");
        expect(declared(request)).not.toContain("mcp__modes__direct");
        expect(declared(request)).not.toContain("mcp__modes__deferred");
        expect(declared(request)).not.toContain("mcp__modes__script");
        expect(declared(request)).not.toContain("mcp__modes__hidden");
        return fauxAssistantMessage(
          [
            fauxToolCall("codemode", {
              code: "return await Promise.all([tools.mcp__modes__direct({}), tools.mcp__modes__deferred({}), tools.mcp__modes__script({})])",
            }),
          ],
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage([fauxText("done")]),
    ]);
    expect(
      (
        await (
          await main.submit({ type: "input", content: "find deferred" }, BACKGROUND_CONTEXT)
        ).wait(BACKGROUND_CONTEXT)
      ).status,
    ).toBe("done");
    expect((await names()).filter((name) => name.startsWith("mcp__"))).toEqual([]);
    const view = await main.viewState(BACKGROUND_CONTEXT);
    const called = view.value.entries
      .flatMap((entry) => entry.model ?? [])
      .find((message) => message.role === "toolResult" && message.toolName === "codemode") as any;
    expect(called.isError).toBe(false);
    expect(called.content[0].text).toContain("direct");
    expect(called.content[0].text).toContain("deferred");
    expect(called.content[0].text).toContain("script");
    view.dispose();
    const discovered = await run(
      'return { names: (await searchTools("mcp__modes__")).map(tool=>tool.name).sort(), declaration: await describeTool("mcp__modes__deferred"), hidden: ALL_TOOLS.some(tool=>tool.name === "mcp__modes__hidden") }',
    );
    expect(discovered.content[0].text).toContain("mcp__modes__script");
    expect(discovered.content[0].text).toContain("mcp__modes__direct");
    expect(discovered.content[0].text).toContain("mcp__modes__deferred");
    expect(JSON.parse(discovered.content[0].text).hidden).toBe(false);
    const restored = await reopen();
    expect(
      (await restored.main.agent(BACKGROUND_CONTEXT)).tools.map((tool) => tool.name),
    ).not.toContain("mcp__modes__direct");
  });

  it("calls Streamable HTTP MCP and interrupts a spinning QuickJS script", async () => {
    const { tools, api, run } = await fixture();
    const server = http.createServer(async (request, response) => {
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      const message = JSON.parse(body);
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result: any = {};
      if (message.method === "initialize")
        result = {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "http-test", version: "1" },
        };
      if (message.method === "tools/list")
        result = { tools: [{ name: "answer", inputSchema: { type: "object", properties: {} } }] };
      if (message.method === "tools/call") result = { content: [{ type: "text", text: "42" }] };
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    });
    const address = server.address() as { port: number };
    await tools.mcp.setServer("http", {
      url: `http://127.0.0.1:${address.port}/mcp`,
      headers: { Authorization: "Bearer test" },
    });
    const codemode = tools.extension.tools!.find((tool) => tool.name === "codemode")!;
    const result = await run("return (await tools.mcp__http__answer({})).content[0].text");
    expect(result.isError).toBe(false);
    expect(result.content?.[0]).toEqual({ type: "text", text: "42" });
    const spinning = await run('// @options: {"timeout_ms": 50}\nwhile (true) {}');
    expect(spinning.isError).toBe(true);
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
            [fauxToolCall("subagent", { action: "run", async: true, prompt: "worker shell" })],
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
      'return await Promise.all([tools.subagent({action:"run",async:true,prompt:"first worker"}), tools.subagent({action:"run",async:true,prompt:"second worker"})])';
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
    const view = await main.viewState(BACKGROUND_CONTEXT);
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
    view.dispose();
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
      const view = await restarted.main.viewState(BACKGROUND_CONTEXT);
      const result = view.value.entries.findLast(
        (entry) =>
          entry.kind === "pi.tool-result" &&
          entry.model?.[0]?.role === "toolResult" &&
          entry.model[0].toolName === "codemode",
      )!.model![0] as any;
      expect(result.isError, JSON.stringify(result)).toBe(false);
      expect(result.content[0].text).toContain("original:finished");
      view.dispose();
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
