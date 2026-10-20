import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { Type, type ImageContent, type Message, type TextContent } from "@earendil-works/pi-ai";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import {
  defineExtension,
  defineTool,
  GenerationTask,
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
import { Packets, WorkerMemory, type MemoryPacket, type MemorySnapshot } from "./memory-documents";
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
    context: Context,
  ) => Promise<{ view: string; snapshot: MemorySnapshot }>;
  preparedView: () => { view: string; snapshot: MemorySnapshot };
  zoom: (
    id: number,
    count: number,
    context: Context,
    snapshot?: MemorySnapshot,
  ) => Promise<(TextContent | ImageContent)[]>;
  date: (id: number, context: Context) => Promise<string>;
  search: (options: MemorySearchOptions, context: Context) => ReturnType<MemorySearch["search"]>;
  report: (error: unknown) => void;
};

export function createMemoryRequests({
  main,
  harness,
  rootSessionId,
  assistantWorkspaceId,
  load,
  conversationalView,
  preparedView,
  zoom,
  date,
  search,
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
  function packetForRun(runId: SubmissionId, context: Context) {
    const result = packetQueue.then(() => createPacket(runId, context));
    packetQueue = result.catch(() => undefined);
    return result;
  }
  async function createPacket(runId: SubmissionId, context: Context) {
    const packet = await harness().snapshot(Packets, main().id, String(runId), context);
    if (packet) return packet;
    const input = await (await harness().submission(runId, context))!.status(context);
    if (!input.entry) throw new Error("Main run input has no entry");
    const candidate = {
      ...(await conversationalView(input.entry - 1, context)),
      boundary: input.entry as number,
    };
    return main().commit(async (tx) => {
      await tx.doc(Packets, main().id, String(runId), candidate);
      await tx.appendEntry(main().id, { kind: "batty.run-head", head: input.entry });
      return candidate;
    }, context);
  }
  async function runMessages(
    messages: readonly Message[],
    packet: MemoryPacket,
    context: Context,
  ): Promise<Message[]> {
    const entry = await main().commit((tx) => tx.entry(packet.boundary as EntryId), context);
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
      { role: "user", content: packet.view, timestamp: 0 },
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
          "Open prepared main-memory line id+n into its two child summaries; n=1 returns uncompressed non-thought text and original images from that message. No reasoning or full message metadata.",
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
        name: "memory_date",
        description:
          "The date and time of main-memory message id (from the prepared overview or memory_zoom).",
        parameters: Type.Object({ id: Type.Integer() }),
        replay: "safe",
        execute: async ({ id }, api, context) => {
          const worker = await api.snapshot(WorkerDoc, api.conversationId, context);
          if (!(await canAccessMemory(api.conversationId, worker?.workspaceId)))
            throw new Error("Main memory is available only in the assistant workspace");
          return { output: [{ type: "text", text: await date(id, context) }] };
        },
      }),
      defineTool({
        name: "memory_search",
        description:
          "Search original main-memory text using 1–12 literal words (all must match), newest first. Returns bounded snippets with original id/date/kind; use memory_zoom(id, 1) for full text. Tools/results excluded unless includeTools is true. No semantic search.",
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
            const packet = await packetForRun(runId, context);
            const prepared = await runMessages(messages, packet, context);
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
