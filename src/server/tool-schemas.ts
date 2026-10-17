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

export const BrowserToolSchema = Type.Object(
  {
    action: StringEnum(
      [
        "open",
        "attach",
        "pages",
        "switch",
        "close-page",
        "frames",
        "snapshot",
        "screenshot",
        "click",
        "fill",
        "press",
        "select",
        "upload",
        "download",
        "wait",
        "scroll",
        "hover",
        "back",
        "reload",
        "evaluate",
        "close",
      ] as const,
      { description: "Browser action to perform." },
    ),
    url: Type.Optional(Type.String({ description: "HTTP or HTTPS URL for action=open." })),
    pageId: Type.Optional(
      Type.String({ description: "Page to target. Defaults to the active page." }),
    ),
    frameId: Type.Optional(
      Type.String({ description: "Frame to target. Defaults to the page's main frame." }),
    ),
    newPage: Type.Optional(
      Type.Boolean({ description: "Open the URL in a new page and make it active." }),
    ),
    cloud: Type.Optional(
      Type.Boolean({
        description:
          "Enable shared interactive VPS access to this browser. Use action=attach to send a native browser button. Existing headless behavior is the default.",
      }),
    ),
    useTailscale: Type.Optional(
      Type.Boolean({
        description:
          "Route this browser session through the configured Tailscale SSH destination. Set only on the initial open. Defaults to false.",
      }),
    ),
    selector: Type.Optional(
      Type.String({ description: "Playwright locator selector for page element actions." }),
    ),
    value: Type.Optional(
      Type.String({ description: "Text for fill or a single option value for select." }),
    ),
    values: Type.Optional(
      Type.Array(Type.String(), { description: "Option values for a multi-select." }),
    ),
    paths: Type.Optional(
      Type.Array(Type.String(), {
        minItems: 1,
        description: "Local file paths for action=upload.",
      }),
    ),
    key: Type.Optional(Type.String({ description: "Key name for press, such as Enter." })),
    state: Type.Optional(
      StringEnum(["attached", "detached", "visible", "hidden"] as const, {
        description: "Desired element state for wait. Defaults to visible.",
      }),
    ),
    script: Type.Optional(
      Type.String({
        description:
          "JavaScript expression or function source for action=evaluate. Functions receive args.",
      }),
    ),
    args: Type.Optional(
      Type.Unknown({ description: "JSON-serializable value passed to an evaluated function." }),
    ),
    deltaX: Type.Optional(Type.Number({ description: "Horizontal pixels for action=scroll." })),
    deltaY: Type.Optional(Type.Number({ description: "Vertical pixels for action=scroll." })),
    viewport: Type.Optional(
      Type.Object(
        {
          width: Type.Integer({
            minimum: 1,
            maximum: 10_000,
            description: "Viewport width in CSS pixels.",
          }),
          height: Type.Integer({
            minimum: 1,
            maximum: 10_000,
            description: "Viewport height in CSS pixels.",
          }),
        },
        {
          additionalProperties: false,
          description: "Browser viewport size. Can be set on open or any active-page action.",
        },
      ),
    ),
    fullPage: Type.Optional(
      Type.Boolean({
        description: "Capture the full scrollable page for action=screenshot. Defaults to false.",
      }),
    ),
    timeoutMs: Type.Optional(
      Type.Integer({
        minimum: 1_000,
        maximum: 60_000,
        description: "Action timeout in milliseconds. Defaults to 30000.",
      }),
    ),
  },
  {
    additionalProperties: false,
  },
);

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
