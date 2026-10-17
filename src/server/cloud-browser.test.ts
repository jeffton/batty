// @vitest-environment node
import { expect, test, vi } from "vite-plus/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once, EventEmitter } from "node:events";
import {
  createCloudBrowserSocketWriter,
  encodeBrowserFrame,
  type BrowserFramePacket,
} from "./cloud-browser-events";
import fastify from "fastify";
import { BrowserService } from "./browser-service";
import { CloudBrowserStreams } from "./cloud-browser-stream";
import { registerCloudBrowserRoutes } from "./routes/cloud-browser";
import type { CloudBrowserFrame } from "@/shared/cloud-browser";
import { artifactRefs, mergeResponseArtifacts } from "./artifact-forwarding";

function decodePacket(value: unknown): CloudBrowserFrame & { frameId: number } {
  const { packet } = value as BrowserFramePacket;
  const end = 4 + packet.readUInt32BE(0);
  return {
    ...JSON.parse(packet.subarray(4, end).toString()),
    image: packet.subarray(end).toString("base64"),
  };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-cloud-browser-"));
  const website = http.createServer((_, response) =>
    response.end(`<!doctype html>
    <html><head><title>Shared browser</title></head><body style="margin:0;height:3000px">
    <button style="width:160px;height:60px" onclick="window.clicks=(window.clicks||0)+1">Click</button>
    <input style="display:block;width:200px;height:40px" id="text">
    <input id="other"><a href="/next">Next</a></body></html>`),
  );
  website.listen(0, "127.0.0.1");
  await once(website, "listening");
  const url = `http://127.0.0.1:${(website.address() as { port: number }).port}/`;
  const service = new BrowserService(undefined, 4, root);
  return {
    root,
    url,
    service,
    async close() {
      await service.closeSession("shared");
      await service.dispose();
      website.closeAllConnections();
      await new Promise<void>((resolve) => website.close(() => resolve()));
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test("cloud attachment shares agent state and controls, survives detach, and cannot resurrect expired handles", async () => {
  const f = await fixture();
  let service = f.service;
  try {
    await service.execute("shared", { action: "open", url: f.url });
    await expect(service.execute("shared", { action: "attach" })).rejects.toThrow("cloud=true");
    const attached = await service.execute("shared", { action: "attach", cloud: true });
    const site = attached.details.sites![0]!;
    const id = site.browserId!;
    expect(site.public).toBe(false);
    expect((await service.execute("shared", { action: "attach" })).details.sites).toEqual([site]);
    // Existing generic artifacts keep the live handle intact when forwarded.
    expect(mergeResponseArtifacts({ sites: [site] }).sites![0]!.browserId).toBe(id);
    expect(artifactRefs({ sites: [site] })[0]!.ref).toMatch(/^browser:/);
    let state = await service.cloudState(id);
    await service.cloudControl(id, { action: "click", ...state, x: 40, y: 30 });
    expect(
      (await service.execute("shared", { action: "evaluate", script: "window.clicks" })).text,
    ).toContain("1");
    await service.execute("shared", { action: "click", selector: "#text" });
    state = await service.cloudState(id);
    await service.cloudControl(id, { action: "text", ...state, text: "iPhone æøå" });
    expect(
      (
        await service.execute("shared", {
          action: "evaluate",
          script: "document.querySelector('#text').value",
        })
      ).text,
    ).toContain("iPhone æøå");
    state = await service.cloudState(id);
    const inputId = state.focused!.id;
    await service.cloudControl(id, {
      action: "fill-focused",
      ...state,
      focusId: inputId,
      value: "",
    });
    expect((await service.cloudState(id)).focused!.value).toBe("");
    await service.cloudControl(id, {
      action: "fill-focused",
      ...state,
      focusId: inputId,
      value: "iPhone æøå",
    });
    // A second viewer/page script may change focus without changing the agent revision.
    const target = await service.cloudTarget(id);
    await target.page.locator("#other").click();
    await expect(
      service.cloudControl(id, {
        action: "fill-focused",
        ...state,
        focusId: inputId,
        value: "wrong field",
      }),
    ).rejects.toThrow("focused field changed");
    await expect(
      service.cloudControl(id, { action: "key", ...state, focusId: inputId, key: "Enter" }),
    ).rejects.toThrow("focused field changed");
    await target.page.locator("#text").click();
    const beforeFocusChange = await service.cloudState(id);
    await service.execute("shared", { action: "click", selector: "#other" });
    await expect(
      service.cloudControl(id, { action: "text", ...beforeFocusChange, text: "wrong field" }),
    ).rejects.toThrow("view changed");
    expect(
      (
        await service.execute("shared", {
          action: "evaluate",
          script: "document.querySelector('#other').value",
        })
      ).text,
    ).not.toContain("wrong field");
    await service.cloudControl(id, { action: "viewport", width: 390, height: 640, mobile: false });
    await expect(
      service.cloudControl(id, { action: "click", ...state, x: 40, y: 30 }),
    ).rejects.toThrow("view changed");
    state = await service.cloudState(id);
    await service.cloudControl(id, {
      action: "scroll",
      ...state,
      x: 200,
      y: 300,
      deltaX: 0,
      deltaY: 300,
    });
    // Continuous viewer scroll does not invalidate its painted revision/restart capture.
    expect((await service.cloudState(id)).revision).toBe(state.revision);
    await service.cloudControl(id, {
      action: "scroll",
      ...state,
      x: 200,
      y: 300,
      deltaX: 0,
      deltaY: 100,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      (await service.execute("shared", { action: "evaluate", script: "window.scrollY" })).text,
    ).not.toContain("result:\n0");
    const second = await service.execute("shared", { action: "open", url: f.url, newPage: true });
    await expect(
      service.cloudControl(id, { action: "text", ...state, text: "stale" }),
    ).rejects.toThrow("view changed");
    await service.cloudControl(id, { action: "switch", pageId: state.pageId });
    expect((await service.cloudState(id)).pages).toHaveLength(2);
    await service.cloudControl(id, { action: "close-page", pageId: second.details.pageId! });
    const busy = service.execute("shared", {
      action: "evaluate",
      script: "new Promise(resolve => setTimeout(resolve, 200))",
    });
    await expect(service.cloudControl(id, { action: "reload" })).rejects.toThrow("busy");
    await busy;
    await service.dispose();
    service = new BrowserService(undefined, 4, f.root);
    expect((await service.cloudState(id)).pageId).toBe(state.pageId);
    expect(
      (
        await service.execute("shared", {
          action: "evaluate",
          script: "document.querySelector('#text').value",
        })
      ).text,
    ).toContain("iPhone æøå");
    await service.execute("shared", { action: "close" });
    await expect(service.cloudState(id)).rejects.toThrow("session ended");
    await service.execute("shared", { action: "open", url: f.url, cloud: true });
    expect(
      (await service.execute("shared", { action: "attach" })).details.sites![0]!.browserId,
    ).not.toBe(id);
    await expect(service.cloudState(id)).rejects.toThrow("session ended");
  } finally {
    await service.closeSession("shared");
    await service.dispose();
    await f.close();
  }
}, 30_000);

test("mobile emulation survives service reconnect without replacing the page or login", async () => {
  const f = await fixture();
  let service = f.service;
  try {
    const opened = await service.execute("shared", { action: "open", url: f.url, cloud: true });
    const attached = await service.execute("shared", { action: "attach" });
    expect(opened.details.sites).toEqual(attached.details.sites);
    const id = attached.details.sites![0]!.browserId!;
    const before = await service.cloudTarget(id);
    await before.page.evaluate(() => {
      document.cookie = "login=retained";
      localStorage.setItem("login", "retained");
    });
    await service.cloudControl(id, { action: "viewport", width: 358, height: 757, mobile: true });
    const target = await service.cloudTarget(id);
    expect(target.page).toBe(before.page);
    expect(
      await target.page.evaluate(() => [
        screen.width,
        screen.height,
        navigator.maxTouchPoints,
        navigator.userAgent.includes("Mobile"),
      ]),
    ).toEqual([358, 757, 1, true]);
    await service.dispose();
    service = new BrowserService(undefined, 4, f.root);
    const restored = await service.cloudTarget(id);
    expect(restored.state.pageId).toBe(before.state.pageId);
    expect(restored.state.mobile).toBe(true);
    expect(
      await restored.page.evaluate(() => [
        screen.width,
        navigator.maxTouchPoints,
        navigator.userAgent.includes("Mobile"),
        document.cookie,
        localStorage.getItem("login"),
      ]),
    ).toEqual([358, 1, true, "login=retained", "retained"]);
    await service.cloudControl(id, { action: "viewport", width: 1200, height: 850, mobile: false });
    expect(
      await restored.page.evaluate(() => [
        innerWidth,
        screen.width,
        navigator.maxTouchPoints,
        navigator.userAgent.includes("Mobile"),
        localStorage.getItem("login"),
      ]),
    ).toEqual([1200, 1200, 0, false, "retained"]);
  } finally {
    await service.closeSession("shared");
    await service.dispose();
    await f.close();
  }
}, 30_000);

test("cloud stream delivers real JPEG frames to multiple viewers without closing the agent browser", async () => {
  const f = await fixture();
  const streams = new CloudBrowserStreams(f.service);
  try {
    await f.service.execute("shared", { action: "open", url: f.url, cloud: true });
    const id = (await f.service.execute("shared", { action: "attach" })).details.sites![0]!
      .browserId!;
    let receive!: (frame: CloudBrowserFrame) => void;
    const frame = new Promise<CloudBrowserFrame>((resolve) => {
      receive = resolve;
    });
    const stop = await streams.subscribe(id, (event, data) => {
      if (event === "frame") receive(decodePacket(data));
    });
    const first = await frame;
    expect(Buffer.from(first.image, "base64").subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(first.width).toBe(390);
    let second: CloudBrowserFrame | undefined;
    const stopSecond = await streams.subscribe(id, (event, data) => {
      if (event === "frame") second = decodePacket(data);
    });
    expect(second?.revision).toBe(first.revision);
    stop();
    stopSecond();
    expect((await f.service.execute("shared", { action: "snapshot" })).text).toContain(
      "Shared browser",
    );
    await streams.close();
    expect(await f.service.hasSession("shared")).toBe(true);
  } finally {
    await streams.close();
    await f.close();
  }
}, 30_000);

test("cloud routes require auth, same-origin control and bounded allowlisted commands", async () => {
  const f = await fixture();
  const app = fastify();
  app.addHook("onRequest", async (request, reply) => {
    if (request.headers.authorization !== "test")
      return reply.code(401).send({ error: "Authentication required" });
  });
  const closeStreams = await registerCloudBrowserRoutes(app, f.service, "https://batty.example");
  try {
    await f.service.execute("shared", { action: "open", url: f.url, cloud: true });
    const id = (await f.service.execute("shared", { action: "attach" })).details.sites![0]!
      .browserId!;
    const endpoint = `/api/cloud-browser/${id}`;
    expect((await app.inject(`${endpoint}/state`)).statusCode).toBe(401);
    expect((await app.inject(`${endpoint}/socket`)).statusCode).toBe(401);
    const control = (payload: Record<string, unknown>, origin = "https://batty.example") =>
      app.inject({
        method: "POST",
        url: `${endpoint}/control`,
        payload,
        headers: { authorization: "test", origin },
      });
    expect((await control({ action: "reload" }, "https://attacker.example")).statusCode).toBe(403);
    expect((await control({ action: "evaluate", script: "steal()" })).statusCode).toBe(400);
    expect((await control({ action: "reload", script: "steal()" })).statusCode).toBe(400);
    expect(
      (await control({ action: "viewport", width: 20_000, height: 640, mobile: false })).statusCode,
    ).toBe(400);
    const state = (
      await app.inject({ url: `${endpoint}/state`, headers: { authorization: "test" } })
    ).json();
    expect(
      (
        await control({
          action: "click",
          pageId: state.pageId,
          revision: state.revision,
          x: 40,
          y: 30,
        })
      ).statusCode,
    ).toBe(200);
    let next = await f.service.cloudState(id);
    expect(
      (
        await control({
          action: "scroll",
          pageId: next.pageId,
          revision: next.revision,
          x: 100,
          y: 200,
          deltaX: 0,
          deltaY: 300,
        })
      ).statusCode,
    ).toBe(200);
    next = await f.service.cloudState(id);
    expect(
      (
        await control({
          action: "text",
          pageId: next.pageId,
          revision: next.revision,
          text: "valid",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await control({
          action: "key",
          pageId: next.pageId,
          revision: next.revision,
          key: "Control+L",
        })
      ).statusCode,
    ).toBe(400);
    await f.service.closeSession("shared");
    expect(
      (await app.inject({ url: `${endpoint}/state`, headers: { authorization: "test" } }))
        .statusCode,
    ).toBe(410);
  } finally {
    await closeStreams();
    await app.close();
    await f.close();
  }
}, 30_000);

test("relative app base paths derive the control origin from the trusted HTTPS request", async () => {
  const app = fastify({ trustProxy: ["127.0.0.1"] });
  const closeStreams = await registerCloudBrowserRoutes(
    app,
    {
      cloudControl: async () => ({ ok: true }),
    } as unknown as BrowserService,
    "/",
  );
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/cloud-browser/test/control",
      payload: { action: "reload" },
      headers: {
        host: "batty.example",
        "x-forwarded-proto": "https",
        origin: "https://batty.example",
      },
    });
    expect(response.statusCode).toBe(200);
  } finally {
    await closeStreams();
    await app.close();
  }
});

test("screencast throttling delivers the latest final paint even without subsequent animation", async () => {
  const connection = new EventEmitter() as EventEmitter & {
    send: () => Promise<void>;
    detach: () => Promise<void>;
  };
  connection.send = async () => {};
  connection.detach = async () => {};
  const page = { context: () => ({ newCDPSession: async () => connection }) };
  const state = {
    pageId: "p",
    revision: "r",
    width: 390,
    height: 640,
    deviceScaleFactor: 1,
    url: "https://example.com",
    title: "",
    pages: [],
  };
  const streams = new CloudBrowserStreams({
    cloudTarget: async () => ({ page, state }),
  } as unknown as BrowserService);
  const frames: CloudBrowserFrame[] = [];
  try {
    const stop = await streams.subscribe("id", (event, value) => {
      if (event === "frame") frames.push(decodePacket(value));
    });
    connection.emit("Page.screencastFrame", {
      sessionId: 1,
      data: Buffer.from("first").toString("base64"),
    });
    connection.emit("Page.screencastFrame", {
      sessionId: 2,
      data: Buffer.from("intermediate").toString("base64"),
    });
    connection.emit("Page.screencastFrame", {
      sessionId: 3,
      data: Buffer.from("final").toString("base64"),
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(frames.map((frame) => Buffer.from(frame.image, "base64").toString())).toEqual([
      "first",
      "final",
    ]);
    stop();
  } finally {
    await streams.close();
  }
});

test("capture uses 2x JPEG80 during scrolling and restores native sharp final paint after idle, including revised viewports", async () => {
  vi.useFakeTimers();
  let state = {
    pageId: "p",
    revision: "r",
    width: 358,
    height: 757,
    deviceScaleFactor: 3,
    mobile: true,
    url: "https://example.com",
    title: "",
    pages: [],
  };
  const starts: Array<Record<string, number>> = [];
  const page = {
    context: () => ({
      newCDPSession: async () => {
        const connection = Object.assign(new EventEmitter(), {
          send: async (method: string, parameters: Record<string, number>) => {
            if (method === "Page.startScreencast") {
              starts.push(parameters);
              connection.emit("Page.screencastFrame", {
                sessionId: starts.length,
                data: Buffer.from(`paint-${starts.length}`).toString("base64"),
              });
            }
          },
          detach: async () => {},
        });
        return connection;
      },
    }),
  };
  const streams = new CloudBrowserStreams({
    cloudTarget: async () => ({ page, state }),
  } as unknown as BrowserService);
  const frames: CloudBrowserFrame[] = [];
  try {
    const stop = await streams.subscribe("id", (event, value) => {
      if (event === "frame") frames.push(decodePacket(value));
    });
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ quality: 85, maxWidth: 1074, maxHeight: 2271 });
    streams.scrolling("id");
    await vi.advanceTimersByTimeAsync(60);
    expect(starts[1]).toMatchObject({ quality: 80, maxWidth: 716, maxHeight: 1514 });
    await vi.advanceTimersByTimeAsync(40);
    streams.scrolling("id");
    await vi.advanceTimersByTimeAsync(100);
    expect(starts).toHaveLength(2); // Repeated wheel events debounce idle, not restart capture.
    state = { ...state, revision: "rotated", width: 757, height: 358 };
    streams.scrolling("id");
    await vi.advanceTimersByTimeAsync(100);
    expect(starts[2]).toMatchObject({ quality: 80, maxWidth: 1514, maxHeight: 716 });
    await vi.advanceTimersByTimeAsync(50);
    expect(starts).toHaveLength(4);
    expect(starts[3]).toMatchObject({ quality: 85, maxWidth: 2271, maxHeight: 1074 });
    expect(frames.at(-1)).toMatchObject({
      revision: "rotated",
      width: 757,
      height: 358,
      image: Buffer.from("paint-4").toString("base64"),
    });
    stop();
    streams.scrolling("id");
    await vi.advanceTimersByTimeAsync(1000);
    expect(starts).toHaveLength(4);
  } finally {
    await streams.close();
    vi.useRealTimers();
  }
});

test("stopped streams cannot be restarted by a pending motion capture or idle callback", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const starts = vi.fn();
  const connection = Object.assign(new EventEmitter(), {
    send: async (method: string) => {
      if (method === "Page.startScreencast") starts();
      if (method === "Page.stopScreencast") await blocked;
    },
    detach: async () => {},
  });
  const state = { pageId: "p", revision: "r", width: 358, height: 757, deviceScaleFactor: 3 };
  const page = { context: () => ({ newCDPSession: async () => connection }) };
  const streams = new CloudBrowserStreams({
    cloudTarget: async () => ({ page, state }),
  } as unknown as BrowserService);
  try {
    const stop = await streams.subscribe("id", () => {});
    streams.scrolling("id");
    await vi.advanceTimersByTimeAsync(60);
    stop();
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(starts).toHaveBeenCalledTimes(1);
  } finally {
    release();
    await streams.close();
    vi.useRealTimers();
  }
});

test("stream failures distinguish navigation interruption, permanent expiry and service disconnect", async () => {
  const connection = new EventEmitter() as EventEmitter & {
    send: () => Promise<void>;
    detach: () => Promise<void>;
  };
  connection.send = async () => {};
  connection.detach = async () => {};
  const page = { context: () => ({ newCDPSession: async () => connection }) };
  const state = {
    pageId: "p",
    revision: "r",
    width: 390,
    height: 640,
    mobile: true,
    deviceScaleFactor: 1,
    url: "https://example.com",
    title: "",
    pages: [],
  };
  let failure: Error | undefined;
  const streams = new CloudBrowserStreams({
    cloudTarget: async () => {
      if (failure) throw failure;
      return { page, state };
    },
  } as unknown as BrowserService);
  const errors: Array<{ retryable: boolean; statusCode?: number }> = [];
  const listener = (event: string, data: unknown) => {
    if (event === "browser-error") errors.push(data as (typeof errors)[number]);
  };
  try {
    const first = await streams.subscribe("id", listener);
    failure = new Error("Execution context was destroyed, most likely because of a navigation");
    await expect.poll(() => errors.length).toBe(1);
    expect(errors[0]!.retryable).toBe(true);
    first();
    failure = undefined;
    const second = await streams.subscribe("id", listener);
    await streams.close();
    expect(errors[1]!.retryable).toBe(true);
    second();
    const third = await streams.subscribe("id", listener);
    failure = Object.assign(new Error("Browser session ended."), { statusCode: 410 });
    await expect.poll(() => errors.length).toBe(3);
    expect(errors[2]).toMatchObject({ retryable: false, statusCode: 410 });
    third();
  } finally {
    await streams.close();
  }
});

test("binary packet retains exact JPEG bytes and CSS dimensions", () => {
  const frame = {
    image: Buffer.from([255, 216, 1, 255, 217]).toString("base64"),
    pageId: "p",
    revision: "r",
    width: 390,
    height: 640,
  };
  expect(decodePacket(encodeBrowserFrame(frame, 42))).toEqual({ ...frame, frameId: 42 });
});

test("slow viewers keep two unacknowledged paints and the final latest paint, with bounded socket writes", () => {
  const writes: Array<string | Buffer> = [];
  const callbacks: Array<(error?: Error) => void> = [];
  const socket = {
    readyState: 1,
    send(value: string | Buffer, _options: unknown, callback: (error?: Error) => void) {
      writes.push(value);
      callbacks.push(callback);
    },
    close: vi.fn(),
    terminate: vi.fn(),
  };
  const writer = createCloudBrowserSocketWriter(
    socket as unknown as Parameters<typeof createCloudBrowserSocketWriter>[0],
  );
  const paint = (frameId: number) =>
    encodeBrowserFrame(
      { image: "//g=", pageId: "p", revision: "r", width: 390, height: 640 },
      frameId,
    );
  writer.send("frame", paint(1));
  writer.send("state", { pageId: "old" });
  writer.send("state", { pageId: "new" });
  writer.send("frame", paint(2));
  expect(writes).toHaveLength(1);
  callbacks.shift()!(); // First socket write completed, latest state wins.
  expect(JSON.parse(writes[1] as string)).toEqual({ event: "state", data: { pageId: "new" } });
  callbacks.shift()!();
  callbacks.shift()!();
  for (let i = 3; i <= 100; i++) writer.send("frame", paint(i));
  expect(writes).toHaveLength(3);
  expect(() => writer.acknowledge(99)).toThrow("Invalid browser frame acknowledgement");
  writer.acknowledge(1);
  expect(decodePacket({ packet: writes[3] }).frameId).toBe(100);
  callbacks.shift()!();
  expect(() => writer.acknowledge(1)).toThrow("Invalid browser frame acknowledgement");
  writer.close();
  writer.send("frame", paint(101));
  expect(writes).toHaveLength(4);
});

test("scroll drain fences have priority over paints and cannot replace a queued fence", () => {
  const writes: Array<string | Buffer> = [];
  const callbacks: Array<(error?: Error) => void> = [];
  const socket = {
    readyState: 1,
    send(value: string | Buffer, _options: unknown, callback: (error?: Error) => void) {
      writes.push(value);
      callbacks.push(callback);
    },
    close: vi.fn(),
    terminate: vi.fn(),
  };
  const writer = createCloudBrowserSocketWriter(
    socket as unknown as Parameters<typeof createCloudBrowserSocketWriter>[0],
  );
  const sent = vi.fn();
  writer.send(
    "frame",
    encodeBrowserFrame({ image: "//g=", pageId: "p", revision: "r", width: 390, height: 640 }, 1),
  );
  writer.send("state", { pageId: "p" });
  writer.send("scroll-drained", { requestId: 1 }, sent);
  expect(() => writer.send("scroll-drained", { requestId: 2 })).toThrow("already pending");
  writer.send("scroll-error", { error: "Rejected scroll.", statusCode: 409 });
  callbacks.shift()!();
  expect(JSON.parse(writes[1] as string).event).toBe("scroll-error");
  callbacks.shift()!();
  expect(JSON.parse(writes[2] as string)).toEqual({
    event: "scroll-drained",
    data: { requestId: 1 },
  });
  expect(sent).not.toHaveBeenCalled();
  callbacks.shift()!();
  expect(sent).toHaveBeenCalledOnce();
  expect(JSON.parse(writes[3] as string).event).toBe("state");
  writer.close();
});

test("WebSocket upgrades enforce ordinary auth, same origin and permanent browser expiry", async () => {
  const app = fastify();
  let expired = false;
  const target = vi.fn(async () => {
    if (expired) throw Object.assign(new Error("Browser session ended."), { statusCode: 410 });
    return {};
  });
  app.addHook("onRequest", async (request, reply) => {
    if (request.headers.authorization !== "test")
      return reply.code(401).send({ error: "Authentication required" });
  });
  const close = await registerCloudBrowserRoutes(
    app,
    { cloudTarget: target } as unknown as BrowserService,
    "https://batty.example",
  );
  await app.ready();
  try {
    await expect(
      app.injectWS("/api/cloud-browser/id/socket", {
        headers: { origin: "https://batty.example" },
      }),
    ).rejects.toThrow("401");
    await expect(
      app.injectWS("/api/cloud-browser/id/socket", {
        headers: { authorization: "test", origin: "https://attacker.example" },
      }),
    ).rejects.toThrow("403");
    expect(target).not.toHaveBeenCalled();
    expired = true;
    await expect(
      app.injectWS("/api/cloud-browser/id/socket", {
        headers: { authorization: "test", origin: "https://batty.example" },
      }),
    ).rejects.toThrow("410");
  } finally {
    await close();
    await app.close();
  }
});

test("WebSocket scroll coalesces pending deltas and preserves its anchor without state round trips", async () => {
  const app = fastify();
  const connection = Object.assign(new EventEmitter(), {
    send: async () => {},
    detach: async () => {},
  });
  const page = { context: () => ({ newCDPSession: async () => connection }) };
  const state = {
    pageId: "p",
    revision: "r",
    width: 390,
    height: 640,
    deviceScaleFactor: 3,
    mobile: true,
    pages: [],
  };
  let release!: () => void;
  const scroll = vi.fn(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const close = await registerCloudBrowserRoutes(
    app,
    {
      cloudTarget: async () => ({ page, state }),
      cloudScroll: scroll,
    } as unknown as BrowserService,
    "https://batty.example",
  );
  await app.ready();
  const socket = await app.injectWS("/api/cloud-browser/id/socket", {
    headers: { origin: "https://batty.example" },
  });
  const messages: Array<{ event: string; data: unknown }> = [];
  socket.on("message", (data, binary) => {
    if (!binary) messages.push(JSON.parse(data.toString()));
  });
  try {
    const command = {
      action: "scroll",
      pageId: "p",
      revision: "r",
      x: 10,
      y: 20,
      deltaX: 1,
      deltaY: 10,
    };
    socket.send(JSON.stringify(command));
    await expect.poll(() => scroll.mock.calls.length).toBe(1);
    socket.send(JSON.stringify({ ...command, x: 30, deltaY: 20 }));
    socket.send(JSON.stringify({ ...command, x: 30, deltaY: 30 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await expect.poll(() => scroll.mock.calls.length).toBe(2);
    expect(scroll.mock.calls[1]).toEqual(["id", { ...command, x: 30, deltaX: 2, deltaY: 50 }]);
    release();
    scroll.mockImplementationOnce(async () => {
      throw Object.assign(new Error("The browser view changed."), { statusCode: 409 });
    });
    socket.send(JSON.stringify(command));
    await expect
      .poll(() => messages.some((message) => message.event === "scroll-error"))
      .toBe(true);
    expect(socket.readyState).toBe(1);
    socket.send(JSON.stringify({ action: "ack", frameId: 999 }));
    await expect
      .poll(() => messages.some((message) => message.event === "browser-error"))
      .toBe(true);
  } finally {
    socket.terminate();
    await close();
    await app.close();
  }
});

async function scrollSocketFixture(
  cloudScroll: BrowserService["cloudScroll"],
  onControl = () => {},
) {
  const app = fastify();
  const connection = Object.assign(new EventEmitter(), {
    send: async () => {},
    detach: async () => {},
  });
  const page = { context: () => ({ newCDPSession: async () => connection }) };
  const state = {
    pageId: "p",
    revision: "r",
    width: 390,
    height: 640,
    deviceScaleFactor: 3,
    mobile: true,
    pages: [],
  };
  const closeStreams = await registerCloudBrowserRoutes(
    app,
    {
      cloudTarget: async () => ({ page, state }),
      cloudScroll,
      cloudControl: async () => {
        onControl();
        return state;
      },
    } as unknown as BrowserService,
    "https://batty.example",
  );
  await app.ready();
  const socket = await app.injectWS("/api/cloud-browser/id/socket", {
    headers: { origin: "https://batty.example" },
  });
  const messages: Array<{ event: string; data: { requestId?: number; statusCode?: number } }> = [];
  socket.on("message", (data, binary) => {
    if (!binary) messages.push(JSON.parse(data.toString()));
  });
  return {
    app,
    socket,
    messages,
    send: (value: unknown) => socket.send(JSON.stringify(value)),
    async close() {
      socket.terminate();
      await closeStreams();
      await app.close();
    },
  };
}

const wheelCommand = {
  action: "scroll",
  pageId: "p",
  revision: "r",
  x: 10,
  y: 20,
  deltaX: 0,
  deltaY: 10,
} as const;

test("distinct scroll anchors stay FIFO and a fence drains all earlier input before HTTP control", async () => {
  const order: string[] = [];
  const releases: Array<() => void> = [];
  const scroll = vi.fn<BrowserService["cloudScroll"]>(async (_id, command) => {
    await new Promise<void>((resolve) => {
      releases.push(resolve);
    });
    order.push(`scroll:${command.x}`);
  });
  const f = await scrollSocketFixture(scroll, () => {
    order.push("click");
  });
  try {
    f.send(wheelCommand);
    await expect.poll(() => scroll.mock.calls.length).toBe(1);
    f.send({ ...wheelCommand, x: 20 });
    f.send({ ...wheelCommand, x: 30 });
    f.send({ ...wheelCommand, x: 40 }); // Active + two pending anchor groups is the bound.
    f.send({ action: "flush", requestId: 1 });
    await expect
      .poll(() =>
        f.messages.some((event) => event.event === "scroll-error" && event.data.statusCode === 409),
      )
      .toBe(true);
    expect(f.messages.filter((event) => event.event === "scroll-drained")).toEqual([]);
    releases.shift()!();
    await expect.poll(() => scroll.mock.calls.length).toBe(2);
    expect(scroll.mock.calls[1]![1].x).toBe(20);
    expect(f.messages.filter((event) => event.event === "scroll-drained")).toEqual([]);
    releases.shift()!();
    await expect.poll(() => scroll.mock.calls.length).toBe(3);
    expect(scroll.mock.calls[2]![1].x).toBe(30);
    expect(f.messages.filter((event) => event.event === "scroll-drained")).toEqual([]);
    releases.shift()!();
    await expect
      .poll(() => f.messages.filter((event) => event.event === "scroll-drained"))
      .toEqual([{ event: "scroll-drained", data: { requestId: 1 } }]);
    const response = await f.app.inject({
      method: "POST",
      url: "/api/cloud-browser/id/control",
      headers: { origin: "https://batty.example" },
      payload: { action: "click", pageId: "p", revision: "r", x: 50, y: 50 },
    });
    expect(response.statusCode).toBe(200);
    expect(order).toEqual(["scroll:10", "scroll:20", "scroll:30", "click"]);
    f.send({ action: "flush", requestId: 2 });
    await expect
      .poll(() =>
        f.messages.some((event) => event.event === "scroll-drained" && event.data.requestId === 2),
      )
      .toBe(true);
    scroll.mockImplementationOnce(async () => {
      throw Object.assign(new Error("Stale scroll rejected."), { statusCode: 409 });
    });
    f.send(wheelCommand);
    f.send({ action: "flush", requestId: 3 });
    await expect
      .poll(() =>
        f.messages.some((event) => event.event === "scroll-drained" && event.data.requestId === 3),
      )
      .toBe(true);
    const fenceIndex = f.messages.findIndex(
      (event) => event.event === "scroll-drained" && event.data.requestId === 3,
    );
    expect(f.messages[fenceIndex - 1]!.event).toBe("scroll-error");
    f.send({ action: "flush", requestId: 3 }); // Reusing an already completed fence is invalid too.
    await expect.poll(() => f.messages.some((event) => event.event === "browser-error")).toBe(true);
    expect(
      f.messages.filter((event) => event.event === "scroll-drained" && event.data.requestId === 3),
    ).toHaveLength(1);
  } finally {
    releases.forEach((release) => release());
    await f.close();
  }
});

test.each([1, 2])(
  "a second pending flush (%i) cannot replace or falsely acknowledge an active fence",
  async (requestId) => {
    let release!: () => void;
    const scroll = vi.fn<BrowserService["cloudScroll"]>(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const f = await scrollSocketFixture(scroll);
    try {
      f.send(wheelCommand);
      await expect.poll(() => scroll.mock.calls.length).toBe(1);
      f.send({ action: "flush", requestId: 1 });
      f.send({ action: "flush", requestId });
      await expect
        .poll(() => f.messages.some((event) => event.event === "browser-error"))
        .toBe(true);
      expect(f.messages.some((event) => event.event === "scroll-drained")).toBe(false);
      release();
    } finally {
      release?.();
      await f.close();
    }
  },
);

test("live WebSocket viewers close at ten minutes to revalidate authentication", async () => {
  const app = fastify();
  const connection = Object.assign(new EventEmitter(), {
    send: async () => {},
    detach: async () => {},
  });
  const page = { context: () => ({ newCDPSession: async () => connection }) };
  const state = {
    pageId: "p",
    revision: "r",
    width: 390,
    height: 640,
    deviceScaleFactor: 1,
    mobile: true,
    pages: [],
  };
  const close = await registerCloudBrowserRoutes(
    app,
    { cloudTarget: async () => ({ page, state }) } as unknown as BrowserService,
    "https://batty.example",
  );
  await app.ready();
  vi.useFakeTimers();
  const socket = await app.injectWS("/api/cloud-browser/id/socket", {
    headers: { origin: "https://batty.example" },
  });
  const serverSocket = [...app.websocketServer.clients][0]!;
  const closing = vi.spyOn(serverSocket, "close");
  try {
    for (let i = 0; i < 40; i++) {
      serverSocket.emit("pong");
      await vi.advanceTimersByTimeAsync(15_000);
    }
    expect(closing).toHaveBeenCalledWith(1001, "Authentication revalidation");
  } finally {
    vi.useRealTimers();
    socket.terminate();
    await close();
    await app.close();
  }
});
