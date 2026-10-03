import type {
  SessionSnapshot,
  SessionState,
  ActiveToolRun,
  UiContentBlock,
  ToolExecutionDetails,
} from "@/shared/types";
import { stripTerminalFormatting } from "@/shared/terminal-output";
import { isPiShellToolName } from "@/shared/pi-tools";

/** Normalize native partial/queued content without touching resolved historic image URLs. */
export function presentationBlocks(content: unknown): UiContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return (content as Array<Record<string, unknown>>).flatMap((block): UiContentBlock[] => {
    switch (block.type) {
      case "text":
        return [{ type: "text", text: block.text as string }];
      case "thinking":
        return [{ type: "thinking", thinking: block.thinking as string }];
      case "toolCall":
        return [
          {
            type: "toolCall",
            id: block.id as string,
            name: block.name as string,
            arguments: block.arguments as Record<string, unknown>,
          },
        ];
      case "image":
        return [
          {
            type: "image",
            mimeType: block.mimeType as string,
            data: block.data as string | undefined,
            url: block.url as string | undefined,
          },
        ];
      default:
        return [];
    }
  });
}

interface NativeNestedCalls {
  readonly complete: boolean;
  readonly calls: readonly {
    readonly id: string;
    readonly name: string;
    readonly status: "unfinished" | "ok" | "error";
    readonly arguments?: Record<string, unknown>;
    readonly argumentsBytes?: number;
    readonly durationMs?: number;
    readonly error?: string;
    readonly output?: string;
  }[];
}

/** Bounded native previews become rows, never a retained client-side accumulator. */
export function nestedToolRuns(details: ToolExecutionDetails | undefined): ActiveToolRun[] {
  const nested = details?.nestedCalls as NativeNestedCalls | undefined;
  return (nested?.calls ?? []).map((call) => {
    const output = isPiShellToolName(call.name)
      ? stripTerminalFormatting(call.output ?? "")
      : (call.output ?? "");
    return {
      toolCallId: call.id,
      parentToolCallId: call.id.slice(0, call.id.lastIndexOf("/")),
      toolName: call.name,
      args: call.arguments ?? {},
      blocks: output ? [{ type: "text", text: output }] : [],
      status: call.status === "unfinished" ? "running" : call.status === "ok" ? "success" : "error",
      isError: call.status === "error",
      details: {
        durationMs: call.durationMs,
        error: call.error,
        argumentsBytes: call.argumentsBytes,
      },
    };
  });
}

/** The only live-state-to-UI projection. Native documents are never mutated. */
export function presentSession(snapshot: SessionSnapshot | undefined): SessionState | undefined {
  if (!snapshot) return undefined;
  const live = snapshot.documents["pi.live"];
  const partial = live.generation?.message;
  const activeAssistant: SessionState["activeAssistant"] = partial
    ? {
        id: "live-assistant",
        role: "assistant",
        timestamp: partial.timestamp,
        turnPhase: "pending",
        blocks: presentationBlocks(partial.content),
        model: partial.model,
        provider: partial.provider,
        stopReason: partial.stopReason,
        errorMessage: partial.errorMessage,
      }
    : undefined;
  const calls = new Map<string, Record<string, unknown>>();
  for (const message of [...snapshot.messages, ...(activeAssistant ? [activeAssistant] : [])]) {
    if (message.role !== "assistant") continue;
    for (const block of message.blocks) {
      if (block.type === "toolCall") calls.set(block.id, block.arguments);
    }
  }
  const activeTools = (live.tools ?? []).flatMap((slot): ActiveToolRun[] => {
    const result =
      slot.status === "done" && slot.entry != null
        ? snapshot.messages.find(
            (message) =>
              message.role === "toolResult" && message.durableEntryId === String(slot.entry),
          )
        : undefined;
    const committed = result?.role === "toolResult" ? result : undefined;
    const isError = committed?.isError ?? (slot.status === "done" && !slot.entry);
    const output = isPiShellToolName(slot.name)
      ? stripTerminalFormatting(slot.output ?? "")
      : (slot.output ?? "");
    const tool: ActiveToolRun = {
      toolCallId: slot.callId,
      toolName: slot.name,
      args: calls.get(slot.callId) ?? {},
      blocks: committed?.blocks ?? (output ? [{ type: "text" as const, text: output }] : []),
      status:
        slot.status === "done"
          ? isError
            ? ("error" as const)
            : ("success" as const)
          : ("running" as const),
      isError,
      details: committed?.details ?? {
        ...(slot.details as ToolExecutionDetails | undefined),
        droppedBytes: slot.droppedBytes,
        droppedLines: slot.droppedLines,
        diagnostics: slot.diagnostics,
      },
    };
    return [tool, ...nestedToolRuns(tool.details)];
  });
  const counts = { steer: 0, followUp: 0 };
  const queuedPrompts = snapshot.documents["pi.inbox"].items.flatMap((item) => {
    if (item.mode === "write") return [];
    const blocks = presentationBlocks(item.content);
    return [
      {
        submissionId: item.id,
        kind: item.mode,
        index: counts[item.mode]++,
        text: blocks
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n"),
        blocks,
        clientMessageId: snapshot.queuedClientMessageIds[item.id],
      },
    ];
  });
  return {
    ...snapshot.metadata,
    messages: snapshot.messages,
    activeAssistant,
    activeTools,
    isStreaming: Boolean(live.run),
    isCompacting: Boolean(live.compactions?.length),
    queuedPrompts,
    pendingMessageCount: queuedPrompts.length,
  };
}
