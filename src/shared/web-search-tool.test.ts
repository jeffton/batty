import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createWebSearchToolDefinition } from "@/shared/web-search-tool";
import { resetWebSearchStateForTests } from "@/shared/web-search";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetWebSearchStateForTests();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("createWebSearchToolDefinition", () => {
  it("uses the caller-specific missing API key message", async () => {
    const tool = createWebSearchToolDefinition({
      getApiKey: () => "",
      missingApiKeyMessage: "Set BRAVE_SEARCH_API_KEY before starting pi.",
    });

    await expect(
      tool.execute(
        "tool-call-1",
        {
          action: "search",
          query: "batty",
        },
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow("Set BRAVE_SEARCH_API_KEY before starting pi.");
  });

  it("shares the same web-search tool implementation for search results", async () => {
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

    const tool = createWebSearchToolDefinition({
      getApiKey: () => "brave-key",
    });

    const result = await tool.execute(
      "tool-call-1",
      {
        action: "search",
        query: "batty",
        count: 1,
      },
      undefined,
      undefined,
      undefined as never,
    );

    const firstContent = result.content[0];
    expect(firstContent?.type).toBe("text");
    expect(firstContent && "text" in firstContent ? firstContent.text : "").toContain(
      "--- Result 1 ---",
    );
    expect(result.details).toMatchObject({
      action: "search",
      query: "batty",
      count: 1,
      country: "US",
      includeContent: false,
      results: [
        {
          title: "Batty",
          link: "https://example.com/batty",
          snippet: "A web UI for Pi.",
          age: "2 days ago",
        },
      ],
    });
  });
});
