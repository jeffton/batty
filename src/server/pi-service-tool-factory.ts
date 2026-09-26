import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PreviousContextMode, ToolExecutionDetails, WorkspaceInfo } from "@/shared/types";
import type { AppConfig } from "./config";
import type { BrowserService } from "./browser-service";
import type { CronService } from "./cron";
import {
  createAttachFilesTool,
  createBrowserTool,
  createCronTool,
  createSitesTool,
  createSubagentTool,
  createWebSearchTool,
  type SubagentToolDependencies,
} from "./pi-service-tools";

type DetachedSubagentToolRequest = {
  sessionId?: string;
  workspace: WorkspaceInfo;
  parentSessionId: string;
  parentSessionPath?: string;
  parentSubagentDepth: number;
  contextBranchLeafId?: string | null;
  prompt: string;
  modelId: string;
  thinkingLevel: string;
  includePreviousContext: PreviousContextMode;
  respondIn: "tool-call" | "session";
  deliveryMode?: "append" | "prompt";
  preludeNotices?: Array<{ kind: "cron" | "subagent"; text: string }>;
  currentToolCallId?: string;
  signal?: AbortSignal;
  onUpdate?: (partial: {
    content: Array<{ type: "text"; text: string }>;
    details: ToolExecutionDetails;
  }) => void;
};

type DetachedSubagentToolResult = {
  text: string;
  details: ToolExecutionDetails;
  finalAssistant?: AssistantMessage;
  isError: boolean;
  errorMessage?: string;
};

export type PiServiceToolFactoryContext = {
  config: AppConfig;
  browserService: BrowserService;
  cronService: CronService;
  validateModel: (modelId: string) => void;
  resolveSubagentDefaults: (
    sessionId: string,
    ctx: ExtensionContext,
  ) => { modelId?: string; thinkingLevel: string };
  runDetachedSubagentSession: (
    request: DetachedSubagentToolRequest,
  ) => Promise<DetachedSubagentToolResult>;
  startDetachedSubagentSession: (
    request: DetachedSubagentToolRequest,
  ) => Promise<DetachedSubagentToolResult>;
  stopSubagent: (parentSessionId: string, subagentSessionId: string) => Promise<void>;
  steerSubagent: (
    parentSessionId: string,
    subagentSessionId: string,
    prompt: string,
  ) => Promise<void>;
  continueSubagent: SubagentToolDependencies["continueSubagent"];
};

export function createPiServiceTools(
  context: PiServiceToolFactoryContext,
  workspace: WorkspaceInfo,
): ToolDefinition<any>[] {
  return [
    createSubagentTool({
      workspace,
      config: context.config,
      resolveSubagentDefaults: context.resolveSubagentDefaults,
      runDetachedSubagentSession: context.runDetachedSubagentSession,
      startDetachedSubagentSession: context.startDetachedSubagentSession,
      stopSubagent: context.stopSubagent,
      steerSubagent: context.steerSubagent,
      continueSubagent: context.continueSubagent,
    }),
    createCronTool({
      workspace,
      cronService: context.cronService,
      validateModel: context.validateModel,
      resolveSubagentDefaults: context.resolveSubagentDefaults,
    }),
    createWebSearchTool(context.config),
    createBrowserTool({
      browserService: context.browserService,
      workspace,
      config: context.config,
    }),
    createSitesTool({ workspace, config: context.config }),
    createAttachFilesTool({
      workspace,
      config: context.config,
    }),
  ];
}
