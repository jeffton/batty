import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { CDPSession, Page } from "patchright";
import type { BrowserDescriptor } from "@/shared/types";
import type {
  CloudBrowserControl,
  CloudBrowserCredentials,
  CloudBrowserCredentialTarget,
  CloudBrowserState,
  CloudBrowserTouch,
} from "@/shared/cloud-browser";
import {
  NATIVE_BROWSER_SCALE,
  NATIVE_BROWSER_SIZE,
  fitCloudViewport,
} from "@/shared/browser-geometry";
import type { NativeCaptureGeometry } from "./native-browser-video";
import { credentialDocumentOperation } from "./browser-credentials";
import {
  browserSessionDirectory,
  persistentBrowserDisplay,
  readBrowserJson,
  writeBrowserJson,
} from "./browser-persistence";
import { pageDetails, validateUrl } from "./browser-actions";
import {
  pageForOpen,
  pageId,
  resolvePage,
  setViewport,
  type BrowserSession,
} from "./browser-pages";

export function cloudEnded(): Error & { statusCode: number } {
  return Object.assign(new Error("Browser session ended."), { statusCode: 410 });
}

function browserDescriptor(id: string): BrowserDescriptor {
  return {
    id: `browser-${id}`,
    kind: "browser",
    browserId: id,
    name: "Cloud browser",
    url: `/api/cloud-browser/${id}/state`,
    public: false,
  };
}

export class BrowserViewer {
  private readonly cloudOwners = new Map<string, string>();
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
    private readonly persistenceRoot: string,
    private readonly maxTabs: number,
    private readonly run: <T>(
      id: string,
      operation: (session: BrowserSession) => Promise<T>,
      rejectBusy?: boolean,
      persistRegistry?: boolean,
    ) => Promise<T>,
  ) {}

  async cancelTouches(session?: BrowserSession): Promise<void> {
    for (const [id, touch] of this.cloudTouches)
      if (!session || touch.session === session) await this.cancelCloudTouch(id);
  }

  forgetSessionTouches(session: BrowserSession | undefined): void {
    for (const [id, touch] of this.cloudTouches)
      if (touch.session === session) this.cloudTouches.delete(id);
  }

  async cloudAttachment(session: BrowserSession): Promise<BrowserDescriptor> {
    const cloud = await readBrowserJson<{ id: string }>(path.join(session.directory, "cloud.json"));
    if (!cloud) throw new Error("Enable cloud=true before attaching this browser.");
    return browserDescriptor(cloud.id);
  }

  async messageBrowser(workspaceKey: string, browserId: string) {
    if ((await this.cloudOwner(browserId)) !== workspaceKey)
      throw new Error("Cloud browser belongs to a different workspace");
    return browserDescriptor(browserId);
  }

  async enableCloud(sessionId: string, session: BrowserSession): Promise<void> {
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
          await setViewport(session, page, fitted);
      }
    }
    this.cloudOwners.set(cloud.id, sessionId);
  }

  async cloudOwner(id: string): Promise<string> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw cloudEnded();
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
    if (!owner) throw cloudEnded();
    const cloud = await readBrowserJson<{ id: string }>(
      path.join(browserSessionDirectory(this.persistenceRoot, owner), "cloud.json"),
    );
    if (cloud?.id !== id) {
      this.cloudOwners.delete(id);
      throw cloudEnded();
    }
    return owner;
  }

  private cloudView(session: BrowserSession, page: Page) {
    const viewport = page.viewportSize() ?? { width: 1365, height: 768 };
    const currentPageId = pageId(session, page);
    return {
      pageId: currentPageId,
      ...viewport,
      mobile: session.pageViewports.get(page)?.mobile ?? false,
      deviceScaleFactor: session.pageViewports.get(page)?.deviceScaleFactor ?? 1,
      revision: createHash("sha256")
        .update(
          JSON.stringify([
            session.cloudGeneration,
            session.cloudInteraction,
            currentPageId,
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
          value:
            element instanceof HTMLInputElement && element.type === "password"
              ? ""
              : input
                ? input.value
                : element.innerText,
          type: element instanceof HTMLInputElement ? element.type : "text",
          multiline: element instanceof HTMLTextAreaElement || element.isContentEditable,
        };
      }, randomUUID());
      if (focused) return { frame, focused };
    }
  }

  private async cloudStateFor(session: BrowserSession): Promise<CloudBrowserState> {
    const page = resolvePage(session);
    await session.pageIdentityPromises.get(page);
    return {
      ...this.cloudView(session, page),
      url: page.url(),
      title: await page.title(),
      focused: (await this.focusedInput(page))?.focused,
      login: (
        await page.evaluate(credentialDocumentOperation, {
          action: "detect" as const,
          id: randomUUID(),
        })
      ).login,
      pages: await pageDetails(session),
    };
  }

  async cloudVideoGeometry(id: string, state: CloudBrowserState): Promise<NativeCaptureGeometry> {
    if (process.platform !== "linux")
      throw Object.assign(
        new Error(
          "Native H.264 cloud viewing requires a Linux host with Xvfb, xauth and FFmpeg/libx264.",
        ),
        { statusCode: 501 },
      );
    return this.run(id, async (session) => {
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
      // X11 captures the foreground window, not a CDP target. Agent tabs and
      // popups can raise another window without changing the viewer selection.
      await page.bringToFront();
      return { display: display.display, authority: display.authority, x: 0, y: 0, width, height };
    });
  }

  async cloudState(id: string): Promise<CloudBrowserState> {
    return this.run(
      id,
      async (session) => {
        // Opening/reconnecting the viewer reconciles its selection with the live
        // tabs. Agent selections and explicit pageId actions remain strict.
        if (!session.pages.has(session.activePageId ?? "")) {
          const next = [...session.pages].find(([, page]) => !page.isClosed());
          if (!next) throw cloudEnded();
          session.activePageId = next[0];
        }
        return this.cloudStateFor(session);
      },
      false,
      true,
    );
  }

  /** Capture polling reads only local page metadata, not titles, frames or focused fields. */
  async cloudCaptureTarget(id: string) {
    return this.run(id, async (session) => {
      const page = resolvePage(session);
      await session.pageIdentityPromises.get(page);
      return { page, state: this.cloudView(session, page) };
    });
  }

  /** Full viewer status observes the same Page object that agent actions use. */
  async cloudTarget(id: string) {
    return this.run(id, async (session) => {
      const page = resolvePage(session);
      return {
        page,
        state: await this.cloudStateFor(session),
      };
    });
  }

  async prepareCloudCredentials(id: string): Promise<CloudBrowserCredentialTarget> {
    return this.run(
      id,
      async (session) => {
        const page = resolvePage(session);
        const view = this.cloudView(session, page);
        const url = page.url();
        const origin = new URL(url).origin;
        if (!/^https?:/.test(url))
          throw Object.assign(new Error("Open a website login page first."), { statusCode: 400 });
        const token = randomUUID();
        const { login } = await page.evaluate(credentialDocumentOperation, {
          action: "prepare" as const,
          id: token,
          token,
        });
        if (!login)
          throw Object.assign(new Error("No unambiguous sign-in form is visible on this page."), {
            statusCode: 409,
          });
        this.cloudInputPage(session, view);
        if (page.url() !== url)
          throw Object.assign(
            new Error("The login page changed. Open the credential panel again."),
            { statusCode: 409 },
          );
        return {
          pageId: view.pageId,
          revision: view.revision,
          url,
          origin,
          token,
          loginId: login.id,
        };
      },
      true,
      false,
    );
  }

  async fillCloudCredentials(id: string, command: CloudBrowserCredentials): Promise<void> {
    await this.run(
      id,
      async (session) => {
        const page = this.cloudInputPage(session, command.target, true);
        // Never expose Patchright errors/call arguments containing credentials.
        let filled = false;
        try {
          filled = !!(
            await page.evaluate(credentialDocumentOperation, {
              action: "fill" as const,
              id: randomUUID(),
              credentials: command,
            })
          ).filled;
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
    interaction = false,
  ): Page {
    const page = resolvePage(session);
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
    if (interaction) session.pageActors.set(page, "viewer");
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
    await this.run(
      id,
      async (session) => {
        try {
          const page = this.cloudInputPage(session, command, true);
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
    await this.run(id, () => this.cancelCloudTouch(id, owner), false, false);
  }

  async cloudScroll(
    id: string,
    command: Extract<CloudBrowserControl, { action: "scroll" }>,
  ): Promise<void> {
    await this.run(
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
    const page = this.cloudInputPage(session, command, true);
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
    return this.run(
      id,
      async (session) => {
        await this.cancelCloudTouch(id);
        if ("revision" in command) await this.controlPaintedPage(session, command);
        else await this.controlViewerSession(session, command);
        return this.cloudStateFor(session);
      },
      true,
    );
  }

  private async controlPaintedPage(
    session: BrowserSession,
    command: Extract<CloudBrowserControl, { revision: string }>,
  ): Promise<void> {
    const page = this.cloudInputPage(session, command, true);
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
        if (command.focusId && (await this.focusedInput(page))?.focused.id !== command.focusId)
          throw Object.assign(new Error("The focused field changed."), { statusCode: 409 });
        await page.keyboard.press(command.key);
        break;
    }
  }

  private async controlViewerSession(
    session: BrowserSession,
    command: Exclude<CloudBrowserControl, { revision: string }>,
  ): Promise<void> {
    session.cloudInteraction++;
    switch (command.action) {
      case "new-page": {
        const page = await pageForOpen(
          session,
          { action: "open", newPage: true },
          false,
          this.maxTabs,
        );
        session.activePageId = pageId(session, page);
        break;
      }
      case "navigate": {
        const page = resolvePage(session);
        session.pageActors.set(page, "viewer");
        await page.goto(validateUrl(command.url), {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        break;
      }
      case "back": {
        const page = resolvePage(session);
        session.pageActors.set(page, "viewer");
        const connection = await page.context().newCDPSession(page);
        let currentIndex: number;
        try {
          ({ currentIndex } = await connection.send("Page.getNavigationHistory"));
        } finally {
          await connection.detach();
        }
        const opener = await page.opener();
        if (currentIndex === 0 && opener && !opener.isClosed()) {
          session.activePageId = pageId(session, opener);
          await page.close();
        } else {
          await page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 });
        }
        break;
      }
      case "reload": {
        const page = resolvePage(session);
        session.pageActors.set(page, "viewer");
        await page.reload({
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        break;
      }
      case "switch":
        resolvePage(session, command.pageId);
        session.activePageId = command.pageId;
        break;
      case "close-page": {
        const page = resolvePage(session, command.pageId);
        if (session.activePageId === command.pageId) {
          // An explicit viewer close selects its next tab. Other clients
          // retain their closed selection and must select a tab themselves.
          let next = [...session.pages.keys()].find((id) => id !== command.pageId);
          if (!next) {
            const blank = await pageForOpen(
              session,
              { action: "open", newPage: true },
              false,
              this.maxTabs,
            );
            next = pageId(session, blank);
          }
          session.activePageId = next;
        }
        await page.close();
        break;
      }
      case "viewport": {
        const page = resolvePage(session);
        const modeChanged = (session.pageViewports.get(page)?.mobile ?? false) !== command.mobile;
        session.cloudViewport = fitCloudViewport({
          width: command.width,
          height: command.height,
          mobile: command.mobile,
          deviceScaleFactor: command.deviceScaleFactor ?? 1,
        });
        await setViewport(session, page, command);
        // Server-selected mobile HTML needs a new request with the mobile UA.
        // Keep the existing page, cookies, storage and browser context.
        if (modeChanged && !session.pageIdentities.has(page) && /^https?:/.test(page.url()))
          await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
        break;
      }
    }
  }
}
