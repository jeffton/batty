import { mount } from "@vue/test-utils";
import { expect, test, vi } from "vite-plus/test";
import AgentTurnDiffPopover from "./AgentTurnDiffPopover.vue";

const { setItems } = vi.hoisted(() => ({ setItems: vi.fn() }));
vi.mock("@pierre/diffs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pierre/diffs")>()),
  CodeView: class {
    setup() {}
    cleanUp() {}
    setItems = setItems;
  },
}));

test("same-path immutable diffs have distinct viewer items", async () => {
  const files = [
    {
      path: "a.ts",
      patch: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-before\n+first\n",
    },
    {
      path: "a.ts",
      patch: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-first\n+second\n",
    },
  ];
  const wrapper = mount(AgentTurnDiffPopover, {
    props: { popoverId: "diffs", files },
    global: { stubs: { FullPopover: { name: "FullPopover", template: "<div><slot /></div>" } } },
  });
  wrapper.findComponent({ name: "FullPopover" }).vm.$emit("toggle", { newState: "open" });
  await vi.waitFor(() => expect(setItems).toHaveBeenCalled());
  const items = setItems.mock.calls.at(-1)![0];
  expect(new Set(items.map((item: { id: string }) => item.id)).size).toBe(2);
  const diffs = items.map(
    (item: { fileDiff: { cacheKey: string; additionLines: string[] } }) => item.fileDiff,
  );
  expect(diffs.map((diff: { additionLines: string[] }) => diff.additionLines)).toEqual([
    ["first\n"],
    ["second\n"],
  ]);
  expect(diffs[0].cacheKey).toContain("diffs:0");
  expect(diffs[1].cacheKey).toContain("diffs:1");
  wrapper.unmount();
});
