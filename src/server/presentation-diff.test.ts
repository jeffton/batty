import { expect, test } from "vite-plus/test";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { messageDiffs } from "./presentation-hook";

test("parallel mutation results form a diff in mutation order, not tool result order", () => {
  const mutation = (order: number, before: string, after: string) =>
    ({
      model: [
        {
          role: "toolResult",
          details: {
            battyFileChanges: [
              { order, before: before + "\n", after: after + "\n", path: "main.ts" },
            ],
          },
        },
      ],
    }) as unknown as EntryRecord;
  const result = messageDiffs([mutation(20, "middle", "last"), mutation(10, "first", "middle")]);
  expect(result).toHaveLength(1);
  expect(result[0]!.patch).toContain("-first\n+last");
  expect(result[0]!.patch).not.toContain("middle");
});
