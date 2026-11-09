// @vitest-environment node
import { expect, test } from "vite-plus/test";
import { WebSocket } from "ws";
import { once } from "node:events";
import { SocketChannel } from "../../shared/socket-channel";
import { createBrowserFixtureServer, closeBrowserFixtureServer } from "./browser-fixture";
import { attachFixtureSocket } from "./socket-fixture";

test("fixture sockets register once, retain the installation prefix and release upgrade listeners", async () => {
  let calls = 0;
  const server = await createBrowserFixtureServer(
    "src/client/lib/InstallationStorage.fixture.html",
    {
      server: { host: "127.0.0.1", port: 0 },
      plugins: [
        {
          name: "prefixed-socket-fixture",
          configureServer(vite) {
            vite.middlewares.use("/nested/app/api/echo", (_request, response) => {
              calls++;
              response.setHeader("content-type", "application/json");
              response.end(JSON.stringify({ calls }));
            });
          },
        },
      ],
    },
  );
  const http = server.httpServer!;
  const listeners = http.listenerCount("upgrade");
  attachFixtureSocket(server);
  expect(http.listenerCount("upgrade")).toBe(listeners);
  let channel: SocketChannel | undefined;
  try {
    await server.listen();
    const url = new URL("/nested/app/api/socket", server.resolvedUrls!.local[0]!);
    url.protocol = "ws:";
    const socket = new WebSocket(url);
    await once(socket, "open");
    channel = new SocketChannel(socket);
    const response = await channel.request("/api/echo", new Request("http://fixture/api/echo"));
    expect(await response.json()).toEqual({ calls: 1 });
    expect(calls).toBe(1);
  } finally {
    channel?.close();
    await closeBrowserFixtureServer(server);
  }
  expect(http.listenerCount("upgrade")).toBeLessThan(listeners);
});
