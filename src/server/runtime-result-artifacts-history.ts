import type { EntryRecord, Storage, ConversationId, Cursor } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { UiMessage } from "@/shared/types";
import { runtimeResultArtifacts } from "./runtime-result-artifacts";
import { BATTY_RUNTIME_NOTICE_CUSTOM_TYPE } from "./runtime-notices";
import { projectUiMetadata } from "./ui-artifact-projection";

/** Historical notices resolve their exact durable delivery, not answer text or latest worker state. */
export async function hydrateRuntimeResultArtifacts(
  storage: Storage,
  parentId: ConversationId,
  message: UiMessage,
): Promise<void> {
  if (message.role !== "custom" || !message.customType.startsWith(BATTY_RUNTIME_NOTICE_CUSTOM_TYPE))
    return;
  if (message.data?.runtimeResultArtifacts) {
    message.data = projectUiMetadata(message.data);
    return;
  }
  const source = (message.data?.cron ?? message.data?.subagent) as
    | { sessionId?: string }
    | undefined;
  if (!source?.sessionId || !message.data?.runtimeNotice) return;
  let cursor: Cursor | undefined;
  let deliveryId: string | undefined;
  do {
    const page = await storage.scanSubmissions(
      { conversationId: parentId },
      200,
      cursor,
      BACKGROUND_CONTEXT,
    );
    const report = page.items.find(
      (submission) =>
        String(submission.entry) === message.id &&
        submission.requestId?.startsWith("batty-report:"),
    );
    if (report) {
      deliveryId = report.requestId!.slice("batty-report:".length);
      break;
    }
    cursor = page.next;
  } while (cursor);
  if (!deliveryId) return;
  const conversationId = Number(source.sessionId) as ConversationId;
  const sourceSubmission = await storage.submissionByRequest(
    conversationId,
    `batty-deliver:${deliveryId}`,
    BACKGROUND_CONTEXT,
  );
  if (sourceSubmission?.type !== "input" || sourceSubmission.status !== "done") return;
  const entries: EntryRecord[] = [];
  cursor = undefined;
  do {
    const page = await storage.scanEntries(
      { conversationId, minEntryId: sourceSubmission.entry, maxEntryId: sourceSubmission.answer },
      200,
      cursor,
      BACKGROUND_CONTEXT,
    );
    entries.unshift(...[...page.items].reverse());
    cursor = page.next;
  } while (cursor);
  message.data!.runtimeResultArtifacts = projectUiMetadata(runtimeResultArtifacts(entries));
}
