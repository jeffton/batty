import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import type { BrowserContext, CDPSession, Frame, Page } from "patchright";
import { getSharedBrowser } from "./browser-runtime";
import { DEFAULT_BROWSER_MAX_TABS } from "./options";
import type { BrowserProxy } from "./ssh-socks-proxy";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BROWSER_SESSIONS = 8;
const SCREENSHOTS_DIR = path.join(os.tmpdir(), "batty-browser-screenshots");

export type BrowserAction =
  | "open"
  | "pages"
  | "switch"
  | "close-page"
  | "frames"
  | "snapshot"
  | "screenshot"
  | "click"
  | "fill"
  | "press"
  | "select"
  | "upload"
  | "download"
  | "wait"
  | "scroll"
  | "hover"
  | "back"
  | "reload"
  | "evaluate"
  | "close";

export interface BrowserViewport {
  width: number;
  height: number;
}

export interface BrowserActionInput {
  action: BrowserAction;
  url?: string;
  pageId?: string;
  frameId?: string;
  newPage?: boolean;
  selector?: string;
  value?: string;
  values?: string[];
  paths?: string[];
  key?: string;
  state?: "attached" | "detached" | "visible" | "hidden";
  script?: string;
  args?: unknown;
  deltaX?: number;
  deltaY?: number;
  viewport?: BrowserViewport;
  fullPage?: boolean;
  timeoutMs?: number;
  useTailscale?: boolean;
}

interface BrowserPageDetails {
  id: string;
  url: string;
  title: string;
  active: boolean;
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
  };
  image?: {
    data: string;
    mimeType: "image/png";
  };
  downloadPaths?: string[];
}

interface BrowserIdentity {
  userAgent: string;
  userAgentMetadata: {
    brands: Array<{ brand: string; version: string }>;
    fullVersionList: Array<{ brand: string; version: string }>;
    platform: string;
    platformVersion: string;
    architecture: string;
    model: string;
    mobile: boolean;
    bitness: string;
    wow64: boolean;
  };
}

interface BrowserSession {
  context: BrowserContext;
  useTailscale: boolean;
  identity: BrowserIdentity;
  cdpSessions: Set<CDPSession>;
  pageIdentityPromises: WeakMap<Page, Promise<void>>;
  pages: Map<string, Page>;
  pageIds: WeakMap<Page, string>;
  rejectedPages: WeakSet<Page>;
  frames: Map<string, Frame>;
  frameIds: WeakMap<Frame, string>;
  activePageId?: string;
  nextPageNumber: number;
  nextFrameNumber: number;
  downloadDirs: Set<string>;
}

interface ActionOutput {
  image?: Buffer;
  screenshotPath?: string;
  text?: string;
  downloadPaths?: string[];
}

function required(value: string | undefined, name: string, action: BrowserAction): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required for browser ${action}`);
  return trimmed;
}

function present(value: string | undefined, name: string, action: BrowserAction): string {
  if (value == null) throw new Error(`${name} is required for browser ${action}`);
  return value;
}

function browserIdentity(version: string): BrowserIdentity {
  const majorVersion = version.split(".")[0]!;
  const brands = [
    { brand: "Not_A Brand", version: "8" },
    { brand: "Google Chrome", version: majorVersion },
    { brand: "Chromium", version: majorVersion },
  ];
  return {
    userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorVersion}.0.0.0 Safari/537.36`,
    userAgentMetadata: {
      brands,
      fullVersionList: [
        { brand: "Not_A Brand", version: "8.0.0.0" },
        { brand: "Google Chrome", version },
        { brand: "Chromium", version },
      ],
      platform: "Linux",
      platformVersion: "",
      architecture: "x86",
      model: "",
      mobile: false,
      bitness: "64",
      wow64: false,
    },
  };
}

function validateUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("browser open only supports http and https URLs");
  }
  return url.toString();
}

function timeout(input: BrowserActionInput): number {
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

export class BrowserService {
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly tailscaleProxy?: BrowserProxy,
    private readonly maxTabs = DEFAULT_BROWSER_MAX_TABS,
  ) {}

  async execute(
    sessionId: string,
    input: BrowserActionInput,
    signal?: AbortSignal,
  ): Promise<BrowserActionResult> {
    const abort = () => {
      void this.closeSessionNow(sessionId).catch(() => {});
    };
    if (signal?.aborted) {
      await this.closeSessionNow(sessionId);
      signal.throwIfAborted();
    }
    signal?.addEventListener("abort", abort, { once: true });

    try {
      return await this.serialized(sessionId, async () => {
        signal?.throwIfAborted();
        try {
          if (input.action === "close") {
            await this.closeSessionNow(sessionId);
            return {
              text: "Browser session closed.",
              details: { action: input.action },
            };
          }

          let session = this.sessions.get(sessionId);
          if (
            session &&
            input.useTailscale != null &&
            input.useTailscale !== session.useTailscale
          ) {
            throw new Error(
              'Browser routing is fixed for the session. Use action="close", then open a new session.',
            );
          }
          if (session?.useTailscale) await this.requireTailscaleProxy();

          if (input.action === "open") {
            const url = validateUrl(required(input.url, "url", input.action));
            const created = !session;
            session ??= await this.createSession(
              sessionId,
              input.viewport,
              input.useTailscale ?? false,
            );
            const page = await this.pageForOpen(session, input, created);
            await this.configurePage(session, page, input);
            await page.goto(url, { waitUntil: "domcontentloaded" });
            return await this.snapshotResult(session, input, page);
          }

          if (!session) {
            throw new Error('No active browser page. Start with action="open".');
          }

          if (input.action === "pages") return await this.pagesResult(session, input.action);

          const page = this.resolvePage(session, input.pageId);
          await this.configurePage(session, page, input);
          if (input.viewport) await page.setViewportSize(input.viewport);

          if (input.action === "switch") {
            session.activePageId = this.pageId(session, page);
            return await this.snapshotResult(session, input, page);
          }
          if (input.action === "close-page") {
            const closedPageId = this.pageId(session, page);
            await page.close();
            return await this.pagesResult(session, input.action, `Closed page ${closedPageId}.`);
          }
          if (input.action === "frames") return this.framesResult(session, input, page);

          const frame = this.resolveFrame(session, page, input.frameId);
          const output = await this.performPageAction(session, page, frame, input);
          if (output.text != null) {
            return await this.textResult(session, input, page, frame, output);
          }
          return await this.snapshotResult(session, input, page, frame, output);
        } catch (error) {
          if (signal?.aborted) await this.closeSessionNow(sessionId);
          throw error;
        }
      });
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.serialized(sessionId, () => this.closeSessionNow(sessionId));
  }

  async dispose(): Promise<void> {
    const sessionIds = [...this.sessions.keys()];
    try {
      await Promise.all(sessionIds.map((sessionId) => this.closeSession(sessionId)));
    } finally {
      await this.tailscaleProxy?.dispose();
    }
  }

  private async createSession(
    sessionId: string,
    viewport: BrowserViewport | undefined,
    useTailscale: boolean,
  ): Promise<BrowserSession> {
    if (this.sessions.size >= MAX_BROWSER_SESSIONS) {
      throw new Error(`Browser session limit reached (${MAX_BROWSER_SESSIONS})`);
    }
    const proxyServer = useTailscale ? await this.requireTailscaleProxy() : undefined;
    const browser = await getSharedBrowser();
    const identity = browserIdentity(browser.version());
    const context = await browser.newContext({
      acceptDownloads: true,
      locale: "en-US",
      permissions: [],
      userAgent: identity.userAgent,
      ...(proxyServer ? { proxy: { server: proxyServer, bypass: "<-loopback>" } } : {}),
      viewport: viewport ?? null,
    });
    const session: BrowserSession = {
      context,
      useTailscale,
      identity,
      cdpSessions: new Set(),
      pageIdentityPromises: new WeakMap(),
      pages: new Map(),
      pageIds: new WeakMap(),
      rejectedPages: new WeakSet(),
      frames: new Map(),
      frameIds: new WeakMap(),
      nextPageNumber: 1,
      nextFrameNumber: 1,
      downloadDirs: new Set(),
    };
    context.on("page", (page) => {
      if (session.pages.size >= this.maxTabs) {
        session.rejectedPages.add(page);
        void page.close().catch(() => {});
        return;
      }
      this.registerPage(session, page, false);
    });
    try {
      const page = await context.newPage();
      this.registerPage(session, page, true);
    } catch (error) {
      await context.close().catch(() => {});
      throw error;
    }
    this.sessions.set(sessionId, session);
    return session;
  }

  private registerPage(session: BrowserSession, page: Page, activate: boolean): string {
    const existingId = session.pageIds.get(page);
    if (existingId) {
      if (activate) session.activePageId = existingId;
      return existingId;
    }

    const pageId = `page-${session.nextPageNumber++}`;
    const identityPromise = this.configureBrowserIdentity(session, page);
    void identityPromise.catch(() => {});
    session.pageIdentityPromises.set(page, identityPromise);
    session.pageIds.set(page, pageId);
    session.pages.set(pageId, page);
    if (activate || !session.activePageId) session.activePageId = pageId;
    for (const frame of page.frames()) this.registerFrame(session, frame);
    page.on("frameattached", (frame) => this.registerFrame(session, frame));
    page.on("framedetached", (frame) => this.unregisterFrame(session, frame));
    page.on("close", () => {
      session.pages.delete(pageId);
      for (const [frameId, frame] of session.frames) {
        if (frame.page() === page) session.frames.delete(frameId);
      }
      if (session.activePageId === pageId) {
        session.activePageId = session.pages.keys().next().value;
      }
    });
    return pageId;
  }

  private registerFrame(session: BrowserSession, frame: Frame): string {
    const existingId = session.frameIds.get(frame);
    if (existingId) return existingId;
    const frameId = `frame-${session.nextFrameNumber++}`;
    session.frameIds.set(frame, frameId);
    session.frames.set(frameId, frame);
    return frameId;
  }

  private unregisterFrame(session: BrowserSession, frame: Frame): void {
    const frameId = session.frameIds.get(frame);
    if (frameId) session.frames.delete(frameId);
  }

  private async pageForOpen(
    session: BrowserSession,
    input: BrowserActionInput,
    sessionCreated: boolean,
  ): Promise<Page> {
    if ((input.newPage && !sessionCreated) || session.pages.size === 0) {
      if (session.pages.size >= this.maxTabs) {
        throw new Error(
          `Browser tab limit reached (${this.maxTabs}). Close a page before opening another.`,
        );
      }
      const page = await session.context.newPage();
      if (
        session.rejectedPages.has(page) ||
        (!session.pageIds.has(page) && session.pages.size >= this.maxTabs)
      ) {
        await page.close().catch(() => {});
        throw new Error(
          `Browser tab limit reached (${this.maxTabs}). Close a page before opening another.`,
        );
      }
      this.registerPage(session, page, true);
      if (input.viewport) await page.setViewportSize(input.viewport);
      return page;
    }
    const page = this.resolvePage(session, input.pageId);
    if (input.viewport && !sessionCreated) await page.setViewportSize(input.viewport);
    return page;
  }

  private resolvePage(session: BrowserSession, requestedPageId?: string): Page {
    const pageId = requestedPageId ?? session.activePageId;
    const page = pageId ? session.pages.get(pageId) : undefined;
    if (!page || page.isClosed()) throw new Error(`Unknown browser page: ${pageId ?? "(none)"}`);
    return page;
  }

  private resolveFrame(session: BrowserSession, page: Page, requestedFrameId?: string): Frame {
    for (const frame of page.frames()) this.registerFrame(session, frame);
    if (!requestedFrameId) return page.mainFrame();
    const frame = session.frames.get(requestedFrameId);
    if (!frame || frame.page() !== page)
      throw new Error(`Unknown browser frame: ${requestedFrameId}`);
    return frame;
  }

  private pageId(session: BrowserSession, page: Page): string {
    return session.pageIds.get(page)!;
  }

  private frameId(session: BrowserSession, frame: Frame): string {
    return this.registerFrame(session, frame);
  }

  private async configureBrowserIdentity(session: BrowserSession, page: Page): Promise<void> {
    const cdpSession = await session.context.newCDPSession(page);
    session.cdpSessions.add(cdpSession);
    await cdpSession.send("Emulation.setUserAgentOverride", session.identity);
  }

  private async configurePage(
    session: BrowserSession,
    page: Page,
    input: BrowserActionInput,
  ): Promise<void> {
    await session.pageIdentityPromises.get(page);
    page.setDefaultTimeout(timeout(input));
    page.setDefaultNavigationTimeout(timeout(input));
  }

  private async performPageAction(
    session: BrowserSession,
    page: Page,
    frame: Frame,
    input: BrowserActionInput,
  ): Promise<ActionOutput> {
    switch (input.action) {
      case "snapshot":
        return {};
      case "screenshot": {
        const image = await page.screenshot({ fullPage: input.fullPage ?? false, type: "png" });
        const screenshotPath = await createScreenshotPath();
        await fs.writeFile(screenshotPath, image);
        return { image, screenshotPath };
      }
      case "click":
        await frame.locator(required(input.selector, "selector", input.action)).click();
        return {};
      case "fill":
        await frame
          .locator(required(input.selector, "selector", input.action))
          .fill(present(input.value, "value", input.action));
        return {};
      case "press":
        await frame
          .locator(required(input.selector, "selector", input.action))
          .press(required(input.key, "key", input.action));
        return {};
      case "select": {
        const values = input.values ?? (input.value == null ? [] : [input.value]);
        if (values.length === 0) throw new Error("value or values is required for browser select");
        await frame
          .locator(required(input.selector, "selector", input.action))
          .selectOption(values);
        return {};
      }
      case "upload": {
        const paths = input.paths ?? [];
        if (paths.length === 0) throw new Error("paths is required for browser upload");
        await frame
          .locator(required(input.selector, "selector", input.action))
          .setInputFiles(paths);
        return {};
      }
      case "download": {
        const [download] = await Promise.all([
          page.waitForEvent("download"),
          frame.locator(required(input.selector, "selector", input.action)).click(),
        ]);
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "batty-browser-download-"));
        session.downloadDirs.add(dir);
        const downloadPath = path.join(dir, safeDownloadName(download.suggestedFilename()));
        await download.saveAs(downloadPath);
        return {
          text: `Downloaded ${download.suggestedFilename()}.\nSaved to: ${downloadPath}`,
          downloadPaths: [downloadPath],
        };
      }
      case "wait":
        await frame.locator(required(input.selector, "selector", input.action)).waitFor({
          state: input.state ?? "visible",
          timeout: timeout(input),
        });
        return {};
      case "scroll":
        if (input.selector) {
          await frame.locator(input.selector).scrollIntoViewIfNeeded();
        } else {
          await frame.evaluate(({ deltaX, deltaY }) => window.scrollBy(deltaX, deltaY), {
            deltaX: input.deltaX ?? 0,
            deltaY: input.deltaY ?? 0,
          });
        }
        return {};
      case "hover":
        await frame.locator(required(input.selector, "selector", input.action)).hover();
        return {};
      case "back":
        await page.goBack({ waitUntil: "domcontentloaded" });
        return {};
      case "reload":
        await page.reload({ waitUntil: "domcontentloaded" });
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
      case "pages":
      case "switch":
      case "close-page":
      case "frames":
      case "close":
        throw new Error(`Unexpected browser action: ${input.action}`);
    }
  }

  private async pageDetails(session: BrowserSession): Promise<BrowserPageDetails[]> {
    return Promise.all(
      [...session.pages].map(async ([id, page]) => ({
        id,
        url: page.url(),
        title: await page.title(),
        active: id === session.activePageId,
      })),
    );
  }

  private async pagesResult(
    session: BrowserSession,
    action: BrowserAction,
    prefix?: string,
  ): Promise<BrowserActionResult> {
    const pages = await this.pageDetails(session);
    const listing =
      pages.length === 0
        ? "No open pages."
        : pages
            .map(
              (page) =>
                `${page.id}${page.active ? " (active)" : ""}\nTitle: ${page.title || "(untitled)"}\nURL: ${page.url}`,
            )
            .join("\n\n");
    return {
      text: prefix ? `${prefix}\n\n${listing}` : listing,
      details: { action, pages },
    };
  }

  private framesResult(
    session: BrowserSession,
    input: BrowserActionInput,
    page: Page,
  ): BrowserActionResult {
    const pageId = this.pageId(session, page);
    const frames = page.frames().map((frame) => ({
      id: this.frameId(session, frame),
      name: frame.name(),
      url: frame.url(),
      parentId: frame.parentFrame() ? this.frameId(session, frame.parentFrame()!) : undefined,
    }));
    return {
      text: frames
        .map(
          (frame) =>
            `${frame.id}${frame.parentId ? ` (parent ${frame.parentId})` : " (main)"}\nName: ${frame.name || "(unnamed)"}\nURL: ${frame.url}`,
        )
        .join("\n\n"),
      details: { action: input.action, pageId, frames },
    };
  }

  private async textResult(
    session: BrowserSession,
    input: BrowserActionInput,
    page: Page,
    frame: Frame,
    output: ActionOutput,
  ): Promise<BrowserActionResult> {
    const pageId = this.pageId(session, page);
    const frameId = this.frameId(session, frame);
    const title = await page.title();
    const url = page.url();
    const downloadPaths = output.downloadPaths;
    return {
      text: [
        `Page: ${title || "(untitled)"}`,
        `Page ID: ${pageId}`,
        `Frame ID: ${frameId}${frame === page.mainFrame() ? " (main)" : ""}`,
        `URL: ${url}`,
        "",
        output.text,
      ].join("\n"),
      details: {
        action: input.action,
        pageId,
        frameId,
        url,
        title,
        downloadPaths,
      },
      downloadPaths,
    };
  }

  private async snapshotResult(
    session: BrowserSession,
    input: BrowserActionInput,
    page: Page,
    frame = page.mainFrame(),
    output: ActionOutput = {},
  ): Promise<BrowserActionResult> {
    const pageId = this.pageId(session, page);
    const frameId = this.frameId(session, frame);
    const title = await page.title();
    const url = page.url();
    const pages = await this.pageDetails(session);
    const header = [
      `Page: ${title || "(untitled)"}`,
      `Page ID: ${pageId}${pageId === session.activePageId ? " (active)" : ""}`,
      `Frame ID: ${frameId}${frame === page.mainFrame() ? " (main)" : ""}`,
      `URL: ${url}`,
      ...(pages.length > 1 ? [`Open pages: ${pages.map((entry) => entry.id).join(", ")}`] : []),
      "",
    ];
    if (output.image) {
      return {
        text: ["Screenshot captured.", `Saved to: ${output.screenshotPath}`, "", ...header].join(
          "\n",
        ),
        details: {
          action: input.action,
          pageId,
          frameId,
          url,
          title,
          pages,
          screenshotPath: output.screenshotPath,
        },
        image: { data: output.image.toString("base64"), mimeType: "image/png" },
      };
    }

    const ariaSnapshot = await frame.locator("body").ariaSnapshot();
    return {
      text: [...header, ariaSnapshot].join("\n"),
      details: { action: input.action, pageId, frameId, url, title, pages },
    };
  }

  private async requireTailscaleProxy(): Promise<string> {
    if (!this.tailscaleProxy) {
      throw new Error(
        "Tailscale browser routing is not configured. Set browserTailscaleSshDestination in options.json.",
      );
    }
    return this.tailscaleProxy.ensureStarted();
  }

  private async closeSessionNow(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    await session.context.close();
    await Promise.all(
      [...session.downloadDirs].map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  }

  private async serialized<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queues.set(sessionId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.queues.get(sessionId) === current) this.queues.delete(sessionId);
    }
  }
}
