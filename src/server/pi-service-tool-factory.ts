import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolExecutionDetails, WorkspaceInfo } from "@/shared/types";
import type { AppConfig } from "./config";
import type { CronService } from "./cron";
import {
  createAttachFilesTool,
  createCronTool,
  createSubagentTool,
  createWebSearchTool,
} from "./pi-service-tools";

export type PiServiceToolFactoryContext = {
  config: AppConfig;
  cronService: CronService;
  validateModel: (modelId: string) => void;
  resolveSubagentDefaults: (
    sessionId: string,
    ctx: ExtensionContext,
  ) => { modelId?: string; thinkingLevel: string };
  runDetachedSubagentSession: (request: {
    workspace: WorkspaceInfo;
    parentSessionId: string;
    parentSessionPath?: string;
    contextBranchLeafId?: string | null;
    prompt: string;
    modelId: string;
    thinkingLevel: string;
    includeSessionContext: boolean;
    respondIn: "tool-call" | "session";
    preludeNotices?: Array<{ kind: "cron" | "subagent"; text: string }>;
    currentToolCallId?: string;
    signal?: AbortSignal;
    onUpdate?: (partial: {
      content: Array<{ type: "text"; text: string }>;
      details: ToolExecutionDetails;
    }) => void;
  }) => Promise<{
    text: string;
    details: ToolExecutionDetails;
    finalAssistant?: AssistantMessage;
    isError: boolean;
    errorMessage?: string;
  }>;
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
    }),
    createCronTool({
      workspace,
      cronService: context.cronService,
      validateModel: context.validateModel,
      resolveSubagentDefaults: context.resolveSubagentDefaults,
    }),
    createWebSearchTool(context.config),
    createAttachFilesTool({
      workspace,
      config: context.config,
    }),
  ];
}
