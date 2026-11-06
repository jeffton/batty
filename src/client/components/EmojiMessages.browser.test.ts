import path from "node:path";
import vue from "@vitejs/plugin-vue";
import { chromium, type Browser } from "patchright";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { closeBrowserFixtureServer, createBrowserFixtureServer } from "../test/browser-fixture";

let server: ViteDevServer;
let browser: Browser;
let url: string;
beforeAll(async () => {
  server = await createBrowserFixtureServer("src/client/components/EmojiMessages.fixture.html", {
    plugins: [vue()],
    resolve: { alias: { "@": path.resolve("src") } },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  url = `${server.resolvedUrls!.local[0]}src/client/components/EmojiMessages.fixture.html`;
  browser = await chromium.launch({ headless: true });
}, 30_000);
afterAll(async () => {
  await browser?.close();
  if (server) await closeBrowserFixtureServer(server);
});

test("only emoji chat text grows, including persisted and streaming messages", async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(url);
    await page.locator(".message__emoji-only").waitFor();
    const setMessage = async (role: string, texts: string[], extras: object[] = []) => {
      await page.evaluate(
        ({ role, texts, extras }) => {
          window.dispatchEvent(
            new CustomEvent("fixture:message", {
              detail: JSON.stringify({
                id: "emoji-fixture",
                role,
                timestamp: 1,
                turnPhase: "final",
                blocks: [...texts.map((text) => ({ type: "text", text })), ...extras],
                ...(role === "toolResult" ? { toolName: "read", toolCallId: "test" } : {}),
              }),
            }),
          );
        },
        { role, texts, extras },
      );
    };
    for (const role of ["assistant", "user"]) {
      for (const text of ["😂", " 🦾😎\n👍🏽 🇸🇪 👨‍👩‍👧‍👦 ", "❤️ 1️⃣ #⃣", "😂".repeat(150)]) {
        await setMessage(role, [text]);
        await expect
          .poll(async () =>
            (await page.locator(".message__emoji-only").textContent())?.replace(/\s/g, ""),
          )
          .toBe(text.replace(/\s/g, ""));
        const sizes = await page.locator(".message__emoji-only").evaluate((node) => ({
          text: node.textContent,
          font: parseFloat(getComputedStyle(node).fontSize),
          parentFont: parseFloat(getComputedStyle(node.parentElement!).fontSize),
          width: document.documentElement.scrollWidth,
        }));
        expect(sizes.text?.replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
        expect(sizes.font / sizes.parentFont).toBeCloseTo(1.6, 1);
        expect(sizes.width).toBeLessThanOrEqual(320);
      }
      for (const text of [
        "hello 😂",
        "42",
        "#",
        "*",
        "!😂",
        "`😂`",
        "```\n😂\n```",
        "\uFE0F",
        "\u200D",
        "🇸",
        "😂a",
        "",
        " \n ",
      ]) {
        await setMessage(role, [text]);
        await expect.poll(() => page.locator(".message__emoji-only").count()).toBe(0);
      }
      for (const text of ["    😂", "\t😂", "😂\n\n    🦾"]) {
        await setMessage(role, [text]);
        await expect
          .poll(() => page.locator(".message__emoji-only").count())
          .toBe(role === "user" ? 1 : 0);
        expect(await page.locator("pre code").count()).toBe(role === "assistant" ? 1 : 0);
      }
      await setMessage(role, ["😂", "text"]);
      expect(await page.locator(".message__emoji-only").count()).toBe(0);
    }
    await setMessage("assistant", ["😂"], [{ type: "thinking", thinking: "🦾" }]);
    expect(await page.locator(".markdown-body--thinking.message__emoji-only").count()).toBe(0);
    await setMessage("toolResult", ["😂"]);
    expect(await page.locator(".message__emoji-only").count()).toBe(0);
    // Reconstruct persisted input, then change streamed content in place.
    await setMessage("assistant", ["😂"]);
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent("fixture:message", {
          detail: JSON.stringify({
            id: "emoji-fixture",
            role: "assistant",
            timestamp: 1,
            turnPhase: "interim",
            blocks: [{ type: "text", text: "😂 hello" }],
          }),
        }),
      ),
    );
    await expect.poll(() => page.locator(".message__emoji-only").count()).toBe(0);
    await setMessage("assistant", ["😂"]);
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.evaluate(() => {
      document.querySelector("article")!.style.fontSize = "24px";
    });
    expect(
      await page
        .locator(".message__emoji-only")
        .evaluate((node) => parseFloat(getComputedStyle(node).fontSize)),
    ).toBeCloseTo(38.4, 1);
    expect((await page.locator(".message__emoji-only").textContent())?.trim()).toBe("😂");
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});
