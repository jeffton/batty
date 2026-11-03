import { appBaseUrl } from "./base-url";

// Browser storage and Web Locks are origin-wide, unlike path-scoped cookies.
export function installationStorageKey(name: string): string {
  return `batty:${encodeURIComponent(appBaseUrl())}:${name}`;
}
