// Run after pnpm build. Exercises the production app shell and native browser storage.
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "patchright";
import mime from "mime-types";
import sharp from "sharp";
const preview = await sharp({
  create: { width: 768, height: 576, channels: 3, background: "teal" },
})
  .webp()
  .toBuffer();
const previewUrl = "/api/uploads/1/fixture/photo.png?preview=1";

const root = path.resolve("dist/client");
const now = Date.now();
const messages = Array.from({ length: 150 }, (_, i) => ({
  id: String(i + 1),
  role: "user",
  timestamp: now - (149 - i) * 600_000,
  blocks: [{ type: "text", text: i === 149 ? "Cached thread newest" : `History ${i + 1}` }],
}));
messages[149].blocks.push({
  type: "image",
  mimeType: "image/png",
  url: "/api/uploads/1/fixture/photo.png",
  previewUrl,
});
const requests = [];
const streams = new Set();
let revision = 1;
let delayBootstrap = 0;
const metadata = {
  id: "1",
  sessionId: "1",
  workspaceId: "roy",
  cwd: "/tmp",
  model: "fixture/model",
  modelLabel: "Fixture",
  thinkingLevel: "off",
  availableThinkingLevels: ["off"],
  activeTools: [],
  queuedPrompts: [],
  isStreaming: false,
  pendingMessageCount: 0,
  contextTokens: null,
  contextWindow: null,
  contextPercent: null,
  totalMessageCount: messages.length,
  hasMoreMessages: true,
  messagesDetailLevel: "full",
  streamId: "offline-fixture",
  updatedAt: now,
};
const state = (after) => ({
  ...metadata,
  totalMessageCount: messages.length,
  messages: after
    ? messages.filter((message) => Number(message.id) >= Number(after))
    : messages.slice(-120),
  revision: ++revision,
});
const json = (response, body) => {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
};
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  requests.push(url.pathname + url.search);
  if (url.pathname === "/api/bootstrap") {
    if (delayBootstrap) await new Promise((resolve) => setTimeout(resolve, delayBootstrap));
    return json(response, {
      authenticated: true,
      cacheScope: "offline-test-user",
      cacheExpiresAt: now + 86_400_000,
      auth: { passkeyCount: 1 },
      providerAuth: { providers: [] },
      settings: {
        appearance: { title: "Batty", color: "neutral" },
        braveSearchConfigured: false,
        pushTitle: "Roy",
        memoryModel: "fixture/model",
        memoryLanguage: "English",
        memoryReasoning: "low",
        defaultThinkingLevel: "off",
        defaultProvider: "fixture",
        defaultModel: "model",
      },
      models: [
        {
          id: "fixture/model",
          label: "Fixture",
          thinkingLevels: ["off"],
          supportsImages: true,
          reasoning: false,
          provider: "fixture",
        },
      ],
      workspaces: [],
      buildId: "dev",
    });
  }
  if (url.pathname === "/api/uploads/1/fixture/photo.png") {
    if (url.searchParams.has("delayed")) await new Promise((resolve) => setTimeout(resolve, 1500));
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "image/webp");
    return response.end(preview);
  }
  if (url.pathname === "/api/main") return json(response, state(url.searchParams.get("after")));
  if (url.pathname === "/api/main/messages") {
    const older = messages.filter(
      (message) => Number(message.id) < Number(url.searchParams.get("before")),
    );
    return json(response, {
      messages: older.slice(-500),
      totalMessageCount: messages.length,
      hasMoreMessages: false,
    });
  }
  if (url.pathname === "/api/main/events") {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
    response.write(
      `data: ${JSON.stringify({ type: "reset", state: state(url.searchParams.get("after")), streamId: metadata.streamId, revision })}\n\n`,
    );
    streams.add(response);
    request.on("close", () => streams.delete(response));
    return;
  }
  if (url.pathname === "/api/provider-usage")
    return json(response, { windows: [], provider: "fixture" });
  if (url.pathname === "/api/version") return json(response, { buildId: "dev" });
  if (url.pathname.startsWith("/api/")) return json(response, []);
  try {
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const content = await fs.readFile(path.join(root, file));
    response.setHeader("Content-Type", mime.lookup(file) || "application/octet-stream");
    response.end(content);
  } catch {
    response.statusCode = 404;
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [390, 1100]) {
    const context = await browser.newContext({ viewport: { width, height: 800 } });
    const page = await context.newPage();
    const debug = await context.newCDPSession(page);
    await debug.send("Runtime.enable");
    debug.on("Runtime.consoleAPICalled", (event) => {
      if (event.type === "error" || event.type === "warning")
        console.log("CONSOLE", event.args.map((arg) => arg.description ?? arg.value).join(" "));
    });
    page.on("pageerror", (error) => console.log("PAGE ERROR", error.message));
    await page.goto(url);
    await page
      .getByText("Cached thread newest", { exact: true })
      .waitFor({ timeout: 5000 })
      .catch(async (error) => {
        console.log(await page.locator("body").innerHTML());
        console.log("URL", page.url());
        console.log(requests.filter((request) => request.startsWith("/api/")));
        await page.screenshot({ path: "/tmp/batty2-offline-failure.png" });
        throw error;
      });
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    await page.waitForTimeout(1500);
    await page.evaluate(
      async (url) => {
        if (!(await fetch(url)).ok) throw new Error("Preview fetch failed");
      },
      previewUrl,
      undefined,
      false,
    );
    const populated = await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const r = indexedDB.open("batty-main-reading-v1");
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      const rows = await new Promise((resolve) => {
        const r = db.transaction("messages").objectStore("messages").getAll();
        r.onsuccess = () => resolve(r.result);
      });
      return {
        count: rows.length,
        bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
        oldest: Math.min(...rows.map((row) => row.timestamp)),
      };
    });
    console.log(
      "populated",
      populated,
      requests.filter((request) => request.startsWith("/api/")),
    );
    if (!populated.count) console.log(await page.locator("body").innerText());
    assert(populated.count >= 150);
    assert(populated.oldest <= now - 86_400_000);
    await context.setOffline(true);
    const started = Date.now();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText("Cached thread newest", { exact: true }).waitFor({ timeout: 5000 });
    const restoreMs = Date.now() - started;
    await page.locator("textarea").fill("An offline draft");
    assert(await page.getByRole("button", { name: "Send prompt", exact: true }).isDisabled());
    assert.equal(await page.getByText("Loading chat…", { exact: true }).count(), 0);
    assert(await page.evaluate(async (url) => (await fetch(url)).ok, previewUrl, undefined, false));
    await debug.send("ServiceWorker.enable");
    await debug.send("ServiceWorker.stopAllWorkers");
    assert(await page.evaluate(async (url) => (await fetch(url)).ok, previewUrl, undefined, false));
    // A changed overlap record and a gap created while offline must merge by stable ID.
    messages[149] = { ...messages[149], blocks: [{ type: "text", text: "Updated anchor" }] };
    messages.push({
      id: "151",
      role: "user",
      timestamp: Date.now(),
      blocks: [{ type: "text", text: "New after reconnect" }],
    });
    delayBootstrap = 3000;
    requests.length = 0;
    await context.setOffline(false);
    await page
      .getByText("New after reconnect", { exact: true })
      .waitFor({ timeout: 10_000 })
      .catch(async (error) => {
        console.log(
          "RECONNECT",
          await page.locator("body").innerText(),
          requests.filter((r) => r.startsWith("/api/")),
        );
        throw error;
      });
    assert(requests.some((request) => request.includes("/api/main?after=150")));
    assert.equal(await page.getByText("Updated anchor", { exact: true }).count(), 1);
    await page.screenshot({ path: `/tmp/batty2-offline-${width}.png` });
    console.log(
      JSON.stringify({
        width,
        restoreMs,
        cache: populated,
        deltaRequests: requests.filter((request) => request.startsWith("/api/main")),
      }),
    );
    await page.evaluate(
      (url) => {
        window.__pendingPreview = fetch(`${url}&delayed=1`).then((response) => response.status);
      },
      previewUrl,
      undefined,
      false,
    );
    await page.waitForTimeout(100);
    await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const channel = new MessageChannel();
          channel.port1.onmessage = (event) =>
            event.data.error ? reject(new Error(event.data.error)) : resolve();
          navigator.serviceWorker.controller.postMessage(
            { type: "clear-private-previews", cacheEpoch: "revoked-test" },
            [channel.port2],
          );
        }),
      undefined,
      undefined,
      false,
    );
    // An authorization queued with the old epoch must not restore permission after clearing.
    await page.evaluate(
      () =>
        navigator.serviceWorker.controller.postMessage({
          type: "authorize-private-previews",
          scope: "offline-test-user",
          expiresAt: Date.now() + 60_000,
          cacheEpoch: null,
        }),
      undefined,
      undefined,
      false,
    );
    assert.equal(
      await page.evaluate(() => window.__pendingPreview, undefined, undefined, false),
      401,
    );
    await page.evaluate(
      (url) => {
        window.__unadmittedPreview = fetch(`${url}&delayed=2`).then((response) => response.status);
      },
      previewUrl,
      undefined,
      false,
    );
    await page.waitForTimeout(100);
    await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const channel = new MessageChannel();
          channel.port1.onmessage = (event) =>
            event.data.error ? reject(new Error(event.data.error)) : resolve();
          navigator.serviceWorker.controller.postMessage(
            { type: "clear-private-previews", cacheEpoch: "revoked-again" },
            [channel.port2],
          );
        }),
      undefined,
      undefined,
      false,
    );
    assert.equal(
      await page.evaluate(() => window.__unadmittedPreview, undefined, undefined, false),
      401,
    );
    await debug.send("ServiceWorker.stopAllWorkers");
    await page.waitForFunction(
      async () =>
        !(await caches.keys()).some(
          (name) => name.startsWith("private-image-previews:") && !name.endsWith(":permissions"),
        ),
    );
    await context.setOffline(true);
    assert(
      await page.evaluate(async (url) => {
        try {
          await fetch(url);
          return false;
        } catch {
          return true;
        }
      }, previewUrl),
    );
    await context.close();
    delayBootstrap = 0;
    messages.splice(150);
    messages[149] = {
      ...messages[149],
      blocks: [
        { type: "text", text: "Cached thread newest" },
        {
          type: "image",
          mimeType: "image/png",
          url: "/api/uploads/1/fixture/photo.png",
          previewUrl,
        },
      ],
    };
  }
} finally {
  await browser.close();
  for (const stream of streams) stream.end();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
