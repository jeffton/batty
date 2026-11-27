import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import mime from "mime-types";
import type { Frame, Page } from "patchright";
import type { BrowserDescriptor } from "@/shared/types";
import { copyIsolatedBrowserDownload } from "./browser-download";
import type { BrowserIsolation } from "./browser-isolation";
import { readBrowserJson } from "./browser-persistence";
import type { BrowserAction, BrowserActionInput, BrowserIdentityMode } from "./browser-schemas";
import { frameId, pageId, type BrowserSession } from "./browser-pages";

const DEFAULT_TIMEOUT_MS = 30_000;
const SCREENSHOTS_DIR = path.join(os.tmpdir(), "batty-browser-screenshots");

interface BrowserPageDetails {
  id: string;
  url: string;
  title: string;
  active: boolean;
  identity: BrowserIdentityMode;
}

interface BrowserFrameDetails {
  id: string;
  name: string;
  url: string;
  parentId?: string;
}

export interface BrowserActionResult {
  text: string;
  details: {
    action: BrowserAction;
    pageId?: string;
    frameId?: string;
    url?: string;
    title?: string;
    pages?: BrowserPageDetails[];
    frames?: BrowserFrameDetails[];
    downloadPaths?: string[];
    screenshotPath?: string;
    sites?: BrowserDescriptor[];
  };
  image?: {
    data: string;
    mimeType: "image/png";
  };
  downloadPaths?: string[];
}

interface ActionOutput {
  image?: Buffer;
  screenshotPath?: string;
  text?: string;
  downloadPaths?: string[];
}

export function required(value: string | undefined, name: string, action: BrowserAction): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required for browser ${action}`);
  return trimmed;
}

function present(value: string | undefined, name: string, action: BrowserAction): string {
  if (value == null) throw new Error(`${name} is required for browser ${action}`);
  return value;
}

export function validateUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("browser open only supports http and https URLs");
  }
  return url.toString();
}

export function timeout(input: BrowserActionInput): number {
  return Math.min(Math.max(Math.floor(input.timeoutMs ?? DEFAULT_TIMEOUT_MS), 1_000), 60_000);
}

function safeDownloadName(name: string): string {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]+/g, "-") || "download";
}

async function createScreenshotPath(): Promise<string> {
  await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
  const directory = await fs.mkdtemp(path.join(SCREENSHOTS_DIR, "screenshot-"));
  return path.join(directory, "screenshot.png");
}

function formatEvaluationResult(value: unknown): string {
  return typeof value === "string"
    ? value
    : inspect(value, {
        breakLength: 120,
        compact: false,
        depth: null,
        maxArrayLength: null,
        maxStringLength: null,
      });
}

export async function performPageAction(
  session: BrowserSession,
  page: Page,
  frame: Frame,
  input: BrowserActionInput,
  signal?: AbortSignal,
): Promise<ActionOutput> {
  signal?.throwIfAborted();
  switch (input.action) {
    case "snapshot":
      return {};
    case "screenshot": {
      const image = await page.screenshot({
        fullPage: input.fullPage ?? false,
        type: "png",
        signal,
      });
      signal?.throwIfAborted();
      const screenshotPath = await createScreenshotPath();
      await fs.writeFile(screenshotPath, image);
      return { image, screenshotPath };
    }
    case "click":
      await frame.locator(required(input.selector, "selector", input.action)).click({ signal });
      return {};
    case "fill":
      await frame
        .locator(required(input.selector, "selector", input.action))
        .fill(present(input.value, "value", input.action), { signal });
      return {};
    case "press":
      await frame
        .locator(required(input.selector, "selector", input.action))
        .press(required(input.key, "key", input.action), { signal });
      return {};
    case "select": {
      const values = input.values ?? (input.value == null ? [] : [input.value]);
      if (values.length === 0) throw new Error("value or values is required for browser select");
      await frame
        .locator(required(input.selector, "selector", input.action))
        .selectOption(values, { signal });
      return {};
    }
    case "upload": {
      const paths = input.paths ?? [];
      if (paths.length === 0) throw new Error("paths is required for browser upload");
      await frame.locator(required(input.selector, "selector", input.action)).setInputFiles(
        await Promise.all(
          paths.map(async (file) => ({
            name: path.basename(file),
            mimeType: mime.lookup(file) || "application/octet-stream",
            buffer: await fs.readFile(file),
          })),
        ),
        { signal },
      );
      return {};
    }
    case "download": {
      const [download] = await Promise.all([
        page.waitForEvent("download", { signal }),
        frame.locator(required(input.selector, "selector", input.action)).click({ signal }),
      ]);
      signal?.throwIfAborted();
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "batty-browser-download-"));
      session.downloadDirs.add(dir);
      const downloadPath = path.join(dir, safeDownloadName(download.suggestedFilename()));
      const isolation = await readBrowserJson<BrowserIsolation>(
        path.join(session.directory, "isolation.json"),
      );
      if (isolation) {
        await copyIsolatedBrowserDownload((await download.path())!, downloadPath, isolation);
      } else {
        await download.saveAs(downloadPath);
      }
      return {
        text: `Downloaded ${download.suggestedFilename()}.\nSaved to: ${downloadPath}`,
        downloadPaths: [downloadPath],
      };
    }
    case "wait":
      await frame.locator(required(input.selector, "selector", input.action)).waitFor({
        state: input.state ?? "visible",
        timeout: timeout(input),
        signal,
      });
      return {};
    case "scroll":
      if (input.selector) {
        await frame.locator(input.selector).scrollIntoViewIfNeeded({ signal });
      } else {
        await frame.evaluate(({ deltaX, deltaY }) => window.scrollBy(deltaX, deltaY), {
          deltaX: input.deltaX ?? 0,
          deltaY: input.deltaY ?? 0,
        });
      }
      return {};
    case "hover":
      await frame.locator(required(input.selector, "selector", input.action)).hover({ signal });
      return {};
    case "back":
      await page.goBack({ waitUntil: "domcontentloaded", signal });
      return {};
    case "reload":
      await page.reload({ waitUntil: "domcontentloaded", signal });
      return {};
    case "evaluate": {
      const script = required(input.script, "script", input.action);
      const result = await frame.evaluate(
        ({ script, args }) => {
          // eslint-disable-next-line no-eval -- This browser action intentionally evaluates page JavaScript.
          const value = globalThis.eval(script);
          return typeof value === "function" ? value(args) : value;
        },
        { script, args: input.args },
        {},
        false,
      );
      return { text: `Evaluation result:\n${formatEvaluationResult(result)}` };
    }
    case "open":
    case "attach":
    case "pages":
    case "switch":
    case "close-page":
    case "frames":
    case "close":
      throw new Error(`Unexpected browser action: ${input.action}`);
  }
}

export async function pageDetails(
  session: BrowserSession,
  selectedPageId = session.activePageId,
): Promise<BrowserPageDetails[]> {
  return Promise.all(
    [...session.pages].map(async ([id, page]) => ({
      id,
      url: page.url(),
      title: await page.title(),
      active: id === selectedPageId,
      identity: session.pageIdentities.get(page) ?? "auto",
    })),
  );
}

export async function pagesResult(
  session: BrowserSession,
  action: BrowserAction,
  prefix?: string,
  selectedPageId?: string,
): Promise<BrowserActionResult> {
  const pages = (await pageDetails(session, selectedPageId ?? "")).map((page) => ({
    ...page,
    viewerActive: page.id === session.activePageId,
  }));
  const listing =
    pages.length === 0
      ? "No open pages."
      : pages
          .map(
            (page) =>
              `${page.id}${page.active ? " (active)" : ""}${page.viewerActive ? " (viewer)" : ""}\nTitle: ${page.title || "(untitled)"}\nURL: ${page.url}\nIdentity: ${page.identity}`,
          )
          .join("\n\n");
  return {
    text: prefix ? `${prefix}\n\n${listing}` : listing,
    details: { action, pages },
  };
}

export function framesResult(
  session: BrowserSession,
  input: BrowserActionInput,
  page: Page,
): BrowserActionResult {
  const currentPageId = pageId(session, page);
  const frames = page.frames().map((frame) => ({
    id: frameId(session, frame),
    name: frame.name(),
    url: frame.url(),
    parentId: frame.parentFrame() ? frameId(session, frame.parentFrame()!) : undefined,
  }));
  return {
    text: frames
      .map(
        (frame) =>
          `${frame.id}${frame.parentId ? ` (parent ${frame.parentId})` : " (main)"}\nName: ${frame.name || "(unnamed)"}\nURL: ${frame.url}`,
      )
      .join("\n\n"),
    details: { action: input.action, pageId: currentPageId, frames },
  };
}

async function actionLocation(
  session: BrowserSession,
  action: BrowserAction,
  page: Page,
  frame: Frame,
) {
  const currentPageId = pageId(session, page);
  const currentFrameId = frameId(session, frame);
  const title = await page.title();
  return { action, pageId: currentPageId, frameId: currentFrameId, url: page.url(), title };
}

function locationHeader(
  { title, pageId, frameId, url }: Awaited<ReturnType<typeof actionLocation>>,
  mainFrame: boolean,
) {
  return [
    `Page: ${title || "(untitled)"}`,
    `Page ID: ${pageId}`,
    `Frame ID: ${frameId}${mainFrame ? " (main)" : ""}`,
    `URL: ${url}`,
  ];
}

export async function textResult(
  session: BrowserSession,
  input: BrowserActionInput,
  page: Page,
  frame: Frame,
  { text, downloadPaths }: ActionOutput,
): Promise<BrowserActionResult> {
  const details = await actionLocation(session, input.action, page, frame);
  return {
    text: [...locationHeader(details, frame === page.mainFrame()), "", text].join("\n"),
    details: { ...details, downloadPaths },
    downloadPaths,
  };
}

export async function snapshotResult(
  session: BrowserSession,
  clientId: string,
  input: BrowserActionInput,
  page: Page,
  frame = page.mainFrame(),
  output: ActionOutput = {},
): Promise<BrowserActionResult> {
  const location = await actionLocation(session, input.action, page, frame);
  const pages = await pageDetails(session, session.agentPages.get(clientId) ?? "");
  const details = { ...location, pages };
  const header = locationHeader(location, frame === page.mainFrame());
  if (pages.length > 1) header.push(`Open pages: ${pages.map((entry) => entry.id).join(", ")}`);
  header.push("");
  if (output.image) {
    return {
      text: ["Screenshot captured.", `Saved to: ${output.screenshotPath}`, "", ...header].join(
        "\n",
      ),
      details: { ...details, screenshotPath: output.screenshotPath },
      image: { data: output.image.toString("base64"), mimeType: "image/png" },
    };
  }

  const ariaSnapshot = await frame.locator("body").ariaSnapshot();
  return {
    text: [...header, ariaSnapshot].join("\n"),
    details,
  };
}
