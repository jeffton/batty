import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import type { BrowserDescriptor } from "@/shared/types";
import type {
  CloudBrowserControl,
  CloudBrowserCredentials,
  CloudBrowserCredentialTarget,
  CloudBrowserState,
  CloudBrowserTouch,
  CloudBrowserViewport,
} from "@/shared/cloud-browser";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import type { Browser, BrowserContext, CDPSession, Frame, Page } from "patchright";
import {
  browserSessionDirectory,
  closePersistentBrowser,
  connectPersistentBrowser,
  persistentBrowserDisplay,
  readBrowserJson,
  writeBrowserJson,
  type PersistentBrowserRegistry,
} from "./browser-persistence";
import { DEFAULT_BROWSER_MAX_TABS } from "./options";
import { fillCredentialFields, prepareCredentialFields } from "./browser-credentials";
import {
  NATIVE_BROWSER_SCALE,
  NATIVE_BROWSER_SIZE,
  fitCloudViewport,
} from "@/shared/browser-geometry";
import type { NativeCaptureGeometry } from "./native-browser-video";
import type { BrowserProxy } from "./ssh-socks-proxy";
import type { BrowserAction, BrowserActionInput } from "./browser-schemas";
export type { BrowserAction, BrowserActionInput } from "./browser-schemas";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BROWSER_SESSIONS = 8;
const SCREENSHOTS_DIR = path.join(os.tmpdir(), "batty-browser-screenshots");

export interface BrowserViewport {
  width: number;
  height: number;
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
    sites?: BrowserDescriptor[];
  };
  image?: {
    data: string;
    mimeType: "image/png";
  };
  downloadPaths?: string[];
}

interface BrowserIdentity {
  platform: string;
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
  browser: Browser;
  directory: string;
  context: BrowserContext;
  useTailscale: boolean;
  identity: BrowserIdentity;
  cloudViewport?: CloudBrowserViewport;
  cloudEnabled: boolean;
  pageEmulation: WeakMap<Page, CDPSession>;
  nativeWindowRevisions: Map<number, string>;
  nativeCapturePage?: Page;
  pageViewports: WeakMap<Page, CloudBrowserViewport>;
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
  cloudGeneration: string;
  cloudInteraction: number;
  navigations: WeakMap<Page, number>;
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

function browserIdentity(version: string, mobile = false): BrowserIdentity {
  const majorVersion = version.split(".")[0]!;
  const brands = [
    { brand: "Not_A Brand", version: "8" },
    { brand: "Google Chrome", version: majorVersion },
    { brand: "Chromium", version: majorVersion },
  ];
  return {
    platform: mobile ? "Linux armv8l" : "Linux x86_64",
    userAgent: mobile
      ? `Mozilla/5.0 (Linux; Android 13; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorVersion}.0.0.0 Mobile Safari/537.36`
      : `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorVersion}.0.0.0 Safari/537.36`,
    userAgentMetadata: {
      brands,
      fullVersionList: [
        { brand: "Not_A Brand", version: "8.0.0.0" },
        { brand: "Google Chrome", version },
        { brand: "Chromium", version },
      ],
      platform: mobile ? "Android" : "Linux",
      platformVersion: mobile ? "13.0.0" : "",
      architecture: mobile ? "" : "x86",
      model: "",
      mobile,
      bitness: mobile ? "" : "64",
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
  private readonly lifecycleQueues = new Map<string, Promise<void>>();
  private readonly epochs = new Map<string, number>();
  private disposed = false;
  private readonly cloudOwners = new Map<string, string>();
  private readonly activeAgentSessions = new Set<string>();
  private readonly cloudTouches = new Map<
    string,
    {
      owner: string;
      session: BrowserSession;
      page: Page;
      connection: CDPSession;
      startedAt: number;
      elapsedMs: number;
    }
  >();

  constructor(
    private readonly tailscaleProxy?: BrowserProxy,
    private readonly maxTabs = DEFAULT_BROWSER_MAX_TABS,
    private readonly persistenceRoot = path.join(process.cwd(), ".batty", "browser"),
  ) {
    this.tailscaleProxy?.setPersistenceRoot?.(this.persistenceRoot);
  }

  async execute(
    sessionId: string,
    input: BrowserActionInput,
    signal?: AbortSignal,
  ): Promise<BrowserActionResult> {
    signal?.throwIfAborted();
    if (this.disposed) throw new Error("Browser service is disposed");
    if (input.action === "close") {
      await this.closeSession(sessionId);
      return { text: "Browser session closed.", details: { action: input.action } };
    }
    // Abort only the waiter on harness shutdown. Explicit close separately
    // terminates the browser outside the action queue, interrupting CDP calls.
    return await this.abortable(
      this.serialized(
        sessionId,
        async () => {
          signal?.throwIfAborted();
          // Registering the action queue protects queued/running browser calls;
          // admission waits for any expiry already closing the old instance.
          await this.withSessionLifecycle(sessionId, async () => {
            if (await this.hasSession(sessionId)) await this.touchSession(sessionId);
          });
          try {
            let session = this.sessions.get(sessionId);
            if (
              !session &&
              (await readBrowserJson(
                path.join(browserSessionDirectory(this.persistenceRoot, sessionId), "launch.json"),
              ))
            )
              session = await this.createSession(sessionId, undefined, undefined);
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
            if (
              session &&
              (input.viewport ||
                !["attach", "pages", "snapshot", "screenshot", "frames", "wait"].includes(
                  input.action,
                ))
            )
              for (const [id, touch] of this.cloudTouches)
                if (touch.session === session) await this.cancelCloudTouch(id);

            if (input.action === "open") {
              const url = validateUrl(required(input.url, "url", input.action));
              const created = !session;
              session ??= await this.createSession(
                sessionId,
                input.viewport,
                input.useTailscale ?? false,
              );
              if (input.cloud) await this.enableCloud(sessionId, session);
              if (created && input.cloud && !input.viewport)
                await this.setViewport(session, this.resolvePage(session), {
                  width: 390,
                  height: 640,
                });
              session.cloudInteraction++;
              const page = await this.pageForOpen(session, input, created);
              await this.configurePage(session, page, input);
              await page.goto(url, { waitUntil: "domcontentloaded" });
              const result = await this.snapshotResult(session, input, page);
              if (input.cloud) result.details.sites = [await this.cloudAttachment(session)];
              return result;
            }

            if (!session) {
              throw new Error('No active browser page. Start with action="open".');
            }

            if (input.cloud) await this.enableCloud(sessionId, session);
            if (input.action === "attach") {
              const site = await this.cloudAttachment(session);
              return {
                text: "Live cloud browser attached. The user and agent share this browser session.",
                details: { action: "attach", sites: [site] },
              };
            }
            if (input.action === "pages") return await this.pagesResult(session, input.action);

            if (!["snapshot", "screenshot", "frames", "wait"].includes(input.action))
              session.cloudInteraction++;
            const page = this.resolvePage(session, input.pageId);
            await this.configurePage(session, page, input);
            if (input.viewport) await this.setViewport(session, page, input.viewport);

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
          } finally {
            const session = this.sessions.get(sessionId);
            if (session?.browser.isConnected()) {
              await this.persistRegistry(session);
              await this.touchSession(sessionId);
            }
          }
        },
        this.queues,
        true,
      ),
      signal,
    );
  }

  private async cloudAttachment(session: BrowserSession): Promise<BrowserDescriptor> {
    const cloud = await readBrowserJson<{ id: string }>(path.join(session.directory, "cloud.json"));
    if (!cloud) throw new Error("Enable cloud=true before attaching this browser.");
    return {
      id: `browser-${cloud.id}`,
      kind: "browser",
      browserId: cloud.id,
      name: "Cloud browser",
      url: `/api/cloud-browser/${cloud.id}/state`,
      public: false,
    };
  }

  private async enableCloud(sessionId: string, session: BrowserSession): Promise<void> {
    const file = path.join(session.directory, "cloud.json");
    let cloud = await readBrowserJson<{ id: string; sessionId: string }>(file);
    if (!cloud) {
      cloud = { id: randomUUID(), sessionId };
      await writeBrowserJson(file, cloud);
    }
    session.cloudEnabled = true;
    for (const page of session.pages.values()) {
      await session.pageIdentityPromises.get(page);
      const viewport = page.viewportSize();
      if (viewport) {
        const fitted = fitCloudViewport(viewport);
        if (fitted.width !== viewport.width || fitted.height !== viewport.height)
          await this.setViewport(session, page, fitted);
      }
    }
    this.cloudOwners.set(cloud.id, sessionId);
  }

  private async cloudOwner(id: string): Promise<string> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw this.cloudEnded();
    let owner = this.cloudOwners.get(id);
    if (!owner) {
      const entries = await fs
        .readdir(this.persistenceRoot, { withFileTypes: true })
        .catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const cloud = await readBrowserJson<{ id: string; sessionId: string }>(
          path.join(this.persistenceRoot, entry.name, "cloud.json"),
        );
        if (cloud?.id === id) {
          owner = cloud.sessionId;
          this.cloudOwners.set(id, owner);
          break;
        }
      }
    }
    if (!owner) throw this.cloudEnded();
    const cloud = await readBrowserJson<{ id: string }>(
      path.join(browserSessionDirectory(this.persistenceRoot, owner), "cloud.json"),
    );
    if (cloud?.id !== id) {
      this.cloudOwners.delete(id);
      throw this.cloudEnded();
    }
    return owner;
  }

  private cloudEnded(): Error & { statusCode: number } {
    return Object.assign(new Error("Browser session ended."), { statusCode: 410 });
  }

  private cloudView(session: BrowserSession, page: Page) {
    const viewport = page.viewportSize() ?? { width: 1365, height: 768 };
    const pageId = this.pageId(session, page);
    return {
      pageId,
      ...viewport,
      mobile: session.pageViewports.get(page)?.mobile ?? false,
      deviceScaleFactor: session.pageViewports.get(page)?.deviceScaleFactor ?? 1,
      revision: createHash("sha256")
        .update(
          JSON.stringify([
            session.cloudGeneration,
            session.cloudInteraction,
            pageId,
            session.navigations.get(page) ?? 0,
            page.url(),
            viewport.width,
            viewport.height,
          ]),
        )
        .digest("hex"),
    };
  }

  private async focusedInput(page: Page) {
    for (const frame of page.frames()) {
      const focused = await frame.evaluate((id) => {
        if (!document.hasFocus()) return;
        let element = document.activeElement;
        while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
        if (!(element instanceof HTMLElement)) return;
        const input =
          element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
            ? element
            : undefined;
        if (
          (!input && !element.isContentEditable) ||
          (input && (input.disabled || input.readOnly)) ||
          (element instanceof HTMLInputElement &&
            !["text", "search", "email", "url", "tel", "password", "number"].includes(element.type))
        )
          return;
        const marked = element as HTMLElement & { __battyInputId?: string };
        marked.__battyInputId ??= id;
        return {
          id: marked.__battyInputId,
          value: input ? input.value : element.innerText,
          type: element instanceof HTMLInputElement ? element.type : "text",
          multiline: element instanceof HTMLTextAreaElement || element.isContentEditable,
        };
      }, randomUUID());
      if (focused) return { frame, focused };
    }
  }

  private async cloudStateFor(session: BrowserSession): Promise<CloudBrowserState> {
    if (!session.pages.size) throw this.cloudEnded();
    const page = this.resolvePage(session);
    await session.pageIdentityPromises.get(page);
    return {
      ...this.cloudView(session, page),
      url: page.url(),
      title: await page.title(),
      focused: (await this.focusedInput(page))?.focused,
      pages: await this.pageDetails(session),
    };
  }

  private async cloudOperation<T>(
    id: string,
    operation: (session: BrowserSession) => Promise<T>,
    rejectBusy = false,
    persistRegistry = rejectBusy,
  ): Promise<T> {
    if (this.disposed) throw this.cloudEnded();
    const owner = await this.cloudOwner(id);
    if (rejectBusy && this.activeAgentSessions.has(owner))
      throw Object.assign(new Error("Browser is busy. Try again when the agent finishes."), {
        statusCode: 409,
      });
    return this.serialized(owner, async () => {
      await this.cloudOwner(id);
      let session = this.sessions.get(owner);
      if (!session) {
        try {
          session = await this.createSession(owner, undefined, undefined);
        } catch (error) {
          if (["ESRCH", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? ""))
            throw this.cloudEnded();
          throw error;
        }
      }
      if (!session.browser.isConnected()) throw this.cloudEnded();
      try {
        return await operation(session);
      } finally {
        if (session.browser.isConnected()) {
          if (persistRegistry) await this.persistRegistry(session);
          await this.touchSession(owner);
        }
      }
    });
  }

  async cloudVideoGeometry(id: string, state: CloudBrowserState): Promise<NativeCaptureGeometry> {
    if (process.platform !== "linux")
      throw Object.assign(
        new Error(
          "Native H.264 cloud viewing requires a Linux host with Xvfb, xauth and FFmpeg/libx264.",
        ),
        { statusCode: 501 },
      );
    return this.cloudOperation(id, async (session) => {
      const page = this.cloudInputPage(session, state);
      const display = await persistentBrowserDisplay(session.directory);
      const width = state.width * NATIVE_BROWSER_SCALE;
      const height = state.height * NATIVE_BROWSER_SCALE;
      if (width > NATIVE_BROWSER_SIZE || height > NATIVE_BROWSER_SIZE)
        throw Object.assign(
          new Error(
            `Native cloud viewport exceeds ${Math.floor(NATIVE_BROWSER_SIZE / NATIVE_BROWSER_SCALE)} CSS pixels per dimension`,
          ),
          { statusCode: 400 },
        );
      const connection = session.pageEmulation.get(page)!;
      const { windowId } = await connection.send("Browser.getWindowForTarget");
      if (session.nativeWindowRevisions.get(windowId) !== state.revision) {
        await connection.send("Browser.setWindowBounds", {
          windowId,
          bounds: { windowState: "normal" },
        });
        await connection.send("Browser.setWindowBounds", {
          windowId,
          bounds: { left: 0, top: 0, width: state.width, height: state.height },
        });
        await connection.send("Browser.setWindowBounds", {
          windowId,
          bounds: { windowState: "fullscreen" },
        });
        await connection.send("Emulation.setDeviceMetricsOverride", {
          width: state.width,
          height: state.height,
          deviceScaleFactor: state.deviceScaleFactor,
          mobile: state.mobile,
          screenWidth: state.width,
          screenHeight: state.height,
          screenOrientation: {
            type: state.width > state.height ? "landscapePrimary" : "portraitPrimary",
            angle: state.width > state.height ? 90 : 0,
          },
        });
        session.nativeWindowRevisions.set(windowId, state.revision);
      }
      if (session.nativeCapturePage !== page) {
        await page.bringToFront();
        session.nativeCapturePage = page;
      }
      return { display: display.display, authority: display.authority, x: 0, y: 0, width, height };
    });
  }

  async cloudState(id: string): Promise<CloudBrowserState> {
    return this.cloudOperation(id, (session) => this.cloudStateFor(session));
  }

  /** Capture polling reads only local page metadata, not titles, frames or focused fields. */
  async cloudCaptureTarget(id: string) {
    return this.cloudOperation(id, async (session) => {
      const page = this.resolvePage(session);
      await session.pageIdentityPromises.get(page);
      return { page, state: this.cloudView(session, page) };
    });
  }

  /** Full viewer status observes the same Page object that agent actions use. */
  async cloudTarget(id: string) {
    return this.cloudOperation(id, async (session) => {
      const page = this.resolvePage(session);
      return {
        page,
        state: await this.cloudStateFor(session),
      };
    });
  }

  async prepareCloudCredentials(id: string): Promise<CloudBrowserCredentialTarget> {
    return this.cloudOperation(
      id,
      async (session) => {
        const page = this.resolvePage(session);
        const view = this.cloudView(session, page);
        const url = page.url();
        const origin = new URL(url).origin;
        if (!/^https?:/.test(url))
          throw Object.assign(new Error("Open a website login page first."), { statusCode: 400 });
        const token = randomUUID();
        if (!(await page.evaluate(prepareCredentialFields, token)))
          throw Object.assign(
            new Error(
              "Show one username and password form on the page first. Embedded and multi-step logins are not supported.",
            ),
            { statusCode: 409 },
          );
        this.cloudInputPage(session, view);
        if (page.url() !== url)
          throw Object.assign(
            new Error("The login page changed. Open the credential panel again."),
            { statusCode: 409 },
          );
        return { pageId: view.pageId, revision: view.revision, url, origin, token };
      },
      true,
      false,
    );
  }

  async fillCloudCredentials(id: string, command: CloudBrowserCredentials): Promise<void> {
    await this.cloudOperation(
      id,
      async (session) => {
        const page = this.cloudInputPage(session, command.target);
        // Never expose Patchright errors/call arguments containing credentials.
        let filled = false;
        try {
          filled = await page.evaluate(fillCredentialFields, command);
        } catch {
          throw Object.assign(
            new Error("Credential fill failed. Open the credential panel again."),
            { statusCode: 409 },
          );
        }
        if (!filled)
          throw Object.assign(
            new Error("The login page or fields changed. Open the credential panel again."),
            { statusCode: 409 },
          );
      },
      true,
      false,
    );
  }

  private cloudInputPage(
    session: BrowserSession,
    command:
      | Extract<CloudBrowserControl, { revision: string }>
      | CloudBrowserTouch
      | Pick<CloudBrowserState, "pageId" | "revision">,
  ): Page {
    const page = this.resolvePage(session);
    const current = this.cloudView(session, page);
    if (command.pageId !== current.pageId || command.revision !== current.revision)
      throw Object.assign(new Error("The browser view changed. Wait for a fresh frame."), {
        statusCode: 409,
      });
    if ("x" in command) {
      const points = [[command.x, command.y]];
      if (command.action === "drag") points.push([command.endX, command.endY]);
      if (points.some(([x, y]) => x! < 0 || y! < 0 || x! >= current.width || y! >= current.height))
        throw Object.assign(new Error("Pointer is outside the browser viewport."), {
          statusCode: 400,
        });
    }
    return page;
  }

  private async cancelCloudTouch(id: string, owner?: string): Promise<void> {
    const touch = this.cloudTouches.get(id);
    if (!touch || (owner !== undefined && touch.owner !== owner)) return;
    this.cloudTouches.delete(id);
    if (!touch.page.isClosed())
      await touch.connection.send("Input.dispatchTouchEvent", {
        type: "touchCancel",
        touchPoints: [],
      });
  }

  async cloudTouch(id: string, command: CloudBrowserTouch, owner: string): Promise<void> {
    await this.cloudOperation(
      id,
      async (session) => {
        try {
          const page = this.cloudInputPage(session, command);
          await session.pageIdentityPromises.get(page);
          let touch = this.cloudTouches.get(id);
          if (command.phase === "start") {
            if (touch)
              throw Object.assign(new Error("Browser already has an active touch."), {
                statusCode: 409,
              });
            touch = {
              owner,
              session,
              page,
              connection: session.pageEmulation.get(page)!,
              startedAt: (Date.now() - command.elapsedMs) / 1000,
              elapsedMs: 0,
            };
            this.cloudTouches.set(id, touch);
          }
          if (
            !touch ||
            touch.owner !== owner ||
            touch.page !== page ||
            command.elapsedMs < touch.elapsedMs
          )
            throw Object.assign(new Error("Browser touch sequence changed."), { statusCode: 409 });
          touch.elapsedMs = command.elapsedMs;
          await touch.connection.send("Input.dispatchTouchEvent", {
            type: (
              {
                start: "touchStart",
                move: "touchMove",
                end: "touchEnd",
                cancel: "touchCancel",
              } as const
            )[command.phase],
            touchPoints:
              command.phase === "end" || command.phase === "cancel"
                ? []
                : [{ x: command.x, y: command.y, id: 1, radiusX: 1, radiusY: 1, force: 0.5 }],
            timestamp: touch.startedAt + command.elapsedMs / 1000,
          });
          if (command.phase === "end" || command.phase === "cancel") this.cloudTouches.delete(id);
        } catch (error) {
          await this.cancelCloudTouch(id, owner);
          throw error;
        }
      },
      true,
      false,
    );
  }

  async cloudReleaseTouch(id: string, owner: string): Promise<void> {
    const touch = this.cloudTouches.get(id);
    if (!touch || touch.owner !== owner) return;
    const sessionId = await this.cloudOwner(id);
    await this.serialized(sessionId, () => this.cancelCloudTouch(id, owner));
  }

  async cloudScroll(
    id: string,
    command: Extract<CloudBrowserControl, { action: "scroll" }>,
  ): Promise<void> {
    await this.cloudOperation(
      id,
      async (session) => {
        await this.dispatchCloudScroll(session, command);
      },
      true,
      false,
    );
  }

  private async dispatchCloudScroll(
    session: BrowserSession,
    command: Extract<CloudBrowserControl, { action: "scroll" }>,
  ): Promise<void> {
    const page = this.cloudInputPage(session, command);
    await session.pageIdentityPromises.get(page);
    const connection = session.pageEmulation.get(page)!;
    // Wheel events carry their own CSS-coordinate target; avoid an extra
    // mousemove/hover dispatch and CDP acknowledgement for every scroll delta.
    await connection.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: command.x,
      y: command.y,
      deltaX: command.deltaX,
      deltaY: command.deltaY,
    });
  }

  async cloudControl(id: string, command: CloudBrowserControl): Promise<CloudBrowserState> {
    return this.cloudOperation(
      id,
      async (session) => {
        await this.cancelCloudTouch(id);
        if ("revision" in command) {
          const page = this.cloudInputPage(session, command);
          // Viewer input keeps the capture running. Revisions fence agent actions,
          // navigation and viewport changes, not individual wheel/typing events.
          switch (command.action) {
            case "click":
              await page.mouse.click(command.x, command.y);
              break;
            case "scroll":
              await this.dispatchCloudScroll(session, command);
              break;
            case "drag":
              await page.mouse.move(command.x, command.y);
              await page.mouse.down();
              try {
                await page.mouse.move(command.endX, command.endY, { steps: 10 });
              } finally {
                await page.mouse.up();
              }
              break;
            case "fill-focused": {
              const target = await this.focusedInput(page);
              if (!target || target.focused.id !== command.focusId)
                throw Object.assign(new Error("The focused field changed."), { statusCode: 409 });
              await target.frame.locator(":focus").last().fill(command.value);
              break;
            }
            case "text":
              await page.keyboard.insertText(command.text);
              break;
            case "key":
              if (
                command.focusId &&
                (await this.focusedInput(page))?.focused.id !== command.focusId
              )
                throw Object.assign(new Error("The focused field changed."), { statusCode: 409 });
              await page.keyboard.press(command.key);
              break;
          }
        } else {
          session.cloudInteraction++;
          switch (command.action) {
            case "navigate":
              await this.resolvePage(session).goto(validateUrl(command.url), {
                waitUntil: "domcontentloaded",
                timeout: 30_000,
              });
              break;
            case "back": {
              const page = this.resolvePage(session);
              const connection = await page.context().newCDPSession(page);
              let currentIndex: number;
              try {
                ({ currentIndex } = await connection.send("Page.getNavigationHistory"));
              } finally {
                await connection.detach();
              }
              const opener = await page.opener();
              if (currentIndex === 0 && opener && !opener.isClosed()) {
                session.activePageId = this.pageId(session, opener);
                await page.close();
              } else {
                await page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 });
              }
              break;
            }
            case "reload":
              await this.resolvePage(session).reload({
                waitUntil: "domcontentloaded",
                timeout: 30_000,
              });
              break;
            case "switch":
              this.resolvePage(session, command.pageId);
              session.activePageId = command.pageId;
              break;
            case "close-page":
              if (session.pages.size === 1)
                throw Object.assign(new Error("Keep at least one browser tab open."), {
                  statusCode: 400,
                });
              await this.resolvePage(session, command.pageId).close();
              break;
            case "viewport": {
              const page = this.resolvePage(session);
              const modeChanged =
                (session.pageViewports.get(page)?.mobile ?? false) !== command.mobile;
              session.cloudViewport = fitCloudViewport({
                width: command.width,
                height: command.height,
                mobile: command.mobile,
                deviceScaleFactor: command.deviceScaleFactor ?? 1,
              });
              await this.setViewport(session, page, command);
              // Server-selected mobile HTML needs a new request with the mobile UA.
              // Keep the existing page, cookies, storage and browser context.
              if (modeChanged && /^https?:/.test(page.url()))
                await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
              break;
            }
          }
        }
        return this.cloudStateFor(session);
      },
      true,
    );
  }

  private abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return pending;
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener("abort", abort);
        reject(signal.reason ?? new Error("Browser action aborted"));
      };
      pending.then(
        (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }

  async closeSession(sessionId: string): Promise<void> {
    this.epochs.set(sessionId, (this.epochs.get(sessionId) ?? 0) + 1);
    await this.closeSessionNow(sessionId);
  }

  async hasSession(sessionId: string): Promise<boolean> {
    return (
      this.sessions.has(sessionId) ||
      (await readBrowserJson(
        path.join(browserSessionDirectory(this.persistenceRoot, sessionId), "launch.json"),
      )) !== undefined
    );
  }

  /** Worker admission and expiry share a queue separate from potentially interrupted CDP actions. */
  async withSessionLifecycle<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    return this.serialized(sessionId, operation, this.lifecycleQueues);
  }

  private async touchSession(sessionId: string): Promise<void> {
    const now = new Date();
    await fs.utimes(
      path.join(browserSessionDirectory(this.persistenceRoot, sessionId), "launch.json"),
      now,
      now,
    );
  }

  /** Browser activity, not conversation/task status, determines idle expiry. */
  async expireIdleSession(sessionId: string, retentionMs: number, now = Date.now()): Promise<void> {
    await this.withSessionLifecycle(sessionId, async () => {
      if (this.queues.has(sessionId) || !(await this.hasSession(sessionId))) return;
      const directory = browserSessionDirectory(this.persistenceRoot, sessionId);
      const launch = await fs.stat(path.join(directory, "launch.json"));
      const registry = await fs.stat(path.join(directory, "registry.json")).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
      // Registry mtime covers browser use before launch.json was touched on actions.
      // Both timestamps survive restart; reconnect alone does not reset expiry.
      const lastUsed = Math.max(launch.mtimeMs, registry?.mtimeMs ?? launch.mtimeMs);
      if (!this.queues.has(sessionId) && now - lastUsed >= retentionMs)
        await this.closeSession(sessionId);
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const id of this.cloudTouches.keys()) await this.cancelCloudTouch(id);
    await Promise.all(
      [...this.sessions.keys()].map(async (sessionId) => {
        const session = this.sessions.get(sessionId);
        if (!session) return;
        this.sessions.delete(sessionId);
        // CDP Browser.close() on a connected client detaches the transport;
        // only explicit closePersistentBrowser terminates the process group.
        await session.browser.close();
      }),
    );
  }

  private async createSession(
    sessionId: string,
    viewport: BrowserViewport | undefined,
    useTailscale: boolean | undefined,
  ): Promise<BrowserSession> {
    if (this.sessions.size >= MAX_BROWSER_SESSIONS) {
      throw new Error(`Browser session limit reached (${MAX_BROWSER_SESSIONS})`);
    }
    const epoch = this.epochs.get(sessionId) ?? 0;
    const directory = browserSessionDirectory(this.persistenceRoot, sessionId);
    const proxyServer = useTailscale ? await this.requireTailscaleProxy() : undefined;
    const { browser, receipt, created } = await connectPersistentBrowser(
      directory,
      useTailscale === undefined ? undefined : { useTailscale, proxyServer },
    );
    const identity = browserIdentity(browser.version());
    const context = browser.contexts()[0]!;
    const registry = await readBrowserJson<PersistentBrowserRegistry>(
      path.join(directory, "registry.json"),
    );
    const session: BrowserSession = {
      browser,
      directory,
      context,
      useTailscale: receipt.useTailscale,
      identity,
      cloudViewport: registry?.cloudViewport,
      cloudEnabled: !!(await readBrowserJson(path.join(directory, "cloud.json"))),
      pageEmulation: new WeakMap(),
      nativeWindowRevisions: new Map(),
      pageViewports: new WeakMap(),
      pageIdentityPromises: new WeakMap(),
      pages: new Map(),
      pageIds: new WeakMap(),
      rejectedPages: new WeakSet(),
      frames: new Map(),
      frameIds: new WeakMap(),
      nextPageNumber: registry?.nextPageNumber ?? 1,
      nextFrameNumber: registry?.nextFrameNumber ?? 1,
      downloadDirs: new Set(),
      cloudGeneration: randomUUID(),
      cloudInteraction: 0,
      navigations: new WeakMap(),
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
      for (const page of context.pages()) {
        const target = await this.targetId(context, page);
        this.registerPage(session, page, false, registry?.pages[target]);
        for (const frame of page.frames()) {
          const marker = await frame.evaluate(() => (globalThis as any).__battyFrameId);
          if (typeof marker === "string" && registry?.frames[`${target}:${marker}`]) {
            const current = session.frameIds.get(frame)!;
            session.frames.delete(current);
            session.frameIds.set(frame, marker);
            session.frames.set(marker, frame);
          }
        }
      }
      if (registry?.activePageId && session.pages.has(registry.activePageId))
        session.activePageId = registry.activePageId;
      if (!session.pages.size) this.registerPage(session, await context.newPage(), true);
      if (created && viewport) await this.setViewport(session, this.resolvePage(session), viewport);
    } catch (error) {
      await context.close().catch(() => {});
      throw error;
    }
    if ((this.epochs.get(sessionId) ?? 0) !== epoch) {
      await closePersistentBrowser(directory, browser);
      throw new Error("Browser session closed during startup");
    }
    if (this.disposed) {
      await this.persistRegistry(session);
      await browser.close();
      throw new Error("Browser service disposed during startup");
    }
    this.sessions.set(sessionId, session);
    return session;
  }

  private registerPage(
    session: BrowserSession,
    page: Page,
    activate: boolean,
    restoredId?: string,
  ): string {
    const existingId = session.pageIds.get(page);
    if (existingId) {
      if (activate) session.activePageId = existingId;
      return existingId;
    }

    const pageId = restoredId ?? `page-${session.nextPageNumber++}`;
    const identityPromise = this.configureBrowserIdentity(session, page);
    void identityPromise.catch(() => {});
    session.pageIdentityPromises.set(page, identityPromise);
    session.pageIds.set(page, pageId);
    session.pages.set(pageId, page);
    if (activate || !session.activePageId) session.activePageId = pageId;
    for (const frame of page.frames()) this.registerFrame(session, frame);
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame())
        session.navigations.set(page, (session.navigations.get(page) ?? 0) + 1);
    });
    page.on("popup", (popup) => {
      if (!session.rejectedPages.has(popup)) this.registerPage(session, popup, true);
    });
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
      if (input.viewport) await this.setViewport(session, page, input.viewport);
      return page;
    }
    const page = this.resolvePage(session, input.pageId);
    if (input.viewport && !sessionCreated) await this.setViewport(session, page, input.viewport);
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
    const connection = await session.context.newCDPSession(page);
    session.pageEmulation.set(page, connection);
    if (session.cloudViewport) {
      session.cloudViewport = fitCloudViewport(session.cloudViewport);
      await page.setViewportSize(session.cloudViewport);
      await this.emulateViewport(session, page, session.cloudViewport);
    } else {
      if (session.cloudEnabled) {
        const viewport = page.viewportSize();
        if (viewport) await page.setViewportSize(fitCloudViewport(viewport));
      }
      await connection.send("Emulation.setUserAgentOverride", session.identity);
    }
  }

  private async setViewport(
    session: BrowserSession,
    page: Page,
    viewport: BrowserViewport,
  ): Promise<void> {
    await session.pageIdentityPromises.get(page);
    if (session.cloudEnabled) viewport = fitCloudViewport(viewport);
    await page.setViewportSize(viewport);
    if (session.cloudViewport) {
      session.cloudViewport = {
        ...session.cloudViewport,
        width: viewport.width,
        height: viewport.height,
      };
      await this.emulateViewport(session, page, session.cloudViewport);
    }
  }

  private async emulateViewport(
    session: BrowserSession,
    page: Page,
    viewport: CloudBrowserViewport,
  ): Promise<void> {
    const connection = session.pageEmulation.get(page)!;
    await connection.send(
      "Emulation.setUserAgentOverride",
      browserIdentity(session.browser.version(), viewport.mobile),
    );
    await connection.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
      mobile: viewport.mobile,
      screenOrientation: {
        type: viewport.width > viewport.height ? "landscapePrimary" : "portraitPrimary",
        angle: viewport.width > viewport.height ? 90 : 0,
      },
    });
    await connection.send("Emulation.setTouchEmulationEnabled", {
      enabled: viewport.mobile,
      maxTouchPoints: 1,
    });
    session.pageViewports.set(page, { ...viewport });
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
      case "attach":
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

  private async targetId(context: BrowserContext, page: Page): Promise<string> {
    const cdp = await context.newCDPSession(page);
    try {
      return (await cdp.send("Target.getTargetInfo")).targetInfo.targetId;
    } finally {
      await cdp.detach();
    }
  }

  private async persistRegistry(session: BrowserSession): Promise<void> {
    const pages: Record<string, string> = {};
    const frames: Record<string, string> = {};
    for (const [pageId, page] of session.pages) {
      if (page.isClosed()) continue;
      const target = await this.targetId(session.context, page);
      pages[target] = pageId;
      for (const frame of page.frames()) {
        const id = this.registerFrame(session, frame);
        await frame.evaluate((id) => {
          Object.defineProperty(globalThis, "__battyFrameId", { value: id, configurable: true });
        }, id);
        frames[`${target}:${id}`] = id;
      }
    }
    await writeBrowserJson(path.join(session.directory, "registry.json"), {
      cloudViewport: session.cloudViewport,
      activePageId: session.activePageId,
      nextPageNumber: session.nextPageNumber,
      nextFrameNumber: session.nextFrameNumber,
      pages,
      frames,
    });
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
    this.sessions.delete(sessionId);
    for (const [id, touch] of this.cloudTouches)
      if (touch.session === session) this.cloudTouches.delete(id);
    await closePersistentBrowser(
      browserSessionDirectory(this.persistenceRoot, sessionId),
      session?.browser,
    );
    if (session)
      await Promise.all(
        [...session.downloadDirs].map((dir) => fs.rm(dir, { recursive: true, force: true })),
      );
    const entries = await fs
      .readdir(this.persistenceRoot, { withFileTypes: true })
      .catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      });
    if (!entries.some((entry) => entry.isDirectory())) await this.tailscaleProxy?.dispose();
  }

  private async serialized<T>(
    sessionId: string,
    operation: () => Promise<T>,
    queues = this.queues,
    agentAction = false,
  ): Promise<T> {
    const previous = queues.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    queues.set(sessionId, current);
    await previous;
    if (agentAction) this.activeAgentSessions.add(sessionId);
    try {
      return await operation();
    } finally {
      if (agentAction) this.activeAgentSessions.delete(sessionId);
      release();
      if (queues.get(sessionId) === current) queues.delete(sessionId);
    }
  }
}
