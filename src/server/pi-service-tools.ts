import path from "node:path";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import type {
  CreateCronJobInput,
  ToolExecutionDetails,
  UpdateCronJobInput,
  WorkspaceInfo,
} from "@/shared/types";
import type { AppConfig } from "./config";
import { createWebSearchToolDefinition } from "../shared/web-search-tool";
import { buildCronJobSummary, type CronService } from "./cron";
import { storeSentFiles } from "./send-files";
import { hasSubagentSessionMarker, SUBAGENT_TOOL_NAME } from "./subagent";
import { AttachFilesToolSchema, CronToolSchema, SubagentToolSchema } from "./pi-service-schemas";

type ResolveSubagentDefaults = (
  sessionId: string,
  ctx: ExtensionContext,
) => {
  modelId?: string;
  thinkingLevel: string;
};

type ToolUpdate = {
  content: Array<{ type: "text"; text: string }>;
  details: ToolExecutionDetails;
};

interface DetachedSubagentResult {
  text: string;
  details: ToolExecutionDetails;
  isError: boolean;
}

interface DetachedSubagentRequest {
  workspace: WorkspaceInfo;
  parentSessionId: string;
  prompt: string;
  modelId: string;
  thinkingLevel: string;
  includeSessionContext: boolean;
  respondIn: "tool-call" | "session";
  currentToolCallId?: string;
  signal?: AbortSignal;
  onUpdate?: (partial: ToolUpdate) => void;
}

interface CommonToolDependencies {
  workspace: WorkspaceInfo;
  config: AppConfig;
}

export interface SubagentToolDependencies extends CommonToolDependencies {
  resolveSubagentDefaults: ResolveSubagentDefaults;
  runSubagentSerial: <T>(sessionId: string, run: () => Promise<T>) => Promise<T>;
  runDetachedSubagentSession: (request: DetachedSubagentRequest) => Promise<DetachedSubagentResult>;
}

export interface CronToolDependencies {
  workspace: WorkspaceInfo;
  cronService: CronService;
  resolveSubagentDefaults: ResolveSubagentDefaults;
}

export function createSubagentTool({
  workspace,
  resolveSubagentDefaults,
  runSubagentSerial,
  runDetachedSubagentSession,
}: SubagentToolDependencies): ToolDefinition<typeof SubagentToolSchema> {
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
      "Subagents start fresh by default and only get the workspace system prompts unless includeSessionContext=true is set.",
    ],
    parameters: SubagentToolSchema,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      if (hasSubagentSessionMarker(ctx.sessionManager.getEntries())) {
        throw new Error("subagent tool cannot be called from inside a subagent session");
      }

      const sessionId = ctx.sessionManager.getSessionId();
      const defaults = resolveSubagentDefaults(sessionId, ctx);
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

      const includeSessionContext = params.includeSessionContext === true;
      return runSubagentSerial(sessionId, async () => {
        const result = await runDetachedSubagentSession({
          workspace,
          parentSessionId: sessionId,
          prompt,
          modelId,
          thinkingLevel,
          includeSessionContext,
          respondIn: "session",
          currentToolCallId: toolCallId,
          signal,
          onUpdate,
        });
        return {
          content: result.isError ? [{ type: "text", text: result.text || "(no output)" }] : [],
          details: result.details,
          isError: result.isError,
        };
      });
    },
  };
}

export function createCronTool({
  workspace,
  cronService,
  resolveSubagentDefaults,
}: CronToolDependencies): ToolDefinition<typeof CronToolSchema> {
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
      'Use session.kind="daily-inline" to run directly in one workspace daily session.',
      'Use session.kind="daily-subagent" to run in one workspace daily session as a subagent tool call.',
      "Daily-subagent runs start fresh by default and only reuse earlier daily-session context when session.includePreviousContext=true is set.",
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
          const jobs = cronService.listJobs(workspaceId);
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
          const defaults = resolveSubagentDefaults(ctx.sessionManager.getSessionId(), ctx);
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
          const job = await cronService.createJob(input);
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

          const job = await cronService.updateJob(jobId, patch);
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
          const job = await cronService.deleteJob(jobId);
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

export function createWebSearchTool(config: AppConfig) {
  return createWebSearchToolDefinition({
    getApiKey: () => config.braveSearchKey ?? "",
  });
}

export function createAttachFilesTool({
  workspace,
  config,
}: CommonToolDependencies): ToolDefinition<typeof AttachFilesToolSchema> {
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
        rootDir: config.sentFilesDir,
        baseUrl: config.baseUrl,
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
