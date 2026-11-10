import { RpcError } from "@/shared/rpc";

/** Background reads recover through the session lifecycle; user actions still report failures. */
export function isConnectionError(error: unknown): boolean {
  return (
    (error instanceof RpcError && error.code === "OFFLINE") ||
    (error instanceof DOMException && error.name === "TimeoutError")
  );
}
