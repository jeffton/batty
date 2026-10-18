import type { BrowserService } from "./browser-service";
import type { CloudBrowserFrame, CloudBrowserState } from "@/shared/cloud-browser";
import { encodeBrowserFrame } from "./cloud-browser-events";
import { startNativeBrowserVideo } from "./native-browser-video";

type Subscriber = (event: "frame" | "state" | "browser-error", data: unknown) => void;
type Target = Awaited<ReturnType<BrowserService["cloudTarget"]>>;
type Capture = { stop: () => Promise<void> };
export type NativeCaptureFactory = (
  target: Target,
  density: number,
  frame: (value: CloudBrowserFrame) => void,
  error: (value: Error) => void,
) => Promise<Capture>;

/** One native H.264 producer per browser. Viewer flow control respects GOP dependencies. */
export class CloudBrowserStreams {
  private readonly streams = new Map<
    string,
    {
      subscribers: Set<Subscriber>;
      stop: () => Promise<void>;
      scrolling: (touchActive?: boolean) => void;
      state?: CloudBrowserState;
    }
  >();
  private nextFrameId = 1;

  constructor(
    private readonly browser: BrowserService,
    private readonly createCapture?: NativeCaptureFactory,
  ) {}

  scrolling(id: string, touchActive?: boolean): void {
    this.streams.get(id)?.scrolling(touchActive);
  }

  async subscribe(id: string, subscriber: Subscriber): Promise<() => void> {
    const initial = await this.browser.cloudTarget(id);
    let stream = this.streams.get(id);
    if (!stream) {
      const subscribers = new Set<Subscriber>([subscriber]);
      let target: Target | undefined;
      let capture: Capture | undefined;
      let stopped = false;
      let epoch = 0;
      let nextStatusAt = Date.now() + 500;
      let refreshPending: Promise<void> | undefined;
      let captureQueue = Promise.resolve();
      let activeMode: boolean | undefined;
      let moving = false;
      let touching = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const broadcast = (event: Parameters<Subscriber>[0], value: unknown) => {
        for (const listener of subscribers) listener(event, value);
      };
      const fail = (error: unknown) => {
        if (stopped) return;
        const statusCode = (error as { statusCode?: number }).statusCode;
        const message = (error as Error).message;
        broadcast("browser-error", {
          error: message,
          statusCode,
          retryable:
            statusCode === undefined &&
            /Execution context was destroyed|Frame was detached|Cannot find context|Target closed|Session closed|has been closed/i.test(
              message,
            ),
        });
        void stream!.stop();
      };
      const configure = (next: Target, changed = false) => {
        captureQueue = captureQueue.then(async () => {
          if (stopped || (!changed && activeMode === moving)) return;
          const generation = ++epoch;
          const previous = capture;
          capture = undefined;
          await previous?.stop();
          if (stopped || generation !== epoch) return;
          const mode = moving;
          const density = mode
            ? Math.min(2, next.state.deviceScaleFactor)
            : next.state.deviceScaleFactor;
          const frame = (value: CloudBrowserFrame) => {
            if (!stopped && generation === epoch)
              broadcast("frame", encodeBrowserFrame(value, this.nextFrameId++));
          };
          const error = (value: Error) => {
            if (generation === epoch) fail(value);
          };
          let created: Capture;
          try {
            created = this.createCapture
              ? await this.createCapture(next, density, frame, error)
              : startNativeBrowserVideo(
                  await this.browser.cloudVideoGeometry(id, next.state),
                  next.state,
                  density,
                  frame,
                  error,
                );
          } catch (cause) {
            // A navigation/input revision can win while a capture setup waits for the session queue.
            // Discard that setup; the next poll observes the authoritative view.
            if ((cause as { statusCode?: number }).statusCode === 409) {
              target = undefined;
              activeMode = undefined;
              return;
            }
            throw cause;
          }
          if (stopped || generation !== epoch) {
            await created.stop();
            return;
          }
          capture = created;
          activeMode = mode;
        });
        return captureQueue;
      };
      const syncState = (state: CloudBrowserState) => {
        if (stopped) return;
        if (JSON.stringify(stream!.state) !== JSON.stringify(state)) {
          stream!.state = state;
          broadcast("state", state);
        }
      };
      const refresh = async () => {
        const next = await this.browser.cloudCaptureTarget(id);
        if (stopped) return;
        if (target?.page !== next.page || target.state.revision !== next.state.revision) {
          const full = await this.browser.cloudTarget(id);
          syncState(full.state);
          target = full;
          await configure(full, true);
          nextStatusAt = Date.now() + 500;
        } else if (Date.now() >= nextStatusAt) {
          syncState(await this.browser.cloudState(id));
          nextStatusAt = Date.now() + 500;
        }
      };
      const timer = setInterval(() => {
        if (refreshPending || stopped) return;
        refreshPending = refresh()
          .catch(fail)
          .finally(() => {
            refreshPending = undefined;
          });
      }, 100);
      timer.unref();
      stream = {
        subscribers,
        scrolling: (touchActive) => {
          if (stopped) return;
          if (touchActive !== undefined) touching = touchActive;
          if (!moving) {
            moving = true;
            if (target) void configure(target).catch(fail);
          }
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = undefined;
          if (touching) return;
          idleTimer = setTimeout(
            () => {
              idleTimer = undefined;
              if (stopped) return;
              moving = false;
              if (target) void configure(target).catch(fail);
            },
            touchActive === false ? 1000 : 150,
          );
          idleTimer.unref();
        },
        stop: async () => {
          if (stopped) return;
          stopped = true;
          epoch++;
          clearInterval(timer);
          if (idleTimer) clearTimeout(idleTimer);
          this.streams.delete(id);
          await capture?.stop();
          capture = undefined;
        },
      };
      this.streams.set(id, stream);
      try {
        target = initial;
        syncState(initial.state);
        await configure(initial, true);
      } catch (error) {
        await stream.stop();
        throw error;
      }
    } else {
      if (stream.subscribers.size >= 4)
        throw Object.assign(new Error("Too many browser viewers."), { statusCode: 429 });
      stream.subscribers.add(subscriber);
      if (stream.state) subscriber("state", stream.state);
      // A delta cannot initialize a decoder. The next periodic IDR starts this viewer.
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
          subscriber("browser-error", { error: "Browser viewer disconnected.", retryable: true });
        await stream.stop();
      }),
    );
  }
}
