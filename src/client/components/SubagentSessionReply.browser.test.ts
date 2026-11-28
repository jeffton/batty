// @vitest-environment node
import path from "node:path";
import vue from "@vitejs/plugin-vue";
import { chromium, type Browser } from "patchright";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { closeBrowserFixtureServer, createBrowserFixtureServer } from "../test/browser-fixture";
import { setFixtureRpcHandler } from "../test/socket-fixture";
import type { OwnerInputs } from "@/shared/owner-api";
import { RpcError } from "@/shared/rpc";
import type { ServerEvent, SessionState } from "@/shared/types";

const fixture = "src/client/components/SubagentSessionReply.fixture.html";
let server: ViteDevServer;
let browser: Browser;

beforeAll(async () => {
  server = await createBrowserFixtureServer(fixture, {
    plugins: [vue()],
    define: { __BATTY_BUILD_ID__: JSON.stringify("dev") },
    resolve: { alias: { "@": path.resolve("src") } },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  if (server) await closeBrowserFixtureServer(server);
});

test.each([false, true])(
  "a native nested transcript sends only on user action (touch: %s)",
  async (hasTouch) => {
    const page = await browser.newPage({
      hasTouch,
      isMobile: hasTouch,
      viewport: { width: hasTouch ? 375 : 1000, height: 720 },
    });
    page.setDefaultTimeout(8_000);
    const calls: OwnerInputs["session.reply"][] = [];
    const rejected = Promise.withResolvers<void>();
    const session: SessionState = {
      id: "worker",
      sessionId: "worker",
      workspaceId: "main",
      cwd: "/",
      thinkingLevel: "off",
      availableThinkingLevels: ["off"],
      isStreaming: false,
      pendingMessageCount: 0,
      updatedAt: 1,
      contextTokens: null,
      contextWindow: null,
      contextPercent: null,
      totalMessageCount: 0,
      hasMoreMessages: false,
      messages: [],
      activeTools: [],
      streamId: "worker-stream",
      revision: 1,
      canReply: true,
    };
    let publish: (event: ServerEvent) => void;
    setFixtureRpcHandler(server, async (operation, input) => {
      if (operation === "session.watch") {
        return {
          value: undefined,
          events: new ReadableStream<ServerEvent>({
            start(controller) {
              publish = (event) => controller.enqueue(event);
              publish({ type: "reset", state: session });
            },
          }),
        };
      }
      if (operation !== "session.reply") throw new Error(`Unexpected operation: ${operation}`);
      calls.push(input as OwnerInputs["session.reply"]);
      if (calls.length === 1) {
        await rejected.promise;
        throw new RpcError("UNAVAILABLE", "Worker disconnected");
      }
      return { value: { ok: true } };
    });
    try {
      await page.goto(new URL(fixture, server.resolvedUrls!.local[0]).href);
      await page.getByRole("button", { name: "Open parent" }).click();
      await page.getByRole("button", { name: "Open worker" }).click();
      const compose = page.getByRole("textbox", { name: "Reply" });
      await compose.fill("First line");
      await compose.press("Enter");
      await compose.press("End");
      await compose.type("Second line");
      const message = "First line\nSecond line";
      expect(await compose.inputValue()).toBe(message);
      expect(calls).toHaveLength(0);
      const send = page.getByRole("button", { name: "Send", exact: true });
      const submit = () => (hasTouch ? send.tap() : compose.press("Control+Enter"));
      await submit();
      await page.getByRole("button", { name: "Sending…" }).waitFor();
      await compose.press("Control+Enter");
      expect(await page.getByRole("button", { name: "Sending…" }).isDisabled()).toBe(true);
      rejected.resolve();
      await page.getByRole("alert").getByText("Worker disconnected").waitFor();
      expect(await compose.inputValue()).toBe(message);
      expect(calls).toHaveLength(1);
      await submit();
      await page.waitForFunction(() => document.querySelector("textarea")?.value === "");
      expect(calls[0]).toEqual({
        sessionId: "worker",
        text: message,
        clientMessageId: expect.any(String),
      });
      expect(calls).toEqual([calls[0], calls[0]]);
      expect(await page.locator("#parent:popover-open, #worker:popover-open").count()).toBe(2);

      publish!({
        type: "reset",
        streamId: session.streamId,
        revision: 2,
        state: {
          ...session,
          revision: 2,
          totalMessageCount: 1,
          messages: [
            { id: "1", role: "user", timestamp: 1, blocks: [{ type: "text", text: message }] },
          ],
        },
      });
      await page.getByText("First line Second line").waitFor();
    } finally {
      rejected.resolve();
      await page.close();
    }
  },
  30_000,
);
