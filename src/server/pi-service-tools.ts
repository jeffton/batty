import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  TOOL_OUTPUT_TRUNCATION_DIRECTIONS,
  type ToolOutputTruncationDirection,
  type TruncatedToolName,
} from "@/shared/pi-tools";
import type {
  CreateCronJobInput,
  PreviousContextMode,
  ToolExecutionDetails,
  UpdateCronJobInput,
  WorkspaceInfo,
} from "@/shared/types";
import type { AppConfig } from "./config";
import type { BrowserService } from "./browser-service";
import { buildCronJobSummary, type CronService } from "./cron";
import { storeSentFiles } from "./send-files";
import { createSite, deleteSite, getSite } from "./sites";
import { runWebSearch } from "./web-search";
import { getSubagentSessionDepth, MAX_SUBAGENT_DEPTH, SUBAGENT_TOOL_NAME } from "./subagent";
import {
  AttachFilesToolSchema,
  BrowserToolSchema,
  CronToolSchema,
  SitesToolSchema,
  SubagentToolSchema,
  WebSearchToolSchema,
} from "./pi-service-schemas";

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

const TOOL_OUTPUT_MAX_LINES = 2_000;
const TOOL_OUTPUT_MAX_BYTES = 50 * 1024;

interface SpillableToolOutput {
  text: string;
  details: ToolExecutionDetails;
}

function normalizeLineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  return normalizeLineEndings(text).split("\n").length;
}

function truncateText(
  text: string,
  maxLines: number,
  maxBytes: number,
  direction: ToolOutputTruncationDirection,
): string {
  const normalizedText = normalizeLineEndings(text);
  const lines = normalizedText.split("\n");
  const selectedLines =
    lines.length <= maxLines
      ? normalizedText
      : direction === "head"
        ? lines.slice(0, maxLines).join("\n")
        : lines.slice(-maxLines).join("\n");
  const buffer = Buffer.from(selectedLines, "utf8");

  if (buffer.byteLength <= maxBytes) {
    return selectedLines;
  }

  if (direction === "head") {
    let end = maxBytes;
    while (end > 0 && (buffer[end]! & 0xc0) === 0x80) {
      end -= 1;
    }
    return buffer.subarray(0, end).toString("utf8");
  }

  let start = buffer.byteLength - maxBytes;
  while (start < buffer.byteLength && (buffer[start]! & 0xc0) === 0x80) {
    start += 1;
  }
  return buffer.subarray(start).toString("utf8");
}

function scrubWebSearchDetails(details: ToolExecutionDetails): ToolExecutionDetails {
  const scrubbed: ToolExecutionDetails = { ...details };

  if (typeof scrubbed.content === "string") {
    delete scrubbed.content;
  }

  if (Array.isArray(scrubbed.results)) {
    scrubbed.results = scrubbed.results.map((result) => {
      if (!result || typeof result !== "object" || !Object.hasOwn(result, "content")) {
        return result;
      }

      const { content: _content, ...rest } = result as Record<string, unknown>;
      return rest;
    });
  }

  return scrubbed;
}

export async function spillToolOutputToTempFile(
  label: string,
  toolCallId: string,
  output: SpillableToolOutput,
  toolName: TruncatedToolName,
): Promise<SpillableToolOutput> {
  const direction = TOOL_OUTPUT_TRUNCATION_DIRECTIONS[toolName];
  const lineCount = countLines(output.text);
  const byteCount = Buffer.byteLength(output.text, "utf8");
  if (lineCount <= TOOL_OUTPUT_MAX_LINES && byteCount <= TOOL_OUTPUT_MAX_BYTES) {
    return output;
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `batty-${label}-`));
  const filePath = path.join(dir, `${toolCallId.replace(/[^a-zA-Z0-9._-]/g, "-") || "output"}.txt`);
  await fs.writeFile(filePath, output.text, "utf8");

  const truncatedText = truncateText(
    output.text,
    TOOL_OUTPUT_MAX_LINES,
    TOOL_OUTPUT_MAX_BYTES,
    direction,
  );
  const message = [
    `Output exceeded ${TOOL_OUTPUT_MAX_LINES} lines or ${TOOL_OUTPUT_MAX_BYTES} bytes.`,
    `Showing the ${direction === "head" ? "first" : "last"} ${countLines(truncatedText)} lines / ${Buffer.byteLength(truncatedText, "utf8")} bytes.`,
    `Full output saved to: ${filePath}`,
    "Use the read tool on that path if you need more.",
  ].join("\n");

  return {
    text: `${message}\n\n${truncatedText}`,
    details: {
      ...scrubWebSearchDetails(output.details),
      truncated: true,
      fullOutputPath: filePath,
      outputLines: lineCount,
      outputBytes: byteCount,
    },
  };
}

interface DetachedSubagentResult {
  text: string;
  details: ToolExecutionDetails;
  isError: boolean;
}

function subagentToolContent(
  result: DetachedSubagentResult,
): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: result.text || "(no output)" }];
}

interface DetachedSubagentRequest {
  sessionId?: string;
  workspace: WorkspaceInfo;
  parentSessionId: string;
  parentSessionPath?: string;
  parentSubagentDepth: number;
  prompt: string;
  modelId: string;
  thinkingLevel: string;
  includePreviousContext: PreviousContextMode;
  respondIn: "tool-call" | "session";
  deliveryMode?: "append" | "prompt";
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
  runDetachedSubagentSession: (request: DetachedSubagentRequest) => Promise<DetachedSubagentResult>;
  startDetachedSubagentSession: (
    request: DetachedSubagentRequest,
  ) => Promise<DetachedSubagentResult>;
  stopSubagent: (parentSessionId: string, subagentSessionId: string) => Promise<void>;
  steerSubagent: (
    parentSessionId: string,
    subagentSessionId: string,
    prompt: string,
  ) => Promise<void>;
}

export interface CronToolDependencies {
  workspace: WorkspaceInfo;
  cronService: CronService;
  validateModel: (modelId: string) => void;
  resolveSubagentDefaults: ResolveSubagentDefaults;
}

export function createSubagentTool({
  workspace,
  resolveSubagentDefaults,
  runDetachedSubagentSession,
  startDetachedSubagentSession,
  stopSubagent,
  steerSubagent,
}: SubagentToolDependencies): ToolDefinition<typeof SubagentToolSchema> {
  return {
    name: SUBAGENT_TOOL_NAME,
    label: "Subagent",
    description:
      "Run a subagent in the current workspace, stop a running subagent, or queue steering instructions for one. Synchronous runs return the reply directly; async runs deliver it into the parent session later.",
    promptSnippet:
      "Run, stop, or steer a subagent in the current workspace. Async runs can be managed by session id.",
    promptGuidelines: [
      "Use this tool to delegate focused work to another agent without leaving the current session.",
      "Use action=run to start a subagent. Prefer omitting model and effort so it inherits the current session settings.",
      'Subagents start fresh by default. Set includePreviousContext=true for full context with prompt-cache reuse, or includePreviousContext="chat-only" for only user and assistant messages without transcript details.',
      "Set async=true to continue working while the subagent runs. Its result will automatically start or steer a later parent turn.",
      "Use action=steer with sessionId and prompt to queue additional instructions for a running subagent.",
      "Use action=stop with sessionId to stop a running subagent.",
    ],
    parameters: SubagentToolSchema,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const parentSessionId = ctx.sessionManager.getSessionId();
      if (params.action === "stop") {
        const subagentSessionId = String(params.sessionId ?? "").trim();
        if (!subagentSessionId) throw new Error("sessionId is required to stop a subagent");
        await stopSubagent(parentSessionId, subagentSessionId);
        return {
          content: [{ type: "text", text: `Stopped subagent ${subagentSessionId}.` }],
          details: {},
          isError: false,
        };
      }
      if (params.action === "steer") {
        const subagentSessionId = String(params.sessionId ?? "").trim();
        if (!subagentSessionId) throw new Error("sessionId is required to steer a subagent");
        const prompt = String(params.prompt ?? "").trim();
        if (!prompt) throw new Error("prompt is required to steer a subagent");
        await steerSubagent(parentSessionId, subagentSessionId, prompt);
        return {
          content: [{ type: "text", text: `Queued steering for subagent ${subagentSessionId}.` }],
          details: {},
          isError: false,
        };
      }

      const parentSubagentDepth = getSubagentSessionDepth(ctx.sessionManager.getEntries());
      if (parentSubagentDepth >= MAX_SUBAGENT_DEPTH) {
        throw new Error("subagent tool cannot be called more than two levels deep");
      }

      const defaults = resolveSubagentDefaults(parentSessionId, ctx);
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

      const includePreviousContext =
        params.includePreviousContext === true || params.includePreviousContext === "chat-only"
          ? params.includePreviousContext
          : false;
      const replay = ctx as unknown as {
        invocation: import("@earendil-works/pi-agent-core").AgentHarnessToolInvocation;
        childSessionId: () => string;
      };
      let childSessionId = (await replay.invocation.getMemo("child-session-id")) as
        | string
        | undefined;
      if (!childSessionId) {
        childSessionId = replay.childSessionId();
        await replay.invocation.setMemo("child-session-id", childSessionId);
      }
      const request: DetachedSubagentRequest = {
        sessionId: childSessionId,
        workspace,
        parentSessionId,
        parentSessionPath: (
          ctx.sessionManager as { getSessionFile?: () => string | undefined }
        ).getSessionFile?.(),
        parentSubagentDepth,
        prompt,
        modelId,
        thinkingLevel,
        includePreviousContext,
        respondIn: params.async === true ? "session" : "tool-call",
        currentToolCallId: toolCallId,
      };
      let result: DetachedSubagentResult;
      if (params.async === true) {
        signal?.throwIfAborted();
        result = await startDetachedSubagentSession({
          ...request,
          deliveryMode: "prompt",
        });
      } else {
        result = await runDetachedSubagentSession({
          ...request,
          signal,
          onUpdate,
        });
      }
      return {
        content: subagentToolContent(result),
        details: result.details,
        isError: result.isError,
      };
    },
  };
}

export function createCronTool({
  workspace,
  cronService,
  validateModel,
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
      'Use session.kind="daily-detached" to run asynchronously beside one workspace daily session.',
      'Daily detached runs start fresh by default. Set session.includePreviousContext=true for full context with prompt-cache reuse, or "chat-only" for only user and assistant messages without transcript details.',
      'Use schedule.kind="at" with schedule.in for relative times like 10m or 2h.',
      'Use schedule.kind="cron" with a standard cron expression and optional timezone for recurring schedules.',
      'Use schedule.kind="every" with durations like 15m, 2h, or 1d for interval schedules.',
      'Use action="list-run-logs" to inspect recent running and completed runs, including detached session paths.',
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
          const running = cronService.listRunningJobs(workspaceId);
          const scheduledText =
            jobs.length === 0
              ? `No cron jobs found for workspace ${workspaceId}.`
              : jobs.map(buildCronJobSummary).join("\n\n---\n\n");
          const runningText =
            running.length === 0
              ? "No running cron jobs."
              : running
                  .map(
                    (run) =>
                      `Running ${run.runId} · job ${run.jobId}\nStarted: ${new Date(run.startedAtMs).toISOString()}\nSession: ${run.sessionPath ?? "starting…"}\nPrompt: ${run.prompt}`,
                  )
                  .join("\n\n---\n\n");
          return {
            content: [{ type: "text", text: `${scheduledText}\n\n\n${runningText}` }],
            details: { count: jobs.length, runningCount: running.length, workspaceId, running },
          };
        }
        case "add": {
          const defaults = resolveSubagentDefaults(ctx.sessionManager.getSessionId(), ctx);
          const input: CreateCronJobInput = {
            workspaceId,
            enabled: typeof params.enabled === "boolean" ? params.enabled : undefined,
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
          validateModel(input.model);
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
            enabled: typeof params.enabled === "boolean" ? params.enabled : undefined,
            prompt: typeof params.prompt === "string" ? params.prompt : undefined,
            model: typeof params.model === "string" ? params.model.trim() : undefined,
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

          if (patch.model != null) {
            validateModel(patch.model);
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
        case "list-running": {
          const running = cronService.listRunningJobs(workspaceId);
          const text =
            running.length === 0
              ? `No running cron jobs found for workspace ${workspaceId}.`
              : running
                  .map(
                    (run) =>
                      `Running ${run.runId} · job ${run.jobId}\nStarted: ${new Date(run.startedAtMs).toISOString()}\nSession: ${run.sessionPath ?? "starting…"}\nPrompt: ${run.prompt}`,
                  )
                  .join("\n\n---\n\n");
          return {
            content: [{ type: "text", text }],
            details: { count: running.length, workspaceId, running },
          };
        }
        case "list-run-logs": {
          const logs = cronService.listRecentRunLogs(
            workspaceId,
            typeof params.limit === "number" ? params.limit : undefined,
          );
          const text =
            logs.length === 0
              ? `No recent cron run logs found for workspace ${workspaceId}.`
              : logs
                  .map(
                    (run) =>
                      `${run.status === "running" ? "Running" : run.status === "success" ? "Completed" : "Failed"} ${run.runId} · job ${run.jobId}\nStarted: ${new Date(run.startedAtMs).toISOString()}${run.completedAtMs == null ? "" : `\nCompleted: ${new Date(run.completedAtMs).toISOString()}`}\nSession: ${run.sessionPath ?? "starting…"}${run.error ? `\nError: ${run.error}` : ""}\nPrompt: ${run.prompt}`,
                  )
                  .join("\n\n---\n\n");
          return {
            content: [{ type: "text", text }],
            details: { count: logs.length, workspaceId, logs },
          };
        }
        case "stop-running": {
          const runId = String(params.runId ?? "").trim();
          const jobId = String(params.jobId ?? "").trim();
          if (!runId && !jobId) {
            throw new Error("runId or jobId is required for cron stop-running");
          }
          const stopped = cronService.stopRunningJob({
            runId: runId || undefined,
            jobId: jobId || undefined,
          });
          return {
            content: [{ type: "text", text: `Stopped running cron job ${stopped.runId}.` }],
            details: stopped,
          };
        }
        default:
          throw new Error(`Unknown cron action: ${action}`);
      }
    },
  };
}

export function createBrowserTool({
  browserService,
  workspace,
  config,
}: CommonToolDependencies & { browserService: BrowserService }): ToolDefinition<
  typeof BrowserToolSchema
> {
  return {
    name: "browser",
    label: "Browser",
    description:
      "Open and interact with JavaScript-driven web pages using a session-scoped headless Chromium browser.",
    promptSnippet: "Browse and interact with dynamic web pages using Playwright.",
    promptGuidelines: [
      "Use this tool when a page requires JavaScript or multi-step interaction that web-search content cannot handle.",
      "Start with action=open. Browser state and cookies persist within the current Batty session only.",
      "Set useTailscale=true on the initial open to route that browser session through the configured SSH destination. Close the session before changing its routing.",
      "Use action=pages to list tabs and popups, action=switch with pageId to activate one, and newPage=true on open to create a tab.",
      "Use action=frames to list frame IDs, then pass frameId to target an iframe.",
      'Selectors use Playwright locator syntax, for example input[name=q], text=Submit, or button:has-text("Next").',
      "Use action=upload with selector and paths for file inputs, and action=download with a selector that triggers a download.",
      "Use action=scroll with a selector to reveal an element, or deltaX/deltaY to scroll by pixels.",
      "Page actions return an accessibility snapshot. Use action=snapshot to inspect the page again.",
      "Use action=screenshot to capture the visible viewport, or set fullPage=true to capture the full scrollable page. The result includes a local PNG path that remains available after the browser session closes.",
      "Set viewport to control the browser width and height. Prefer setting it on open before the page loads.",
      "Use action=evaluate with a JavaScript expression when direct page inspection or manipulation is more efficient.",
      "Large text outputs are truncated and written to a temp file; use the read tool on the reported path when you need the full snapshot.",
      "Use action=wait with a selector when a dynamic page needs time to render the next state.",
      "Ask for explicit user approval before actions that submit forms, make bookings or purchases, or send messages.",
      "Use action=close when the browser state is no longer needed.",
    ],
    parameters: BrowserToolSchema,
    execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
      signal?.throwIfAborted();
      const result = await browserService.execute(
        ctx.sessionManager.getSessionId(),
        {
          action: params.action,
          url: typeof params.url === "string" ? params.url : undefined,
          pageId: typeof params.pageId === "string" ? params.pageId : undefined,
          frameId: typeof params.frameId === "string" ? params.frameId : undefined,
          newPage: typeof params.newPage === "boolean" ? params.newPage : undefined,
          useTailscale: typeof params.useTailscale === "boolean" ? params.useTailscale : undefined,
          selector: typeof params.selector === "string" ? params.selector : undefined,
          value: typeof params.value === "string" ? params.value : undefined,
          values: Array.isArray(params.values)
            ? params.values.filter((value): value is string => typeof value === "string")
            : undefined,
          paths: Array.isArray(params.paths)
            ? params.paths
                .filter((value): value is string => typeof value === "string")
                .map((value) => path.resolve(workspace.path, value))
            : undefined,
          key: typeof params.key === "string" ? params.key : undefined,
          state: params.state,
          script: typeof params.script === "string" ? params.script : undefined,
          args: params.args,
          deltaX: typeof params.deltaX === "number" ? params.deltaX : undefined,
          deltaY: typeof params.deltaY === "number" ? params.deltaY : undefined,
          viewport: params.viewport,
          fullPage: typeof params.fullPage === "boolean" ? params.fullPage : undefined,
          timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
        },
        signal,
      );
      const output = await spillToolOutputToTempFile(
        "browser-output",
        toolCallId,
        { text: result.text, details: result.details },
        "browser",
      );
      const sessionFile = ctx.sessionManager.getSessionFile();
      const sessionId =
        typeof sessionFile === "string" && sessionFile.length > 0
          ? path.basename(sessionFile, path.extname(sessionFile))
          : "ephemeral-session";
      const sentFiles = result.downloadPaths
        ? await storeSentFiles({
            rootDir: config.sentFilesDir,
            baseUrl: config.baseUrl,
            workspaceId: workspace.id,
            sessionId,
            toolCallId,
            cwd: workspace.path,
            paths: result.downloadPaths,
          })
        : [];
      return {
        content: [
          { type: "text" as const, text: output.text },
          ...(result.image ? [{ type: "image" as const, ...result.image }] : []),
        ],
        details: { ...output.details, ...(sentFiles.length > 0 ? { sentFiles } : {}) },
      };
    },
  };
}

export function createWebSearchTool(config: AppConfig): ToolDefinition<typeof WebSearchToolSchema> {
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
      "Large outputs are truncated and written to a temp file; use the read tool on the reported path when you need the full content.",
    ],
    parameters: WebSearchToolSchema,
    execute: async (toolCallId, params) => {
      const result = await runWebSearch({
        apiKey: config.braveSearchKey ?? "",
        action: params.action,
        query: typeof params.query === "string" ? params.query : undefined,
        url: typeof params.url === "string" ? params.url : undefined,
        count: typeof params.count === "number" ? params.count : undefined,
        includeContent: typeof params.includeContent === "boolean" ? params.includeContent : false,
        country: typeof params.country === "string" ? params.country : undefined,
        freshness: typeof params.freshness === "string" ? params.freshness : undefined,
      });
      const output = await spillToolOutputToTempFile(
        "web-search-output",
        toolCallId,
        {
          text: result.text,
          details: result.details,
        },
        "web-search",
      );
      return {
        content: [{ type: "text", text: output.text }],
        details: output.details,
      };
    },
  };
}

export function createSitesTool({
  config,
}: CommonToolDependencies): ToolDefinition<typeof SitesToolSchema> {
  return {
    name: "sites",
    label: "Sites",
    description:
      "Create, share, and delete hosted HTML sites. Create allocates a directory; use file tools to build or change its contents.",
    promptSnippet: "Create and share interactive HTML sites with the user.",
    promptGuidelines: [
      "Call create to allocate a site directory, then use write/edit tools to create index.html and its assets there.",
      "After building and checking the site, call share so it appears in the final response.",
      "Use the browser URL from the result with the browser tool to inspect the site without changing its public setting.",
      "Use delete to permanently remove a site.",
    ],
    parameters: SitesToolSchema,
    execute: async (_toolCallId, params) => {
      if (params.action === "create") {
        const name = typeof params.name === "string" ? params.name.trim() : "";
        if (!name) throw new Error("name is required for sites create");
        const site = await createSite(config.sitesDir, config.baseUrl, name);
        return {
          content: [
            {
              type: "text",
              text: `Created site ${site.descriptor.id}.\nDirectory: ${site.directory}\nUser URL: ${site.descriptor.url}\nBrowser URL: ${site.browserUrl}`,
            },
          ],
          details: {},
        };
      }

      const siteId = typeof params.siteId === "string" ? params.siteId.trim() : "";
      if (!siteId) throw new Error(`siteId is required for sites ${params.action}`);
      if (params.action === "delete") {
        await deleteSite(config.sitesDir, siteId);
        return {
          content: [{ type: "text", text: `Deleted site ${siteId}.` }],
          details: {},
        };
      }

      const site = await getSite(config.sitesDir, config.baseUrl, siteId);
      return {
        content: [
          {
            type: "text",
            text: `Shared site ${site.descriptor.id}.\nDirectory: ${site.directory}\nUser URL: ${site.descriptor.url}\nBrowser URL: ${site.browserUrl}`,
          },
        ],
        details: { sites: [site.descriptor] },
      };
    },
  };
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
