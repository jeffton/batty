// @vitest-environment node
import { expect, test } from "vite-plus/test";
import http from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";

// Chrome can report an existing service worker without browserContextId on reconnect.
// Exercise the installed CDP client in a child: the upstream assertion kills its process.
test("CDP reconnect resumes and detaches context-less service workers without killing the host", async () => {
  let port = 0;
  const messages: Array<{ method: string; sessionId?: string }> = [];
  const server = http.createServer((_, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        Browser: "Chrome/157.0.0.0",
        "Protocol-Version": "1.3",
        "User-Agent": "Mozilla/5.0 Chrome/157.0.0.0",
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/mock`,
      }),
    );
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) => {
    socket.on("message", (data) => {
      const { id, method, sessionId } = JSON.parse(String(data));
      messages.push({ method, sessionId });
      let result = {};
      if (method === "Browser.getVersion")
        result = {
          product: "Chrome/157.0.0.0",
          userAgent: "Mozilla/5.0 Chrome/157.0.0.0",
          protocolVersion: "1.3",
          revision: "0",
          jsVersion: "0",
        };
      if (method === "Target.getBrowserContexts") result = { browserContextIds: [] };
      socket.send(JSON.stringify({ id, sessionId, result }));
      if (method === "Target.setAutoAttach" && !sessionId) {
        socket.send(
          JSON.stringify({
            method: "Target.attachedToTarget",
            params: {
              sessionId: "orphan-worker",
              waitingForDebugger: true,
              targetInfo: {
                targetId: "worker",
                type: "service_worker",
                title: "Worker",
                url: "https://example.test/service-worker.js",
                attached: true,
                canAccessOpener: false,
              },
            },
          }),
        );
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as { port: number }).port;
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { chromium } from 'patchright';
      const browser = await chromium.connectOverCDP('http://127.0.0.1:${port}');
      console.log('connected', browser.contexts().length);
      await browser.close();
    `,
      ],
      { cwd: process.cwd(), timeout: 10_000 },
    );
    expect(stdout).toContain("connected 1");
    expect(messages).toContainEqual({
      method: "Runtime.runIfWaitingForDebugger",
      sessionId: "orphan-worker",
    });
    expect(messages.some((message) => message.method === "Target.detachFromTarget")).toBe(true);
  } finally {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 15_000);
