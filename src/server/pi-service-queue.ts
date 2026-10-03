import type { SessionState } from "@/shared/types";
import type { WebSession } from "./pi-service-types";

export function getQueuedPrompts(webSession: WebSession): SessionState["queuedPrompts"] {
  return webSession.session.getQueuedPrompts();
}

export function removeQueuedPrompt(webSession: WebSession, submissionId: number): Promise<void> {
  return webSession.session.removeQueuedPrompt(submissionId);
}
