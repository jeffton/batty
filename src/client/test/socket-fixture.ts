import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { ViteDevServer } from "vite";
import { WebSocketServer } from "ws";
import { SocketChannel } from "../../shared/socket-channel";

type FixtureRoute = {
  request(): { method(): string; url(): string; postDataJSON(): any };
  fulfill(options?: {
    status?: number;
    json?: unknown;
    body?: string | Buffer;
    headers?: Record<string, string>;
    contentType?: string;
  }): Promise<void>;
  continue(): Promise<void>;
};
type Override = { matches: RegExp; handle: (route: FixtureRoute) => unknown };
const overrides = new WeakMap<ViteDevServer, Override[]>();
const responses = new WeakMap<
  ViteDevServer,
  Set<(path: string, body: string | undefined, response: Response) => void>
>();

export function waitForFixtureResponse(
  server: ViteDevServer,
  matches: (path: string, body: string | undefined) => boolean,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const listeners = responses.get(server)!;
    const timer = setTimeout(() => {
      listeners.delete(received);
      reject(new Error("Fixture response timed out"));
    }, 10_000);
    const received = (path: string, body: string | undefined, response: Response) => {
      if (!matches(path, body)) return;
      clearTimeout(timer);
      listeners.delete(received);
      resolve(response.clone());
    };
    listeners.add(received);
  });
}

/** Real socket protocol, with fixture-only dispatch to HTTP middleware or test overrides. */
export function attachFixtureSocket(server: ViteDevServer) {
  if (overrides.has(server)) return;
  const routes: Override[] = [];
  overrides.set(server, routes);
  const listeners = new Set<(path: string, body: string | undefined, response: Response) => void>();
  responses.set(server, listeners);
  const sockets = new WebSocketServer({ noServer: true });
  const upgradeSocket = (upgrade: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(upgrade.url!, "http://fixture").pathname;
    if (!pathname.endsWith("/api/socket")) return;
    const prefix = pathname.slice(0, -"/api/socket".length);
    sockets.handleUpgrade(upgrade, socket, head, (ws) => {
      new SocketChannel(ws, {
        handle: async (path, request) => {
          const origin = server.resolvedUrls!.local[0]!;
          const url = new URL(`${prefix}${path}`, origin).href;
          const bytes = request.body ? await request.arrayBuffer() : undefined;
          const headers = new Headers(request.headers);
          if (upgrade.headers.cookie) headers.set("cookie", upgrade.headers.cookie);
          if (upgrade.headers.origin) headers.set("origin", upgrade.headers.origin);
          const forward = () =>
            fetch(url, {
              method: request.method,
              headers,
              ...(bytes ? { body: bytes } : {}),
              signal: request.signal,
            });
          const override = [...routes].reverse().find((route) => route.matches.test(url));
          const notify = (response: Response) => {
            for (const listener of listeners)
              listener(path, bytes ? new TextDecoder().decode(bytes) : undefined, response);
            return response;
          };
          if (!override) return notify(await forward());
          let result: Response | undefined;
          await override.handle({
            request: () => ({
              method: () => request.method,
              url: () => url,
              postDataJSON: () => (bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null),
            }),
            fulfill: async (options = {}) => {
              const headers = new Headers(options.headers);
              if (options.contentType) headers.set("content-type", options.contentType);
              if (options.json !== undefined) headers.set("content-type", "application/json");
              result = new Response(
                options.json !== undefined
                  ? JSON.stringify(options.json)
                  : typeof options.body === "string"
                    ? options.body
                    : options.body
                      ? Uint8Array.from(options.body)
                      : null,
                {
                  status: options.status ?? 200,
                  headers,
                },
              );
            },
            continue: async () => {
              result = await forward();
            },
          });
          if (!result) throw new Error(`Fixture route did not respond: ${path}`);
          return notify(result);
        },
      });
    });
  };
  server.httpServer!.on("upgrade", upgradeSocket);
  const close = server.close.bind(server);
  server.close = async () => {
    server.httpServer!.off("upgrade", upgradeSocket);
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    await close();
  };
}

/** Register the same assertion-bearing fixture handler for HTTP and socket requests. */
export async function fixtureRoute(
  server: ViteDevServer,
  page: {
    route(pattern: string, handle: (route: FixtureRoute) => unknown): Promise<unknown>;
    on(event: "close", listener: () => void): unknown;
  },
  pattern: string,
  handle: (route: FixtureRoute) => unknown,
) {
  const matches = new RegExp(
    "^" +
      pattern
        .split("**")
        .map((part) =>
          part
            .split("*")
            .map((piece) => piece.replace(/[.+?^$()|[\]\\]/g, "\\$&"))
            .join("[^/]*"),
        )
        .join(".*")
        .replace(
          /\{([^}]+)\}/g,
          (_, alternatives: string) => `(${alternatives.split(",").join("|")})`,
        ) +
      "$",
  );
  const override = { matches, handle };
  const routes = overrides.get(server)!;
  routes.push(override);
  page.on("close", () => {
    const index = routes.indexOf(override);
    if (index !== -1) routes.splice(index, 1);
  });
  await page.route(pattern, handle);
}
