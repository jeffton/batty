import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { CLOUD_BROWSER_KEYS } from "@/shared/cloud-browser";

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

export type BrowserActionInput = Static<typeof BrowserToolSchema>;
export type BrowserAction = BrowserActionInput["action"];

const target = {
  pageId: Type.String({ minLength: 1, maxLength: 100 }),
  revision: Type.String({ minLength: 1, maxLength: 100 }),
};
const point = {
  x: Type.Number({ minimum: 0, maximum: 10_000 }),
  y: Type.Number({ minimum: 0, maximum: 10_000 }),
};
const command = (action: string, fields = {}) =>
  Type.Object({ action: Type.Literal(action), ...fields }, { additionalProperties: false });
const scrollCommand = command("scroll", {
  ...target,
  ...point,
  deltaX: Type.Number({ minimum: -10_000, maximum: 10_000 }),
  deltaY: Type.Number({ minimum: -10_000, maximum: 10_000 }),
});
export const CloudBrowserControlSchema = Type.Union([
  command("click", { ...target, ...point }),
  scrollCommand,
  command("drag", {
    ...target,
    ...point,
    endX: Type.Number({ minimum: 0, maximum: 10_000 }),
    endY: Type.Number({ minimum: 0, maximum: 10_000 }),
  }),
  command("fill-focused", {
    ...target,
    focusId: Type.String({ minLength: 1, maxLength: 100 }),
    value: Type.String({ maxLength: 10_000 }),
  }),
  command("text", { ...target, text: Type.String({ minLength: 1, maxLength: 10_000 }) }),
  command("key", {
    ...target,
    key: Type.String({ enum: [...CLOUD_BROWSER_KEYS] }),
    focusId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  }),
  command("navigate", {
    url: Type.String({ minLength: 1, maxLength: 8192, pattern: "^https?://" }),
  }),
  command("back"),
  command("reload"),
  command("switch", { pageId: target.pageId }),
  command("close-page", { pageId: target.pageId }),
  command("viewport", {
    width: Type.Integer({ minimum: 1, maximum: 10000 }),
    height: Type.Integer({ minimum: 1, maximum: 10000 }),
    mobile: Type.Boolean(),
    deviceScaleFactor: Type.Optional(Type.Number({ minimum: 1, maximum: 3 })),
  }),
]);

export const CloudBrowserSocketCommandSchema = Type.Union([
  command("ack", { frameId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) }),
  command("flush", { requestId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) }),
  scrollCommand,
]);
