import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  addRemoteConnection,
  getRemoteSettings,
  issueRemoteGrant,
  removeRemoteConnection,
  revokeRemoteGrant,
  setAssistantWorkspace,
  setMemoryLanguage,
  setPushTitle,
} from "./api";

afterEach(() => vi.unstubAllGlobals());

it("sends owner-authenticated provisioning requests as JSON", async () => {
  const requests: { method: string; body: unknown; credentials: RequestCredentials | undefined }[] =
    [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    expect(input).toBe("/api/remotes");
    requests.push({
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      credentials: init.credentials,
    });
    return new Response(JSON.stringify({ ok: true }));
  });
  await getRemoteSettings();
  await issueRemoteGrant("Office");
  await addRemoteConnection({
    id: "work",
    label: "Work",
    url: "https://work.test/",
    token: "private",
  });
  await removeRemoteConnection("work");
  await revokeRemoteGrant("grant");
  expect(requests).toEqual([
    { method: "GET", body: undefined, credentials: "include" },
    { method: "POST", body: { action: "grant-add", label: "Office" }, credentials: "include" },
    {
      method: "POST",
      body: {
        action: "connection-add",
        id: "work",
        label: "Work",
        url: "https://work.test/",
        token: "private",
      },
      credentials: "include",
    },
    { method: "POST", body: { action: "connection-remove", id: "work" }, credentials: "include" },
    { method: "POST", body: { action: "grant-revoke", id: "grant" }, credentials: "include" },
  ]);
});

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
