import { expect, test } from "vite-plus/test";
import type { Storage } from "@earendil-works/pi-durable";
import type { UiMessage } from "@/shared/types";
import { hydrateRuntimeResultArtifacts } from "./runtime-result-artifacts-history";
const file = { id: "old", name: "old.jpg" };
test("historical hydration resolves exact delivery even with repeated answers and includes pre-steering effects", async () => {
  const queries: unknown[] = [];
  const storage = {
    scanSubmissions: async () => ({
      items: [
        { entry: 100, requestId: "batty-report:10" },
        { entry: 200, requestId: "batty-report:20" },
      ],
    }),
    submissionByRequest: async (session: number, request: string) => {
      expect([session, request]).toEqual([42, "batty-deliver:10"]);
      return { type: "input", status: "done", entry: 10, answer: 14 };
    },
    scanEntries: async (query: unknown) => {
      queries.push(query);
      return {
        items: [
          { model: [{ role: "assistant", content: [{ type: "text", text: "Done" }] }] },
          { model: [{ role: "user", content: "Steering" }] },
          {
            model: [
              {
                role: "toolResult",
                details: {
                  sentFiles: [file],
                  battyFileChanges: [
                    { path: "a.ts", before: "private before", after: "private after", order: 1 },
                  ],
                },
              },
            ],
          },
          { model: [{ role: "user", content: "Original task" }] },
        ],
      };
    },
  } as unknown as Storage;
  const message: UiMessage = {
    id: "100",
    role: "custom",
    timestamp: 200,
    customType: "batty-runtime-notice:subagent",
    text: "Done",
    data: { subagent: { sessionId: "42" }, runtimeNotice: { markdown: "Done" } },
  };
  await hydrateRuntimeResultArtifacts(storage, 1 as never, message);
  expect(queries).toEqual([{ conversationId: 42, minEntryId: 10, maxEntryId: 14 }]);
  expect(message.data!.runtimeResultArtifacts).toMatchObject({
    sentFiles: [file],
    fileChanges: [{ path: "a.ts", patch: expect.any(String) }],
  });
  expect(message.data!.runtimeResultArtifacts).not.toHaveProperty("battyFileChanges");
  expect(message.data!.runtimeResultArtifacts).not.toHaveProperty("forwardedArtifacts");
});
