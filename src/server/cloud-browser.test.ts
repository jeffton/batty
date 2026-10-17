// @vitest-environment node
import { expect, test } from "vite-plus/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once, EventEmitter } from "node:events";
import { createCloudBrowserEventWriter } from "./cloud-browser-events";
import fastify from "fastify";
import { BrowserService } from "./browser-service";
import { CloudBrowserStreams } from "./cloud-browser-stream";
import { registerCloudBrowserRoutes } from "./routes/cloud-browser";
import type { CloudBrowserFrame } from "@/shared/cloud-browser";
import { artifactRefs, mergeResponseArtifacts } from "./artifact-forwarding";

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
      if (event === "frame") receive(data as CloudBrowserFrame);
    });
    const first = await frame;
    expect(Buffer.from(first.image, "base64").subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(first.width).toBe(390);
    let second: CloudBrowserFrame | undefined;
    const stopSecond = await streams.subscribe(id, (event, data) => {
      if (event === "frame") second = data as CloudBrowserFrame;
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
  const closeStreams = registerCloudBrowserRoutes(app, f.service, "https://batty.example");
  try {
    await f.service.execute("shared", { action: "open", url: f.url, cloud: true });
    const id = (await f.service.execute("shared", { action: "attach" })).details.sites![0]!
      .browserId!;
    const endpoint = `/api/cloud-browser/${id}`;
    expect((await app.inject(`${endpoint}/state`)).statusCode).toBe(401);
    expect((await app.inject(`${endpoint}/events`)).statusCode).toBe(401);
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
  const closeStreams = registerCloudBrowserRoutes(
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
      if (event === "frame") frames.push(value as CloudBrowserFrame);
    });
    connection.emit("Page.screencastFrame", { sessionId: 1, data: "first" });
    connection.emit("Page.screencastFrame", { sessionId: 2, data: "intermediate" });
    connection.emit("Page.screencastFrame", { sessionId: 3, data: "final" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(frames.map((frame) => frame.image)).toEqual(["first", "final"]);
    stop();
  } finally {
    await streams.close();
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

test("slow SSE viewers recover the latest state and final frame after drain without queued history", () => {
  const response = Object.assign(new EventEmitter(), {
    writableNeedDrain: true,
    destroyed: false,
    writableEnded: false,
    write(value: string) {
      writes.push(value);
      return true;
    },
    end() {
      this.writableEnded = true;
    },
  });
  const writes: string[] = [];
  const writer = createCloudBrowserEventWriter(
    response as unknown as Parameters<typeof createCloudBrowserEventWriter>[0],
  );
  writer.start();
  writer.send("state", { pageId: "old" });
  writer.send("frame", { image: "old" });
  writer.send("state", { pageId: "new" });
  writer.send("frame", { image: "final" });
  expect(writes).toEqual([]);
  response.writableNeedDrain = false;
  response.emit("drain");
  expect(writes).toEqual([
    'event: state\ndata: {"pageId":"new"}\n\n',
    'event: frame\ndata: {"image":"final"}\n\n',
  ]);
  writer.close();
  expect(response.listenerCount("drain")).toBe(0);
});
