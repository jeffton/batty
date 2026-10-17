import type { CDPSession } from "patchright";
import type { BrowserService } from "./browser-service";
import type { CloudBrowserFrame, CloudBrowserState } from "@/shared/cloud-browser";

type Subscriber = (event: "frame" | "state" | "browser-error", data: unknown) => void;
type Target = Awaited<ReturnType<BrowserService["cloudTarget"]>>;

/** One producer per live browser; slow viewers drop frames in the HTTP transport. */
export class CloudBrowserStreams {
  private readonly streams = new Map<
    string,
    {
      subscribers: Set<Subscriber>;
      stop: () => Promise<void>;
      frame?: CloudBrowserFrame;
      state?: CloudBrowserState;
    }
  >();

  constructor(private readonly browser: BrowserService) {}

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
      let lastFrameAt = 0;
      let latestFrame: CloudBrowserFrame | undefined;
      let frameTimer: ReturnType<typeof setTimeout> | undefined;
      const broadcast = (event: Parameters<Subscriber>[0], value: unknown) => {
        for (const listener of subscribers) listener(event, value);
      };
      const flushFrame = () => {
        frameTimer = undefined;
        if (stopped || !latestFrame) return;
        const frame = latestFrame;
        latestFrame = undefined;
        lastFrameAt = Date.now();
        stream!.frame = frame;
        broadcast("frame", frame);
      };
      const detach = async () => {
        if (frameTimer) clearTimeout(frameTimer);
        frameTimer = undefined;
        latestFrame = undefined;
        lastFrameAt = 0;
        const previous = cdp;
        cdp = undefined;
        if (previous) {
          // A closed target has already stopped producing frames.
          await previous.send("Page.stopScreencast").catch(() => {});
          await previous.detach().catch(() => {});
        }
      };
      const sync = async (next: Target) => {
        if (stopped) return;
        if (JSON.stringify(stream!.state) !== JSON.stringify(next.state)) {
          stream!.state = next.state;
          broadcast("state", next.state);
        }
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
          // Bind pixels to the revision at screencast startup, never label an old
          // paint with a later agent interaction. A revision change restarts capture.
          const { pageId, revision, width, height } = next.state;
          latestFrame = { image: event.data, pageId, revision, width, height };
          if (frameTimer) return;
          const delay = 33 - (Date.now() - lastFrameAt);
          if (delay <= 0) flushFrame();
          else frameTimer = setTimeout(flushFrame, delay);
        });
        await connection.send("Page.startScreencast", {
          format: "jpeg",
          quality: 70,
          maxWidth: 1600,
          maxHeight: 1600,
          everyNthFrame: 1,
        });
      };
      const timer = setInterval(() => {
        if (pending || stopped) return;
        pending = this.browser
          .cloudTarget(id)
          .then(sync)
          .catch((error) => {
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
          })
          .finally(() => {
            pending = undefined;
          });
      }, 100);
      timer.unref();
      stream = {
        subscribers,
        stop: async () => {
          if (stopped) return;
          stopped = true;
          clearInterval(timer);
          this.streams.delete(id);
          await detach();
        },
      };
      this.streams.set(id, stream);
      subscribers.add(subscriber);
      try {
        await sync(initial);
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
