import { expect, test } from "vite-plus/test";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createHistoryIndex } from "./history-index";
import { responseArtifacts } from "./artifact-forwarding";

test("response projection delivers once on commentary, independent of submissions and page boundaries", async () => {
  const db = await openNodeSqliteDatabase(":memory:");
  const storage = await SqliteStorage.open(db);
  try {
    const index = await createHistoryIndex(db);
    const selected = {
      fileChanges: [{ path: "a", patch: "saved diff" }],
      sites: [
        { kind: "site" as const, id: "s", name: "Chosen", url: "/s", public: false as const },
      ],
      sentFiles: [
        {
          id: "video",
          name: "night.mp4",
          size: 42,
          mimeType: "video/mp4",
          kind: "video" as const,
          downloadUrl: "/video",
        },
      ],
    };
    const nativePhoto = {
      ...selected.sentFiles[0],
      id: "native-photo",
      name: "photo.png",
      mimeType: "image/png",
      kind: "image" as const,
    };
    const expected = { ...selected, sentFiles: [...selected.sentFiles, nativePhoto] };
    const draft = {
      sites: [
        {
          kind: "site" as const,
          id: "draft",
          name: "Draft",
          url: "/draft",
          public: false as const,
        },
      ],
    };
    const assistant = (text: string) => ({
      role: "assistant",
      stopReason: "toolUse",
      content: [{ type: "text", text }],
    });
    await db.transaction(async (tx) => {
      for (const [id, conversationId, model] of [
        [1, 1, [{ role: "toolResult", details: { forwardedArtifacts: draft } }]],
        [2, 1, [assistant("Earlier delivery")]],
        // A child report's inventory is not an attachment selection.
        [3, 1, [{ role: "toolResult", toolName: "subagent", details: draft }]],
        [
          4,
          1,
          [
            {
              role: "toolResult",
              toolName: "codemode",
              details: {
                calls: [
                  { name: "attach_artifacts", forwardedArtifacts: selected },
                  { name: "attach_files", sentFiles: [nativePhoto] },
                  { name: "subagent", sites: draft.sites },
                ],
              },
            },
          ],
        ],
        [5, 2, [{ role: "toolResult", details: { forwardedArtifacts: draft } }]],
        [
          6,
          1,
          [
            { role: "assistant", content: [{ type: "toolCall", name: "subagent" }] },
            { ...assistant("Hidden text"), display: false },
            assistant("\t\n\r\u00a0\u2009\ufeff "),
          ],
        ],
        [7, 1, [assistant("Here is the timelapse")]],
        [8, 1, [{ role: "user", content: "Another request" }]],
        [9, 1, [assistant("Unrelated final answer")]],
      ] as const) {
        await tx.run(
          "INSERT INTO entries (id, conversation_id, commit_seq, record) VALUES (?, ?, 1, ?)",
          id,
          conversationId,
          JSON.stringify({ id, conversationId, kind: "pi.model", model }),
        );
      }
    });
    const entries = await index.responseArtifacts(1, 7);
    expect(entries.map((entry) => entry.id)).toEqual([4]);
    expect(responseArtifacts(entries)).toEqual(expected);
    expect(await index.responseArtifacts(1, 9)).toEqual([]);
    expect(await index.responseArtifacts(2, 7)).toHaveLength(1);
    // The page need not contain the tools that produced the visible response.
    const page = await index.entries(1, "8", 1);
    expect(page.entries.map((entry) => entry.id)).toEqual([7]);
    expect(responseArtifacts(await index.responseArtifacts(1, page.entries[0]!.id))).toEqual(
      expected,
    );
  } finally {
    await storage.close(context);
  }
});
