import { socketFetch } from "./socket-fetch";

/** SSE framing over a multiplexed response. The session lifecycle owns retries/cursors. */
export class SocketEventSource {
  private readonly events = new EventTarget();
  readonly addEventListener = this.events.addEventListener.bind(this.events);
  readonly removeEventListener = this.events.removeEventListener.bind(this.events);
  readonly dispatchEvent = this.events.dispatchEvent.bind(this.events);
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = SocketEventSource.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  private readonly controller = new AbortController();
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  constructor(readonly url: string) {
    void this.read();
  }

  close(): void {
    this.readyState = SocketEventSource.CLOSED;
    this.controller.abort();
    void this.reader?.cancel().catch(() => {});
  }

  private async read(): Promise<void> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await socketFetch(this.url, {
        headers: { Accept: "text/event-stream" },
        signal: this.controller.signal,
      });
      if (!response.ok) throw new Error(`Session stream: HTTP ${response.status}`);
      this.controller.signal.throwIfAborted();
      reader = response.body!.getReader();
      this.reader = reader;
      this.readyState = SocketEventSource.OPEN;
      const opened = new Event("open");
      this.dispatchEvent(opened);
      this.onopen?.(opened);
      const decoder = new TextDecoder();
      let buffer = "";
      let data: string[] = [];
      let type = "message";
      let lastEventId = "";
      let skipLF = false;
      const line = (value: string) => {
        if (!value) {
          if (data.length && !this.controller.signal.aborted) {
            const message = new MessageEvent(type, { data: data.join("\n"), lastEventId });
            this.dispatchEvent(message);
            if (type === "message") this.onmessage?.(message);
          }
          data = [];
          type = "message";
          return;
        }
        const colon = value.indexOf(":");
        const field = colon < 0 ? value : value.slice(0, colon);
        const content = colon < 0 ? "" : value.slice(colon + 1).replace(/^ /, "");
        if (field === "data") data.push(content);
        else if (field === "event") type = content || "message";
        else if (field === "id" && !content.includes("\0")) lastEventId = content;
      };
      while (!this.controller.signal.aborted) {
        const chunk = await reader.read();
        const text = decoder.decode(chunk.value, { stream: !chunk.done });
        for (const character of text) {
          if (skipLF && character === "\n") {
            skipLF = false;
            continue;
          }
          skipLF = character === "\r";
          if (character === "\r" || character === "\n") {
            line(buffer);
            buffer = "";
          } else buffer += character;
        }
        if (chunk.done) throw new Error("Session stream disconnected");
      }
    } catch {
      if (!this.controller.signal.aborted) {
        this.readyState = SocketEventSource.CLOSED;
        const error = new Event("error");
        this.dispatchEvent(error);
        this.onerror?.(error);
      }
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      this.reader = undefined;
    }
  }
}
