import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
export const SitesToolSchema = Type.Object(
  {
    action: StringEnum(["create", "share", "delete"] as const, {
      description: "Create a site directory, share an existing site, or delete a site.",
    }),
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
