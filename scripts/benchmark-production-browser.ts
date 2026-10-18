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

// Run unchanged in the current checkout and an isolated historical JPEG worktree.
// No codec switch, capture adapter, production profile or public listener is used.
const trials = Number(process.env.BENCH_TRIALS ?? 20);
const rttMs = Number(process.env.BENCH_RTT_MS ?? 60);
const downMbit = Number(process.env.BENCH_DOWN_MBIT ?? 20);
const label = process.env.BENCH_LABEL ?? "production";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-production-bench-"));
const cleanups: Array<() => Promise<unknown>> = [
  () => fs.rm(root, { recursive: true, force: true }),
];
const failures: unknown[] = [];
try {
  const service = new BrowserService(undefined, 4, root);
  cleanups.push(
    () => service.dispose(),
    () => service.closeSession("benchmark"),
  );
  const touchOperationMs: number[] = [];
  const dispatchTouch = service.cloudTouch.bind(service);
  service.cloudTouch = async (...args) => {
    const began = performance.now();
    try {
      await dispatchTouch(...args);
    } finally {
      touchOperationMs.push(performance.now() - began);
    }
  };
  const backend = fastify();
  cleanups.push(() => backend.close());
  backend.get("/target", (_request, reply) =>
    reply
      .type("text/html")
      .send(
        `<!doctype html><meta name="viewport" content="width=device-width"><style>body{margin:0;font:16px Arial;line-height:1.5;background:#f2f5f8}p{padding:8px;margin:0;border-bottom:1px solid #ccc}#mark{position:fixed;top:0;left:0;width:24px;height:24px;z-index:3;background:rgb(16,16,16)}</style><div id="mark"></div>${Array.from({ length: 600 }, (_, i) => `<p>Row ${i}: Crisp browser text — æøå 0123456789</p>`).join("")}<script>window.n=0;window.trial=0;window.scrollRecords=[];addEventListener('touchstart',()=>window.trial++,{passive:true});onscroll=()=>{const n=++window.n;window.scrollRecords.push({mark:n,trial:window.trial,y:scrollY});document.documentElement.dataset.scrollRecords=JSON.stringify(window.scrollRecords);document.documentElement.dataset.mark=String(n);document.querySelector('#mark').style.background='rgb('+[n%8,Math.floor(n/8)%8,Math.floor(n/64)%8].map(x=>16+x*32).join(',')+')'}</script>`,
      ),
  );
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const backendPort = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const sockets = new Set<net.Socket>();
  const bytes: Array<{ time: number; bytes: number }> = [];
  const relay = net.createServer((client) => {
    const upstream = net.connect(backendPort, "127.0.0.1");
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
    }
    function forward(from: net.Socket, to: net.Socket, rate: number, downstream: boolean) {
      let next = 0;
      const pending: Array<{ at: number; data: Buffer }> = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      const flush = () => {
        timer = undefined;
        while (pending.length && pending[0]!.at <= performance.now()) {
          const item = pending.shift()!;
          if (!to.destroyed) {
            if (downstream) bytes.push({ time: performance.now(), bytes: item.data.length });
            to.write(item.data);
          }
        }
        if (pending.length)
          timer = setTimeout(flush, Math.max(0, pending[0]!.at - performance.now()));
      };
      from.on("data", (data: Buffer) => {
        const now = performance.now();
        next = Math.max(now + rttMs / 2, next) + (data.length / rate) * 1000;
        pending.push({ at: next, data });
        if (!timer) timer = setTimeout(flush, Math.max(0, next - now));
      });
      to.on("close", () => {
        if (timer) clearTimeout(timer);
        pending.length = 0;
      });
    }
    forward(client, upstream, 1_250_000_000, false);
    forward(upstream, client, (downMbit * 1_000_000) / 8, true);
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      relay.close((error) => (error ? reject(error) : resolve())),
    );
  });
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
  cleanups.push(() => closeBrowserFixtureServer(server));
  await server.listen();
  const closeStreams = await registerCloudBrowserRoutes(
    backend,
    service,
    server.resolvedUrls!.local[0]!,
  );
  cleanups.push(closeStreams);
  await backend.listen({ host: "127.0.0.1", port: backendPort });
  const browser = await chromium.launch({ headless: true });
  cleanups.push(() => browser.close());
  await service.execute("benchmark", {
    action: "open",
    url: `http://127.0.0.1:${backendPort}/target`,
    cloud: true,
  });
  id = (await service.execute("benchmark", { action: "attach" })).details.sites![0]!.browserId!;
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const wireFrames: Array<{
    hostTime: number;
    frameId: number;
    streamId?: string;
    key?: boolean;
    width: number;
    height: number;
  }> = [];
  const network = await page.context().newCDPSession(page);
  await network.send("Network.enable");
  network.on("Network.webSocketFrameReceived", (event) => {
    if (event.response.opcode !== 2) return;
    const data = Buffer.from(event.response.payloadData, "base64");
    const size = data.readUInt32BE(0);
    const metadata = JSON.parse(data.subarray(4, 4 + size).toString());
    wireFrames.push({
      hostTime: performance.now(),
      frameId: metadata.frameId,
      streamId: metadata.streamId,
      key: metadata.key,
      width: metadata.width,
      height: metadata.height,
    });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    `${server.resolvedUrls!.local[0]}src/client/components/BrowserPopover.fixture.html`,
  );
  const clockBefore = performance.now();
  const clientClock = await page.evaluate(() => performance.now());
  const clockAfter = performance.now();
  const clientToHostOffset = (clockBefore + clockAfter) / 2 - clientClock;
  await page.evaluate("globalThis.__name = value => value");
  await page.evaluate(() => {
    const records: Array<{ time: number; mark: number; width: number; frameId: number }> = [];
    const inputs: Array<{ time: number; handlerTime: number; trial: number }> = [];
    let trial = 0;
    const publish = () => {
      document.documentElement.dataset.bench = JSON.stringify({ records, inputs });
    };
    document.addEventListener(
      "pointerdown",
      (event) => {
        if ((event.target as Element).classList.contains("cloud-browser__image")) trial++;
      },
      true,
    );
    document.addEventListener(
      "pointermove",
      (event) => {
        if (!(event.target as Element).classList.contains("cloud-browser__image")) return;
        inputs.push({ time: event.timeStamp, handlerTime: performance.now(), trial });
        publish();
      },
      true,
    );
    new MutationObserver((entries) => {
      for (const entry of entries) {
        const canvas = entry.target;
        if (!(canvas instanceof HTMLCanvasElement)) continue;
        const pixel = canvas.getContext("2d")!.getImageData(6, 6, 1, 1).data;
        const mark = [pixel[0]!, pixel[1]!, pixel[2]!]
          .map((x) => Math.round((x - 16) / 32))
          .reduce((n, x, i) => n + x * 8 ** i, 0);
        records.push({
          time: performance.now(),
          mark,
          width: canvas.width,
          frameId: Number(canvas.dataset.frame),
        });
        publish();
      }
    }).observe(document.documentElement, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-frame"],
    });
  });
  await page.getByRole("button", { name: "Open browser", exact: true }).click();
  await page.waitForFunction(
    () => JSON.parse(document.documentElement.dataset.bench ?? '{"records":[]}').records.length > 0,
  );
  const image = page.locator(".cloud-browser__image");
  const bounds = (await image.boundingBox())!;
  const touch = await page.context().newCDPSession(page);
  const remote = (await service.cloudTarget(id)).page;
  const point = { x: bounds.x + 180, y: bounds.y + bounds.height - 35 };
  const start = (timestamp: number) =>
    touch.send("Input.dispatchTouchEvent", { type: "touchStart", timestamp, touchPoints: [point] });
  const move = (delta: number, timestamp: number) =>
    touch.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      timestamp,
      touchPoints: [{ x: point.x, y: point.y - delta }],
    });
  const end = (timestamp: number) =>
    touch.send("Input.dispatchTouchEvent", { type: "touchEnd", timestamp, touchPoints: [] });
  for (let trial = 1; trial <= trials; trial++) {
    await page.waitForTimeout(1300);
    const gestureEpoch = Date.now() / 1000;
    await start(gestureEpoch);
    await page.waitForTimeout(80);
    await move(80, gestureEpoch + 0.08);
    await remote.waitForFunction(
      (trial) =>
        JSON.parse(document.documentElement.dataset.scrollRecords ?? "[]").some(
          (r: any) => r.trial === trial,
        ),
      trial,
    );
    const mark = await remote.evaluate(
      (trial) =>
        JSON.parse(document.documentElement.dataset.scrollRecords!).find(
          (r: any) => r.trial === trial,
        ).mark as number,
      trial,
    );
    await page.waitForFunction(
      (mark) =>
        JSON.parse(document.documentElement.dataset.bench!).records.some(
          (r: any) => r.mark === mark,
        ),
      mark,
      { timeout: 15000 },
    );
    // Hold until momentum velocity is zero: exactly one scroll per isolated trial.
    await page.waitForTimeout(200);
    await end(Date.now() / 1000);
  }
  await page.waitForTimeout(1500);
  const before = await page.evaluate(() => JSON.parse(document.documentElement.dataset.bench!));
  const scrolls = await remote.evaluate(() =>
    JSON.parse(document.documentElement.dataset.scrollRecords!),
  );
  const latency: number[] = [];
  const responseStages: Array<{
    trial: number;
    inputToNetworkEventMs: number;
    networkEventToCanvasMs: number;
    streamId?: string;
    frameId: number;
  }> = [];
  for (let trial = 1; trial <= trials; trial++) {
    const inputs = before.inputs.filter((r: any) => r.trial === trial);
    const matching = scrolls.filter((r: any) => r.trial === trial);
    if (inputs.length !== 1 || matching.length !== 1)
      throw Error(`Ambiguous trial ${trial}: inputs=${inputs.length}, scrolls=${matching.length}`);
    const paint = before.records.find(
      (r: any) => r.mark === matching[0].mark && r.time >= inputs[0].time,
    );
    if (!paint) throw Error(`Missing corresponding pixels for trial ${trial}`);
    latency.push(paint.time - inputs[0].time);
    const packet = wireFrames.find((frame) => frame.frameId === paint.frameId);
    if (packet)
      responseStages.push({
        trial,
        inputToNetworkEventMs: packet.hostTime - clientToHostOffset - inputs[0].time,
        networkEventToCanvasMs: paint.time + clientToHostOffset - packet.hostTime,
        streamId: packet.streamId,
        frameId: packet.frameId,
      });
  }
  const began = performance.now();
  const clientBegan = await page.evaluate(() => performance.now());
  const gestureEpoch = Date.now() / 1000;
  const wall = performance.now();
  await start(gestureEpoch);
  for (let i = 1; i <= 180; i++) {
    await page.waitForTimeout(Math.max(0, wall + i * (1000 / 30) - performance.now()));
    await move(i * 3, gestureEpoch + i / 30);
  }
  await end(gestureEpoch + 6.001);
  const ended = performance.now();
  const clientEnded = await page.evaluate(() => performance.now());
  await page.waitForTimeout(1500);
  const trace = await page.evaluate(() => JSON.parse(document.documentElement.dataset.bench!));
  const paints = trace.records.filter((r: any) => r.time >= clientBegan && r.time <= clientEnded);
  const changed = paints.filter((r: any, i: number) => i === 0 || r.mark !== paints[i - 1].mark);
  const quantile = (values: number[], q: number) =>
    [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];
  const downstream = bytes
    .filter((r) => r.time >= began && r.time <= ended)
    .reduce((n, r) => n + r.bytes, 0);
  const result = {
    label,
    trials,
    profile: { rttMs, downMbit },
    endpoint: "actual BrowserPopover + production routes/BrowserService/native touch",
    latencyEndpoint:
      "source pointermove event.timeStamp to matching canvas marker (same viewer monotonic clock)",
    inputTimeline:
      "explicit CDP epoch timestamps: sparse move at +80ms; 180 continuous moves at 30Hz over 6s",
    latencyMs: { p50: quantile(latency, 0.5), p95: quantile(latency, 0.95), samples: latency },
    continuous: {
      durationMs: ended - began,
      canvasFps: (paints.length * 1000) / (clientEnded - clientBegan),
      changedMarkerFps: (changed.length * 1000) / (clientEnded - clientBegan),
      downstreamBytes: downstream,
      downstreamMbit: (downstream * 8) / (ended - began) / 1000,
    },
    touchOperationMs: {
      p50: quantile(touchOperationMs, 0.5),
      p95: quantile(touchOperationMs, 0.95),
      samples: touchOperationMs.length,
    },
    geometry: await image.evaluate((canvas) => ({
      css: [(canvas as HTMLCanvasElement).clientWidth, (canvas as HTMLCanvasElement).clientHeight],
      pixels: [(canvas as HTMLCanvasElement).width, (canvas as HTMLCanvasElement).height],
    })),
    remote: await remote.evaluate(() => ({
      dpr: devicePixelRatio,
      width: innerWidth,
      height: innerHeight,
      scrollY,
    })),
    errors,
    wireFrames,
    responseStages,
    clockCorrelation: { clientToHostOffset, uncertaintyMs: (clockAfter - clockBefore) / 2 },
    trace,
    scrolls,
  };
  if (errors.length) throw Error(errors.join("\n"));
  const output = `/tmp/production-browser-${label}.json`;
  await fs.writeFile(output, JSON.stringify(result, null, 2));
  await page.screenshot({ path: `/tmp/production-browser-${label}.png` });
  console.log(
    JSON.stringify(
      { ...result, trace: undefined, scrolls: undefined, wireFrames: undefined, output },
      null,
      2,
    ),
  );
} catch (error) {
  failures.push(error);
} finally {
  for (const cleanup of cleanups.toReversed()) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
}
if (failures.length) throw new AggregateError(failures, "Browser benchmark failed");
