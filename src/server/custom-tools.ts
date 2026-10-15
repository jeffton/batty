import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  TOOL_OUTPUT_TRUNCATION_DIRECTIONS,
  type ToolOutputTruncationDirection,
  type TruncatedToolName,
} from "@/shared/pi-tools";
import type { ToolExecutionDetails, WorkspaceInfo } from "@/shared/types";
import type { AppConfig } from "./config";
import type { BrowserService } from "./browser-service";
import { storeSentFiles } from "./send-files";
import { ATTACHMENT_DELIVERY_INSTRUCTION, reportWithAttachments } from "./attachment-contract";
import { createSite, deleteSite, getSite } from "./sites";
import { runWebSearch } from "./web-search";
import {
  AttachFilesToolSchema,
  BrowserToolSchema,
  SitesToolSchema,
  WebSearchToolSchema,
} from "./tool-schemas";
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

type CommonToolDependencies = { workspace: WorkspaceInfo; config: AppConfig };
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
      "Use this tool when a page requires JavaScript or multi-step interaction that web_search content cannot handle.",
      "Start with action=open. Browser state and cookies persist within the current Batty session only.",
      "Set useTailscale=true on the initial open to route that browser session through the configured SSH destination. Close the session before changing its routing.",
      "Use action=pages to list tabs and popups, action=switch with pageId to activate one, and newPage=true on open to create a tab.",
      "Reuse the active page for sequential research; use newPage=true only when comparing pages. Close rejected or finished research tabs immediately with action=close-page, and use action=pages periodically to keep the tab count low.",
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
      "Use action=close when the browser state is no longer needed.",
    ],
    parameters: BrowserToolSchema,
    execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
      signal?.throwIfAborted();
      const result = await browserService.execute(
        ctx.sessionManager.getSessionId(),
        {
          ...params,
          paths: params.paths?.map((value) => path.resolve(workspace.path, value)),
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
    name: "web_search",
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
        query: params.query,
        url: params.url,
        count: params.count,
        includeContent: params.includeContent,
        country: params.country,
        freshness: params.freshness,
      });
      const output = await spillToolOutputToTempFile(
        "web-search-output",
        toolCallId,
        {
          text: result.text,
          details: result.details,
        },
        "web_search",
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
      "Create, share, and delete hosted HTML sites. Create allocates a directory; use file tools to build or change its contents. Share attaches the site to the current response as a native site attachment that opens the site popover; ordinary links do not.",
    promptSnippet:
      "Create and deliver interactive HTML sites as native site attachments, not Markdown links.",
    promptGuidelines: [
      "Call create to allocate a site directory, then use write/edit tools to create index.html and its assets there.",
      "After building and checking the site, call share to attach it to your response. Do not replace the native site attachment with a plain URL or Markdown link; those do not open the site popover.",
      "To deliver a site from a subagent or other report, call attach_artifacts with its listed site ref in your own turn. Do not recreate or reshare it, or copy its URL as a substitute for attaching it.",
      "Use the browser URL from the result with the browser tool to inspect the site without changing its public setting.",
      "Use delete to permanently remove a site.",
    ],
    parameters: SitesToolSchema,
    execute: async (_toolCallId, params) => {
      if (params.action === "create") {
        const name = params.name?.trim();
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

      const siteId = params.siteId?.trim();
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
            text: `Shared site ${site.descriptor.id}. Attached to this response as a native site attachment; do not replace it with a URL or Markdown link.\nDirectory: ${site.directory}\nUser URL: ${site.descriptor.url}\nBrowser URL: ${site.browserUrl}`,
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
    name: "attach_files",
    label: "Attach Files",
    description: `Copy files into Batty storage so they appear as attachments in the current agent’s response and downloads during the tool call. ${ATTACHMENT_DELIVERY_INSTRUCTION}`,
    promptSnippet: "Attach files to the final response without leaving Batty.",
    promptGuidelines: [
      "Use this tool when the user asks you to send or attach one or more files.",
      ATTACHMENT_DELIVERY_INSTRUCTION,
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
        paths: params.paths,
        reuseExisting: true,
      });
      const count = sentFiles.length;
      const noun = count === 1 ? "file" : "files";
      return {
        content: [
          {
            type: "text",
            text: reportWithAttachments(
              `Attached ${count} ${noun} in this execution scope.`,
              sentFiles,
            ),
          },
        ],
        details: { sentFiles },
      };
    },
  };
}
