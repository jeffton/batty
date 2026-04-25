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

export async function removeQueuedPrompt(
  webSession: WebSession,
  kind: "steer" | "followUp",
  index: number,
): Promise<void> {
  const queued = webSession.session.clearQueue();
  const steering = queued.steering.filter(
    (_, candidateIndex) => kind !== "steer" || candidateIndex !== index,
  );
  const followUp = queued.followUp.filter(
    (_, candidateIndex) => kind !== "followUp" || candidateIndex !== index,
  );

  for (const message of steering) {
    await webSession.session.steer(message);
  }
  for (const message of followUp) {
    await webSession.session.followUp(message);
  }
}
