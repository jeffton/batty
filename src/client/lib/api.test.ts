import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { rpcCall, closeRpcTransport } from "./rpc";
import { RpcError } from "@/shared/rpc";
import {
  addRemoteConnection,
  beginPasskeyLogin,
  finishPasskeyLogin,
  getBootstrap,
  logout,
  finishPasskeyRegistration,
  getRemoteSettings,
  getMainMessages,
  issueRemoteGrant,
  removeRemoteConnection,
  revokeRemoteGrant,
  setAssistantWorkspace,
  setMemoryLanguage,
  setPushTitle,
  submitMainPrompt,
  getWorkspaceFile,
} from "./api";
vi.mock("./rpc", () => ({ rpcCall: vi.fn(), closeRpcTransport: vi.fn() }));
beforeEach(() => vi.mocked(rpcCall).mockResolvedValue({ value: { workspaces: [] } }));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("cookie login, bootstrap and logout remain HTTP; domain calls use native RPC", async () => {
  const http = vi.fn(async () => new Response(JSON.stringify({ authenticated: true })));
  vi.stubGlobal("fetch", http);
  await getBootstrap();
  await beginPasskeyLogin();
  await finishPasskeyLogin("request", {} as Parameters<typeof finishPasskeyLogin>[1]);
  await logout();
  expect(closeRpcTransport).toHaveBeenCalledTimes(2);
  expect(rpcCall).not.toHaveBeenCalled();
  expect(http).toHaveBeenCalledTimes(4);
  await getRemoteSettings();
  expect(rpcCall).toHaveBeenCalledWith("remotes.get", {}, expect.any(Object));
});
it("distinguishes fetch transport failures from HTTP auth and malformed responses without replay", async () => {
  const http = vi.fn().mockRejectedValueOnce(new TypeError("Load failed"));
  vi.stubGlobal("fetch", http);
  await expect(beginPasskeyLogin()).rejects.toMatchObject({
    code: "OFFLINE",
    message: "Load failed",
  });
  expect(http).toHaveBeenCalledOnce();
  http.mockResolvedValueOnce(
    new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
  );
  await expect(getBootstrap()).rejects.toMatchObject({ status: 401, message: "Unauthorized" });
  http.mockResolvedValueOnce(new Response("not json"));
  await expect(getBootstrap()).rejects.not.toBeInstanceOf(RpcError);
});

it.each([200, 401])(
  "classifies interrupted HTTP response bodies without losing status %s",
  async (status) => {
    const response = new Response(null, { status });
    // Browser Fetch exposes interrupted body reads as TypeError; happy-dom wraps
    // errored streams in its own EncodingError instead.
    vi.spyOn(response, "json").mockRejectedValueOnce(new TypeError("Network connection lost"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    const expected =
      status === 200
        ? { code: "OFFLINE", message: "Network connection lost" }
        : { status: 401, message: "HTTP 401" };
    await expect(getBootstrap()).rejects.toMatchObject(expected);
    expect(fetch).toHaveBeenCalledOnce();
  },
);

it("successful registration resets captured identity, but rejected login leaves a live transport alone", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ ok: true }))),
  );
  await finishPasskeyRegistration("request", {} as Parameters<typeof finishPasskeyRegistration>[1]);
  expect(closeRpcTransport).toHaveBeenCalledOnce();
  vi.mocked(closeRpcTransport).mockClear();
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(JSON.stringify({ error: "Denied" }), { status: 401 }),
  );
  await expect(
    finishPasskeyLogin("request", {} as Parameters<typeof finishPasskeyLogin>[1]),
  ).rejects.toThrow("Denied");
  expect(closeRpcTransport).not.toHaveBeenCalled();
});
it.each(["lifecycle", "timeout"])(
  "history combines cancellation and deadline: %s",
  async (cause) => {
    const lifecycle = new AbortController();
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    await getMainMessages({ before: "message", signal: lifecycle.signal });
    const signal = vi.mocked(rpcCall).mock.calls[0]![2]!.signal!;
    expect(signal.aborted).toBe(false);
    const reason = new DOMException(
      "cancelled",
      cause === "lifecycle" ? "AbortError" : "TimeoutError",
    );
    (cause === "lifecycle" ? lifecycle : deadline).abort(reason);
    expect(signal.reason).toBe(reason);
  },
);
it("provisions remotes through named operations without transport envelopes", async () => {
  await getRemoteSettings();
  await issueRemoteGrant();
  await addRemoteConnection({ url: "https://work.test/", token: "private" });
  await removeRemoteConnection("work");
  await revokeRemoteGrant("grant");
  expect(vi.mocked(rpcCall).mock.calls.map(([operation, input]) => [operation, input])).toEqual([
    ["remotes.get", {}],
    ["remotes.token.generate", {}],
    ["remotes.connection.add", { url: "https://work.test/", token: "private" }],
    ["remotes.connection.remove", { id: "work" }],
    ["remotes.token.revoke", { id: "grant" }],
  ]);
});
it.each([
  ["settings.push-title", () => setPushTitle("Custom sender"), { title: "Custom sender" }],
  ["settings.memory-language", () => setMemoryLanguage("Danish"), { language: "Danish" }],
  ["settings.assistant-workspace", () => setAssistantWorkspace("roy"), { workspaceId: "roy" }],
] as const)("sends typed domain settings to %s", async (operation, save, input) => {
  await save();
  expect(rpcCall).toHaveBeenCalledWith(operation, input, undefined);
});
it("uploads file metadata and ordered raw bytes rather than multipart/base64", async () => {
  let bytes: Uint8Array | undefined;
  vi.mocked(rpcCall).mockImplementation(async (_operation, _input, options) => {
    bytes = new Uint8Array(await new Response(options!.body).arrayBuffer());
    return { value: { disposition: "started", submissionId: "receipt", sessionId: "main" } };
  });
  const files = [
    new File([new Uint8Array([0, 255, 1])], "one.bin", { type: "application/octet-stream" }),
    new File([], "empty"),
    new File(["Hej 🦾"], "two.txt", { type: "text/plain" }),
  ];
  await submitMainPrompt("prompt", "hello", files, "receipt");
  expect(vi.mocked(rpcCall).mock.calls[0]!.slice(0, 2)).toEqual([
    "main.submit",
    {
      kind: "prompt",
      text: "hello",
      clientMessageId: "receipt",
      correlationId: expect.any(String),
      files: files.map((file) => ({ name: file.name, type: file.type, size: file.size })),
    },
  ]);
  expect(bytes).toEqual(new Uint8Array([0, 255, 1, ...new TextEncoder().encode("Hej 🦾")]));
});
it("reads a selected code file with its own operation", async () => {
  await getWorkspaceFile("project", "src/a.ts");
  expect(rpcCall).toHaveBeenCalledWith(
    "workspace.file",
    { workspaceId: "project", path: "src/a.ts" },
    expect.any(Object),
  );
});
