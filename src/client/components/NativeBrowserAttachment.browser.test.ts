// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import fastify from "fastify";
import vue from "@vitejs/plugin-vue";
import { chromium } from "patchright";
import { expect, test, vi } from "vite-plus/test";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "@/server/config";
import { Runtime, context } from "@/server/runtime";
import { registerSessionRoutes } from "@/server/routes/sessions";
import { registerCloudBrowserRoutes } from "@/server/routes/cloud-browser";
import { TranscriptImages } from "@/server/transcript-images";
import { closeBrowserFixtureServer, createBrowserFixtureServer } from "../test/browser-fixture";

test("main browser tools render a live attachment through SSE, reload and reopened durable history", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-native-browser-"));
  vi.stubEnv("PI_OFFLINE", "1");
  await fs.mkdir(path.join(root, ".batty"));
  await fs.mkdir(path.join(root, "work"));
  await fs.writeFile(
    path.join(root, ".batty/options.json"),
    JSON.stringify({ workspacesRoots: [root], webPushSubject: "mailto:test@example.com" }),
  );
  const config = {
    ...(await loadConfig(root)),
    selfPath: path.join(root, "work"),
    defaultProvider: "faux",
    defaultModel: "browser-artifact-test",
    defaultThinkingLevel: "off" as const,
    memoryModel: "faux/browser-artifact-test",
  };
  const faux = fauxProvider({ models: [{ id: "browser-artifact-test" }] });
  const open = () =>
    Runtime.open(config, {
      beforeStart: (runtime) => runtime.models.registerNativeProvider(faux.provider),
    });
  let runtime = await open();
  const backend = fastify();
  backend.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/api/") && !request.headers.cookie?.includes("cloud-auth=test"))
      return reply.code(401).send({ error: "Authentication required" });
  });
  backend.get("/target", (_request, reply) =>
    reply
      .header("set-cookie", "existing-login=retained; Path=/")
      .type("text/html")
      .send(
        "<title>Main tool session</title><button onclick=\"document.body.dataset.clicked='yes'\">Shared page</button>",
      ),
  );
  registerSessionRoutes(backend, runtime, new TranscriptImages(path.join(root, "images")));
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const backendUrl = `http://127.0.0.1:${port}`;
  const fixture = "src/client/components/NativeBrowserAttachment.fixture.html";
  const server = await createBrowserFixtureServer(fixture, {
    plugins: [vue()],
    resolve: { alias: { "@": path.resolve("src") } },
    server: {
      host: "127.0.0.1",
      port: 0,
      proxy: { "/api": { target: backendUrl, ws: true } },
    },
  });
  await server.listen();
  const origin = server.resolvedUrls!.local[0]!;
  const closeStreams = await registerCloudBrowserRoutes(
    backend,
    runtime.tools.browserService,
    origin,
  );
  await backend.listen({ host: "127.0.0.1", port });
  const browser = await chromium.launch({ headless: true });
  const viewer = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await viewer.addCookies([{ name: "cloud-auth", value: "test", url: origin }]);
  const page = await viewer.newPage();
  try {
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("browser", { action: "open", url: `${backendUrl}/target`, cloud: true })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxToolCall("browser", { action: "attach" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxText("Her")]),
      fauxAssistantMessage(
        [fauxToolCall("codemode", { code: 'text(await tools.browser({ action: "attach" }));' })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("Same browser")]),
    ]);
    await page.goto(`${origin}${fixture}`);
    await expect.poll(() => page.locator(".transcript-shell").count()).toBe(1);
    const submit = async () => {
      await (
        await runtime.main.submit({ type: "input", content: "Show the browser" }, context)
      ).wait(context);
    };
    const sites = async () =>
      (await runtime.messages("main")).messages.flatMap((message) =>
        message.role === "assistant" && message.turnPhase === "final" ? (message.sites ?? []) : [],
      );
    await submit();
    const buttons = page.getByRole("button", { name: "Open browser", exact: true });
    await expect.poll(() => buttons.count()).toBe(1);
    const [attached] = await sites();
    expect(attached?.browserId).toBeTruthy();
    const service = runtime.tools.browserService;
    const before = await service.cloudTarget(attached!.browserId!);
    expect(await before.page.evaluate(() => document.cookie)).toContain("existing-login=retained");
    expect(
      (await backend.inject(`/api/cloud-browser/${attached!.browserId}/state`)).statusCode,
    ).toBe(401);
    await buttons.click();
    await expect.poll(() => page.locator(".cloud-browser__image[data-frame]").count()).toBe(1);
    expect((await service.cloudTarget(attached!.browserId!)).page).toBe(before.page);
    await page.getByRole("button", { name: "Close popover" }).click();
    await submit();
    await expect.poll(() => buttons.count()).toBe(2);
    expect((await sites()).map((site) => site.browserId)).toEqual([
      attached!.browserId,
      attached!.browserId,
    ]);
    await page.reload();
    await expect.poll(() => buttons.count()).toBe(2);
    await buttons.last().click();
    await expect.poll(() => page.locator(".cloud-browser__image[data-frame]").count()).toBe(1);
    await page.getByRole("button", { name: "Close popover" }).click();
    const after = await service.cloudTarget(attached!.browserId!);
    expect(after.page).toBe(before.page);
    expect(await after.page.evaluate(() => document.cookie)).toContain("existing-login=retained");
    await page.screenshot({ path: "/tmp/native-browser-attachment-main.png" });
    await page.close();
    await closeStreams();
    await backend.close();
    await runtime.close();
    runtime = await open();
    expect((await sites()).map((site) => site.browserId)).toEqual([
      attached!.browserId,
      attached!.browserId,
    ]);
    const restored = await runtime.tools.browserService.cloudTarget(attached!.browserId!);
    expect(restored.state.pageId).toBe(before.state.pageId);
    expect(await restored.page.evaluate(() => document.cookie)).toContain(
      "existing-login=retained",
    );
  } finally {
    await browser.close();
    await closeStreams();
    await backend.close();
    await closeBrowserFixtureServer(server);
    await runtime.tools.browserService.closeSession(String(runtime.main.id));
    await runtime.close();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 60_000);
