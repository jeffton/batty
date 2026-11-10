import { RpcClient, RpcError, type RpcCaller } from "@/shared/rpc";
import type { OwnerInputs, OwnerOutputs, OwnerEvents } from "@/shared/owner-api";
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

export const rpcCall = client.call.bind(client) as RpcCaller<
  OwnerInputs,
  OwnerOutputs,
  OwnerEvents
>;
export const closeRpcTransport = client.close.bind(client);
