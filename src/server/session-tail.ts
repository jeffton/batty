import type { Message } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { decodeRuntimeNotice } from "./runtime-notices";

// One size policy, with 20% hysteresis: advance in byte-sized batches, never
// every turn. JSON includes tools, reasoning, reports and image payloads.
export const SESSION_TAIL_BYTES = 200_000;
export const SESSION_TAIL_RETAIN_RATIO = 0.8;

function contributions(entries: readonly EntryRecord[]): Message[][] {
  // Respect the ordinary session's contextual edits; originals stay archived.
  const edits = new Map(
    entries.flatMap((entry) => (entry.edits ?? []).map((edit) => [edit.target, edit] as const)),
  );
  return entries.map((entry) => {
    const edit = edits.get(entry.id);
    const model =
      edit?.action === "omit"
        ? []
        : edit?.action === "replace"
          ? edit.messages
          : (entry.model ?? []);
    return model.flatMap((message): Message[] => {
      if (
        message.role === "system" ||
        (message.role === "assistant" &&
          ["aborted", "error", "deferred"].includes(message.stopReason))
      )
        return [];
      const notice = message.role === "user" && decodeRuntimeNotice(message.content);
      return [notice ? ({ ...message, content: notice.text } as Message) : message];
    });
  });
}

export function sessionMessages(entries: readonly EntryRecord[]): Message[] {
  const messages = contributions(entries).flat();
  // Pi's context ordering is internal, not exported. Mirror its pairing rules:
  // interrupted calls get an explicit unavailable result, orphan results are
  // excluded and committed results retain their original payload/signatures.
  const ordered: Message[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === "toolResult") continue;
    ordered.push(message);
    if (message.role !== "assistant") continue;
    const results = new Map<string, Message>();
    for (
      let next = index + 1;
      next < messages.length && messages[next]!.role !== "assistant";
      next++
    ) {
      const result = messages[next]!;
      if (result.role === "toolResult" && !results.has(result.toolCallId))
        results.set(result.toolCallId, result);
    }
    for (const call of message.content) {
      if (call.type !== "toolCall") continue;
      ordered.push(
        results.get(call.id) ?? {
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [
            {
              type: "text",
              text: "Tool result unavailable: history ends before this call completed.",
            },
          ],
          isError: true,
          timestamp: message.timestamp,
        },
      );
    }
  }
  return ordered;
}

export function sessionBytes(messages: readonly Message[]): number {
  return Buffer.byteLength(JSON.stringify(messages), "utf8");
}

export function rolloverBoundary(
  entries: readonly EntryRecord[],
  currentInput: number,
  threshold: number,
): number | undefined {
  const bytes = contributions(entries).map((messages) =>
    messages.length ? sessionBytes(messages) - 1 : 0,
  );
  let remaining = bytes.reduce((sum, size) => sum + size, 1);
  if (remaining <= threshold) return undefined;
  const boundaries = new Set([
    currentInput,
    ...entries.filter((entry) => entry.kind === "batty.run-head").map((entry) => entry.head!),
  ]);
  const retain = threshold * SESSION_TAIL_RETAIN_RATIO;
  const total = remaining;
  let latest: number | undefined;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    // Cut only between runs, keeping tool calls/results and reasoning together.
    if (boundaries.has(entry.id)) {
      if (remaining <= retain) return entry.id;
      if (total - remaining >= threshold - retain) latest = entry.id;
    }
    remaining -= bytes[index]!;
  }
  // An oversized current run cannot be split, but need not pin older runs.
  return latest;
}
