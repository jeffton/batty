import path from "node:path";
import { createMutationTool } from "./mutation-tools";
import {
  createBashToolDefinition,
  createPowerShellToolDefinition,
  getPowerShellConfig,
  createFindToolDefinition,
  createGrepToolDefinition,
  type ToolDefinition,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import {
  defineExtension,
  hook,
  GenerationTask,
  defineTool,
  section,
  type ToolRegistration,
  type ToolExecutionApi,
  type Harness,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import type { CodemodeSandbox } from "@earendil-works/pi-codemode";
import type { AppConfig } from "./config";
import { stateDirPath } from "./options";
import { listWorkspaces } from "./workspaces";
import { BrowserService } from "./browser-service";
import { closeSharedBrowser } from "./browser-runtime";
import { SshSocksProxy } from "./ssh-socks-proxy";
import {
  createAttachFilesTool,
  createBrowserTool,
  createSitesTool,
  createWebSearchTool,
} from "./custom-tools";
import { McpService } from "./mcp-service";
import { createCodemodeTool } from "./codemode";
import { persistentBashOperations } from "./durable-bash";
import { createBattyReadTool } from "./read-tool";
import { createCodemodeTasks } from "./codemode-tasks";
import { cancelPersistentBashJobs } from "./durable-bash-cancel";
import { createBashAbortWatcher } from "./tools-abort-watcher";
import { WorkerDoc } from "./orchestration";
import { MAIN_MEMORY_TOOLS } from "./main-memory-policy";
import { conversationPolicy } from "./conversation-policy";
import { createAttachArtifactsTool } from "./artifact-forwarding";

export async function toolCwd(api: ToolExecutionApi, ctx: Context): Promise<string> {
  const cwd = api.env?.cwd ?? (await api.agent(ctx)).cwd;
  if (!cwd) throw new Error("Tool requires a conversation working directory");
  return cwd;
}

export async function createTools(
  config: AppConfig,
  resolveExtraTools?: (
    api: ToolExecutionApi,
    ctx: Context,
  ) => Promise<readonly ToolRegistration[]> | readonly ToolRegistration[],
) {
  const browserService = new BrowserService(
    config.browserTailscaleSshDestination
      ? new SshSocksProxy(config.browserTailscaleSshDestination)
      : undefined,
    config.browserMaxTabs,
    path.join(stateDirPath(config.battyDir), "browser"),
  );
  const mcp = await McpService.create(config);
  const sandboxes = new Set<CodemodeSandbox>();
  const registered = new Map<string, ToolRegistration>();
  let harness: Harness | undefined;
  const guidelines = new Set<string>();
  const jobsDir = path.join(stateDirPath(config.battyDir), "jobs");
  const abortWatcher = createBashAbortWatcher(jobsDir);

  const bridge = (
    name: string,
    factory: (
      cwd: string,
      api: ToolExecutionApi,
    ) => Pick<ToolDefinition<any>, "name" | "description" | "parameters" | "execute">,
    replay: "safe" | "unsafe" = "unsafe",
  ) => {
    const metadata = factory(process.cwd(), {} as ToolExecutionApi);
    for (const guideline of (metadata as ToolDefinition<any>).promptGuidelines ?? [])
      guidelines.add(guideline);
    return defineTool({
      name,
      description: metadata.description,
      parameters: metadata.parameters,
      replay,
      execute: async (args, api, ctx) => {
        const cwd = await toolCwd(api, ctx);
        const definition = factory(cwd, api);
        const context = {
          cwd,
          signal: ctx.abortSignal,
          sessionManager: {
            getSessionId: () => String(api.conversationId),
            getSessionFile: () => `${api.conversationId}.jsonl`,
          },
        } as unknown as ExtensionToolContext;
        let streamed = "";
        const result = await definition.execute(
          api.callId,
          args,
          ctx.abortSignal,
          (partial) => {
            const text = partial.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n");
            if (text.startsWith(streamed)) api.output(text.slice(streamed.length));
            streamed = text;
          },
          context,
        );
        const wrapped = {
          output: result.content,
          isError: result.isError,
          ...(result.details === undefined
            ? {}
            : { details: JSON.parse(JSON.stringify(result.details)) }),
        };
        if (result.structuredContent !== undefined)
          mcp.rememberStructured(wrapped, result.structuredContent);
        return wrapped;
      },
    });
  };
  const native = [
    bridge("read", (cwd) => createBattyReadTool(cwd), "safe"),
    bridge("write", (cwd) => createMutationTool(cwd, "write")),
    bridge("edit", (cwd) => createMutationTool(cwd, "edit")),
    process.platform === "win32"
      ? bridge("powershell", (cwd) => {
          // The SDK also supports Windows PowerShell 5.1; Batty requires PowerShell 7.
          if (path.basename(getPowerShellConfig().shell).toLowerCase() !== "pwsh.exe")
            throw new Error("Batty requires PowerShell 7 (pwsh.exe) on PATH");
          return createPowerShellToolDefinition(cwd, { exposeSessionEnvironment: false });
        })
      : bridge(
          "bash",
          (cwd, api) =>
            createBashToolDefinition(cwd, {
              operations: persistentBashOperations(
                jobsDir,
                `${api.conversationId ?? "metadata"}-${api.taskId ?? "metadata"}-${api.callId ?? "metadata"}`,
              ),
              exposeSessionEnvironment: false,
            }),
          "safe",
        ),
    bridge("find", (cwd) => createFindToolDefinition(cwd), "safe"),
    bridge("grep", (cwd) => createGrepToolDefinition(cwd), "safe"),
  ];
  const scoped = (
    name: string,
    factory: (
      dependencies: any,
    ) => Pick<ToolDefinition<any>, "name" | "description" | "parameters" | "execute">,
    replay: "safe" | "unsafe" = "unsafe",
  ) => {
    const metadata = factory({
      config,
      browserService,
      workspace: { id: "metadata", path: process.cwd() },
    });
    for (const guideline of (metadata as ToolDefinition<any>).promptGuidelines ?? [])
      guidelines.add(guideline);
    return defineTool({
      name,
      description: metadata.description,
      parameters: metadata.parameters,
      replay,
      execute: async (args, api, ctx) => {
        const cwd = await toolCwd(api, ctx);
        const workspace = (await listWorkspaces(config)).find(
          (workspace) => cwd === workspace.path || cwd.startsWith(`${workspace.path}${path.sep}`),
        );
        if (!workspace) throw new Error(`No Batty workspace contains ${cwd}`);
        return bridge(
          name,
          () => factory({ config, browserService, workspace: { ...workspace, path: cwd } }),
          replay,
        ).execute(args, api, ctx);
      },
    });
  };
  const local: ToolRegistration[] = [
    ...native,
    createAttachArtifactsTool(),
    bridge("web_search", () => createWebSearchTool(config), "safe"),
    scoped("browser", createBrowserTool),
    scoped("sites", createSitesTool),
    scoped("attach_files", createAttachFilesTool, "safe"),
  ];
  const resolveTools = async (api: ToolExecutionApi, ctx: Context) => {
    const agent = await api.agent(ctx);
    const all = new Map(
      [
        ...local,
        ...agent.tools,
        ...registered.values(),
        ...((await resolveExtraTools?.(api, ctx)) ?? []),
        ...(await mcp.tools()),
      ].map((tool) => [tool.name, tool]),
    );
    const worker = await api.snapshot(WorkerDoc, api.conversationId, ctx);
    const isMain = harness && api.conversationId === (await harness.root(ctx)).id;
    return [...all.values()].filter(
      (tool) =>
        tool.name !== "memory_overview" &&
        (conversationPolicy(isMain ? "assistant" : "worker", worker?.workspaceId).mainMemory ||
          !MAIN_MEMORY_TOOLS.has(tool.name)),
    );
  };
  const nestedTask = createCodemodeTasks(resolveTools, mcp, jobsDir);
  local.push(
    createCodemodeTool(resolveTools, mcp, sandboxes, nestedTask, async (id, ctx) => {
      if (!harness)
        throw new Error("Tools must bindHarness() before cancelling nested codemode calls");
      await harness.abortTask(id, withoutAbortSignal(ctx));
    }),
  );
  const extension = defineExtension({
    name: "batty-tools",
    tools: local,
    tasks: [nestedTask],
    hooks: [
      hook(GenerationTask, {
        beforeRequest: (request) => ({
          messages: request.messages.map((message) =>
            message.role === "system"
              ? {
                  ...message,
                  toolsAdded: message.toolsAdded?.filter(
                    (tool) => tool.name !== "tool_search" && !tool.name.startsWith("mcp__"),
                  ),
                }
              : message,
          ),
        }),
      }),
    ],
    sections: [
      section("tool-guidelines", () =>
        [
          "Use read for files and images; explicit limit removes the read byte cap.",
          "Use edit for exact unique replacements, merging overlapping changes.",
          "Use codemode instead of separate tool calls for independent batching, dependent chaining, and filtering results before returning them. Batch independent work with Promise.allSettled so one failure does not discard successful results, e.g. const results = await Promise.allSettled([tools.read({path: '/path/a'}), tools.read({path: '/path/b'})]); for (const result of results) text(result.status === 'fulfilled' ? result.value : String(result.reason));",
          "MCP tools are available only through codemode. Discover tools with the awaited GLOBAL helpers: const matches = await searchTools('query'); text(matches); text(await describeTool(matches[0].name)); Do not use tools.searchTools or tools.describeTool. Nested tools return strings, except shell tools return {output, exit_code, truncated, wall_time_seconds, full_output_path?} and MCP calls return CallToolResult objects.",
          ...guidelines,
        ].join("\n"),
      ),
    ],
  });
  return {
    extension,
    mcp,
    browserService,
    bindHarness(value: Harness) {
      harness = value;
      abortWatcher.bind(value);
    },
    registerTools(tools: readonly ToolRegistration[]) {
      for (const tool of tools) registered.set(tool.name, tool);
    },
    async abortConversation(conversationId: number) {
      await cancelPersistentBashJobs(jobsDir, conversationId);
      await browserService.closeSession(String(conversationId));
    },
    async close() {
      await abortWatcher.close();
      await Promise.all([...sandboxes].map((sandbox) => sandbox.close()));
      await mcp.dispose();
      await browserService.dispose();
      await closeSharedBrowser();
    },
  };
}
