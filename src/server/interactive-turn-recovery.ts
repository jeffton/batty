import type { AgentSession, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { PreparedInteractiveTurnSubmission } from "./active-interactive-turn-journal";

const INTERRUPTED_TOOL_RESULT =
  "Batty restarted while this tool call was in progress. Its completion is unknown, so it was not run again automatically. Inspect the current state before deciding whether to retry it.";

interface MessageLike {
  role: string;
  clientMessageId?: string;
  toolCallId?: string;
  stopReason?: string;
  content?: unknown;
}

export interface InteractiveTurnRecoveryPlan {
  action: "resume" | "prompt" | "complete";
  pendingSubmissions: PreparedInteractiveTurnSubmission[];
}

function branchMessages(entries: SessionEntry[]): MessageLike[] {
  return entries.flatMap((entry) =>
    entry.type === "message" ? [entry.message as MessageLike] : [],
  );
}

function toolCalls(message: MessageLike): Array<{ id: string; name: string }> {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content.flatMap((part) => {
    if (
      typeof part === "object" &&
      part !== null &&
      (part as { type?: unknown }).type === "toolCall" &&
      typeof (part as { id?: unknown }).id === "string" &&
      typeof (part as { name?: unknown }).name === "string"
    ) {
      return [{ id: (part as { id: string }).id, name: (part as { name: string }).name }];
    }
    return [];
  });
}

/**
 * Build a recovery plan from the durable active branch. Missing tool results are
 * recorded as uncertain errors instead of rerunning tools whose side effects may
 * already have happened before the process stopped.
 */
export function prepareInteractiveTurnRecovery(
  session: AgentSession,
  submissions: PreparedInteractiveTurnSubmission[],
): InteractiveTurnRecoveryPlan {
  const branch = session.sessionManager.getBranch();
  const messageEntries = branch.filter((entry) => entry.type === "message");
  const messages = branchMessages(branch);
  const persistedClientMessageIds = new Set(
    messages.flatMap((message) =>
      message.role === "user" && message.clientMessageId ? [message.clientMessageId] : [],
    ),
  );
  const pendingSubmissions = submissions.filter(
    (submission) => !persistedClientMessageIds.has(submission.clientMessageId),
  );

  if (messages.length === 0 || !persistedClientMessageIds.has(submissions[0]!.clientMessageId)) {
    return { action: "prompt", pendingSubmissions };
  }

  let lastAssistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      lastAssistantIndex = index;
      break;
    }
  }

  const lastAssistant = lastAssistantIndex >= 0 ? messages[lastAssistantIndex] : undefined;
  const calls = lastAssistant ? toolCalls(lastAssistant) : [];
  if (calls.length > 0) {
    const resultIds = new Set(
      messages
        .slice(lastAssistantIndex + 1)
        .flatMap((message) =>
          message.role === "toolResult" && message.toolCallId ? [message.toolCallId] : [],
        ),
    );
    for (const call of calls) {
      if (resultIds.has(call.id)) continue;
      const result = {
        role: "toolResult" as const,
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text" as const, text: INTERRUPTED_TOOL_RESULT }],
        isError: true,
        timestamp: Date.now(),
      };
      session.sessionManager.appendMessage(result);
      session.agent.state.messages.push(result);
    }
    return { action: "resume", pendingSubmissions };
  }

  const tail = messages.at(-1);
  if (tail?.role === "assistant") {
    if (tail.stopReason === "error" || tail.stopReason === "length") {
      const tailEntry = messageEntries.at(-1)!;
      if (tailEntry.parentId) {
        session.sessionManager.branch(tailEntry.parentId);
      } else {
        session.sessionManager.resetLeaf();
      }
      if (session.agent.state.messages.at(-1)?.role === "assistant") {
        session.agent.state.messages = session.agent.state.messages.slice(0, -1);
      }
      return { action: "resume", pendingSubmissions };
    }
    return {
      action: pendingSubmissions.length > 0 ? "prompt" : "complete",
      pendingSubmissions,
    };
  }

  return { action: "resume", pendingSubmissions };
}
