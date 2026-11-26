import { hook, GenerationTask, LiveDoc, type EntryRecord } from "@earendil-works/pi-durable";
import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import type { DurableFileChange } from "./agent-turn-file-changes";
import type { OrchestrationServices } from "./orchestration-state";
import {
  extractSelection,
  type MessagePresentation,
  type PresentedAssistant,
} from "./message-presentation";

export function messageDiffs(entries: readonly EntryRecord[]) {
  const mutations = entries.flatMap((entry) =>
    (entry.model ?? []).flatMap((message) =>
      message.role === "toolResult"
        ? ((message.details as { battyFileChanges?: DurableFileChange[] } | undefined)
            ?.battyFileChanges ?? [])
        : [],
    ),
  );
  mutations.sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
  const changes = new Map<string, DurableFileChange>();
  for (const change of mutations) {
    const first = changes.get(change.path);
    changes.set(change.path, { ...change, before: first ? first.before : change.before });
  }
  return [...changes.values()]
    .filter((change) => change.before !== change.after)
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(({ path, before, after }) => ({
      path,
      patch: generateUnifiedPatch(path, before ?? "", after),
    }));
}

export function presentationHook(services: OrchestrationServices) {
  return hook(GenerationTask, {
    afterResponse: async (message: PresentedAssistant, api, ctx) => {
      if (!["stop", "toolUse", "length"].includes(message.stopReason)) {
        // Failed attempts never select anything.
        try {
          extractSelection(message);
        } catch {
          /* the provider failure already reports the error */
        }
        return;
      }
      let presentation: MessagePresentation = {};
      try {
        const selection = extractSelection(message);
        if (selection)
          presentation = await services.resolvePresentation(api.conversationId, selection);
      } catch (error) {
        message.content.push({
          type: "text",
          text: `\n\nAttachment selection failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      if (message.stopReason !== "toolUse") {
        const first = (await api.snapshot(LiveDoc, api.conversationId, ctx))?.run?.first;
        if (first !== undefined) {
          const entries: EntryRecord[] = [];
          let cursor;
          do {
            const page = await api.entries({ minEntryId: first }, 200, cursor, ctx);
            entries.unshift(...[...page.items].reverse());
            cursor = page.next;
          } while (cursor);
          const fileChanges = messageDiffs(entries);
          if (fileChanges.length) presentation.fileChanges = fileChanges;
        }
      }
      if (Object.keys(presentation).length) message.battyPresentation = presentation;
    },
  });
}
