import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { runWebSearch } from "@/server/web-search";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
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

  it("extracts readable markdown content from pages", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          "<!doctype html><html><head><title>Example Article</title></head><body><main><article><h1>Example Article</h1><p>Hello <strong>world</strong>.</p></article></main></body></html>",
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
  });
});
