import type { Agent, AgentChange } from "@earendil-works/pi-durable";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { conversationPolicy } from "./conversation-policy.js";
import { MAIN_MEMORY_TOOLS } from "./main-memory-policy.js";

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
export function workerTools(agent: Agent, workspaceId: string): string[] {
  const memoryTools = conversationPolicy("worker", workspaceId).mainMemory
    ? agent.extensions.flatMap((extension) =>
        extension.name === "batty-optchat" ? (extension.tools ?? []) : [],
      )
    : [];
  return [
    ...new Set(
      [...agent.tools, ...memoryTools]
        .filter(
          (tool) =>
            tool.name !== "memory_overview" &&
            (conversationPolicy("worker", workspaceId).mainMemory ||
              !MAIN_MEMORY_TOOLS.has(tool.name)),
        )
        .map((tool) => tool.name),
    ),
  ];
}
