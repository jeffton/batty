import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/** Preserve nested subagent destinations without exposing their output to the model. */
export function createCodemodeSubagentExtension(): ExtensionFactory {
  return (pi) => {
    const destinations = new Map<string, Map<string, unknown>>();
    pi.on("agent_end", () => destinations.clear());
    pi.on("tool_result", (event) => {
      if (event.parentToolCallId && event.toolName === "subagent") {
        const subagent = (event.details as { subagent?: unknown } | undefined)?.subagent;
        if (subagent) {
          const calls = destinations.get(event.parentToolCallId) ?? new Map();
          calls.set(event.toolCallId, subagent);
          destinations.set(event.parentToolCallId, calls);
        }
        return undefined;
      }
      if (event.toolName !== "codemode") return undefined;
      const subagents = destinations.get(event.toolCallId);
      destinations.delete(event.toolCallId);
      if (!subagents) return undefined;
      const details = event.details as { calls: Array<{ id: string }> };
      return {
        details: {
          ...details,
          calls: details.calls.map((call) =>
            subagents.has(call.id) ? { ...call, subagent: subagents.get(call.id) } : call,
          ),
        },
      };
    });
  };
}
