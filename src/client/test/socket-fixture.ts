import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { ViteDevServer } from "vite";
import { WebSocketServer } from "ws";
import {
  RpcChannel,
  RpcError,
  type RpcHandler,
  type RpcContext,
  type RpcReply,
} from "../../shared/rpc-channel";

type Override = {
  operation: string | readonly string[];
  handle(
    input: any,
    context: RpcContext,
    next: () => Promise<RpcReply>,
    operation: string,
  ): Promise<RpcReply> | RpcReply;
};
type Observer = (operation: string, input: unknown, reply: RpcReply) => void;
type Fixture = { overrides: Override[]; observers: Set<Observer>; handle?: RpcHandler };
const fixtures = new WeakMap<ViteDevServer, Fixture>();

/** Supply an actual native domain handler; never proxy native operations through HTTP. */
export function setFixtureRpcHandler(server: ViteDevServer, handle: RpcHandler) {
  fixtures.get(server)!.handle = handle;
}

export function waitForFixtureOperation(
  server: ViteDevServer,
  matches: (operation: string, input: any) => boolean,
): Promise<RpcReply> {
  return new Promise((resolve, reject) => {
    const observers = fixtures.get(server)!.observers;
    const timer = setTimeout(() => {
      observers.delete(received);
      reject(new Error("Fixture operation timed out"));
    }, 10_000);
    const received: Observer = (operation, input, reply) => {
      if (!matches(operation, input)) return;
      clearTimeout(timer);
      observers.delete(received);
      resolve(reply);
    };
    observers.add(received);
  });
}

/** Real native RPC channel. Unimplemented operations fail rather than silently using HTTP. */
export function attachFixtureSocket(server: ViteDevServer) {
  if (fixtures.has(server)) return;
  const fixture: Fixture = { overrides: [], observers: new Set() };
  fixtures.set(server, fixture);
  const sockets = new WebSocketServer({ noServer: true });
  const upgradeSocket = (upgrade: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!new URL(upgrade.url!, "http://fixture").pathname.endsWith("/api/socket")) return;
    sockets.handleUpgrade(upgrade, socket, head, (ws) => {
      new RpcChannel(ws, {
        handle: async (operation, input, context) => {
          const routes = [...fixture.overrides].reverse();
          const dispatch = async (index: number): Promise<RpcReply> => {
            const route = routes[index];
            if (!route) {
              if (!fixture.handle)
                throw new RpcError("NOT_FOUND", `No native fixture operation: ${operation}`);
              return fixture.handle(operation, input, context);
            }
            const matches =
              route.operation === "*" ||
              route.operation === operation ||
              (Array.isArray(route.operation) && route.operation.includes(operation));
            return matches
              ? route.handle(input, context, () => dispatch(index + 1), operation)
              : dispatch(index + 1);
          };
          const reply = await dispatch(0);
          for (const observer of fixture.observers) observer(operation, input, reply);
          return reply;
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

/** Named overrides are test data. The default handler remains the real native implementation. */
export async function fixtureOperation(
  server: ViteDevServer,
  page: { on(event: "close", listener: () => void): unknown },
  operation: string | readonly string[],
  handle: Override["handle"],
) {
  const routes = fixtures.get(server)!.overrides;
  const override = { operation, handle };
  routes.push(override);
  page.on("close", () => {
    const index = routes.indexOf(override);
    if (index !== -1) routes.splice(index, 1);
  });
}
