import type { AgentSession, SessionEntry } from "@earendil-works/pi-coding-agent";

const INTERRUPTED_TOOL_RESULT =
  "Batty restarted while this tool call was in progress. Its completion is unknown, so it was not run again automatically. Inspect the current state before deciding whether to retry it.";

type ToolResult = Extract<AgentSession["messages"][number], { role: "toolResult" }>;

export type InteractiveTurnRecoveryPlan =
  | { action: "complete" }
  | { action: "resume"; toolResults: ToolResult[]; rewindTo?: string | null };

/** Inspect the durable transcript without changing it. */
export function prepareInteractiveTurnRecovery(
  entries: SessionEntry[],
): InteractiveTurnRecoveryPlan {
  const messages = entries.filter((entry) => entry.type === "message");
  const tail = messages.at(-1);
  if (!tail) return { action: "complete" };

  const lastAssistant = messages.findLast((entry) => entry.message.role === "assistant");
  if (lastAssistant?.message.role === "assistant") {
    const calls = lastAssistant.message.content.filter((part) => part.type === "toolCall");
    if (calls.length > 0) {
      const results = new Set(
        messages
          .slice(messages.indexOf(lastAssistant) + 1)
          .flatMap(({ message }) => (message.role === "toolResult" ? [message.toolCallId] : [])),
      );
      return {
        action: "resume",
        toolResults: calls
          .filter((call) => !results.has(call.id))
          .map((call) => ({
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text", text: INTERRUPTED_TOOL_RESULT }],
            isError: true,
            timestamp: Date.now(),
          })),
      };
    }
  }

  if (tail.message.role === "assistant") {
    if (tail.message.stopReason === "error" || tail.message.stopReason === "length") {
      return { action: "resume", toolResults: [], rewindTo: tail.parentId };
    }
    return { action: "complete" };
  }
  return { action: "resume", toolResults: [] };
}

export async function resumeInteractiveTurn(
  session: AgentSession,
  plan: Extract<InteractiveTurnRecoveryPlan, { action: "resume" }>,
): Promise<void> {
  if (plan.rewindTo !== undefined) {
    if (plan.rewindTo === null) session.sessionManager.resetLeaf();
    else session.sessionManager.branch(plan.rewindTo);
    session.agent.state.messages = session.agent.state.messages.slice(0, -1);
  }
  for (const result of plan.toolResults) {
    session.sessionManager.appendMessage(result);
    session.agent.state.messages.push(result);
  }
  await session.resumeInterruptedTurn();
}
