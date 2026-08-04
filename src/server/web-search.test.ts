import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { chromium } from "playwright";
import { resetWebSearchStateForTests, runWebSearch } from "@/server/web-search";

vi.mock("playwright", () => ({
  chromium: {
    launch: vi.fn(),
  },
}));

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetWebSearchStateForTests();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("runWebSearch", () => {
  it("rejects missing Brave API keys", async () => {
    await expect(
      runWebSearch({
        apiKey: "",
        action: "search",
        query: "batty",
      }),
    ).rejects.toThrow(
      "Missing Brave Search API key. Set braveSearchKey in <batty-root>/.batty/options.json.",
    );
  });

  it("formats Brave search results", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            web: {
              results: [
                {
                  title: "Batty",
                  url: "https://example.com/batty",
                  description: "A web UI for Pi.",
                  age: "2 days ago",
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ) as typeof fetch;

    const result = await runWebSearch({
      apiKey: "brave-key",
      action: "search",
      query: "batty",
      count: 1,
    });

    expect(result.text).toContain("--- Result 1 ---");
    expect(result.text).toContain("Title: Batty");
    expect(result.text).toContain("Link: https://example.com/batty");
    expect(result.details.results).toEqual([
      {
        title: "Batty",
        link: "https://example.com/batty",
        snippet: "A web UI for Pi.",
        age: "2 days ago",
      },
    ]);
  });

  it("returns text/plain markdown unchanged", async () => {
    const markdown = [
      "# Tool docs",
      "",
      "Call `list_apps` to enumerate apps.",
      "Literal fences stay literal:",
      "```",
      "list_apps",
      "```",
    ].join("\n");

    globalThis.fetch = vi.fn(
      async () =>
        new Response(markdown, { status: 200, headers: { "Content-Type": "text/plain" } }),
    ) as typeof fetch;

    const result = await runWebSearch({
      apiKey: "brave-key",
      action: "content",
      url: "https://example.com/tool-docs.txt",
    });

    expect(result.text).toBe(markdown);
    expect(result.text).toContain("`list_apps`");
    expect(result.text).not.toContain("\\`list\\_apps\\`");
    expect(chromium.launch).not.toHaveBeenCalled();
  });

  it("returns JSON content unchanged", async () => {
    const json = JSON.stringify({ tool: "list_apps", enabled: true }, null, 2);

    globalThis.fetch = vi.fn(
      async () =>
        new Response(json, {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        }),
    ) as typeof fetch;

    const result = await runWebSearch({
      apiKey: "brave-key",
      action: "content",
      url: "https://example.com/tool-docs.json",
    });

    expect(result.text).toBe(json);
    expect(chromium.launch).not.toHaveBeenCalled();
  });

  it("extracts readable markdown content from pages", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          "<!doctype html><html><head><title>Example Article</title></head><body><main><article><h1>Example Article</h1><p>Hello <strong>world</strong>.</p><p>This article has enough text to avoid the browser fallback path in the extractor.</p></article></main></body></html>",
          { status: 200, headers: { "Content-Type": "text/html" } },
        ),
    ) as typeof fetch;

    const result = await runWebSearch({
      apiKey: "brave-key",
      action: "content",
      url: "https://example.com/article",
    });

    expect(result.text).toContain("# Example Article");
    expect(result.text).toContain("Hello **world**.");
    expect(result.details.url).toBe("https://example.com/article");
    expect(chromium.launch).not.toHaveBeenCalled();
  });

  it("does not mistake GitHub feature flags for a bot challenge", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          "<!doctype html><html><head><title>GitHub - SharpAI/SwiftLM</title></head><body><main><article><div>octocaptcha_origin_optimization</div><h1>SwiftLM</h1><p>A native Swift inference server for MLX models with an OpenAI-compatible API.</p><p>This README text is long enough to be useful content and should not trigger a browser fallback just because the page HTML contains an internal feature flag with the word captcha in it.</p></article></main></body></html>",
          { status: 200, headers: { "Content-Type": "text/html" } },
        ),
    ) as typeof fetch;

    const result = await runWebSearch({
      apiKey: "brave-key",
      action: "content",
      url: "https://github.com/SharpAI/SwiftLM",
    });

    expect(result.text).toContain("# GitHub - SharpAI/SwiftLM");
    expect(result.text).toContain("A native Swift inference server for MLX models");
    expect(chromium.launch).not.toHaveBeenCalled();
  });

  it("falls back to a browser when direct fetch is blocked", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("Forbidden", { status: 403, statusText: "Forbidden" }),
    ) as typeof fetch;

    const routeAbort = vi.fn(async () => {});
    const routeContinue = vi.fn(async () => {});
    const page = {
      setDefaultNavigationTimeout: vi.fn(),
      setDefaultTimeout: vi.fn(),
      route: vi.fn(async (_pattern: string, handler: (route: unknown) => Promise<void>) => {
        await handler({
          request: () => ({ resourceType: () => "document" }),
          abort: routeAbort,
          continue: routeContinue,
        });
      }),
      goto: vi.fn(async () => ({
        headers: () => ({ "content-type": "text/html" }),
        status: () => 200,
        statusText: () => "OK",
      })),
      waitForLoadState: vi.fn(async () => {}),
      waitForTimeout: vi.fn(async () => {}),
      content: vi.fn(
        async () =>
          "<!doctype html><html><head><title>Browser Article</title></head><body><main><article><h1>Browser Article</h1><p>Rendered content from the headless browser path.</p><p>This paragraph is long enough to be considered useful extracted content for the fallback strategy.</p></article></main></body></html>",
      ),
      url: vi.fn(() => "https://example.com/rendered"),
    };
    const context = {
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => {}),
    };

    vi.mocked(chromium.launch).mockResolvedValue({
      isConnected: vi.fn(() => true),
      on: vi.fn(),
      newContext: vi.fn(async () => context),
    } as never);

    const result = await runWebSearch({
      apiKey: "brave-key",
      action: "content",
      url: "https://example.com/protected",
    });

    expect(chromium.launch).toHaveBeenCalledOnce();
    expect(result.text).toContain("# Browser Article");
    expect(result.text).toContain("Rendered content from the headless browser path.");
    expect(routeAbort).not.toHaveBeenCalled();
    expect(routeContinue).toHaveBeenCalled();
  });

  it("relaunches the shared browser when it closes before creating a context", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("Forbidden", { status: 403, statusText: "Forbidden" }),
    ) as typeof fetch;

    const page = {
      setDefaultNavigationTimeout: vi.fn(),
      setDefaultTimeout: vi.fn(),
      route: vi.fn(async () => {}),
      goto: vi.fn(async () => ({
        headers: () => ({ "content-type": "text/html" }),
        status: () => 200,
        statusText: () => "OK",
      })),
      waitForLoadState: vi.fn(async () => {}),
      waitForTimeout: vi.fn(async () => {}),
      content: vi.fn(
        async () =>
          "<!doctype html><html><head><title>Recovered Article</title></head><body><main><article><h1>Recovered Article</h1><p>The replacement browser returned rendered content.</p><p>This paragraph makes the extracted fallback content sufficiently useful.</p></article></main></body></html>",
      ),
      url: vi.fn(() => "https://example.com/recovered"),
    };
    const context = {
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => {}),
    };
    const closedBrowser = {
      isConnected: vi.fn(() => true),
      on: vi.fn(),
      newContext: vi.fn(async () => {
        throw new Error("browser.newContext: Target page, context or browser has been closed");
      }),
    };
    const replacementBrowser = {
      isConnected: vi.fn(() => true),
      on: vi.fn(),
      newContext: vi.fn(async () => context),
    };
    vi.mocked(chromium.launch)
      .mockResolvedValueOnce(closedBrowser as never)
      .mockResolvedValueOnce(replacementBrowser as never);

    const result = await runWebSearch({
      apiKey: "brave-key",
      action: "content",
      url: "https://example.com/protected",
    });

    expect(chromium.launch).toHaveBeenCalledTimes(2);
    expect(closedBrowser.newContext).toHaveBeenCalledOnce();
    expect(replacementBrowser.newContext).toHaveBeenCalledOnce();
    expect(result.text).toContain("# Recovered Article");
  });

  it("replaces a cached browser after its disconnected event", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("Forbidden", { status: 403, statusText: "Forbidden" }),
    ) as typeof fetch;

    const page = {
      setDefaultNavigationTimeout: vi.fn(),
      setDefaultTimeout: vi.fn(),
      route: vi.fn(async () => {}),
      goto: vi.fn(async () => ({
        headers: () => ({ "content-type": "text/html" }),
        status: () => 200,
        statusText: () => "OK",
      })),
      waitForLoadState: vi.fn(async () => {}),
      waitForTimeout: vi.fn(async () => {}),
      content: vi.fn(
        async () =>
          "<!doctype html><html><head><title>Cached Article</title></head><body><main><article><h1>Cached Article</h1><p>Rendered content from the shared browser.</p><p>This paragraph makes the extracted fallback content sufficiently useful.</p></article></main></body></html>",
      ),
      url: vi.fn(() => "https://example.com/cached"),
    };
    const context = {
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => {}),
    };
    let disconnect: (() => void) | undefined;
    const firstBrowser = {
      isConnected: vi.fn(() => true),
      on: vi.fn((event: string, listener: () => void) => {
        if (event === "disconnected") {
          disconnect = listener;
        }
      }),
      newContext: vi.fn(async () => context),
    };
    const replacementBrowser = {
      isConnected: vi.fn(() => true),
      on: vi.fn(),
      newContext: vi.fn(async () => context),
    };
    vi.mocked(chromium.launch)
      .mockResolvedValueOnce(firstBrowser as never)
      .mockResolvedValueOnce(replacementBrowser as never);

    await runWebSearch({
      apiKey: "brave-key",
      action: "content",
      url: "https://example.com/first",
    });
    disconnect?.();
    await runWebSearch({
      apiKey: "brave-key",
      action: "content",
      url: "https://example.com/second",
    });

    expect(chromium.launch).toHaveBeenCalledTimes(2);
    expect(firstBrowser.newContext).toHaveBeenCalledOnce();
    expect(replacementBrowser.newContext).toHaveBeenCalledOnce();
  });
});
