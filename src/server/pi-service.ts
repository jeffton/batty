import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface UploadedFile {
  filename: string;
  data: Buffer;
}

import {
  StringEnum,
  type AssistantMessage,
  type Message,
  type ToolCall,
  type ToolResultMessage,
} from "@mariozechner/pi-ai";
import {
  AuthStorage,
  buildSessionContext,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionContext,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import mime from "mime-types";
import { RECENT_SESSION_MESSAGE_WINDOW } from "@/shared/session-history";
import type {
  ActiveToolRun,
  CreateCronJobInput,
  CronJobSession,
  ModelOption,
  ProviderAuthStartResponse,
  ProviderAuthStatus,
  ServerEvent,
  SessionMessagesPage,
  SessionState,
  SessionStateMetadata,
  SessionSummary,
  ToolExecutionDetails,
  UpdateCronJobInput,
  WorkspaceInfo,
} from "@/shared/types";
import type { AppConfig } from "./config";
import {
  buildBattySystemPromptSnapshot,
  BATTY_SYSTEM_PROMPT_CUSTOM_TYPE,
  findBattySystemPromptSnapshot,
} from "./batty-system-prompt";
import { buildCronJobSummary, type CronService } from "./cron";
import { storeSentFiles } from "./send-files";
import { runWebSearch } from "./web-search";
import {
  buildDailyCronSessionBinding,
  CRON_SESSION_CUSTOM_TYPE,
  findDailyCronSessionBinding,
  localDayStartMs,
  toLocalIsoDate,
} from "./cron-session";
import { createSessionState, normalizeBlocks } from "./pi-state";
import {
  battyAgentDir,
  battyResourcePaths,
  loadBattyPromptFile,
  loadBattySettings,
  workspaceSessionDir,
} from "./pi-paths";
import { listSessionSummaries as listFastSessionSummaries } from "./session-summaries";
import { sanitizeTerminalBlocks } from "./terminal-output";
import { ProviderAuthService } from "./provider-auth";
import {
  buildSubagentDetails,
  cloneMessagesForSubagent,
  extractAssistantText,
  findLastAssistantMessage,
  newlyGeneratedSubagentMessages,
  SUBAGENT_EFFORT_LEVELS,
  SUBAGENT_TOOL_NAME,
  ZERO_USAGE,
} from "./subagent";

interface SessionSubscriber {
  (event: ServerEvent): void;
}

type PiModel = {
  id: string;
  name: string;
  provider: string;
  api?: string;
  reasoning?: boolean;
  input: string[];
  contextWindow?: number;
};

interface WebSession {
  id: string;
  workspace: WorkspaceInfo;
  session: AgentSession;
  subscribers: Set<SessionSubscriber>;
  activeAssistant?: AgentSession["messages"][number] | undefined;
  activeTools: Map<string, ActiveToolRun>;
  openedAt: number;
  modelFallbackMessage?: string | undefined;
  ephemeral: boolean;
}

interface LiveSession {
  workspace: WorkspaceInfo;
  session: AgentSession;
}

function modelKey(model: PiModel): string {
  return `${model.provider}/${model.id}`;
}

function toModelOption(model: PiModel): ModelOption {
  return {
    id: modelKey(model),
    label: `${model.name} · ${model.provider}`,
    provider: model.provider,
    reasoning: Boolean(model.reasoning),
    supportsImages: model.input.includes("image"),
  };
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function isImageMimeType(value: false | string): value is string {
  return typeof value === "string" && value.startsWith("image/");
}

async function processUploadedFiles(
  filePaths: string[],
): Promise<{ text: string; images: Array<{ type: "image"; mimeType: string; data: string }> }> {
  let text = "";
  const images: Array<{ type: "image"; mimeType: string; data: string }> = [];

  for (const filePath of filePaths) {
    const fileName = path.basename(filePath);
    const mimeType = mime.lookup(filePath);
    if (isImageMimeType(mimeType)) {
      const data = (await fs.readFile(filePath)).toString("base64");
      images.push({ type: "image", mimeType, data });
      text += `<file name="${fileName}"></file>\n`;
      continue;
    }

    const content = await fs.readFile(filePath, "utf8");
    text += `<file name="${fileName}">\n${content}\n</file>\n`;
  }

  return { text, images };
}

function sessionUpdatedAt(session: AgentSession, openedAt: number): number {
  const lastMessage = [...session.messages].reverse().find((message) => "timestamp" in message);
  return typeof lastMessage?.timestamp === "number" ? lastMessage.timestamp : openedAt;
}

function normalizeToolDetails(details: unknown): ToolExecutionDetails | undefined {
  return details && typeof details === "object" ? (details as ToolExecutionDetails) : undefined;
}

const DEFAULT_MESSAGE_PAGE_SIZE = RECENT_SESSION_MESSAGE_WINDOW;
const MAX_MESSAGE_PAGE_SIZE = 200;

function clampMessagePageSize(limit?: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return DEFAULT_MESSAGE_PAGE_SIZE;
  }

  return Math.max(1, Math.min(MAX_MESSAGE_PAGE_SIZE, Math.floor(limit)));
}

function messageIndexFromId(messageId: string | undefined): number | undefined {
  if (!messageId) {
    return undefined;
  }

  const separator = messageId.lastIndexOf("-");
  if (separator === -1) {
    return undefined;
  }

  const index = Number.parseInt(messageId.slice(separator + 1), 10);
  return Number.isFinite(index) && index >= 0 ? index : undefined;
}

const CronScheduleSchema = Type.Object(
  {
    kind: StringEnum(["at", "every", "cron"] as const, {
      description: "Schedule kind.",
    }),
    at: Type.Optional(Type.String({ description: "Absolute time for at jobs." })),
    in: Type.Optional(Type.String({ description: "Relative duration for at jobs, like 10m." })),
    every: Type.Optional(Type.String({ description: "Interval duration like 15m or 2h." })),
    expression: Type.Optional(Type.String({ description: "Cron expression for recurring jobs." })),
    timezone: Type.Optional(Type.String({ description: "IANA timezone for cron jobs." })),
  },
  {
    additionalProperties: false,
    description:
      'Use {kind:"at", in:"10m"} or {kind:"at", at:"2026-03-21T09:00:00+01:00"} or {kind:"every", every:"2h"} or {kind:"cron", expression:"0 9 * * 1-5", timezone:"Europe/Copenhagen"}.',
  },
);

const CronSessionSchema = Type.Object(
  {
    kind: StringEnum(["new", "daily"] as const, {
      description: "Session strategy for cron runs.",
    }),
    includePreviousContext: Type.Optional(
      Type.Boolean({
        description:
          "When kind=daily, whether the subagent should include previous daily-session context. Defaults to true.",
      }),
    ),
  },
  {
    additionalProperties: false,
    description:
      'Use {kind:"new"} for a fresh session each run or {kind:"daily", includePreviousContext:true} to reuse one workspace cron conversation per local day.',
  },
);

const CronToolSchema = Type.Object(
  {
    action: StringEnum(["list", "add", "update", "remove"] as const, {
      description: "Which cron action to perform.",
    }),
    jobId: Type.Optional(Type.String({ description: "Job id for update or remove." })),
    workspaceId: Type.Optional(
      Type.String({ description: "Target workspace id. Defaults to the current workspace." }),
    ),
    prompt: Type.Optional(
      Type.String({ description: "Prompt the scheduled agent turn should run." }),
    ),
    model: Type.Optional(
      Type.String({ description: "Model id for the scheduled job, for example openai/gpt-5." }),
    ),
    thinkingLevel: Type.Optional(
      Type.String({
        description:
          "Thinking level for the scheduled job: off, minimal, low, medium, high, xhigh.",
      }),
    ),
    session: Type.Optional(CronSessionSchema),
    schedule: Type.Optional(CronScheduleSchema),
  },
  {
    additionalProperties: false,
  },
);

const SubagentToolSchema = Type.Object(
  {
    prompt: Type.String({ description: "Prompt the subagent should run." }),
    model: Type.Optional(
      Type.String({ description: "Model id for the subagent, for example openai/gpt-5." }),
    ),
    effort: Type.Optional(
      StringEnum(SUBAGENT_EFFORT_LEVELS, {
        description: "Effort level for the subagent: off, minimal, low, medium, high, xhigh.",
      }),
    ),
    includeSessionContext: Type.Optional(
      Type.Boolean({
        description:
          "Whether to include the current session context. Defaults to true. When false, the subagent still gets the workspace system prompts.",
      }),
    ),
  },
  {
    additionalProperties: false,
  },
);

const WebSearchToolSchema = Type.Object(
  {
    action: StringEnum(["search", "content"] as const, {
      description: "Whether to run a web search or extract page content from a URL.",
    }),
    query: Type.Optional(Type.String({ description: "Search query for action=search." })),
    url: Type.Optional(Type.String({ description: "Page URL for action=content." })),
    count: Type.Optional(Type.Number({ description: "Number of search results to return, 1-20." })),
    includeContent: Type.Optional(
      Type.Boolean({ description: "Fetch readable markdown content for each search result." }),
    ),
    country: Type.Optional(
      Type.String({ description: "Two-letter country code for search results. Defaults to US." }),
    ),
    freshness: Type.Optional(
      Type.String({
        description:
          "Freshness filter such as pd, pw, pm, py, or a range like 2024-01-01to2024-06-30.",
      }),
    ),
  },
  {
    additionalProperties: false,
  },
);

const AttachFilesToolSchema = Type.Object(
  {
    paths: Type.Array(Type.String({ description: "Path to a file to attach for the user." }), {
      minItems: 1,
      description: "Files to copy into Batty storage and expose as downloads for the user.",
    }),
  },
  {
    additionalProperties: false,
  },
);

export class PiService {
  private readonly config: AppConfig;
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly providerAuthService: ProviderAuthService;
  private readonly sessions = new Map<string, WebSession>();
  private readonly liveSessions = new Map<string, LiveSession>();
  private readonly subagentQueues = new Map<string, Promise<void>>();
  private readonly cronSessionResolutions = new Map<string, Promise<SessionState>>();
  private readonly onAgentCompleted: ((session: SessionState) => Promise<void>) | undefined;
  private readonly onWorkspaceUpdated: ((workspaceId: string) => Promise<void>) | undefined;
  private readonly cronService: CronService;

  constructor(
    config: AppConfig,
    cronService: CronService,
    onAgentCompleted?: (session: SessionState) => Promise<void>,
    onWorkspaceUpdated?: (workspaceId: string) => Promise<void>,
  ) {
    this.config = config;
    this.cronService = cronService;
    this.onAgentCompleted = onAgentCompleted;
    this.onWorkspaceUpdated = onWorkspaceUpdated;
    const agentDir = battyAgentDir(config);
    this.authStorage = AuthStorage.create(path.join(agentDir, "auth.json"));
    this.modelRegistry = ModelRegistry.create(this.authStorage, path.join(agentDir, "models.json"));
    this.providerAuthService = new ProviderAuthService(this.authStorage);
  }

  private registerLiveSession(workspace: WorkspaceInfo, session: AgentSession): void {
    this.liveSessions.set(session.sessionId, { workspace, session });
  }

  private unregisterLiveSession(sessionId: string): void {
    this.liveSessions.delete(sessionId);
  }

  getProviderAuthStatus(): ProviderAuthStatus {
    return this.providerAuthService.getStatus();
  }

  async startProviderAuth(providerId: "openai-codex"): Promise<ProviderAuthStartResponse> {
    return this.providerAuthService.start(providerId);
  }

  async completeProviderAuth(
    attemptId: string,
    callbackUrlOrCode: string,
  ): Promise<ProviderAuthStatus> {
    await this.providerAuthService.complete(attemptId, callbackUrlOrCode);
    return this.providerAuthService.getStatus();
  }

  setProviderApiKey(providerId: "google" | "openrouter", apiKey: string): ProviderAuthStatus {
    return this.providerAuthService.setApiKey(providerId, apiKey);
  }

  async listModels(): Promise<ModelOption[]> {
    const models = await this.modelRegistry.getAvailable();
    return models.map(toModelOption).sort((a, b) => a.label.localeCompare(b.label));
  }

  async listSessionSummaries(workspace: WorkspaceInfo): Promise<SessionSummary[]> {
    return listFastSessionSummaries(this.config, workspace);
  }

  async createSession(
    workspace: WorkspaceInfo,
    options?: { modelId?: string; thinkingLevel?: string; ephemeral?: boolean },
  ): Promise<SessionState> {
    const sessionOptions = {
      ...(options?.modelId ? { modelId: options.modelId } : {}),
      ...(options?.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
    };
    const result = await this.createPiAgentSession(
      workspace,
      SessionManager.create(workspace.path, workspaceSessionDir(this.config, workspace.id)),
      sessionOptions,
    );

    const webSession = this.attachSession(
      workspace,
      result.session,
      result.modelFallbackMessage,
      options?.ephemeral ?? false,
    );
    await this.notifyWorkspaceUpdated(workspace.id);
    return this.getState(webSession.id);
  }

  async openSession(workspace: WorkspaceInfo, sessionPath: string): Promise<SessionState> {
    const existing = [...this.sessions.values()].find(
      (candidate) => candidate.session.sessionFile === sessionPath,
    );
    if (existing) {
      return this.getState(existing.id);
    }

    const result = await this.createPiAgentSession(workspace, SessionManager.open(sessionPath));
    const webSession = this.attachSession(workspace, result.session, result.modelFallbackMessage);
    return this.getState(webSession.id);
  }

  async runCronJobSession(job: {
    workspace: WorkspaceInfo;
    prompt: string;
    model: string;
    thinkingLevel: string;
    session: CronJobSession;
    scheduleLabel: string;
  }): Promise<{ sessionId: string; sessionPath: string }> {
    const cronPrompt = this.buildCronPrompt(job.prompt, job.scheduleLabel);
    if (job.session.kind !== "daily") {
      const session = await this.createSession(job.workspace, {
        modelId: job.model,
        thinkingLevel: job.thinkingLevel,
      });
      const current = this.getState(session.id);
      await this.prompt(current.id, cronPrompt, [], current.isStreaming ? "followUp" : undefined);

      return {
        sessionId: current.sessionId,
        sessionPath: this.requireSessionPath(current.id),
      };
    }

    const session = await this.resolveOrCreateDailySession(job.workspace, {
      modelId: job.model,
      thinkingLevel: job.thinkingLevel,
    });

    const webSession = this.requireSession(session.id);
    const includePreviousContext = job.session.includePreviousContext !== false;
    const toolCallId = `${SUBAGENT_TOOL_NAME}-${randomUUID()}`;
    const toolArgs = {
      prompt: cronPrompt,
      model: job.model,
      effort: job.thinkingLevel,
      includeSessionContext: includePreviousContext,
    };

    return this.runSubagentSerial(webSession.session.sessionId, async () => {
      await webSession.session.agent.waitForIdle();
      this.setThinkingLevel(session.id, job.thinkingLevel);
      await this.setModel(session.id, job.model);
      this.appendCronSubagentStart(webSession.session, toolCallId, toolArgs);
      webSession.activeTools.set(toolCallId, {
        toolCallId,
        toolName: SUBAGENT_TOOL_NAME,
        args: toolArgs,
        blocks: [],
        status: "running",
        isError: false,
        details: undefined,
      });
      this.publish(webSession, { type: "reset", state: this.getState(webSession.id) });

      try {
        const result = await this.runDetachedSubagentSession({
          workspace: job.workspace,
          parentSessionId: webSession.session.sessionId,
          prompt: cronPrompt,
          modelId: job.model,
          thinkingLevel: job.thinkingLevel,
          includeSessionContext: includePreviousContext,
          respondIn: "session",
          onUpdate: (partial) => {
            const current = webSession.activeTools.get(toolCallId);
            if (!current) {
              return;
            }
            current.blocks = normalizeBlocks(partial.content ?? []);
            current.details = normalizeToolDetails(partial.details);
            webSession.activeTools.set(toolCallId, current);
            this.publish(webSession, {
              type: "tools",
              tools: [...webSession.activeTools.values()],
            });
          },
        });

        this.appendCronSubagentCompletion(webSession.session, toolCallId, result);
        const completedState = this.getState(webSession.id);
        this.publish(webSession, { type: "reset", state: completedState });
        try {
          await this.onAgentCompleted?.({
            ...completedState,
            isStreaming: false,
            pendingMessageCount: 0,
            activeAssistant: undefined,
          });
        } catch (error) {
          console.error("Failed to run agent completion hook for cron subagent", error);
        }
        await this.notifyWorkspaceUpdated(job.workspace.id);

        if (result.isError) {
          throw new Error(result.errorMessage || result.text || "Subagent failed");
        }

        return {
          sessionId: webSession.session.sessionId,
          sessionPath: this.requireSessionPath(webSession.id),
        };
      } finally {
        webSession.activeTools.delete(toolCallId);
        this.publish(webSession, { type: "tools", tools: [...webSession.activeTools.values()] });
      }
    });
  }

  async createOrOpenDailySession(workspace: WorkspaceInfo): Promise<SessionState> {
    return this.resolveOrCreateDailySession(workspace);
  }

  private async waitForSubagentQueue(sessionId: string): Promise<void> {
    await (this.subagentQueues.get(sessionId) ?? Promise.resolve()).catch(() => undefined);
  }

  private async runSubagentSerial<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.subagentQueues.get(sessionId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.subagentQueues.set(
      sessionId,
      previous.catch(() => undefined).then(() => current),
    );

    await previous.catch(() => undefined);
    try {
      return await run();
    } finally {
      release?.();
      if (this.subagentQueues.get(sessionId) === current) {
        this.subagentQueues.delete(sessionId);
      }
    }
  }

  private resolveSubagentDefaults(
    sessionId: string,
    ctx: ExtensionContext,
  ): {
    modelId?: string;
    thinkingLevel: string;
  } {
    const liveSession = this.liveSessions.get(sessionId)?.session;
    const snapshot = findBattySystemPromptSnapshot(ctx.sessionManager.getEntries());

    return {
      modelId:
        liveSession?.model != null
          ? modelKey(liveSession.model as PiModel)
          : ctx.model != null
            ? modelKey(ctx.model as PiModel)
            : snapshot?.model,
      thinkingLevel: liveSession?.thinkingLevel ?? snapshot?.thinkingLevel ?? "medium",
    };
  }

  private sessionMessagesForSubagent(
    sessionId: string,
    currentToolCallId?: string,
  ): AgentSession["messages"] {
    const liveSession = this.liveSessions.get(sessionId)?.session;
    if (liveSession) {
      return cloneMessagesForSubagent(liveSession.messages, currentToolCallId);
    }

    const attached = this.sessions.get(sessionId);
    if (attached) {
      const context = buildSessionContext(
        attached.session.sessionManager.getEntries(),
        attached.session.sessionManager.getLeafId(),
      );
      return cloneMessagesForSubagent(
        context.messages as AgentSession["messages"],
        currentToolCallId,
      );
    }

    throw new Error(`Unknown live session for subagent: ${sessionId}`);
  }

  private async runDetachedSubagentSession(options: {
    workspace: WorkspaceInfo;
    parentSessionId: string;
    prompt: string;
    modelId: string;
    thinkingLevel: string;
    includeSessionContext: boolean;
    respondIn: "tool-call" | "session";
    currentToolCallId?: string;
    signal?: AbortSignal;
    onUpdate?: (partial: {
      content: Array<{ type: "text"; text: string }>;
      details: ToolExecutionDetails;
    }) => void;
  }): Promise<{
    text: string;
    details: ToolExecutionDetails;
    messages: AgentSession["messages"];
    generatedMessages: AgentSession["messages"];
    finalAssistant?: AssistantMessage;
    isError: boolean;
    errorMessage?: string;
  }> {
    const result = await this.createPiAgentSession(
      options.workspace,
      SessionManager.inMemory(options.workspace.path),
      {
        modelId: options.modelId,
        thinkingLevel: options.thinkingLevel,
      },
    );
    const subagentSession = result.session;
    this.registerLiveSession(options.workspace, subagentSession);

    const seedMessages = options.includeSessionContext
      ? this.sessionMessagesForSubagent(options.parentSessionId, options.currentToolCallId)
      : [];
    const seedMessageCount = seedMessages.length;
    if (seedMessages.length > 0) {
      subagentSession.agent.state.messages = structuredClone(seedMessages);
      for (const message of seedMessages) {
        if (message.role === "branchSummary" || message.role === "compactionSummary") {
          continue;
        }
        subagentSession.sessionManager.appendMessage(message as Message);
      }
    }

    let lastText = "";
    const unsubscribe = subagentSession.subscribe((event) => {
      if (
        event.type !== "message_start" &&
        event.type !== "message_update" &&
        event.type !== "message_end"
      ) {
        return;
      }
      if (event.message.role !== "assistant") {
        return;
      }

      const text = extractAssistantText(event.message);
      if (!text || text === lastText) {
        return;
      }

      lastText = text;
      const finalAssistant = event.message as AssistantMessage;
      options.onUpdate?.({
        content: [{ type: "text", text }],
        details: buildSubagentDetails(
          {
            prompt: options.prompt,
            model: options.modelId,
            effort: options.thinkingLevel,
            includeSessionContext: options.includeSessionContext,
            respondIn: options.respondIn,
          },
          subagentSession.messages,
          finalAssistant,
          {
            sentFileMessages: newlyGeneratedSubagentMessages(
              subagentSession.messages,
              seedMessageCount,
            ),
          },
        ),
      });
    });

    const abortListener = () => {
      void subagentSession.abort();
    };
    if (options.signal) {
      if (options.signal.aborted) {
        abortListener();
      } else {
        options.signal.addEventListener("abort", abortListener, { once: true });
      }
    }

    try {
      await subagentSession.prompt(options.prompt);
      const messages = structuredClone(subagentSession.messages) as AgentSession["messages"];
      const finalAssistant = findLastAssistantMessage(messages);
      const text = extractAssistantText(finalAssistant) || lastText;
      const generatedMessages = newlyGeneratedSubagentMessages(messages, seedMessageCount);
      const details = buildSubagentDetails(
        {
          prompt: options.prompt,
          model: options.modelId,
          effort: options.thinkingLevel,
          includeSessionContext: options.includeSessionContext,
          respondIn: options.respondIn,
        },
        messages,
        finalAssistant,
        { sentFileMessages: generatedMessages },
      );
      return {
        text,
        details,
        messages,
        generatedMessages,
        finalAssistant,
        isError: finalAssistant?.stopReason === "error" || finalAssistant?.stopReason === "aborted",
        errorMessage: finalAssistant?.errorMessage,
      };
    } catch (error) {
      const messages = structuredClone(subagentSession.messages) as AgentSession["messages"];
      const finalAssistant = findLastAssistantMessage(messages);
      const text =
        extractAssistantText(finalAssistant) ||
        finalAssistant?.errorMessage ||
        (error instanceof Error ? error.message : String(error));
      const generatedMessages = newlyGeneratedSubagentMessages(messages, seedMessageCount);
      const details = buildSubagentDetails(
        {
          prompt: options.prompt,
          model: options.modelId,
          effort: options.thinkingLevel,
          includeSessionContext: options.includeSessionContext,
          respondIn: options.respondIn,
        },
        messages,
        finalAssistant,
        { sentFileMessages: generatedMessages },
      );
      return {
        text,
        details,
        messages,
        generatedMessages,
        finalAssistant,
        isError: true,
        errorMessage:
          finalAssistant?.errorMessage || (error instanceof Error ? error.message : String(error)),
      };
    } finally {
      if (options.signal) {
        options.signal.removeEventListener("abort", abortListener);
      }
      unsubscribe();
      this.unregisterLiveSession(subagentSession.sessionId);
      subagentSession.dispose();
    }
  }

  private appendMessages(session: AgentSession, messages: Message[]): void {
    session.agent.state.messages = [...session.messages, ...messages];
    for (const message of messages) {
      session.sessionManager.appendMessage(message);
    }
  }

  private buildCronPrompt(prompt: string, scheduleLabel: string): string {
    const trimmedPrompt = prompt.trim();
    return [
      "[Cron trigger]\nThis turn was triggered by a Batty cron job.",
      `Schedule: ${scheduleLabel}`,
      trimmedPrompt,
    ]
      .filter((part) => part.length > 0)
      .join("\n\n");
  }

  private appendCronSubagentStart(
    session: AgentSession,
    toolCallId: string,
    args: {
      prompt: string;
      model: string;
      effort: string;
      includeSessionContext: boolean;
    },
  ): void {
    const timestamp = Date.now();
    this.appendMessages(session, [
      { role: "user", content: args.prompt, timestamp },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: toolCallId,
            name: SUBAGENT_TOOL_NAME,
            arguments: args,
          } satisfies ToolCall,
        ],
        api: (session.model as PiModel | undefined)?.api ?? "openai-responses",
        provider: session.model?.provider ?? "unknown",
        model: session.model?.id ?? args.model,
        usage: ZERO_USAGE,
        stopReason: "toolUse",
        timestamp: timestamp + 1,
      } satisfies AssistantMessage,
    ]);
  }

  private appendCronSubagentCompletion(
    session: AgentSession,
    toolCallId: string,
    result: {
      text: string;
      details: ToolExecutionDetails;
      finalAssistant?: AssistantMessage;
      isError: boolean;
      errorMessage?: string;
    },
  ): void {
    const timestamp = Date.now();
    const toolResult: ToolResultMessage<ToolExecutionDetails> = {
      role: "toolResult",
      toolCallId,
      toolName: SUBAGENT_TOOL_NAME,
      content: [],
      details: result.details,
      isError: result.isError,
      timestamp,
    };
    const deliveredAssistant: AssistantMessage = result.finalAssistant
      ? {
          ...result.finalAssistant,
          timestamp: timestamp + 1,
        }
      : {
          role: "assistant",
          content: [{ type: "text", text: result.text || result.errorMessage || "(no output)" }],
          api: (session.model as PiModel | undefined)?.api ?? "openai-responses",
          provider: session.model?.provider ?? "unknown",
          model: session.model?.id ?? "unknown",
          usage: ZERO_USAGE,
          stopReason: result.isError ? "error" : "stop",
          errorMessage: result.isError ? result.errorMessage : undefined,
          timestamp: timestamp + 1,
        };
    this.appendMessages(session, [toolResult, deliveredAssistant]);
  }

  private async resolveOrCreateDailySession(
    workspace: WorkspaceInfo,
    options?: { modelId?: string; thinkingLevel?: string },
  ): Promise<SessionState> {
    const now = new Date();
    const date = toLocalIsoDate(now, this.config.cronDailySessionStartTime);
    const key = `${workspace.id}:daily:${date}`;
    const inFlight = this.cronSessionResolutions.get(key);
    if (inFlight) {
      return inFlight;
    }

    let resolution: Promise<SessionState>;
    resolution = (async () => {
      const todayStartMs = localDayStartMs(now, this.config.cronDailySessionStartTime);
      const candidates = (await this.listSessionSummaries(workspace)).filter(
        (candidate) =>
          typeof candidate.path === "string" &&
          candidate.path.length > 0 &&
          candidate.updatedAt >= todayStartMs,
      );

      for (const candidate of candidates) {
        const sessionPath = candidate.path;
        if (!sessionPath) {
          continue;
        }

        const loaded = [...this.sessions.values()].find(
          (session) =>
            session.workspace.id === workspace.id && session.session.sessionFile === sessionPath,
        );
        const entries = loaded
          ? loaded.session.sessionManager.getEntries()
          : SessionManager.open(sessionPath).getEntries();
        if (findDailyCronSessionBinding(entries, date)) {
          return this.openSession(workspace, sessionPath);
        }
      }

      const session = await this.createSession(workspace, {
        ...(options?.modelId ? { modelId: options.modelId } : {}),
        ...(options?.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
      });
      const webSession = this.requireSession(session.id);
      webSession.session.sessionManager.appendCustomEntry(
        CRON_SESSION_CUSTOM_TYPE,
        buildDailyCronSessionBinding(now, this.config.cronDailySessionStartTime),
      );
      await this.notifyWorkspaceUpdated(workspace.id);
      return this.getState(webSession.id);
    })();

    this.cronSessionResolutions.set(key, resolution);
    try {
      return await resolution;
    } finally {
      if (this.cronSessionResolutions.get(key) === resolution) {
        this.cronSessionResolutions.delete(key);
      }
    }
  }

  private requireSessionPath(sessionId: string): string {
    const sessionPath = this.requireSession(sessionId).session.sessionFile;
    if (!sessionPath) {
      throw new Error(`Session ${sessionId} is not persisted`);
    }
    return sessionPath;
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  subscribe(sessionId: string, subscriber: SessionSubscriber): () => void {
    const webSession = this.requireSession(sessionId);
    webSession.subscribers.add(subscriber);
    subscriber({ type: "reset", state: this.getState(sessionId) });
    return () => {
      webSession.subscribers.delete(subscriber);
      if (
        webSession.ephemeral &&
        webSession.subscribers.size === 0 &&
        !webSession.session.isStreaming
      ) {
        this.sessions.delete(webSession.id);
        this.unregisterLiveSession(webSession.id);
      }
    };
  }

  getState(
    sessionId: string,
    options?: { beforeMessageId?: string; limit?: number },
  ): SessionState {
    const webSession = this.requireSession(sessionId);
    const contextUsage = webSession.session.getContextUsage();
    const messagePage = this.getMessagePage(webSession, options);

    return createSessionState({
      id: webSession.id,
      sessionId: webSession.session.sessionId,
      workspaceId: webSession.workspace.id,
      cwd: webSession.workspace.path,
      path: webSession.session.sessionFile,
      model: webSession.session.model ? modelKey(webSession.session.model) : undefined,
      modelLabel: webSession.session.model
        ? `${webSession.session.model.name} · ${webSession.session.model.provider}`
        : undefined,
      thinkingLevel: webSession.session.thinkingLevel,
      availableThinkingLevels: webSession.session.getAvailableThinkingLevels(),
      isStreaming: webSession.session.isStreaming,
      pendingMessageCount: webSession.session.pendingMessageCount,
      updatedAt: sessionUpdatedAt(webSession.session, webSession.openedAt),
      contextTokens: contextUsage?.tokens ?? null,
      contextWindow: contextUsage?.contextWindow ?? webSession.session.model?.contextWindow ?? null,
      contextPercent: contextUsage?.percent ?? null,
      totalMessageCount: messagePage.totalMessageCount,
      hasMoreMessages: messagePage.hasMoreMessages,
      messageIndexOffset: messagePage.messageIndexOffset,
      messages: messagePage.messages,
      activeAssistant: webSession.activeAssistant ?? undefined,
      activeTools: [...webSession.activeTools.values()],
      title: webSession.session.sessionName,
    });
  }

  getSessionMessages(
    sessionId: string,
    options?: { beforeMessageId?: string; limit?: number },
  ): SessionMessagesPage {
    const webSession = this.requireSession(sessionId);
    const page = this.getMessagePage(webSession, options);
    return {
      messages: createSessionState({
        id: webSession.id,
        sessionId: webSession.session.sessionId,
        workspaceId: webSession.workspace.id,
        cwd: webSession.workspace.path,
        path: webSession.session.sessionFile,
        model: undefined,
        modelLabel: undefined,
        thinkingLevel: webSession.session.thinkingLevel,
        availableThinkingLevels: webSession.session.getAvailableThinkingLevels(),
        isStreaming: webSession.session.isStreaming,
        pendingMessageCount: webSession.session.pendingMessageCount,
        updatedAt: sessionUpdatedAt(webSession.session, webSession.openedAt),
        contextTokens: null,
        contextWindow: null,
        contextPercent: null,
        totalMessageCount: page.totalMessageCount,
        hasMoreMessages: page.hasMoreMessages,
        messageIndexOffset: page.messageIndexOffset,
        messages: page.messages,
        activeTools: [],
        title: undefined,
      }).messages,
      totalMessageCount: page.totalMessageCount,
      hasMoreMessages: page.hasMoreMessages,
    };
  }

  async setModel(sessionId: string, modelId: string): Promise<SessionState> {
    const webSession = this.requireSession(sessionId);
    const model = await this.resolveModel(modelId);
    await webSession.session.setModel(model as never);
    await this.refreshBattySystemPrompt(webSession);
    this.publish(webSession, { type: "state", state: this.getStateMetadata(webSession) });
    return this.getState(sessionId);
  }

  setThinkingLevel(sessionId: string, thinkingLevel: string): SessionState {
    const webSession = this.requireSession(sessionId);
    webSession.session.setThinkingLevel(thinkingLevel as AgentSession["thinkingLevel"]);
    this.publish(webSession, { type: "state", state: this.getStateMetadata(webSession) });
    return this.getState(sessionId);
  }

  async prompt(
    sessionId: string,
    text: string,
    files: UploadedFile[],
    streamingBehavior?: "steer" | "followUp",
  ): Promise<void> {
    const webSession = this.requireSession(sessionId);
    await this.waitForSubagentQueue(sessionId);
    const prepared = await this.preparePromptFiles(sessionId, files);
    const parts = [text.trim(), prepared.text.trim()].filter(Boolean);
    const promptText = parts.join("\n\n").trim() || "Please inspect the attached files.";

    await webSession.session.prompt(promptText, {
      images: prepared.images,
      ...(streamingBehavior ? { streamingBehavior } : {}),
    });
  }

  async abort(sessionId: string): Promise<void> {
    const webSession = this.requireSession(sessionId);
    await webSession.session.abort();
    this.publish(webSession, { type: "state", state: this.getStateMetadata(webSession) });
  }

  private async createPiAgentSession(
    workspace: WorkspaceInfo,
    sessionManager: SessionManager,
    options?: { modelId?: string; thinkingLevel?: string },
  ): Promise<Awaited<ReturnType<typeof createAgentSession>>> {
    const model = options?.modelId ? await this.resolveModel(options.modelId) : undefined;
    const agentDir = battyAgentDir(this.config);
    const settings = await loadBattySettings(this.config, workspace.path);
    const settingsManager = SettingsManager.inMemory({
      ...settings,
      sessionDir: workspaceSessionDir(this.config, workspace.id),
    });
    const persistedPrompt = findBattySystemPromptSnapshot(sessionManager.getEntries());
    const systemPrompt = await loadBattyPromptFile(workspace.path, agentDir, "SYSTEM.md");
    const appendSystemPrompt = await loadBattyPromptFile(
      workspace.path,
      agentDir,
      "APPEND_SYSTEM.md",
    );
    const workspaceRoot = path.resolve(workspace.path);
    const globalAgentsPath = path.resolve(path.join(agentDir, "AGENTS.md"));
    const resourcePaths = battyResourcePaths(this.config, workspace.path, settings);
    const resourceLoader = new DefaultResourceLoader({
      cwd: workspace.path,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalExtensionPaths: resourcePaths.extensions,
      additionalSkillPaths: resourcePaths.skills,
      additionalPromptTemplatePaths: resourcePaths.prompts,
      additionalThemePaths: resourcePaths.themes,
      agentsFilesOverride: (base) => ({
        agentsFiles: base.agentsFiles.filter((file) => {
          const resolved = path.resolve(file.path);
          return (
            resolved === globalAgentsPath || resolved === path.join(workspaceRoot, "AGENTS.md")
          );
        }),
      }),
      systemPromptOverride: () => systemPrompt,
      appendSystemPromptOverride: () => {
        const base = appendSystemPrompt ? [appendSystemPrompt] : [];
        const appendedBattyPrompt = findBattySystemPromptSnapshot(
          sessionManager.getEntries(),
        )?.appendedPrompt;
        return appendedBattyPrompt ? [...base, appendedBattyPrompt] : base;
      },
    });
    await resourceLoader.reload();

    const result = await createAgentSession({
      cwd: workspace.path,
      agentDir,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      sessionManager,
      settingsManager,
      resourceLoader,
      ...(model ? { model: model as never } : {}),
      ...(options?.thinkingLevel
        ? { thinkingLevel: options.thinkingLevel as AgentSession["thinkingLevel"] }
        : {}),
      customTools: [
        this.createSubagentTool(workspace) as never,
        this.createCronTool(workspace) as never,
        this.createWebSearchTool() as never,
        this.createAttachFilesTool(workspace) as never,
      ],
    });

    if (!persistedPrompt) {
      const restoredContext = sessionManager.buildSessionContext();
      const selectedModel =
        result.session.model != null
          ? modelKey(result.session.model as PiModel)
          : restoredContext.model != null
            ? `${restoredContext.model.provider}/${restoredContext.model.modelId}`
            : (options?.modelId ?? "unknown");
      const selectedThinkingLevel =
        result.session.thinkingLevel ||
        restoredContext.thinkingLevel ||
        options?.thinkingLevel ||
        "off";
      const snapshot = buildBattySystemPromptSnapshot(
        workspace,
        selectedModel,
        selectedThinkingLevel,
        new Date(),
        path.join(this.config.selfPath, "README.md"),
      );

      sessionManager.appendCustomEntry(BATTY_SYSTEM_PROMPT_CUSTOM_TYPE, snapshot);
      await resourceLoader.reload();
      result.session.setActiveToolsByName(result.session.getActiveToolNames());
    }

    return result;
  }

  private attachSession(
    workspace: WorkspaceInfo,
    session: AgentSession,
    modelFallbackMessage?: string,
    ephemeral = false,
  ): WebSession {
    const webSession: WebSession = {
      id: session.sessionId,
      workspace,
      session,
      subscribers: new Set(),
      activeTools: new Map(),
      openedAt: Date.now(),
      modelFallbackMessage,
      ephemeral,
    };

    session.subscribe((event) => {
      void this.handleAgentEvent(webSession, event).catch((error) => {
        console.error("Failed to handle agent event", error);
      });
    });
    this.sessions.set(webSession.id, webSession);
    this.registerLiveSession(workspace, session);
    return webSession;
  }

  private publish(webSession: WebSession, event: ServerEvent): void {
    for (const subscriber of webSession.subscribers) {
      subscriber(event);
    }
  }

  private getMessagePage(
    webSession: WebSession,
    options?: { beforeMessageId?: string; limit?: number },
  ): {
    messages: AgentSession["messages"];
    totalMessageCount: number;
    hasMoreMessages: boolean;
    messageIndexOffset: number;
  } {
    const allMessages = webSession.session.messages;
    const totalMessageCount = allMessages.length;
    const limit = clampMessagePageSize(options?.limit);
    const beforeIndex = messageIndexFromId(options?.beforeMessageId);
    const end =
      typeof beforeIndex === "number" && beforeIndex >= 0
        ? Math.min(beforeIndex, totalMessageCount)
        : totalMessageCount;
    const start = Math.max(0, end - limit);

    return {
      messages: allMessages.slice(start, end),
      totalMessageCount,
      hasMoreMessages: start > 0,
      messageIndexOffset: start,
    };
  }

  private getStateMetadata(webSession: WebSession): SessionStateMetadata {
    const state = this.getState(webSession.id, { limit: 1 });
    const {
      messages: _messages,
      activeAssistant: _activeAssistant,
      activeTools: _activeTools,
      ...rest
    } = state;
    return rest;
  }

  private async handleAgentEvent(webSession: WebSession, event: AgentSessionEvent): Promise<void> {
    switch (event.type) {
      case "message_start":
      case "message_update":
        if (event.message.role === "assistant") {
          webSession.activeAssistant = event.message;
          this.publish(webSession, {
            type: "assistant",
            assistant: this.getState(webSession.id).activeAssistant,
          });
        }
        break;
      case "message_end":
        if (event.message.role === "assistant") {
          webSession.activeAssistant = undefined;
        }
        this.publish(webSession, { type: "reset", state: this.getState(webSession.id) });
        break;
      case "tool_execution_start":
        webSession.activeTools.set(event.toolCallId, {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args as Record<string, unknown>,
          blocks: [],
          status: "running",
          isError: false,
          details: undefined,
        });
        this.publish(webSession, { type: "tools", tools: [...webSession.activeTools.values()] });
        break;
      case "tool_execution_update": {
        const current = webSession.activeTools.get(event.toolCallId);
        if (current) {
          const blocks = normalizeBlocks(event.partialResult.content ?? []);
          current.blocks = current.toolName === "bash" ? sanitizeTerminalBlocks(blocks) : blocks;
          current.details = normalizeToolDetails(event.partialResult.details);
          webSession.activeTools.set(event.toolCallId, current);
          this.publish(webSession, { type: "tools", tools: [...webSession.activeTools.values()] });
        }
        break;
      }
      case "tool_execution_end": {
        const current = webSession.activeTools.get(event.toolCallId);
        if (current) {
          const blocks = normalizeBlocks(event.result.content ?? []);
          current.blocks = current.toolName === "bash" ? sanitizeTerminalBlocks(blocks) : blocks;
          current.status = event.isError ? "error" : "success";
          current.isError = event.isError;
          current.details = normalizeToolDetails(event.result.details);
          webSession.activeTools.set(event.toolCallId, current);
          this.publish(webSession, { type: "tools", tools: [...webSession.activeTools.values()] });
        }
        break;
      }
      case "agent_start":
        webSession.activeTools.clear();
        this.publish(webSession, { type: "tools", tools: [] });
        this.publish(webSession, { type: "state", state: this.getStateMetadata(webSession) });
        break;
      case "agent_end":
      case "turn_end":
      case "compaction_end":
      case "auto_retry_end": {
        if (event.type === "agent_end") {
          webSession.activeAssistant = undefined;
        }
        const state = this.getState(webSession.id);
        const publishedState =
          event.type === "agent_end"
            ? {
                ...state,
                isStreaming: false,
                pendingMessageCount: 0,
                activeAssistant: undefined,
              }
            : state;
        this.publish(webSession, { type: "reset", state: publishedState });
        if (event.type === "agent_end") {
          try {
            console.info("Running agent completion hook", {
              sessionId: publishedState.sessionId,
              workspaceId: publishedState.workspaceId,
            });
            await this.onAgentCompleted?.(publishedState);
          } catch (error) {
            console.error("Failed to run agent completion hook", error);
          }
          try {
            await this.notifyWorkspaceUpdated(publishedState.workspaceId);
          } catch (error) {
            console.error("Failed to publish workspace update", error);
          }
          if (webSession.ephemeral && webSession.subscribers.size === 0) {
            this.sessions.delete(webSession.id);
            this.unregisterLiveSession(webSession.id);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  private async notifyWorkspaceUpdated(workspaceId: string): Promise<void> {
    await this.onWorkspaceUpdated?.(workspaceId);
  }

  private async refreshBattySystemPrompt(webSession: WebSession): Promise<void> {
    const model = webSession.session.model
      ? modelKey(webSession.session.model as PiModel)
      : "unknown";
    const snapshot = buildBattySystemPromptSnapshot(
      webSession.workspace,
      model,
      webSession.session.thinkingLevel,
      new Date(),
      path.join(this.config.selfPath, "README.md"),
    );

    webSession.session.sessionManager.appendCustomEntry(BATTY_SYSTEM_PROMPT_CUSTOM_TYPE, snapshot);
    await webSession.session.resourceLoader.reload();
    webSession.session.setActiveToolsByName(webSession.session.getActiveToolNames());
  }

  private createSubagentTool(workspace: WorkspaceInfo): ToolDefinition<typeof SubagentToolSchema> {
    return {
      name: SUBAGENT_TOOL_NAME,
      label: "Subagent",
      description:
        "Run a synchronous subagent in the current workspace. The tool result is the subagent's reply.",
      promptSnippet:
        "Run a synchronous subagent in the current workspace, optionally reusing the current session context.",
      promptGuidelines: [
        "Use this tool to delegate focused work to another agent without leaving the current session.",
        "Prefer omitting model and effort so the subagent inherits the current session settings.",
        "Set includeSessionContext=false when you want a fresh workspace-scoped subagent with only the system prompts.",
      ],
      parameters: SubagentToolSchema,
      execute: async (toolCallId, params, signal, onUpdate, ctx) => {
        const sessionId = ctx.sessionManager.getSessionId();
        const defaults = this.resolveSubagentDefaults(sessionId, ctx);
        const modelId =
          typeof params.model === "string" && params.model.trim().length > 0
            ? params.model.trim()
            : defaults.modelId;
        if (!modelId) {
          throw new Error("No model available for subagent");
        }

        const thinkingLevel =
          typeof params.effort === "string" && params.effort.trim().length > 0
            ? params.effort.trim()
            : defaults.thinkingLevel;
        const prompt = String(params.prompt ?? "").trim();
        if (!prompt) {
          throw new Error("prompt is required for subagent");
        }

        const includeSessionContext = params.includeSessionContext !== false;
        return this.runSubagentSerial(sessionId, async () => {
          const result = await this.runDetachedSubagentSession({
            workspace,
            parentSessionId: sessionId,
            prompt,
            modelId,
            thinkingLevel,
            includeSessionContext,
            respondIn: "tool-call",
            currentToolCallId: toolCallId,
            signal,
            onUpdate,
          });
          return {
            content: [{ type: "text", text: result.text || "(no output)" }],
            details: result.details,
            isError: result.isError,
          };
        });
      },
    };
  }

  private createCronTool(workspace: WorkspaceInfo): ToolDefinition<typeof CronToolSchema> {
    return {
      name: "cron",
      label: "Cron",
      description:
        "Create, list, update, and remove scheduled Batty jobs that run future agent turns in workspaces.",
      promptSnippet:
        "Create and manage scheduled agent turns for Batty workspaces. Prefer reusing the current session model unless the user explicitly asks for a different one.",
      promptGuidelines: [
        "When scheduling a cron job, always provide the full prompt the future agent turn should run.",
        "Prefer omitting model and thinkingLevel so the cron job reuses the current session settings. Only set them explicitly if the user asks for different ones.",
        'Use session.kind="daily" to reuse one workspace cron conversation per local day.',
        'Use session.includePreviousContext=false with session.kind="daily" to run the daily subagent without earlier daily-session context.',
        'Use schedule.kind="at" with schedule.in for relative times like 10m or 2h.',
        'Use schedule.kind="cron" with a standard cron expression and optional timezone for recurring schedules.',
        'Use schedule.kind="every" with durations like 15m, 2h, or 1d for interval schedules.',
      ],
      parameters: CronToolSchema,
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const action = String(params.action ?? "").trim();
        const workspaceId =
          typeof params.workspaceId === "string" && params.workspaceId.trim().length > 0
            ? params.workspaceId.trim()
            : workspace.id;

        switch (action) {
          case "list": {
            const jobs = this.cronService.listJobs(workspaceId);
            const text =
              jobs.length === 0
                ? `No cron jobs found for workspace ${workspaceId}.`
                : jobs.map(buildCronJobSummary).join("\n\n---\n\n");
            return {
              content: [{ type: "text", text }],
              details: { count: jobs.length, workspaceId },
            };
          }
          case "add": {
            const defaults = this.resolveSubagentDefaults(ctx.sessionManager.getSessionId(), ctx);
            const input: CreateCronJobInput = {
              workspaceId,
              prompt: String(params.prompt ?? ""),
              model:
                typeof params.model === "string" && params.model.trim().length > 0
                  ? params.model.trim()
                  : (defaults.modelId ?? ""),
              thinkingLevel:
                typeof params.thinkingLevel === "string" && params.thinkingLevel.trim().length > 0
                  ? params.thinkingLevel.trim()
                  : defaults.thinkingLevel,
              session:
                params.session && typeof params.session === "object"
                  ? (params.session as CreateCronJobInput["session"])
                  : undefined,
              schedule: (params.schedule ?? {}) as CreateCronJobInput["schedule"],
            };
            const job = await this.cronService.createJob(input);
            return {
              content: [{ type: "text", text: `Created cron job.\n\n${buildCronJobSummary(job)}` }],
              details: job,
            };
          }
          case "update": {
            const jobId = String(params.jobId ?? "").trim();
            if (!jobId) {
              throw new Error("jobId is required for cron update");
            }

            const patch: UpdateCronJobInput = {
              workspaceId,
              prompt: typeof params.prompt === "string" ? params.prompt : undefined,
              model: typeof params.model === "string" ? params.model : undefined,
              thinkingLevel:
                typeof params.thinkingLevel === "string" ? params.thinkingLevel : undefined,
              session:
                params.session && typeof params.session === "object"
                  ? (params.session as UpdateCronJobInput["session"])
                  : undefined,
              schedule:
                params.schedule && typeof params.schedule === "object"
                  ? (params.schedule as UpdateCronJobInput["schedule"])
                  : undefined,
            };
            if (patch.workspaceId === workspace.id && typeof params.workspaceId !== "string") {
              delete patch.workspaceId;
            }

            const job = await this.cronService.updateJob(jobId, patch);
            return {
              content: [{ type: "text", text: `Updated cron job.\n\n${buildCronJobSummary(job)}` }],
              details: job,
            };
          }
          case "remove": {
            const jobId = String(params.jobId ?? "").trim();
            if (!jobId) {
              throw new Error("jobId is required for cron remove");
            }
            const job = await this.cronService.deleteJob(jobId);
            return {
              content: [
                {
                  type: "text",
                  text: `Removed cron job ${job.id} from workspace ${job.workspaceId}.`,
                },
              ],
              details: job,
            };
          }
          default:
            throw new Error(`Unknown cron action: ${action}`);
        }
      },
    };
  }

  private createWebSearchTool(): ToolDefinition<typeof WebSearchToolSchema> {
    return {
      name: "web-search",
      label: "Web Search",
      description:
        "Search the web with Brave Search and extract readable markdown content from result pages.",
      promptSnippet: "Search the web or extract readable page content without leaving Batty.",
      promptGuidelines: [
        "Use this tool for web lookups, current facts, API docs, or extracting readable page content from URLs.",
        'Use action="search" with query for web search.',
        'Use action="content" with url to extract readable markdown from a specific page.',
        "Set includeContent=true when you need the actual page text for the search results.",
      ],
      parameters: WebSearchToolSchema,
      execute: async (_toolCallId, params) => {
        const result = await runWebSearch({
          apiKey: this.config.braveSearchKey ?? "",
          action: params.action,
          query: typeof params.query === "string" ? params.query : undefined,
          url: typeof params.url === "string" ? params.url : undefined,
          count: typeof params.count === "number" ? params.count : undefined,
          includeContent:
            typeof params.includeContent === "boolean" ? params.includeContent : false,
          country: typeof params.country === "string" ? params.country : undefined,
          freshness: typeof params.freshness === "string" ? params.freshness : undefined,
        });
        return {
          content: [{ type: "text", text: result.text }],
          details: result.details,
        };
      },
    };
  }

  private createAttachFilesTool(
    workspace: WorkspaceInfo,
  ): ToolDefinition<typeof AttachFilesToolSchema> {
    return {
      name: "attach-files",
      label: "Attach Files",
      description:
        "Copy files into Batty storage so they appear as attachments in the final response and downloads during the tool call.",
      promptSnippet: "Attach files to the final response without leaving Batty.",
      promptGuidelines: [
        "Use this tool when the user asks you to send or attach one or more files.",
        "Pass every file path you want to attach in paths.",
        "Only attach files that already exist in the workspace or as absolute paths you have access to.",
      ],
      parameters: AttachFilesToolSchema,
      execute: async (toolCallId, params, _signal, _onUpdate, ctx) => {
        const sessionFile = ctx.sessionManager.getSessionFile();
        const sessionId =
          typeof sessionFile === "string" && sessionFile.length > 0
            ? path.basename(sessionFile, path.extname(sessionFile))
            : "ephemeral-session";
        const sentFiles = await storeSentFiles({
          rootDir: this.config.sentFilesDir,
          workspaceId: workspace.id,
          sessionId,
          toolCallId,
          cwd: workspace.path,
          paths: Array.isArray(params.paths)
            ? params.paths.filter((value): value is string => typeof value === "string")
            : [],
        });
        const count = sentFiles.length;
        const noun = count === 1 ? "file" : "files";
        return {
          content: [{ type: "text", text: `Attached ${count} ${noun} for the user.` }],
          details: { sentFiles },
        };
      },
    };
  }

  private async resolveModel(modelId: string): Promise<PiModel> {
    const [provider, ...rest] = modelId.split("/");
    if (!provider || rest.length === 0) {
      throw new Error(`Invalid model id: ${modelId}`);
    }

    const resolved = this.modelRegistry.find(provider, rest.join("/"));
    if (!resolved) {
      throw new Error(`Model not found: ${modelId}`);
    }

    return resolved;
  }

  private requireSession(sessionId: string): WebSession {
    const webSession = this.sessions.get(sessionId);
    if (!webSession) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return webSession;
  }

  private async preparePromptFiles(
    sessionId: string,
    files: UploadedFile[],
  ): Promise<{ text: string; images: Array<{ type: "image"; mimeType: string; data: string }> }> {
    if (files.length === 0) {
      return { text: "", images: [] };
    }

    const sessionDir = path.join(this.config.uploadsDir, sessionId, randomUUID());
    await ensureDir(sessionDir);

    const savedPaths: string[] = [];
    for (const file of files) {
      const targetPath = path.join(sessionDir, sanitizeFileName(file.filename || "attachment.bin"));
      await fs.writeFile(targetPath, file.data);
      savedPaths.push(targetPath);
    }

    return processUploadedFiles(savedPaths);
  }
}
