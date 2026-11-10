// @vitest-environment node
import { expect, test } from "vite-plus/test";
import { WebSocket } from "ws";
import { once } from "node:events";
import { RpcChannel } from "../../shared/rpc";
import { createBrowserFixtureServer, closeBrowserFixtureServer } from "./browser-fixture";
import { attachFixtureSocket, setFixtureRpcHandler } from "./socket-fixture";

test("fixture sockets register once, retain the installation prefix and release upgrade listeners", async () => {
  let calls = 0;
  const server = await createBrowserFixtureServer(
    "src/client/lib/InstallationStorage.fixture.html",
    {
      server: { host: "127.0.0.1", port: 0 },
    },
  );
  setFixtureRpcHandler(server, async (operation, input) => {
    expect(operation).toBe("fixture.echo");
    expect(input).toEqual({ text: "native" });
    return { value: { calls: ++calls } };
  });
  const http = server.httpServer!;
  const listeners = http.listenerCount("upgrade");
  attachFixtureSocket(server);
  expect(http.listenerCount("upgrade")).toBe(listeners);
  let channel: RpcChannel | undefined;
  try {
    await server.listen();
    const url = new URL("/nested/app/api/socket", server.resolvedUrls!.local[0]!);
    url.protocol = "ws:";
    const socket = new WebSocket(url);
    await once(socket, "open");
    channel = new RpcChannel(socket);
    const reply = await channel.call("fixture.echo", { text: "native" });
    expect(reply.value).toEqual({ calls: 1 });
    expect(calls).toBe(1);
  } finally {
    channel?.close();
    await closeBrowserFixtureServer(server);
  }
  expect(http.listenerCount("upgrade")).toBeLessThan(listeners);
});
