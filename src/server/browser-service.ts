import fs from "node:fs/promises";
import { browserAbortable } from "./browser-abort";
import { randomUUID } from "node:crypto";
import type { BrowserDescriptor } from "@/shared/types";
import path from "node:path";
import type { BrowserContext, Page } from "patchright";
import {
  browserSessionDirectory,
  closePersistentBrowser,
  connectPersistentBrowser,
  interruptedBrowser,
  readBrowserJson,
  writeBrowserJson,
  type PersistentBrowserRegistry,
} from "./browser-persistence";
import { DEFAULT_BROWSER_MAX_TABS } from "./options";
import { installWebAuthnPolicy } from "./browser-webauthn";
import type { BrowserProxy } from "./ssh-socks-proxy";
import type { BrowserActionInput } from "./browser-schemas";
export type { BrowserAction, BrowserActionInput } from "./browser-schemas";

export type { BrowserViewport } from "./browser-pages";
export type { BrowserActionResult } from "./browser-actions";
import { cloudEnded, BrowserViewer } from "./browser-viewer";
import {
  configurePage,
  pageForOpen,
  pageId,
  registerFrame,
  registerPage,
  resolveFrame,
  resolvePage,
  setViewport,
  type BrowserSession,
  type BrowserViewport,
} from "./browser-pages";
import {
  framesResult,
  pageDetails,
  pagesResult,
  performPageAction,
  required,
  snapshotResult,
  textResult,
  timeout,
  validateUrl,
  type BrowserActionResult,
} from "./browser-actions";

const CLOUD_OPERATION_TIMEOUT_MS = 15_000;
const CANCELLATION_CLEANUP_TIMEOUT_MS = 15_000;
const MAX_BROWSER_SESSIONS = 8;

interface AgentCancellation {
  page?: Page;
  evaluating: boolean;
}

/** Stable browser key shared by all agents in a workspace. */
export function workspaceBrowserKey(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}

export class BrowserService {
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly lifecycleQueues = new Map<string, Promise<void>>();
  private readonly startups = new Map<string, Promise<BrowserSession>>();
  private readonly epochs = new Map<string, number>();
  private disposed = false;
  private readonly activeAgentSessions = new Set<string>();
  private readonly viewer: BrowserViewer;

  constructor(
    private readonly tailscaleProxy?: BrowserProxy,
    private readonly maxTabs = DEFAULT_BROWSER_MAX_TABS,
    private readonly persistenceRoot = path.join(process.cwd(), ".batty", "browser"),
  ) {
    this.tailscaleProxy?.setPersistenceRoot?.(this.persistenceRoot);
    this.viewer = new BrowserViewer(this.persistenceRoot, this.maxTabs, (...args) =>
      this.cloudOperation(...args),
    );
  }

  async execute(
    sessionId: string,
    input: BrowserActionInput,
    signal?: AbortSignal,
    clientId = "legacy",
  ): Promise<BrowserActionResult> {
    const controller = new AbortController();
    const deadline = setTimeout(
      () =>
        controller.abort(
          new Error(`Browser ${input.action} exceeded timeoutMs (${timeout(input)} ms)`),
        ),
      timeout(input),
    );
    const cancellation = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      return await this.executeAction(sessionId, input, cancellation, clientId);
    } finally {
      clearTimeout(deadline);
    }
  }

  private async executeAction(
    sessionId: string,
    input: BrowserActionInput,
    signal: AbortSignal | undefined,
    clientId: string,
  ): Promise<BrowserActionResult> {
    signal?.throwIfAborted();
    if (this.disposed) throw new Error("Browser service is disposed");
    if (input.identity && input.action !== "open" && input.action !== "reload")
      throw new Error("Browser identity can only be set on open or reload.");
    if (input.action === "close") {
      await browserAbortable(
        this.withSessionLifecycle(sessionId, async () => {
          await this.closeSession(sessionId);
          await fs.rm(
            path.join(browserSessionDirectory(this.persistenceRoot, sessionId), "relaunch.json"),
            { force: true },
          );
        }),
        signal,
      );
      return { text: "Browser session closed.", details: { action: input.action } };
    }
    const cancellation: AgentCancellation = { evaluating: false };
    // Cancellation must reach the serialized operation, not just its caller.
    // Explicit close remains outside the queue so it can interrupt a stalled action.
    return await this.serialized(
      sessionId,
      async () => {
        signal?.throwIfAborted();
        // Registering the action queue protects queued/running browser calls;
        // admission waits for any expiry already closing the old instance.
        await this.withSessionLifecycle(sessionId, async () => {
          if (await this.hasSession(sessionId)) await this.touchSession(sessionId);
        });
        signal?.throwIfAborted();
        if (
          await readBrowserJson(
            path.join(browserSessionDirectory(this.persistenceRoot, sessionId), "relaunch.json"),
          )
        )
          throw new Error(
            'Browser relaunch was interrupted. Open the browser viewer to retry, or use action="close" to end the session.',
          );
        try {
          let session = this.sessions.get(sessionId);
          if (
            !session &&
            (await readBrowserJson(
              path.join(browserSessionDirectory(this.persistenceRoot, sessionId), "launch.json"),
            ))
          )
            session = await this.createSession(sessionId, undefined, undefined, signal);
          if (
            session &&
            input.useTailscale != null &&
            input.useTailscale !== session.useTailscale
          ) {
            throw new Error(
              'Browser routing is fixed for the session. Use action="close", then open a new session.',
            );
          }

          if (session?.useTailscale) await this.requireTailscaleProxy(signal);
          if (
            session &&
            (input.viewport ||
              !["attach", "pages", "snapshot", "screenshot", "frames", "wait"].includes(
                input.action,
              ))
          )
            await this.viewer.cancelTouches(session);

          if (input.action === "open")
            return await this.openAgentPage(
              sessionId,
              session,
              input,
              clientId,
              cancellation,
              signal,
            );

          if (!session) {
            throw new Error('No active browser page. Start with action="open".');
          }

          return await this.actOnAgentPage(
            sessionId,
            session,
            input,
            clientId,
            cancellation,
            signal,
          );
        } finally {
          const session = this.sessions.get(sessionId);
          if (!signal?.aborted && session?.browser.isConnected()) {
            await this.persistRegistry(session);
            signal?.throwIfAborted();
            await this.touchSession(sessionId);
          }
        }
      },
      this.queues,
      true,
      signal,
      () => cancellation.page,
      () => cancellation.evaluating,
    );
  }

  private async openAgentPage(
    sessionId: string,
    session: BrowserSession | undefined,
    input: BrowserActionInput,
    clientId: string,
    cancellation: AgentCancellation,
    signal?: AbortSignal,
  ): Promise<BrowserActionResult> {
    const url = validateUrl(required(input.url, "url", input.action));
    const created = !session;
    session ??= await this.createSession(
      sessionId,
      input.viewport,
      input.useTailscale ?? false,
      signal,
    );
    signal?.throwIfAborted();
    if (input.cloud) await this.viewer.enableCloud(sessionId, session);
    if (created && input.cloud && !input.viewport)
      await setViewport(session, resolvePage(session), {
        width: 390,
        height: 640,
      });
    session.cloudInteraction++;
    const selected = session.agentPages.get(clientId);
    const page = await pageForOpen(
      session,
      {
        ...input,
        pageId: input.pageId ?? selected,
        newPage: input.newPage || (!created && !input.pageId && !selected),
      },
      created,
      this.maxTabs,
    );
    session.agentPages.set(clientId, pageId(session, page));
    session.pageActors.set(page, clientId);
    cancellation.page = page;
    signal?.throwIfAborted();
    await configurePage(session, page, input.identity, timeout(input));
    signal?.throwIfAborted();
    await page.goto(url, { waitUntil: "domcontentloaded", signal });
    signal?.throwIfAborted();
    const result = await snapshotResult(session, clientId, input, page);
    if (input.cloud) result.details.sites = [await this.viewer.cloudAttachment(session)];
    return result;
  }

  private async actOnAgentPage(
    sessionId: string,
    session: BrowserSession,
    input: BrowserActionInput,
    clientId: string,
    cancellation: AgentCancellation,
    signal?: AbortSignal,
  ): Promise<BrowserActionResult> {
    if (input.cloud) await this.viewer.enableCloud(sessionId, session);
    if (input.action === "attach") {
      const site = await this.viewer.cloudAttachment(session);
      return {
        text: "Live cloud browser ready.",
        details: { action: "attach", sites: [site] },
      };
    }
    if (input.action === "pages")
      return await pagesResult(session, input.action, undefined, session.agentPages.get(clientId));

    if (!["snapshot", "screenshot", "frames", "wait"].includes(input.action))
      session.cloudInteraction++;
    const selected = input.pageId ?? session.agentPages.get(clientId);
    if (!selected)
      throw new Error(
        'No selected browser tab. Use action="pages", then action="switch" with pageId, or open a new page.',
      );
    const page = resolvePage(session, selected);
    if (
      !["snapshot", "screenshot", "frames", "wait", "switch", "close-page"].includes(input.action)
    )
      session.pageActors.set(page, clientId);
    cancellation.page = page;
    await configurePage(session, page, input.identity, timeout(input));
    signal?.throwIfAborted();
    if (input.viewport) await setViewport(session, page, input.viewport);
    signal?.throwIfAborted();

    if (input.action === "switch") {
      session.agentPages.set(clientId, pageId(session, page));
      return await snapshotResult(session, clientId, input, page);
    }
    if (input.action === "close-page") {
      const closedPageId = pageId(session, page);
      // Chrome exits when its final tab closes. Keep an unselected blank
      // tab without redirecting any client's closed selection to it.
      if (session.pages.size === 1)
        await pageForOpen(session, { action: "open", newPage: true }, false, this.maxTabs);
      await page.close();
      return await pagesResult(
        session,
        input.action,
        `Closed page ${closedPageId}. Select another tab with action="switch".`,
        session.agentPages.get(clientId),
      );
    }
    if (input.action === "frames") return framesResult(session, input, page);

    const frame = resolveFrame(session, page, input.frameId);
    cancellation.evaluating =
      input.action === "evaluate" || (input.action === "scroll" && !input.selector);
    const output = await performPageAction(session, page, frame, input, signal);
    signal?.throwIfAborted();
    cancellation.evaluating = false;
    if (output.text != null) {
      return await textResult(session, input, page, frame, output);
    }
    return await snapshotResult(session, clientId, input, page, frame, output);
  }

  /** Open the workspace viewer without navigating or replacing its existing tabs. */
  async openCloudBrowser(sessionId: string): Promise<BrowserDescriptor> {
    if (process.platform !== "linux") throw new Error("Cloud browser requires Linux.");
    const signal = AbortSignal.timeout(30_000);
    return this.serialized(
      sessionId,
      async () => {
        if (this.disposed) throw new Error("Browser service is disposed");
        await this.withSessionLifecycle(sessionId, async () => {
          if (await this.hasSession(sessionId)) await this.touchSession(sessionId);
        });
        const directory = browserSessionDirectory(this.persistenceRoot, sessionId);
        const relaunchFile = path.join(directory, "relaunch.json");
        const interrupted = await interruptedBrowser(directory);
        const relaunch =
          interrupted ?? (await readBrowserJson<{ useTailscale: boolean }>(relaunchFile));
        if (relaunch?.useTailscale) await this.requireTailscaleProxy(signal);
        if (interrupted) {
          // A viewer start is explicit permission to relaunch the same profile.
          // Keep routing intent across failed launches, independently of process receipts.
          await writeBrowserJson(relaunchFile, { useTailscale: interrupted.useTailscale });
          await this.closeSession(sessionId);
        }
        const session =
          this.sessions.get(sessionId) ??
          (await this.createSession(
            sessionId,
            undefined,
            relaunch?.useTailscale ?? ((await this.hasSession(sessionId)) ? undefined : false),
            signal,
            !!relaunch,
          ));
        signal.throwIfAborted();
        if (session.useTailscale) await this.requireTailscaleProxy(signal);
        await this.viewer.enableCloud(sessionId, session);
        await this.persistRegistry(session);
        await this.touchSession(sessionId);
        await fs.rm(relaunchFile, { force: true });
        return this.viewer.cloudAttachment(session);
      },
      this.queues,
      true,
      signal,
    );
  }

  private async cloudOperation<T>(
    id: string,
    operation: (session: BrowserSession) => Promise<T>,
    rejectBusy = false,
    persistRegistry = rejectBusy,
  ): Promise<T> {
    if (this.disposed) throw cloudEnded();
    const controller = new AbortController();
    let running = false;
    const deadline = setTimeout(
      () =>
        controller.abort(
          Object.assign(
            new Error(
              running
                ? "Cloud browser operation timed out."
                : "Cloud browser queue timed out. Another operation is still using the browser.",
            ),
            { statusCode: 504 },
          ),
        ),
      CLOUD_OPERATION_TIMEOUT_MS,
    );
    const signal = controller.signal;
    try {
      const owner = await browserAbortable(this.viewer.cloudOwner(id), signal);
      if (rejectBusy && this.activeAgentSessions.has(owner))
        throw Object.assign(new Error("Browser is busy. Try again when the agent finishes."), {
          statusCode: 409,
        });
      return await this.serialized(
        owner,
        async () => {
          running = true;
          signal.throwIfAborted();
          await this.viewer.cloudOwner(id);
          signal.throwIfAborted();
          let session = this.sessions.get(owner);
          if (!session) {
            try {
              session = await this.createSession(owner, undefined, undefined, signal);
            } catch (error) {
              if (["ESRCH", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? ""))
                throw cloudEnded();
              throw error;
            }
          }
          signal.throwIfAborted();
          if (!session.browser.isConnected()) throw cloudEnded();
          try {
            return await operation(session);
          } catch (error) {
            // A closed viewer selection is recoverable only by an explicit
            // switch/new action. Keep the surviving tabs available to the UI.
            if ((error as Error).message.startsWith("Unknown browser page:")) {
              throw Object.assign(error as Error, {
                statusCode: 409,
                pages: (await pageDetails(session)).map((page) => ({
                  ...page,
                  active: false,
                })),
              });
            }
            throw error;
          } finally {
            // An abandoned CDP promise may settle after timeout/closure. Never
            // persist it or touch a newer session that reused the same owner.
            if (!signal.aborted && session.browser.isConnected()) {
              if (persistRegistry) await this.persistRegistry(session);
              signal.throwIfAborted();
              await this.touchSession(owner);
            }
          }
        },
        this.queues,
        false,
        signal,
      );
    } finally {
      clearTimeout(deadline);
    }
  }

  cloudVideoGeometry(...args: Parameters<BrowserViewer["cloudVideoGeometry"]>) {
    return this.viewer.cloudVideoGeometry(...args);
  }

  messageBrowser(workspaceId: string, browserId: string) {
    return this.viewer.messageBrowser(workspaceBrowserKey(workspaceId), browserId);
  }

  cloudState(...args: Parameters<BrowserViewer["cloudState"]>) {
    return this.viewer.cloudState(...args);
  }

  cloudCaptureTarget(...args: Parameters<BrowserViewer["cloudCaptureTarget"]>) {
    return this.viewer.cloudCaptureTarget(...args);
  }

  cloudTarget(...args: Parameters<BrowserViewer["cloudTarget"]>) {
    return this.viewer.cloudTarget(...args);
  }

  prepareCloudCredentials(...args: Parameters<BrowserViewer["prepareCloudCredentials"]>) {
    return this.viewer.prepareCloudCredentials(...args);
  }

  fillCloudCredentials(...args: Parameters<BrowserViewer["fillCloudCredentials"]>) {
    return this.viewer.fillCloudCredentials(...args);
  }

  cloudTouch(...args: Parameters<BrowserViewer["cloudTouch"]>) {
    return this.viewer.cloudTouch(...args);
  }

  cloudReleaseTouch(...args: Parameters<BrowserViewer["cloudReleaseTouch"]>) {
    return this.viewer.cloudReleaseTouch(...args);
  }

  cloudScroll(...args: Parameters<BrowserViewer["cloudScroll"]>) {
    return this.viewer.cloudScroll(...args);
  }

  cloudControl(...args: Parameters<BrowserViewer["cloudControl"]>) {
    return this.viewer.cloudControl(...args);
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

  /** Browser action admission and expiry share a queue separate from CDP actions. */
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
    await this.viewer.cancelTouches();
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
    signal?: AbortSignal,
    restoreTabs = false,
  ): Promise<BrowserSession> {
    const pending = this.createSessionNow(sessionId, viewport, useTailscale, signal, restoreTabs);
    this.startups.set(sessionId, pending);
    try {
      return await pending;
    } finally {
      if (this.startups.get(sessionId) === pending) this.startups.delete(sessionId);
    }
  }

  private async createSessionNow(
    sessionId: string,
    viewport: BrowserViewport | undefined,
    useTailscale: boolean | undefined,
    signal?: AbortSignal,
    restoreTabs = false,
  ): Promise<BrowserSession> {
    if (this.sessions.size >= MAX_BROWSER_SESSIONS) {
      throw new Error(`Browser session limit reached (${MAX_BROWSER_SESSIONS})`);
    }
    const epoch = this.epochs.get(sessionId) ?? 0;
    const directory = browserSessionDirectory(this.persistenceRoot, sessionId);
    signal?.throwIfAborted();
    const proxyServer = useTailscale ? await this.requireTailscaleProxy(signal) : undefined;
    signal?.throwIfAborted();
    const { browser, receipt, created } = await connectPersistentBrowser(
      directory,
      useTailscale === undefined ? undefined : { useTailscale, proxyServer, restoreTabs },
      signal,
    );
    const context = browser.contexts()[0]!;
    const registry = await readBrowserJson<PersistentBrowserRegistry>(
      path.join(directory, "registry.json"),
    );
    const session: BrowserSession = {
      browser,
      directory,
      context,
      useTailscale: receipt.useTailscale,
      pageIdentities: new WeakMap(),
      cloudViewport: registry?.cloudViewport,
      cloudEnabled: !!(await readBrowserJson(path.join(directory, "cloud.json"))),
      pageEmulation: new WeakMap(),
      nativeWindowRevisions: new Map(),
      pageViewports: new WeakMap(),
      pageIdentityPromises: new WeakMap(),
      pages: new Map(),
      agentPages: new Map(Object.entries(registry?.agentPages ?? {})),
      pageActors: new WeakMap(),
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
      // Native foreground can change independently of logical client selections,
      // including a popup created after its initiating action has completed.
      session.cloudInteraction++;
      if (session.pages.size >= this.maxTabs) {
        page.on("close", () => session.cloudInteraction++);
        session.rejectedPages.add(page);
        void page.close().catch(() => {});
        return;
      }
      registerPage(session, page, false);
    });
    try {
      await browserAbortable(installWebAuthnPolicy(context), signal);
      for (const page of context.pages()) {
        const target = await browserAbortable(this.targetId(context, page), signal);
        registerPage(
          session,
          page,
          false,
          registry?.pages[target],
          registry?.pageIdentities?.[target],
        );
        for (const frame of page.frames()) {
          const marker = await browserAbortable(
            frame.evaluate(() => (globalThis as any).__battyFrameId),
            signal,
          );
          if (typeof marker === "string" && registry?.frames[`${target}:${marker}`]) {
            const current = session.frameIds.get(frame)!;
            session.frames.delete(current);
            session.frameIds.set(frame, marker);
            session.frames.set(marker, frame);
          }
        }
      }
      if (registry?.activePageId) session.activePageId = registry.activePageId;
      if (!session.pages.size)
        registerPage(session, await browserAbortable(context.newPage(), signal), true);
      if (created && viewport)
        await browserAbortable(setViewport(session, resolvePage(session), viewport), signal);
      signal?.throwIfAborted();
    } catch (error) {
      try {
        await closePersistentBrowser(directory, browser);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Browser startup and cleanup failed");
      }
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
    const pageIdentities: Record<string, "desktop" | "mobile"> = {};
    const frames: Record<string, string> = {};
    for (const [pageId, page] of session.pages) {
      if (page.isClosed()) continue;
      const target = await this.targetId(session.context, page);
      pages[target] = pageId;
      const identity = session.pageIdentities.get(page);
      if (identity) pageIdentities[target] = identity;
      for (const frame of page.frames()) {
        const id = registerFrame(session, frame);
        await frame.evaluate((id) => {
          Object.defineProperty(globalThis, "__battyFrameId", { value: id, configurable: true });
        }, id);
        frames[`${target}:${id}`] = id;
      }
    }
    await writeBrowserJson(path.join(session.directory, "registry.json"), {
      cloudViewport: session.cloudViewport,
      activePageId: session.activePageId,
      agentPages: Object.fromEntries(session.agentPages),
      pageIdentities,
      nextPageNumber: session.nextPageNumber,
      nextFrameNumber: session.nextFrameNumber,
      pages,
      frames,
    });
  }

  private async requireTailscaleProxy(signal?: AbortSignal): Promise<string> {
    if (!this.tailscaleProxy) {
      throw new Error(
        "Tailscale browser routing is not configured. Set browserTailscaleSshDestination in options.json.",
      );
    }
    return this.tailscaleProxy.ensureStarted(signal);
  }

  private async closeSessionNow(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    this.viewer.forgetSessionTouches(session);
    const errors: unknown[] = [];
    try {
      await closePersistentBrowser(
        browserSessionDirectory(this.persistenceRoot, sessionId),
        session?.browser,
      );
    } catch (error) {
      errors.push(error);
    }
    if (session) {
      const downloads = await Promise.allSettled(
        [...session.downloadDirs].map((dir) => fs.rm(dir, { recursive: true, force: true })),
      );
      for (const result of downloads) if (result.status === "rejected") errors.push(result.reason);
    }
    try {
      const entries = await fs
        .readdir(this.persistenceRoot, { withFileTypes: true })
        .catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        });
      const active = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map((entry) =>
            readBrowserJson(path.join(this.persistenceRoot, entry.name, "launch.json")),
          ),
      );
      if (!this.startups.size && !active.some(Boolean)) await this.tailscaleProxy?.dispose();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, "Browser session cleanup failed");
  }

  private async settlesWithin(pending: Promise<unknown>, milliseconds: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending.then(
          () => true,
          () => true,
        ),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), milliseconds);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async serialized<T>(
    sessionId: string,
    operation: () => Promise<T>,
    queues = this.queues,
    agentAction = false,
    signal?: AbortSignal,
    recoveryPage?: () => Page | undefined,
    destroyTarget?: () => boolean,
  ): Promise<T> {
    const previous = queues.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    queues.set(sessionId, current);
    try {
      await browserAbortable(previous, signal);
    } catch (error) {
      // Keep later callers behind the actual predecessor, not an abandoned waiter.
      void previous.finally(() => {
        release();
        if (queues.get(sessionId) === current) queues.delete(sessionId);
      });
      throw error;
    }
    if (agentAction) this.activeAgentSessions.add(sessionId);
    let cancellationCleanup: Promise<void> | undefined;
    let pending: Promise<T> | undefined;
    try {
      signal?.throwIfAborted();
      pending = operation();
      return await browserAbortable(pending, signal);
    } catch (error) {
      if (signal?.aborted && pending) {
        cancellationCleanup = (async () => {
          // Locator/navigation AbortSignals settle cooperatively. Give the driver
          // time to acknowledge cancellation before touching the shared browser.
          if (!destroyTarget?.() && pending && (await this.settlesWithin(pending, 500))) return;
          const page = recoveryPage?.();
          if (page) {
            try {
              // evaluate has no AbortSignal: closing its target destroys its JS
              // context, including timers/promises which could mutate it later.
              await browserAbortable(page.close(), AbortSignal.timeout(2_000));
              if (pending && (await this.settlesWithin(pending, 500))) return;
            } catch {
              // Recovery itself failed; the process is the remaining boundary.
            }
          }
          // Startup must finish its own cancellation cleanup before removal/retry.
          await this.startups.get(sessionId)?.catch(() => {});
          await this.closeSession(sessionId);
        })();
        try {
          await browserAbortable(
            cancellationCleanup,
            AbortSignal.timeout(CANCELLATION_CLEANUP_TIMEOUT_MS),
          );
        } catch (cleanupError) {
          throw Object.assign(
            new AggregateError(
              [error, cleanupError],
              `Browser cancellation cleanup failed or exceeded ${CANCELLATION_CLEANUP_TIMEOUT_MS} ms`,
            ),
            { statusCode: (error as { statusCode?: number })?.statusCode },
          );
        }
      }
      throw error;
    } finally {
      const finish = () => {
        if (agentAction) this.activeAgentSessions.delete(sessionId);
        release();
        if (queues.get(sessionId) === current) queues.delete(sessionId);
      };
      // A cleanup timeout ends the caller's wait, not ownership of the browser.
      // Keep later actions fenced until the actual cleanup has finished.
      if (cancellationCleanup)
        void cancellationCleanup.then(finish, (error) => {
          console.error("Browser cancellation cleanup", error);
          finish();
        });
      else finish();
    }
  }
}
