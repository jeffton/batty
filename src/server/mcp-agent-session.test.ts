import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createAgentSessionFixture } from "./agent-session-test-fixture";
import { battyMcpConfigPath, loadBattyMcpConfig } from "./mcp-settings";
import { getSessionMessagePage } from "./pi-service-message-page";

const fixtures: Awaited<ReturnType<typeof createAgentSessionFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

// A real child process, with stdout reserved exclusively for the MCP wire protocol.
const serverSource = `
import fs from 'node:fs';
import readline from 'node:readline';
fs.writeFileSync(process.env.PID_FILE, String(process.pid));
const send = (message) => process.stdout.write(JSON.stringify({jsonrpc: '2.0', ...message}) + '\\n');
let changed = false;
const tool = (name) => ({name, description: 'Fixture ' + name, inputSchema: {type: 'object', properties: {value: {type: 'string'}}, additionalProperties: false}});
readline.createInterface({input: process.stdin}).on('line', async (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result;
  switch (message.method) {
    case 'initialize':
      result = {protocolVersion: message.params.protocolVersion, capabilities: {tools: {listChanged: true}}, serverInfo: {name: 'batty-fixture', version: '1'}};
      break;
    case 'tools/list':
      result = {tools: (changed ? ['late', 'change'] : ['echo', 'direct', 'deferred', 'secret', 'change']).map(tool)};
      break;
    case 'tools/call': {
      const {name, arguments: args} = message.params;
      if (name === 'change') {
        changed = true;
        send({method: 'notifications/tools/list_changed'});
      }
      fs.appendFileSync(process.env.CALL_FILE, JSON.stringify({name, args}) + '\\n');
      if (args?.value === 'hold') {
        while (!fs.existsSync(process.env.CALL_FILE + '.release')) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
      result = {
        content: [{type: 'text', text: 'echoed'}, {type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6KAAAAABJRU5ErkJggg=='}],
        structuredContent: {name, value: args?.value, cwd: process.cwd(), marker: process.env.MARKER},
        _meta: {private: true}
      };
      break;
    }
    default:
      send({id: message.id, error: {code: -32601, message: 'Method not found'}});
      return;
  }
  send({id: message.id, result});
});
`;

function toolCall(name: string, args: Record<string, string>) {
  return fauxAssistantMessage([{ type: "toolCall", id: "outer-call", name, arguments: args }]);
}

async function setup(extensionFactories: ExtensionFactory[] = [], workspaceOverride = false) {
  const fixture = await createAgentSessionFixture({
    extensionFactories,
    prepare: async (root, config) => {
      await fs.writeFile(path.join(root, "server.mjs"), serverSource);
      await fs.mkdir(path.join(root, "launch"));
      const server = {
        command: process.execPath,
        args: [path.join(root, "server.mjs")],
        cwd: "launch",
        env: {
          PID_FILE: path.join(root, "server.pid"),
          CALL_FILE: path.join(root, "calls.jsonl"),
          MARKER: "global",
        },
        toolExposure: { direct: "direct", deferred: "deferred", secret: "hidden" },
      };
      await fs.writeFile(
        battyMcpConfigPath(config),
        JSON.stringify({ mcpServers: { srv: server } }),
      );
      if (workspaceOverride) {
        await fs.mkdir(path.join(root, ".batty"), { recursive: true });
        await fs.writeFile(
          path.join(root, ".batty", "mcp.json"),
          JSON.stringify({
            mcpServers: { srv: { ...server, env: { ...server.env, MARKER: "workspace" } } },
          }),
        );
      }
    },
  });
  fixtures.push(fixture);
  return fixture;
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return false;
  }
}

async function runCode(fixture: Awaited<ReturnType<typeof setup>>, code: string) {
  fixture.faux.setResponses([toolCall("codemode", { code }), fauxAssistantMessage("done")]);
  await fixture.session.prompt("run the fixture script");
  return fixture.session.messages.filter((message) => message.role === "toolResult").at(-1)!;
}

describe("native MCP in Batty AgentSession", () => {
  it("discovers codemode tools, forwards structured results/images, and preserves nested host effects", async () => {
    const calls: unknown[] = [];
    const results: unknown[] = [];
    const observer: ExtensionFactory = (pi) => {
      pi.on("tool_call", (event) => {
        calls.push(event);
      });
      pi.on("tool_result", (event) => {
        results.push(event);
      });
    };
    const fixture = await setup([observer], true);
    const { root, session, config } = fixture;
    expect(loadBattyMcpConfig(config, root, false).servers[0]?.config).toMatchObject({
      env: { MARKER: "global" },
    });
    expect(loadBattyMcpConfig(config, root, true).servers[0]?.config).toMatchObject({
      env: { MARKER: "workspace" },
    });
    const result = await runCode(
      fixture,
      `
      text(ALL_TOOLS.filter(t => t.name.startsWith('mcp__srv__')).map(t => t.name));
      text(await searchTools('Fixture echo'));
      text(await describeTool('mcp__srv__echo'));
      const result = await tools.mcp__srv__echo({value: 'native'});
      text(result.structuredContent);
      image(result.content[1]);
      await tools.write({path: 'nested.txt', content: 'completed host effect'});
    `,
    );
    expect(result).toMatchObject({
      isError: false,
      content: expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining('"marker":"workspace"'),
        }),
        expect.objectContaining({ type: "image", mimeType: "image/png" }),
      ]),
    });
    expect(JSON.stringify(result)).toContain(path.join(root, "launch"));
    expect(JSON.stringify(result)).toContain("mcp__srv__echo");
    expect(JSON.stringify(result)).not.toContain("mcp__srv__secret");
    expect(session.sdk.getActiveToolNames()).toContain("mcp__srv__direct");
    expect(session.sdk.getActiveToolNames()).not.toContain("mcp__srv__echo");
    expect(session.sdk.getActiveToolNames()).not.toContain("mcp__srv__deferred");
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolName: "mcp__srv__echo", parentToolCallId: "outer-call" }),
        expect.objectContaining({ toolName: "write", parentToolCallId: "outer-call" }),
      ]),
    );
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: "mcp__srv__echo",
          parentToolCallId: "outer-call",
          isError: false,
        }),
      ]),
    );
    expect(await fs.readFile(path.join(root, "nested.txt"), "utf8")).toBe("completed host effect");
    expect(getSessionMessagePage(session).messages.at(-1)).toMatchObject({
      battyFileChanges: [expect.objectContaining({ path: path.join(root, "nested.txt") })],
    });
    fixture.faux.setResponses([
      toolCall("tool_search", { query: "Fixture deferred" }),
      fauxAssistantMessage("loaded"),
    ]);
    await session.prompt("load deferred tools");
    expect(session.sdk.getActiveToolNames()).toContain("mcp__srv__deferred");
    const pid = Number(await fs.readFile(path.join(root, "server.pid"), "utf8"));
    expect(alive(pid)).toBe(true);
    await session.dispose();
    await expect.poll(() => alive(pid)).toBe(false);
  });

  it("reloads edited configuration, closes the old process, and adds/removes tools", async () => {
    const fixture = await setup();
    await runCode(fixture, "text(await tools.mcp__srv__echo({value: 'before'}));");
    const oldPid = Number(await fs.readFile(path.join(fixture.root, "server.pid"), "utf8"));
    const configPath = battyMcpConfigPath(fixture.config);
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    config.mcpServers = { replacement: config.mcpServers.srv };
    await fs.writeFile(configPath, JSON.stringify(config));
    await fixture.session.reloadResources();
    const result = await runCode(
      fixture,
      "text(ALL_TOOLS.filter(t => t.name.startsWith('mcp__'))); text(await tools.mcp__replacement__echo({value: 'after'}));",
    );
    expect(result).toMatchObject({ isError: false });
    expect(JSON.stringify(result)).toContain("mcp__replacement__echo");
    expect(JSON.stringify(result)).not.toContain("mcp__srv__echo");
    await expect.poll(() => alive(oldPid)).toBe(false);
    const replacementPid = Number(await fs.readFile(path.join(fixture.root, "server.pid"), "utf8"));
    expect(replacementPid).not.toBe(oldPid);
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: {} }));
    await fixture.session.reloadResources();
    await expect.poll(() => alive(replacementPid)).toBe(false);
    expect(fixture.session.sdk.getAllTools().some((tool) => tool.name.startsWith("mcp__"))).toBe(
      false,
    );
  });

  it("defers configuration reload until admitted nested calls have completed", async () => {
    const fixture = await setup();
    const running = runCode(
      fixture,
      "text(await tools.mcp__srv__echo({value: 'hold'})); await tools.write({path: 'settled.txt', content: 'completed'});",
    );
    const callPath = path.join(fixture.root, "calls.jsonl");
    await expect
      .poll(async () => {
        try {
          return await fs.readFile(callPath, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          return "";
        }
      })
      .toContain("hold");
    const pid = Number(await fs.readFile(path.join(fixture.root, "server.pid"), "utf8"));
    await fs.writeFile(battyMcpConfigPath(fixture.config), JSON.stringify({ mcpServers: {} }));
    await fixture.session.reloadResources();
    expect(alive(pid)).toBe(true);
    await fs.writeFile(`${callPath}.release`, "release");
    expect(await running).toMatchObject({ isError: false });
    await fixture.session.waitForIdle();
    expect(await fs.readFile(path.join(fixture.root, "settled.txt"), "utf8")).toBe("completed");
    await expect.poll(() => alive(pid)).toBe(false);
    expect(fixture.session.sdk.getAllTools().some((tool) => tool.name.startsWith("mcp__"))).toBe(
      false,
    );
  });

  it("applies tools/list_changed additions and withdrawals on subsequent admission", async () => {
    const fixture = await setup();
    const result = await runCode(fixture, "text(await tools.mcp__srv__change({}));");
    expect(result).toMatchObject({ isError: false });
    await expect
      .poll(() => fixture.session.sdk.getAllTools().map((tool) => tool.name))
      .toContain("mcp__srv__late");
    const next = await runCode(
      fixture,
      "text(ALL_TOOLS.filter(t => t.name.startsWith('mcp__srv__'))); text(await tools.mcp__srv__late({value: 'new'}));",
    );
    expect(next).toMatchObject({ isError: false });
    expect(JSON.stringify(next)).toContain("mcp__srv__late");
    expect(JSON.stringify(next)).not.toContain("mcp__srv__echo");
    expect(fixture.session.sdk.getActiveToolNames()).not.toContain("mcp__srv__direct");
    const rejected = await runCode(fixture, "await tools.mcp__srv__echo({value: 'withdrawn'});");
    expect(rejected).toMatchObject({ isError: true });
    const calls = await fs.readFile(path.join(fixture.root, "calls.jsonl"), "utf8");
    expect(calls).not.toContain("withdrawn");
  });
});
