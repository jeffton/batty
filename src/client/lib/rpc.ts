import { RpcClient, RpcError } from "@/shared/rpc";
import { withBaseUrl } from "./base-url";

export type { RpcCallOptions } from "@/shared/rpc";

const client = new RpcClient(
  () => {
    const url = new URL(withBaseUrl("/api/socket"), window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return new WebSocket(url);
  },
  {
    // Upgrade cookies are fixed for a generation. Discard a rejected identity.
    invalidate: (error) => error instanceof RpcError && error.code === "UNAUTHORIZED",
  },
);

export const rpcCall = client.call.bind(client);
export const closeRpcTransport = client.close.bind(client);
