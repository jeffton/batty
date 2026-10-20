import { LiveDoc, GenerationTask, hook } from "@earendil-works/pi-durable";
import { decodeRuntimeNotice } from "./runtime-notices.js";
import { OrchestrationDoc, WorkerDoc, type OrchestrationServices } from "./orchestration-state.js";

export function orchestrationHooks(services: OrchestrationServices) {
  return [
    hook(GenerationTask, {
      beforeRequest: (request) => ({
        messages: request.messages.map((message) => {
          const notice = message.role === "user" && decodeRuntimeNotice(message.content);
          return notice ? { ...message, content: notice.text } : message;
        }),
      }),
    }),
    hook(GenerationTask, {
      beforeRequest: async (_request, api, ctx) => {
        await services.harness.commit(async (tx) => {
          const completion = (await tx.doc(WorkerDoc, api.conversationId)).completion;
          if (!completion) return;
          const live = await tx.doc(LiveDoc, api.conversationId);
          for (const id of live.run?.inputs ?? [])
            if (!completion.inputs.includes(id)) completion.inputs.push(id);
        }, ctx);
      },
      afterResponse: async (message, api, ctx) => {
        if (message.stopReason === "stop" || message.stopReason === "length") {
          await services.main.commit(async (tx) => {
            const doc = await tx.doc(OrchestrationDoc);
            if (doc.joinParents) delete doc.joinParents[String(api.conversationId)];
          }, ctx);
        }
      },
    }),
  ];
}
