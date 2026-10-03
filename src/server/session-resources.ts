import { dirname } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { runToolCall, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { JsonObject, ToolCall, Usage } from "@earendil-works/pi-ai";
import {
  buildSystemPrompt,
  createSyntheticSourceInfo,
  ExtensionRunner,
  ModelRegistry,
  wrapRegisteredTools,
  type BuildSystemPromptOptions,
  type ExtensionActions,
  type ExtensionContextActions,
  type ExtensionCommandContextActions,
  type ModelRuntime,
  type RegisteredTool,
  type ResourceLoader,
  type SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

type Outcome = Awaited<ReturnType<typeof runToolCall>>;
type Update = NonNullable<Parameters<typeof runToolCall>[1]["onUpdate"]>;
type NestedEvent = Extract<
  Parameters<ExtensionRunner["emit"]>[0],
  { type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end" }
>;

/** App operations are bound after construction, before session_start. No execution engine is owned here. */
export interface SessionResourceCallbacks {
  actions: Omit<
    ExtensionActions,
    | "getActiveTools"
    | "getAllTools"
    | "getSettings"
    | "setActiveTools"
    | "refreshTools"
    | "getCommands"
  >;
  context: Omit<
    ExtensionContextActions,
    | "getSystemPrompt"
    | "getSystemPromptOptions"
    | "executeTool"
    | "getCallableTools"
    | "isProjectTrusted"
  >;
  getMessages: () => AgentMessage[];
  emit?: (event: NestedEvent) => void | Promise<void>;
  commands?: ExtensionCommandContextActions;
  toolsChanged?: () => void | Promise<void>;
}

export interface SessionResourcesOptions {
  cwd: string;
  store: ConstructorParameters<typeof ExtensionRunner>[3];
  resourceLoader: ResourceLoader;
  settingsManager: SettingsManager;
  modelRuntime: ModelRuntime;
  tools: ToolDefinition<any>[];
  activeToolNames?: string[];
  toolExecution?: "sequential" | "parallel";
  onError?: Parameters<ExtensionRunner["onError"]>[0];
}

interface NestedReceipt {
  id: string;
  name: string;
  status: "unfinished" | "ok" | "error";
  arguments?: JsonObject;
  argumentsBytes?: number;
  durationMs?: number;
  error?: string;
  output?: string;
}
interface NestedRecord {
  calls: NestedReceipt[];
  complete: boolean;
  argumentBytes: number;
  usage?: Usage;
}
export type NestedCalls = { calls: NestedReceipt[]; complete: boolean };
interface ToolInvocation {
  scopes: Map<string, NestedScope>;
  recordArtifacts?: (nestedCallId: string, details: unknown) => Promise<void>;
  onNestedUpdate?: (nestedCalls: NestedCalls) => void | Promise<void>;
}
interface ExecuteToolOptions {
  signal?: AbortSignal;
  onUpdate?: Update;
  prepared?: boolean;
  parentToolCallId?: string;
  recordArtifacts?: (nestedCallId: string, details: unknown) => Promise<void>;
  onNestedUpdate?: (nestedCalls: NestedCalls) => void | Promise<void>;
}
interface NestedScope {
  record: NestedRecord;
  nextId: number;
  holdsQueue: boolean;
}

/** Standalone resource and extension host shared by Durable sessions and command-only MCP management. */
export class SessionResources {
  readonly resourceLoader: ResourceLoader;
  readonly settingsManager: SettingsManager;
  readonly modelRuntime: ModelRuntime;
  readonly modelRegistry: ModelRegistry;
  readonly toolExecution: "sequential" | "parallel";
  extensionRunner: ExtensionRunner;
  private callbacks?: SessionResourceCallbacks;
  private definitions = new Map<string, RegisteredTool>();
  private executables = new Map<string, AgentTool>();
  private active: AgentTool[] = [];
  private hidden = new Set<string>();
  private pending = new Set<string>();
  private invocation = new AsyncLocalStorage<ToolInvocation>();
  private queueTail = Promise.resolve();
  private operations = new Set<Promise<void>>();
  private operationErrors: unknown[] = [];

  constructor(private readonly options: SessionResourcesOptions) {
    this.resourceLoader = options.resourceLoader;
    this.settingsManager = options.settingsManager;
    this.modelRuntime = options.modelRuntime;
    this.modelRegistry = new ModelRegistry(options.modelRuntime);
    this.toolExecution = options.toolExecution ?? "parallel";
    this.extensionRunner = this.createRunner();
    const extensionDefaults = this.extensionRunner
      .getAllRegisteredTools()
      .filter(
        ({ definition }) =>
          definition.defaultActive !== false &&
          (definition.exposure === undefined ||
            definition.exposure === "direct" ||
            definition.exposure === "model-only"),
      )
      .map(({ definition }) => definition.name);
    this.refreshRegistry([
      ...(options.activeToolNames ?? options.tools.map((tool) => tool.name)),
      ...extensionDefaults,
    ]);
  }

  private createRunner() {
    const loaded = this.resourceLoader.getExtensions();
    const runner = new ExtensionRunner(
      loaded.extensions,
      loaded.runtime,
      this.options.cwd,
      this.options.store,
      this.modelRegistry,
    );
    runner.onError(
      this.options.onError ??
        ((error) => {
          throw new Error(`${error.extensionPath}: ${error.event}: ${error.error}`);
        }),
    );
    runner.setUIContext(undefined, "rpc");
    return runner;
  }

  /** Observe async app operations started by synchronous extension APIs. */
  trackOperation(operation: unknown): void {
    if (!operation || typeof (operation as Promise<unknown>).then !== "function") return;
    const pending = Promise.resolve(operation)
      .then(
        () => {},
        (error) => {
          this.operationErrors.push(error);
        },
      )
      .finally(() => {
        this.operations.delete(pending);
      });
    this.operations.add(pending);
  }
  async flushOperations(): Promise<void> {
    while (this.operations.size) await Promise.all(this.operations);
    if (this.operationErrors.length)
      throw new AggregateError(this.operationErrors.splice(0), "Extension operations failed");
  }
  getActiveToolNames() {
    return this.activeToolNames;
  }
  getCallableToolNames() {
    return this.callableToolNames;
  }

  get model() {
    return this.callbacks?.context.getModel();
  }
  get isStreaming() {
    return !(this.callbacks?.context.isIdle() ?? true);
  }
  get promptTemplates() {
    return this.resourceLoader.getPrompts().prompts;
  }
  get regularToolNames() {
    return [...this.definitions.keys()].filter((name) => this.exposure(name) === "direct");
  }
  get activeToolNames() {
    return this.active.map((tool) => tool.name);
  }
  get callableToolNames() {
    return this.callableTools.map((tool) => tool.name);
  }
  get declaredTools() {
    return this.active.filter((tool) => !this.hidden.has(tool.name));
  }
  get callableTools() {
    const active = new Set(this.activeToolNames);
    return [...this.executables.values()].filter((tool) => {
      const exposure = this.exposure(tool.name);
      return (
        exposure === "codemode" ||
        exposure === "deferred" ||
        (exposure === "direct" && active.has(tool.name))
      );
    });
  }
  getAllTools(): ReturnType<ExtensionActions["getAllTools"]> {
    return [...this.definitions.values()].map(({ definition, sourceInfo }) => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      promptGuidelines: definition.promptGuidelines,
      exposure: definition.exposure ?? "direct",
      ...(definition.namespace ? { namespace: definition.namespace } : {}),
      ...(definition.annotations ? { annotations: definition.annotations } : {}),
      sourceInfo,
    }));
  }
  getToolDefinition(name: string) {
    return this.definitions.get(name)?.definition;
  }
  get systemPromptOptions(): BuildSystemPromptOptions {
    return {
      cwd: this.options.cwd,
      skills: this.resourceLoader.getSkills().skills,
      contextFiles: this.resourceLoader.getAgentsFiles().agentsFiles,
      customPrompt: this.resourceLoader.getSystemPrompt(),
      appendSystemPrompt: this.resourceLoader.getAppendSystemPrompt().join("\n\n"),
      selectedTools: this.activeToolNames,
      toolSnippets: Object.fromEntries(
        [...this.definitions.values()].flatMap(({ definition }) =>
          definition.promptSnippet && !this.hidden.has(definition.name)
            ? [[definition.name, definition.promptSnippet.replace(/\s+/g, " ").trim()]]
            : [],
        ),
      ),
      toolGuidelines: Object.fromEntries(
        [...this.definitions.values()].map(({ definition }) => [
          definition.name,
          [
            ...new Set(
              (definition.promptGuidelines ?? []).map((text) => text.trim()).filter(Boolean),
            ),
          ],
        ]),
      ),
    };
  }
  get systemPrompt() {
    return buildSystemPrompt(this.systemPromptOptions);
  }

  bind(callbacks: SessionResourceCallbacks) {
    this.callbacks = callbacks;
    this.extensionRunner.bindCore(
      {
        ...callbacks.actions,
        sendMessage: (...args) => {
          this.trackOperation(callbacks.actions.sendMessage(...args));
        },
        sendUserMessage: (...args) => {
          this.trackOperation(callbacks.actions.sendUserMessage(...args));
        },
        appendEntry: (...args) => {
          this.trackOperation(callbacks.actions.appendEntry(...args));
        },
        setSessionName: (...args) => {
          this.trackOperation(callbacks.actions.setSessionName(...args));
        },
        setLabel: (...args) => {
          this.trackOperation(callbacks.actions.setLabel(...args));
        },
        setThinkingLevel: (...args) => {
          this.trackOperation(callbacks.actions.setThinkingLevel(...args));
        },
        getActiveTools: () => this.activeToolNames,
        getAllTools: () => this.getAllTools(),
        getSettings: () => this.settingsManager.getSettings(),
        setActiveTools: (names) => {
          this.applyLoadout(names);
        },
        refreshTools: () => {
          this.refreshRegistry();
        },
        getCommands: () => [
          ...this.extensionRunner.getRegisteredCommands().map((command) => ({
            name: command.name,
            description: command.description,
            source: "extension" as const,
            sourceInfo: command.sourceInfo,
          })),
          ...this.promptTemplates.map((prompt) => ({
            name: prompt.name,
            description: prompt.description,
            source: "prompt" as const,
            sourceInfo: prompt.sourceInfo,
          })),
          ...this.resourceLoader.getSkills().skills.map((skill) => ({
            name: `skill:${skill.name}`,
            description: skill.description,
            source: "skill" as const,
            sourceInfo: skill.sourceInfo,
          })),
        ],
      },
      {
        ...callbacks.context,
        isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
        getSystemPrompt: () => this.systemPrompt,
        getSystemPromptOptions: () => this.systemPromptOptions,
        executeTool: (callerId, name, args, options) =>
          this.executeNested(callerId, name, args, options),
        getCallableTools: () => this.callableTools,
      },
      {
        registerProvider: (name, config) => this.modelRuntime.registerProvider(name, config),
        registerNativeProvider: (provider) => this.modelRuntime.registerNativeProvider(provider),
        unregisterProvider: (name) => this.modelRuntime.unregisterProvider(name),
        registerVirtualModel: (definition) => this.modelRuntime.registerVirtualModel(definition),
        unregisterVirtualModel: (provider, id) =>
          this.modelRuntime.unregisterVirtualModel(provider, id),
      },
    );
    this.extensionRunner.bindCommandContext(callbacks.commands);
    this.applyLoadout([...this.activeToolNames, ...this.pending]);
  }

  async start(reason: "startup" | "reload" | "resume" = "startup") {
    if (!this.callbacks) throw new Error("Bind SessionResources before session_start");
    await this.extensionRunner.emit({ type: "session_start", reason });
    this.extensionRunner.reportUnhandledMcpServers();
    if (this.extensionRunner.hasHandlers("resources_discover")) {
      const discovered = await this.extensionRunner.emitResourcesDiscover(
        this.options.cwd,
        reason === "reload" ? "reload" : "startup",
      );
      const resourcePaths = (entries: { path: string; extensionPath: string }[]) =>
        entries.map(({ path, extensionPath }) => ({
          path,
          metadata: {
            source: extensionPath,
            scope: "temporary" as const,
            origin: "top-level" as const,
            baseDir:
              extensionPath.startsWith("<") || extensionPath.startsWith("builtin:")
                ? undefined
                : dirname(extensionPath),
          },
        }));
      this.resourceLoader.extendResources({
        skillPaths: resourcePaths(discovered.skillPaths),
        promptPaths: resourcePaths(discovered.promptPaths),
        themePaths: resourcePaths(discovered.themePaths),
      });
    }
    await this.refreshTools();
  }
  async reload() {
    await this.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
    this.extensionRunner.invalidate();
    await this.resourceLoader.reload();
    this.extensionRunner = this.createRunner();
    const callbacks = this.callbacks;
    this.callbacks = undefined;
    this.refreshRegistry(this.activeToolNames);
    if (callbacks) this.bind(callbacks);
    await this.start("reload");
  }
  async dispose() {
    await this.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    await this.flushOperations();
    this.extensionRunner.invalidate();
  }
  async setActiveToolsByName(names: string[]) {
    this.applyLoadout(names);
    await this.flushOperations();
  }
  async refreshTools() {
    this.refreshRegistry();
    await this.flushOperations();
  }

  private exposure(name: string) {
    return this.definitions.get(name)?.definition.exposure ?? "direct";
  }
  private refreshRegistry(initialNames?: string[]) {
    const previous = new Set(this.definitions.keys());
    const names = initialNames ?? this.activeToolNames;
    const definitions = this.options.tools.map((definition) => ({
      definition,
      sourceInfo: createSyntheticSourceInfo(`<batty:${definition.name}>`, { source: "sdk" }),
    }));
    // Extensions may replace configured definitions; first extension registration wins.
    this.definitions = new Map(
      [...definitions, ...this.extensionRunner.getAllRegisteredTools()].map((tool) => [
        tool.definition.name,
        tool,
      ]),
    );
    this.executables = new Map(
      wrapRegisteredTools([...this.definitions.values()], this.extensionRunner).map((tool) => [
        tool.name,
        tool,
      ]),
    );
    if (!initialNames)
      for (const name of this.definitions.keys()) {
        if (
          !previous.has(name) &&
          this.getToolDefinition(name)?.defaultActive !== false &&
          (this.exposure(name) === "direct" || this.exposure(name) === "model-only")
        )
          names.push(name);
      }
    this.applyLoadout([...names, ...this.pending]);
  }
  private applyLoadout(names: string[]) {
    const previous = this.activeToolNames;
    this.pending = new Set(names.filter((name) => !this.executables.has(name)));
    const active = [...new Set(names)].flatMap((name) => {
      const tool = this.executables.get(name);
      return tool && this.exposure(name) !== "hidden" ? [tool] : [];
    });
    const activeNames = new Set(active.map((tool) => tool.name));
    const callable = [...this.executables.values()].filter(
      (tool) =>
        this.exposure(tool.name) === "codemode" ||
        this.exposure(tool.name) === "deferred" ||
        (this.exposure(tool.name) === "direct" && activeNames.has(tool.name)),
    );
    const loadout = {
      declared: active,
      callable,
      registered: [...this.executables.values()],
      getExposure: (name: string) => this.exposure(name),
      getNamespace: (name: string) => this.getToolDefinition(name)?.namespace,
    };
    const descriptions = new Map<string, string>();
    this.hidden = new Set();
    for (const tool of this.callbacks ? active : []) {
      const changes = this.getToolDefinition(tool.name)?.prepareLoadout?.(loadout);
      for (const [name, description] of Object.entries(changes?.descriptions ?? {}))
        descriptions.set(name, description);
      for (const name of changes?.hiddenDeclarations ?? []) this.hidden.add(name);
    }
    this.active = active.map((tool) =>
      descriptions.has(tool.name) ? { ...tool, description: descriptions.get(tool.name)! } : tool,
    );
    if (previous.some((name) => !activeNames.has(name))) this.pending.clear();
    this.trackOperation(this.callbacks?.toolsChanged?.());
  }

  async executeTool(
    toolCall: ToolCall,
    options: ExecuteToolOptions = {},
  ): Promise<Outcome & { nestedCalls?: NestedCalls }> {
    const invocation = this.invocation.getStore();
    if (options.parentToolCallId) {
      if (!invocation) throw new Error("Nested tool execution requires an outer invocation");
      return this.runTool(toolCall, options, invocation);
    }
    // Each execution owns its scope and artifact callback, even when call IDs are reused.
    return this.invocation.run(
      {
        scopes: new Map(),
        recordArtifacts: options.recordArtifacts,
        onNestedUpdate: options.onNestedUpdate,
      },
      async () => {
        const current = this.invocation.getStore()!;
        const outcome = await this.runTool(toolCall, options, current);
        return { ...outcome, nestedCalls: this.takeNestedCalls(toolCall.id, current) };
      },
    );
  }

  private async runTool(
    toolCall: ToolCall,
    options: ExecuteToolOptions,
    invocation: ToolInvocation,
  ): Promise<Outcome> {
    if (!this.callbacks) throw new Error("Bind SessionResources before executing tools");
    const messages = this.callbacks.getMessages();
    const assistantMessage = messages.findLast((message) => message.role === "assistant");
    if (!assistantMessage) throw new Error("No assistant message issued this tool call");
    const tools = options.parentToolCallId ? this.callableTools : this.active;
    const outcome = await runToolCall(toolCall, {
      tools: options.prepared
        ? tools.map((tool) => ({ ...tool, prepareArguments: undefined }))
        : tools,
      assistantMessage,
      context: { messages, tools: this.active },
      signal: options.signal,
      onUpdate: options.onUpdate,
      beforeToolCall: ({ toolCall, args }) =>
        this.extensionRunner.emitToolCall({
          type: "tool_call",
          toolName: toolCall.name,
          toolCallId: toolCall.id,
          input: args as Record<string, unknown>,
          ...(options.parentToolCallId ? { parentToolCallId: options.parentToolCallId } : {}),
        }),
      afterToolCall: ({ toolCall, args, result, isError }) =>
        this.extensionRunner.emitToolResult({
          type: "tool_result",
          toolName: toolCall.name,
          toolCallId: toolCall.id,
          input: args as Record<string, unknown>,
          content: result.content,
          details: result.details,
          structuredContent: result.structuredContent,
          isError,
          usage: result.usage,
          ...(options.parentToolCallId ? { parentToolCallId: options.parentToolCallId } : {}),
        }),
    });
    if (!options.parentToolCallId) {
      const nestedUsage = invocation.scopes.get(toolCall.id)?.record.usage;
      if (nestedUsage) outcome.result.usage = addUsage(outcome.result.usage, nestedUsage);
    }
    return outcome;
  }

  private async emit(event: NestedEvent) {
    await this.extensionRunner.emit(event);
    await this.callbacks?.emit?.(event);
  }
  private async executeNested(
    callerId: string,
    name: string,
    args: unknown,
    options: { signal?: AbortSignal; onUpdate?: Update } = {},
  ): Promise<Outcome> {
    const invocation = this.invocation.getStore();
    if (!invocation) throw new Error("Nested tool execution requires an outer invocation");
    let scope = invocation.scopes.get(callerId);
    if (!scope) {
      scope = {
        record: { calls: [], complete: true, argumentBytes: 0 },
        nextId: 1,
        holdsQueue: false,
      };
      invocation.scopes.set(callerId, scope);
    }
    const toolCall: ToolCall = {
      type: "toolCall",
      id: `${callerId}/${scope.nextId++}`,
      name,
      arguments: (args ?? {}) as JsonObject,
    };
    let receipt: NestedReceipt | undefined;
    const record = scope.record;
    if (record.calls.length < 256) {
      receipt = { id: toolCall.id, name, status: "unfinished" };
      const json = JSON.stringify(toolCall.arguments);
      const bytes = new TextEncoder().encode(json).length;
      if (bytes <= 8192 && record.argumentBytes + bytes <= 32768) {
        receipt.arguments = JSON.parse(json);
        record.argumentBytes += bytes;
      } else {
        receipt.argumentsBytes = bytes;
        record.complete = false;
      }
      record.calls.push(receipt);
    } else record.complete = false;
    const startedAt = performance.now();
    await this.emit({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: name,
      args: toolCall.arguments,
      parentToolCallId: callerId,
    });
    await this.emitNestedSnapshot(invocation, callerId);
    const exclusive =
      !scope.holdsQueue &&
      (this.toolExecution === "sequential" ||
        this.executables.get(name)?.executionMode === "sequential");
    let release: (() => void) | undefined;
    if (exclusive) {
      const previous = this.queueTail;
      this.queueTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
    }
    invocation.scopes.set(toolCall.id, {
      ...scope,
      nextId: 1,
      holdsQueue: scope.holdsQueue || exclusive,
    });
    let outcome: Outcome;
    try {
      outcome = await this.executeTool(toolCall, {
        signal: options.signal,
        parentToolCallId: callerId,
        onUpdate: async (partialResult) => {
          const text = partialResult.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
          if (receipt) receipt.output = text.slice(0, 8192);
          await options.onUpdate?.(partialResult);
          await this.emit({
            type: "tool_execution_update",
            toolCallId: toolCall.id,
            toolName: name,
            args: toolCall.arguments,
            partialResult,
            parentToolCallId: callerId,
          });
          await this.emitNestedSnapshot(invocation, callerId);
        },
      });
    } finally {
      invocation.scopes.delete(toolCall.id);
      release?.();
    }
    if (receipt) {
      receipt.status = outcome.isError ? "error" : "ok";
      receipt.durationMs = Math.round(performance.now() - startedAt);
      if (outcome.isError)
        receipt.error = outcome.result.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n")
          .slice(0, 500);
    }
    const finalText = outcome.result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    if (receipt) receipt.output = finalText.slice(0, 8192);
    if (outcome.result.usage) record.usage = addUsage(record.usage, outcome.result.usage);
    if (hasArtifacts(outcome.result.details))
      await invocation.recordArtifacts?.(toolCall.id, outcome.result.details);
    await this.emit({
      type: "tool_execution_end",
      toolCallId: toolCall.id,
      toolName: name,
      result: outcome.result,
      isError: outcome.isError,
      parentToolCallId: callerId,
    });
    await this.emitNestedSnapshot(invocation, callerId);
    return outcome;
  }
  private async emitNestedSnapshot(invocation: ToolInvocation, callId: string) {
    const scope = invocation.scopes.get(callId);
    if (!scope || (scope.record.calls.length === 0 && scope.record.complete)) return;
    await invocation.onNestedUpdate?.({
      calls: scope.record.calls.map((call) => ({ ...call })),
      complete:
        scope.record.complete && scope.record.calls.every((call) => call.status !== "unfinished"),
    });
  }
  private takeNestedCalls(callId: string, invocation: ToolInvocation): NestedCalls | undefined {
    const scope = invocation.scopes.get(callId);
    invocation.scopes.delete(callId);
    if (!scope || (scope.record.calls.length === 0 && scope.record.complete)) return undefined;
    return {
      calls: scope.record.calls.map((call) => ({ ...call })),
      complete:
        scope.record.complete && scope.record.calls.every((call) => call.status !== "unfinished"),
    };
  }
}

function addUsage(previous: Usage | undefined, usage: Usage): Usage {
  if (!previous) return usage;
  return {
    input: previous.input + usage.input,
    output: previous.output + usage.output,
    cacheRead: previous.cacheRead + usage.cacheRead,
    cacheWrite: previous.cacheWrite + usage.cacheWrite,
    totalTokens: previous.totalTokens + usage.totalTokens,
    ...(previous.reasoning !== undefined || usage.reasoning !== undefined
      ? { reasoning: (previous.reasoning ?? 0) + (usage.reasoning ?? 0) }
      : {}),
    ...(previous.cacheWrite1h !== undefined || usage.cacheWrite1h !== undefined
      ? { cacheWrite1h: (previous.cacheWrite1h ?? 0) + (usage.cacheWrite1h ?? 0) }
      : {}),
    cost: {
      input: previous.cost.input + usage.cost.input,
      output: previous.cost.output + usage.cost.output,
      cacheRead: previous.cost.cacheRead + usage.cost.cacheRead,
      cacheWrite: previous.cost.cacheWrite + usage.cost.cacheWrite,
      total: previous.cost.total + usage.cost.total,
    },
  };
}

export function hasArtifacts(details: unknown): boolean {
  return (
    !!details &&
    typeof details === "object" &&
    ["battyFileChanges", "sentFiles", "sites"].some((key) => key in details)
  );
}
