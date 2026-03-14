import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface UploadedFile {
  filename: string;
  data: Buffer;
}

import {
  AuthStorage,
  createAgentSession,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import mime from "mime-types";
import type {
  ActiveToolRun,
  ModelOption,
  ServerEvent,
  SessionState,
  SessionSummary,
  WorkspaceInfo,
} from "@/shared/types";
import type { AppConfig } from "./config";
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
  modelFallbackMessage?: string;
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

export class PiService {
  private readonly config: AppConfig;
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly sessions = new Map<string, WebSession>();

  constructor(config: AppConfig) {
    this.config = config;
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

  async createSession(workspace: WorkspaceInfo): Promise<SessionState> {
    const result = await createAgentSession({
      cwd: workspace.path,
      agentDir: getAgentDir(),
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      sessionManager: SessionManager.create(workspace.path),
    });

    const webSession = this.attachSession(workspace, result.session, result.modelFallbackMessage);
    return this.getState(webSession.id);
  }

  async openSession(workspace: WorkspaceInfo, sessionPath: string): Promise<SessionState> {
    const existing = [...this.sessions.values()].find(
      (candidate) => candidate.session.sessionFile === sessionPath,
    );
    if (existing) {
      return this.getState(existing.id);
    }

    const result = await createAgentSession({
      cwd: workspace.path,
      agentDir: getAgentDir(),
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      sessionManager: SessionManager.open(sessionPath),
    });

    const webSession = this.attachSession(workspace, result.session, result.modelFallbackMessage);
    return this.getState(webSession.id);
  }

  subscribe(sessionId: string, subscriber: SessionSubscriber): () => void {
    const webSession = this.requireSession(sessionId);
    webSession.subscribers.add(subscriber);
    subscriber({ type: "state", state: this.getState(sessionId) });
    return () => {
      webSession.subscribers.delete(subscriber);
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
      model: webSession.session.model ? modelKey(webSession.session.model) : undefined,
      modelLabel: webSession.session.model
        ? `${webSession.session.model.name} · ${webSession.session.model.provider}`
        : undefined,
      thinkingLevel: webSession.session.thinkingLevel,
      isStreaming: webSession.session.isStreaming,
      pendingMessageCount: webSession.session.pendingMessageCount,
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

  private attachSession(
    workspace: WorkspaceInfo,
    session: AgentSession,
    modelFallbackMessage?: string,
  ): WebSession {
    const webSession: WebSession = {
      id: session.sessionId,
      workspace,
      session,
      subscribers: new Set(),
      activeTools: new Map(),
      modelFallbackMessage,
    };

    session.subscribe((event) => this.handleAgentEvent(webSession, event));
    this.sessions.set(webSession.id, webSession);
    return webSession;
  }

  private publish(webSession: WebSession, event: ServerEvent): void {
    for (const subscriber of webSession.subscribers) {
      subscriber(event);
    }
  }

  private handleAgentEvent(webSession: WebSession, event: AgentSessionEvent): void {
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
          isError: false,
        });
        this.publish(webSession, { type: "tools", tools: [...webSession.activeTools.values()] });
        break;
      case "tool_execution_update": {
        const current = webSession.activeTools.get(event.toolCallId);
        if (current) {
          const blocks = normalizeBlocks(event.partialResult.content ?? []);
          current.blocks = current.toolName === "bash" ? sanitizeTerminalBlocks(blocks) : blocks;
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
          current.isError = event.isError;
          this.publish(webSession, { type: "tools", tools: [...webSession.activeTools.values()] });
          webSession.activeTools.delete(event.toolCallId);
        }
        break;
      }
      case "agent_start":
      case "agent_end":
      case "turn_end":
      case "auto_compaction_end":
      case "auto_retry_end":
        if (event.type === "agent_end") {
          webSession.activeAssistant = undefined;
          webSession.activeTools.clear();
        }
        this.publish(webSession, { type: "state", state: this.getState(webSession.id) });
        break;
      default:
        break;
    }
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
