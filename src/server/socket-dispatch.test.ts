import { afterEach, expect, it, vi } from "vite-plus/test";
import { isOwnerSocketRoute, localSocketHandler, nodeSocketHandler } from "./socket-dispatch";

afterEach(() => vi.restoreAllMocks());

it("allows ordinary owner API routes but rejects privileged or noncanonical paths", () => {
  for (const [path, method] of [
    ["/api/workspaces", "GET"],
    ["/api/sessions/12", "POST"],
    ["/api/workspaces?filter=a", "GET"],
  ] as const) {
    expect(isOwnerSocketRoute(path, method)).toBe(true);
  }

  for (const [path, method] of [
    ["/api/node/identity", "GET"],
    ["/api/auth/login", "POST"],
    ["/api/service/restart", "POST"],
    ["/api/socket", "GET"],
    ["/api/bootstrap", "GET"],
    ["/api/logout", "POST"],
    ["/api/workspaces", "OPTIONS"],
    ["/healthz", "GET"],
    ["/api/%2e%2e/service/restart", "POST"],
    ["/api/../service/restart", "POST"],
    ["/api/workspaces%2f..%2fservice/restart", "POST"],
    ["/api/workspaces%5c..%5cservice/restart", "POST"],
    ["/api/%6eode/identity", "GET"],
    ["/api/workspaces#fragment", "GET"],
  ] as const) {
    expect(isOwnerSocketRoute(path, method), `${method} ${path}`).toBe(false);
  }

  expect(isOwnerSocketRoute("/api/%ZZ", "GET")).toBe(false);
});

it("uses only the configured local destination and trusted credentials", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
  const handler = localSocketHandler(
    () => "http://127.0.0.1:3148/base/",
    () => ({ cookie: "session=trusted", origin: "https://batty.example" }),
    () => true,
  );
  const request = new Request("http://batty.invalid/api/workspaces?x=1", {
    headers: {
      host: "attacker.example",
      authorization: "Bearer attacker-secret",
      cookie: "session=attacker",
      origin: "https://attacker.example",
      "x-forwarded-host": "attacker.example",
    },
  });

  await handler("/api/workspaces?x=1", request);

  expect(fetchSpy).toHaveBeenCalledOnce();
  const [url, init] = fetchSpy.mock.calls[0]!;
  expect(url).toBeInstanceOf(URL);
  expect((url as URL).href).toBe("http://127.0.0.1:3148/base/api/workspaces?x=1");
  const headers = new Headers(init?.headers);
  expect(headers.get("cookie")).toBe("session=trusted");
  expect(headers.get("origin")).toBe("https://batty.example");
  expect(headers.get("authorization")).toBeNull();
  expect(headers.get("host")).toBeNull();
  expect(headers.get("x-forwarded-host")).toBeNull();
  expect(init?.redirect).toBe("error");
});

it("requires a live grant bound to this connection and forwards only node routes", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
  let active = true;
  const access = {
    authenticate: vi.fn((token: string) =>
      active && token === "peer-token"
        ? { id: "local-grant" }
        : token === "other-peer-token"
          ? { id: "different-grant" }
          : undefined,
    ),
  } as never;
  const handler = nodeSocketHandler(
    () => "http://127.0.0.1:3148/",
    { localGrantId: "local-grant" } as never,
    { access } as never,
  );
  const request = (authorization: string) =>
    new Request("http://batty.invalid/api/node/identity", {
      headers: {
        authorization,
        host: "attacker.example",
        cookie: "owner-session=stolen",
        origin: "https://attacker.example",
        "x-forwarded-host": "attacker.example",
      },
    });

  expect((await handler("/api/node/identity", request("Bearer other-token"))).status).toBe(401);
  expect((await handler("/api/node/identity", request("Bearer other-peer-token"))).status).toBe(
    401,
  );
  expect((await handler("/api/node/identity", request(""))).status).toBe(401);
  expect((await handler("/api/workspaces", request("Bearer peer-token"))).status).toBe(403);
  expect(fetchSpy).not.toHaveBeenCalled();

  await handler("/api/node/identity", request("Bearer peer-token"));
  expect(fetchSpy).toHaveBeenCalledOnce();
  const [url, init] = fetchSpy.mock.calls[0]!;
  expect(url).toBeInstanceOf(URL);
  expect((url as URL).href).toBe("http://127.0.0.1:3148/api/node/identity");
  const headers = new Headers(init?.headers);
  expect(headers.get("authorization")).toBe("Bearer peer-token");
  expect(headers.get("cookie")).toBeNull();
  expect(headers.get("origin")).toBeNull();
  expect(headers.get("host")).toBeNull();
  expect(headers.get("x-forwarded-host")).toBeNull();

  active = false; // Simulate revocation after a previously successful request.
  expect((await handler("/api/node/identity", request("Bearer peer-token"))).status).toBe(401);
  expect(fetchSpy).toHaveBeenCalledOnce();
});

it("completes an authorized unpair before returning its response", async () => {
  const removeConnection = vi.fn(async () => {});
  const disconnect = vi.fn();
  const remotes = {
    access: {
      authenticate: vi.fn(() => ({ id: "local-grant" })),
      pairedConnection: vi.fn(() => ({ id: "peer-instance" })),
      removeConnection,
    },
    disconnect,
    reverse: { reconfigure: vi.fn() },
  } as never;
  const handler = nodeSocketHandler(
    () => "http://127.0.0.1:3148/",
    { localGrantId: "local-grant" } as never,
    remotes,
  );
  const response = await handler(
    "/api/node/unpair",
    new Request("http://batty.invalid/api/node/unpair", {
      method: "POST",
      headers: { authorization: "Bearer peer-token" },
    }),
  );

  expect(response.status).toBe(200);
  expect(removeConnection).toHaveBeenCalledWith("peer-instance");
  expect(disconnect).toHaveBeenCalledWith("peer-instance");
});
