import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { SUBAGENT_EFFORT_LEVELS } from "./subagent";

const CronScheduleSchema = Type.Object(
  {
    kind: StringEnum(["at", "every", "cron"] as const, {
      description: "Schedule kind.",
    }),
    at: Type.Optional(Type.String({ description: "Absolute time for at jobs." })),
    in: Type.Optional(Type.String({ description: "Relative duration for at jobs, like 10m." })),
    every: Type.Optional(Type.String({ description: "Interval duration like 15m or 2h." })),
    expression: Type.Optional(Type.String({ description: "Cron expression for recurring jobs." })),
    timezone: Type.Optional(Type.String({ description: "IANA timezone for cron jobs." })),
  },
  {
    additionalProperties: false,
    description:
      'Use {kind:"at", in:"10m"} or {kind:"at", at:"2026-03-21T09:00:00+01:00"} or {kind:"every", every:"2h"} or {kind:"cron", expression:"0 9 * * 1-5", timezone:"Europe/Copenhagen"}.',
  },
);

const CronSessionSchema = Type.Union(
  [
    Type.Object(
      {
        kind: Type.Literal("new", {
          description: "Run each cron job in a fresh session.",
        }),
      },
      {
        additionalProperties: false,
      },
    ),
    Type.Object(
      {
        kind: Type.Literal("daily-inline", {
          description: "Run directly in one workspace daily session.",
        }),
      },
      {
        additionalProperties: false,
      },
    ),
    Type.Object(
      {
        kind: Type.Literal("daily-detached", {
          description: "Run asynchronously beside one workspace daily session.",
        }),
        includePreviousContext: Type.Optional(
          Type.Boolean({
            description:
              "Whether the cron run should include previous daily-session context. Defaults to false.",
          }),
        ),
      },
      {
        additionalProperties: false,
      },
    ),
  ],
  {
    description:
      'Use {kind:"new"} for a fresh session each run, {kind:"daily-inline"} to run directly in one workspace daily session, or {kind:"daily-detached"} to run asynchronously beside that daily session. Detached runs start fresh unless includePreviousContext:true is set.',
  },
);

export const CronToolSchema = Type.Object(
  {
    action: StringEnum(
      ["list", "add", "update", "remove", "list-running", "list-run-logs", "stop-running"] as const,
      {
        description: "Which cron action to perform.",
      },
    ),
    jobId: Type.Optional(
      Type.String({ description: "Job id for update, remove, or stopping a running job." }),
    ),
    runId: Type.Optional(Type.String({ description: "Running cron run id for stop-running." })),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 100,
        description: "Maximum number of recent cron run logs to return. Defaults to 100.",
      }),
    ),
    workspaceId: Type.Optional(
      Type.String({ description: "Target workspace id. Defaults to the current workspace." }),
    ),
    enabled: Type.Optional(
      Type.Boolean({ description: "Whether the cron job is enabled. Defaults to true." }),
    ),
    prompt: Type.Optional(
      Type.String({ description: "Prompt the scheduled agent turn should run." }),
    ),
    model: Type.Optional(
      Type.String({ description: "Model id for the scheduled job, for example openai/gpt-5." }),
    ),
    thinkingLevel: Type.Optional(
      Type.String({
        description:
          "Thinking level for the scheduled job: off, minimal, low, medium, high, xhigh, max.",
      }),
    ),
    session: Type.Optional(CronSessionSchema),
    schedule: Type.Optional(CronScheduleSchema),
  },
  {
    additionalProperties: false,
  },
);

export const SubagentToolSchema = Type.Object(
  {
    prompt: Type.String({ description: "Prompt the subagent should run." }),
    model: Type.Optional(
      Type.String({ description: "Model id for the subagent, for example openai/gpt-5." }),
    ),
    effort: Type.Optional(
      StringEnum(SUBAGENT_EFFORT_LEVELS, {
        description: "Effort level for the subagent: off, minimal, low, medium, high, xhigh, max.",
      }),
    ),
    includeSessionContext: Type.Optional(
      Type.Boolean({
        default: false,
        description:
          "Whether to include the current session context. Defaults to false. When false, the subagent still gets the workspace system prompts.",
      }),
    ),
    async: Type.Optional(
      Type.Boolean({
        default: false,
        description:
          "Run in the background and deliver the result into the parent session. Defaults to false.",
      }),
    ),
  },
  {
    additionalProperties: false,
  },
);

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
