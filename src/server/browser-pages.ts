import type { Browser, BrowserContext, CDPSession, Frame, Page } from "patchright";
import type { CloudBrowserViewport } from "@/shared/cloud-browser";
import { fitCloudViewport } from "@/shared/browser-geometry";
import type { BrowserActionInput } from "./browser-schemas";

export interface BrowserViewport {
  width: number;
  height: number;
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

export interface BrowserSession {
  browser: Browser;
  directory: string;
  context: BrowserContext;
  useTailscale: boolean;
  pageIdentities: WeakMap<Page, "desktop" | "mobile">;
  cloudViewport?: CloudBrowserViewport;
  cloudEnabled: boolean;
  pageEmulation: WeakMap<Page, CDPSession>;
  nativeWindowRevisions: Map<number, string>;
  pageViewports: WeakMap<Page, CloudBrowserViewport>;
  pageIdentityPromises: WeakMap<Page, Promise<void>>;
  pages: Map<string, Page>;
  pageIds: WeakMap<Page, string>;
  rejectedPages: WeakSet<Page>;
  frames: Map<string, Frame>;
  frameIds: WeakMap<Frame, string>;
  activePageId?: string;
  agentPages: Map<string, string>;
  pageActors: WeakMap<Page, string>;
  nextPageNumber: number;
  nextFrameNumber: number;
  downloadDirs: Set<string>;
  cloudGeneration: string;
  cloudInteraction: number;
  navigations: WeakMap<Page, number>;
}

function browserIdentity(version: string, mobile = false): BrowserIdentity {
  const majorVersion = version.split(".")[0]!;
  const brands = [
    { brand: "Not_A Brand", version: "8" },
    { brand: "Google Chrome", version: majorVersion },
    { brand: "Chromium", version: majorVersion },
  ];
  return {
    platform: mobile ? "Linux armv8l" : "MacIntel",
    userAgent: mobile
      ? `Mozilla/5.0 (Linux; Android 13; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorVersion}.0.0.0 Mobile Safari/537.36`
      : `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorVersion}.0.0.0 Safari/537.36`,
    userAgentMetadata: {
      brands,
      fullVersionList: [
        { brand: "Not_A Brand", version: "8.0.0.0" },
        { brand: "Google Chrome", version },
        { brand: "Chromium", version },
      ],
      platform: mobile ? "Android" : "macOS",
      // Chrome freezes its macOS UA token at 10_15_7; UA-CH retains the OS version.
      platformVersion: mobile ? "13.0.0" : "14.0.0",
      architecture: mobile ? "" : "x86",
      model: "",
      mobile,
      bitness: mobile ? "" : "64",
      wow64: false,
    },
  };
}

export function registerPage(
  session: BrowserSession,
  page: Page,
  activate: boolean,
  restoredId?: string,
  restoredIdentity?: "desktop" | "mobile",
): string {
  const existingId = session.pageIds.get(page);
  if (existingId) {
    if (activate) session.activePageId = existingId;
    return existingId;
  }

  const pageId = restoredId ?? `page-${session.nextPageNumber++}`;
  if (restoredIdentity) session.pageIdentities.set(page, restoredIdentity);
  const identityPromise = configureBrowserIdentity(session, page);
  void identityPromise.catch(() => {});
  session.pageIdentityPromises.set(page, identityPromise);
  session.pageIds.set(page, pageId);
  session.pages.set(pageId, page);
  if (activate || !session.activePageId) session.activePageId = pageId;
  for (const frame of page.frames()) registerFrame(session, frame);
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame())
      session.navigations.set(page, (session.navigations.get(page) ?? 0) + 1);
  });
  page.on("popup", (popup) => {
    if (session.rejectedPages.has(popup)) return;
    const popupId = registerPage(session, popup, false);
    const actor = session.pageActors.get(page);
    if (actor && actor !== "viewer") {
      if (session.agentPages.get(actor) === pageId) session.agentPages.set(actor, popupId);
    } else if (session.activePageId === pageId) session.activePageId = popupId;
  });
  page.on("frameattached", (frame) => registerFrame(session, frame));
  page.on("framedetached", (frame) => unregisterFrame(session, frame));
  page.on("close", () => {
    session.cloudInteraction++;
    session.pages.delete(pageId);
    for (const [frameId, frame] of session.frames) {
      if (frame.page() === page) session.frames.delete(frameId);
    }
    // Keep closed selections as tombstones: never redirect another client silently.
  });
  return pageId;
}

export function registerFrame(session: BrowserSession, frame: Frame): string {
  const existingId = session.frameIds.get(frame);
  if (existingId) return existingId;
  const frameId = `frame-${session.nextFrameNumber++}`;
  session.frameIds.set(frame, frameId);
  session.frames.set(frameId, frame);
  return frameId;
}

function unregisterFrame(session: BrowserSession, frame: Frame): void {
  const frameId = session.frameIds.get(frame);
  if (frameId) session.frames.delete(frameId);
}

export async function pageForOpen(
  session: BrowserSession,
  input: BrowserActionInput,
  sessionCreated: boolean,
  maxTabs: number,
): Promise<Page> {
  if ((input.newPage && !sessionCreated) || session.pages.size === 0) {
    if (session.pages.size >= maxTabs) {
      throw new Error(
        `Browser tab limit reached (${maxTabs}). Close a page before opening another.`,
      );
    }
    const page = await session.context.newPage();
    if (
      session.rejectedPages.has(page) ||
      (!session.pageIds.has(page) && session.pages.size >= maxTabs)
    ) {
      await page.close().catch(() => {});
      throw new Error(
        `Browser tab limit reached (${maxTabs}). Close a page before opening another.`,
      );
    }
    registerPage(session, page, false);
    if (input.viewport) await setViewport(session, page, input.viewport);
    return page;
  }
  const page = resolvePage(session, input.pageId);
  if (input.viewport && !sessionCreated) await setViewport(session, page, input.viewport);
  return page;
}

export function resolvePage(session: BrowserSession, requestedPageId?: string): Page {
  const pageId = requestedPageId ?? session.activePageId;
  const page = pageId ? session.pages.get(pageId) : undefined;
  if (!page || page.isClosed()) throw new Error(`Unknown browser page: ${pageId ?? "(none)"}`);
  return page;
}

export function resolveFrame(
  session: BrowserSession,
  page: Page,
  requestedFrameId?: string,
): Frame {
  for (const frame of page.frames()) registerFrame(session, frame);
  if (!requestedFrameId) return page.mainFrame();
  const frame = session.frames.get(requestedFrameId);
  if (!frame || frame.page() !== page)
    throw new Error(`Unknown browser frame: ${requestedFrameId}`);
  return frame;
}

export function pageId(session: BrowserSession, page: Page): string {
  return session.pageIds.get(page)!;
}

export function frameId(session: BrowserSession, frame: Frame): string {
  return registerFrame(session, frame);
}

async function configureBrowserIdentity(session: BrowserSession, page: Page): Promise<void> {
  const connection = await session.context.newCDPSession(page);
  session.pageEmulation.set(page, connection);
  if (session.cloudViewport) {
    session.cloudViewport = fitCloudViewport(session.cloudViewport);
    await page.setViewportSize(session.cloudViewport);
    await emulateViewport(session, page, session.cloudViewport);
  } else {
    if (session.cloudEnabled) {
      const viewport = page.viewportSize();
      if (viewport) await page.setViewportSize(fitCloudViewport(viewport));
    }
    await applyBrowserIdentity(session, page);
  }
}

export async function setViewport(
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
    await emulateViewport(session, page, session.cloudViewport);
  }
}

async function applyBrowserIdentity(session: BrowserSession, page: Page): Promise<void> {
  const mode = session.pageIdentities.get(page);
  const mobile = mode ? mode === "mobile" : (session.pageViewports.get(page)?.mobile ?? false);
  await session.pageEmulation
    .get(page)!
    .send("Emulation.setUserAgentOverride", browserIdentity(session.browser.version(), mobile));
}

async function emulateViewport(
  session: BrowserSession,
  page: Page,
  viewport: CloudBrowserViewport,
): Promise<void> {
  const connection = session.pageEmulation.get(page)!;
  session.pageViewports.set(page, { ...viewport });
  await applyBrowserIdentity(session, page);
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
}

export async function configurePage(
  session: BrowserSession,
  page: Page,
  identity: BrowserActionInput["identity"],
  timeoutMs: number,
): Promise<void> {
  await session.pageIdentityPromises.get(page);
  if (identity) {
    if (identity === "auto") session.pageIdentities.delete(page);
    else session.pageIdentities.set(page, identity);
    await applyBrowserIdentity(session, page);
  }
  page.setDefaultTimeout(timeoutMs);
  page.setDefaultNavigationTimeout(timeoutMs);
}
