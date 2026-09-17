import { stripBaseUrl } from "./base-url";

export function resolveAuthReturnTo(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return undefined;
  }

  const url = new URL(value, window.location.origin);
  const pathname = stripBaseUrl(url.pathname);
  if (url.origin !== window.location.origin || !pathname?.startsWith("/sites/")) {
    return undefined;
  }

  return `${url.pathname}${url.search}${url.hash}`;
}
