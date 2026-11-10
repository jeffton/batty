import {
  AgentDoc,
  type Agent,
  type AgentChange,
  type Cursor,
  type Harness,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

// Refresh persisted allowlists before durable generations resume after startup.
export async function enableWorkerMemory(harness: Harness, context: Context) {
  let cursor: Cursor | undefined;
  do {
    cursor = await harness.commit(async (tx) => {
      const page = await tx.scanConversations({}, 100, cursor);
      for (const conversation of page.items) {
        const agent = await tx.doc(AgentDoc, conversation.id);
        if (!Array.isArray(agent.tools)) continue;
        for (const name of ["memory_search", "memory_zoom"]) {
          if (!agent.tools.includes(name)) agent.tools.push(name);
        }
      }
      return page.next;
    }, context);
  } while (cursor !== undefined);
}

export function modelChange(model?: string, effort?: string): AgentChange {
  const change: AgentChange = {};
  if (model) {
    const slash = model.indexOf("/");
    if (slash < 1) throw new Error("Model must be provider/modelId");
    (change as { model: { provider: string; modelId: string } }).model = {
      provider: model.slice(0, slash),
      modelId: model.slice(slash + 1),
    };
  }
  if (effort) {
    if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort))
      throw new Error(`Invalid thinking level: ${effort}`);
    (change as { thinkingLevel: ModelThinkingLevel }).thinkingLevel = effort as ModelThinkingLevel;
  }
  return change;
}
export function workerTools(agent: Agent): string[] {
  const memoryTools = agent.extensions.flatMap((extension) =>
    extension.name === "batty-optchat" ? (extension.tools ?? []) : [],
  );
  return [
    ...new Set(
      // Model tools exclude caller-only adapters; workers still need them for nested execution.
      [
        ...agent.tools,
        ...agent.extensions.flatMap((extension) =>
          (extension.tools ?? []).filter(
            (tool) => tool.callers?.length === 1 && tool.callers[0] === "tools",
          ),
        ),
        ...memoryTools,
      ]
        .filter((tool) => tool.name !== "memory_overview")
        .map((tool) => tool.name),
    ),
  ];
}
