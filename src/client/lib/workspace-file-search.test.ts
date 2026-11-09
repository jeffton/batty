import { afterEach, expect, test, vi } from "vite-plus/test";

vi.mock("@/client/lib/socket-fetch", () => ({
  socketFetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
  closeSocketTransport: vi.fn(),
}));
import { searchWorkspaceFiles } from "./api";

afterEach(() => vi.unstubAllGlobals());

test("decodes filename events across UTF-8 and record chunk boundaries", async () => {
  const data = new TextEncoder().encode(
    [
      { kind: "match", path: "nested/Ångström.ts" },
      { kind: "match", path: "another/Ångström.ts" },
      { kind: "done" },
    ]
      .map((event) => JSON.stringify(event) + "\n")
      .join(""),
  );
  const fetch = vi.fn(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (let offset = 0; offset < data.length; offset += 3)
              controller.enqueue(data.slice(offset, offset + 3));
            controller.close();
          },
        }),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  const matches: string[] = [];
  const controller = new AbortController();
  await searchWorkspaceFiles("project", "ångström", controller.signal, (paths) =>
    matches.push(...paths),
  );
  expect(matches).toEqual(["nested/Ångström.ts", "another/Ångström.ts"]);
  expect(fetch.mock.calls[0]).toEqual([
    "/api/workspaces/project/file-search?name=%C3%A5ngstr%C3%B6m",
    { credentials: "include", signal: controller.signal },
  ]);
});

test("keeps partial matches but surfaces scan errors and truncated responses", async () => {
  for (const tail of [{ kind: "error", message: "Permission denied" }, undefined]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ kind: "match", path: "found.ts" }) +
              "\n" +
              (tail ? JSON.stringify(tail) + "\n" : ""),
          ),
      ),
    );
    const matches: string[] = [];
    await expect(
      searchWorkspaceFiles("project", "found", new AbortController().signal, (paths) =>
        matches.push(...paths),
      ),
    ).rejects.toThrow(
      tail ? "Search incomplete: Permission denied" : "File search ended before completion",
    );
    expect(matches).toEqual(["found.ts"]);
  }
});
