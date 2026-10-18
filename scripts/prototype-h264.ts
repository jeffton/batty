import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import type { WebSocketServer as SocketServer } from "ws";
import { chromium } from "patchright";
import { webkit } from "playwright-core";
import sharp from "sharp";
import { CloudBrowserStreams } from "../src/server/cloud-browser-stream";
import { createCloudBrowserSocketWriter } from "../src/server/cloud-browser-events";
import type { BrowserService } from "../src/server/browser-service";

// Isolated Linux prototype. No production service, user profile or exposed listener.
const requireWebsocket = createRequire(import.meta.resolve("@fastify/websocket"));
const { WebSocketServer } = requireWebsocket("ws") as { WebSocketServer: typeof SocketServer };
const mode = process.env.PROTO_CODEC ?? "h264";
const rttMs = Number(process.env.BENCH_RTT_MS ?? 60);
const downMbit = Number(process.env.BENCH_DOWN_MBIT ?? 20);
const trials = Number(process.env.PROTO_TRIALS ?? 40);
const continuous = process.env.PROTO_WORKLOAD === "continuous";
if (!["h264", "jpeg"].includes(mode)) throw new Error("Invalid PROTO_CODEC");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-h264-"));
const now = () => performance.now();
const stats: Array<Record<string, unknown>> = [];
const children: ChildProcess[] = [];
const connections = new Set<net.Socket>();
const errorLog: string[] = [];
const targetHtml = `<!doctype html><meta name="viewport" content="width=device-width"><style>body{margin:0;font:16px Arial;line-height:1.5;background:#f2f5f8}p{padding:8px;margin:0;border-bottom:1px solid #ccc}#mark{position:fixed;top:0;left:0;width:24px;height:24px;z-index:3;background:rgb(16,16,16)}</style><div id="mark"></div>${Array.from({ length: 600 }, (_, i) => `<p>Row ${i}: Crisp browser text — æøå 0123456789</p>`).join("")}<script>window.n=0;window.records=[];window.trial=0;addEventListener('touchstart',()=>window.trial++,{passive:true});onscroll=()=>{const n=++window.n;window.records.push({mark:n,trial:window.trial,y:scrollY,time:performance.now()});document.documentElement.dataset.scrollRecords=JSON.stringify(window.records);document.querySelector('#mark').style.background='rgb('+[n%8,Math.floor(n/8)%8,Math.floor(n/64)%8].map(x=>16+x*32).join(',')+')'}</script>`;
const viewerHtml = (
  await fs.readFile(new URL("./prototype-h264-viewer.html", import.meta.url), "utf8")
).replaceAll("__CODEC__", mode);
const server = http.createServer((request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(
    request.url === "/target"
      ? targetHtml
      : request.url === "/support"
        ? "<!doctype html><title>Codec probe</title>"
        : viewerHtml,
  );
});
server.on("connection", (socket) => {
  connections.add(socket);
  socket.on("close", () => connections.delete(socket));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = (server.address() as net.AddressInfo).port;
const ws = new WebSocketServer({ noServer: true });
const relayRecords: Array<{ time: number; bytes: number; direction: string }> = [];
const relay = net.createServer((client) => {
  const upstream = net.connect(port, "127.0.0.1");
  for (const socket of [client, upstream]) {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.on("error", () => {});
  }
  function forward(from: net.Socket, to: net.Socket, rate: number, direction: string) {
    let next = 0;
    const pending: Array<{ at: number; data: Buffer }> = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      while (pending.length && pending[0]!.at <= now()) {
        const item = pending.shift()!;
        if (!to.destroyed) {
          relayRecords.push({ time: now(), bytes: item.data.length, direction });
          to.write(item.data);
        }
      }
      if (pending.length) timer = setTimeout(flush, Math.max(0, pending[0]!.at - now()));
    };
    from.on("data", (data: Buffer) => {
      const received = now();
      next = Math.max(received + rttMs / 2, next) + (data.length / rate) * 1000;
      pending.push({ at: next, data });
      if (!timer) timer = setTimeout(flush, Math.max(0, next - now()));
    });
    to.on("close", () => {
      if (timer) clearTimeout(timer);
      pending.length = 0;
    });
  }
  forward(client, upstream, 1_250_000_000, "up");
  forward(upstream, client, (downMbit * 1_000_000) / 8, "down");
});
relay.listen(0, "127.0.0.1");
await once(relay, "listening");
const viewerOrigin = `http://127.0.0.1:${(relay.address() as net.AddressInfo).port}`;
server.on("upgrade", (request, socket, head) => {
  if (request.url !== "/socket" || request.headers.origin !== viewerOrigin) {
    socket.destroy();
    return;
  }
  ws.handleUpgrade(request, socket, head, (client) => ws.emit("connection", client, request));
});
let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
let viewer: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let streams: CloudBrowserStreams | undefined;
let safari: Awaited<ReturnType<typeof webkit.launch>> | undefined;
let drainInput = async () => {};
const stopping = new Map<ChildProcess, Promise<void>>();
function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  if (stopping.has(child)) return stopping.get(child)!;
  const ended = once(child, "exit").then(() => {});
  stopping.set(child, ended);
  child.kill("SIGTERM");
  return ended;
}
try {
  // Xvfb chooses a free display; it never attaches to the host's desktop.
  const xvfb = spawn(
    "Xvfb",
    ["-displayfd", "1", "-screen", "0", "1074x2271x24", "-nolisten", "tcp"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(xvfb);
  xvfb.stderr!.on("data", (data) => errorLog.push(String(data)));
  const display = await new Promise<string>((resolve, reject) => {
    xvfb.stdout!.once("data", (data) => resolve(`:${String(data).trim()}`));
    xvfb.once("error", reject);
  });
  context = await chromium.launchPersistentContext(path.join(root, "profile"), {
    headless: false,
    ignoreDefaultArgs: ["--enable-automation", "about:blank"],
    viewport: null,
    env: { ...process.env, DISPLAY: display },
    args: [
      "--force-device-scale-factor=3",
      "--kiosk",
      `--app=http://127.0.0.1:${port}/target`,
      "--window-position=0,0",
      "--window-size=358,757",
    ],
  });
  const target = context.pages()[0]!;
  await target.bringToFront();
  await target.goto(`http://127.0.0.1:${port}/target`);
  const cdp = await context.newCDPSession(target);
  const { windowId } = await cdp.send("Browser.getWindowForTarget");
  await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "fullscreen" } });
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 358,
    height: 757,
    deviceScaleFactor: 3,
    mobile: true,
  });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  const dimensions = await target.evaluate(() => ({
    inner: [innerWidth, innerHeight],
    screen: [screen.width, screen.height],
    dpr: devicePixelRatio,
  }));
  if (dimensions.inner[0] !== 358 || dimensions.inner[1] !== 757)
    throw Error(`Wrong viewport: ${JSON.stringify(dimensions)}`);
  let frameId = 0;
  let codec = "";
  let firstKeyframe: Buffer | undefined;
  const sentVideo: Buffer[] = [];
  let encoder: ChildProcess | undefined;
  let unsubscribe: (() => void) | undefined;
  const view = {
    pageId: "prototype",
    revision: "1",
    width: 358,
    height: 757,
    mobile: true,
    deviceScaleFactor: 3,
  };
  if (mode === "jpeg") {
    const create = context.newCDPSession.bind(context);
    context.newCDPSession = async (...args) => {
      const connection = await create(...args);
      connection.on("Page.screencastFrame", (event) =>
        stats.push({ stage: "jpeg-capture", time: now(), metadata: event.metadata }),
      );
      return connection;
    };
  }
  const adapter = {
    cloudTarget: async () => ({
      page: target,
      state: { ...view, pages: [], url: target.url(), title: "Fixture" },
    }),
    cloudCaptureTarget: async () => ({ page: target, state: view }),
    cloudState: async () => ({ ...view, pages: [], url: target.url(), title: "Fixture" }),
  } as unknown as BrowserService;
  streams = new CloudBrowserStreams(adapter);
  ws.on("connection", (client) => {
    const writer = createCloudBrowserSocketWriter(client);
    let inputQueue = Promise.resolve();
    let processing = false;
    let gestureStartedAt = 0;
    type Touch = {
      phase: "start" | "move" | "end" | "cancel";
      x: number;
      y: number;
      elapsedMs: number;
      inputId: number;
      trial: number;
    };
    const pendingInputs: Touch[] = [];
    drainInput = async () => {
      await inputQueue;
    };
    const runInput = () => {
      if (processing) return;
      processing = true;
      inputQueue = (async () => {
        try {
          while (pendingInputs.length) {
            const command = pendingInputs.shift()!;
            if (command.phase === "start") gestureStartedAt = Date.now() - command.elapsedMs;
            stats.push({ stage: "input-dispatch", time: now(), inputId: command.inputId });
            await cdp.send("Input.dispatchTouchEvent", {
              type: {
                start: "touchStart",
                move: "touchMove",
                end: "touchEnd",
                cancel: "touchCancel",
              }[command.phase],
              touchPoints:
                command.phase === "end" || command.phase === "cancel"
                  ? []
                  : [{ x: command.x, y: command.y, id: 1, radiusX: 1, radiusY: 1, force: 0.5 }],
              timestamp: (gestureStartedAt + command.elapsedMs) / 1000,
            });
            if (mode === "jpeg")
              streams!.scrolling(
                "prototype",
                command.phase === "start" || command.phase === "move",
              );
          }
        } finally {
          processing = false;
        }
      })();
      void inputQueue.catch((error) => client.send(JSON.stringify({ error: String(error) })));
    };
    client.on("message", (data) => {
      const command = JSON.parse(data.toString());
      if (command.action === "ack") {
        if (mode === "jpeg") writer.acknowledge(command.frameId);
        return;
      }
      if (command.action !== "touch") throw Error("Unexpected command");
      stats.push({ stage: "input-receive", time: now(), ...command });
      const last = pendingInputs.at(-1);
      if (command.phase === "move" && last?.phase === "move")
        pendingInputs[pendingInputs.length - 1] = command;
      else {
        if (pendingInputs.length >= 64) throw Error("Prototype input queue full");
        pendingInputs.push(command);
      }
      runInput();
    });
    if (mode === "jpeg") {
      void streams!.subscribe("prototype", writer.send).then((stop) => (unsubscribe = stop));
    } else {
      // x11grab -> scale -> x264 zerolatency. AUDs delimit complete access units.
      encoder = spawn(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "warning",
          "-f",
          "x11grab",
          "-draw_mouse",
          "0",
          "-video_size",
          "1074x2271",
          "-framerate",
          "30",
          "-i",
          display + "+0,0",
          "-vf",
          "scale=716:1514:flags=bilinear:out_color_matrix=bt709",
          "-an",
          "-c:v",
          "libx264",
          "-threads",
          "2",
          "-preset",
          "ultrafast",
          "-tune",
          "zerolatency",
          "-profile:v",
          "baseline",
          "-pix_fmt",
          "yuv420p",
          "-colorspace",
          "bt709",
          "-color_primaries",
          "bt709",
          "-color_trc",
          "bt709",
          "-color_range",
          "tv",
          "-crf",
          "18",
          "-g",
          "60",
          "-bf",
          "0",
          "-x264-params",
          "repeat-headers=1:aud=1",
          "-flush_packets",
          "1",
          "-f",
          "h264",
          "pipe:1",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      children.push(encoder);
      encoder.stderr!.on("data", (data) => errorLog.push(String(data)));
      let pending = Buffer.alloc(0),
        unit: Buffer[] = [],
        key = false;
      const deliver = () => {
        if (!unit.length) return;
        const payload = Buffer.concat(unit);
        sentVideo.push(payload);
        unit = [];
        if (key && !firstKeyframe) firstKeyframe = payload;
        if (!codec) throw Error("Missing SPS");
        if (client.bufferedAmount > 1_000_000) throw Error("Prototype video transport congested");
        const meta = Buffer.from(JSON.stringify({ frameId: ++frameId, key, codec }));
        const header = Buffer.alloc(4);
        header.writeUInt32BE(meta.length);
        client.send(Buffer.concat([header, meta, payload]));
        stats.push({ stage: "video-send", time: now(), frameId, bytes: payload.length, key });
        key = false;
      };
      const nal = (data: Buffer) => {
        const start = data[2] === 1 ? 3 : 4;
        const type = data[start]! & 31;
        if (type === 9) deliver();
        if (type === 7) codec = "avc1." + data.subarray(start + 1, start + 4).toString("hex");
        if (type === 5) key = true;
        unit.push(data);
      };
      encoder.stdout!.on("data", (data: Buffer) => {
        pending = Buffer.concat([pending, data]);
        const starts: number[] = [];
        for (let i = 0; i < pending.length - 3; i++) {
          if (
            pending[i] === 0 &&
            pending[i + 1] === 0 &&
            (pending[i + 2] === 1 || (pending[i + 2] === 0 && pending[i + 3] === 1))
          ) {
            starts.push(i);
            i += pending[i + 2] === 1 ? 2 : 3;
          }
        }
        for (let i = 0; i < starts.length - 1; i++) nal(pending.subarray(starts[i], starts[i + 1]));
        if (starts.length) pending = pending.subarray(starts.at(-1));
      });
    }
    client.on("close", (code, reason) => {
      stats.push({ stage: "socket-close", time: now(), code, reason: reason.toString() });
      unsubscribe?.();
      writer.close();
      if (encoder) void stop(encoder);
    });
  });
  viewer = await chromium.launch({
    headless: true,
    args: ["--disable-features=LocalNetworkAccessChecks"],
  });
  const page = await viewer.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  page.on("pageerror", (error) => errorLog.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errorLog.push(message.text());
  });
  await page.goto(viewerOrigin);
  await page
    .waitForFunction(() => !!document.querySelector("canvas[data-frame]"))
    .catch(async (error) => {
      await page.addScriptTag({
        content:
          "document.documentElement.dataset.debug=JSON.stringify({failure:window.failure,trace:window.trace,codecSupport:window.codecSupport})",
      });
      console.error({
        errorLog,
        dimensions,
        root,
        stats: JSON.stringify(stats.slice(0, 2)),
        body: await page.locator("body").innerText(),
        debug: await page.locator("html").getAttribute("data-debug"),
      });
      await target.screenshot({ path: path.join(root, "debug-target.png") });
      throw error;
    });
  // Match viewer events and pixel markers on one viewer monotonic clock; no wall-clock subtraction.
  const canvas = page.locator("canvas");
  const bounds = (await canvas.boundingBox())!;
  const touch = await page.context().newCDPSession(page);
  const cpuBefore = process.cpuUsage();
  const began = now();
  const procCpu = async () => {
    const rows = await fs.readdir("/proc");
    let ticks = 0;
    const parents = new Set<number>([process.pid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const name of rows) {
        if (!/^\d+$/.test(name)) continue;
        try {
          const s = await fs.readFile(`/proc/${name}/stat`, "utf8");
          const fields = s.slice(s.lastIndexOf(")") + 2).split(" ");
          if (parents.has(Number(fields[1])) && !parents.has(Number(name))) {
            parents.add(Number(name));
            changed = true;
          }
        } catch {}
      }
    }
    for (const pid of parents) {
      try {
        const s = await fs.readFile(`/proc/${pid}/stat`, "utf8");
        const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
        ticks += Number(f[11]) + Number(f[12]);
      } catch {}
    }
    return ticks;
  };
  const startTicks = await procCpu();
  if (continuous) {
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: bounds.x + 200, y: bounds.y + 737 }],
    });
    for (let i = 1; i <= 240; i++) {
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: bounds.x + 200, y: bounds.y + 737 - i * 3 }],
      });
      const wait = began + i * 33 - now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else
    for (let trial = 0; trial < trials; trial++) {
      const x = bounds.x + 50 + trial * 4,
        y = bounds.y + 717;
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: y - 80 }],
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  const ended = now();
  const endTicks = await procCpu();
  const cpu = process.cpuUsage(cpuBefore);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const client = await page.evaluate(() => ({
    trace: (window as unknown as { trace: unknown[] }).trace,
    inputs: (window as unknown as { inputs: unknown[] }).inputs,
    failure: (window as unknown as { failure: string }).failure,
    codecSupport: (window as unknown as { codecSupport: unknown }).codecSupport,
  }));
  // Patchright worlds share DOM, not globals: obtain main-world data through a DOM snapshot.
  await page.addScriptTag({
    content:
      "document.documentElement.dataset.result=JSON.stringify({trace:window.trace,inputs:window.inputs,failure:window.failure,codecSupport:window.codecSupport})",
  });
  Object.assign(
    client,
    await page.evaluate(() => JSON.parse(document.documentElement.dataset.result!)),
  );
  if (mode === "h264")
    await fs.writeFile(path.join(root, "recording.h264"), Buffer.concat(sentVideo));
  if (client.failure) {
    await fs.writeFile(
      path.join(root, "failure.json"),
      JSON.stringify({ client, stats, errorLog }),
    );
    throw Error(client.failure + "; diagnostics " + root);
  }
  const scrolls = JSON.parse(
    (await target.locator("html").getAttribute("data-scroll-records")) ?? "[]",
  );
  // Quality sample after timing: both codecs at DPR2, same settled image, no status overlay.
  await drainInput();
  let stable = 0;
  let previousY = -1;
  for (let i = 0; i < 50 && stable < 5; i++) {
    const y = await target.evaluate(() => scrollY);
    stable = y === previousY ? stable + 1 : 0;
    previousY = y;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (stable < 5) throw Error("Quality reference did not settle");
  if (mode === "jpeg") {
    streams.scrolling("prototype", true);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const qualityRecords = JSON.parse(
    (await target.locator("html").getAttribute("data-scroll-records")) ?? "[]",
  );
  const qualityMark = qualityRecords.at(-1)?.mark ?? 0;
  await page.waitForFunction(
    (expected) => document.querySelector("canvas")?.getAttribute("data-mark") === String(expected),
    qualityMark,
  );
  await page.addScriptTag({
    content:
      "document.documentElement.dataset.canvasPng=document.querySelector('canvas').toDataURL('image/png')",
  });
  const reconstructed = Buffer.from(
    (await page.locator("html").getAttribute("data-canvas-png"))!.split(",")[1]!,
    "base64",
  );
  await fs.writeFile(path.join(root, "decoded.png"), reconstructed);
  const screenshot = await page.screenshot({ path: path.join(root, "viewer.png") });
  const referenceCapture = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "x11grab",
      "-video_size",
      "1074x2271",
      "-i",
      display + "+0,0",
      "-frames:v",
      "1",
      "-c:v",
      "png",
      "-f",
      "image2pipe",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(referenceCapture);
  const referenceChunks: Buffer[] = [];
  referenceCapture.stdout!.on("data", (data) => referenceChunks.push(data));
  referenceCapture.stderr!.on("data", (data) => errorLog.push(String(data)));
  const [referenceCode] = await once(referenceCapture, "exit");
  if (referenceCode !== 0) throw Error("Native reference capture failed");
  const remote = Buffer.concat(referenceChunks);
  await fs.writeFile(path.join(root, "target.png"), remote);
  const reference = await sharp(remote)
    .resize(716, 1514, { kernel: "linear" })
    .removeAlpha()
    .raw()
    .toBuffer();
  const decoded = await sharp(reconstructed).removeAlpha().raw().toBuffer();
  if (reference.length !== decoded.length) throw Error("Quality sample geometry mismatch");
  let squaredError = 0;
  for (let i = 0; i < reference.length; i++) squaredError += (reference[i]! - decoded[i]!) ** 2;
  const psnrDb = 10 * Math.log10(255 ** 2 / (squaredError / reference.length));
  // Browser-engine support probe, not a claim of physical iPhone validation.
  safari = await webkit.launch({ headless: true });
  const safariPage = await safari.newPage();
  await safariPage.goto(viewerOrigin + "/support");
  await safariPage.evaluate("globalThis.__name = value => value");
  const safariSupport = await safariPage.evaluate(async () => ({
    userAgent: navigator.userAgent,
    decoder: typeof VideoDecoder,
    supported:
      typeof VideoDecoder !== "undefined"
        ? await VideoDecoder.isConfigSupported({ codec: "avc1.42c020", optimizeForLatency: true })
        : null,
  }));
  let safariDecoded: unknown = null;
  if (mode === "h264") {
    await fs.writeFile(path.join(root, "keyframe.h264"), firstKeyframe!);
    safariDecoded = await safariPage.evaluate(
      async ({ base64, codec }) => {
        const data = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        return await new Promise((resolve, reject) => {
          const decoder = new VideoDecoder({
            error: reject,
            output: (frame) => {
              const canvas = document.createElement("canvas");
              canvas.width = frame.displayWidth;
              canvas.height = frame.displayHeight;
              const context = canvas.getContext("2d")!;
              context.drawImage(frame, 0, 0);
              const pixel = [...context.getImageData(6, 6, 1, 1).data];
              resolve({ width: frame.displayWidth, height: frame.displayHeight, pixel });
              frame.close();
              decoder.close();
            },
          });
          decoder.configure({ codec, optimizeForLatency: true });
          decoder.decode(new EncodedVideoChunk({ type: "key", timestamp: 0, data }));
        });
      },
      { base64: firstKeyframe!.toString("base64"), codec },
    );
  }
  await safari.close();
  safari = undefined;
  const result = {
    psnrDb,
    mode,
    profile: { rttMs, downMbit },
    continuous,
    trials,
    dimensions,
    began,
    ended,
    cpuNodeMicroseconds: cpu,
    cpuTreeCorePercent: (((endTicks - startTicks) * 10) / (ended - began)) * 100,
    stats,
    relayRecords,
    client,
    scrolls,
    safariSupport,
    safariDecoded,
    errorLog,
    root,
    screenshotBytes: screenshot.length,
  };
  const filename = `/tmp/h264-prototype-${process.env.PROTO_LABEL ?? mode}.json`;
  await fs.writeFile(filename, JSON.stringify(result));
  console.log(filename);
  console.log(root);
} finally {
  await safari?.close();
  await viewer?.close();
  await streams?.close();
  await context?.close();
  await fs.rm(path.join(root, "profile"), { recursive: true, force: true });
  for (const child of [...children].reverse()) await stop(child);
  ws.close();
  for (const connection of connections) connection.destroy();
  await new Promise<void>((resolve) => relay.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
