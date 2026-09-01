import { withBaseUrl } from "@/client/lib/base-url";

export function workspaceEventsPath(): string {
  return withBaseUrl("/api/workspaces/events");
}
