import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import fastify from "fastify";
import vue from "@vitejs/plugin-vue";
import { chromium } from "patchright";
import { BrowserService } from "../src/server/browser-service";
import { registerCloudBrowserRoutes } from "../src/server/routes/cloud-browser";
import {
  closeBrowserFixtureServer,
  createBrowserFixtureServer,
} from "../src/client/test/browser-fixture";

// Repeatable synthetic mobile link: 30ms each way, 20Mbit/s downstream.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-cloud-bench-"));
const service = new BrowserService(undefined, 4, root);
const scrollOperationMs: number[] = [];
const dispatchScroll = service.cloudScroll.bind(service);
service.cloudScroll = async (id, command) => {
  const started = performance.now();
  await dispatchScroll(id, command);
  scrollOperationMs.push(performance.now() - started);
};
const backend = fastify();
backend.get("/target", (_request, reply) =>
  reply.type("text/html").send(`<!doctype html>
<meta name="viewport" content="width=device-width"><style>body{margin:0;font:16px Arial;line-height:1.5;background:#f2f5f8}p{padding:8px;margin:0;border-bottom:1px solid #ccc}#mark{position:fixed;top:0;left:0;width:24px;height:24px;z-index:3;background:rgb(16,16,16)}</style>
<div id="mark"></div>${Array.from({ length: 600 }, (_, i) => `<p>Row ${i}: Crisp browser text — æøå 0123456789</p>`).join("")}
<script>window.n=0;window.scrollRecords=[];onscroll=()=>{const n=++window.n;window.scrollRecords.push({mark:n,y:scrollY});document.documentElement.dataset.scrollRecords=JSON.stringify(window.scrollRecords);document.documentElement.dataset.mark=String(n);document.documentElement.dataset.firstScrollAt ||= String(Date.now());document.querySelector('#mark').style.background='rgb('+[n%8,Math.floor(n/8)%8,Math.floor(n/64)%8].map(x=>16+x*32).join(',')+')'}</script>`),
);
const reservation = net.createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const backendAddress = reservation.address() as net.AddressInfo;
await new Promise<void>((r) => reservation.close(() => r()));
const sockets = new Set<net.Socket>();
const relay = net.createServer((client) => {
  const upstream = net.connect(backendAddress.port, "127.0.0.1");
  for (const socket of [client, upstream]) {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  }
  function forward(from: net.Socket, to: net.Socket, bytesPerSecond: number) {
    let next = 0;
    from.on("data", (data: Buffer) => {
      const now = Date.now();
      next = Math.max(now + 30, next) + (data.length / bytesPerSecond) * 1000;
      setTimeout(
        () => {
          if (!to.destroyed) to.write(data);
        },
        Math.max(0, next - now),
      );
    });
    from.on("end", () => setTimeout(() => to.end(), Math.max(0, next - Date.now()) + 1));
  }
  forward(client, upstream, 10_000_000);
  forward(upstream, client, 2_500_000);
});
relay.listen(0, "127.0.0.1");
await once(relay, "listening");
let id = "";
const server = await createBrowserFixtureServer(
  "src/client/components/BrowserPopover.fixture.html",
  {
    plugins: [vue()],
    resolve: { alias: { "@": path.resolve("src") } },
    server: {
      host: "127.0.0.1",
      port: 0,
      fs: { allow: [process.cwd(), await fs.realpath("node_modules")] },
      proxy: {
        "/api/cloud-browser": {
          target: `http://127.0.0.1:${(relay.address() as net.AddressInfo).port}`,
          ws: true,
          rewrite: (p) => p.replace("/opaque/", `/${id}/`),
        },
      },
    },
  },
);
await server.listen();
const closeStreams = await registerCloudBrowserRoutes(
  backend,
  service,
  server.resolvedUrls!.local[0]!,
);
await backend.listen({ host: "127.0.0.1", port: backendAddress.port });
const browser = await chromium.launch({ headless: true });
try {
  await service.execute("benchmark", {
    action: "open",
    url: `http://127.0.0.1:${backendAddress.port}/target`,
    cloud: true,
  });
  id = (await service.execute("benchmark", { action: "attach" })).details.sites![0]!.browserId!;
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  let wireBytes = 0;
  const network = await page.context().newCDPSession(page);
  await network.send("Network.enable");
  const transports = new Set<string>();
  network.on("Network.requestWillBeSent", (event) => {
    if (event.request.url.includes("/api/cloud-browser/")) transports.add(event.requestId);
  });
  network.on("Network.webSocketCreated", (event) => {
    if (event.url.includes("/api/cloud-browser/")) transports.add(event.requestId);
  });
  network.on("Network.dataReceived", (event) => {
    if (transports.has(event.requestId)) wireBytes += event.dataLength;
  });
  network.on("Network.webSocketFrameReceived", (event) => {
    if (!transports.has(event.requestId)) return;
    wireBytes +=
      event.response.opcode === 2
        ? Buffer.byteLength(event.response.payloadData, "base64")
        : Buffer.byteLength(event.response.payloadData);
  });
  await page.goto(
    `${server.resolvedUrls!.local[0]}src/client/components/BrowserPopover.fixture.html`,
  );
  await page.evaluate("globalThis.__name = value => value");
  await page.evaluate(() => {
    const records: Array<{ time: number; mark: number; pixelsWidth: number }> = [];
    const inputs: Array<{ time: number; position: number }> = [];
    let originY = 0;
    const publish = () => {
      document.documentElement.dataset.bench = JSON.stringify({ records, inputs });
    };
    document.addEventListener(
      "pointerdown",
      (event) => {
        if ((event.target as Element).classList.contains("cloud-browser__image"))
          originY = event.clientY;
      },
      true,
    );
    document.addEventListener(
      "pointermove",
      (event) => {
        if (!(event.target as Element).classList.contains("cloud-browser__image")) return;
        const position = originY - event.clientY;
        if (position < 6) return;
        inputs.push({ time: performance.now(), position });
        publish();
      },
      true,
    );
    document.addEventListener("bench-reset", () => {
      records.length = 0;
      inputs.length = 0;
      publish();
    });
    const sample = (image: HTMLImageElement | HTMLCanvasElement) => {
      const canvas = document.createElement("canvas");
      canvas.width = 24;
      canvas.height = 24;
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      context.drawImage(image, 0, 0);
      const pixel = context.getImageData(6, 6, 1, 1).data;
      const mark = [pixel[0]!, pixel[1]!, pixel[2]!]
        .map((x) => Math.round((x - 16) / 32))
        .reduce((n, x, i) => n + x * 8 ** i, 0);
      records.push({
        time: performance.now(),
        mark,
        pixelsWidth: image instanceof HTMLImageElement ? image.naturalWidth : image.width,
      });
      publish();
    };
    document.addEventListener(
      "load",
      (event) => {
        const e = event.target;
        if (e instanceof HTMLImageElement && e.classList.contains("cloud-browser__image"))
          sample(e);
      },
      true,
    );
    new MutationObserver((entries) => {
      for (const e of entries)
        if (e.target instanceof HTMLCanvasElement && e.attributeName === "data-frame")
          sample(e.target);
    }).observe(document.documentElement, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-frame"],
    });
  });
  await page.getByRole("button", { name: "Open browser", exact: true }).click();
  const image = page.locator(".cloud-browser__image");
  await image.waitFor();
  await page.waitForFunction(
    () => JSON.parse(document.documentElement.dataset.bench ?? '{"records":[]}').records.length > 0,
  );
  const verifyCoverage = async () => {
    const covered = await image.evaluate((element) => {
      const canvas =
        element instanceof HTMLCanvasElement ? element : document.createElement("canvas");
      if (element instanceof HTMLImageElement) {
        canvas.width = element.naturalWidth;
        canvas.height = element.naturalHeight;
        canvas.getContext("2d")!.drawImage(element, 0, 0);
      }
      const pixel = canvas
        .getContext("2d")!
        .getImageData(canvas.width - 3, canvas.height - 3, 1, 1).data;
      return [...pixel].slice(0, 3).some((value) => value < 250);
    });
    if (!covered) throw new Error("Page does not cover the bottom-right viewport corner.");
  };
  await verifyCoverage();
  const dimensions = await image.evaluate((e) => ({
    css: [e.clientWidth, e.clientHeight],
    pixels:
      e instanceof HTMLImageElement
        ? [e.naturalWidth, e.naturalHeight]
        : [(e as HTMLCanvasElement).width, (e as HTMLCanvasElement).height],
    dpr: devicePixelRatio,
  }));
  // Benchmark steady scrolling, not cold page-load frames still in flight.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const bounds = (await image.boundingBox())!;
  const touch = await page.context().newCDPSession(page);
  await page.evaluate(() => document.dispatchEvent(new Event("bench-reset")));
  wireBytes = 0;
  const started = await page.evaluate(() => performance.now());
  await touch.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: bounds.x + 200, y: bounds.y + 500 }],
  });
  const wallStart = Date.now();
  for (let i = 1; i <= 90; i++) {
    // A continuous 3s drag; leave the captured element as the pointer moves.
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: bounds.x + 200, y: bounds.y + 500 - i * 8 }],
    });
    const remaining = wallStart + i * 33 - Date.now();
    if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
  }
  const ended = await page.evaluate(() => performance.now());
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const target = await service.cloudTarget(id);
  // Assert the final remote scroll event's mark actually reaches the viewer.
  await new Promise((r) => setTimeout(r, 200));
  const finalMark = await target.page.evaluate(() => Number(document.documentElement.dataset.mark));
  await page.waitForFunction(
    (mark) =>
      (JSON.parse(document.documentElement.dataset.bench!).records as Array<{ mark: number }>).some(
        (r) => r.mark === mark,
      ),
    finalMark,
    { timeout: 15000 },
  );
  if (await image.evaluate((e) => e instanceof HTMLCanvasElement))
    await page.waitForFunction(() => {
      const e = document.querySelector<HTMLCanvasElement>(".cloud-browser__image")!;
      return e.width >= Math.round(e.clientWidth * devicePixelRatio);
    });
  const stats = await page.evaluate(
    ({ started, ended, finalMark, initialWidth, remoteScrolls }) => {
      const bench = JSON.parse(document.documentElement.dataset.bench!);
      const records = bench.records as Array<{ time: number; mark: number; pixelsWidth: number }>;
      const changed = records.filter((r, i) => i === 0 || r.mark !== records[i - 1]!.mark);
      const inputs = bench.inputs as Array<{ time: number; position: number }>;
      const inputAges = changed
        .flatMap((paint) => {
          const remote = remoteScrolls.find((scroll) => scroll.mark === paint.mark);
          const input = remote && inputs.findLast((move) => move.position <= remote.y + 1);
          return input ? [paint.time - input.time] : [];
        })
        .sort((a, b) => a - b);
      const moving = changed.filter((r) => r.time >= started && r.time <= ended);
      const gaps = moving
        .slice(1)
        .map((r, i) => r.time - moving[i]!.time)
        .sort((a, b) => a - b);
      return {
        firstPaintMs: changed.find((r) => r.mark > 0)!.time - started,
        firstInputToVisibleMs: changed.find((r) => r.mark > 0)!.time - inputs[0]!.time,
        reflectedInputAgeMs: {
          p50: inputAges[Math.floor(inputAges.length * 0.5)],
          p95: inputAges[Math.floor(inputAges.length * 0.95)],
          samples: inputAges.length,
        },
        fullResolutionFinalPaintMs:
          records.find((r) => r.mark === finalMark && r.pixelsWidth === initialWidth)!.time - ended,
        gestureMs: ended - started,
        presentedChanges: moving.length,
        fps: (moving.length / (ended - started)) * 1000,
        p95FrameGapMs: gaps[Math.floor(gaps.length * 0.95)],
        finalPaintAfterLiftMs: changed.find((r) => r.mark === finalMark)!.time - ended,
        remoteScrollEvents: finalMark,
      };
    },
    {
      started,
      ended,
      finalMark,
      initialWidth: dimensions.pixels[0],
      remoteScrolls: await target.page.evaluate(
        () =>
          JSON.parse(document.documentElement.dataset.scrollRecords!) as Array<{
            mark: number;
            y: number;
          }>,
      ),
    },
  );
  await verifyCoverage();
  const finalScroll = await target.page.evaluate(() => scrollY);
  if (Math.abs(finalScroll - 720) > 1)
    throw new Error(`Gesture distance changed: expected 720 CSS pixels, got ${finalScroll}`);
  console.log(
    JSON.stringify(
      {
        link: { rttMs: 60, downMbit: 20 },
        dimensions,
        finalDimensions: await image.evaluate((e) => ({
          css: [e.clientWidth, e.clientHeight],
          pixels:
            e instanceof HTMLImageElement
              ? [e.naturalWidth, e.naturalHeight]
              : [(e as HTMLCanvasElement).width, (e as HTMLCanvasElement).height],
        })),
        state: await service.cloudState(id),
        remote: await target.page.evaluate(() => ({
          dpr: devicePixelRatio,
          scale: visualViewport?.scale,
          scrollY,
        })),
        ...stats,
        scrollOperationMs: {
          p50: scrollOperationMs.sort((a, b) => a - b)[Math.floor(scrollOperationMs.length * 0.5)],
          p95: scrollOperationMs[Math.floor(scrollOperationMs.length * 0.95)],
          samples: scrollOperationMs.length,
        },
        runnerToRemoteScrollMs:
          Number(await target.page.evaluate(() => document.documentElement.dataset.firstScrollAt)) -
          wallStart,
        wireBytes,
      },
      null,
      2,
    ),
  );
  await page.screenshot({
    path: `/tmp/batty-cloud-benchmark-${process.env.BENCH_LABEL ?? "current"}.png`,
  });
  const disconnected = new Promise<void>((resolve) => {
    network.on("Network.webSocketClosed", (event) => {
      if (transports.has(event.requestId)) resolve();
    });
  });
  await page.getByRole("button", { name: "Close popover" }).click();
  if (await image.evaluate((e) => e instanceof HTMLCanvasElement)) await disconnected;
} finally {
  await browser.close();
  await closeStreams();
  await service.closeSession("benchmark");
  await service.dispose();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((r) => relay.close(() => r()));
  await closeBrowserFixtureServer(server);
  await backend.close();
  await fs.rm(root, { recursive: true, force: true });
}
