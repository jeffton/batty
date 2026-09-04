import type { SessionState } from "@/shared/types";
import type { WebSession } from "./pi-service-types";

export function getQueuedPrompts(webSession: WebSession): SessionState["queuedPrompts"] {
  return [
    ...webSession.session.getSteeringMessages().map((text, index) => ({
      kind: "steer" as const,
      index,
      text,
    })),
    ...webSession.session.getFollowUpMessages().map((text, index) => ({
      kind: "followUp" as const,
      index,
      text,
    })),
  ];
}

export function removeQueuedPrompt(
  webSession: WebSession,
  kind: "steer" | "followUp",
  index: number,
): void {
  webSession.session.removeQueuedPrompt(kind, index);
}
