import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
export const SitesToolSchema = Type.Object(
  {
    action: StringEnum(["create", "share", "delete", "function", "delete_function"] as const, {
      description: "Create/share/delete a site, or register/remove a site-scoped backend function.",
    }),
    functionName: Type.Optional(
      Type.String({ description: "Backend function name for function/delete_function." }),
    ),
    code: Type.Optional(
      Type.String({
        description:
          "QuickJS async function body. Read input with await tools.input(); return JSON. No Node/files/network except tools.request({connection, method, body}).",
      }),
    ),
    name: Type.Optional(
      Type.String({ description: "Display name. Required when creating a site." }),
    ),
    siteId: Type.Optional(
      Type.String({ description: "Site id. Required when sharing or deleting a site." }),
    ),
  },
  { additionalProperties: false },
);

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

export const WebSearchOutputSchema = Type.Union([
  Type.Object({
    action: Type.Literal("search"),
    query: Type.String(),
    count: Type.Number(),
    country: Type.String(),
    freshness: Type.Optional(Type.String()),
    includeContent: Type.Boolean(),
    results: Type.Array(
      Type.Object({
        title: Type.String(),
        link: Type.String(),
        snippet: Type.String(),
        age: Type.String(),
        content: Type.Optional(Type.String()),
      }),
    ),
  }),
  Type.Object({
    action: Type.Literal("content"),
    url: Type.String(),
    content: Type.String(),
  }),
]);

export { BrowserToolSchema } from "./browser-schemas";

export const AttachFilesToolSchema = Type.Object(
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
