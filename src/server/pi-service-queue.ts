import type { SessionState } from "@/shared/types";
import type { WebSession } from "./pi-service-types";

export function getQueuedPrompts(webSession: WebSession): SessionState["queuedPrompts"] {
  return webSession.session.getQueuedPrompts();
}

export function removeQueuedPrompt(
  webSession: WebSession,
  kind: "steer" | "followUp",
  index: number,
): Promise<void> {
  return webSession.session.removeQueuedPrompt(kind, index);
}
