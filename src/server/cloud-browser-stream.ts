import type { CDPSession } from "patchright";
import type { BrowserService } from "./browser-service";
import type { CloudBrowserFrame, CloudBrowserState } from "@/shared/cloud-browser";
import { encodeBrowserFrame, type BrowserFramePacket } from "./cloud-browser-events";

type Subscriber = (event: "frame" | "state" | "browser-error", data: unknown) => void;
type Target = Awaited<ReturnType<BrowserService["cloudCaptureTarget"]>>;
const CAPTURE_POLL_MS = 100;
const STATUS_POLL_MS = 500;

/** One producer per live browser; each WebSocket viewer retains only its latest paint. */
export class CloudBrowserStreams {
  private readonly streams = new Map<
    string,
    {
      subscribers: Set<Subscriber>;
      stop: () => Promise<void>;
      scrolling: (touchActive?: boolean) => void;
      frame?: BrowserFramePacket;
      state?: CloudBrowserState;
    }
  >();

  private nextFrameId = 1;

  constructor(private readonly browser: BrowserService) {}

  scrolling(id: string, touchActive?: boolean): void {
    this.streams.get(id)?.scrolling(touchActive);
  }

  async subscribe(id: string, subscriber: Subscriber): Promise<() => void> {
    // Validate before opening an HTTP stream, including expired attachment handles.
    const initial = await this.browser.cloudTarget(id);
    let stream = this.streams.get(id);
    if (!stream) {
      const subscribers = new Set<Subscriber>();
      let cdp: CDPSession | undefined;
      let target: Target | undefined;
      let stopped = false;
      let pending: Promise<void> | undefined;
      let nextStatusAt = Date.now() + STATUS_POLL_MS;
      let lastFrameAt = 0;
      let latestFrame: CloudBrowserFrame | undefined;
      let frameTimer: ReturnType<typeof setTimeout> | undefined;
      let previousSignal: string | undefined;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let moving = false;
      let touching = false;
      let activeMode: boolean | undefined;
      let captureQueue = Promise.resolve();
      const broadcast = (event: Parameters<Subscriber>[0], value: unknown) => {
        for (const listener of subscribers) listener(event, value);
      };
      const flushFrame = () => {
        frameTimer = undefined;
        if (stopped || !latestFrame) return;
        const frame = latestFrame;
        latestFrame = undefined;
        lastFrameAt = Date.now();
        const encoded = encodeBrowserFrame(frame, this.nextFrameId++);
        stream!.frame = encoded;
        broadcast("frame", encoded);
      };
      const clearPaint = () => {
        if (frameTimer) clearTimeout(frameTimer);
        frameTimer = undefined;
        latestFrame = undefined;
        lastFrameAt = 0;
      };
      const fail = (error: unknown) => {
        if (stopped) return;
        const statusCode = (error as { statusCode?: number }).statusCode;
        const message = (error as Error).message;
        broadcast("browser-error", {
          error: message,
          statusCode,
          retryable:
            statusCode !== 410 &&
            /Execution context was destroyed|Frame was detached|Cannot find context|Target closed|Session closed|has been closed/i.test(
              message,
            ),
        });
        void stream!.stop();
      };
      const configure = (connection: CDPSession, next: Target) => {
        captureQueue = captureQueue.then(async () => {
          if (stopped || cdp !== connection || activeMode === moving) return;
          const mode = moving;
          if (activeMode !== undefined) {
            await connection.send("Page.stopScreencast");
            if (stopped || cdp !== connection) return;
          }
          clearPaint();
          previousSignal = undefined;
          const density = mode
            ? Math.min(2, next.state.deviceScaleFactor)
            : next.state.deviceScaleFactor;
          // Native compositor capture, never Page.captureScreenshot or a surface
          // resize. Limits downsample the real raster; they never upscale 1x
          // browsers launched before native high-density rendering was enabled.
          await connection.send("Page.startScreencast", {
            format: "jpeg",
            quality: mode ? 80 : 85,
            maxWidth: Math.ceil(next.state.width * density),
            maxHeight: Math.ceil(next.state.height * density),
            everyNthFrame: 1,
          });
          if (!stopped && cdp === connection) activeMode = mode;
        });
        return captureQueue;
      };
      const updateCapture = () => {
        if (!stopped && cdp && target) void configure(cdp, target).catch(fail);
      };
      const detach = async () => {
        clearPaint();
        const previous = cdp;
        cdp = undefined;
        activeMode = undefined;
        previousSignal = undefined;
        if (previous) {
          // A closed target has already stopped producing frames.
          await previous.send("Page.stopScreencast").catch(() => {});
          await previous.detach().catch(() => {});
        }
      };
      const syncState = (state: CloudBrowserState) => {
        if (stopped) return;
        if (JSON.stringify(stream!.state) !== JSON.stringify(state)) {
          stream!.state = state;
          broadcast("state", state);
        }
      };
      const syncCapture = async (next: Target) => {
        if (stopped) return;
        if (target?.page === next.page && target.state.revision === next.state.revision && cdp)
          return;
        await detach();
        if (stopped) return;
        target = next;
        stream!.frame = undefined;
        const connection = await next.page.context().newCDPSession(next.page);
        if (stopped) {
          await connection.detach();
          return;
        }
        cdp = connection;
        connection.on("Page.screencastFrame", (event) => {
          void connection
            .send("Page.screencastFrameAck", { sessionId: event.sessionId })
            .catch(() => {});
          if (stopped || connection !== cdp) return;
          // Never label pixels from a different compositor surface as this view.
          if (
            event.metadata.deviceWidth !== next.state.width ||
            event.metadata.deviceHeight !== next.state.height
          )
            return;
          if (event.data === previousSignal) return;
          previousSignal = event.data;
          const { pageId, revision, width, height } = next.state;
          latestFrame = { image: event.data, pageId, revision, width, height };
          if (frameTimer) return;
          const delay = 16 - (Date.now() - lastFrameAt);
          if (delay <= 0) flushFrame();
          else frameTimer = setTimeout(flushFrame, delay);
        });
        await configure(connection, next);
      };
      const refresh = async () => {
        const next = await this.browser.cloudCaptureTarget(id);
        if (stopped) return;
        if (target?.page !== next.page || target.state.revision !== next.state.revision || !cdp) {
          // Publish matching status before pixels from a new page/revision.
          const full = await this.browser.cloudTarget(id);
          syncState(full.state);
          await syncCapture(full);
          nextStatusAt = Date.now() + STATUS_POLL_MS;
        } else if (Date.now() >= nextStatusAt) {
          syncState(await this.browser.cloudState(id));
          nextStatusAt = Date.now() + STATUS_POLL_MS;
        }
      };
      const timer = setInterval(() => {
        if (pending || stopped) return;
        pending = refresh()
          .catch(fail)
          .finally(() => {
            pending = undefined;
          });
      }, CAPTURE_POLL_MS);
      timer.unref();
      stream = {
        subscribers,
        scrolling: (touchActive) => {
          if (stopped) return;
          if (touchActive !== undefined) touching = touchActive;
          if (!moving) {
            moving = true;
            updateCapture();
          }
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = undefined;
          // Keep the motion capture mode stable while a finger is held, then
          // through the fling. A pause in touchmove is not the end of a gesture.
          if (touching) return;
          idleTimer = setTimeout(
            () => {
              idleTimer = undefined;
              if (stopped) return;
              moving = false;
              updateCapture();
            },
            touchActive === false ? 1000 : 150,
          );
          idleTimer.unref();
        },
        stop: async () => {
          if (stopped) return;
          stopped = true;
          clearInterval(timer);
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = undefined;
          this.streams.delete(id);
          await detach();
        },
      };
      this.streams.set(id, stream);
      subscribers.add(subscriber);
      try {
        syncState(initial.state);
        await syncCapture(initial);
      } catch (error) {
        await stream.stop();
        throw error;
      }
    } else {
      if (stream.subscribers.size >= 4)
        throw Object.assign(new Error("Too many browser viewers."), { statusCode: 429 });
      stream.subscribers.add(subscriber);
      if (stream.state) subscriber("state", stream.state);
      if (stream.frame) subscriber("frame", stream.frame);
    }
    const current = stream;
    return () => {
      current.subscribers.delete(subscriber);
      if (!current.subscribers.size) void current.stop();
    };
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.streams.values()].map(async (stream) => {
        for (const subscriber of stream.subscribers)
          subscriber("browser-error", {
            error: "Browser viewer disconnected.",
            retryable: true,
          });
        await stream.stop();
      }),
    );
  }
}
