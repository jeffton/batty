import { restoreInlineAgent } from "./orchestration-lifecycle.js";
import { LiveDoc, GenerationTask, hook, configure, type EntryId } from "@earendil-works/pi-durable";
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
      // Inline turns use the originating workspace for tools. Save main's cwd
      // in the same commit so reopening can restore it after interruption.
      beforeRequest: async (_request, api, ctx) => {
        await services.harness.commit(async (tx) => {
          const completion = (await tx.doc(WorkerDoc, api.conversationId)).completion;
          if (!completion) return;
          const live = await tx.doc(LiveDoc, api.conversationId);
          for (const id of live.run?.inputs ?? [])
            if (!completion.inputs.includes(id)) completion.inputs.push(id);
        }, ctx);
        if (api.conversationId !== services.main.id) return;
        // The active run's admitted inputs survive zooms and later steering.
        // Read those immutable input entries rather than the prepared last user.
        const live = await api.snapshot(LiveDoc, services.main.id, ctx);
        const entries: EntryId[] = [];
        const completion = (await api.snapshot(WorkerDoc, services.main.id, ctx))?.completion;
        for (const id of new Set([...(completion?.inputs ?? []), ...(live?.run?.inputs ?? [])])) {
          const submission = await (await services.harness.submission(id, ctx))!.status(ctx);
          if (submission.entry !== undefined) entries.push(submission.entry);
        }
        const agent = await services.main.agent(ctx);
        await services.main.commit(async (tx) => {
          let origin: { cwd: string; runId: string } | undefined;
          for (const id of entries) {
            const entry = await tx.entry(id);
            const message = entry?.model?.find((message) => message.role === "user");
            const text =
              message?.role === "user"
                ? typeof message.content === "string"
                  ? message.content
                  : message.content
                      .flatMap((part) => (part.type === "text" ? [part.text] : []))
                      .join("")
                : "";
            const notice = decodeRuntimeNotice(text);
            if (notice?.kind === "cron" && notice.data?.cron) {
              origin = notice.data.cron as { cwd: string; runId: string };
              break;
            }
            // Already-admitted inline runs retain their immutable old input.
            const legacy = /^<batty-cron-context>(.*?)<\/batty-cron-context>/s.exec(text);
            if (legacy) {
              origin = JSON.parse(legacy[1]!) as { cwd: string; runId: string };
              break;
            }
          }
          const doc = await tx.doc(OrchestrationDoc);
          if (origin) {
            doc.inlineContext ??= {
              cwd: agent.cwd ?? null,
              model: agent.model ?? null,
              thinkingLevel: agent.thinkingLevel,
              runId: origin.runId,
            };
            doc.inlineContext.runId = origin.runId;
            await configure(tx, services.main.id, { cwd: origin.cwd });
          } else if (doc.inlineContext) {
            await restoreInlineAgent(tx, services.main.id, doc.inlineContext);
            delete doc.inlineContext;
          }
        }, ctx);
      },
      afterTools: async (_assistant, _results, api, ctx) => {
        if (api.conversationId !== services.main.id) return;
        if ((await api.snapshot(WorkerDoc, services.main.id, ctx))?.completion) return;
        const live = await api.snapshot(LiveDoc, services.main.id, ctx);
        const controls = [];
        for (const tool of live?.tools ?? []) {
          const task =
            tool.taskId === undefined
              ? undefined
              : await services.harness.getTask(tool.taskId, ctx);
          const outcome = task?.state.status === "terminal" ? task.state.outcome : undefined;
          const control =
            outcome && "result" in outcome
              ? (
                  outcome.result as
                    | { control?: { terminate?: boolean; handoff?: string } }
                    | undefined
                )?.control
              : undefined;
          controls.push(control);
        }
        if (
          !controls.some((control) => control?.handoff !== undefined) &&
          !(controls.length && controls.every((control) => control?.terminate))
        )
          return;
        await services.main.commit(async (tx) => {
          const doc = await tx.doc(OrchestrationDoc);
          if (!doc.inlineContext) return;
          await restoreInlineAgent(tx, services.main.id, doc.inlineContext);
          delete doc.inlineContext;
        }, ctx);
      },
      afterResponse: async (message, api, ctx) => {
        if (message.stopReason === "stop" || message.stopReason === "length") {
          await services.main.commit(async (tx) => {
            const doc = await tx.doc(OrchestrationDoc);
            if (doc.joinParents) delete doc.joinParents[String(api.conversationId)];
          }, ctx);
        }
        if (
          api.conversationId !== services.main.id ||
          (message.stopReason !== "stop" && message.stopReason !== "length")
        )
          return;
        if ((await api.snapshot(WorkerDoc, services.main.id, ctx))?.completion) return;
        await services.main.commit(async (tx) => {
          const doc = await tx.doc(OrchestrationDoc);
          if (!doc.inlineContext) return;
          await restoreInlineAgent(tx, services.main.id, doc.inlineContext);
          delete doc.inlineContext;
        }, ctx);
      },
    }),
  ];
}
