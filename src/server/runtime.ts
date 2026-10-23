import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  ModelRuntime,
  readStoredCredential,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  configure,
  createRegistry,
  Harness,
  LiveDoc,
  InboxDoc,
  type Conversation,
  type ConversationId,
  type EntryRecord,
  type EntryId,
  type Cursor,
  type Storage,
  type ConversationView,
  type LiveState,
  type InboxState,
} from "@earendil-works/pi-durable";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AppConfig } from "./config";
import { stateDirPath } from "./options";
import { enableCodemodeAdapters } from "./codemode-native";
import { listWorkspaces } from "./workspaces";
import { normalizeMessage, normalizeBlocks } from "./pi-state";
import { hydrateRuntimeResultArtifacts } from "./runtime-result-artifacts-history";
import { responseArtifacts, mergeResponseArtifacts } from "./artifact-forwarding";
import { queuedPromptDisplay } from "./queued-prompt-display";
import { createHistoryIndex } from "./history-index";
import { createMemorySearch } from "./memory-search";
import { conversationPolicy } from "./conversation-policy";
import { ProviderAuthService } from "./provider-auth";
import { ProviderUsageService } from "./provider-usage";
import { createTools } from "./tools";
import { createWorkerBrowserCleanup } from "./browser-worker-cleanup";
import { createOrchestration } from "./orchestration";
import { RemoteWorkers, parseRemoteSession } from "./remote-workers";
import { createMemory, type MemoryConfig } from "./memory";
import { createResources } from "./resources";
import type { SessionState, SessionMessagesPage, UiMessage, ModelOption } from "@/shared/types";

export const context = BACKGROUND_CONTEXT;
const PAGE_SIZE = 120;

export function entryMessages(entries: readonly EntryRecord[]): UiMessage[] {
  return entries.flatMap((entry) => {
    if (entry.model?.length)
      return entry.model.flatMap((message, index) => {
        const normalized = normalizeMessage(message as AgentMessage, index);
        if (!normalized) return [];
        normalized.id = index ? `${entry.id}:${index}` : String(entry.id);
        if (normalized.role === "assistant" && entry.byTaskId !== undefined)
          normalized.runTaskId = String(entry.byTaskId);
        return [normalized];
      });
    const data = entry.data as Record<string, unknown> | undefined;
    const original = data?.original as Record<string, unknown> | undefined;
    if (original?.type === "custom_message") {
      const message = normalizeMessage(
        {
          role: "custom",
          customType: original.customType,
          content: original.content,
          display: original.display,
          details: original.details,
          timestamp: Date.parse(String(original.timestamp)),
        } as unknown as AgentMessage,
        0,
      );
      if (message) {
        message.id = String(entry.id);
        return [message];
      }
    }
    if (data && typeof data.text === "string")
      return [
        {
          id: String(entry.id),
          role: "custom" as const,
          customType: entry.kind,
          timestamp: typeof data.timestamp === "number" ? data.timestamp : 0,
          text: data.text,
          data,
        },
      ];
    return [];
  });
}

export async function historyPage(
  storage: Storage,
  conversationId: ConversationId,
  before: string | undefined,
  limit: number,
  after?: string,
  maximum?: number,
) {
  const query = {
    conversationId,
    ...(after ? { minEntryId: (Number(after.split(":")[0]) + 1) as EntryId } : {}),
    ...(maximum === undefined ? {} : { maxEntryId: maximum as EntryId }),
    ...(before ? { maxEntryId: (Number(before.split(":")[0]) - 1) as EntryId } : {}),
  };
  const target = Math.min(limit, 500);
  let cursor: Cursor | undefined;
  let oldest: EntryId | undefined;
  const messages: UiMessage[] = [];
  do {
    const page = await storage.scanEntries(
      query,
      after ? 200 : Math.max(1, target - messages.length),
      cursor,
      context,
    );
    oldest = page.items.at(-1)?.id ?? oldest;
    messages.unshift(...entryMessages([...page.items].reverse()));
    cursor = page.next;
  } while ((after !== undefined || messages.length < target) && cursor);
  await Promise.all(
    messages.map((message) => hydrateRuntimeResultArtifacts(storage, conversationId, message)),
  );
  return {
    messages,
    hasMoreMessages: cursor !== undefined,
    nextBefore: oldest === undefined ? undefined : String(oldest),
  };
}

export class Runtime {
  remotes!: RemoteWorkers;
  readonly streamId = randomUUID();
  private revision = 0;
  private readonly workerBrowserCleanup: ReturnType<typeof createWorkerBrowserCleanup>;
  private constructor(
    readonly config: AppConfig,
    readonly models: ModelRuntime,
    readonly harness: Harness,
    readonly storage: Storage,
    readonly main: Conversation,
    readonly tools: Awaited<ReturnType<typeof createTools>>,
    readonly orchestration: ReturnType<typeof createOrchestration>,
    readonly memory: ReturnType<typeof createMemory>,
    readonly resources: ReturnType<typeof createResources>,
    readonly providerAuth: ProviderAuthService,
    readonly providerUsage: ProviderUsageService,
    private readonly historyIndex: Awaited<ReturnType<typeof createHistoryIndex>>,
  ) {
    this.workerBrowserCleanup = createWorkerBrowserCleanup(tools.browserService);
    orchestration.setWorkerBrowserLifecycle({
      admit: (id, operation) => tools.browserService.withSessionLifecycle(id, operation),
      stop: (id, taskId) =>
        this.workerBrowserCleanup.stop(harness, Number(id) as ConversationId, taskId),
    });
  }

  static async open(
    config: AppConfig,
    {
      resume = true,
      beforeStart,
    }: { resume?: boolean; beforeStart?: (runtime: Runtime) => void | Promise<void> } = {},
  ): Promise<Runtime> {
    const dir = stateDirPath(config.battyDir);
    await fs.mkdir(dir, { recursive: true });
    const authPath = process.env.BATTY_PROVIDER_AUTH_PATH ?? path.join(dir, "auth.json");
    const models = await ModelRuntime.create({
      authPath,
      modelsPath: path.join(dir, "models.json"),
      modelsStorePath: path.join(dir, "models-store.json"),
      allowModelNetwork: true,
    });
    const registry = createRegistry();
    const tools = await createTools(config);
    const orchestration = createOrchestration(config);
    const memory = createMemory(
      {
        getAssistantWorkspaceId: async () =>
          (await listWorkspaces(config)).find((workspace) => workspace.isAssistant)?.id,
        noiseBackupDir: path.join(dir, "memory-backups"),
        rebuildRequested: existsSync(path.join(dir, "memory-rebuild.request")),
        get memoryLanguage() {
          return config.memoryLanguage;
        },
        get memoryModel() {
          return config.memoryModel;
        },
        memoryReasoning: (process.env.BATTY_MEMORY_REASONING ??
          "low") as MemoryConfig["memoryReasoning"],
      },
      models,
    );
    registry.install(tools.extension);
    registry.install(orchestration.extension);
    registry.install(memory.extension);
    const resources = createResources(config);
    registry.install(resources.extension);
    const baseExtensions = registry.snapshot().installed();
    const workspaces = await listWorkspaces(config);
    const database = await openNodeSqliteDatabase(path.join(dir, "runtime.sqlite"));
    await database.exec("PRAGMA synchronous = FULL");
    const storage = await SqliteStorage.open(database);
    const historyIndex = await createHistoryIndex(database);
    const harness = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: {
          extensions: baseExtensions,
          compaction: { enabled: true },
          toolExecution: "parallel",
          stream: { timeoutMs: 300_000 },
        },
        env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? config.selfPath }),
        onReport: (error, info) => console.error("Durable runtime", info, error),
      },
      context,
    );
    const cwd = workspaces.find((workspace) => workspace.isAssistant)?.path ?? config.selfPath;
    const main = await harness.root(context, {
      agent: {
        model: {
          provider: config.defaultProvider ?? "openai-codex",
          modelId: config.defaultModel ?? "gpt-6.1-sol",
        },
        thinkingLevel: (config.defaultThinkingLevel ?? "medium") as ModelThinkingLevel,
        cwd,
      },
    });
    // Main uses the installed extensions' tools. Older MCP discovery persisted a
    // fixed allowlist, which otherwise hides tools added by later releases.
    await main.configure({ tools: null }, context);
    await enableCodemodeAdapters(harness, context);
    if (!(await main.agent(context)).model) {
      await main.configure(
        {
          model: {
            provider: config.defaultProvider ?? "openai-codex",
            modelId: config.defaultModel ?? "gpt-6.1-sol",
          },
          thinkingLevel: (config.defaultThinkingLevel ?? "medium") as ModelThinkingLevel,
          cwd,
        },
        context,
      );
    }
    tools.bindHarness(harness);
    tools.registerTools([
      ...(orchestration.extension.tools ?? []),
      ...(memory.extension.tools ?? []),
    ]);
    await memory.bind(harness, main, storage, await createMemorySearch(database));
    const streamSimple = models.streamSimple.bind(models);
    models.streamSimple = (model, request, options) => {
      memory.validateRequest(request, options);
      return streamSimple(model, request, options);
    };
    const settings = SettingsManager.create(cwd, dir);
    const providerAuth = new ProviderAuthService(
      models,
      (id) => readStoredCredential(id, authPath),
      async () => {
        const id = settings.getOrCreateDeviceId();
        await settings.flush();
        return id;
      },
    );
    const runtime = new Runtime(
      config,
      models,
      harness,
      storage,
      main,
      tools,
      orchestration,
      memory,
      resources,
      providerAuth,
      new ProviderUsageService(models, (id) => readStoredCredential(id, authPath)),
      historyIndex,
    );
    // bind() admits due cron jobs and can resume the harness itself. Install
    // completion observers before that startup boundary, not only before resume.
    await runtime.workerBrowserCleanup.bind(harness);
    await beforeStart?.(runtime);
    await orchestration.bind(harness, main);
    runtime.remotes = await RemoteWorkers.open(runtime);
    orchestration.setRemoteWorkers(runtime.remotes);
    runtime.remotes.start();
    if (resume) harness.resume();
    return runtime;
  }

  async conversation(id: string): Promise<Conversation> {
    const conversation =
      id === "main"
        ? this.main
        : await this.harness.conversation(Number(id) as ConversationId, context);
    if (!conversation) throw Object.assign(new Error("Session not found"), { statusCode: 404 });
    return conversation;
  }

  async listModels(): Promise<ModelOption[]> {
    return (await this.models.getAvailable()).map((model) => ({
      id: `${model.provider}/${model.id}`,
      label: `${model.name} · ${model.provider}`,
      provider: model.provider,
      reasoning: model.reasoning,
      thinkingLevels: getSupportedThinkingLevels(model),
      supportsImages: model.input.includes("image"),
    }));
  }

  nextRevision(): number {
    return ++this.revision;
  }

  async state(
    id = "main",
    view?: ConversationView,
    includeHistory = true,
    after?: string,
  ): Promise<SessionState> {
    if (parseRemoteSession(id)) return this.remotes.state(id, includeHistory, after);
    const conversation = await this.conversation(id);
    const agent = await conversation.agent(context);
    const live = view
      ? (view.docs["pi.live"] as unknown as LiveState)
      : await this.harness.snapshot(LiveDoc, conversation.id, context);
    const inbox = view
      ? (view.docs["pi.inbox"] as unknown as InboxState)
      : await this.harness.snapshot(InboxDoc, conversation.id, context);
    const workspaces = await listWorkspaces(this.config);
    const workspace = workspaces.find((item) => item.path === agent.cwd);
    const model = agent.model && this.models.getModel(agent.model.provider, agent.model.modelId);
    const boundary = !includeHistory
      ? undefined
      : after !== undefined
        ? await this.historyIndex.nextBoundary(conversation.id, after, PAGE_SIZE)
        : { end: (await this.historyIndex.latestEntry(conversation.id)) ?? 0, more: false };
    const history = includeHistory
      ? await this.history(
          conversation.id,
          undefined,
          PAGE_SIZE,
          after,
          boundary?.end ?? (after === undefined ? undefined : Number(after.split(":")[0])),
        )
      : undefined;
    const activeTools = await Promise.all(
      (live?.tools ?? [])
        .filter((tool) => tool.status !== "done")
        .map(async (tool) => {
          const task =
            tool.taskId === undefined
              ? undefined
              : await this.harness.getTask(tool.taskId, context);
          const assistantId = (task?.input as { assistant: EntryId } | undefined)?.assistant;
          const entries =
            assistantId === undefined
              ? (
                  await this.storage.scanEntries(
                    { conversationId: conversation.id },
                    PAGE_SIZE,
                    undefined,
                    context,
                  )
                ).items
              : [(await this.storage.entry(conversation.id, assistantId, context))!.entry];
          const call = entries
            .flatMap((entry) => entry.model ?? [])
            .flatMap((message) => (message.role === "assistant" ? message.content : []))
            .find((block) => block.type === "toolCall" && block.id === tool.callId);
          return {
            toolCallId: tool.callId,
            toolName: tool.name,
            args: call?.type === "toolCall" ? call.arguments : {},
            blocks: normalizeBlocks(tool.output ?? ""),
            status: "running" as const,
            isError: false,
            details: tool.details as Record<string, unknown> | undefined,
          };
        }),
    );
    const all = history?.messages ?? [];
    const totalMessageCount = await this.historyIndex.count(conversation.id);
    await this.attachClientIds(conversation.id, all);
    const queuedClientIds = new Map(
      await Promise.all(
        (inbox?.items ?? []).map(
          async (item) =>
            [item.id, (await this.storage.submission(item.id, context))?.requestId] as const,
        ),
      ),
    );
    const worker = await this.orchestration.metadata(conversation.id);
    const role =
      conversation.id === this.main.id ? "assistant" : worker?.isCron ? "cron" : "worker";
    const policy = conversationPolicy(role, workspace?.id);
    const activeAssistant = live?.generation?.message
      ? normalizeMessage(
          live.generation.message as unknown as AgentMessage,
          Number.MAX_SAFE_INTEGER,
        )
      : undefined;
    const state: SessionState = {
      id: String(conversation.id),
      sessionId: String(conversation.id),
      path: `durable:${conversation.id}`,
      workspaceId: workspace?.id ?? "batty2",
      cwd: agent.cwd ?? this.config.selfPath,
      model: agent.model ? `${agent.model.provider}/${agent.model.modelId}` : undefined,
      modelLabel: model?.name,
      thinkingLevel: agent.thinkingLevel,
      availableThinkingLevels: model ? getSupportedThinkingLevels(model) : ["off"],
      isStreaming: Boolean(live?.run),
      // Main declines native compaction tasks; only workers produce native summaries.
      isCompacting: policy.nativeCompaction && Boolean(live?.compactions?.length),
      memoryPreparation: conversation.id === this.main.id ? this.memory.status() : undefined,
      pendingMessageCount: inbox?.items?.length ?? 0,
      queuedPrompts: (inbox?.items ?? []).flatMap((item) =>
        item.mode === "write"
          ? []
          : [
              {
                kind: item.mode,
                index: item.id,
                clientMessageId: queuedClientIds.get(item.id),
                ...queuedPromptDisplay(item.content),
              },
            ],
      ),
      updatedAt: all.at(-1)?.timestamp ?? Date.now(),
      contextTokens: null,
      contextWindow: model?.contextWindow ?? null,
      contextPercent: null,
      totalMessageCount,
      hasMoreMessages: totalMessageCount > all.length,
      historyAfter: after,
      historyCursor: includeHistory
        ? String(boundary?.end ?? Number(after!.split(":")[0]))
        : undefined,
      hasMoreRecentMessages: boundary?.more ?? false,
      messagesDetailLevel: "full",
      messages: all,
      activeAssistant: activeAssistant?.role === "assistant" ? activeAssistant : undefined,
      activeTools,
      title: role === "assistant" ? "Batty" : role === "cron" ? "Cron" : "Subagent",
      isSubagentSession: role !== "assistant",
      canStopSubagent:
        role === "worker" && (await this.orchestration.canStopWorker(String(conversation.id))),
      isCronSession: role === "cron",
      streamId: this.streamId,
      revision: this.nextRevision(),
    };
    return state;
  }

  async messages(id: string, before?: string, limit = PAGE_SIZE): Promise<SessionMessagesPage> {
    if (parseRemoteSession(id)) return this.remotes.messages(id, before, limit);
    const conversation = await this.conversation(id);
    const page = await this.history(conversation.id, before, limit);
    await this.attachClientIds(conversation.id, page.messages);
    return {
      ...page,
      totalMessageCount: await this.historyIndex.count(conversation.id),
    };
  }

  private async history(
    conversationId: ConversationId,
    before: string | undefined,
    limit: number,
    after?: string,
    maximum?: number,
  ) {
    const page = await this.historyIndex.entries(conversationId, before, limit, after, maximum);
    const messages = entryMessages(page.entries);
    await Promise.all(
      messages.map(async (message) => {
        await hydrateRuntimeResultArtifacts(this.storage, conversationId, message);
        if (message.role === "assistant" && message.turnPhase === "final") {
          const entries = await this.historyIndex.responseArtifacts(
            conversationId,
            Number(message.id.split(":")[0]),
          );
          if (entries.length) {
            const artifacts = mergeResponseArtifacts(message, responseArtifacts(entries));
            message.fileChanges = artifacts.fileChanges;
            message.sites = artifacts.sites;
            message.sentFiles = artifacts.sentFiles;
          }
        }
      }),
    );
    return { messages, hasMoreMessages: page.hasMoreMessages, nextBefore: page.nextBefore };
  }

  private async attachClientIds(conversationId: ConversationId, messages: UiMessage[]) {
    const ids = await this.historyIndex.clientIds(
      conversationId,
      messages.filter((message) => message.role === "user").map((message) => message.id),
    );
    for (const message of messages)
      if (message.role === "user") message.clientMessageId = ids.get(message.id);
  }

  async useDefaultModel(): Promise<void> {
    const model = {
      provider: this.config.defaultProvider ?? "openai-codex",
      modelId: this.config.defaultModel ?? "gpt-6.1-sol",
    };
    const thinkingLevel = (this.config.defaultThinkingLevel ?? "medium") as ModelThinkingLevel;
    await this.main.commit(async (tx) => {
      await configure(tx, this.main.id, { model, thinkingLevel });
    }, context);
  }

  async close(): Promise<void> {
    await this.remotes.close();
    await this.orchestration.close();
    await this.providerAuth.dispose();
    await this.workerBrowserCleanup.close();
    await this.harness.close(context);
    await this.memory.close();
    await this.tools.close();
  }
}
