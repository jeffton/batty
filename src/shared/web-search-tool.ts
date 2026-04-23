import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { runWebSearch } from "./web-search";

export const WebSearchToolSchema = Type.Object(
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

export interface CreateWebSearchToolDefinitionOptions {
  getApiKey: () => string | Promise<string>;
  missingApiKeyMessage?: string;
}

export function createWebSearchToolDefinition(
  options: CreateWebSearchToolDefinitionOptions,
): ToolDefinition<typeof WebSearchToolSchema> {
  return {
    name: "web-search",
    label: "Web Search",
    description:
      "Search the web with Brave Search and extract readable markdown content from result pages.",
    promptSnippet: "Search the web or extract readable page content without leaving the agent.",
    promptGuidelines: [
      "Use this tool for web lookups, current facts, API docs, or extracting readable page content from URLs.",
      'Use action="search" with query for web search.',
      'Use action="content" with url to extract readable markdown from a specific page.',
      "Set includeContent=true when you need the actual page text for the search results.",
    ],
    parameters: WebSearchToolSchema,
    execute: async (_toolCallId, params) => {
      const result = await runWebSearch({
        apiKey: await options.getApiKey(),
        missingApiKeyMessage: options.missingApiKeyMessage,
        action: params.action,
        query: typeof params.query === "string" ? params.query : undefined,
        url: typeof params.url === "string" ? params.url : undefined,
        count: typeof params.count === "number" ? params.count : undefined,
        includeContent: typeof params.includeContent === "boolean" ? params.includeContent : false,
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
