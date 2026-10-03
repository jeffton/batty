import type { JsonValue } from "@earendil-works/chord";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { EntryRecord, SubmissionRecord } from "@earendil-works/pi-durable";

/** UI DTOs only. Durable records remain the sole persisted transcript. */
export function projectEntries(
  records: readonly EntryRecord[],
  submissions: readonly SubmissionRecord[] = [],
): SessionEntry[] {
  const entries: SessionEntry[] = [];
  let parentId: string | null = null;
  const submissionsByEntry = new Map(
    submissions.flatMap((submission) =>
      submission.entry === undefined ? [] : [[submission.entry, submission] as const],
    ),
  );
  for (const record of records) {
    const data = record.data as Record<string, JsonValue> | undefined;
    const timestamp = new Date(
      record.model?.[0]?.timestamp ?? (typeof data?.timestamp === "number" ? data.timestamp : 0),
    ).toISOString();
    const push = (value: object, id = String(record.id)) => {
      entries.push({ ...value, id, parentId, timestamp } as SessionEntry);
      parentId = id;
    };
    if (record.kind === "batty.session-info") {
      push({ type: "session_info", name: data!.name });
    } else if (record.kind === "batty.label") {
      push({ type: "label", targetId: data!.targetId, label: data!.label });
    } else if (record.kind === "batty.custom-message") {
      push({
        type: "custom_message",
        ...data,
        details: {
          ...(data?.details as object),
          durableEntryId: String(record.id),
          durableModel: record.model ?? [],
        },
      });
    } else if (record.kind === "pi.compaction") {
      const message = record.model?.[0];
      const summary =
        typeof message?.content === "string"
          ? message.content
          : (message?.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n") ?? "");
      push({
        type: "compaction",
        summary,
        firstKeptEntryId: String(record.head),
        tokensBefore: 0,
        details: { durableEntryId: String(record.id) },
      });
    } else if (record.model?.length) {
      const requestId =
        submissionsByEntry.get(record.id)?.requestId ??
        (typeof data?.submissionRequestId === "string" ? data.submissionRequestId : undefined);
      const customInput = requestId?.startsWith("custom-input:")
        ? JSON.parse(Buffer.from(requestId.split(":")[1]!, "base64url").toString("utf8"))
        : undefined;
      const taskId = record.byTaskId ?? data?.sourceToolTaskId;
      const artifactTaskId =
        taskId !== undefined && data?.sourceTaskNamespace
          ? `${data.sourceTaskNamespace}:${taskId}`
          : taskId;
      record.model.forEach((message, index) => {
        const id = index ? `${record.id}:${index}` : String(record.id);
        if (customInput && message.role === "user") {
          push(
            {
              type: "custom_message",
              ...customInput,
              content: message.content,
              details: { ...customInput.details, durableEntryId: id, durableModel: [message] },
            },
            id,
          );
        } else {
          push(
            {
              type: "message",
              message: {
                ...message,
                battyDurableEntryId: id,
                ...(artifactTaskId !== undefined ? { battyDurableTaskId: artifactTaskId } : {}),
                ...(requestId?.startsWith("client:")
                  ? { clientMessageId: requestId.slice(7) }
                  : typeof data?.clientMessageId === "string"
                    ? { clientMessageId: data.clientMessageId }
                    : {}),
              },
            },
            id,
          );
        }
      });
    } else {
      push({
        type: "custom",
        customType: record.kind === "batty.custom" ? data!.customType : record.kind,
        data:
          record.kind === "batty.custom"
            ? data!.customType === "batty.tool-artifacts" && data!.sourceTaskNamespace
              ? { ...(data!.data as object), sourceTaskNamespace: data!.sourceTaskNamespace }
              : data!.data
            : record.data,
      });
    }
  }
  return decorateDurableArtifacts(entries);
}

function mergeArtifactDetails(
  previous: Record<string, JsonValue>,
  next: Record<string, JsonValue>,
): Record<string, JsonValue> {
  const merged = { ...previous, ...next };
  for (const key of ["battyFileChanges", "sentFiles", "sites"]) {
    const before = previous[key];
    const after = next[key];
    if (!Array.isArray(before) && !Array.isArray(after)) continue;
    const unique = new Map(
      [...(Array.isArray(before) ? before : []), ...(Array.isArray(after) ? after : [])].map(
        (artifact) => [JSON.stringify(artifact), artifact],
      ),
    );
    merged[key] = [...unique.values()];
  }
  return merged;
}

/** Apply committed artifact receipts to presentation copies, never model state. */
export function decorateDurableArtifacts(
  entries: SessionEntry[],
  receipts: SessionEntry[] = entries,
): SessionEntry[] {
  const artifacts = new Map<string | number, Record<string, JsonValue>>();
  for (const entry of receipts) {
    if (entry.type !== "custom" || entry.customType !== "batty.tool-artifacts") continue;
    const data = entry.data as {
      toolTaskId?: number;
      sourceTaskNamespace?: string;
      details?: Record<string, JsonValue>;
    };
    if (typeof data?.toolTaskId === "number" && data.details) {
      const key = data.sourceTaskNamespace
        ? `${data.sourceTaskNamespace}:${data.toolTaskId}`
        : data.toolTaskId;
      artifacts.set(key, mergeArtifactDetails(artifacts.get(key) ?? {}, data.details));
    }
  }
  return entries.map((entry) => {
    if (entry.type !== "message" || entry.message.role !== "toolResult") return entry;
    const taskId = (
      entry.message as typeof entry.message & { battyDurableTaskId?: string | number }
    ).battyDurableTaskId;
    const details = taskId === undefined ? undefined : artifacts.get(taskId);
    return details
      ? {
          ...entry,
          message: {
            ...entry.message,
            details: mergeArtifactDetails(
              (entry.message.details as Record<string, JsonValue>) ?? {},
              details,
            ),
          },
        }
      : entry;
  });
}
