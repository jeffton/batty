import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { setAssistantWorkspace, setMemoryLanguage, setPushTitle } from "./api";

afterEach(() => vi.unstubAllGlobals());

it.each([
  ["push-title", () => setPushTitle("Custom sender"), { title: "Custom sender" }],
  ["memory-language", () => setMemoryLanguage("Danish"), { language: "Danish" }],
  ["assistant-workspace", () => setAssistantWorkspace("roy"), { workspaceId: "roy" }],
] as const)("sends %s settings as parsed JSON", async (setting, save, expectedBody) => {
  const app = Fastify();
  let receivedBody: unknown;
  app.post(`/api/settings/${setting}`, async (request) => {
    receivedBody = request.body;
    return { workspaces: [] };
  });
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    // Request applies browser defaults, including text/plain for untyped string bodies.
    const request = new Request(`http://localhost${input}`, init);
    const response = await app.inject({
      method: "POST",
      url: input,
      headers: Object.fromEntries(request.headers),
      payload: await request.text(),
    });
    return new Response(response.body, { status: response.statusCode });
  });
  try {
    await save();
    expect(receivedBody).toEqual(expectedBody);
  } finally {
    await app.close();
  }
});
