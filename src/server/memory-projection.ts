import type { EntryRecord } from "@earendil-works/pi-durable";
import { decodeRuntimeNotice } from "./runtime-notices";

export type MemoryLeaf = {
  kind: "user" | "talk" | "tool" | "echo" | "note";
  text: string;
  date: string;
  source: number;
  ordinal: number;
};
export function projectEntry(entry: EntryRecord): MemoryLeaf[] {
  const imported =
    (entry.data as { provenance?: { source?: string } } | undefined)?.provenance?.source === "roy";
  const leaves: MemoryLeaf[] = [];
  const append = (kind: MemoryLeaf["kind"], text: string, timestamp: number) =>
    leaves.push({
      kind,
      text,
      date: new Date(timestamp).toISOString(),
      source: entry.id,
      ordinal: leaves.length,
    });
  for (const message of entry.model ?? []) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .map((part) => (part.type === "text" ? part.text : `[image ${part.mimeType}]`))
              .join("\n");
      const notice = decodeRuntimeNotice(message.content);
      append(
        notice || entry.kind === "batty.import-note" ? "note" : "user",
        notice ? `Runtime ${notice.kind}: ${notice.text}` : text,
        message.timestamp,
      );
    } else if (message.role === "assistant") {
      if (
        imported &&
        ((message.stopReason !== "stop" && message.stopReason !== "length") ||
          message.content.some((part) => part.type === "toolCall"))
      )
        continue;
      const text = message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n");
      if (text) append("talk", text, message.timestamp);
      for (const part of message.content)
        if (part.type === "toolCall")
          append("tool", `${part.name} ${JSON.stringify(part.arguments)}`, message.timestamp);
    } else if (message.role === "toolResult") {
      if (imported) continue;
      append(
        "echo",
        message.content
          .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
          .join("\n"),
        message.timestamp,
      );
    }
  }
  return leaves;
}
