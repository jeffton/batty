import { RpcError } from "../shared/rpc";

/** Translate domain errors once for both owner and peer operation boundaries. */
export function rpcError(error: unknown): RpcError {
  if (error instanceof RpcError) return error;
  const failure = error as Error & { statusCode?: number; code?: string; pages?: unknown };
  const code = failure.pages
    ? "SELECTION_CHANGED"
    : failure.code === "ENOENT"
      ? "NOT_FOUND"
      : ((
          {
            400: "BAD_INPUT",
            401: "UNAUTHORIZED",
            403: "FORBIDDEN",
            404: "NOT_FOUND",
            409: "CONFLICT",
            410: "GONE",
            429: "RATE_LIMITED",
            501: "UNAVAILABLE",
            503: "OFFLINE",
            504: "TIMEOUT",
          } as Record<number, string>
        )[failure.statusCode ?? 500] ?? (error instanceof RangeError ? "BAD_INPUT" : "INTERNAL"));
  return new RpcError(
    code,
    error instanceof Error ? error.message : String(error),
    failure.pages ? { pages: failure.pages } : undefined,
  );
}
