import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface UploadedFile {
  filename: string;
  data: Buffer;
}

import { StringEnum } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import mime from "mime-types";
import type {
  ActiveToolRun,
  CreateCronJobInput,
  ModelOption,
  ServerEvent,
  SessionState,
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
import { createSessionState, normalizeBlocks } from "./pi-state";
import { sanitizeTerminalBlocks } from "./terminal-output";

interface SessionSubscriber {
  (event: ServerEvent): void;
}

type PiModel = {
  id: string;
  name: string;
  provider: string;
  reasoning?: boolean;
  input: string[];
  contextWindow?: number;
};

interface WebSession {
  id: string;
  workspace: WorkspaceInfo;
  session: AgentSession;
  subscribers: Set<SessionSubscriber>;
  activeAssistant?: AgentSession["state"]["streamMessage"];
  activeTools: Map<string, ActiveToolRun>;
  openedAt: number;
  modelFallbackMessage?: string;
  ephemeral: boolean;
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
    schedule: Type.Optional(CronScheduleSchema),
  },
  {
    additionalProperties: false,
  },
);

export class PiService {
  private readonly config: AppConfig;
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly sessions = new Map<string, WebSession>();
  private readonly onAgentCompleted?: (session: SessionState) => Promise<void>;
  private readonly onWorkspaceUpdated?: (workspaceId: string) => Promise<void>;
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
    this.authStorage = AuthStorage.create(path.join(getAgentDir(), "auth.json"));
    this.modelRegistry = new ModelRegistry(
      this.authStorage,
      path.join(getAgentDir(), "models.json"),
    );
  }

  async listModels(): Promise<ModelOption[]> {
    const models = await this.modelRegistry.getAvailable();
    return models.map(toModelOption).sort((a, b) => a.label.localeCompare(b.label));
  }

  async listSessionSummaries(workspace: WorkspaceInfo): Promise<SessionSummary[]> {
    const infos = await SessionManager.list(workspace.path);
    return infos
      .map((info) => ({
        id: info.path,
        sessionId: info.id,
        name: info.name,
        path: info.path,
        firstMessage: info.firstMessage,
        updatedAt: info.modified.getTime(),
        messageCount: info.messageCount,
        workspaceId: workspace.id,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async createSession(
    workspace: WorkspaceInfo,
    options?: { modelId?: string; thinkingLevel?: string; ephemeral?: boolean },
  ): Promise<SessionState> {
    const result = await this.createPiAgentSession(
      workspace,
      SessionManager.create(workspace.path),
      {
        modelId: options?.modelId,
        thinkingLevel: options?.thinkingLevel,
      },
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
  }): Promise<{ sessionId: string }> {
    const session = await this.createSession(job.workspace, {
      modelId: job.model,
      thinkingLevel: job.thinkingLevel,
    });

    await this.prompt(session.id, job.prompt, []);

    return { sessionId: session.sessionId };
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  subscribe(sessionId: string, subscriber: SessionSubscriber): () => void {
    const webSession = this.requireSession(sessionId);
    webSession.subscribers.add(subscriber);
    subscriber({ type: "state", state: this.getState(sessionId) });
    return () => {
      webSession.subscribers.delete(subscriber);
      if (
        webSession.ephemeral &&
        webSession.subscribers.size === 0 &&
        !webSession.session.isStreaming
      ) {
        this.sessions.delete(webSession.id);
      }
    };
  }

  getState(sessionId: string): SessionState {
    const webSession = this.requireSession(sessionId);
    const contextUsage = webSession.session.getContextUsage();

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
      messages: webSession.session.messages,
      activeAssistant: webSession.activeAssistant,
      activeTools: [...webSession.activeTools.values()],
      title: webSession.session.sessionName,
    });
  }

  async setModel(sessionId: string, modelId: string): Promise<SessionState> {
    const webSession = this.requireSession(sessionId);
    const model = await this.resolveModel(modelId);
    await webSession.session.setModel(model);
    await this.refreshBattySystemPrompt(webSession);
    this.publish(webSession, { type: "state", state: this.getState(sessionId) });
    return this.getState(sessionId);
  }

  setThinkingLevel(sessionId: string, thinkingLevel: string): SessionState {
    const webSession = this.requireSession(sessionId);
    webSession.session.setThinkingLevel(thinkingLevel as AgentSession["thinkingLevel"]);
    this.publish(webSession, { type: "state", state: this.getState(sessionId) });
    return this.getState(sessionId);
  }

  async prompt(
    sessionId: string,
    text: string,
    files: UploadedFile[],
    streamingBehavior?: "steer" | "followUp",
  ): Promise<void> {
    const webSession = this.requireSession(sessionId);
    const prepared = await this.preparePromptFiles(sessionId, files);
    const parts = [text.trim(), prepared.text.trim()].filter(Boolean);
    const promptText = parts.join("\n\n").trim() || "Please inspect the attached files.";

    await webSession.session.prompt(promptText, {
      images: prepared.images,
      streamingBehavior,
    });
  }

  async abort(sessionId: string): Promise<void> {
    const webSession = this.requireSession(sessionId);
    await webSession.session.abort();
    this.publish(webSession, { type: "state", state: this.getState(sessionId) });
  }

  private async createPiAgentSession(
    workspace: WorkspaceInfo,
    sessionManager: SessionManager,
    options?: { modelId?: string; thinkingLevel?: string },
  ): Promise<Awaited<ReturnType<typeof createAgentSession>>> {
    const model = options?.modelId ? await this.resolveModel(options.modelId) : undefined;
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(workspace.path, agentDir);
    const persistedPrompt = findBattySystemPromptSnapshot(sessionManager.getEntries());
    const resourceLoader = new DefaultResourceLoader({
      cwd: workspace.path,
      agentDir,
      settingsManager,
      appendSystemPromptOverride: (base) => {
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
      model,
      thinkingLevel: options?.thinkingLevel as AgentSession["thinkingLevel"] | undefined,
      customTools: [this.createCronTool(workspace)],
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
    return webSession;
  }

  private publish(webSession: WebSession, event: ServerEvent): void {
    for (const subscriber of webSession.subscribers) {
      subscriber(event);
    }
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
        this.publish(webSession, { type: "state", state: this.getState(webSession.id) });
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
        this.publish(webSession, { type: "state", state: this.getState(webSession.id) });
        break;
      case "agent_end":
      case "turn_end":
      case "auto_compaction_end":
      case "auto_retry_end": {
        if (event.type === "agent_end") {
          webSession.activeAssistant = undefined;
        }
        const state = this.getState(webSession.id);
        this.publish(webSession, { type: "state", state });
        if (event.type === "agent_end") {
          try {
            console.info("Running agent completion hook", {
              sessionId: state.sessionId,
              workspaceId: state.workspaceId,
            });
            await this.onAgentCompleted?.(state);
          } catch (error) {
            console.error("Failed to run agent completion hook", error);
          }
          try {
            await this.notifyWorkspaceUpdated(state.workspaceId);
          } catch (error) {
            console.error("Failed to publish workspace update", error);
          }
          if (webSession.ephemeral && webSession.subscribers.size === 0) {
            this.sessions.delete(webSession.id);
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
    );

    webSession.session.sessionManager.appendCustomEntry(BATTY_SYSTEM_PROMPT_CUSTOM_TYPE, snapshot);
    await webSession.session.resourceLoader.reload();
    webSession.session.setActiveToolsByName(webSession.session.getActiveToolNames());
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
        "Prefer omitting model so the cron job reuses the current session model. Only set model explicitly if the user asks for a different model.",
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
            const currentModel = ctx.model ? modelKey(ctx.model as PiModel) : undefined;
            const input: CreateCronJobInput = {
              workspaceId,
              prompt: String(params.prompt ?? ""),
              model:
                typeof params.model === "string" && params.model.trim().length > 0
                  ? params.model.trim()
                  : (currentModel ?? ""),
              thinkingLevel:
                typeof params.thinkingLevel === "string" && params.thinkingLevel.trim().length > 0
                  ? params.thinkingLevel.trim()
                  : "medium",
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
