import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { Type, type ImageContent, type Message, type TextContent } from "@earendil-works/pi-ai";
import { getCurrentSystemMessage, normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import {
  defineExtension,
  defineTool,
  GenerationTask,
  type GenerationCheckpoint,
  DEFAULT_COMPACTION_POLICY,
  CompactionTask,
  hook,
  LiveDoc,
  section,
  type Conversation,
  type ConversationId,
  type SubmissionId,
  type EntryId,
  type Harness,
} from "@earendil-works/pi-durable";
import type { MemorySearchOptions, MemorySearch } from "./memory-search";
import { Packets, WorkerMemory, MemoryRecall, type MemorySnapshot } from "./memory-documents";
import { decodeRuntimeNotice } from "./runtime-notices";
import { WorkerDoc } from "./orchestration";
import { conversationPolicy } from "./conversation-policy";
import { MAIN_MEMORY_TOOLS, isMainMemoryView, withoutMainMemory } from "./main-memory-policy";
import { MEMORY_PROMPT } from "./memory-prompts";

type MemoryRequests = {
  main: () => Conversation;
  harness: () => Harness;
  rootSessionId: () => string;
  assistantWorkspaceId: () => Promise<string | undefined>;
  load: (context: Context) => Promise<void>;
  conversationalView: (
    maximum: number,
    fits: (view: string) => boolean,
    context: Context,
  ) => Promise<{ view: string; snapshot: MemorySnapshot }>;
  preparedView: () => { view: string; snapshot: MemorySnapshot };
  zoom: (
    id: number,
    count: number,
    context: Context,
    snapshot?: MemorySnapshot,
  ) => Promise<(TextContent | ImageContent)[]>;
  search: (options: MemorySearchOptions, context: Context) => ReturnType<MemorySearch["search"]>;
  recall: (
    prompt: string,
    recent: string[],
    before: number,
    visible: Set<number>,
    context: Context,
  ) => Promise<string>;
  report: (error: unknown) => void;
};

// Keep complete OptChat lines and valid framing when admission space is tight.
export function fitMemoryRecall(text: string, fits: (text: string) => boolean): string {
  const lines = text.split("\n");
  const start = lines.indexOf("<chat>") + 1;
  let end = lines.indexOf("</chat>");
  while (text && !fits(text)) {
    if (end <= start) return "";
    lines.splice(--end, 1);
    text = end === start ? "" : lines.join("\n");
  }
  return text;
}

export function createMemoryRequests({
  main,
  harness,
  rootSessionId,
  assistantWorkspaceId,
  load,
  conversationalView,
  preparedView,
  zoom,
  search,
  recall,
  report,
}: MemoryRequests) {
  const validPackets = new Set<string>();
  async function canAccessMemory(conversationId: ConversationId, workspaceId?: string) {
    return conversationPolicy(
      conversationId === main().id ? "assistant" : "worker",
      workspaceId,
      await assistantWorkspaceId(),
    ).mainMemory;
  }
  async function mainSnapshot(context: Context) {
    const live = await harness().snapshot(LiveDoc, main().id, context);
    const runId = live?.run?.inputs[0];
    return runId
      ? (await harness().snapshot(Packets, main().id, String(runId), context))?.snapshot
      : undefined;
  }
  let packetQueue: Promise<unknown> = Promise.resolve();
  function packetForRun(runId: SubmissionId, fits: (view: string) => boolean, context: Context) {
    const result = packetQueue.then(() => createPacket(runId, fits, context));
    packetQueue = result.catch(() => undefined);
    return result;
  }
  async function createPacket(
    runId: SubmissionId,
    fits: (view: string) => boolean,
    context: Context,
  ) {
    const packet = await harness().snapshot(Packets, main().id, String(runId), context);
    if (packet && fits(packet.view)) return packet;
    const input = await (await harness().submission(runId, context))!.status(context);
    if (!input.entry) throw new Error("Main run input has no entry");
    const candidate = {
      ...(await conversationalView(input.entry - 1, fits, context)),
      boundary: input.entry as number,
    };
    return main().commit(async (tx) => {
      Object.assign(await tx.doc(Packets, main().id, String(runId), candidate), candidate);
      if (!packet) await tx.appendEntry(main().id, { kind: "batty.run-head", head: input.entry });
      return candidate;
    }, context);
  }
  async function runTail(
    messages: readonly Message[],
    boundary: EntryId,
    context: Context,
  ): Promise<Message[]> {
    const entry = await main().commit((tx) => tx.entry(boundary), context);
    const original = entry!.model![0]!;
    const start = messages.findIndex(
      (message) =>
        message.role === "user" &&
        message.timestamp === original.timestamp &&
        JSON.stringify(message.content) ===
          JSON.stringify(decodeRuntimeNotice(original.content)?.text ?? original.content),
    );
    if (start < 0) throw new Error("Main run boundary absent from request");
    // Pi may emit its complete system baseline after the input/run-head.
    // Replay every patch, then lead with the effective instructions and tools.
    const system = getCurrentSystemMessage(messages);
    return [
      ...(system ? [{ ...system, timestamp: 0 }] : []),
      ...messages.slice(start).filter((message) => message.role !== "system"),
    ];
  }
  const extension = defineExtension({
    name: "batty-optchat",
    sections: [section("memory", () => MEMORY_PROMPT)],
    tools: [
      defineTool({
        name: "memory_zoom",
        description:
          "Open prepared main-memory line id+n into its two child summaries with UTC timestamp ranges; n=1 returns the original UTC timestamp, uncompressed non-thought text and original images from that message. No reasoning or full message metadata. From a search/recall ID, use memory_zoom(id - 1, 1) or memory_zoom(id + 1, 1) to read neighboring original messages, also across summary boundaries. Neighbors may be tool calls or runtime notes.",
        parameters: Type.Object({ id: Type.Integer(), n: Type.Integer() }),
        replay: "safe",
        outputLimits: { maxBytes: Number.MAX_SAFE_INTEGER, maxLines: Number.MAX_SAFE_INTEGER },
        execute: async ({ id, n }, api, context) => {
          const worker = await api.snapshot(WorkerDoc, api.conversationId, context);
          if (!(await canAccessMemory(api.conversationId, worker?.workspaceId)))
            throw new Error("Main memory is available only in the assistant workspace");
          const snapshot =
            api.conversationId === main().id
              ? await mainSnapshot(context)
              : (await api.snapshot(WorkerMemory, api.conversationId, context))?.snapshot;
          return { output: await zoom(id, n, context, snapshot) };
        },
      }),
      defineTool({
        name: "memory_search",
        description:
          "Search original main-memory text using 1–12 words (all must match). Ranked by exact matches then BM25 relevance; conservative whole-word variants match longer words. Short words stay exact. Returns bounded snippets with original id/date/kind; use memory_zoom(id, 1) for full text. Tools/results excluded unless includeTools is true. No semantic search.",
        parameters: Type.Object({
          query: Type.String({ maxLength: 256 }),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
          includeTools: Type.Optional(Type.Boolean()),
        }),
        replay: "safe",
        execute: async (options, api, context) => {
          const worker = await api.snapshot(WorkerDoc, api.conversationId, context);
          if (!(await canAccessMemory(api.conversationId, worker?.workspaceId)))
            throw new Error("Main memory is available only in the assistant workspace");
          return {
            output: [{ type: "text", text: JSON.stringify(await search(options, context)) }],
          };
        },
      }),
    ],
    hooks: [
      hook(CompactionTask, {
        beforeCompact: (_, api) =>
          conversationPolicy(api.conversationId === main().id ? "assistant" : "worker")
            .nativeCompaction
            ? undefined
            : { decline: true },
      }),
      hook(GenerationTask, {
        beforeRequest: async ({ messages }, api, context) => {
          if (api.conversationId !== main().id) {
            const worker = await api.snapshot(WorkerDoc, api.conversationId, context);
            if (!(await canAccessMemory(api.conversationId, worker?.workspaceId))) {
              const isolated = withoutMainMemory(messages);
              const system = getCurrentSystemMessage(messages);
              return {
                messages: [
                  ...(system
                    ? [
                        {
                          ...system,
                          toolsAdded: system.toolsAdded?.filter(
                            (tool) => !MAIN_MEMORY_TOOLS.has(tool.name),
                          ),
                        },
                      ]
                    : []),
                  ...isolated,
                ],
              };
            }
            let snapshot = await harness().snapshot(WorkerMemory, api.conversationId, context);
            if (!snapshot?.view) {
              await load(context);
              const active = await harness().snapshot(LiveDoc, main().id, context);
              const runId = active?.run?.inputs[0];
              const packet = runId
                ? await harness().snapshot(Packets, main().id, String(runId), context)
                : undefined;
              const prepared = preparedView();
              const candidate = {
                view: packet?.view ?? prepared.view,
                snapshot: packet?.snapshot ?? prepared.snapshot,
              };
              const conversation = (await harness().conversation(api.conversationId, context))!;
              snapshot = await conversation.commit(async (tx) => {
                const pinned = await tx.doc(WorkerMemory, api.conversationId);
                if (pinned.view === null) {
                  pinned.view = candidate.view;
                  pinned.snapshot = candidate.snapshot;
                }
                return {
                  view: pinned.view,
                  snapshot: pinned.snapshot ? { ...pinned.snapshot } : undefined,
                };
              }, context);
            }
            const system = getCurrentSystemMessage(messages);
            return {
              messages: [
                ...(system ? [{ ...system, timestamp: 0 }] : []),
                {
                  role: "user",
                  content: snapshot!.view!,
                  timestamp: 0,
                },
                ...messages.filter(
                  (message) => message.role !== "system" && !isMainMemoryView(message),
                ),
              ],
            };
          }
          try {
            const live = (await api.snapshot(LiveDoc, main().id, context))!;
            const runId = live.run!.inputs[0]!;
            const input = await (await harness().submission(runId, context))!.status(context);
            const notices = new Set<string>();
            for (const id of live.run!.inputs) {
              const status = await (await harness().submission(id, context))!.status(context);
              if (!status.entry) continue;
              const entry = await main().commit((tx) => tx.entry(status.entry!), context);
              for (const message of entry?.model ?? []) {
                const notice = message.role === "user" && decodeRuntimeNotice(message.content);
                if (notice) notices.add(JSON.stringify([message.timestamp, notice.text]));
              }
            }
            const tail = await runTail(messages, input.entry!, context);
            const task = (await harness().getTask(api.taskId, context))!;
            const checkpoint = task.state.checkpoint as unknown as GenerationCheckpoint;
            if (checkpoint.phase !== "request")
              throw new Error("Memory admission outside model request");
            const model = api.models.getModel(checkpoint.model.provider, checkpoint.model.modelId)!;
            const reserve = Math.min(DEFAULT_COMPACTION_POLICY.reserveTokens, model.maxTokens);
            const system = tail[0]?.role === "system" ? tail.slice(0, 1) : [];
            // This synthetic prefix replaces canonical history. Its newer timestamp
            // tells the SDK not to reuse assistant usage measured for another prefix.
            // Original input, reasoning and tool messages remain byte-for-byte intact.
            const timestamp =
              tail.reduce((latest, message) => Math.max(latest, message.timestamp), 0) + 1;
            let recalledTail = tail.slice(system.length);
            const makeMessages = (view: string): Message[] => [
              ...system,
              { role: "user", content: view, timestamp },
              ...recalledTail,
            ];
            // Use the provider SDK's estimator and safety margin, leaving the same
            // answer reserve as native compaction (up to the model's output limit).
            const fits = (view: string) =>
              clampMaxTokensToContext(
                model,
                normalizeContext({ messages: makeMessages(view) }),
                model.maxTokens,
              ) >= reserve;
            if (!fits(""))
              throw new Error(
                "Active main turn exceeds the model's input budget; memory preparation cannot reduce it",
              );
            let packet = await packetForRun(runId, fits, context);
            const visible = new Set(
              [...packet.view.matchAll(/(?:^|\n)(\d+)\+1\|/g)].map((match) => Number(match[1])),
            );
            const recent = [...packet.view.matchAll(/(?:^|\n)\d+\+1\|(?:user|talk): (.*)/g)]
              .slice(-4)
              .map((match) => match[1]!);
            recalledTail = [];
            const rawTail = tail.slice(system.length);
            for (const [position, message] of rawTail.entries()) {
              if (message.role === "user") {
                const text =
                  typeof message.content === "string"
                    ? message.content
                    : message.content
                        .filter((block) => block.type === "text")
                        .map((block) => block.text)
                        .join("\n");
                // Match canonical runtime inputs, not text that merely looks like a report.
                if (
                  !decodeRuntimeNotice(message.content) &&
                  !notices.has(JSON.stringify([message.timestamp, text]))
                ) {
                  const key = createHash("sha256")
                    .update(JSON.stringify([message.timestamp, message.content]))
                    .digest("hex");
                  let saved = await api.snapshot(MemoryRecall, main().id, key, context);
                  const candidate =
                    saved?.text ??
                    (await recall(text, recent.slice(-4), packet.snapshot.count, visible, context));
                  const admitted = fitMemoryRecall(candidate, (text) => {
                    const prefix = recalledTail;
                    recalledTail = [
                      ...prefix,
                      ...(text
                        ? [{ role: "user" as const, content: text, timestamp: message.timestamp }]
                        : []),
                      ...rawTail.slice(position),
                    ];
                    // Recall may use spare space, never repin the overview to make room.
                    const accepted = fits(packet.view);
                    recalledTail = prefix;
                    return accepted;
                  });
                  if (!saved || saved.text !== admitted) {
                    saved = await main().commit(async (tx) => {
                      const pinned = await tx.doc(MemoryRecall, main().id, key, { text: admitted });
                      pinned.text = admitted;
                      return { ...pinned };
                    }, context);
                  }
                  if (saved.text)
                    recalledTail.push({
                      role: "user",
                      content: saved.text,
                      timestamp: message.timestamp,
                    });
                  recent.push(text);
                }
              } else if (message.role === "assistant") {
                recent.push(
                  message.content
                    .filter((block) => block.type === "text")
                    .map((block) => block.text)
                    .join("\n"),
                );
              }
              recalledTail.push(message);
            }
            // Retrieval is late, outside the stable overview/system prefix, and pinned
            // per input across tools/restarts. Include it in admission budgeting.
            if (!fits(""))
              throw new Error("Active main turn and memory recall exceed the model's input budget");
            packet = await packetForRun(runId, fits, context);
            const prepared = makeMessages(packet.view);
            validPackets.clear();
            validPackets.add(packet.view);
            return { messages: prepared };
          } catch (error) {
            report(error);
            // Pi swallows ordinary hook exceptions. Mark this invocation aborted and wait for its signal instead.
            void harness().abortTask(api.taskId, BACKGROUND_CONTEXT).catch(report);
            await new Promise<never>((_, reject) => {
              const signal = context.abortSignal!;
              if (signal.aborted) reject(signal.reason);
              else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          }
        },
      }),
    ],
  });
  return {
    extension,
    validateRequest(request: { messages: readonly Message[] }, options?: { sessionId?: string }) {
      if (options?.sessionId !== rootSessionId()) return;
      const admitted = request.messages.some(
        (message) =>
          message.role === "user" &&
          typeof message.content === "string" &&
          validPackets.has(message.content),
      );
      if (!admitted) throw new Error("Main request rejected: no persisted OptChat run packet");
    },
  };
}
