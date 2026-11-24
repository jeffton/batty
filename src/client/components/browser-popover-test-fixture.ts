import { flushPromises, mount } from "@vue/test-utils";

const rpcCallMock = vi.hoisted(() => vi.fn());
vi.mock("@/client/lib/rpc", () => ({ rpcCall: rpcCallMock }));
import { afterEach, beforeEach, vi } from "vite-plus/test";
import BrowserPopover from "./BrowserPopover.vue";

export const state = {
  pageId: "page-1",
  revision: "painted-revision",
  url: "https://example.org",
  title: "Example",
  width: 1280,
  height: 800,
  mobile: false,
  deviceScaleFactor: 1,
  pages: [],
};
export class FakeEvents {
  static instances: FakeEvents[] = [];
  static OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  closed = false;
  readonly url: string;
  sent: Array<Record<string, unknown>> = [];
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  private frameId = 0;
  constructor(url: string | URL) {
    this.url = String(url);
    FakeEvents.instances.push(this);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }
  send(type: string, data?: unknown): void {
    if (data === undefined) {
      this.sent.push(JSON.parse(type));
      return;
    }
    if (type === "frame") {
      const metadata = new TextEncoder().encode(
        JSON.stringify({
          codec: "avc1.42E01F",
          key: true,
          streamId: `stream-${(data as { revision: string }).revision}`,
          ...(data as object),
          frameId: ++this.frameId,
        }),
      );
      const packet = new Uint8Array(4 + metadata.length);
      new DataView(packet.buffer).setUint32(0, metadata.length);
      packet.set(metadata, 4);
      this.onmessage?.({ data: packet.buffer });
    } else this.onmessage?.({ data: JSON.stringify({ event: type, data }) });
  }
}
export class FakeDecoder {
  static instances: FakeDecoder[] = [];
  static holdNext = false;
  static async isConfigSupported() {
    return { supported: true };
  }
  state = "unconfigured";
  private hold = FakeDecoder.holdNext;
  constructor(readonly callbacks: VideoDecoderInit) {
    FakeDecoder.holdNext = false;
    FakeDecoder.instances.push(this);
  }
  configure() {
    this.state = "configured";
  }
  decode(chunk: EncodedVideoChunk) {
    if (!this.hold) this.emit(chunk.timestamp);
  }
  emit(timestamp: number) {
    this.callbacks.output({
      timestamp,
      displayWidth: 3840,
      displayHeight: 2400,
      close: vi.fn(),
    } as unknown as VideoFrame);
  }
  close() {
    this.state = "closed";
  }
}
export const rpcCall = rpcCallMock;
beforeEach(() => {
  FakeEvents.instances = [];
  vi.stubGlobal("WebSocket", FakeEvents);
  FakeDecoder.instances = [];
  FakeDecoder.holdNext = false;
  vi.stubGlobal("VideoDecoder", FakeDecoder);
  vi.stubGlobal(
    "EncodedVideoChunk",
    class {
      constructor(init: EncodedVideoChunkInit) {
        Object.assign(this, init);
      }
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    void Promise.resolve().then(() => callback(0));
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  rpcCall.mockResolvedValue({ value: state });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rpcCall.mockReset();
});
export function create() {
  return mount(BrowserPopover, {
    props: { popoverId: "browser-test", browserId: "opaque/id", title: "Cloud browser" },
    global: {
      stubs: {
        BasePopover: {
          template: "<div><slot /></div>",
          methods: { hidePopover() {} },
        },
        FullPopover: {
          name: "FullPopover",
          template: '<div><slot name="heading" /><slot /></div>',
        },
      },
    },
  });
}
export async function open(wrapper: ReturnType<typeof create>) {
  wrapper.getComponent({ name: "FullPopover" }).vm.$emit("toggle", { newState: "open" });
  await flushPromises();
  return FakeEvents.instances.at(-1)!;
}
export async function frame(
  wrapper: ReturnType<typeof create>,
  events: FakeEvents,
  revision = state.revision,
) {
  events.send("frame", { image: "ZmFrZQ==", pageId: "page-1", revision, width: 1280, height: 800 });
  await flushPromises();
  const image = wrapper.get("canvas").element;
  vi.spyOn(image, "getBoundingClientRect").mockReturnValue({
    left: 20,
    top: 50,
    width: 320,
    height: 200,
  } as DOMRect);
  Object.defineProperty(image, "setPointerCapture", { configurable: true, value: vi.fn() });
}
export function commands() {
  return rpcCall.mock.calls
    .filter(([operation]) => operation === "browser.control")
    .map(([, input]) => (input as { control: Record<string, unknown> }).control);
}
