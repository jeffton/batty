import dns from "node:dns/promises";
import { isIP } from "node:net";
import https from "node:https";
import type { SiteConnection } from "@/shared/site-functions";

export const SITE_MAX_BYTES = 4 * 1024 * 1024;
export const SITE_SECRET_PREFIX = "BATTY_SITE_SECRET_";

export function validateSiteConnection(connection: SiteConnection): URL {
  const url = new URL(connection.url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443")
  )
    throw new Error("Connections require HTTPS on port 443 without credentials or fragments");
  new Headers(connection.headers);
  for (const [header, secret] of Object.entries(connection.secretHeaders ?? {})) {
    new Headers({ [header]: secret.prefix ?? "" });
    if (!/^BATTY_SITE_SECRET_[A-Za-z0-9_]+$/.test(secret.env))
      throw new Error(`Site secrets must use the ${SITE_SECRET_PREFIX} namespace`);
  }
  return url;
}

/** Deliberately IPv4-only: reject every non-public/reserved range before pinning DNS. */
export function isPublicSiteAddress(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a! >= 224 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

export interface SiteRequest {
  connection: string;
  method?: string;
  body?: unknown;
  path?: string;
}

function redact(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") {
    for (const secret of secrets) value = (value as string).replaceAll(secret, "[redacted]");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [redact(key, secrets), redact(item, secrets)]),
    );
  return value;
}

/** Root broker: worker supplies only a named capability and JSON, never a destination/header. */
export async function requestSiteConnection(
  connection: SiteConnection,
  args: SiteRequest,
  signal: AbortSignal,
): Promise<unknown> {
  try {
    const target = validateSiteConnection(connection);
    if (args.path !== undefined) {
      if (!target.pathname.endsWith("/") || target.search)
        throw new Error("Connection URL must end in / to use a path");
      const resolved = new URL(args.path, target);
      if (
        resolved.origin !== target.origin ||
        !resolved.pathname.startsWith(target.pathname) ||
        resolved.username ||
        resolved.password ||
        resolved.hash
      )
        throw new Error("Path is outside the connection");
      // Do not allow encoded separators/traversal to bypass prefix checks at the upstream router.
      for (const segment of resolved.pathname.split("/")) {
        const decoded = decodeURIComponent(segment);
        if (decoded === "." || decoded === ".." || /[%/\\]/.test(decoded))
          throw new Error("Invalid connection path");
      }
      target.href = resolved.href;
    }
    const method = args.method ?? "POST";
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method))
      throw new Error("Unsupported method");
    const hostname = target.hostname;
    const resolver = new dns.Resolver({ timeout: 2000, tries: 1 });
    const cancelDns = () => resolver.cancel();
    signal.addEventListener("abort", cancelDns, { once: true });
    let addresses: string[];
    try {
      addresses = isIP(hostname) ? [hostname] : await resolver.resolve4(hostname);
    } finally {
      signal.removeEventListener("abort", cancelDns);
    }
    if (!addresses.length || addresses.some((address) => !isPublicSiteAddress(address)))
      throw new Error("Connection must resolve to public IPv4 addresses");
    signal.throwIfAborted();
    const address = addresses[0]!;
    const headers = new Headers(connection.headers);
    const secrets: string[] = [];
    for (const [header, binding] of Object.entries(connection.secretHeaders ?? {})) {
      const value = process.env[binding.env];
      if (!value) throw new Error("A connection secret is not configured");
      secrets.push(value);
      headers.set(header, `${binding.prefix ?? ""}${value}`);
    }
    const payload = args.body === undefined ? undefined : JSON.stringify(args.body);
    if (payload && Buffer.byteLength(payload) > SITE_MAX_BYTES)
      throw new Error("Request too large");
    if (payload !== undefined) headers.set("Content-Type", "application/json");
    const body = await new Promise<string>((resolve, reject) => {
      const request = https.request(
        target,
        {
          method,
          headers: Object.fromEntries(headers),
          signal,
          family: 4,
          // Pin the checked address; TLS still verifies the original URL hostname/SNI.
          lookup: (_host, _options, callback) => callback(null, address, 4),
        },
        (response) => {
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            response.destroy();
            reject(new Error("Upstream request failed"));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > SITE_MAX_BYTES) response.destroy(new Error("Response too large"));
            else chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        },
      );
      request.on("error", reject);
      request.end(payload);
    });
    return redact(JSON.parse(body), secrets);
  } catch {
    // Includes URL/DNS/TLS and header-validation errors, which may embed secret values.
    throw new Error(
      "Connection request failed (check its public HTTPS destination and site-secret configuration)",
    );
  }
}
