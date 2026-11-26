// @vitest-environment node
import { describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxToolCall, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { stateDirPath } from "./options";
import { withoutMainMemory } from "./main-memory-policy";
import { piShellToolNameForPlatform } from "../shared/pi-tools";
import { createToolsTestFixture } from "./tools-test-fixture";

const shellName = piShellToolNameForPlatform(process.platform);
const shellPrint = process.platform === "win32" ? "Write-Output" : "printf";
const { fixture, cleanups } = createToolsTestFixture();

describe("durable tool bridge", () => {
  it("returns structured web search results and declares both output contracts", async () => {
    const { config, run } = await fixture();
    config.braveSearchKey = "test-key";
    const fetchMock = vi.spyOn(globalThis, "fetch");
    cleanups.push(async () => fetchMock.mockRestore());
    fetchMock.mockResolvedValueOnce(
      Response.json({
        web: {
          results: [
            {
              title: "Example",
              url: "https://example.com/page",
              description: "Snippet",
              age: "1d",
            },
          ],
        },
      }),
    );
    const result = await run(
      'return { data: await tools.web_search({action:"search", query:"example", country:"dk", freshness:"pw"}), declaration: await describeTool("web_search") };',
    );
    expect(result.isError).toBe(false);
    const { data, declaration } = JSON.parse(result.content[0].text);
    expect(data).toEqual({
      action: "search",
      query: "example",
      count: 5,
      country: "DK",
      freshness: "pw",
      includeContent: false,
      results: [
        { title: "Example", link: "https://example.com/page", snippet: "Snippet", age: "1d" },
      ],
    });
    expect(declaration).toContain('action: "search"');
    expect(declaration).toContain('action: "content"');
    expect(declaration).toContain("results:");
    expect(declaration).toContain("content:");
    fetchMock.mockResolvedValueOnce(Response.json({ web: { results: [] } }));
    const empty = await run(
      'return (await tools.web_search({action:"search", query:"empty"})).results;',
    );
    expect(empty.isError).toBe(false);
    expect(JSON.parse(empty.content[0].text)).toEqual([]);
  });

  it("keeps page failure text in structured content and rejects Brave failures", async () => {
    const { config, run } = await fixture();
    config.braveSearchKey = "test-key";
    const fetchMock = vi.spyOn(globalThis, "fetch");
    cleanups.push(async () => fetchMock.mockRestore());
    fetchMock.mockResolvedValueOnce(
      new Response("server error", { status: 500, statusText: "Failure" }),
    );
    const page = await run(
      'return await tools.web_search({action:"content", url:"https://example.com/page"});',
    );
    expect(page.isError).toBe(false);
    expect(JSON.parse(page.content[0].text)).toEqual({
      action: "content",
      url: "https://example.com/page",
      content: "(HTTP 500: Failure)",
    });
    fetchMock.mockResolvedValueOnce(
      new Response("Brave error body", { status: 500, statusText: "Failure" }),
    );
    const search = await run('return await tools.web_search({action:"search", query:"example"});');
    expect(search.isError).toBe(true);
    expect(JSON.stringify(search)).toContain("Brave error body");
  });

  it.each(["search", "content"] as const)(
    "retains in-body headings that match part of the page title in codemode %s results",
    async (action) => {
      const { config, run } = await fixture();
      config.braveSearchKey = "test-key";
      const url = "https://example.com/newsletter";
      const fetchMock = vi.spyOn(globalThis, "fetch");
      cleanups.push(async () => fetchMock.mockRestore());
      if (action === "search") {
        fetchMock.mockResolvedValueOnce(
          Response.json({ web: { results: [{ title: "Newsletter", url }] } }),
        );
      }
      const paragraph = "The newsletter covers several different topics in independent sections. ";
      fetchMock.mockResolvedValueOnce(
        new Response(
          `<!doctype html><title>Weather, Coastal Flooding and Local News</title>
           <nav><h2>Navigation heading</h2><a href="/archive">Archive</a></nav>
           <table role="presentation"><tr><td>
             <h1>Tomorrow's Weather Forecast</h1><p>${paragraph.repeat(8)}</p>
             <h1>Coastal Flooding</h1><p>${paragraph.repeat(8)}</p>
             <h2>Local News</h2><p>${paragraph.repeat(8)}Ending marker.</p>
           </td></tr></table>`,
          { headers: { "content-type": "text/html" } },
        ),
      );
      const params =
        action === "search"
          ? { action, query: "newsletter", includeContent: true }
          : { action, url };
      const result = await run(`
        const data = await tools.web_search(${JSON.stringify(params)});
        return data.action === "search" ? data.results[0].content : data.content;
      `);
      expect(result.isError).toBe(false);
      const content = result.content[0].text;
      expect(content.match(/^#{1,2} .+$/gm)).toEqual([
        "# Weather, Coastal Flooding and Local News",
        "## Tomorrow's Weather Forecast",
        "## Coastal Flooding",
        "## Local News",
      ]);
      expect(content).toMatch(/Ending marker\.$/);
      expect(content).not.toContain("Navigation heading");
      expect(content).not.toContain("Archive");
    },
  );

  it.each(["search", "content"] as const)(
    "preserves full %s page data through codemode while spilling model-facing text",
    async (action) => {
      const { config, run } = await fixture();
      config.braveSearchKey = "test-key";
      const content =
        "Challenge: verify you are human\\n" + "unfiltered page text\\n".repeat(3000) + "END";
      const fetchMock = vi.spyOn(globalThis, "fetch");
      cleanups.push(async () => fetchMock.mockRestore());
      if (action === "search") {
        fetchMock.mockResolvedValueOnce(
          Response.json({ web: { results: [{ title: "Page", url: "https://example.com/page" }] } }),
        );
      }
      fetchMock.mockResolvedValueOnce(
        new Response(content, { headers: { "content-type": "text/plain" } }),
      );
      const params =
        action === "search"
          ? { action, query: "example", includeContent: true }
          : { action, url: "https://example.com/page" };
      const result = await run(`
        const data = await tools.web_search(${JSON.stringify(params)});
        const content = data.action === "search" ? data.results[0].content : data.content;
        return { action: data.action, url: data.url, length: content.length, start: content.slice(0, 35), end: content.slice(-3) };
      `);
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.content[0].text)).toEqual({
        action,
        ...(action === "content" ? { url: "https://example.com/page" } : {}),
        length: content.length,
        start: content.slice(0, 35),
        end: "END",
      });
      const details = result.details.calls[0].details;
      expect(details.truncated).toBe(true);
      expect(details.content).toBeUndefined();
      if (action === "search") expect(details.results[0].content).toBeUndefined();
      const fullText = await fs.readFile(details.fullOutputPath, "utf8");
      expect(fullText).toContain(content);
      cleanups.push(() =>
        fs.rm(path.dirname(details.fullOutputPath), { recursive: true, force: true }),
      );
    },
  );

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
      'return { names: (await searchTools("import_files", {namespace: "import_"})).map(tool => tool.name).sort(), declaration: await describeTool("web_search") }',
    );
    expect(discovered.isError).toBe(false);
    expect(JSON.parse(discovered.content[0].text)).toMatchObject({
      names: ["import_files"],
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
    const obsoleteInvocation = await run('return await tools["attach_files"]({paths: []})');
    expect(obsoleteInvocation.isError).toBe(true);
    expect(obsoleteInvocation.details.calls).toEqual([]);
  });

  it("passes the single message selection contract to the model", async () => {
    const { faux, main } = await fixture();
    faux.setResponses([
      (request) => {
        const prompt = JSON.stringify(
          request.messages.filter((message) => message.role === "system"),
        );
        expect(prompt.match(/<batty-attachments>/g)).toHaveLength(1);
        expect(prompt).toContain("import_files or sites action=create");
        expect(prompt).toContain('action:\\"report\\"');
        expect(prompt).not.toMatch(/attach_artifacts|attach_files/);
        return fauxAssistantMessage("prompt checked");
      },
    ]);
    const result = await (
      await main.submit({ type: "input", content: "Deliver a file" }, BACKGROUND_CONTEXT)
    ).wait(BACKGROUND_CONTEXT);
    expect(result.status).toBe("done");
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
  it.each(["memory_search", "memory_date"])(
    "keeps %s text out of project context",
    async (name) => {
      const { tools, run } = await fixture();
      tools.registerTools([
        {
          name,
          description: "main-memory text",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async () => ({ output: [{ type: "text", text: "private memory text" }] }),
        },
      ]);
      const result = await run(`text(await tools.${name}({}));`);
      expect(result.isError).toBe(false);
      expect(result.content).toEqual([{ type: "text", text: "private memory text" }]);
      expect(withoutMainMemory([result])).toEqual([]);
    },
  );
  it.each([
    ["text", 'text(await tools.read({path: "drawing.png"}));'],
    ["return", 'return await tools.read({path: "drawing.png"});'],
    ["ignored", 'await tools.read({path: "drawing.png"});'],
    ["later failure", 'await tools.read({path: "drawing.png"}); throw new Error("after read");'],
    ["obsolete image wrapper", 'image(await tools.read({path: "drawing.png"}));'],
  ])("forwards image reads once with %s and keeps base64 out of text", async (mode, code) => {
    const { directory, run } = await fixture();
    const sharp = (await import("sharp")).default;
    await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } })
      .png()
      .toFile(path.join(directory, "drawing.png"));
    const result = await run(code);
    expect(result.isError).toBe(mode === "later failure" || mode === "obsolete image wrapper");
    const images = result.content.filter((block: any) => block.type === "image");
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ mimeType: "image/png", data: expect.any(String) });
    const text = result.content
      .filter((block: any) => block.type === "text")
      .map((block: any) => block.text)
      .join("\n");
    expect(text).not.toContain(images[0].data);
    if (mode === "text" || mode === "return") expect(text).toBe("Read image file [image/png]");
    if (mode === "ignored") expect(result.content).toEqual(images);
    if (mode === "later failure") expect(text).toContain("after read");
    if (mode === "obsolete image wrapper") expect(text).toContain("image");
  });

  it("declares image read notes as strings and preserves ordinary text reads", async () => {
    const { directory, run } = await fixture();
    await fs.writeFile(path.join(directory, "task.txt"), "ordinary text");
    const result = await run(
      'return {value: await tools.read({path: "task.txt"}), declaration: await describeTool("read")};',
    );
    expect(result.isError).toBe(false);
    const { value, declaration } = JSON.parse(result.content[0].text);
    expect(value).toBe("ordinary text");
    expect(declaration).toContain("Promise<string>");
    expect(declaration).toContain("automatically forward the image");
  });

  it("preserves explicit image helper output without automatically repeating it", async () => {
    const { run } = await fixture();
    const sharp = (await import("sharp")).default;
    const data = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } })
      .png()
      .toBuffer();
    const image = { type: "image", mimeType: "image/png", data: data.toString("base64") };
    const result = await run(`image(${JSON.stringify(image)});`);
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([image]);
  });

  it("isolates memory-derived image reads while retaining independent image reads", async () => {
    const { directory, tools, run } = await fixture();
    const sharp = (await import("sharp")).default;
    await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } })
      .png()
      .toFile(path.join(directory, "drawing.png"));
    tools.registerTools([
      {
        name: "memory_zoom",
        description: "main-memory image path",
        parameters: Type.Object({}),
        replay: "safe",
        execute: async () => ({ output: [{ type: "text", text: "drawing.png" }] }),
      },
    ]);
    const independent = await run(
      'await Promise.all([tools.read({path: "drawing.png"}), tools.memory_zoom({})]);',
    );
    expect(independent.isError).toBe(false);
    const image = independent.content.find((block: any) => block.type === "image");
    expect(image).toBeDefined();
    expect(withoutMainMemory([independent])[0]).toMatchObject({ content: [image] });
    const derived = await run("await tools.read({path: await tools.memory_zoom({})});");
    expect(derived.isError).toBe(false);
    expect(derived.content.filter((block: any) => block.type === "image")).toHaveLength(1);
    expect(withoutMainMemory([derived])).toEqual([]);
  });

  it("forwards leaf-zoom images through codemode without leaking them to project context", async () => {
    const { tools, run } = await fixture();
    const image = { type: "image" as const, mimeType: "image/png", data: "cHJpdmF0ZQ==" };
    tools.registerTools([
      {
        name: "memory_zoom",
        description: "main-memory leaf with image",
        parameters: Type.Object({}),
        replay: "safe",
        execute: async () => ({
          output: [{ type: "text", text: "archived screenshot" }, image],
        }),
      },
    ]);
    const result = await run("text(await tools.memory_zoom({}));");
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "archived screenshot" }, image]);
    expect(withoutMainMemory([result])).toEqual([]);
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
    expect(second.result.cwd).toBe(await fs.realpath(directory));
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
    const view = await main.watch(BACKGROUND_CONTEXT);
    const called = view.value.entries
      .flatMap((entry) => entry.model ?? [])
      .find((message) => message.role === "toolResult" && message.toolName === "codemode") as any;
    expect(called.isError).toBe(false);
    expect(called.content[0].text).toContain("direct");
    expect(called.content[0].text).toContain("deferred");
    expect(called.content[0].text).toContain("script");
    view.stop();
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
});
