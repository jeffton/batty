import type { UiMessage } from "@/shared/types";

/** Mutation snapshots and forwarding bookkeeping belong to durable agent history,
 * not the UI. Keep every other metadata field, including immutable diff patches.
 * Only descend through known tool/notice metadata containers, never tool arguments
 * or unrelated application data that happens to use the same field names.
 */
export function projectUiMetadata<T extends object>(metadata: T): T {
  const {
    battyFileChanges: _snapshots,
    forwardedArtifacts: _forwarded,
    ...visible
  } = metadata as Record<string, unknown>;
  for (const key of ["details", "runtimeResultArtifacts"] as const) {
    const value = visible[key];
    if (value && typeof value === "object" && !Array.isArray(value))
      visible[key] = projectUiMetadata(value as Record<string, unknown>);
  }
  if (Array.isArray(visible.calls)) {
    visible.calls = visible.calls.map((call) =>
      call && typeof call === "object" && !Array.isArray(call)
        ? projectUiMetadata(call as Record<string, unknown>)
        : call,
    );
  }
  return visible as T;
}

/** Also covers remote/already-projected history at the HTTP and WebSocket event boundary. */
export function projectUiMessage(message: UiMessage): UiMessage {
  if (message.role === "toolResult" && message.details)
    return { ...message, details: projectUiMetadata(message.details) };
  if (message.role === "custom" && message.data)
    return { ...message, data: projectUiMetadata(message.data) };
  return message;
}
