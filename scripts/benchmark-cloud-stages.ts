import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { createHash } from "node:crypto";
import fastify from "fastify";
import vue from "@vitejs/plugin-vue";
import { chromium, type Page, type CDPSession } from "patchright";
import { createRequire } from "node:module";
import type { WebSocket as Socket } from "ws";
const requireWebsocket = createRequire(import.meta.resolve("@fastify/websocket"));
const { WebSocket } = requireWebsocket("ws") as { WebSocket: typeof Socket };
import sharp from "sharp";
import { BrowserService } from "../src/server/browser-service";
import { CloudBrowserStreams } from "../src/server/cloud-browser-stream";
import { registerCloudBrowserRoutes } from "../src/server/routes/cloud-browser";
import {
  closeBrowserFixtureServer,
  createBrowserFixtureServer,
} from "../src/client/test/browser-fixture";

// Historical JPEG instrumentation must run in the isolated 470668d worktree.
if (
  !(
    await fs.readFile(new URL("../src/server/cloud-browser-stream.ts", import.meta.url), "utf8")
  ).includes("Page.startScreencast")
)
  throw new Error(
    "Historical JPEG harness: run from a 470668d worktree. For current production use scripts/benchmark-production-browser.ts; see docs/cloud-browser-performance.md.",
  );

// Isolated benchmark only: no production trace hooks or active user sessions.
const rttMs = Number(process.env.BENCH_RTT_MS ?? 60);
const downMbit = Number(process.env.BENCH_DOWN_MBIT ?? 20);
const workload = process.env.BENCH_WORKLOAD ?? "continuous";
if (!["continuous", "settled"].includes(workload)) throw new Error("Invalid BENCH_WORKLOAD");
const commandIds = new Map<string, number>();
let activeCommandId: number | undefined;
const commandId = (command: unknown) => commandIds.get(JSON.stringify(command));
const now = () => performance.now();
const traces: Array<Record<string, unknown>> = [];
const trace = (stage: string, data: Record<string, unknown> = {}) =>
  traces.push({ stage, time: now(), ...data });
CloudBrowserStreams.prototype.scrolling = () => {}; // Constant DPR3/JPEG85, no capture restarts.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-stages-"));
const service = new BrowserService(undefined, 4, root);
const inputPage = Reflect.get(service, "cloudInputPage").bind(service);
Reflect.set(service, "cloudInputPage", (...args: unknown[]) => {
  trace("service-guard", { command: args[1], commandId: commandId(args[1]) });
  return inputPage(...args);
});
const dispatch = service.cloudTouch.bind(service);
service.cloudTouch = async (id, command, owner) => {
  trace("operation-start", { command, commandId: commandId(command) });
  activeCommandId = commandId(command);
  try {
    await dispatch(id, command, owner);
    trace("operation-end", { command, commandId: commandId(command) });
  } finally {
    activeCommandId = undefined;
  }
};
const backend = fastify();
backend.get("/target", (_request, reply) =>
  reply.type("text/html").send(`<!doctype html>
<meta name="viewport" content="width=device-width"><style>body{margin:0;font:16px Arial;line-height:1.5;background:#f2f5f8}p{padding:8px;margin:0;border-bottom:1px solid #ccc}#mark{position:fixed;top:0;left:0;width:24px;height:24px;z-index:3;background:rgb(16,16,16)}</style>
<div id="mark"></div>${Array.from({ length: 600 }, (_, i) => `<p>Row ${i}: Crisp browser text — æøå 0123456789</p>`).join("")}
<script>window.n=0;window.scrollRecords=[];window.inputY=null;window.trial=0;
addEventListener('touchstart',()=>{window.trial++;window.inputY=null},{passive:true});
addEventListener('touchmove',e=>{window.inputY=Math.round(e.touches[0].clientY)},{passive:true});
onscroll=()=>{const n=++window.n;window.scrollRecords.push({mark:n,trial:window.trial,y:scrollY,inputY:window.inputY,time:performance.now()});document.querySelector('#mark').style.background='rgb('+[n%8,Math.floor(n/8)%8,Math.floor(n/64)%8].map(x=>16+x*32).join(',')+')'};</script>`),
);
const reservation = net.createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const port = (reservation.address() as net.AddressInfo).port;
await new Promise<void>((resolve) => reservation.close(() => resolve()));
const originalEmit = WebSocket.prototype.emit;
const originalSend = WebSocket.prototype.send;
WebSocket.prototype.emit = function (event, ...args) {
  if (event === "message" && Reflect.get(this, "_socket")?.localPort === port && !args[1]) {
    const command = JSON.parse(String(args[0]));
    if (command.action === "touch") {
      const id = commandIds.size + 1;
      const key = JSON.stringify(command);
      if (commandIds.has(key)) throw new Error("Non-unique benchmark command");
      commandIds.set(key, id);
      trace("server-receive", { command, commandId: id });
    }
  }
  return originalEmit.call(this, event, ...args);
};
WebSocket.prototype.send = function (...args: Parameters<typeof originalSend>) {
  if (Reflect.get(this, "_socket")?.localPort === port && Buffer.isBuffer(args[0])) {
    const data = args[0];
    const length = data.readUInt32BE(0);
    const metadata = JSON.parse(data.subarray(4, 4 + length).toString());
    trace("ws-send", {
      frameId: metadata.frameId,
      bytes: data.length,
      buffered: this.bufferedAmount,
      hash: createHash("sha256")
        .update(data.subarray(4 + length))
        .digest("hex"),
    });
  }
  return originalSend.apply(this, args);
};
const sockets = new Set<net.Socket>();
const relayRecords: Array<{
  direction: string;
  received: number;
  released: number;
  bytes: number;
}> = [];
const relay = net.createServer((client) => {
  const upstream = net.connect(port, "127.0.0.1");
  for (const socket of [client, upstream]) {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  }
  const forward = (from: net.Socket, to: net.Socket, rate: number, direction: string) => {
    let next = 0;
    from.on("data", (data: Buffer) => {
      const received = now();
      next = Math.max(received + rttMs / 2, next) + (data.length / rate) * 1000;
      setTimeout(
        () => {
          if (!to.destroyed) {
            relayRecords.push({ direction, received, released: now(), bytes: data.length });
            to.write(data);
          }
        },
        Math.max(0, next - received),
      );
    });
    from.on("end", () => setTimeout(() => to.end(), Math.max(0, next - now()) + 1));
  };
  forward(client, upstream, 1_250_000_000, "up");
  forward(upstream, client, (downMbit * 1_000_000) / 8, "down");
});
relay.listen(0, "127.0.0.1");
await once(relay, "listening");
let id = "";
const clientTrace = `(globalThis as unknown as { __trace: Array<Record<string, unknown>> }).__trace`;
const server = await createBrowserFixtureServer(
  "src/client/components/BrowserPopover.fixture.html",
  {
    plugins: [
      {
        name: "benchmark-stage-probes",
        enforce: "pre",
        transform(source, filename) {
          if (!filename.endsWith("/client/browser/frames.ts")) return;
          const replace = (input: string, from: string, to: string) => {
            if (input.split(from).length !== 2)
              throw new Error(`Stage probe must match once: ${from}`);
            return input.replace(from, to);
          };
          let result = source;
          const substitutions = [
            [
              "const frame = JSON.parse(",
              `const received = performance.now();\nconst frame = JSON.parse(`,
            ],
            [
              "if (pendingFrame) acknowledge",
              `${clientTrace}.push({stage:'client-receive',time:received,frameId:frame.frameId,bytes:data.byteLength});\nif (pendingFrame) acknowledge`,
            ],
            [
              "const bitmap = await createImageBitmap(next.jpeg);",
              `${clientTrace}.push({stage:'decode-start',time:performance.now(),frameId:next.frame.frameId});\nconst bitmap = await createImageBitmap(next.jpeg);\n${clientTrace}.push({stage:'decode-end',time:performance.now(),frameId:next.frame.frameId});`,
            ],
            [
              "canvas.dataset.frame = String(next.frame.frameId);",
              `canvas.dataset.frame = String(next.frame.frameId);\n${clientTrace}.push({stage:'paint',time:performance.now(),frameId:next.frame.frameId});`,
            ],
          ];
          for (const [from, to] of substitutions) result = replace(result, from!, to!);
          return result;
        },
      },
      vue(),
    ],
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
await backend.listen({ host: "127.0.0.1", port });
const viewer = await chromium.launch({
  headless: true,
  args: ["--disable-features=LocalNetworkAccessChecks"],
});
const captures: Array<{
  captureId: number;
  time: number;
  data: string;
  mark?: number;
  hash: string;
}> = [];
async function clock(page: Page) {
  const samples = [];
  for (let i = 0; i < 25; i++) {
    const before = now();
    const remote = await page.evaluate(() => performance.now());
    const after = now();
    samples.push({ offset: (before + after) / 2 - remote, uncertainty: (after - before) / 2 });
  }
  return samples.sort((a, b) => a.uncertainty - b.uncertainty)[0]!;
}
try {
  await service.execute("stage-benchmark", {
    action: "open",
    url: `http://127.0.0.1:${port}/target`,
    cloud: true,
  });
  id = (await service.execute("stage-benchmark", { action: "attach" })).details.sites![0]!
    .browserId!;
  const target = await service.cloudTarget(id);
  const session = Reflect.get(service, "sessions").get("stage-benchmark");
  const touchCDP: CDPSession = session.pageEmulation.get(target.page);
  const send = touchCDP.send.bind(touchCDP);
  touchCDP.send = async (...args: Parameters<typeof send>) => {
    if (args[0] === "Input.dispatchTouchEvent")
      trace("cdp-dispatch", { params: args[1], commandId: activeCommandId });
    const result = await send(...args);
    if (args[0] === "Input.dispatchTouchEvent")
      trace("cdp-ack", { params: args[1], commandId: activeCommandId });
    return result;
  };
  const context = target.page.context();
  const createCDP = context.newCDPSession.bind(context);
  context.newCDPSession = async (...args) => {
    const connection = await createCDP(...args);
    connection.on("Page.screencastFrame", (event) =>
      captures.push({
        captureId: captures.length + 1,
        time: now(),
        data: event.data,
        hash: createHash("sha256").update(Buffer.from(event.data, "base64")).digest("hex"),
      }),
    );
    return connection;
  };
  const page = await viewer.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  page.on("pageerror", (error) => console.error(error));
  await page.goto(
    `${server.resolvedUrls!.local[0]}src/client/components/BrowserPopover.fixture.html`,
  );
  await page.evaluate("globalThis.__name = value => value");
  const install = () => {
    const scope = globalThis as unknown as { __trace: Array<Record<string, unknown>> };
    scope.__trace = [];
    let inputId = 0;
    let trial = 0;
    for (const event of ["pointerdown", "pointermove", "pointerup"])
      document.addEventListener(
        event,
        (e) => {
          if ((e.target as Element).classList.contains("cloud-browser__image")) {
            inputId++;
            if (event === "pointerdown") trial++;
            scope.__trace.push({
              stage: "input",
              time: performance.now(),
              inputId,
              trial,
              y: (e as PointerEvent).clientY,
            });
          }
        },
        true,
      );
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === "string") {
        const command = JSON.parse(data);
        if (command.action === "touch")
          scope.__trace.push({
            stage: "client-send",
            time: performance.now(),
            inputId,
            trial,
            command,
            buffered: this.bufferedAmount,
          });
      }
      return send.call(this, data);
    };
  };
  await page.addScriptTag({
    content: `globalThis.__name = value => value; (${install.toString()})();`,
  });
  await page.getByRole("button", { name: "Open browser", exact: true }).click();
  const image = page.locator(".cloud-browser__image");
  await image.waitFor();
  await page.waitForFunction(() => !!document.querySelector("canvas[data-frame]"));
  const viewerClock = await clock(page);
  const remoteClock = await clock(target.page);
  await new Promise((resolve) => setTimeout(resolve, 600));
  const bounds = (await image.boundingBox())!;
  const touch = await page.context().newCDPSession(page);
  const began = now();
  if (workload === "continuous") {
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: bounds.x + 200, y: bounds.y + bounds.height - 20 }],
    });
    // Eight-second drag: continuous workload associations are not causal per-move latencies.
    for (let i = 1; i <= 240; i++) {
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: bounds.x + 200, y: bounds.y + bounds.height - 20 - i * 3 }],
      });
      const remaining = began + i * 33 - now();
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    }
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else {
    // One move per settled trial: no ambiguity about which move produced the first scroll marker.
    for (let trial = 0; trial < 40; trial++) {
      const x = bounds.x + 50 + trial * 4;
      const y = bounds.y + bounds.height - 40;
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
  }
  const lifted = now();
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const endViewerClock = await clock(page);
  const endRemoteClock = await clock(target.page);
  await page.addScriptTag({
    content: "document.documentElement.dataset.stageTrace = JSON.stringify(globalThis.__trace)",
  });
  const client = await page.evaluate(() =>
    JSON.parse(document.documentElement.dataset.stageTrace!),
  );
  await target.page.addScriptTag({
    content: "document.documentElement.dataset.stageScrolls = JSON.stringify(window.scrollRecords)",
  });
  const scrolls = await target.page.evaluate(() =>
    JSON.parse(document.documentElement.dataset.stageScrolls!),
  );
  // Decode offline, after the timed drag, so JPEG inspection cannot stall capture.
  for (const frame of captures) {
    const { data } = await sharp(Buffer.from(frame.data, "base64"))
      .extract({ left: 6, top: 6, width: 1, height: 1 })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    frame.mark = [...data]
      .slice(0, 3)
      .map((x) => Math.round((x - 16) / 32))
      .reduce((n, x, i) => n + x * 8 ** i, 0);
    frame.data = "";
  }
  const output = {
    profile: { rttMs, downMbit, constantCapture: true, workload },
    clocks: { viewerClock, remoteClock, endViewerClock, endRemoteClock },
    began,
    lifted,
    traces,
    client,
    scrolls,
    captures,
    relayRecords,
  };
  const filename = `/tmp/cloud-stages-${process.env.BENCH_LABEL ?? "current"}.json`;
  await fs.writeFile(filename, JSON.stringify(output));
  console.log(filename);
} finally {
  WebSocket.prototype.emit = originalEmit;
  WebSocket.prototype.send = originalSend;
  await viewer.close();
  await closeStreams();
  await service.closeSession("stage-benchmark");
  await service.dispose();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => relay.close(() => resolve()));
  await closeBrowserFixtureServer(server);
  await backend.close();
  await fs.rm(root, { recursive: true, force: true });
}
