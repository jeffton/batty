import type { BrowserContext, Page } from "playwright";
import { getSharedBrowser } from "./browser-runtime";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BROWSER_SESSIONS = 8;

export type BrowserAction =
  | "open"
  | "snapshot"
  | "screenshot"
  | "click"
  | "fill"
  | "press"
  | "select"
  | "wait"
  | "close";

export interface BrowserViewport {
  width: number;
  height: number;
}

export interface BrowserActionInput {
  action: BrowserAction;
  url?: string;
  selector?: string;
  value?: string;
  values?: string[];
  key?: string;
  state?: "attached" | "detached" | "visible" | "hidden";
  viewport?: BrowserViewport;
  fullPage?: boolean;
  timeoutMs?: number;
}

export interface BrowserActionResult {
  text: string;
  details: {
    action: BrowserAction;
    url?: string;
    title?: string;
  };
  image?: {
    data: string;
    mimeType: "image/png";
  };
}

interface BrowserSession {
  context: BrowserContext;
  page: Page;
}

function required(value: string | undefined, name: string, action: BrowserAction): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required for browser ${action}`);
  return trimmed;
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

export class BrowserService {
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly queues = new Map<string, Promise<void>>();

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
          let image: Buffer | undefined;
          if (input.action === "open") {
            const url = validateUrl(required(input.url, "url", input.action));
            if (session?.page.isClosed()) {
              await this.closeSessionNow(sessionId);
              session = undefined;
            }
            if (session) {
              if (input.viewport) await session.page.setViewportSize(input.viewport);
            } else {
              session = await this.createSession(sessionId, input.viewport);
            }
            signal?.throwIfAborted();
            session.page.setDefaultTimeout(timeout(input));
            session.page.setDefaultNavigationTimeout(timeout(input));
            await session.page.goto(url, { waitUntil: "domcontentloaded" });
          } else {
            if (!session || session.page.isClosed()) {
              throw new Error('No active browser page. Start with action="open".');
            }
            session.page.setDefaultTimeout(timeout(input));
            session.page.setDefaultNavigationTimeout(timeout(input));
            if (input.viewport) await session.page.setViewportSize(input.viewport);
            image = await this.performPageAction(session.page, input);
          }

          return await this.snapshot(input.action, session.page, image);
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
    await Promise.all(sessionIds.map((sessionId) => this.closeSession(sessionId)));
  }

  private async createSession(
    sessionId: string,
    viewport?: BrowserViewport,
  ): Promise<BrowserSession> {
    if (this.sessions.size >= MAX_BROWSER_SESSIONS) {
      throw new Error(`Browser session limit reached (${MAX_BROWSER_SESSIONS})`);
    }
    const browser = await getSharedBrowser();
    const context = await browser.newContext({
      acceptDownloads: false,
      locale: "en-US",
      permissions: [],
      ...(viewport ? { viewport } : {}),
    });
    let page: Page;
    try {
      page = await context.newPage();
    } catch (error) {
      await context.close().catch(() => {});
      throw error;
    }
    const session = { context, page };
    this.sessions.set(sessionId, session);
    return session;
  }

  private async performPageAction(
    page: Page,
    input: BrowserActionInput,
  ): Promise<Buffer | undefined> {
    switch (input.action) {
      case "snapshot":
        return;
      case "screenshot":
        return page.screenshot({ fullPage: input.fullPage ?? false, type: "png" });
      case "click":
        await page.locator(required(input.selector, "selector", input.action)).click();
        return;
      case "fill":
        await page
          .locator(required(input.selector, "selector", input.action))
          .fill(required(input.value, "value", input.action));
        return;
      case "press":
        await page
          .locator(required(input.selector, "selector", input.action))
          .press(required(input.key, "key", input.action));
        return;
      case "select": {
        const values = input.values ?? (input.value == null ? [] : [input.value]);
        if (values.length === 0) throw new Error("value or values is required for browser select");
        await page.locator(required(input.selector, "selector", input.action)).selectOption(values);
        return;
      }
      case "wait":
        await page.locator(required(input.selector, "selector", input.action)).waitFor({
          state: input.state ?? "visible",
          timeout: timeout(input),
        });
        return;
      case "open":
      case "close":
        throw new Error(`Unexpected browser action: ${input.action}`);
    }
  }

  private async snapshot(
    action: BrowserAction,
    page: Page,
    image?: Buffer,
  ): Promise<BrowserActionResult> {
    const title = await page.title();
    const url = page.url();
    if (image) {
      return {
        text: [`Page: ${title || "(untitled)"}`, `URL: ${url}`, "", "Screenshot captured."].join(
          "\n",
        ),
        details: { action, url, title },
        image: { data: image.toString("base64"), mimeType: "image/png" },
      };
    }

    const ariaSnapshot = await page.locator("body").ariaSnapshot();
    return {
      text: [`Page: ${title || "(untitled)"}`, `URL: ${url}`, "", ariaSnapshot].join("\n"),
      details: { action, url, title },
    };
  }

  private async closeSessionNow(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    await session.context.close();
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
