import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type {
  CronJobSession,
  SessionState,
  ToolExecutionDetails,
  WorkspaceInfo,
} from "@/shared/types";
import { buildCronRuntimeNotice } from "./runtime-notices";
import { normalizeBlocks } from "./pi-state";
import { SUBAGENT_TOOL_NAME } from "./subagent";
import {
  appendCronSubagentCompletion,
  appendCronSubagentStart,
  appendRuntimeNoticeMessage,
  buildFailedCronSubagentResult,
  findDanglingCronSubagentToolCall,
} from "./pi-service-subagents";
import { normalizeToolDetails, type WebSession } from "./pi-service-types";

export type CronJobRun = {
  workspace: WorkspaceInfo;
  prompt: string;
  model: string;
  thinkingLevel: string;
  session: CronJobSession;
  scheduleLabel: string;
};

export type PiServiceCronAdapterContext = {
  cronSubagentAbortControllers: Map<string, AbortController>;
  createSession: (
    workspace: WorkspaceInfo,
    options?: { modelId?: string; thinkingLevel?: string; ephemeral?: boolean },
  ) => Promise<SessionState>;
  prompt: (
    sessionId: string,
    text: string,
    files: [],
    streamingBehavior?: "steer" | "followUp",
  ) => Promise<void>;
  resolveOrCreateDailySession: (
    workspace: WorkspaceInfo,
    options?: { modelId?: string; thinkingLevel?: string },
  ) => Promise<SessionState>;
  requireSession: (sessionId: string) => WebSession;
  requireSessionPath: (sessionId: string) => string;
  runSubagentSerial: <T>(sessionId: string, run: () => Promise<T>) => Promise<T>;
  getState: (sessionId: string) => SessionState;
  publishReset: (webSession: WebSession, state: SessionState) => void;
  publishTools: (webSession: WebSession) => void;
  setThinkingLevel: (sessionId: string, thinkingLevel: string) => SessionState;
  setModel: (sessionId: string, modelId: string) => Promise<SessionState>;
  runDetachedSubagentSession: (options: {
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
  onAgentCompleted?: (session: SessionState) => Promise<void>;
  notifyWorkspaceUpdated: (workspaceId: string) => Promise<void>;
};

export async function runCronJobSession(
  context: PiServiceCronAdapterContext,
  job: CronJobRun,
): Promise<{ sessionId: string; sessionPath: string }> {
  const cronNotice = buildCronRuntimeNotice(job.scheduleLabel);
  if (job.session.kind === "new") {
    const session = await context.createSession(job.workspace, {
      modelId: job.model,
      thinkingLevel: job.thinkingLevel,
    });
    const current = context.requireSession(session.id);
    appendRuntimeNotice(current.session, cronNotice);
    await context.prompt(
      session.id,
      job.prompt,
      [],
      current.session.isStreaming ? "followUp" : undefined,
    );

    return {
      sessionId: current.session.sessionId,
      sessionPath: context.requireSessionPath(session.id),
    };
  }

  const session = await context.resolveOrCreateDailySession(job.workspace, {
    modelId: job.model,
    thinkingLevel: job.thinkingLevel,
  });
  const webSession = context.requireSession(session.id);

  return context.runSubagentSerial(webSession.session.sessionId, async () => {
    const recovered = recoverDanglingCronSubagent(
      context,
      webSession,
      "Cron subagent did not finish before the server stopped.",
    );
    if (recovered) {
      context.publishReset(webSession, context.getState(webSession.id));
      context.publishTools(webSession);
    }
    await webSession.session.agent.waitForIdle();

    if (job.session.kind === "daily-inline") {
      context.setThinkingLevel(session.id, job.thinkingLevel);
      await context.setModel(session.id, job.model);
      appendRuntimeNotice(webSession.session, cronNotice);
      context.publishReset(webSession, context.getState(webSession.id));
      await webSession.session.prompt(job.prompt);
      return {
        sessionId: webSession.session.sessionId,
        sessionPath: context.requireSessionPath(webSession.id),
      };
    }
    if (job.session.kind !== "daily-subagent") {
      throw new Error(`Invalid cron session kind: ${job.session.kind}`);
    }

    const includePreviousContext = job.session.includePreviousContext === true;
    const contextBranchLeafId = includePreviousContext
      ? webSession.session.sessionManager.getLeafId()
      : undefined;
    const parentSessionPath = context.requireSessionPath(webSession.id);
    const toolCallId = `${SUBAGENT_TOOL_NAME}-${randomUUID()}`;
    const toolArgs = {
      prompt: job.prompt,
      model: job.model,
      effort: job.thinkingLevel,
      includeSessionContext: includePreviousContext,
    };

    appendCronSubagentStart(webSession.session, toolCallId, toolArgs, cronNotice);
    webSession.activeTools.set(toolCallId, {
      toolCallId,
      toolName: SUBAGENT_TOOL_NAME,
      args: toolArgs,
      blocks: [],
      status: "running",
      isError: false,
      details: undefined,
    });
    context.publishReset(webSession, context.getState(webSession.id));

    let completionAppended = false;
    const abortController = new AbortController();
    context.cronSubagentAbortControllers.set(toolCallId, abortController);
    try {
      const result = await context.runDetachedSubagentSession({
        workspace: job.workspace,
        parentSessionId: webSession.session.sessionId,
        parentSessionPath,
        contextBranchLeafId,
        prompt: job.prompt,
        modelId: job.model,
        thinkingLevel: job.thinkingLevel,
        includeSessionContext: includePreviousContext,
        respondIn: "session",
        preludeNotices: [cronNotice],
        currentToolCallId: toolCallId,
        signal: abortController.signal,
        onUpdate: (partial) => {
          const current = webSession.activeTools.get(toolCallId);
          if (!current) {
            return;
          }
          current.blocks = normalizeBlocks(partial.content ?? []);
          current.details = normalizeToolDetails(partial.details);
          webSession.activeTools.set(toolCallId, current);
          context.publishTools(webSession);
        },
      });

      appendCronSubagentCompletion(webSession.session, toolCallId, result);
      completionAppended = true;
      const completedState = context.getState(webSession.id);
      context.publishReset(webSession, completedState);
      try {
        await context.onAgentCompleted?.({
          ...completedState,
          isStreaming: false,
          pendingMessageCount: 0,
          activeAssistant: undefined,
        });
      } catch (error) {
        console.error("Failed to run agent completion hook for cron subagent", error);
      }
      await context.notifyWorkspaceUpdated(job.workspace.id);

      if (result.isError) {
        throw new Error(result.errorMessage || result.text || "Subagent failed");
      }

      return {
        sessionId: webSession.session.sessionId,
        sessionPath: context.requireSessionPath(webSession.id),
      };
    } catch (error) {
      if (
        !completionAppended &&
        findDanglingCronSubagentToolCall(webSession.session)?.id === toolCallId
      ) {
        appendCronSubagentCompletion(
          webSession.session,
          toolCallId,
          buildFailedCronSubagentResult(toolArgs, error),
        );
        context.publishReset(webSession, context.getState(webSession.id));
      }
      throw error;
    } finally {
      context.cronSubagentAbortControllers.delete(toolCallId);
      webSession.activeTools.delete(toolCallId);
      context.publishTools(webSession);
    }
  });
}

export function recoverDanglingCronSubagent(
  context: Pick<PiServiceCronAdapterContext, "cronSubagentAbortControllers">,
  webSession: WebSession,
  error: string,
): boolean {
  const dangling = findDanglingCronSubagentToolCall(webSession.session);
  if (!dangling) {
    return false;
  }

  context.cronSubagentAbortControllers.get(dangling.id)?.abort();
  context.cronSubagentAbortControllers.delete(dangling.id);
  webSession.activeTools.delete(dangling.id);
  appendCronSubagentCompletion(
    webSession.session,
    dangling.id,
    buildFailedCronSubagentResult(dangling.args, error),
  );
  return true;
}

const appendRuntimeNotice = appendRuntimeNoticeMessage;
