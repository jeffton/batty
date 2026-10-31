// @vitest-environment node
import { expect, test, vi } from "vite-plus/test";
import fs from "node:fs/promises";
import { removeTestBrowserRoot } from "./test-browser-cleanup";
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
vi.mock("./cloud-browser-stream", () => ({
  CloudBrowserStreams: class {
    async subscribe() {
      return () => {};
    }
    async close() {}
    scrolling() {}
  },
}));
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
      await removeTestBrowserRoot(root);
    },
  };
}

test("oversized cloud viewports fit the display across attach, tool resize, API rotation and restore", async () => {
  const f = await fixture();
  let service = f.service;
  try {
    await service.execute("shared", {
      action: "open",
      url: f.url,
      viewport: { width: 2400, height: 1600 },
    });
    const page = () =>
      service.execute("shared", {
        action: "evaluate",
        script: "({width:innerWidth,height:innerHeight})",
      });
    expect((await page()).text).toContain("2400");
    const attachment = await service.execute("shared", { action: "attach", cloud: true });
    const id = attachment.details.sites![0]!.browserId;
    expect(await service.cloudState(id)).toMatchObject({ width: 1365, height: 910 });
    for (const [width, height, fittedWidth, fittedHeight] of [
      [2400, 1600, 1365, 910],
      [1600, 2400, 910, 1365],
      [390, 844, 390, 844],
      [844, 390, 844, 390],
    ]) {
      const state = await service.cloudControl(id, {
        action: "viewport",
        width: width!,
        height: height!,
        mobile: false,
      });
      expect(state).toMatchObject({ width: fittedWidth, height: fittedHeight });
      const geometry = await service.cloudVideoGeometry(id, state);
      expect(Math.max(geometry.width, geometry.height)).toBeLessThanOrEqual(4096);
      await service.cloudControl(id, { action: "click", ...state, x: 40, y: 30 });
    }
    await service.execute("shared", {
      action: "evaluate",
      script: "window.scrollTo(0,0)",
      viewport: { width: 4000, height: 2000 },
    });
    let state = await service.cloudState(id);
    expect(state).toMatchObject({ width: 1365, height: 683 });
    await service.cloudControl(id, {
      action: "scroll",
      ...state,
      x: 100,
      y: 200,
      deltaX: 0,
      deltaY: 300,
    });
    await expect
      .poll(async () => (await service.cloudTarget(id)).page.evaluate(() => scrollY))
      .toBeGreaterThan(0);
    await service.dispose();
    service = new BrowserService(undefined, 4, f.root);
    state = await service.cloudState(id);
    expect(state).toMatchObject({ width: 1365, height: 683 });
    await service.cloudVideoGeometry(id, state);
    expect(
      (await service.execute("shared", { action: "evaluate", script: "window.clicks" })).text,
    ).toContain("4");
  } finally {
    await service.dispose();
    await f.close();
  }
});

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
    const forwarded = mergeResponseArtifacts({ sites: [site] }).sites![0]!;
    expect(forwarded.kind === "browser" && forwarded.browserId).toBe(id);
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

test("capture targets retain view fences without querying page status", async () => {
  const f = await fixture();
  try {
    const opened = await f.service.execute("shared", { action: "open", url: f.url, cloud: true });
    const id = opened.details.sites![0]!.browserId!;
    const full = await f.service.cloudTarget(id);
    const title = vi.spyOn(full.page, "title");
    const frames = vi.spyOn(full.page, "frames");
    const capture = await f.service.cloudCaptureTarget(id);
    expect(capture.page).toBe(full.page);
    expect(full.state).toMatchObject(capture.state);
    expect(title).not.toHaveBeenCalled();
    expect(frames).not.toHaveBeenCalled();
    await f.service.cloudControl(id, { action: "click", ...capture.state, x: 40, y: 30 });
    await f.service.execute("shared", { action: "click", selector: "#text" });
    await expect(
      f.service.cloudScroll(id, {
        action: "scroll",
        ...capture.state,
        x: 40,
        y: 30,
        deltaX: 0,
        deltaY: 10,
      }),
    ).rejects.toThrow("view changed");
  } finally {
    await f.close();
  }
}, 30_000);

test("native touch ownership survives competing viewers and releases on coordinate changes", async () => {
  const f = await fixture();
  try {
    const opened = await f.service.execute("shared", { action: "open", url: f.url, cloud: true });
    const id = opened.details.sites![0]!.browserId!;
    await f.service.cloudControl(id, { action: "viewport", width: 390, height: 640, mobile: true });
    const { page, state } = await f.service.cloudTarget(id);
    await page.setContent(
      `<meta name="viewport" content="width=device-width"><body style="height:3000px" ontouchcancel="this.dataset.cancelled='yes'"></body>`,
    );
    const command = {
      action: "touch" as const,
      ...state,
      phase: "start" as const,
      x: 100,
      y: 300,
      elapsedMs: 0,
    };
    // setContent keeps the same page but may change its revision.
    Object.assign(command, await f.service.cloudState(id));
    await f.service.cloudTouch(id, command, "first-viewer");
    await expect(f.service.cloudTouch(id, command, "other-viewer")).rejects.toThrow("active touch");
    await f.service.cloudReleaseTouch(id, "other-viewer");
    await f.service.cloudTouch(
      id,
      { ...command, phase: "move", y: 260, elapsedMs: 30 },
      "first-viewer",
    );
    await f.service.cloudControl(id, { action: "viewport", width: 640, height: 390, mobile: true });
    await expect.poll(() => page.locator("body").getAttribute("data-cancelled")).toBe("yes");
    await expect(
      f.service.cloudTouch(id, { ...command, phase: "move", elapsedMs: 60 }, "first-viewer"),
    ).rejects.toThrow("view changed");
    const next = { ...command, ...(await f.service.cloudState(id)), x: 100, y: 100 };
    await f.service.cloudTouch(id, next, "other-viewer");
    await f.service.cloudReleaseTouch(id, "other-viewer");
    await f.service.cloudTouch(id, next, "first-viewer");
    await f.service.cloudTouch(id, { ...next, phase: "cancel", elapsedMs: 30 }, "first-viewer");
  } finally {
    await f.close();
  }
}, 30_000);

test("direct wheel input targets iframe and nested scrollers without synthetic hover events", async () => {
  const f = await fixture();
  try {
    const opened = await f.service.execute("shared", { action: "open", url: f.url, cloud: true });
    const id = opened.details.sites![0]!.browserId!;
    const { page } = await f.service.cloudTarget(id);
    await page.setContent(`
      <body style="margin:0;height:3000px" onmousemove="this.dataset.moves=String(Number(this.dataset.moves||0)+1)">
      <iframe style="display:block;width:160px;height:160px;border:0" srcdoc="<body style='margin:0;height:2000px'>Frame</body>"></iframe>
      <div id="pane" style="position:absolute;left:180px;top:0;width:160px;height:160px;overflow:auto;overscroll-behavior:contain"><div style="height:2000px">Pane</div></div>
      </body>`);
    const frame = page.frames().find((frame) => frame !== page.mainFrame())!;
    await frame.waitForLoadState();
    const state = await f.service.cloudState(id);
    const scroll = (x: number, deltaY: number) =>
      f.service.cloudScroll(id, {
        action: "scroll",
        ...state,
        x,
        y: 80,
        deltaX: 0,
        deltaY,
      });
    const moves = await page.locator("body").getAttribute("data-moves");
    await scroll(80, 120);
    await expect.poll(() => frame.evaluate(() => scrollY)).toBe(120);
    await scroll(240, 90);
    await expect.poll(() => page.locator("#pane").evaluate((pane) => pane.scrollTop)).toBe(90);
    await scroll(80, -40);
    await expect.poll(() => frame.evaluate(() => scrollY)).toBe(80);
    expect(await page.evaluate(() => scrollY)).toBe(0);
    expect(await page.locator("body").getAttribute("data-moves")).toBe(moves);
  } finally {
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

test("binary packet retains exact H.264 bytes and decoder metadata", () => {
  const frame = {
    image: Buffer.from([0, 0, 0, 1, 0x65, 255]).toString("base64"),
    pageId: "p",
    revision: "r",
    width: 390,
    height: 640,
    codec: "avc1.42c01f",
    key: true,
    streamId: "encoder",
  };
  expect(decodePacket(encodeBrowserFrame(frame, 42))).toEqual({ ...frame, frameId: 42 });
});

test("slow viewers bound socket writes and recover an overflowing GOP only at a keyframe", () => {
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
      {
        image: "//g=",
        pageId: "p",
        revision: "r",
        width: 390,
        height: 640,
        codec: "avc1.42c01f",
        streamId: "encoder",
        key: frameId === 1 || frameId === 100,
      },
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
  writer.send("frame", paint(3));
  callbacks.shift()!();
  writer.send("frame", paint(4));
  callbacks.shift()!();
  for (let i = 5; i <= 100; i++) writer.send("frame", paint(i));
  expect(writes).toHaveLength(5); // Four decoder ACKs are outstanding; queued GOPs overflow.
  expect(() => writer.acknowledge(99)).toThrow("Invalid browser frame acknowledgement");
  writer.acknowledge(1);
  expect(decodePacket({ packet: writes[5] }).frameId).toBe(100);
  callbacks.shift()!();
  expect(() => writer.acknowledge(1)).toThrow("Invalid browser frame acknowledgement");
  writer.close();
  writer.send("frame", paint(101));
  expect(writes).toHaveLength(6);
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
    encodeBrowserFrame(
      {
        image: "//g=",
        pageId: "p",
        revision: "r",
        width: 390,
        height: 640,
        codec: "avc1.42c01f",
        streamId: "encoder",
        key: true,
      },
      1,
    ),
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

function videoWriterFixture() {
  const packets: Buffer[] = [];
  const callbacks: Array<(error?: Error) => void> = [];
  const socket = {
    readyState: 1,
    send(value: string | Buffer, _options: unknown, callback: (error?: Error) => void) {
      if (Buffer.isBuffer(value)) packets.push(value);
      callbacks.push(callback);
    },
    close: vi.fn(),
    terminate: vi.fn(),
  };
  const writer = createCloudBrowserSocketWriter(
    socket as unknown as Parameters<typeof createCloudBrowserSocketWriter>[0],
  );
  const frame = (id: number, key = false, streamId = "first", bytes = 4) =>
    writer.send(
      "frame",
      encodeBrowserFrame(
        {
          image: Buffer.alloc(bytes).toString("base64"),
          pageId: "p",
          revision: "r",
          width: 390,
          height: 640,
          codec: "avc1.42c01f",
          key,
          streamId,
        },
        id,
      ),
    );
  return {
    writer,
    socket,
    frame,
    complete: (error?: Error) => callbacks.shift()!(error),
    ids: () => packets.map((packet) => decodePacket({ packet }).frameId),
  };
}

test("a newly attached decoder waits for a keyframe and preserves every dependent delta in order", () => {
  const f = videoWriterFixture();
  f.frame(1); // Joining an existing producer mid-GOP cannot initialize the decoder.
  expect(f.ids()).toEqual([]);
  f.frame(2, true);
  f.frame(3);
  f.frame(4);
  f.frame(5);
  f.frame(6);
  f.frame(7);
  expect(f.ids()).toEqual([2]); // At most one socket write is active.
  f.complete();
  f.complete();
  f.complete();
  f.complete();
  expect(f.ids()).toEqual([2, 3, 4, 5]); // Four frames await decoder ACKs; later deltas stay queued.
  f.writer.acknowledge(2);
  expect(f.ids()).toEqual([2, 3, 4, 5, 6]);
  f.complete();
  f.writer.acknowledge(3);
  expect(f.ids()).toEqual([2, 3, 4, 5, 6, 7]);
  f.complete();
  expect(() => f.writer.acknowledge(2)).toThrow("Invalid browser frame acknowledgement");
  expect(() => f.writer.acknowledge(99)).toThrow("Invalid browser frame acknowledgement");
  f.writer.close();
});

test("the ninth queued dependent frame overflows the GOP and waits for a fresh keyframe", () => {
  const f = videoWriterFixture();
  for (let id = 1; id <= 4; id++) {
    f.frame(id, id === 1);
    f.complete();
  }
  for (let id = 5; id <= 12; id++) f.frame(id);
  expect(f.ids()).toEqual([1, 2, 3, 4]);
  f.writer.acknowledge(1);
  expect(f.ids()).toEqual([1, 2, 3, 4, 5]); // Eight queued frames fit without dropping deltas.
  f.complete();
  f.frame(13);
  f.frame(14); // Nine queued frames now exceed the frame-count bound.
  f.writer.acknowledge(2);
  expect(f.ids()).toEqual([1, 2, 3, 4, 5]);
  f.frame(15);
  expect(f.ids()).toEqual([1, 2, 3, 4, 5]); // Later deltas cannot recover the broken GOP.
  f.frame(16, true);
  expect(f.ids()).toEqual([1, 2, 3, 4, 5, 16]);
  f.complete();
  f.writer.close();
});

test("encoder changes and byte-budget overflow both require a fresh keyframe", () => {
  const f = videoWriterFixture();
  f.frame(1, true);
  f.complete();
  f.frame(2);
  f.complete();
  f.frame(3);
  f.complete();
  f.frame(4);
  f.complete();
  f.frame(5, false, "first", 1024 * 1024);
  f.frame(6, false, "first", 1024 * 1024); // Exceeds 2 MiB including metadata.
  f.writer.acknowledge(1);
  expect(f.ids()).toEqual([1, 2, 3, 4]);
  f.frame(7);
  expect(f.ids()).toEqual([1, 2, 3, 4]);
  f.frame(8, true);
  f.complete();
  f.writer.acknowledge(2);
  f.frame(9, false, "new-encoder");
  expect(f.ids()).toEqual([1, 2, 3, 4, 8]);
  f.frame(10, true, "new-encoder");
  expect(f.ids()).toEqual([1, 2, 3, 4, 8, 10]);
  f.complete();
  f.writer.close();
});

test("write errors terminate transport and terminal browser errors close only after their write", () => {
  const failed = videoWriterFixture();
  failed.frame(1, true);
  failed.complete(new Error("socket lost"));
  failed.frame(2);
  expect(failed.socket.terminate).toHaveBeenCalledOnce();
  expect(failed.ids()).toEqual([1]);
  const ended = videoWriterFixture();
  ended.frame(1, true);
  ended.writer.send("browser-error", { error: "expired", statusCode: 410, retryable: false });
  ended.frame(2);
  ended.complete();
  expect(ended.socket.close).not.toHaveBeenCalled();
  ended.complete();
  expect(ended.socket.close).toHaveBeenCalledWith(1000, "Browser stream ended");
  expect(ended.ids()).toEqual([1]);
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
      cloudCaptureTarget: async () => ({ page, state }),
      cloudState: async () => state,
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
  touch: Partial<Pick<BrowserService, "cloudTouch" | "cloudReleaseTouch">> = {},
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
      cloudCaptureTarget: async () => ({ page, state }),
      cloudState: async () => state,
      cloudScroll,
      ...touch,
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

test("a busy-agent touch rejection releases ownership before disconnect and a fresh viewer can touch", async () => {
  let active = false;
  let busy = false;
  const cloudTouch = vi.fn<BrowserService["cloudTouch"]>(async (_id, command) => {
    if (busy) throw Object.assign(new Error("Browser is busy"), { statusCode: 409 });
    if (command.phase === "start") {
      if (active) throw new Error("Browser already has an active touch");
      active = true;
    }
  });
  const release = vi.fn(async () => {
    active = false;
  });
  const f = await scrollSocketFixture(
    async () => {},
    () => {},
    { cloudTouch, cloudReleaseTouch: release },
  );
  const command = {
    action: "touch",
    pageId: "p",
    revision: "r",
    x: 100,
    y: 300,
    phase: "start",
    elapsedMs: 0,
  };
  try {
    f.send(command);
    await expect.poll(() => active).toBe(true);
    busy = true;
    f.send({ ...command, phase: "end", elapsedMs: 30 });
    await expect
      .poll(() => f.messages.some((message) => message.event === "scroll-error"))
      .toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(active).toBe(false);
    f.socket.terminate();
    busy = false;
    const next = await f.app.injectWS("/api/cloud-browser/id/socket", {
      headers: { origin: "https://batty.example" },
    });
    next.send(JSON.stringify(command));
    await expect.poll(() => active).toBe(true);
    next.terminate();
    await expect.poll(() => active).toBe(false);
    expect(release).toHaveBeenCalledTimes(2);
  } finally {
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
    {
      cloudTarget: async () => ({ page, state }),
      cloudCaptureTarget: async () => ({ page, state }),
      cloudState: async () => state,
    } as unknown as BrowserService,
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
